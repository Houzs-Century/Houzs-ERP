/* ----------------------------------------------------------------------------
   use-cancel-request-action — the ask-for-a-reason-then-raise step behind
   every "Request cancellation" control, on both documents and every surface.

   THE OWNER, 2026-09-08: 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」.

   THE SALES ORDER'S, since 2026-09-09. The Purchase Order left this flow when
   the owner cut its approval (「PO cancelled 不需要审批，只需要 remark 原因取消」);
   it asks for its reason and cancels on the spot through ./use-po-cancel-action
   .ts, and raising a PO request is refused by the server (no_approval_needed).
   The copy below says two approvers have to sign, which is true of the Sales
   Order alone — do not re-point another document at it without changing that
   sentence.

   ONE COPY OF THE WORDS, NOT SIX. The Sales Order had four Cancel buttons
   (edit page, read page, list menu, mobile) and the Purchase Order two, each
   with its own confirm copy — one said "You can Reopen it later" about a
   cancel that is final. What the operator is told now is a decision: the
   document is NOT cancelled by this click, two people have to approve, and
   the reason they type is what those two people will read. That sentence has
   to be identical everywhere or it stops being true somewhere.

   IT ALSO KEEPS THE PAGES UNDER THEIR SIZE CEILINGS. SalesOrderDetail.tsx and
   MfgSalesOrdersListV2.tsx are at `scripts/file-size-ceilings.json`, and this
   repo's rule is that new code moves into a module rather than a ceiling
   moving up — use-hold-action.ts and use-close-action.ts are the precedents.

   THE IN-APP usePrompt, NOT window.prompt — the lint gate refuses a native
   prompt in this tree, and a mandatory multi-line reason needs a real field.
   ---------------------------------------------------------------------------- */

import { usePrompt } from "../../vendor/scm/components/PromptDialog";
import { serviceNotify } from "../../vendor/scm/lib/dialog-service";
import { useRaiseCancelRequest, type CancelDocType } from "../../vendor/scm/lib/document-cancel-queries";

const NOUN: Record<CancelDocType, string> = { so: "sales order", po: "purchase order" };

/** Under 5 characters the server refuses it too (reason_required); the prompt
 *  says so first so the refusal is never the first thing the person sees. */
export const MIN_CANCEL_REASON = 5;

/** The prompt-dialog copy — used by useCancelRequestAction below and by any
 *  screen that runs its own prompt. The sentence that matters is the second
 *  one: nothing is cancelled by this click. */
export const cancelRequestPrompt = (docType: CancelDocType, docNumber: string) => ({
  title: `Request cancellation of ${docNumber}?`,
  body:
    `Say why this ${NOUN[docType]} should be cancelled. ` +
    "Nothing is cancelled yet: two approvers have to sign first, and they will read this reason.",
  placeholder: "e.g. customer cancelled the order and asked for a refund",
  confirmLabel: "Request cancellation",
  multiline: true,
  validate: (v: string) =>
    v.trim().length < MIN_CANCEL_REASON ? "Give a reason the approvers can act on — at least a few words." : null,
});

/**
 * Returns `(key, docNumber) => Promise<boolean>` — ask for the reason, raise
 * the request, tell the person what happens next. Resolves true when a request
 * was raised. `key` is what the document's own route is keyed by: `doc_no` for
 * the Sales Order, `id` for the Purchase Order. `docNumber` is only ever shown.
 */
export function useCancelRequestAction(docType: CancelDocType) {
  const prompt = usePrompt();
  const raise = useRaiseCancelRequest(docType);
  return async (key: string, docNumber: string): Promise<boolean> => {
    const reason = await prompt(cancelRequestPrompt(docType, docNumber));
    if (reason == null) return false;
    try {
      await raise.mutateAsync({ key, reason: reason.trim() });
      void serviceNotify({
        title: "Cancellation requested",
        body: `${docNumber} is not cancelled yet. It needs a level-1 and then a level-2 approval; the approvers have been notified.`,
      });
      return true;
    } catch (err) {
      /* A refusal that reaches nobody is worse than a crash (CLAUDE.md). */
      void serviceNotify({
        title: "Could not request cancellation",
        body: err instanceof Error ? err.message : `Something went wrong with this ${NOUN[docType]}.`,
        tone: "error",
      });
      return false;
    }
  };
}
