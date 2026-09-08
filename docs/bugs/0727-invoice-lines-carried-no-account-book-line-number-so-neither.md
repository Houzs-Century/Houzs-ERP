## Invoice lines carried no account-book line number, so neither invoice type could be compared at all [high]

**Symptom.** The transfer-chain audit (PR #3304, run `34246919551`) could not
answer a single question about either invoice type:

> 销售发票、采购发票 — **问不了**：每一行都没有账本行号。

The report was right to print "NOT MEASURED" rather than a zero, and it did.
But the reconcile's own SUMMARY made the same corpus look nearly settled from a
different angle — 13 sales invoices were compared as MULTISETS with 12 "proven
identical" — so the invoices read as *mostly fine* when in truth they were
*mostly unasked*. That is the failure this repository has paid for repeatedly:
a zero that comes from not looking.

**Root cause (traced, on `origin/main` at `d890a1b6f`).** Not a comparison bug.
A column that exists, is dereferenced by three separate readers, and was never
populated.

1. Migration `0280_scm_ac_line_keys_downstream.sql` added `linked_ac_dtlkey` to
   `scm.sales_invoice_items` and `scm.purchase_invoice_items`. Its own header
   states the gap plainly: *"Nothing backfills it: the keys are stamped forward,
   at the moment AcSyncService reports the lines it created for a conversion."*
   Every row the MIGRATION created therefore kept NULL.
2. Measured on production 2026-09-08 (run `34257665800`, DRY-RUN):
   **0 of 186** sales-invoice lines and **0 of 158** purchase-invoice lines
   carried one. Not "few" — none.
3. `lib/ac-transfer-chain-run.mjs` reads that column as `child_key`, so all 344
   lines reached it as `unkeyed` and both edges reported nothing. The invoice
   half of `lib/so-tally-verdict.mjs` and the reconcile's variant axes were
   equally blind: with no key, which of our rows answers which of the book's is
   the checker's own guess, which is the named defect class `docs/bugs/0690`.
4. AutoCount cannot supply the pairing either. `PIDTL.FromDocDtlKey` is
   populated on **0 of 20,777** rows and `GRDTL` on **0 of 21,000** (0280's
   header), and the committed snapshot's `line_fields` carries `fromSoDtlKey`
   for `PODTL` only. So the key had to be DERIVED, and only where the document
   forces it.

**The invoice-shaped difficulty.** A migrated invoice's lines are built from
OUR delivery order / goods receipt, and the migration carried only the
OUTSTANDING population — so the ERP deliberately holds a SUBSET of what the
book's invoice bills. 131 of the 192 in-scope purchase invoices bill at least
one line whose purchase order was never carried
(`lib/ac-chain-line-grain.mjs`). Bucketed on `(item, quantity)` alone every one
of those reads as *"the book has 2 such lines, we have 1"* — refused for a
reason that is SCOPE, not doubt.

**Fix.** `IVDTL.FromDocNo` / `PIDTL.FromDocNo` is the discriminator and it is
the BOOK'S OWN. `lib/ac-forced-line-pairing.mjs` takes it as `sourceDoc` and
partitions the buckets by it, ALL-OR-NOTHING per document: if either side
leaves one row's source unstated the partition is off and the older rule
stands, because a sourceless row falling into a shared `""` bucket with every
other sourceless row would pair lines the book never linked. The goods-receipt
and delivery-order lanes pass no source at all and are bit-for-bit unchanged.

`resolveErpSource` picks which of our TWO parents the book means (an invoice
line knows its delivery order AND the sales order behind it; its goods receipt
AND that receipt's purchase order) from the book's own list for that invoice,
and returns null when it names both or neither. Preferring one join over the
other would be position matching wearing a link's clothes.

Proved RED on the unfixed tree first: 8 cases in
`backend/tests/acForcedLinePairing.test.mjs` — 3 for the partition, 5 for
`resolveErpSource` — failed against the unmodified module before the
implementation existed (`forcedSourceDoc` was `undefined`, `sourceDoc` absent
from the folded unit, `resolveErpSource` not a function). 47/47 green after.

**Applied.** Run `34258125504`, prod, 2026-09-08: **291 of 291 planned rows
stamped** — sales invoices 174/186, purchase invoices 117/158. The remaining 53
are refusals printed by name with their reason, because a wrong DtlKey makes
AcSyncService append a line to the LIVE account book instead of editing the one
that changed (migration `0273`), so no key is the cheap outcome and a wrong one
is the expensive one. The run's SHAPE proof — re-taken on a FRESH connection —
reported money, quantities, readiness, stock and the migrated-document movement
leak IDENTICAL before and after, with `mfg_sales_order_items` and
`purchase_order_items` carried as an explicit CONTROL that did not move.

**What it bought, and it is not comfortable.** Run `34258790142`:

| | documents | identical | differ | cannot compare |
| --- | --- | --- | --- | --- |
| Sales invoices | 49 | 31 | 16 | 2 |
| Purchase invoices | 55 | 1 | 53 | 1 |

Sales invoices now answer **0 differ** on SKU, quantity, money AND on the
transfer chain that could not be asked at all before. Purchase invoices went
the other way: the transfer chain alone is **47 documents, all PROCEEDED**, and
the bedframe axes another 36 — differences that were always there and simply
could not be seen. The number got worse because the instrument started working.

**Ref.** `fix/invoice-line-keys-tally`, PR #3324, 2026-09-08.
