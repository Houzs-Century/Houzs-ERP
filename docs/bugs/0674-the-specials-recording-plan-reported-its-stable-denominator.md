## The specials recording plan reported its stable denominator as remaining work [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** After the 2026-09-04 apply that recorded 338 held-back special
orders, a PLAN re-run of the same job still answered with a line count of the
same size. Read as backlog, it says the owner's ruling never landed. It is the
second time this population has been quoted back as outstanding work: the
variant reconcile did the same thing from a different direction, and that one
put 139 already-decided lines into a go-live backlog number
(`docs/bugs/0668-the-variant-reconcile-counted-the-owner-s-already-applied-sp.md`).

**Root cause (traced).** `backend/scripts/record-priced-specials-on-migrated-lines.mjs`.
The selection is `cls.addedNow` — codes the AutoCount slip asks for that the line
does not carry in `variants.specials` (the `classifyLine` call, and the
`if (!cls.phrases.length || !cls.addedNow.length) continue` guard under it). The
apply writes `variants.specialsRecorded` and, by design, never writes
`variants.specials` — that is the whole point of the separate key, since ten call
sites fold `variants.specials` into a price. So the input to the selection is
untouched by a successful run and the count is a CONSTANT, not a remaining
balance.

The script already read the applied decision — `declared` is built from
`v0.specialsRecorded` and unioned into `recordedOnly` — so it held both halves of
the answer and reported neither. The workflow header stated the consequence in
prose ("a PLAN re-run after a successful APPLY still reports the SAME line
count ... that is the design, not a failure"), which is the shape this repo has
been bitten by before: a rule in a comment does not run, and the reader who
skips the comment gets a number that means the opposite of what it says.

**Fix.** The plan and apply report now split the selection into lines this run
adds a code to versus lines an earlier apply already covers, and says so
explicitly when nothing is left. The denominator is unchanged and still printed;
what is new is the part that actually moves. No selection, write, money proof or
read-back behaviour changed — the split is computed from `declared`, which the
script was already deriving.

Not a code-gate class: nothing here was type-unsafe or untested, and the money
property is pinned by `backend/tests/specialsRecordedNeverPriced.test.ts`, which
still passes untouched. The wrong artifact was the REPORT, the same way the
`?mode=all` incident's wrong artifact was the claim.

**Ref.** fix/specials-record-358, 2026-09-07.
