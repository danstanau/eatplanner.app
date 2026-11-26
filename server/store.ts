import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MAIN_HOUSEHOLD_ID, recipeSchema, type Recipe } from "./recipes.js";
import { weekKeySchema, weekSchema, type Week } from "./planner.js";

const stateSchema = z.object({
  recipes: z.array(recipeSchema),
  weeks: z.record(weekKeySchema, weekSchema),
  profiles: z.array(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(200) })).max(100).default([]),
  shopping: z.object({
    revision: z.number().int().min(0),
    items: z.array(z.object({
      id: z.uuid(),
      name: z.string().trim().min(1).max(200),
      checked: z.boolean(),
      createdBy: z.object({ id: z.uuid(), name: z.string().trim().min(1).max(200) }).nullable().default(null),
    })).max(1000),
  }).default({ revision: 0, items: [] }),
});
const starterRecipesSchema = z.array(recipeSchema.extend({ source: z.literal("collection") }));
type State = {
  recipes: Recipe[];
  weeks: Record<string, Week>;
  profiles: z.infer<typeof stateSchema>["profiles"];
  shopping: z.infer<typeof stateSchema>["shopping"];
};

export function householdDataPath(filename: string): string {
  const directory = process.env.DATA_DIR?.trim() || fileURLToPath(new URL("../data/", import.meta.url));
  return resolve(directory, filename);
}

export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  private state: State | undefined;
  private starterRecipes: Promise<Recipe[]> | undefined;
  constructor(
    private path = householdDataPath("household.json"),
    private seedPath = fileURLToPath(new URL("../data/recipes.json", import.meta.url)),
    private householdId = MAIN_HOUSEHOLD_ID,
  ) {}

  private async load(): Promise<State> {
    if (this.state) return this.state;
    try {
      this.state = stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      this.state = { recipes: [], weeks: {}, profiles: [], shopping: { revision: 0, items: [] } };
    }
    // Older saves included a copy of the bundled library.
    this.state.recipes = this.state.recipes.filter((recipe) => recipe.source === "personal");
    // Older files kept ownership implicitly in the file that held the recipe.
    for (const recipe of this.state.recipes) this.fillOwner(recipe);
    for (const week of Object.values(this.state.weeks)) {
      for (const meal of week.meals) if ("recipe" in meal) this.fillOwner(meal.recipe);
    }
    return this.state;
  }

  private fillOwner(recipe: Recipe) {
    if (recipe.source === "personal") recipe.householdId ??= this.householdId;
  }

  async read(): Promise<State> {
    await this.queue;
    return structuredClone(await this.load());
  }

  async readRecipes(): Promise<Recipe[]> {
    await this.queue;
    return structuredClone((await this.load()).recipes);
  }

  async readStarterRecipes(): Promise<Recipe[]> {
    this.starterRecipes ??= readFile(this.seedPath, "utf8").then((json) => starterRecipesSchema.parse(JSON.parse(json)));
    return structuredClone(await this.starterRecipes);
  }

  update<T>(change: (state: State) => T): Promise<T> {
    const task = this.queue.then(async () => {
      const next = structuredClone(await this.load());
      const result = change(next);
      stateSchema.parse(next);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
      this.state = next;
      return structuredClone(result);
    });
    // Keep later writes available after a failed mutation; the caller still receives its rejection.
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}
