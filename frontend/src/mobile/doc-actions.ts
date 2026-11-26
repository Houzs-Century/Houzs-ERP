
import { inBandFailureText, type InBandFailure } from "../vendor/scm/lib/mutation-error";

export type ActVariant = "solid" | "outline" | "danger";

/** One footer action button descriptor. */
export type DocAction = {
  key: string;
  label: string;
  variant: ActVariant;
  request: { path: string; method: "PATCH" | "POST" | "DELETE"; body?: unknown };
  confirm?: { title: string; body?: string; confirmLabel: string };
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

/** The words the phone shows before cancelling a Delivery Order.
 *
 *  Owner, 2026-09-14:「DO cancel need pop out window for reason」. MUST stay the
 *  sentence the desktop shows (pages/scm-v2/use-do-cancel-action.ts
 *  `doCancelPrompt`), for the same reason as the PO's copy above. */
export const DO_CANCEL_PROMPT: ReasonPrompt = {
  title: "Cancel this delivery order?",
  body: "Say why. It is cancelled as soon as you confirm — no approval is needed: its stock goes back and its lines are released to the Sales Order. A cancelled delivery order cannot be reactivated, and this reason is kept on its History.",
  placeholder: "e.g. customer postponed the delivery",
  confirmLabel: "Cancel DO",
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
  const body = action.request.body;
  const carried = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return { ...action, request: { ...action.request, body: { ...carried, reason: reason.trim() } } };
}

/**
 * What the footer says once an action's request came back 200. It used to be
 * "Done" every time — including a Delivery Order Confirm whose stock OUT was
 * refused, or a GRN post whose PO recount failed: the server says so in the body
 * (`movementErrors` / `cancelErrors` / `reversalErrors` / `recountError`) and the
 * phone threw the body away. The desktop reads the same fields through
 * reportInBandFailure; this is the phone's copy of that rule, worded the same.
 */
export function actionDoneNotice(label: string, data: unknown): { title: string; body?: string; tone?: "error" } {
  const text = inBandFailureText((data ?? undefined) as InBandFailure | undefined);
  if (!text) return { title: "Done" };
  return { title: `${label} saved, but not everything was recorded`, body: text, tone: "error" };
}
