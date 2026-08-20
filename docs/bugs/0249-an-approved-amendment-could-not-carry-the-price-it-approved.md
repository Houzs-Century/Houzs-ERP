## An APPROVED amendment could not carry the price it approved [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-08-16: *"Any amount can be edited, unless it is locked.
If it has proceeded and a day has passed so it locked, then it goes through Sales
Amendment."* The amendment is the sanctioned road for money on a locked Sales
Order — and it did not carry money. An operator typed RM 50, an approver holding
`scm.amendment.approve_*` signed RM 50, and the CATALOGUE price landed on the
order instead.

**Root cause (traced, not guessed).** `so-revision.ts` derived
`amendTrust = soIsMigrated ? 'including-zero' : false` and threaded it into the
honest-pricing recompute. With `false`, `mfg-pricing-recompute.ts`'s trust
overwrite (`if (trustOperatorSelling && (manualUnitSelling > 0 || …))`) never
executed, so `unitToPersistSen` kept the authoritative catalogue figure assigned
a few lines earlier. The ADD path passed no trust argument at all, so a
brand-new line lost its price on migrated orders too. Blast radius, measured by
the tests below rather than argued: only a SOFA build, a SKU absent from the
catalogue, and a SKU whose `sell_price_sen` is 0 survived — and a QTY-ONLY
amendment re-priced as well, because the recompute is per-line and the editor
sends `newUnitPriceSen` on every SPEC/QTY line.

**Proven, not read.** `src/scm/lib/so-revision.amendmentPrice.test.ts` drives the
REAL engine through a fake PostgREST client: **6 of its 12 tests fail against
origin/main** and all 12 pass with the fix (stash the two source files and
re-run — the six are the price-carrying ones).

**Fix.** The trust is now derived from the APPROVAL, not from the payload.
`applySoAmendment` takes a **required** `approval: SoAmendmentApproval | null`
constructed only by `approveSoCommandHandler`, after `hasHouzsPerm(c,
approveKey)` and the transition check. With `approval` present a native line
persists the requested price (plain `true` — an ADD line never gets
`'including-zero'`, it is authored now); with `null` the requested
`new_unit_price_sen` is not read at all and the catalogue behaviour is
unchanged. That is the safety property: `new_unit_price_sen` is client-authored
and validated nowhere, so what makes it payable is the signature. The ceiling is
the authority the operator already had on the same order before it locked
(`trustOperatorSelling = !(isPosTabletCaller)` on the direct write path).

**NOT fixed, deliberately.** `discount_centi` has no amendment channel —
`scm.so_amendment_lines` has no discount column (mig 0080 + 0281) — so a
discount still cannot be requested, approved or applied; it is carried forward
untouched and an ADD line lands at 0. Reducing an amount on a locked SO is a
unit-price change. Migration 0281 lists the other fields with no channel
(`lineDeliveryDate`, `description`, `uom`, `itemGroup`, `cost`); those are
unchanged too. Two further findings from the same trace, reported not fixed:
approve-so has **no requester != approver check**, and the amendment SUBMIT route
is the one SO write surface where `isPosTabletCaller` is never consulted.

**Ref.** fix/amendment-carries-approved-price, 2026-08-16.
