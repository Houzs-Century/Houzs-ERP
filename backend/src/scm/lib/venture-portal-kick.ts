// ----------------------------------------------------------------------------
// venture-portal-kick — after a successful SCM write, send the Venture Portal
// feed's queue now rather than on the next five-minute sweep.
//
// Owner 2026-09-13: 「我要秒级 update 的」. A sales order saved at 10:01 used to
// reach the portal by 10:05. The capture was never the slow half — the trigger
// runs in the SAME TRANSACTION as the salesperson's Save — so this changes only
// WHEN the drain runs, and nothing about what is delivered.
//
// ONE MOUNT, NOT ONE CALL PER HANDLER, and that is the whole reason this file
// exists. Sales orders are written from mfg-sales-orders, from the amendment
// routes, from the cancel routes, from the POS cart's checkout and from the
// handover route; their lines and payments from more. A kick added per handler
// is a kick somebody forgets in the next handler, and the symptom — one document
// that quietly takes five minutes while its neighbours take two seconds — is
// invisible until somebody measures it. Mounted once on /api/scm/*, a write that
// touches a sales order cannot miss it, and a write that touches anything else
// costs one cached flag read (see WHAT AN IDLE KICK COSTS below).
//
// WHY NOT /api/pos/* TOO. Checked 2026-09-13: backend/src/routes/pos.ts has nine
// routes, and the only two that name scm.mfg_sales_orders are both SELECTs
// inside GET /sales-stats. The POS's sales-order writes go through
// /api/scm/mfg-sales-orders and its cart through /api/scm/pos-cart, so both are
// already covered by the mount below. That answers the hand-off's open point.
//
// WHAT AN IDLE KICK COSTS. At most one per VP_KICK_DELAY_MS per isolate, and
// then only after the response has been sent. While the feed is OFF — which is
// how it ships — drainVenturePortalOutbox returns after ONE app_config read that
// is itself cached for 30 s, so the steady-state cost of this middleware on a
// system that does not use the feed is approximately nothing. With the feed on
// and the queue empty it is that read plus one sync_config read plus one outbox
// read: three, inside the subrequest diet CLAUDE.md holds this repo to.
//
// WHAT IT CANNOT SEE. A change made to scm.mfg_sales_orders* outside a Worker
// request — a migration backfill, a repair script, a hand-written UPDATE — is
// captured by the trigger but kicked by nothing, and leaves on the five-minute
// sweep. That is the accepted limit, recorded in the module guide.
// ----------------------------------------------------------------------------
import type { Context, Next } from 'hono';
import type { Env } from '../env';
import { kickVenturePortalDrain } from './venture-portal-outbox';

/**
 * Hono middleware — mount once, ahead of the SCM sub-routers.
 *
 * AFTER next(), NEVER BEFORE. The outbox row this drain is meant to collect is
 * inserted by the capture trigger inside the handler's own transaction, so a
 * kick scheduled before the handler ran would be a drain racing the row it
 * exists to send.
 *
 * NON-GET AND 2xx ONLY. A read changed nothing, and a refused write changed
 * nothing either — kicking on a 403 or a write-freeze 503 would schedule a drain
 * for a save that did not happen. Not a correctness problem (the drain would
 * find nothing) but it would put the cost on exactly the requests that already
 * failed.
 *
 * IT CANNOT FAIL THE REQUEST. Everything after next() is inside a catch, and
 * kickVenturePortalDrain swallows its own failures too. The person who pressed
 * Save has already had their 200; a broken accelerator must not retract it.
 */
export function venturePortalKick() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    await next();
    try {
      const method = c.req.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
      if (c.res.status < 200 || c.res.status > 299) return;

      /* Reading c.executionCtx THROWS when the context has none — a unit test,
         or any host that is not the Workers runtime. backend/src/index.ts does
         the same try/catch for the same reason. null is the honest answer and
         kickVenturePortalDrain reports it rather than pretending to schedule. */
      let ctx: { waitUntil(p: Promise<unknown>): void } | null = null;
      try {
        ctx = c.executionCtx;
      } catch {
        ctx = null;
      }

      kickVenturePortalDrain(c.env, ctx);
    } catch (e) {
      console.error('[vp-kick] middleware', String((e as Error | undefined)?.message ?? e));
    }
  };
}
