import { describe, expect, test } from "vitest";
import { categoryTitle, defaultTicks, planFor, type CategoryCount } from "./boothCategories";

const counts: CategoryCount[] = [
  { category: "SOFA", to_add: 10, active: 1000, off: 0, no_price: 800 },
  { category: "ACCESSORY", to_add: 20, active: 74, off: 2, no_price: 29 },
  { category: "DIFFUSER", to_add: 0, active: 39, off: 0, no_price: 0 },
  { category: "", to_add: 3, active: 0, off: 0, no_price: 0 },
];

describe("boothCategories", () => {
  test("a fresh picker ticks the categories with items on", () => {
    expect([...defaultTicks(counts)]).toEqual(["SOFA", "ACCESSORY", "DIFFUSER"]);
  });
  test("an empty POS opens with the booth defaults that exist", () => {
    const empty = counts.map((c) => ({ ...c, active: 0 }));
    expect([...defaultTicks(empty)]).toEqual(["ACCESSORY", "DIFFUSER"]);
  });
  test("the plan adds the ticked categories, turns their off items on, and removes the POS items outside them", () => {
    expect(planFor(counts, new Set(["ACCESSORY", "DIFFUSER"]))).toEqual({ to_add: 22, kept: 113, to_remove: 1000 });
    expect(planFor(counts, new Set())).toEqual({ to_add: 0, kept: 0, to_remove: 1113 });
  });
  test("a category reads by its label; no category says so", () => {
    expect(categoryTitle("FABRIC_ACCESSORY")).toBe("Sofa Accessory");
    expect(categoryTitle("")).toBe("No category");
  });
});
