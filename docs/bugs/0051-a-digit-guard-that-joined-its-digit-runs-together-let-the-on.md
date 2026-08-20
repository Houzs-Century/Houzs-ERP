## A digit guard that joined its digit runs together let the one binding it existed to refuse straight through [high]

**Symptom** - `bind-null-colour-lines.mjs` was written with an explicit digit
guard whose entire purpose was to refuse `PC151-101` -> `PC151-11`, the binding
#1964 named as the reason the 7 NULL-colour lines were not auto-filled. Its
first production DRY-RUN (**31452652036**) printed that binding under
`=== WOULD BIND ===`, with the guard reporting `digits 151101 = 15111` as
though the two agreed.

**Root cause (traced, not guessed)** - the guard collapsed every digit run into
one string before comparing, then allowed a single padding zero on the tail:

```
"PC151-101" -> 151101      "PC151-11" -> 15111
pad("15111") = "151101"    -> declared the same number
```

The padding rule is real and necessary - the library stores
`ARMANI J9226-01 SAND` while documents write `J9226-1`. But it is only sound
while the SEPARATOR still tells the series number from the colour number. Once
the runs are joined, a one-zero pad on the tail is indistinguishable from a
digit moving across the boundary. This is the identical hazard
`merge-duplicate-fabric-series.mjs` documents from the other side, and its
comment says so in as many words: after folding, "nothing downstream can then
tell which digits are which".

**Fix** - `backend/scripts/lib/colour-digit-guard.mjs`, extracted so it is one
implementation with one set of tests rather than a helper inlined in whatever
script needs it next. It compares digit RUNS with the separator intact:
`["151","101"]` against `["151","11"]`. Every run but the last must be equal;
the last may differ by one leading zero. A document that writes no number at all
is exempt, because there is no digit to move - `Cream` -> `KS-02` and the
misspelt `sliver` -> `KS-15` are hits on the colour's NAME, and the matcher
already drops any fold key two library rows share, so a name-only hit is unique
by construction.

`backend/tests/colourDigitGuard.test.ts` pins the regression plus every silent
swap the matcher's own docstring names (`B0315-27` -> `BO315-2`, `HR805-20` ->
`HR805-40`, `GD8371-03` -> `GD8371-02`, `STAR-10` -> `STAR 01`).

**Lesson** - a guard is not verified by existing. This one was written
deliberately, for one named case, and still passed that exact case; the only
reason it did not reach production is that the run was a DRY-RUN and its output
was read line by line rather than trusted for its summary. Write the guard, then
make the tool print the specific case it exists to refuse, and go look.

**Ref** - 2026-08-11, PR #1976 (fix/colour-bind-digit-runs). Prod evidence: the
DRY-RUN that caught it, run 31452652036.
