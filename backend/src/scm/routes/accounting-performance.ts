/* The Performance P&L (owner 2026-09-12; docs/bugs/0835): sales and cost of
   sales from the SALES ORDERS dated in the period (every status except DRAFT
   and CANCELLED, delivered or not), per group — bedframe / mattress / sofa /
   dining / accessory / service — with gross profit and %; operating expense
   as an adjustable rate (16%) of sales excluding service IN PLACE OF the one
   ledger account the company names (900-O001), every other expense as the
   ledger booked it by journal date; net. Computed live on every read.
   GET /accounting/reports/performance?from&to;
   POST /accounting/reports/performance/settings {rateBp, account}.
   The arithmetic is acc/performance-pnl.ts; see accounting.md. */

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { paginateAll } from '../lib/paginate-all';
import { SO_NOT_AN_ORDER } from '../shared/so-deliverable-states';
import { loadAccounts, loadSums, sectionResolver } from './accounting-reports';
import {
  buildPerformanceReport, loadPerformanceSettings, savePerformanceSettings,
  type PerfExpense, type PerfLine, type PerfOrder,
} from '../../acc/performance-pnl';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
const requirePerm = (c: Ctx): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to read the financial statements." };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const who = (c: Ctx): string | null =>
  (c.get('houzsUser') as { name?: string } | undefined)?.name ?? (c.get('user') as { id?: string } | undefined)?.id ?? null;
const failed = (e: unknown): string => String((e as { message?: string })?.message ?? e);

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
  const companyId = co.companyId;

  const st = await loadPerformanceSettings(sb, companyId);
  if (!st.ok) return c.json({ error: 'load_failed', reason: st.reason }, 500);

  /* The orders of the period, by SO date. Status is an enum the fake client
     cannot be trusted to compare; the DRAFT/CANCELLED filter is in code. */
  const sos = await paginateAll<PerfOrder>((f, t) =>
    sb.from('mfg_sales_orders')
      .select('doc_no, so_date, status, delivery_fee_sen')
      .eq('company_id', companyId).gte('so_date', from).lte('so_date', to)
      .order('so_date').order('doc_no').range(f, t));
  if (sos.error) return c.json({ error: 'load_failed', reason: failed(sos.error) }, 500);
  const orders = (sos.data ?? []) as PerfOrder[];
  const liveDocs = orders.filter((o) => !SO_NOT_AN_ORDER.has(String(o.status))).map((o) => o.doc_no);

  /* Their lines, in chunks — PostgREST's `in` list has a length limit. */
  const lines: PerfLine[] = [];
  for (let i = 0; i < liveDocs.length; i += 150) {
    const chunk = liveDocs.slice(i, i + 150);
    const its = await paginateAll<PerfLine>((f, t) =>
      sb.from('mfg_sales_order_items')
        .select('doc_no, item_group, item_code, qty, total_sen, unit_cost_sen, line_cost_sen, cancelled')
        .eq('company_id', companyId).in('doc_no', chunk)
        .order('id').range(f, t));
    if (its.error) return c.json({ error: 'load_failed', reason: failed(its.error) }, 500);
    lines.push(...((its.data ?? []) as PerfLine[]));
  }

  /* The expense side: the ledger's EXPENSES section for the same dates, the
     way the standard P&L reads it (one source, one section rule). */
  const [sums, accs] = await Promise.all([loadSums(sb, companyId, from, to), loadAccounts(sb, companyId)]);
  if (!sums.ok) return c.json({ error: 'load_failed', reason: sums.reason }, 500);
  if (!accs.ok) return c.json({ error: 'load_failed', reason: accs.reason }, 500);
  const secOf = sectionResolver(accs.accounts);
  const expenses: PerfExpense[] = sums.sums
    .filter((r) => secOf(r) === 'EXPENSES')
    .map((r) => ({ code: r.code, name: r.name, amountSen: r.drSen - r.crSen }));

  /* The account the rate stands in for, as the chart names it. */
  const { data: acct, error: acctErr } = await sb.from('accounts')
    .select('account_code, account_name')
    .eq('company_id', companyId).eq('account_code', st.settings.account)
    .maybeSingle();
  if (acctErr) return c.json({ error: 'load_failed', reason: failed(acctErr) }, 500);
  const account = acct ? { code: String((acct as { account_code: string }).account_code), name: String((acct as { account_name?: string | null }).account_name ?? '') } : null;

  return c.json(buildPerformanceReport({ from, to, orders, lines, expenses, settings: st.settings, account }));
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
