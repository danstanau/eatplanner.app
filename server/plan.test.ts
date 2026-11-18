import assert from "node:assert/strict";
import test from "node:test";
import { preferencesSchema, validateMealPlan, type Preferences } from "./plan.js";

const preferences: Preferences = { people: 2, days: 1, diet: "anything", maxMinutes: 30, notes: "" };
const dinner = { name: "Chickpea salad", minutes: 15, ingredients: ["400 g chickpeas"], steps: ["Rinse chickpeas and combine with vegetables."] };
const plan = { summary: "A quick dinner.", dinners: [dinner], shoppingList: ["400 g chickpeas"] };

test("preferences reject invalid quantities, oversized notes, and extra fields", () => {
  for (const change of [{ people: 0 }, { days: 8 }, { people: 1.5 }, { diet: "unknown" }, { notes: "a".repeat(1501) }, { model: "expensive" }]) {
    assert.equal(preferencesSchema.safeParse({ ...preferences, ...change }).success, false);
  }
});

test("meal plans must match the requested dinner count and cooking-time limit", () => {
  assert.deepEqual(validateMealPlan(plan, preferences), plan);
  assert.throws(() => validateMealPlan({ ...plan, dinners: [dinner, dinner] }, preferences), /number of dinners/);
  assert.throws(() => validateMealPlan({ ...plan, dinners: [{ ...dinner, minutes: 40 }] }, preferences), /cooking-time limit/);
  assert.throws(() => validateMealPlan({ ...plan, dinners: [{ ...dinner, steps: [] }] }, preferences));
});
