// ----------------------------------------------------------------------------
// autocount-outbox-status — the VOCABULARY of scm.autocount_outbox, in one
// place, so a screen and a workflow log cannot describe the same row
// differently.
//
// WHY THIS FILE EXISTS. The taxonomy below was written and proven inside
// backend/scripts/check-autocount-outbox-health.mjs, which until now was the
// only thing that could read the queue. Giving the owner a page meant a second
// reader, and a second reader with its own copy of the taxonomy is how the two
// drift — the health check has already been wrong about this once, matching the
// shared prefix `refused, nothing sent` and so reporting all four refusal
// classes as a DtlKey problem (#2094). An operator holding a
// MissingLocationError was sent to backfill line keys.
//
// So: this module is the source, the script's copy is
// backend/scripts/lib/autocount-skip-kinds.mjs (plain ESM, because that script
// runs under plain node against postgres.js and cannot import TypeScript), and
// autocountOutboxStatus.canonical.test.ts imports BOTH and refuses to pass if
// they differ. A copy with no referee is a rule with two homes and no
// authority; that is this repo's stated position on mirrored rules
// (check-shared-mirrors.mjs).
//
// PURE. No imports, no client, no env. It is called from a route handler, from
// a test, and — through the mirror — from an ops script.
// ----------------------------------------------------------------------------

/** The four values 0277's CHECK constraint admits on `status`. */
export const AC_OUTBOX_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const;
export type AcOutboxStatus = (typeof AC_OUTBOX_STATUSES)[number];

/**
 * The state a READER should be shown, which is the four statuses plus one.
 *
 * `requeued` is not a database status and must not become one — 0277's CHECK
 * admits four and each of the others would be a lie about a re-queued row (it
 * was never sent, never failed, and `pending` would hand the drain a row with an
 * empty body). It is a skip that has already been asked again, and the whole
 * reason it needs its own name is that the table is append-only: without the
 * distinction the original refusal sits in the report forever, sending an
 * operator to fix something that is already fixed and already queued.
 */
export const AC_OUTBOX_STATES = ['pending', 'sent', 'failed', 'skipped', 'requeued'] as const;
export type AcOutboxState = (typeof AC_OUTBOX_STATES)[number];

/**
 * What a re-queued row's ORIGINAL skip is rewritten to start with.
 *
 * Written by annotateRequeued in autocount-requeue.ts, which imports it from
 * here so there is one definition rather than a constant and a comment asking
 * the next reader to keep two in step.
 */
export const REQUEUE_NOTE_PREFIX = '[re-queued';

/** Past this an operation is surfaced as FAILED instead of retrying forever. */
export const AC_MAX_ATTEMPTS = 6;

/**
 * What each state MEANS to someone who did not write the queue.
 *
 * The owner's question is "is anything stuck", and a status word alone does not
 * answer it: `skipped` reads like a shrug and is often the most serious row on
 * the page, while `pending` reads like a problem and is usually the system
 * working. Each sentence therefore says what is true of the DOCUMENT, not what
 * is true of the row.
 */
export const AC_STATE_MEANING: Record<AcOutboxState, string> = {
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
 * The reason strings the ERP writes when it declines to send, and what to do
 * about each. Ported verbatim from check-autocount-outbox-health.mjs.
 *
 * MATCH ON THE ERROR CLASS NAME, NOT ON "refused, nothing sent". noteReadFailure
 * (autocount-outbox.ts) writes `refused, nothing sent (${e.name}): ${message}`
 * for several different classes, and each has a different remedy — backfill a
 * DtlKey, fix a sofa build, map an item code, set a stock location. Every class
 * sets this.name in its constructor, so the parenthesised name is reliable.
 *
 * `kind` is a STABLE key, safe to put in a URL and to filter on. The needle is
 * the ERP's own wording and would change if a message were reworded; the key
 * must not.
 */
export interface AcSkipKind {
  /** Stable identifier — URL filters and tests use this, never the needle. */
  kind: string;
  /** Substring of `last_error` that identifies this class. */
  needle: string;
  /** What an operator has to do about it. */
  remedy: string;
}

export const AC_SKIP_KINDS: readonly AcSkipKind[] = [
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
    kind: 'desc2-too-long',
    needle: 'refused, nothing sent (Desc2TooLongError)',
    remedy:
      "a line's Further Description is over AutoCount's nvarchar(100) — shorten the special order or "
      + 'the colour text on that line, then save again',
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
] as const;

/** The key given to a skip whose wording this module does not recognise. */
export const AC_SKIP_UNRECOGNISED = 'unrecognised';

/**
 * Is this skip's reason the annotation the re-queue tool leaves behind?
 *
 * Deliberately a prefix test and not a `includes`: the annotation is prepended
 * and the ORIGINAL reason is kept whole behind it, so a row whose own message
 * happened to quote the marker mid-string is still an open refusal.
 */
export function isRequeuedNote(lastError: string | null | undefined): boolean {
  return (lastError ?? '').startsWith(REQUEUE_NOTE_PREFIX);
}

/**
 * The state to SHOW for a row, which is its status except that a re-queued skip
 * is its own thing.
 *
 * An unknown status is returned untouched rather than coerced to one of the
 * five. 0277's CHECK makes that unreachable today; if a ninth status is ever
 * added, a reader that says the honest word is better than one that silently
 * files it under `failed`.
 */
export function acOutboxState(
  status: string,
  lastError: string | null | undefined,
): AcOutboxState | string {
  /* A re-queued row is history whether it was SKIPPED or FAILED.
     This read `status === 'skipped'` until 2026-08-15, and it was right when it
     was written: the re-queue tool only ever selected skips. #2189 gave it an
     explicit includeFailed opt-in, and the first use of that opt-in put the
     marker on two FAILED rows — whose documents then went through. The page
     kept counting them, so it told the owner "2 documents need attention — in
     the ERP and not in AutoCount" on the same screen that showed both of them
     IN AutoCount. Caught by opening the page against production; the stubbed
     harness it was built on had no re-queued failed row to show. */
  if (isRequeuedNote(lastError) && (status === 'skipped' || status === 'failed')) return 'requeued';
  return status;
}

/**
 * Which refusal class a skip belongs to, and the remedy for it.
 *
 * An unmatched reason is `AC_SKIP_UNRECOGNISED` with a null remedy rather than
 * being rolled into a nearest neighbour: a reason this module does not know is
 * a code path that grew a new refusal, and putting it in an existing bucket is
 * exactly how it stays invisible.
 */
export function classifyAcSkip(
  lastError: string | null | undefined,
): { kind: string; remedy: string | null } {
  const text = lastError ?? '';
  for (const k of AC_SKIP_KINDS) {
    if (text.includes(k.needle)) return { kind: k.kind, remedy: k.remedy };
  }
  return { kind: AC_SKIP_UNRECOGNISED, remedy: null };
}

/**
 * Does this row need somebody to do something?
 *
 * The owner's whole question. An OUTSTANDING `failed` does — the document is in
 * the ERP and not in the book. An OUTSTANDING `skipped` does — its remedy is
 * named. A re-queued row of EITHER kind does not: it was asked again, and its
 * document is queued or sent under a newer row. `pending` and `sent` do not.
 */
export function acNeedsAttention(
  status: string,
  lastError: string | null | undefined,
): boolean {
  const state = acOutboxState(status, lastError);
  return state === 'failed' || state === 'skipped';
}
