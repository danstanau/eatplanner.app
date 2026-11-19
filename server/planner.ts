import { randomInt } from "node:crypto";
import { z } from "zod";
import { recipeSchema, recipeScopeSchema, type Ingredient, type Recipe } from "./recipes.js";

export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const weekKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 1;
}, "Choose a week starting on a Monday.");
export const daySchema = z.number().int().min(0).max(6);
export const rulesSchema = z.object({
  differentProteins: z.boolean(),
  overlapIngredients: z.boolean(),
  maxMinutes: z.number().int().min(10).max(180),
  diet: z.enum(["anything", "vegetarian", "vegan", "pescatarian"]),
  recipeScope: recipeScopeSchema.optional(),
});
export const planningSchema = z.object({
  days: z.array(daySchema).min(1).max(7).refine((days) => new Set(days).size === days.length, "Choose each day only once."),
  people: z.number().int().min(1).max(12),
  adults: z.number().int().min(0).max(12).optional(),
  children: z.number().int().min(0).max(12).optional(),
  rules: rulesSchema,
  revision: z.number().int().min(0).optional(),
});
export const batchPlanningSchema = planningSchema.omit({ revision: true }).extend({
  startWeek: weekKeySchema,
  count: z.number().int().min(2).max(12),
});
export const shoppingItemSchema = z.object({
  name: z.string(), quantity: z.number(), unit: z.string(), pantry: z.boolean(),
});
export const weekSchema = z.object({
  week: weekKeySchema,
  people: z.number().int().min(1).max(12),
  adults: z.number().int().min(0).max(12).optional(),
  children: z.number().int().min(0).max(12).optional(),
  rules: rulesSchema,
  meals: z.array(z.object({ day: daySchema, recipe: recipeSchema, cooked: z.boolean().optional() })).min(1).max(7),
  status: z.enum(["draft", "confirmed"]),
  confirmedAt: z.string().nullable(),
  revision: z.number().int().min(1),
  shoppingList: z.array(shoppingItemSchema),
});
export type Rules = z.infer<typeof rulesSchema>;
export type Week = z.infer<typeof weekSchema>;
export type Planning = z.infer<typeof planningSchema>;
export type ShoppingItem = z.infer<typeof shoppingItemSchema>;

export function eligible(recipe: Recipe, rules: Rules): boolean {
  if (recipe.prepMinutes + recipe.cookMinutes > rules.maxMinutes) return false;
  if (rules.diet === "vegan") return recipe.diet === "vegan";
  if (rules.diet === "vegetarian") return ["vegetarian", "vegan"].includes(recipe.diet);
  if (rules.diet === "pescatarian") return recipe.diet !== "omnivore";
  return true;
}

function orderCandidates(candidates: Recipe[], selected: Recipe[], overlap: boolean): Recipe[] {
  const names = new Set(selected.flatMap((recipe) => recipe.ingredients.filter((i) => !i.pantry).map((i) => i.name)));
  return candidates.map((recipe) => ({
    recipe,
    score: overlap ? recipe.ingredients.filter((i) => !i.pantry && names.has(i.name)).length : 0,
    tie: randomInt(1_000_000),
  })).sort((a, b) => b.score - a.score || a.tie - b.tie).map(({ recipe }) => recipe);
}

export function planWeek(week: string, input: Planning, recipes: Recipe[]): Week {
  const children = input.children ?? 0;
  const adults = input.adults ?? input.people - children;
  if (adults < 0 || adults + children !== input.people) {
    throw new AppError(400, "The adult and child counts must match the total people (1 to 12).");
  }
  const candidates = recipes.filter((recipe) => eligible(recipe, input.rules));
  const available = input.rules.differentProteins ? new Set(candidates.map((r) => r.protein)).size : candidates.length;
  if (available < input.days.length) {
    throw new AppError(422, `Only ${available} ${input.rules.differentProteins ? "different proteins" : "recipes"} match these rules. Choose fewer days, broaden the recipe source, relax the time/diet rules, turn off different proteins, or add recipes.`);
  }
  const selected: Recipe[] = [];
  const meals = [...input.days].sort((a, b) => a - b).map((day) => {
    const options = candidates.filter((recipe) => !selected.some((other) =>
      recipe.id === other.id || (input.rules.differentProteins && recipe.protein === other.protein)));
    const recipe = orderCandidates(options, selected, input.rules.overlapIngredients)[0];
    if (!recipe) throw new AppError(422, "No recipe matches these planning rules.");
    selected.push(recipe);
    return { day, recipe };
  });
  return {
    week, people: input.people, adults, children, rules: input.rules, meals,
    status: "draft", confirmedAt: null, revision: 1, shoppingList: [],
  };
}

export function alternatives(week: Week, day: number, recipes: Recipe[]): Recipe[] {
  const current = week.meals.find((meal) => meal.day === day);
  if (!current) throw new AppError(404, "There is no meal on that day.");
  const others = week.meals.filter((meal) => meal.day !== day).map((meal) => meal.recipe);
  const candidates = recipes.filter((recipe) => recipe.id !== current.recipe.id &&
    eligible(recipe, week.rules) &&
    !others.some((other) => recipe.id === other.id || (week.rules.differentProteins && recipe.protein === other.protein)));
  return orderCandidates(candidates, others, week.rules.overlapIngredients);
}

export function assertEditable(week: Week, revision: number) {
  if (week.revision !== revision) throw new AppError(409, "This week changed in another tab. Reload the week before editing.");
  if (week.status === "confirmed") throw new AppError(409, "This week is locked. Unlock it before making changes.");
}

export function swapMeal(week: Week, day: number, recipes: Recipe[], recipeId?: string) {
  const options = alternatives(week, day, recipes);
  const replacement = recipeId ? options.find((recipe) => recipe.id === recipeId) : options[0];
  if (!replacement) throw new AppError(422, "No alternative fits your rules. Change your planning rules or add another recipe.");
  const meal = week.meals.find((item) => item.day === day);
  if (!meal) throw new AppError(404, "Meal not found.");
  meal.recipe = replacement;
  delete meal.cooked;
}

export function moveMeal(week: Week, from: number, to: number) {
  const meal = week.meals.find((item) => item.day === from);
  if (!meal) throw new AppError(404, "Meal not found.");
  const target = week.meals.find((item) => item.day === to);
  if (target) target.day = from;
  meal.day = to;
  week.meals.sort((a, b) => a.day - b.day);
}

function normalise(ingredient: Ingredient): { quantity: number; unit: string } {
  const conversion: Record<string, { factor: number; unit: string }> = {
    kg: { factor: 1000, unit: "g" }, l: { factor: 1000, unit: "ml" },
    tbsp: { factor: 20, unit: "ml" }, tsp: { factor: 5, unit: "ml" },
  };
  const converted = conversion[ingredient.unit];
  return converted
    ? { quantity: ingredient.quantity * converted.factor, unit: converted.unit }
    : { quantity: ingredient.quantity, unit: ingredient.unit };
}

export function shoppingList(week: Pick<Week, "meals" | "people">): ShoppingItem[] {
  const items = new Map<string, ShoppingItem>();
  for (const { recipe } of week.meals) {
    for (const ingredient of recipe.ingredients) {
      const { quantity, unit } = normalise(ingredient);
      const name = ingredient.name.trim().toLowerCase().replace(/\s+/g, " ");
      const key = `${name}|${unit}`;
      const existing = items.get(key);
      const scaled = quantity * week.people / recipe.servings;
      if (existing) {
        existing.quantity += scaled;
        existing.pantry = existing.pantry && ingredient.pantry;
      } else {
        items.set(key, { name, quantity: scaled, unit, pantry: ingredient.pantry });
      }
    }
  }
  return [...items.values()].map((item) => ({
    ...item, quantity: Math.round(item.quantity * 100) / 100,
  })).sort((a, b) => Number(a.pantry) - Number(b.pantry) || a.name.localeCompare(b.name));
}
