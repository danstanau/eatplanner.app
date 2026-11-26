import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import test from "node:test";
import { Window } from "happy-dom";
import { MantineProvider } from "@mantine/core";
import { App } from "../client/ui.tsx";

test("unauthenticated visitors see the public sales page with sign-in and unavailable registration", async (t) => {
  const browser = new Window({ url: "http://127.0.0.1:3000/" });
  const document = browser.document;
  document.body.innerHTML = '<div id="root"></div>';
  const globals: Record<string, unknown> = {
    window: browser,
    document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    fetch: async (input: RequestInfo | URL) => {
      assert.equal(String(input), "/api/auth/session");
      return Response.json({ enabled: true, authenticated: false });
    },
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  const root = createRoot(document.querySelector("#root")!);
  t.after(async () => {
    await act(async () => root.unmount());
    await browser.happyDOM.abort();
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
  assert.match(document.querySelector("h1")?.textContent ?? "", /Make a plan/);
  assert.equal(document.querySelectorAll(".sales-step").length, 3);
  assert.equal(document.querySelector<HTMLAnchorElement>(".sales-signin")?.getAttribute("href"), "/login");
  const register = document.querySelector<HTMLAnchorElement>(".sales-register");
  assert.equal(register?.getAttribute("aria-disabled"), "true");
  assert.equal(register?.hasAttribute("href"), false);
  assert.match(document.querySelector("#register-note")?.textContent ?? "", /isn’t available yet/);
});

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
    ["/api/shopping", { revision: 0, items: [] }],
  ]);
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  let conversionFailure: "json" | "text" | null = null;
  let conversions = 0;
  let extractedPhotoCount = 0;
  const canvasDimensions: Array<[number, number]> = [];
  let copiedText = "";
  Object.defineProperty(browser.navigator, "clipboard", {
    configurable: true, value: { writeText: async (text: string) => { copiedText = text; } },
  });
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
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    createImageBitmap: async (image: Blob & { name?: string }) => {
      if (image.name?.endsWith(".HEIC")) throw new Error("Browser cannot decode HEIC");
      assert.equal(image.type, "image/jpeg");
      return { width: 1200, height: 900, close() {} };
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/shopping" && init?.method === "POST") {
        const current = responses.get(path) as { revision: number; items: { id: string; name: string; checked: boolean }[] };
        const names = (JSON.parse(String(init.body)) as { names: string[] }).names;
        const updated = { revision: current.revision + 1, items: [...current.items, ...names.map((name, index) => ({ id: `item-${index}`, name, checked: false }))] };
        responses.set(path, updated);
        return Response.json(updated);
      }
      if (path.startsWith("/api/shopping/")) {
        const current = responses.get("/api/shopping") as { revision: number; items: { id: string; name: string; checked: boolean }[] };
        const id = path.split("/").at(-1);
        const items = init?.method === "DELETE" ? current.items.filter((item) => item.id !== id)
          : current.items.map((item) => item.id === id ? { ...item, ...JSON.parse(String(init?.body)) } : item);
        const updated = { revision: current.revision + 1, items };
        responses.set("/api/shopping", updated);
        return Response.json(updated);
      }
      if (path === "/api/recipes/convert-heic") {
        conversions++;
        if (conversionFailure === "json") return Response.json({ error: "This HEIC photo couldn't be opened." }, { status: 422 });
        if (conversionFailure === "text") return new Response("Service unavailable", { status: 503 });
        return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
      }
      if (path === "/api/recipes/extract") {
        extractedPhotoCount = (JSON.parse(String(init?.body)) as { photos: unknown[] }).photos.length;
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
    configurable: true, value: () => ({ fillStyle: "", fillRect() {}, drawImage() {}, translate() {}, rotate() {} }),
  });
  Object.defineProperty(browser.HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true, value: function (this: HTMLCanvasElement) {
      canvasDimensions.push([this.width, this.height]);
      return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    },
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
  assert.match(document.querySelector("#nav-shopping")?.textContent ?? "", /Shopping list \(0\)/);
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
  const upload = async (input: HTMLInputElement, files = [new browser.File(["heic"], "photo.HEIC", { type: "image/heic" })]) => {
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new browser.Event("change", { bubbles: true }));
      await delay(20);
    });
  };
  await upload(inputs[0]);
  assert.equal(conversions, 1);
  assert.equal(requests.includes("/api/recipes/extract"), false, "photos can be staged before they are read");
  await upload(inputs[1], [new browser.File(["back"], "back.jpg", { type: "image/jpeg" })]);
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Rotate recipe page 1 clockwise"]')?.click();
    await delay(10);
  });
  assert.ok(canvasDimensions.some(([width, height]) => width === 900 && height === 1200), "rotation swaps the photo dimensions");
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent?.includes("Read recipe"))?.click();
    await delay(20);
  });
  assert.ok(requests.includes("/api/recipes/extract"), "recipe photos reach extraction together");
  assert.equal(extractedPhotoCount, 2);
  assert.match(document.querySelector(".upload-status")?.textContent ?? "", /Draft ready: Lemon pasta/);
  await upload(inputs[2]);
  assert.equal(conversions, 2);
  assert.match(document.querySelector(".upload-status")?.textContent ?? "", /Dish photo ready/);
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent?.includes("Rotate dish photo"))?.click();
    await delay(10);
  });
  assert.match(document.querySelector(".upload-status")?.textContent ?? "", /Dish photo rotated/);
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
  await act(async () => {
    [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to household list"))?.click();
    await delay(10);
  });
  assert.match(document.querySelector("#nav-shopping")?.textContent ?? "", /Shopping list \(2\)/);
  await act(async () => {
    document.querySelector<HTMLButtonElement>("#nav-shopping")?.click();
    await delay(10);
  });
  assert.equal(document.querySelector("#view h1")?.textContent, "Shopping list");
  assert.ok(document.querySelector('input[aria-label="Edit 500 g lamb mince"]'));
  assert.equal(document.querySelectorAll(".household-shopping-row").length, 2);
  await act(async () => {
    document.querySelector<HTMLInputElement>('input[aria-label="Mark 500 g lamb mince as bought"]')?.click();
    await delay(10);
  });
  assert.ok(document.querySelector<HTMLInputElement>('input[aria-label="Mark 500 g lamb mince as needed"]')?.checked);
  await act(async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Remove 500 g lamb mince"]')?.click();
    await delay(10);
  });
  assert.match(document.querySelector("#nav-shopping")?.textContent ?? "", /Shopping list \(1\)/);
  await act(async () => {
    browser.history.back();
    await delay(20);
  });
  responses.set("/api/shopping", {
    revision: 10,
    items: [
      { id: "duplicate", name: "1 PINCH BLACK PEPPER", checked: false },
      { id: "extra", name: "Dish soap", checked: false },
      { id: "bought", name: "Apples", checked: true },
    ],
  });
  await act(async () => {
    browser.dispatchEvent(new browser.Event("focus"));
    await delay(10);
  });
  const combined = document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "";
  assert.match(combined, /500 g lamb mince/);
  assert.match(combined, /Dish soap/);
  assert.doesNotMatch(combined, /Apples|olive oil/);
  assert.equal((combined.match(/black pepper/gi) ?? []).length, 1);
  await act(async () => {
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Copy shopping list")?.click();
    await delay(10);
  });
  assert.equal(copiedText, combined);
  const includePantry = [...document.querySelectorAll("label")].find((label) => label.textContent?.includes("Include unchecked pantry items"))
    ?.querySelector<HTMLInputElement>("input");
  assert.ok(includePantry);
  await act(async () => {
    includePantry.click();
    await delay(10);
  });
  const withoutPantry = document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "";
  assert.doesNotMatch(withoutPantry, /1 pinch black pepper/);
  assert.match(withoutPantry, /1 PINCH BLACK PEPPER/);
  assert.match(withoutPantry, /Dish soap/);
  await act(async () => {
    includePantry.click();
    await delay(10);
  });
  const anyPreference = document.querySelector<HTMLInputElement>('#shopping-product-preference input[value="any"]');
  const specialsPreference = document.querySelector<HTMLInputElement>('#shopping-product-preference input[value="specials"]');
  const premiumPreference = document.querySelector<HTMLInputElement>('#shopping-product-preference input[value="premium"]');
  assert.ok(anyPreference);
  assert.ok(specialsPreference);
  assert.ok(premiumPreference);
  assert.equal(anyPreference.checked, true);
  assert.match(document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "", /Add every ingredient and quantity listed below directly to my cart/);
  assert.match(document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "", /Match available pack sizes and quantities as closely as possible/);
  assert.match(document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "", /Never proceed to checkout or payment/);
  assert.match(document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "", /I will review the cart before checkout/);
  await act(async () => {
    specialsPreference.click();
    await delay(10);
  });
  const specialsOnly = document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "";
  assert.equal(specialsPreference.checked, true);
  assert.match(specialsOnly, /Please prefer specials and lower-priced suitable alternatives/);
  assert.match(specialsOnly, /do not skip an ingredient if no preferred match is available/);
  assert.match(specialsOnly, /lamb mince/);
  assert.match(specialsOnly, /black pepper/);
  await act(async () => {
    premiumPreference.click();
    await delay(10);
  });
  const premiumOnly = document.querySelector<HTMLTextAreaElement>(".shopping-text")?.value ?? "";
  assert.equal(premiumPreference.checked, true);
  assert.equal(specialsPreference.checked, false);
  assert.doesNotMatch(premiumOnly, /Please prefer specials/);
  assert.match(premiumOnly, /Please prefer premium products/);
});
