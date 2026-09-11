## Discount input accepts amount only, no percentage option [low]

**Symptom.** Kathy 2026-09-11, relayed by owner:「我可以打 by amount，也可以打
by percentage … 就是 25%」. Supplier invoices quote discounts as a
percentage; the ERP's line-level Discount input on every purchase-side
document (PO / PI / GRN / Purchase Consignment) accepted only a ringgit
amount, forcing mental arithmetic (or a calculator round-trip that drifts
by a sen or two) every time.

**Root cause (traced).** No bug in the runtime — the pattern that was
never built. The audit for this task walked every SCM document surface
that carries a Discount input:

- `frontend/src/vendor/scm/components/PoLineCard.tsx:688`   (PO / PI / GRN)
- `frontend/src/vendor/scm/components/PcLineCard.tsx:370`   (Purchase Consignment cards)
- `frontend/src/pages/scm-v2/PurchaseOrderNew.tsx:1410`
- `frontend/src/pages/scm-v2/PurchaseConsignmentOrderNew.tsx:755`
- `frontend/src/pages/scm-v2/GoodsReceivedDetail.tsx:1015`
- `frontend/src/pages/scm-v2/PurchaseConsignmentReceiveDetail.tsx:610`

Every one of them mounts `<MoneyInput bare valueSen={l.discountSen ?? 0}
onCommit={(sen) => onChange({ discountSen: sen ?? 0 })} … />`. `MoneyInput`
is a plain RM editor; there is no `%` option to enable. The backing column
`discount_centi` (aliased `discount_sen`) is an integer sen amount on all
11 SCM line tables. Only `lorry_wo_parts` (mig 0241, workshop repair
lines) carries a `discount_pct` companion; every other doc stores the
resolved amount only.

The sales-side card `SoLineCard.tsx` never exposed a manual per-line
discount input at all — the one place it writes `discountSen` is the
delivery-fee "type the amount to charge" auto-computation (line 959),
which is semantic-specific rather than a discount UI. So sales-side
surfaces are out of scope here.

**Fix.** New shared component `frontend/src/vendor/scm/components/DiscountInput.tsx`
wraps `MoneyInput` with a small `RM` ⇄ `%` toggle beside the field.
Default mode is RM (unchanged behaviour). In % mode the field takes a
number 0..100; on commit the component resolves
`Math.round(baseSen × pct / 100)` and calls `onCommit(sen)` — exactly
what a user would have typed in RM mode. Owner ruling 2026-09-11: the
percentage is UI-only; there is no `discount_pct` column and the reopened
record reads back the sen amount, not the %. The audit for that decision
is in the PR body and answers Kathy's ask with two files of change
(component + six call sites) instead of a migration on eleven tables.

Value above 100 clamps to 100; base of 0 disables the % field but not the
toggle. Six unit tests pin the four behaviours (RM commit, % commit,
non-integer % rounds to the nearest sen, > 100 clamp, mode-switch
round-trip preserves the sen value, base-0 disables the field but keeps
the toggle usable) — proven RED on the unfixed tree by running the same
suite before the component existed.

**Ref.** `fix/discount-percentage-input`, 2026-09-11.
