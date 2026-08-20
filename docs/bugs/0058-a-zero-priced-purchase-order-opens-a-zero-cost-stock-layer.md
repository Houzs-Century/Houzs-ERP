## A zero-priced purchase order opens a zero-cost stock layer [high, money]

**Symptom** — imported purchase orders carry `unit_price_centi = 0` on 565 of
the 579 SO-linked lines. The books are clean TODAY only because those POs
deliberately have no ERP GRN: costless-stock PENDING(GRN) = 0, PERMANENT = 0,
"OUT movements with no cost: 0". The exposure is the NEXT receipt — 234 open
units across 180 lines / 121 POs / 67 AutoCount item codes are waiting to be
received, and every one of them would book at RM0.

**Root cause (traced, not guessed)** — Houzs suppliers genuinely do not price a
purchase order; the price appears on the GOODS RECEIVED document. Live AutoCount
confirms it is the norm, not corruption: HOOKKA 2,264/2,264 PO lines unpriced,
OHANA 100%, DORSETTLOFT 100%, while GRDTL is 17,377/19,013 priced (91.4%). The
cutover copied that faithfully. What is missing is any fallback afterwards —
the zero rides the whole chain untouched:

`purchase_order_items.unit_price_centi = 0` -> `grns.ts` `/from-pos` and
`/from-po-items` copy it verbatim -> `postGrnAndRollup` computes
`unit_cost_sen = landedUnitCostMyr ?? toMyrSen(unit_price_centi, rate)` ->
the FIFO trigger's **IN** branch is `COALESCE(NEW.unit_cost_sen, 0)` (the
weighted-average fallback exists only in the **ADJUSTMENT** branch, migration
0195) -> the OUT consumes that lot at RM0 COGS -> DO line cost 0 ->
`sales_invoice_items.line_cost_centi` 0 -> the margin report reads 100%.
`grep` for `cost_required` / `price_required` in `grns.ts` returned nothing:
there was no zero-price guard anywhere on the receipt path.

**Fix** — a gate at the receipt, because it is the last moment the cost is
still changeable: once the unit ships the COGS is settled and must never be
rewritten. `scm/lib/zero-cost-receipt-guard.ts` refuses a post whose line would
open a zero-cost lot, wired into `postGrnAndRollup` BEFORE the CAS status flip
so a refusal writes nothing, plus a rollback on the three create-as-POSTED
paths so a refused receipt leaves no POSTED-but-unbooked document behind.

The discriminator is the SKU's own purchase history, not a flag: there is no
`is_free_gift` on the purchase side (`default_free_gifts` is entirely
sales-side), so a SKU never received at a non-zero cost is treated as genuinely
free — GWP, demo, display — and allowed silently, while a SKU that HAS carried
money before is refused. Same rule `backfill-zero-cost-lots.mjs` already uses
and the owner already confirmed. `grn_items.zero_cost_ack` (migration 0277) is
the per-line escape hatch, because a refusal with no override trains people to
type a fake price, which is worse than a recorded zero. It shipped inert in the
first round — the column was written by the migration and read by the gate, but
no route accepted it and both create paths build their insert from an EXPLICIT
whitelist, so a tick would have been silently dropped. It is now accepted on
create, add-line and line PATCH, all through `zeroCostAckColumns`, which also
records WHO ticked it and when; the tick renders on the receipt screen only
while the line carries no price.

**The class, for next time** — *a COALESCE to 0 on a money column is a silent
default, not a safe one.* The same trigger already knew better one branch away:
ADJUSTMENT falls back to the weighted average, IN falls back to zero, and
nothing flagged the asymmetry for as long as it has existed. When a fallback
value is indistinguishable from a legitimate value — free really is zero here —
no downstream report can ever tell them apart, so the check has to happen at
the point of entry or not at all.

**And do not price a repair from `MAX(UnitPrice)` or last-cost.** Backtested
over all 11,239 priced AutoCount purchase lines for the 67 affected item codes,
predicting each line from the others: `MAX` by item code is 112.5% mean error
and overstates 97.6% of the time; last-cost by item code is 32.2% and overstates
57.2%; item + Desc2 signature is 0.4% and exact on 97.3%. Desc2 — the
compartment/colour signature — IS the price key. `stamp-po-line-costs.mjs`
therefore prices only what it can price accurately and reports the rest, since a
plausible wrong cost is worse than a visible zero the gate will catch.

**Ref** — PR fix/zero-cost-po-exposure, 2026-08-10.

### [HIGH] The write-back sent ERP item codes the account book has never heard of, and one sofa as N lines

**Symptom** - nothing visible, because the write-back has never drained in
production. On the first document that did drain, AutoCount would have received
a Sales Order whose lines carried `9028-1S`, `AKEMI APEX MATT (SP)` and every
other ERP `material_code` verbatim as `ItemCode` - codes the licensed
`AED_HOUZS` book does not contain - and a sofa would have arrived as three or
four lines (`{model}-1A(LHF)`, `{model}-CNR`, ...) where the book holds ONE.

**Root cause (traced, not guessed)** - two separate defects that both end in the
same place, `toDetails` in `backend/src/services/autocount-writeback.ts`:

- **D10.** `composeCreateSo` was called with two arguments
  (`autocount-outbox.ts`, SO create), so its third parameter defaulted to
  `identityResolver` and `toDetails` emitted `ItemCode: l.item_code` - the raw
  ERP code. `makeItemCodeResolver`, the function written to solve exactly this,
  had no caller outside `autocount-writeback.test.ts`. Measured against the
  cutover map: of the enumerable ERP catalogue only a small minority are real
  AutoCount ItemCodes; the rest do not exist in the book.
- **D9.** `toDetails` was a strict 1:1 `map` over the ERP rows. The ERP models a
  sofa build as one line per COMPARTMENT and AutoCount holds one line per sofa
  with the build in `Desc2`, so every sofa document was the wrong shape.
  Compounding it, `PO_ITEM_COLS` did not select `description2`, so the PO side
  threw away the original AutoCount build text that the cutover importer had
  stored verbatim on every compartment row.

**Fix** - `composeDetails` now runs COLLAPSE then RESOLVE, and refuses the whole
document rather than sending part of it.

- `autocount-sofa-collapse.ts` (pure) folds a compartment run into one line:
  ECHO the stored `Desc2` when it still decodes to everything the ERP row holds
  (551 of 551 decodable builds in the real corpus), COMPOSE only when the
  operator actually changed the build, and GATE always - re-decode with the same
  `parse-sofa.mjs` the importers use and refuse unless pieces, size, colour and
  specials all survive.
- **A third defect, found while verifying the second.** The first cut of the echo
  matched on the COMPARTMENT LIST alone. But a fabric colour, a seat height and a
  special order all change without the piece list changing, so an operator who
  re-coloured a sofa in the ERP would have had the sofa's OLD colour echoed into
  AutoCount - the ERP showing the new value, the account book showing the old
  one, nothing refused, and no marker anywhere that the edit was dropped. That is
  a wrong line, not a missing one, and it is the failure the write-back exists to
  prevent. The echo now also requires the stored text to decode to the size,
  colour and specials the row holds; anything else falls through to compose,
  which spells the current build or refuses it visibly. Measured by re-colouring
  every coloured build in the corpus: **341 recomposed / 41 refused / 0 stale**
  with the check, **382 of 382 stale** without it.
- `autocount-item-code.ts` resolves against the compiled cutover map, using the
  creditor to separate the 117 ERP codes the cutover collapsed onto several
  AutoCount items. 109 separate; **8 do not, and are refused** rather than
  guessed. No fallback to `material_code`.
- `PO_ITEM_COLS` now selects `description2`.
- Refusals land as `skipped` outbox rows, and the row now names the refusal
  class (`KeylessLineError` / `SofaCollapseError` / `ItemCodeError`), because the
  three have three different remedies and the `console.error` that carried the
  name does not survive a Worker recycle.

**The trap this leaves behind** - a test whose fixture uses an invented SKU no
longer tests what its name says. `an edit whose line has no DtlKey is REFUSED`
kept passing with `SKU-1`/`SKU-2` fixtures, but it was passing on an
`ItemCodeError`, not the keyless guard, and its `toContain('SKU-2')` matched the
wrong message. Outbox fixtures now use real cutover codes and that test asserts
the refusal class explicitly.

**Ref** - PR (feat/ac-writeback-sofa-collapse), 2026-08-11. Closes contract
divergences D9 and D10.
