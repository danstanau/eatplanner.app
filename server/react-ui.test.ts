import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";
import { Window } from "happy-dom";
import { MantineProvider } from "@mantine/core";
import { App } from "../client/ui.tsx";

test("React planner loads the weeks screen, navigates, and opens planning controls", async (t) => {
  const browser = new Window({ url: "http://127.0.0.1:3000/" });
  const document = browser.document;
  document.body.innerHTML = '<div id="root"></div>';
  const recipe = {
    id: "pasta-night", title: "Lemon pasta", description: "A quick, bright dinner.",
    category: "quick", protein: "cheese", diet: "vegetarian", servings: 2,
    prepMinutes: 10, cookMinutes: 15,
    ingredients: [{ quantity: 250, unit: "g", name: "pasta", pantry: false }],
    steps: ["Boil the pasta.", "Toss with lemon."], notes: "",
    image: "/images/pasta.jpg", source: "collection",
  };
  const responses = new Map<string, unknown>([
    ["/api/auth/session", { enabled: false, authenticated: true }],
    ["/api/recipes", [recipe]],
    ["/api/weeks", []],
  ]);
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  const globals: Record<string, unknown> = {
    window: browser,
    document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    fetch: async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path.startsWith("/api/weeks/")) return Response.json(null);
      if (!responses.has(path)) throw new Error(`Unexpected React UI request: ${path}`);
      return Response.json(responses.get(path));
    },
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  const root = createRoot(document.querySelector("#root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    await browser.happyDOM.abort();
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  await act(async () => {
    root.render(React.createElement(MantineProvider, null, React.createElement(App)));
    await delay(20);
  });
  assert.equal(document.querySelector("#view h1")?.textContent, "This week");
  assert.equal(document.querySelectorAll(".strip-cell").length, 7);
  assert.ok([...document.querySelectorAll("[style]")].some((element) => element.getAttribute("style")?.includes("--button-bg")));

  await act(async () => {
    document.querySelector<HTMLButtonElement>("#nav-recipes")?.click();
    await delay(10);
  });
  assert.equal(document.querySelector("#view h1")?.textContent, "Recipes");
  assert.ok(document.querySelector('[aria-label="Search recipes"]'));
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".collection-card")?.click();
    await delay(10);
  });
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  const labelledBy = dialog.getAttribute("aria-labelledby");
  assert.equal(document.getElementById(labelledBy!)?.textContent, "Lemon pasta");
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".close-button")?.click();
    await delay(10);
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>("#add-recipe")?.click();
    await delay(10);
  });
  assert.equal(document.querySelector('[role="dialog"] [class*="title"]')?.textContent, "Add a recipe");
  assert.ok(document.querySelector('[aria-label="Choose or take a photo of the recipe page"]'));
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".close-button")?.click();
    await delay(10);
  });

  await act(async () => {
    document.querySelector<HTMLButtonElement>("#nav-weeks")?.click();
    await delay(10);
  });
  await act(async () => {
    const plan = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Plan this week"));
    assert.ok(plan);
    plan.click();
    await delay(20);
  });
  assert.equal(document.querySelectorAll(".day-toggle").length, 7);
  assert.ok(requests.some((path) => /^\/api\/weeks\/\d{4}-\d{2}-\d{2}$/.test(path)));
});
