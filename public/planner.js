import { DAYS, CATEGORIES, PROTEINS, today, addDays, mondayFor, dateLabel, weekLabel, ingredientLine, shoppingText, parseIngredientLines } from "./lib.js";

const view = document.querySelector("#view");
const modal = document.querySelector("#modal");
const modalContent = document.querySelector("#modal-content");
const toast = document.querySelector("#toast");
const state = { view: "weeks", recipes: [], summaries: [], weekKey: mondayFor(today()), week: null };
const SHARE_PALETTE = {
  paper: "#f3efe4",
  forest: "#203f32",
  ink: "#203b30",
  cream: "#fffdf7",
  green: "#49644a",
  muted: "#59695b",
  line: "#ded8c8",
  saffron: "#c2943c",
  terracotta: "#9c4c31",
};
let toastTimer;
let loadSequence = 0;
let shareUrl;

function h(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === "text") node.textContent = value;
    else if (key === "className") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function button(text, onClick, className = "button") {
  return h("button", { type: "button", text, className, onClick: (event) => run(onClick, event.currentTarget) });
}
function loadingState(message) {
  return h("div", { className: "loading-state", role: "status" },
    h("p", { className: "loading", text: message }),
    h("span", { className: "skeleton-line", "aria-hidden": "true" }),
    h("span", { className: "skeleton-line short", "aria-hidden": "true" }),
    h("span", { className: "skeleton-line", "aria-hidden": "true" }));
}
function notify(message, error = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("is-error", error);
  toast.setAttribute("role", error ? "alert" : "status");
  toast.hidden = false;
  if (error && modal.open) {
    let message = modalContent.querySelector("#dialog-error");
    if (!message) {
      message = h("p", { id: "dialog-error", className: "notice", role: "alert" });
      modalContent.prepend(message);
    }
    message.textContent = toast.textContent;
    message.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  toastTimer = setTimeout(() => { toast.hidden = true; }, error ? 14000 : 5500);
}
async function run(action, control) {
  if (control) control.disabled = true;
  try { await action(); }
  catch (error) {
    console.error(error);
    notify(error instanceof Error ? error.message : "Something went wrong.", true);
  } finally { if (control) control.disabled = false; }
}
async function api(path, body, method) {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(150_000),
  });
  const value = await response.json();
  if (response.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  if (!response.ok) {
    const details = value.details?.fieldErrors;
    const message = details ? Object.entries(details).map(([field, errors]) => `${field}: ${errors.join(", ")}`).join("; ") : "";
    throw new Error([value.error || `Request failed (${response.status}).`, message].filter(Boolean).join(" "));
  }
  return value;
}
function heading(kicker, title, description) {
  return h("div", { className: "page-heading" },
    h("p", { className: "eyebrow", text: kicker }),
    h("h1", { text: title }),
    description ? h("p", { className: "lede", text: description }) : null);
}
function tag(text, extra = "") { return h("span", { className: `tag ${extra}`, text }); }
function hasImageCredit(credit) {
  return credit &&
    ["creator", "sourceUrl", "license", "licenseUrl"].every((key) => typeof credit[key] === "string" && credit[key].trim()) &&
    (credit.creatorUrl === undefined || (typeof credit.creatorUrl === "string" && credit.creatorUrl.trim()));
}
function photoCreditParts(credit) {
  if (!hasImageCredit(credit)) return null;
  const creator = h("a", { href: credit.creatorUrl ?? credit.sourceUrl, target: "_blank", rel: "noreferrer", text: credit.creator });
  if (credit.creatorUrl) {
    return ["Photo by ", creator, " on ", h("a", { href: credit.sourceUrl, target: "_blank", rel: "noreferrer", text: "Unsplash" }),
      " · ", h("a", { href: credit.licenseUrl, target: "_blank", rel: "noreferrer", text: "Unsplash licence" })];
  }
  return ["Photo by ", creator, ` · ${credit.license} `, h("a", { href: credit.licenseUrl, target: "_blank", rel: "noreferrer", text: "licence" })];
}
function field(label, input, help) {
  return h("label", { className: "field" }, h("span", { text: label }), input, help ? h("small", { text: help }) : null);
}
function select(options, value) {
  const node = h("select");
  for (const [key, label] of Object.entries(options)) node.append(h("option", { value: key, text: label }));
  node.value = String(value);
  return node;
}
function openModal(...content) {
  modalContent.replaceChildren(...content.filter((item) => item !== null && item !== undefined));
  if (!modal.open) modal.showModal();
  modal.scrollTop = 0;
}
function readRoute() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (view === "week" && /^\d{4}-\d{2}-\d{2}$/.test(params.get("week") ?? "")) {
    return {
      view, week: params.get("week"), recipe: params.get("recipe"), day: params.get("day"),
      edit: params.get("edit"), q: params.get("q"), category: params.get("category"), protein: params.get("protein"),
    };
  }
  if (view === "recipes") {
    return {
      view, recipe: params.get("recipe"), edit: params.get("edit"), q: params.get("q"),
      category: params.get("category"), protein: params.get("protein"),
    };
  }
  return { view: "weeks" };
}
function writeRoute(route, replace = false) {
  const params = new URLSearchParams();
  params.set("view", route.view);
  for (const key of ["week", "recipe", "day", "edit", "q", "category", "protein"]) {
    const value = route[key];
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  if (url === `${window.location.pathname}${window.location.search}${window.location.hash}` && window.history.state?.plannerRoute) return;
  const hasParent = replace ? Boolean(window.history.state?.plannerHasParent) : true;
  window.history[replace ? "replaceState" : "pushState"]({ plannerRoute: true, plannerHasParent: hasParent }, "", url);
}
function dismissRouteModal() {
  const route = readRoute();
  if (!route.recipe && !route.edit) return false;
  if (window.history.state?.plannerHasParent) {
    window.history.back();
  } else {
    const parent = { ...route, edit: undefined };
    if (!route.edit) { parent.recipe = undefined; parent.day = undefined; }
    writeRoute(parent, true);
    if (modal.open) modal.close();
    run(restoreRoute);
  }
  return true;
}
document.querySelector("#close-modal").addEventListener("click", () => {
  if (!dismissRouteModal()) modal.close();
});
modal.addEventListener("click", (event) => {
  if (event.target === modal && !dismissRouteModal()) modal.close();
});
modal.addEventListener("cancel", (event) => {
  if (dismissRouteModal()) event.preventDefault();
});
modal.addEventListener("close", () => {
  if (shareUrl) { URL.revokeObjectURL(shareUrl); shareUrl = undefined; }
});

function setNavigation() {
  const weeks = document.querySelector("#nav-weeks");
  const recipes = document.querySelector("#nav-recipes");
  weeks.classList.toggle("active", state.view !== "recipes");
  recipes.classList.toggle("active", state.view === "recipes");
  weeks.setAttribute("aria-current", state.view !== "recipes" ? "page" : "false");
  recipes.setAttribute("aria-current", state.view === "recipes" ? "page" : "false");
}
async function showWeeks(updateUrl = true) {
  if (updateUrl) writeRoute({ view: "weeks" });
  if (modal.open) modal.close();
  const sequence = ++loadSequence;
  state.view = "weeks";
  setNavigation();
  view.replaceChildren(loadingState("Finding your weeks..."));
  const summaries = await api("/weeks");
  if (state.view !== "weeks" || sequence !== loadSequence) return;
  state.summaries = summaries;
  renderWeeks();
}
function renderWeeks() {
  const current = mondayFor(today());
  const keys = new Set(state.summaries.map((week) => week.week));
  for (let offset = -2; offset <= 7; offset++) keys.add(addDays(current, offset * 7));
  const datePicker = h("input", { type: "date", value: current, "aria-label": "Choose any date in a week" });
  datePicker.addEventListener("change", () => { if (datePicker.value) run(() => openWeek(mondayFor(datePicker.value))); });
  const hero = h("section", { className: "hero" },
    h("div", { className: "hero-copy" },
      heading("A TABLE WORTH COMING HOME TO", "Good weeks start\nwith good dinners.", "A few thoughtful choices now. One less thing to think about later."),
      h("div", { className: "hero-actions" }, button("Plan this week \u2192", () => openWeek(current)), h("span", { text: "Pick your days. We'll find the dishes." }))),
    h("div", { className: "hero-art" },
      h("img", { src: "/images/salad.jpg", alt: "A colourful bowl of fresh vegetables photographed from above" }),
      h("div", { className: "hero-note" }, h("span", { text: "ON THE MENU" }), h("p", { text: "A little seasonal.\nA little spontaneous.\nEntirely yours." }))));
  const grid = h("div", { className: "week-grid" });
  [...keys].sort().forEach((key) => {
    const saved = state.summaries.find((week) => week.week === key);
    const title = key === current ? "This week" : key === addDays(current, 7) ? "Next week" : dateLabel(key, { month: "long", day: "numeric" });
    const card = button("", () => openWeek(key), `week-card ${key === current ? "current" : ""}`);
    card.append(
      h("div", { className: "week-card-top" }, h("span", { className: "week-label", text: title }), tag(saved ? saved.status === "confirmed" ? "Locked in" : "Draft" : "A fresh page", saved?.status === "confirmed" ? "green" : "")),
      h("p", { className: "week-date", text: weekLabel(key) }),
      h("div", { className: "mini-days" }, ...DAYS.map((day, index) => h("span", { className: saved?.days.includes(index) ? "filled" : "", text: day[0], "aria-hidden": "true" }))),
      h("p", { className: "week-preview", text: saved ? `${saved.count} dinners \u00b7 ${saved.titles.slice(0, 2).join(" / ")}${saved.count > 2 ? "..." : ""}` : "Something delicious could happen here." }),
      h("span", { className: "card-link", text: saved ? "Open your week \u2197" : "Start planning \u2197" }));
    grid.append(card);
  });
  view.replaceChildren(hero, h("section", { className: "weeks-section" },
    h("div", { className: "section-bar" }, h("div", {}, h("p", { className: "eyebrow", text: "YOUR KITCHEN CALENDAR" }), h("h2", { text: "Your weeks, your rhythm." })), field("Jump to a week", datePicker)), grid));
}

async function openWeek(key, updateUrl = true) {
  if (updateUrl) writeRoute({ view: "week", week: key });
  if (modal.open) modal.close();
  const sequence = ++loadSequence;
  state.view = "week";
  state.weekKey = key;
  setNavigation();
  view.replaceChildren(loadingState("Opening your week..."));
  const week = await api(`/weeks/${key}`);
  if (sequence !== loadSequence) return;
  state.week = week;
  renderWeek();
}
function planningForm() {
  const existing = state.week;
  const key = state.weekKey;
  const selected = new Set(existing ? existing.meals.map((meal) => meal.day) : [0, 1, 2, 3, 4]);
  const adults = h("input", { type: "number", inputMode: "numeric", min: 0, max: 12, step: 1, value: existing?.adults ?? (existing?.people ?? 2) - (existing?.children ?? 0), required: true });
  const children = h("input", { type: "number", inputMode: "numeric", min: 0, max: 12, step: 1, value: existing?.children ?? 0, required: true });
  const diet = select({ anything: "A bit of everything", vegetarian: "Vegetarian", vegan: "Vegan", pescatarian: "Pescatarian" }, existing?.rules.diet ?? "anything");
  const time = select({ 20: "20 minutes", 30: "30 minutes", 45: "45 minutes", 60: "60 minutes", 90: "90 minutes", 180: "Any time (up to 3 hours)" }, existing?.rules.maxMinutes ?? 60);
  const weeksCount = select(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, `${index + 1} ${index === 0 ? "week" : "weeks"}`])), 1);
  const different = h("input", { type: "checkbox", checked: existing?.rules.differentProteins ?? true });
  const overlap = h("input", { type: "checkbox", checked: existing?.rules.overlapIngredients ?? true });
  const dayList = h("div", { className: "day-picker", role: "group", "aria-label": "Days needing dinner" });
  const count = h("p", { className: "selection-count" });
  const submit = h("button", { type: "submit", className: "button", text: "Start planning" });
  function updateDays() {
    count.textContent = `${selected.size} ${selected.size === 1 ? "dinner" : "dinners"} to look forward to`;
    submit.textContent = existing
      ? `Replan ${selected.size} ${selected.size === 1 ? "dinner" : "dinners"} \u2192`
      : Number(weeksCount.value) === 1
        ? `Start planning ${selected.size} ${selected.size === 1 ? "dinner" : "dinners"} \u2192`
        : `Plan ${weeksCount.value} weeks \u2192`;
    submit.disabled = selected.size === 0;
    [...dayList.children].forEach((item, index) => { item.setAttribute("aria-pressed", String(selected.has(index))); });
  }
  weeksCount.addEventListener("change", updateDays);
  DAYS.forEach((day, index) => {
    dayList.append(button("", () => {
      if (selected.has(index)) selected.delete(index); else selected.add(index);
      updateDays();
    }, "day-toggle"));
    dayList.lastChild.append(h("span", { text: day.slice(0, 3) }), h("strong", { text: dateLabel(addDays(state.weekKey, index), { day: "numeric" }) }), h("span", { className: "day-check", text: "\u2713", "aria-hidden": "true" }));
    dayList.lastChild.setAttribute("aria-label", `Plan dinner for ${day}`);
  });
  const quickPick = h("div", { className: "quick-pick" }, h("span", { text: "Quick pick:" }),
    ...[3, 5, 7].map((number) => button(`${number} dinners`, () => {
      selected.clear();
      for (let i = 0; i < number; i++) selected.add(i);
      updateDays();
    }, "text-button")));
  const form = h("form", { className: "planning-form" },
    h("div", { className: "form-section" }, h("p", { className: "eyebrow", text: "01 / MAKE ROOM AT THE TABLE" }),
      h("h2", { text: "Which nights are we cooking?" }), h("p", { className: "muted", text: "Tap the days you need dinner. Leave space for leftovers and nights out." }),
      dayList, h("div", { className: "day-picker-footer" }, count, quickPick),
      existing ? null : field("Plan ahead", weeksCount, "Use these cooking nights and house rules for each week.")),
    h("div", { className: "form-section" }, h("p", { className: "eyebrow", text: "02 / A FEW HOUSE RULES" }),
      h("div", { className: "form-grid" }, field("Adults", adults), field("Children", children)),
      h("p", { className: "muted", text: "Plan for 1 to 12 people in total. Each adult and child counts as one serving; adjust portions to suit your household." }),
      h("div", { className: "form-grid" }, field("How we eat", diet), field("Total time per meal", time)),
      h("label", { className: "check-field" }, different, h("span", {}, h("strong", { text: "A different protein each dinner" }), h("small", { text: "No repeated primary protein in the week. Includes tofu, beans, eggs and cheese." }))),
      h("label", { className: "check-field" }, overlap, h("span", {}, h("strong", { text: "Some overlapping ingredients" }), h("small", { text: "Favour shared fresh ingredients, for a shorter shopping list and less waste." })))),
    h("div", { className: "form-bottom" }, h("p", { className: "muted", text: "Picked from your recipe collection. No AI credits needed." }), submit));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const planning = {
        days: [...selected], people: Number(adults.value) + Number(children.value),
        adults: Number(adults.value), children: Number(children.value),
        rules: { differentProteins: different.checked, overlapIngredients: overlap.checked, maxMinutes: Number(time.value), diet: diet.value },
        revision: existing?.revision,
      };
      const count = existing ? 1 : Number(weeksCount.value);
      const next = count === 1
        ? await api(`/weeks/${key}/plan`, planning)
        : (await api("/weeks/plan", { ...planning, startWeek: key, count }))[0];
      if (modalContent.contains(form)) modal.close();
      if (state.view === "week" && state.weekKey === key) { state.week = next; renderWeek(); }
      notify(count === 1 ? "Your draft is ready. Swap anything you don't fancy." : `Your next ${count} weeks are ready. Swap anything you don't fancy.`);
    }, submit);
  });
  updateDays();
  return form;
}
function peopleLabel(week) {
  if (week.adults === undefined && week.children === undefined) return `${week.people} people`;
  const children = week.children ?? 0;
  const adults = week.adults ?? week.people - children;
  return `${adults} ${adults === 1 ? "adult" : "adults"}, ${children} ${children === 1 ? "child" : "children"}`;
}
function renderWeek() {
  const week = state.week;
  const locked = week?.status === "confirmed";
  const actions = h("div", { className: "action-row" }, button("\u2190 All weeks", () => showWeeks(), "text-button"));
  if (week) actions.append(button("Share week \u2197", shareWeek, "button secondary small"));
  const title = heading(locked ? "DINNER IS SORTED" : "A LITTLE FORWARD THINKING", weekLabel(state.weekKey), week ? `${week.meals.length} dinners \u00b7 ${peopleLabel(week)} \u00b7 ${locked ? "Confirmed and locked in" : "A draft to make your own"}` : "Choose the nights. Set a few rules. Find your weeknight rhythm.");
  if (!week) {
    view.replaceChildren(actions, title, planningForm());
    return;
  }
  const statusBar = h("div", { className: `plan-status ${locked ? "locked" : ""}` },
    h("div", {}, tag(locked ? "\u2713 Locked in" : "Draft plan", locked ? "green" : ""), h("span", { text: locked ? "Your dinners and shopping quantities are saved for this week." : "Nothing is set in stone. Swap a dish, move a day, then make it official." })),
    locked ? button("Unlock to edit", unlockWeek, "text-button") : button("Change planning rules", () => openModal(h("h2", { id: "modal-title", text: "A little change of plan" }), planningForm()), "text-button"));
  const grid = h("div", { className: "meal-grid" });
  DAYS.forEach((day, index) => {
    const meal = week.meals.find((item) => item.day === index);
    const date = addDays(week.week, index);
    const card = h("article", { className: `day-card ${meal ? "" : "day-off"} ${date === today() ? "today-card" : ""}` },
      h("div", { className: "day-card-heading" }, h("strong", { text: day }), h("span", { text: `${date === today() ? "Today \u00b7 " : ""}${dateLabel(date, { day: "numeric", month: "short" })}` })));
    if (!meal) {
      card.append(h("div", { className: "off-content" }, h("span", { className: "off-mark", text: "\u2014" }), h("h3", { text: "A night off." }), h("p", { text: "Leftovers, a favourite takeaway,\nor something spontaneous." })));
    } else {
      const recipe = meal.recipe;
      const open = button("", () => showRecipe(recipe, week.people, week.week, index), "recipe-open");
      open.append(h("img", { src: recipe.image, alt: recipe.title, loading: "lazy", className: "meal-photo" }),
        h("div", { className: "meal-copy" }, h("div", { className: "recipe-meta" }, tag(PROTEINS[recipe.protein]), h("span", { text: `${recipe.prepMinutes + recipe.cookMinutes} min` })), h("h3", { text: recipe.title }), h("p", { text: CATEGORIES[recipe.category] }),
          meal.cooked ? h("span", { className: "tag green meal-completion" }, "\u2713 Cooked!")
            : h("span", { className: "card-link", text: locked ? "Let's cook \u2192" : "Read recipe \u2192" })));
      card.append(open);
      if (!locked) {
        const move = select(Object.fromEntries(DAYS.map((name, dayIndex) => [dayIndex, `Move to ${name}`])), index);
        move.setAttribute("aria-label", `Change day for ${recipe.title}`);
        move.addEventListener("change", () => run(async () => {
          try {
            await mutateWeek("move", { from: index, to: Number(move.value) });
            notify("Days updated. Meals exchange places when both days are occupied.");
          } finally {
            if (move.isConnected) move.value = String(index);
          }
        }, move));
        card.append(h("div", { className: "meal-actions" }, button("\u21bb Swap", () => swapDialog(index), "text-button"), move));
      }
    }
    grid.append(card);
  });
  const bottom = locked ? shoppingPanel(week) : h("div", { className: "confirm-bar" },
    h("div", {}, h("h2", { text: "Looks like a delicious week." }), h("p", { text: "Confirm to lock it in and bring your shopping list together." })),
    button("Confirm this week \u2713", async () => {
      await mutateWeek("confirm");
      notify("Locked in. Your combined shopping list is ready.");
      document.querySelector("#shopping")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  view.replaceChildren(actions, title, statusBar, grid, bottom);
}
async function mutateWeek(action, body = {}) {
  const key = state.weekKey;
  const week = await api(`/weeks/${key}/${action}`, { ...body, revision: state.week.revision });
  if (state.view === "week" && state.weekKey === key) { state.week = week; renderWeek(); }
}
async function unlockWeek() {
  if (!window.confirm("Unlock this week? Its shopping list will be rebuilt when you confirm again.")) return;
  await mutateWeek("unlock");
  notify("Week unlocked. Confirm again after making your changes.");
}
async function swapDialog(day) {
  const key = state.weekKey;
  const revision = state.week.revision;
  const recipes = await api(`/weeks/${key}/alternatives/${day}`);
  const list = h("div", { className: "swap-list" });
  const replace = async (recipeId) => {
    if (state.weekKey !== key || state.week.revision !== revision) throw new Error("The week changed. Reopen the swap picker.");
    await mutateWeek("swap", { day, recipeId });
    modal.close();
    notify("A fresh idea for dinner.");
  };
  recipes.forEach((recipe) => {
    const choice = button("", () => replace(recipe.id), "swap-choice");
    choice.append(h("img", { src: recipe.image, alt: "", loading: "lazy" }), h("div", {}, h("strong", { text: recipe.title }), h("p", { text: `${PROTEINS[recipe.protein]} \u00b7 ${recipe.prepMinutes + recipe.cookMinutes} min` })), h("span", { text: "\u2192" }));
    list.append(choice);
  });
  openModal(h("p", { className: "eyebrow", text: `A CHANGE FOR ${DAYS[day].toUpperCase()}` }), h("h2", { id: "modal-title", text: "Something else sound good?" }),
    h("p", { className: "muted", text: "These alternatives still follow your diet, time and protein rules." }),
    recipes.length ? button("Surprise me \u21bb", () => replace(undefined), "button secondary") : h("p", { className: "notice", text: "No alternatives fit. Change your planning rules or add another recipe to the collection." }), list);
}

function shoppingPanel(week) {
  const include = h("input", { type: "checkbox", checked: true });
  const oliveNote = h("input", { type: "checkbox", checked: true });
  const justAdd = h("input", { type: "checkbox" });
  const text = h("textarea", { className: "shopping-text", rows: 12, readOnly: true, "aria-label": "Combined shopping list for copying" });
  const checklist = h("div", { className: "shopping-checklist" });
  const progress = h("p", { className: "shopping-progress", role: "status", "aria-live": "polite" });
  const storageKey = `eatplanner.app:checked:${week.week}:${week.revision}`;
  const legacyStorageKey = `mealplan.ai:checked:${week.week}:${week.revision}`;
  let checked = new Set();
  try {
    const saved = localStorage.getItem(storageKey);
    const stored = JSON.parse(saved ?? localStorage.getItem(legacyStorageKey) ?? "[]");
    if (!Array.isArray(stored) || stored.some((item) => typeof item !== "string")) throw new Error("Invalid saved checklist.");
    checked = new Set(stored);
    if (saved === null && stored.length) localStorage.setItem(storageKey, JSON.stringify(stored));
  } catch (error) { console.error(error); notify("The saved shopping ticks could not be loaded. Your confirmed list is safe.", true); }
  function render() {
    const items = shoppingText(week.shoppingList, include.checked);
    const instructions = [
      oliveNote.checked ? "Add these items to my cart" : "",
      justAdd.checked ? "Just add, don't confirm" : "",
    ].filter(Boolean);
    text.value = instructions.length && items ? `${instructions.join("\n")}\n\n${items}` : items;
    checklist.replaceChildren();
    const visibleItems = week.shoppingList.filter((item) => include.checked || !item.pantry);
    visibleItems.forEach((item) => {
      const key = `${item.name}|${item.unit}`;
      const box = h("input", { type: "checkbox", checked: checked.has(key) });
      box.addEventListener("change", () => {
        if (box.checked) checked.add(key); else checked.delete(key);
        updateProgress(visibleItems);
        try { localStorage.setItem(storageKey, JSON.stringify([...checked])); }
        catch (error) { console.error(error); notify("This browser couldn't save your shopping ticks.", true); }
      });
      checklist.append(h("label", { className: "shopping-item" }, box, h("span", { text: ingredientLine(item) }), item.pantry ? tag("Pantry") : null));
    });
    updateProgress(visibleItems);
  }
  function updateProgress(items) {
    const complete = items.filter((item) => checked.has(`${item.name}|${item.unit}`)).length;
    progress.textContent = items.length ? `${complete} of ${items.length} items checked` : "No items in this list.";
  }
  include.addEventListener("change", render);
  oliveNote.addEventListener("change", render);
  justAdd.addEventListener("change", render);
  render();
  const copyStatus = h("p", { className: "muted", role: "status", "aria-live": "polite" });
  async function copyList(openWoolworths = false) {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text.value);
        copied = true;
      } catch (error) { console.error("Clipboard access failed:", error); }
    }
    if (!copied) {
      text.focus();
      text.select();
      text.setSelectionRange(0, text.value.length);
      try { copied = document.execCommand?.("copy") === true; }
      catch (error) { console.error("Clipboard fallback failed:", error); }
    }
    if (!copied) {
      copyStatus.textContent = "Your browser couldn't copy automatically. The ingredients are selected: press and hold the text, then tap Copy. Open Woolworths after copying.";
      return;
    }
    copyStatus.textContent = oliveNote.checked || justAdd.checked
      ? "Ingredients copied. Open Olive in the Woolworths app, paste into the chat and send."
      : "Ingredients copied. Paste into Olive or a supported Woolworths list-entry field.";
    if (openWoolworths) window.location.assign("https://www.woolworths.com.au/");
  }
  return h("section", { className: "shopping-panel", id: "shopping" },
    h("div", { className: "section-bar" }, h("div", {}, h("p", { className: "eyebrow", text: "ONE LIST. ONE LESS TRIP." }), h("h2", { text: "A little list for the shops." })),
      button("Copy shopping list", () => copyList(), "button")),
    h("p", { className: "muted", text: `Combined and scaled for ${peopleLabel(week)}. Quantities are recipe amounts, not supermarket pack sizes. Pantry items are included unless you untick them.` }),
    h("label", { className: "check-field compact" }, include, h("span", { text: "Include pantry staples" })),
    h("div", { className: "shopping-layout" }, h("div", {}, progress, checklist), h("div", {},
      h("h3", { text: "Take your ingredients to Woolworths" }),
      h("label", { className: "check-field compact" }, oliveNote,
        h("span", { text: 'Include Olive instruction: "Add these items to my cart"' })),
      h("label", { className: "check-field compact" }, justAdd,
        h("span", {}, h("strong", { text: "Just add" }),
          h("small", { text: 'Adds "Just add, don\'t confirm". This requests fewer prompts; Olive may still require confirmation.' }))),
      h("ol", { className: "shopping-instructions" },
        h("li", { text: "Choose whether to include pantry staples and the Olive instruction, then copy your ingredients." }),
        h("li", { text: "In the Woolworths app, choose Pick up or Delivery mode and open Olive beside the home-page search bar. Press and hold the chat field, tap Paste, then send." }),
        h("li", { text: "Follow Olive's prompts and check product matches, pack sizes and quantities. The instruction requests cart additions, but cannot skip any confirmation Olive requires. You complete checkout yourself." })),
      h("div", { className: "shopping-copy-actions" },
        button("Copy & open Woolworths", () => copyList(true)),
        h("a", { className: "button secondary", href: "https://www.woolworths.com.au/", text: "Open Woolworths" })),
      copyStatus, text,
      h("p", { className: "fineprint" },
        "The Woolworths link may open the installed app if your phone allows it; otherwise it opens the website. Olive is only available in the app, not on the website or in in-store mode. Nothing is sent to Olive automatically. ",
        h("a", { href: "https://www.woolworths.com.au/shop/services/olive", text: "Woolworths Olive help" })))));
}

function showRecipes(updateUrl = true) {
  const previous = readRoute();
  if (updateUrl) {
    writeRoute({ view: "recipes", q: previous.q, category: previous.category, protein: previous.protein });
  }
  if (modal.open) modal.close();
  ++loadSequence;
  state.view = "recipes";
  setNavigation();
  const route = readRoute();
  const search = h("input", { type: "search", placeholder: "Find a recipe or ingredient...", "aria-label": "Search recipes", value: route.q ?? "" });
  const category = select({ all: "Every category", ...CATEGORIES }, route.category ?? "all");
  category.setAttribute("aria-label", "Filter recipes by category");
  const protein = select({ all: "Every protein", ...PROTEINS }, route.protein ?? "all");
  protein.setAttribute("aria-label", "Filter recipes by protein");
  const grid = h("div", { className: "collection-grid" });
  const count = h("p", { className: "muted", role: "status", "aria-live": "polite" });
  function filter() {
    const query = search.value.toLowerCase().trim();
    const filtered = state.recipes.filter((recipe) => (category.value === "all" || category.value === recipe.category) &&
      (protein.value === "all" || protein.value === recipe.protein) &&
      `${recipe.title} ${recipe.description} ${recipe.ingredients.map((i) => i.name).join(" ")}`.toLowerCase().includes(query));
    count.textContent = `${filtered.length} recipes to come home to`;
    grid.replaceChildren(...filtered.map((recipe) => {
      const card = button("", () => showRecipe(recipe), "collection-card");
      card.append(h("div", { className: "collection-image" }, h("img", { src: recipe.image, alt: recipe.title, loading: "lazy" }), tag(CATEGORIES[recipe.category])),
        h("div", { className: "meal-copy" }, h("div", { className: "recipe-meta" }, h("span", { text: PROTEINS[recipe.protein] }), h("span", { text: `${recipe.prepMinutes + recipe.cookMinutes} min` })),
          h("h3", { text: recipe.title }), h("p", { text: recipe.description }), h("span", { className: "card-link", text: "Into the kitchen \u2192" })));
      return card;
    }));
    if (!filtered.length) grid.append(h("p", { className: "notice", text: "No recipes match yet. Try another filter or add one of your own." }));
  }
  function updateFilters() {
    writeRoute({
      view: "recipes",
      q: search.value.trim() || undefined,
      category: category.value === "all" ? undefined : category.value,
      protein: protein.value === "all" ? undefined : protein.value,
    }, true);
    filter();
  }
  search.addEventListener("input", updateFilters);
  category.addEventListener("change", updateFilters);
  protein.addEventListener("change", updateFilters);
  view.replaceChildren(heading("THE THINGS WE LOVE TO COOK", "Your recipe collection.", "A growing book of everyday favourites. Good ingredients, clear steps, and something for every kind of evening."),
    h("div", { className: "collection-toolbar" }, search, category, protein), count, grid,
    h("p", { className: "fineprint collection-note", text: "Photography is serving inspiration and may not depict the exact recipe. Always check ingredient labels for allergens and follow safe food-handling guidance." }));
  filter();
}

function showRecipe(recipe, servings = recipe.servings, weekKey, day, updateUrl = true) {
  if (updateUrl) {
    const current = readRoute();
    writeRoute({
      ...current, view: weekKey === undefined ? "recipes" : "week",
      week: weekKey, recipe: recipe.id, day: day === undefined ? undefined : String(day), edit: undefined,
    });
  }
  const ingredientList = h("div", { className: "recipe-ingredients" });
  recipe.ingredients.forEach((item) => ingredientList.append(h("label", { className: "shopping-item" }, h("input", { type: "checkbox" }), h("span", { text: ingredientLine(item, servings / recipe.servings) }))));
  let step = 0;
  const storageKey = weekKey === undefined ? null : `eatplanner.app:cook:${weekKey}:${day}:${recipe.id}`;
  const legacyStorageKey = weekKey === undefined ? null : `mealplan.ai:cook:${weekKey}:${day}:${recipe.id}`;
  if (storageKey) {
    try {
      const current = localStorage.getItem(storageKey);
      const saved = Number(current ?? (legacyStorageKey ? localStorage.getItem(legacyStorageKey) : null) ?? 0);
      if (Number.isInteger(saved) && saved >= 0 && saved < recipe.steps.length) step = saved;
      if (current === null && step > 0) localStorage.setItem(storageKey, String(step));
    } catch (error) { console.error(error); notify("Cooking progress couldn't be restored in this browser.", true); }
  }
  const stepCount = h("p", { className: "eyebrow" });
  const stepText = h("p", { className: "step-instruction", tabIndex: -1 });
  const previous = button("\u2190 Previous", () => changeStep(-1), "button secondary");
  const next = button("Next step \u2192", () => changeStep(1));
  function renderStep(focus = false) {
    stepCount.textContent = `STEP ${step + 1} OF ${recipe.steps.length}`;
    stepText.textContent = recipe.steps[step];
    previous.disabled = step === 0;
    next.disabled = step === recipe.steps.length - 1;
    next.textContent = step === recipe.steps.length - 1 ? "Ready to serve \u2713" : "Next step \u2192";
    if (focus) stepText.focus();
  }
  function changeStep(delta) {
    step = Math.max(0, Math.min(recipe.steps.length - 1, step + delta));
    if (storageKey) {
      try { localStorage.setItem(storageKey, String(step)); }
      catch (error) { console.error(error); notify("Cooking progress couldn't be saved in this browser.", true); }
    }
    renderStep(true);
  }
  renderStep();
  const allSteps = h("details", { className: "all-steps" }, h("summary", { text: "See the whole method" }),
    h("ol", {}, ...recipe.steps.map((text) => h("li", { text }))));
  const credit = photoCreditParts(recipe.imageCredit);
  const scheduledMeal = weekKey !== undefined && weekKey === state.week?.week
    ? state.week.meals.find((meal) => meal.day === day && meal.recipe.id === recipe.id)
    : undefined;
  const cookedStatus = h("p", { className: "muted", role: "status", text: scheduledMeal?.cooked ? "Done! You've cooked this meal." : "Not cooked yet." });
  const cookedButton = scheduledMeal ? button(scheduledMeal.cooked ? "Undo cooked" : "Cooked!", async () => {
    const cooked = !scheduledMeal.cooked;
    const updated = await api(`/weeks/${weekKey}/cooked`, { day, recipeId: recipe.id, cooked });
    scheduledMeal.cooked = cooked;
    if (state.weekKey === weekKey) {
      state.week = updated;
      renderWeek();
    }
    cookedButton.textContent = cooked ? "Undo cooked" : "Cooked!";
    cookedStatus.textContent = cooked ? "Done! You've cooked this meal." : "Not cooked yet.";
  }) : null;
  openModal(h("img", { className: "recipe-hero", src: recipe.image, alt: recipe.title }),
    credit ? h("p", { className: "fineprint photo-credit" }, ...credit) : null,
    h("div", { className: "recipe-intro" }, h("p", { className: "eyebrow", text: `${CATEGORIES[recipe.category]} / ${PROTEINS[recipe.protein]}` }),
      h("h2", { id: "modal-title", text: recipe.title }), h("p", { className: "muted", text: recipe.description }),
      h("div", { className: "recipe-stats" }, tag(`${servings} servings`), tag(`${recipe.prepMinutes} min prep`), tag(`${recipe.cookMinutes} min cook`), tag(recipe.diet)),
      cookedButton ? h("div", { className: "action-row" }, cookedButton, cookedStatus) : null,
      button("Edit recipe / update from photo", () => addRecipeDialog(recipe), "button secondary"),
      h("div", { className: "recipe-layout" }, h("section", {}, h("h3", { text: "What you'll need" }), ingredientList), h("section", { className: "cook-mode", "aria-label": "Step-by-step cooking" }, stepCount, stepText, h("div", { className: "step-controls" }, previous, next), allSteps)),
      recipe.notes ? h("p", { className: "notice", text: recipe.notes }) : null,
      h("p", { className: "fineprint", text: "Check allergies and ingredient labels yourself. Times are a guide; make sure food is cooked safely. Photos are serving inspiration." })));
}

async function shareWeek() {
  const week = state.week;
  if (!week) return;
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1480;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot create a share card.");
  ctx.fillStyle = SHARE_PALETTE.paper; ctx.fillRect(0, 0, 1080, 1480);
  ctx.fillStyle = SHARE_PALETTE.forest; ctx.fillRect(0, 0, 1080, 265);
  ctx.fillStyle = "#d8bd79"; ctx.fillRect(70, 86, 58, 4);
  ctx.fillStyle = SHARE_PALETTE.saffron; ctx.font = "500 24px sans-serif"; ctx.fillText("EATPLANNER.APP / OUR HOME KITCHEN", 70, 65);
  ctx.fillStyle = SHARE_PALETTE.cream; ctx.font = "62px Georgia"; ctx.fillText("This week, at our table.", 70, 143);
  ctx.font = "29px sans-serif"; ctx.fillStyle = "#e4e6d9"; ctx.fillText(weekLabel(week.week), 70, 205);
  const wrap = (text, x, y, maxWidth) => {
    let line = ""; let offset = 0;
    for (const word of text.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) { ctx.fillText(line, x, y + offset); offset += 38; line = word; }
      else line = next;
    }
    ctx.fillText(line, x, y + offset);
  };
  DAYS.forEach((day, index) => {
    const y = 310 + index * 143;
    const meal = week.meals.find((item) => item.day === index);
    ctx.fillStyle = "#e5e9d9"; ctx.beginPath(); ctx.arc(105, y + 40, 35, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = SHARE_PALETTE.green; ctx.font = "24px sans-serif"; ctx.fillText(day.slice(0, 1), 96, y + 48);
    ctx.font = "600 19px sans-serif"; ctx.fillStyle = SHARE_PALETTE.muted; ctx.fillText(day.toUpperCase(), 170, y + 5);
    ctx.font = "31px Georgia"; ctx.fillStyle = meal ? SHARE_PALETTE.ink : SHARE_PALETTE.muted;
    wrap(meal ? meal.recipe.title : "A night off. Something spontaneous.", 170, y + 48, 810);
    ctx.strokeStyle = SHARE_PALETTE.line; ctx.beginPath(); ctx.moveTo(170, y + 110); ctx.lineTo(1000, y + 110); ctx.stroke();
  });
  ctx.fillStyle = SHARE_PALETTE.forest; ctx.font = "24px sans-serif";
  ctx.fillText(`${peopleLabel(week)} / ${week.meals.length} dinners / ${week.status === "confirmed" ? "Locked in" : "DRAFT - not yet confirmed"}`, 70, 1385);
  ctx.fillStyle = SHARE_PALETTE.terracotta; ctx.fillRect(70, 1400, 40, 3);
  ctx.fillStyle = SHARE_PALETTE.muted; ctx.font = "22px Georgia"; ctx.fillText("A little less planning. A little more living.", 70, 1430);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The share card couldn't be created.");
  const file = new File([blob], `eatplanner-${week.week}.png`, { type: "image/png" });
  if (shareUrl) URL.revokeObjectURL(shareUrl);
  shareUrl = URL.createObjectURL(blob);
  const download = h("a", { className: "button secondary", href: shareUrl, download: file.name, text: "Download PNG" });
  const nativeShare = button("Share card \u2197", async () => {
    if (!navigator.canShare?.({ files: [file] })) {
      notify("File sharing isn't available here. Download the PNG and send it in your favourite app.");
      return;
    }
    try { await navigator.share({ files: [file], title: "Our weekly meal plan" }); }
    catch (error) { if (error instanceof Error && error.name === "AbortError") return; throw error; }
  });
  openModal(h("p", { className: "eyebrow", text: "GOOD FOOD IS BETTER SHARED" }), h("h2", { id: "modal-title", text: "Your week, in one little card." }),
    h("p", { className: "muted", text: "Send a PNG to your household. No account or access to this app needed. This is a snapshot, not a live shared link." }),
    h("div", { className: "action-row" }, nativeShare, download), h("img", { className: "share-preview", src: shareUrl, alt: `Meal plan for ${weekLabel(week.week)}. ${week.meals.map((meal) => `${DAYS[meal.day]}: ${meal.recipe.title}`).join(". ")}` }));
}

async function preparePhoto(file) {
  const isHeic = file && (/^image\/hei[cf](?:-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name));
  if (!file || (!file.type.startsWith("image/") && !isHeic)) throw new Error("Choose an image file.");
  if (file.size > 15_000_000) throw new Error("Choose a photo smaller than 15 MB.");
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch (error) {
    if (!isHeic) {
      console.error(error);
      throw new Error("This photo format couldn't be opened. Try a JPEG, PNG, WebP or HEIC photo.");
    }
    const response = await fetch("/api/recipes/convert-heic", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      signal: AbortSignal.timeout(150_000),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || `Photo conversion failed (${response.status}).`);
    }
    try { bitmap = await createImageBitmap(await response.blob()); }
    catch (conversionError) { console.error(conversionError); throw new Error("The converted photo couldn't be opened."); }
  }
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser cannot prepare this photo.");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/jpeg", 0.88);
    if (image.length > 2_900_000) throw new Error("This photo is still too large. Crop it and try again.");
    return image;
  } finally { bitmap.close(); }
}
function addRecipeDialog(existing, updateUrl = true) {
  if (updateUrl) {
    const current = readRoute();
    writeRoute({ ...current, view: current.view === "week" ? "week" : "recipes", edit: existing ? "1" : "new" });
  }
  let image = existing?.image ?? "/images/pasta.jpg";
  let prepared;
  let preparing = false;
  let extracting = false;
  const title = h("input", { required: true, maxLength: 100, placeholder: "Your family's favourite...", value: existing?.title ?? "" });
  const description = h("textarea", { rows: 2, required: true, maxLength: 400, placeholder: "A little about this dish", value: existing?.description ?? "" });
  const category = select(CATEGORIES, existing?.category ?? "quick");
  const protein = select(PROTEINS, existing?.protein ?? "chicken");
  const diet = select({ omnivore: "Omnivore", vegetarian: "Vegetarian", vegan: "Vegan", pescatarian: "Pescatarian" }, existing?.diet ?? "omnivore");
  const servings = h("input", { type: "number", min: 1, max: 12, value: existing?.servings ?? 2, required: true });
  const prep = h("input", { type: "number", min: 0, max: 180, value: existing?.prepMinutes ?? 10, required: true });
  const cook = h("input", { type: "number", min: 0, max: 360, value: existing?.cookMinutes ?? 20, required: true });
  const ingredients = h("textarea", { rows: 6, required: true, placeholder: "400 | g | canned chickpeas\n1 | piece | lemon\n1 | tbsp | olive oil | pantry",
    value: existing?.ingredients.map((item) => `${item.quantity} | ${item.unit} | ${item.name}${item.pantry ? " | pantry" : ""}`).join("\n") ?? "" });
  const steps = h("textarea", { rows: 6, required: true, placeholder: "One step per line. Include cooking temperatures and safety checks.", value: existing?.steps.join("\n") ?? "" });
  const notes = h("textarea", { rows: 2, maxLength: 1500, placeholder: "Source, tips, substitutions or anything to double-check", value: existing?.notes ?? "" });
  const warnings = h("div", { className: "import-warnings", role: "status", hidden: true });
  const reviewed = h("input", { type: "checkbox", required: true });
  const recipePreview = h("img", { className: "upload-preview", alt: "Selected recipe page", hidden: true });
  const recipeFile = h("input", { type: "file", accept: "image/*,.heic,.heif", "aria-label": "Choose or take a photo of the recipe page" });
  const recipeStatus = h("p", { className: "muted upload-status", role: "status" });
  const imagePreview = h("img", { className: "upload-preview", alt: "Recipe cover photo", src: image, hidden: !existing });
  const imageFile = h("input", { type: "file", accept: "image/*,.heic,.heif", "aria-label": "Choose or take a photo of the finished dish" });
  const imageStatus = h("p", { className: "muted upload-status", role: "status" });
  const photoCredit = h("p", { className: "fineprint photo-credit", hidden: true });
  let imageCredit = hasImageCredit(existing?.imageCredit) ? existing.imageCredit : undefined;
  const excludedPhotoSources = new Set(typeof imageCredit?.sourceUrl === "string" ? [imageCredit.sourceUrl] : []);
  const showPhotoCredit = () => {
    const parts = photoCreditParts(imageCredit);
    if (!parts) { photoCredit.hidden = true; photoCredit.replaceChildren(); return; }
    photoCredit.replaceChildren(...parts);
    photoCredit.hidden = false;
  };
  showPhotoCredit();
  function updatePhotoControls() {
    const busy = preparing || extracting || findingImage;
    recipeFile.disabled = busy;
    imageFile.disabled = busy;
    extract.disabled = busy || !prepared;
    findImage.disabled = busy;
    save.disabled = busy;
  }
  const extract = button("Read recipe with Copilot", async () => {
    if (!prepared) throw new Error("Take or choose a photo first.");
    extracting = true;
    updatePhotoControls();
    reviewed.checked = false;
    recipeStatus.textContent = "Reading your recipe. This can take up to two minutes...";
    try {
      const result = await api("/recipes/extract", { data: prepared.split(",")[1], mimeType: "image/jpeg" });
      if (!result.recipe) throw new Error("No readable recipe was found. Try a clearer photo.");
      const recipe = result.recipe;
      title.value = recipe.title; description.value = recipe.description; category.value = recipe.category;
      protein.value = recipe.protein; diet.value = recipe.diet; servings.value = recipe.servings;
      prep.value = recipe.prepMinutes; cook.value = recipe.cookMinutes;
      ingredients.value = recipe.ingredients.map((item) => `${item.quantity} | ${item.unit} | ${item.name}${item.pantry ? " | pantry" : ""}`).join("\n");
      steps.value = recipe.steps.join("\n"); notes.value = recipe.notes;
      warnings.replaceChildren(h("strong", { text: "Please review the transcription." }),
        h("ul", {}, ...result.warnings.map((warning) => h("li", { text: warning }))),
        h("p", { text: "Compare quantities, units, dietary labels and method with your photo before saving." }));
      warnings.hidden = false;
      recipeStatus.textContent = "Read successfully. Check the editable card below before saving.";
    } catch (error) {
      recipeStatus.textContent = "Photo import failed. You can try again or enter the recipe manually.";
      throw error;
    } finally { extracting = false; updatePhotoControls(); }
  }, "button secondary");
  extract.disabled = true;
  let findingImage = false;
  const findImage = button("Find a photo with Copilot", async () => {
    if (findingImage) return;
    findingImage = true;
    updatePhotoControls();
    imageStatus.textContent = "Searching and checking food photos. This can take up to two minutes...";
    try {
      if (typeof imageCredit?.sourceUrl === "string") excludedPhotoSources.add(imageCredit.sourceUrl);
      const result = await api("/recipes/find-image", {
        title: title.value,
        description: description.value,
        protein: protein.value,
        ingredients: ingredients.value.split("\n").map((line) => line.split("|")[2]?.trim()).filter(Boolean),
        excludeSourceUrls: [...excludedPhotoSources].slice(-20),
      });
      image = result.image;
      imageCredit = result.imageCredit;
      if (typeof imageCredit?.sourceUrl === "string") excludedPhotoSources.add(imageCredit.sourceUrl);
      imagePreview.src = image;
      imagePreview.hidden = false;
      showPhotoCredit();
      imageStatus.textContent = "Photo found. It will be saved with this recipe.";
    } catch (error) {
      imageStatus.textContent = "Photo search failed. Your current image is unchanged.";
      throw error;
    } finally {
      findingImage = false;
      updatePhotoControls();
    }
  }, "button secondary");
  recipeFile.addEventListener("change", () => run(async () => {
    const chosen = recipeFile.files?.[0];
    if (!chosen) return;
    preparing = true;
    updatePhotoControls();
    recipeStatus.textContent = "Preparing recipe photo...";
    try {
      prepared = await preparePhoto(chosen);
      recipePreview.src = prepared;
      recipePreview.hidden = false;
      reviewed.checked = false;
      recipeStatus.textContent = "Ready to read. Your photo is only sent to Copilot when you press Read recipe.";
    } catch (error) {
      recipeStatus.textContent = "Couldn't prepare the recipe photo. Your previous selection is unchanged.";
      throw error;
    } finally { preparing = false; updatePhotoControls(); }
  }));
  imageFile.addEventListener("change", () => run(async () => {
    const chosen = imageFile.files?.[0];
    if (!chosen) return;
    preparing = true;
    updatePhotoControls();
    imageStatus.textContent = "Preparing dish photo...";
    try {
      image = await preparePhoto(chosen);
      imageCredit = undefined;
      imagePreview.src = image;
      imagePreview.hidden = false;
      showPhotoCredit();
      imageStatus.textContent = "Dish photo ready. It will be saved with this recipe.";
    } catch (error) {
      imageStatus.textContent = "Couldn't prepare the dish photo. Your current image is unchanged.";
      throw error;
    } finally { preparing = false; updatePhotoControls(); }
  }));
  const save = h("button", { type: "submit", className: "button", text: existing ? "Update this recipe \u2192" : "Save to my collection \u2192" });
  const form = h("form", { className: "recipe-form" },
    h("div", { className: "recipe-photo-options" },
      h("section", { className: "upload-box" }, h("h3", { text: "Recipe page" }),
        h("p", { className: "muted", text: "Choose an image or take a photo of the ingredients and method, or enter them manually below." }),
        recipeFile, recipePreview, extract, recipeStatus),
      h("section", { className: "upload-box" }, h("h3", { text: "Dish photo" }),
        h("p", { className: "muted", text: "Choose an image or take a photo of the finished dish. This is separate from the recipe page." }),
        imageFile, imagePreview, photoCredit, findImage, imageStatus)),
    h("p", { className: "fineprint recipe-photo-note", text: "Reading a recipe photo or finding a dish photo uses GitHub Copilot and your allowance. Images are resized locally. Only import recipes you have permission to use." }),
    warnings, field("Recipe name", title), field("A little description", description),
    h("div", { className: "form-grid" }, field("Category", category), field("Primary protein", protein), field("Diet", diet)),
    h("div", { className: "form-grid" }, field("Servings", servings), field("Prep minutes", prep), field("Cook minutes", cook)),
    field("Ingredients", ingredients, "One per line: quantity | unit | name. Optionally add | pantry. Units: g, kg, ml, l, tsp, tbsp, piece, pinch. Australian tbsp = 20 ml; tsp = 5 ml. Use singular grocery names so identical ingredients combine."),
    field("Method", steps, "One complete step per line."), field("Notes & source", notes),
    h("label", { className: "check-field" }, reviewed, h("span", { text: "I've checked the amounts, dietary labels and steps against the original." })),
    h("div", { className: "form-bottom" }, h("span", { className: "muted", text: existing ? "This updates the recipe card in your collection." : "Saved to this household's recipe file." }), save));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (extracting || preparing) return;
    run(async () => {
      const content = {
        title: title.value, description: description.value, category: category.value, protein: protein.value, diet: diet.value,
        servings: Number(servings.value), prepMinutes: Number(prep.value), cookMinutes: Number(cook.value),
        ingredients: parseIngredientLines(ingredients.value), steps: steps.value.split("\n").map((line) => line.trim()).filter(Boolean),
        notes: notes.value, image, imageCredit,
      };
      const recipe = await api(existing ? `/recipes/${encodeURIComponent(existing.id)}` : "/recipes", content, existing ? "PUT" : undefined);
      if (existing) {
        const index = state.recipes.findIndex((item) => item.id === existing.id);
        if (index >= 0) state.recipes[index] = recipe;
      } else state.recipes.push(recipe);
      modal.close();
      showRecipes();
      notify(existing ? "Recipe updated in your collection." : "A new favourite, safely in your collection.");
    }, save);
  });
  openModal(h("p", { className: "eyebrow", text: existing ? "MAKE THIS RECIPE YOUR OWN" : "MAKE ROOM FOR A NEW FAVOURITE" }),
    h("h2", { id: "modal-title", text: existing ? `Update ${existing.title}.` : "Add a little to your recipe book." }), form);
}

document.querySelector("#nav-weeks").addEventListener("click", () => run(showWeeks));
document.querySelector("#nav-recipes").addEventListener("click", () => showRecipes());
document.querySelector("#add-recipe").addEventListener("click", () => addRecipeDialog());
document.querySelector("#sign-out").addEventListener("click", (event) => run(async () => {
  await api("/auth/logout", {});
  window.location.assign("/login");
}, event.currentTarget));

let restoreSequence = 0;
async function restoreRoute() {
  const sequence = ++restoreSequence;
  const route = readRoute();
  if (modal.open) modal.close();

  if (route.view === "week") {
    await openWeek(route.week, false);
    if (sequence !== restoreSequence || state.view !== "week" || state.weekKey !== route.week) return;
    if (route.edit === "new") {
      addRecipeDialog(undefined, false);
      return;
    }
    if (route.recipe) {
      const meal = state.week?.meals.find((item) => item.recipe.id === route.recipe && (route.day === null || item.day === Number(route.day)));
      if (meal) {
        showRecipe(meal.recipe, state.week.people, state.week.week, meal.day, false);
        if (route.edit === "1") addRecipeDialog(meal.recipe, false);
        return;
      }
    }
    if (route.recipe || route.edit) writeRoute({ view: "week", week: route.week }, true);
    return;
  }

  if (route.view === "recipes") {
    showRecipes(false);
    if (route.edit === "new") {
      addRecipeDialog(undefined, false);
      return;
    }
    if (route.recipe) {
      const recipe = state.recipes.find((item) => item.id === route.recipe);
      if (recipe) {
        showRecipe(recipe, recipe.servings, undefined, undefined, false);
        if (route.edit === "1") addRecipeDialog(recipe, false);
        return;
      }
      writeRoute({ view: "recipes", q: route.q, category: route.category, protein: route.protein }, true);
    }
    return;
  }

  writeRoute({ view: "weeks" }, true);
  await showWeeks(false);
}
window.addEventListener("popstate", () => run(restoreRoute));

async function initialise() {
  const session = await api("/auth/session");
  document.querySelector("#sign-out").hidden = !session.enabled;
  state.recipes = await api("/recipes");
  await restoreRoute();
}
run(async () => {
  try { await initialise(); }
  catch (error) {
    view.replaceChildren(heading("THE KITCHEN IS TAKING A MOMENT", "Couldn't open your planner.", "Check that the server is running and your household JSON file is valid."),
      button("Try again", initialise));
    throw error;
  }
});
