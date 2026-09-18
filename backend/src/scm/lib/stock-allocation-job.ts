/* company-scope-file: every write here targets
   scm.stock_allocation_recompute_queue by `job_key` / `locked_by` /
   `request_token`. That table carries NO company_id — mig 0083 stamped 116
   tables and left it alone, deliberately — because it is global infrastructure:
   one recompute at a time across the whole system. There is no company to scope
   to. `job_key` is the queue's own identity, not a business key two companies
   could each hold. */

/* ══════════════════════════════════════════════════════════════════════════════
   SCOPE — READ THIS BEFORE RELYING ON "DURABLE".

   This queue makes an SO stock-allocation recompute durable for the SIX call
   sites that use `scheduleStockAllocationAfterCommand`: the three TBC line
   commands, amendment approve-so, and — since 2026-08-20 — the GRN line DELETE
   and GRN cancel. Those six run inside `runScmPgCommand`, so the queue row
   commits in the SAME database transaction as the source write, and a Worker
   crash between the two is impossible.

   The other THIRTY-TWO allocation triggers in this codebase still call
   `recomputeSoStockAllocation` best-effort (GRN post, DO ship/cancel,
   delivery + purchase returns, stock takes, transfers, inventory adjustments,
   consignment, and eight paths in mfg-sales-orders itself). For those, a crash
   between the source write and the recompute leaves READY / PENDING and the SO
   header status stale until some later mutation happens to sweep. ALLOCATION IS
   NOT DURABLE IN GENERAL. Do not read the word "durable" in this file as
   covering the whole surface — it covers six entry points.

   NARROWED, NOT CLOSED, 2026-08-17. `recomputeSoStockAllocation` now enqueues
   its OWN retry row whenever a sweep it actually ENTERED did not finish — a
   lost single-flight race, a throw, or a header left un-advanced under an edit
   lease. So the cron below IS now a repair loop for those outcomes, on all ~38
   triggers rather than the durable six. The gap that remains is the one this
   header was written about and it is unchanged: if the Worker dies BEFORE the
   recompute is reached, there is still no row and still no retry, because only
   a queue write inside the source write's own transaction can cover that. Six
   entry points have it. Converting the rest still means moving each route onto
   `runScmPgCommand` first.

   THIRTY-ONE of those thirty-two are `await`ed inline, so the operator's
   request pays for the whole global sweep. ONE — the SO header PATCH — is
   DEFERRED via `deferAllocationRecompute` below. Deferred is NOT a durability
   upgrade: same call, same crash window, just moved off the response path. If
   anything it is harder to reason about, because the operator has already been
   told the save succeeded when the sweep dies. It buys latency and nothing
   else; the honest fix for that call site is still to move it onto
   `runScmPgCommand` so it can join the durable six.

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
import { enqueueStockAllocationRecompute } from './stock-allocation-queue';
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
   deliberately NOT a multiple of five minutes: the cron is 5 min, and two equal
   timers can beat against each other forever. The SO edit lease was 5 min too
   until 2026-09-03 and is now 60s (scm/lib/so-edit-lease.ts), which only makes
   a deferral rarer - the lock is usually gone before the first retry.
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

/* The enqueue moved to lib/stock-allocation-queue.ts on 2026-08-17 so that
   so-stock-allocation.ts can write its own retry row without closing an import
   cycle. Re-exported here because this is where callers look for it, and there
   must go on being exactly ONE enqueue. */
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
