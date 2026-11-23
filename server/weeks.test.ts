import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp } from "./app.js";
import { shoppingList } from "./planner.js";
import { Store } from "./store.js";
import { recipeSchema } from "./recipes.js";
import type { Week } from "./planner.js";

test("weekly HTTP workflow persists recipes, swaps and locks, and safely imports photo drafts", async (t) => {
  const temporary = await mkdtemp(join(fileURLToPath(new URL("../", import.meta.url)), ".test-household-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const path = join(temporary, "household.json");
  const store = new Store(path);
  const starter = await store.readStarterRecipes();
  const { id: _id, source: _source, image: _image, ...content } = starter[0];
  let photoCalls = 0;
  let imageSearch: unknown;
  let unreadable = false;
  const server = createApp({
    generatePlan: async () => { throw new Error("Weekly planning must not call a model."); },
    getStatus: async () => ({ authenticated: false, model: "auto" }),
    extractRecipe: async () => {
      photoCalls++;
      return { recipe: unreadable ? null : content, warnings: [unreadable ? "No readable recipe was found." : "Check the servings."] };
    },
    findRecipeImage: async (recipe) => {
      imageSearch = recipe;
      return {
        image: "/images/chicken.jpg",
        imageCredit: {
          creator: "Example photographer",
          sourceUrl: "https://example.com/photo",
          license: "CC0",
          licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        },
      };
    },
  }, store).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const invalidImageSearch = await post("/recipes/find-image", { title: "", description: "", protein: "", ingredients: [] });
  assert.equal(invalidImageSearch.status, 400);
  const imageSearchBody = { title: "Chicken curry", description: "A quick curry", protein: "chicken", ingredients: ["chicken thigh", "coconut milk"] };
  const foundImage = await post("/recipes/find-image", imageSearchBody);
  assert.equal(foundImage.status, 200);
  assert.deepEqual(imageSearch, imageSearchBody);
  assert.equal((await foundImage.json()).imageCredit.creator, "Example photographer");
  const key = "/weeks/2026-11-16";
  assert.equal(await (await fetch(base + key)).json(), null);
  assert.equal((await fetch(base + "/weeks/2026-11-17")).status, 400);
  const planned = await post(`${key}/plan`, {
    days: [0, 2, 4], people: 4,
    rules: { differentProteins: true, overlapIngredients: true, maxMinutes: 60, diet: "anything" },
  });
  assert.equal(planned.status, 200);
  let week: Week = await planned.json();
  const multiWeekPlan = await post("/weeks/plan", {
    startWeek: "2026-11-23", count: 3, days: [0, 2, 4], people: 4, adults: 2, children: 2,
    rules: { differentProteins: true, overlapIngredients: true, maxMinutes: 60, diet: "anything" },
  });
  assert.equal(multiWeekPlan.status, 200);
  const createdWeeks: Week[] = await multiWeekPlan.json();
  assert.deepEqual(createdWeeks.map((created) => created.week), ["2026-11-23", "2026-11-30", "2026-12-07"]);
  assert.ok(createdWeeks.every((created) => created.meals.length === 3));
  assert.ok(createdWeeks.every((created) => created.adults === 2 && created.children === 2 && created.people === 4));
  const savedCustom = await post("/weeks/2026-11-23/custom", {
    revision: createdWeeks[0].revision, day: 1, title: "Dinner with friends",
  });
  assert.equal(savedCustom.status, 200);
  const replan = await post("/weeks/2026-11-23/plan", {
    revision: createdWeeks[0].revision + 1, days: [0, 2, 4], people: 4, rules: createdWeeks[0].rules,
  });
  assert.equal(replan.status, 200);
  const replannedWeek: Week = await replan.json();
  assert.ok(replannedWeek.meals.some((meal) => "type" in meal && meal.title === "Dinner with friends"));
  assert.equal((await post("/weeks/2026-12-21/plan", {
    days: [0], people: 2, rules: week.rules,
  })).status, 200);
  const collision = await post("/weeks/plan", {
    startWeek: "2026-12-14", count: 3, days: [0, 2, 4], people: 4, rules: week.rules,
  });
  assert.equal(collision.status, 409);
  assert.equal(await (await fetch(`${base}/weeks/2026-12-14`)).json(), null);
  assert.equal(await (await fetch(`${base}/weeks/2026-12-28`)).json(), null);
  const choices = await (await fetch(`${base}${key}/alternatives/0`)).json();
  const swapped = await post(`${key}/swap`, { revision: week.revision, day: 0, recipeId: choices[0].id });
  assert.equal(swapped.status, 200);
  week = await swapped.json();
  assert.equal(week.meals[0].recipe.id, choices[0].id);
  assert.equal((await post(`${key}/move`, { revision: 1, from: 0, to: 6 })).status, 409);
  week = await (await post(`${key}/move`, { revision: week.revision, from: 0, to: 6 })).json();
  assert.deepEqual(week.meals.map((meal) => meal.day), [2, 4, 6]);
  assert.equal((await post(`${key}/custom`, { revision: week.revision, day: 2, title: "Eating out at Thai" })).status, 409);
  const custom = await post(`${key}/custom`, { revision: week.revision, day: 1, title: "  Eating out at Thai  " });
  assert.equal(custom.status, 200);
  week = await custom.json();
  assert.deepEqual(week.meals.find((meal) => meal.day === 1), { day: 1, type: "custom", title: "Eating out at Thai" });
  assert.equal((await post(`${key}/custom`, { revision: week.revision, day: 5, title: "   " })).status, 400);
  const summariesWithCustom = await (await fetch(base + "/weeks")).json();
  assert.equal(summariesWithCustom[0].count, 4);
  assert.ok(summariesWithCustom[0].titles.includes("Eating out at Thai"));
  const recipeMeals = week.meals.filter((meal) => "recipe" in meal);
  week = await (await post(`${key}/confirm`, { revision: week.revision })).json();
  assert.equal(week.status, "confirmed");
  assert.ok(week.confirmedAt);
  assert.ok(week.shoppingList.length > 0);
  assert.deepEqual(week.shoppingList, shoppingList({ people: week.people, meals: recipeMeals }));
  const snapshot = structuredClone(week);
  for (const [action, body] of [
    ["swap", { day: 2 }], ["move", { from: 2, to: 3 }],
    ["plan", { days: [1], people: 2, rules: week.rules }], ["confirm", {}],
  ] as const) {
    assert.equal((await post(`${key}/${action}`, { ...body, revision: week.revision })).status, 409);
  }
  const persisted = await new Store(path).read();
  assert.deepEqual(persisted.weeks[week.week], snapshot);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).weeks[week.week], snapshot);
  const completedMeal = week.meals.find((meal) => "recipe" in meal)!;
  const cooked = await post(`${key}/cooked`, { day: completedMeal.day, recipeId: completedMeal.recipe.id, cooked: true });
  assert.equal(cooked.status, 200);
  week = await cooked.json();
  assert.equal(week.meals.find((meal) => meal.day === completedMeal.day)?.cooked, true);
  assert.equal(week.revision, snapshot.revision, "cooking progress must not invalidate shopping checkmarks");
  assert.deepEqual(week.shoppingList, snapshot.shoppingList);
  assert.equal((await new Store(path).read()).weeks[week.week].meals.find((meal) => meal.day === completedMeal.day)?.cooked, true);
  assert.equal((await post(`${key}/cooked`, { day: completedMeal.day, recipeId: "stale-recipe", cooked: false })).status, 409);
  week = await (await post(`${key}/cooked`, { day: completedMeal.day, recipeId: completedMeal.recipe.id, cooked: false })).json();
  assert.equal(week.meals.find((meal) => meal.day === completedMeal.day)?.cooked, false);
  week = await (await post(`${key}/unlock`, { revision: week.revision })).json();
  assert.equal(week.status, "draft");
  assert.deepEqual(week.shoppingList, []);
  week = await (await post(`${key}/remove-custom`, { revision: week.revision, day: 1 })).json();
  assert.equal(week.meals.some((meal) => meal.day === 1), false);

  const badImage = await post("/recipes/extract", { mimeType: "image/jpeg", data: Buffer.from("not a photo").toString("base64") });
  assert.equal(badImage.status, 400);
  assert.equal(photoCalls, 0);
  const image = (await readFile(new URL("../public/images/chicken.jpg", import.meta.url))).toString("base64");
  const extracted = await post("/recipes/extract", { mimeType: "image/jpeg", data: image });
  assert.equal(extracted.status, 200);
  assert.equal(photoCalls, 1);
  assert.equal((await store.read()).recipes.length, 0, "extraction must wait for user review before saving");
  unreadable = true;
  assert.equal((await post("/recipes/extract", { mimeType: "image/jpeg", data: image })).status, 422);
  const added = await post("/recipes", { ...content, title: "My reviewed recipe", image: "/images/chicken.jpg" });
  assert.equal(added.status, 201);
  const recipe = recipeSchema.parse(await added.json());
  assert.equal(recipe.source, "personal");
  assert.equal((await new Store(path).read()).recipes.length, 1);
  assert.equal((await new Store(path).read()).recipes.at(-1)?.title, "My reviewed recipe");
  const another = await post("/recipes", { ...content, title: "Another family recipe", image: "/images/chicken.jpg" });
  assert.equal(another.status, 201);
  assert.equal((await new Store(path).read()).recipes.length, 2);
  assert.deepEqual((await new Store(path).read()).recipes.slice(-2).map((item) => item.title), ["My reviewed recipe", "Another family recipe"]);
  assert.equal((await post("/recipes", { ...content, image: "https://untrusted.example/tracker.jpg" })).status, 400);
  const summaries = await (await fetch(base + "/weeks")).json();
  assert.equal(summaries[0].count, 3);

  const saved = await store.read();
  const seedPath = join(temporary, "updated-starter.json");
  const updatedStarter = [
    { ...starter[0], title: "Updated starter recipe" },
    { ...starter[1], id: "new-starter", title: "New starter recipe" },
  ];
  await writeFile(path, JSON.stringify({ ...saved, recipes: [...starter, ...saved.recipes] }));
  await writeFile(seedPath, JSON.stringify(updatedStarter));
  const restarted = new Store(path, seedPath);
  assert.deepEqual(await restarted.readStarterRecipes(), updatedStarter);
  assert.deepEqual(await restarted.read(), saved);
  await restarted.update((state) => { state.recipes[0].title = "Updated personal recipe"; });
  const rewritten = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(rewritten.recipes.map((item: { title: string }) => item.title), ["Updated personal recipe", "Another family recipe"]);
  assert.deepEqual(rewritten.weeks, saved.weeks);
});

test("failed storage mutations cannot change saved state or block subsequent writes", async (t) => {
  const temporary = await mkdtemp(join(fileURLToPath(new URL("../", import.meta.url)), ".test-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const store = new Store(join(temporary, "household.json"));
  const starter = await store.readStarterRecipes();
  await store.update((state) => {
    state.recipes.push(
      { ...starter[0], id: "first-personal", source: "personal", householdId: "1" },
      { ...starter[1], id: "second-personal", source: "personal", householdId: "1" },
    );
  });
  const original = (await store.read()).recipes[0].title;
  await assert.rejects(store.update((state) => {
    state.recipes[0].title = "Should not be saved";
    throw new Error("Failed transaction");
  }), /Failed transaction/);
  assert.equal((await store.read()).recipes[0].title, original);
  await Promise.all([
    store.update((state) => { state.recipes[0].title = "First"; }),
    store.update((state) => { state.recipes[1].title = "Second"; }),
  ]);
  const saved = await store.read();
  assert.equal(saved.recipes[0].title, "First");
  assert.equal(saved.recipes[1].title, "Second");
});
