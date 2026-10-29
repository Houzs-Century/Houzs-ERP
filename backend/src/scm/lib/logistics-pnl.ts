// ----------------------------------------------------------------------------
// logistics-pnl — the Logistics P&L: the owner's own Logistic Cost Report
// ("Sept26 - Logistic & Operation Cost.xlsx", sheet "Logistic - Auto"), built
// from the books instead of typed (owner 2026-10-29, 做: nothing typed by hand —
// 「不要我填」). The months asked for, by the books' four regions. Pure: the route
// (scm/routes/acc-logistics-pnl.ts) reads the rows, this decides;
// scm/lib/logistics-pnl.test.ts pins it.
//
//   INCOME
//     Transport Income — the DOs' value × the company's rate (3% until Finance
//       changes it), each DO in its region.
//     Transport Income (Houzs / The Conts / Hookka / 2990) — what Finance bills
//       EXTRA, on Other Debtor bills (「我额外bill 的就要放过去」; a sales
//       invoice's transport line 「另有用途」 and never counts here): a line on a
//       TRANSPORT INCOME account, in the region the account's name gives; a line
//       worded "LOGISTICS CHARGES" / "TRANSPORT CHARGES" on any other account
//       counts under KL (the 2990 recharges billed before the accounts existed).
//       The row is the company billed; the month the one the line names
//       ("LOGISTICS CHARGES - SEP'26" is September's), else the bill's own.
//     Set/Dismantle Income (in-house) — every fair's setup (its first day) and
//       dismantle (its last day), one trip per venue per day, at its area's rate
//       per trip (Finance keeps the rates — 「我要自己能维护」). A trip an
//       outsourced bill covers is not ours; Finance may untick or tick any trip.
//   EXPENSE
//     Outsource — the transport accounts, by the region their names give
//       (900-T005 Penang, T006 KL, T007 / T017–T026 / T036 SBH & SWK, T015 /
//       T027–T029 / T034 SGD); the fair-transport accounts are the fairs' own.
//     In-house — in the KL column, as the owner's sheet keeps it:
//       petrol — the own-lorry accounts naming petrol / toll / parking;
//       upkeep — those naming upkeep / repair, each bill spread over the months
//         Finance gives it (「根据情况定的，这个我可以自己定」 — its own month until then);
//       lorry instalment — what was paid on the HP creditor of one of our lorries;
//       road tax & insurance — spread like upkeep, 12 months until Finance says otherwise;
//       manpower — the salary journal's OPERATION DELIVERY (drivers) and
//         OPERATION HELPER lines (「进salary 时有分driver和helper」).
// ----------------------------------------------------------------------------

import { REGIONS, normalisePlate, share, monthOf, type ChartAccount, type LogisticsLorry, type RegionCode } from './logistics-cost';

export type RegionSen = Record<RegionCode, number>;
const zero = (): RegionSen => ({ PG: 0, KL: 0, EM: 0, SG: 0 });
const total = (r: RegionSen): number => r.PG + r.KL + r.EM + r.SG;
const upper = (s: string | null | undefined): string => String(s ?? '').toUpperCase().trim();

/* ── Months ───────────────────────────────────────────────────────────────── */
export function addMonths(month: string, n: number): string {
  const i = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) out.push(m);
  return out;
}

const MONTH_WORD = /\b(JANUARY|JAN|FEBRUARY|FEB|MARCH|MAR|APRIL|APR|MAY|JUNE|JUN|JULY|JUL|AUGUST|AUG|SEPTEMBER|SEPT|SEP|OCTOBER|OCT|NOVEMBER|NOV|DECEMBER|DEC)\.?\s*['’`]?\s*(\d{4}|\d{2})\b/i;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The month a line names — "LOGISTICS CHARGES - SEP'26" → 2026-09; null when it names none. */
export function monthNamed(text: string | null | undefined): string | null {
  const m = MONTH_WORD.exec(String(text ?? ''));
  if (!m) return null;
  const idx = MONTHS.indexOf(m[1]!.toUpperCase().slice(0, 3));
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return `${year}-${String(idx + 1).padStart(2, '0')}`;
}

/* ── The accounts, by what their names say ────────────────────────────────── */
/** An outsourced-transport account's region, or null when it is not one (fair transport is the fairs'). */
export function outsourceRegionOf(name: string | null | undefined): RegionCode | null {
  const n = upper(name);
  if (/^TRANSPORT\s*\(\s*(PNG|PENANG)\b/.test(n)) return 'PG';
  if (/^TRANSPORT\s*\(\s*KL\b/.test(n)) return 'KL';
  if (/^TRANSPORT\s*\(\s*(SABAH|SBH)\b/.test(n)) return 'EM';
  if (/^TRANSPORT\s*(\(\s*)?SGD\b/.test(n)) return 'SG';
  return null;
}

/** A transport income account's region (KL when its name names none), or null when it is not one. */
export function transportIncomeRegionOf(name: string | null | undefined): RegionCode | null {
  const n = upper(name);
  if (!/\bTRANSPORT\s+INCOME\b/.test(n)) return null;
  if (/\((PNG|PENANG)\b/.test(n)) return 'PG';
  if (/\(\s*(SABAH|SBH|SARAWAK|SWK)\b/.test(n)) return 'EM';
  if (/\bSGD\b|\bSINGAPORE\b/.test(n)) return 'SG';
  return 'KL';
}

/** A bill line worded as a transport recharge, on whatever account. */
export const isRechargeWording = (text: string | null | undefined): boolean =>
  /^\s*(LOGISTICS?|TRANSPORT(ATION)?)\s+(CHARGES?|FEES?|INCOME)\b/i.test(String(text ?? ''));

export type OwnCostKind = 'petrol' | 'upkeep' | 'other';
/** Which in-house row one of the own-lorry accounts feeds. */
export function ownCostKindOf(name: string | null | undefined): OwnCostKind {
  const n = upper(name);
  if (/PETROL|FUEL|DIESEL|\bTOLL?\b|PARKING/.test(n)) return 'petrol';
  if (/UPKEEP|REPAIR|SERVICE|MAINTEN|TYRE|TIRE/.test(n)) return 'upkeep';
  return 'other';
}

const isExpense = (a: ChartAccount) => upper(a.account_type) === 'EXPENSE' && a.is_active !== false;

/** Insurance & road tax: the expense accounts naming road tax. */
export const roadTaxAccounts = (chart: readonly ChartAccount[]): string[] =>
  chart.filter((a) => isExpense(a) && /ROAD\s*TAX/.test(upper(a.account_name))).map((a) => a.account_code).sort();

/** The HP creditor of each of OUR lorries (450-H002 VNB 9058 …) — not a forklift, not a lorry we no longer run. */
export function instalmentAccounts(chart: readonly ChartAccount[], lorries: readonly LogisticsLorry[]): string[] {
  const plates = lorries.filter((l) => l.isInternal).map((l) => normalisePlate(l.plate)).filter(Boolean);
  return chart
    .filter((a) => a.is_active !== false && /\bHP\s+CREDITOR\b/.test(upper(a.account_name)))
    .filter((a) => plates.some((p) => normalisePlate(a.account_name).includes(p)))
    .map((a) => a.account_code)
    .sort();
}

/** The payroll accounts the salary journal writes its department lines on. */
export const salaryAccounts = (chart: readonly ChartAccount[]): string[] =>
  chart.filter((a) => isExpense(a) && /SALAR|\bEPF\b|SOCSO|\bEIS\b|ALLOWANCE|WAGES|OVERTIME|SKBB/.test(upper(a.account_name)))
    .map((a) => a.account_code).sort();

/** A salary-journal line for the drivers or the helpers. */
export const isManpowerLine = (notes: string | null | undefined): boolean => /^\s*OPERATION\s+(DELIVERY|HELPER)\b/i.test(String(notes ?? ''));

/** The chart sorted into the P&L's rows. The own-lorry list (Finance's ticks, else
    the chart's default) gives petrol, upkeep and any other lorry cost; manpower
    never re-reads an account that list already counts. */
export function pnlAccountsOf(chart: readonly ChartAccount[], lorries: readonly LogisticsLorry[], ownCost: readonly string[]): PnlAccounts & { all: string[] } {
  const nameOf = new Map(chart.map((a) => [a.account_code, a.account_name] as const));
  const outsource = new Map<string, RegionCode>();
  for (const a of chart) {
    const r = isExpense(a) ? outsourceRegionOf(a.account_name) : null;
    if (r) outsource.set(a.account_code, r);
  }
  const petrol = new Set<string>();
  const upkeep = new Set<string>();
  const otherLorry = new Set<string>();
  for (const code of ownCost) {
    const k = ownCostKindOf(nameOf.get(code));
    (k === 'petrol' ? petrol : k === 'upkeep' ? upkeep : otherLorry).add(code);
  }
  const own = new Set(ownCost);
  const roadTax = new Set(roadTaxAccounts(chart).filter((c) => !own.has(c)));
  const instalment = new Set(instalmentAccounts(chart, lorries));
  const salary = new Set(salaryAccounts(chart).filter((c) => !own.has(c)));
  const all = [...new Set([...outsource.keys(), ...petrol, ...upkeep, ...otherLorry, ...roadTax, ...instalment, ...salary])].sort();
  return { outsource, petrol, upkeep, otherLorry, roadTax, instalment, salary, all };
}

/* ── The areas a setup or dismantle trip is priced by ─────────────────────── */
export type Area = { key: string; label: string; region: RegionCode; defaultRateSen: number | null };
/** Owner 2026-10-29: 400 for KL, 600 for other areas, each way — Kuala Lumpur,
    Selangor and Putrajaya at the KL rate; East Malaysia and Singapore carry no
    rate until Finance gives one (his August sheet: Sarawak "no rate"). */
export const AREAS: readonly Area[] = [
  { key: 'kualalumpur', label: 'Kuala Lumpur', region: 'KL', defaultRateSen: 40_000 },
  { key: 'selangor', label: 'Selangor', region: 'KL', defaultRateSen: 40_000 },
  { key: 'putrajaya', label: 'Putrajaya', region: 'KL', defaultRateSen: 40_000 },
  { key: 'johor', label: 'Johor', region: 'KL', defaultRateSen: 60_000 },
  { key: 'melaka', label: 'Melaka', region: 'KL', defaultRateSen: 60_000 },
  { key: 'negerisembilan', label: 'Negeri Sembilan', region: 'KL', defaultRateSen: 60_000 },
  { key: 'perak', label: 'Perak', region: 'KL', defaultRateSen: 60_000 },
  { key: 'penang', label: 'Penang', region: 'PG', defaultRateSen: 60_000 },
  { key: 'kedah', label: 'Kedah', region: 'PG', defaultRateSen: 60_000 },
  { key: 'perlis', label: 'Perlis', region: 'PG', defaultRateSen: 60_000 },
  { key: 'kelantan', label: 'Kelantan', region: 'PG', defaultRateSen: 60_000 },
  { key: 'terengganu', label: 'Terengganu', region: 'PG', defaultRateSen: 60_000 },
  { key: 'pahang', label: 'Pahang', region: 'PG', defaultRateSen: 60_000 },
  { key: 'sabah', label: 'Sabah', region: 'EM', defaultRateSen: null },
  { key: 'sarawak', label: 'Sarawak', region: 'EM', defaultRateSen: null },
  { key: 'labuan', label: 'Labuan', region: 'EM', defaultRateSen: null },
  { key: 'singapore', label: 'Singapore', region: 'SG', defaultRateSen: null },
];
const AREA_ALIASES: Record<string, string> = {
  wpkualalumpur: 'kualalumpur', wilayahpersekutuankualalumpur: 'kualalumpur', kl: 'kualalumpur',
  wpputrajaya: 'putrajaya', wilayahpersekutuanputrajaya: 'putrajaya',
  malacca: 'melaka', pulaupinang: 'penang', pinang: 'penang', wplabuan: 'labuan', wilayahpersekutuanlabuan: 'labuan', ns: 'negerisembilan',
};
const areaKeyOf = (state: string | null | undefined): string => {
  const k = String(state ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return AREA_ALIASES[k] ?? k;
};
export const areaOf = (state: string | null | undefined): Area | null => AREAS.find((a) => a.key === areaKeyOf(state)) ?? null;
export const isAreaKey = (key: string): boolean => AREAS.some((a) => a.key === key);

/** The rate one area's trips are priced at: Finance's own (null = no rate), else the default. */
export const rateOf = (area: Area, rates: ReadonlyMap<string, number | null>): number | null =>
  rates.has(area.key) ? rates.get(area.key)! : area.defaultRateSen;

/* ── Setup and dismantle trips ────────────────────────────────────────────── */
export type TripKind = 'setup' | 'dismantle';
export type Fair = { id: number; code: string | null; name: string; state: string | null; venue: string | null; startDate: string | null; endDate: string | null };
export type SetupTrip = {
  key: string; kind: TripKind; day: string; venue: string;
  area: string | null; areaLabel: string; region: RegionCode;
  fairs: Array<{ id: number; code: string | null; name: string }>;
  rateSen: number | null;
  /** An outsourced bill covers it (a 3PL bill line or a fair-transport line on one of its fairs). */
  outsourced: boolean;
  /** Finance's own tick (true) or untick (false); null = the rule decides. */
  mark: boolean | null;
  inHouse: boolean;
  amountSen: number;
};

const venueKey = (v: string | null | undefined): string => upper(v).replace(/[^A-Z0-9]+/g, '');

export function setupTrips(input: {
  fairs: readonly Fair[];
  outsourced: ReadonlyMap<number, ReadonlySet<TripKind>>;
  marks: ReadonlyMap<string, boolean>;
  rates: ReadonlyMap<string, number | null>;
  from: string; to: string;
}): SetupTrip[] {
  const trips = new Map<string, SetupTrip>();
  for (const f of input.fairs) {
    for (const [kind, raw] of [['setup', f.startDate], ['dismantle', f.endDate]] as const) {
      const day = raw ? String(raw).slice(0, 10) : '';
      if (!day || day < input.from || day > input.to) continue;
      const key = `${kind}|${venueKey(f.venue) || `#${f.code ?? f.id}`}|${day}`;
      const covered = input.outsourced.get(f.id)?.has(kind) ?? false;
      const fair = { id: f.id, code: f.code, name: f.name };
      const had = trips.get(key);
      if (had) {
        had.fairs.push(fair);
        had.outsourced = had.outsourced || covered;
        continue;
      }
      const area = areaOf(f.state);
      trips.set(key, {
        key, kind, day, venue: String(f.venue ?? '').trim(),
        area: area?.key ?? null, areaLabel: area?.label ?? (String(f.state ?? '').trim() || '(no state)'), region: area?.region ?? 'KL',
        fairs: [fair], rateSen: area ? rateOf(area, input.rates) : null,
        outsourced: covered, mark: null, inHouse: false, amountSen: 0,
      });
    }
  }
  return [...trips.values()]
    .map((t) => {
      const mark = input.marks.has(t.key) ? input.marks.get(t.key)! : null;
      const inHouse = mark ?? !t.outsourced;
      return { ...t, mark, inHouse, amountSen: inHouse && t.rateSen != null ? t.rateSen : 0 };
    })
    .sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind) || a.venue.localeCompare(b.venue));
}

/** Which way(s) an outsourced line on a fair covers: the 3PL reader's kind, else
    its words — "… EVENT SETUP - DISMANTLE EVENT SPCC" is a dismantle, "SETUP &
    DISMANTLE" both — else both. */
export function coveredKinds(kind: string | null | undefined, words: string | null | undefined): TripKind[] {
  const k = String(kind ?? '').toLowerCase();
  if (k === 'setup' || k === 'dismantle') return [k];
  const s = upper(words);
  if (/SET\s*-?\s*UP\s*(&|AND|\/)\s*DISMANTL/.test(s)) return ['setup', 'dismantle'];
  if (/DISMANTL|\bRETURN\b/.test(s)) return ['dismantle'];
  if (/\bSET\s*-?\s*UP\b|\bSETUP\b/.test(s)) return ['setup'];
  return ['setup', 'dismantle'];
}

/* ── Bills spread over months ─────────────────────────────────────────────── */
export type SpreadKind = 'upkeep' | 'roadtax';
export const DEFAULT_SPREAD: Record<SpreadKind, number> = { upkeep: 1, roadtax: 12 };
export const MAX_SPREAD = 36;
export type SpreadLeg = { lineId: string; kind: SpreadKind; accountCode: string; accountName: string | null; day: string; docNo: string | null; notes: string | null; amountSen: number };
export type SpreadRow = SpreadLeg & { months: number; isDefault: boolean; perMonthSen: number; inRangeSen: number; lastMonth: string };

/** Each bill's share of the months asked for; the bills whose spread reaches into them. */
export function spreadBills(legs: readonly SpreadLeg[], months: ReadonlyMap<string, number>, range: readonly string[]): { sen: Record<SpreadKind, number>; rows: SpreadRow[] } {
  const inRange = new Set(range);
  const sen: Record<SpreadKind, number> = { upkeep: 0, roadtax: 0 };
  const rows: SpreadRow[] = [];
  for (const l of legs) {
    const own = months.get(l.lineId);
    const n = own ?? DEFAULT_SPREAD[l.kind];
    const start = monthOf(l.day);
    const parts = share(l.amountSen, n);
    let mine = 0;
    parts.forEach((p, i) => { if (inRange.has(addMonths(start, i))) mine += p; });
    const lastMonth = addMonths(start, n - 1);
    if (lastMonth < range[0]! || start > range[range.length - 1]!) continue;
    sen[l.kind] += mine;
    rows.push({ ...l, months: n, isDefault: own == null, perMonthSen: parts[0] ?? 0, inRangeSen: mine, lastMonth });
  }
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.accountCode.localeCompare(b.accountCode));
  return { sen, rows };
}

/* ── What Finance billed extra ────────────────────────────────────────────── */
export type IncomeRow = 'houzs' | 'conts' | 'hookka' | '2990';
export const incomeRowOf = (debtorName: string | null | undefined): IncomeRow => {
  const n = upper(debtorName);
  if (/\b2990\b/.test(n)) return '2990';
  if (/\bCONTS\b/.test(n)) return 'conts';
  if (/\bHOOKKA\b/.test(n)) return 'hookka';
  return 'houzs';
};
export type BillLine = { lineId: string; billNo: string; billDate: string; debtorName: string; description: string | null; accountCode: string; accountName: string | null; amountSen: number };
export type IncomeLine = BillLine & { month: string; row: IncomeRow; region: RegionCode; by: 'account' | 'wording' };

/** The transport lines among a stack of Other Debtor bill lines, in the months asked for. */
export function incomeLines(lines: readonly BillLine[], range: readonly string[]): IncomeLine[] {
  const inRange = new Set(range);
  const out: IncomeLine[] = [];
  for (const l of lines) {
    const byAccount = transportIncomeRegionOf(l.accountName);
    const region = byAccount ?? (isRechargeWording(l.description) ? 'KL' : null);
    if (region == null) continue;
    const month = monthNamed(l.description) ?? monthOf(l.billDate);
    if (!inRange.has(month)) continue;
    out.push({ ...l, month, row: incomeRowOf(l.debtorName), region, by: byAccount ? 'account' : 'wording' });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.billNo.localeCompare(b.billNo));
}

/* ── The P&L ──────────────────────────────────────────────────────────────── */
export type Leg = { lineId: string; accountCode: string; accountName: string | null; day: string; debitSen: number; creditSen: number; notes: string | null; docNo: string | null };
export type PnlAccounts = {
  outsource: ReadonlyMap<string, RegionCode>;
  petrol: ReadonlySet<string>;
  upkeep: ReadonlySet<string>;
  otherLorry: ReadonlySet<string>;
  roadTax: ReadonlySet<string>;
  instalment: ReadonlySet<string>;
  salary: ReadonlySet<string>;
};
export type PnlRowKey =
  | 'do_value' | 'do_income' | 'ti_houzs' | 'ti_conts' | 'ti_hookka' | 'sd_income' | 'ti_2990' | 'total_income'
  | 'outsource' | 'petrol' | 'upkeep' | 'instalment' | 'roadtax' | 'manpower' | 'other_lorry' | 'inhouse_total' | 'total_expense'
  | 'net' | 'cost_per_do' | 'net_cost_per_do';
export type PnlRow = { key: PnlRowKey; label: string; sen: Record<RegionCode, number | null>; totalSen: number | null };
export type PnlInput = {
  from: string; to: string;
  /** The DOs of the months asked for, each in its region. */
  dos: ReadonlyArray<{ region: RegionCode; valueSen: number }>;
  doIncomeBp: number;
  income: readonly IncomeLine[];
  trips: readonly SetupTrip[];
  /** Every leg on the accounts below, from far enough back for the longest spread. */
  legs: readonly Leg[];
  accounts: PnlAccounts;
  spreadMonths: ReadonlyMap<string, number>;
  /** Our lorries' trips in the months (one lorry, one day). */
  ownTrips: number;
};
export type LogisticsPnl = {
  from: string; to: string; months: string[];
  doIncomeBp: number;
  dos: Record<RegionCode, number> & { total: number };
  rows: PnlRow[];
  income: IncomeLine[];
  trips: SetupTrip[];
  spreads: SpreadRow[];
  ownTrips: number;
  inHousePerTripSen: number | null;
};

export function buildLogisticsPnl(input: PnlInput): LogisticsPnl {
  const range = monthsBetween(input.from, input.to);
  const inDays = (day: string) => day >= input.from && day <= input.to;
  const counts: Record<RegionCode, number> = { PG: 0, KL: 0, EM: 0, SG: 0 };
  const doValue = zero();
  for (const d of input.dos) { counts[d.region] += 1; doValue[d.region] += d.valueSen; }
  const doIncome = zero();
  for (const r of REGIONS) doIncome[r.code] = Math.round((doValue[r.code] * input.doIncomeBp) / 10_000);

  const incomeBy = (row: IncomeRow) => {
    const s = zero();
    for (const l of input.income) if (l.row === row) s[l.region] += l.amountSen;
    return s;
  };
  const sdIncome = zero();
  for (const t of input.trips) sdIncome[t.region] += t.amountSen;

  /* The books: each leg into its row. Manpower never re-counts an own-lorry account. */
  const outsource = zero();
  const kl = { petrol: 0, instalment: 0, manpower: 0, other: 0 };
  const spreadLegs: SpreadLeg[] = [];
  const a = input.accounts;
  for (const l of input.legs) {
    const net = l.debitSen - l.creditSen;
    if (a.upkeep.has(l.accountCode) || a.roadTax.has(l.accountCode)) {
      if (net === 0) continue;
      spreadLegs.push({
        lineId: l.lineId, kind: a.upkeep.has(l.accountCode) ? 'upkeep' : 'roadtax',
        accountCode: l.accountCode, accountName: l.accountName, day: l.day, docNo: l.docNo, notes: l.notes, amountSen: net,
      });
      continue;
    }
    if (!inDays(l.day)) continue;
    const region = a.outsource.get(l.accountCode);
    if (region) outsource[region] += net;
    else if (a.petrol.has(l.accountCode)) kl.petrol += net;
    else if (a.otherLorry.has(l.accountCode)) kl.other += net;
    else if (a.instalment.has(l.accountCode)) kl.instalment += l.debitSen;
    else if (a.salary.has(l.accountCode) && isManpowerLine(l.notes)) kl.manpower += net;
  }
  const spread = spreadBills(spreadLegs, input.spreadMonths, range);

  const klOnly = (sen: number): RegionSen => ({ ...zero(), KL: sen });
  const money = (key: PnlRowKey, label: string, sen: RegionSen): PnlRow => ({ key, label, sen, totalSen: total(sen) });
  const add = (...xs: RegionSen[]): RegionSen => {
    const s = zero();
    for (const x of xs) for (const r of REGIONS) s[r.code] += x[r.code];
    return s;
  };
  const less = (x: RegionSen, y: RegionSen): RegionSen => add(x, { PG: -y.PG, KL: -y.KL, EM: -y.EM, SG: -y.SG });

  const ti = { houzs: incomeBy('houzs'), conts: incomeBy('conts'), hookka: incomeBy('hookka'), '2990': incomeBy('2990') };
  const otherIncome = add(ti.houzs, ti.conts, ti.hookka, sdIncome, ti['2990']);
  const totalIncome = add(doIncome, otherIncome);
  const inHouse = {
    petrol: klOnly(kl.petrol), upkeep: klOnly(spread.sen.upkeep), instalment: klOnly(kl.instalment),
    roadtax: klOnly(spread.sen.roadtax), manpower: klOnly(kl.manpower), other: klOnly(kl.other),
  };
  const inHouseTotal = add(inHouse.petrol, inHouse.upkeep, inHouse.instalment, inHouse.roadtax, inHouse.manpower, inHouse.other);
  const totalExpense = add(outsource, inHouseTotal);
  const netCost = less(totalExpense, otherIncome);

  const perDo = (key: PnlRowKey, label: string, sen: RegionSen): PnlRow => {
    const by = {} as Record<RegionCode, number | null>;
    for (const r of REGIONS) by[r.code] = counts[r.code] > 0 ? Math.round(sen[r.code] / counts[r.code]) : null;
    const n = total(counts);
    return { key, label, sen: by, totalSen: n > 0 ? Math.round(total(sen) / n) : null };
  };

  const pctText = (input.doIncomeBp / 100).toFixed(2).replace(/\.?0+$/, '');
  const rows: PnlRow[] = [
    money('do_value', 'Delivery Order', doValue),
    money('do_income', `Transport Income (${pctText}% of DO)`, doIncome),
    money('ti_houzs', 'Transport Income (Houzs)', ti.houzs),
    money('ti_conts', 'Transport Income (The Conts)', ti.conts),
    money('ti_hookka', 'Transport Income (Hookka)', ti.hookka),
    money('sd_income', 'Set/Dismantle Income (In-house)', sdIncome),
    money('ti_2990', 'Transport Income (2990)', ti['2990']),
    money('total_income', 'TOTAL INCOME', totalIncome),
    money('outsource', 'Outsource Expense', outsource),
    money('petrol', 'Petrol Cost', inHouse.petrol),
    money('upkeep', 'Upkeep Cost', inHouse.upkeep),
    money('instalment', 'Lorry Installment Cost', inHouse.instalment),
    money('roadtax', 'RoadTax & Insurance Cost', inHouse.roadtax),
    money('manpower', 'Manpower Cost', inHouse.manpower),
    ...(kl.other !== 0 ? [money('other_lorry', 'Other lorry cost', inHouse.other)] : []),
    money('inhouse_total', 'Total In-house Expenses', inHouseTotal),
    money('total_expense', 'TOTAL EXPENSE', totalExpense),
    money('net', 'NET PROFIT', less(totalIncome, totalExpense)),
    perDo('cost_per_do', 'Cost per DO', totalExpense),
    perDo('net_cost_per_do', 'Net cost per DO (after other income)', netCost),
  ];

  return {
    from: input.from, to: input.to, months: range, doIncomeBp: input.doIncomeBp,
    dos: { ...counts, total: total(counts) },
    rows,
    income: [...input.income],
    trips: [...input.trips],
    spreads: spread.rows,
    ownTrips: input.ownTrips,
    inHousePerTripSen: input.ownTrips > 0 ? Math.round(total(inHouseTotal) / input.ownTrips) : null,
  };
}
