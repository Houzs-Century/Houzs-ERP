## The file-size ratchet charged every open PR for one file it had never opened [high]

**Symptom** — on 2026-08-14 every open pull request failed `file-size`, all of
them naming the same file: `backend/src/scm/routes/grns.ts`, 3,591 lines against
a ceiling of 3,482. None of them had opened it. One of the blocked PRs was the
fix for a **live production defect** in the sales-order proceed path.

**Root cause** — two facts that are each fine alone:

1. `file-size` is NOT one of the ruleset's required checks (those are
   `backend-typecheck` and `frontend`), so a pull request CAN merge with it red,
   and one did — main outgrew its own manifest.
2. The gate charged whichever branch ran next for every violation in the tree,
   not for the files that branch had touched.

Together they turn one merged violation into a repository-wide stop: nobody can
merge until someone else shrinks a file they are not working on. The ratchet was
built to stop growth; it stopped shipping.

**Fix** — the gate now resolves the merge base, diffs it, and FAILS only on
files present in that diff. A violation in an untouched file is still printed in
full with its numbers, under a heading that says whose problem it is — silence
would let the tree drift, which is the thing this gate exists to prevent. If the
merge base cannot be resolved, every violation is charged again: a gate that
cannot tell whose fault it is must not let anything through.

**The check** — `scripts/check-file-size-ratchet.mjs` gains a case that pins the
split: one violation in a touched file fails, one in an untouched file is
reported with its 109 lines intact.

**Class** — *a gate whose blast radius is wider than its subject*. Same shape as
the fabric census that counted the tombstone a merge leaves on purpose, so
`require_clean` could never pass. Both fail on something nobody in the loop can
act on.

**Ref** - `fix/file-size-blames-the-toucher`, 2026-08-14
