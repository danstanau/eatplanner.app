import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { extractionSchema, photoSchema, recipeSchema, type Recipe } from "./recipes.js";
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

test("diet and time limits are hard constraints with actionable infeasibility errors", () => {
  assert.throws(() => planWeek("2026-11-16", { days: [0, 1, 2], people: 2, rules: { ...rules, diet: "vegan" } }, recipes), /Only 2 different proteins/);
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
  swapMeal(week, 0, recipes, options[0].id);
  assert.equal(week.meals[0].recipe.id, options[0].id);
  assert.throws(() => swapMeal(week, 0, recipes, "not-a-recipe"), /No alternative/);
});

test("changing days exchanges occupied meals or moves to a free day without losing meals", () => {
  const week = planWeek("2026-11-16", { days: [0, 2], people: 2, rules }, recipes);
  const first = week.meals[0].recipe.id;
  const second = week.meals[1].recipe.id;
  moveMeal(week, 0, 2);
  assert.equal(week.meals.find((meal) => meal.day === 2)?.recipe.id, first);
  assert.equal(week.meals.find((meal) => meal.day === 0)?.recipe.id, second);
  moveMeal(week, 2, 6);
  assert.deepEqual(week.meals.map((meal) => meal.day), [0, 6]);
  assert.equal(week.meals.length, 2);
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
  assert.equal(extractionSchema.safeParse({ recipe: null, warnings: ["No readable recipe."] }).success, true);
  assert.equal(photoSchema.safeParse({ mimeType: "image/png", data: Buffer.from("not an image").toString("base64") }).success, false);
  assert.equal(photoSchema.safeParse({ mimeType: "text/html", data: "PHNjcmlwdD4=" }).success, false);
});
