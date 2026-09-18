/* ----------------------------------------------------------------------------
   use-po-cancel-action — ask why, then cancel the Purchase Order.

   THE OWNER, 2026-09-09: 「PO cancelled 不需要审批，只需要 remark 原因取消」. So a
   PO cancel is one step again — no request, no approver, no waiting — but it
   may not happen silently: the reason is mandatory, the server refuses a cancel
   without one (400 `reason_required`, the guard in
   backend/src/scm/routes/document-cancel-routes.ts), and it is recorded in the
   cancellation ledger and on the PO's own history.

   ONE COPY OF THE WORDS, NOT FOUR. The PO has four Cancel controls — the read
   page, the editor, the list row menu and mobile — and what the buyer is told
   has to be the same sentence on all of them, or it stops being true somewhere.
   Sibling of use-cancel-request-action.ts, which is now the SALES ORDER's (that
   one still takes two approvals).

   THE IN-APP usePrompt, NOT window.prompt — the lint gate refuses a native
   prompt in this tree, and a mandatory reason needs a real field.
   ---------------------------------------------------------------------------- */

import { usePrompt } from "../../vendor/scm/components/PromptDialog";
import { serviceNotify } from "../../vendor/scm/lib/dialog-service";
import { useCancelPurchaseOrder } from "../../vendor/scm/lib/suppliers-queries";

/** Under 5 characters the server refuses it too (`reason_required`); the prompt
 *  says so first, so the refusal is never the first thing the buyer sees. */
export const MIN_PO_CANCEL_REASON = 5;

/** The prompt copy — exported so a screen running its own prompt says the same
 *  thing. The sentence that matters is the second: this DOES cancel it. */
export const poCancelPrompt = (poNumber: string) => ({
  title: `Cancel PO ${poNumber}?`,
  body:
    "Say why this purchase order is being cancelled. " +
    "It is cancelled as soon as you confirm — no approval is needed — and this reason is kept on the PO.",
  placeholder: "e.g. supplier cannot meet the delivery date; re-ordering from another supplier",
  confirmLabel: "Cancel PO",
  multiline: true,
  validate: (v: string) =>
    v.trim().length < MIN_PO_CANCEL_REASON ? "Say why in a few words — this is what the next person reads." : null,
});

/**
 * `{ cancelPo, isPending }` — `cancelPo(id, poNumber)` asks for the reason,
 * cancels, and reports either way. Resolves true when the PO was cancelled.
 * `id` is the PO's uuid (its route key), `poNumber` is only ever shown.
 */
export function usePoCancelAction() {
  const prompt = usePrompt();
  const cancel = useCancelPurchaseOrder();
  const cancelPo = async (id: string, poNumber: string): Promise<boolean> => {
    const reason = await prompt(poCancelPrompt(poNumber));
    if (reason == null) return false;
    try {
      await cancel.mutateAsync({ id, reason: reason.trim() });
      void serviceNotify({ title: `PO ${poNumber} cancelled`, body: "Its sales-order lines are released back to the picker." });
      return true;
    } catch (err) {
      /* A refusal that reaches nobody is worse than a crash (CLAUDE.md). The
         server's own words carry the reason — a GRN on the PO, a drop-ship
         delivery already shipped, or a reason too short. */
      void serviceNotify({
        title: "Could not cancel this PO",
        body: err instanceof Error ? err.message : "Something went wrong with this purchase order.",
        tone: "error",
      });
      return false;
    }
  };
  return { cancelPo, isPending: cancel.isPending };
}
