/* The factory-return (返厂) helpers back the "{n} trips" badge, the Current
 * marker, and the next trip number that BOTH the desktop Supplier panel and the
 * mobile Stage tab render, so they live in one module and are pinned here. Two
 * are subtle: the current trip is the HIGHEST round_no (not the newest id), and
 * an archived (mistaken) trip must not be current, must not be counted, yet must
 * still consume its number so a re-add never collides. */
import { describe, expect, test } from "vitest";
import { roundCount, currentRound, nextRoundNo, roundLabel, qcResultLabel, returnNotePath, type SupplierReturn } from "./returns";

const r = (round_no: number, extra: Partial<SupplierReturn> = {}): SupplierReturn => ({
  id: round_no * 10,
  round_no,
  pickup_at: null,
  returned_at: null,
  qc_result: null,
  creditor_code: null,
  reason: null,
  note: null,
  ...extra,
});

describe("roundCount", () => {
  test("counts only non-archived trips", () => {
    expect(roundCount([])).toBe(0);
    expect(roundCount([r(1), r(2), r(3, { archived_at: "x" })])).toBe(2);
  });
});

describe("currentRound", () => {
  test("no rows -> null", () => {
    expect(currentRound([])).toBeNull();
  });
  test("picks the highest round_no regardless of array order", () => {
    expect(currentRound([r(1), r(3), r(2)])?.round_no).toBe(3);
  });
  test("ignores archived trips", () => {
    expect(currentRound([r(1), r(2, { archived_at: "x" })])?.round_no).toBe(1);
  });
});

describe("nextRoundNo", () => {
  test("empty -> 1, then +1", () => {
    expect(nextRoundNo([])).toBe(1);
    expect(nextRoundNo([r(1)])).toBe(2);
  });
  test("an archived trip still consumes its number (no reuse)", () => {
    expect(nextRoundNo([r(1), r(2, { archived_at: "x" })])).toBe(3);
  });
});

describe("labels", () => {
  test("roundLabel", () => {
    expect(roundLabel(4)).toBe("Return to Supplier #4");
  });
  test("qcResultLabel maps known + falls back", () => {
    expect(qcResultLabel("pass")).toBe("Pass");
    expect(qcResultLabel("na")).toBe("N/A");
    expect(qcResultLabel(null)).toBe("—");
  });
});

describe("returnNotePath", () => {
  test("prints ONE trip on the supplier copy (both surfaces open this)", () => {
    expect(returnNotePath(42, 7)).toBe("/api/assr-print/42?variant=supplier&round=7");
  });
});
