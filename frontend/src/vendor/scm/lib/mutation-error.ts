/* ---------------------------------------------------------------------------
 * writeFailed — the shared onError for SCM write mutations.
 *
 * WHY THIS EXISTS. The owner pressed "Deactivate" on a fabric and nothing
 * happened. Nothing is what the code did: the mutation had an onSuccess and no
 * onError, so the server's refusal — the SCM area guard wanting `edit` on the
 * area where the grid's GET only needs `view`
 * (scm/middleware/area-guard.ts:16), a 409 while the active company has not
 * resolved, a 404 when the row belongs to the other company — arrived, was
 * correct, and was dropped on the floor. No toast, no inline message, no
 * console line. The row just stayed as it was.
 *
 * That is the worst shape a defect can take here. The USER cannot report it
 * usefully ("the button does nothing"), and the DEVELOPER cannot see it either,
 * because nothing failed loudly enough to look for.
 *
 * A sweep found 35 mutations in this tree with the same shape (no onError on
 * the mutation AND no consumer catching it) — `node
 * frontend/scripts/check-silent-mutations.mjs` is the check, and it reports
 * CAUGHT / SILENT / UNRESOLVED separately so the number stays honest.
 *
 * WHAT IT SHOWS. authedFetch throws Errors carrying the SERVER's own sentence,
 * so err.message names the actual cause. A generic "something went wrong" would
 * only send the next person hunting again, which is the thing being fixed.
 * ------------------------------------------------------------------------- */
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
};

export const reportInBandFailure = (
  title: string,
  res: InBandFailure | undefined | void,
): void => {
  const errs = [
    ...(res?.movementErrors ?? []),
    ...(res?.cancelErrors ?? []),
    ...(res?.reversalErrors ?? []),
  ];
  if (!errs.length) return;
  writeFailedAs(title)(new Error(
    `${errs.join('\n')}\n\n` +
    'The document is saved. Stock was NOT adjusted for this change — tell IT so the ledger can be repaired.',
  ));
};
