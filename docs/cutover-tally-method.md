# Cutover tally / reconciliation method (SO + PO)

How to COUNT and RECONCILE the AutoCount -> ERP outstanding migration, end to
end, so it can be re-run on any later date (owner: "多几天后我们还要 tally 多一次").
Every number below is a live query — re-run them and compare.

Provenance: the first authoritative export was taken from the LIVE AutoCount book
**AED_HOUZS** on **2026-08-09**. The real cutover uses ONE final export taken at the
FREEZE moment (after AutoCount is blocked) — record that timestamp as the official
cut-off; anything changed in AutoCount after it is found by modified-date and topped up.

---

## A. AutoCount side (source of truth) — run on the AutoCount host SQL (book AED_HOUZS)

Reached via the remote console (`Server=.\A2006;Database=AED_HOUZS`). "Outstanding"
= a line still not fully delivered: `Qty > TransferedQty`.

```sql
-- SO: outstanding orders / lines
SELECT COUNT(DISTINCT h.DocNo) AS outstanding_orders,
       COUNT(*)               AS outstanding_lines
FROM SO h JOIN SODTL d ON d.DocKey = h.DocKey
WHERE h.Cancelled = 'F' AND (d.Qty - ISNULL(d.TransferedQty,0)) > 0;
-- baseline 2026-08-09: 2,709 orders / 13,333 lines  (12,995 total non-cancelled SOs)

-- PO: outstanding lines (mirror-confirmed 273 POs / 431 lines; 74 sofa)
SELECT COUNT(DISTINCT h.DocNo) AS po_count, COUNT(*) AS po_lines
FROM PO h JOIN PODTL d ON d.DocKey = h.DocKey
WHERE h.Cancelled = 'F' AND (d.Qty - ISNULL(d.OutstandingQty,0)) > 0;  -- confirm PODTL outstanding col name at run time
```

Export columns needed (so the ERP import is complete):
- **SO header**: DocNo, DocDate, DebtorCode, DebtorName, SalesAgent, SalesLocation, Ref,
  Phone1, Attention, InvAddr1-4, DeliverAddr1-4, DeliverContact, DeliverPhone1,
  **UDF_PDate (processing date)**, UDF_BRANDING, UDF_VENUE, UDF_PAYEMENT, UDF_BALANCE.
- **SO line (SODTL)**: DtlKey, ItemCode, Description, Desc2, Qty, TransferedQty, UnitPrice,
  Location, **DeliveryDate**, UDF_BatchNo.  (UDF_PDate + DeliveryDate were MISSING in the
  first export — must be added; UDF_PDate -> processing, DeliveryDate -> delivery, NOT swapped.)
- **PO**: DocNo, DocDate, CreditorCode/Name, so_doc_no link, ItemCode, Desc2, Qty,
  OutstandingQty, UnitPrice, Location, DeliveryDate + supplier dates. (The ERP mirror
  `public.purchase_orders` has NULL price/qty/Desc2 — insufficient; PO needs this real export.)

---

## B. ERP side after import — run against DATABASE_URL (company_id = 1 = Houzs Century)

```sql
-- SO imported (sofa excluded this round: mixed + all-sofa held)
SELECT COUNT(*)                AS orders,
       COUNT(linked_ac_docno)  AS linked,           -- must equal orders
       SUM(local_total_centi)/100.0  AS total_rm,
       SUM(balance_centi)/100.0      AS balance_rm,
       SUM(paid_centi)/100.0         AS paid_rm
FROM scm.mfg_sales_orders WHERE company_id = 1;
-- expected: 2,275 orders, all linked, total RM 16,178,290 / balance RM 8,169,873

SELECT COUNT(*) FROM scm.mfg_sales_order_items    WHERE company_id = 1;  -- ~12,518
SELECT COUNT(*), SUM(amount_centi)/100.0 FROM scm.mfg_sales_order_payments WHERE company_id = 1;

-- PO imported
SELECT COUNT(*) po, SUM(subtotal_centi)/100.0 total_rm FROM scm.purchase_orders WHERE company_id = 1;
SELECT COUNT(*) FROM scm.purchase_order_items WHERE company_id = 1;
```

---

## B2. Count LINES, not only documents (added 2026-08-10, after a miss)

A document-count tally cannot see a document that arrived with some of its lines
missing, and on 2026-08-10 that is exactly what had happened: `PO 407 = 407
MISSING 0` while 35 AutoCount PO lines (60 ERP rows) had no row at all. Both PO
importers are idempotent at DOCUMENT level, so a document created by an earlier
run was skipped WHOLE by the later one and the lines the earlier run did not
carry were never written. See `BUG-HISTORY.md`, top entry.

So the tally now has a line altitude, and it is a script, not a query to run by
hand:

```
node backend/scripts/check-cutover-completeness.mjs      # section 1b
```

The two rules it counts by, both of which are load-bearing:

- **PO - one AutoCount line must have AT LEAST ONE ERP row.** A sofa line
  decomposes into its compartments, everything else is one-for-one, so fewer
  rows than lines proves rows are missing without the check having to predict
  the piece count. Rows are claimed for an AutoCount `ItemCode` by
  `supplier_sku` (the importers write the ItemCode there, and
  `${ItemCode} ${compartment}` for a piece), falling back to `material_code` for
  the ~225 migrated lines that carry no `supplier_sku` at all. Above both sits
  `linked_ac_dtlkey` (migration 0273), used where a row has one and written onto
  every row the top-up inserts — but never relied on alone, because it is
  nullable and its backfill cannot reach a sofa compartment.
  Rule in full: `backend/scripts/lib/po-line-topup-core.mjs`.
- **SO - the denominator is the OUTSTANDING lines, not every line.** An imported
  order holds the AutoCount lines where `Qty > TransferedQty`. SO-000013 is the
  clearest read: 8 AutoCount lines, 7 fully transferred, exactly the 1
  untransfered line in the ERP. Counting all 13,588 lines calls 243 lines missing
  on 65 orders, and every one of them is a delivered line that was never meant to
  come; against the 13,342 outstanding ones the gap is 1 line.

Repair for what it finds on the PO side, DRY-RUN by default:

```
Actions -> "Top up missing AutoCount PO lines (line level)" -> target=prod, apply=0
```

It inserts only lines whose AutoCount ItemCode has ZERO rows on the document; an
ItemCode with SOME rows is reported and left alone, because a half-written sofa
build is just as likely a build somebody corrected by hand.

### The received quantity: only ONE of the two exports can supply it per line

`ac-outstanding-po.json.gz` carries `PODTL.TransferedQty`, which is per PO LINE.
`ac-so-linked-pos.json.gz` carries `GrQty`, which is **aggregated on
(DocNo + ItemCode)** — on a document holding two lines of one ItemCode, every
line reports the DOCUMENT's total. Reading it per line put 65 production rows at
`received_qty > qty` (`BUG-HISTORY.md`, top entry). The tell is in the file:
59 lines carry `GrQty > Qty`, which is impossible for a single line, and all 59
sit on a repeated-ItemCode group.

So the tally treats a received quantity as UNKNOWN unless `TransferedQty` supplied
it or the aggregate is exactly zero, and the top-up **withholds the whole family**
rather than write a number nobody can stand behind — `received_qty` is
`NOT NULL DEFAULT 0`, so there is no blank to write. Withheld rows are printed
under `WITHHELD - no per-line received quantity in the export`, and they stay
MISSING, which this same check keeps reporting. That is the intended trade: a
missing row is visible and recoverable, an inflated one is a silent permanent
negative outstanding.

**To clear them properly, re-export with the per-line column** —
`backend/scripts/data/autocount-refetch-so-linked-po.sql`, read-only, run on the
AutoCount host against `AED_HOUZS`, then gzip over `ac-so-linked-pos.json.gz` and
re-run the DRY-RUN. Note `GRDTL.FromDocDtlKey` is NULL in this book, so
reconstructing a per-line figure from GR details is not an option;
`PODTL.TransferedQty` is the only correct source.

---

## C. Three-way reconciliation (must tie out before go-live)

| check | rule |
|---|---|
| SO count | ERP company-1 non-sofa order count == AutoCount outstanding orders MINUS (mixed + all-sofa held). 2,709 - 191 mixed - 243 all-sofa = **2,275**. |
| SO value | ERP `SUM(local_total_centi)` == AutoCount outstanding SO value (RM 16,178,290). |
| SO linkage | every ERP order has `linked_ac_docno`; == its AutoCount DocNo. |
| Payment/balance | per order: `paid + balance == total`; `balance == UDF_BALANCE`. |
| PO count | ERP company-1 PO count == AutoCount outstanding POs (non-sofa) == **227 / 357 lines**. |
| PO linkage | ERP PO `linked_ac_docno` == AutoCount PO DocNo; `so_item` link kept where present. |
| Exceptions | SO colour/free-text exception list (~37, all AutoCount source-data truncation) consciously reviewed; nothing silently dropped. |

## C2. THE ONE-LINE ANSWER, per document type (added 2026-09-08)

Section C ties out COUNTS and VALUE. It does not answer 「都tally了吗」 for a
document type, because a summary row can be right about its own column and still
leave a document differing — see `docs/bugs/0715` (a comparison that never ran,
counted as `differ`) and `docs/bugs/0720` (a purchase order that differed on
CURRENCY while the gap total read `PO 0`).

Two read-only workflows print that answer, one document at a time, and neither
writes anything:

| question | Actions -> workflow | script |
|---|---|---|
| 「SO 都tally了吗」 | **Are all the sales orders tallied? (read-only)** | `backend/scripts/check-so-tally.mjs` |
| 「PO GR 也tally了吗」 | **Are the purchase orders and goods receipts tallied? (read-only)** | `backend/scripts/check-po-gr-tally.mjs` |

Both classify the SAME comparison — `check-ac-erp-reconcile.mjs` — into four
buckets, and **neither measures anything itself**. The second runs the reconcile
ONCE for every requested type (`TYPES`, default `PO,GR,SO`) so purchase orders,
goods receipts and the sales-order CONTROL all quote one run.

**The four buckets, and why the third one has to exist.** A document whose sofa
build the book's own text does not state is NEITHER agreeing NOR differing.
Folding it into DIFFER invents a backlog nobody owes; folding it into IDENTICAL
calls it checked when nothing checked it. It gets its own column, always.

- `identical` — compared on every axis, and every axis agreed.
- `work` — at least one axis where both sides state something different, or the
  document is absent, or the ERP claims one the book does not have.
- `unanswerable` — the only findings are axes the checker refused to answer.
- `book-gap` — the ERP carries a value the BOOK never stated. Already accepted.

**TALLIED means zero `work`**, and it is decided in exactly one place —
`isTallied` in `backend/scripts/lib/so-tally-verdict.mjs`. Not "few", not "only
the declared ones are left". No summary writer gets a vote.

**A refusal PRINTS THE VALUE WE HOLD — added 2026-09-09.** The
`CANNOT BE COMPARED` list used to print the document number and the axis name
and stop, so an order the ERP already holds a perfectly good build for reached
the owner as a blank to fill from memory:

```
HC-SO-013503 (SO-013503)  [PROCEEDED] — sofa build not verifiable
```

He pushed back — 「所以基本上model和sofa compartment基本上都有了啊？那为什么你说没
有呢？」 — and he was right: the photograph and the book's `Desc2` had been
checked, and **what our own database holds had not**. It now reads:

```
HC-SO-013503 (SO-013503)  [PROCEEDED] — sofa build not verifiable
      sofa build not verifiable: … we hold "1A(LHF)+1NA+1A(RHF)" — the book's
      Desc2 does not state the pieces
```

which is a one-word confirmation instead of a research task.

Two notes for anyone extending this:

- The build is **read, never recomputed**. `variant-reconcile.mjs` already sets
  `cell.erp = have.join("+")` before the `UNREADABLE` branch;
  `variant-report.mjs` records that value. A second computation of the piece
  list is how two statements of one rule come to disagree (`docs/bugs/0708`).
- It prints on the **cannot-compare list only**. A `work` row already names a
  real difference on its axis; a refusal alone is the thing nobody can act on.
  `bucketOf` and `isTallied` are untouched — this prints, it does not
  reclassify, and `tests/soTallyVerdict.test.mjs` pins that the document stays
  in `unanswerable`.

To ask the same question about any document directly, without the reconcile:
**What the ERP holds for a sales order (read-only)** ->
`backend/scripts/diag-so-erp-build.mjs`, which takes `DOCS=` as ERP or AutoCount
numbers and prints every line plus the piece list. It compares nothing.
See `docs/bugs/0728`.

### The `unanswerable` column is split BY CAUSE, and the split must cover the column

"Cannot be compared" is not one thing, and the report says which of three it is
per document. The registry is `backend/scripts/lib/unanswerable-causes.mjs`; it
IMPORTS the sofa buckets from `backend/scripts/lib/sofa-unread-split.mjs` rather
than restating them.

| whose it is | what closes it |
| --- | --- |
| **MECHANICAL** | a line key we never stamped. A recording job — 「一律跟账本。除了sofa compartment而已啊」 reserves the owner's ruling for what the compartments ARE, not for which line they sit on |
| **ABSENT SOURCE** | the account book states nothing to compare against and no drawing exists. Unanswerable by anyone, the owner included, and never a backlog |
| **YOURS** | the book's own text does not decode into pieces and a drawing does. Only he can read it |

Two traps this split was bought by, on run 34257873206
(`docs/bugs/0729-*.md`):

1. **The table must be fed by the COLUMN, not by every row.** A document with a
   real difference on another axis is `work`, whatever its unreadable sofa turns
   out to be. Counting its cause into the cannot-compare table made
   `=> N of these can be made comparable WITHOUT you` a promise about a set the
   owner was not being handed — GR read 6 against a column of 3, DO 7 against 5,
   PI 5 against 2.
2. **`sofa build not verifiable` is not the only unanswerable axis.**
   `transfer chain not verifiable` is the other, and it is itself TWO
   populations owed opposite things: `line_not_stamped` is MECHANICAL (a
   backfill), `erp_parent_unstamped` is an ABSENT SOURCE (an ERP-native parent
   the book has nothing to compare against). The causes are emitted in
   `backend/scripts/lib/ac-transfer-chain-run.mjs` beside the refusal, from the
   verdict it already holds, so a cause and its refusal cannot disagree.

The report prints `documents in the column carrying NO named cause: N`, whether
N is zero or not. "Every one is named" is a claim; the number that would be
non-zero if it were false is what makes it evidence.

### Why a document differs, per document — the read that was being thrown away

`backend/scripts/diag-doc-differ-cause.mjs` (workflow **Why does each document
differ, by cause (read-only)**) prints, for one document type, every document in
the `work` and `unanswerable` buckets with the reconcile's OWN findings and the
account book's own lines beside them. `buildVerdictRows` has always written that
`detail` string; nothing printed it, so the next step after the tally was to read
the axis name AS the cause and sweep the set — and a cause-mixed sweep overwrites
the rows that were already right. It compares nothing and writes nothing.

**Two things that are NOT differences, per type, and are printed with the ruling
that made them so** — do not "repair" either into a difference:

- PO: **241 lines where the BOOK states no price.** Houzs prices a purchase when
  the goods arrive; copying the book's blank would ERASE a real price.
- GR: **100 receipts carrying RM 0.00.** The owner, 2026-09-08: 「GR 0 没关系」.
  Proved per document (`migrated_no_stock`, zero inventory movements), never
  assumed.

**Grain, for goods receipts.** One "document" is a
(AutoCount receipt x purchase order) PAIR, written `GR-nnn|PO-nnn`. An ERP goods
receipt belongs to ONE purchase order while an AutoCount receipt can span
several, and 51 of the 214 in-scope receipts do. Counting receipts instead
reports every one of those as short by the part raised against another order.

### The 9 goods receipts that "differed on money" were a MEASURING ERROR — CORRECTED 2026-09-08

> **This section previously said the opposite**, at length: that the nine were a
> DECISION rather than a defect, that "no existing tool will close them", and
> **"Do NOT repair this by copying the book's receipt price."** All of that was
> built on one sentence that is false — *"our receipt mirrors ONE purchase order
> and AutoCount's receipt spans several, so the invoice bills more than our lines
> cover"* — and the owner rejected it:
>
> 「PI 是from multiple的PO 所以GR的吧? 没有啊 我们一张GR to 一张PI — 可是GR 会from
> multiple PO啊 — 所以你要去GR 每个line的amount 都对齐啊 — PO GR PI的line
> information去吧要对其啊」
>
> The old text is not reproduced here. Read `docs/bugs/0723-*.md` for the trace.

**Not one sen is missing.** The gate in `stamp-migrated-source-prices.mjs`
compared an ERP group's total against the WHOLE AutoCount invoice's `NetTotal`.
Our documents mirror only the (receipt x purchase order) pairs the migration
carried — the OUTSTANDING population, the owner's own rule — so the rest of the
invoice belongs to purchase orders that were already fully received and were
never imported. A partial mirror cannot reach a whole invoice, and no price can
make it.

**PROVEN from the committed snapshot** `backend/scripts/data/ac-reconcile-truth.json.gz`,
attributed by document link only (`PIDTL.FromDocNo` -> receipt,
`GRDTL.FromDocNo` -> order; nothing paired by position or by name — the
`docs/bugs/0690` transposition hazard). Re-run the arithmetic rather than quoting
it; `backend/tests/acChainLineGrain.test.mjs` pins all three:

| invoice | book NetTotal | the pairs we HOLD | the pairs never carried |
|---|---|---|---|
| PI-007287 | RM 11,247.00 | `GR-004909\|PO-009017` **RM 3,200.00** | `GR-004909\|PO-009033` 3,070.00 + `GR-004914\|PO-008984` 3,300.00 + `GR-004914\|PO-009074` 1,677.00 |
| PI-007765 | RM 4,580.00 | `GR-005169\|PO-009475` **RM 2,230.00** | `GR-005169\|PO-009469` 2,350.00 |
| PI-007771 | RM 9,284.00 | `GR-005171\|PO-009344` 2,330.00 + `GR-005171\|PO-009553` 2,520.00 = **RM 4,850.00** | `GR-005171\|PO-009365` 1,444.00 + `GR-005171\|PO-009516` 2,990.00 |

RM 3,200.00 / RM 2,230.00 / RM 4,850.00 are **exactly** what the stamper printed
as "ours would be" on run `34231092897`. It had the right figure all along and
was grading it against the wrong total.

**How big the wrong yardstick is:** 131 of the 192 live purchase invoices that
touch an in-scope receipt bill at least one line whose purchase order was never
migrated — **RM 625,213.71 across 892 lines**. That is not a backlog; it is
money that was never ours to hold.

**Why those orders are out of scope, checked rather than assumed.**
`PO-009033`, `PO-008984`, `PO-009074`, `PO-009469`, `PO-009365` and `PO-009516`
each read `Qty == TransferedQty` on every line and none is raised for a line of
an in-scope sales order, so each fails both lanes of `SCOPE.PO` in
`backend/scripts/lib/ac-scope.mjs`.

**Two facts found while proving this, which the arithmetic depends on:**

- **Every one of the 189 in-scope receipts is billed for exactly what it holds.**
  That is what lets the book's (receipt x order) split stand in for an
  invoice-line split AutoCount never states. Book-wide it is 5,269 exact, 4
  billed for slightly less, 0 for more. It is asserted at run time, not assumed —
  where an invoice bills only part of a receipt, the share is reported as NOT
  DETERMINABLE instead of as a number nobody can defend.
- **20 live purchase invoices have a line sum that does not equal their header,
  and every one is CNY** — the line export is DOCUMENT currency, the header
  export LOCAL. `PI-001222`: lines 1,635,817 sen, header 2,641,055 sen,
  `1,635,817 / 0.61938 = 2,641,055`, and both exports state that rate. It is a
  RATE, not a discount, and it is refused rather than converted. None of the 20
  touches an in-scope receipt.

**The yardstick now lives in ONE place** — `backend/scripts/lib/ac-chain-line-grain.mjs`.
The two-export cross-check that the old gate was reaching for is kept and is now
MEASURED per document (`invoiceIdentity`) rather than assumed.

**Currency is its own axis and it LOCKS.** A foreign purchase order's total is
compared in the document's own currency, so the money can be right to the sen
while the ERP's `currency` column reads MYR — which is wrong. It is deliberately
NOT in the SUMMARY's gap total (comparing a local-currency total against a
document-currency one is what wrote RM 13,068.55 of imaginary discount onto a
CNY order, `docs/bugs/0665`), so the per-document verdict is the only place it
shows. Never repair a foreign document's TOTAL by script: a discount and an
exchange rate are not distinguishable from a total alone.

## D. The mapping/rules the tally depends on (so a re-run reproduces the same numbers)

- SKU: `backend/scripts/data/autocount-erp-mapping-1561.csv` (ac_code -> erp_code); 0 non-sofa codes off the pick list after the `SVC-DELIVERY -> TRANSPORTATION CHARGES` company-1 alias.
- Salesperson: `backend/scripts/data/agent-staff-binding.csv` (34 bind / 23 auto-created inactive sales staff).
- Sofa EXCLUDED (any sofa line -> order held): 191 mixed + 243 all-sofa = 434 orders / 569 lines held.
- doc_no = `HC-<AutoCount DocNo>`; raw number in `linked_ac_docno`.
- Scripts: `backend/scripts/import-ac-outstanding-so.mjs` + `import-ac-outstanding-po.mjs`
  (DRY-RUN default, APPLY=1, LIMIT=N), workflow `import-ac-outstanding-so.yml`.

## F. FIELD-LEVEL tally (per order) — verify SKU / size / variants / payment are really aligned

Counts tie out at the header; this is how you prove each FIELD imported correctly.
Pick any order by its AutoCount DocNo and pull the ERP side:

```sql
-- header
SELECT doc_no, linked_ac_docno, debtor_name, salesperson_id, postcode, city, customer_state,
       venue, emergency_contact_phone, proceeded_at, processing_date,
       local_total_centi/100.0 total, balance_centi/100.0 balance, paid_centi/100.0 paid
FROM scm.mfg_sales_orders WHERE linked_ac_docno = 'SO-0XXXXX';

-- lines (SKU / size / variants)
SELECT line_no, item_group, item_code, description2, qty, unit_price_centi/100.0 price,
       gap_inches, divan_height_inches, leg_height_inches, variants, custom_specials
FROM scm.mfg_sales_order_items WHERE doc_no = 'HC-SO-0XXXXX' ORDER BY line_no;

-- payment
SELECT paid_at, method, account_sheet, approval_code, amount_centi/100.0 amount
FROM scm.mfg_sales_order_payments WHERE so_doc_no = 'HC-SO-0XXXXX';
```

Compare each field against the AutoCount SO/SODTL source line:

| ERP field | must equal (AutoCount source) |
|---|---|
| **item_code (SKU)** | the binding-CSV `erp_code` for the AutoCount `ItemCode`. 0 non-sofa codes should be off the pick list. |
| **size / spec** | the size suffix `(K)/(Q)/(S)/(SS)/(SK)` on the code = the AutoCount code's size; physical dims live in the product name. |
| **variants.fabricId / colourId** | the colour code in `Desc2` (`Col:PC151-03`), normalized (`PC-151-01`==`PC151-01`, `151-03`->`PC151-03`, `SFAT4`->`SF-AT 04`, junk-after-code stripped). TBC/KIV -> BLANK (colour not chosen). |
| **variants.gap / divanHeight / legHeight** | the `GAP:` / `DIVAN: N"+M"` numbers in Desc2 (M = leg; `NO LEG` -> 0). |
| **custom_specials / variants.specials** | the special tokens in Desc2 — `HB ...`, `fully cover`, `push back` (245 SO lines carry one). |
| **salesperson_id** | the AutoCount `SalesAgent`, resolved via `agent-staff-binding.csv` (resigned/no-account agents -> auto-created inactive sales staff). |
| **postcode / city / customer_state** | parsed from `InvAddr1-4` (state from postcode prefix). |
| **emergency_contact_phone** | the 2nd contact number (`DeliverPhone1`, else 2nd half of `Phone1`). |
| **amount_centi (payment)** | (Σ line `Qty*UnitPrice`) − `UDF_BALANCE`, in sen. |
| **account_sheet / approval_code** | the two halves of `UDF_PAYEMENT` `(accountsheet/approval)`. |
| **paid_at / payment_date** | the SO `DocDate`. |
| **proceeded_at** | `UDF_PDate`. The importer writes AutoCount's processing date into `proceeded_at` (`import-ac-outstanding-so.mjs:304, 390`) and does NOT write `processing_date`. RULE: if this is set, address + bedframe colour MUST be complete (else it is on the exceptions list). |
| **processing_date** | **NOT written by the importer** — left NULL on every migrated order. Since mig 0286 this is the ERP's one Processing Date (`scm.mfg_sales_orders.processing_date`), so a migrated order is "proceeded" with no Processing Date. That state is inert for the amendment path but the stock allocator gates on `proceeded_at`, so the two genuinely disagree on migrated rows. This row used to be labelled `proceeded_at (processing)`, which is the exact conflation mig 0286 exists to end. |

PO field-level tally is the same shape against `scm.purchase_order_items`
(material_code<-binding, supplier_id<-creditor, warehouse_id<-location, delivery_date,
variants backfilled from the linked SO line where present else the PO's own Desc2).

## E. Finding what changed after the cut-off (the top-up query, for a later tally)

After recording the freeze timestamp T, re-query AutoCount for rows modified after T
(SO/SODTL/PO carry a LastModified-style column — confirm its name on the box) and diff
against the ERP `linked_ac_docno` set: new DocNos = create in ERP; changed = update the
linked ERP order. Then close the old system.
