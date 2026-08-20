## The array repair refused the only shape production actually had [medium]

**Symptom** — the plan run over the seven array-shaped `variants` blocks
recovered none of them. Every row was refused by `unwrap()`, which accepted only
a ONE-element array (`${arr.length} elements — only a one-element wrap is
recoverable`).

**Root cause (traced, not guessed)** — the recovery rule was written against a
hypothesis about the damage instead of a reading of it, and the hypothesis was
one element short. The real shape, from the plan run, is two elements: element 0
is the COMPLETE variants object, element 1 is the fragment that was being merged
in when the bad bind turned `variants || <string>` into an array rather than a
merge.

**Fix** — `asObject()` is factored out so an element is accepted whether it
arrived as an object or as a JSON string. A multi-element array is recovered from
element 0 **only when every key of every later element exists in element 0 with
an equal value**, compared by `JSON.stringify`; a tail that contradicts element 0
or adds a key it lacks is refused, and the difference is named per key rather
than reported as "not recoverable". The empty array gets its own message. The
reason the proof is there rather than a plain "take the first element": that,
applied blindly, is how a merge silently drops a seat height.

**What landed, against what the PR says** — the PR's results table lists three
verified cases (real prod shape recovers; a disagreeing tail `seatHeight` is
refused; a tail carrying a `legHeight` element 0 lacks is refused). Those were
run by hand. The merged diff is **one file, 45 additions and 10 deletions,
`backend/scripts/repair-array-shaped-variants.mjs`** — no test file. `unwrap()`
is a pure function with an exactly-testable contract and nothing in the tree
fails if it regresses.

**The class, for next time** — "take the first element" is a guess about which
side of a merge won, and the remedy here generalises: prove the discarded side is
redundant key by key, and name the disagreement instead of returning a verdict.
The same rule the sofa-PO entry at the top of this file states — *"the rows are
indistinguishable" is a claim about ONE side of a match* — arrived at
independently, two days later, in a different subsystem.

**Ref** — 2026-08-13, PR #2100 (`fix/array-repair-redundant-tail`). Entry written
2026-08-14 from the merged diff. No module guide covers `backend/scripts/`.

---
