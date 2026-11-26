import express, { type ErrorRequestHandler, type Response } from "express";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import convertHeic from "heic-convert";
import { z } from "zod";
import { preferencesSchema, type MealPlan, type Preferences } from "./plan.js";
import { DEFAULT_RECIPE_SCOPE, MAIN_HOUSEHOLD_ID, extractionSchema, newRecipeSchema, recipePhotosSchema, recipeImageSearchSchema, recipeScopeSchema, type Extraction, type ImageCredit, type Photo, type Recipe, type RecipeImageSearch, type RecipeScope } from "./recipes.js";
import { alternatives, AppError, assertEditable, batchPlanningSchema, daySchema, moveMeal, planningSchema, planWeek, shoppingList, swapMeal, weekKeySchema, type Week } from "./planner.js";
import { Store } from "./store.js";
import { hashPassword, householdAuth, type AuthConfig } from "./auth.js";
import { Households, householdNameSchema, passwordSchema } from "./households.js";

interface Services {
  generatePlan: (preferences: Preferences) => Promise<MealPlan>;
  getStatus: () => Promise<{ authenticated: boolean; model: string }>;
  extractRecipe: (photos: Photo[], signal: AbortSignal) => Promise<Extraction>;
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
function recentRecipeIds(weeks: Record<string, Week>, beforeWeek: string): Set<string> {
  const cutoff = new Date(`${beforeWeek}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 28);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  return new Set(Object.values(weeks)
    .filter((week) => week.week >= cutoffKey && week.week < beforeWeek)
    .flatMap((week) => week.meals.flatMap((meal) => "recipe" in meal ? [meal.recipe.id] : [])));
}
function makeAgainRecipeIds(feedback: { recipeId: string; makeAgain: boolean }[]): Set<string> {
  return new Set(feedback.filter((item) => item.makeAgain).map((item) => item.recipeId));
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
  async function requireAvailableRecipe(response: Response, id: string) {
    const [local, sources] = await Promise.all([
      storeFor(response).readRecipes(),
      recipeSources(response, "all"),
    ]);
    if (!recipePool(local, sources, "all").some((recipe) => recipe.id === id)) {
      throw new AppError(404, "This recipe is no longer available.");
    }
  }
  function feedbackProfileId(response: Response) {
    const identity = response.locals.identity;
    if (options.auth && !identity?.profile) throw new AppError(409, "Choose who you are before sharing recipe feedback.");
    return identity?.profile?.id ?? "household";
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
    const styleNonce = randomBytes(18).toString("base64");
    response.locals.styleNonce = styleNonce;
    response.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'self'; img-src 'self' data: blob: https://images.unsplash.com; style-src 'self' 'nonce-${styleNonce}'; style-src-attr 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
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
  const profileName = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, "Use a name on one line.");
  function requireProfile(response: Response) {
    const profile = response.locals.identity?.profile;
    if (!profile) throw new AppError(409, "Choose who you are before making changes.");
    return profile;
  }
  app.get("/api/profiles", async (_request, response) => {
    response.json((await storeFor(response).read()).profiles);
  });
  app.post("/api/profiles", async (request, response) => {
    const { name } = z.object({ name: profileName }).strict().parse(request.body);
    const profile = await storeFor(response).update((state) => {
      const existing = state.profiles.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (existing) return existing;
      if (state.profiles.length >= 100) throw new AppError(400, "This household can have up to 100 profiles.");
      const created = { id: randomUUID(), name };
      state.profiles.push(created);
      return created;
    });
    response.locals.selectProfile?.(profile);
    response.status(201).json(profile);
  });
  app.post("/api/profiles/select", async (request, response) => {
    const { id } = z.object({ id: z.uuid() }).strict().parse(request.body);
    const profile = (await storeFor(response).read()).profiles.find((item) => item.id === id);
    if (!profile) throw new AppError(404, "This profile no longer exists.");
    response.locals.selectProfile?.(profile);
    response.json(profile);
  });
  app.post("/api/profiles/clear", async (_request, response) => {
    response.locals.clearProfile?.();
    response.json({ selected: false });
  });
  const shoppingName = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, "Use a name on one line.");
  app.get("/api/shopping", async (_request, response) => {
    response.json((await storeFor(response).read()).shopping);
  });
  app.post("/api/shopping", async (request, response) => {
    const { names } = z.object({ names: z.array(shoppingName).min(1).max(500) }).strict().parse(request.body);
    const profile = requireProfile(response);
    response.status(201).json(await storeFor(response).update((state) => {
      const existing = new Set(state.shopping.items.map((item) => item.name.toLowerCase()));
      for (const name of names) {
        if (!existing.has(name.toLowerCase())) {
          state.shopping.items.push({ id: randomUUID(), name, checked: false, createdBy: profile });
          existing.add(name.toLowerCase());
        }
      }
      if (state.shopping.items.length > 1000) throw new AppError(400, "The shopping list can hold up to 1000 items.");
      state.shopping.revision++;
      return state.shopping;
    }));
  });
  app.patch("/api/shopping/:id", async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z.object({ name: shoppingName.optional(), checked: z.boolean().optional() }).strict()
      .refine((value) => value.name !== undefined || value.checked !== undefined).parse(request.body);
    response.json(await storeFor(response).update((state) => {
      const item = state.shopping.items.find((entry) => entry.id === id);
      if (!item) throw new AppError(404, "This shopping item no longer exists.");
      Object.assign(item, input);
      state.shopping.revision++;
      return state.shopping;
    }));
  });
  app.delete("/api/shopping/:id", async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    response.json(await storeFor(response).update((state) => {
      const index = state.shopping.items.findIndex((entry) => entry.id === id);
      if (index < 0) throw new AppError(404, "This shopping item no longer exists.");
      state.shopping.items.splice(index, 1);
      state.shopping.revision++;
      return state.shopping;
    }));
  });
  app.get("/api/recipes", async (request, response) => {
    const scope = recipeScopeSchema.optional().parse(request.query.scope) ?? DEFAULT_RECIPE_SCOPE;
    const [local, sources] = await Promise.all([storeFor(response).readRecipes(), recipeSources(response, scope)]);
    response.json(recipePool(local, sources, scope));
  });
  app.get("/api/favorites", async (_request, response) => {
    response.json((await storeFor(response).read()).favoriteRecipeIds);
  });
  app.put("/api/favorites/:id", async (request, response) => {
    const id = z.string().min(1).max(120).parse(request.params.id);
    const { favorite } = z.object({ favorite: z.boolean() }).strict().parse(request.body);
    if (favorite) await requireAvailableRecipe(response, id);
    const favoriteRecipeIds = await storeFor(response).update((state) => {
      const exists = state.favoriteRecipeIds.includes(id);
      if (favorite && !exists) {
        if (state.favoriteRecipeIds.length >= 1000) throw new AppError(400, "You can save up to 1000 favourite recipes.");
        state.favoriteRecipeIds.push(id);
      }
      if (!favorite && exists) state.favoriteRecipeIds = state.favoriteRecipeIds.filter((item) => item !== id);
      return state.favoriteRecipeIds;
    });
    response.json(favoriteRecipeIds);
  });
  app.get("/api/recipes/:id/feedback", async (request, response) => {
    const id = z.string().min(1).max(120).parse(request.params.id);
    await requireAvailableRecipe(response, id);
    const state = await storeFor(response).read();
    const matching = state.recipeFeedback.filter((item) => item.recipeId === id);
    const ratings = matching.flatMap((item) => item.rating === null ? [] : [item.rating]);
    const own = matching.find((item) => item.profileId === feedbackProfileId(response));
    response.json({
      rating: own?.rating ?? null,
      makeAgain: own?.makeAgain ?? false,
      average: ratings.length ? Math.round(ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length * 10) / 10 : null,
      ratingCount: ratings.length,
      makeAgainCount: matching.filter((item) => item.makeAgain).length,
    });
  });
  app.put("/api/recipes/:id/feedback", async (request, response) => {
    const id = z.string().min(1).max(120).parse(request.params.id);
    const input = z.object({
      rating: z.number().int().min(1).max(5).nullable(),
      makeAgain: z.boolean(),
    }).strict().parse(request.body);
    await requireAvailableRecipe(response, id);
    const profileId = feedbackProfileId(response);
    const feedback = await storeFor(response).update((state) => {
      const index = state.recipeFeedback.findIndex((item) => item.recipeId === id && item.profileId === profileId);
      if (input.rating === null && !input.makeAgain) {
        if (index >= 0) state.recipeFeedback.splice(index, 1);
      } else {
        const updated = { recipeId: id, profileId, ...input, updatedAt: new Date().toISOString() };
        if (index >= 0) state.recipeFeedback[index] = updated;
        else {
          if (state.recipeFeedback.length >= 10000) throw new AppError(400, "The household has reached its recipe feedback limit.");
          state.recipeFeedback.push(updated);
        }
      }
      const matching = state.recipeFeedback.filter((item) => item.recipeId === id);
      const ratings = matching.flatMap((item) => item.rating === null ? [] : [item.rating]);
      const own = matching.find((item) => item.profileId === profileId);
      return {
        rating: own?.rating ?? null,
        makeAgain: own?.makeAgain ?? false,
        average: ratings.length ? Math.round(ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length * 10) / 10 : null,
        ratingCount: ratings.length,
        makeAgainCount: matching.filter((item) => item.makeAgain).length,
      };
    });
    response.json(feedback);
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
    const photos = recipePhotosSchema.parse(Array.isArray(request.body?.photos) ? request.body.photos : [request.body]);
    if (recipePhotoTask) throw new AppError(429, "Another recipe photo task is running. Please wait.");
    recipePhotoTask = true;
    const controller = new AbortController();
    const { signal } = controller;
    const cancel = () => controller.abort();
    response.once("close", cancel);
    try {
      const result = await services.extractRecipe(photos, signal);
      signal.throwIfAborted();
      const extraction = extractionSchema.parse(result);
      if (!extraction.recipe) throw new AppError(422, extraction.warnings.join(" ") || "No readable recipe was found. Try a clearer photo of the ingredients and method.");
      response.json(extraction);
    } catch (error) {
      if (!signal.aborted || error !== signal.reason) throw error;
    } finally {
      response.off("close", cancel);
      recipePhotoTask = false;
    }
  });
  app.get("/api/weeks", async (_request, response) => {
    const { weeks } = await storeFor(response).read();
    response.json(Object.values(weeks).map((week) => ({
      week: week.week, status: week.status, count: week.meals.length,
      days: week.meals.map((meal) => meal.day),
      titles: week.meals.map((meal) => "recipe" in meal ? meal.recipe.title : meal.title),
      images: week.meals.map((meal) => "recipe" in meal ? meal.recipe.image : ""),
      meals: week.meals.map((meal) => "recipe" in meal
        ? { day: meal.day, title: meal.recipe.title, recipeId: meal.recipe.id }
        : { day: meal.day, title: meal.title }),
    })));
  });
  app.get("/api/weeks/:week", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    response.json((await storeFor(response).read()).weeks[key] ?? null);
  });
  app.post("/api/weeks/:week/copy", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const { fromWeek } = z.object({ fromWeek: weekKeySchema }).strict().parse(request.body);
    response.status(201).json(await storeFor(response).update((state) => {
      if (state.weeks[key]) throw new AppError(409, `The week starting ${key} already has a plan.`);
      const source = structuredClone(requireWeek(state.weeks, fromWeek));
      source.week = key;
      source.status = "draft";
      source.confirmedAt = null;
      source.revision = 1;
      source.shoppingList = [];
      for (const meal of source.meals) if ("recipe" in meal) delete meal.cooked;
      state.weeks[key] = source;
      return source;
    }));
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
      const weeks = keys.map((key) => {
        const week = planWeek(key, input, pool, recentRecipeIds(state.weeks, key), makeAgainRecipeIds(state.recipeFeedback));
        state.weeks[key] = week;
        return week;
      });
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
      const next = planWeek(key, input, recipePool(state.recipes, sources, scope),
        recentRecipeIds(state.weeks, key), makeAgainRecipeIds(state.recipeFeedback));
      if (current) {
        next.meals.push(...current.meals.filter((meal) => "type" in meal && !input.days.includes(meal.day)));
        next.meals.sort((a, b) => a.day - b.day);
      }
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
    response.json(alternatives(week, day, recipePool(state.recipes, await recipeSources(response, scope), scope),
      recentRecipeIds(state.weeks, key), makeAgainRecipeIds(state.recipeFeedback)));
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
      swapMeal(week, input.day, recipePool(state.recipes, sources, scope), input.recipeId,
        recentRecipeIds(state.weeks, key), makeAgainRecipeIds(state.recipeFeedback));
      week.revision++;
      return week;
    }));
  });
  app.post("/api/weeks/:week/custom", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = revisionSchema.extend({ day: daySchema, title: z.string().trim().min(1).max(120) }).parse(request.body);
    response.json(await storeFor(response).update((state) => {
      const week = requireWeek(state.weeks, key);
      assertEditable(week, input.revision);
      const existing = week.meals.find((meal) => meal.day === input.day);
      if (existing && "recipe" in existing) throw new AppError(409, "Choose an open night to add a custom plan.");
      if (existing) existing.title = input.title;
      else week.meals.push({ day: input.day, type: "custom", title: input.title });
      week.meals.sort((a, b) => a.day - b.day);
      week.revision++;
      return week;
    }));
  });
  app.post("/api/weeks/:week/remove-custom", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = revisionSchema.extend({ day: daySchema }).parse(request.body);
    response.json(await storeFor(response).update((state) => {
      const week = requireWeek(state.weeks, key);
      assertEditable(week, input.revision);
      const index = week.meals.findIndex((meal) => meal.day === input.day);
      if (index < 0 || "recipe" in week.meals[index]) throw new AppError(404, "There is no custom plan on that day.");
      week.meals.splice(index, 1);
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
      if (!("recipe" in meal)) throw new AppError(409, "Custom plans don't have cooking progress.");
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
  app.get(["/", "/index.html"], async (_request, response) => {
    const html = await readFile(fileURLToPath(new URL("../public/build/index.html", import.meta.url)), "utf8");
    response.type("html").send(html.replaceAll("__CSP_NONCE__", response.locals.styleNonce ?? ""));
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
