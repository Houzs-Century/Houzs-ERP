/* ----------------------------------------------------------------------------
   use-discard-draft-action — the confirm-then-delete step behind every
   "Discard draft" control on the desktop Sales Order surfaces.

   THE OWNER, 2026-07-20: a junk draft (a bad scan / OCR slip, a duplicate keyed
   by mistake) had no way out but Confirm → Cancel, which burns a document
   number and leaves a dead CANCELLED row. DELETE /mfg-sales-orders/:docNo is
   that way out, and it is DRAFT-only — the server refuses anything else.

   WHY THIS FILE EXISTS (2026-10-13, 「这个draft - discard不到」). The button was
   wired on exactly two screens: the mobile detail and the desktop INLINE EDITOR
   (?edit=1). The three places a person actually looks at a draft on the desktop
   — the list's right-click menu, the quick-view drawer and the read-only detail
   page — offered Confirm and Request cancellation and nothing else, so the
   draft could not be discarded from where it was being read. One hook, three
   callers, one copy of the words (use-hold-action.ts / use-close-action.ts are
   the precedents), and the list file stays under its size ceiling.

   RETURNS true ONLY WHEN THE ROW IS GONE. The caller decides what to do with
   the screen (close the drawer, leave the page); this file decides nothing
   about navigation. A refusal from the server (payments on the draft, a live
   edit lease, a stale version) is shown to the person word for word — a
   refusal that reaches nobody is worse than a crash (CLAUDE.md).
   ---------------------------------------------------------------------------- */

import { useConfirm } from "../../vendor/scm/components/ConfirmDialog";
import { serviceNotify } from "../../vendor/scm/lib/dialog-service";
import { useDeleteMfgSalesOrder } from "../../vendor/scm/lib/sales-order-queries";

export const DISCARD_DRAFT_LABEL = "Discard draft";

/** The confirm-dialog copy — the sentence that matters is the last one: a
 *  CONFIRMED order is cancelled, never discarded, so nobody looks for this
 *  button on one. */
export const discardDraftPrompt = (docNumber: string) => ({
  title: `Discard draft ${docNumber}?`,
  body:
    "This permanently deletes this draft order and everything on it. It cannot be undone. " +
    "(Confirmed orders are cancelled, not discarded.)",
  confirmLabel: DISCARD_DRAFT_LABEL,
  danger: true,
});

/**
 * Returns `{ discard, isPending }`. `discard(docNo)` confirms, deletes, tells
 * the person, and resolves true when the draft no longer exists.
 */
export function useDiscardDraftAction() {
  const askConfirm = useConfirm();
  const del = useDeleteMfgSalesOrder();
  const discard = async (docNo: string): Promise<boolean> => {
    if (!(await askConfirm(discardDraftPrompt(docNo)))) return false;
    try {
      await del.mutateAsync({ docNo });
      void serviceNotify({ title: "Draft discarded", body: `${docNo} has been deleted.` });
      return true;
    } catch (err) {
      void serviceNotify({
        title: "Could not discard this draft",
        body: `${err instanceof Error ? err.message : "Something went wrong."} Nothing was changed.`,
        tone: "error",
      });
      return false;
    }
  };
  return { discard, isPending: del.isPending };
}
