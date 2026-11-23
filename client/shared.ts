export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const CATEGORIES = {
  quick: "Quick & easy",
  comfort: "Comfort food",
  fresh: "Fresh & colourful",
  "one-pot": "One pot wonders",
} as const;
export const PROTEINS = {
  chicken: "Chicken",
  beef: "Beef",
  pork: "Pork",
  lamb: "Lamb",
  fish: "Fish",
  tofu: "Tofu",
  legumes: "Beans & lentils",
  eggs: "Eggs",
  cheese: "Cheese",
  other: "Other / leftovers",
} as const;
export const RECIPE_SCOPES = {
  "starter-and-household": "Starter recipes + my household",
  household: "My household only",
  "other-households": "Other households only",
  all: "All recipes",
} as const;
export type RecipeScope = keyof typeof RECIPE_SCOPES;
export type Recipe = {
  id: string;
  source: "collection" | "personal";
  householdId?: string;
  title: string;
  description: string;
  category: keyof typeof CATEGORIES;
  protein: keyof typeof PROTEINS;
  diet: "omnivore" | "vegetarian" | "vegan" | "pescatarian";
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  ingredients: Ingredient[];
  steps: string[];
  notes: string;
  image: string;
  imageCredit?: ImageCredit;
};
export type Ingredient = { name: string; quantity: number; unit: string; pantry: boolean };
export type ImageCredit = { creator: string; sourceUrl: string; creatorUrl?: string; license: string; licenseUrl: string };
export type Meal = { day: number; recipe: Recipe; cooked?: boolean } | { day: number; type: "custom"; title: string };
export type ShoppingItem = Ingredient;
export type Week = {
  week: string;
  people: number;
  adults?: number;
  children?: number;
  rules: { differentProteins: boolean; overlapIngredients: boolean; maxMinutes: number; diet: string; recipeScope?: RecipeScope };
  meals: Meal[];
  status: "draft" | "confirmed";
  confirmedAt: string | null;
  revision: number;
  shoppingList: ShoppingItem[];
};
export type Summary = { week: string; status: Week["status"]; count: number; days: number[]; titles: string[]; images?: string[] };
export type User = { id: string; name: string; isAdmin: boolean };
export type AppRoute = {
  view: "weeks" | "week" | "recipes" | "admin";
  week?: string | null;
  recipe?: string | null;
  day?: string | null;
  edit?: string | null;
  q?: string | null;
  category?: string | null;
  protein?: string | null;
  scope?: string | null;
};
export type RouteParams = AppRoute;

export const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
export const addDays = (key: string, count: number) => {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
export const mondayFor = (key: string) => {
  const date = new Date(`${key}T12:00:00Z`);
  return addDays(key, -((date.getUTCDay() + 6) % 7));
};
export const dateLabel = (key: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) =>
  new Intl.DateTimeFormat("en-AU", { ...options, timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`));
export function weekLabel(key: string) {
  const end = addDays(key, 6);
  const sameMonth = key.slice(0, 7) === end.slice(0, 7);
  return `${dateLabel(key, sameMonth ? { day: "numeric" } : undefined)}–${dateLabel(end, { day: "numeric", month: "short", year: "numeric" })}`;
}
export const ingredientLine = (item: Ingredient, multiplier = 1) => {
  const amount = String(Math.round(item.quantity * multiplier * 100) / 100);
  return item.unit === "piece" ? `${amount} ${item.name}` : `${amount} ${item.unit} ${item.name}`;
};
export const shoppingText = (items: Ingredient[], includePantry = true) =>
  items.filter((item) => includePantry || !item.pantry).map((item) => ingredientLine(item)).join("\n");
export function parseIngredientLines(text: string): Ingredient[] {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Add at least one ingredient.");
  return lines.map((line, index) => {
    const [amount, unit, name, pantry, ...rest] = line.split("|").map((part) => part.trim());
    if (rest.length || !Number.isFinite(Number(amount)) || Number(amount) <= 0 ||
      !["g", "kg", "ml", "l", "tsp", "tbsp", "piece", "pinch"].includes(unit) || !name ||
      (pantry && pantry.toLowerCase() !== "pantry")) {
      throw new Error(`Ingredient line ${index + 1}: use quantity | unit | name, optionally followed by | pantry.`);
    }
    return { quantity: Number(amount), unit, name, pantry: pantry?.toLowerCase() === "pantry" };
  });
}
export async function api<T = unknown>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(150_000)]) : AbortSignal.timeout(150_000),
  });
  const parsed: unknown = await response.json();
  const value = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  if (response.status === 401 && path !== "/auth/login" && path !== "/auth/session") {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  if (!response.ok) {
    const rawDetails = value.details;
    const fieldErrors = typeof rawDetails === "object" && rawDetails !== null
      ? (rawDetails as Record<string, unknown>).fieldErrors
      : undefined;
    const detailText = typeof fieldErrors === "object" && fieldErrors !== null
      ? Object.entries(fieldErrors).map(([field, errors]) => `${field}: ${Array.isArray(errors) ? errors.join(", ") : ""}`).join("; ")
      : "";
    const errorText = typeof value.error === "string" ? value.error : `Request failed (${response.status}).`;
    throw new Error([errorText, detailText].filter(Boolean).join(" "));
  }
  return parsed as T;
}
export function readRoute(): AppRoute {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const scope = params.get("scope");
  if (view === "admin") return { view };
  if (view === "week" && /^\d{4}-\d{2}-\d{2}$/.test(params.get("week") ?? "")) {
    return { view, week: params.get("week")!, recipe: params.get("recipe"), day: params.get("day"), edit: params.get("edit") };
  }
  if (view === "recipes") return {
    view, recipe: params.get("recipe"), edit: params.get("edit"), q: params.get("q"),
    category: params.get("category"), protein: params.get("protein"),
    scope: scope && Object.hasOwn(RECIPE_SCOPES, scope) ? scope : undefined,
  };
  return { view: "weeks" as const };
}
export function writeRoute(route: RouteParams, replace = false) {
  const params = new URLSearchParams();
  params.set("view", route.view ?? "weeks");
  for (const key of ["week", "recipe", "day", "edit", "q", "category", "protein", "scope"] as const) {
    const value = route[key];
    if (value) params.set(key, value);
  }
  const url = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history[replace ? "replaceState" : "pushState"]({ plannerRoute: true }, "", url);
}
