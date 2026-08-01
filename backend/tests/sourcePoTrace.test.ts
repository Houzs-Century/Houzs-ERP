import { describe, expect, test } from "vitest";
import { projectReadyFifo, type ReadySourceChip } from "../src/scm/lib/source-po-trace";

// The owner's READY rule (2026-08-01): a READY line must name the PO its
// allocated stock sits in. The projection walks the SAME two deterministic
// orders the engine itself uses — claims in MRP allocation order (delivery
// date, then doc_no: the caller passes sku.lines in array order, which IS that
// order), lots in FIFO consumption order (received_at ASC, id ASC — the ORDER
// BY inside fn_consume_fifo, 0057→0230). These tests pin the pure walk so the
// projection can never silently drift from "what FIFO will actually consume".

const chips = (m: Map<string, ReadySourceChip[]>, id: string) => m.get(id) ?? [];

describe("projectReadyFifo", () => {
  test("single claim, single lot: the whole slice names that lot's PO", () => {
    const out = projectReadyFifo(
      [{ soItemId: "a", stockQty: 2 }],
      [{ qty: 5, po: "PO-1", adjustment: false }],
    );
    expect(chips(out, "a")).toEqual([{ po: "PO-1", qty: 2, kind: "po" }]);
  });

  test("a claim spanning two lots carries BOTH POs with the exact split", () => {
    const out = projectReadyFifo(
      [{ soItemId: "a", stockQty: 3 }],
      [
        { qty: 2, po: "PO-1", adjustment: false },
        { qty: 9, po: "PO-2", adjustment: false },
      ],
    );
    expect(chips(out, "a")).toEqual([
      { po: "PO-1", qty: 2, kind: "po" },
      { po: "PO-2", qty: 1, kind: "po" },
    ]);
  });

  test("earlier claims consume first — a later claim starts where they stopped", () => {
    // The GRN batch split the owner screenshotted (2 units, 1+1 across DOs) is
    // the same shape pre-ship: two claims of 1 over a 1-unit lot + a 5-unit lot.
    const out = projectReadyFifo(
      [
        { soItemId: "first", stockQty: 1 },
        { soItemId: "second", stockQty: 1 },
      ],
      [
        { qty: 1, po: "PO-A", adjustment: false },
        { qty: 5, po: "PO-B", adjustment: false },
      ],
    );
    expect(chips(out, "first")).toEqual([{ po: "PO-A", qty: 1, kind: "po" }]);
    expect(chips(out, "second")).toEqual([{ po: "PO-B", qty: 1, kind: "po" }]);
  });

  test("competing claims from OTHER SOs shift this line's lots even when only ours is wanted", () => {
    // Caller passes EVERY claim in the bucket (the allocation order includes
    // competitors); the wanted-filter happens outside the pure walk.
    const out = projectReadyFifo(
      [
        { soItemId: "competitor", stockQty: 4 },
        { soItemId: "ours", stockQty: 2 },
      ],
      [
        { qty: 4, po: "PO-OLD", adjustment: false },
        { qty: 4, po: "PO-NEW", adjustment: false },
      ],
    );
    expect(chips(out, "ours")).toEqual([{ po: "PO-NEW", qty: 2, kind: "po" }]);
  });

  test("an adjustment-sourced lot yields a STOCK ADJ chip, not a blank", () => {
    const out = projectReadyFifo(
      [{ soItemId: "a", stockQty: 2 }],
      [{ qty: 2, po: null, adjustment: true }],
    );
    expect(chips(out, "a")).toEqual([{ po: null, qty: 2, kind: "adjustment" }]);
  });

  test("an unbatchable lot (no po, not adjustment) yields NO chip — honest, never a guess", () => {
    const out = projectReadyFifo(
      [{ soItemId: "a", stockQty: 2 }],
      [{ qty: 2, po: null, adjustment: false }],
    );
    expect(out.has("a")).toBe(false);
  });

  test("mixed lots merge per PO and keep adjustment separate", () => {
    const out = projectReadyFifo(
      [{ soItemId: "a", stockQty: 6 }],
      [
        { qty: 2, po: "PO-1", adjustment: false },
        { qty: 1, po: null, adjustment: true },
        { qty: 2, po: "PO-1", adjustment: false },
        { qty: 5, po: "PO-2", adjustment: false },
      ],
    );
    expect(chips(out, "a")).toEqual([
      { po: "PO-1", qty: 4, kind: "po" },
      { po: "PO-2", qty: 1, kind: "po" },
      { po: null, qty: 1, kind: "adjustment" },
    ]);
  });

  test("stock figure exceeding the open lots (balances drift) truncates honestly", () => {
    const out = projectReadyFifo(
      [{ soItemId: "a", stockQty: 5 }],
      [{ qty: 2, po: "PO-1", adjustment: false }],
    );
    // Only the 2 covered units carry a chip; the 3-unit tail names nothing.
    expect(chips(out, "a")).toEqual([{ po: "PO-1", qty: 2, kind: "po" }]);
  });

  test("zero/negative claim quantities are skipped without consuming lots", () => {
    const out = projectReadyFifo(
      [
        { soItemId: "zero", stockQty: 0 },
        { soItemId: "real", stockQty: 1 },
      ],
      [{ qty: 1, po: "PO-1", adjustment: false }],
    );
    expect(out.has("zero")).toBe(false);
    expect(chips(out, "real")).toEqual([{ po: "PO-1", qty: 1, kind: "po" }]);
  });

  test("chips sort by PO number (numeric-aware), adjustment last", () => {
    const out = projectReadyFifo(
      [{ soItemId: "a", stockQty: 3 }],
      [
        { qty: 1, po: "PO-10", adjustment: false },
        { qty: 1, po: "PO-2", adjustment: false },
        { qty: 1, po: null, adjustment: true },
      ],
    );
    expect(chips(out, "a").map((c) => c.po)).toEqual(["PO-2", "PO-10", null]);
  });
});
