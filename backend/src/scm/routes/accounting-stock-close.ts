// ----------------------------------------------------------------------------
// accounting-stock-close — the month-end screen's two doors (GL redesign
// item 4). The CLOSE itself lives in acc/stock-close.ts and mostly runs from
// the nightly cron; this file is the visible half the owner asked for
// (我有没有办法看到你每天检查的成果): the run log, the live value, and a
// manual Run button for the impatient path.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { closeStockMonth, stockValueByBucketAsOf, sweepMonths } from '../../acc/stock-close';
import { closedStockMonths } from '../../acc/stock-close-months';

/** Runs the screen lists: the last 90 days (two a night, a few by hand). */
export const RUN_DAYS = 90;
const RUN_LIMIT = 400;

const requirePerm = (c: any): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');

/* ── GET /accounting/stock-close — run log + the live number ────────────────
   Books › Stock close (batch 6 c4): the live value with its buckets, every
   month the close has booked (its buckets, posted or re-posted, the entries)
   and the runs of the last 90 days. */
export const stockCloseStatus = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const since = new Date(Date.now() - RUN_DAYS * 86_400_000).toISOString();
  const [runsRes, live, months] = await Promise.all([
    sb.from('acc_stock_close_runs')
      .select('month, ran_at, trigger, stock_value_sen, action, je_no, rev_je_no, note')
      .eq('company_id', co.companyId)
      .gte('ran_at', since)
      .order('ran_at', { ascending: false })
      .limit(RUN_LIMIT),
    stockValueByBucketAsOf(sb, co.companyId, new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)),
    closedStockMonths(sb, co.companyId),
  ]);
  if (runsRes.error) return c.json({ error: 'load_failed', reason: runsRes.error.message }, 500);
  if (!live.ok) return c.json({ error: 'load_failed', reason: live.reason }, 500);
  if (!months.ok) return c.json({ error: 'load_failed', reason: months.reason }, 500);

  return c.json({
    liveValueSen: live.totalSen,
    liveBuckets: live.buckets,
    defaultMonth: sweepMonths()[0],
    sweepMonths: sweepMonths(),
    runs: runsRes.data ?? [],
    months: months.months,
  });
};

/* ── POST /accounting/stock-close/run — {month?} defaults to last month ───── */
export const stockCloseRun = async (c: any): Promise<Response> => {
  if (!requirePerm(c)) return c.json({ error: "You don't have permission to post to the general ledger." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body = default month */ }
  const month = String(body?.month ?? '').trim() || sweepMonths()[0];
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'bad_month', message: 'Month must be YYYY-MM.' }, 400);

  const sb = c.get('supabase');
  const outcome = await closeStockMonth(sb, co.companyId, month, 'manual');
  return c.json({ outcome }, outcome.action === 'failed' ? 500 : 200);
};
