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
import type { ReactNode } from 'react';
import type { SaveProblem } from './authed-fetch';
import { SaveProblemsList } from '../components/SaveProblemsList';

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

/** The code a problem carries when the document DID reach the accounts and a
 *  field on it did not. Mirrors `AC_SENT_INCOMPLETE` in
 *  backend/src/scm/lib/ac-preflight.ts; the referee test across the two
 *  packages pins the pair. */
export const AC_SENT_INCOMPLETE_CODE = 'ac_sent_incomplete';

/**
 * The title for the OTHER verdict: it is in the accounts, and part of it is not.
 *
 * A SEPARATE SENTENCE BECAUSE THE OTHER ONE WOULD BE FALSE. A transferred
 * delivery order that reached the book without its reference is not a document
 * "the accounts have not got" — telling an operator that sends them to re-raise
 * a receipt the book already holds, which is worse than the silence this whole
 * module exists to end.
 */
export function acSentIncompleteTitle(docLabel: string): string {
  return `${docLabel} saved and sent — but not every field on it reached the accounts`;
}

/**
 * Which of the two frames these problems belong in.
 *
 * ALL-OR-NOTHING, and it has to be: a response that somehow carried both
 * verdicts is a response about two different facts, and the safer of the two
 * headlines is "the accounts have not got it" — an operator who checks a
 * document that is actually there loses a minute, one who does not check a
 * document that is missing loses it from the books.
 */
export function acTitleFor(problems: SaveProblem[], docLabel: string): string {
  const allIncomplete = problems.length > 0
    && problems.every((p) => (p as { code?: string }).code === AC_SENT_INCOMPLETE_CODE);
  return allIncomplete ? acSentIncompleteTitle(docLabel) : acNotSentTitle(docLabel);
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

/**
 * Show it, once, the same way everywhere.
 *
 * THE WHOLE BEHAVIOUR LIVES HERE, not just the words. Four surfaces raise these
 * documents and every one of them would otherwise decide for itself whether to
 * show a dialog, which list component to use, which tone, and — the one that
 * matters — whether to show anything at all on an empty list. do-next-step.ts
 * records what that costs: a rule re-derived per surface reaches some of them
 * and drifts on the rest, with nothing erroring when it does.
 *
 * AWAITED, and the caller must await it too. Every call site navigates away
 * immediately afterwards; a fire-and-forget dialog is torn down by the route
 * change and the operator sees a flicker instead of a reason.
 *
 * SILENT ON THE ORDINARY SAVE. Returns without touching the UI when the
 * response carries nothing — the success path must stay a success path.
 */
export async function notifyAcNotSent(
  notify: (opts: { title: string; body?: ReactNode; tone?: 'info' | 'error' }) => Promise<void>,
  res: unknown,
  docLabel: string,
): Promise<void> {
  const problems = acNotSentProblemsOf(res);
  if (problems.length === 0) return;
  await notify({
    title: acTitleFor(problems, docLabel),
    body: <SaveProblemsList problems={problems} />,
    tone: AC_NOT_SENT_TONE,
  });
}
