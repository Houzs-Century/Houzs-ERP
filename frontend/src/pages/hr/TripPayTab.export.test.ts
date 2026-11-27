/* Trip Pay export writes money in RINGGIT, not sen (owner 2026-11-27: 价格格式不对).
 *
 * Symptom: the Excel showed a delivery order's Local Total as 557,900.00 while the
 *   page showed RM 5,579.00 — every money column was 100x too big.
 * Cause: the money columns exported their raw sen `getValue` with no `exportValue`
 *   and no `exportFormat`, so sen reached the sheet unscaled.
 * Fix: each money column exports `moneyRm` (sen/100, blank for zero) as a
 *   `exportFormat: "money"` cell; this test guards the whole column set so a
 *   future column can't silently ship sen again. */
import { describe, expect, it } from "vitest";
import { buildLineExportMatrix } from "../../components/dataTableLineExport";
import { peopleCols, buildRowCols } from "./TripPayTab";
import type { TripPersonPay, TripRowOut } from "./hrApi";

const rowCols = buildRowCols({ canEdit: false, busy: false, setJobType: () => {}, setEditing: () => {}, remove: () => {} });

const cellOf = (matrix: ReturnType<typeof buildLineExportMatrix>, label: string, rowIdx = 0) => {
  const c = matrix.header.indexOf(label);
  expect(c, `column "${label}" present`).toBeGreaterThanOrEqual(0);
  return { value: matrix.body[rowIdx]![c], format: matrix.formats[c] };
};

const tripRow = (over: Partial<TripRowOut> = {}): TripRowOut => ({
  id: 1,
  source: "PLANNING",
  tripDate: "2026-11-02",
  docNo: "HC-SO-2609-187",
  transferTo: "",
  refNo: "",
  kind: "DO",
  jobType: "DELIVERY_ORDER",
  eventType: null,
  localTotalSen: 557_900,
  state: "Johor",
  postcode: "81100",
  lorryPlate: "VRH9058",
  hrEdited: false,
  sourceMissing: false,
  pay: { tripOfDay: null, sameJob: false, allowanceSen: 0, outstationSen: 24_000, overnightSen: 1_050 },
  driver1: { name: "UMAR", employeeId: 1 },
  driver2: { name: "", employeeId: null },
  helper1: { name: "SOWKAT", employeeId: 2 },
  helper2: { name: "", employeeId: null },
  matched: { driver1: 1, helper1: 2 },
  ...over,
});

const person = (over: Partial<TripPersonPay> = {}): TripPersonPay => ({
  employeeId: 1,
  empNo: "HC0011",
  name: "Umar Farhan",
  drove: true,
  helped: false,
  commission: {
    lines: [{ crew: 2, baseSen: 28_115_400, rateBps: 40, amountSen: 113_698 }],
    baseSen: 28_115_400,
    missedDays: 0,
    cutBps: 0,
    amountSen: 113_698,
  },
  lines: [],
  allowanceSen: 240_198,
  jobAllowanceSen: 99_500,
  outstationSen: 27_000,
  overnightSen: 0,
  totalSen: 240_198,
  missed: null,
  ...over,
});

describe("Trip Pay rows export", () => {
  it("writes ringgit, not sen, as money cells", () => {
    const m = buildLineExportMatrix([tripRow()], () => [], rowCols);
    expect(cellOf(m, "Local Total")).toEqual({ value: 5579, format: "money" });
    expect(cellOf(m, "Outstation")).toEqual({ value: 240, format: "money" });
    expect(cellOf(m, "Overnight")).toEqual({ value: 10.5, format: "money" });
  });

  it("leaves a zero money cell blank", () => {
    const m = buildLineExportMatrix([tripRow({ pay: { tripOfDay: null, sameJob: false, allowanceSen: 0, outstationSen: 0, overnightSen: 0 } })], () => [], rowCols);
    expect(cellOf(m, "Allowance").value).toBeNull();
  });

  it("blanks a Transfer item's Local Total (it pays nothing)", () => {
    const m = buildLineExportMatrix([tripRow({ jobType: "TRANSFER", localTotalSen: 557_900 })], () => [], rowCols);
    expect(cellOf(m, "Local Total").value).toBeNull();
  });
});

describe("Trip Pay people export", () => {
  it("writes commission and totals in ringgit as money cells", () => {
    const m = buildLineExportMatrix([person()], () => [], peopleCols);
    expect(cellOf(m, "Commission Base")).toEqual({ value: 281154, format: "money" });
    expect(cellOf(m, "Commission")).toEqual({ value: 1136.98, format: "money" });
    expect(cellOf(m, "Job Allowances")).toEqual({ value: 995, format: "money" });
    expect(cellOf(m, "Outstation")).toEqual({ value: 270, format: "money" });
    expect(cellOf(m, "Total")).toEqual({ value: 2401.98, format: "money" });
    expect(cellOf(m, "Overnight").value).toBeNull();
  });

  it("blanks commission for a helper who never drove", () => {
    const m = buildLineExportMatrix([person({ drove: false })], () => [], peopleCols);
    expect(cellOf(m, "Commission").value).toBeNull();
    expect(cellOf(m, "Commission Base").value).toBeNull();
  });
});
