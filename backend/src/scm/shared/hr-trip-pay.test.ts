// Trip pay against Nico's September 2026 sheet ("Houzs_Driver Comm + Worker
// Allowance", 23 Aug - 22 Sep): Amir's own tab, row for row.
import { describe, expect, test } from "vitest";
import {
  DEFAULT_TRIP_RATES,
  areaOfState,
  computeTripPay,
  kindFromSheet,
  leaveCutFor,
  missedWorkingDays,
  normName,
  normalizeTripRates,
  parseTripReport,
  tripMonthBounds,
  tripMonthOf,
  type TripRow,
} from "./hr-trip-pay";

const AMIR_TAB = [
  "Doc. No.\tTransfer To\tRef. No\tLocal Total\tDelivery Date\tAddress 4\tlorry plate\tdriver name\tHelper 1\tHelper 2",
  "SO-006584-SERVICE\tASSR/2605-031\tHC8479-SERVICE\t\t2026/08/24\tSelangor\tVPC 9058\tAMIR\tWAN\tNAEM",
  "SO-012788\tDO-011193+DO-011397\tHC8479\t200.00\t2026/08/24\tSelangor\tVPC 9058\tAMIR\tWAN\tNAEM",
  "SEND LORRY TO HOKKA\t\tSUPPLIER\t\t2026/08/24\tSelangor\tVPC 9058\tAMIR\tWAN\tNAEM",
  "MELAKA AKEMI MITC SETUP - 2\t\tSETUP / DISMANTLE - FA\t\t2026/08/27\tMelaka\tVPC 9058\tAMIR\tWAN\tNAEM",
  "2990-SO-2607-029\t2990-DO-2608-019\t2990-SO-2607-029\t0.00\t2026/08/28\tKuala Lumpur\tVPC 9058\tAMIR\tBAIJIT\tSHOHAG",
  "SO-012268\tDO-011438\tHC10850\t7,000.00\t2026/08/28\tSelangor\tVPC 9058\tAMIR\tBAIJIT\tSHOHAG",
  "SO-012648\tDO-011428\tHC11455\t8,500.00\t2026/08/28\tKuala Lumpur\tVPC 9058\tAMIR\tBAIJIT\tSHOHAG",
  "SO-012650\tDO-011442\tHC11465\t4,000.00\t2026/08/28\tSelangor\tVPC 9058\tAMIR\tBAIJIT\tSHOHAG",
  "SO-010712\tDO-011430\tHC12409\t2,094.00\t2026/08/28\tKuala Lumpur\tVPC 9058\tAMIR\tBAIJIT\tSHOHAG",
  "SO-013156\tDO-011427\tHC13924\t8,500.00\t2026/08/28\tKuala Lumpur\tVPC 9058\tAMIR\tBAIJIT\tSHOHAG",
  "SO-005593\tDO-011429\tHC8123\t7,388.00\t2026/08/28\tKuala Lumpur\tVPC 9058\tAMIR\tBAIJIT\tSHOHAG",
  "JOHOR ZANOTTI MID VALLEY DISMANTLE - 4\t\tSETUP / DISMANTLE - FA\t\t2026/09/01\tJohor\tVPC 9058\tAMIR\tWAN\tNAEM",
  "SO-012625-SERVICE\tASSR/2608-012\tZNT 6495-SERVICE\t\t2026/09/02\tSelangor\tVQE 9058\tAMIR\tALI\tJAMSED",
  "SO-012508-SERVICE\tASSR/2608-020\tZNT5976-SERVICE\t\t2026/09/02\tSelangor\tVQE 9058\tAMIR\tALI\tJAMSED",
  "2990-SO-2608-008\t2990-DO-2609-002\t2990-SO-2608-008\t3,490.00\t2026/09/02\tSelangor\tVQE 9058\tAMIR\tALI\tJAMSED",
  "2990-SO-2608-009\t2990-DO-2609-003\t2990-SO-2608-009\t3,240.00\t2026/09/02\tSelangor\tVQE 9058\tAMIR\tALI\tJAMSED",
  "SO-013142\tHC-DO-011478\tHC13919\t8,099.00\t2026/09/02\tSelangor\tVQE 9058\tAMIR\tALI\tJAMSED",
  "SO-012645-SERVICE\tASSR/2608-037\tHC11452-SERVICE\t\t2026/09/03\tSelangor\tVQE 9058\tAMIR\tYUNUS\tBILAL",
  "2990-SO-2608-014\t2990-DO-2609-005\t2990-SO-2608-014\t3,240.00\t2026/09/03\tSelangor\tVQE 9058\tAMIR\tYUNUS\tBILAL",
  "SO-000624\tHC-DO-011489\tMYHC 0352\t2,760.00\t2026/09/03\tSelangor\tVQE 9058\tAMIR\tYUNUS\tBILAL",
  "SO-2606-016 - MATTRESS\tDO-2608-005\tSO-2606-016 - MATTRESS\t4,095.00\t2026/09/03\tSelangor\tVQE 9058\tAMIR\tYUNUS\tBILAL",
  "SO-011146-SERVICE\tASSR/2608-003\tZNT5869-SERVICE\t\t2026/09/04\tSelangor\tVPC 9058\tAMIR\tSAGOR\tJAMSED",
  "2990-SO-2608-005\t2990-DO-2609-007\t2990-SO-2608-005\t3,240.00\t2026/09/04\tSelangor\tVPC 9058\tAMIR\tSAGOR\tJAMSED",
  "SO-013277\tHC-DO-011503\tHC10770\t4,888.00\t2026/09/04\tSelangor\tVPC 9058\tAMIR\tSAGOR\tJAMSED",
  "SO-008172\tHC-DO-011505, HC-DO-2609-101\tHC12208\t20,166.00\t2026/09/04\tSelangor\tVPC 9058\tAMIR\tSAGOR\tJAMSED",
  "SO-003279\tHC-DO-011502\tHC4647\t7,000.00\t2026/09/04\tSelangor\tVPC 9058\tAMIR\tSAGOR\tJAMSED",
  "2990-SO-2607-021\t2990-DO-2608-016\t2990-SO-2607-021 + SO-2607-019\t\t2026/09/07\tKuala Lumpur\tVQE 9058\tAMIR\tBAIJIT\tSHOHAG",
  "SO-009110\tHC-DO-011537\tHC8403\t6,500.00\t2026/09/07\tKuala Lumpur\tVQE 9058\tAMIR\tBAIJIT\tSHOHAG",
  "SO-006068\tHC-DO-011538\tHC8433\t3,800.00\t2026/09/07\tSelangor\tVQE 9058\tAMIR\tBAIJIT\tSHOHAG",
  "2990-SO-2607-019\t2990-DO-2609-010\tSO-2607-019\t2,865.00\t2026/09/07\tKuala Lumpur\tVQE 9058\tAMIR\tBAIJIT\tSHOHAG",
  "SO-012107\tHC-DO-011539\tZNT6076\t3,380.00\t2026/09/07\tSelangor\tVQE 9058\tAMIR\tBAIJIT\tSHOHAG",
  "LORRY VPC SERVICE\t\tLORRY SERVICE\t\t2026/09/08\tSelangor\tVPC 9058\tAMIR\t\t",
  "SO-007322-SERVICE\tASSR/2608-004\tZNT4951-SERVICE\t\t2026/09/10\tJohor\tVNB 9058\tAMIR\tWAN\tSHOHAG",
  "JOHOR AKEMI THE COMMUNE KULAI SETUP\t\tSETUP / DISMANTLE - FA\t\t2026/09/10\tJohor\tVNB 9058\tAMIR\tWAN\tSHOHAG",
  "HOOKKA PICK UP ITEM\t\tSUPPLIER\t\t2026/09/11\tSelangor\tVNB 9058\tAMIR\tSAGOR\t",
  "AKEMI MID VALLEY DISMANTLE - 2\t\tSETUP / DISMANTLE - FA\t\t2026/09/14\tKuala Lumpur\tVPC 9058\tAMIR\tYUNUS\tSAGOR",
  "ZANOTTI MID VALLEY DISMANTLE - 2\t\tSETUP / DISMANTLE - FA\t\t2026/09/14\tKuala Lumpur\tVPC 9058\tAMIR\tYUNUS\tSAGOR",
  "SO-013081-SERVICE\tASSR/2609-003\tZNT5986-SERVICE\t\t2026/09/19\tSelangor\tVPC 9058\tAMIR\tYUNUS\tSHOHAG",
  "SO-011097\tHC-DO-2609-138\tHC10171\t3,594.00\t2026/09/19\tSelangor\tVPC 9058\tAMIR\tYUNUS\tSHOHAG",
  "SO-013512\tHC-DO-2609-140\tHC13239\t3,049.00\t2026/09/19\tSelangor\tVPC 9058\tAMIR\tYUNUS\tSHOHAG",
  "SO-013131\tHC-DO-2609-156\tHc13967\t5,700.00\t2026/09/19\tSelangor\tVPC 9058\tAMIR\tYUNUS\tSHOHAG",
  "SO-011280\tHC-DO-2609-139\tHC9194\t3,600.00\t2026/09/19\tSelangor\tVPC 9058\tAMIR\tYUNUS\tSHOHAG",
  "SO-011160\tHC-DO-2609-143\tZNT 6458\t4,450.00\t2026/09/19\tSelangor\tVPC 9058\tAMIR\tYUNUS\tSHOHAG",
  "SOLO IOI PUTRAJAYA DISMANTLE\t\tSETUP / DISMANTLE - FNGT\t\t2026/09/20\tSelangor\tVPC 9058\tAMIR\tALI\tJAMSED",
  "2990-SO-2607-026-SERVICE\tASSR/2608-051\t2990-SO-2607-026-SERVICE\t\t2026/09/22\tKuala Lumpur\tVPC 9058\tAMIR\tALI\tNAEM",
  "SO-009202\tHC-DO-2609-177\tHC 10555\t19,800.00\t2026/09/22\tKuala Lumpur\tVPC 9058\tAMIR\tALI\tNAEM",
  "SO-012416\tHC-DO-2609-173\tHc14287\t4,500.00\t2026/09/22\tKuala Lumpur\tVPC 9058\tAMIR\tALI\tNAEM",
  "SO-012297\tHC-DO-2609-176\tHc9989\t5,888.00\t2026/09/22\tKuala Lumpur\tVPC 9058\tAMIR\tALI\tNAEM",
].join("\n");

/** Sheet names to ids; the sheet spells Nayem two ways. */
function byName(rows: TripRow[]) {
  const ids = new Map<string, number>();
  const alias: Record<string, string> = { NAEM: "NAYEM" };
  const employeeOf = (p: { name: string }) => {
    const n = alias[normName(p.name)] ?? normName(p.name);
    if (!ids.has(n)) ids.set(n, ids.size + 1);
    return ids.get(n)!;
  };
  for (const r of rows) [...r.drivers, ...r.helpers].forEach(employeeOf);
  return { ids, employeeOf };
}

describe("parseTripReport", () => {
  test("reads the copied tab: header skipped, dates and amounts parsed, kinds from the Ref No", () => {
    const { rows, skipped } = parseTripReport(AMIR_TAB);
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(48);
    expect(rows[1]).toMatchObject({ tripDate: "2026-08-24", kind: "DO", localTotalSen: 20000, state: "Selangor" });
    expect(rows.filter((r) => r.kind === "FAIR")).toHaveLength(5);
    expect(rows.filter((r) => r.kind === "FAIR_NIGHT")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "SERVICE_DELIVERY")).toHaveLength(8);
    expect(rows.filter((r) => r.kind === "SUPPLIER")).toHaveLength(2);
    expect(rows.find((r) => r.docNo === "LORRY VPC SERVICE")).toMatchObject({ kind: "NONE", helpers: [] });
  });

  test("a line with no date is skipped and reported", () => {
    const { rows, skipped } = parseTripReport("SO-1\tDO-1\tHC1\t100.00\t\tSelangor\tVPC 1\tAMIR\t\t");
    expect(rows).toEqual([]);
    expect(skipped).toEqual([{ line: 1, text: "SO-1\tDO-1\tHC1\t100.00\t\tSelangor\tVPC 1\tAMIR\t\t" }]);
  });
});

describe("kindFromSheet", () => {
  test("the sheet's codes", () => {
    expect(kindFromSheet("X SETUP", "", "SETUP / DISMANTLE - FN", false)).toBe("FAIR_NOON");
    expect(kindFromSheet("X", "", "SETUP / DISMANTLE - 2T", false)).toBe("FAIR_2ND");
    expect(kindFromSheet("SO-1-PICKUP", "ASSR/1", "HC1-PICKUP", true)).toBe("SERVICE_PICKUP");
    expect(kindFromSheet("SO-1-INSPECTION", "ASSR/1", "Z-INSPECTION", false)).toBe("SERVICE_INSPECTION");
    expect(kindFromSheet("SEND ITEM", "", "TRANSFER ITEM", false)).toBe("TRANSFER");
    expect(kindFromSheet("PICK UP", "", "SUPPLIER - FULL LOAD", false)).toBe("SUPPLIER_FULL");
  });
});

describe("computeTripPay", () => {
  test("Amir, September: the sheet's RM1,520.10 plus the JB/PG day Nico confirmed was missed = RM1,600.10", () => {
    const { rows } = parseTripReport(AMIR_TAB);
    const { ids, employeeOf } = byName(rows);
    const pay = computeTripPay({ rows, rates: DEFAULT_TRIP_RATES, employeeOf, missedDaysOf: () => 0 });
    const amir = pay.get(ids.get("AMIR")!)!;
    expect(amir.commission).toMatchObject({ baseSen: 16502600, cutBps: 0, amountSen: 66010 });
    expect(amir.lines.map((l) => [l.key, l.count, l.amountSen])).toEqual([
      ["FAIR", 4, 40000],
      ["FAIR_NIGHT", 1, 20000],
      ["OUT_JP", 2, 16000],
      ["OUT_MIS", 1, 3000],
      ["SERVICE_DELIVERY", 8, 12000],
      ["SUPPLIER", 2, 3000],
    ]);
    expect(amir.lines.find((l) => l.key === "OUT_JP")!.dates).toEqual(["2026-09-01", "2026-09-10"]);
    expect(amir.totalSen).toBe(160010);
  });

  test("helpers earn the transport allowance only, once per day per area", () => {
    const { rows } = parseTripReport(AMIR_TAB);
    const { ids, employeeOf } = byName(rows);
    const pay = computeTripPay({ rows, rates: DEFAULT_TRIP_RATES, employeeOf, missedDaysOf: () => 0 });
    const wan = pay.get(ids.get("WAN")!)!;
    expect(wan).toMatchObject({ drove: false, helped: true, commission: { amountSen: 0 } });
    expect(wan.lines.map((l) => [l.key, l.dates])).toEqual([
      ["TRANSPORT_JP", ["2026-09-01", "2026-09-10"]],
      ["TRANSPORT_MIS", ["2026-08-27"]],
    ]);
    expect(pay.get(ids.get("NAYEM")!)!.lines.map((l) => l.count)).toEqual([1, 1]);
  });

  test("two missed days take 0.4% to 0.3% (Farhan and Faslie in September); a 2-person crew earns 0.5%", () => {
    const row = (date: string, sen: number, helpers: string[]): TripRow => ({
      tripDate: date,
      docNo: "SO",
      transferTo: "DO",
      refNo: "HC",
      kind: "DO",
      localTotalSen: sen,
      state: "Selangor",
      lorryPlate: "",
      drivers: [{ name: "D", employeeId: 1 }],
      helpers: helpers.map((h, i) => ({ name: h, employeeId: 10 + i })),
    });
    const pay = computeTripPay({
      rows: [row("2026-09-02", 34370400, ["A", "B"]), row("2026-09-03", 100000, ["A"])],
      rates: DEFAULT_TRIP_RATES,
      employeeOf: (p) => p.employeeId,
      missedDaysOf: () => 2,
    }).get(1)!;
    expect(pay.commission.cutBps).toBe(10);
    expect(pay.commission.lines).toEqual([
      { crew: 3, baseSen: 34370400, rateBps: 30, amountSen: 103111 },
      { crew: 2, baseSen: 100000, rateBps: 40, amountSen: 400 },
    ]);
    expect(pay.commission.amountSen).toBe(103511);
  });

  test("a service case with a charge counts toward the commission base, as the sheet does", () => {
    const { rows } = parseTripReport("SO-013031 - SERVICE\tASSR/2608-054\tHC11062-SERVICE\t1,900.00\t2026/09/19\tSelangor\tVPC\tD\tA\tB");
    expect(rows[0].kind).toBe("SERVICE_DELIVERY");
    const pay = computeTripPay({ rows, rates: DEFAULT_TRIP_RATES, employeeOf: (p) => (p.name === "D" ? 1 : 2), missedDaysOf: () => 0 }).get(1)!;
    expect(pay.commission.amountSen).toBe(760);
    expect(pay.lines.map((l) => l.key)).toEqual(["SERVICE_DELIVERY"]);
  });

  test("a name nobody resolves earns nothing", () => {
    const { rows } = parseTripReport(AMIR_TAB);
    const pay = computeTripPay({ rows, rates: DEFAULT_TRIP_RATES, employeeOf: () => null, missedDaysOf: () => 0 });
    expect(pay.size).toBe(0);
  });
});

describe("rules", () => {
  test("leave cut is cumulative: 0.05, 0.10, 0.20, then 0.10 a day", () => {
    expect([0, 1, 2, 3, 4].map((n) => leaveCutFor(n, DEFAULT_TRIP_RATES))).toEqual([0, 5, 10, 20, 30]);
  });

  test("trip month runs 23rd to 22nd, across the new year", () => {
    expect(tripMonthBounds("2026-09")).toEqual({ first: "2026-08-23", last: "2026-09-22" });
    expect(tripMonthBounds("2027-01")).toEqual({ first: "2026-12-23", last: "2027-01-22" });
    expect(tripMonthOf("2026-09-22")).toBe("2026-09");
    expect(tripMonthOf("2026-09-23")).toBe("2026-10");
    expect(tripMonthOf("2026-12-28")).toBe("2027-01");
  });

  test("outstation areas; home area and Singapore earn none", () => {
    expect(["Melaka", "Negeri Sembilan", "Perak", "Johor", "Penang", "Pahang", "Kelantan", "Selangor", "Kuala Lumpur", "Singapore"].map(areaOfState)).toEqual([
      "MIS",
      "MIS",
      "MIS",
      "JP",
      "JP",
      "TP",
      "KEL",
      null,
      null,
      null,
    ]);
  });

  test("missed days: working days with no hours and no leave", () => {
    expect(
      missedWorkingDays({
        from: "2026-09-14",
        to: "2026-09-20",
        workedDates: new Set(["2026-09-14", "2026-09-15", "2026-09-17"]),
        leaveDates: new Set(["2026-09-18"]),
        holidays: new Set(["2026-09-16"]),
      }),
    ).toEqual(["2026-09-19"]);
  });

  test("stored rates fall back field by field", () => {
    const r = normalizeTripRates({ fairSen: "12000", driverOutstationSen: { JP: 9000 }, leaveCutBps: [5, "x", 10] });
    expect(r.fairSen).toBe(12000);
    expect(r.driverOutstationSen).toEqual({ MIS: 3000, JP: 9000, TP: 12000, KEL: 15000 });
    expect(r.leaveCutBps).toEqual([5, 10]);
    expect(r.commission3Bps).toBe(40);
  });
});
