/* company-scope-file: the write here targets
   scm.stock_allocation_recompute_queue by `job_key`. That table carries NO
   company_id — mig 0083 stamped 116 tables and left it alone, deliberately —
   because it is global infrastructure: one recompute at a time across the whole
   system. `job_key` is the queue's own identity, not a business key two
   companies could each hold. See stock-allocation-job.ts for the full note.

   WHY THIS IS ITS OWN FILE. It used to live in stock-allocation-job.ts, which
   imports `recomputeSoStockAllocation`. Since 2026-08-17 the recompute enqueues
   its OWN retry row when a sweep does not finish, and importing the enqueue
   back out of stock-allocation-job.ts would close an import cycle
   (job -> allocation -> job). One leaf module both sides import instead. There
   is exactly one enqueue in this codebase and this is it; stock-allocation-job
   re-exports it so existing callers are unchanged. */

const JOB_KEY = 'GLOBAL';

/**
 * Persist the invalidation. When the caller runs inside `runScmPgCommand` this
 * commits in the SAME transaction as the source write and is a real durability
 * guarantee; called from anywhere else it is a REPAIR REQUEST — a row the
 * five-minute cron will pick up — and nothing more. Read the SCOPE header in
 * stock-allocation-job.ts before assuming which one you have.
 *
 * `attempts` / `deferrals` / `state` are DELIBERATELY not in the payload. This
 * is an upsert on the singleton row, so listing them would reset the failure
 * counter on every new mutation and a permanently broken job could never reach
 * its terminal state. On first INSERT the column defaults apply; on conflict
 * only the columns named here are overwritten.
 */
export async function enqueueStockAllocationRecompute(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- moved verbatim from stock-allocation-job.ts, where this same parameter sat under that file's ceiling; typing it needs schema.pg.ts to cover the SCM tables (drizzle-kit pull), which is the upstream fix named in ci.yml's lint job
  sb: any,
  reason: string,
): Promise<void> {
  const { error } = await sb.from('stock_allocation_recompute_queue').upsert({
    job_key: JOB_KEY,
    request_token: crypto.randomUUID(),
    requested_at: new Date().toISOString(),
    reason,
  }, { onConflict: 'job_key' });
  if (error) throw new Error(`Stock-allocation enqueue failed: ${error.message}`);
}

export const STOCK_ALLOCATION_JOB_KEY = JOB_KEY;
