import { serviceNotify } from './dialog-service';

/** Drop-in `onError` for a write mutation: `onError: writeFailed`. */
export const writeFailed = (err: unknown): void => {
  void serviceNotify({
    title: 'That change was not saved',
    body: err instanceof Error ? err.message : 'Something went wrong. Please try again.',
    tone: 'error',
  });
};

/**
 * Same, with a caller-supplied title for cases where "that change" is too vague
 * to act on — a delete, a bulk import, a costing run.
 */
export const writeFailedAs = (title: string) => (err: unknown): void => {
  void serviceNotify({
    title,
    body: err instanceof Error ? err.message : 'Something went wrong. Please try again.',
    tone: 'error',
  });
};

/**
 * IN-BAND FAILURE — the request SUCCEEDED and something it depends on did not.
 *
 * The SCM write routes answer 200 and put the ledger's failure in the body:
 * `{ ok: true, movementErrors: [...] }`, or `cancelErrors`, or `reversalErrors`.
 * The write is deliberately best-effort — a document edit must not be rolled
 * back for a ledger hiccup — so the request is genuinely a success and the
 * stock genuinely did not move.
 *
 * `writeFailed` cannot help here: nothing rejects, so `onError` never fires.
 * Call this from `onSuccess` instead.
 *
 * WHY IT IS SHARED RATHER THAN PER-FILE. On 2026-08-13 eight backend route
 * files returned `movementErrors` and three frontend files read it; `POST
 * /purchase-returns` had returned the field since it was written while
 * PurchaseReturnNew.tsx announced "Stock OUT recorded." unconditionally, so a
 * refused inventory write reported success for months. `cancelErrors` and
 * `reversalErrors` had ZERO readers — including one the same session's own
 * backend fix had just started emitting, which made that fix half a feature.
 * One helper, one wording, and `frontend/scripts/check-inband-failures.mjs`
 * counts producers against readers so the next field cannot ship reader-less.
 *
 * The message says the document IS saved on purpose. An operator who reads
 * "failed" and re-submits creates a second document on top of a ledger that is
 * already out of step.
 */
export type InBandFailure = {
  movementErrors?: string[] | null;
  cancelErrors?: string[] | null;
  reversalErrors?: string[] | null;
  settleErrors?: string[] | null;
  recountError?: string | null;
  paymentErrors?: string[] | null;
};

/**
 * The sentence for what did NOT happen, or null when everything did. Exported
 * for a screen that shows its outcome in its own dialog (GrnNew) rather than a
 * toast — the dialog must not say "PO received qty updated" over a recount that
 * failed.
 */
export const inBandFailureText = (res: InBandFailure | undefined | void): string | null => {
  const stock = [
    ...(res?.movementErrors ?? []),
    ...(res?.cancelErrors ?? []),
    ...(res?.reversalErrors ?? []),
  ];
  const parts: string[] = [];
  if (stock.length) {
    parts.push(
      `${stock.join('\n')}\n\n` +
      'The document is saved. Stock was NOT adjusted for this change — tell IT so the ledger can be repaired.',
    );
  }
  if (res?.settleErrors?.length) {
    parts.push(
      `${res.settleErrors.join('\n')}\n\n` +
      'Nothing was lost: press the same button again and it finishes these steps without repeating the rest.',
    );
  }
  if (res?.recountError) {
    parts.push(
      `The purchase order's received quantity was NOT updated (${res.recountError}). ` +
      'The receipt is saved, but the PO may still show these goods as outstanding — tell IT so it can be recounted.',
    );
  }
  if (res?.paymentErrors?.length) {
    parts.push(
      `${res.paymentErrors.join('\n')}\n\n` +
      'The order is saved. Do not create it again - add the payment on the order instead.',
    );
  }
  return parts.length ? parts.join('\n\n') : null;
};

export const reportInBandFailure = (
  title: string,
  res: InBandFailure | undefined | void,
): void => {
  const text = inBandFailureText(res);
  if (!text) return;
  writeFailedAs(title)(new Error(text));
};
