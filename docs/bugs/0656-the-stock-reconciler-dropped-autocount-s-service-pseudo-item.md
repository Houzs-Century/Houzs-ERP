## The stock reconciler dropped AutoCount's service pseudo-items on one side only [medium]

**Symptom.** The go-live stock comparison reported cells the ERP holds and
AutoCount does not — headed by `DISPOSE @ BALAKONG WAREHOUSE -1714`,
`DISPOSE @ PENANG WAREHOUSE -803` and four `TRANSPORTATION CHARGES` warehouses.
Read at face value that is thousands of units of stock in the ERP with no
counterpart in the account book, on the very axis the owner set as the release
gate. None of it is stock.

**Root cause (traced).** `check-stock-vs-autocount.mjs` drops AutoCount's
`SERVICE_GROUPS` (`OTHER`, `TRANS`) while building the AutoCount side —
AutoCount models delivery, disposal and storage as stock-controlled items and
they accumulate a large negative balance no warehouse holds. It then built the
ERP side as `erpBal.filter((r) => !r.is_sofa)`, with no matching predicate. So
the ERP's rows for the SAME codes stayed in the comparison with nothing left to
compare against, and every one of them fell out as an ERP-only cell. Measured on
prod 2026-09-07 while writing `check-golive-parity.mjs`: **16 cells,
−4,149 units**, which is 33 of the 49 ERP-only cells the first run reported.

This is the identical failure `docs/stock-reconciliation.md` §4 already records
for SOFA — a gap invented by the filter rather than found by it — and the sofa
half was fixed symmetrically at the time. The service half was written the same
day and never was.

**Fix.** `serviceErpCodes()` in `backend/scripts/lib/ac-stock-compare.mjs`
derives the ERP codes from the binding CSV — never typed — and both checkers
exclude them on BOTH sides and print the units held out, so the exclusion stays
visible rather than silent. Proved RED on the unfixed tree by running
`check-golive-parity.mjs` against prod before the change: 49 ERP-only cells
including the six named above; after: 33, with the six gone and a
`held out — service pseudo-items … (ERP side, the SAME codes via the binding)`
line in their place. The location map, the service-group set and the binding
reader moved into that shared module in the same change, so the two scripts
cannot drift apart again.

**Ref.** chore/golive-readiness-checker, 2026-09-07.
