## Amendments approved before the Description 2 rebuild shipped still print the old spec [high]

**Symptom.** On HC-SO-012312 a rep asked for the drawer off bedframes 2 and 3.
Her amendment was raised and approved, and the two HILTON lines' stored specials
lost "Right Drawer" — while the sentence printed under the item on the Sales
Order PDF went on saying `SPECIAL: HB Fully Cover + Divan Full Cover + Right
Drawer`. One row, two answers: whoever makes the item reads one of them, and
nothing on screen says which.

**Root cause (traced).** `applySoAmendment`
(`backend/src/scm/lib/so-revision.ts`) rewrites the line's `variants` on an
approved SPEC. Rebuilding `description2` from those new variants was added by
#3551 and reached production when that deploy's backend job completed —
run 34467359474, `2026-09-10T10:50:39Z` (`gh api .../actions/runs/34467359474/jobs`,
run conclusion `success`, `backend` job `success`, per the pair rule in
CLAUDE.md). The amendment on this order was approved at **07:44:27Z**, about
three hours earlier, so it ran code in which no branch touched `description2` at
all. Nothing was wrong with the amendment and nothing is wrong with the fix; the
order simply sits on the wrong side of a deploy.

Proved rather than reasoned: the widened history probe (`docs/bugs/0788-*`)
prints the approval's own `line_HILTON (A)-(Q)_spec` change as
`... + Right Drawer -> ...` without it, so the spec DID move at 07:44; the line
pricing probe read at 12:20Z shows `description2` still carrying the drawer and
byte-identical to the value a direct edit wrote at 06:17. `git log -L 737,737`
on `so-revision.ts` dates the rebuild line to `cb086ee8`, 10:36Z.

**Fix.** Nothing to change in the code — #3551 is the fix and it is live. What
did not exist was any way to say WHICH orders are on the wrong side of it, and
answering that by eye is how a two-line finding becomes an unknown-size one.
`backend/scripts/check-stale-line-desc2.mjs` +
`.github/workflows/stale-line-desc2-check.yml` is a read-only census: for every
`AMENDMENT_SO_APPROVED` audit row it reads the `line_<code>_spec` change the
server itself recorded — which is the SAME `buildVariantSummary` call that
produces `description2` — and compares it against what the line prints today.

It decides REBUILT / STALE / **UNCLEAR**, and the third is reported as its own
outcome rather than folded into either neighbour. It also counts approvals AFTER
the cutoff separately: a STALE there would mean the rebuild is not working and
would refute the premise the census was written on, which is worth more than the
count. A probe that can only confirm is not evidence.

It does not repair anything. Repair means raising and approving one more spec
amendment per order — a business act with a price authority attached, and no
script here may forge it.

**Ref.** diag/stale-desc2-census, 2026-09-10. Follows #3551 (`cb086ee8`).
