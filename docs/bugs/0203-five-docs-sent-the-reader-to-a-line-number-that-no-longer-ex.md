## Five docs sent the reader to a line number that no longer exists [low]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `check-docs-drift` reported five `line-past-eof` advisories — a doc
citing `file.ts:161` where the file has 140 lines. Following one lands nowhere;
following a line number that is merely WRONG rather than past the end lands on
unrelated code and is not detected at all.

**Root cause.** A line number in prose is a fact with a very short expiry — it
rots the moment anything ABOVE it is edited, which is most edits. The worst
example here was not past EOF at all: `docs/2990-mirror-full-design.md` cited
`so-revision.ts:157-428` for `applySoAmendment`, and that function begins at line
271. The number was inside the file, so nothing flagged it, and it pointed at
something else entirely.

**Fix, and it is a convention rather than five edits.** Cite the SYMBOL, not the
line: a function name, an exported const, a route path. Those move with the code
and survive an edit above them.

| was | now |
|---|---|
| `so-revision.ts:157-428`; `so-mirror.ts:161-169` | `so-revision.ts` -> `applySoAmendment()`; `so-mirror.ts` -> the `soMirror` router |
| `backend/src/routes/users.ts:2291` (x2) | `users.ts` -> the second `POST /:id/impersonate` registration |
| `backfill-sofa-special-orders.mjs:237` | the filename alone — the entry's point was the CONTENT it wrote |
| `schema.pg.ts:905-1307` | "the `scm_*` table block in `schema.pg.ts`" |

Each replacement was checked to RESOLVE before it was written:
`export async function applySoAmendment` and `export const soMirror` both exist,
and `users.ts` carries four `/:id/impersonate` mentions.

**Measured: 5 -> 0.**

**Not fixed here, and characterised rather than left as noise.** Six
`unknown-permission` advisories remain and all six are FALSE POSITIVES — the
checker's own message admits it ("or it is a table.column that shares a prefix
with a real key"). `projects.venue`, `projects.state`, `projects.stage`,
`projects.name` and `projects.setup_start_at` are COLUMNS, read in prose about
data: *"`projects.venue` is free[-text]"*, *"read `projects.setup_start_at`"*.
Teaching the checker to tell a table.column from an `<area>.<verb>` permission
needs the real column set, which is a separate change.

**Ref.** 2026-08-15. Lesson: **a line number is the most perishable thing you can
put in a document**, and the dangerous half of that class is invisible — a number
still inside the file points confidently at the wrong code and no checker can see
it.
