## The before/after guard refused a correct restore, because `git checkout` writes the index too [medium]

**Symptom.** The first real dispatch of
`.github/workflows/sofa-reader-before-after.yml` —
[run 34312272059](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34312272059)
— died on its third step, `Put the MERGE BASE's reader back, and prove it
actually changed`, after the AFTER pass had already spent a full production
read. The BEFORE pass and the comparison never ran.

The step's own refusal text is what printed:

> restoring the merge base's reader changed nothing, so both passes would
> measure the SAME code and the comparison would report a difference of zero
> that means nothing.

**That statement was false.** The restore had worked. `76d9c6353`'s
`parse-sofa.mjs` contains no `COLOUR_LABEL` and the merged one contains nine
mentions of it, so the two files are plainly different.

**Root cause (traced, and reproduced in a scratch repo).**

```sh
git checkout "$BASE" -- reader.mjs      # writes the WORKING TREE *and the INDEX*
git diff --quiet -- reader.mjs          # compares working tree against the INDEX
```

`git checkout <commit> -- <path>` stages what it restores. A bare `git diff`
then compares the restored file against a copy of itself and answers "identical"
— on the one outcome the guard exists to bless. Measured both directions in a
throwaway repo before the fix was written:

```
restore a genuinely different file:  git diff -> NO CHANGE   git diff HEAD -> CHANGED
restore HEAD onto HEAD:              git diff HEAD -> NO CHANGE   (guard still refuses)
```

**Fix.** `git diff --quiet HEAD -- …`. The guard keeps its whole point — a
restore that changes nothing still refuses, so a comparison can never report a
difference of zero and be read as a pass — and it stops firing on the case it
was written to permit.

**The lesson is the one this repo keeps paying for**, and it is why this entry
exists rather than a one-word diff: **the check that answers a different
question.** `git diff` is not wrong; it answers "working tree vs index", and the
question here is "working tree vs HEAD". Ask what a successful result would ALSO
be true of. A guard cannot be trusted until it has been run in BOTH directions,
and a `workflow_dispatch` workflow is not shipped until it has been dispatched
once and reported success (CLAUDE.md) — this one was dispatched, failed, and is
fixed here rather than left as a green-looking file nobody has executed.

**Ref.** fix/sofa-reader-beforeafter-guard, 2026-09-09. Introduced by
`docs/bugs/0745`.
