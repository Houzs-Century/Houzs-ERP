// ----------------------------------------------------------------------------
// live-mrp-memo — one live MRP run shared by the SO list's deferred Stock column
// (GET /mfg-sales-orders/list-mrp-enrichment) and the SO detail's
// (GET /:docNo/coverage). HC-0002, measured on prod 2026-10-22: each of those
// ran its own company-wide computeMrp, 1.5-2.6s apiece, so opening the list and
// then an order paid for the same allocation twice.
//
// Both ask for the identical run (no category / warehouse filter, undated
// included), so a result computed for one is the right answer for the other.
// It is held in this isolate only:
//
//   - for LIVE_MRP_TTL_MS after the run STARTED, never longer;
//   - a request that arrives while a run is in flight joins it instead of
//     starting a second one;
//   - any successful SCM write (forgetLiveMrpOnWrite, mounted in scm/index.ts)
//     drops it, and a run already in flight when the write lands is not kept.
//
// What it cannot see: a write served by ANOTHER isolate. That bounds the
// staleness at LIVE_MRP_TTL_MS for documents other than the one being looked
// at; /coverage bypasses the memo when its own order was saved after the run
// started (see liveMrpStartedAfter). The MRP page and its 15-min snapshot are
// untouched.
// ----------------------------------------------------------------------------

import type { Context, Next } from 'hono';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import { computeMrp, type MrpResult } from '../routes/mrp';

export const LIVE_MRP_TTL_MS = 30_000;

type Entry = { startedAt: number; result: Promise<MrpResult> };

const memo = new Map<string, Entry>();

function keyFor(companyId: number | null | undefined): string {
  return String(companyId ?? 'none');
}

/**
 * The company-wide live MRP run, shared within LIVE_MRP_TTL_MS. Rejects exactly
 * as computeMrp would; a rejected run is never kept.
 */
export function sharedLiveMrp(
  sb: unknown,
  db: D1Database,
  companyId: number | null | undefined,
  /** The looked-at document's last save; a run that started before it is not reused. */
  savedAt: string | null = null,
  now: () => number = Date.now,
): { result: Promise<MrpResult>; startedAt: number } {
  const key = keyFor(companyId);
  const hit = memo.get(key);
  if (hit && now() - hit.startedAt < LIVE_MRP_TTL_MS && !liveMrpStartedAfter(hit.startedAt, savedAt)) return hit;

  const startedAt = now();
  const result = (async () =>
    computeMrp(sb, {
      catFilter: null, whFilter: null, includeUndated: true,
      companyId: companyId ?? null, leadBuffers: await loadLeadBuffers(db),
    }))();
  const entry: Entry = { startedAt, result };
  memo.set(key, entry);
  result.catch(() => {
    if (memo.get(key) === entry) memo.delete(key);
  });
  return entry;
}

/** Drop every held run. A run still in flight finishes for the callers already on it, and nobody new joins it. */
export function forgetLiveMrp(): void {
  memo.clear();
}

/** True when `isoTimestamp` is at or after the run's start, i.e. the run may predate that save. */
export function liveMrpStartedAfter(startedAt: number, isoTimestamp: string | null | undefined): boolean {
  if (!isoTimestamp) return false;
  const t = Date.parse(isoTimestamp);
  return Number.isFinite(t) && t >= startedAt;
}

/** After any successful SCM write in this isolate, the next read computes fresh. */
export function forgetLiveMrpOnWrite() {
  return async (c: Context, next: Next) => {
    await next();
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (c.res.status < 200 || c.res.status > 299) return;
    forgetLiveMrp();
  };
}
