/* Trip pay, HC-0125 phase 5: the driver's monthly commission and the trip
 * allowances of drivers and helpers, from the rules Nico keeps in her sheet
 * "Houzs_Driver Comm + Worker Allowance" (2026-10-22):
 *   - the trip month runs from the 23rd of the previous month to the 22nd and
 *     is paid on that month's payslip;
 *   - a driver earns a % of the Local Total of every row carried (a service
 *     case with a charge counts too, as the sheet does): 0.5% on a
 *     2-person crew, 0.4% on a 3-person crew (1 driver + 2 helpers or
 *     2 drivers + 1 helper); a working day with no punch and no leave cuts the
 *     rate, cumulatively (1st day 0.05%, 2nd 0.05%, 3rd 0.10%: two days take
 *     0.4% to 0.3%, as the sheet paid Farhan and Faslie in September);
 *   - a driver earns a fair allowance per fair day (Fair Night RM150 + RM50:
 *     the sheet paid RM200 on a Tuesday too), RM15 a service case, supplier
 *     trip or transfer, and an outstation allowance per day per area;
 *   - a helper earns only the outstation (transport) allowance, per day per area.
 * Every amount is a rate the HR editor can change (effective-dated).
 *
 * ONE home. backend/src/scm/shared/hr-trip-pay.ts is the original and
 * frontend/src/vendor/shared/hr-trip-pay.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */

export const TRIP_KINDS = [
  "DO",
  "FAIR",
  "FAIR_NIGHT",
  "FAIR_NOON",
  "FAIR_2ND",
  "FAIR_2BOOTH",
  "SERVICE_DELIVERY",
  "SERVICE_PICKUP",
  "SERVICE_INSPECTION",
  "SUPPLIER",
  "SUPPLIER_FULL",
  "TRANSFER",
  "NONE",
] as const;
export type TripKind = (typeof TRIP_KINDS)[number];

export const TRIP_KIND_LABEL: Record<TripKind, string> = {
  DO: "Delivery (DO)",
  FAIR: "Fair",
  FAIR_NIGHT: "Fair night",
  FAIR_NOON: "Fair noon",
  FAIR_2ND: "Fair 2nd trip",
  FAIR_2BOOTH: "Fair, 1 trip 2 booths",
  SERVICE_DELIVERY: "Service - delivery",
  SERVICE_PICKUP: "Service - pickup",
  SERVICE_INSPECTION: "Service - inspection",
  SUPPLIER: "Supplier - per trip",
  SUPPLIER_FULL: "Supplier - full load",
  TRANSFER: "Transfer item",
  NONE: "No allowance",
};

export const OUTSTATION_AREAS = ["MIS", "JP", "TP", "KEL"] as const;
export type OutstationArea = (typeof OUTSTATION_AREAS)[number];
export const OUTSTATION_LABEL: Record<OutstationArea, string> = {
  MIS: "Melaka, Seremban, Ipoh",
  JP: "Johor, Penang",
  TP: "Terengganu, Pahang",
  KEL: "Kelantan",
};

/** The outstation area of a delivery state, or null for the home area (and Singapore, which the sheet never paid separately). */
export function areaOfState(state: string | null | undefined): OutstationArea | null {
  const s = String(state ?? "").toLowerCase();
  if (/melaka|malacca|negeri sembilan|seremban|perak|ipoh/.test(s)) return "MIS";
  if (/johor|penang|pulau pinang/.test(s)) return "JP";
  if (/terengganu|pahang/.test(s)) return "TP";
  if (/kelantan/.test(s)) return "KEL";
  return null;
}

export type TripRates = {
  /** Commission in basis points (40 = 0.40%) of a DO's Local Total. */
  commission2Bps: number;
  commission3Bps: number;
  /** Rate cut for the 1st, 2nd, 3rd... missed working day; each later day cuts leaveCutAfterBps. */
  leaveCutBps: number[];
  leaveCutAfterBps: number;
  fairSen: number;
  fairNightSen: number;
  fairNoonSen: number;
  fair2ndSen: number;
  fair2BoothSen: number;
  serviceDeliverySen: number;
  servicePickupSen: number;
  serviceInspectionSen: number;
  supplierTripSen: number;
  supplierFullSen: number;
  transferSen: number;
  /** Per day per area: the driver's outstation allowance and the helper's transport allowance. */
  driverOutstationSen: Record<OutstationArea, number>;
  helperTransportSen: Record<OutstationArea, number>;
};

export const DEFAULT_TRIP_RATES: TripRates = {
  commission2Bps: 50,
  commission3Bps: 40,
  leaveCutBps: [5, 5, 10],
  leaveCutAfterBps: 10,
  fairSen: 10000,
  fairNightSen: 20000,
  fairNoonSen: 17000,
  fair2ndSen: 13500,
  fair2BoothSen: 15000,
  serviceDeliverySen: 1500,
  servicePickupSen: 1500,
  serviceInspectionSen: 1500,
  supplierTripSen: 1500,
  supplierFullSen: 3000,
  transferSen: 1500,
  driverOutstationSen: { MIS: 3000, JP: 8000, TP: 12000, KEL: 15000 },
  helperTransportSen: { MIS: 3000, JP: 8000, TP: 12000, KEL: 15000 },
};

/** Coerce a half-trusted stored object onto the defaults, field by field. */
export function normalizeTripRates(raw: unknown): TripRates {
  const r = (raw ?? {}) as Record<string, unknown>;
  const whole = (v: unknown, d: number) => {
    const n = Number(v);
    return v !== null && v !== "" && v !== undefined && Number.isFinite(n) && n >= 0 ? Math.round(n) : d;
  };
  const num = (k: Exclude<keyof TripRates, "leaveCutBps" | "driverOutstationSen" | "helperTransportSen">) => whole(r[k], DEFAULT_TRIP_RATES[k]);
  const areas = (k: "driverOutstationSen" | "helperTransportSen") => {
    const o = (r[k] ?? {}) as Record<string, unknown>;
    return Object.fromEntries(OUTSTATION_AREAS.map((a) => [a, whole(o[a], DEFAULT_TRIP_RATES[k][a])])) as Record<OutstationArea, number>;
  };
  const cuts = Array.isArray(r.leaveCutBps) ? r.leaveCutBps.map((v) => whole(v, -1)).filter((v) => v >= 0) : DEFAULT_TRIP_RATES.leaveCutBps;
  return {
    commission2Bps: num("commission2Bps"),
    commission3Bps: num("commission3Bps"),
    leaveCutBps: cuts,
    leaveCutAfterBps: num("leaveCutAfterBps"),
    fairSen: num("fairSen"),
    fairNightSen: num("fairNightSen"),
    fairNoonSen: num("fairNoonSen"),
    fair2ndSen: num("fair2ndSen"),
    fair2BoothSen: num("fair2BoothSen"),
    serviceDeliverySen: num("serviceDeliverySen"),
    servicePickupSen: num("servicePickupSen"),
    serviceInspectionSen: num("serviceInspectionSen"),
    supplierTripSen: num("supplierTripSen"),
    supplierFullSen: num("supplierFullSen"),
    transferSen: num("transferSen"),
    driverOutstationSen: areas("driverOutstationSen"),
    helperTransportSen: areas("helperTransportSen"),
  };
}

/** Why a rates snapshot cannot be saved, or null when it can. */
export function tripRatesProblem(r: TripRates): string | null {
  if (r.commission2Bps > 1000 || r.commission3Bps > 1000) return "Commission is at most 10%.";
  if (r.leaveCutBps.length > 31) return "List the cut for at most 31 days.";
  return null;
}

/** The rates in force on dateYmd. Versions may arrive unsorted. */
export function resolveTripRatesAsOf(versions: ReadonlyArray<{ effectiveFrom: string; rates: unknown }> | null, dateYmd: string): TripRates {
  let best: { effectiveFrom: string; rates: unknown } | null = null;
  for (const v of versions ?? []) {
    if (typeof v.effectiveFrom !== "string" || v.effectiveFrom > dateYmd) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom) best = v;
  }
  return best ? normalizeTripRates(best.rates) : DEFAULT_TRIP_RATES;
}

/** Trip month "2026-09" = 2026-08-23 through 2026-09-22. */
export function tripMonthBounds(period: string): { first: string; last: string } {
  const [y, m] = period.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return { first: `${py}-${String(pm).padStart(2, "0")}-23`, last: `${period}-22` };
}

/** The trip month a date falls in. */
export function tripMonthOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (d <= 22) return ymd.slice(0, 7);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Total rate cut, in basis points, for a number of missed working days. */
export function leaveCutFor(missedDays: number, rates: Pick<TripRates, "leaveCutBps" | "leaveCutAfterBps">): number {
  let cut = 0;
  for (let i = 0; i < Math.max(0, Math.floor(missedDays)); i++) cut += rates.leaveCutBps[i] ?? rates.leaveCutAfterBps;
  return cut;
}

/* ── The month's Trip Report, pasted from Nico's sheet ───────────────────── */

export type TripRow = {
  tripDate: string;
  docNo: string;
  transferTo: string;
  refNo: string;
  kind: TripKind;
  localTotalSen: number;
  state: string;
  lorryPlate: string;
  /** Up to two drivers and two helpers; the employee id when known, else matched by name. */
  drivers: { name: string; employeeId: number | null }[];
  helpers: { name: string; employeeId: number | null }[];
};

/** The kind a Trip Report row reads as, from its Doc No., Transfer To and Ref No. */
export function kindFromSheet(docNo: string, transferTo: string, refNo: string, hasAmount: boolean): TripKind {
  const ref = refNo.toUpperCase();
  const doc = docNo.toUpperCase();
  const all = `${doc} ${transferTo.toUpperCase()} ${ref}`;
  if (/SETUP|DISMANTLE/.test(ref)) {
    const code = ref.split("-").pop()?.trim() ?? "";
    if (code === "FNGT") return "FAIR_NIGHT";
    if (code === "FN") return "FAIR_NOON";
    if (code === "2T") return "FAIR_2ND";
    if (code === "2B") return "FAIR_2BOOTH";
    return "FAIR";
  }
  if (/LORRY SERVICE/.test(all)) return "NONE";
  if (/^SUPPLIER/.test(ref)) return /FULL/.test(all) ? "SUPPLIER_FULL" : "SUPPLIER";
  if (/^TRANSFER/.test(ref)) return "TRANSFER";
  if (/-SERVICE\b/.test(all) || /^ASSR/.test(transferTo.toUpperCase())) {
    if (/PICK ?UP/.test(all)) return "SERVICE_PICKUP";
    if (/INSPECT/.test(all)) return "SERVICE_INSPECTION";
    return "SERVICE_DELIVERY";
  }
  if (hasAmount || /\bDO\b|-DO-|^DO-/.test(transferTo.toUpperCase())) return "DO";
  return "NONE";
}

const moneySen = (s: string): number | null => {
  const t = s.replace(/RM|,|\s/gi, "");
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

const dateOf = (s: string): string | null => {
  const t = s.trim();
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
};

/**
 * Rows of the Trip Report tab copied from Google Sheets (tab-separated, the
 * header row optional): Doc No., Transfer To, Ref No, Local Total, Delivery
 * Date, Address 4 (state), lorry plate, driver name, Helper 1, Helper 2.
 * A line without a date is skipped and reported.
 */
export function parseTripReport(text: string): { rows: TripRow[]; skipped: { line: number; text: string }[] } {
  const rows: TripRow[] = [];
  const skipped: { line: number; text: string }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const c = raw.split("\t").map((s) => s.trim());
    if (i === 0 && /doc\.? ?no/i.test(c[0] ?? "")) return;
    const tripDate = dateOf(c[4] ?? "");
    if (!tripDate) {
      skipped.push({ line: i + 1, text: raw.slice(0, 120) });
      return;
    }
    const amount = moneySen(c[3] ?? "");
    const [docNo, transferTo, refNo] = [c[0] ?? "", c[1] ?? "", c[2] ?? ""];
    const person = (name: string | undefined) => ({ name: (name ?? "").trim(), employeeId: null });
    rows.push({
      tripDate,
      docNo,
      transferTo,
      refNo,
      kind: kindFromSheet(docNo, transferTo, refNo, amount != null),
      localTotalSen: amount ?? 0,
      state: c[5] ?? "",
      lorryPlate: c[6] ?? "",
      drivers: [person(c[7])].filter((p) => p.name),
      helpers: [person(c[8]), person(c[9])].filter((p) => p.name),
    });
  });
  return { rows, skipped };
}

/** Upper-case, single-spaced: how names and aliases are compared. */
export const normName = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

/* ── The month's pay per person ──────────────────────────────────────────── */

export type TripPayLine = {
  key: string;
  label: string;
  count: number;
  unitSen: number;
  amountSen: number;
  dates: string[];
};

export type TripCommission = {
  /** One line per crew size carried. */
  lines: { crew: 2 | 3; baseSen: number; rateBps: number; amountSen: number }[];
  baseSen: number;
  missedDays: number;
  cutBps: number;
  amountSen: number;
};

export type TripPay = {
  employeeId: number;
  drove: boolean;
  helped: boolean;
  commission: TripCommission;
  lines: TripPayLine[];
  allowanceSen: number;
  totalSen: number;
};

/**
 * Every employee's trip pay for a month's rows. `employeeOf` resolves a row
 * person to an employee (its id when set, else by name); a person it cannot
 * resolve earns nothing here and is listed by the caller.
 */
export function computeTripPay(input: {
  rows: ReadonlyArray<TripRow>;
  rates: TripRates;
  employeeOf: (p: { name: string; employeeId: number | null }) => number | null;
  missedDaysOf: (employeeId: number) => number;
}): Map<number, TripPay> {
  const { rates } = input;
  type Acc = {
    drove: boolean;
    helped: boolean;
    base: { 2: number; 3: number };
    perRow: Map<string, { label: string; unitSen: number; dates: string[] }>;
    perDay: Map<string, { label: string; unitSen: number; days: Set<string> }>;
  };
  const accs = new Map<number, Acc>();
  const acc = (id: number): Acc => {
    let a = accs.get(id);
    if (!a) {
      a = { drove: false, helped: false, base: { 2: 0, 3: 0 }, perRow: new Map(), perDay: new Map() };
      accs.set(id, a);
    }
    return a;
  };
  const addRow = (a: Acc, key: string, label: string, unitSen: number, date: string) => {
    const l = a.perRow.get(key) ?? { label, unitSen, dates: [] };
    l.dates.push(date);
    a.perRow.set(key, l);
  };
  const addDay = (a: Acc, key: string, label: string, unitSen: number, date: string) => {
    const l = a.perDay.get(key) ?? { label, unitSen, days: new Set<string>() };
    l.days.add(date);
    a.perDay.set(key, l);
  };

  for (const row of input.rows) {
    const driverIds = [...new Set(row.drivers.map(input.employeeOf).filter((id): id is number => id != null))];
    const helperIds = [...new Set(row.helpers.map(input.employeeOf).filter((id): id is number => id != null && !driverIds.includes(id)))];
    const crew: 2 | 3 = row.drivers.length + row.helpers.length >= 3 ? 3 : 2;
    const area = areaOfState(row.state);
    for (const id of driverIds) {
      const a = acc(id);
      a.drove = true;
      a.base[crew] += row.localTotalSen;
      if (area) addDay(a, `OUT_${area}`, `Outstation (${OUTSTATION_LABEL[area]})`, rates.driverOutstationSen[area], row.tripDate);
      switch (row.kind) {
        case "DO":
          break;
        case "FAIR":
          addDay(a, "FAIR", TRIP_KIND_LABEL.FAIR, rates.fairSen, row.tripDate);
          break;
        case "FAIR_2BOOTH":
          addDay(a, "FAIR_2BOOTH", TRIP_KIND_LABEL.FAIR_2BOOTH, rates.fair2BoothSen, row.tripDate);
          break;
        case "FAIR_NIGHT":
          addDay(a, row.kind, TRIP_KIND_LABEL[row.kind], rates.fairNightSen, row.tripDate);
          break;
        case "FAIR_NOON":
          addDay(a, row.kind, TRIP_KIND_LABEL[row.kind], rates.fairNoonSen, row.tripDate);
          break;
        case "FAIR_2ND":
          addDay(a, row.kind, TRIP_KIND_LABEL[row.kind], rates.fair2ndSen, row.tripDate);
          break;
        case "SERVICE_DELIVERY":
          addRow(a, row.kind, TRIP_KIND_LABEL[row.kind], rates.serviceDeliverySen, row.tripDate);
          break;
        case "SERVICE_PICKUP":
          addRow(a, row.kind, TRIP_KIND_LABEL[row.kind], rates.servicePickupSen, row.tripDate);
          break;
        case "SERVICE_INSPECTION":
          addRow(a, row.kind, TRIP_KIND_LABEL[row.kind], rates.serviceInspectionSen, row.tripDate);
          break;
        case "SUPPLIER":
          addRow(a, row.kind, TRIP_KIND_LABEL[row.kind], rates.supplierTripSen, row.tripDate);
          break;
        case "SUPPLIER_FULL":
          addRow(a, row.kind, TRIP_KIND_LABEL[row.kind], rates.supplierFullSen, row.tripDate);
          break;
        case "TRANSFER":
          addRow(a, row.kind, TRIP_KIND_LABEL[row.kind], rates.transferSen, row.tripDate);
          break;
        case "NONE":
          break;
      }
    }
    for (const id of helperIds) {
      const a = acc(id);
      a.helped = true;
      if (area) addDay(a, `TRANSPORT_${area}`, `Transport (${OUTSTATION_LABEL[area]})`, rates.helperTransportSen[area], row.tripDate);
    }
  }

  const out = new Map<number, TripPay>();
  for (const [id, a] of accs) {
    const missedDays = a.drove ? Math.max(0, Math.floor(input.missedDaysOf(id))) : 0;
    const cutBps = leaveCutFor(missedDays, rates);
    const commissionLines = ([3, 2] as const)
      .filter((crew) => a.base[crew] > 0)
      .map((crew) => {
        const rateBps = Math.max(0, (crew === 3 ? rates.commission3Bps : rates.commission2Bps) - cutBps);
        return { crew, baseSen: a.base[crew], rateBps, amountSen: (a.base[crew] * rateBps) / 10000 };
      });
    const commissionSen = Math.round(commissionLines.reduce((s, l) => s + l.amountSen, 0));
    const lines: TripPayLine[] = [
      ...[...a.perDay.entries()].map(([key, l]) => {
        const dates = [...l.days].sort();
        return { key, label: l.label, count: dates.length, unitSen: l.unitSen, amountSen: dates.length * l.unitSen, dates };
      }),
      ...[...a.perRow.entries()].map(([key, l]) => {
        const dates = [...l.dates].sort();
        return { key, label: l.label, count: dates.length, unitSen: l.unitSen, amountSen: dates.length * l.unitSen, dates };
      }),
    ]
      .filter((l) => l.amountSen > 0)
      .sort((x, y) => x.key.localeCompare(y.key));
    const allowanceSen = lines.reduce((s, l) => s + l.amountSen, 0);
    out.set(id, {
      employeeId: id,
      drove: a.drove,
      helped: a.helped,
      commission: {
        lines: commissionLines.map((l) => ({ ...l, amountSen: Math.round(l.amountSen) })),
        baseSen: a.base[2] + a.base[3],
        missedDays,
        cutBps,
        amountSen: commissionSen,
      },
      lines,
      allowanceSen,
      totalSen: commissionSen + allowanceSen,
    });
  }
  return out;
}

/** Working days (Mon-Sat, not a holiday) in [from, to] with no logged hours and no leave: the days that cut a driver's commission. */
export function missedWorkingDays(input: {
  from: string;
  to: string;
  workedDates: ReadonlySet<string>;
  leaveDates: ReadonlySet<string>;
  holidays: ReadonlySet<string>;
}): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${input.from}T00:00:00Z`); t <= Date.parse(`${input.to}T00:00:00Z`); t += 86400000) {
    const ymd = new Date(t).toISOString().slice(0, 10);
    if (new Date(t).getUTCDay() === 0 || input.holidays.has(ymd)) continue;
    if (input.workedDates.has(ymd) || input.leaveDates.has(ymd)) continue;
    out.push(ymd);
  }
  return out;
}
