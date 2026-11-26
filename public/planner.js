import { DAYS, CATEGORIES, PROTEINS, today, addDays, mondayFor, dateLabel, weekLabel, ingredientLine, shoppingText, parseIngredientLines } from "./lib.js";

const view = document.querySelector("#view");
const modal = document.querySelector("#modal");
const modalContent = document.querySelector("#modal-content");
const closeModalButton = document.querySelector("#close-modal");
const editRecipeButton = document.querySelector("#edit-recipe");
const toast = document.querySelector("#toast");
const state = { view: "weeks", recipes: [], summaries: [], weekKey: mondayFor(today()), week: null, user: null };
const DEFAULT_RECIPE_SCOPE = "starter-and-household";
const RECIPE_SCOPES = {
  [DEFAULT_RECIPE_SCOPE]: "Starter recipes + my household",
  household: "My household only",
  "other-households": "Other households only",
  all: "All recipes",
};
const SHARE_PALETTE = { enamel: "#f4f6f5", white: "#ffffff", blue: "#1b3fa0", ink: "#131c3a", muted: "#4a5470", line: "#d3d9e4" };
let toastTimer;
let loadSequence = 0;
let shareUrl;
let stripEntered = false;
let disposeModal;

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
async function api(path, body, method, signal) {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: requestDeadline(signal),
  });
  const value = await response.json();
  signal?.throwIfAborted();
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
function requestDeadline(signal) {
  const timeout = AbortSignal.timeout(150_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function heading(title, description) {
  return h("div", { className: "page-heading" },
    h("h1", { text: title }),
    description ? h("p", { className: "lede", text: description }) : null);
}
function dinners(count) { return `${count} ${count === 1 ? "dinner" : "dinners"}`; }
function householdStorageKey(suffix) {
  const household = state.user && !state.user.isAdmin ? `household:${state.user.id}:` : "";
  return `eatplanner.app:${household}${suffix}`;
}
function canEditRecipe(recipe) {
  return recipe.source === "personal" && recipe.householdId === (state.user?.id ?? "1");
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
      " (", h("a", { href: credit.licenseUrl, target: "_blank", rel: "noreferrer", text: "Unsplash licence" }), ")"];
  }
  return ["Photo by ", creator, `, ${credit.license} `, h("a", { href: credit.licenseUrl, target: "_blank", rel: "noreferrer", text: "licence" })];
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
  clearModalWork();
  if (document.activeElement === editRecipeButton) closeModalButton.focus();
  editRecipeButton.hidden = true;
  editRecipeButton.onclick = null;
  modalContent.replaceChildren(...content.filter((item) => item !== null && item !== undefined));
  if (!modal.open) modal.showModal();
  modal.scrollTop = 0;
}
function clearModalWork() {
  disposeModal?.();
  disposeModal = undefined;
}
function readRoute() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (view === "admin") return { view };
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
      scope: Object.hasOwn(RECIPE_SCOPES, params.get("scope")) ? params.get("scope") : undefined,
    };
  }
  return { view: "weeks" };
}
function writeRoute(route, replace = false) {
  const params = new URLSearchParams();
  params.set("view", route.view);
  for (const key of ["week", "recipe", "day", "edit", "q", "category", "protein", "scope"]) {
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
  clearModalWork();
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
closeModalButton.addEventListener("click", () => {
  if (!dismissRouteModal()) modal.close();
});
modal.addEventListener("click", (event) => {
  if (event.target === modal && !dismissRouteModal()) modal.close();
});
modal.addEventListener("cancel", (event) => {
  if (dismissRouteModal()) event.preventDefault();
});
modal.addEventListener("close", () => {
  if (!modal.open) clearModalWork();
  if (shareUrl) { URL.revokeObjectURL(shareUrl); shareUrl = undefined; }
});

function setNavigation() {
  const weeks = document.querySelector("#nav-weeks");
  const recipes = document.querySelector("#nav-recipes");
  const isWeeks = state.view === "weeks" || state.view === "week";
  weeks.classList.toggle("active", isWeeks);
  recipes.classList.toggle("active", state.view === "recipes");
  weeks.setAttribute("aria-current", isWeeks ? "page" : "false");
  recipes.setAttribute("aria-current", state.view === "recipes" ? "page" : "false");
  document.querySelector("#nav-admin").setAttribute("aria-current", state.view === "admin" ? "page" : "false");
}

async function showAdmin(updateUrl = true) {
  if (updateUrl) writeRoute({ view: "admin" });
  if (modal.open) modal.close();
  const sequence = ++loadSequence;
  state.view = "admin";
  setNavigation();
  if (!state.user?.isAdmin) {
    view.replaceChildren(heading("Admin access required", "Only the super admin can manage households."),
      button("Back to your planner", () => showWeeks()));
    return;
  }
  view.replaceChildren(loadingState("Loading households..."));
  const households = await api("/admin/households");
  if (state.view !== "admin" || sequence !== loadSequence) return;
  const list = h("div", { className: "household-list" });
  for (const household of households) {
    list.append(h("div", { className: "household-row" },
      h("h3", { text: household.name }),
      h("div", { className: "action-row" },
        button("Change name", () => householdDialog(household, "name"), "button secondary small"),
        button("Reset password", () => householdDialog(household, "password"), "button secondary small"))));
  }
  view.replaceChildren(
    h("div", { className: "section-bar" }, heading("Households", "Each household has its own login, recipes and meal plans."),
      button("Add household", () => householdDialog())),
    h("p", { className: "notice", text: `Signed in as super admin: ${state.user.name}. Your own planner is unchanged. Manage this login through the server’s .env settings.` }),
    households.length ? list : h("p", { className: "admin-empty", text: "No additional households yet. Add a household and share its name and password with its members." }));
}

function householdDialog(household, mode) {
  const creating = !household;
  const title = creating ? "Add household" : mode === "name" ? "Change household name" : "Reset household password";
  const name = creating || mode === "name"
    ? h("input", { name: "name", value: household?.name ?? "", required: true, maxLength: 200, autocomplete: "off" })
    : null;
  const password = creating || mode === "password"
    ? h("input", { name: "password", type: "password", required: true, minLength: 6, maxLength: 1024, autocomplete: "new-password" })
    : null;
  const submit = h("button", { type: "submit", className: "button", text: creating ? "Add household" : mode === "name" ? "Save name" : "Reset password" });
  const form = h("form", { className: "household-form" },
    name ? field("Household name", name, "Members use this name to sign in. Names must be unique.") : null,
    password ? field(creating ? "Password" : "New password", password, "At least 6 characters. Share it only with household members.") : null,
    !creating && password ? h("p", { className: "notice", text: "Resetting the password signs out everyone in this household." }) : null,
    submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const body = {};
      if (name) body.name = name.value.trim();
      if (password) body.password = password.value;
      await api(creating ? "/admin/households" : `/admin/households/${household.id}`, body, creating ? "POST" : "PATCH");
      if (password) password.value = "";
      modal.close();
      await showAdmin(false);
      notify(creating ? "Household added." : mode === "name" ? "Household name saved." : "Household password reset.");
    }, submit);
  });
  openModal(h("h2", { id: "modal-title", text: title }),
    household ? h("p", { className: "lede", text: household.name }) : null, form);
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
  const now = today();
  const current = mondayFor(now);
  const keys = new Set(state.summaries.map((week) => week.week));
  for (let offset = -2; offset <= 4; offset++) keys.add(addDays(current, offset * 7));
  keys.delete(current);
  const datePicker = h("input", { type: "date", value: current, "aria-label": "Choose any date in a week" });
  datePicker.addEventListener("change", () => { if (datePicker.value) run(() => openWeek(mondayFor(datePicker.value))); });
  const thisWeek = state.summaries.find((week) => week.week === current);
  const strip = h("ol", { className: stripEntered ? "week-strip" : "week-strip is-entering" });
  stripEntered = true;
  DAYS.forEach((day, index) => {
    const date = addDays(current, index);
    const at = thisWeek ? thisWeek.days.indexOf(index) : -1;
    const cell = h("li", { className: ["strip-cell", at >= 0 ? "filled" : "", date === now ? "is-today" : "", date < now ? "is-past" : ""].filter(Boolean).join(" ") },
      h("div", { className: "strip-day" }, h("strong", { text: day.slice(0, 3) }), h("span", { text: dateLabel(date, { day: "numeric" }) }),
        date === now ? h("span", { className: "strip-today", text: "Today" }) : null));
    if (at >= 0) {
      const meal = button("", () => openWeek(current), "strip-meal");
      if (thisWeek.images?.[at]) meal.append(h("img", { src: thisWeek.images[at], alt: "", loading: "lazy" }));
      meal.append(h("span", { text: thisWeek.titles[at] }));
      cell.append(meal);
    } else if (thisWeek) cell.append(h("span", { className: "strip-empty", text: "Night off" }));
    strip.append(cell);
  });
  const hero = h("section", { className: "this-week" },
    h("div", { className: "this-week-head" },
      heading("This week", thisWeek
        ? `${dinners(thisWeek.count)}, ${weekLabel(current)}. ${thisWeek.status === "confirmed" ? "Locked in." : "Still a draft."}`
        : `${weekLabel(current)}. Nothing planned yet.`),
      h("div", { className: "this-week-actions" },
        thisWeek ? null : h("p", { className: "muted", text: `Pick the nights. Dinners come from your ${state.recipes.length} recipes.` }),
        button(thisWeek ? "Open this week" : "Plan this week", () => openWeek(current)))),
    strip);
  const weekRow = (key) => {
    const saved = state.summaries.find((week) => week.week === key);
    const name = key === addDays(current, 7) ? "Next week" : key === addDays(current, -7) ? "Last week" : null;
    const card = button("", () => openWeek(key), saved ? "week-card" : "week-card is-open");
    card.append(...[
      h("span", { className: "week-label", text: name ?? weekLabel(key) }),
      name ? h("span", { className: "week-date", text: weekLabel(key) }) : null,
      h("span", { className: "mini-days", "aria-hidden": "true" }, ...DAYS.map((day, index) => h("span", { className: saved?.days.includes(index) ? "filled" : "", text: day[0] }))),
      h("span", { className: "week-preview", text: saved ? `${dinners(saved.count)}: ${saved.titles.join(", ")}` : "Nothing planned" }),
      h("span", { className: "week-status" }, saved ? tag(saved.status === "confirmed" ? "Locked in" : "Draft", saved.status === "confirmed" ? "green" : "draft") : "Plan"),
    ].filter(Boolean));
    return card;
  };
  const upcoming = [...keys].filter((key) => key > current).sort();
  const earlier = [...keys].filter((key) => key < current).sort().reverse();
  view.replaceChildren(hero, h("section", { className: "weeks-section" },
    h("div", { className: "section-bar" }, h("h2", { text: "Coming up" }), field("Jump to a week", datePicker)),
    h("div", { className: "week-list" }, ...upcoming.map(weekRow)),
    h("h3", { text: "Earlier" }),
    h("div", { className: "week-list" }, ...earlier.map(weekRow))));
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
  const recipeScope = select(RECIPE_SCOPES, existing?.rules.recipeScope ?? DEFAULT_RECIPE_SCOPE);
  const weeksCount = select(Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, `${index + 1} ${index === 0 ? "week" : "weeks"}`])), 1);
  const different = h("input", { type: "checkbox", checked: existing?.rules.differentProteins ?? true });
  const overlap = h("input", { type: "checkbox", checked: existing?.rules.overlapIngredients ?? true });
  const dayList = h("div", { className: "day-picker", role: "group", "aria-label": "Days needing dinner" });
  const count = h("p", { className: "selection-count" });
  const submit = h("button", { type: "submit", className: "button", text: "Start planning" });
  function updateDays() {
    count.textContent = `${dinners(selected.size)} to plan`;
    submit.textContent = existing
      ? `Replan ${dinners(selected.size)}`
      : Number(weeksCount.value) === 1 ? `Plan ${dinners(selected.size)}` : `Plan ${weeksCount.value} weeks`;
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
  const quickPick = h("div", { className: "quick-pick" }, h("span", { text: "Quick pick" }),
    ...[3, 5, 7].map((number) => button(`${number} dinners`, () => {
      selected.clear();
      for (let i = 0; i < number; i++) selected.add(i);
      updateDays();
    }, "text-button")));
  const form = h("form", { className: "planning-form" },
    h("div", { className: "form-section" },
      h("h2", { text: "Which nights are we cooking?" }), h("p", { className: "muted", text: "Tap the days you need dinner. Leave space for leftovers and nights out." }),
      dayList, h("div", { className: "day-picker-footer" }, count, quickPick),
      existing ? null : field("Plan ahead", weeksCount, "Use these cooking nights and house rules for each week.")),
    h("div", { className: "form-section" }, h("h2", { text: "Who's eating, and how?" }),
      h("div", { className: "form-grid" }, field("Adults", adults), field("Children", children)),
      h("p", { className: "muted", text: "Plan for 1 to 12 people in total. Each adult and child counts as one serving; adjust portions to suit your household." }),
      h("div", { className: "form-grid" }, field("How we eat", diet), field("Total time per meal", time)),
      field("Recipe source", recipeScope),
      h("label", { className: "check-field" }, different, h("span", {}, h("strong", { text: "A different protein each dinner" }), h("small", { text: "No repeated primary protein in the week. Includes tofu, beans, eggs and cheese." }))),
      h("label", { className: "check-field" }, overlap, h("span", {}, h("strong", { text: "Some overlapping ingredients" }), h("small", { text: "Favour shared fresh ingredients, for a shorter shopping list and less waste." })))),
    h("div", { className: "form-bottom" }, submit));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const planning = {
        days: [...selected], people: Number(adults.value) + Number(children.value),
        adults: Number(adults.value), children: Number(children.value),
        rules: { differentProteins: different.checked, overlapIngredients: overlap.checked, maxMinutes: Number(time.value), diet: diet.value, recipeScope: recipeScope.value },
        revision: existing?.revision,
      };
      const count = existing ? 1 : Number(weeksCount.value);
      const next = count === 1
        ? await api(`/weeks/${key}/plan`, planning)
        : (await api("/weeks/plan", { ...planning, startWeek: key, count }))[0];
      if (modalContent.contains(form)) modal.close();
      if (state.view === "week" && state.weekKey === key) { state.week = next; renderWeek(); }
      notify(count === 1 ? "Draft ready. Swap anything you don't fancy." : `${count} weeks drafted. Swap anything you don't fancy.`);
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
  const actions = h("div", { className: "action-row" }, button("All weeks", () => showWeeks(), "text-button"));
  if (week) actions.append(button("Share week", shareWeek, "button secondary small"));
  const title = heading(weekLabel(state.weekKey), week ? `${dinners(week.meals.length)} for ${peopleLabel(week)}.` : "Choose the nights that need dinner, then set a few rules.");
  if (!week) {
    view.replaceChildren(actions, title, planningForm());
    return;
  }
  const statusBar = h("div", { className: `plan-status ${locked ? "locked" : ""}` },
    h("div", {}, tag(locked ? "Locked in" : "Draft", locked ? "green" : "draft"), h("span", { text: locked ? "Dinners and shopping quantities are saved for this week." : "Swap a dinner or move it to another night, then lock the week in." })),
    locked ? button("Unlock to edit", unlockWeek, "text-button") : button("Change planning rules", () => openModal(h("h2", { id: "modal-title", text: "Change planning rules" }), planningForm()), "text-button"));
  const grid = h("div", { className: "meal-grid" });
  DAYS.forEach((day, index) => {
    const meal = week.meals.find((item) => item.day === index);
    const date = addDays(week.week, index);
    const card = h("article", { className: `day-card ${meal ? "" : "day-off"} ${date === today() ? "today-card" : ""}` },
      h("div", { className: "day-card-heading" }, h("strong", { text: day }), h("span", { text: `${date === today() ? "Today, " : ""}${dateLabel(date, { day: "numeric", month: "short" })}` })));
    if (!meal) {
      card.append(h("div", { className: "off-content" }, h("h3", { text: "Night off" }), h("p", { text: "Leftovers, takeaway, or whatever happens." })));
    } else {
      const recipe = meal.recipe;
      const open = button("", () => showRecipe(recipe, week.people, week.week, index), "recipe-open");
      open.append(h("img", { src: recipe.image, alt: recipe.title, loading: "lazy", className: "meal-photo" }),
        h("div", { className: "meal-copy" }, h("div", { className: "recipe-meta" }, tag(PROTEINS[recipe.protein]), h("span", { text: `${recipe.prepMinutes + recipe.cookMinutes} min` })), h("h3", { text: recipe.title }), h("p", { text: CATEGORIES[recipe.category] }),
          meal.cooked ? h("span", { className: "tag green meal-completion", text: "Cooked" })
            : h("span", { className: "card-link", text: locked ? "Let's cook" : "Read recipe" })));
      card.append(open);
      if (!locked) {
        const move = select(Object.fromEntries(DAYS.map((name, dayIndex) => [dayIndex, `Move to ${name}`])), index);
        move.setAttribute("aria-label", `Change day for ${recipe.title}`);
        move.addEventListener("change", () => run(async () => {
          try {
            await mutateWeek("move", { from: index, to: Number(move.value) });
            notify("Dinner moved. Two dinners trade places when both nights are taken.");
          } finally {
            if (move.isConnected) move.value = String(index);
          }
        }, move));
        card.append(h("div", { className: "meal-actions" }, button("Swap", () => swapDialog(index), "text-button"), move));
      }
    }
    grid.append(card);
  });
  const bottom = locked ? shoppingPanel(week) : h("div", { className: "confirm-bar" },
    h("div", {}, h("h2", { text: "Happy with this week?" }), h("p", { text: "Lock it in to build one shopping list for all of it." })),
    button("Lock in this week", async () => {
      await mutateWeek("confirm");
      notify("Locked in. Your shopping list is ready.");
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
  if (!window.confirm("Unlock this week? Its shopping list is rebuilt when you lock it in again.")) return;
  await mutateWeek("unlock");
  notify("Unlocked. Lock the week in again after your changes.");
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
    notify("Dinner swapped.");
  };
  recipes.forEach((recipe) => {
    const choice = button("", () => replace(recipe.id), "swap-choice");
    choice.append(h("img", { src: recipe.image, alt: "", loading: "lazy" }), h("div", {}, h("strong", { text: recipe.title }), h("p", { text: `${PROTEINS[recipe.protein]}, ${recipe.prepMinutes + recipe.cookMinutes} min` })));
    list.append(choice);
  });
  openModal(h("h2", { id: "modal-title", text: `Swap ${DAYS[day]}'s dinner` }),
    h("p", { className: "muted", text: "Every option follows this week's recipe source, diet, time and protein rules." }),
    recipes.length ? button("Pick one for me", () => replace(undefined), "button secondary") : h("p", { className: "notice", text: "No other recipe fits this week's rules. Change the planning rules or add a recipe." }), list);
}

function shoppingPanel(week) {
  const include = h("input", { type: "checkbox", checked: true });
  const oliveNote = h("input", { type: "checkbox", checked: true });
  const justAdd = h("input", { type: "checkbox" });
  const text = h("textarea", { className: "shopping-text", rows: 12, readOnly: true, "aria-label": "Combined shopping list for copying" });
  const checklist = h("div", { className: "shopping-checklist" });
  const progress = h("p", { className: "shopping-progress", role: "status", "aria-live": "polite" });
  const storageKey = householdStorageKey(`checked:${week.week}:${week.revision}`);
  const legacyStorageKey = !state.user || state.user.isAdmin ? `mealplan.ai:checked:${week.week}:${week.revision}` : null;
  let checked = new Set();
  try {
    const saved = localStorage.getItem(storageKey);
    const stored = JSON.parse(saved ?? (legacyStorageKey ? localStorage.getItem(legacyStorageKey) : null) ?? "[]");
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
    h("div", { className: "section-bar" }, h("div", {}, h("h2", { text: "Shopping list" })),
      h("div", { className: "shopping-share-actions" },
        button("Copy shopping list", () => copyList(), "button"),
        button("Share shopping list", () => shareShoppingList(week, shoppingText(week.shoppingList, include.checked)), "button secondary"))),
    h("p", { className: "muted", text: `Combined and scaled for ${peopleLabel(week)}. Quantities are recipe amounts, not supermarket pack sizes. Ingredients marked Pantry go into the Woolworths list by default; untick the option below to leave them out. The item checkboxes are just shopping progress.` }),
    h("label", { className: "check-field compact" }, include, h("span", { text: "Include pantry items in Woolworths list" })),
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

async function shareShoppingList(week, ingredients) {
  const title = "Woolworths shopping list";
  const items = ingredients.split("\n").map((item) => item.trim()).filter(Boolean);
  const date = weekLabel(week.week);
  const text = `${title} — ${date}\n\n${items.length ? items.join("\n") : "No ingredients on this list."}`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot create a shopping-list share card.");
  const face = '"Bricolage Grotesque", "Avenir Next Condensed", "Arial Narrow", sans-serif';
  try { await document.fonts?.load(`600 34px ${face}`); }
  catch (error) { console.error("The share card font couldn't be loaded:", error); }
  ctx.font = `500 34px ${face}`;
  const wrappedItems = (items.length ? items : ["No ingredients on this list."]).map((item) => {
    const lines = [];
    let line = "";
    for (const word of item.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > 900 && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  });
  const rowHeight = 54;
  const height = 300 + wrappedItems.reduce((total, lines) => total + Math.max(1, lines.length) * rowHeight + 20, 0) + 100;
  canvas.width = 1080;
  canvas.height = height;
  ctx.fillStyle = SHARE_PALETTE.enamel; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = SHARE_PALETTE.blue; ctx.fillRect(0, 0, canvas.width, 250);
  ctx.fillStyle = SHARE_PALETTE.white; ctx.font = `800 62px ${face}`;
  ctx.fillText(title, 70, 112);
  ctx.font = `400 32px ${face}`; ctx.fillText(date, 70, 178);
  ctx.fillStyle = SHARE_PALETTE.line; ctx.fillRect(70, 262, 940, 3);
  ctx.font = `500 34px ${face}`;
  let y = 330;
  wrappedItems.forEach((lines, index) => {
    ctx.fillStyle = SHARE_PALETTE.blue; ctx.font = `700 28px ${face}`;
    ctx.fillText(`${index + 1}.`, 70, y);
    ctx.fillStyle = SHARE_PALETTE.ink; ctx.font = `500 34px ${face}`;
    lines.forEach((line, lineIndex) => ctx.fillText(line, 125, y + lineIndex * rowHeight));
    y += Math.max(1, lines.length) * rowHeight + 20;
    if (index < wrappedItems.length - 1) {
      ctx.fillStyle = SHARE_PALETTE.line; ctx.fillRect(125, y - 10, 885, 2);
    }
  });
  ctx.fillStyle = SHARE_PALETTE.muted; ctx.font = `400 24px ${face}`;
  ctx.fillText("eatplanner.app", 70, height - 38);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The shopping-list share card couldn't be created.");
  const file = new File([blob], `woolworths-shopping-list-${week.week}.png`, { type: "image/png" });
  if (shareUrl) URL.revokeObjectURL(shareUrl);
  shareUrl = URL.createObjectURL(blob);

  const preview = h("textarea", {
    className: "shopping-share-text", rows: Math.min(12, Math.max(4, items.length)),
    readOnly: true, value: text, "aria-label": "Shopping list text to share",
  });
  const status = h("p", { className: "muted", role: "status", "aria-live": "polite" });
  async function copyText() {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (error) { console.error("Clipboard access failed:", error); }
    }
    if (!copied) {
      preview.focus();
      preview.select();
      preview.setSelectionRange(0, text.length);
      try { copied = document.execCommand?.("copy") === true; }
      catch (error) { console.error("Clipboard fallback failed:", error); }
    }
    status.textContent = copied
      ? "Shopping list copied. Paste it into a message to share."
      : "Your browser couldn't copy automatically. The text is selected: press and hold, then tap Copy.";
  }
  const shareText = button("Share as text", async () => {
    if (!navigator.share) {
      await copyText();
      return;
    }
    try { await navigator.share({ title, text }); }
    catch (error) { if (error instanceof Error && error.name === "AbortError") return; throw error; }
  });
  const shareImage = button("Share image", async () => {
    if (!navigator.canShare?.({ files: [file] })) {
      notify("This browser can't share images. Download the PNG and send it from any app.");
      return;
    }
    try { await navigator.share({ files: [file], title }); }
    catch (error) { if (error instanceof Error && error.name === "AbortError") return; throw error; }
  });
  const download = h("a", { className: "button secondary", href: shareUrl, download: file.name, text: "Download PNG" });
  openModal(h("h2", { id: "modal-title", text: "Share shopping list" }),
    h("p", { className: "muted", text: "Share the current Woolworths ingredients as text or an image. This is a snapshot; later list changes won't be included." }),
    h("div", { className: "action-row" }, shareText, button("Copy text", copyText, "button secondary"), shareImage, download),
    status, preview,
    h("img", { className: "share-preview", src: shareUrl, alt: `Woolworths shopping list for ${date}. ${items.join(". ") || "No ingredients."}` }));
}

async function showRecipes(updateUrl = true) {
  const previous = readRoute();
  if (updateUrl) {
    writeRoute({ view: "recipes", q: previous.q, category: previous.category, protein: previous.protein, scope: previous.scope });
  }
  if (modal.open) modal.close();
  const sequence = ++loadSequence;
  state.view = "recipes";
  setNavigation();
  const route = readRoute();
  const search = h("input", { type: "search", placeholder: "Search recipes or ingredients", "aria-label": "Search recipes", value: route.q ?? "" });
  const category = select({ all: "Every category", ...CATEGORIES }, route.category ?? "all");
  category.setAttribute("aria-label", "Filter recipes by category");
  const protein = select({ all: "Every protein", ...PROTEINS }, route.protein ?? "all");
  protein.setAttribute("aria-label", "Filter recipes by protein");
  const scope = select(RECIPE_SCOPES, route.scope ?? DEFAULT_RECIPE_SCOPE);
  scope.setAttribute("aria-label", "Recipe source");
  const grid = h("div", { className: "collection-grid" });
  let compact = false;
  try { compact = localStorage.getItem("eatplanner.app:recipe-layout") === "compact"; }
  catch (error) { console.error("Recipe layout preference could not be loaded:", error); }
  const comfortableButton = button("Comfortable", () => setLayout(false), "collection-layout-option");
  const compactButton = button("Compact", () => setLayout(true), "collection-layout-option");
  comfortableButton.setAttribute("aria-pressed", "true");
  compactButton.setAttribute("aria-pressed", "false");
  function setLayout(value) {
    compact = value;
    grid.classList.toggle("is-compact", compact);
    comfortableButton.setAttribute("aria-pressed", String(!compact));
    compactButton.setAttribute("aria-pressed", String(compact));
    try { localStorage.setItem("eatplanner.app:recipe-layout", compact ? "compact" : "comfortable"); }
    catch (error) {
      console.error("Recipe layout preference could not be saved:", error);
      notify("Your layout choice couldn't be saved in this browser.", true);
    }
  }
  setLayout(compact);
  const layoutToggle = h("div", { className: "collection-layout-toggle", role: "group", "aria-label": "Recipe card layout" },
    comfortableButton, compactButton);
  const count = h("p", { className: "muted", role: "status", "aria-live": "polite" });
  let recipes = null;
  let scopeRequest = 0;
  async function loadScope() {
    const request = ++scopeRequest;
    const selected = scope.value;
    recipes = null;
    count.textContent = "";
    grid.replaceChildren(loadingState("Finding recipes..."));
    try {
      const result = selected === DEFAULT_RECIPE_SCOPE ? state.recipes : selected === "household"
        ? state.recipes.filter((recipe) => recipe.source === "personal")
        : await api(`/recipes?scope=${encodeURIComponent(selected)}`);
      if (sequence !== loadSequence || request !== scopeRequest) return;
      recipes = result;
      filter();
      return result;
    } catch (error) {
      if (sequence !== loadSequence || request !== scopeRequest) return;
      grid.replaceChildren(h("p", { className: "notice", text: "Couldn't load these recipes." }), button("Try again", loadScope, "button secondary"));
      throw error;
    }
  }
  function filter() {
    const query = search.value.toLowerCase().trim();
    const filtered = recipes.filter((recipe) => (category.value === "all" || category.value === recipe.category) &&
      (protein.value === "all" || protein.value === recipe.protein) &&
      `${recipe.title} ${recipe.description} ${recipe.ingredients.map((i) => i.name).join(" ")}`.toLowerCase().includes(query));
    count.textContent = `${filtered.length} ${filtered.length === 1 ? "recipe" : "recipes"}`;
    grid.replaceChildren(...filtered.map((recipe) => {
      const card = button("", () => showRecipe(recipe), "collection-card");
      card.append(h("div", { className: "collection-image" }, h("img", { src: recipe.image, alt: "", loading: "lazy" })),
        h("div", { className: "meal-copy" }, h("div", { className: "recipe-meta" }, h("span", { text: CATEGORIES[recipe.category] }), h("span", { text: `${recipe.prepMinutes + recipe.cookMinutes} min` })),
          h("h3", { text: recipe.title }), h("p", { text: recipe.description }),
          recipe.source === "collection" ? h("p", { className: "fineprint", text: "Starter recipe" }) :
            canEditRecipe(recipe) ? null : h("p", { className: "fineprint", text: "Shared by another household" })));
      return card;
    }));
    if (!filtered.length) grid.append(h("p", { className: "notice", text: "No recipes match. Clear the search or a filter, or add your own." }));
  }
  function saveFilters() {
    writeRoute({
      view: "recipes",
      q: search.value.trim() || undefined,
      category: category.value === "all" ? undefined : category.value,
      protein: protein.value === "all" ? undefined : protein.value,
      scope: scope.value === DEFAULT_RECIPE_SCOPE ? undefined : scope.value,
    }, true);
  }
  function updateFilters() { saveFilters(); if (recipes) filter(); }
  search.addEventListener("input", updateFilters);
  category.addEventListener("change", updateFilters);
  protein.addEventListener("change", updateFilters);
  scope.addEventListener("change", () => { saveFilters(); run(loadScope); });
  view.replaceChildren(heading("Recipes", "Browse starter recipes, your household's recipes, or recipes shared by other households."),
    h("div", { className: "collection-toolbar" }, search, scope, category, protein), layoutToggle, count, grid,
    h("p", { className: "fineprint collection-note", text: "Photos are serving suggestions and may not show the exact recipe. Check ingredient labels for allergens and follow safe food-handling guidance." }));
  return loadScope();
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
  const storageKey = weekKey === undefined ? null : householdStorageKey(`cook:${weekKey}:${day}:${recipe.id}`);
  const legacyStorageKey = weekKey === undefined || (state.user && !state.user.isAdmin) ? null : `mealplan.ai:cook:${weekKey}:${day}:${recipe.id}`;
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
  const previous = button("Previous step", () => changeStep(-1), "button secondary");
  const next = button("Next step", () => changeStep(1));
  function renderStep(focus = false) {
    stepCount.textContent = `Step ${step + 1} of ${recipe.steps.length}`;
    stepText.textContent = recipe.steps[step];
    previous.disabled = step === 0;
    next.disabled = step === recipe.steps.length - 1;
    next.textContent = step === recipe.steps.length - 1 ? "Ready to serve" : "Next step";
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
  const singleStep = h("div", { className: "single-step" }, stepCount, stepText, h("div", { className: "step-controls" }, previous, next));
  const methodToggle = h("summary", { text: "See the whole method" });
  const allSteps = h("details", { className: "all-steps", open: true }, methodToggle,
    h("ol", {}, ...recipe.steps.map((text) => h("li", { text }))));
  function renderMethod() {
    singleStep.hidden = allSteps.open;
    methodToggle.textContent = allSteps.open ? "Back to step-by-step" : "See the whole method";
  }
  allSteps.addEventListener("toggle", renderMethod);
  renderMethod();
  const credit = photoCreditParts(recipe.imageCredit);
  const scheduledMeal = weekKey !== undefined && weekKey === state.week?.week
    ? state.week.meals.find((meal) => meal.day === day && meal.recipe.id === recipe.id)
    : undefined;
  const cookedStatus = h("p", { className: "muted", role: "status", text: scheduledMeal?.cooked ? "Cooked." : "Not cooked yet." });
  const cookedButton = scheduledMeal ? button(scheduledMeal.cooked ? "Undo cooked" : "Cooked!", async () => {
    const cooked = !scheduledMeal.cooked;
    const updated = await api(`/weeks/${weekKey}/cooked`, { day, recipeId: recipe.id, cooked });
    scheduledMeal.cooked = cooked;
    if (state.weekKey === weekKey) {
      state.week = updated;
      renderWeek();
    }
    cookedButton.textContent = cooked ? "Undo cooked" : "Cooked!";
    cookedStatus.textContent = cooked ? "Cooked." : "Not cooked yet.";
  }) : null;
  openModal(h("img", { className: "recipe-hero", src: recipe.image, alt: recipe.title }),
    credit ? h("p", { className: "fineprint photo-credit" }, ...credit) : null,
    h("div", { className: "recipe-intro" }, h("p", { className: "recipe-kind", text: `${CATEGORIES[recipe.category]}, ${PROTEINS[recipe.protein].toLowerCase()}` }),
      h("h2", { id: "modal-title", text: recipe.title }), h("p", { className: "muted", text: recipe.description }),
      h("div", { className: "recipe-stats" }, h("span", {}, "Serves ", h("strong", { text: String(servings) })), h("span", {}, "Prep ", h("strong", { text: `${recipe.prepMinutes} min` })), h("span", {}, "Cook ", h("strong", { text: `${recipe.cookMinutes} min` })), h("span", { text: recipe.diet[0].toUpperCase() + recipe.diet.slice(1) })),
      cookedButton ? h("div", { className: "action-row" }, cookedButton, cookedStatus) : null,
      h("div", { className: "recipe-layout" }, h("section", {}, h("h3", { text: "What you'll need" }), ingredientList), h("section", { className: "cook-mode", "aria-label": "Cooking method" }, singleStep, allSteps)),
      recipe.notes ? h("p", { className: "notice", text: recipe.notes }) : null,
      h("p", { className: "fineprint", text: "Check allergies and ingredient labels yourself. Times are a guide; make sure food is cooked safely. Photos are serving suggestions." })));
  if (canEditRecipe(recipe)) {
    editRecipeButton.onclick = () => run(() => addRecipeDialog(recipe));
    editRecipeButton.hidden = false;
  }
}

async function shareWeek() {
  const week = state.week;
  if (!week) return;
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1480;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot create a share card.");
  const face = '"Bricolage Grotesque", "Avenir Next Condensed", "Arial Narrow", sans-serif';
  try { await document.fonts?.load(`800 84px ${face}`); }
  catch (error) { console.error("The share card font couldn't be loaded:", error); }
  ctx.fillStyle = SHARE_PALETTE.enamel; ctx.fillRect(0, 0, 1080, 1480);
  ctx.fillStyle = SHARE_PALETTE.blue; ctx.fillRect(0, 0, 1080, 250); ctx.fillRect(0, 262, 1080, 4);
  ctx.fillStyle = SHARE_PALETTE.white;
  ctx.font = `800 condensed 88px ${face}`; ctx.fillText("Dinner this week", 70, 138);
  ctx.font = `400 32px ${face}`; ctx.fillText(weekLabel(week.week), 70, 198);
  const wrap = (text, x, y, maxWidth) => {
    let line = ""; let offset = 0;
    for (const word of text.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) { ctx.fillText(line, x, y + offset); offset += 40; line = word; }
      else line = next;
    }
    ctx.fillText(line, x, y + offset);
  };
  DAYS.forEach((day, index) => {
    const y = 318 + index * 142;
    const meal = week.meals.find((item) => item.day === index);
    ctx.font = `800 condensed 46px ${face}`; ctx.fillStyle = meal ? SHARE_PALETTE.blue : SHARE_PALETTE.muted;
    ctx.fillText(day, 70, y + 52);
    ctx.font = `600 34px ${face}`; ctx.fillStyle = meal ? SHARE_PALETTE.ink : SHARE_PALETTE.muted;
    wrap(meal ? meal.recipe.title : "Night off", 330, y + 50, 680);
    ctx.strokeStyle = SHARE_PALETTE.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(70, y + 116); ctx.lineTo(1010, y + 116); ctx.stroke();
  });
  ctx.fillStyle = SHARE_PALETTE.ink; ctx.font = `600 28px ${face}`;
  ctx.fillText(`${dinners(week.meals.length)} for ${peopleLabel(week)}. ${week.status === "confirmed" ? "Locked in." : "Draft, not locked in yet."}`, 70, 1376);
  ctx.fillStyle = SHARE_PALETTE.muted; ctx.font = `400 24px ${face}`; ctx.fillText("eatplanner.app", 70, 1420);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The share card couldn't be created.");
  const file = new File([blob], `eatplanner-${week.week}.png`, { type: "image/png" });
  if (shareUrl) URL.revokeObjectURL(shareUrl);
  shareUrl = URL.createObjectURL(blob);
  const download = h("a", { className: "button secondary", href: shareUrl, download: file.name, text: "Download PNG" });
  const nativeShare = button("Share card", async () => {
    if (!navigator.canShare?.({ files: [file] })) {
      notify("This browser can't share files. Download the PNG and send it from any app.");
      return;
    }
    try { await navigator.share({ files: [file], title: "Our weekly meal plan" }); }
    catch (error) { if (error instanceof Error && error.name === "AbortError") return; throw error; }
  });
  openModal(h("h2", { id: "modal-title", text: "Share this week" }),
    h("p", { className: "muted", text: "Send this picture to your household. They don't need an account. It's a snapshot, so later changes won't show." }),
    h("div", { className: "action-row" }, nativeShare, download), h("img", { className: "share-preview", src: shareUrl, alt: `Meal plan for ${weekLabel(week.week)}. ${week.meals.map((meal) => `${DAYS[meal.day]}: ${meal.recipe.title}`).join(". ")}` }));
}

async function preparePhoto(file, signal) {
  const isHeic = file && (/^image\/hei[cf](?:-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name));
  if (!file || (!file.type.startsWith("image/") && !isHeic)) throw new Error("Choose an image file.");
  if (file.size > 15_000_000) throw new Error("Choose a photo smaller than 15 MB.");
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch (error) {
    signal?.throwIfAborted();
    if (!isHeic) {
      console.error(error);
      throw new Error("This photo format couldn't be opened. Try a JPEG, PNG, WebP or HEIC photo.");
    }
    const response = await fetch("/api/recipes/convert-heic", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      signal: requestDeadline(signal),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || `Photo conversion failed (${response.status}).`);
    }
    const converted = await response.blob();
    signal?.throwIfAborted();
    try { bitmap = await createImageBitmap(converted); }
    catch (conversionError) {
      signal?.throwIfAborted();
      console.error(conversionError);
      throw new Error("The converted photo couldn't be opened.");
    }
  }
  try {
    signal?.throwIfAborted();
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
  let reading;
  let preparingDish = false;
  let findingImage = false;
  const title = h("input", { required: true, maxLength: 100, placeholder: "Lemon chicken traybake", value: existing?.title ?? "" });
  const description = h("textarea", { rows: 2, required: true, maxLength: 400, placeholder: "One or two lines about the dish", value: existing?.description ?? "" });
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
  const progress = h("progress", { "aria-label": "Recipe import in progress" });
  const cancel = h("button", { type: "button", className: "button secondary", text: "Cancel reading", onClick: () => {
    reading?.abort();
    finishReading("Reading cancelled. Choose a photo to try again, or enter the recipe below.");
  } });
  const importActions = h("div", { className: "import-actions", hidden: true }, progress, cancel);
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
    const busy = Boolean(reading) || preparingDish || findingImage;
    recipeFile.disabled = Boolean(reading) || findingImage;
    imageFile.disabled = preparingDish || findingImage;
    findImage.disabled = busy;
    save.disabled = busy;
    for (const field of [title, description, category, protein, diet, servings, prep, cook, ingredients, steps, notes, reviewed]) {
      field.disabled = Boolean(reading);
    }
  }
  function finishReading(message, success = false) {
    reading = undefined;
    recipeStatus.textContent = message;
    recipeStatus.classList.toggle("is-success", success);
    if (!success) recipePreview.hidden = true;
    updatePhotoControls();
    if (document.activeElement === cancel) recipeFile.focus();
    importActions.hidden = true;
  }
  recipeFile.addEventListener("change", () => run(async () => {
    const chosen = recipeFile.files?.[0];
    if (!chosen || reading) return;
    recipeFile.value = "";
    const controller = new AbortController();
    reading = controller;
    const { signal } = controller;
    updatePhotoControls();
    recipePreview.hidden = true;
    recipeStatus.classList.remove("is-success");
    recipeStatus.textContent = "Preparing your recipe photo…";
    importActions.hidden = false;
    try {
      const prepared = await preparePhoto(chosen, signal);
      signal.throwIfAborted();
      recipePreview.src = prepared;
      recipePreview.hidden = false;
      recipeStatus.textContent = "Reading ingredients and method with Copilot. This can take up to two minutes.";
      const result = await api("/recipes/extract", { data: prepared.split(",")[1], mimeType: "image/jpeg" }, undefined, signal);
      signal.throwIfAborted();
      if (!modal.open || !form.isConnected) return;
      if (!result.recipe) throw new Error("No readable recipe was found. Try a clearer photo.");
      const recipe = result.recipe;
      title.value = recipe.title; description.value = recipe.description; category.value = recipe.category;
      protein.value = recipe.protein; diet.value = recipe.diet; servings.value = recipe.servings;
      prep.value = recipe.prepMinutes; cook.value = recipe.cookMinutes;
      ingredients.value = recipe.ingredients.map((item) => `${item.quantity ?? ""} | ${item.unit ?? ""} | ${item.name}${item.pantry ? " | pantry" : ""}`).join("\n");
      steps.value = recipe.steps.join("\n"); notes.value = recipe.notes;
      reviewed.checked = false;
      warnings.replaceChildren(h("strong", { text: "Review before saving" }),
        ...(result.warnings.length ? [h("ul", {}, ...result.warnings.map((warning) => h("li", { text: warning })))] : []),
        h("p", { text: "Compare quantities, units, dietary labels and method with your photo before saving." }));
      warnings.hidden = false;
      finishReading(`Draft ready: ${recipe.title}. Review the details below, then save to your collection.`, true);
    } catch (error) {
      if (signal.aborted || !modal.open || !form.isConnected) return;
      finishReading("Couldn't read this photo. Try another image or enter the recipe below.");
      throw error;
    }
  }));
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
  imageFile.addEventListener("change", () => run(async () => {
    const chosen = imageFile.files?.[0];
    if (!chosen) return;
    preparingDish = true;
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
    } finally { preparingDish = false; updatePhotoControls(); }
  }));
  const save = h("button", { type: "submit", className: "button", text: existing ? "Update this recipe" : "Save to my collection" });
  const form = h("form", { className: "recipe-form" },
    existing ? null : h("p", { className: "muted", text: "Other signed-in households can find recipes you add." }),
    h("div", { className: "recipe-photo-options" },
      h("section", { className: "upload-box" }, h("h3", { text: "Recipe page" }),
        h("p", { className: "muted", text: "Select a photo of the ingredients and method to start reading with Copilot, or enter them manually below." }),
        recipeFile, recipeStatus, importActions, recipePreview),
      h("section", { className: "upload-box" }, h("h3", { text: "Dish photo" }),
        h("p", { className: "muted", text: "Choose an image or take a photo of the finished dish. This is separate from the recipe page." }),
        imageFile, imagePreview, photoCredit, findImage, imageStatus)),
    h("p", { className: "fineprint recipe-photo-note", text: "Reading a recipe photo or finding a dish photo uses GitHub Copilot and your allowance. Images are resized locally. Only import recipes you have permission to use." }),
    warnings, field("Recipe name", title), field("Description", description),
    h("div", { className: "form-grid" }, field("Category", category), field("Primary protein", protein), field("Diet", diet)),
    h("div", { className: "form-grid" }, field("Servings", servings), field("Prep minutes", prep), field("Cook minutes", cook)),
    field("Ingredients", ingredients, "One per line: quantity | unit | name. Fill any blank quantity or unit before saving. Optionally add | pantry. Units: g, kg, ml, l, tsp, tbsp, piece, pinch. Australian tbsp = 20 ml; tsp = 5 ml. Use singular grocery names so identical ingredients combine."),
    field("Method", steps, "One complete step per line."), field("Notes and source", notes),
    h("label", { className: "check-field" }, reviewed, h("span", { text: "I've checked the amounts, dietary labels and steps against the original." })),
    h("div", { className: "form-bottom" }, h("span", { className: "muted", text: existing ? "This replaces the saved recipe." : "Saved to this household's recipe file." }), save));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (reading || preparingDish || findingImage) return;
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
      await showRecipes();
      notify(existing ? "Recipe updated." : "Saved to your collection.");
    }, save);
  });
  openModal(h("h2", { id: "modal-title", text: existing ? `Edit ${existing.title}` : "Add a recipe" }), form);
  disposeModal = () => reading?.abort();
}

document.querySelector("#nav-weeks").addEventListener("click", () => run(showWeeks));
document.querySelector("#nav-recipes").addEventListener("click", () => run(showRecipes));
document.querySelector("#nav-admin").addEventListener("click", () => run(showAdmin));
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

  if (route.view === "admin") {
    await showAdmin(false);
    return;
  }

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
        if (route.edit === "1" && canEditRecipe(meal.recipe)) addRecipeDialog(meal.recipe, false);
        return;
      }
    }
    if (route.recipe || route.edit) writeRoute({ view: "week", week: route.week }, true);
    return;
  }

  if (route.view === "recipes") {
    const recipes = await showRecipes(false);
    if (!recipes || sequence !== restoreSequence || state.view !== "recipes") return;
    if (route.edit === "new") {
      addRecipeDialog(undefined, false);
      return;
    }
    if (route.recipe) {
      const recipe = recipes.find((item) => item.id === route.recipe);
      if (recipe) {
        showRecipe(recipe, recipe.servings, undefined, undefined, false);
        if (route.edit === "1" && canEditRecipe(recipe)) addRecipeDialog(recipe, false);
        return;
      }
      writeRoute({ ...route, recipe: undefined, edit: undefined }, true);
    }
    return;
  }

  writeRoute({ view: "weeks" }, true);
  await showWeeks(false);
}
window.addEventListener("popstate", () => run(restoreRoute));

async function initialise() {
  const session = await api("/auth/session");
  state.user = session.user ?? null;
  document.querySelector("#sign-out").hidden = !session.enabled;
  document.querySelector("#nav-admin").hidden = !state.user?.isAdmin;
  state.recipes = await api("/recipes");
  await restoreRoute();
}
run(async () => {
  try { await initialise(); }
  catch (error) {
    view.replaceChildren(heading("Couldn't open your planner.", "Check that the server is running and your household JSON file is valid."),
      button("Try again", initialise));
    throw error;
  }
});
