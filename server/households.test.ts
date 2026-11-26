import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createApp } from "./app.js";
import { hashPassword } from "./auth.js";
import { Households } from "./households.js";

test("household registry persists identities, serializes duplicate names and reports damaged storage", async (t) => {
  const directory = await mkdtemp(fileURLToPath(new URL("../.test-households-", import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = `${directory}/households.json`;
  const households = new Households(path);
  const passwordHash = await hashPassword("test12");
  const results = await Promise.allSettled([
    households.save({ name: "Family", passwordHash }, "admin"),
    households.save({ name: " family ", passwordHash }, "admin"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await assert.rejects(households.save({ name: "ADMIN", passwordHash }, "admin"), /already in use/);
  const [family] = await households.list();
  await households.save({ id: family.id, name: "Renamed family" }, "admin");
  assert.equal((await new Households(path).findById(family.id))?.name, "Renamed family");
  await assert.rejects(households.save({ id: "00000000-0000-4000-8000-000000000000", name: "Missing" }, "admin"), /no longer exists/);
  assert.throws(() => households.store("../household"), /Invalid/);
  await writeFile(path, "{broken");
  await assert.rejects(new Households(path).list(), SyntaxError);
});

test("super admin manages isolated households and persists their data under DATA_DIR", async (t) => {
  const directory = await mkdtemp(fileURLToPath(new URL("../.test-household-admin-", import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  });
  const registryPath = `${directory}/households.json`;
  const adminStorePath = `${directory}/household.json`;
  const auth = {
    username: "stanfield",
    passwordHash: await hashPassword("admin-password"),
    publicOrigin: "https://meals.example.test",
  };
  const unused = async (): Promise<never> => { throw new Error("Household management must not call AI"); };
  const services = { getStatus: unused, generatePlan: unused, extractRecipe: unused, findRecipeImage: unused };
  const start = async () => {
    const server = createApp(services, undefined, { auth }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  let base = await start();
  const request = (path: string, cookie = "", body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(`${base}/api${path}`, {
    method,
    headers: { Cookie: cookie, Origin: auth.publicOrigin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async (username: string, password: string) => {
    const response = await request("/auth/login", "", { username, password });
    assert.equal(response.status, 200);
    return (response.headers.get("set-cookie") ?? "").split(";")[0];
  };
  assert.equal((await request("/admin/households")).status, 401);
  assert.equal((await request("/admin/households", "", { name: "Uninvited", password: "test12" })).status, 401);
  const admin = await login("stanfield", "admin-password");
  assert.deepEqual((await (await request("/auth/session", admin)).json()).user, {
    id: "1", name: "stanfield", isAdmin: true,
  });
  assert.equal((await request("/admin/households", admin, { name: "Too short", password: "short" })).status, 400);
  assert.equal((await request("/admin/households", admin, { name: "STANFIELD", password: "test12" })).status, 409);
  const alphaResponse = await request("/admin/households", admin, { name: "Alpha", password: "alpha-password" });
  assert.equal(alphaResponse.status, 201);
  const alpha = await alphaResponse.json();
  assert.deepEqual(Object.keys(alpha).sort(), ["id", "name"]);
  const betaResponse = await request("/admin/households", admin, { name: "Beta", password: "beta-password" });
  assert.equal(betaResponse.status, 201);
  const beta = await betaResponse.json();
  assert.equal((await request("/admin/households", admin, { name: " alpha ", password: "test12" })).status, 409);
  const alphaCookie = await login(" alpha ", "alpha-password");
  const secondAlphaCookie = await login("Alpha", "alpha-password");
  const betaCookie = await login("Beta", "beta-password");
  assert.equal((await request("/shopping")).status, 401);
  assert.deepEqual(await (await request("/shopping", alphaCookie)).json(), { revision: 0, items: [] });
  assert.equal((await request("/shopping", alphaCookie, { names: ["  "] })).status, 400);
  const additions = await Promise.all([
    request("/shopping", alphaCookie, { names: ["Milk", "Eggs"] }),
    request("/shopping", secondAlphaCookie, { names: ["Bread"] }),
  ]);
  assert.ok(additions.every((result) => result.status === 201));
  const sharedShopping = await (await request("/shopping", secondAlphaCookie)).json();
  assert.deepEqual(sharedShopping.items.map((item: { name: string }) => item.name).sort(), ["Bread", "Eggs", "Milk"]);
  const milk = sharedShopping.items.find((item: { name: string }) => item.name === "Milk");
  assert.equal((await request(`/shopping/${milk.id}`, secondAlphaCookie, { name: "Oat milk", checked: true }, "PATCH")).status, 200);
  assert.equal((await request("/shopping", alphaCookie, { names: ["oat milk"] })).status, 201);
  const editedShopping = await (await request("/shopping", alphaCookie)).json();
  assert.equal(editedShopping.items.length, 3);
  assert.deepEqual(editedShopping.items.find((item: { id: string }) => item.id === milk.id), { id: milk.id, name: "Oat milk", checked: true });
  assert.deepEqual(await (await request("/shopping", betaCookie)).json(), { revision: 0, items: [] });
  assert.equal((await request(`/shopping/${milk.id}`, betaCookie, {}, "DELETE")).status, 404);
  assert.equal((await request(`/shopping/${milk.id}`, alphaCookie, {}, "DELETE")).status, 200);
  assert.equal((await request(`/shopping/${milk.id}`, alphaCookie, {}, "DELETE")).status, 404);
  assert.deepEqual((await (await request("/auth/session", alphaCookie)).json()).user, {
    id: alpha.id, name: "Alpha", isAdmin: false,
  });
  for (const cookie of [alphaCookie, betaCookie]) {
    assert.equal((await request("/admin/households", cookie)).status, 403);
    assert.equal((await request("/admin/households", cookie, { name: "Intruder", password: "test12" })).status, 403);
    assert.equal((await request(`/admin/households/${beta.id}`, cookie, { password: "hacked" }, "PATCH")).status, 403);
  }
  const starter = await (await request("/recipes", admin)).json();
  assert.deepEqual(await (await request("/recipes", alphaCookie)).json(), starter);
  const [{ id: starterId, source: _source, ...recipe }] = starter;
  for (const cookie of [admin, alphaCookie]) {
    const edit = await request(`/recipes/${starterId}`, cookie, { ...recipe, title: "Cannot edit starter" }, "PUT");
    assert.equal(edit.status, 403);
    assert.deepEqual(await edit.json(), { error: "Starter recipes are read-only." });
  }
  const adminRecipeResponse = await request("/recipes", admin, { ...recipe, title: "Super admin's recipe" });
  assert.equal(adminRecipeResponse.status, 201);
  const adminRecipe = await adminRecipeResponse.json();
  assert.equal(adminRecipe.householdId, "1");
  assert.ok(!(await (await request("/recipes", alphaCookie)).json()).some((item: { id: string }) => item.id === adminRecipe.id));
  const personalResponse = await request("/recipes", alphaCookie, { ...recipe, title: "Alpha's own recipe", householdId: beta.id });
  assert.equal(personalResponse.status, 201);
  const personal = await personalResponse.json();
  assert.equal(personal.householdId, alpha.id);
  const betaRecipeResponse = await request("/recipes", betaCookie, { ...recipe, title: "Beta's own recipe" });
  assert.equal(betaRecipeResponse.status, 201);
  const betaRecipe = await betaRecipeResponse.json();
  for (const cookie of [admin, betaCookie]) {
    assert.ok(!(await (await request("/recipes", cookie)).json()).some((item: { id: string }) => item.id === personal.id));
    assert.equal((await request(`/recipes/${personal.id}`, cookie, { ...recipe, title: "Not yours" }, "PUT")).status, 404);
  }
  const recipesFor = async (scope: string) => {
    const response = await request(`/recipes?scope=${scope}`, alphaCookie);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual((await recipesFor("household")).map((item: { id: string }) => item.id), [personal.id]);
  assert.deepEqual((await recipesFor("other-households")).map((item: { id: string }) => item.id), [adminRecipe.id, betaRecipe.id]);
  const all = await recipesFor("all");
  assert.equal(all.filter((item: { source: string }) => item.source === "personal").length, 3);
  assert.deepEqual(all.filter((item: { source: string }) => item.source === "collection"), starter);
  assert.equal(new Set(all.map((item: { id: string }) => item.id)).size, all.length);
  assert.equal((await request("/recipes?scope=invalid", alphaCookie)).status, 400);
  const rules = { differentProteins: false, overlapIngredients: false, maxMinutes: 180, diet: "anything" };
  const scopedRequest = { days: [0], people: 2, rules: { ...rules, recipeScope: "other-households" } };
  const scopedPlan = await request("/weeks/2026-11-23/plan", alphaCookie, scopedRequest);
  assert.equal(scopedPlan.status, 200);
  const sharedWeek = await scopedPlan.json();
  assert.equal(sharedWeek.rules.recipeScope, "other-households");
  assert.ok([adminRecipe.id, betaRecipe.id].includes(sharedWeek.meals[0].recipe.id));
  const [alternative] = await (await request("/weeks/2026-11-23/alternatives/0", alphaCookie)).json();
  assert.ok([adminRecipe.id, betaRecipe.id].includes(alternative.id));
  assert.notEqual(alternative.id, sharedWeek.meals[0].recipe.id);
  const swap = (recipeId: string) => request("/weeks/2026-11-23/swap", alphaCookie, { day: 0, revision: sharedWeek.revision, recipeId });
  assert.equal((await swap(personal.id)).status, 422);
  const swapped = await swap(alternative.id);
  assert.equal(swapped.status, 200);
  assert.equal((await swapped.json()).meals[0].recipe.householdId, alternative.householdId);
  const batch = await request("/weeks/plan", alphaCookie, {
    ...scopedRequest, startWeek: "2026-11-30", count: 2, rules: { ...rules, recipeScope: "household" },
  });
  assert.equal(batch.status, 200);
  assert.deepEqual((await batch.json()).map((week: typeof sharedWeek) => week.meals[0].recipe.id), [personal.id, personal.id]);
  const planned = await request("/weeks/2026-11-16/plan", alphaCookie, {
    days: [0, 2, 4], people: 2,
    rules: { differentProteins: false, overlapIngredients: false, maxMinutes: 60, diet: "anything" },
  });
  assert.equal(planned.status, 200);
  assert.equal((await (await request("/weeks", alphaCookie)).json()).length, 4);
  for (const cookie of [admin, betaCookie]) {
    assert.deepEqual(await (await request("/weeks", cookie)).json(), []);
    assert.equal(await (await request("/weeks/2026-11-16", cookie)).json(), null);
    assert.equal((await request("/weeks/2026-11-16/confirm", cookie, { revision: 1 })).status, 404);
  }
  assert.equal((await request(`/admin/households/${alpha.id}`, admin, { name: "Beta" }, "PATCH")).status, 409);
  assert.equal((await request(`/admin/households/${alpha.id}`, admin, { name: "New Alpha" }, "PATCH")).status, 200);
  assert.equal((await (await request("/auth/session", alphaCookie)).json()).user.name, "New Alpha");
  assert.equal((await request("/auth/login", "", { username: "Alpha", password: "alpha-password" })).status, 401);
  assert.equal((await request(`/admin/households/${alpha.id}`, admin, { password: "reset-password" }, "PATCH")).status, 200);
  assert.equal((await request("/recipes", alphaCookie)).status, 401);
  assert.equal((await request("/recipes", betaCookie)).status, 200);
  assert.equal((await request("/admin/households", admin)).status, 200);
  assert.equal((await request("/auth/login", "", { username: "New Alpha", password: "alpha-password" })).status, 401);
  const resetCookie = await login("New Alpha", "reset-password");
  assert.ok((await (await request("/recipes", resetCookie)).json()).some((item: { id: string }) => item.id === personal.id));
  const listed = await (await request("/admin/households", admin)).json();
  assert.deepEqual(listed, [{ id: alpha.id, name: "New Alpha" }, beta]);
  const disk = await readFile(registryPath, "utf8");
  assert.doesNotMatch(disk, /alpha-password|beta-password|reset-password/);
  assert.match(disk, /scrypt\$/);
  const savedAlpha = JSON.parse(await readFile(join(directory, "households", `${alpha.id}.json`), "utf8"));
  assert.ok(savedAlpha.recipes.some((item: { id: string }) => item.id === personal.id));
  assert.ok(savedAlpha.weeks["2026-11-16"]);
  const savedAdmin = JSON.parse(await readFile(adminStorePath, "utf8"));
  const savedRecipe = savedAdmin.recipes.find((item: { id: string }) => item.id === adminRecipe.id);
  assert.equal(savedRecipe.householdId, "1");
  delete savedRecipe.householdId;
  await writeFile(adminStorePath, JSON.stringify(savedAdmin));
  base = await start();
  assert.equal((await request("/admin/households", admin)).status, 401);
  const restartedAdmin = await login("stanfield", "admin-password");
  assert.deepEqual(await (await request("/admin/households", restartedAdmin)).json(), listed);
  const restartedAlpha = await login("New Alpha", "reset-password");
  assert.deepEqual((await (await request("/shopping", restartedAlpha)).json()).items.map((item: { name: string }) => item.name).sort(), ["Bread", "Eggs"]);
  assert.ok((await (await request("/recipes", restartedAlpha)).json()).some((item: { id: string }) => item.id === personal.id));
  assert.equal((await (await request("/weeks", restartedAlpha)).json()).length, 4);
  assert.ok((await (await request("/recipes", restartedAdmin)).json()).some((item: { id: string }) => item.id === adminRecipe.id));
  const legacyShared = (await (await request("/recipes?scope=other-households", restartedAlpha)).json())
    .find((item: { id: string }) => item.id === adminRecipe.id);
  assert.equal(legacyShared.householdId, "1");
});
