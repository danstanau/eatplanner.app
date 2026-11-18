import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp } from "./app.js";
import { Store } from "./store.js";
import { recipeSchema } from "./recipes.js";
import type { Week } from "./planner.js";

test("weekly HTTP workflow persists recipes, swaps and locks, and safely imports photo drafts", async (t) => {
  const temporary = await mkdtemp(join(fileURLToPath(new URL("../", import.meta.url)), ".test-household-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const path = join(temporary, "household.json");
  const store = new Store(path);
  const seed = await store.read();
  const { id: _id, source: _source, image: _image, ...content } = seed.recipes[0];
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
  const choices = await (await fetch(`${base}${key}/alternatives/0`)).json();
  const swapped = await post(`${key}/swap`, { revision: week.revision, day: 0, recipeId: choices[0].id });
  assert.equal(swapped.status, 200);
  week = await swapped.json();
  assert.equal(week.meals[0].recipe.id, choices[0].id);
  assert.equal((await post(`${key}/move`, { revision: 1, from: 0, to: 6 })).status, 409);
  week = await (await post(`${key}/move`, { revision: week.revision, from: 0, to: 6 })).json();
  assert.deepEqual(week.meals.map((meal) => meal.day), [2, 4, 6]);
  week = await (await post(`${key}/confirm`, { revision: week.revision })).json();
  assert.equal(week.status, "confirmed");
  assert.ok(week.confirmedAt);
  assert.ok(week.shoppingList.length > 0);
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
  week = await (await post(`${key}/unlock`, { revision: week.revision })).json();
  assert.equal(week.status, "draft");
  assert.deepEqual(week.shoppingList, []);

  const badImage = await post("/recipes/extract", { mimeType: "image/jpeg", data: Buffer.from("not a photo").toString("base64") });
  assert.equal(badImage.status, 400);
  assert.equal(photoCalls, 0);
  const image = (await readFile(new URL("../public/images/chicken.jpg", import.meta.url))).toString("base64");
  const extracted = await post("/recipes/extract", { mimeType: "image/jpeg", data: image });
  assert.equal(extracted.status, 200);
  assert.equal(photoCalls, 1);
  assert.equal((await store.read()).recipes.length, seed.recipes.length, "extraction must wait for user review before saving");
  unreadable = true;
  assert.equal((await post("/recipes/extract", { mimeType: "image/jpeg", data: image })).status, 422);
  const added = await post("/recipes", { ...content, title: "My reviewed recipe", image: "/images/chicken.jpg" });
  assert.equal(added.status, 201);
  const recipe = recipeSchema.parse(await added.json());
  assert.equal(recipe.source, "personal");
  assert.equal((await new Store(path).read()).recipes.at(-1)?.title, "My reviewed recipe");
  assert.equal((await post("/recipes", { ...content, image: "https://untrusted.example/tracker.jpg" })).status, 400);
  const summaries = await (await fetch(base + "/weeks")).json();
  assert.equal(summaries[0].count, 3);
});

test("failed storage mutations cannot change saved state or block subsequent writes", async (t) => {
  const temporary = await mkdtemp(join(fileURLToPath(new URL("../", import.meta.url)), ".test-store-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const store = new Store(join(temporary, "household.json"));
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
