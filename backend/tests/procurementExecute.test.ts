import { describe, expect, test } from "vitest";
import { reorderUnits } from "../src/services/agents/procurement-execute";

/* procurement-execute was shipped with a stated gap: "no unit tests (all I/O)".
   Most of it IS I/O — but the piece the Stage-2 ceiling is measured against is
   pure, and it decides whether a reorder self-approves or waits for a human. An
   under-count here would let an oversized order through the gate silently, so it
   is exactly the part that deserves pinning. */

describe("reorderUnits — the size proxy the Stage-2 ceiling is measured against", () => {
  test("sums the pick quantities", () => {
    expect(reorderUnits({ picks: [{ soItemId: "a", qty: 10 }, { soItemId: "b", qty: 32 }] })).toBe(42);
  });

  test("reads a payload that arrived as a JSON STRING (the DB hands it back either way)", () => {
    expect(reorderUnits(JSON.stringify({ picks: [{ soItemId: "a", qty: 7 }] }))).toBe(7);
  });

  test("no picks / no payload → 0, never NaN", () => {
    expect(reorderUnits({})).toBe(0);
    expect(reorderUnits(null)).toBe(0);
    expect(reorderUnits("not json")).toBe(0);
    expect(reorderUnits({ picks: [] })).toBe(0);
  });

  test("junk quantities are IGNORED, never counted as something", () => {
    // A NaN or negative qty must not silently shrink (or inflate) the size the
    // ceiling sees — that is how an oversized reorder would slip past the gate.
    expect(reorderUnits({ picks: [{ qty: "abc" }, { qty: -5 }, { qty: 12 }] })).toBe(12);
  });

  test("a huge order stays huge — the number the ceiling compares must not saturate", () => {
    expect(reorderUnits({ picks: [{ qty: 4000 }, { qty: 1500 }] })).toBe(5500);
  });
});
