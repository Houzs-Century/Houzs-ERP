/* Once an order reaches Pending Schedule it STAYS there (owner 2026-10-26):
   「如果进到来 pending schedule 就不要出去了，就算缺货我们也能知道然后处理」.
   The customer may already have the WhatsApp date and the lorry may be planned,
   so the order must not slip back to Pending Delivery / Overdue on its own when
   stock moves. Its Stock column keeps showing the live truth, which is how a
   shortage is seen. Stock allocation, MRP and the SO status are untouched.

   Mechanism: the board stamps the existing manual override (delivery_state =
   PENDING_SCHEDULE) on an order the first time it derives Pending Schedule; the
   override already wins in derivePlanningState, and Delivered still beats it.
   Leaving is manual only: "Back to Pending Delivery" clears the stamp.

   The write never holds a board read: it runs after the response, and only on a
   request without a band (counts_only, the whole board, a ?docs row refresh). The
   five band reads of one board open used to each run it inside the GET, where an
   UPDATE waits on any other writer's row lock with no time limit. The rows a band
   returns still show the stamp, so the output is the same. */
import type { Context } from 'hono';
import { scopeToAllowedCompanies, type CompanyScopeCtx } from './companyScope';

export function docsEnteringPendingSchedule(
  rows: Array<{ row_type: string; so_doc_no: string; delivery_state: string; delivery_state_override: string | null }>,
): string[] {
  return rows
    .filter((o) => o.row_type === 'so' && o.delivery_state === 'PENDING_SCHEDULE' && o.delivery_state_override == null)
    .map((o) => o.so_doc_no);
}

export async function stampPendingSchedule(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client, as every board read takes it
  sb: any,
  c: CompanyScopeCtx,
  docNos: string[],
): Promise<void> {
  if (docNos.length === 0) return;
  for (let i = 0; i < docNos.length; i += 200) {
    const { error } = await scopeToAllowedCompanies(
      sb.from('mfg_sales_orders').update({ delivery_state: 'PENDING_SCHEDULE' }).in('doc_no', docNos.slice(i, i + 200)).is('delivery_state', null),
      c,
    );
    // Best-effort: the board still answers; the next read stamps what this missed.
    if (error) console.warn(`[delivery-planning] pending-schedule stamp skipped: ${String(error.message).slice(0, 120)}`);
  }
}

/** stampPendingSchedule after the response (waitUntil in a Worker); awaited where
 *  there is no execution context (tests), so a test can read what was written. */
export async function stampPendingScheduleAfterResponse(
  c: Pick<Context, 'executionCtx'> & CompanyScopeCtx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client
  sb: any,
  docNos: string[],
): Promise<void> {
  if (docNos.length === 0) return;
  const run = stampPendingSchedule(sb, c, docNos).catch((e: unknown) => {
    console.warn(`[delivery-planning] pending-schedule stamp skipped: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
  });
  let ctx: ExecutionContext | null = null;
  try { ctx = c.executionCtx; } catch { /* no execution context (tests) */ }
  if (ctx) ctx.waitUntil(run); else await run;
}
