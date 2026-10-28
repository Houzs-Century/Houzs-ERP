/* ----------------------------------------------------------------------------
   use-do-cancel-action — ask why, then cancel the Delivery Order.

   THE OWNER, 2026-09-14: 「DO cancel need pop out window for reason」. The
   Purchase Order's rule (use-po-cancel-action.ts) on the delivery order: no
   approval, no waiting, but never silent — the reason is mandatory, the server
   refuses a cancel without one (400 `reason_required`, the guard in
   backend/src/scm/routes/document-cancel-routes.ts), and it is kept on the
   delivery order's History and in the cancellation ledger.

   ONE COPY OF THE WORDS. The desktop has two Cancel controls — the detail page
   and the list row menu — and both open this prompt. The phone says the same
   thing through DO_CANCEL_PROMPT (mobile/doc-actions.ts), which must not drift
   from it.

   THE IN-APP usePrompt, NOT window.prompt — the lint gate refuses a native
   prompt in this tree, and a mandatory reason needs a real field.
   ---------------------------------------------------------------------------- */

import { usePrompt } from "../../vendor/scm/components/PromptDialog";
import { serviceNotify } from "../../vendor/scm/lib/dialog-service";
import { useCancelMfgDeliveryOrder } from "../../vendor/scm/lib/delivery-order-queries";

/** Under 5 characters the server refuses it too (`reason_required`); the prompt
 *  says so first, so the refusal is never the first thing the person sees. */
export const MIN_DO_CANCEL_REASON = 5;

/** The prompt copy. What matters is that it says what the cancel DOES: it runs
 *  at once, the stock comes back, and it cannot be undone. */
export const doCancelPrompt = (doNumber: string) => ({
  title: `Cancel delivery order ${doNumber}?`,
  body:
    "Say why this delivery order is being cancelled. It is cancelled as soon as you confirm — no approval is needed: " +
    "its stock goes back and its lines are released to the Sales Order. A cancelled delivery order cannot be reactivated, " +
    "and this reason is kept on its History.",
  placeholder: "e.g. customer postponed the delivery; wrong items loaded",
  confirmLabel: "Cancel DO",
  multiline: true,
  validate: (v: string) =>
    v.trim().length < MIN_DO_CANCEL_REASON ? "Say why in a few words — this is what the next person reads." : null,
});

/**
 * `{ cancelDo, isPending }` — `cancelDo(id, doNumber)` asks for the reason,
 * cancels, and reports either way. Resolves true when the delivery order was
 * cancelled. `id` is the DO's uuid (its route key), `doNumber` is only shown.
 */
export function useDoCancelAction() {
  const prompt = usePrompt();
  const cancel = useCancelMfgDeliveryOrder();
  const cancelDo = async (id: string, doNumber: string): Promise<boolean> => {
    const reason = await prompt(doCancelPrompt(doNumber));
    if (reason == null) return false;
    try {
      const res = await cancel.mutateAsync({ id, reason: reason.trim() });
      /* The cancel stands even when returning its stock partly failed — the
         handler reports that in-band as `movementErrors` rather than refusing,
         so "its stock is back" is only said when it is true. */
      const stockErrors = res.movementErrors ?? [];
      void serviceNotify(stockErrors.length > 0
        ? { title: `${doNumber} cancelled, but its stock was not all returned`, body: `${stockErrors.join("\n")}\n\nFix manually via Stock Adjustments.`, tone: "error" }
        : { title: `${doNumber} cancelled`, body: "Its stock is back and its lines are released to the Sales Order." });
      return true;
    } catch (err) {
      /* A refusal that reaches nobody is worse than a crash (CLAUDE.md). The
         server's own words carry the reason — a Sales Invoice or Delivery Return
         already raised on it, or a reason too short. */
      void serviceNotify({
        title: "Could not cancel this delivery order",
        body: err instanceof Error ? err.message : "Something went wrong with this delivery order.",
        tone: "error",
      });
      return false;
    }
  };
  return { cancelDo, isPending: cancel.isPending };
}
