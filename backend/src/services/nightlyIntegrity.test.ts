import { describe, expect, it } from "vitest";
import { compareDocItems, comparePoReceived } from "../../scripts/lib/half-done-documents.mjs";
import {
  integrityNotice, isCutoverPoLine, isNewFinding, isNonStockCode, logLine, newLotBucketFindings,
  nightlyCutoffMs, withoutNonStock, type ClassResult, type NightlyLotRow,
} from "./nightlyIntegrity";

const NOW = Date.parse("2026-11-10T16:05:00Z");
const CUT = nightlyCutoffMs(NOW);
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe("new vs old findings", () => {
  it("the window is the last two days", () => {
    expect(CUT).toBe(NOW - 2 * 86_400_000);
    expect(isNewFinding(hoursAgo(1), CUT)).toBe(true);
    expect(isNewFinding(hoursAgo(47), CUT)).toBe(true);
    expect(isNewFinding(hoursAgo(49), CUT)).toBe(false);
    expect(isNewFinding(null, CUT)).toBe(false);
    expect(isNewFinding(new Date(NOW), CUT)).toBe(true);
  });

  it("an old half-done GRN is not counted, tonight's is", () => {
    const docs = [
      { docId: "old", docNo: "GRN-OLD", createdAt: hoursAgo(24 * 60) },
      { docId: "new", docNo: "GRN-NEW", createdAt: hoursAgo(3) },
    ];
    const lines = [
      { docId: "old", itemCode: "BED-1", itemGroup: "bedframe", qty: 2 },
      { docId: "new", itemCode: "BED-1", itemGroup: "bedframe", qty: 2 },
    ];
    const found = compareDocItems(docs, lines, []).filter((r) => isNewFinding(r.createdAt, CUT));
    expect(found.map((r) => r.docNo)).toEqual(["GRN-NEW"]);
  });

  it("a stock bucket counts only when it was born in the window", () => {
    const row = (vk: string, firstAt: string): NightlyLotRow => ({
      itemCode: "CHAIR-1", warehouse: "WH1", variantKey: vk, movementNet: 5, lotOpen: 3, lastAt: hoursAgo(1), firstAt, category: "ACCESSORY",
    });
    const out = newLotBucketFindings(2, [row("old", hoursAgo(24 * 30)), row("new", hoursAgo(5))], CUT, new Set());
    expect(out.map((r) => r.variantKey)).toEqual(["new"]);
  });
});

describe("skip rules", () => {
  const master = new Set(["DISPOSE", "TRANSPORTATION CHARGES", "STORAGE", "MISC"]);

  it("non-stock codes come from the product master's SERVICE category and the line's own service signal", () => {
    expect(isNonStockCode("DISPOSE", null, master)).toBe(true);
    expect(isNonStockCode(" STORAGE ", null, master)).toBe(true);
    expect(isNonStockCode("SVC-DELIVERY", null, new Set())).toBe(true);
    expect(isNonStockCode("ANYTHING", "service", new Set())).toBe(true);
    expect(isNonStockCode("BED-1", "bedframe", master)).toBe(false);
  });

  it("a DO whose only missing OUT is a service line is not a finding, and its movement is not an extra", () => {
    const docs = [{ docId: "d1", docNo: "DO-1", createdAt: hoursAgo(2) }];
    const lines = [
      { docId: "d1", itemCode: "BED-1", itemGroup: "bedframe", qty: 1 },
      { docId: "d1", itemCode: "TRANSPORTATION CHARGES", itemGroup: null, qty: 1 },
      { docId: "d1", itemCode: "MISC", itemGroup: "others", qty: 1 },
    ];
    const movs = [{ docId: "d1", itemCode: "BED-1", net: 1 }, { docId: "d1", itemCode: "MISC", net: 1 }];
    expect(compareDocItems(docs, lines, movs).length).toBeGreaterThan(0); // without the rule: TRANSPORTATION CHARGES missing
    const f = withoutNonStock(lines, movs, master);
    expect(compareDocItems(docs, f.lines, f.movements)).toEqual([]);
  });

  it("a real goods line with no movement is still caught", () => {
    const docs = [{ docId: "d1", docNo: "DO-1", createdAt: hoursAgo(2) }];
    const f = withoutNonStock([{ docId: "d1", itemCode: "BED-1", itemGroup: "bedframe", qty: 1 }], [], master);
    expect(compareDocItems(docs, f.lines, f.movements).map((r) => r.kind)).toEqual(["missing"]);
  });

  it("company-1 hard-bound items: spec buckets that net out are not a problem", () => {
    const rows: NightlyLotRow[] = [
      { itemCode: "SOFA-A", warehouse: "WH1", variantKey: "grey", movementNet: 2, lotOpen: 0, lastAt: hoursAgo(1), firstAt: hoursAgo(3), category: "SOFA" },
      { itemCode: "SOFA-A", warehouse: "WH1", variantKey: "", movementNet: 0, lotOpen: 2, lastAt: hoursAgo(1), firstAt: hoursAgo(3), category: "SOFA" },
    ];
    expect(newLotBucketFindings(1, rows, CUT, new Set())).toEqual([]);
    // The same two buckets in company 2 (pooled) are two findings.
    expect(newLotBucketFindings(2, rows, CUT, new Set())).toHaveLength(2);
  });

  it("company-1 hard-bound items whose total is wrong are still a finding; non-bound items keep their buckets", () => {
    const rows: NightlyLotRow[] = [
      { itemCode: "SOFA-A", warehouse: "WH1", variantKey: "grey", movementNet: 3, lotOpen: 0, lastAt: hoursAgo(1), firstAt: hoursAgo(3), category: "SOFA" },
      { itemCode: "SOFA-A", warehouse: "WH1", variantKey: "", movementNet: 0, lotOpen: 2, lastAt: hoursAgo(1), firstAt: hoursAgo(3), category: "SOFA" },
      { itemCode: "PILLOW", warehouse: "WH1", variantKey: "x", movementNet: 1, lotOpen: 0, lastAt: hoursAgo(1), firstAt: hoursAgo(3), category: "ACCESSORY" },
    ];
    const out = newLotBucketFindings(1, rows, CUT, new Set());
    expect(out.map((r) => [r.itemCode, r.variantKey, r.diff])).toEqual([["PILLOW", "x", -1], ["SOFA-A", "*", -1]]);
  });

  it("service codes never make a lot-bucket finding", () => {
    const rows: NightlyLotRow[] = [
      { itemCode: "DISPOSE", warehouse: "WH1", variantKey: "", movementNet: 1, lotOpen: 0, lastAt: hoursAgo(1), firstAt: hoursAgo(3), category: "SERVICE" },
    ];
    expect(newLotBucketFindings(2, rows, CUT, master)).toEqual([]);
  });

  it("PO lines imported at the 2026-08-28 cutover are skipped, later ones are not", () => {
    expect(isCutoverPoLine("2026-08-28T10:00:00+08:00")).toBe(true);
    expect(isCutoverPoLine("2026-08-28T23:59:59+08:00")).toBe(true);
    expect(isCutoverPoLine("2026-08-29T00:00:01+08:00")).toBe(false);
    expect(isCutoverPoLine(null)).toBe(false);
    const po = [
      { poItemId: "a", docNo: "PO-CUT", lineNo: 1, itemCode: "BED-1", receivedQty: 4, createdAt: "2026-08-28T09:00:00+08:00" },
      { poItemId: "b", docNo: "PO-NEW", lineNo: 1, itemCode: "BED-1", receivedQty: 4, createdAt: hoursAgo(5) },
    ];
    const found = comparePoReceived(po.filter((p) => !isCutoverPoLine(p.createdAt)), []);
    expect(found.map((r) => r.docNo)).toEqual(["PO-NEW"]);
  });
});

describe("notice and log", () => {
  const results: ClassResult[] = [
    { cls: "grn_in_missing", count: 0, examples: [], error: null },
    { cls: "do_out_missing", count: 10, examples: ["DO-1 BED-1", "DO-2 BED-2"], error: null },
    { cls: "double_submit", count: 0, examples: [], error: "boom" },
  ];

  it("no notice when nothing is new", () => {
    expect(integrityNotice("HOUZS", "2026-11-11", [{ cls: "grn_in_missing", count: 0, examples: [], error: null }])).toBeNull();
  });

  it("the notice names documents and counts, the log line names counts only", () => {
    const n = integrityNotice("HOUZS", "2026-11-11", results)!;
    expect(n.title).toBe("Data check 2026-11-11: 10 new problems in HOUZS");
    expect(n.body).toContain("DO shipped, stock OUT missing or wrong: 10 — DO-1 BED-1; DO-2 BED-2 (+8 more)");
    expect(logLine(1, results)).toBe("company 1: grn_in_missing=0 do_out_missing=10 double_submit=ERROR");
  });
});
