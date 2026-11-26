// ----------------------------------------------------------------------------
// accounting-commission-release — Books › Commission release, the visible half
// of the monthly release (acc/commission-release.ts; owner 2026-11-25). The
// release itself runs from the nightly cron once the company switches it on;
// this file is what Finance and the owner see: what the prepayment holds, bill
// by bill, what each month releases and what is booked, every run, each bill's
// orders — and the switch and a Run now.
//
//   GET  /accounting/commission-release                — the plan, the entries, the runs
//   GET  /accounting/commission-release/orders?layer=  — one bill's orders
//   POST /accounting/commission-release/run            — book every month now
//   POST /accounting/commission-release/settings {on}  — the company's switch
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { requireActiveCompanyId } from '../lib/companyScope';
import { layerOrders, planCommissionRelease } from '../../acc/commission-release-plan';
import {
  loadReleaseData, loadReleaseSettings, mytMonths, postedReleaseMonths, runCommissionRelease, saveReleaseSwitch,
} from '../../acc/commission-release';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** Runs the page lists: the last 90 days (a few a night, a few by hand). */
export const RELEASE_RUN_DAYS = 90;
const RUN_LIMIT = 600;

const requirePerm = (c: Ctx): boolean => hasHouzsPerm(c, 'scm.payment_voucher.post');
const NO_PERM = { error: "You don't have permission to post to the general ledger." };
const who = (c: Ctx): string | null =>
  (c.get('houzsUser') as { name?: string } | undefined)?.name ?? (c.get('user') as { id?: string } | undefined)?.id ?? null;

export const commissionReleaseStatus = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');

  const st = await loadReleaseSettings(sb, co.companyId);
  if (!st.ok) return c.json({ error: 'load_failed', reason: st.reason }, 500);
  const { current, last } = mytMonths(Date.now());
  const data = await loadReleaseData(sb, co.companyId, st.settings.booksStart, current);
  if (!data.ok) return c.json({ error: 'load_failed', reason: data.reason }, 500);
  const plan = planCommissionRelease(data.data.input);

  const since = new Date(Date.now() - RELEASE_RUN_DAYS * 86_400_000).toISOString();
  const [posted, runs, accts] = await Promise.all([
    postedReleaseMonths(sb, co.companyId, data.data.roles.COMMISSION_EXPENSE),
    sb.from('acc_commission_release_runs')
      .select('month, ran_at, trigger, released_sen, action, je_no, note, parts')
      .eq('company_id', co.companyId).gte('ran_at', since)
      .order('ran_at', { ascending: false }).limit(RUN_LIMIT),
    sb.from('accounts').select('account_code, account_name').eq('company_id', co.companyId)
      .in('account_code', [data.data.roles.COMMISSION_PREPAID, data.data.roles.COMMISSION_EXPENSE]),
  ]);
  if (!posted.ok) return c.json({ error: 'load_failed', reason: posted.reason }, 500);
  if (runs.error) return c.json({ error: 'load_failed', reason: runs.error.message }, 500);
  if (accts.error) return c.json({ error: 'load_failed', reason: accts.error.message }, 500);
  const runRows = runs.data as unknown[];
  const nameOf = new Map((accts.data as Array<{ account_code: string; account_name: string | null }>).map((a) => [a.account_code, a.account_name ?? '']));
  const account = (code: string) => ({ code, name: nameOf.get(code) ?? null });

  return c.json({
    on: st.settings.on,
    booksStart: data.data.input.booksStart,
    currentMonth: current,
    lastMonth: last,
    accounts: { prepaid: account(data.data.roles.COMMISSION_PREPAID), expense: account(data.data.roles.COMMISSION_EXPENSE) },
    prepaid: data.data.prepaid.map((p) => ({
      month: p.month, amountSen: p.amountSen, docNo: p.docNo, jeNo: p.jeNo, entryDate: p.entryDate,
      sourceType: p.sourceType, notes: p.notes, monthGuessed: p.monthGuessed,
    })),
    layers: plan.layers,
    months: plan.months,
    posted: posted.months,
    runs: runRows,
  });
};

export const commissionReleaseOrders = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const layer = String(c.req.query('layer') ?? '');
  if (!/^(opening|bill:\d{4}-\d{2})$/.test(layer)) return c.json({ error: 'bad_layer', message: 'Name a bill month (bill:YYYY-MM) or opening.' }, 400);
  const sb = c.get('supabase');
  const st = await loadReleaseSettings(sb, co.companyId);
  if (!st.ok) return c.json({ error: 'load_failed', reason: st.reason }, 500);
  const { current } = mytMonths(Date.now());
  const data = await loadReleaseData(sb, co.companyId, st.settings.booksStart, current);
  if (!data.ok) return c.json({ error: 'load_failed', reason: data.reason }, 500);
  const plan = planCommissionRelease(data.data.input);
  if (!plan.layers.some((l) => l.key === layer)) return c.json({ error: 'not_found', message: 'The prepayment holds nothing for that month.' }, 404);
  return c.json({ layer, through: current, orders: layerOrders(data.data.input, plan, layer) });
};

export const commissionReleaseRun = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const st = await loadReleaseSettings(sb, co.companyId);
  if (!st.ok) return c.json({ error: 'load_failed', reason: st.reason }, 500);
  if (!st.settings.on) return c.json({ error: 'release_off', message: 'The monthly release is off for this company — turn it on first.' }, 409);
  const r = await runCommissionRelease(sb, co.companyId, 'manual');
  if (!r.ok) return c.json({ error: 'run_failed', reason: r.reason }, 500);
  return c.json({ outcomes: r.outcomes }, r.outcomes.some((o) => o.action === 'failed') ? 500 : 200);
};

export const commissionReleaseSettings = async (c: Ctx): Promise<Response> => {
  if (!requirePerm(c)) return c.json(NO_PERM, 403);
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  let body: { on?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  if (typeof body.on !== 'boolean') return c.json({ error: 'bad_switch', message: 'Say on: true or on: false.' }, 400);
  const sb = c.get('supabase');
  const saved = await saveReleaseSwitch(sb, co.companyId, body.on, who(c));
  if (!saved.ok) return c.json({ error: 'save_failed', reason: saved.reason }, 500);
  if (!body.on) return c.json({ ok: true, on: false, outcomes: [] });
  const r = await runCommissionRelease(sb, co.companyId, 'manual');
  if (!r.ok) return c.json({ ok: true, on: true, error: 'run_failed', reason: r.reason, outcomes: [] }, 500);
  return c.json({ ok: true, on: true, outcomes: r.outcomes });
};
