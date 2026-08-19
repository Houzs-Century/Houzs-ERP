// ----------------------------------------------------------------------------
// mrp-snapshot — the stored MRP planning result per company (option B, owner
// 2026-08-19). The MRP page reads the snapshot for the DEFAULT view (no
// category / warehouse filter, undated hidden) so it opens instantly instead of
// running computeMrp (~4s) on every load; any FILTERED or undated view computes
// live, because catFilter/whFilter change the allocation inputs, not just the
// output rows (mrp.ts computeMrp lines 549/863/991/1203), so the stored full
// result cannot be safely post-filtered without a byte-identical proof. Serving
// the snapshot only for a request that MATCHES the params it was computed with
// is correct by construction.
//
// A ~15-min scheduled job and a manual Regenerate keep it fresh; the page shows
// "as of <computedAt>". The snapshot is a CACHE, not a book of record (migration
// 0309): when a company has no row, readMrpSnapshot returns null and the page
// falls back to live compute — so this is a NO-OP until first populated.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client this SCM tree passes around (see companyScope.ts header). */
import type { Env } from '../../types';
import { getSupabaseService } from '../../db/supabase';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import { computeMrp, type MrpResult } from '../routes/mrp';

type Sb = any;

/* The live companies whose MRP snapshot the scheduled job refreshes: Houzs
   Century (1) + 2990's Home (2), the two tenants (the canonical pair, e.g.
   companyScope.test.ts). A company NOT listed still gets a correct plan — the
   MRP page falls back to live compute and Regenerate populates it on demand — so
   an unlisted tenant degrades to "slow but right", never to a wrong plan. */
export const MRP_REFRESH_COMPANY_IDS: readonly number[] = [1, 2];

/** The lead-buffer input computeMrp takes — same shape the Worker loads from
    c.env.DB and the refresh job loads from its own connection. */
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
  // Pass the object straight through — PostgREST json-encodes it ONCE into the
  // jsonb column. Never JSON.stringify first (the jsonb double-encoding COE).
  const { error } = await sb.from('mrp_snapshots').upsert(
    { company_id: companyId, result, computed_at: nowIso, updated_at: nowIso },
    { onConflict: 'company_id' },
  );
  if (error) throw new Error(`mrp_snapshot upsert failed: ${error.message}`);
  return { result, computedAt: nowIso };
}

/**
 * Refresh every live company's stored MRP snapshot — the scheduled (~15 min)
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
  }
}
