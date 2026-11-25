/* The Performance P&L (owner 2026-09-12; docs/bugs/0835): sales and cost of
   sales from the SALES ORDERS dated in the period (every status except DRAFT
   and CANCELLED, delivered or not), per group — bedframe / mattress / sofa /
   dining / accessory / service — with gross profit and %; operating expense
   as an adjustable rate (16%) of sales excluding service IN PLACE OF the one
   ledger account the company names (900-O001), every other expense — and
   the other income (owner 2026-09-12: performance GL 要放 other income) — as
   the ledger booked it by journal date; net. Computed live on every read.
   GET /accounting/reports/performance?from&to;
   POST /accounting/reports/performance/settings {rateBp, account, also}.
   `also`: the other accounts the rate covers (owner 2026-10-06: 2990's
   transport is inside the 16%), each with the accounts under it.
   The arithmetic is acc/performance-pnl.ts; see accounting.md. */

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { SO_NOT_AN_ORDER } from '../shared/so-deliverable-states';
import { countsInTheBooks } from '../../acc/reversal-pairs';
import { isManpowerLine, pnlAccountsOf } from '../lib/logistics-pnl';
import { loadAccounts, loadSums, sectionResolver, type AccountRow, type SumRow } from './accounting-reports';
import { allowedIds, resolveLayout, type ResolvedLayout } from './accounting-report-layouts';
import {
  FAIR_RATE_KEYS, accountsUnder, buildPerformanceReport, loadPerformanceSettings, normaliseAlso, performanceLayout, saveFairRates, savePerformanceSettings,
  type FairInputs, type FairRateKey, type PerfExpense, type PerfLine, type PerfOrder, type PerformanceLayout, type PerformanceReport, type PerformanceSettings,
} from '../../acc/performance-pnl';
import { commissionForPeriod, loadCommissionFacts, type CommissionFacts } from '../../acc/performance-commission';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
const requirePerm = (c: Ctx): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const who = (c: Ctx): string | null =>
  (c.get('houzsUser') as { name?: string } | undefined)?.name ?? (c.get('user') as { id?: string } | undefined)?.id ?? null;
const failed = (e: unknown): string => String((e as { message?: string })?.message ?? e);

/* ── Where the report reads from (the route: the database; the Dashboard: its preloaded window) ── */
/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof loadSums>[0];
export type PerfSources = {
  sums: (from: string | null, to: string | null) => Promise<{ ok: true; sums: SumRow[] } | { ok: false; reason: string }>;
  accounts: () => Promise<{ ok: true; accounts: AccountRow[] } | { ok: false; reason: string }>;
  layout: () => Promise<({ ok: true } & ResolvedLayout) | { ok: false; reason: string }>;
  /** The company's rate and account. */
  settings: () => Promise<{ ok: true; settings: PerformanceSettings } | { ok: false; reason: string }>;
  /** Every sales order dated in [from, to], any status, by SO date then doc_no. */
  orders: (from: string, to: string) => Promise<{ ok: true; orders: PerfOrder[] } | { ok: false; reason: string }>;
  /** The lines of the named orders. */
  lines: (docNos: string[]) => Promise<{ ok: true; lines: PerfLine[] } | { ok: false; reason: string }>;
  /** The account the rate stands in for, as the chart names it; null when the chart has no such code. */
  rateAccount: (code: string) => Promise<{ ok: true; account: { code: string; name: string } | null } | { ok: false; reason: string }>;
  /** The commission bills on the prepayment and what the release booked (owner 2026-11-25); null facts = none kept. */
  commission: () => Promise<{ ok: true; facts: CommissionFacts | null } | { ok: false; reason: string }>;
  /** The drivers' and helpers' pay lines on these payroll accounts in [from, to] (the
      Logistics P&L's manpower lines) — read only for a company with a fair block. */
  logisticsPay: (codes: readonly string[], from: string, to: string) => Promise<{ ok: true; lines: PayLine[] } | { ok: false; reason: string }>;
};
/** One driver's or helper's pay line: its account, its day, its amount (debit less credit). */
export type PayLine = { code: string; day: string; sen: number };

/** The drivers' and helpers' pay lines the books count, read from the ledger. */
export async function readLogisticsPay(sb: Sb, companyId: number, codes: readonly string[], from: string, to: string): Promise<{ ok: true; lines: PayLine[] } | { ok: false; reason: string }> {
  if (codes.length === 0) return { ok: true, lines: [] };
  const res = await chunkIn<Record<string, unknown>>([...codes], (b, f, t) => sb.from('v_gl_entries')
    .select('line_id, account_code, entry_date, debit_sen, credit_sen, notes, posted, reversed, reversed_by_je')
    .eq('company_id', companyId).in('account_code', b).gte('entry_date', from).lte('entry_date', to)
    .order('line_id').range(f, t));
  if (res.error) return { ok: false, reason: failed(res.error) };
  return {
    ok: true,
    lines: res.data
      .filter((l) => countsInTheBooks(l as { posted?: boolean | null; reversed?: boolean | null; reversed_by_je?: string | null }) && isManpowerLine(l.notes == null ? null : String(l.notes)))
      .map((l) => ({ code: String(l.account_code), day: String(l.entry_date).slice(0, 10), sen: Number(l.debit_sen ?? 0) - Number(l.credit_sen ?? 0) })),
  };
}

/** The accounts the fair block works from, out of the chart: the Logistics P&L's own
    expense accounts and its payroll accounts (where the drivers' and helpers' lines are). */
export function fairChartOf(accounts: readonly AccountRow[]): { logistics: Set<string>; payroll: string[] } {
  const a = pnlAccountsOf(accounts.map((x) => ({
    account_code: x.account_code, account_name: x.account_name ?? null, account_type: x.account_type,
    is_active: x.is_active ?? null, parent_code: x.parent_code ?? null, logistics_row: x.logistics_row ?? null,
  })));
  return { logistics: new Set([...a.outsource.keys(), ...a.petrol, ...a.upkeep, ...a.otherLorry, ...a.roadTax]), payroll: [...a.salary].sort() };
}
/** The database, as the route reads it. Every read the report needs is a
    source, so the Dashboard can answer all of them from one preloaded window
    (2026-09-22, the owner's "loading 很慢": the orders, their lines, the
    settings and the rate's account were read again for every period). */
export const perfDbSources = (sb: Sb, companyId: number, layoutIds: number[]): PerfSources => {
  /* Read once per source: the By-month view asks for every month. */
  let commission: ReturnType<PerfSources['commission']> | null = null;
  return {
  sums: (from, to) => loadSums(sb, companyId, from, to),
  accounts: () => loadAccounts(sb, companyId),
  layout: () => resolveLayout(sb, layoutIds, 'performance'),
  settings: () => loadPerformanceSettings(sb, companyId),
  orders: async (from, to) => {
    /* The orders of the period, by SO date. Status is an enum the fake client
       cannot be trusted to compare; the DRAFT/CANCELLED filter is in code. */
    const sos = await paginateAll<PerfOrder>((f, t) =>
      sb.from('mfg_sales_orders')
        .select('doc_no, so_date, status, delivery_fee_sen')
        .eq('company_id', companyId).gte('so_date', from).lte('so_date', to)
        .order('so_date').order('doc_no').range(f, t));
    if (sos.error) return { ok: false, reason: failed(sos.error) };
    return { ok: true, orders: (sos.data ?? []) as PerfOrder[] };
  },
  lines: async (docNos) => {
    /* Their lines, in chunks — PostgREST's `in` list has a length limit. */
    const its = await chunkIn<PerfLine>(docNos, (batch, f, t) =>
      sb.from('mfg_sales_order_items')
        .select('doc_no, item_group, item_code, qty, total_sen, unit_cost_sen, line_cost_sen, cancelled')
        .eq('company_id', companyId).in('doc_no', batch)
        .order('id').range(f, t));
    if (its.error) return { ok: false, reason: failed(its.error) };
    return { ok: true, lines: its.data };
  },
  rateAccount: async (code) => {
    const { data: acct, error: acctErr } = await sb.from('accounts')
      .select('account_code, account_name')
      .eq('company_id', companyId).eq('account_code', code)
      .maybeSingle();
    if (acctErr) return { ok: false, reason: failed(acctErr) };
    const row = acct as { account_code: string; account_name?: string | null } | null;
    return { ok: true, account: row ? { code: String(row.account_code), name: String(row.account_name ?? '') } : null };
  },
  commission: () => (commission ??= loadCommissionFacts(sb, companyId)),
  logisticsPay: (codes, from, to) => readLogisticsPay(sb, companyId, codes, from, to),
  };
};
export type PerformancePayload = PerformanceReport & { layout: PerformanceLayout };

/** The Performance P&L for [from, to] — the route's figures, and the Dashboard's. */
export async function buildPerformance(companyId: number, from: string, to: string, src: PerfSources): Promise<{ ok: true; report: PerformancePayload } | { ok: false; reason: string }> {
  const st = await src.settings();
  if (!st.ok) return { ok: false, reason: st.reason };

  const sos = await src.orders(from, to);
  if (!sos.ok) return { ok: false, reason: sos.reason };
  const orders = sos.orders;
  const liveDocs = orders.filter((o) => !SO_NOT_AN_ORDER.has(String(o.status))).map((o) => o.doc_no);
  const its = await src.lines(liveDocs);
  if (!its.ok) return { ok: false, reason: its.reason };
  const lines = its.lines;

  /* The expense side: the ledger's EXPENSES section for the same dates, the
     way the standard P&L reads it (one source, one section rule). */
  const [sums, accs] = await Promise.all([src.sums(from, to), src.accounts()]);
  if (!sums.ok) return { ok: false, reason: sums.reason };
  if (!accs.ok) return { ok: false, reason: accs.reason };
  const secOf = sectionResolver(accs.accounts);
  const expenses: PerfExpense[] = sums.sums
    .filter((r) => secOf(r) === 'EXPENSES')
    .map((r) => ({ code: r.code, name: r.name, amountSen: r.drSen - r.crSen }));
  /* The other income the standard P&L shows — the same two sections, credit-positive. */
  const otherIncome: PerfExpense[] = sums.sums
    .filter((r) => ['OTHER INCOMES', 'EXTRA-ORDINARY INCOME'].includes(secOf(r)))
    .map((r) => ({ code: r.code, name: r.name, amountSen: r.crSen - r.drSen }));

  /* The account the rate stands in for, as the chart names it. */
  const acct = await src.rateAccount(st.settings.account);
  if (!acct.ok) return { ok: false, reason: acct.reason };

  /* The account part on the report's own layout (docs/bugs/0912). */
  const laid = await src.layout();
  if (!laid.ok) return { ok: false, reason: laid.reason };
  /* The other accounts the rate covers, with every account under them in the chart. */
  const alsoCodes = accountsUnder(st.settings.also, accs.accounts);
  const nameOf = new Map(accs.accounts.map((a) => [a.account_code, a.account_name ?? null]));
  const alsoNamed = st.settings.also.map((code) => ({ code, name: nameOf.get(code) ?? null }));
  /* The commission: the bills for the period's months in place of the release. */
  const cf = await src.commission();
  if (!cf.ok) return { ok: false, reason: cf.reason };
  const commission = commissionForPeriod(cf.facts, from, to);
  /* The fair block (owner 2026-11-25), for a company that keeps one. */
  let fair: FairInputs | null = null;
  const fs = st.settings.fair;
  if (fs) {
    const fc = fairChartOf(accs.accounts);
    const pay = await src.logisticsPay(fc.payroll, from, to);
    if (!pay.ok) return { ok: false, reason: pay.reason };
    const byCode = new Map<string, number>();
    for (const l of pay.lines) byCode.set(l.code, (byCode.get(l.code) ?? 0) + l.sen);
    fair = {
      settings: fs,
      rental: accountsUnder(fs.rental, accs.accounts), setup: accountsUnder(fs.setup, accs.accounts),
      setupDismantle: accountsUnder(fs.setupDismantle, accs.accounts), merchandise: accountsUnder(fs.merchandise, accs.accounts),
      logistics: fc.logistics, pay: byCode,
    };
  }
  const report = buildPerformanceReport({ from, to, orders, lines, expenses, otherIncome, settings: st.settings, account: acct.account, alsoCodes, alsoNamed, commission, fair });
  return { ok: true, report: { ...report, layout: performanceLayout(report, laid.layout, companyId, laid.stored) } };
}

/* ── GET /accounting/reports/performance?from=YYYY-MM-DD&to=YYYY-MM-DD ───── */
export const performanceReport = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!DATE.test(from) || !DATE.test(to) || from > to) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM-DD, from on or before to.' }, 400);
  }
  const sb = c.get('supabase');
  const r = await buildPerformance(co.companyId, from, to, perfDbSources(sb, co.companyId, allowedIds(c)));
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  return c.json(r.report);
};

/* ── GET /accounting/reports/performance/months?from=YYYY-MM&to=YYYY-MM ──────
   The Performance P&L's chart (the owner's Claude Design, batch 6 read c6):
   per month, the report's own sales, cost of sales, gross profit, other
   income, expenses (operating expense at the rate + as booked) and net
   performance — buildPerformance month by month, its inputs read ONCE for
   the window (twelve calls to the full report would read and rebuild every
   order twelve times; the ledger's sums are read per month, as the report
   reads them). Reads only. */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** The longest window the chart asks for (24 months; the screen asks 12). */
export const PERFORMANCE_MONTHS_MAX = 24;

export type PerformanceMonth = {
  month: string; from: string; to: string;
  salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null;
  otherIncomeSen: number; expensesSen: number; netSen: number; netPct: number | null;
  /** The month's orders, its product groups' sales and cost, and its commission bills — the
      Department P&L's Exhibition reads them (owner 2026-11-25), so the two reports agree. */
  orders: PerformanceReport['orders'];
  groups: Array<Pick<PerformanceReport['groups'][number], 'key' | 'label' | 'salesSen' | 'cogsSen'>>;
  commission: PerformanceReport['commission'];
};

/** Every month from `from` to `to` (YYYY-MM, inclusive), each as its first and last day. */
export function monthsBetween(from: string, to: string): Array<{ month: string; from: string; to: string }> {
  const out: Array<{ month: string; from: string; to: string }> = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push({ month, from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The report's sources over a window read once: settings, accounts, layout,
    the window's orders and their lines and the rate's account answered from
    memory; the ledger's sums still per period. */
export async function windowPerfSources(db: PerfSources, from: string, to: string): Promise<{ ok: true; src: PerfSources } | { ok: false; reason: string }> {
  const [st, accs, laid, sos, cf] = await Promise.all([db.settings(), db.accounts(), db.layout(), db.orders(from, to), db.commission()]);
  if (!st.ok) return { ok: false, reason: st.reason };
  if (!cf.ok) return { ok: false, reason: cf.reason };
  if (!accs.ok) return { ok: false, reason: accs.reason };
  if (!laid.ok) return { ok: false, reason: laid.reason };
  if (!sos.ok) return { ok: false, reason: sos.reason };
  const live = sos.orders.filter((o) => !SO_NOT_AN_ORDER.has(String(o.status))).map((o) => o.doc_no);
  const [its, acct, pay] = await Promise.all([
    db.lines(live), db.rateAccount(st.settings.account),
    st.settings.fair ? db.logisticsPay(fairChartOf(accs.accounts).payroll, from, to) : Promise.resolve({ ok: true as const, lines: [] as PayLine[] }),
  ]);
  if (!its.ok) return { ok: false, reason: its.reason };
  if (!acct.ok) return { ok: false, reason: acct.reason };
  if (!pay.ok) return { ok: false, reason: pay.reason };
  return {
    ok: true,
    src: {
      sums: db.sums,
      accounts: () => Promise.resolve(accs),
      layout: () => Promise.resolve(laid),
      settings: () => Promise.resolve(st),
      orders: (f, t) => Promise.resolve({ ok: true, orders: sos.orders.filter((o) => o.so_date >= f && o.so_date <= t) }),
      lines: (docNos) => {
        const wanted = new Set(docNos);
        return Promise.resolve({ ok: true, lines: its.lines.filter((l) => wanted.has(l.doc_no)) });
      },
      rateAccount: () => Promise.resolve(acct),
      commission: () => Promise.resolve(cf),
      logisticsPay: (codes, f, t) => {
        const wanted = new Set(codes);
        return Promise.resolve({ ok: true, lines: pay.lines.filter((l) => wanted.has(l.code) && l.day >= f && l.day <= t) });
      },
    },
  };
}

/** The months' figures, each from the report's own builder. */
export async function buildPerformanceMonths(companyId: number, from: string, to: string, db: PerfSources): Promise<{ ok: true; months: PerformanceMonth[] } | { ok: false; reason: string }> {
  const months = monthsBetween(from, to);
  const first = months.at(0);
  const last = months.at(-1);
  if (!first || !last) return { ok: true, months: [] };
  const w = await windowPerfSources(db, first.from, last.to);
  if (!w.ok) return { ok: false, reason: w.reason };
  const out: PerformanceMonth[] = [];
  for (const m of months) {
    const r = await buildPerformance(companyId, m.from, m.to, w.src);
    if (!r.ok) return { ok: false, reason: `${m.month}: ${r.reason}` };
    const p = r.report;
    out.push({
      month: m.month, from: m.from, to: m.to,
      salesSen: p.totals.salesSen, cogsSen: p.totals.cogsSen, gpSen: p.totals.gpSen, gpPct: p.totals.gpPct,
      otherIncomeSen: p.otherIncomeSen, expensesSen: p.operatingExpense.amountSen + (p.fair?.totalSen ?? 0) + p.otherExpensesSen,
      netSen: p.netSen, netPct: p.netPct,
      orders: p.orders,
      groups: p.groups.map((g) => ({ key: g.key, label: g.label, salesSen: g.salesSen, cogsSen: g.cogsSen })),
      commission: p.commission,
    });
  }
  return { ok: true, months: out };
}

export const performanceMonthsHandler = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const from = String(c.req.query('from') ?? '').trim();
  const to = String(c.req.query('to') ?? '').trim();
  if (!MONTH.test(from) || !MONTH.test(to) || from > to) {
    return c.json({ error: 'bad_range', message: 'from and to must be YYYY-MM, from on or before to.' }, 400);
  }
  if (monthsBetween(from, to).length > PERFORMANCE_MONTHS_MAX) {
    return c.json({ error: 'bad_range', message: `At most ${PERFORMANCE_MONTHS_MAX} months.` }, 400);
  }
  const sb = c.get('supabase');
  const r = await buildPerformanceMonths(co.companyId, from, to, perfDbSources(sb, co.companyId, allowedIds(c)));
  if (!r.ok) return c.json({ error: 'load_failed', reason: r.reason }, 500);
  return c.json({ from, to, months: r.months });
};

/* ── POST /accounting/reports/performance/settings {rateBp, account} ─────── */
export const savePerformanceSettingsHandler = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { rateBp?: unknown; account?: unknown; also?: unknown; fair?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const rateBp = Number(body.rateBp);
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) {
    return c.json({ error: 'bad_rate', message: 'The operating expense rate is whole basis points from 0 to 10000 (0% to 100%).' }, 400);
  }
  const account = String(body.account ?? '').trim().toUpperCase();
  if (account === '' || account.length > 32) {
    return c.json({ error: 'account_required', message: 'Name the ledger account the rate stands in for (900-O001).' }, 400);
  }
  const also = normaliseAlso(body.also ?? [], account);
  if (also.length > 40 || also.some((code) => code.length > 32 || !/^[A-Z0-9-]+$/.test(code))) {
    return c.json({ error: 'bad_also', message: 'The other accounts the rate covers are account codes (900-T004), at most 40.' }, 400);
  }
  /* The fair block's three rates (owner 2026-11-25), when sent: whole basis points, the accounts kept. */
  let rates: Record<FairRateKey, number> | null = null;
  if (body.fair != null) {
    const f = body.fair as Record<string, unknown>;
    const bad = typeof f !== 'object' || FAIR_RATE_KEYS.some((k) => !Number.isInteger(f[k]) || Number(f[k]) < 0 || Number(f[k]) > 10000);
    if (bad) return c.json({ error: 'bad_fair_rate', message: 'Each fair rate is whole basis points from 0 to 10000 (0% to 100%).' }, 400);
    rates = { transportBp: Number(f.transportBp), setupDismantleBp: Number(f.setupDismantleBp), merchandiseBp: Number(f.merchandiseBp) };
  }
  const sb = c.get('supabase');
  let fair = null as PerformanceSettings['fair'];
  if (rates) {
    const now = await loadPerformanceSettings(sb, co.companyId);
    if (!now.ok) return c.json({ error: 'load_failed', reason: now.reason }, 500);
    if (!now.settings.fair) return c.json({ error: 'no_fair_block', message: 'This company keeps no fair costs.' }, 400);
    fair = { ...now.settings.fair, ...rates };
  }
  const saved = await savePerformanceSettings(sb, co.companyId, { rateBp, account, also }, who(c));
  if (!saved.ok) return c.json({ error: 'save_failed', reason: saved.reason }, 500);
  if (fair && rates) {
    const f = await saveFairRates(sb, co.companyId, fair, rates, who(c));
    if (!f.ok) return c.json({ error: 'save_failed', reason: f.reason }, 500);
  }
  return c.json({ ok: true, settings: { rateBp, account, also, ...(fair ? { fair } : {}) } });
};
