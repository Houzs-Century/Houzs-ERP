// ----------------------------------------------------------------------------
// accounting-self-check — Books › Self-check run and summed (the owner's
// Claude Design, batch 6 c3). One run reads what the page shows — the
// control check (acc/control-check), the cancelled orders still holding
// money, the official receipts owed — and leaves one row in
// scm.acc_selfcheck_runs: how many of the eight checks name something to look
// at, and the items To do lists. POST /accounting/self-check/run is the
// page's Run again (it returns the three reads, so the page needs no second
// read); the nightly 00:05 job runs it for every company. Reads only — the
// row is a summary; nothing posts.
// ----------------------------------------------------------------------------

import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { ordersWithMoney, type ConvertSource } from '../lib/so-money';
import { runControlCheck, type ControlCheckResult } from '../../acc/control-check';
import { selfCheckSummary, type SelfCheckSummary } from '../../acc/self-check';
import { receiptsPlanFor, type BackfillPlan } from './accounting-receipts-backfill';

type Db = any;

export type SelfCheckRead = {
  control: ControlCheckResult;
  cancelled: { orders: ConvertSource[]; totalRemainingSen: number } | { error: string };
  receipts: BackfillPlan | { error: string };
  summary: SelfCheckSummary;
};

/** Every read the page makes, for one company, and what they sum to. */
export async function runSelfCheck(sb: Db, companyId: number): Promise<SelfCheckRead> {
  const [control, cancelled, receipts] = await Promise.all([
    runControlCheck(sb, companyId),
    ordersWithMoney(sb, companyId, { phone: null, cancelledOnly: true }),
    receiptsPlanFor(sb, companyId),
  ]);
  const summary = selfCheckSummary({
    control: { ok: true, value: control },
    cancelled: cancelled.ok ? { ok: true, count: cancelled.rows.length } : { ok: false, reason: cancelled.reason },
    receipts: receipts.ok ? { ok: true, count: receipts.plan.total } : { ok: false, reason: receipts.reason },
  });
  return {
    control,
    cancelled: cancelled.ok
      ? { orders: cancelled.rows, totalRemainingSen: cancelled.rows.reduce((t, r) => t + r.remainingSen, 0) }
      : { error: cancelled.reason },
    receipts: receipts.ok ? receipts.plan : { error: receipts.reason },
    summary,
  };
}

/** The summary as one row: what To do reads. */
export async function recordSelfCheck(sb: Db, companyId: number, s: SelfCheckSummary, trigger: 'cron' | 'manual', ranBy: string | null): Promise<{ ok: true; ranAt: string } | { ok: false; reason: string }> {
  const ranAt = new Date().toISOString();
  const { error } = await sb.from('acc_selfcheck_runs').insert({
    company_id: companyId, ran_at: ranAt, trigger, ran_by: ranBy, checks: s.checks, findings: s.findings, items: s.items,
  });
  if (error) return { ok: false, reason: `self-check run: ${String(error.message ?? error)}` };
  return { ok: true, ranAt };
}

export type LatestSelfCheck = { ranAt: string; findings: number; checks: number; items: string[] };

/** The newest run's summary for the company, or null when it never ran. */
export async function latestSelfCheck(sb: Db, companyId: number): Promise<{ ok: true; run: LatestSelfCheck | null } | { ok: false; reason: string }> {
  const { data, error } = await sb.from('acc_selfcheck_runs')
    .select('ran_at, findings, checks, items')
    .eq('company_id', companyId)
    .order('ran_at', { ascending: false })
    .limit(1);
  if (error) return { ok: false, reason: String(error.message ?? error) };
  const row = (Array.isArray(data) ? data[0] : null) as { ran_at: string; findings: number; checks: number; items: unknown } | null | undefined;
  if (!row) return { ok: true, run: null };
  return {
    ok: true,
    run: {
      ranAt: String(row.ran_at), findings: Number(row.findings ?? 0), checks: Number(row.checks ?? 0),
      items: Array.isArray(row.items) ? row.items.map(String) : [],
    },
  };
}

/** The nightly run: every company, one row each; a company that fails is said, the rest still run. */
export async function sweepSelfCheck(sb: Db, companyIds: number[]): Promise<Array<{ companyId: number; ok: boolean; findings?: number; reason?: string }>> {
  const out: Array<{ companyId: number; ok: boolean; findings?: number; reason?: string }> = [];
  for (const companyId of companyIds) {
    try {
      const read = await runSelfCheck(sb, companyId);
      const saved = await recordSelfCheck(sb, companyId, read.summary, 'cron', null);
      out.push(saved.ok ? { companyId, ok: true, findings: read.summary.findings } : { companyId, ok: false, reason: saved.reason });
    } catch (e) {
      out.push({ companyId, ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/* ── POST /accounting/self-check/run — the page's Run again ───────────────── */
export const selfCheckRunHandler = async (c: any): Promise<Response> => {
  if (!hasHouzsPerm(c, 'scm.payment_voucher.post')) return c.json({ error: "You don't have permission to run the self-check." }, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const read = await runSelfCheck(sb, co.companyId);
  const by = (c.get('houzsUser') as { name?: string } | undefined)?.name ?? null;
  const saved = await recordSelfCheck(sb, co.companyId, read.summary, 'manual', by);
  /* The reads stand even when the summary could not be kept; the page says so. */
  return c.json({ ...read, ranAt: saved.ok ? saved.ranAt : new Date().toISOString(), ...(saved.ok ? {} : { recordError: saved.reason }) });
};
