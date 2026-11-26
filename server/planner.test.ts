import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { extractionSchema, modelExtractionSchema, photoSchema, prepareExtraction, recipePhotosSchema, recipeSchema, type Recipe } from "./recipes.js";
import { alternatives, assertEditable, moveMeal, planWeek, planningSchema, shoppingList, swapMeal, weekKeySchema, type Rules } from "./planner.js";

const recipes = z.array(recipeSchema).parse(JSON.parse(await readFile(new URL("../data/recipes.json", import.meta.url), "utf8")));
const rules: Rules = { differentProteins: true, overlapIngredients: true, maxMinutes: 60, diet: "anything" };

test("a full week has one meal per chosen day and genuinely different proteins", () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const week = planWeek("2026-11-16", { days: [6, 0, 3, 5, 1, 4, 2], people: 4, rules }, recipes);
    assert.deepEqual(week.meals.map((meal) => meal.day), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(new Set(week.meals.map((meal) => meal.recipe.protein)).size, 7);
    assert.equal(new Set(week.meals.map((meal) => meal.recipe.id)).size, 7);
  }
});

test("recently planned recipes are avoided when alternatives exist but remain available as a fallback", () => {
  const [recent, fresh] = recipes;
  const input = { days: [0], people: 2, rules: { ...rules, differentProteins: false } };
  assert.equal(planWeek("2026-11-16", input, [recent, fresh], new Set([recent.id])).meals[0].recipe.id, fresh.id);
  assert.ok([recent.id, fresh.id].includes(planWeek("2026-11-16", input, [recent, fresh], new Set([recent.id, fresh.id])).meals[0].recipe.id));
  assert.equal(planWeek("2026-11-16", input, [recent, fresh], new Set(), new Set([fresh.id])).meals[0].recipe.id, fresh.id);
  assert.equal(planWeek("2026-11-16", input, [recent, fresh], new Set([fresh.id]), new Set([fresh.id])).meals[0].recipe.id, recent.id);
});

test("diet and time limits are hard constraints with actionable infeasibility errors", () => {
  const veganProteins = new Set(recipes.filter((recipe) => recipe.diet === "vegan").map((recipe) => recipe.protein));
  assert.throws(() => planWeek("2026-11-16", {
    days: Array.from({ length: veganProteins.size + 1 }, (_, day) => day),
    people: 2, rules: { ...rules, diet: "vegan" },
  }, recipes), new RegExp(`Only ${veganProteins.size} different proteins`));
  const week = planWeek("2026-11-16", { days: [0, 2, 4], people: 2, rules: { ...rules, diet: "vegan", differentProteins: false } }, recipes);
  assert.ok(week.meals.every(({ recipe }) => recipe.diet === "vegan"));
  const quick = planWeek("2026-11-16", { days: [1], people: 2, rules: { ...rules, maxMinutes: 20 } }, recipes);
  assert.ok(quick.meals.every(({ recipe }) => recipe.prepMinutes + recipe.cookMinutes <= 20));
});

test("swap options preserve rules and favour overlapping fresh ingredients, not pantry staples", () => {
  const week = planWeek("2026-11-16", { days: [0, 1, 2, 3, 4], people: 2, rules }, recipes);
  const previous = week.meals[0].recipe.id;
  const options = alternatives(week, 0, recipes);
  const others = week.meals.slice(1).map((meal) => meal.recipe);
  assert.ok(options.length > 0);
  for (const recipe of options) {
    assert.notEqual(recipe.id, previous);
    assert.ok(!others.some((other) => other.id === recipe.id || other.protein === recipe.protein));
  }
  const names = new Set(others.flatMap((recipe) => recipe.ingredients.filter((i) => !i.pantry).map((i) => i.name)));
  const scores = options.map((recipe) => recipe.ingredients.filter((i) => !i.pantry && names.has(i.name)).length);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  week.meals[0].cooked = true;
  swapMeal(week, 0, recipes, options[0].id);
  assert.equal(week.meals[0].recipe.id, options[0].id);
  assert.equal(week.meals[0].cooked, undefined);
  assert.throws(() => swapMeal(week, 0, recipes, "not-a-recipe"), /No alternative/);
});

test("changing days exchanges occupied meals or moves to a free day without losing meals", () => {
  const week = planWeek("2026-11-16", { days: [0, 2], people: 2, rules }, recipes);
  const first = week.meals[0].recipe.id;
  const second = week.meals[1].recipe.id;
  week.meals[0].cooked = true;
  moveMeal(week, 0, 2);
  assert.equal(week.meals.find((meal) => meal.day === 2)?.recipe.id, first);
  assert.equal(week.meals.find((meal) => meal.day === 0)?.recipe.id, second);
  moveMeal(week, 2, 6);
  assert.deepEqual(week.meals.map((meal) => meal.day), [0, 6]);
  assert.equal(week.meals.length, 2);
  assert.equal(week.meals.find((meal) => meal.day === 6)?.cooked, true);
});

test("adult and child counts persist without changing per-person ingredient scaling", () => {
  const input = { days: [0], people: 4, adults: 2, children: 2, rules };
  const week = planWeek("2026-11-16", input, recipes);
  assert.equal(week.adults, 2);
  assert.equal(week.children, 2);
  assert.deepEqual(shoppingList(week), shoppingList({ people: 4, meals: week.meals }));
  assert.throws(() => planWeek("2026-11-16", { ...input, people: 3 }, recipes), /counts must match/);
  const legacy = planWeek("2026-11-16", { days: [0], people: 2, rules }, recipes);
  assert.equal(legacy.adults, 2);
  assert.equal(legacy.children, 0);
  const childrenOnly = planWeek("2026-11-16", { ...input, adults: 0, children: 4 }, recipes);
  assert.equal(childrenOnly.adults, 0);
  assert.equal(planningSchema.safeParse({ ...input, adults: -1 }).success, false);
  assert.equal(planningSchema.safeParse({ ...input, children: 1.5 }).success, false);
  assert.equal(planningSchema.safeParse({ ...input, people: 0, adults: 0, children: 0 }).success, false);
});

test("shopping combines compatible units, scales servings and keeps incompatible units separate", () => {
  const base = recipes[0];
  const make = (id: string, ingredients: Recipe["ingredients"], servings: number): Recipe => ({ ...base, id, servings, ingredients });
  const list = shoppingList({
    people: 4,
    meals: [
      { day: 0, recipe: make("a", [{ name: "potato", quantity: 0.5, unit: "kg", pantry: false }, { name: "olive oil", quantity: 1, unit: "tbsp", pantry: true }, { name: "tomato", quantity: 2, unit: "piece", pantry: false }], 2) },
      { day: 2, recipe: make("b", [{ name: "potato", quantity: 250, unit: "g", pantry: false }, { name: "olive oil", quantity: 5, unit: "ml", pantry: true }, { name: "tomato", quantity: 100, unit: "g", pantry: false }], 4) },
    ],
  });
  assert.deepEqual(list.find((item) => item.name === "potato"), { name: "potato", quantity: 1250, unit: "g", pantry: false });
  assert.deepEqual(list.find((item) => item.name === "olive oil"), { name: "olive oil", quantity: 45, unit: "ml", pantry: true });
  assert.equal(list.filter((item) => item.name === "tomato").length, 2);
});

test("week validation rejects duplicate days, non-Mondays and impossible dates; locks reject edits", () => {
  assert.equal(weekKeySchema.safeParse("2026-11-16").success, true);
  for (const key of ["2026-11-17", "2026-02-30", "not-a-date"]) assert.equal(weekKeySchema.safeParse(key).success, false);
  assert.equal(planningSchema.safeParse({ days: [0, 0], people: 2, rules }).success, false);
  const week = planWeek("2026-11-16", { days: [0], people: 2, rules }, recipes);
  assert.throws(() => assertEditable(week, 99), /another tab/);
  week.status = "confirmed";
  assert.throws(() => assertEditable(week, week.revision), /locked/);
});

test("photo extraction schema is SDK-compatible and invalid image types are rejected", () => {
  assert.doesNotThrow(() => extractionSchema.toJSONSchema());
  assert.doesNotThrow(() => modelExtractionSchema.toJSONSchema());
  assert.equal(extractionSchema.safeParse({ recipe: null, warnings: ["No readable recipe."] }).success, true);
  assert.equal(extractionSchema.safeParse({
    recipe: {
      title: "Lamb penne", description: "Penne with lamb.", category: "comfort", protein: "lamb", diet: "omnivore",
      servings: 2, prepMinutes: 10, cookMinutes: 20,
      ingredients: [{ name: "lamb mince", quantity: null, unit: null, pantry: false }],
      steps: ["Cook the pasta."], notes: "",
    },
    warnings: [],
  }).success, true);
  assert.equal(photoSchema.safeParse({ mimeType: "image/png", data: Buffer.from("not an image").toString("base64") }).success, false);
  assert.equal(photoSchema.safeParse({ mimeType: "text/html", data: "PHNjcmlwdD4=" }).success, false);
  const photo = { mimeType: "image/jpeg" as const, data: Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0]).toString("base64") };
  assert.equal(recipePhotosSchema.safeParse([photo, photo]).success, true);
  assert.equal(recipePhotosSchema.safeParse([]).success, false);
  assert.equal(recipePhotosSchema.safeParse(Array.from({ length: 5 }, () => photo)).success, false);
  const largePhoto = { ...photo, data: photo.data + "A".repeat(1_900_000) };
  assert.equal(recipePhotosSchema.safeParse([largePhoto, largePhoto]).success, false);
});

test("photo estimates are retained and explicitly identified for review", () => {
  const result = prepareExtraction(modelExtractionSchema.parse({
    recipe: {
      title: "Lamb penne", description: "Penne with lamb.", category: "comfort", protein: "lamb", diet: "omnivore",
      servings: 2, prepMinutes: 10, cookMinutes: 20,
      ingredients: [
        { name: "lamb mince", quantity: 250, unit: "g", pantry: false, estimated: true },
        { name: "pasta", quantity: 200, unit: "g", pantry: true, estimated: false },
        { name: "oil", quantity: null, unit: null, pantry: true, estimated: true },
      ],
      steps: ["Cook the pasta."], notes: "",
    },
    warnings: ["The method is incomplete."],
  }));
  assert.deepEqual(result.recipe?.ingredients[0], { name: "lamb mince", quantity: 250, unit: "g", pantry: false });
  assert.deepEqual(result.warnings, [
    "Estimated amounts to review: lamb mince.",
    "Complete missing quantities or units for 1 ingredient before saving.",
    "The method is incomplete.",
  ]);
  assert.equal(extractionSchema.safeParse(result).success, true);
});
