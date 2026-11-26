import { z } from "zod";

export const proteins = ["chicken", "beef", "pork", "lamb", "fish", "tofu", "legumes", "eggs", "cheese", "other"] as const;
export const categories = ["quick", "comfort", "fresh", "one-pot"] as const;
export const units = ["g", "kg", "ml", "l", "tsp", "tbsp", "piece", "pinch"] as const;
export const ingredientSchema = z.object({
  name: z.string().trim().min(1).max(100).toLowerCase(),
  quantity: z.number().positive().max(100_000),
  unit: z.enum(units),
  pantry: z.boolean(),
});

export const recipeContentSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(400),
  category: z.enum(categories),
  protein: z.enum(proteins),
  diet: z.enum(["omnivore", "vegetarian", "vegan", "pescatarian"]),
  servings: z.number().int().min(1).max(12),
  prepMinutes: z.number().int().min(0).max(180),
  cookMinutes: z.number().int().min(0).max(360),
  ingredients: z.array(ingredientSchema).min(1).max(40),
  steps: z.array(z.string().trim().min(1).max(1500)).min(1).max(25),
  notes: z.string().max(1500),
});

const extractionIngredientSchema = ingredientSchema.extend({
  quantity: z.number().positive().max(100_000).nullable(),
  unit: z.enum(units).nullable(),
});
const extractionRecipeSchema = recipeContentSchema.extend({
  ingredients: z.array(extractionIngredientSchema).min(1).max(40),
});

export const recipeImageSchema = z.string().max(3_000_000).refine((value) => {
  if (/^\/images\/[a-z0-9-]+\.jpg$/.test(value) || /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "images.unsplash.com" && !url.username && !url.password;
  } catch { return false; }
}, "Use a bundled photo, a JPEG, PNG or WebP image, or an Unsplash photo.");

export const imageCreditSchema = z.object({
  creator: z.string().trim().min(1).max(200),
  sourceUrl: z.string().url().max(2000).refine((value) => value.startsWith("https://")),
  creatorUrl: z.string().url().max(2000).refine((value) => value.startsWith("https://")).optional(),
  license: z.string().trim().min(1).max(100),
  licenseUrl: z.string().url().max(2000).refine((value) => value.startsWith("https://")),
});

export const newRecipeSchema = recipeContentSchema.extend({
  image: recipeImageSchema,
  imageCredit: imageCreditSchema.optional(),
});
export const MAIN_HOUSEHOLD_ID = "1";
export const recipeScopeSchema = z.enum(["starter-and-household", "household", "other-households", "all"]);
export type RecipeScope = z.infer<typeof recipeScopeSchema>;
export const DEFAULT_RECIPE_SCOPE: RecipeScope = "starter-and-household";

export const recipeSchema = newRecipeSchema.extend({
  id: z.string().min(1).max(120),
  source: z.enum(["collection", "personal"]),
  householdId: z.union([z.literal(MAIN_HOUSEHOLD_ID), z.uuid()]).optional(),
});
export const extractionSchema = z.object({
  recipe: extractionRecipeSchema.nullable(),
  warnings: z.array(z.string().max(500)).max(25),
});

export const modelExtractionSchema = extractionSchema.extend({
  recipe: extractionRecipeSchema.extend({
    ingredients: z.array(extractionIngredientSchema.extend({
      estimated: z.boolean(),
    })).min(1).max(40),
  }).nullable(),
  warnings: z.array(z.string().max(500)).max(12),
});

export function prepareExtraction(result: z.infer<typeof modelExtractionSchema>): Extraction {
  if (!result.recipe) return result;
  const estimated: string[] = [];
  let incomplete = 0;
  const ingredients = result.recipe.ingredients.map(({ estimated: isEstimated, ...ingredient }) => {
    if (ingredient.quantity === null || ingredient.unit === null) {
      incomplete++;
    } else if (isEstimated) {
      estimated.push(ingredient.name);
    }
    return ingredient;
  });
  const warnings: string[] = [];
  let group = "";
  for (const item of estimated) {
    if (group && group.length + item.length + 2 > 440) {
      warnings.push(`Estimated amounts to review: ${group}.`);
      group = "";
    }
    group += `${group ? ", " : ""}${item}`;
  }
  if (group) warnings.push(`Estimated amounts to review: ${group}.`);
  if (incomplete) {
    warnings.push(`Complete missing quantities or units for ${incomplete} ingredient${incomplete === 1 ? "" : "s"} before saving.`);
  }
  return { recipe: { ...result.recipe, ingredients }, warnings: [...warnings, ...result.warnings] };
}

export const recipeImageSearchSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(400),
  protein: z.string().trim().max(30),
  ingredients: z.array(z.string().trim().min(1).max(100)).max(40),
  excludeSourceUrls: z.array(z.string().url().max(2000)).max(20).optional(),
});

export const photoSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z.string().min(8).max(2_900_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).superRefine((photo, context) => {
  const bytes = Buffer.from(photo.data, "base64");
  const valid = photo.mimeType === "image/jpeg"
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : photo.mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) context.addIssue({ code: "custom", message: "The image does not match its format." });
});
export const recipePhotosSchema = z.array(photoSchema).min(1).max(4).superRefine((photos, context) => {
  if (photos.reduce((total, photo) => total + photo.data.length, 0) > 3_800_000) {
    context.addIssue({ code: "custom", message: "Choose smaller photos or use fewer images (up to 4)." });
  }
});

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeContent = z.infer<typeof recipeContentSchema>;
export type ImageCredit = z.infer<typeof imageCreditSchema>;
export type Ingredient = z.infer<typeof ingredientSchema>;
export type Photo = z.infer<typeof photoSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
export type RecipeImageSearch = z.infer<typeof recipeImageSearchSchema>;
