## Four things the cutover pulled out of AutoCount that the write-back never put back [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner, on the write-back's fidelity: *"之前我们有从 AutoCount 抽取
数据进来过我们的 ERP … 他抽取了什么东西，就代表什么东西都是要进来的 … 既然我抽出
来了，就代表我是需要的。"* Concretely, he reported a line delivery date arriving in
the account book as the DOCUMENT date on orders where the ERP holds none, and it
should be blank.

**Root cause, traced against the committed extract rather than reasoned about.**
`backend/scripts/data/ac-fidelity-so-headers.json.gz` (13,015 rows, 18 fields) and
`ac-fidelity-so-lines.json.gz` (60,939 rows, 13 fields) are exactly what the
cutover read off the live `AED_HOUZS` book, so the gap is a diff and not an
opinion. Four findings, each the module's own recurring shape — **the ERP holds
the fact in one column and the composer reads another**
(`docs/autocount-writeback-golive-coe.md` section 2, where it had already cost
three incidents):

1. **`UDF_BALANCE`** — non-zero on **2,339 of 13,015** headers, and never sent.
   The ERP has three candidates and the obvious one is wrong:
   `mfg_sales_orders.balance_centi` is rewritten to the GROSS total by
   `recomputeTotals` on every edit, so it never reflects a payment — and it LOOKS
   right precisely because the cutover's own `UDF_BALANCE` landed in it
   (`check-migration-fidelity.mjs:95`). The live answer is total minus the
   payments ledger, plus the legacy header deposit only where no `is_deposit`
   ledger row exists, which is what `GET /mfg-sales-orders/:docNo` and the
   customer print show.
2. **`DeliverPhone1`** — on **120** headers, genuinely different from `Phone1` on
   **37**. Two contacts, two columns (owner: *"应该是有一个 Delivery Contact，一个
   是 Contact"*): the ERP's is `emergency_contact_phone`, which is where
   `import-ac-outstanding-so.mjs:302` put AutoCount's own `DeliverPhone1` at the
   cutover. The CREATE was masked by the service's `Or(DeliverPhone1, Phone)`
   fallback; the EDIT has no fallback, so a changed delivery number never reached
   the book at all.
3. **`SODTL.DeliveryDate`** — **NULL on 11,886 of 60,939 lines**, 2,268 documents
   entirely blank, so the book plainly holds blanks. `SO_ITEM_COLS` did not select
   `line_delivery_date`, so `soLine` left it undefined and the key was never sent;
   and `AcSyncService`'s `if (dd.HasValue)` could not tell an absent key from a
   null one, so no payload could ever have asked for a blank. What landed was
   AutoCount's own default, which is the document date the owner saw.
4. **`Desc2` was sent but half-composed.** The cutover PARSED Further Description
   to get the ERP's variants, so the specification has to go back; the composer
   emitted `Col / Fabric / Seat / Leg` and read colour off `fabricColor`, the
   GRN-family key. A bedframe keeps its colour in `fabricCode` / `colourLabel`
   and its build in `gap` / `divanHeight`, so an ERP-created bedframe reached the
   book with an EMPTY Further Description — while the book's own text carries
   `COL` on 6,741 of its 15,950 populated values, `DIVAN` on 5,778 and `GAP` on
   2,620, its three commonest labels. Two renderers for one string, which is COE
   lesson 4 exactly.

**`SODTL.UOM` was the fifth candidate and is REFUTED, which is the finding worth
keeping.** It is in the extract and unsent, so it reads as a gap. Measured against
the book's own `ItemUOM` rows, **59,582 of the 59,624 lines carrying a UOM carry
one the ITEM's master row holds** (the 2 exceptions are the `unit`/`UNIT` case
typo) — the line never decides it. And the ERP's `uom` column is written
`?? 'UNIT'` at every create path, while **363 of the 758 distinct item codes on
those lines have no `UNIT` row at all**, their only UOM being `SET`. Sending it
would have put `UNIT` on a line whose item only has `SET`, against a column the
detail foreign-keys to `ItemUOM`, and lost the whole document — the same shape as
`FK_SODTL_Location`. Owner: every SKU already carries a UOM, set when the item is
opened.

**Fix.** `BALANCE` and `DeliverPhone1` on both create and edit; the line delivery
date on both, sent PRESENT-AND-NULL on a create and omitted on an edit; `Desc2`
composed by `buildVariantSummary`, the ERP's own renderer.

The balance rule moved into `backend/src/scm/shared/so-outstanding.ts` and the SO
detail route now calls it, so the account book and the screen cannot compute
different numbers. `AcSyncService` guards the delivery date on `ContainsKey`
instead of `HasValue`, which is what makes a blank expressible at all — the
property is `DeliveryDate:Nullable`1` on all six detail classes.

Three rules the change keeps: **zero is a value** (a settled order sends `"0.00"`,
since `udf()` drops a falsy entry and the book would otherwise show a paid debt
forever); **no total means no key** (zero would declare a real debt settled in a
licensed ledger); and **an edit never blanks what the book holds** (a null
delivery date and a blank delivery phone both omit).

A new refusal, `Desc2TooLongError`, comes with the richer Desc2: `SODTL.Desc2` is
`nvarchar(100)` and the book is AT that ceiling — the longest of its 15,950 values
is exactly 100 and none is over — so an over-long line becomes a readable
`skipped` row instead of a lost document behind a 500. Same `AC_DESC2_MAX` the
sofa collapse already refuses on.

**Ref.** 2026-08-15. Divergence **D3** struck from the register in
`autocount-writeback.contract.test.ts` (11 -> 10). Lesson: **an extract is a
specification.** "Which fields should we send?" was answered for months by
judgement; the committed cutover files answer it by subtraction, and they also
refute one of the five candidates that judgement would have shipped.
