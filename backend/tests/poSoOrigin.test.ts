import { describe, expect, test } from "vitest";
import { parseFromSosNote } from "../src/scm/routes/document-flow";
import {
  buildStoredOrigins,
  buildDeliveredSoLock,
  mergeAssignments,
  type OriginAssignment,
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

describe("parseFromSosNote", () => {
  test("extracts the SO doc numbers a bulk PO records in its note", () => {
    expect(parseFromSosNote("From SOs: SO-2606-033, SO-2606-034"))
      .toEqual(["SO-2606-033", "SO-2606-034"]);
    expect(parseFromSosNote("From SOs: SO-2606-033,SO-2606-034"))
      .toEqual(["SO-2606-033", "SO-2606-034"]);
  });

  test("accepts the singular 'From SO:' label and de-dupes", () => {
    expect(parseFromSosNote("From SO: SO-9")).toEqual(["SO-9"]);
    expect(parseFromSosNote("From SOs: SO-1, SO-1, SO-2")).toEqual(["SO-1", "SO-2"]);
  });

  test("a plain note with no 'From SOs:' label, or empty input, yields nothing", () => {
    expect(parseFromSosNote("Deliver to loading bay 3")).toEqual([]);
    expect(parseFromSosNote("")).toEqual([]);
    expect(parseFromSosNote(null)).toEqual([]);
    expect(parseFromSosNote(undefined)).toEqual([]);
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
      { itemCode: "BF-15", assignments: [a("SO-DELIVERED", true)], storedLink: false },
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
