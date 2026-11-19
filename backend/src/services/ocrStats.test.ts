import { describe, expect, it } from "vitest";
import { buildOcrReport, changedFields, classifyScan, LINES_CHANGED, type ScanRow } from "./ocrStats";

const row = (over: Partial<ScanRow>): ScanRow => ({
  id: "j1",
  document_type: "SO",
  status: "done",
  error: null,
  review_state: null,
  doc_no: "SO-1",
  created_at: "2026-10-10T01:00:00.000Z",
  updated_at: "2026-10-10T01:00:10.000Z",
  sample_status: "ACCEPTED",
  sample_error: null,
  extracted: null,
  corrected: null,
  draft_baseline: null,
  so_missing: false,
  slip_image_key: null,
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
    // GR / PI: a document = imported, never "clean" (GR ACCEPTED means posted).
    expect(classifyScan(row({ document_type: "GR", doc_no: "GRN-1" })).outcome).toBe("imported");
    expect(classifyScan(row({ document_type: "PI", doc_no: "PI-1", sample_status: "EXTRACTED" })).outcome).toBe("imported");
  });

  it("splits a supplier scan with no document into failed, needs review, awaiting and discarded", () => {
    const supplier = (over: Partial<ScanRow>) => row({ document_type: "PI", doc_no: null, sample_status: "EXTRACTED", ...over });
    expect(classifyScan(supplier({ status: "error", error: "timed out", review_state: "discarded" }))).toEqual({ outcome: "failed", detail: "timed out" });
    expect(classifyScan(supplier({ error: "The scan could not tell which Goods Receipt this invoice is for" }))).toEqual({
      outcome: "needsReview", detail: "The scan could not tell which Goods Receipt this invoice is for",
    });
    expect(classifyScan(supplier({}))).toEqual({ outcome: "needsReview", detail: "No document was created" });
    expect(classifyScan(supplier({ review_state: "pending", error: "No matching goods receipt" })).outcome).toBe("awaiting");
    expect(classifyScan(supplier({ review_state: "discarded" })).outcome).toBe("discarded");
    expect(classifyScan(supplier({ review_state: "created", doc_no: "PI-1" })).outcome).toBe("imported");
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

describe("buildOcrReport before/after", () => {
  it("shows the draft value and the confirmed value when a baseline exists, names only without one", () => {
    const ex = slip("A1", 1, { phones: ["012-345 6789"] });
    const corrected = slip("B2", 1, { phones: ["0198765432"] });
    const base = slip("A1", 1, { phones: ["123456789"] });
    const withBase = row({ id: "a", sample_status: "CONFIRMED", extracted: ex, corrected, draft_baseline: base });
    const noBase = row({ id: "b", sample_status: "CONFIRMED", extracted: ex, corrected });
    const [a, b] = buildOcrReport("2026-10", "m", [withBase, noBase]).problems;
    expect(a.changes).toEqual([{ field: "Phone", before: "0123456789", after: "0198765432" }]);
    expect(a.detail).toBe("Phone, Product code");
    expect(b.changes).toBeNull();
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
      row({ id: "f", document_type: "PI", doc_no: null, error: "No matching goods receipt" }),
      row({ id: "g", document_type: "PI", doc_no: null, review_state: "pending" }),
    ];
    const r = buildOcrReport("2026-10", "claude-sonnet-5-5", rows);
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.docTypes.map((d) => d.documentType)).toEqual(["SO", "PI"]);
    const so = r.docTypes[0];
    expect(so).toMatchObject({ scans: 4, clean: 1, corrected: 1, failed: 1, pending: 1, accuracy: { clean: 1, reviewed: 2 } });
    expect(so.avgSec).toBeCloseTo((10 + 30 + 10) / 3);
    expect(so.p90Sec).toBe(30);
    expect(r.docTypes[1]).toMatchObject({ scans: 3, imported: 1, needsReview: 1, awaiting: 1, failed: 0, accuracy: null });
    expect(r.fieldMisses).toEqual({ reviewed: 2, fields: [{ field: "Product code", count: 1 }] });
    expect(r.problems.map((p) => [p.id, p.outcome])).toEqual([["b", "corrected"], ["c", "failed"], ["f", "needsReview"]]);
  });

  it("carries the slip photo key so the page can show the slip beside the changes", () => {
    const corrected = row({ id: "a", sample_status: "CONFIRMED", extracted: slip("A"), corrected: slip("B"), slip_image_key: "scan-slips/s1" });
    const failed = row({ id: "b", status: "error", error: "boom" });
    expect(buildOcrReport("2026-10", "m", [corrected, failed]).problems.map((p) => p.slipImageKey)).toEqual(["scan-slips/s1", null]);
  });
});
