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

### Why 9 goods receipts still differ on money — and why it is a DECISION, not a defect

**PROVEN, from the committed book snapshot** `backend/scripts/data/ac-reconcile-truth.json.gz`
(exported 2026-09-08, re-run the arithmetic below rather than quoting it):

> Of the **11,623** receipt x order pairs AutoCount itself states, **8,169**
> carry a price on the RECEIPT while the purchase ORDER states none at all.
> Only 3,333 have a price on both.

That is not an anomaly — it is how this business books a purchase. The price is
settled when the goods arrive, which is the same fact behind the 241 unpriced
purchase lines the owner ruled 「这个没问题」.

Our goods receipts take their money from the purchase-ORDER line by design
(`priceDeclared` in `backend/scripts/lib/ac-reconcile-erp-sql.mjs`;
`reshape-migrated-grns.mjs` copies the book's item, quantity and date and leaves
price to the order). So wherever the order is blank, our receipt is short by
exactly that line.

**Worked, on the three the reconcile named** (raw ringgit, book side proven):

| pair | book line 1 | book line 2 | book pair total | our total |
|---|---|---|---|---|
| `GR-004909\|PO-009017` | 1 x RM 3,080.00 | 4 x RM 30.00 = 120.00 | RM 3,200.00 | **RM 120.00** |
| `GR-005171\|PO-009344` | 1 x RM 2,250.00 | 2 x RM 40.00 = 80.00 | RM 2,330.00 | **RM 80.00** |
| `GR-005169\|PO-009475` | 1 x RM 2,170.00 | 2 x RM 30.00 = 60.00 | RM 2,230.00 | **RM 60.00** |

In each one our total equals the SECOND line to the sen and the big qty-1 line
contributes zero. The book's own `PODTL` for all three orders states
`UnitPrice 0.00`, so the book agrees the ORDER had no price; only the RECEIPT
states one.

**PROVEN on production, run `34231092897`** — `stamp-migrated-source-prices.mjs`
dispatched in PLAN mode (writes nothing), company 1, `kind=gr`, 2026-09-08
13:17 UTC. That tool already computes the right figure to the sen and then
REFUSES to write it:

```
PI-007287      AutoCount  RM 11,247.00  ours would be   RM 3,200.00   HC-GR-004909
PI-007765      AutoCount   RM 4,580.00  ours would be   RM 2,230.00   HC-GR-005169
PI-007771      AutoCount   RM 9,284.00  ours would be   RM 4,850.00   HC-GR-005171-PO-009344 + HC-GR-005171-PO-009553
```

`RM 3,200.00`, `RM 2,230.00` and `RM 2,330.00 + RM 2,520.00 = RM 4,850.00` are
exactly the book pair totals in the table above. The same run explains the
RM 120 / RM 80 / RM 60 we DO hold:

```
HC-GR-004909 group 829661 (SQUARE PILLOW): already carries money in the ERP — never overwritten. SKIPPED.
HC-GR-005169 group 861817 (SQUARE PILLOW): already carries money in the ERP — never overwritten. SKIPPED.
HC-GR-005171-PO-009344 group 851497 (LONG PILLOW): already carries money in the ERP — never overwritten. SKIPPED.
```

The accessory line is priced; the furniture line is not. And the run states why
it will not price the furniture line:

> **LEFT ALONE — 28 AutoCount invoice(s) whose ERP side cannot reach the billed
> total:** our receipt mirrors ONE purchase order and AutoCount's receipt spans
> several, so the invoice bills more than our lines cover. A price cannot fix
> that; **these are the multi-purchase-order fragments with the owner.**

**So the 9 are not a data defect and no existing tool will close them.** They
are that already-known class. The same run also reports what it WOULD do
elsewhere — `STAMPING 23 line(s) across 21 document(s) / 7 AutoCount invoice(s)`,
after which those 7 reconcile to the sen and become convertible — which is a
separate, available decision and was NOT applied here.

**Do NOT repair this by copying the book's receipt price.** It would put money
on a receipt that its own purchase order does not have, contradict
`priceDeclared`, and change what a purchase invoice raised off that receipt
would say — the stamp tool's own words are that it would move an owner-held
decision out of the "ours RM 0.00" bucket into "both sides priced and genuinely
differ", where it reads as new. It sits beside his existing 「GR 0 没关系」
ruling, which already accepts a migrated receipt carrying LESS than the book
states. Whether a PARTIAL amount falls under the same ruling is his to say.

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
