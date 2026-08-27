/* ----------------------------------------------------------------------------
   use-hold-action — the confirm-then-write step behind Put On Hold / Take Off
   Hold, shared by all five document lists.

   THE OWNER, 2026-08-22: 「我们的hold是给我们知道一个 order hold这的」 — the hold is
   there so people KNOW a document is paused. 「take off hold也要看」.

   ONE COPY OF THE WORDS, NOT FIVE. What the operator is told before a hold lands
   is a decision, not boilerplate, and the sentence that matters is the SECOND
   one: *it keeps its current status.* Before mig 0324 that was false — putting a
   document on hold overwrote its status and taking the hold off guessed a new
   one — so the reassurance has to be identical on all five screens or it stops
   being a reassurance. Five inline copies would drift the day someone reworded
   one of them.

   IT ALSO KEEPS THE LISTS UNDER THEIR SIZE CEILINGS. Four of the five list
   screens are at or over `scripts/file-size-ceilings.json`, and this repo's rule
   is that new code moves into a module rather than a ceiling moving up.

   THE IN-APP `useConfirm`, NOT `window.confirm`. This file used the native
   confirm while its neighbours (`doCancel` on the PO and GRN lists) did too;
   since the 2026-08-24 sweep every operator-facing prompt in the SCM tree is the
   styled in-app dialog (Commander's "no 裸奔" rule — the ConfirmProvider is
   mounted by Scm2990Shell on every /scm/* route), and the lint gate in
   frontend/eslint.config.mjs now refuses a native prompt here outright.
   ---------------------------------------------------------------------------- */

import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { useSetDocumentHold, type HoldDocType } from "../../vendor/scm/lib/document-hold-queries";

/** How the document is named to the operator, and the field holding its number. */
type HoldPrompt = { noun: string };

const PROMPTS: Record<HoldDocType, HoldPrompt> = {
  so:  { noun: "sales order" },
  po:  { noun: "purchase order" },
  grn: { noun: "goods received note" },
  pi:  { noun: "purchase invoice" },
  do:  { noun: "delivery order" },
};

/**
 * Returns `(key, docNumber, onHold) => void` — confirm, then write the marker.
 *
 * `key` is what the document's own route is keyed by: `doc_no` for the Sales
 * Order, `id` for the other four. `docNumber` is only ever shown to the person.
 *
 * The write NEVER sends a status. That is the property to check if this file is
 * edited: the moment a status goes over the wire, holding a document starts
 * destroying its progress again.
 */
export function useHoldAction(docType: HoldDocType) {
  const setHold = useSetDocumentHold(docType);
  const askConfirm = useConfirm();
  const { noun } = PROMPTS[docType];
  return async (key: string, docNumber: string, onHold: boolean) => {
    if (!(await askConfirm(holdPrompt(`${noun} ${docNumber}`, onHold)))) return;
    setHold.mutate({ key, onHold });
  };
}

/** The confirm-dialog copy for a hold — used by useHoldAction above and by any
 *  caller that runs its own dialog (the Sales Order list calls `askConfirm`
 *  directly). ONE copy of the words: the sentence that matters is "it keeps its
 *  current status", and it must not drift. */
export const holdPrompt = (docNumber: string, onHold: boolean) => ({
  title: onHold ? `Put ${docNumber} on hold?` : `Take ${docNumber} off hold?`,
  body: onHold
    ? "The order keeps its current status. It is marked so everyone can see it is paused."
    : "The hold marker is removed. The order was never moved, so it carries on from where it is.",
  confirmLabel: onHold ? "Put On Hold" : "Take Off Hold",
});
