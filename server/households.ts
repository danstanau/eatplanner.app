import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AppError } from "./planner.js";
import { householdDataPath, Store } from "./store.js";

export const householdNameSchema = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, "Use a household name on one line.");
export const passwordSchema = z.string().min(6, "Use at least 6 characters.").max(1024);
const householdSchema = z.object({
  id: z.uuid(),
  name: householdNameSchema,
  passwordHash: z.string().regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/),
});
const registrySchema = z.array(householdSchema).superRefine((households, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const household of households) {
    const name = household.name.toLowerCase();
    if (ids.has(household.id) || names.has(name)) context.addIssue({ code: "custom", message: "Household names and IDs must be unique." });
    ids.add(household.id);
    names.add(name);
  }
});
type Household = z.infer<typeof householdSchema>;

export class Households {
  private queue: Promise<unknown> = Promise.resolve();
  private records: Household[] | undefined;
  private stores = new Map<string, Store>();

  constructor(private path = householdDataPath("households.json")) {}

  private async load(): Promise<Household[]> {
    if (this.records) return this.records;
    try {
      this.records = registrySchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      this.records = [];
    }
    return this.records;
  }

  async list(): Promise<Household[]> {
    await this.queue;
    return structuredClone(await this.load());
  }

  async findByName(name: string) {
    return (await this.list()).find((household) => household.name.toLowerCase() === name.trim().toLowerCase());
  }

  async findById(id: string) {
    return (await this.list()).find((household) => household.id === id);
  }

  save(input: { id?: string; name?: string; passwordHash?: string }, adminName: string): Promise<Household> {
    const task = this.queue.then(async () => {
      const records = structuredClone(await this.load());
      const current = input.id ? records.find((household) => household.id === input.id) : undefined;
      if (input.id && !current) throw new AppError(404, "This household no longer exists.");
      const household = householdSchema.parse({
        id: current?.id ?? randomUUID(),
        name: input.name ?? current?.name,
        passwordHash: input.passwordHash ?? current?.passwordHash,
      });
      const name = household.name.toLowerCase();
      if (name === adminName.trim().toLowerCase() || records.some((item) => item.id !== household.id && item.name.toLowerCase() === name)) {
        throw new AppError(409, "That household name is already in use.");
      }
      if (current) records[records.indexOf(current)] = household;
      else records.push(household);
      registrySchema.parse(records);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, JSON.stringify(records, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
      this.records = records;
      return structuredClone(household);
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  store(id: string): Store {
    const key = z.uuid().parse(id);
    let store = this.stores.get(key);
    if (!store) {
      store = new Store(join(dirname(this.path), "households", `${key}.json`), undefined, key);
      this.stores.set(key, store);
    }
    return store;
  }
}
