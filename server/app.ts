import express, { type ErrorRequestHandler } from "express";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { preferencesSchema, type MealPlan, type Preferences } from "./plan.js";
import { extractionSchema, newRecipeSchema, photoSchema, type Extraction, type Photo } from "./recipes.js";
import { alternatives, AppError, assertEditable, daySchema, moveMeal, planningSchema, planWeek, shoppingList, swapMeal, weekKeySchema, type Week } from "./planner.js";
import { Store } from "./store.js";

interface Services {
  generatePlan: (preferences: Preferences) => Promise<MealPlan>;
  getStatus: () => Promise<{ authenticated: boolean; model: string }>;
  extractRecipe: (photo: Photo) => Promise<Extraction>;
}

const revisionSchema = z.object({ revision: z.number().int().min(1) });
function requireWeek(weeks: Record<string, Week>, key: string): Week {
  const week = weeks[key];
  if (!week) throw new AppError(404, "This week has not been planned yet.");
  return week;
}

export function createApp(services: Services, store = new Store()) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use("/api", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (request, response, next) => {
    const hostname = request.hostname;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
      response.status(403).json({ error: "Use this app through its local address." });
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      const origin = request.get("origin");
      if (origin && origin !== `${request.protocol}://${request.get("host")}`) {
        response.status(403).json({ error: "Changes must be requested from this app." });
        return;
      }
      if (!request.is("application/json")) {
        response.status(415).json({ error: "Send data as application/json." });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "4mb" }));
  app.get("/api/status", async (_request, response) => {
    response.json(await services.getStatus());
  });
  app.get("/api/recipes", async (_request, response) => {
    response.json((await store.read()).recipes);
  });
  app.post("/api/recipes", async (request, response) => {
    const content = newRecipeSchema.parse(request.body);
    const recipe = { ...content, id: randomUUID(), source: "personal" as const };
    response.status(201).json(await store.update((state) => {
      state.recipes.push(recipe);
      return recipe;
    }));
  });
  app.put("/api/recipes/:id", async (request, response) => {
    const content = newRecipeSchema.parse(request.body);
    response.json(await store.update((state) => {
      const index = state.recipes.findIndex((recipe) => recipe.id === request.params.id);
      if (index < 0) throw new AppError(404, "This recipe is no longer in your collection.");
      const recipe = { ...content, id: state.recipes[index].id, source: state.recipes[index].source };
      state.recipes[index] = recipe;
      return recipe;
    }));
  });
  let importing = false;
  app.post("/api/recipes/extract", async (request, response) => {
    const photo = photoSchema.parse(request.body);
    if (importing) throw new AppError(429, "A recipe is already being read. Please wait.");
    importing = true;
    try {
      const extraction = extractionSchema.parse(await services.extractRecipe(photo));
      if (!extraction.recipe) throw new AppError(422, extraction.warnings.join(" ") || "No readable recipe was found. Try a clearer photo of the ingredients and method.");
      response.json(extraction);
    } finally {
      importing = false;
    }
  });
  app.get("/api/weeks", async (_request, response) => {
    const { weeks } = await store.read();
    response.json(Object.values(weeks).map((week) => ({
      week: week.week, status: week.status, count: week.meals.length,
      days: week.meals.map((meal) => meal.day),
      titles: week.meals.map((meal) => meal.recipe.title),
    })));
  });
  app.get("/api/weeks/:week", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    response.json((await store.read()).weeks[key] ?? null);
  });
  app.post("/api/weeks/:week/plan", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = planningSchema.parse(request.body);
    response.json(await store.update((state) => {
      const current = state.weeks[key];
      if (current) assertEditable(current, input.revision ?? 0);
      else if (input.revision) throw new AppError(409, "This week no longer exists. Reload before planning.");
      const next = planWeek(key, input, state.recipes);
      next.revision = (current?.revision ?? 0) + 1;
      state.weeks[key] = next;
      return next;
    }));
  });
  app.get("/api/weeks/:week/alternatives/:day", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const day = daySchema.parse(Number(request.params.day));
    const state = await store.read();
    response.json(alternatives(requireWeek(state.weeks, key), day, state.recipes));
  });
  app.post("/api/weeks/:week/swap", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = revisionSchema.extend({ day: daySchema, recipeId: z.string().optional() }).parse(request.body);
    response.json(await store.update((state) => {
      const week = requireWeek(state.weeks, key);
      assertEditable(week, input.revision);
      swapMeal(week, input.day, state.recipes, input.recipeId);
      week.revision++;
      return week;
    }));
  });
  app.post("/api/weeks/:week/move", async (request, response) => {
    const key = weekKeySchema.parse(request.params.week);
    const input = revisionSchema.extend({ from: daySchema, to: daySchema }).parse(request.body);
    response.json(await store.update((state) => {
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
    response.json(await store.update((state) => {
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
    response.json(await store.update((state) => {
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
    if (origin && origin !== `${request.protocol}://${request.get("host")}`) {
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
    console.error("[eatplanner.app]", error instanceof Error ? error.message : "Unexpected error");
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
      error: "The request could not be completed. For photo imports, check copilot login, your allowance and a vision-capable model. See the server terminal for details.",
    });
  };
  app.use(handleError);
  return app;
}
