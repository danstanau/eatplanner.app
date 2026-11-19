import express, { type ErrorRequestHandler, type Response } from "express";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import convertHeic from "heic-convert";
import { z } from "zod";
import { preferencesSchema, type MealPlan, type Preferences } from "./plan.js";
import { DEFAULT_RECIPE_SCOPE, MAIN_HOUSEHOLD_ID, extractionSchema, newRecipeSchema, photoSchema, recipeImageSearchSchema, recipeScopeSchema, type Extraction, type ImageCredit, type Photo, type Recipe, type RecipeImageSearch, type RecipeScope } from "./recipes.js";
import { alternatives, AppError, assertEditable, batchPlanningSchema, daySchema, moveMeal, planningSchema, planWeek, shoppingList, swapMeal, weekKeySchema, type Week } from "./planner.js";
import { Store } from "./store.js";
import { hashPassword, householdAuth, type AuthConfig } from "./auth.js";
import { Households, householdNameSchema, passwordSchema } from "./households.js";

interface Services {
  generatePlan: (preferences: Preferences) => Promise<MealPlan>;
  getStatus: () => Promise<{ authenticated: boolean; model: string }>;
  extractRecipe: (photo: Photo) => Promise<Extraction>;
  findRecipeImage: (recipe: RecipeImageSearch) => Promise<{ image: string; imageCredit: ImageCredit }>;
}

const revisionSchema = z.object({ revision: z.number().int().min(1) });
function recipePool(local: Recipe[], { starter, shared }: { starter: Recipe[]; shared: Recipe[] }, scope: RecipeScope) {
  return scope === "other-households" ? shared : [...starter, ...local, ...shared];
}
function requireWeek(weeks: Record<string, Week>, key: string): Week {
  const week = weeks[key];
  if (!week) throw new AppError(404, "This week has not been planned yet.");
  return week;
}

export function createApp(services: Services, store = new Store(), options: { allowNetworkAccess?: boolean; auth?: AuthConfig; households?: Households } = {}) {
  const app = express();
  const households = options.households ?? new Households();
  const householdId = (response: Response) => response.locals.identity?.id ?? MAIN_HOUSEHOLD_ID;
  async function sharedRecipes(response: Response, scope: RecipeScope) {
    if (!options.auth || (scope !== "all" && scope !== "other-households")) return [];
    const ownId = householdId(response);
    const sources = [MAIN_HOUSEHOLD_ID, ...(await households.list()).map(({ id }) => id)].filter((id) => id !== ownId);
    return (await Promise.all(sources.map(async (id) => {
      const recipes = await (id === MAIN_HOUSEHOLD_ID ? store : households.store(id)).readRecipes();
      return recipes.filter((recipe) => recipe.householdId === id);
    }))).flat();
  }
  async function recipeSources(response: Response, scope: RecipeScope) {
    const [starter, shared] = await Promise.all([
      scope === DEFAULT_RECIPE_SCOPE || scope === "all" ? store.readStarterRecipes() : [],
      sharedRecipes(response, scope),
    ]);
    return { starter, shared };
  }
  function storeFor(response: Response): Store {
    if (!options.auth) return store;
    const identity = response.locals.identity;
    if (!identity) throw new AppError(401, "Please sign in to your household.");
    return identity.isAdmin ? store : households.store(identity.id);
  }
  function requireAdmin(response: Response) {
    const identity = response.locals.identity;
    if (!identity?.isAdmin) throw new AppError(403, "Only the super admin can manage households.");
    return identity;
  }
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(householdAuth(options.auth, households));
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (request, response, next) => {
    const hostname = request.hostname;
    if (!options.allowNetworkAccess && !["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
      response.status(403).json({ error: "Use this app through its local address." });
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      const origin = request.get("origin");
      if (origin && origin !== (options.auth?.publicOrigin ?? `${request.protocol}://${request.get("host")}`)) {
        response.status(403).json({ error: "Changes must be requested from this app." });
        return;
      }
      const isHeicConversion = request.path === "/recipes/convert-heic";
      if (!request.is(isHeicConversion ? "application/octet-stream" : "application/json")) {
        response.status(415).json({ error: isHeicConversion ? "Send the image as binary data." : "Send data as application/json." });
        return;
      }
    }
    next();
  });
  let convertingHeic = false;
  app.post("/api/recipes/convert-heic", express.raw({ type: "application/octet-stream", limit: 15_000_000 }), async (request, response) => {
    const bytes: unknown = request.body;
    if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp" ||
      !["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(bytes.toString("ascii", 8, 12))) {
      throw new AppError(400, "Choose a valid HEIC or HEIF image.");
    }
    if (convertingHeic) throw new AppError(429, "Another phone photo is being prepared. Please wait.");
    convertingHeic = true;
    try {
      let jpeg: Uint8Array;
      try {
        jpeg = await convertHeic({ buffer: bytes, format: "JPEG", quality: 0.88 });
      } catch (error) {
        console.error("[eatplanner.app] HEIC conversion failed:", error instanceof Error ? error.message : "Unexpected error");
        throw new AppError(422, "This HEIC photo couldn't be opened. Try another photo or export it as JPEG.");
      }
      response.type("image/jpeg").send(Buffer.from(jpeg));
    } finally {
      convertingHeic = false;
    }
  });
  app.use(express.json({ limit: "4mb" }));
  app.use("/api/admin", (_request, response, next) => {
    requireAdmin(response);
    next();
  });
  app.get("/api/admin/households", async (_request, response) => {
    response.json((await households.list()).map(({ id, name }) => ({ id, name })));
  });
  app.post("/api/admin/households", async (request, response) => {
    const input = z.object({ name: householdNameSchema, password: passwordSchema }).strict().parse(request.body);
    const household = await households.save({
      name: input.name, passwordHash: await hashPassword(input.password),
    }, requireAdmin(response).name);
    response.status(201).json({ id: household.id, name: household.name });
  });
  app.patch("/api/admin/households/:id", async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z.object({ name: householdNameSchema.optional(), password: passwordSchema.optional() }).strict()
      .refine((value) => value.name !== undefined || value.password !== undefined, "Enter a name or a new password.")
      .parse(request.body);
    const household = await households.save({
      id, name: input.name,
      passwordHash: input.password === undefined ? undefined : await hashPassword(input.password),
    }, requireAdmin(response).name);
    response.json({ id: household.id, name: household.name });
  });
  app.get("/api/status", async (_request, response) => {
    response.json(await services.getStatus());
  });
  app.get("/api/recipes", async (request, response) => {
    const scope = recipeScopeSchema.optional().parse(request.query.scope) ?? DEFAULT_RECIPE_SCOPE;
    const [local, sources] = await Promise.all([storeFor(response).readRecipes(), recipeSources(response, scope)]);
    response.json(recipePool(local, sources, scope));
  });
  app.post("/api/recipes", async (request, response) => {
    const content = newRecipeSchema.parse(request.body);
    const recipe = { ...content, id: randomUUID(), source: "personal" as const, householdId: householdId(response) };
    response.status(201).json(await storeFor(response).update((state) => {
      state.recipes.push(recipe);
      return recipe;
    }));
  });
  let recipePhotoTask = false;
  app.post("/api/recipes/find-image", async (request, response) => {
    const recipe = recipeImageSearchSchema.parse(request.body);
    if (recipePhotoTask) throw new AppError(429, "Another recipe photo task is running. Please wait.");
    recipePhotoTask = true;
    try {
      response.json(await services.findRecipeImage(recipe));
    } finally {
      recipePhotoTask = false;
    }
  });
  app.put("/api/recipes/:id", async (request, response) => {
    const content = newRecipeSchema.parse(request.body);
    if ((await store.readStarterRecipes()).some((recipe) => recipe.id === request.params.id)) {
      throw new AppError(403, "Starter recipes are read-only.");
    }
    response.json(await storeFor(response).update((state) => {
      const index = state.recipes.findIndex((recipe) => recipe.id === request.params.id);
      if (index < 0) throw new AppError(404, "This recipe is no longer in your collection.");
      const { id, source, householdId: owner } = state.recipes[index];
      const recipe = { ...content, id, source, ...(owner ? { householdId: owner } : {}) };
      state.recipes[index] = recipe;
      return recipe;
    }));
  });
  app.post("/api/recipes/extract", async (request, response) => {
    const photo = photoSchema.parse(request.body);
    if (recipePhotoTask) throw new AppError(429, "Another recipe photo task is running. Please wait.");
    recipePhotoTask = true;
    try {
      const extraction = extractionSchema.parse(await services.extractRecipe(photo));
      if (!extraction.recipe) throw new AppError(422, extraction.warnings.join(" ") || "No readable recipe was found. Try a clearer photo of the ingredients and method.");
      response.json(extraction);
    } finally {
      recipePhotoTask = false;
    }
  });
  app.get("/api/weeks", async (_request, response) => {
    const { weeks } = await storeFor(response).read();
    response.json(Object.values(weeks).map((week) => ({
      week: week.week, status: week.status, count: week.meals.length,
      days: week.meals.map((meal) => meal.day),
      titles: week.meals.map((meal) => meal.recipe.title),
      images: week.meals.map((meal) => meal.recipe.image),
    })));
  });
  app.get("/api/weeks/:week", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    response.json((await storeFor(response).read()).weeks[key] ?? null);
  });
  app.post("/api/weeks/plan", async (request, response) => {
    const input = batchPlanningSchema.parse(request.body);
    const scope = input.rules.recipeScope ?? DEFAULT_RECIPE_SCOPE;
    const sources = await recipeSources(response, scope);
    response.json(await storeFor(response).update((state) => {
      const start = new Date(`${input.startWeek}T00:00:00Z`);
      const keys = Array.from({ length: input.count }, (_, index) => {
        const week = new Date(start);
        week.setUTCDate(week.getUTCDate() + index * 7);
        return week.toISOString().slice(0, 10);
      });
      const existing = keys.find((key) => state.weeks[key]);
      if (existing) throw new AppError(409, `The week starting ${existing} already has a plan. Choose another start week or plan fewer weeks.`);
      const pool = recipePool(state.recipes, sources, scope);
      const weeks = keys.map((key) => planWeek(key, input, pool));
      weeks.forEach((week) => { state.weeks[week.week] = week; });
      return weeks;
    }));
  });
  app.post("/api/weeks/:week/plan", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = planningSchema.parse(request.body);
    const scope = input.rules.recipeScope ?? DEFAULT_RECIPE_SCOPE;
    const sources = await recipeSources(response, scope);
    response.json(await storeFor(response).update((state) => {
      const current = state.weeks[key];
      if (current) assertEditable(current, input.revision ?? 0);
      else if (input.revision) throw new AppError(409, "This week no longer exists. Reload before planning.");
      const next = planWeek(key, input, recipePool(state.recipes, sources, scope));
      next.revision = (current?.revision ?? 0) + 1;
      state.weeks[key] = next;
      return next;
    }));
  });
  app.get("/api/weeks/:week/alternatives/:day", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const day = daySchema.parse(Number(request.params.day));
    const state = await storeFor(response).read();
    const week = requireWeek(state.weeks, key);
    const scope = week.rules.recipeScope ?? DEFAULT_RECIPE_SCOPE;
    response.json(alternatives(week, day, recipePool(state.recipes, await recipeSources(response, scope), scope)));
  });
  app.post("/api/weeks/:week/swap", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = revisionSchema.extend({ day: daySchema, recipeId: z.string().optional() }).parse(request.body);
    const own = storeFor(response);
    const current = requireWeek((await own.read()).weeks, key);
    assertEditable(current, input.revision);
    const scope = current.rules.recipeScope ?? DEFAULT_RECIPE_SCOPE;
    const sources = await recipeSources(response, scope);
    response.json(await own.update((state) => {
      const week = requireWeek(state.weeks, key);
      assertEditable(week, input.revision);
      swapMeal(week, input.day, recipePool(state.recipes, sources, scope), input.recipeId);
      week.revision++;
      return week;
    }));
  });
  app.post("/api/weeks/:week/cooked", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = z.object({
      day: daySchema, recipeId: z.string().min(1).max(120), cooked: z.boolean(),
    }).parse(request.body);
    response.json(await storeFor(response).update((state) => {
      const week = requireWeek(state.weeks, key);
      const meal = week.meals.find((item) => item.day === input.day);
      if (!meal) throw new AppError(404, "There is no meal on that day.");
      if (meal.recipe.id !== input.recipeId) throw new AppError(409, "This meal changed. Reload the week before marking it cooked.");
      meal.cooked = input.cooked;
      return week;
    }));
  });
  app.post("/api/weeks/:week/move", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = revisionSchema.extend({ from: daySchema, to: daySchema }).parse(request.body);
    response.json(await storeFor(response).update((state) => {
      const week = requireWeek(state.weeks, key);
      assertEditable(week, input.revision);
      moveMeal(week, input.from, input.to);
      week.revision++;
      return week;
    }));
  });
  app.post("/api/weeks/:week/confirm", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = revisionSchema.parse(request.body);
    response.json(await storeFor(response).update((state) => {
      const week = requireWeek(state.weeks, key);
      assertEditable(week, input.revision);
      week.status = "confirmed";
      week.confirmedAt = new Date().toISOString();
      week.shoppingList = shoppingList(week);
      week.revision++;
      return week;
    }));
  });
  app.post("/api/weeks/:week/unlock", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = revisionSchema.parse(request.body);
    response.json(await storeFor(response).update((state) => {
      const week = requireWeek(state.weeks, key);
      if (week.revision !== input.revision) throw new AppError(409, "This week changed. Reload before unlocking.");
      if (week.status !== "confirmed") throw new AppError(409, "This week is already a draft.");
      week.status = "draft";
      week.confirmedAt = null;
      week.shoppingList = [];
      week.revision++;
      return week;
    }));
  });

  let generating = false;
  app.post("/api/plan", async (request, response) => {
    // JSON-only, same-origin requests prevent other sites from spending your credits.
    const origin = request.get("origin");
    if (origin && origin !== (options.auth?.publicOrigin ?? `${request.protocol}://${request.get("host")}`)) {
      response.status(403).json({ error: "Meal plans must be requested from this app." });
      return;
    }
    if (!request.is("application/json")) {
      response.status(415).json({ error: "Send preferences as application/json." });
      return;
    }
    const result = preferencesSchema.safeParse(request.body);
    if (!result.success) {
      response.status(400).json({ error: "Check your preferences.", details: result.error.flatten() });
      return;
    }
    if (generating) {
      response.status(429).json({ error: "A plan is already being generated. Please wait." });
      return;
    }
    generating = true;
    try {
      response.json(await services.generatePlan(result.data));
    } finally {
      generating = false;
    }
  });
  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API endpoint not found." });
  });
  app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url))));
  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    console.error("[eatplanner.app]", error instanceof SyntaxError && "body" in error
      ? "The request contains invalid JSON."
      : error instanceof Error ? error.message : "Unexpected error");
    if (error instanceof AppError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({ error: "Check the entered details.", details: error.flatten() });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "The request contains invalid JSON." });
      return;
    }
    if (error instanceof Error && "status" in error && error.status === 413) {
      response.status(413).json({ error: "This upload is too large. Choose a smaller image." });
      return;
    }
    response.status(502).json({
      error: "The request could not be completed. For photo imports or image search, check Copilot login, your allowance and service availability. See the server terminal for details.",
    });
  };
  app.use(handleError);
  return app;
}
