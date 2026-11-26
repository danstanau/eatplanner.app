import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createApp } from "./app.js";
import type { MealPlan } from "./plan.js";

const preferences = { people: 2, days: 1, diet: "anything", maxMinutes: 30, notes: "" };
const plan: MealPlan = {
  summary: "A quick dinner.",
  dinners: [{ name: "Pasta", minutes: 20, ingredients: ["200 g pasta"], steps: ["Cook the pasta."] }],
  shoppingList: ["200 g pasta"],
};

test("HTTP routes validate input, isolate failures, and prevent duplicate generations", async (t) => {
  let calls = 0;
  let generate = async () => plan;
  const server = createApp({
    extractRecipe: async () => { throw new Error("Not used by this test"); },
    findRecipeImage: async () => { throw new Error("Not used by this test"); },
    getStatus: async () => ({ authenticated: true, model: "auto" }),
    generatePlan: async () => { calls++; return generate(); },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /eatplanner\.app/);
  assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), { authenticated: true, model: "auto" });
  assert.equal((await post({ ...preferences, days: 99 })).status, 400);
  assert.equal((await post(preferences, { Origin: "https://another-site.example" })).status, 403);
  assert.equal((await post(preferences, { "Content-Type": "text/plain" })).status, 415);
  const phonePhoto = await readFile(new URL("./fixtures/phone.heic", import.meta.url));
  const conversion = await fetch(`${base}/api/recipes/convert-heic`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: phonePhoto,
  });
  assert.equal(conversion.status, 200);
  assert.equal(conversion.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await conversion.arrayBuffer()).subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal((await fetch(`${base}/api/recipes/convert-heic`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "not an image",
  })).status, 400);
  assert.equal((await fetch(`${base}/api/recipes/convert-heic`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream", Origin: "https://another-site.example" }, body: phonePhoto,
  })).status, 403);
  assert.equal((await fetch(`${base}/api/plan`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
  })).status, 400);
  assert.equal(calls, 0);

  const success = await post(preferences);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), plan);

  generate = async () => { throw new Error("SDK test failure"); };
  assert.equal((await post(preferences)).status, 502);
  generate = async () => plan;
  assert.equal((await post(preferences)).status, 200);

  let release: (value: MealPlan) => void = () => { throw new Error("Generation has not started"); };
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  generate = () => new Promise<MealPlan>((resolve) => { release = resolve; markStarted(); });
  const pending = post(preferences);
  await started;
  const duplicate = await post(preferences);
  release(plan);
  assert.equal(duplicate.status, 429);
  assert.equal((await pending).status, 200);
});

test("network-host API requests require explicit opt-in", async (t) => {
  const services = {
    extractRecipe: async () => { throw new Error("Not used by this test"); },
    findRecipeImage: async () => { throw new Error("Not used by this test"); },
    getStatus: async () => ({ authenticated: true, model: "auto" }),
    generatePlan: async () => plan,
  };
  for (const allowNetworkAccess of [false, true]) {
    const server = createApp(services, undefined, { allowNetworkAccess }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path: "/api/status",
        headers: { Host: `192.168.4.33:${address.port}` },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, allowNetworkAccess ? 200 : 403);
  }
});

test("recipe extraction accepts multiple validated photos", async (t) => {
  let photoCount = 0;
  const server = createApp({
    extractRecipe: async (photos) => {
      photoCount = photos.length;
      return {
        recipe: {
          title: "Lamb penne", description: "Penne with lamb.", category: "comfort", protein: "lamb", diet: "omnivore",
          servings: 2, prepMinutes: 10, cookMinutes: 20,
          ingredients: [{ name: "lamb mince", quantity: 300, unit: "g", pantry: false }],
          steps: ["Cook the pasta."], notes: "",
        },
        warnings: [],
      };
    },
    findRecipeImage: async () => { throw new Error("Not used by this test"); },
    getStatus: async () => ({ authenticated: true, model: "auto" }),
    generatePlan: async () => plan,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const photo = { mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0]).toString("base64") };
  const extract = (photos: unknown[]) => fetch(`http://127.0.0.1:${address.port}/api/recipes/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photos }),
  });
  assert.equal((await extract([photo, photo])).status, 200);
  assert.equal(photoCount, 2);
  assert.equal((await extract(Array.from({ length: 5 }, () => photo))).status, 400);
  assert.equal(photoCount, 2);
});
