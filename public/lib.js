export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const CATEGORIES = { quick: "Quick & easy", comfort: "Comfort food", fresh: "Fresh & colourful", "one-pot": "One pot wonders" };
export const PROTEINS = { chicken: "Chicken", beef: "Beef", pork: "Pork", lamb: "Lamb", fish: "Fish", tofu: "Tofu", legumes: "Beans & lentils", eggs: "Eggs", cheese: "Cheese", other: "Other / leftovers" };

export function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(key, count) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function mondayFor(key) {
  const date = new Date(`${key}T12:00:00Z`);
  return addDays(key, -((date.getUTCDay() + 6) % 7));
}

export function dateLabel(key, options = { day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("en-AU", { ...options, timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`));
}

export function weekLabel(key) {
  const end = addDays(key, 6);
  const sameMonth = key.slice(0, 7) === end.slice(0, 7);
  return `${dateLabel(key, sameMonth ? { day: "numeric" } : undefined)}\u2013${dateLabel(end, { day: "numeric", month: "short", year: "numeric" })}`;
}

export function quantity(value) {
  return String(Math.round(value * 100) / 100);
}

export function ingredientLine(item, multiplier = 1) {
  const amount = quantity(item.quantity * multiplier);
  return item.unit === "piece"
    ? `${amount} ${item.name}`
    : `${amount} ${item.unit} ${item.name}`;
}

export function shoppingText(items, includePantry = true) {
  return items.filter((item) => includePantry || !item.pantry).map((item) => ingredientLine(item)).join("\n");
}

export function parseIngredientLines(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Add at least one ingredient.");
  return lines.map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    const [amount, unit, name, pantry] = parts;
    if (parts.length < 3 || parts.length > 4 || !Number.isFinite(Number(amount)) || Number(amount) <= 0 ||
      !["g", "kg", "ml", "l", "tsp", "tbsp", "piece", "pinch"].includes(unit) || !name ||
      (pantry && pantry.toLowerCase() !== "pantry")) {
      throw new Error(`Ingredient line ${index + 1}: use quantity | unit | name, optionally followed by | pantry. Use decimal quantities, for example 0.5.`);
    }
    return { quantity: Number(amount), unit, name, pantry: pantry?.toLowerCase() === "pantry" };
  });
}
