## The line-pricing probe read fewer specials keys than the document renderer [medium]

**Symptom.** Investigating HC-SO-012312 on 2026-09-10 (owner, relaying Cheah
Huan: 「第二三不需要 drawer，结果还是有」), the probe reported that the two HILTON
bedframes no longer carried "Right Drawer" while their stored Description 2 —
the line the Sales Order PDF prints — still said they did. That was written up
as "the structured specials are clean, the printed text is stale", and the next
step proposed to the owner was built on it.

**Root cause (traced).** `specialsOf()` in `backend/scripts/check-so-line-pricing.mjs`
read three keys — `specials`, `customSpecials`, `specialsRecorded`. The renderer
that produces Description 2, `buildVariantSummary` in
`backend/src/scm/shared/variant-summary.ts`, reads
`variants.specials ?? variants.special` plus `variants.specialsRecorded`. The
SINGULAR `special` was in the renderer and in no version of the probe, so a line
storing its add-ons under that key reads as EMPTY here and as carrying the add-on
on every printed copy. The probe was not measuring the thing it was being quoted
about, and it reported a clean run it had not earned — CLAUDE.md's "a checker
that cannot match reports a clean run", with the twist that this one pointed a
live investigation at the wrong half of a contradiction.

The list is copied rather than imported because the renderer is TypeScript under
`src/` and the probe is a dependency-free `.mjs` that runs before any build.
That copy is the drift surface, and it is now named as such in the code.

**Fix.** `SPECIAL_KEYS` now carries every key the renderer reads, plus
`specialChoices`, and each value printed is TAGGED with the key it came from, so
two keys disagreeing reads as a disagreement rather than a longer list. The probe
takes the UNION where the renderer takes an alternative (`specials ?? special`) —
"which key is this line actually using" is the question being asked, so the probe
must not pick one. Because a list can only find what it knows to look for, each
line also prints the full key inventory of its `variants` (names only — the
values are money, addresses and remarks, and this prints into a CI log).

No unit test: the script is a `workflow_dispatch` probe with no importable pure
part, and the assertion that matters is against production rows. It is proved by
DISPATCH instead — run pasted in the PR body.

**Ref.** diag/so-line-specials-keys, 2026-09-10.
