/* Trip pay: the driver's monthly commission and the trip allowances of
 * drivers and helpers.
 *
 * The rules (owner-approved redesign, 2026-11-17):
 *   - the trip month runs from the 23rd of the previous month to the 22nd and
 *     is paid on that month's payslip;
 *   - commission: a driver earns a % of the Local Total of every Delivery
 *     order carried, one % for a 2-person crew and one for a 3-person crew; a
 *     working day with no punch and no leave cuts the rate by percentage
 *     points, cumulatively (1st day, 2nd day, ..., then "each later day");
 *   - allowance per job: the driver earns the rate of the row's job type
 *     (Delivery Planning's own job types; Setup / Dismantle also by event type,
 *     Exhibition or Roadshow). A second Setup / Dismantle trip of the same
 *     driver and lorry on the same day, or a second venue on the same trip,
 *     pays the 2nd-trip rate;
 *   - outstation: once per person per day, the farthest (highest-priced) state
 *     group reached that day; states in no group are the home area;
 *   - overnight: once per night, the highest clock-out tier reached, for the
 *     job types ticked, optionally only when the shift lasted over N hours.
 * Every amount is an effective-dated rate HR can change.
 *
 * A rates version saved before the redesign (no `schema: 2`) keeps computing
 * exactly as it did: it is normalized into the new shape for display, and its
 * original values ride along in `legacy`, which computeTripMonth runs through
 * the old rules unchanged (computeLegacyTripPay below).
 *
 * ONE home. backend/src/scm/shared/hr-trip-pay.ts is the original and
 * frontend/src/vendor/shared/hr-trip-pay.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */

/* ── Job types: Delivery Planning's own (DP_ENTRY_MENU), plus No allowance ── */

export const TRIP_JOB_TYPES = [
  "DELIVERY_ORDER",
  "SETUP",
  "DISMANTLE",
  "SUPPLIER",
  "TRANSFER",
  "LORRY_SERVICE",
  "ASSR_INSPECTION",
  "ASSR_PICKUP",
  "ASSR_SERVICE",
  "NONE",
] as const;
export type TripJobType = (typeof TRIP_JOB_TYPES)[number];

export const TRIP_JOB_LABEL: Record<TripJobType, string> = {
  DELIVERY_ORDER: "Delivery order",
  SETUP: "Setup",
  DISMANTLE: "Dismantle",
  SUPPLIER: "Supplier",
  TRANSFER: "Transfer item",
  LORRY_SERVICE: "Lorry service",
  ASSR_INSPECTION: "ASSR - Inspection",
  ASSR_PICKUP: "ASSR - Pickup",
  ASSR_SERVICE: "ASSR - Service",
  NONE: "No allowance",
};

/** The job types whose allowance also depends on the project's event type, and which can be a 2nd trip. */
export const isFairJob = (j: TripJobType): boolean => j === "SETUP" || j === "DISMANTLE";

export const TRIP_EVENT_TYPES = ["EXHIBITION", "ROADSHOW"] as const;
export type TripEventType = (typeof TRIP_EVENT_TYPES)[number];
export const TRIP_EVENT_LABEL: Record<TripEventType, string> = { EXHIBITION: "Exhibition", ROADSHOW: "Roadshow" };

/** A project's event type (project_event_types slug / name) as trip pay reads it:
 *  a solo event is a roadshow, every other event an exhibition; none = unknown. */
export function eventTypeOf(slug: string | null | undefined, name: string | null | undefined): TripEventType | null {
  const s = `${slug ?? ""} ${name ?? ""}`.trim().toLowerCase();
  if (!s) return null;
  return /solo|roadshow|road show/.test(s) ? "ROADSHOW" : "EXHIBITION";
}

/* ── States ─────────────────────────────────────────────────────────────── */

export const TRIP_STATES = [
  "Johor",
  "Kedah",
  "Kelantan",
  "Kuala Lumpur",
  "Labuan",
  "Melaka",
  "Negeri Sembilan",
  "Pahang",
  "Perak",
  "Perlis",
  "Pulau Pinang",
  "Putrajaya",
  "Sabah",
  "Sarawak",
  "Selangor",
  "Terengganu",
] as const;

const STATE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Kuala Lumpur", /kuala lumpur|^kl$|^w\.? ?p\.? ?kl$/],
  ["Putrajaya", /putrajaya/],
  ["Labuan", /labuan/],
  ["Johor", /johor/],
  ["Kedah", /kedah/],
  ["Kelantan", /kelantan/],
  ["Melaka", /melaka|malacca/],
  ["Negeri Sembilan", /negeri sembilan|n\.? ?sembilan|^n\.? ?s\.?$|seremban/],
  ["Pahang", /pahang/],
  ["Perak", /perak|ipoh/],
  ["Perlis", /perlis/],
  ["Pulau Pinang", /pinang|penang/],
  ["Sabah", /sabah/],
  ["Sarawak", /sarawak/],
  ["Selangor", /selangor/],
  ["Terengganu", /terengganu|trengganu/],
];

/** The canonical state of a free-text state ("PENANG" -> "Pulau Pinang"), or "" when it is not a Malaysian state. */
export function tripStateOf(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  for (const [name, re] of STATE_PATTERNS) if (re.test(s)) return name;
  return "";
}

/* ── Rates (schema 2) ───────────────────────────────────────────────────── */

export type TripJobAllowance = {
  jobType: TripJobType;
  /** Only for Setup / Dismantle; null for every other job type. */
  eventType: TripEventType | null;
  perTripSen: number;
  /** Setup / Dismantle 2nd trip of the day; null = same as per trip. */
  secondTripSen: number | null;
};
export type TripOutstationGroup = { states: string[]; driverSen: number; helperSen: number };
/** Clock-out after `after` (HH:MM, 22:00 to 04:00). */
export type TripOvernightTier = { after: string; driverSen: number; helperSen: number };

export type TripRates = {
  schema: 2;
  /** Commission in basis points (40 = 0.40%) of a Delivery order's Local Total. */
  commission2Bps: number;
  commission3Bps: number;
  /** Rate cut, in basis points (5 = 0.05 percentage points), for the 1st, 2nd, 3rd... missed working day; each later day cuts leaveCutAfterBps. Cuts add up. */
  leaveCutBps: number[];
  leaveCutAfterBps: number;
  jobAllowances: TripJobAllowance[];
  outstation: TripOutstationGroup[];
  overnight: {
    tiers: TripOvernightTier[];
    /** Only a night after a day on which the person ran one of these; empty = every night, trip or not. */
    jobTypes: TripJobType[];
    /** Only when the shift lasted over this many hours; 0 = no condition. */
    minHours: number;
  };
  /** Set only for a version saved before the redesign: it is computed by the old rules, exactly as before. Never saved. */
  legacy: LegacyTripRates | null;
};

const fair = (jobType: "SETUP" | "DISMANTLE", eventType: TripEventType, perTripSen: number, secondTripSen: number | null): TripJobAllowance => ({ jobType, eventType, perTripSen, secondTripSen });

export const DEFAULT_TRIP_RATES: TripRates = {
  schema: 2,
  commission2Bps: 50,
  commission3Bps: 40,
  leaveCutBps: [5, 5, 10],
  leaveCutAfterBps: 10,
  jobAllowances: [
    fair("SETUP", "EXHIBITION", 10000, 13500),
    fair("SETUP", "ROADSHOW", 10000, 13500),
    fair("DISMANTLE", "EXHIBITION", 10000, 13500),
    fair("DISMANTLE", "ROADSHOW", 10000, 13500),
    { jobType: "SUPPLIER", eventType: null, perTripSen: 1500, secondTripSen: null },
    { jobType: "TRANSFER", eventType: null, perTripSen: 1500, secondTripSen: null },
    { jobType: "ASSR_INSPECTION", eventType: null, perTripSen: 1500, secondTripSen: null },
    { jobType: "ASSR_PICKUP", eventType: null, perTripSen: 1500, secondTripSen: null },
    { jobType: "ASSR_SERVICE", eventType: null, perTripSen: 1500, secondTripSen: null },
  ],
  outstation: [
    { states: ["Melaka", "Negeri Sembilan", "Perak"], driverSen: 3000, helperSen: 3000 },
    { states: ["Johor", "Pulau Pinang"], driverSen: 8000, helperSen: 8000 },
    { states: ["Terengganu", "Pahang"], driverSen: 12000, helperSen: 12000 },
    { states: ["Kelantan"], driverSen: 15000, helperSen: 15000 },
  ],
  overnight: { tiers: [{ after: "00:00", driverSen: 5000, helperSen: 5000 }], jobTypes: [], minHours: 8 },
  legacy: null,
};

const wholeOr = (v: unknown, d: number): number => {
  const n = Number(v);
  return v !== null && v !== "" && v !== undefined && typeof v !== "boolean" && Number.isFinite(n) && n >= 0 ? Math.round(n) : d;
};
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after noon of a night time: 22:00 = 600, 00:00 = 720, 04:00 = 960. */
export function nightMinutes(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) return -1;
  return (Number(m[1]) * 60 + Number(m[2]) - 720 + 1440) % 1440;
}

/** Coerce a half-trusted stored object onto the new shape. A version saved
 *  before the redesign (no `schema: 2`) is converted for display and keeps its
 *  original values in `legacy`, so it computes exactly as before. */
export function normalizeTripRates(raw: unknown): TripRates {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.schema !== 2) return tripRatesFromLegacy(normalizeLegacyTripRates(raw));
  const D = DEFAULT_TRIP_RATES;
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
  const cuts = Array.isArray(r.leaveCutBps) ? r.leaveCutBps.map((v) => wholeOr(v, -1)).filter((v) => v >= 0) : D.leaveCutBps;
  const jobAllowances = list(r.jobAllowances)
    .filter((a) => TRIP_JOB_TYPES.includes(a.jobType as TripJobType))
    .map((a) => {
      const jobType = a.jobType as TripJobType;
      const ev = TRIP_EVENT_TYPES.includes(a.eventType as TripEventType) ? (a.eventType as TripEventType) : null;
      const second = a.secondTripSen === null || a.secondTripSen === undefined || a.secondTripSen === "" ? null : wholeOr(a.secondTripSen, -1);
      return { jobType, eventType: isFairJob(jobType) ? ev : null, perTripSen: wholeOr(a.perTripSen, 0), secondTripSen: second != null && second >= 0 ? second : null };
    });
  const outstation = list(r.outstation).map((g) => ({
    states: Array.isArray(g.states) ? [...new Set(g.states.map((s) => tripStateOf(String(s))).filter(Boolean))] : [],
    driverSen: wholeOr(g.driverSen, 0),
    helperSen: wholeOr(g.helperSen, 0),
  }));
  const on = (r.overnight ?? {}) as Record<string, unknown>;
  const tiers = list(on.tiers)
    .filter((t) => typeof t.after === "string" && HHMM.test(t.after))
    .map((t) => ({ after: t.after as string, driverSen: wholeOr(t.driverSen, 0), helperSen: wholeOr(t.helperSen, 0) }));
  const jobTypes = Array.isArray(on.jobTypes) ? [...new Set(on.jobTypes.filter((j): j is TripJobType => TRIP_JOB_TYPES.includes(j as TripJobType)))] : [];
  return {
    schema: 2,
    commission2Bps: wholeOr(r.commission2Bps, D.commission2Bps),
    commission3Bps: wholeOr(r.commission3Bps, D.commission3Bps),
    leaveCutBps: cuts,
    leaveCutAfterBps: wholeOr(r.leaveCutAfterBps, D.leaveCutAfterBps),
    jobAllowances,
    outstation,
    overnight: { tiers, jobTypes, minHours: Math.min(24, wholeOr(on.minHours, 0)) },
    legacy: null,
  };
}

/** Why a rates snapshot cannot be saved, or null when it can. */
export function tripRatesProblem(r: TripRates): string | null {
  if (r.commission2Bps > 1000 || r.commission3Bps > 1000) return "Commission is at most 10%.";
  if (r.leaveCutBps.length > 31) return "List the cut for at most 31 days.";
  const seen = new Set<string>();
  for (const a of r.jobAllowances) {
    if (a.jobType === "NONE") return "\"No allowance\" pays nothing; remove its row.";
    if (isFairJob(a.jobType) && !a.eventType) return `${TRIP_JOB_LABEL[a.jobType]}: pick Exhibition or Roadshow.`;
    const key = `${a.jobType}|${a.eventType ?? ""}`;
    if (seen.has(key)) return `${TRIP_JOB_LABEL[a.jobType]}${a.eventType ? ` (${TRIP_EVENT_LABEL[a.eventType]})` : ""} is listed twice.`;
    seen.add(key);
  }
  const owner = new Map<string, number>();
  for (const [i, g] of r.outstation.entries()) {
    if (!g.states.length) return `Outstation group ${i + 1} has no state.`;
    for (const s of g.states) {
      if (!(TRIP_STATES as readonly string[]).includes(s)) return `${s} is not a state.`;
      const had = owner.get(s);
      if (had != null && had !== i) return `${s} is in two outstation groups.`;
      owner.set(s, i);
    }
  }
  const afters = new Set<string>();
  for (const t of r.overnight.tiers) {
    const m = nightMinutes(t.after);
    if (m < 600 || m > 960) return `Overnight: ${t.after} is not between 22:00 and 04:00.`;
    if (afters.has(t.after)) return `Overnight: ${t.after} is listed twice.`;
    afters.add(t.after);
  }
  if (r.overnight.minHours > 24) return "Overnight: at most 24 hours.";
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

/** The allowance a driver earns for one job: the exact job type + event type,
 *  else (Setup / Dismantle with an unknown event) the Exhibition rate, else the
 *  job type's first row. Null when the job type has no rate. */
export function jobAllowanceFor(rates: Pick<TripRates, "jobAllowances">, jobType: TripJobType, eventType: TripEventType | null): TripJobAllowance | null {
  if (jobType === "NONE") return null;
  const of = rates.jobAllowances.filter((a) => a.jobType === jobType);
  if (!isFairJob(jobType)) return of.length ? of[0] : null;
  return of.find((a) => a.eventType === (eventType ?? "EXHIBITION")) ?? (of.length ? of[0] : null);
}

/** The states no outstation group lists: the home area. */
export function homeAreaStates(rates: Pick<TripRates, "outstation">): string[] {
  const used = new Set(rates.outstation.flatMap((g) => g.states));
  return TRIP_STATES.filter((s) => !used.has(s));
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

/* ── Rows ───────────────────────────────────────────────────────────────── */

/** The kinds a row carried before the redesign; still stored (hr_trip_rows.kind) and read by the legacy rules. */
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

/** The job type an old kind reads as. A fair is a Dismantle when its Doc No. says so, else a Setup. */
export function jobTypeOfKind(kind: TripKind, docNo: string, refNo: string): TripJobType {
  switch (kind) {
    case "DO":
      return "DELIVERY_ORDER";
    case "FAIR":
    case "FAIR_NIGHT":
    case "FAIR_NOON":
    case "FAIR_2ND":
    case "FAIR_2BOOTH":
      return /DISMANTLE/i.test(docNo) || (!/SETUP/i.test(docNo) && /DISMANTLE/i.test(refNo) && !/SETUP/i.test(refNo)) ? "DISMANTLE" : "SETUP";
    case "SERVICE_DELIVERY":
      return "ASSR_SERVICE";
    case "SERVICE_PICKUP":
      return "ASSR_PICKUP";
    case "SERVICE_INSPECTION":
      return "ASSR_INSPECTION";
    case "SUPPLIER":
    case "SUPPLIER_FULL":
      return "SUPPLIER";
    case "TRANSFER":
      return "TRANSFER";
    case "NONE":
      return /LORRY SERVICE/i.test(`${docNo} ${refNo}`) ? "LORRY_SERVICE" : "NONE";
  }
}

/** The old kind a job type is stored as (hr_trip_rows.kind), for the legacy rules. */
export function kindOfJobType(j: TripJobType): TripKind {
  const map: Record<TripJobType, TripKind> = {
    DELIVERY_ORDER: "DO",
    SETUP: "FAIR",
    DISMANTLE: "FAIR",
    SUPPLIER: "SUPPLIER",
    TRANSFER: "TRANSFER",
    LORRY_SERVICE: "NONE",
    ASSR_INSPECTION: "SERVICE_INSPECTION",
    ASSR_PICKUP: "SERVICE_PICKUP",
    ASSR_SERVICE: "SERVICE_DELIVERY",
    NONE: "NONE",
  };
  return map[j];
}

export type TripRow = {
  tripDate: string;
  docNo: string;
  transferTo: string;
  refNo: string;
  /** The old kind, read by a pre-redesign rates version. */
  kind: TripKind;
  jobType: TripJobType;
  /** Setup / Dismantle only: the project's event type; null = unknown (pays the Exhibition rate). */
  eventType: TripEventType | null;
  localTotalSen: number;
  state: string;
  postcode: string;
  lorryPlate: string;
  /** The lorry run the row rode (Delivery Planning trip id); "" when unknown. */
  tripRef: string;
  /** The venue / project the row served; "" = the Doc No. stands for it. */
  venueKey: string;
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
    const kind = kindFromSheet(docNo, transferTo, refNo, amount != null);
    const jobType = jobTypeOfKind(kind, docNo, refNo);
    rows.push({
      tripDate,
      docNo,
      transferTo,
      refNo,
      kind,
      jobType,
      eventType: isFairJob(jobType) && /\bSOLO\b|ROADSHOW/i.test(docNo) ? "ROADSHOW" : null,
      localTotalSen: amount ?? 0,
      state: c[5] ?? "",
      postcode: "",
      lorryPlate: c[6] ?? "",
      tripRef: "",
      venueKey: "",
      drivers: [person(c[7])].filter((p) => p.name),
      helpers: [person(c[8]), person(c[9])].filter((p) => p.name),
    });
  });
  return { rows, skipped };
}

/** Upper-case, single-spaced: how names and aliases are compared. */
export const normName = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

/* ── The month's pay per person ──────────────────────────────────────────── */

export type TripLineCategory = "JOB" | "OUTSTATION" | "OVERNIGHT";
/** One job / day behind a pay line, for the person drawer. */
export type TripLineItem = { date: string; docNo: string; job: string; state: string; amountSen: number };

export type TripPayLine = {
  key: string;
  label: string;
  category: TripLineCategory;
  count: number;
  unitSen: number;
  amountSen: number;
  dates: string[];
  /** What each count was; empty under a pre-redesign rates version. */
  items: TripLineItem[];
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
  /** Every allowance line: job + outstation + overnight. */
  allowanceSen: number;
  jobAllowanceSen: number;
  outstationSen: number;
  overnightSen: number;
  totalSen: number;
};

/** What one row earned, the whole crew together; tripOfDay is set for Setup / Dismantle only. */
export type TripRowPay = { tripOfDay: 1 | 2 | null; sameJob: boolean; allowanceSen: number; outstationSen: number; overnightSen: number };

export type TripPunch = { workDate: string; inAt: string | null; outAt: string | null };

export type TripMonthInput = {
  rows: ReadonlyArray<TripRow>;
  rates: TripRates;
  employeeOf: (p: { name: string; employeeId: number | null }) => number | null;
  missedDaysOf: (employeeId: number) => number;
  /** Each employee's punches with a clock-out, for the overnight allowance. */
  punches: ReadonlyMap<number, readonly TripPunch[]>;
};

/**
 * Every employee's trip pay for a month's rows, and what each row earned.
 * `employeeOf` resolves a row person to an employee (its id when set, else by
 * name); a person it cannot resolve earns nothing here and is listed by the caller.
 */
export function computeTripMonth(input: TripMonthInput): { pay: Map<number, TripPay>; rows: TripRowPay[] } {
  const blankRows = (): TripRowPay[] => input.rows.map(() => ({ tripOfDay: null, sameJob: false, allowanceSen: 0, outstationSen: 0, overnightSen: 0 }));
  if (input.rates.legacy) {
    const overnight = new Map<number, string[]>();
    for (const [id, list] of input.punches) {
      const d = overnightDates(list, input.rates.legacy.overnightMinHours);
      if (d.length) overnight.set(id, d);
    }
    return { pay: computeLegacyTripPay({ rows: input.rows, rates: input.rates.legacy, employeeOf: input.employeeOf, missedDaysOf: input.missedDaysOf, overnight }), rows: blankRows() };
  }
  const { rates } = input;
  const rowPay = blankRows();
  type Line = { label: string; category: TripLineCategory; unitSen: number; items: TripLineItem[] };
  type Acc = { drove: boolean; helped: boolean; base: { 2: number; 3: number }; lines: Map<string, Line> };
  const accs = new Map<number, Acc>();
  const acc = (id: number): Acc => {
    let a = accs.get(id);
    if (!a) {
      a = { drove: false, helped: false, base: { 2: 0, 3: 0 }, lines: new Map() };
      accs.set(id, a);
    }
    return a;
  };
  const add = (a: Acc, key: string, label: string, category: TripLineCategory, item: TripLineItem) => {
    const l = a.lines.get(key) ?? { label, category, unitSen: item.amountSen, items: [] };
    l.items.push(item);
    a.lines.set(key, l);
  };
  const jobName = (r: TripRow, tripOfDay: 1 | 2 | null) =>
    [TRIP_JOB_LABEL[r.jobType], isFairJob(r.jobType) ? TRIP_EVENT_LABEL[r.eventType ?? "EXHIBITION"] : null, tripOfDay === 2 ? "2nd trip" : null].filter(Boolean).join(" · ");

  const resolved = input.rows.map((row) => {
    const driverIds = [...new Set(row.drivers.map(input.employeeOf).filter((id): id is number => id != null))];
    const helperIds = [...new Set(row.helpers.map(input.employeeOf).filter((id): id is number => id != null && !driverIds.includes(id)))];
    return { driverIds, helperIds, crew: (row.drivers.length + row.helpers.length >= 3 ? 3 : 2) as 2 | 3, state: tripStateOf(row.state) };
  });

  /* 2nd trip: per driver + lorry + day, each distinct (lorry run, venue) of a Setup / Dismantle is a trip; the first pays the per-trip rate, every later one the 2nd-trip rate. The same run and venue again is the same job. */
  const seenUnits = new Map<string, Map<string, 1 | 2>>();
  input.rows.forEach((row, i) => {
    if (!isFairJob(row.jobType)) return;
    const who = resolved[i].driverIds.length ? `#${resolved[i].driverIds[0]}` : normName(row.drivers.length ? row.drivers[0].name : "");
    const dayKey = `${who}|${normName(row.lorryPlate)}|${row.tripDate}`;
    const units = seenUnits.get(dayKey) ?? new Map<string, 1 | 2>();
    seenUnits.set(dayKey, units);
    const unit = `${row.tripRef}|${row.venueKey || normName(row.docNo)}`;
    const had = units.get(unit);
    if (had) {
      rowPay[i].tripOfDay = had;
      rowPay[i].sameJob = true;
      return;
    }
    const ord: 1 | 2 = units.size === 0 ? 1 : 2;
    units.set(unit, ord);
    rowPay[i].tripOfDay = ord;
  });

  /* Commission and the allowance per job. */
  input.rows.forEach((row, i) => {
    const { driverIds, helperIds, crew, state } = resolved[i];
    for (const id of helperIds) acc(id).helped = true;
    for (const id of driverIds) {
      const a = acc(id);
      a.drove = true;
      if (row.jobType === "DELIVERY_ORDER") a.base[crew] += row.localTotalSen;
    }
    if (rowPay[i].sameJob) return;
    const rate = jobAllowanceFor(rates, row.jobType, row.eventType);
    if (!rate) return;
    const second = rowPay[i].tripOfDay === 2;
    const unit = second ? (rate.secondTripSen ?? rate.perTripSen) : rate.perTripSen;
    if (unit <= 0) return;
    const key = `JOB_${row.jobType}${isFairJob(row.jobType) ? `_${row.eventType ?? "EXHIBITION"}_${second ? 2 : 1}` : ""}`;
    for (const id of driverIds) {
      add(acc(id), key, jobName(row, rowPay[i].tripOfDay), "JOB", { date: row.tripDate, docNo: row.docNo, job: jobName(row, rowPay[i].tripOfDay), state, amountSen: unit });
      rowPay[i].allowanceSen += unit;
    }
  });

  /* Per person per day: the rows they were on, as driver or helper. */
  type DayRow = { i: number; role: "D" | "H" };
  const days = new Map<number, Map<string, DayRow[]>>();
  input.rows.forEach((row, i) => {
    const put = (id: number, role: "D" | "H") => {
      const m = days.get(id) ?? new Map<string, DayRow[]>();
      days.set(id, m);
      m.set(row.tripDate, [...(m.get(row.tripDate) ?? []), { i, role }]);
    };
    resolved[i].driverIds.forEach((id) => put(id, "D"));
    resolved[i].helperIds.forEach((id) => put(id, "H"));
  });

  /* Outstation: once per person per day, the highest-priced group reached. */
  const groupOf = new Map<string, number>();
  rates.outstation.forEach((g, gi) => g.states.forEach((s) => groupOf.set(s, gi)));
  for (const [id, byDay] of days) {
    for (const [date, list] of byDay) {
      let best: { gi: number; role: "D" | "H"; sen: number; i: number } | null = null;
      for (const { i, role } of list) {
        if (input.rows[i].jobType === "NONE") continue;
        const gi = groupOf.get(resolved[i].state);
        if (gi == null) continue;
        const g = rates.outstation[gi];
        const sen = role === "D" ? g.driverSen : g.helperSen;
        if (sen > 0 && (!best || sen > best.sen)) best = { gi, role, sen, i };
      }
      if (!best) continue;
      const g = rates.outstation[best.gi];
      const row = input.rows[best.i];
      add(acc(id), `OUT_${best.gi}_${best.role}`, `Outstation (${g.states.join(", ")})${best.role === "H" ? ", helper" : ""}`, "OUTSTATION", {
        date,
        docNo: row.docNo,
        job: jobName(row, rowPay[best.i].tripOfDay),
        state: resolved[best.i].state,
        amountSen: best.sen,
      });
      rowPay[best.i].outstationSen += best.sen;
    }
  }

  /* Overnight: once per night, the highest tier the clock-out reached. */
  const tiers = rates.overnight.tiers.map((t) => ({ ...t, at: nightMinutes(t.after) })).sort((x, y) => y.at - x.at);
  for (const [id, list] of input.punches) {
    const nights = new Map<string, (typeof tiers)[number]>();
    for (const p of list) {
      if (!p.inAt || !p.outAt) continue;
      const span = Date.parse(p.outAt) - Date.parse(p.inAt);
      if (rates.overnight.minHours > 0 && !(span > rates.overnight.minHours * 3600000)) continue;
      const sinceNoon = (Date.parse(p.outAt) - Date.parse(`${p.workDate}T12:00:00+08:00`)) / 60000;
      const tier = tiers.find((t) => sinceNoon >= t.at);
      const had = nights.get(p.workDate);
      if (tier && (!had || tier.at > had.at)) nights.set(p.workDate, tier);
    }
    for (const [date, tier] of nights) {
      const dayRows = days.get(id)?.get(date) ?? [];
      const ticked = rates.overnight.jobTypes;
      const qualifying = ticked.length ? dayRows.filter((d) => ticked.includes(input.rows[d.i].jobType)) : dayRows;
      if (ticked.length && !qualifying.length) continue;
      const a = acc(id);
      const role: "D" | "H" = qualifying.some((d) => d.role === "D") ? "D" : qualifying.length ? "H" : a.drove ? "D" : "H";
      const sen = role === "D" ? tier.driverSen : tier.helperSen;
      if (sen <= 0) continue;
      const first = qualifying.length ? qualifying[0] : null;
      const row = first ? input.rows[first.i] : null;
      add(a, `NIGHT_${tier.after}_${role}`, `Overnight (clock-out after ${tier.after})${role === "H" ? ", helper" : ""}`, "OVERNIGHT", {
        date,
        docNo: row?.docNo ?? "",
        job: row ? jobName(row, rowPay[first.i].tripOfDay) : "",
        state: first ? resolved[first.i].state : "",
        amountSen: sen,
      });
      if (first) rowPay[first.i].overnightSen += sen;
    }
  }

  const out = new Map<number, TripPay>();
  for (const [id, a] of accs) {
    const commission = commissionOf(a.drove, a.base, id, input.missedDaysOf, rates);
    const lines: TripPayLine[] = [...a.lines.entries()]
      .map(([key, l]) => {
        const items = [...l.items].sort((x, y) => x.date.localeCompare(y.date));
        const amountSen = items.reduce((s, it) => s + it.amountSen, 0);
        return { key, label: l.label, category: l.category, count: items.length, unitSen: l.unitSen, amountSen, dates: items.map((it) => it.date), items };
      })
      .filter((l) => l.amountSen > 0)
      .sort((x, y) => x.key.localeCompare(y.key));
    const sum = (c: TripLineCategory) => lines.filter((l) => l.category === c).reduce((s, l) => s + l.amountSen, 0);
    const allowanceSen = lines.reduce((s, l) => s + l.amountSen, 0);
    out.set(id, {
      employeeId: id,
      drove: a.drove,
      helped: a.helped,
      commission,
      lines,
      allowanceSen,
      jobAllowanceSen: sum("JOB"),
      outstationSen: sum("OUTSTATION"),
      overnightSen: sum("OVERNIGHT"),
      totalSen: commission.amountSen + allowanceSen,
    });
  }
  return { pay: out, rows: rowPay };
}

/** Every employee's trip pay for a month's rows (computeTripMonth without the per-row view). */
export function computeTripPay(input: TripMonthInput): Map<number, TripPay> {
  return computeTripMonth(input).pay;
}

function commissionOf(
  drove: boolean,
  base: { 2: number; 3: number },
  id: number,
  missedDaysOf: (employeeId: number) => number,
  rates: Pick<TripRates, "commission2Bps" | "commission3Bps" | "leaveCutBps" | "leaveCutAfterBps">,
): TripCommission {
  const missedDays = drove ? Math.max(0, Math.floor(missedDaysOf(id))) : 0;
  const cutBps = leaveCutFor(missedDays, rates);
  const lines = ([3, 2] as const)
    .filter((crew) => base[crew] > 0)
    .map((crew) => {
      const rateBps = Math.max(0, (crew === 3 ? rates.commission3Bps : rates.commission2Bps) - cutBps);
      return { crew, baseSen: base[crew], rateBps, amountSen: (base[crew] * rateBps) / 10000 };
    });
  return {
    lines: lines.map((l) => ({ ...l, amountSen: Math.round(l.amountSen) })),
    baseSen: base[2] + base[3],
    missedDays,
    cutBps,
    amountSen: Math.round(lines.reduce((s, l) => s + l.amountSen, 0)),
  };
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

/* ── Before the redesign: the rules of Nico's sheet (2026-10-22) ────────────
 * Kept verbatim so a rates version saved before 2026-11-17 pays exactly what
 * it paid: commission on every row's Local Total; a fair allowance per fair
 * day by sheet code; RM15 a service case, supplier trip or transfer; outstation
 * per day per area; overnight once per punch past midnight lasting over N hours. */

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

export type LegacyTripRates = {
  commission2Bps: number;
  commission3Bps: number;
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
  overnightSen: number;
  overnightMinHours: number;
  driverOutstationSen: Record<OutstationArea, number>;
  helperTransportSen: Record<OutstationArea, number>;
};

export const LEGACY_DEFAULT_TRIP_RATES: LegacyTripRates = {
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
  overnightSen: 5000,
  overnightMinHours: 8,
  driverOutstationSen: { MIS: 3000, JP: 8000, TP: 12000, KEL: 15000 },
  helperTransportSen: { MIS: 3000, JP: 8000, TP: 12000, KEL: 15000 },
};

/** Coerce a stored pre-redesign object onto the old defaults, field by field. */
export function normalizeLegacyTripRates(raw: unknown): LegacyTripRates {
  const r = (raw ?? {}) as Record<string, unknown>;
  const D = LEGACY_DEFAULT_TRIP_RATES;
  const num = (k: Exclude<keyof LegacyTripRates, "leaveCutBps" | "driverOutstationSen" | "helperTransportSen">) => wholeOr(r[k], D[k]);
  const areas = (k: "driverOutstationSen" | "helperTransportSen") => {
    const o = (r[k] ?? {}) as Record<string, unknown>;
    return Object.fromEntries(OUTSTATION_AREAS.map((a) => [a, wholeOr(o[a], D[k][a])])) as Record<OutstationArea, number>;
  };
  const cuts = Array.isArray(r.leaveCutBps) ? r.leaveCutBps.map((v) => wholeOr(v, -1)).filter((v) => v >= 0) : D.leaveCutBps;
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
    overnightSen: num("overnightSen"),
    overnightMinHours: num("overnightMinHours"),
    driverOutstationSen: areas("driverOutstationSen"),
    helperTransportSen: areas("helperTransportSen"),
  };
}

const LEGACY_AREA_STATES: Record<OutstationArea, string[]> = {
  MIS: ["Melaka", "Negeri Sembilan", "Perak"],
  JP: ["Johor", "Pulau Pinang"],
  TP: ["Terengganu", "Pahang"],
  KEL: ["Kelantan"],
};

/** A pre-redesign version in the new shape (what the drawer shows), carrying the original for the old rules. */
export function tripRatesFromLegacy(l: LegacyTripRates): TripRates {
  const flat = (jobType: TripJobType, sen: number): TripJobAllowance => ({ jobType, eventType: null, perTripSen: sen, secondTripSen: null });
  return {
    schema: 2,
    commission2Bps: l.commission2Bps,
    commission3Bps: l.commission3Bps,
    leaveCutBps: [...l.leaveCutBps],
    leaveCutAfterBps: l.leaveCutAfterBps,
    jobAllowances: [
      fair("SETUP", "EXHIBITION", l.fairSen, l.fair2ndSen),
      fair("SETUP", "ROADSHOW", l.fairSen, l.fair2ndSen),
      fair("DISMANTLE", "EXHIBITION", l.fairSen, l.fair2ndSen),
      fair("DISMANTLE", "ROADSHOW", l.fairSen, l.fair2ndSen),
      flat("SUPPLIER", l.supplierTripSen),
      flat("TRANSFER", l.transferSen),
      flat("ASSR_INSPECTION", l.serviceInspectionSen),
      flat("ASSR_PICKUP", l.servicePickupSen),
      flat("ASSR_SERVICE", l.serviceDeliverySen),
    ],
    outstation: OUTSTATION_AREAS.map((a) => ({ states: LEGACY_AREA_STATES[a], driverSen: l.driverOutstationSen[a], helperSen: l.helperTransportSen[a] })),
    overnight: { tiers: [{ after: "00:00", driverSen: l.overnightSen, helperSen: l.overnightSen }], jobTypes: [], minHours: l.overnightMinHours },
    legacy: l,
  };
}

/** Pay under a pre-redesign version: the old rules, unchanged. */
export function computeLegacyTripPay(input: {
  rows: ReadonlyArray<TripRow>;
  rates: LegacyTripRates;
  employeeOf: (p: { name: string; employeeId: number | null }) => number | null;
  missedDaysOf: (employeeId: number) => number;
  /** Each employee's overnight work dates (overnightDates). */
  overnight: ReadonlyMap<number, readonly string[]>;
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
  for (const [id, dates] of input.overnight) {
    const a = acc(id);
    for (const d of dates) addDay(a, "OVERNIGHT", "Overnight", rates.overnightSen, d);
  }

  const categoryOf = (key: string): TripLineCategory => (key === "OVERNIGHT" ? "OVERNIGHT" : /^(OUT|TRANSPORT)_/.test(key) ? "OUTSTATION" : "JOB");
  const out = new Map<number, TripPay>();
  for (const [id, a] of accs) {
    const commission = commissionOf(a.drove, a.base, id, input.missedDaysOf, rates);
    const lines: TripPayLine[] = [
      ...[...a.perDay.entries()].map(([key, l]) => {
        const dates = [...l.days].sort();
        return { key, label: l.label, category: categoryOf(key), count: dates.length, unitSen: l.unitSen, amountSen: dates.length * l.unitSen, dates, items: [] };
      }),
      ...[...a.perRow.entries()].map(([key, l]) => {
        const dates = [...l.dates].sort();
        return { key, label: l.label, category: categoryOf(key), count: dates.length, unitSen: l.unitSen, amountSen: dates.length * l.unitSen, dates, items: [] };
      }),
    ]
      .filter((l) => l.amountSen > 0)
      .sort((x, y) => x.key.localeCompare(y.key));
    const sum = (c: TripLineCategory) => lines.filter((l) => l.category === c).reduce((s, l) => s + l.amountSen, 0);
    const allowanceSen = lines.reduce((s, l) => s + l.amountSen, 0);
    out.set(id, {
      employeeId: id,
      drove: a.drove,
      helped: a.helped,
      commission,
      lines,
      allowanceSen,
      jobAllowanceSen: sum("JOB"),
      outstationSen: sum("OUTSTATION"),
      overnightSen: sum("OVERNIGHT"),
      totalSen: commission.amountSen + allowanceSen,
    });
  }
  return out;
}

/** The work dates whose punch ran past midnight (Malaysia time) and lasted over
 *  minHours: the pre-redesign overnight allowance, once per punch. */
export function overnightDates(punches: ReadonlyArray<TripPunch>, minHours: number): string[] {
  const myt = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10);
  const out: string[] = [];
  for (const p of punches) {
    if (!p.inAt || !p.outAt) continue;
    const span = Date.parse(p.outAt) - Date.parse(p.inAt);
    if (myt(p.outAt) > p.workDate && span > minHours * 3600000) out.push(p.workDate);
  }
  return out.sort();
}
