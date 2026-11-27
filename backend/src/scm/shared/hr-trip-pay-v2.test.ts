import { describe, expect, test } from "vitest";
import {
  DEFAULT_TRIP_RATES,
  computeLegacyTripPay,
  computeTripMonth,
  eventTypeOf,
  homeAreaStates,
  normalizeLegacyTripRates,
  normalizeTripRates,
  parseTripReport,
  tripRatesProblem,
  tripStateOf,
  type TripPunch,
  type TripRates,
  type TripRow,
} from "./hr-trip-pay";

const D = { name: "AMIR", employeeId: 1 };
const H = { name: "WAN", employeeId: 2 };
const row = (o: Partial<TripRow>): TripRow => ({
  tripDate: "2026-11-03",
  docNo: "X",
  transferTo: "",
  refNo: "",
  kind: "FAIR",
  jobType: "SETUP",
  eventType: "EXHIBITION",
  localTotalSen: 0,
  allowanceOverrideSen: null,
  state: "Selangor",
  postcode: "",
  lorryPlate: "VPC 9058",
  tripRef: "T1",
  venueKey: "P1",
  drivers: [D],
  helpers: [H],
  ...o,
});
const run = (rows: TripRow[], rates: TripRates = DEFAULT_TRIP_RATES, punches = new Map<number, TripPunch[]>(), missed = 0) =>
  computeTripMonth({ rows, rates, employeeOf: (p) => p.employeeId, missedDaysOf: () => missed, punches });

describe("2nd trip, automatic", () => {
  test("a second Setup/Dismantle trip of the same driver and lorry that day pays the 2nd-trip rate (Setup then Dismantle counts)", () => {
    const r = run([row({ tripRef: "T1", venueKey: "P1" }), row({ jobType: "DISMANTLE", tripRef: "T2", venueKey: "P2" })]);
    expect(r.rows.map((x) => [x.tripOfDay, x.allowanceSen])).toEqual([
      [1, 10000],
      [2, 13500],
    ]);
    expect(r.pay.get(1)!.jobAllowanceSen).toBe(23500);
    expect(r.pay.get(2)!.jobAllowanceSen).toBe(0);
  });

  test("a second venue on the same trip pays the 2nd-trip rate; the same venue twice is one job", () => {
    const r = run([row({ venueKey: "P1" }), row({ venueKey: "P1", docNo: "Y" }), row({ venueKey: "P2" })]);
    expect(r.rows.map((x) => [x.tripOfDay, x.sameJob, x.allowanceSen])).toEqual([
      [1, false, 10000],
      [1, true, 0],
      [2, false, 13500],
    ]);
  });

  test("another lorry, another driver or another day is a 1st trip again", () => {
    const r = run([
      row({}),
      row({ venueKey: "P2", lorryPlate: "VQE 1" }),
      row({ venueKey: "P3", drivers: [{ name: "ALI", employeeId: 3 }] }),
      row({ venueKey: "P4", tripDate: "2026-11-04" }),
    ]);
    expect(r.rows.map((x) => x.tripOfDay)).toEqual([1, 1, 1, 1]);
  });

  test("an empty 2nd-trip rate pays the per-trip rate; a roadshow pays its own rate; an unknown event pays the Exhibition rate", () => {
    const rates = normalizeTripRates({
      ...DEFAULT_TRIP_RATES,
      jobAllowances: [
        { jobType: "SETUP", eventType: "EXHIBITION", perTripSen: 10000, secondTripSen: null },
        { jobType: "SETUP", eventType: "ROADSHOW", perTripSen: 20000, secondTripSen: 15000 },
      ],
    });
    const r = run([row({}), row({ venueKey: "P2" }), row({ tripDate: "2026-11-05", eventType: "ROADSHOW" }), row({ tripDate: "2026-11-06", eventType: null })], rates);
    expect(r.rows.map((x) => x.allowanceSen)).toEqual([10000, 10000, 20000, 10000]);
  });

  test("other job types pay per trip, helpers earn no job allowance", () => {
    const r = run([row({ jobType: "ASSR_SERVICE", eventType: null }), row({ jobType: "ASSR_SERVICE", eventType: null, venueKey: "P2" }), row({ jobType: "NONE", eventType: null })]);
    expect(r.rows.map((x) => [x.tripOfDay, x.allowanceSen])).toEqual([
      [null, 1500],
      [null, 1500],
      [null, 0],
    ]);
    expect(r.pay.get(1)!.lines.find((l) => l.key === "JOB_ASSR_SERVICE")).toMatchObject({ count: 2, amountSen: 3000 });
  });
});

describe("transfer item, once per driver per day", () => {
  test("a driver's extra transfer stops that day pay the flat RM15 only once", () => {
    const r = run([
      row({ jobType: "TRANSFER", eventType: null, docNo: "HC-SO-1" }),
      row({ jobType: "TRANSFER", eventType: null, docNo: "HC-SO-2", venueKey: "P2" }),
    ]);
    expect(r.rows.map((x) => [x.sameJob, x.allowanceSen])).toEqual([
      [false, 1500],
      [true, 0],
    ]);
    expect(r.pay.get(1)!.jobAllowanceSen).toBe(1500);
  });

  test("another driver, or another day, is its own transfer again", () => {
    const r = run([
      row({ jobType: "TRANSFER", eventType: null }),
      row({ jobType: "TRANSFER", eventType: null, drivers: [{ name: "ALI", employeeId: 3 }], venueKey: "P2" }),
      row({ jobType: "TRANSFER", eventType: null, tripDate: "2026-11-04", venueKey: "P3" }),
    ]);
    expect(r.rows.map((x) => x.allowanceSen)).toEqual([1500, 1500, 1500]);
  });
});

describe("hand-set allowance override (owner 2026-11-27)", () => {
  test("a filled override is the row's job allowance, not the rate card", () => {
    const r = run([row({ allowanceOverrideSen: 25000 })]);
    expect(r.rows[0].allowanceSen).toBe(25000);
    expect(r.pay.get(1)!.jobAllowanceSen).toBe(25000);
  });
  test("override pays even for a job type with no rate-card allowance", () => {
    const r = run([row({ jobType: "LORRY_SERVICE", eventType: null, allowanceOverrideSen: 8000 })]);
    expect(r.rows[0].allowanceSen).toBe(8000);
  });
  test("override of 0 pays nothing; null falls back to the rate card", () => {
    expect(run([row({ allowanceOverrideSen: 0 })]).rows[0].allowanceSen).toBe(0);
    expect(run([row({ allowanceOverrideSen: null })]).rows[0].allowanceSen).toBe(10000);
  });
});

describe("commission", () => {
  test("Delivery orders only, by crew size; a charged service case does not count", () => {
    const p = run([
      row({ jobType: "DELIVERY_ORDER", eventType: null, localTotalSen: 1000000 }),
      row({ jobType: "DELIVERY_ORDER", eventType: null, localTotalSen: 500000, helpers: [] }),
      row({ jobType: "ASSR_SERVICE", eventType: null, localTotalSen: 190000 }),
    ]).pay.get(1)!;
    expect(p.commission.lines).toEqual([{ crew: 2, baseSen: 1500000, rateBps: 50, amountSen: 7500 }]);
  });

  test("the missed-day cut list is configurable and adds up, then each later day", () => {
    const rates = normalizeTripRates({ ...DEFAULT_TRIP_RATES, leaveCutBps: [5, 5, 10], leaveCutAfterBps: 10 });
    const p = run([row({ jobType: "DELIVERY_ORDER", eventType: null, localTotalSen: 1000000, helpers: [H, { name: "B", employeeId: 9 }] })], rates, new Map(), 4).pay.get(1)!;
    expect(p.commission).toMatchObject({ cutBps: 30, lines: [{ crew: 3, rateBps: 10, amountSen: 1000 }] });
  });
});

describe("outstation", () => {
  test("once per person per day, the highest-priced group reached; the home area and No allowance pay none", () => {
    const r = run([
      row({ jobType: "DELIVERY_ORDER", eventType: null, state: "MELAKA" }),
      row({ jobType: "DELIVERY_ORDER", eventType: null, state: "Johor" }),
      row({ jobType: "DELIVERY_ORDER", eventType: null, state: "Johor" }),
      row({ jobType: "NONE", eventType: null, state: "Kelantan", tripDate: "2026-11-04" }),
      row({ jobType: "DELIVERY_ORDER", eventType: null, state: "Selangor", tripDate: "2026-11-05" }),
    ]);
    const amir = r.pay.get(1)!;
    expect(amir.outstationSen).toBe(8000);
    expect(amir.lines.find((l) => l.category === "OUTSTATION")!.items).toEqual([{ date: "2026-11-03", docNo: "X", job: "Delivery order", state: "Johor", amountSen: 8000 }]);
    expect(r.pay.get(2)!.lines.find((l) => l.category === "OUTSTATION")).toMatchObject({ key: "OUT_1_H", amountSen: 8000 });
    expect(r.rows.map((x) => x.outstationSen)).toEqual([0, 16000, 0, 0, 0]);
  });

  test("driver and helper prices differ; home area lists the states in no group", () => {
    const rates = normalizeTripRates({ ...DEFAULT_TRIP_RATES, outstation: [{ states: ["Pahang"], driverSen: 12000, helperSen: 6000 }] });
    const r = run([row({ jobType: "SUPPLIER", eventType: null, state: "Pahang" })], rates);
    expect([r.pay.get(1)!.outstationSen, r.pay.get(2)!.outstationSen]).toEqual([12000, 6000]);
    expect(homeAreaStates(rates)).not.toContain("Pahang");
    expect(homeAreaStates(rates)).toContain("Johor");
  });
});

describe("overnight", () => {
  const tiers = (o: Partial<TripRates["overnight"]>) =>
    normalizeTripRates({
      ...DEFAULT_TRIP_RATES,
      overnight: {
        tiers: [
          { after: "22:00", driverSen: 3000, helperSen: 2000 },
          { after: "00:00", driverSen: 5000, helperSen: 4000 },
          { after: "02:00", driverSen: 8000, helperSen: 6000 },
        ],
        jobTypes: [],
        minHours: 0,
        ...o,
      },
    });
  const punch = (outIso: string): TripPunch => ({ workDate: "2026-11-03", inAt: "2026-11-03T02:00:00.000Z", outAt: outIso });
  const out = (rates: TripRates, punches: TripPunch[], rows = [row({})]) => run(rows, rates, new Map([[1, punches]])).pay.get(1)?.overnightSen ?? 0;

  test("the highest tier reached pays, once per night", () => {
    const r = tiers({});
    expect(out(r, [punch("2026-11-03T12:30:00.000Z")])).toBe(0);
    expect(out(r, [punch("2026-11-03T14:30:00.000Z")])).toBe(3000);
    expect(out(r, [punch("2026-11-03T17:30:00.000Z")])).toBe(5000);
    expect(out(r, [punch("2026-11-03T19:00:00.000Z")])).toBe(8000);
    expect(out(r, [punch("2026-11-03T15:00:00.000Z"), punch("2026-11-03T19:00:00.000Z")])).toBe(8000);
  });

  test("a helper that night is paid the helper amount", () => {
    const p = run([row({})], tiers({}), new Map([[2, [{ workDate: "2026-11-03", inAt: "2026-11-03T02:00:00.000Z", outAt: "2026-11-03T17:30:00.000Z" }]]])).pay.get(2)!;
    expect(p.overnightSen).toBe(4000);
  });

  test("applies to the ticked job types only", () => {
    const r = tiers({ jobTypes: ["SETUP", "DISMANTLE"] });
    expect(out(r, [punch("2026-11-03T17:30:00.000Z")], [row({ jobType: "DELIVERY_ORDER", eventType: null })])).toBe(0);
    expect(out(r, [punch("2026-11-03T17:30:00.000Z")], [row({})])).toBe(5000);
    expect(out(tiers({}), [punch("2026-11-03T17:30:00.000Z")], [])).toBe(4000);
  });

  test("only if the shift lasted over N hours; 0 = no condition", () => {
    const shortShift: TripPunch = { workDate: "2026-11-03", inAt: "2026-11-03T09:00:00.000Z", outAt: "2026-11-03T17:30:00.000Z" };
    expect(out(tiers({ minHours: 10 }), [shortShift])).toBe(0);
    expect(out(tiers({ minHours: 8 }), [shortShift])).toBe(5000);
    expect(out(tiers({ minHours: 0 }), [shortShift])).toBe(5000);
  });
});

describe("Supplier (Hookka)", () => {
  test("a Supplier (Hookka) pickup pays the driver the RM30 default; the helper earns no job allowance", () => {
    const r = run([row({ jobType: "SUPPLIER_HOOKKA", eventType: null })]);
    expect(r.pay.get(1)!.jobAllowanceSen).toBe(3000);
    expect(r.pay.get(2)!.jobAllowanceSen).toBe(0);
  });

  test("with no Supplier (Hookka) rate of its own it falls back to the generic Supplier rate", () => {
    const rates: TripRates = { ...DEFAULT_TRIP_RATES, jobAllowances: DEFAULT_TRIP_RATES.jobAllowances.filter((a) => a.jobType !== "SUPPLIER_HOOKKA") };
    expect(run([row({ jobType: "SUPPLIER_HOOKKA", eventType: null })], rates).pay.get(1)!.jobAllowanceSen).toBe(1500);
  });
});

describe("rates", () => {
  test("old versions still compute the same totals as the old rules", () => {
    const stored = { fairSen: 12000, fairNightSen: 21000, driverOutstationSen: { JP: 9000 }, overnightSen: 6000, commission3Bps: 45 };
    const { rows } = parseTripReport(
      [
        "SO-1\tDO-1\tHC1\t5,000.00\t2026/09/01\tJohor\tVPC\tAMIR\tWAN\tNAEM",
        "X SETUP\t\tSETUP / DISMANTLE - FNGT\t\t2026/09/02\tMelaka\tVPC\tAMIR\tWAN\t",
        "SO-2-SERVICE\tASSR/1\tHC2-SERVICE\t1,900.00\t2026/09/03\tSelangor\tVPC\tAMIR\tWAN\t",
      ].join("\n"),
    );
    const ids: Record<string, number> = { AMIR: 1, WAN: 2, NAEM: 3 };
    const employeeOf = (p: { name: string }) => ids[p.name] ?? null;
    const punches = new Map([[1, [{ workDate: "2026-09-02", inAt: "2026-09-02T04:00:00.000Z", outAt: "2026-09-02T20:00:00.000Z" }]]]);
    const now = computeTripMonth({ rows, rates: normalizeTripRates(stored), employeeOf, missedDaysOf: () => 1, punches }).pay;
    const then = computeLegacyTripPay({ rows, rates: normalizeLegacyTripRates(stored), employeeOf, missedDaysOf: () => 1, overnight: new Map([[1, ["2026-09-02"]]]) });
    expect([...now.values()].map((p) => p.totalSen)).toEqual([...then.values()].map((p) => p.totalSen));
    expect(now.get(1)!.totalSen).toBe(2000 + 855 + 21000 + 9000 + 3000 + 1500 + 6000);
  });

  test("an old version reads in the new shape for the drawer", () => {
    const r = normalizeTripRates({ fairSen: 12000, fair2ndSen: 14000 });
    expect(r.legacy).not.toBeNull();
    expect(r.jobAllowances[0]).toEqual({ jobType: "SETUP", eventType: "EXHIBITION", perTripSen: 12000, secondTripSen: 14000 });
    expect(r.outstation[1]).toEqual({ states: ["Johor", "Pulau Pinang"], driverSen: 8000, helperSen: 8000 });
  });

  test("a saved version round-trips and is validated", () => {
    expect(normalizeTripRates(JSON.parse(JSON.stringify(DEFAULT_TRIP_RATES)))).toEqual(DEFAULT_TRIP_RATES);
    const twice = { ...DEFAULT_TRIP_RATES, outstation: [...DEFAULT_TRIP_RATES.outstation, { states: ["Johor"], driverSen: 1, helperSen: 1 }] };
    expect(tripRatesProblem(twice)).toBe("Johor is in two outstation groups.");
    expect(tripRatesProblem({ ...DEFAULT_TRIP_RATES, overnight: { tiers: [{ after: "12:00", driverSen: 1, helperSen: 1 }], jobTypes: [], minHours: 0 } })).toMatch(/22:00 and 04:00/);
    expect(tripRatesProblem({ ...DEFAULT_TRIP_RATES, jobAllowances: [...DEFAULT_TRIP_RATES.jobAllowances, { jobType: "SUPPLIER", eventType: null, perTripSen: 1, secondTripSen: null }] })).toMatch(/listed twice/);
    expect(tripRatesProblem(DEFAULT_TRIP_RATES)).toBeNull();
  });

  test("states and event types", () => {
    expect(["PENANG", "N.S.", "KL", "malacca", "Singapore", ""].map(tripStateOf)).toEqual(["Pulau Pinang", "Negeri Sembilan", "Kuala Lumpur", "Melaka", "", ""]);
    expect([eventTypeOf("solo", null), eventTypeOf("exhibition", "Exhibition"), eventTypeOf(null, null)]).toEqual(["ROADSHOW", "EXHIBITION", null]);
  });
});
