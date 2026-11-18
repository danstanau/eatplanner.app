import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { recipeSchema, type Recipe } from "./recipes.js";
import { weekKeySchema, weekSchema, type Week } from "./planner.js";

const stateSchema = z.object({
  recipes: z.array(recipeSchema),
  weeks: z.record(weekKeySchema, weekSchema),
});
type State = { recipes: Recipe[]; weeks: Record<string, Week> };

export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  private state: State | undefined;
  constructor(
    private path = fileURLToPath(new URL("../data/household.json", import.meta.url)),
    private seedPath = fileURLToPath(new URL("../data/recipes.json", import.meta.url)),
  ) {}

  private async load(): Promise<State> {
    if (this.state) return this.state;
    try {
      this.state = stateSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      this.state = { recipes: z.array(recipeSchema).parse(JSON.parse(await readFile(this.seedPath, "utf8"))), weeks: {} };
    }
    return this.state;
  }

  async read(): Promise<State> {
    await this.queue;
    return structuredClone(await this.load());
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
