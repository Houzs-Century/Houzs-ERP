// ----------------------------------------------------------------------------
// list-mrp-source — where the BULK list enrichments get their MRP run from.
//
// The PO / GRN / PI list enrichments and the SO list enrichment used to run the
// company-wide live MRP on every open (prod, 7 days to 2026-11-10: SO list
// 5,416 calls p95 3.1 s, PO list 932 calls). Owner 2026-11-10: the lists read
// the stored list snapshot (scm.mrp_list_snapshots, refreshed every 15 min by
// the cron and after supply-moving writes), show "MRP as of hh:mm", and offer a
// Refresh. The SO DETAIL coverage panel (GET /:docNo/coverage) stays LIVE: a
// person deciding on one order needs the current answer.
//
//   snapshot fresh (<= 30 min)       -> serve it, no computation
//   snapshot missing / older         -> live run, said so on screen
//   ?refresh=1, snapshot >= 60 s old -> one live run, stored as the new snapshot
//   ?refresh=1, snapshot <  60 s old -> the snapshot (someone just refreshed)
//
// The live run is the per-isolate shared one (live-mrp-memo), so the chunks of
// one list page and concurrent clicks join a single computation; storing it
// makes the next reader in ANY isolate get it without computing. Company scope:
// the snapshot is read and written by activeCompanyId only.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the untyped supabase-js client and Hono context this SCM tree passes around (see companyScope.ts header). */
import type { MrpResult } from '../routes/mrp';
import { activeCompanyId } from './companyScope';
import { sharedLiveMrp } from './live-mrp-memo';
import { MRP_REFRESH_COMPANY_IDS, readListMrpSnapshot, storeListMrpSnapshot } from './mrp-snapshot';

export const LIST_MRP_MAX_AGE_MS = 30 * 60_000;
export const LIST_MRP_REFRESH_MIN_MS = 60_000;

/** Why a list read computed live instead of reading the snapshot. */
export type ListMrpFallback = 'missing' | 'stale' | 'refresh';

/** What every list-enrichment response carries next to `enrichment`. */
export type ListMrpMeta = {
  /** When the MRP answer was computed (ISO). null only when a live run failed. */
  asOf: string | null;
  source: 'snapshot' | 'live';
  fallback: ListMrpFallback | null;
  /** The live run failed: the MRP-derived cells are empty, not "no assignment". */
  failed: boolean;
};

export type ListMrp = { result: MrpResult | null; meta: ListMrpMeta };

export type ListMrpDecision = { use: 'snapshot' } | { use: 'live'; reason: ListMrpFallback };

/** PURE. Snapshot or live, from the snapshot's age and whether Refresh was asked. */
export function decideListMrp(computedAt: string | null, refresh: boolean, nowMs: number): ListMrpDecision {
  const t = computedAt ? Date.parse(computedAt) : NaN;
  if (!Number.isFinite(t)) return { use: 'live', reason: 'missing' };
  const age = nowMs - t;
  if (age > LIST_MRP_MAX_AGE_MS) return { use: 'live', reason: 'stale' };
  if (refresh && age >= LIST_MRP_REFRESH_MIN_MS) return { use: 'live', reason: 'refresh' };
  return { use: 'snapshot' };
}

/** `?refresh=1` on a list-enrichment request. */
export function wantsListMrpRefresh(c: any): boolean {
  return c.req.query('refresh') === '1';
}

/**
 * The MRP run a bulk list enrichment uses. Never rejects: a failed live run
 * comes back as `{ result: null, meta.failed: true }` so each caller keeps its
 * own fail-soft path.
 */
export async function resolveListMrp(
  sb: any,
  c: any,
  refresh: boolean,
  now: () => number = Date.now,
): Promise<ListMrp> {
  const companyId: number | null = activeCompanyId(c) ?? null;
  let snap: { result: MrpResult; computedAt: string } | null = null;
  try { snap = await readListMrpSnapshot(sb, companyId); } catch { snap = null; }

  const decision = decideListMrp(snap?.computedAt ?? null, refresh, now());
  if (decision.use === 'snapshot' && snap) {
    return { result: snap.result, meta: { asOf: snap.computedAt, source: 'snapshot', fallback: null, failed: false } };
  }
  const reason: ListMrpFallback = decision.use === 'live' ? decision.reason : 'missing';

  const run = sharedLiveMrp(sb, c.env.DB, companyId, null, now);
  let result: MrpResult;
  try {
    result = await run.result;
  } catch {
    return { result: null, meta: { asOf: null, source: 'live', fallback: reason, failed: true } };
  }
  const asOf = new Date(run.startedAt).toISOString();

  /* Keep the computation: the next list open, in any isolate, reads it. Only
     for companies the cron keeps fresh (same rule as deferMrpSnapshotRefresh),
     and only when it is newer than what is stored. */
  if (companyId != null && MRP_REFRESH_COMPANY_IDS.includes(companyId)
      && (!snap || Date.parse(snap.computedAt) < run.startedAt)) {
    const store = storeListMrpSnapshot(sb, companyId, result, asOf).catch((e: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[mrp-list-snapshot] store company=${companyId}`, e);
    });
    /* c.executionCtx throws outside Workers (vitest); the promise is already caught. */
    try { c.executionCtx.waitUntil(store); } catch { /* non-Workers runtime */ }
  }
  return { result, meta: { asOf, source: 'live', fallback: reason, failed: false } };
}

/** The run as the promise shape the resolvers already await (rejects when it failed). */
export function listMrpResult(p: Promise<ListMrp>): Promise<MrpResult> {
  return p.then((m) => {
    if (!m.result) throw new Error('mrp_unavailable');
    return m.result;
  });
}
