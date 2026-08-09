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

## D. The mapping/rules the tally depends on (so a re-run reproduces the same numbers)

- SKU: `backend/scripts/data/autocount-erp-mapping-1561.csv` (ac_code -> erp_code); 0 non-sofa codes off the pick list after the `SVC-DELIVERY -> TRANSPORTATION CHARGES` company-1 alias.
- Salesperson: `backend/scripts/data/agent-staff-binding.csv` (34 bind / 23 auto-created inactive sales staff).
- Sofa EXCLUDED (any sofa line -> order held): 191 mixed + 243 all-sofa = 434 orders / 569 lines held.
- doc_no = `HC-<AutoCount DocNo>`; raw number in `linked_ac_docno`.
- Scripts: `backend/scripts/import-ac-outstanding-so.mjs` + `import-ac-outstanding-po.mjs`
  (DRY-RUN default, APPLY=1, LIMIT=N), workflow `import-ac-outstanding-so.yml`.

## E. Finding what changed after the cut-off (the top-up query, for a later tally)

After recording the freeze timestamp T, re-query AutoCount for rows modified after T
(SO/SODTL/PO carry a LastModified-style column — confirm its name on the box) and diff
against the ERP `linked_ac_docno` set: new DocNos = create in ERP; changed = update the
linked ERP order. Then close the old system.
