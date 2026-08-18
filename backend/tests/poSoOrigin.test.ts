import { describe, expect, test } from "vitest";
import { parseProvenanceNote } from "../src/scm/routes/document-flow";
import {
  buildStoredOrigins,
  buildDeliveredSoLock,
  mergeAssignments,
  effectiveStoredLinks,
  summarizeOrigins,
  type OriginAssignment,
  type SkuOrigin,
} from "../src/scm/routes/po-so-coverage";
import {
  mrpLineCoverage,
  mrpReverseCoverage,
  type MrpResult,
  type MrpSku,
  type MrpLine,
} from "../src/scm/routes/mrp";

// The owner's model (2026-07-25, refined): the PO's "Assigned SO" is the exact
// REVERSE of the SO's "Assigned PO", both off the ONE MRP engine, and it is
// FLOATING until the goods ship then STATIC once a DO locks them. Precedence per
// SKU: (a) delivered→DO-lock (static) > (b) stored raise-link origin (static) >
// (c) MRP floating coverage (floating) > (d) none → dash. These tests pin the
// pure pieces + the SO↔PO symmetry.

describe("parseProvenanceNote", () => {
  test("extracts the SO doc numbers a bulk PO records in its note", () => {
    expect(parseProvenanceNote("From SOs: SO-2606-033, SO-2606-034"))
      .toEqual(["SO-2606-033", "SO-2606-034"]);
    expect(parseProvenanceNote("From SOs: SO-2606-033,SO-2606-034"))
      .toEqual(["SO-2606-033", "SO-2606-034"]);
  });

  test("accepts the singular 'From SO:' label and de-dupes", () => {
    expect(parseProvenanceNote("From SO: SO-9")).toEqual(["SO-9"]);
    expect(parseProvenanceNote("From SOs: SO-1, SO-1, SO-2")).toEqual(["SO-1", "SO-2"]);
  });

  test("a plain note with no 'From SOs:' label, or empty input, yields nothing", () => {
    expect(parseProvenanceNote("Deliver to loading bay 3")).toEqual([]);
    expect(parseProvenanceNote("")).toEqual([]);
    expect(parseProvenanceNote(null)).toEqual([]);
    expect(parseProvenanceNote(undefined)).toEqual([]);
  });
});

describe("buildStoredOrigins (linkage B — the PO's stored raise-link origin, STATIC)", () => {
  const hdr = (doc_no: string, over: Partial<{ customer_delivery_date: string | null; amended_delivery_date: string | null }> = {}) =>
    ({ doc_no, customer_delivery_date: null, amended_delivery_date: null, ...over });

  test("(c) a PO raised from an SO returns its REAL origin SO + effective delivery date, marked STATIC", () => {
    const origins = buildStoredOrigins(
      ["BF-15"],
      [hdr("SO-2606-033", { customer_delivery_date: "2026-08-01" })],
      [{ doc_no: "SO-2606-033", item_code: "BF-15" }],
    );
    expect(origins.get("BF-15")).toEqual([
      { soDocNo: "SO-2606-033", deliveryDate: "2026-08-01", locked: true, source: "linked" },
    ]);
  });

  test("amended_delivery_date wins over customer_delivery_date (effective date)", () => {
    const origins = buildStoredOrigins(
      ["MAT-7"],
      [hdr("SO-1", { customer_delivery_date: "2026-08-01", amended_delivery_date: "2026-09-15" })],
      [{ doc_no: "SO-1", item_code: "MAT-7" }],
    );
    expect(origins.get("MAT-7")?.[0].deliveryDate).toBe("2026-09-15");
  });

  test("a genuine stock PO with no matching origin SO yields NO assignment", () => {
    expect(buildStoredOrigins(["STOCK-99"], [hdr("SO-1")], [{ doc_no: "SO-1", item_code: "BF-15" }]).size).toBe(0);
    expect(buildStoredOrigins(["BF-15"], [], []).size).toBe(0);
  });

  test("one SKU raised across two SOs lists both, earliest delivery date first", () => {
    const origins = buildStoredOrigins(
      ["BF-15"],
      [
        hdr("SO-A", { customer_delivery_date: "2026-08-10" }),
        hdr("SO-B", { customer_delivery_date: "2026-08-02" }),
      ],
      [
        { doc_no: "SO-A", item_code: "BF-15" },
        { doc_no: "SO-B", item_code: "BF-15" },
      ],
    );
    expect(origins.get("BF-15")?.map((a) => a.soDocNo)).toEqual(["SO-B", "SO-A"]);
  });

  test("null-safe on undefined inputs", () => {
    expect(buildStoredOrigins(undefined as never, undefined as never, undefined as never).size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mig 0235 — effectiveStoredLinks: the allocation-aware layer (b) links. A line
// WITH allocations reads THEM as the authoritative fine-grained answer (its own
// single so_item_id is superseded — never both, so never a double count); a
// line WITHOUT keeps the 1:1 so_item_id fast path. The owner's case: one qty-5
// MAKOTO line on 2990-PO-2606-023 covering SO-036 x1 + SO-029 x1 + 3 stock.
// ─────────────────────────────────────────────────────────────────────────────
describe("effectiveStoredLinks (allocations ∪ so_item_id, allocations win per line)", () => {
  const line = (id: string, code: string, so: string | null) =>
    ({ id, material_code: code, so_item_id: so });

  test("a line with NO allocations keeps its single so_item_id (the 1:1 fast path)", () => {
    const eff = effectiveStoredLinks([line("L1", "BF-15", "so-1")], new Map());
    expect(eff.soItemIds).toEqual(["so-1"]);
    expect(eff.linkedSkus.has("BF-15")).toBe(true);
  });

  test("the consolidated line: allocations name SEVERAL SOs — all become layer (b) links", () => {
    const allocs = new Map([
      ["L1", [{ so_item_id: "so-036" }, { so_item_id: "so-029" }, { so_item_id: null }]],
    ]);
    const eff = effectiveStoredLinks([line("L1", "MAKOTO-Q", null)], allocs);
    expect(eff.soItemIds.sort()).toEqual(["so-029", "so-036"]);
    // An allocation IS a stored link — the SKU counts as stored-linked.
    expect(eff.linkedSkus.has("MAKOTO-Q")).toBe(true);
  });

  test("where BOTH exist, allocations WIN — the line's own so_item_id is not unioned in", () => {
    const allocs = new Map([["L1", [{ so_item_id: "so-NEW" }]]]);
    const eff = effectiveStoredLinks([line("L1", "BF-15", "so-OLD")], allocs);
    expect(eff.soItemIds).toEqual(["so-NEW"]); // so-OLD superseded, not double-counted
  });

  test("an ALL-STOCK split overrules a stale single link — no links, SKU not stored-linked", () => {
    const allocs = new Map([["L1", [{ so_item_id: null }, { so_item_id: null }]]]);
    const eff = effectiveStoredLinks([line("L1", "BF-15", "so-OLD")], allocs);
    expect(eff.soItemIds).toEqual([]);
    expect(eff.linkedSkus.has("BF-15")).toBe(false);
  });

  test("mixed lines: each line resolves independently, ids de-dupe across lines", () => {
    const allocs = new Map([["L1", [{ so_item_id: "so-1" }]]]);
    const eff = effectiveStoredLinks(
      [line("L1", "BF-15", "so-ignored"), line("L2", "MAT-7", "so-1"), line("L3", "STK-9", null)],
      allocs,
    );
    expect(eff.soItemIds).toEqual(["so-1"]); // L1 via allocation + L2 via fast path, de-duped
    expect(eff.linkedSkus.has("BF-15")).toBe(true);
    expect(eff.linkedSkus.has("MAT-7")).toBe(true);
    expect(eff.linkedSkus.has("STK-9")).toBe(false);
  });

  test("null-safe on undefined input", () => {
    const eff = effectiveStoredLinks(undefined as never, new Map());
    expect(eff.soItemIds).toEqual([]);
    expect(eff.linkedSkus.size).toBe(0);
  });
});

describe("buildDeliveredSoLock (linkage C — DELIVERED goods locked to their DO's SO, STATIC)", () => {
  // A DO line counts only when its (do, code, variant) shipped from THIS PO, i.e.
  // it is in the bucket set. so_item_id → SO doc_no wins; the DO header so_doc_no
  // is the fallback for a line with no so_item_id.
  const doLine = (delivery_order_id: string, item_code: string, so_item_id: string | null) =>
    ({ delivery_order_id, item_code, so_item_id, item_group: "BEDFRAME", variants: null });

  test("a delivered PO line resolves the locked DO-linked SO (static) + that SO's date", () => {
    const bucketVk = ""; // BEDFRAME with null variants → variant key ''
    const buckets = new Set([`DO-1::BF-15::${bucketVk}`]);
    const bySku = buildDeliveredSoLock(
      buckets,
      [doLine("DO-1", "BF-15", "soitem-9")],
      new Map([["soitem-9", "SO-777"]]),
      new Map([["DO-1", "SO-FALLBACK"]]),
      new Map([["SO-777", "2026-08-20"]]),
    );
    expect(bySku.get("BF-15")).toEqual([
      { soDocNo: "SO-777", deliveryDate: "2026-08-20", locked: true, source: "delivered" },
    ]);
  });

  test("falls back to the DO header so_doc_no when a DO line has no so_item_id", () => {
    const buckets = new Set([`DO-2::BF-15::`]);
    const bySku = buildDeliveredSoLock(
      buckets,
      [doLine("DO-2", "BF-15", null)],
      new Map(),
      new Map([["DO-2", "SO-HEADER"]]),
      new Map([["SO-HEADER", "2026-09-01"]]),
    );
    expect(bySku.get("BF-15")?.[0].soDocNo).toBe("SO-HEADER");
  });

  test("a DO line NOT in this PO's shipped buckets is ignored (only THIS PO's goods lock)", () => {
    const buckets = new Set([`DO-1::BF-15::`]);
    const bySku = buildDeliveredSoLock(
      buckets,
      [doLine("DO-9", "BF-15", "soitem-x")], // different DO — not from this PO
      new Map([["soitem-x", "SO-OTHER"]]),
      new Map(),
      new Map([["SO-OTHER", "2026-08-20"]]),
    );
    expect(bySku.size).toBe(0);
  });
});

describe("mergeAssignments (precedence: delivered-DO > stored-origin > MRP-floating > none)", () => {
  const a = (soDocNo: string, locked: boolean): OriginAssignment => ({ soDocNo, deliveryDate: "2026-08-01", locked });

  test("(a) a delivered PO line shows the locked DO-linked SO — static wins over origin & floating", () => {
    const merged = mergeAssignments(
      ["BF-15"],
      new Map([["BF-15", [a("SO-DELIVERED", true)]]]),
      new Map([["BF-15", [a("SO-ORIGIN", true)]]]),
      new Map([["BF-15", [a("SO-FLOAT", false)]]]),
    );
    expect(merged).toEqual([
      // `provenance` (PR-3) rides beside the winner: always layer (b) verbatim.
      { itemCode: "BF-15", assignments: [a("SO-DELIVERED", true)], storedLink: false, provenance: [a("SO-ORIGIN", true)] },
    ]);
  });

  /* 2026-07-31 — `storedLink` is a SEPARATE axis from which layer won. 67 of the
     101 live PO lines carry no so_item_id, so a screen that renders an MRP guess
     with the same weight as a real binding is what the owner was reading when he
     believed a PO was bound to an SO that it was not. */
  test("storedLink is reported independently of the winning layer", () => {
    const linked = new Set(["BF-15"]);
    const delivered = mergeAssignments(
      ["BF-15"], new Map([["BF-15", [a("SO-DELIVERED", true)]]]), new Map(), new Map(), linked,
    );
    expect(delivered[0].storedLink).toBe(true);

    // MRP-only coverage on a SKU whose PO lines carry NO so_item_id: an
    // assignment is shown, and storedLink says there is nothing behind it.
    const guessed = mergeAssignments(
      ["BF-15"], new Map(), new Map(), new Map([["BF-15", [a("SO-FLOAT", false)]]]), new Set(),
    );
    expect(guessed[0].assignments[0].locked).toBe(false);
    expect(guessed[0].storedLink).toBe(false);
  });

  test("(b) stored origin wins over floating when not delivered", () => {
    const merged = mergeAssignments(
      ["BF-15"],
      new Map(),
      new Map([["BF-15", [a("SO-ORIGIN", true)]]]),
      new Map([["BF-15", [a("SO-FLOAT", false)]]]),
    );
    expect(merged[0].assignments[0].soDocNo).toBe("SO-ORIGIN");
    expect(merged[0].assignments[0].locked).toBe(true);
  });

  test("(c) a PO with matching MRP demand but no origin shows its FLOATING SO (not a dash)", () => {
    const merged = mergeAssignments(
      ["BF-15"],
      new Map(),
      new Map(),
      new Map([["BF-15", [a("SO-FLOAT", false)]]]),
    );
    expect(merged[0].assignments[0].soDocNo).toBe("SO-FLOAT");
    expect(merged[0].assignments[0].locked).toBe(false); // floating
  });

  test("(d) a true stock PO with no demand at any layer yields no assignment (dash)", () => {
    expect(mergeAssignments(["STOCK-99"], new Map(), new Map(), new Map())).toEqual([]);
  });

  test("null-safe on undefined inputs", () => {
    expect(mergeAssignments(undefined as never, new Map(), new Map(), new Map())).toEqual([]);
  });

  /* ── PR-3 (2026-08-07): the parallel `provenance` slot ────────────────────
     ADDITIVE only — the four tests above pin that `assignments` / `storedLink`
     did not move. These pin the new slot: ALWAYS the layer-(b) stored-origin
     rows, regardless of which layer won the precedence. */
  describe("provenance rides beside the precedence winner (PR-3, additive)", () => {
    const stored = new Map([["BF-15", [a("SO-BOUGHT", true)]]]);

    test("precedence untouched: with stored origin populated, (b) still wins over floating AND provenance mirrors it", () => {
      /* NOTE the structural fact this pins: under TODAY's precedence (a>b>c) a
         per-SKU FLOATING winner implies the stored layer was empty for that
         SKU, so `provenance` is empty with it — the floating-winner-beside-
         bought-for state becomes reachable per SKU only when PR-4 flips the
         precedence. The wire and the frontends are ready for it now; nothing
         about the winner moved in PR-3. */
      const merged = mergeAssignments(
        ["BF-15"], new Map(), stored, new Map([["BF-15", [a("SO-FLOAT", false)]]]),
      );
      expect(merged[0].assignments.map((x) => x.soDocNo)).toEqual(["SO-BOUGHT"]);
      expect(merged[0].provenance).toEqual([a("SO-BOUGHT", true)]);
    });

    test("populated when DELIVERED wins — provenance still names the stored SO", () => {
      const merged = mergeAssignments(
        ["BF-15"],
        new Map([["BF-15", [a("SO-DELIVERED", true)]]]),
        stored,
        new Map([["BF-15", [a("SO-FLOAT", false)]]]),
        new Set(["BF-15"]),
      );
      expect(merged[0].assignments.map((x) => x.soDocNo)).toEqual(["SO-DELIVERED"]);
      expect(merged[0].provenance).toEqual([a("SO-BOUGHT", true)]);
      expect(merged[0].storedLink).toBe(true);
    });

    test("when STORED origin wins, provenance === assignments content (frontend dedupes to one chip)", () => {
      const merged = mergeAssignments(["BF-15"], new Map(), stored, new Map());
      expect(merged[0].assignments).toEqual(merged[0].provenance);
      expect(merged[0].provenance).toEqual([a("SO-BOUGHT", true)]);
    });

    test("EMPTY when the SKU has no stored links — an MRP-only SKU carries no bought-for chip", () => {
      const merged = mergeAssignments(
        ["BF-15"], new Map(), new Map(), new Map([["BF-15", [a("SO-FLOAT", false)]]]),
      );
      expect(merged[0].assignments[0].soDocNo).toBe("SO-FLOAT");
      expect(merged[0].provenance).toEqual([]);
    });
  });
});

/* ── summarizeOrigins (PR-3): `provenanceSos` rolls up beside `assignedSos` ──
   Parallel and additive: the existing assignedSos / sourceLinked rollup is
   untouched; provenanceSos is the distinct stored-origin SOs across SKUs. */
describe("summarizeOrigins carries provenanceSos without moving assignedSos/sourceLinked", () => {
  const a = (soDocNo: string, locked: boolean): OriginAssignment => ({ soDocNo, deliveryDate: "2026-08-01", locked });
  const origin = (itemCode: string, assignments: OriginAssignment[], provenance: OriginAssignment[], storedLink = false): SkuOrigin =>
    ({ itemCode, assignments, storedLink, provenance });

  test("dedupes stored-origin SOs across SKUs into provenanceSos", () => {
    const s = summarizeOrigins([
      origin("BF-15", [a("SO-FLOAT", false)], [a("SO-BOUGHT", true)], true),
      origin("MAT-7", [a("SO-FLOAT", false)], [a("SO-BOUGHT", true), a("SO-OTHER", true)], true),
    ]);
    expect(s.assignedSos.map((x) => x.soDocNo)).toEqual(["SO-FLOAT"]);
    expect(s.sourceLinked).toBe(true);
    expect(s.provenanceSos.map((x) => x.soDocNo)).toEqual(["SO-BOUGHT", "SO-OTHER"]);
  });

  test("empty provenanceSos when no SKU has stored origin; assignedSos unchanged", () => {
    const s = summarizeOrigins([origin("BF-15", [a("SO-FLOAT", false)], [])]);
    expect(s.assignedSos.map((x) => x.soDocNo)).toEqual(["SO-FLOAT"]);
    expect(s.provenanceSos).toEqual([]);
    expect(s.sourceLinked).toBe(false);
  });

  test("null-safe when provenance is absent on an older-shaped origin", () => {
    const s = summarizeOrigins([
      { itemCode: "BF-15", assignments: [a("SO-X", true)], storedLink: false } as SkuOrigin,
    ]);
    expect(s.provenanceSos).toEqual([]);
    expect(s.assignedSos.map((x) => x.soDocNo)).toEqual(["SO-X"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SO↔PO SYMMETRY — the owner's "一致且相互互通" requirement. mrpLineCoverage (the
// SO detail's Assigned-PO) and mrpReverseCoverage (the PO detail's floating
// Assigned-SO) are the two directions of the SAME single computeMrp allocation.
// If the SO says "covered by PO-Y", the PO must say "assigned to SO-X" — same
// allocation, same delivery date.
// ─────────────────────────────────────────────────────────────────────────────
describe("SO↔PO symmetry (mrpLineCoverage is the exact reverse of mrpReverseCoverage)", () => {
  const line = (over: Partial<MrpLine>): MrpLine => ({
    soItemId: "soitem-1",
    soDocNo: "SO-X",
    debtorName: "ACME",
    customerState: null,
    soDate: null,
    deliveryDate: "2026-08-15",
    processingDate: null,
    orderByDate: null,
    qty: 3,
    source: "po",
    poNumber: "PO-Y",
    poEta: "2026-08-10",
    shortageQty: 0,
    poSupplierId: null,
    poSupplierName: null,
    ...over,
  });
  const sku = (lines: MrpLine[]): MrpSku => ({
    warehouseId: "wh-1",
    warehouseCode: "KL",
    warehouseName: "KL Main",
    itemCode: "BF-15",
    variantKey: "",
    variantLabel: null,
    description: null,
    category: "BEDFRAME",
    qtyNeeded: 3,
    stock: 0,
    poOutstanding: 3,
    shortage: 0,
    mainSupplierCode: null,
    mainSupplierName: null,
    suppliers: [],
    lines,
  });
  const result = (skus: MrpSku[]): MrpResult => ({
    asOf: "now",
    categories: [],
    warehouses: [],
    skus,
    sofaSets: [],
    totals: { skuCount: skus.length, shortageSkuCount: 0, shortageUnits: 0, sofaSetCount: 0, sofaSetShortageCount: 0 },
  });

  test("SO says PO-Y ⇒ PO-Y says SO-X, with the SAME delivery date", () => {
    const r = result([sku([line({})])]);
    // SO side: soitem-1 is covered by PO-Y.
    const fwd = mrpLineCoverage(r);
    expect(fwd.get("soitem-1")).toEqual({ source: "po", po: "PO-Y", eta: "2026-08-10" });
    // PO side: PO-Y is assigned to SO-X (soitem-1), same delivery date.
    const rev = mrpReverseCoverage(r).get("PO-Y") ?? [];
    expect(rev).toHaveLength(1);
    expect(rev[0].soItemId).toBe("soitem-1");
    expect(rev[0].soDocNo).toBe("SO-X");
    expect(rev[0].deliveryDate).toBe("2026-08-15");
    // Symmetry, stated as one assertion: every PO-covered SO line in the forward
    // map appears under its PO in the reverse map, and vice-versa.
    const fwdPoLines = [...fwd.entries()].filter(([, v]) => v.source === "po" && v.po);
    for (const [soItemId, v] of fwdPoLines) {
      const revForPo = mrpReverseCoverage(r).get(v.po as string) ?? [];
      expect(revForPo.some((x) => x.soItemId === soItemId)).toBe(true);
    }
  });

  test("a stock-covered SO line is on NEITHER side (no PO to assign)", () => {
    const r = result([sku([line({ soItemId: "soitem-2", source: "stock", poNumber: null, poEta: null })])]);
    expect(mrpLineCoverage(r).get("soitem-2")).toEqual({ source: "stock", po: null, eta: null });
    // No PO number ⇒ nothing in the reverse map.
    expect([...mrpReverseCoverage(r).keys()]).toEqual([]);
  });
});
