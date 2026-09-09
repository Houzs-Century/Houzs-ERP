/* ----------------------------------------------------------------------------
   doc-actions — the footer-action descriptor every mobile document detail
   renders, and the one step that asks for a mandatory reason before firing one.

   EXTRACTED FROM MobileModuleDetail.tsx, which sits at its 2000-line ceiling
   (scripts/file-size-ceilings.json): the reason prompt the Purchase Order cancel
   needs could not be added there without pushing the file past it, and this
   repo's rule is that new code moves into a module rather than a ceiling moving
   up. What lives here is the SHAPE and the ASKING; which actions a document
   offers at which status stays in that file's `statusActionsFor`, where it is
   read beside the rest of the screen.
   ---------------------------------------------------------------------------- */

export type ActVariant = "solid" | "outline" | "danger";

/** One footer action button descriptor. */
export type DocAction = {
  key: string;
  label: string;
  variant: ActVariant;
  /** POST/PATCH/DELETE request, relative to /api/scm. */
  request: { path: string; method: "PATCH" | "POST" | "DELETE"; body?: unknown };
  /** In-app danger confirm before firing (Cancel / Void). */
  confirm?: { title: string; body?: string; confirmLabel: string };
  /** Ask for a mandatory REASON and send it as `reason` in the body. The server
   *  refuses a Purchase Order cancel that carries none, so a phone that only
   *  confirmed would collect a 400 the operator cannot act on. Used INSTEAD of
   *  `confirm`: the prompt is the confirmation, and asking twice for one
   *  decision is exactly what the desktop copy was cut down to avoid. */
  reasonPrompt?: ReasonPrompt;
  /** When true, the record no longer exists after this action → navigate back
   *  to the list instead of staying on a now-deleted detail.
   *
   *  NO action sets this today. The last one that did was the mobile Delete PO
   *  (removed 2026-08-11 with its endpoint — owner rule 不可以删只可以 cancel).
   *  Kept because a legitimate `removes` action can still exist — discarding a
   *  DRAFT that was never confirmed, the shape SO `DELETE /:docNo` has. It is
   *  NOT the hook for re-adding a document delete; see
   *  docs/hard-delete-inventory.md. */
  removes?: boolean;
};

export type ReasonPrompt = {
  title: string;
  body: string;
  placeholder: string;
  confirmLabel: string;
  minChars: number;
};

/** The words the phone shows before cancelling a Purchase Order.
 *
 *  Owner, 2026-09-09:「PO cancelled 不需要审批，只需要 remark 原因取消」. MUST stay
 *  the sentence the desktop shows (pages/scm-v2/use-po-cancel-action.ts
 *  `poCancelPrompt`): one document, one rule, and the buyer reads it on
 *  whichever screen is in their hand. */
export const PO_CANCEL_PROMPT: ReasonPrompt = {
  title: "Cancel this purchase order?",
  body: "Say why. It is cancelled as soon as you confirm — no approval is needed — and this reason is kept on the PO. Its sales-order lines go back to the picker.",
  placeholder: "e.g. supplier cannot meet the delivery date",
  confirmLabel: "Cancel PO",
  minChars: 5,
};

/** Ask, and hand back the action to fire with `reason` merged into its body —
 *  or null when the person dismissed the prompt, which cancels nothing. An
 *  action with no `reasonPrompt` is returned untouched and asks nothing. */
export async function askActionReason(
  action: DocAction,
  prompt: (opts: {
    title: string; body: string; placeholder: string; confirmLabel: string;
    multiline: boolean; validate: (v: string) => string | null;
  }) => Promise<string | null>,
): Promise<DocAction | null> {
  const p = action.reasonPrompt;
  if (!p) return action;
  const reason = await prompt({
    title: p.title,
    body: p.body,
    placeholder: p.placeholder,
    confirmLabel: p.confirmLabel,
    multiline: true,
    validate: (v: string) => (v.trim().length < p.minChars ? "Say why in a few words — this is what the next person reads." : null),
  });
  if (reason == null) return null;
  /* Merged, not replaced: an action can carry both a body and a reason. */
  return { ...action, request: { ...action.request, body: { ...((action.request.body as Record<string, unknown>) ?? {}), reason: reason.trim() } } };
}
