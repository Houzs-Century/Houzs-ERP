## A delivery note whose only item code was substituted vanished without a trace [high]

<!-- area: Cutover + migrated data -->

**Symptom.** Company 1 go-live, 2026-09-07. `DO-001800` and `DO-005583` exist in
AutoCount, are not cancelled, and deliver against sales orders with lines still
outstanding — and neither exists in the ERP. Nothing refused them, nothing
counted them, and no number anywhere went down. The AutoCount reconcile then
listed both as **"(owner-declined)"**: a gap printed as a decision.

**Root cause (traced).** `backend/scripts/lib/migrated-do-writer.mjs`
`buildMigratedDoPlan()` matches an AutoCount delivery line to a sales-order line
by ITEM CODE. `AutoCount carries no DO -> SO line key in this book` — measured on
`data/ac-partial-dos.json.gz`: **0 of 369** delivery rows carry a `SoDtlKey`
(corpus-wide, `ac-reconcile-truth.json.gz` line fields: `fromSoDtlKey` is
populated on 10,792 of 18,890 PO lines and **0 of 48,772 DO lines**). So the item
code is the only bridge, and the warehouse **substitutes the product at
dispatch**, so the code routinely does not reach:

- `DO-001800` delivers `HB109NL` x3 and `HB109M-CC` x3 against `SO-002281`,
  whose ERP lines are `AKEMI ARMOUR MATT (Q)` / `AK- LTX CLS PIL` /
  `NTYR-CS LTX PIL + CSC` / `AK-SK + MICROFIL PIL`.
- `DO-005583` delivers `AK-SK FX AIRLOFT PIL` x2 against `SO-007435`.

An unmatched row hit `stats.noSoLine++` and `continue`. That counter is a TOTAL
with no denominator per document, and `byDo` only ever held documents that
produced at least one line — so a note whose EVERY line failed was simply not in
it. The run printed `DO documents: 82` (production run 34129497431), which was
the count AFTER the loss, with nothing subtracted from anything.

The same silent path also SHORTENS documents that survive: `DO-001953` (4 book
lines, 2 written) and `DO-004903` lose 2 lines each. `DO-001953` is the
expensive one — the two lines it lost were its only lines carrying a quantity,
so `create-migrated-invoices` refused its sales invoice as `nothing_to_invoice`
and `I-2411-0323` never came in either. **Measured blast radius: 7 lines across
4 documents, 2 of which do not exist at all.**

**Why it was not fixed when it was found.** A previous session refused to pair
`HB109NL` to `AK- LTX CLS PIL` on quantity alone, and was right to: that is
computing, not copying, and it credits a delivery against a line that may not be
the one substituted. The reporting was fixed (per-document attribution) but the
documents still did not come in.

**Fix.** Owner ruling 2026-09-07 — *"改我们的程式，允许换型号"*. The document must
come in; the pairing must still not be invented. `buildMigratedDoPlan` takes
`allowSubstitution`, and when set carries the row instead of dropping it:

- `item_code` / `description` come from the **book**, through the same mapping
  sheet every other line uses. Nothing is rewritten into the order's product.
- `so_item_id` stays **NULL**. An unlinked DO line is an existing, supported
  shape (`delivery-orders-mfg.ts:992`), and the interactive create path already
  blesses exactly this case: it refuses an unlinked line only when the SO *does*
  order that code, because "a replacement part riding along on the same trip
  still passes" (`:3396`).
- `ac_substituted = true` (migration `20260907T2340`) marks the row, so the
  system never presents a code as matching an order it does not match. Desktop
  (`DeliveryOrderDetailV2.tsx`) and mobile (`MobileModuleDetail.tsx`) both show
  it; the header note says it in words.
- Price is the **book's own** `UnitPrice`, not a price borrowed from a line this
  row is not paired to. Cost is 0 — unknown stays unknown.
- The consequence accepted deliberately: an unlinked line does not move the
  sales order's remaining quantity. That is correct — we do not know WHICH line
  was substituted, and crediting the wrong one is the error being refused.

**The more valuable half: the run can no longer lose a document quietly.**
`create-migrated-documents.mjs` now closes its books out loud — every note in the
cut is either a document the ERP will hold or is NAMED with its reason, and the
two conservation identities (documents, then lines) are asserted. A mismatch
prints `::error::` and **refuses to apply**. Enabled only for the cutover cut;
`sync-ac-delta.mjs` is deliberately left off (it is already ALL-OR-NOTHING with
an explicit refusal list, so it never vanished a document, and substitution
changes what its over-delivery assertion measures).

**Ref.** PR (2026-09-07). Tests: `backend/tests/migratedDoWriter.test.mjs` — 12
new cases pinning both halves, including that the flag is OFF by default, that
the book code is carried rather than the ordered one, that no link is invented,
and that a genuinely absent sales order is still a NAMED drop.
