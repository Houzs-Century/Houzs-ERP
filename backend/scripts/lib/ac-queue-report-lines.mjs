/* ---------------------------------------------------------------------------
   The two sentences the AutoCount queue report kept getting wrong.

   Both were caught by the owner reading the report rather than by any check,
   and both are the same species: a line that asserts ONE shape for a set that
   holds several.

     「为什么会有矛盾的点呢」 — 2026-09-03

   They live here, apart from the script, so a test can hold them to what they
   claim. Inline in a 700-line reporter they were unreachable, and the last time
   this exact class was fixed the fix reached one report and missed the other.
   -------------------------------------------------------------------------- */

/**
 * THE TOTALS LINE.
 *
 * It used to end `(3 of those have been re-queued)` appended to
 * `skipped 3 / failed 1` — so the same rows were counted as outstanding and
 * described as history inside one sentence, and a reader could not tell how
 * many things were actually waiting. Now the clause says WHERE those rows sit
 * and what they are.
 */
export function acQueueTotalsLine(total, by, requeuedCount) {
  const counts = ['pending', 'sent', 'failed', 'skipped']
    .map((s) => `${s} ${by[s] ?? 0}`)
    .join(' / ');
  if (!requeuedCount) return `queue: ${total} row(s) — ${counts}`;
  return `queue: ${total} row(s) — ${counts}`
    + ` — ${requeuedCount} of the failed/skipped above are RE-QUEUED HISTORY:`
    + ' already asked again, waiting on nobody.';
}

/**
 * THE FAILED HEADING.
 *
 * It used to read "each is a document that is in the ERP and NOT in AutoCount",
 * which is true of a failed CREATE and false of everything else. On 2026-09-03
 * it was printed over a failed EDIT of SO-013361 — a document the owner had
 * open in AutoCount at the time.
 *
 * The honest heading names the operation's own meaning, and the per-row lines
 * below it carry the reason.
 */
export function acFailedHeadingLine(rows) {
  const ops = new Set(rows.map((r) => String(r.op ?? '')));
  const creates = [...ops].some((o) => o.startsWith('create'));
  const others = [...ops].some((o) => o && !o.startsWith('create'));
  const what = creates && others
    ? 'a failed CREATE means the document is NOT in AutoCount; a failed EDIT or'
      + ' CONVERT means it IS there and the change did not land'
    : creates
      ? 'the document is NOT in AutoCount — its create was refused'
      : 'the document IS in AutoCount and the change did not land';
  return `FAILED: ${rows.length} — the ERP could not complete the operation`
    + ` against the account book. Here, ${what}.`;
}
