## The colour checker compared three different vocabularies, so every one of its 12 disagreements was its own comparison [medium]

**Symptom.** `probe-link-identity.mjs` reported, run **34139187692** (2026-09-07
23:37 local): *"12 rows across 7 documents carry a colour that disagrees with the
line they were copied from, and NOT ONE document is a perfect permutation."* That
number went into `docs/bugs/0672` as an open finding and was handed on as work.

**Root cause (traced).** The comparison was
`upper(btrim(coalesce(variants->>'colourId', variants->>'colourLabel', variants->>'colourCode', '')))`
on both sides — a `COALESCE` across THREE DIFFERENT VOCABULARIES.
`backend/scripts/import-ac-outstanding-so.mjs` writes `colourId` AND
`colourLabel` together at `:304` and writes `colourLabel` **alone** at `:317`, so
a row from the second path compared against a row from the first compares a
fabric-library ID against a human label and disagrees **by construction**.

It is the same mistake the section had already been corrected for once. The
FIRST version of it read `colourCode`, which nothing writes, and returned 0
comparable pairs on every edge — an EMPTY answer that prints identically to a
clean one (`docs/bugs/0674`). The fix added the other two field names to the
COALESCE and stopped there, which turned a false NEGATIVE into a false POSITIVE
without ever asking whether the two sides were speaking the same language.

**What the 12 actually were — PROVEN, `probe-invoice-link-facts.mjs`, run
34143079454, 2026-09-08 00:26 local, which printed all three fields on both
sides for all of them (14 by then; the population had moved with other agents'
repairs). NOT ONE is two different fabrics:**

| shape | rows | example |
|---|---|---|
| both sides carry a colourId, one of them SUPERSEDED | 8 | `CH141-8` vs `CH141-08`; `BO315-5-FOSSIL` vs `BO315-05`; `KS-01 BABY WHITE` vs `KS-01` |
| a colourId on one side, free TEXT on the other | 6 | `MODENZA 05- DARK OLIVE` vs id `MODENZA-05`; `J9883-1-1 PAMA` vs id `J9883-1-01`; `grafield1-softlinen` vs id `GARFIELD-01` |

The supersession is not inferred: the fabric library renumbered itself on
2026-08-11 and left the dead rows in place with the pointer written into their
own label — `CH141-8 [superseded by CH141-08 on 2026-08-11]`. Following it
resolves all 8 to one live colour.

**Fix.** `backend/scripts/lib/colour-identity.mjs` — `supersededBy`,
`liveColourId`, `canonicalColour`, `compareColour` — with
`backend/tests/colourIdentity.test.mjs` (14 assertions, every case a real pair
from that run). Wired into `probe-invoice-link-facts.mjs`;
`probe-link-identity.mjs` now compares only where BOTH sides carry the SAME
field and counts the field-mixed pairs separately as what they are.

**The verdict has THREE values, and that is the substance of the fix.** `same`
and `different` cannot express the last case honestly. `grafield1-softlinen` is
almost certainly `GARFIELD-01 SOFT LINEN` with two letters transposed, and
`J9883-1-1 PAMA` is almost certainly `J9883-1-01` with a zero dropped — but a
string rule cannot PROVE either, and answering `different` sends somebody to
edit a row that is probably right. So a comparison across two vocabularies can
be resolved UP to `same` and never DOWN to `different`; anything else is
`unproven`. On the 14: **10 PROVEN `same`, 4 `unproven`, 0 `different`.** The
4 unproven are free-text `colourLabel` with no `colourId` at all, which is the
already-owner-deferred fabric-matcher gap of `docs/bugs/0669`, not this.

**NO DATA WAS CHANGED.** The finding was the checker's, so the checker was
fixed. Editing the rows to satisfy a broken comparison is the shape CLAUDE.md
forbids.

**A second checker, mine, made the same class of mistake in the same session.**
`decomposeGroup` (`backend/scripts/lib/sofa-compartment-suffixes.mjs`) asked
whether a shared AutoCount `DtlKey` is one sofa decomposed into compartments,
and refused a group in which a compartment REPEATED. Run 34143079454 flagged 10
of 296 sales-order groups and 4 of 98 purchase-order groups as candidate
collisions, and every single one failed on that rule alone —
`9058-1NA, 9058-1NA, 9058-CNR`, `8030-1A(RHF), 8030-1A(RHF)`,
`R819-1S(R), R819-1S(R)`. A four-seater is `1A(LHF) + 1NA + 1NA + 1A(RHF)`; two
identical recliners is a book line of quantity two. The rule is corrected to
report repeats rather than refuse them, and the test asserting the old behaviour
was REWRITTEN to assert the reversal rather than deleted, so it cannot silently
come back.

**With that corrected, the DtlKey question 0672 left UNKNOWN is settled:**
**296 of 296** sales-order and **98 of 98** purchase-order shared DtlKeys are ONE
model decomposed into compartments; **0** name two different models and **0**
span two companies. So a DtlKey group is never two unrelated products, and the
repair-keyed-on-DtlKey risk that nearly wrote RM 2,216,501 of invented revenue is
not this.

**Ref.** fix/invoice-link-identity, 2026-09-08.
