/* The Performance P&L (owner 2026-09-12; docs/bugs/0835): sales and cost of
   sales from the SALES ORDERS dated in the period (every status except DRAFT
   and CANCELLED, delivered or not), per group — bedframe / mattress / sofa /
   dining / accessory / service — with gross profit and %; operating expense
   as an adjustable rate (16%) of sales excluding service IN PLACE OF the one
   ledger account the company names (900-O001), every other expense — and
   the other income (owner 2026-09-12: performance GL 要放 other income) — as
   the ledger booked it by journal date; net. Computed live on every read.
   GET /accounting/reports/performance?from&to;
   POST /accounting/reports/performance/settings {rateBp, account}.
   The arithmetic is acc/performance-pnl.ts; see accounting.md. */

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import { SO_NOT_AN_ORDER } from '../shared/so-deliverable-states';
import { loadAccounts, loadSums, sectionResolver, type AccountRow, type SumRow } from './accounting-reports';
import { allowedIds, resolveLayout, type ResolvedLayout } from './accounting-report-layouts';
import {
  buildPerformanceReport, loadPerformanceSettings, performanceLayout, savePerformanceSettings,
  type PerfExpense, type PerfLine, type PerfOrder, type PerformanceLayout, type PerformanceReport, type PerformanceSettings,
} from '../../acc/performance-pnl';

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
};
/** The database, as the route reads it. Every read the report needs is a
    source, so the Dashboard can answer all of them from one preloaded window
    (2026-09-22, the owner's "loading 很慢": the orders, their lines, the
    settings and the rate's account were read again for every period). */
export const perfDbSources = (sb: Sb, companyId: number, layoutIds: number[]): PerfSources => ({
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
});
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
  const report = buildPerformanceReport({ from, to, orders, lines, expenses, otherIncome, settings: st.settings, account: acct.account });
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

/* ── POST /accounting/reports/performance/settings {rateBp, account} ─────── */
export const savePerformanceSettingsHandler = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { rateBp?: unknown; account?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const rateBp = Number(body.rateBp);
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) {
    return c.json({ error: 'bad_rate', message: 'The operating expense rate is whole basis points from 0 to 10000 (0% to 100%).' }, 400);
  }
  const account = String(body.account ?? '').trim().toUpperCase();
  if (account === '' || account.length > 32) {
    return c.json({ error: 'account_required', message: 'Name the ledger account the rate stands in for (900-O001).' }, 400);
  }
  const saved = await savePerformanceSettings(c.get('supabase'), co.companyId, { rateBp, account }, who(c));
  if (!saved.ok) return c.json({ error: 'save_failed', reason: saved.reason }, 500);
  return c.json({ ok: true, settings: { rateBp, account } });
};
