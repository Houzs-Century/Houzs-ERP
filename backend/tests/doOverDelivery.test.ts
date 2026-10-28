import { describe, expect, test } from "vitest";
import { findOverDeliveredSoItems } from "../src/scm/lib/do-over-delivery";

/* The over-delivery guard fired at the DRAFT->shipped confirm chokepoint
   (delivery-orders-mfg.ts). It closes the hole where a DRAFT DO skips the
   create-path cap (asDraft branch) and, on Confirm, ships an SO line a second
   time. Only the pure invariant is unit-tested here; that the guard actually
   runs before the flip/deduct against a real DB is a staging check (this suite
   binds no Postgres), same honest limit as the sibling money-path suites. */
describe("findOverDeliveredSoItems", () => {
  test("qty over the line's remaining is flagged", () => {
    const linked = new Map([["so-1", 3]]);
    const remaining = new Map([["so-1", 2]]);
    expect(findOverDeliveredSoItems(linked, remaining)).toEqual(["so-1"]);
  });

  test("qty exactly at remaining is NOT flagged (boundary — full ship is legal)", () => {
    const linked = new Map([["so-1", 2]]);
    const remaining = new Map([["so-1", 2]]);
    expect(findOverDeliveredSoItems(linked, remaining)).toEqual([]);
  });

  test("qty under remaining (partial delivery) is NOT flagged", () => {
    const linked = new Map([["so-1", 1]]);
    const remaining = new Map([["so-1", 5]]);
    expect(findOverDeliveredSoItems(linked, remaining)).toEqual([]);
  });

  test("a line already fully delivered (remaining 0) flags any qty — the duplicate-DO case", () => {
    const linked = new Map([["so-1", 4]]);
    const remaining = new Map([["so-1", 0]]);
    expect(findOverDeliveredSoItems(linked, remaining)).toEqual(["so-1"]);
  });

  test("an SO item id missing from remaining is treated as 0 open and flagged", () => {
    const linked = new Map([["so-gone", 1]]);
    const remaining = new Map<string, number>();
    expect(findOverDeliveredSoItems(linked, remaining)).toEqual(["so-gone"]);
  });

  test("only the over-shipped lines are returned when a DO spans several SO lines", () => {
    const linked = new Map([["so-1", 2], ["so-2", 5], ["so-3", 1]]);
    const remaining = new Map([["so-1", 2], ["so-2", 3], ["so-3", 0]]);
    expect(findOverDeliveredSoItems(linked, remaining).sort()).toEqual(["so-2", "so-3"]);
  });

  test("no linked lines (all ad-hoc / unlinked) yields nothing — manual delivery stays uncapped", () => {
    expect(findOverDeliveredSoItems(new Map(), new Map())).toEqual([]);
  });
});
