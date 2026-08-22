/* ----------------------------------------------------------------------------
   document-hold-queries — the ONE mutation behind Put On Hold / Take Off Hold,
   for all five documents.

   THE OWNER, 2026-08-22: 「我们的hold是给我们知道一个 order hold这的」 and
   「take off hold也要看」.

   WHAT THIS REPLACES, on the Sales Order — the only document that had a hold
   control at all:

     Put On Hold     PATCH /mfg-sales-orders/:docNo/status  {status:'ON_HOLD'}
     Take Off Hold   PATCH /mfg-sales-orders/:docNo/status  {status:'CONFIRMED'}

   Both lines were in `row-menus.ts`, and the second one is the defect in its
   plainest form: it sent CONFIRMED for every order, whatever it had been. An
   order that was IN_PRODUCTION when somebody paused it came back as Confirmed,
   and no record of the production progress survived anywhere — there is no
   `previous_status` column in scm, which the PR body's grep shows. Holding was
   a one-way lossy operation and releasing was a guess.

   ONE HOOK, FIVE DOCUMENTS. The server has one handler
   (backend/src/scm/lib/document-hold-route.ts) and this is its one client. A
   per-document copy would be five places to forget to invalidate a cache from,
   and this repo already keeps a checker for exactly that class
   (check-duplicated-decisions.mjs).

   THE PO, THE GRN, THE PI AND THE DO GET A WORKING HOLD FOR THE FIRST TIME.
   Migrations 0318/0319/0320 gave the first three the WORD On Hold on
   2026-08-21 — a tab, a pill, a detail blurb — and nothing in frontend/src ever
   sent that status, so the three screens rendered a state the product could not
   produce. The Delivery Order had nothing at all; the owner asked for one on
   2026-08-21 (「再加到一个 Hold」).
   ---------------------------------------------------------------------------- */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';

/** The five documents a hold marker lives on. The key decides the URL and which
 *  caches are dropped, so a new document type cannot be added by a caller
 *  passing a string — it has to be added here, beside its invalidations. */
export type HoldDocType = 'so' | 'po' | 'grn' | 'pi' | 'do';

type HoldDocSpec = {
  /** The API path segment, e.g. `mfg-sales-orders`. */
  base: string;
  /** Every react-query key that can be showing this document. */
  invalidate: string[];
  /** What the operator sees if the write fails. */
  label: string;
};

const DOCS: Record<HoldDocType, HoldDocSpec> = {
  so:  { base: 'mfg-sales-orders',   label: 'sales order',           invalidate: ['mfg-sales-orders', 'mfg-sales-order-detail', 'so-detail'] },
  po:  { base: 'purchase-orders',    label: 'purchase order',        invalidate: ['purchase-orders', 'purchase-order-detail'] },
  grn: { base: 'grns',               label: 'goods received note',   invalidate: ['grns', 'grn-detail'] },
  pi:  { base: 'purchase-invoices',  label: 'purchase invoice',      invalidate: ['purchase-invoices', 'purchase-invoice-detail'] },
  do:  { base: 'delivery-orders-mfg', label: 'delivery order',       invalidate: ['mfg-delivery-orders', 'mfg-delivery-order-detail'] },
};

export type HoldVars = {
  /** `doc_no` for the Sales Order, `id` for the other four — whatever that
   *  document's own route is keyed by. */
  key: string;
  /** TRUE puts the marker on, FALSE takes it off. No default anywhere in this
   *  chain: a missing value is refused by the server (`on_hold_required`),
   *  because guessing either way turns one operator action into the other. */
  onHold: boolean;
  /** Why, in the operator's words. Optional — a hold with no reason is still a
   *  hold, and demanding one would just produce a screen full of ".". */
  reason?: string | null;
};

/**
 * Put the hold marker on a document, or take it off.
 *
 * IT NEVER SENDS A STATUS, and that is the property to check if this file is
 * ever edited. The moment a `status` appears in this body the change has been
 * undone and holding an order will start destroying its progress again.
 */
export function useSetDocumentHold(docType: HoldDocType) {
  const qc = useQueryClient();
  const spec = DOCS[docType];
  return useMutation({
    mutationFn: ({ key, onHold, reason }: HoldVars) =>
      authedFetch(`/${spec.base}/${encodeURIComponent(key)}/hold`, {
        method: 'PATCH',
        body: JSON.stringify({ onHold, reason: reason ?? null }),
      }),
    onSuccess: (_data, vars) => {
      /* `void` because react-query's invalidateQueries returns a promise nobody
         waits on — a refetch that fails re-renders stale data, which the next
         poll corrects, and awaiting it here would hold the mutation open for
         every list this document appears on. Same posture as the sibling
         mutations; the linter wants the intent spelled out rather than the
         promise dropped silently. */
      for (const k of spec.invalidate) void qc.invalidateQueries({ queryKey: [k] });
      void qc.invalidateQueries({ queryKey: [spec.invalidate[0], vars.key] });
    },
    onError: (err, vars) => {
      /* A refusal that reaches nobody is worse than a crash — the owner's
         "the button does nothing" (CLAUDE.md, mutation-error.ts). */
      void serviceNotify({
        title: vars.onHold ? 'Could not put it on hold' : 'Could not take it off hold',
        body: err instanceof Error ? err.message : `Something went wrong with this ${spec.label}.`,
        tone: 'error',
      });
    },
  });
}
