
import { acNeedsAttention } from './autocount-outbox-status';

/** The columns a verdict needs. Deliberately not the whole row. */
export interface AcArchiveRow {
  status: string;
  last_error: string | null;
  archived_at: string | null;
}

/**
 * What happened, or why nothing did.
 *
 * A STRUCTURED OUTCOME rather than an exception string, for the same reason the
 * re-queue handler beside it uses one: the owner's requirement for this page is
 * that no code jargon appears on it, so the UI branches on the code and the
 * person reads the sentence.
 */
export const AC_ARCHIVE_OUTCOMES = [
  'ok',
  'doc-not-found',
  'needs-attention',
  'still-working',
  'already-archived',
  'read-failed',
  'write-failed',
] as const;
export type AcArchiveOutcome = (typeof AC_ARCHIVE_OUTCOMES)[number];

/**
 * Each outcome as one sentence somebody can act on.
 *
 * NO COLUMN, NO TABLE, NO IDENTIFIER. The same rule the skip reasons are held
 * to and for the same reason: on 2026-08-16 the owner read an SDK method name
 * off this very page, hours after having it removed from the page's own copy,
 * because it lived in a reason string nobody was checking. A test in this
 * module's suite asserts it.
 */
export const AC_ARCHIVE_MEANING: Record<AcArchiveOutcome, string> = {
  ok: 'Cleared from the list. Everything it did is kept and can be brought back.',
  'doc-not-found':
    'There is nothing on the list for this document, so there is nothing to clear.',
  'needs-attention':
    'This document is in the ERP and not in the account book, so it still needs somebody. '
    + 'Put it right, or send it again, and it can be cleared once it has gone through.',
  'still-working':
    'This document is still on its way to AutoCount. Wait for the next send and clear it '
    + 'once it has arrived.',
  'already-archived': 'This document was already cleared from the list.',
  'read-failed': 'The list could not be read, so nothing was changed.',
  'write-failed': 'Nothing was changed — the list refused the change.',
};

/** Did the caller's request actually take effect? */
export const acArchiveAccepted = (code: AcArchiveOutcome): boolean => code === 'ok';

/** The verdict, plus the numbers the sentence on screen is allowed to quote. */
export interface AcArchiveVerdict {
  code: AcArchiveOutcome;
  rows: number;
  blocked: number;
}

/**
 * MAY THIS DOCUMENT BE RETIRED, and if not, why not.
 *
 * The rule in one line: a document may be cleared when it has nothing left to
 * do. Everything else is that sentence made checkable.
 *
 * ORDER MATTERS between the two refusals. A document that is BOTH waiting and
 * carrying a settled refusal is reported as waiting, because only one of those
 * two resolves itself — sending somebody to fix a document the next five-minute
 * drain may well clear is how a page teaches people to ignore it.
 *
 * `acNeedsAttention` is the shared judgement, not a re-implementation: a
 * re-queued failure is HISTORY (its document went through under a newer row) and
 * a rule that read `status` alone would refuse to clear all three of the
 * documents this was built for.
 */
export function acArchiveVerdict(rows: readonly AcArchiveRow[]): AcArchiveVerdict {
  if (rows.length === 0) return { code: 'doc-not-found', rows: 0, blocked: 0 };

  const waiting = rows.filter((r) => r.status === 'pending');
  if (waiting.length > 0) return { code: 'still-working', rows: 0, blocked: waiting.length };

  const open = rows.filter((r) => acNeedsAttention(r.status, r.last_error));
  if (open.length > 0) return { code: 'needs-attention', rows: 0, blocked: open.length };

  const live = rows.filter((r) => r.archived_at === null);
  if (live.length === 0) return { code: 'already-archived', rows: 0, blocked: 0 };

  return { code: 'ok', rows: live.length, blocked: 0 };
}
