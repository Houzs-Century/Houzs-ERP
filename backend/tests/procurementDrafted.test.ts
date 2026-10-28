import { describe, expect, test } from "vitest";
import {
  loadDraftedQtyBySoItem,
  type SbLike,
} from "../src/services/agents/procurement-learning";

/* loadDraftedQtyBySoItem is the guard against the Procurement Agent ordering the
   same thing twice.

   The setup that makes it necessary: an approved reorder lands a DRAFT PO, and a
   DRAFT PO is invisible to BOTH mechanisms that would otherwise stop a repeat.
   MRP's PO_DEAD excludes it from supply, so the shortage still reads as
   uncovered; recomputeSoPicked excludes it too, so po_qty_picked never advances.
   Both are correct in isolation -- a draft is a proposal, not a commitment -- but
   together they leave the agent unable to see its own approved work. This loader
   is the third thing that can see it, so these tests are the third thing that
   holds the fix. */

type Row = { so_item_id: string | null; qty: number | null };

/** A client whose every query resolves to one page of `rows` (or an error).
 *  Only the four builder methods the loader touches are real. */
function sbOf(rows: Row[], error: { message: string } | null = null): SbLike {
  const page = () => Promise.resolve(error ? { data: null, error } : { data: rows, error: null });
  const builder: Record<string, unknown> = {};
  for (const m of ["eq", "in", "gte", "order"]) builder[m] = () => builder;
  builder.range = page;
  return { from: () => ({ select: () => builder }) } as unknown as SbLike;
}

describe("loadDraftedQtyBySoItem", () => {
  test("sums qty per source SO line", async () => {
    const m = await loadDraftedQtyBySoItem(
      sbOf([
        { so_item_id: "A", qty: 4 },
        { so_item_id: "B", qty: 7 },
      ]),
    );
    expect(m.get("A")).toBe(4);
    expect(m.get("B")).toBe(7);
  });

  test("one SO line split across two draft PO lines counts once, in full", async () => {
    /* The mattress window rule can put one SO line's qty on two different POs.
       Reading only the first would under-count what is drafted and re-propose
       the difference. */
    const m = await loadDraftedQtyBySoItem(
      sbOf([
        { so_item_id: "A", qty: 4 },
        { so_item_id: "A", qty: 6 },
      ]),
    );
    expect(m.get("A")).toBe(10);
  });

  test("a manually-added PO line covers no SO line", async () => {
    // No so_item_id -- it converted nothing, so it can cover nothing.
    const m = await loadDraftedQtyBySoItem(
      sbOf([
        { so_item_id: null, qty: 99 },
        { so_item_id: "  ", qty: 99 },
        { so_item_id: "A", qty: 3 },
      ]),
    );
    expect(m.size).toBe(1);
    expect(m.get("A")).toBe(3);
  });

  test("non-positive and non-numeric qty are not drafted cover", async () => {
    const m = await loadDraftedQtyBySoItem(
      sbOf([
        { so_item_id: "A", qty: 0 },
        { so_item_id: "B", qty: -5 },
        { so_item_id: "C", qty: null },
      ]),
    );
    expect(m.size).toBe(0);
  });

  test("an absent SO line reads as nothing drafted", async () => {
    const m = await loadDraftedQtyBySoItem(sbOf([]));
    expect(m.get("nope") ?? 0).toBe(0);
  });

  test("THROWS on a read error -- it must never report nothing drafted", async () => {
    /* The whole point. An empty map is a real answer meaning "nothing is on a
       draft", and acting on it re-proposes everything already awaiting confirm.
       A failed read must stop the run, not double an order. If someone ever
       wraps this call in a try/catch that returns an empty map, this test is
       what says no. */
    await expect(
      loadDraftedQtyBySoItem(sbOf([], { message: "connection reset" })),
    ).rejects.toThrow(/procurement_drafted_load_failed/);
  });

  test("the thrown error carries the cause, not just a code", async () => {
    await expect(
      loadDraftedQtyBySoItem(sbOf([], { message: "connection reset" })),
    ).rejects.toThrow(/connection reset/);
  });
});
