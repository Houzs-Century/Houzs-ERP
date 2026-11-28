
/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client this SCM tree passes around (see companyScope.ts header). */
import type { Env } from '../../types';
import { getSupabaseService } from '../../db/supabase';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import { computeMrp, type MrpResult } from '../routes/mrp';

type Sb = any;

export const MRP_REFRESH_COMPANY_IDS: readonly number[] = [1, 2];

type LeadBuffers = Parameters<typeof computeMrp>[1]['leadBuffers'];

/** The exact params the MRP page opens with (mrp.ts GET): no filters, undated
    hidden. A snapshot is computed with these, so serving it for a matching
    request needs no post-filtering of the stored result. */
export function isDefaultMrpView(
  catFilter: string | null,
  whFilter: string | null,
  includeUndated: boolean,
): boolean {
  return catFilter === null && whFilter === null && includeUndated === false;
}

export async function readMrpSnapshot(
  sb: Sb,
  companyId: number | null | undefined,
): Promise<{ result: MrpResult; computedAt: string } | null> {
  if (companyId == null) return null;
  const { data, error } = await sb.from('mrp_snapshots')
    .select('result, computed_at')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error || !data) return null;
  return { result: data.result as MrpResult, computedAt: data.computed_at as string };
}

/**
 * Recompute the DEFAULT-view MRP result for a company and upsert it. Returns the
 * fresh result + its computedAt. Shared by the Regenerate endpoint and the
 * scheduled refresh job. `leadBuffers` is passed in (the Worker reads it from
 * c.env.DB; the job reads it from its own connection) so this stays free of the
 * Hono context. `nowIso` is injected so the caller controls the timestamp.
 */
export async function refreshMrpSnapshot(
  sb: Sb,
  companyId: number,
  leadBuffers: LeadBuffers,
  nowIso: string,
): Promise<{ result: MrpResult; computedAt: string }> {
  const result = await computeMrp(sb, {
    catFilter: null, whFilter: null, includeUndated: false, companyId, leadBuffers,
  });
  const { error } = await sb.from('mrp_snapshots').upsert(
    { company_id: companyId, result, computed_at: nowIso, updated_at: nowIso },
    { onConflict: 'company_id' },
  );
  if (error) throw new Error(`mrp_snapshot upsert failed: ${error.message}`);
  return { result, computedAt: nowIso };
}

export async function readListMrpSnapshot(
  sb: Sb,
  companyId: number | null,
): Promise<{ result: MrpResult; computedAt: string } | null> {
  if (companyId == null) return null;
  const { data, error } = await sb.from('mrp_list_snapshots')
    .select('result, computed_at')
    .eq('company_id', companyId)
    .maybeSingle();
  if (error || !data) return null;
  return { result: data.result as MrpResult, computedAt: data.computed_at as string };
}

export async function storeListMrpSnapshot(
  sb: Sb,
  companyId: number,
  result: MrpResult,
  computedAtIso: string,
): Promise<void> {
  const { error } = await sb.from('mrp_list_snapshots').upsert(
    { company_id: companyId, result, computed_at: computedAtIso, updated_at: new Date().toISOString() },
    { onConflict: 'company_id' },
  );
  if (error) throw new Error(`mrp_list_snapshot upsert failed: ${error.message}`);
}

export async function refreshListMrpSnapshot(
  sb: Sb,
  companyId: number,
  leadBuffers: LeadBuffers,
  nowIso: string,
): Promise<{ result: MrpResult; computedAt: string }> {
  const result = await computeMrp(sb, {
    catFilter: null, whFilter: null, includeUndated: true, companyId, leadBuffers,
  });
  await storeListMrpSnapshot(sb, companyId, result, nowIso);
  return { result, computedAt: nowIso };
}

/**
 * Refresh one company's snapshot in the background after a write that moves
 * supply. 2990-0034 (2026-11-02): seven POs cancelled at 11:33 stayed "covered"
 * on the MRP page until the next cron, and the toolbar Refresh only re-reads the
 * same snapshot, so the purchaser saw nothing to re-order. Only companies the
 * cron refreshes: writing a first snapshot for any other company would pin its
 * page to a plan nothing keeps fresh. Never fails the caller's write.
 */
export function deferMrpSnapshotRefresh(c: any, sb: Sb, companyId: number, where: string): void {
  if (!MRP_REFRESH_COMPANY_IDS.includes(companyId)) return;
  const run = (async () => {
    const leadBuffers = await loadLeadBuffers(c.env.DB);
    await refreshMrpSnapshot(sb, companyId, leadBuffers, new Date().toISOString());
    await refreshListMrpSnapshot(sb, companyId, leadBuffers, new Date().toISOString());
  })().catch((e: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[mrp-snapshot] ${where} company=${companyId}`, e);
  });
  try { c.executionCtx.waitUntil(run); }
  catch { }
}

/**
 * Refresh every live company's two stored MRP snapshots (page + list) — the scheduled (~15 min)
 * job, run from the Worker's `scheduled()` handler where env.DB + the SCM client
 * are already to hand (so no pgrest-shim / lead-buffer plumbing). Best-effort per
 * company: one company's failure is logged and never blocks another's, and the
 * whole job is fire-and-forget (`ctx.waitUntil`) so a slow run never stalls the
 * cron slot. `nowIso` is injected by the caller.
 */
export async function refreshAllMrpSnapshots(env: Env, nowIso: string): Promise<void> {
  const sb = getSupabaseService(env);
  const leadBuffers = await loadLeadBuffers((env as { DB: unknown }).DB as Parameters<typeof loadLeadBuffers>[0]);
  for (const companyId of MRP_REFRESH_COMPANY_IDS) {
    try {
      const { computedAt } = await refreshMrpSnapshot(sb, companyId, leadBuffers, nowIso);
      // eslint-disable-next-line no-console
      console.log(`[cron mrp-snapshot] company=${companyId} computedAt=${computedAt}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[cron mrp-snapshot] company=${companyId}`, e);
    }
    try {
      const { computedAt } = await refreshListMrpSnapshot(sb, companyId, leadBuffers, nowIso);
      // eslint-disable-next-line no-console
      console.log(`[cron mrp-list-snapshot] company=${companyId} computedAt=${computedAt}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[cron mrp-list-snapshot] company=${companyId}`, e);
    }
  }
}
