import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The dependency-free browser module intentionally ships as JavaScript.
import { mondayFor, addDays, weekLabel, shoppingText, parseIngredientLines } from "../public/lib.js";

test("week selection keeps Sunday in the preceding Monday week, including year boundaries", () => {
  assert.equal(mondayFor("2026-11-22"), "2026-11-16");
  assert.equal(mondayFor("2027-01-03"), "2026-12-28");
  assert.equal(addDays("2026-12-28", 6), "2027-01-03");
  assert.match(weekLabel("2026-12-28"), /2027/);
});

test("copyable shopping text has one plain grocery line per ingredient and optional pantry filtering", () => {
  const items = [
    { name: "chicken thigh", quantity: 400, unit: "g", pantry: false },
    { name: "lemon", quantity: 2, unit: "piece", pantry: false },
    { name: "olive oil", quantity: 30, unit: "ml", pantry: true },
  ];
  assert.equal(shoppingText(items), "400 g chicken thigh\n2 lemon\n30 ml olive oil");
  assert.equal(shoppingText(items, false), "400 g chicken thigh\n2 lemon");
});

test("the recipe editor accepts reviewed ingredient lines and rejects ambiguous input", () => {
  assert.deepEqual(parseIngredientLines("0.5 | kg | potato\n1 | tbsp | olive oil | pantry"), [
    { quantity: 0.5, unit: "kg", name: "potato", pantry: false },
    { quantity: 1, unit: "tbsp", name: "olive oil", pantry: true },
  ]);
  for (const text of ["", "half | kg | potato", "1 | bag | rice", "1 | g | salt | sometimes", "1 | g | "]) {
    assert.throws(() => parseIngredientLines(text));
  }
});
