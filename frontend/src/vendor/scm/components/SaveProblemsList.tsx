// ----------------------------------------------------------------------------
// SaveProblemsList — renders the backend's aggregated save-gate failures
// (validation_failed → problems[]) as a list inside a NotifyDialog popup, one
// row per problem, each naming its concrete line + field.
//
// Owner 2026-07-18: setting a Processing Date / saving a confirmed SO used to
// fail ONE gate at a time (fix, save, hit the next). The backend now reports
// every reason at once; this is the ONE renderer both desktop (SalesOrderDetail)
// and mobile (MobileNewSO) hand to `notify({ body: <SaveProblemsList …> })`, so
// the two surfaces list them identically.
//
// Left-aligned because NotifyDialog centres its body text by default and a
// bulleted list must read as a list.
// ----------------------------------------------------------------------------
import type { ReactNode } from 'react';
import { parseSaveProblems, type SaveProblem } from '../lib/authed-fetch';

export function SaveProblemsList({ problems }: { problems: SaveProblem[] }) {
  return (
    <ul style={{ textAlign: 'left', margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.5 }}>
      {problems.map((p, i) => (
        <li key={`${p.code}-${p.line ?? ''}-${p.field ?? ''}-${i}`}>{p.message}</li>
      ))}
    </ul>
  );
}

/** The popup title for an aggregated save failure — singular / plural by count. */
export function saveProblemsTitle(count: number): string {
  return count === 1
    ? 'This needs fixing before saving'
    : `${count} things need fixing before saving`;
}

/**
 * The aggregated save-gate failure, decided in ONE place.
 *
 * WHY IT MOVED HERE (2026-08-19). Three surfaces — the desktop New SO, the SO
 * Detail save and the mobile wizard — each wrote out the same decision by hand:
 * parse the body, and if it carries a `validation_failed` problem list, show
 * EVERY reason in this popup rather than one at a time (owner 2026-07-18).
 * Eight lines is exactly the size at which a copy looks too small to be worth
 * sharing and drifts anyway, and this is the renderer for every confirm-gate
 * refusal — including the salesperson rule just narrowed in
 * `backend/src/scm/lib/ac-preflight.ts`, so it is about to be reached more
 * often than it has been.
 *
 * WHAT IS SHARED AND WHAT IS NOT, stated precisely because the three were NOT
 * identical and pretending otherwise would have changed two of them:
 *   · SHARED — "is this an aggregated gate failure, and if so, this popup".
 *   · NOT SHARED — what happens when it is NOT one. The desktop New SO opens a
 *     second popup, SO Detail sets its inline banner, and the mobile wizard sets
 *     its inline error line with its own wording. Each is right for its surface,
 *     so each still passes its own `onOther`. Collapsing those would have taken
 *     the banner off the Detail page.
 *
 * Behaviour is unchanged at all three call sites.
 */
export async function notifySaveProblems(
  notify: (opts: { title: string; body?: ReactNode; tone?: 'info' | 'error' }) => Promise<void>,
  err: unknown,
  /** What to do when the failure is NOT an aggregated gate refusal. */
  onOther: (message: string) => void,
  /** The sentence for a failure that carries no message of its own. */
  genericMessage = 'Something went wrong.',
): Promise<void> {
  const problems = parseSaveProblems((err as { body?: string } | undefined)?.body);
  if (problems && problems.length > 0) {
    await notify({
      title: saveProblemsTitle(problems.length),
      body: <SaveProblemsList problems={problems} />,
      tone: 'error',
    });
    return;
  }
  onOther(err instanceof Error ? err.message : genericMessage);
}
