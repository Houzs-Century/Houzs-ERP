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

// ── HEADER ≡ ∪(lines) — the 2990-DO-2607-017 phantom-chip invariant ─────────
// The DO list header showed {006, 007, 011, 021} while the drill's items
// resolved {006, 007, 021}: the old byDo rollup unioned EVERY ledger row keyed
// to the DO, including buckets no physical line owns (re-pointed consumption /
// drifted variant key). unionLineTraces derives the header from the LINES, so
// an orphan bucket can never surface again.
import { unionLineTraces, unionSoLineChips, type BucketTrace } from "../src/scm/lib/source-po-trace";

const bt = (pos: string[], adjQty = 0): BucketTrace => ({ pos, adjQty });

describe("unionLineTraces — header equals the union of the lines", () => {
  test("a mixed sofa/non-sofa/service DO: header = exactly the union of its PHYSICAL lines; the orphan ledger bucket is excluded", () => {
    // Variant-less lines compute vk '' — the fixture pins every LINE bucket to
    // '' and gives the ORPHAN a drifted (quote-doubled) vk no line computes,
    // the exact shape behind DO-2607-017's phantom fourth chip.
    const byBucket = new Map<string, BucketTrace>([
      ["do-17::KETTA::", bt(["2990-PO-2606-006"])],            // sofa line (movement-batched)
      ["do-17::TRION::", bt(["2990-PO-2606-007"])],            // bedframe line (consumed lots)
      ["do-17::NTYR-PILLOW::", bt(["2990-PO-2606-021"])],      // accessories line
      ["do-17::NTYR-PILLOW::legheight=1\"\"", bt(["2990-PO-2606-011"])], // ORPHAN — no line owns this bucket
    ]);
    const out = unionLineTraces(byBucket, [
      { docKey: "do-17", bucketDoId: "do-17", itemCode: "KETTA", itemGroup: "sofa", variants: null },
      { docKey: "do-17", bucketDoId: "do-17", itemCode: "TRION", itemGroup: "bedframe", variants: null },
      { docKey: "do-17", bucketDoId: "do-17", itemCode: "NTYR-PILLOW", itemGroup: "accessories", variants: null },
      // service line — excluded even when a ledger bucket matches its code
      { docKey: "do-17", bucketDoId: "do-17", itemCode: "DELIVERY-FEE", itemGroup: "service", variants: null },
    ]);
    // Header = EXACTLY the three line-owned POs; the phantom 011 stays out.
    expect(out.get("do-17")!.pos).toEqual([
      "2990-PO-2606-006", "2990-PO-2606-007", "2990-PO-2606-021",
    ]);
  });

  test("bound-PO fallback fills ONLY lines whose ledger trace is empty (the drill's rule)", () => {
    const byBucket = new Map<string, BucketTrace>([
      ["do-1::A::", bt(["PO-1"])],
    ]);
    const out = unionLineTraces(byBucket, [
      { docKey: "do-1", bucketDoId: "do-1", itemCode: "A", itemGroup: "mattress", variants: null, fallbackPo: "PO-IGNORED" },
      { docKey: "do-1", bucketDoId: "do-1", itemCode: "B", itemGroup: "mattress", variants: null, fallbackPo: "PO-9" },
    ]);
    expect(out.get("do-1")!.pos).toEqual(["PO-1", "PO-9"]);
  });

  test("a bucket shared by two lines counts its adjustment once", () => {
    const byBucket = new Map<string, BucketTrace>([
      ["do-1::A::", bt([], 2)],
    ]);
    const out = unionLineTraces(byBucket, [
      { docKey: "do-1", bucketDoId: "do-1", itemCode: "A", itemGroup: "mattress", variants: null },
      { docKey: "do-1", bucketDoId: "do-1", itemCode: "A", itemGroup: "mattress", variants: null },
    ]);
    expect(out.get("do-1")!.adjQty).toBe(2); // not 4
  });

  test("service lines contribute nothing, even with a matching ledger bucket", () => {
    const byBucket = new Map<string, BucketTrace>([
      ["do-1::DELIVERY::", bt(["PO-5"])],
    ]);
    const out = unionLineTraces(byBucket, [
      { docKey: "do-1", bucketDoId: "do-1", itemCode: "DELIVERY", itemGroup: "service", variants: null },
    ]);
    expect(out.has("do-1")).toBe(false);
  });
});

describe("unionSoLineChips — the SO list PO No. union (defect 2026-08-02-A)", () => {
  test("unions shipped and READY chips per SO; adjustment folds to one flag", () => {
    const out = unionSoLineChips(
      [
        { id: "l1", docNo: "SO-1" },
        { id: "l2", docNo: "SO-1" },
        { id: "l3", docNo: "SO-2" },
      ],
      new Map([["l1", bt(["2990-PO-2606-021"])]]),
      new Map([
        ["l2", [{ po: "2990-PO-2606-006", qty: 1, kind: "po" as const }]],
        ["l3", [{ po: null, qty: 1, kind: "adjustment" as const }]],
      ]),
      new Set(),
    );
    expect(out.get("SO-1")).toEqual({ pos: ["2990-PO-2606-006", "2990-PO-2606-021"], adj: false });
    expect(out.get("SO-2")).toEqual({ pos: [], adj: true });
  });

  test("READY chips are suppressed for fully-shipped lines (the drill's precedence)", () => {
    const out = unionSoLineChips(
      [{ id: "l1", docNo: "SO-1" }],
      new Map([["l1", bt(["PO-A"])]]),
      new Map([["l1", [{ po: "PO-STALE", qty: 1, kind: "po" as const }]]]),
      new Set(["l1"]),
    );
    expect(out.get("SO-1")).toEqual({ pos: ["PO-A"], adj: false });
  });

  test("an SO with nothing resolved is absent (the list renders its dash)", () => {
    const out = unionSoLineChips(
      [{ id: "l1", docNo: "SO-1" }],
      new Map(),
      new Map(),
      new Set(),
    );
    expect(out.has("SO-1")).toBe(false);
  });
});
