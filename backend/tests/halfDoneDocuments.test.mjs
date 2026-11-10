// check-half-done-documents.mjs counts documents that say "done" while the
// stock / PO / bank behind them did not move. What can go silently wrong is the
// judgement: counting a service line as missing stock, missing a short IN,
// treating a deleted payment's reversal as stranded, or a double-submit
// cluster that a 10 s window should have split.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  intEnv, malaysiaHour, compareDocItems, cancelledResidue, grnLineNetReceived, comparePoReceived,
  strandedRebanks, lotBucketDiffs, duplicateClusters, summarise, hourProfile, grnCountsAsReceived,
} from "../scripts/lib/half-done-documents.mjs";

const docs = [
  { docId: "g1", docNo: "GRN-1", createdAt: "2026-10-01T02:00:00Z" },
  { docId: "g2", docNo: "GRN-2", createdAt: "2026-10-02T02:00:00Z" },
  { docId: "g3", docNo: "GRN-3", createdAt: "2026-10-03T02:00:00Z" },
];

describe("compareDocItems", () => {
  it("finds a missing movement, a short qty and an extra item, and passes a match", () => {
    const lines = [
      { docId: "g1", itemCode: "CODY-(K)", qty: 3 },
      { docId: "g2", itemCode: "A", qty: 2 },
      { docId: "g2", itemCode: "A", qty: 1 },
      { docId: "g3", itemCode: "B", qty: 4 },
    ];
    const movements = [
      { docId: "g2", itemCode: "A", net: 2 },
      { docId: "g3", itemCode: "B", net: 4 },
      { docId: "g3", itemCode: "Z", net: 1 },
    ];
    const out = compareDocItems(docs, lines, movements);
    expect(out.map((r) => [r.docNo, r.itemCode, r.expected, r.actual, r.kind])).toEqual([
      ["GRN-1", "CODY-(K)", 3, 0, "missing"],
      ["GRN-2", "A", 3, 2, "qty"],
      ["GRN-3", "Z", 0, 1, "extra"],
    ]);
  });

  it("expects nothing for service lines and zero-qty lines", () => {
    const lines = [
      { docId: "g1", itemCode: "SVC-DELIVERY", qty: 1 },
      { docId: "g1", itemCode: "FREIGHT", itemGroup: "service", qty: 1 },
      { docId: "g1", itemCode: "X", qty: 0 },
    ];
    expect(compareDocItems(docs, lines, [])).toEqual([]);
  });

  it("a movement that nets to zero for a goods line is a qty mismatch, not missing", () => {
    const out = compareDocItems(docs, [{ docId: "g1", itemCode: "A", qty: 2 }], [{ docId: "g1", itemCode: "A", net: 0 }]);
    expect(out[0].kind).toBe("qty");
  });
});

describe("cancelledResidue", () => {
  it("flags a DO whose OUT was not reversed and one reversed twice", () => {
    const out = cancelledResidue(docs, [
      { docId: "g1", itemCode: "A", net: 2 },
      { docId: "g2", itemCode: "B", net: 0 },
      { docId: "g3", itemCode: "C", net: -1 },
    ]);
    expect(out.map((r) => [r.docNo, r.kind, r.actual])).toEqual([["GRN-1", "not_reversed", 2], ["GRN-3", "over_reversed", -1]]);
  });
});

describe("PO received_qty", () => {
  it("mirrors po-net-received.ts", () => {
    const src = readFileSync(new URL("../src/scm/lib/po-net-received.ts", import.meta.url), "utf8");
    expect(src).toMatch(/Math\.max\(0, Number\(r\.qty_accepted \?\? 0\) - Math\.max\(0, reopened\)\)/);
    expect(grnLineNetReceived({ qty_accepted: 5, returned_qty: 2, returned_closed_qty: 0 })).toBe(3);
    expect(grnLineNetReceived({ qty_accepted: 5, returned_qty: 2, returned_closed_qty: 2 })).toBe(5);
    expect(grnLineNetReceived({ qty_accepted: 1, returned_qty: 4, returned_closed_qty: 0 })).toBe(0);
  });

  it("counts every GRN status except DRAFT and CANCELLED, like recomputePoReceived", () => {
    expect([..."POSTED CLOSED DRAFT CANCELLED".split(" ")].map(grnCountsAsReceived)).toEqual([true, true, false, false]);
    const po = [
      { poItemId: "p1", docNo: "PO-1", receivedQty: 5 },
      { poItemId: "p2", docNo: "PO-2", receivedQty: 0 },
      { poItemId: "p3", docNo: "PO-3", receivedQty: 2 },
    ];
    const grn = [
      { poItemId: "p1", status: "POSTED", qty_accepted: 3 },
      { poItemId: "p1", status: "CLOSED", qty_accepted: 2 },
      { poItemId: "p1", status: "DRAFT", qty_accepted: 9 },
      { poItemId: "p2", status: "POSTED", qty_accepted: 4 },
      { poItemId: "p3", status: "CANCELLED", qty_accepted: 2 },
    ];
    expect(comparePoReceived(po, grn).map((r) => [r.docNo, r.expected, r.actual, r.kind])).toEqual([
      ["PO-2", 4, 0, "under"],
      ["PO-3", 0, 2, "over"],
    ]);
  });
});

describe("strandedRebanks", () => {
  it("only an existing payment with no live entry is stranded", () => {
    const out = strandedRebanks([
      { jeNo: "JE1", paymentId: "aaaaaaaa-1", paymentExists: true, liveEntries: 0 },
      { jeNo: "JE2", paymentId: "bbbbbbbb-1", paymentExists: true, liveEntries: 1 },
      { jeNo: "JE3", paymentId: "cccccccc-1", paymentExists: false, liveEntries: 0 },
    ]);
    expect(out.map((r) => r.docNo)).toEqual(["JE1 (aaaaaaaa)"]);
  });

  it("matches the contra receipt-rebank.ts writes", () => {
    const src = readFileSync(new URL("../src/acc/receipt-rebank.ts", import.meta.url), "utf8");
    expect(src).toContain("moved from ${c.fromAccount} to ${fresh.target}");
    const rules = readFileSync(new URL("../src/acc/rules.ts", import.meta.url), "utf8");
    expect(rules).toMatch(/SOPAY: 'SOPAY_REVERSAL'/);
    expect(rules).toMatch(/SIPAY: 'SIPAY_REVERSAL'/);
  });
});

describe("lotBucketDiffs", () => {
  it("reports the CODY-(K) shape: lots 3, movements 2", () => {
    const out = lotBucketDiffs([
      { itemCode: "CODY-(K)", warehouse: "KL", variantKey: "", movementNet: 2, lotOpen: 3, lastAt: "2026-11-01T00:00:00Z" },
      { itemCode: "OK", warehouse: "KL", variantKey: "", movementNet: 1, lotOpen: 1 },
      { itemCode: "DS", warehouse: "KL", variantKey: "v", movementNet: -5, lotOpen: 0 },
    ]);
    expect(out.map((r) => [r.itemCode, r.diff, r.kind])).toEqual([
      ["DS", 5, "lots_above_movements"],
      ["CODY-(K)", 1, "lots_above_movements"],
    ]);
  });
});

describe("duplicateClusters", () => {
  const d = (docNo, fp, at) => ({ docNo, fingerprint: fp, createdAt: at, status: "POSTED" });
  it("chains documents within the window and splits beyond it", () => {
    const out = duplicateClusters([
      d("CN-1", "x", "2026-10-01T00:00:00Z"),
      d("CN-2", "x", "2026-10-01T00:00:08Z"),
      d("CN-3", "x", "2026-10-01T00:00:17Z"),
      d("CN-4", "x", "2026-10-01T00:01:00Z"),
      d("CN-5", "y", "2026-10-01T00:00:01Z"),
      d("CN-6", null, "2026-10-01T00:00:01Z"),
      d("CN-7", null, "2026-10-01T00:00:02Z"),
    ], 10);
    expect(out).toHaveLength(1);
    expect(out[0].docs.map((x) => x.docNo)).toEqual(["CN-1", "CN-2", "CN-3"]);
    expect(out[0].spanSeconds).toBe(17);
  });

  it("same fingerprint far apart is not a double-submit", () => {
    expect(duplicateClusters([d("A", "x", "2026-10-01T00:00:00Z"), d("B", "x", "2026-10-01T00:00:11Z")], 10)).toEqual([]);
  });
});

describe("summary and hours", () => {
  it("counts, dates and caps examples", () => {
    const rows = [
      { docId: "1", docNo: "A", createdAt: "2026-09-01T10:00:00Z" },
      { docId: "1", docNo: "A", createdAt: "2026-09-01T10:00:00Z" },
      { docId: "2", docNo: "B", createdAt: "2026-10-05T10:00:00Z" },
    ];
    const s = summarise(rows, 2);
    expect(s).toMatchObject({ count: 3, documents: 2, oldest: "2026-09-01", newest: "2026-10-05" });
    expect(s.examples).toHaveLength(2);
    expect(summarise([], 5)).toMatchObject({ count: 0, oldest: "-", newest: "-" });
  });

  it("buckets by Malaysia hour, each document once, with the rate against all documents", () => {
    expect(malaysiaHour("2026-10-01T17:30:00Z")).toBe(1);
    expect(malaysiaHour(null)).toBe(null);
    const all = [
      { docId: "a", createdAt: "2026-10-01T02:10:00Z" },
      { docId: "b", createdAt: "2026-10-01T02:50:00Z" },
      { docId: "c", createdAt: "2026-10-01T05:00:00Z" },
    ];
    const failed = [all[0], { ...all[0] }];
    const h = hourProfile(failed, all);
    expect(h).toHaveLength(24);
    expect(h[10]).toEqual({ hour: 10, failed: 1, all: 2, pct: 50 });
    expect(h[13]).toEqual({ hour: 13, failed: 0, all: 1, pct: 0 });
  });
});

describe("intEnv", () => {
  it("defaults, accepts and refuses", () => {
    expect(intEnv(undefined, 180, 3650)).toBe(180);
    expect(intEnv("", 30, 500)).toBe(30);
    expect(intEnv("90", 180, 3650)).toBe(90);
    expect(() => intEnv("0", 180, 3650)).toThrow();
    expect(() => intEnv("abc", 180, 3650)).toThrow();
  });
});

describe("the script", () => {
  const src = readFileSync(new URL("../scripts/check-half-done-documents.mjs", import.meta.url), "utf8");
  it("imports the public-log guard first and reads inside one READ ONLY transaction", () => {
    expect(src.split("\n").find((l) => l.startsWith("import"))).toBe('import "./lib/public-log-guard.mjs";');
    expect(src).toContain('pg.begin("read only"');
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|scm\.)/i);
  });

  it("names company_id in every FROM-clause query", () => {
    const queries = src.split("sql`").slice(1).map((q) => q.slice(0, q.indexOf("`")));
    expect(queries.length).toBeGreaterThan(10);
    for (const q of queries) if (/\bFROM\b/i.test(q)) expect(q).toMatch(/company_id/);
  });
});
