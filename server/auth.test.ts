import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import test from "node:test";
import { createApp } from "./app.js";
import { hashPassword, readAuthConfig } from "./auth.js";

test("household login protects private pages and APIs, rotates sessions and signs out", async (t) => {
  const password = "test12";
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
  for (const path of ["/login", "/login.js", "/theme.js", "/base.css", "/fonts/bricolage-grotesque.woff2", "/login.css", "/login-preview.svg", "/favicon.svg", "/apple-touch-icon.png"]) {
    assert.equal((await fetch(base + path)).status, 200);
  }
  const loginPage = await fetch(`${base}/login`);
  const loginHtml = await loginPage.text();
  const loginCsp = loginPage.headers.get("content-security-policy") ?? "";
  const loginNonce = loginCsp.match(/style-src 'self' 'nonce-([^']+)'/)?.[1];
  assert.ok(loginNonce);
  assert.match(loginCsp, /img-src 'self' data: blob: https:\/\/images\.unsplash\.com/);
  assert.match(loginCsp, /style-src-attr 'unsafe-inline'/);
  assert.ok(loginHtml.includes(`<meta name="csp-nonce" content="${loginNonce}">`));
  const loginScript = loginHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  assert.ok(loginScript?.startsWith("/build/"));
  assert.equal((await fetch(`${base}${loginScript}`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/auth/session`)).json(), { enabled: true, authenticated: false });
  for (const path of ["/status", "/recipes", "/weeks"]) {
    assert.equal((await fetch(`${base}/api${path}`)).status, 401);
  }
  const credentials = { username: auth.username, password };
  const wrongOrigin = await login(credentials, { Origin: "https://other.example" });
  assert.equal(wrongOrigin.status, 403);
  assert.deepEqual(await wrongOrigin.json(), {
    error: `This request must come from ${auth.publicOrigin}. Open that address, or update APP_ORIGIN and restart the server.`,
  });
  assert.equal((await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials),
  })).status, 403);
  for (const path of ["/recipes/find-image", "/recipes/convert-heic", "/plan"]) {
    assert.equal((await fetch(`${base}/api${path}`, {
      method: "POST", headers: { Origin: auth.publicOrigin, "Content-Type": "application/json" }, body: "{}",
    })).status, 401);
  }
  assert.equal((await fetch(`${base}/api/auth/signup`, {
    method: "POST", headers: { Origin: auth.publicOrigin, "Content-Type": "application/json" }, body: "{}",
  })).status, 401);
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
  const privateHtml = await privatePage.text();
  const privateCsp = privatePage.headers.get("content-security-policy") ?? "";
  const privateNonce = privateCsp.match(/style-src 'self' 'nonce-([^']+)'/)?.[1];
  assert.ok(privateNonce && privateNonce !== loginNonce);
  assert.match(privateCsp, /style-src-attr 'unsafe-inline'/);
  assert.ok(privateHtml.includes(`<meta name="csp-nonce" content="${privateNonce}">`));
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

test("local login redirects hostname aliases to the configured origin without weakening origin checks", async (t) => {
  const password = "test12";
  const auth = {
    username: "stanfield",
    passwordHash: await hashPassword(password),
    publicOrigin: "http://127.0.0.1",
  };
  const unused = async (): Promise<never> => { throw new Error("Login must not call planner services"); };
  const server = createApp({
    getStatus: unused, generatePlan: unused, extractRecipe: unused, findRecipeImage: unused,
  }, undefined, { auth }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  auth.publicOrigin = `http://127.0.0.1:${address.port}`;
  for (const host of [`localhost:${address.port}`, `[::1]:${address.port}`, "127.0.0.1:1234"]) {
    const response = await new Promise<{ status?: number; location?: string }>((resolve, reject) => {
      const request = httpRequest(`${auth.publicOrigin}/login?next=%2F%3Fview%3Drecipes`, {
        headers: { Host: host },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(response.status, 302);
    assert.equal(response.location, `${auth.publicOrigin}/login?next=%2F%3Fview%3Drecipes`);
  }
  assert.equal((await fetch(`${auth.publicOrigin}/login`, { redirect: "manual" })).status, 200);
  const login = (origin: string) => fetch(`${auth.publicOrigin}/api/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: auth.username, password }),
  });
  assert.equal((await login(`http://localhost:${address.port}`)).status, 403);
  assert.equal((await login(auth.publicOrigin)).status, 200);
});

test("login configuration is required everywhere and rejects partial or invalid settings", async () => {
  assert.throws(() => readAuthConfig({}), /Household login is required/);
  assert.throws(() => readAuthConfig({ NODE_ENV: "production" }), /Household login is required/);
  assert.throws(() => readAuthConfig({ HOUSEHOLD_USERNAME: "household" }), /Household login is required/);
  const values = {
    HOUSEHOLD_USERNAME: "household", HOUSEHOLD_PASSWORD_HASH: await hashPassword("test household password"),
    APP_ORIGIN: "https://meals.example.test",
  };
  assert.equal(readAuthConfig({ ...values, NODE_ENV: "production" }).publicOrigin, values.APP_ORIGIN);
  assert.throws(() => readAuthConfig({ ...values, APP_ORIGIN: "http://example.test", NODE_ENV: "production" }), /HTTPS/);
  assert.throws(() => readAuthConfig({ ...values, APP_ORIGIN: "http://example.test" }), /HTTPS/);
  assert.throws(() => readAuthConfig({ ...values, APP_ORIGIN: "http://192.168.1.10:3000" }), /HTTPS/);
  assert.equal(readAuthConfig({ ...values, APP_ORIGIN: "http://127.0.0.1:3000" }).publicOrigin, "http://127.0.0.1:3000");
  assert.throws(() => readAuthConfig({ ...values, APP_ORIGIN: "https://example.test/path" }), /without a path/);
  assert.throws(() => readAuthConfig({ ...values, HOUSEHOLD_PASSWORD_HASH: "plaintext" }), /invalid/);
  await assert.rejects(hashPassword("short"), /6/);
  assert.notEqual(await hashPassword("test household password"), values.HOUSEHOLD_PASSWORD_HASH);
});

test("server refuses to start without household credentials even in development", { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    env: { NODE_ENV: "development" }, stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const [code] = await once(child, "close");
  assert.notEqual(code, 0);
  assert.match(errors, /Household login is required/);
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
    ["Super admin name [stanfield]: ", ""],
    ["App URL (e.g. https://meals.example.com): ", "https://meals.example.test"],
    ["Household password (6+ characters, hidden): ", "test12"],
    ["Repeat password: ", "test12"],
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
  assert.doesNotMatch(output, /test12/);
  const saved = await readFile(envFile, "utf8");
  assert.doesNotMatch(saved, /test12/);
  const values = parseEnv(saved);
  assert.equal(values.COPILOT_MODEL, "auto");
  assert.equal(values.HOUSEHOLD_USERNAME, "stanfield");
  assert.equal(readAuthConfig(values).publicOrigin, "https://meals.example.test");
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
});
