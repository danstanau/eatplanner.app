import assert from "node:assert/strict";
import { once } from "node:events";
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
