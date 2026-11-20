import { describe, expect, it } from "vitest";
import { fieldScore } from "./scan-field-accuracy";

const line = (raw: string, sku: string, qty = 1) => ({ rawText: raw, skuMatch: { code: sku }, qtyGuess: qty });
const slip = (over: Record<string, unknown> = {}) => ({
  customerName: "Tan",
  phones: ["0123456789"],
  addressLine1: "1 Jalan A",
  address: "1 Jalan A",
  bankMatch: null,
  lines: [line("bed A1", "A1"), line("pillow P2", "P2", 2)],
  ...over,
});

describe("fieldScore", () => {
  it("counts filled fields once per label and nothing blank on both sides", () => {
    // Customer name, Phone, Address (two keys, one label) + 2 lines x (code, qty).
    expect(fieldScore(slip(), slip())).toEqual({ total: 7, changed: 0 });
  });

  it("counts each changed field, header and line", () => {
    const fixed = slip({ phones: ["0198765432"], lines: [line("bed A1", "A1"), line("pillow P2", "P2", 3)] });
    expect(fieldScore(slip(), fixed)).toEqual({ total: 7, changed: 2 });
  });

  it("counts a field the AI left blank and the person filled", () => {
    expect(fieldScore(slip(), slip({ bankMatch: { code: "MBB" } }))).toEqual({ total: 8, changed: 1 });
  });

  it("counts every filled field of a missed or invented line as changed", () => {
    const added = slip({ lines: [...slip().lines as unknown[], line("sofa S3", "S3")] });
    expect(fieldScore(slip(), added)).toEqual({ total: 9, changed: 2 });
    const removed = slip({ lines: [line("bed A1", "A1")] });
    expect(fieldScore(slip(), removed)).toEqual({ total: 7, changed: 2 });
  });

  it("pairs lines by slip text, not position", () => {
    const swapped = slip({ lines: [line("pillow P2", "P2", 2), line("bed A1", "A1")] });
    expect(fieldScore(slip(), swapped)).toEqual({ total: 7, changed: 0 });
  });

  it("is null without both sides", () => {
    expect(fieldScore(null, slip())).toBeNull();
  });
});
