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
  let conversionFailure: "json" | "text" | null = null;
  let conversions = 0;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x4a, 0x46, 0x49, 0x46]);
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
    createImageBitmap: async (image: Blob & { name?: string }) => {
      if (image.name?.endsWith(".HEIC")) throw new Error("Browser cannot decode HEIC");
      assert.equal(image.type, "image/jpeg");
      return { width: 1200, height: 900, close() {} };
    },
    fetch: async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/recipes/convert-heic") {
        conversions++;
        if (conversionFailure === "json") return Response.json({ error: "This HEIC photo couldn't be opened." }, { status: 422 });
        if (conversionFailure === "text") return new Response("Service unavailable", { status: 503 });
        return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
      }
      if (path === "/api/recipes/extract") {
        const { id: _id, source: _source, image: _image, ...content } = recipe;
        return Response.json({ recipe: content, warnings: [] });
      }
      if (path.startsWith("/api/weeks/")) return Response.json(responses.get(path) ?? null);
      if (!responses.has(path)) throw new Error(`Unexpected React UI request: ${path}`);
      return Response.json(responses.get(path));
    },
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  Object.defineProperty(browser.HTMLCanvasElement.prototype, "getContext", {
    configurable: true, value: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
  });
  Object.defineProperty(browser.HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true, value: () => `data:image/jpeg;base64,${jpeg.toString("base64")}`,
  });
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
  assert.match(dialog.textContent ?? "", /Tick ingredients as you gather them for cooking/);
  const gatheredIngredient = dialog.querySelector<HTMLInputElement>('input[aria-label="Gathered pasta"]');
  assert.ok(gatheredIngredient);
  await act(async () => {
    gatheredIngredient.click();
    await delay(10);
  });
  assert.equal(gatheredIngredient.checked, true);
  await act(async () => {
    document.querySelector<HTMLButtonElement>(".close-button")?.click();
    await delay(10);
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>("#add-recipe")?.click();
    await delay(10);
  });
  assert.equal(document.querySelector('[role="dialog"] [class*="title"]')?.textContent, "Add a recipe");
  assert.deepEqual([...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] .photo-picker-actions button')]
    .map((button) => button.textContent?.trim()), ["Take a photo", "Choose from library", "Take a photo", "Choose from library"]);
  const inputs = document.querySelectorAll<HTMLInputElement>('[role="dialog"] .photo-picker input[type="file"]');
  const upload = async (input: HTMLInputElement) => {
    Object.defineProperty(input, "files", { configurable: true, value: [new browser.File(["heic"], "photo.HEIC", { type: "image/heic" })] });
    await act(async () => {
      input.dispatchEvent(new browser.Event("change", { bubbles: true }));
      await delay(20);
    });
  };
  await upload(inputs[0]);
  assert.equal(conversions, 1);
  assert.ok(requests.includes("/api/recipes/extract"), "recipe photo reaches extraction after conversion");
  assert.match(document.querySelector(".upload-status")?.textContent ?? "", /Draft ready: Lemon pasta/);
  await upload(inputs[2]);
  assert.equal(conversions, 2);
  assert.match(document.querySelector(".upload-status")?.textContent ?? "", /Dish photo ready/);
  conversionFailure = "json";
  await upload(inputs[2]);
  assert.equal(conversions, 3);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /This HEIC photo couldn't be opened/);
  conversionFailure = "text";
  await upload(inputs[2]);
  assert.equal(conversions, 4);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Photo conversion failed \(503\)/);
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

  const weekKey = requests.find((path) => /^\/api\/weeks\/\d{4}-\d{2}-\d{2}$/.test(path))?.split("/").at(-1);
  assert.ok(weekKey);
  responses.set(`/api/weeks/${weekKey}`, {
    week: weekKey, people: 2, adults: 2, children: 0,
    rules: { differentProteins: false, overlapIngredients: false, maxMinutes: 60, diet: "any" },
    meals: [], status: "confirmed", confirmedAt: "2026-11-23T00:00:00Z", revision: 1,
    shoppingList: [
      { name: "olive oil", quantity: 1, unit: "tbsp", pantry: true },
      { name: "lamb mince", quantity: 500, unit: "g", pantry: false },
      { name: "black pepper", quantity: 1, unit: "pinch", pantry: true },
    ],
  });
  await act(async () => {
    browser.history.pushState({}, "", `/?view=week&week=${weekKey}`);
    browser.dispatchEvent(new browser.PopStateEvent("popstate"));
    await delay(20);
  });
  const pantryGroup = document.querySelector(".pantry-group");
  assert.ok(pantryGroup);
  assert.match(pantryGroup.textContent ?? "", /Pantry staples/);
  const pantryCheckbox = pantryGroup.querySelector<HTMLInputElement>('input[aria-label="Already have olive oil"]');
  assert.ok(pantryCheckbox);
  await act(async () => {
    pantryCheckbox.click();
    await delay(10);
  });
  assert.match(document.querySelector(".shopping-progress")?.textContent ?? "", /2 to buy · 1 already have/);
  assert.doesNotMatch(document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "", /olive oil/);
  const specialsPreference = document.querySelector<HTMLInputElement>('input[aria-label="Look for specials"]');
  const premiumPreference = document.querySelector<HTMLInputElement>('input[aria-label="Prefer premium products"]');
  assert.ok(specialsPreference);
  assert.ok(premiumPreference);
  await act(async () => {
    specialsPreference.click();
    await delay(10);
  });
  assert.match(document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "", /Please look for specials/);
  await act(async () => {
    premiumPreference.click();
    await delay(10);
  });
  const bothPreferences = document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "";
  assert.match(bothPreferences, /Please look for specials/);
  assert.match(bothPreferences, /Please prefer premium products/);
  await act(async () => {
    specialsPreference.click();
    await delay(10);
  });
  const premiumOnly = document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "";
  assert.doesNotMatch(premiumOnly, /Please look for specials/);
  assert.match(premiumOnly, /Please prefer premium products/);
});
