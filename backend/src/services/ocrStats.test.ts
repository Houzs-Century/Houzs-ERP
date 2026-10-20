import { describe, expect, it } from "vitest";
import { buildOcrReport, changedFields, classifyScan, LINES_CHANGED, type ScanRow } from "./ocrStats";

const row = (over: Partial<ScanRow>): ScanRow => ({
  id: "j1",
  document_type: "SO",
  status: "done",
  error: null,
  doc_no: "SO-1",
  created_at: "2026-10-10T01:00:00.000Z",
  updated_at: "2026-10-10T01:00:10.000Z",
  sample_status: "ACCEPTED",
  sample_error: null,
  extracted: null,
  corrected: null,
  so_missing: false,
  ...over,
});

const slip = (sku: string, qty = 1, extra: Record<string, unknown> = {}) => ({
  customerName: "Tan",
  phones: ["0123"],
  ...extra,
  lines: [{ skuMatch: { code: sku }, qtyGuess: qty }],
});

describe("classifyScan", () => {
  it("sorts each kind of row into its outcome", () => {
    expect(classifyScan(row({ status: "running" })).outcome).toBe("pending");
    expect(classifyScan(row({ status: "error", error: "timed out" }))).toEqual({ outcome: "failed", detail: "timed out" });
    expect(classifyScan(row({ sample_status: "FAILED", sample_error: "Anthropic 529" }))).toEqual({ outcome: "failed", detail: "Anthropic 529" });
    expect(classifyScan(row({ error: "The scan could not read this slip, so this draft is blank." })).outcome).toBe("failed");
    expect(classifyScan(row({ error: "Payment receipt saved, please check" })).outcome).toBe("clean");
    expect(classifyScan(row({ so_missing: true })).outcome).toBe("discarded");
    expect(classifyScan(row({ sample_status: "EXTRACTED" })).outcome).toBe("awaiting");
    // GR / PI: no document = failed; a document = imported, never "clean" (GR ACCEPTED means posted).
    expect(classifyScan(row({ document_type: "GR", doc_no: null, error: "Supplier not matched" }))).toEqual({ outcome: "failed", detail: "Supplier not matched" });
    expect(classifyScan(row({ document_type: "GR", doc_no: "GRN-1" })).outcome).toBe("imported");
    expect(classifyScan(row({ document_type: "PI", doc_no: "PI-1", sample_status: "EXTRACTED" })).outcome).toBe("imported");
  });

  it("names the fields the operator corrected", () => {
    const r = row({ sample_status: "CONFIRMED", extracted: slip("A1"), corrected: slip("B2", 1, { customerName: "Tan Ah Kow" }) });
    expect(classifyScan(r)).toEqual({ outcome: "corrected", detail: "Customer name, Product code" });
  });
});

describe("changedFields", () => {
  it("ignores line order and reports a line added or removed", () => {
    const two = (a: string, b: string) => ({ lines: [{ skuMatch: { code: a } }, { skuMatch: { code: b } }] });
    expect(changedFields(two("A", "B"), two("B", "A"))).toEqual([]);
    expect(changedFields(slip("A"), { ...slip("A"), lines: [...slip("A").lines, { qtyGuess: 2 }] })).toEqual([LINES_CHANGED]);
    expect(changedFields(slip("A", 1), slip("A", 2))).toEqual(["Qty"]);
    expect(changedFields(null, slip("A"))).toEqual([]);
  });
});

describe("buildOcrReport", () => {
  it("counts outcomes, accuracy, field misses and time per document type", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", sample_status: "CONFIRMED", extracted: slip("A"), corrected: slip("B"), updated_at: "2026-10-10T01:00:30.000Z" }),
      row({ id: "c", status: "error", error: "boom" }),
      row({ id: "d", status: "queued" }),
      row({ id: "e", document_type: "PI", doc_no: "PI-9" }),
    ];
    const r = buildOcrReport("2026-10", rows);
    expect(r.docTypes.map((d) => d.documentType)).toEqual(["SO", "PI"]);
    const so = r.docTypes[0];
    expect(so).toMatchObject({ scans: 4, clean: 1, corrected: 1, failed: 1, pending: 1, accuracy: { clean: 1, reviewed: 2 } });
    expect(so.avgSec).toBeCloseTo((10 + 30 + 10) / 3);
    expect(so.p90Sec).toBe(30);
    expect(r.docTypes[1]).toMatchObject({ imported: 1, accuracy: null });
    expect(r.fieldMisses).toEqual({ reviewed: 2, fields: [{ field: "Product code", count: 1 }] });
    expect(r.problems.map((p) => [p.id, p.outcome])).toEqual([["b", "corrected"], ["c", "failed"]]);
  });
});
