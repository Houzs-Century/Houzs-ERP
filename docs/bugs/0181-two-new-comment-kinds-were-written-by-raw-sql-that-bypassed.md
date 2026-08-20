## Two new comment kinds were written by raw SQL that bypassed the only typed entry point, and `main` stopped deploying [high]

**Symptom.** `main` red on `frontend` — a REQUIRED status check — and the Deploy
run reporting `frontend: failure` with `backend: skipped`, which CLAUDE.md says
to treat as a failed deploy. Nothing reached production from #2184 merging until
this fix. Two Deploy runs failed the same way (the second for an innocent PR that
merely inherited the tree). Eight errors, all one shape:

```
src/pages/Projects.tsx(8955,53): error TS2367: This comparison appears to be
unintentional because the types '"note" | "approve" | "reject" | "amend"'
and '"upload"' have no overlap.
```

**Root cause.** PR #2184 added two per-task history kinds, `upload` and `remove`,
and wrote them from `backend/src/routes/projects.ts` as raw SQL —
`INSERT INTO project_checklist_comments (item_id, kind, body, user_id) VALUES (?, 'upload', ?, ?)`.
That statement never passes through `addChecklistComment`, which is the ONE typed
entry point for that column, so the backend compiled while emitting two values no
type in the repo admitted. Neither union was widened:
`backend/src/services/projects.ts` (the helper's parameter) nor
`frontend/src/pages/Projects.tsx` (`interface ChecklistComment`).

The frontend half of the same PR then filtered those kinds OUT of the Remarks
column — correct, and at the owner's instruction — and `tsc -b` read those filters
as comparisons that can never be true.

**The shape worth remembering.** The type is declared in two files and written
from a third that consults neither. Nothing connected them, so the drift was
invisible until an UNRELATED expression happened to compare against a missing
value. Had the PR not also added that filter, the two kinds would be undeclared
today and no gate would have said a word — the build error was luck, not a check.

**Fix, in two parts by two people.** The FRONTEND union was widened directly on
`main` while this branch was in flight — that is what un-blocked the deploy, and
this entry does not claim it. What landed here is the half that was still
missing: the BACKEND union on `addChecklistComment`, which was still
`"note" | "submit" | "reject" | "amend" | "approve"` after the outage was over,
and `backend/tests/checklistCommentKinds.test.ts`, which extracts every kind
literal written into that table and asserts both declarations admit all of them
AND agree with each other. Proven red by reverting the frontend union — exit 1,
naming both `remove` and `upload`.

That split is worth recording rather than tidying away: the visible symptom was
fixed in one file, and the other declaration — plus the thing that stops it
recurring — was still open afterwards. Un-blocking the build and fixing the
defect were not the same job.

The guard is ANCHORED on the declaring construct (`interface ChecklistComment`,
`export async function addChecklistComment(`), not on the first `kind:` union in
the file. Its first draft was not, and read `kind: "income" | "cost"` 56 lines
earlier in the same file — it refused with "only 2 kinds parsed" rather than
reporting a pass, which is the property CLAUDE.md demands of a checker that
cannot match, but the anchor is what makes it correct.

**Ref.** 2026-08-14, PR #2184 introduced it. Deploy runs 31802261895 and the one
before it, both `frontend: failure` / `backend: skipped`. Lesson: **a typed helper
is not a boundary if another file can write the same column directly** — and
CLAUDE.md's own rule, "a BUG-HISTORY entry with no test attached is unfixed", is
why this one ships with a guard rather than a paragraph.
