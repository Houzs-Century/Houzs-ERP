// ----------------------------------------------------------------------------
// postgrest-aggregate — run a PostgREST aggregate select (`cnt:id.count()`,
// `amt:x.sum()`), remembering when the server has aggregates switched off.
//
// Every aggregate in the SCM routes is a FAST PATH with a plain-read fallback:
// the SO list pills and money tiles, the DO list pills, Outstanding /summary.
// PostgREST answers PGRST123 when `db-aggregates-enabled` is off — its default,
// and Supabase's — and on such a server every one of those opens paid a refused
// request before doing the real work (HC-0002, measured on prod 2026-10-23: a
// DO list search matching nothing cost 12 round trips, 3 with aggregates on).
//
// The first PGRST123 is remembered for the isolate for AGG_OFF_MS; calls inside
// that window get the same error back without a request, so the caller takes its
// fallback exactly as before. The memo expires, so switching aggregates on is
// picked up without a deploy. Every aggregate error is marked in Server-Timing
// as `s-db-agg-<code>` (a skipped call as `s-db-agg-skip`), so the cause can be
// read from the browser.
// ----------------------------------------------------------------------------

import { recordStep } from '../../lib/step-timing';

export const AGG_OFF_CODE = 'PGRST123';
export const AGG_OFF_MS = 10 * 60_000;

let offUntil = 0;

type AggResult = { data?: unknown; error?: { code?: string | null; message?: string | null } | null };

export async function readAggregate<R extends AggResult>(
  run: () => PromiseLike<R>,
  now: () => number = Date.now,
): Promise<R> {
  if (now() < offUntil) {
    recordStep('db-agg-skip', 0);
    return { data: null, error: { code: AGG_OFF_CODE, message: 'aggregate functions are disabled on this PostgREST (remembered)' } } as R;
  }
  const res = await run();
  if (res.error) {
    const code = String(res.error.code ?? 'none').replace(/[^\w-]/g, '') || 'none';
    recordStep(`db-agg-${code}`, 0);
    if (code === AGG_OFF_CODE) offUntil = now() + AGG_OFF_MS;
  }
  return res;
}

/** Tests only: forget a remembered PGRST123. */
export function resetAggregateMemo(): void {
  offUntil = 0;
}
