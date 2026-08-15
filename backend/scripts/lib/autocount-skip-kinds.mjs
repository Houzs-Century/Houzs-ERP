// The plain-node MIRROR of src/scm/lib/autocount-outbox-status.ts.
//
// WHY A MIRROR AND NOT AN IMPORT. check-autocount-outbox-health.mjs runs under
// plain node against postgres.js — it cannot import TypeScript, and giving it a
// tsx runner to save one file would change how a working production diagnostic
// is executed for no operational gain. So the taxonomy is copied, and
// src/scm/lib/autocountOutboxStatus.canonical.test.ts imports BOTH files and
// fails if they differ by so much as a character of a remedy.
//
// Edit the TypeScript module, then edit this one; the test will tell you if you
// only did the first. Do NOT add a shebang here: this file is imported by a
// vitest suite, and on Windows vitest inlines the source before
// vm.runInThisContext, so a `#!` that is no longer at byte 0 is a SyntaxError at
// LOAD (CLAUDE.md, #2062).

/** The four values 0277's CHECK constraint admits on `status`. */
export const AC_OUTBOX_STATUSES = ['pending', 'sent', 'failed', 'skipped'];

/** The four statuses plus the one derived state, `requeued`. */
export const AC_OUTBOX_STATES = ['pending', 'sent', 'failed', 'skipped', 'requeued'];

/** What a re-queued row's ORIGINAL skip is rewritten to start with. */
export const REQUEUE_NOTE_PREFIX = '[re-queued';

/** Past this an operation is surfaced as FAILED instead of retrying forever. */
export const AC_MAX_ATTEMPTS = 6;

/** What each state MEANS to someone who did not write the queue. */
export const AC_STATE_MEANING = {
  pending:
    'Queued. The 5-minute cron will send it. Not an error by itself — only if the age keeps climbing.',
  sent: 'In the AutoCount account book, under the document number shown.',
  failed:
    'AutoCount refused it, or it ran out of attempts. The document is in the ERP and NOT in the account book.',
  skipped:
    'The ERP decided not to send it, on purpose. The reason names the remedy.',
  requeued:
    'A refusal that has already been asked again. Its document is queued or sent under a newer row — this is the record, not an open item.',
};

/**
 * The reason strings the ERP writes when it declines to send, and the remedy.
 *
 * MATCH ON THE ERROR CLASS NAME, NOT ON "refused, nothing sent" — noteReadFailure
 * writes that prefix for several classes with different remedies, and matching
 * the prefix once sent an operator holding a MissingLocationError off to
 * backfill DtlKeys (#2094).
 */
export const AC_SKIP_KINDS = [
  {
    kind: 'keyless-line',
    needle: 'refused, nothing sent (KeylessLineError)',
    remedy: 'line identity missing — backfill linked_ac_dtlkey, then save again',
  },
  {
    kind: 'sofa-collapse',
    needle: 'refused, nothing sent (SofaCollapseError)',
    remedy:
      "sofa build cannot be folded into AutoCount's one line without inventing Desc2 text",
  },
  {
    kind: 'item-code',
    needle: 'refused, nothing sent (ItemCodeError)',
    remedy:
      'an ERP item resolves to no single AutoCount ItemCode — fix the cutover map (scm.autocount_item_bindings)',
  },
  {
    kind: 'missing-location',
    needle: 'refused, nothing sent (MissingLocationError)',
    remedy:
      'a line carries no stock location — set the warehouse on the line, or the sales location on the document',
  },
  {
    kind: 'compose-failed',
    needle: 'compose failed, nothing sent',
    remedy:
      'the ERP could not read its own document while composing — a read fault, not a refusal',
  },
  {
    kind: 'masters-not-opened',
    needle: 'masters not opened',
    remedy: 'an item or salesperson could not be opened in AutoCount',
  },
  {
    kind: 'no-source-document',
    needle: 'no source document to transfer from',
    remedy: 'raised with no parent — cannot exist in AutoCount at all',
  },
  {
    kind: 'no-autocount-shape',
    needle: 'AutoCount has no shape',
    remedy: 'merged conversion (N sources -> 1 document) — must be worked by hand',
  },
];

/** The key given to a skip whose wording this module does not recognise. */
export const AC_SKIP_UNRECOGNISED = 'unrecognised';

/** Is this skip's reason the annotation the re-queue tool leaves behind? */
export function isRequeuedNote(lastError) {
  return (lastError ?? '').startsWith(REQUEUE_NOTE_PREFIX);
}

/** The state to SHOW for a row — its status, except a re-queued skip. */
export function acOutboxState(status, lastError) {
  /* Both terminal states, not just skipped — see the TS twin's comment. A
     re-queued FAILED row is history for the same reason a re-queued skip is:
     the document went through under a newer row. */
  if (isRequeuedNote(lastError) && (status === 'skipped' || status === 'failed')) return 'requeued';
  return status;
}

/** Which refusal class a skip belongs to, and the remedy for it. */
export function classifyAcSkip(lastError) {
  const text = lastError ?? '';
  for (const k of AC_SKIP_KINDS) {
    if (text.includes(k.needle)) return { kind: k.kind, remedy: k.remedy };
  }
  return { kind: AC_SKIP_UNRECOGNISED, remedy: null };
}

/** Does this row need somebody to do something? */
export function acNeedsAttention(status, lastError) {
  const state = acOutboxState(status, lastError);
  return state === 'failed' || state === 'skipped';
}
