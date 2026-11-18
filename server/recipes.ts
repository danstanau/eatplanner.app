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

export const recipeImageSchema = z.string().max(3_000_000).refine(
  (value) => /^\/images\/[a-z0-9-]+\.jpg$/.test(value) ||
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value),
  "Use a bundled photo or a JPEG, PNG or WebP image.",
);

export const newRecipeSchema = recipeContentSchema.extend({ image: recipeImageSchema });
export const recipeSchema = newRecipeSchema.extend({
  id: z.string().min(1).max(120),
  source: z.enum(["collection", "personal"]),
});
export const extractionSchema = z.object({
  recipe: recipeContentSchema.nullable(),
  warnings: z.array(z.string().max(500)).max(25),
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

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeContent = z.infer<typeof recipeContentSchema>;
export type Ingredient = z.infer<typeof ingredientSchema>;
export type Photo = z.infer<typeof photoSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
