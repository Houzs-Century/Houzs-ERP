## The file-size gate reported OK on a tree it could not see [medium]

**Symptom.** `node scripts/check-file-size.mjs --require-base` printed the
ratchet summary and exited 0 while the working tree held changes that put a file
over its ceiling. Committing the same changes and re-running turned it red. The
gate had answered a question about a DIFFERENT tree and said nothing about it.

**Root cause.** The "which files did this change touch" half is computed from
git — `merge-base` plus a diff — so it sees only what is COMMITTED. The "how many
lines" half is read from the working tree. With uncommitted work those two halves
describe different trees: the line counts were current, the touched-file set was
not, so a file this change had grown was classified as INHERITED debt and
reported rather than charged. Exit 0.

This is the same shape as the three checkers CLAUDE.md already records — a
verdict computed over the wrong corpus reads exactly like a clean run. The
difference here is that nothing was broken: both halves worked, and the gate was
still wrong, because they were asked about different things.

**Fix.** The gate REFUSES rather than answers: `uncommittedSourcePaths` parses
`git status --porcelain -z`, and when the touched-file set is in play and any
source file is dirty, it prints what it cannot see and exits 2. Not a warning —
CLAUDE.md's rule is that a check which cannot execute must never report a pass,
and a warning on a green run is a pass. Parsing lives in
`scripts/lib/file-size-ratchet.mjs` so it is unit-tested without a repo: staged
files, renames (`R old -> new`), and paths with spaces each have a case.

**Ref.** 2026-08-14, PR #2179. Lesson: **a gate that reads two halves from two
different places has a third state — not pass, not fail, but "asked about
something else"** — and that state is invisible unless the gate is built to
notice it.
