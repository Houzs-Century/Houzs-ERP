/* company-scope-file: every write here targets
   scm.stock_allocation_recompute_queue by `job_key` / `locked_by` /
   `request_token`. That table carries NO company_id — mig 0083 stamped 116
   tables and left it alone, deliberately — because it is global infrastructure:
   one recompute at a time across the whole system. There is no company to scope
   to. `job_key` is the queue's own identity, not a business key two companies
   could each hold. */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseService } from '../../db/supabase';
import type { Env } from '../env';
import { recomputeSoStockAllocation } from './so-stock-allocation';
import { enqueueStockAllocationRecompute } from './stock-allocation-queue';
import { deferScmAfterCommit } from './pg-supabase-transaction';
import { afterResponse } from '../../lib/after-response';

const JOB_KEY = 'GLOBAL';
const LEASE_MS = 4 * 60_000;

const MAX_ATTEMPTS = 10;
export const DEAD_LETTER_STATE = 'DEAD';
export const PENDING_STATE = 'PENDING';

const DEFER_BACKOFF_BASE_MS = 45_000;
const DEFER_BACKOFF_JITTER_MS = 60_000;
const DEFER_BACKOFF_CAP_MS = 4 * 60_000;

export function deferralBackoffMs(
  deferrals: number,
  random: () => number = Math.random,
): number {
  const grown = DEFER_BACKOFF_BASE_MS * Math.min(4, Math.max(1, deferrals));
  return Math.min(DEFER_BACKOFF_CAP_MS, grown) + Math.floor(random() * DEFER_BACKOFF_JITTER_MS);
}

type QueueRow = {
  job_key: string;
  request_token: string;
  requested_at: string;
  attempts: number;
  deferrals?: number;
  state?: string | null;
  next_attempt_at?: string | null;
};

export type AllocationDrainResult = {
  processed: boolean;
  completed: boolean;
  deferred?: boolean;
  deadLettered?: boolean;
  attempts?: number;
  reason?: string;
};

export { enqueueStockAllocationRecompute };

/**
 * Claim and drain the singleton projection job. The random request_token
 * equality on claim/delete is the generation fence: a mutation arriving during
 * recompute gets a new token, so the old worker can never delete the new work,
 * even when two enqueues share one clock millisecond.
 */
export async function drainStockAllocationRecomputeWithClient(
  sb: any,
  recompute: typeof recomputeSoStockAllocation = recomputeSoStockAllocation,
  random: () => number = Math.random,
): Promise<AllocationDrainResult> {
  const { data: pending, error: loadError } = await sb.from('stock_allocation_recompute_queue')
    .select('job_key, request_token, requested_at, attempts, deferrals, state, next_attempt_at')
    .eq('job_key', JOB_KEY)
    .maybeSingle();
  if (loadError) return { processed: false, completed: false, reason: loadError.message };
  if (!pending) return { processed: false, completed: true };

  const row = pending as QueueRow;
  const attempts = Number(row.attempts ?? 0);

  if (row.state === DEAD_LETTER_STATE) {
    return {
      processed: false,
      completed: false,
      deadLettered: true,
      attempts,
      reason: `dead_letter: stock allocation recompute failed ${attempts} times and is parked for IT`,
    };
  }

  const dueAt = row.next_attempt_at ? Date.parse(row.next_attempt_at) : NaN;
  if (Number.isFinite(dueAt) && dueAt > Date.now()) {
    return { processed: false, completed: false, deferred: true, attempts, reason: 'backoff_not_due' };
  }

  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const lockedUntil = new Date(Date.now() + LEASE_MS).toISOString();
  const { data: claimed, error: claimError } = await sb.from('stock_allocation_recompute_queue')
    .update({ locked_by: token, locked_until: lockedUntil })
    .eq('job_key', JOB_KEY)
    .eq('request_token', row.request_token)
    .or(`locked_by.is.null,locked_until.lt.${now}`)
    .select('job_key')
    .maybeSingle();
  if (claimError) return { processed: false, completed: false, reason: claimError.message };
  if (!claimed) return { processed: false, completed: false, deferred: true, reason: 'job_already_claimed' };

  let failure: string | null = null;
  let softDefer: string | null = null;
  try {
    const result = await recompute(sb);
    if (!result.ok) failure = result.reason ?? 'stock allocation returned ok=false';
    else if (result.reason === 'another_recompute_in_progress') softDefer = result.reason;
    else if (result.deferredDocNos && result.deferredDocNos.length > 0) {
      softDefer = `headers_leased:${result.deferredDocNos.join(',')}`;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (softDefer) {
    const deferrals = Number(row.deferrals ?? 0) + 1;
    const { error } = await sb.from('stock_allocation_recompute_queue').update({
      deferrals,
      last_error: softDefer,
      next_attempt_at: new Date(Date.now() + deferralBackoffMs(deferrals, random)).toISOString(),
      locked_by: null,
      locked_until: null,
    }).eq('job_key', JOB_KEY).eq('locked_by', token);
    return {
      processed: true,
      completed: false,
      deferred: true,
      attempts,
      reason: error ? `${softDefer}; queue release failed: ${error.message}` : softDefer,
    };
  }

  if (failure) {
    const nextAttempts = attempts + 1;
    const dead = nextAttempts >= MAX_ATTEMPTS;
    const { error } = await sb.from('stock_allocation_recompute_queue').update({
      attempts: nextAttempts,
      last_error: failure,
      state: dead ? DEAD_LETTER_STATE : PENDING_STATE,
      dead_lettered_at: dead ? new Date().toISOString() : null,
      locked_by: null,
      locked_until: null,
    }).eq('job_key', JOB_KEY).eq('locked_by', token);
    return {
      processed: true,
      completed: false,
      deadLettered: dead,
      attempts: nextAttempts,
      reason: error ? `${failure}; queue release failed: ${error.message}` : failure,
    };
  }

  const { data: deleted, error: deleteError } = await sb.from('stock_allocation_recompute_queue')
    .delete()
    .eq('job_key', JOB_KEY)
    .eq('locked_by', token)
    .eq('request_token', row.request_token)
    .select('job_key')
    .maybeSingle();
  if (deleteError) return { processed: true, completed: false, reason: deleteError.message };
  if (!deleted) {
    const { error } = await sb.from('stock_allocation_recompute_queue').update({
      locked_by: null,
      locked_until: null,
    }).eq('job_key', JOB_KEY).eq('locked_by', token);
    return {
      processed: true,
      completed: false,
      deferred: true,
      reason: error ? `new_work_arrived; queue release failed: ${error.message}` : 'new_work_arrived',
    };
  }
  return { processed: true, completed: true };
}

export async function drainStockAllocationRecompute(env: Env): Promise<AllocationDrainResult> {
  return drainStockAllocationRecomputeWithClient(getSupabaseService(env));
}

/**
 * Fire the global recompute WITHOUT making the caller's response wait for it.
 *
 * WHY THIS EXISTS (owner 2026-08-10, measured). Saving an SO header took 10.6s
 * on production. The write itself (apply_so_header_cas) is milliseconds; the
 * rest was this recompute, which is global by design — it walks every active SO
 * and every one of its lines through PostgREST's 1000-row pages, in series.
 * That cost does not shrink with `scopeToDocNo`, which narrows the WRITES only.
 *
 * The "2,784 active SOs / 14,076 lines / ~25-30 sequential round trips at
 * roughly 300ms each" this paragraph carried until 2026-08-16 was arithmetic,
 * not a measurement, and it was wrong by a factor of four in the direction that
 * makes the problem look smaller. `probe-so-save-cost` asked production and got
 * 123 read round trips, 71 of them ONE read fetching 83 rows. Do not re-quote a
 * number from here — run the probe; that is what it is for.
 *
 * WHAT YOU GIVE UP. The response returns before the projection settles, so a
 * client that refetches immediately can render READY / PENDING badges one sweep
 * behind for a few seconds. They self-correct on the next read. Nothing the
 * operator just typed is affected: the header row is already committed.
 *
 * WHAT YOU DO NOT GIVE UP. Durability is unchanged, because there was none to
 * lose here — see the SCOPE header. Read that before reaching for this in a new
 * call site; if the route can join a PG command transaction, use
 * `scheduleStockAllocationAfterCommand` instead and get a real guarantee.
 *
 * Failures are logged and swallowed, exactly as the inline callers do — the
 * promise is `.catch`ed BEFORE it is handed to waitUntil so a recompute error
 * can never surface as an unhandled rejection that fails the whole invocation.
 */
export function deferAllocationRecompute(c: any, sb: any, where: string): void {
  const sweep = sweepThenCatchUp(sb).then(
    () => undefined,
    (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[so-allocation] ${where} failed:`, error);
    },
  );
  try { c.executionCtx.waitUntil(sweep); }
  catch { }
}

/**
 * The fast half for a caller that has ALREADY queued the GLOBAL row (the SO
 * hold). deferAllocationRecompute would sweep and then find that same row in
 * its catch-up and sweep again; this drains the row instead, so the one sweep
 * also clears it. When the drain ran no sweep (row parked, backing off, claimed
 * elsewhere, or a read failed) it falls back to the ordinary sweep, whose
 * catch-up then finds nothing it can run, so it is still one sweep.
 */
export function deferQueuedAllocationDrain(c: { executionCtx: ExecutionContext }, sb: QueueDb, where: string): void {
  const sweep = drainOrSweepOnce(sb).then(
    () => undefined,
    (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[so-allocation] ${where} failed:`, error);
    },
  );
  try { c.executionCtx.waitUntil(sweep); }
  catch { }
}

async function drainOrSweepOnce(sb: QueueDb): Promise<void> {
  const drained = await drainCoalesced(sb);
  if (drained.processed || drained.completed) return;
  await sweepThenCatchUp(sb);
}

type QueueDb = Parameters<typeof drainStockAllocationRecomputeWithClient>[0];

/**
 * The same deferral for code that holds only a db client (helpers called from
 * many routes, e.g. grn-post-tail). Inside a request it hands the sweep to the
 * request's waitUntil through lib/after-response and returns at once; outside
 * one (cron, scripts, unit tests) it runs the sweep inline as before. Failures
 * are logged, never thrown — the same contract as the inline callers had.
 */
export async function recomputeAllocationAfterSave(sb: QueueDb, where: string): Promise<void> {
  await afterResponse(`so-allocation ${where}`, () => sweepThenCatchUp(sb));
}

async function sweepThenCatchUp(sb: QueueDb): Promise<void> {
  const result = await recomputeSoStockAllocation(sb);
  if (result.queuedForRetry !== undefined) return;
  const drained = await drainCoalesced(sb);
  if (!drained.completed && !drained.deferred && !drained.deadLettered && drained.reason) {
    // eslint-disable-next-line no-console
    console.error('[so-allocation] catch-up drain failed:', drained.reason);
  }
}

const MAX_DRAIN_PASSES = 4;
export async function drainCoalesced(
  sb: QueueDb,
  drain: (sb: QueueDb) => Promise<AllocationDrainResult> = drainStockAllocationRecomputeWithClient,
): Promise<AllocationDrainResult> {
  let result = await drain(sb);
  for (let pass = 1; pass < MAX_DRAIN_PASSES && result.reason === 'new_work_arrived'; pass += 1) {
    result = await drain(sb);
  }
  return result;
}

/** Queue transactionally, then make one after-commit attempt for low latency. */
export async function scheduleStockAllocationAfterCommand(c: any, sb: any, reason: string): Promise<void> {
  await enqueueStockAllocationRecompute(sb, reason);
  deferScmAfterCommit(c, async () => {
    const attempt = drainStockAllocationRecomputeWithClient(c.get('supabase') as SupabaseClient)
      .then((result) => {
        if (!result.completed && !result.deferred && !result.deadLettered) {
          throw new Error(result.reason ?? 'stock-allocation drain failed');
        }
      });
    try { c.executionCtx.waitUntil(attempt); }
    catch { await attempt; }
  });
}
