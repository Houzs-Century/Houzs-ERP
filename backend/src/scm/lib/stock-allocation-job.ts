/* ══════════════════════════════════════════════════════════════════════════════
   SCOPE — READ THIS BEFORE RELYING ON "DURABLE".

   This queue makes an SO stock-allocation recompute durable for the FOUR call
   sites that use `scheduleStockAllocationAfterCommand`: the three TBC line
   commands and amendment approve-so. Those four run inside `runScmPgCommand`,
   so the queue row commits in the SAME database transaction as the source
   write, and a Worker crash between the two is impossible.

   The other THIRTY-FOUR allocation triggers in this codebase still call
   `recomputeSoStockAllocation` best-effort (GRN post/cancel, DO ship/cancel,
   delivery + purchase returns, stock takes, transfers, inventory adjustments,
   consignment, and eight paths in mfg-sales-orders itself). For those, a crash
   between the source write and the recompute leaves READY / PENDING and the SO
   header status stale until some later mutation happens to sweep. ALLOCATION IS
   NOT DURABLE IN GENERAL. Do not read the word "durable" in this file as
   covering the whole surface — it covers four entry points.

   THIRTY-THREE of those thirty-four are `await`ed inline, so the operator's
   request pays for the whole global sweep. ONE — the SO header PATCH — is
   DEFERRED via `deferAllocationRecompute` below. Deferred is NOT a durability
   upgrade: same call, same crash window, just moved off the response path. If
   anything it is harder to reason about, because the operator has already been
   told the save succeeded when the sweep dies. It buys latency and nothing
   else; the honest fix for that call site is still to move it onto
   `runScmPgCommand` so it can join the durable four.

   The exact inventory is pinned by tests/stockAllocationDurabilityScope.test.ts,
   which fails if any count moves. Converting the rest requires first moving
   each route onto the PG command transaction: enqueuing from a route that has
   no transaction to join produces a queue row that can commit without its
   source write, which is worse than the honest inline call.
   ══════════════════════════════════════════════════════════════════════════ */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseService } from '../../db/supabase';
import type { Env } from '../env';
import { recomputeSoStockAllocation } from './so-stock-allocation';
import { deferScmAfterCommit } from './pg-supabase-transaction';

const JOB_KEY = 'GLOBAL';
const LEASE_MS = 4 * 60_000;

/* Terminal state (2026-07-22). Without one, a permanently failing recompute —
   a dropped column, a broken PL/pgSQL function, a poison row — retried every
   five minutes forever and nobody ever found out, because `attempts` was reset
   to 0 by the very next enqueue. After MAX_ATTEMPTS consecutive HARD failures
   the row is parked in state 'DEAD': automatic retries stop, the row (with its
   last_error) stays for a human, and every subsequent cron sweep logs it loudly
   so the silence is broken. Clearing it is deliberate — see the runbook. */
const MAX_ATTEMPTS = 10;
export const DEAD_LETTER_STATE = 'DEAD';
export const PENDING_STATE = 'PENDING';

/* A DEFERRAL is not a failure: some SO header could not be advanced because a
   human holds its edit lease. Those are counted separately so a busy shop can
   never dead-letter a perfectly healthy projection. The deferral backoff is
   deliberately NOT a multiple of five minutes: the SO edit lease is 5 min and
   the cron is 5 min, and two equal timers can beat against each other forever.
   A jittered 45-105s next_attempt_at breaks the resonance, and the next cron
   tick picks the row up regardless. */
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

/**
 * Persist the invalidation in the caller's transaction.
 *
 * `attempts` / `deferrals` / `state` are DELIBERATELY not in the payload. This
 * is an upsert on the singleton row, so listing them would reset the failure
 * counter on every new mutation and a permanently broken job could never reach
 * its terminal state. On first INSERT the column defaults apply; on conflict
 * only the columns named here are overwritten.
 */
export async function enqueueStockAllocationRecompute(sb: any, reason: string): Promise<void> {
  const { error } = await sb.from('stock_allocation_recompute_queue').upsert({
    job_key: JOB_KEY,
    request_token: crypto.randomUUID(),
    requested_at: new Date().toISOString(),
    reason,
  }, { onConflict: 'job_key' });
  if (error) throw new Error(`Stock-allocation enqueue failed: ${error.message}`);
}

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

  /* Terminal. Never retried automatically, and never silent: the cron logs this
     reason on every sweep until a human clears the row. */
  if (row.state === DEAD_LETTER_STATE) {
    return {
      processed: false,
      completed: false,
      deadLettered: true,
      attempts,
      reason: `dead_letter: stock allocation recompute failed ${attempts} times and is parked for IT`,
    };
  }

  /* Deferral backoff — the row is queued but not due yet. */
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
      /* Headers left un-advanced because a human is editing them. The line
         projection committed; only these headers are outstanding. Soft. */
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
    // New work arrived while recompute ran. Release only our lease; keep it queued.
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
 * rest was this recompute, which is global by design — it walks 2,784 active
 * SOs and their 14,076 lines through PostgREST's 1000-row pages, ~25-30
 * sequential round trips at roughly 300ms each. That cost does not shrink with
 * `scopeToDocNo`, which narrows the WRITES only.
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
  const sweep = recomputeSoStockAllocation(sb).then(
    () => undefined,
    (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[so-allocation] ${where} failed:`, error);
    },
  );
  /* c.executionCtx throws outside Workers (vitest). There the floating promise
     just runs — already `.catch`ed, so it cannot break the test run. */
  try { c.executionCtx.waitUntil(sweep); }
  catch { /* non-Workers runtime — let the floating promise run */ }
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
    // The durable row is already committed, so the response need not wait for
    // a global allocation sweep. waitUntil keeps the low-latency attempt alive;
    // environments without it await as a safe fallback.
    try { c.executionCtx.waitUntil(attempt); }
    catch { await attempt; }
  });
}
