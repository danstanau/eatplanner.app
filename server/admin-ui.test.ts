import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Window } from "happy-dom";

test("super admin opens the gear page and adds, renames and resets household logins", async (t) => {
  const browser = new Window({
    url: "https://meals.example.test/?view=admin",
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  const document = browser.document;
  document.write(await readFile(new URL("../public/index.html", import.meta.url), "utf8"));
  const households: Array<{ id: string; name: string }> = [];
  const id = "00000000-0000-4000-8000-000000000001";
  let resetPassword = "";
  const originalTimeout = globalThis.setTimeout;
  const globals = {
    document, window: browser, navigator: browser.navigator, localStorage: browser.localStorage,
    fetch: async (url: string, options: RequestInit = {}) => {
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      if (url === "/api/auth/session") return Response.json({
        enabled: true, authenticated: true, user: { id: "1", name: "stanfield", isAdmin: true },
      });
      if (url === "/api/recipes" || url === "/api/weeks") return Response.json([]);
      if (url === "/api/admin/households" && options.method === "GET") return Response.json(households);
      if (url === "/api/admin/households" && options.method === "POST") {
        assert.deepEqual(body, { name: "Family", password: "secret1" });
        households.push({ id, name: body.name });
        return Response.json(households[0], { status: 201 });
      }
      if (url === `/api/admin/households/${id}` && options.method === "PATCH") {
        if (body.name === "Taken") return Response.json({ error: "That household name is already in use." }, { status: 409 });
        if (body.name) {
          assert.deepEqual(body, { name: "New family" });
          households[0].name = body.name;
        } else {
          assert.deepEqual(body, { password: "secret2" });
          resetPassword = body.password;
        }
        return Response.json(households[0]);
      }
      throw new Error(`Unexpected request: ${options.method} ${url}`);
    },
    setTimeout: (callback: () => void, timeout: number) => {
      const timer = originalTimeout(callback, timeout);
      timer.unref();
      return timer;
    },
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(async () => {
    await browser.happyDOM.abort();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const waitFor = async (check: () => unknown) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Admin UI timed out: ${document.body.textContent}`);
      await delay(10);
    }
  };
  const click = (text: string) => {
    const control = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
    assert.ok(control, `Button "${text}" is present`);
    control.click();
  };
  const fill = (name: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(`.household-form input[name="${name}"]`);
    assert.ok(input);
    input.value = value;
  };
  const submit = () => document.querySelector(".household-form")?.dispatchEvent(new browser.Event("submit", { cancelable: true }));
  // @ts-expect-error The actual browser entrypoint intentionally ships as JavaScript.
  await import("../public/planner.js");
  await waitFor(() => document.querySelector(".admin-empty"));
  assert.equal(document.querySelector<HTMLButtonElement>("#nav-admin")?.hidden, false);
  assert.equal(document.querySelector("#nav-admin")?.getAttribute("aria-current"), "page");
  click("Add household");
  fill("name", "Family");
  fill("password", "secret1");
  assert.equal(document.querySelector<HTMLInputElement>('.household-form input[name="password"]')?.type, "password");
  submit();
  await waitFor(() => document.querySelector(".household-row h3")?.textContent === "Family");
  assert.equal(document.querySelector("dialog")?.open, false);
  click("Change name");
  fill("name", "Taken");
  submit();
  await waitFor(() => document.querySelector("#dialog-error"));
  assert.equal(document.querySelector("dialog")?.open, true);
  assert.match(document.querySelector("#dialog-error")?.textContent ?? "", /already in use/);
  fill("name", "New family");
  submit();
  await waitFor(() => document.querySelector(".household-row h3")?.textContent === "New family");
  click("Reset password");
  assert.match(document.querySelector(".household-form .notice")?.textContent ?? "", /signs out everyone/);
  fill("password", "secret2");
  submit();
  await waitFor(() => !document.querySelector("dialog")?.open);
  assert.equal(resetPassword, "secret2");
  assert.doesNotMatch(document.body.textContent, /secret1|secret2/);
  click("Weeks");
  await waitFor(() => document.querySelector(".this-week"));
  document.querySelector<HTMLButtonElement>("#nav-admin")?.click();
  await waitFor(() => document.querySelector(".household-row"));
  assert.equal(new URL(browser.location.href).searchParams.get("view"), "admin");
});
