import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import test from "node:test";
import { createApp } from "./app.js";
import { hashPassword, readAuthConfig } from "./auth.js";

test("household login protects private pages and APIs, rotates sessions and signs out", async (t) => {
  const password = "test household password";
  const auth = {
    username: "household",
    passwordHash: await hashPassword(password),
    publicOrigin: "https://meals.example.test",
  };
  let aiCalls = 0;
  const server = createApp({
    getStatus: async () => { aiCalls++; return { authenticated: true, model: "auto" }; },
    extractRecipe: async () => { throw new Error("Must not be called"); },
    findRecipeImage: async () => { throw new Error("Must not be called"); },
    generatePlan: async () => { throw new Error("Must not be called"); },
  }, undefined, { auth, allowNetworkAccess: true }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const login = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: auth.publicOrigin, ...headers },
    body: JSON.stringify(body),
  });
  for (const path of ["/", "/index.html", "/planner.js", "/images/chicken.jpg"]) {
    const response = await fetch(base + path, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.ok(response.headers.get("location")?.startsWith("/login?next="));
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const path of ["/login", "/login.js", "/base.css", "/design.css", "/login.css"]) {
    assert.equal((await fetch(base + path)).status, 200);
  }
  assert.deepEqual(await (await fetch(`${base}/api/auth/session`)).json(), { enabled: true, authenticated: false });
  for (const path of ["/status", "/recipes", "/weeks"]) {
    assert.equal((await fetch(`${base}/api${path}`)).status, 401);
  }
  const credentials = { username: auth.username, password };
  assert.equal((await login(credentials, { Origin: "https://other.example" })).status, 403);
  assert.equal((await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials),
  })).status, 403);
  for (const path of ["/recipes/find-image", "/recipes/convert-heic", "/plan"]) {
    assert.equal((await fetch(`${base}/api${path}`, {
      method: "POST", headers: { Origin: auth.publicOrigin, "Content-Type": "application/json" }, body: "{}",
    })).status, 401);
  }
  assert.equal(aiCalls, 0);
  assert.equal((await login({ username: "wrong", password })).status, 401);
  assert.equal((await login({ username: auth.username, password: "wrong" })).status, 401);
  const signedIn = await login(credentials);
  assert.equal(signedIn.status, 200);
  const setCookie = signedIn.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=604800/);
  const cookie = setCookie.split(";")[0];
  assert.ok(cookie.startsWith("__Host-eatplanner_session="));
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal(aiCalls, 1);
  const privatePage = await fetch(`${base}/`, { headers: { Cookie: cookie } });
  assert.equal(privatePage.status, 200);
  assert.equal(privatePage.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: cookie.slice(0, -1) } })).status, 401);
  const rotated = await login(credentials, { Cookie: cookie });
  const newCookie = (rotated.headers.get("set-cookie") ?? "").split(";")[0];
  assert.notEqual(newCookie, cookie);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).status, 401);
  const logout = await fetch(`${base}/api/auth/logout`, {
    method: "POST", headers: { Origin: auth.publicOrigin, Cookie: newCookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Expires=Thu, 01 Jan 1970/);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: newCookie } })).status, 401);
  for (let count = 0; count < 6; count++) assert.equal((await login({ username: "wrong", password: "wrong" })).status, 401);
  const throttled = await login(credentials);
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get("retry-after")) > 0);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(15 * 60 * 1000 + 1);
  const afterCooldown = await login(credentials);
  assert.equal(afterCooldown.status, 200);
  const expiringCookie = (afterCooldown.headers.get("set-cookie") ?? "").split(";")[0];
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000 + 1);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: expiringCookie } })).status, 401);
});

test("login configuration fails closed in production and rejects partial or invalid settings", async () => {
  assert.equal(readAuthConfig({}), undefined);
  assert.throws(() => readAuthConfig({ NODE_ENV: "production" }), /required in production/);
  assert.throws(() => readAuthConfig({ HOUSEHOLD_USERNAME: "household" }), /required in production/);
  const values = {
    HOUSEHOLD_USERNAME: "household", HOUSEHOLD_PASSWORD_HASH: await hashPassword("test household password"),
    APP_ORIGIN: "https://meals.example.test",
  };
  assert.equal(readAuthConfig({ ...values, NODE_ENV: "production" })?.publicOrigin, values.APP_ORIGIN);
  assert.throws(() => readAuthConfig({ ...values, APP_ORIGIN: "http://example.test", NODE_ENV: "production" }), /HTTPS/);
  assert.throws(() => readAuthConfig({ ...values, APP_ORIGIN: "https://example.test/path" }), /without a path/);
  assert.throws(() => readAuthConfig({ ...values, HOUSEHOLD_PASSWORD_HASH: "plaintext" }), /invalid/);
  await assert.rejects(hashPassword("short"), /12/);
  assert.notEqual(await hashPassword("test household password"), values.HOUSEHOLD_PASSWORD_HASH);
});

test("interactive setup stores only a password hash and preserves other environment settings", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(fileURLToPath(new URL("../.test-auth-setup-", import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = `${directory}/.env`;
  await writeFile(envFile, "COPILOT_MODEL=auto\nHOUSEHOLD_USERNAME=old\n");
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../scripts/setup-auth.ts", import.meta.url))], {
    cwd: directory, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const prompts = [
    ["Household username: ", "family"],
    ["App URL (e.g. https://meals.example.com): ", "https://meals.example.test"],
    ["Household password (12+ characters, hidden): ", "test setup password"],
    ["Repeat password: ", "test setup password"],
  ];
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    const next = prompts[0];
    if (next && output.includes(next[0])) {
      prompts.shift();
      child.stdin.write(`${next[1]}\n`);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const [code] = await once(child, "close");
  assert.equal(code, 0, errors);
  assert.equal(prompts.length, 0);
  assert.doesNotMatch(output, /test setup password/);
  const saved = await readFile(envFile, "utf8");
  assert.doesNotMatch(saved, /test setup password/);
  const values = parseEnv(saved);
  assert.equal(values.COPILOT_MODEL, "auto");
  assert.equal(values.HOUSEHOLD_USERNAME, "family");
  assert.equal(readAuthConfig(values)?.publicOrigin, "https://meals.example.test");
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
});
