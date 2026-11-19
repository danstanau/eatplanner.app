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
  const starter = await store.readStarterRecipes();
  const initialRecipes = starter.length;
  const { id: _id, source: _source, image: _image, ...content } = starter[0];
  let recipeReads = 0;
  let cancelledReads = 0;
  const finishImport = Promise.withResolvers<void>();
  const server = createApp({
    generatePlan: async () => { throw new Error("Not used by weekly planning"); },
    getStatus: async () => ({ authenticated: false, model: "auto" }),
    extractRecipe: async (_photo, signal) => {
      recipeReads++;
      if (recipeReads === 1) {
        await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => {
          cancelledReads++;
          reject(signal.reason);
        }, { once: true }));
      }
      if (recipeReads === 2) await finishImport.promise;
      return { recipe: content, warnings: ["Double-check the servings."] };
    },
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
    server.closeAllConnections();
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
      if (url === "/api/recipes?scope=other-households") return Response.json([{
        ...content, id: "shared-recipe", source: "personal", title: "Shared dinner",
        image: "/images/chicken.jpg", householdId: "00000000-0000-4000-8000-000000000001",
      }]);
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
    setTimeout: (...args: Parameters<typeof originalTimeout>) => {
      const timer = originalTimeout(...args);
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
  const editRecipe = () => {
    const control = document.querySelector<HTMLButtonElement>('#edit-recipe[aria-label="Edit recipe"]:not([hidden])');
    assert.ok(control);
    assert.equal(control.parentElement, document.querySelector("#close-modal")?.parentElement);
    control.click();
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
  await waitFor(() => document.querySelectorAll(".week-card").length === 6);
  assert.equal(document.querySelector("#sign-out")?.hasAttribute("hidden"), true);
  assert.equal(document.querySelector("#nav-admin")?.hasAttribute("hidden"), true);
  findButton("Plan this week").click();
  assert.equal(new URL(browser.location.href).searchParams.get("view"), "week");
  assert.ok(new URL(browser.location.href).searchParams.get("week"));
  await waitFor(() => document.querySelectorAll(".day-toggle").length === 7);
  const planRecipeSource = [...document.querySelectorAll(".planning-form .field")]
    .find((field) => field.querySelector("span")?.textContent === "Recipe source")?.querySelector("select");
  assert.equal(planRecipeSource?.value, "starter-and-household");
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
  findButton("Lock in this week").click();
  await waitFor(() => document.querySelector("#shopping"));
  assert.equal(document.querySelectorAll(".meal-actions").length, 0);
  assert.ok(document.querySelector(".shopping-text")?.value.includes("\n"));
  const pantryToggle = [...document.querySelectorAll("#shopping .check-field")]
    .find((label) => label.textContent?.includes("Include pantry items in Woolworths list"))?.querySelector("input");
  assert.ok(pantryToggle);
  assert.equal(pantryToggle.checked, true);
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
  const shareDescriptor = Object.getOwnPropertyDescriptor(browser.navigator, "share");
  const canShareDescriptor = Object.getOwnPropertyDescriptor(browser.navigator, "canShare");
  let sharedData: ShareData | undefined;
  Object.defineProperties(browser.navigator, {
    share: { configurable: true, value: async (data: ShareData) => { sharedData = data; } },
    canShare: { configurable: true, value: (data: ShareData) => Boolean(data.files?.length) },
  });
  findButton("Share shopping list").click();
  await waitFor(() => document.querySelector(".shopping-share-text"));
  const sharedText = document.querySelector<HTMLTextAreaElement>(".shopping-share-text")?.value ?? "";
  assert.match(sharedText, /^Woolworths shopping list — /);
  assert.equal(sharedText.split("\n\n").slice(1).join("\n\n"),
    document.querySelector(".shopping-text")?.value.split("\n\n").slice(1).join("\n\n"));
  assert.ok(!sharedText.includes("Add these items to my cart"));
  assert.ok(drawing.includes("Woolworths shopping list"));
  findButton("Share as text").click();
  await waitFor(() => Boolean(sharedData?.text));
  assert.equal(sharedData?.text, sharedText);
  findButton("Share image").click();
  await waitFor(() => Boolean(sharedData?.files?.length));
  assert.match(sharedData?.files?.[0]?.name ?? "", /^woolworths-shopping-list-.*\.png$/);
  document.querySelector("#close-modal")?.click();
  await waitFor(() => !document.querySelector("dialog")?.open);
  if (shareDescriptor) Object.defineProperty(browser.navigator, "share", shareDescriptor);
  else Reflect.deleteProperty(browser.navigator, "share");
  if (canShareDescriptor) Object.defineProperty(browser.navigator, "canShare", canShareDescriptor);
  else Reflect.deleteProperty(browser.navigator, "canShare");
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
  assert.equal(document.querySelector<HTMLButtonElement>("#edit-recipe")?.hidden, true);
  browser.history.back();
  await waitFor(() => !document.querySelector("dialog")?.open && new URL(browser.location.href).searchParams.get("view") === "week" && document.querySelector(".recipe-open") !== originalMealCard);
  document.querySelector(".recipe-open")?.click();
  assert.match(document.querySelector(".cook-mode .eyebrow")?.textContent ?? "", /Step 1/);
  findButton("Next step").click();
  assert.match(document.querySelector(".cook-mode .eyebrow")?.textContent ?? "", /Step 2/);
  const singleStep = document.querySelector<HTMLElement>(".single-step");
  const allSteps = document.querySelector<HTMLDetailsElement>(".all-steps");
  assert.ok(singleStep && allSteps);
  allSteps.querySelector("summary")?.click();
  await waitFor(() => singleStep.hidden);
  assert.equal(allSteps.open, true);
  assert.equal(allSteps.querySelector("summary")?.textContent, "Back to step-by-step");
  assert.ok(allSteps.querySelectorAll("li").length > 1);
  allSteps.querySelector("summary")?.click();
  await waitFor(() => !singleStep.hidden);
  assert.equal(allSteps.open, false);
  assert.equal(allSteps.querySelector("summary")?.textContent, "See the whole method");
  assert.match(singleStep.querySelector(".eyebrow")?.textContent ?? "", /Step 2/);
  document.querySelector("#close-modal")?.click();
  await waitFor(() => !document.querySelector("dialog")?.open && Boolean([...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Share week"))));
  findButton("Share week").click();
  await waitFor(() => document.querySelector(".share-preview"));
  assert.ok(document.querySelector("a[download]")?.getAttribute("download")?.endsWith(".png"));
  assert.ok(drawing.some((text) => text.includes("Locked in")));
  assert.ok(drawing.includes("Monday"));
  assert.ok(drawing.includes("Sunday"));
  document.querySelector("#close-modal")?.click();
  await waitFor(() => !document.querySelector("dialog")?.open && Boolean([...document.querySelectorAll("button")].find((item) => item.textContent?.includes("All weeks"))));
  findButton("All weeks").click();
  await waitFor(() => document.querySelector(".week-strip .filled"));
  const dayMarks = [...document.querySelectorAll(".week-strip .strip-cell")].map((item, index) => item.classList.contains("filled") ? index : -1).filter((index) => index >= 0);
  assert.deepEqual(dayMarks, [1, 2, 6]);

  document.querySelector("#nav-recipes")?.click();
  assert.equal(document.querySelectorAll(".collection-card").length, initialRecipes);
  const recipeSource = document.querySelector<HTMLSelectElement>('.collection-toolbar [aria-label="Recipe source"]');
  assert.ok(recipeSource);
  assert.equal(recipeSource.value, "starter-and-household");
  recipeSource.value = "household";
  recipeSource.dispatchEvent(new browser.Event("change"));
  assert.equal(document.querySelectorAll(".collection-card").length, 0);
  assert.equal(new URL(browser.location.href).searchParams.get("scope"), "household");
  recipeSource.value = "other-households";
  recipeSource.dispatchEvent(new browser.Event("change"));
  await waitFor(() => document.querySelector(".collection-card h3")?.textContent === "Shared dinner");
  document.querySelector(".collection-card")?.click();
  assert.equal(document.querySelector("#modal-title")?.textContent, "Shared dinner");
  assert.equal(document.querySelector<HTMLButtonElement>("#edit-recipe")?.hidden, true);
  document.querySelector("#close-modal")?.click();
  await waitFor(() => !document.querySelector("dialog")?.open && document.querySelector(".collection-card h3")?.textContent === "Shared dinner");
  const restoredSource = document.querySelector<HTMLSelectElement>('.collection-toolbar [aria-label="Recipe source"]');
  assert.ok(restoredSource);
  assert.equal(restoredSource.value, "other-households");
  restoredSource.value = "starter-and-household";
  restoredSource.dispatchEvent(new browser.Event("change"));
  assert.equal(document.querySelectorAll(".collection-card").length, initialRecipes);
  const recipeLayout = document.querySelector('[aria-label="Recipe card layout"]');
  assert.ok(recipeLayout);
  const compactLayout = [...recipeLayout.querySelectorAll("button")].find((item) => item.textContent === "Compact");
  const comfortableLayout = [...recipeLayout.querySelectorAll("button")].find((item) => item.textContent === "Comfortable");
  assert.ok(compactLayout && comfortableLayout);
  assert.equal(comfortableLayout.getAttribute("aria-pressed"), "true");
  compactLayout.click();
  assert.ok(document.querySelector(".collection-grid")?.classList.contains("is-compact"));
  assert.equal(compactLayout.getAttribute("aria-pressed"), "true");
  assert.equal(browser.localStorage.getItem("eatplanner.app:recipe-layout"), "compact");
  const brisketCard = [...document.querySelectorAll(".collection-card")].find((card) => card.querySelector("h3")?.textContent === "Beef brisket");
  assert.ok(brisketCard);
  assert.match(brisketCard.textContent ?? "", /Starter recipe/);
  brisketCard.click();
  assert.equal(document.querySelector<HTMLButtonElement>("#edit-recipe")?.hidden, true);
  assert.doesNotMatch(document.querySelector("#modal-content")?.textContent ?? "", /\bnull\b/);
  assert.equal(document.querySelector(".photo-credit"), null);
  document.querySelector("#close-modal")?.click();
  await waitFor(() => !document.querySelector("dialog")?.open && document.querySelectorAll(".collection-card").length === initialRecipes);
  assert.ok(document.querySelector(".collection-grid")?.classList.contains("is-compact"), "layout preference survives opening a recipe");
  const comfortableAfterRecipe = [...document.querySelector('[aria-label="Recipe card layout"]')!.querySelectorAll("button")]
    .find((item) => item.textContent === "Comfortable");
  assert.ok(comfortableAfterRecipe);
  comfortableAfterRecipe.click();
  assert.equal(document.querySelector(".collection-grid")?.classList.contains("is-compact"), false);
  assert.equal(browser.localStorage.getItem("eatplanner.app:recipe-layout"), "comfortable");
  document.querySelector("#add-recipe")?.click();
  assert.equal(new URL(browser.location.href).searchParams.get("edit"), "new");
  assert.ok(document.querySelector(".recipe-form"), document.querySelector("#modal-content")?.textContent);
  assert.match(document.querySelector(".form-bottom")?.textContent ?? "", /Saved to this household's recipe file/);
  editor("Recipe name").value = "Our family pasta";
  editor("Description").value = "A quick family favourite.";
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
  assert.equal((await store.read()).recipes.length, 1);

  document.querySelector("#add-recipe")?.click();
  const upload = document.querySelector<HTMLInputElement>('input[aria-label="Choose or take a photo of the recipe page"]');
  assert.ok(upload);
  assert.equal(upload.hasAttribute("capture"), false);
  const dishUpload = document.querySelector<HTMLInputElement>('input[aria-label="Choose or take a photo of the finished dish"]');
  assert.ok(dishUpload);
  assert.equal(dishUpload.hasAttribute("capture"), false);
  editor("Recipe name").value = "Keep this draft";
  Object.defineProperty(upload, "files", { configurable: true, value: [new browser.File(["photo"], "recipe.HEIC", { type: "" })] });
  upload.dispatchEvent(new browser.Event("change", { bubbles: true }));
  assert.match(document.querySelector(".upload-status")?.textContent ?? "", /Preparing/);
  await waitFor(() => recipeReads === 1);
  assert.match(document.querySelector(".upload-status")?.textContent ?? "", /Reading ingredients and method with Copilot/);
  assert.equal(document.querySelector("progress")?.parentElement?.hidden, false);
  assert.equal(findButton("Save to my collection").disabled, true);
  assert.equal(convertedPhonePhotos, 1);
  findButton("Cancel reading").click();
  assert.match(document.querySelector(".upload-status")?.textContent ?? "", /Reading cancelled/);
  assert.equal(editor("Recipe name").value, "Keep this draft");
  assert.equal(upload.disabled, false);
  await waitFor(() => cancelledReads === 1);

  Object.defineProperty(upload, "files", { configurable: true, value: [new browser.File(["photo"], "recipe.jpg", { type: "image/jpeg" })] });
  upload.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => recipeReads === 2);
  assert.equal(dishUpload.disabled, false);
  Object.defineProperty(dishUpload, "files", { configurable: true, value: [new browser.File(["photo"], "dinner.jpg", { type: "image/jpeg" })] });
  dishUpload.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => document.querySelectorAll(".upload-status")[1]?.textContent?.includes("Dish photo ready"));
  const dishPhoto = document.querySelector('img[alt="Recipe cover photo"]')?.getAttribute("src");
  assert.ok(dishPhoto?.startsWith("data:image/jpeg"));
  assert.equal(findButton("Save to my collection").disabled, true);
  finishImport.resolve();
  await waitFor(() => !document.querySelector(".import-warnings")?.hidden);
  assert.equal(document.querySelector("progress")?.parentElement?.hidden, true);
  assert.match(document.querySelector(".upload-status.is-success")?.textContent ?? "", /Draft ready: .*Review the details below, then save/);
  assert.equal(editor("Recipe name").value, content.title);
  assert.match(document.querySelector(".import-warnings")?.textContent ?? "", /Double-check the servings/);
  assert.equal((await store.read()).recipes.length, 1, "photo extraction remains a draft until a reviewed save");
  const photoReviewed = document.querySelector(".recipe-form > .check-field input");
  assert.ok(photoReviewed);
  assert.equal(photoReviewed.required, true);
  assert.equal(photoReviewed.checked, false);
  photoReviewed.checked = true;
  findButton("Save to my collection").click();
  await waitFor(() => document.querySelectorAll(".collection-card").length === initialRecipes + 2);
  const imported = (await store.read()).recipes.at(-1);
  assert.ok(imported);
  assert.equal((await store.read()).recipes.length, 2);
  assert.equal(imported.image, dishPhoto, "the selected dish photo is saved with the imported recipe");

  Array.from(document.querySelectorAll(".collection-card")).at(-1)?.click();
  editRecipe();
  assert.equal(new URL(browser.location.href).searchParams.get("recipe"), imported.id);
  assert.equal(new URL(browser.location.href).searchParams.get("edit"), "1");
  const previousEditor = document.querySelector(".recipe-form");
  browser.history.pushState({ plannerRoute: true, plannerHasParent: false }, "", `/?view=recipes&recipe=${encodeURIComponent(imported.id)}&edit=1`);
  browser.dispatchEvent(new browser.PopStateEvent("popstate"));
  await waitFor(() => document.querySelector(".recipe-form") !== previousEditor);
  assert.equal(editor("Recipe name").value, imported.title);
  document.querySelector("#close-modal")?.click();
  await waitFor(() => new URL(browser.location.href).searchParams.get("recipe") === imported.id && !new URL(browser.location.href).searchParams.has("edit") && Boolean(document.querySelector(".recipe-layout")));
  editRecipe();
  await waitFor(() => Boolean(document.querySelector(".recipe-form")));
  const updateUpload = document.querySelector<HTMLInputElement>('input[aria-label="Choose or take a photo of the recipe page"]');
  assert.ok(updateUpload);
  Object.defineProperty(updateUpload, "files", { configurable: true, value: [new browser.File(["photo"], "updated-recipe.jpg", { type: "image/jpeg" })] });
  updateUpload.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => !document.querySelector(".import-warnings")?.hidden);
  const updateReviewed = document.querySelector(".recipe-form > .check-field input");
  assert.ok(updateReviewed);
  updateReviewed.checked = true;
  editor("Description").value = "Updated from the photographed family recipe.";
  findButton("Update this recipe").click();
  await waitFor(() => !document.querySelector("dialog")?.open);
  const updated = (await store.read()).recipes.at(-1);
  assert.equal((await store.read()).recipes.length, 2);
  assert.equal(updated?.id, imported.id);
  assert.equal(updated?.description, "Updated from the photographed family recipe.");
  assert.equal(updated?.image, imported.image, "reading a recipe page leaves the existing cover unchanged");

  Array.from(document.querySelectorAll(".collection-card")).at(-1)?.click();
  editRecipe();
  findButton("Find a photo with Copilot").click();
  await waitFor(() => document.querySelectorAll(".recipe-form .upload-status")[1]?.textContent?.includes("Photo found"));
  assert.ok((document.querySelector('img[alt="Recipe cover photo"]')?.getAttribute("src") ?? "").endsWith("/images/chicken.jpg"));
  assert.match(document.querySelector(".recipe-form .photo-credit")?.textContent ?? "", /Example photographer/);
  const sourceAfterSearch = document.querySelector<HTMLInputElement>('input[aria-label="Choose or take a photo of the recipe page"]');
  assert.ok(sourceAfterSearch);
  Object.defineProperty(sourceAfterSearch, "files", { configurable: true, value: [new browser.File(["photo"], "page.jpg", { type: "image/jpeg" })] });
  sourceAfterSearch.dispatchEvent(new browser.Event("change", { bubbles: true }));
  await waitFor(() => document.querySelector(".upload-status.is-success"));
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
  editRecipe();
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
