import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Window } from "happy-dom";
import { createApp } from "./app.js";
import { Store } from "./store.js";

test("UI completes week selection, swaps, moves, confirmation, cooking, sharing and reviewed recipe import", async (t) => {
  const temporary = await mkdtemp(join(fileURLToPath(new URL("../", import.meta.url)), ".test-ui-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const store = new Store(join(temporary, "household.json"));
  const initialRecipes = (await store.read()).recipes.length;
  const { id: _id, source: _source, image: _image, ...content } = (await store.read()).recipes[0];
  const server = createApp({
    generatePlan: async () => { throw new Error("Not used by weekly planning"); },
    getStatus: async () => ({ authenticated: false, model: "auto" }),
    extractRecipe: async () => ({ recipe: content, warnings: ["Double-check the servings."] }),
    findRecipeImage: async () => ({
      image: "/images/chicken.jpg",
      imageCredit: {
        creator: "Example photographer",
        sourceUrl: "https://example.com/photo",
        license: "CC0",
        licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
    }),
  }, store).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const browser = new Window({
    url: base,
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  const document = browser.document;
  document.write(await readFile(new URL("../public/index.html", import.meta.url), "utf8"));
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const globals = {
    document, window: browser, navigator: browser.navigator, localStorage: browser.localStorage,
    fetch: (url: string, init?: RequestInit) => originalFetch(new URL(url, base), init),
    createImageBitmap: async () => ({ width: 1200, height: 900, close() {} }),
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
  const drawing: string[] = [];
  const photo = (await readFile(new URL("../public/images/chicken.jpg", import.meta.url))).toString("base64");
  const context = {
    fillRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {},
    fillText(text: string) { drawing.push(text); }, measureText(text: string) { return { width: text.length * 15 }; },
  };
  Object.defineProperty(browser.HTMLCanvasElement.prototype, "getContext", { value: () => context });
  Object.defineProperty(browser.HTMLCanvasElement.prototype, "toDataURL", { value: () => `data:image/jpeg;base64,${photo}` });
  Object.defineProperty(browser.HTMLCanvasElement.prototype, "toBlob", { value: (callback: (blob: Blob) => void) => callback(new Blob(["test-png"], { type: "image/png" })) });
  const waitFor = async (check: () => unknown) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`UI condition timed out. Page: ${document.body.textContent}`);
      await delay(10);
    }
  };
  const findButton = (text: string) => {
    const control = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
    assert.ok(control, `Button "${text}" is present`);
    return control;
  };
  const editor = (label: string) => {
    const field = [...document.querySelectorAll(".recipe-form .field")].find((item) => item.querySelector("span")?.textContent === label);
    const control = field?.querySelector("input, textarea, select");
    assert.ok(control, `Editor field "${label}" is present`);
    return control;
  };
  // @ts-expect-error The actual browser entrypoint intentionally ships as JavaScript.
  await import("../public/planner.js");
  await waitFor(() => document.querySelectorAll(".week-card").length === 10);
  findButton("Plan this week").click();
  await waitFor(() => document.querySelectorAll(".day-toggle").length === 7);
  assert.match(document.querySelector(".selection-count")?.textContent ?? "", /5 dinners/);
  document.querySelectorAll(".day-toggle")[0].click();
  assert.match(document.querySelector(".selection-count")?.textContent ?? "", /4 dinners/);
  findButton("3 dinners").click();
  findButton("Start planning 3").click();
  await waitFor(() => document.querySelectorAll(".recipe-open").length === 3);
  const firstTitle = document.querySelector(".recipe-open h3")?.textContent;
  findButton("Swap").click();
  await waitFor(() => document.querySelectorAll(".swap-choice").length > 0);
  document.querySelector(".swap-choice")?.click();
  await waitFor(() => !document.querySelector("dialog")?.open && document.querySelector(".recipe-open h3")?.textContent !== firstTitle);
  const move = document.querySelector(".meal-actions select");
  assert.ok(move);
  move.value = "6";
  move.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => document.querySelectorAll(".day-card")[6].querySelector(".recipe-open"));
  assert.equal(document.querySelectorAll(".recipe-open").length, 3);
  findButton("Confirm this week").click();
  await waitFor(() => document.querySelector("#shopping"));
  assert.equal(document.querySelectorAll(".meal-actions").length, 0);
  assert.ok(document.querySelector(".shopping-text")?.value.includes("\n"));
  assert.equal((await store.read()).weeks[Object.keys((await store.read()).weeks)[0]].status, "confirmed");

  document.querySelector(".recipe-open")?.click();
  assert.match(document.querySelector(".cook-mode .eyebrow")?.textContent ?? "", /STEP 1/);
  findButton("Next step").click();
  assert.match(document.querySelector(".cook-mode .eyebrow")?.textContent ?? "", /STEP 2/);
  document.querySelector("#close-modal")?.click();
  findButton("Share week").click();
  await waitFor(() => document.querySelector(".share-preview"));
  assert.ok(document.querySelector("a[download]")?.getAttribute("download")?.endsWith(".png"));
  assert.ok(drawing.some((text) => text.includes("Locked in")));
  assert.ok(drawing.includes("MONDAY"));
  assert.ok(drawing.includes("SUNDAY"));
  document.querySelector("#close-modal")?.click();
  findButton("All weeks").click();
  await waitFor(() => document.querySelector(".week-card.current"));
  const dayMarks = [...document.querySelectorAll(".week-card.current .mini-days span")].map((item, index) => item.classList.contains("filled") ? index : -1).filter((index) => index >= 0);
  assert.deepEqual(dayMarks, [1, 2, 6]);

  document.querySelector("#nav-recipes")?.click();
  assert.equal(document.querySelectorAll(".collection-card").length, initialRecipes);
  document.querySelector("#add-recipe")?.click();
  assert.ok(document.querySelector(".recipe-form"), document.querySelector("#modal-content")?.textContent);
  editor("Recipe name").value = "Our family pasta";
  editor("A little description").value = "A quick family favourite.";
  editor("Ingredients").value = "200 | bag | pasta";
  editor("Method").value = "Cook pasta according to its packet.";
  const reviewed = document.querySelector(".recipe-form > .check-field input");
  assert.ok(reviewed);
  reviewed.checked = true;
  findButton("Save to my collection").click();
  await waitFor(() => document.querySelector("#dialog-error"));
  assert.match(document.querySelector("#dialog-error")?.textContent ?? "", /Ingredient line 1/);
  editor("Ingredients").value = "200 | g | pasta | pantry";
  findButton("Save to my collection").click();
  await waitFor(() => document.querySelectorAll(".collection-card").length === initialRecipes + 1);
  assert.equal((await store.read()).recipes.length, initialRecipes + 1);

  document.querySelector("#add-recipe")?.click();
  const upload = document.querySelector('input[type="file"]');
  assert.ok(upload);
  Object.defineProperty(upload, "files", { configurable: true, value: [new browser.File(["photo"], "recipe.jpg", { type: "image/jpeg" })] });
  upload.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => !findButton("Read recipe with Copilot").disabled);
  findButton("Read recipe with Copilot").click();
  await waitFor(() => !document.querySelector(".import-warnings")?.hidden);
  assert.equal(editor("Recipe name").value, content.title);
  assert.match(document.querySelector(".import-warnings")?.textContent ?? "", /Double-check the servings/);
  assert.equal((await store.read()).recipes.length, initialRecipes + 1);
  const photoReviewed = document.querySelector(".recipe-form > .check-field input");
  assert.ok(photoReviewed);
  assert.equal(photoReviewed.required, true);
  assert.equal(photoReviewed.checked, false);
  photoReviewed.checked = true;
  findButton("Save to my collection").click();
  await waitFor(() => document.querySelectorAll(".collection-card").length === initialRecipes + 2);
  const imported = (await store.read()).recipes.at(-1);
  assert.ok(imported);
  assert.equal((await store.read()).recipes.length, initialRecipes + 2);
  assert.equal(imported.image.startsWith("data:image/jpeg"), true);

  Array.from(document.querySelectorAll(".collection-card")).at(-1)?.click();
  findButton("Edit recipe / update from photo").click();
  assert.equal(editor("Recipe name").value, imported.title);
  const updateUpload = document.querySelector('input[type="file"]');
  assert.ok(updateUpload);
  Object.defineProperty(updateUpload, "files", { configurable: true, value: [new browser.File(["photo"], "updated-recipe.jpg", { type: "image/jpeg" })] });
  updateUpload.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => !findButton("Read recipe with Copilot").disabled);
  findButton("Read recipe with Copilot").click();
  await waitFor(() => !document.querySelector(".import-warnings")?.hidden);
  const updateReviewed = document.querySelector(".recipe-form > .check-field input");
  assert.ok(updateReviewed);
  updateReviewed.checked = true;
  editor("A little description").value = "Updated from the photographed family recipe.";
  findButton("Update this recipe").click();
  await waitFor(() => !document.querySelector("dialog")?.open);
  const updated = (await store.read()).recipes.at(-1);
  assert.equal((await store.read()).recipes.length, initialRecipes + 2);
  assert.equal(updated?.id, imported.id);
  assert.equal(updated?.description, "Updated from the photographed family recipe.");

  Array.from(document.querySelectorAll(".collection-card")).at(-1)?.click();
  findButton("Edit recipe / update from photo").click();
  findButton("Find a photo with Copilot").click();
  await waitFor(() => document.querySelector(".recipe-form .upload-box .muted[role=status]")?.textContent?.includes("Photo found"));
  assert.ok((document.querySelector(".upload-preview")?.getAttribute("src") ?? "").endsWith("/images/chicken.jpg"));
  assert.match(document.querySelector(".recipe-form .photo-credit")?.textContent ?? "", /Example photographer/);
  const imageReviewed = document.querySelector(".recipe-form > .check-field input");
  assert.ok(imageReviewed);
  imageReviewed.checked = true;
  findButton("Update this recipe").click();
  await waitFor(() => !document.querySelector("dialog")?.open);
  const imageUpdated = (await store.read()).recipes.at(-1);
  assert.equal(imageUpdated?.image, "/images/chicken.jpg");
  assert.equal(imageUpdated?.imageCredit?.creator, "Example photographer");
});
