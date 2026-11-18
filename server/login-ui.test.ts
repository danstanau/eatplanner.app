import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Window } from "happy-dom";

test("login form reports failures, preserves local routes and rejects external redirects", async (t) => {
  const browser = new Window({ settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  browser.document.write(await readFile(new URL("../public/login.html", import.meta.url), "utf8"));
  const destinations: string[] = [];
  const location = {
    origin: "https://meals.example.test", search: "?next=%2F%3Fview%3Drecipes",
    assign(value: string) { destinations.push(value); },
  };
  let success = false;
  const globals = {
    document: browser.document,
    window: { location },
    FormData: browser.FormData,
    fetch: async (url: string, options: RequestInit) => {
      assert.equal(url, "/api/auth/login");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(String(options.body)), { username: "household", password: "my test password" });
      return new Response(JSON.stringify(success ? { authenticated: true } : { error: "Incorrect username or password." }), {
        status: success ? 200 : 401,
      });
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
  // @ts-expect-error The actual browser entrypoint intentionally ships as JavaScript.
  await import("../public/login.js");
  const form = browser.document.querySelector("form");
  const username = form?.querySelector("input[name=username]");
  const password = form?.querySelector("input[name=password]");
  const submit = form?.querySelector("button");
  assert.ok(form && username && password && submit);
  username.value = "household";
  password.value = "my test password";
  form.dispatchEvent(new browser.Event("submit", { cancelable: true }));
  assert.equal(submit.disabled, true);
  await setImmediate();
  assert.match(browser.document.querySelector("#login-error")?.textContent ?? "", /Incorrect username/);
  assert.equal(submit.disabled, false);
  assert.equal(destinations.length, 0);
  success = true;
  form.dispatchEvent(new browser.Event("submit", { cancelable: true }));
  await setImmediate();
  assert.deepEqual(destinations, ["https://meals.example.test/?view=recipes"]);
  location.search = "?next=https://other.example";
  form.dispatchEvent(new browser.Event("submit", { cancelable: true }));
  await setImmediate();
  assert.equal(destinations.at(-1), "/");
  assert.equal(browser.document.querySelector("#login-error")?.hasAttribute("hidden"), true);
});
