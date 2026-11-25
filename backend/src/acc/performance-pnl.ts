// ----------------------------------------------------------------------------
// performance-pnl — the Performance P&L (owner 2026-09-12: 我还要多一份
// performance P&L，就是 sales 和 COGS 的数额是根据 sales order 的，expense 其他
// remain，但是 expense 的 operating 要根据 sales 的 16% 来算 … 按 SO 日期 … 未送货
// 也算，因为我是看当月的表现 … 分成 bedframe, mattress, sofa, dining, accessory,
// service/Transport income … 根据 SO 明显的成本 … operating expense 根据 total
// sales exclude transport 的 amount，16% 要设计成可调 … 只取代 900-O001，然后在
// performance P&L 要注明; docs/bugs/0835).
//
// TWO SOURCES, deliberately, and the report says so on its face:
//   • the SALES side is the sales orders dated in the period — every status
//     except DRAFT and CANCELLED, delivered or not (当月的表现) — sales and
//     cost of sales per line as the order records them (total_sen; unit cost
//     × quantity, which is line_cost_sen), grouped BEDFRAME / MATTRESS / SOFA /
//     DINING / ACCESSORY / SERVICE (transport income); a line outside the six
//     lands under OTHERS so the total still ties to the orders;
//   • the EXPENSE side is the ledger by journal date — every EXPENSES-section
//     account as booked — except ONE: the operating-expense account the
//     company names (900-O001 by default), which is REPLACED by a rate (16%
//     by default, adjustable) of sales excluding service, because the owner
//     budgets operating cost as a share of goods sold;
//   • OTHER INCOME is the ledger's too (OTHER INCOMES + EXTRA-ORDINARY INCOME
//     sections, as booked, by journal date) — owner 2026-09-12: performance
//     GL 要放 other income — so net = gross profit + other income − operating
//     expense − other expenses.
// The rate may ALSO cover other accounts the company names, each with every
// account beneath it in the chart (owner 2026-10-06: 2990's transport is
// already inside the 16% — counting it again double-counts): those are left
// out of the expenses, show at nil, and the rate's line names them. Houzs
// names none (its performance is figured differently — 不做先).
// FAIR COSTS (owner 2026-11-25:「帮我把这些fair的费用单独放一块 就是rental, setup,
// commission, transport 和 merchandise」) — a company that keeps them (Houzs) gets
// them as the first block of its expenses: rental and setup as booked on their
// accounts, the commission its bills, and three rates of sales excluding service,
// each IN PLACE OF what the books carry for it — transport (3%: the Logistics
// P&L's own accounts and the drivers' and helpers' pay,「driver helper的薪水其实都包括
// 在 logistic的3 % 了」), setup & dismantle (1%:「多1% 是 for setup & dismantle」, the
// fair-transport accounts) and merchandise (2%: his fair P&L's rate for every brand,
// in place of the card terminal charges).
// The rates and the accounts live on scm.acc_company_settings; the figures are
// computed live on every read and stored nowhere. The building is pure
// (buildPerformanceReport) so the contract test feeds it worlds directly.
// ----------------------------------------------------------------------------

import { isDeliveryFeeServiceCode, isServiceLine } from '../scm/shared/service-sku';
import { SO_DELIVERED_OR_BEYOND, SO_NOT_AN_ORDER } from '../scm/shared/so-deliverable-states';
import { laidLineNode, layOutBlock, pctOf, type LaidLine, type LaidNode, type Layout, type LayoutItem } from './report-layout';
import type { PeriodCommission } from './performance-commission';

type Db = any;

/** The fair costs a company keeps (scm.acc_company_settings.performance_fair): the
    accounts read as booked (rental, setup), and three rates of sales excluding service,
    each with the accounts it stands in for (transport: the Logistics P&L's own accounts
    and the drivers' and helpers' pay, from the chart). Codes each with the accounts under them. */
export type FairCostSettings = {
  rental: string[]; setup: string[];
  transportBp: number;
  setupDismantleBp: number; setupDismantle: string[];
  merchandiseBp: number; merchandise: string[];
};
export type FairRateKey = 'transportBp' | 'setupDismantleBp' | 'merchandiseBp';
export const FAIR_RATE_KEYS: readonly FairRateKey[] = ['transportBp', 'setupDismantleBp', 'merchandiseBp'];

const codesOf = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map((c) => String(c ?? '').trim().toUpperCase()).filter(Boolean))] : []);
const bpOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 0;
};
/** The stored fair costs, checked; anything that is not an object is no fair block. */
export function parseFairSettings(raw: unknown): FairCostSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    rental: codesOf(r.rental), setup: codesOf(r.setup),
    transportBp: bpOf(r.transportBp),
    setupDismantleBp: bpOf(r.setupDismantleBp), setupDismantle: codesOf(r.setupDismantle),
    merchandiseBp: bpOf(r.merchandiseBp), merchandise: codesOf(r.merchandise),
  };
}

/** `also`: accounts the rate covers besides `account` — each with the accounts under it.
    `fair`: the fair costs the company keeps, or null. */
export type PerformanceSettings = { rateBp: number; account: string; also: string[]; fair: FairCostSettings | null };
/** 16% of sales excluding service, in place of 900-O001 — the owner's numbers (2026-09-12). */
export const DEFAULT_PERFORMANCE_SETTINGS: PerformanceSettings = { rateBp: 1600, account: '900-O001', also: [], fair: null };

/** The covered accounts as the settings hold them: trimmed, upper case, each
    once, never the rate's own account. A list or a comma/space-separated text. */
export const normaliseAlso = (raw: unknown, account: string): string[] => {
  const list: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  return [...new Set(list.map((c) => String(c ?? '').trim().toUpperCase()).filter((c) => c !== '' && c !== account))];
};

/** Each named code and every account beneath it in the chart. */
export function accountsUnder(codes: readonly string[], chart: ReadonlyArray<{ account_code: string; parent_code?: string | null }>): Set<string> {
  const kids = new Map<string, string[]>();
  for (const a of chart) if (a.parent_code) kids.set(a.parent_code, [...(kids.get(a.parent_code) ?? []), a.account_code]);
  const out = new Set<string>();
  const walk = (c: string): void => {
    if (out.has(c)) return;
    out.add(c);
    for (const k of kids.get(c) ?? []) walk(k);
  };
  for (const c of codes) walk(c);
  return out;
}

/** The company's rate and account, else the owner's defaults (a company with
    no settings row yet reads the same numbers the migration defaulted). */
export async function loadPerformanceSettings(sb: Db, companyId: number): Promise<{ ok: true; settings: PerformanceSettings } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_company_settings')
    .select('performance_opex_rate_bp, performance_opex_account, performance_opex_also, performance_fair')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  const row = (data ?? null) as { performance_opex_rate_bp?: number | null; performance_opex_account?: string | null; performance_opex_also?: string[] | null; performance_fair?: unknown } | null;
  const rate = Number(row?.performance_opex_rate_bp);
  const account = String(row?.performance_opex_account ?? '').trim() || DEFAULT_PERFORMANCE_SETTINGS.account;
  return {
    ok: true,
    settings: {
      rateBp: row?.performance_opex_rate_bp != null && Number.isFinite(rate) ? rate : DEFAULT_PERFORMANCE_SETTINGS.rateBp,
      account,
      also: normaliseAlso(row?.performance_opex_also ?? [], account),
      fair: parseFairSettings(row?.performance_fair),
    },
  };
}

/** Save the pair on the company's row — the deposit-invoice switch beside it
    is left as it is (the upsert names only these columns). */
export async function savePerformanceSettings(sb: Db, companyId: number, s: Pick<PerformanceSettings, 'rateBp' | 'account' | 'also'>, actor: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { error } = await sb.from('acc_company_settings').upsert({
    company_id: companyId,
    performance_opex_rate_bp: s.rateBp,
    performance_opex_account: s.account,
    performance_opex_also: s.also,
    updated_at: new Date().toISOString(),
    updated_by: actor,
  }, { onConflict: 'company_id' });
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

/** Finance's three fair rates, saved on the company's fair costs; the accounts stay. */
export async function saveFairRates(sb: Db, companyId: number, fair: FairCostSettings, rates: Record<FairRateKey, number>, actor: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { error } = await sb.from('acc_company_settings').update({
    performance_fair: { ...fair, ...rates },
    updated_at: new Date().toISOString(),
    updated_by: actor,
  }).eq('company_id', companyId);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

/* ── The owner's groups ──────────────────────────────────────────────────── */

export const PERFORMANCE_GROUPS = [
  { key: 'bedframe', label: 'Bedframe' },
  { key: 'mattress', label: 'Mattress' },
  { key: 'sofa', label: 'Sofa' },
  { key: 'dining', label: 'Dining' },
  { key: 'accessory', label: 'Accessory' },
  { key: 'service', label: 'Service / transport income' },
  { key: 'others', label: 'Others' },
] as const;
export type PerformanceGroupKey = (typeof PERFORMANCE_GROUPS)[number]['key'];

/** Which of the owner's six a line belongs to: SERVICE by any signal (the
    group, the SVC- code), then the group word the SKU's category wrote on
    the line; a line outside the six is OTHERS, never dropped. */
export function performanceGroupOf(line: { item_group: string | null; item_code: string | null }): PerformanceGroupKey {
  if (isServiceLine({ itemGroup: line.item_group, itemCode: line.item_code })) return 'service';
  const g = String(line.item_group ?? '').toLowerCase();
  if (g.includes('mattress')) return 'mattress';
  if (g.includes('sofa')) return 'sofa';
  if (g.includes('bedframe')) return 'bedframe';
  if (g.includes('dining')) return 'dining';
  if (g.includes('accessor')) return 'accessory';
  return 'others';
}

/* ── The report ──────────────────────────────────────────────────────────── */

export type PerfOrder = { doc_no: string; so_date: string; status: string; delivery_fee_sen: number | null };
export type PerfLine = {
  doc_no: string; item_group: string | null; item_code: string | null; qty: number | null;
  total_sen: number | null; unit_cost_sen: number | null; line_cost_sen: number | null; cancelled: boolean | null;
};
/** A sales-order line's own cost: unit cost × quantity, written on the line
    when it was priced; recomputed from the parts only when the line predates
    the column. The Performance P&L and the product profit ranking both read it. */
export const soLineCostSen = (l: Pick<PerfLine, 'qty' | 'unit_cost_sen' | 'line_cost_sen'>): number =>
  l.line_cost_sen != null ? Number(l.line_cost_sen) : Math.round(Number(l.qty ?? 0) * Number(l.unit_cost_sen ?? 0));

/** A ledger account's live figure for the period, as booked: an EXPENSES-section
    account's debit, or an other-income section's credit. */
export type PerfExpense = { code: string; name: string; amountSen: number };

export type PerformanceGroup = { key: PerformanceGroupKey; label: string; lines: number; salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null };

/** What the fair block reads, worked out from the chart and the ledger for the period:
    each line's accounts with the accounts under them, the Logistics P&L's own expense
    accounts (the Chart of Accounts' Logistics column) and the drivers' and helpers' pay
    in the period by payroll account (the Logistics P&L's manpower lines). */
export type FairInputs = {
  settings: FairCostSettings;
  rental: ReadonlySet<string>; setup: ReadonlySet<string>; setupDismantle: ReadonlySet<string>; merchandise: ReadonlySet<string>;
  logistics: ReadonlySet<string>;
  pay: ReadonlyMap<string, number>;
};
/** A line of the fair block: accounts as booked, or a rate of sales excluding service
    standing in for what the books carry (`replacedSen`, left out of the expenses). */
export type FairLine =
  | { key: 'rental' | 'setup' | 'commission'; kind: 'booked'; accounts: PerfExpense[]; amountSen: number }
  | { key: 'transport' | 'setupDismantle' | 'merchandise'; kind: 'rate'; rateBp: number; amountSen: number; replaced: PerfExpense[]; replacedSen: number };
export type FairCosts = { lines: FairLine[]; totalSen: number };
export type PerformanceReport = {
  from: string; to: string;
  orders: { counted: number; notDelivered: number; excludedDraft: number; excludedCancelled: number };
  /** The six, in the owner's order, then OTHERS only when a line landed there. */
  groups: PerformanceGroup[];
  totals: { salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null; salesExServiceSen: number };
  operatingExpense: {
    rateBp: number; baseSen: number; amountSen: number;
    account: string; accountName: string | null; accountFound: boolean;
    /** What the ledger booked on that account in the period — shown, left out of the expenses. */
    bookedSen: number;
    /** The other accounts the rate covers, as named (each with the accounts under it). */
    also: Array<{ code: string; name: string | null }>;
    /** What the ledger booked on those in the period — left out of the expenses too. */
    alsoBookedSen: number;
  };
  /** The covered accounts that booked something in the period — shown at nil. */
  inRate: PerfExpense[];
  /** The ledger's OTHER INCOMES + EXTRA-ORDINARY INCOME accounts as booked, by code. */
  otherIncome: PerfExpense[];
  otherIncomeSen: number;
  /** Every other EXPENSES-section account as booked, by code. */
  otherExpenses: PerfExpense[];
  otherExpensesSen: number;
  netSen: number; netPct: number | null;
  settings: PerformanceSettings;
  /** The commission: the bills for the period's months on the commission
      expense, in place of what the monthly release booked there (owner
      2026-11-25); null when the company keeps no commission prepayment. */
  commission: PeriodCommission | null;
  /** The fair costs, the first block of the expenses; null when the company keeps none. */
  fair: FairCosts | null;
};

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function buildPerformanceReport(p: {
  from: string; to: string;
  orders: PerfOrder[]; lines: PerfLine[]; expenses: PerfExpense[];
  /** Other income as the ledger booked it (credit-positive). */
  otherIncome?: PerfExpense[];
  settings: PerformanceSettings;
  /** The named account as the chart has it, or null when the chart does not. */
  account: { code: string; name: string } | null;
  /** The accounts `settings.also` covers, expanded to every account under them (accountsUnder). */
  alsoCodes?: ReadonlySet<string>;
  /** `settings.also` as the chart names them. */
  alsoNamed?: Array<{ code: string; name: string | null }>;
  /** The period's commission bills and what the release booked (acc/performance-commission.ts). */
  commission?: PeriodCommission | null;
  /** The fair block's inputs, or null for a company that keeps no fair block. */
  fair: FairInputs | null;
}): PerformanceReport {
  const excludedDraft = p.orders.filter((o) => String(o.status) === 'DRAFT').length;
  const excludedCancelled = p.orders.filter((o) => String(o.status) === 'CANCELLED').length;
  const live = p.orders.filter((o) => !SO_NOT_AN_ORDER.has(String(o.status)));
  const liveDocs = new Set(live.map((o) => o.doc_no));

  const at = new Map<PerformanceGroupKey, { lines: number; salesSen: number; cogsSen: number }>(
    PERFORMANCE_GROUPS.map((g) => [g.key, { lines: 0, salesSen: 0, cogsSen: 0 }]),
  );
  const hasFeeLine = new Set<string>();
  for (const l of p.lines) {
    if (!liveDocs.has(l.doc_no) || l.cancelled === true) continue;
    const a = at.get(performanceGroupOf(l))!;
    const cost = soLineCostSen(l);
    a.lines += 1;
    a.salesSen += Number(l.total_sen ?? 0);
    a.cogsSen += cost;
    if (isDeliveryFeeServiceCode(l.item_code)) hasFeeLine.add(l.doc_no);
  }
  /* A legacy order whose delivery fee sits only on its header (no
     SVC-DELIVERY line): the fee is service income the lines do not carry —
     the same rule the order's own totals follow. */
  for (const o of live) {
    if (!hasFeeLine.has(o.doc_no) && Number(o.delivery_fee_sen ?? 0) > 0) at.get('service')!.salesSen += Number(o.delivery_fee_sen);
  }

  const groups: PerformanceGroup[] = PERFORMANCE_GROUPS
    .map((g) => {
      const a = at.get(g.key)!;
      return { key: g.key, label: g.label, lines: a.lines, salesSen: a.salesSen, cogsSen: a.cogsSen, gpSen: a.salesSen - a.cogsSen, gpPct: pct(a.salesSen - a.cogsSen, a.salesSen) };
    })
    .filter((g) => g.key !== 'others' || g.lines > 0 || g.salesSen !== 0 || g.cogsSen !== 0);

  const salesSen = groups.reduce((s, g) => s + g.salesSen, 0);
  const cogsSen = groups.reduce((s, g) => s + g.cogsSen, 0);
  const gpSen = salesSen - cogsSen;
  const serviceSalesSen = at.get('service')!.salesSen;
  const salesExServiceSen = salesSen - serviceSalesSen;

  const opexSen = Math.round((salesExServiceSen * p.settings.rateBp) / 10000);
  const code = p.settings.account;
  /* The commission expense reads the bills for the period's months, not the
     release: what the release booked on it leaves, the bills come in. */
  const commission = p.commission ?? null;
  const booked = commission
    ? (p.expenses.some((e) => e.code === commission.code) ? p.expenses : [...p.expenses, { code: commission.code, name: commission.name ?? commission.code, amountSen: 0 }])
        .map((e) => (e.code === commission.code ? { ...e, amountSen: e.amountSen - commission.releaseSen + commission.billSen } : e))
    : p.expenses;
  const replaced = booked.find((e) => e.code === code) ?? null;
  const accountFound = p.account != null;
  /* Only the named account is replaced — and only when the chart carries
     it; a code the chart does not know replaces nothing, and the report
     says so rather than quietly dropping a booked expense. */
  /* The other accounts the rate covers are inside it, not beside it. */
  const alsoCodes = p.alsoCodes ?? new Set<string>();
  const inRate = booked.filter((e) => alsoCodes.has(e.code) && e.code !== code && e.amountSen !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
  const beside = (accountFound ? booked.filter((e) => e.code !== code) : booked).filter((e) => !alsoCodes.has(e.code));
  const fair = fairCostsOf(p.fair, beside, salesExServiceSen, commission?.code ?? null);
  const otherExpenses = fair.rest
    .filter((e) => e.amountSen !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
  const otherExpensesSen = otherExpenses.reduce((s, e) => s + e.amountSen, 0);
  const otherIncome = (p.otherIncome ?? []).filter((e) => e.amountSen !== 0).sort((a, b) => a.code.localeCompare(b.code));
  const otherIncomeSen = otherIncome.reduce((s, e) => s + e.amountSen, 0);
  const fairSen = fair.costs?.totalSen ?? 0;
  const netSen = gpSen + otherIncomeSen - opexSen - fairSen - otherExpensesSen;

  return {
    from: p.from, to: p.to,
    orders: {
      counted: live.length,
      notDelivered: live.filter((o) => !SO_DELIVERED_OR_BEYOND.has(String(o.status))).length,
      excludedDraft, excludedCancelled,
    },
    groups,
    totals: { salesSen, cogsSen, gpSen, gpPct: pct(gpSen, salesSen), salesExServiceSen },
    operatingExpense: {
      rateBp: p.settings.rateBp, baseSen: salesExServiceSen, amountSen: opexSen,
      account: code, accountName: p.account?.name ?? null, accountFound,
      bookedSen: accountFound ? (replaced?.amountSen ?? 0) : 0,
      also: p.alsoNamed ?? [],
      alsoBookedSen: inRate.reduce((s, e) => s + e.amountSen, 0),
    },
    inRate,
    otherIncome, otherIncomeSen,
    otherExpenses, otherExpensesSen,
    netSen, netPct: pct(netSen, salesSen),
    settings: p.settings,
    commission,
    fair: fair.costs,
  };
}

/** The fair block out of the expenses as booked: rental, setup and the commission
    as they stand (the commission already its bills); transport, setup & dismantle and
    merchandise at their rates of sales excluding service, what the books carry for
    them left out — the drivers' and helpers' pay taken off their payroll accounts.
    `rest`: every other expense, for the tree. */
export function fairCostsOf(fair: FairInputs | null, booked: readonly PerfExpense[], baseSen: number, commissionCode: string | null): { costs: FairCosts | null; rest: PerfExpense[] } {
  if (!fair) return { costs: null, rest: [...booked] };
  const sum = (xs: readonly PerfExpense[]) => xs.reduce((s, e) => s + e.amountSen, 0);
  const on = (codes: ReadonlySet<string>) => booked.filter((e) => codes.has(e.code));
  const commission = new Set(commissionCode ? [commissionCode] : []);
  const booked3 = (key: 'rental' | 'setup' | 'commission', codes: ReadonlySet<string>): FairLine => {
    const accounts = on(codes).filter((e) => e.amountSen !== 0).sort((a, b) => a.code.localeCompare(b.code));
    return { key, kind: 'booked', accounts, amountSen: sum(accounts) };
  };
  const paySen = [...fair.pay.values()].reduce((s, v) => s + v, 0);
  const rate = (key: 'transport' | 'setupDismantle' | 'merchandise', bp: number, codes: ReadonlySet<string>, extraSen: number): FairLine => {
    const replaced = on(codes).filter((e) => e.amountSen !== 0).sort((a, b) => a.code.localeCompare(b.code));
    return { key, kind: 'rate', rateBp: bp, amountSen: Math.round((baseSen * bp) / 10_000), replaced, replacedSen: sum(replaced) + extraSen };
  };
  const s = fair.settings;
  const lines: FairLine[] = [
    booked3('rental', fair.rental),
    booked3('setup', fair.setup),
    booked3('commission', commission),
    rate('transport', s.transportBp, fair.logistics, paySen),
    rate('setupDismantle', s.setupDismantleBp, fair.setupDismantle, 0),
    rate('merchandise', s.merchandiseBp, fair.merchandise, 0),
  ];
  const moved = new Set([...fair.rental, ...fair.setup, ...commission, ...fair.logistics, ...fair.setupDismantle, ...fair.merchandise]);
  const rest = booked.filter((e) => !moved.has(e.code))
    .map((e) => (fair.pay.has(e.code) ? { ...e, amountSen: e.amountSen - (fair.pay.get(e.code) ?? 0) } : e));
  return { costs: { lines, totalSen: lines.reduce((t, l) => t + l.amountSen, 0) }, rest };
}

/* ── The account part on the report's layout (docs/bugs/0912) ──────────── */

export type PerformanceLayout = {
  stored: boolean;
  /** Sales of the period — what every % is of; null when nothing sold. */
  baseSen: number | null;
  otherIncome: LaidNode[];
  expenses: LaidNode[];
};

const fmtRm2 = (sen: number): string =>
  new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(sen) / 100);
const ratePct = (bp: number): string => `${(bp / 100).toFixed(2)}%`;

/** The sentence the computed operating expense line prints under — what it
    is, what it stands in for (owner: 在 performance P&L 要注明). ONE home: the
    screen, the CSV and the PDF all read the laid line's label. */
export const operatingExpenseLabel = (o: PerformanceReport['operatingExpense']): string => {
  const standsFor = o.accountFound
    ? `in place of ${o.account}${o.accountName ? ` ${o.accountName}` : ''}`
    : `${o.account} not in the chart — nothing replaced`;
  const also = o.also.length > 0
    ? `; also covers ${o.also.map((a) => `${a.code}${a.name ? ` ${a.name}` : ''}`).join(', ')} (with the accounts under them)`
    : '';
  return `Operating expense — ${ratePct(o.rateBp)} of sales excluding service (${fmtRm2(o.baseSen)}), ${standsFor}${also}`;
};

const monthWord = (ym: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : ym;
};

/** The sentence the commission line prints under: the bills it shows, in place of the release. */
export const commissionLabel = (c: PeriodCommission): string =>
  `${c.code}${c.name ? ` ${c.name}` : ''} — the commission bills for ${c.months.length > 0 ? c.months.map(monthWord).join(', ') : 'no month in the period'}, in place of the monthly release`;

const FAIR_RATE_WORDS: Record<'transport' | 'setupDismantle' | 'merchandise', string> = {
  transport: 'Transport', setupDismantle: 'Setup & dismantle', merchandise: 'Merchandise',
};
/** The sentence a fair rate prints under: its rate, its base, what it stands in for. */
export const fairRateLabel = (l: Extract<FairLine, { kind: 'rate' }>, baseSen: number): string => {
  const what = l.key === 'transport'
    ? "the logistics accounts (the Chart of Accounts' Logistics column) and the drivers' and helpers' pay"
    : l.replaced.length > 0 ? l.replaced.map((e) => `${e.code} ${e.name}`).join(', ') : 'nothing booked';
  return `${FAIR_RATE_WORDS[l.key]} — ${ratePct(l.rateBp)} of sales excluding service (${fmtRm2(baseSen)}), in place of ${what} (${fmtRm2(l.replacedSen)} booked)`;
};

/** The fair block, the first category of the expenses: the booked accounts as rows
    (they open their lines), each rate a row of its own saying what it stands in for. */
function fairNode(r: PerformanceReport, baseSen: number | null): LaidNode | null {
  if (!r.fair) return null;
  const kids: LaidNode[] = [];
  for (const l of r.fair.lines) {
    if (l.kind === 'booked') {
      for (const e of l.accounts) kids.push(laidLineNode(l.key === 'commission' && r.commission ? { ...e, label: commissionLabel(r.commission) } : e, baseSen));
    } else if (l.amountSen !== 0 || l.replacedSen !== 0) {
      kids.push({ kind: 'account', id: `fair:${l.key}`, label: fairRateLabel(l, r.totals.salesExServiceSen), amountSen: l.amountSen, pct: pctOf(l.amountSen, baseSen), children: [] });
    }
  }
  if (kids.length === 0) return null;
  const amountSen = kids.reduce((t, n) => t + n.amountSen, 0);
  return { kind: 'category', id: 'perf:fair', label: 'Fair costs', amountSen, pct: pctOf(amountSen, baseSen), children: kids };
}

/**
 * The lower part of the Performance P&L — the other income as booked, the
 * computed operating expense, every other expense as booked — on the
 * report's tree. The computed line carries the CODE of the account it
 * replaces, so it prints exactly where the owner placed that account (and
 * under Unassigned when the chart does not carry the code — the report then
 * says so in the line's own label). % of sales on every line.
 */
export function performanceLayout(r: PerformanceReport, layout: Layout, companyId: number, stored: boolean): PerformanceLayout {
  const baseSen = r.totals.salesSen > 0 ? r.totals.salesSen : null;
  const o = r.operatingExpense;
  const opex: LaidLine = { code: o.account, name: o.accountName ?? o.account, label: operatingExpenseLabel(o), amountSen: o.amountSen };
  const block = (key: string): LayoutItem[] => layout.blocks[key] ?? [];
  const fair = fairNode(r, baseSen);
  return {
    stored,
    baseSen,
    otherIncome: layOutBlock(block('otherIncome'), r.otherIncome, companyId, baseSen),
    /* The fair costs first, as one block; a covered account that booked something
       prints where it always sits, at nil — the money is inside the rate's line. */
    expenses: [
      ...(fair ? [fair] : []),
      ...layOutBlock(block('expenses'), [
        opex,
        ...r.otherExpenses.map((e): LaidLine => (r.commission && e.code === r.commission.code ? { ...e, label: commissionLabel(r.commission) } : e)),
        ...r.inRate.map((e) => ({ code: e.code, name: e.name, amountSen: 0 })),
      ], companyId, baseSen),
    ],
  };
}
