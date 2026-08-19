// ----------------------------------------------------------------------------
// ac-not-sent — "it saved, but the accounts have not got it", read off a save
// response, in ONE place.
//
// THE SHAPE THIS CLOSES. Until 2026-08-19 a document the AutoCount write-back
// refused was indistinguishable, from the operator's seat, from one it accepted:
// the create returned 201, the refusal went into `scm.autocount_outbox` as a
// `skipped` row, and that queue sits behind its own permission key
// (`scm.autocount.read`) which no salesperson or buyer holds. So the person who
// raised the document believed it was in the accounts and nothing ever told them
// otherwise. The backend now returns the refusal on the response that reports
// the save; this reads it.
//
// WHY A MODULE AND NOT THREE `res.acNotSent` READS. Four surfaces raise these
// documents (desktop SO, mobile SO, desktop PO, PO-from-SO) and do-next-step.ts
// records what happens when each answers the same question by hand — the date
// format rule reached 14 of 189 inputs that way. The one thing that must not be
// re-derived is what counts as "the accounts did not get it", and the one thing
// that must not be re-worded is the title above the list.
//
// THE SENTENCES ARE NOT HERE, DELIBERATELY. Every problem's `message` is written
// by backend/src/scm/lib/ac-preflight.ts and travels verbatim, because the thing
// that decides a document is unsendable is the composer and the wording has to
// follow the reason. This module contributes only the frame around them, so
// there is no second vocabulary to drift.
// ----------------------------------------------------------------------------
import type { SaveProblem } from './authed-fetch';

/** The key the backend attaches to a create response. Never present when the
 *  document composed cleanly — a warning nobody needed is how an operator
 *  learns to stop reading them, so absence is the normal case. */
export const AC_NOT_SENT_KEY = 'acNotSent';

/**
 * The reasons this response says the accounts will not take the document.
 *
 * Empty for every ordinary save. Tolerant of a response that has never heard of
 * the key (an older worker, a surface that reads a cached body), because the
 * absence of a warning must read as "nothing to say" and never as a crash on
 * the success path.
 */
export function acNotSentProblemsOf(res: unknown): SaveProblem[] {
  const raw = (res as Record<string, unknown> | null | undefined)?.[AC_NOT_SENT_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is SaveProblem => !!p && typeof (p as SaveProblem).message === 'string',
  );
}

/**
 * The title above the list.
 *
 * SAYS WHAT IS TRUE OF BOTH HALVES, because half of it is good news and half is
 * not: the document exists and the work can go on, AND the accounts do not have
 * it yet. A title that said only "failed" would send someone to re-enter a
 * document that is already there; one that said only "saved" is the silence
 * this whole change is about.
 */
export function acNotSentTitle(docLabel: string): string {
  return `${docLabel} saved — but the accounts have not got it yet`;
}

/**
 * The tone these are shown in, and it is NOT 'error'.
 *
 * NotifyDialog has two (`'info' | 'error'`, NotifyDialog.tsx:56) and 'error'
 * tints the title red. The save SUCCEEDED — the document exists, the line is
 * reserved, the work can go on — and painting a completed action red teaches
 * people to re-enter documents that are already there. The title carries the
 * weight instead. If this ever needs a third tone it is a change to
 * NotifyDialog, made once, not a colour picked per surface.
 */
export const AC_NOT_SENT_TONE = 'info' as const;
