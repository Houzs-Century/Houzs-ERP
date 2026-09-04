## 338 migrated lines carry no special order, because recording one would have moved money [high]

**Symptom.** On 338 AutoCount-imported SO and PO lines the slip asks for an
option — "HB fully cover", "front drawer", "5540 backrest" — and the ERP line
carries no picker code, so the Special Orders accordion reads `(0 selected)` and
the factory cannot see what to build. Measured 2026-09-02, prod run
**33659562235**: SO 228, PO 110. `check-sofa-bedframe-completeness.mjs` with
`ALL_SO=1` (run 33653494144) counts the same gap as 298 bedframe + 39 sofa.

**Root cause (traced).** It is not a miss — it is a deliberate hold-back that was
never followed up. `backfill-specials-into-variants.mjs` runs with `SKIP_PRICED=1`
and skips WHOLE any line that would newly gain a code carrying a price in
`scm.special_addons` (prod run **33517835461**: 442 stamped, 338 held back). Nine
codes are priced today and `HB Fully Cover` alone accounts for 263 of the 338.

The hold-back was right, and this is the trace of why. Nothing recomputes on
READ; the surcharge is recomputed and PERSISTED by a route write, and only when
the caller actually changed the line's priced shape
(`mfg-sales-orders.ts:8357`, guarded by the canonJson equality at `:8345-8356`).
On that path:

- **Selling is already safe on a migrated line.** `mfg-pricing-recompute.ts:546`
  derives `isMigratedTrust` from `trustOperatorSelling === 'including-zero'`,
  `:547` zeroes `chargeableSurchargesSen`, and `:725-730` persists the stored
  price. The marker comes from `erpLineTrust(..., soIsMigrated)` (`:275`), fed by
  `linked_ac_docno IS NOT NULL` (`mfg-sales-orders.ts:8231`). The customer price
  cannot move.
- **Cost is NOT.** `:579` sets `unitCostSen = costBreakdown.unitPriceSen`, which
  includes `sumSpecialsCost` (`mfg-pricing.ts:538/541/543`), and the route writes
  it to `unit_cost_sen` / `line_cost_sen` / `line_margin_sen`
  (`mfg-sales-orders.ts:8522-8538`). `special_order_price_sen` (`:8546`) has no
  migrated exemption either.
- **Purchase orders re-price in the BROWSER.** `mfg-purchase-orders.ts:3131`
  persists whatever the client sends and recomputes nothing;
  `PurchaseOrderDetail.tsx:415` re-prices any line whose `priceTouched` is false
  and `:621-629` clears that flag when the operator edits a variant. That path
  reads the SUPPLIER MAINTENANCE CONFIG's specials pool, not
  `scm.special_addons` — and run 33659562235 measured that pool live: it carries
  `priceSen` for these same codes at master scope and at both supplier scopes.

Measured cost of stamping the codes into `variants.specials` plainly: SO
`unit_cost_sen` **+RM 16,820**, SO `special_order_price_sen` **+RM 16,820**, PO
`unit_price_sen` **+RM 7,380** — arriving one document at a time, on whoever
edits it next. A further **224 lines (SO 204, PO 20) already carry a priced code
today** and are armed the same way with or without this work.

**Fix.** Owner's choice 甲, 2026-09-03 —「记下来给工厂看，但单据的钱不可以动」.
`backend/scripts/record-priced-specials-on-migrated-lines.mjs` (MODE=plan by
default, `CONFIRM=RECORD-NOT-CHARGE` on apply) writes the codes to
**`variants.specialsRecorded`** and never touches `variants.specials`.

The obvious alternative — stamp into `variants.specials` and teach the engine to
skip those codes — was rejected for failing OPEN: **ten call sites across nine
files** feed that array into a price or a cost, and missing one reprices a
closed document silently. A key no pricing path reads cannot do that even if a
future author misses a site. Two
DISPLAY surfaces render it: `variant-summary.ts` (Description 2, so it reaches
every print and the Detail Listing) and `SpecialOrders.tsx` (a ticked, locked
row reading "from AutoCount — already in this document's price, not charged
again"). A code the operator picks properly still lands in `variants.specials`
and is charged normally.

That property is pinned by `backend/tests/specialsRecordedNeverPriced.test.ts`,
which scans both trees and fails if the key reaches anything but the allow-list —
**proved RED** by appending the identifier to `mfg-pricing.ts`
(`AssertionError: backend/src/scm/shared/mfg-pricing.ts mentions
specialsRecorded`). It self-checks its own corpus first, so a scan that matched
nothing cannot read as a pass.

The phrase→code rules moved to `backend/scripts/lib/special-order-phrase-mapper.mjs`
so the two backfills derive the same population by construction rather than by a
second author re-deriving it; `special-order-phrase-mapper.test.mjs` pins the
classification against run 33517835461's own output.

**NOT DONE, and deliberately.** The apply has NOT been run — the plan is the
deliverable and the write is the owner's call. The 224 already-armed lines are
reported, not repaired. Whether a migrated line's COST should re-add a specials
surcharge at all is an open owner question that this entry does not settle.

**Ref.** fix/record-priced-specials-money-neutral, 2026-09-03. Plan run
**33663208619** (prod, read-only).

**Re-measured after `parse-sofa.mjs` changed under it.** #2899's leg-note fix
(`0622`) altered the regex that pushes a sofa leg phrase into `specials`, and
this population is derived from that parser — so the numbers above were re-taken
on the merged tree rather than carried over. Run **33663208619** reproduces run
33659562235 exactly: SO 228 + PO 110, the same nine codes with the same counts,
the same RM 16,820 / RM 16,820 / RM 7,380, and the same money columns. The
earlier run is superseded, not contradicted.
