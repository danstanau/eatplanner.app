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
  const modalContent = document.querySelector("#modal-content");
  assert.ok(modalContent);
  const replaceModalChildren = modalContent.replaceChildren.bind(modalContent);
  modalContent.replaceChildren = (...children) => {
    assert.ok(children.every((child) => child !== null && child !== undefined), "modal content omits absent elements instead of rendering null");
    replaceModalChildren(...children);
  };
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  let convertedPhonePhotos = 0;
  const globals = {
    document, window: browser, navigator: browser.navigator, localStorage: browser.localStorage,
    fetch: async (url: string, init?: RequestInit) => {
      if (new URL(url, base).pathname === "/api/recipes/convert-heic") {
        convertedPhonePhotos++;
        return new Response(Buffer.from(photo, "base64"), { headers: { "Content-Type": "image/jpeg" } });
      }
      const response = await originalFetch(new URL(url, base), init);
      if (new URL(url, base).pathname !== "/api/recipes" || (init?.method && init.method !== "GET")) return response;
      const recipes = await response.json() as Array<{ id: string; imageCredit?: unknown }>;
      const brisket = recipes.find((recipe) => recipe.id === "beef-brisket");
      if (brisket) brisket.imageCredit = {
        creator: null, sourceUrl: "https://example.com/photo", license: "CC0", licenseUrl: "https://example.com/license",
      };
      return new Response(JSON.stringify(recipes), { status: response.status });
    },
    createImageBitmap: async (file: File) => {
      if (file.name === "invalid.jpg" || file.name?.toLowerCase().endsWith(".heic")) throw new Error("Cannot decode image");
      return { width: 1200, height: 900, close() {} };
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
  assert.equal(document.querySelector("#add-recipe")?.parentElement?.tagName, "NAV");
  await waitFor(() => document.querySelectorAll(".week-card").length === 10);
  assert.equal(document.querySelector("#sign-out")?.hasAttribute("hidden"), true);
  findButton("Plan this week").click();
  assert.equal(new URL(browser.location.href).searchParams.get("view"), "week");
  assert.ok(new URL(browser.location.href).searchParams.get("week"));
  await waitFor(() => document.querySelectorAll(".day-toggle").length === 7);
  const planningCount = (label: string) => {
    const input = [...document.querySelectorAll(".planning-form .field")]
      .find((field) => field.querySelector("span")?.textContent === label)?.querySelector("input");
    assert.ok(input);
    return input;
  };
  assert.equal(planningCount("Adults").value, "2");
  assert.equal(planningCount("Children").value, "0");
  for (const label of ["Adults", "Children"]) {
    assert.equal(planningCount(label).type, "number");
    assert.equal(planningCount(label).inputMode, "numeric");
  }
  planningCount("Children").value = "1";
  assert.match(document.querySelector(".selection-count")?.textContent ?? "", /5 dinners/);
  document.querySelectorAll(".day-toggle")[0].click();
  assert.match(document.querySelector(".selection-count")?.textContent ?? "", /4 dinners/);
  findButton("3 dinners").click();
  const weeksCount = document.querySelector(".planning-form .field select");
  assert.ok(weeksCount);
  weeksCount.value = "3";
  weeksCount.dispatchEvent(new browser.Event("change", { bubbles: true }));
  findButton("Plan 3 weeks").click();
  await waitFor(() => document.querySelectorAll(".recipe-open").length === 3);
  assert.equal(Object.keys((await store.read()).weeks).length, 3);
  const plannedHousehold = Object.values((await store.read()).weeks)[0];
  assert.equal(plannedHousehold.adults, 2);
  assert.equal(plannedHousehold.children, 1);
  assert.equal(plannedHousehold.people, 3);
  assert.match(document.querySelector(".page-heading .lede")?.textContent ?? "", /2 adults, 1 child/);
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
  const oliveInstruction = [...document.querySelectorAll("#shopping .check-field")].find((label) => label.textContent?.includes("Include Olive instruction"))?.querySelector("input");
  assert.ok(oliveInstruction);
  const oliveShoppingText = document.querySelector(".shopping-text")?.value ?? "";
  assert.ok(oliveShoppingText.startsWith("Add these items to my cart\n\n"));
  oliveInstruction.click();
  assert.equal(document.querySelector(".shopping-text")?.value, oliveShoppingText.replace("Add these items to my cart\n\n", ""));
  oliveInstruction.click();
  assert.equal(document.querySelector(".shopping-text")?.value, oliveShoppingText);
  const justAddInstruction = [...document.querySelectorAll("#shopping .check-field")].find((label) => label.querySelector("strong")?.textContent === "Just add")?.querySelector("input");
  assert.ok(justAddInstruction);
  assert.equal(justAddInstruction.checked, false);
  justAddInstruction.click();
  assert.equal(document.querySelector(".shopping-text")?.value, oliveShoppingText.replace("\n\n", "\nJust add, don't confirm\n\n"));
  oliveInstruction.click();
  assert.equal(document.querySelector(".shopping-text")?.value, oliveShoppingText.replace("Add these items to my cart", "Just add, don't confirm"));
  justAddInstruction.click();
  assert.equal(document.querySelector(".shopping-text")?.value, oliveShoppingText.replace("Add these items to my cart\n\n", ""));
  oliveInstruction.click();
  const expectedShoppingText = document.querySelector(".shopping-text")?.value;
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(browser.navigator, "clipboard");
  let copiedText = "";
  Object.defineProperty(browser.navigator, "clipboard", {
    configurable: true, value: { writeText: async (value: string) => { copiedText = value; } },
  });
  findButton("Copy shopping list").click();
  await waitFor(() => copiedText === expectedShoppingText);
  await waitFor(() => document.querySelector("#shopping")?.textContent?.includes("Open Olive in the Woolworths app"));
  let destination = "";
  const navigate = t.mock.method(browser.location, "assign", (url: string) => { destination = url; });
  Object.defineProperty(browser.navigator, "clipboard", { configurable: true, value: undefined });
  let fallbackSucceeds = true;
  let fallbackCommand = "";
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string) => { fallbackCommand = command; return fallbackSucceeds; },
  });
  findButton("Copy & open Woolworths").click();
  await waitFor(() => destination === "https://www.woolworths.com.au/");
  assert.equal(fallbackCommand, "copy");
  assert.equal(document.querySelector(".shopping-text")?.selectionEnd, expectedShoppingText?.length);
  fallbackSucceeds = false;
  destination = "";
  findButton("Copy & open Woolworths").click();
  await waitFor(() => document.querySelector("#shopping")?.textContent?.includes("press and hold the text"));
  assert.equal(destination, "", "failed copying must not navigate away from the selected ingredients");
  navigate.mock.restore();
  if (clipboardDescriptor) Object.defineProperty(browser.navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(browser.navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  const firstShoppingItem = document.querySelector("#shopping .shopping-checklist input[type=checkbox]");
  assert.ok(firstShoppingItem);
  firstShoppingItem.click();
  assert.match(document.querySelector(".shopping-progress")?.textContent ?? "", /^1 of \d+ items checked$/);
  assert.equal((await store.read()).weeks[Object.keys((await store.read()).weeks)[0]].status, "confirmed");

  const originalMealCard = document.querySelector(".recipe-open");
  originalMealCard?.click();
  assert.ok(new URL(browser.location.href).searchParams.get("recipe"));
  findButton("Cooked!").click();
  await waitFor(() => document.querySelector(".meal-completion"));
  const cookedCard = document.querySelector(".meal-completion")?.closest(".recipe-open");
  assert.ok(cookedCard);
  assert.equal(cookedCard.querySelector(".card-link"), null);
  assert.ok(document.querySelector("dialog")?.open);
  assert.ok((await store.read()).weeks[Object.keys((await store.read()).weeks)[0]].meals.some((meal) => meal.cooked));
  findButton("Undo cooked").click();
  await waitFor(() => !document.querySelector(".meal-completion"));
  assert.match(document.querySelector(".recipe-open .card-link")?.textContent ?? "", /Let's cook/);
  assert.ok(!(await store.read()).weeks[Object.keys((await store.read()).weeks)[0]].meals.some((meal) => meal.cooked));
  findButton("Edit recipe / update from photo").click();
  assert.equal(new URL(browser.location.href).searchParams.get("edit"), "1");
  browser.history.back();
  await waitFor(() => new URL(browser.location.href).searchParams.has("recipe") && !new URL(browser.location.href).searchParams.has("edit") && Boolean(document.querySelector(".recipe-layout")));
  browser.history.back();
  await waitFor(() => !document.querySelector("dialog")?.open && new URL(browser.location.href).searchParams.get("view") === "week" && document.querySelector(".recipe-open") !== originalMealCard);
  document.querySelector(".recipe-open")?.click();
  assert.match(document.querySelector(".cook-mode .eyebrow")?.textContent ?? "", /STEP 1/);
  findButton("Next step").click();
  assert.match(document.querySelector(".cook-mode .eyebrow")?.textContent ?? "", /STEP 2/);
  document.querySelector("#close-modal")?.click();
  await waitFor(() => !document.querySelector("dialog")?.open && Boolean([...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Share week"))));
  findButton("Share week").click();
  await waitFor(() => document.querySelector(".share-preview"));
  assert.ok(document.querySelector("a[download]")?.getAttribute("download")?.endsWith(".png"));
  assert.ok(drawing.some((text) => text.includes("Locked in")));
  assert.ok(drawing.includes("MONDAY"));
  assert.ok(drawing.includes("SUNDAY"));
  document.querySelector("#close-modal")?.click();
  await waitFor(() => !document.querySelector("dialog")?.open && Boolean([...document.querySelectorAll("button")].find((item) => item.textContent?.includes("All weeks"))));
  findButton("All weeks").click();
  await waitFor(() => document.querySelector(".week-card.current"));
  const dayMarks = [...document.querySelectorAll(".week-card.current .mini-days span")].map((item, index) => item.classList.contains("filled") ? index : -1).filter((index) => index >= 0);
  assert.deepEqual(dayMarks, [1, 2, 6]);

  document.querySelector("#nav-recipes")?.click();
  assert.equal(document.querySelectorAll(".collection-card").length, initialRecipes);
  const brisketCard = [...document.querySelectorAll(".collection-card")].find((card) => card.querySelector("h3")?.textContent === "Beef brisket");
  assert.ok(brisketCard);
  brisketCard.click();
  assert.doesNotMatch(document.querySelector("#modal-content")?.textContent ?? "", /\bnull\b/);
  assert.equal(document.querySelector(".photo-credit"), null);
  document.querySelector("#close-modal")?.click();
  await waitFor(() => !document.querySelector("dialog")?.open && document.querySelectorAll(".collection-card").length === initialRecipes);
  document.querySelector("#add-recipe")?.click();
  assert.equal(new URL(browser.location.href).searchParams.get("edit"), "new");
  assert.ok(document.querySelector(".recipe-form"), document.querySelector("#modal-content")?.textContent);
  assert.match(document.querySelector(".form-bottom")?.textContent ?? "", /Saved to this household's recipe file/);
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
  const upload = document.querySelector<HTMLInputElement>('input[aria-label="Choose or take a photo of the recipe page"]');
  assert.ok(upload);
  assert.equal(upload.hasAttribute("capture"), false);
  const dishUpload = document.querySelector<HTMLInputElement>('input[aria-label="Choose or take a photo of the finished dish"]');
  assert.ok(dishUpload);
  assert.equal(dishUpload.hasAttribute("capture"), false);
  Object.defineProperty(upload, "files", { configurable: true, value: [new browser.File(["photo"], "recipe.HEIC", { type: "" })] });
  upload.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => !findButton("Read recipe with Copilot").disabled);
  assert.equal(convertedPhonePhotos, 1);
  findButton("Read recipe with Copilot").click();
  await waitFor(() => !document.querySelector(".import-warnings")?.hidden);
  assert.equal(editor("Recipe name").value, content.title);
  assert.match(document.querySelector(".import-warnings")?.textContent ?? "", /Double-check the servings/);
  assert.equal((await store.read()).recipes.length, initialRecipes + 1, "photo extraction remains a draft until a reviewed save");
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
  assert.equal(imported.image, "/images/pasta.jpg", "the recipe page is not used as the dish photo");

  Array.from(document.querySelectorAll(".collection-card")).at(-1)?.click();
  findButton("Edit recipe / update from photo").click();
  assert.equal(new URL(browser.location.href).searchParams.get("recipe"), imported.id);
  assert.equal(new URL(browser.location.href).searchParams.get("edit"), "1");
  const previousEditor = document.querySelector(".recipe-form");
  browser.history.pushState({ plannerRoute: true, plannerHasParent: false }, "", `/?view=recipes&recipe=${encodeURIComponent(imported.id)}&edit=1`);
  browser.dispatchEvent(new browser.PopStateEvent("popstate"));
  await waitFor(() => document.querySelector(".recipe-form") !== previousEditor);
  assert.equal(editor("Recipe name").value, imported.title);
  document.querySelector("#close-modal")?.click();
  await waitFor(() => new URL(browser.location.href).searchParams.get("recipe") === imported.id && !new URL(browser.location.href).searchParams.has("edit") && Boolean(document.querySelector(".recipe-layout")));
  findButton("Edit recipe / update from photo").click();
  await waitFor(() => Boolean(document.querySelector(".recipe-form")));
  const updateUpload = document.querySelector<HTMLInputElement>('input[aria-label="Choose or take a photo of the recipe page"]');
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
  assert.equal(updated?.image, imported.image, "reading a recipe page leaves the existing cover unchanged");

  Array.from(document.querySelectorAll(".collection-card")).at(-1)?.click();
  findButton("Edit recipe / update from photo").click();
  findButton("Find a photo with Copilot").click();
  await waitFor(() => document.querySelectorAll(".recipe-form .upload-status")[1]?.textContent?.includes("Photo found"));
  assert.ok((document.querySelector('img[alt="Recipe cover photo"]')?.getAttribute("src") ?? "").endsWith("/images/chicken.jpg"));
  assert.match(document.querySelector(".recipe-form .photo-credit")?.textContent ?? "", /Example photographer/);
  const sourceAfterSearch = document.querySelector<HTMLInputElement>('input[aria-label="Choose or take a photo of the recipe page"]');
  assert.ok(sourceAfterSearch);
  Object.defineProperty(sourceAfterSearch, "files", { configurable: true, value: [new browser.File(["photo"], "page.jpg", { type: "image/jpeg" })] });
  sourceAfterSearch.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => !findButton("Read recipe with Copilot").disabled);
  assert.ok((document.querySelector('img[alt="Recipe cover photo"]')?.getAttribute("src") ?? "").endsWith("/images/chicken.jpg"));
  assert.match(document.querySelector(".recipe-form .photo-credit")?.textContent ?? "", /Example photographer/);
  const imageReviewed = document.querySelector(".recipe-form > .check-field input");
  assert.ok(imageReviewed);
  imageReviewed.checked = true;
  findButton("Update this recipe").click();
  await waitFor(() => !document.querySelector("dialog")?.open);
  const imageUpdated = (await store.read()).recipes.at(-1);
  assert.equal(imageUpdated?.image, "/images/chicken.jpg");
  assert.equal(imageUpdated?.imageCredit?.creator, "Example photographer");

  Array.from(document.querySelectorAll(".collection-card")).at(-1)?.click();
  findButton("Edit recipe / update from photo").click();
  const coverFile = document.querySelector<HTMLInputElement>('input[aria-label="Choose or take a photo of the finished dish"]');
  assert.ok(coverFile);
  Object.defineProperty(coverFile, "files", { configurable: true, value: [new browser.File(["photo"], "dish.heic", { type: "image/heic" })] });
  coverFile.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => document.querySelectorAll(".recipe-form .upload-status")[1]?.textContent?.includes("Dish photo ready"));
  assert.equal(convertedPhonePhotos, 2);
  assert.equal(document.querySelector(".recipe-form .photo-credit")?.hidden, true);
  Object.defineProperty(coverFile, "files", { configurable: true, value: [new browser.File(["bad"], "invalid.jpg", { type: "image/jpeg" })] });
  coverFile.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => document.querySelectorAll(".recipe-form .upload-status")[1]?.textContent?.includes("current image is unchanged"));
  const coverReviewed = document.querySelector<HTMLInputElement>(".recipe-form > .check-field input");
  assert.ok(coverReviewed);
  coverReviewed.checked = true;
  findButton("Update this recipe").click();
  await waitFor(() => !document.querySelector("dialog")?.open);
  const coverUpdated = (await store.read()).recipes.at(-1);
  assert.equal(coverUpdated?.image.startsWith("data:image/jpeg"), true);
  assert.equal(coverUpdated?.imageCredit, undefined);
});
