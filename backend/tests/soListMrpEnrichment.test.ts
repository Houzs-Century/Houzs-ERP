import { describe, expect, test } from "vitest";
import {
  unionSoLineChips,
  type BucketTrace,
  type ReadySourceChip,
} from "../src/scm/lib/source-po-trace";
import {
  readinessLinesByDoc,
} from "../src/scm/lib/so-line-effective-stock";
import { attachLineCategories } from "../src/scm/lib/so-readiness-category";
import { summariseReadiness } from "../src/scm/lib/so-readiness";
import { derivePlanningState } from "../src/scm/routes/delivery-planning";
import {
  assembleSoListMrpEnrichment,
  SO_LIST_MRP_ENRICHMENT_KEYS,
  type EnrichmentItem,
  type EnrichmentHeader,
} from "../src/scm/lib/so-list-mrp-enrichment";

const bt = (pos: string[], adjQty = 0): BucketTrace => ({ pos, adjQty });

/* The list now computes the SHIPPED arm inline and the READY arm in the
   deferred endpoint. The client re-merges them. This is the exact merge
   applySoListMrpEnrichment does (sorted set union of pos, OR of the adj flags) —
   pinned here so a divergence between the two surfaces' overlay and this proof
   is caught. */
const chipCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true });
function clientMerge(
  shippedOnly: { pos: string[]; adj: boolean } | undefined,
  readyOnly: { pos: string[]; adj: boolean } | undefined,
): { pos: string[]; adj: boolean } {
  const pos = [...new Set([...(shippedOnly?.pos ?? []), ...(readyOnly?.pos ?? [])])].sort(chipCompare);
  return { pos, adj: Boolean(shippedOnly?.adj) || Boolean(readyOnly?.adj) };
}

describe("SO-list source-PO union split is behaviour-preserving", () => {
  // A page with: a doc whose shipped+ready POs differ (SO-1), a doc whose only
  // chip is a fully-shipped-suppressed READY (SO-2, must stay suppressed), and a
  // doc whose READY is a stock adjustment (SO-3).
  const items = [
    { id: "l1", docNo: "SO-1" },
    { id: "l2", docNo: "SO-1" },
    { id: "l3", docNo: "SO-2" },
    { id: "l4", docNo: "SO-3" },
  ];
  const shipped = new Map<string, BucketTrace>([
    ["l1", bt(["PO-B", "PO-A"])],
  ]);
  const ready = new Map<string, ReadySourceChip[]>([
    ["l2", [{ po: "PO-C", qty: 1, kind: "po" }]],
    ["l3", [{ po: "PO-STALE", qty: 1, kind: "po" }]], // fully-shipped → suppressed
    ["l4", [{ po: null, qty: 1, kind: "adjustment" }]],
  ]);
  const fully = new Set(["l3"]);

  test("merge(shipped-only, ready-only) equals the old combined union, per doc", () => {
    const combined = unionSoLineChips(items, shipped, ready, fully); // the OLD inline path
    const shippedOnly = unionSoLineChips(items, shipped, new Map(), fully); // NEW list path
    const readyOnly = unionSoLineChips(items, new Map(), ready, fully); // NEW endpoint arm

    for (const docNo of ["SO-1", "SO-2", "SO-3"]) {
      const expected = combined.get(docNo) ?? { pos: [], adj: false };
      const merged = clientMerge(shippedOnly.get(docNo), readyOnly.get(docNo));
      expect(merged).toEqual(expected);
    }
  });

  test("the list's shipped-only chips are exactly the shipped POs (READY dropped)", () => {
    const shippedOnly = unionSoLineChips(items, shipped, new Map(), fully);
    // SO-1 shows only its shipped POs on first paint; PO-C (ready) fills later.
    expect(shippedOnly.get("SO-1")).toEqual({ pos: ["PO-A", "PO-B"], adj: false });
    // SO-2 / SO-3 have no shipped chip at all → absent until the endpoint lands.
    expect(shippedOnly.has("SO-2")).toBe(false);
    expect(shippedOnly.has("SO-3")).toBe(false);
  });

  test("the endpoint's READY arm equals the old inline READY contribution", () => {
    const readyOnly = unionSoLineChips(items, new Map(), ready, fully);
    expect(readyOnly.get("SO-1")).toEqual({ pos: ["PO-C"], adj: false });
    expect(readyOnly.has("SO-2")).toBe(false); // fully-shipped suppression holds
    expect(readyOnly.get("SO-3")).toEqual({ pos: [], adj: true }); // stock adjustment
  });
});

describe("assembleSoListMrpEnrichment", () => {
  const items: EnrichmentItem[] = [
    { id: "l1", doc_no: "SO-1", item_group: "MATTRESS", item_code: "M1", stock_status: "PENDING", cancelled: false },
  ];
  const categoryByCode = new Map<string, string>([["M1", "MATTRESS"]]);
  const readyByItem = new Map<string, ReadySourceChip[]>([
    ["l1", [{ po: "PO-9", qty: 1, kind: "po" }]],
  ]);
  const headers = new Map<string, EnrichmentHeader>([
    ["SO-1", { status: "CONFIRMED", storedOverride: null, effectiveDD: "2099-01-01" }],
  ]);
  /* SO-1 is PROCESSED and its mattress line is pooled — the gates are open, so
     these cases exercise the promotion arm exactly as before 2026-08-30. */
  const processedDocs = new Set(["SO-1"]);
  const base = {
    docNos: ["SO-1"],
    items,
    categoryByCode,
    readyByItem,
    fullyShippedItemIds: new Set<string>(),
    headers,
    delivered: new Map<string, number>(),
    remaining: new Map<string, number>([["SO-1", 1]]),
    today: "2026-08-18",
    processedDocs,
  };

  // Independent expected readiness for a coverage, via the SAME shared helpers
  // the list uses — proves the assembler delegates faithfully rather than
  // re-implementing.
  function expectedReadiness(coverage: Map<string, { source: string }> | null) {
    const lines = readinessLinesByDoc(items, coverage, processedDocs);
    attachLineCategories(lines.values(), categoryByCode);
    return summariseReadiness(lines.get("SO-1")!);
  }

  test("live 'stock' coverage flips a stored-PENDING line to ready (the 2026-08-17 union)", () => {
    const coverage = new Map([["l1", { source: "stock" }]]);
    const exp = expectedReadiness(coverage);
    const out = assembleSoListMrpEnrichment({ ...base, coverage }).get("SO-1")!;

    expect(out.stockRemark).toBe(exp.stockRemark);
    expect(out.isMainReady).toBe(exp.isMainReady);
    expect(out.isMainReady).toBe(true); // stored was PENDING; coverage healed it
    expect(out.sourcePoReady).toEqual(["PO-9"]);
    expect(out.sourcePoAdj).toBe(false);
    expect(out.planningState).toBe(
      derivePlanningState({
        storedOverride: null, status: "CONFIRMED",
        readiness: { isShipReady: exp.isShipReady },
        delivered: 0, remaining: 1, effectiveDD: "2099-01-01", today: "2026-08-18",
      }),
    );
    expect(out.planningState).toBe("PENDING_SCHEDULE"); // ready → scheduled
  });

  test("an UNPROCESSED order does not promote on live 'stock' — the allocator gated it (HC-SO-013367)", () => {
    const coverage = new Map([["l1", { source: "stock" }]]);
    const out = assembleSoListMrpEnrichment({ ...base, coverage, processedDocs: new Set<string>() }).get("SO-1")!;
    expect(out.isMainReady).toBe(false); // stored PENDING stands; no "accessories Ready" on a date-less order
  });

  test("null coverage (list first paint) keeps the stored-PENDING verdict", () => {
    const exp = expectedReadiness(null);
    const out = assembleSoListMrpEnrichment({ ...base, coverage: null }).get("SO-1")!;

    expect(out.isMainReady).toBe(exp.isMainReady);
    expect(out.isMainReady).toBe(false); // stored PENDING stands
    expect(out.planningState).not.toBe("PENDING_SCHEDULE");
    // The chip arm is independent of the readiness coverage: whatever
    // soLineReadySourcePos resolved is emitted regardless of the verdict.
    expect(out.sourcePoReady).toEqual(["PO-9"]);
  });
});

/* C16 guard (Hookka rule): the endpoint's returned shape is pinned to the same
   named key set the frontend overlay heals, so an MRP-derived field cannot be
   added to the payload here without the frontend routing it through the overlay
   (and vice-versa) — the drift fails CI instead of shipping a field that heals
   on one surface but stays stored-only on another. */
describe("assembleSoListMrpEnrichment — C16 payload key-set parity", () => {
  test("returns EXACTLY the pinned SO_LIST_MRP_ENRICHMENT_KEYS", () => {
    const out = assembleSoListMrpEnrichment({
      docNos: ["SO-1"],
      items: [{ id: "l1", doc_no: "SO-1", item_group: "MATTRESS", item_code: "M1", stock_status: "READY", cancelled: false }],
      coverage: null,
      categoryByCode: new Map<string, string>(),
      readyByItem: new Map<string, ReadySourceChip[]>(),
      fullyShippedItemIds: new Set<string>(),
      headers: new Map<string, EnrichmentHeader>([["SO-1", { status: "CONFIRMED", storedOverride: null, effectiveDD: null }]]),
      delivered: new Map<string, number>(),
      remaining: new Map<string, number>(),
      today: "2026-08-18",
      processedDocs: null,
    }).get("SO-1")!;

    expect(new Set(Object.keys(out))).toEqual(new Set<string>(SO_LIST_MRP_ENRICHMENT_KEYS));
  });
});
