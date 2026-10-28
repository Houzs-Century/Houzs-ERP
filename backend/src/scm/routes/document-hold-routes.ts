/* ----------------------------------------------------------------------------
   document-hold-routes — mounts `PATCH .../:id/hold` on all five documents, and
   holds the reasoning for each of them in one place.

   THE OWNER, 2026-08-22: 「我们的hold是给我们知道一个 order hold这的」 — the hold is
   there so people KNOW a document is paused. And 「take off hold也要看」.

   WHY A MOUNTING MODULE AND NOT FIVE INLINE BLOCKS. Two reasons, and the second
   is the one that decided it:

   1. The five routers are all at or over their file-size ceilings
      (`scripts/file-size-ceilings.json`), and this repo's rule is that new code
      moves into a module rather than a ceiling moving up. Five copies of this
      block was not an option that existed.
   2. It is the same decision five times over — put a marker on, take it off,
      never touch the status — and the differences between the documents are
      worth READING SIDE BY SIDE rather than discovering one route file at a
      time. `row-menus.ts` was written for the same reason and says so.

   WHAT EACH DOCUMENT'S HOLD MEANS, together, which is the part worth keeping:

     Sales Order       Replaces `PATCH /:docNo/status {status:'ON_HOLD'}`, which
                       is now refused (`hold_is_not_a_status`). This is where the
                       damage was: the status write OVERWROTE the order's
                       progress and `Take Off Hold` sent everything back to
                       CONFIRMED because there was nothing to restore from.
                       Keyed by doc_no, not id — its whole route family is.

     Purchase Order    Its FIRST working hold. Mig 0318 added the WORD On Hold on
                       2026-08-21 and no screen could ever send it. A held
                       PARTIALLY_RECEIVED order is still partially received.

     GRN               Its first working hold, same story (mig 0319). A held
                       POSTED GRN is still POSTED, so the "paperwork pause, never
                       a stock event" promise is now literally true: the
                       inventory IN fired at DRAFT -> POSTED and the marker moves
                       nothing.

     Purchase Invoice  Its first working hold (mig 0320), and the document where
                       the marker earns the most. Under a status-hold a
                       PARTIALLY_PAID invoice that went on hold stopped saying
                       how much had been paid — on the one screen a person opens
                       to decide whether to pay the rest. It now says both.

     Delivery Order    Its first hold of ANY kind. The owner asked for one on
                       2026-08-21 (「再加到一个 Hold」) and it was missed while the
                       other three got theirs. It needed NO enum change:
                       scm.do_status is untouched. That is the plainest argument
                       for a marker — the other three each cost an irreversible
                       ALTER TYPE ... ADD VALUE.

   NO CAS / VERSION ARGUMENT ON ANY OF THEM, deliberately. The Sales Order's
   status route carries one because two tabs writing STATUS can silently
   overwrite each other's progress. Two tabs writing the MARKER cannot: it is one
   boolean plus a note, the last writer's intent is the one that should win, and
   refusing a hold because a colleague edited the order in another tab would be a
   worse failure than accepting it.

   WHAT BLOCKS A HELD DOCUMENT IS NOT HERE. Each guard reads the flag where it
   already reads the status — `isReceivablePo` (grns.ts), the billable-GRN read
   (purchase-invoices.ts), `allocationPisOnHold` (payment-vouchers.ts),
   `soCanRaiseDo`, `firstUnorderableSo`, `soEarnsCommission`. The full list, and
   the two sites that deliberately do NOT consult it, are in
   `docs/modules/document-status-vocabulary.md`.
   ---------------------------------------------------------------------------- */

import { makeHoldHandler, type HoldRouteConfig } from '../lib/document-hold-route';

/** The five documents, and what their own route is keyed by. */
export type HoldDocument = 'so' | 'po' | 'grn' | 'pi' | 'do';

const CONFIGS: Record<HoldDocument, HoldRouteConfig> = {
  so:  { table: 'mfg_sales_orders',   keyColumn: 'doc_no', param: 'docNo', responseKey: 'salesOrder',      echoColumns: 'status' },
  po:  { table: 'purchase_orders',    keyColumn: 'id',     param: 'id',    responseKey: 'purchaseOrder',   echoColumns: 'po_number, status' },
  grn: { table: 'grns',               keyColumn: 'id',     param: 'id',    responseKey: 'grn',             echoColumns: 'grn_number, status' },
  pi:  { table: 'purchase_invoices',  keyColumn: 'id',     param: 'id',    responseKey: 'purchaseInvoice', echoColumns: 'invoice_number, status' },
  do:  { table: 'delivery_orders',    keyColumn: 'id',     param: 'id',    responseKey: 'deliveryOrder',   echoColumns: 'do_number, status' },
};

/** The route path each document mounts the hold on. */
const PATHS: Record<HoldDocument, string> = {
  so: '/:docNo/hold', po: '/:id/hold', grn: '/:id/hold', pi: '/:id/hold', do: '/:id/hold',
};

/**
 * Mount `PATCH .../hold` on one document's router.
 *
 * The router is typed loosely on purpose: the five routers carry five different
 * `Hono<{ Bindings, Variables }>` instantiations, and narrowing this to any one
 * of them would make the shared mount unusable by the other four — which is the
 * duplication the module exists to avoid.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- five distinct Hono generic instantiations share this mount; see the note above
export function mountHoldRoute(router: any, doc: HoldDocument): void {
  router.patch(PATHS[doc], makeHoldHandler(CONFIGS[doc]));
}
