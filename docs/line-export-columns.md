# Line export columns — one row per line item, for every transaction document

**What this is for.** The owner, 2026-09-15: every document list must export
**one row per line item**, the way AutoCount's exports do, and the file must hold
**every row the list's filters match** — never just the page on screen. Staff send
these files to suppliers, customers and others, and use them to chase deliveries,
collections and pending work.

This document proposes the columns, in order, for each document type, says where
each value comes from, and says which columns the future import may change. It is
a **design**, not a build: the only export being built today is the Purchase
Order one, and its columns are the template everything below follows.

> **Built since** (2026-09-15): Delivery Return (§4) and Purchase Return (§7), on the
> grid-driven mechanism, with AutoCount's own Detail Listing columns — read-only
> production proof in `backend/scripts/check-return-line-export.mjs`.

> **Built since** (2026-09-15): Goods Receipt (§5), Purchase Invoice (§6) and
> Sales Invoice (§3) export through the grid-driven mechanism below, with a
> later owner ruling on top: the columns and values are **AutoCount's Detail
> Listing** (captions, order and spellings), not the tables in §3 / §5 / §6. The
> tables stay as the source map for the ERP's own columns, which sit hidden in
> each grid's chooser. What differs is listed in
> [§ What the GR / PI / SI builds changed](#what-the-gr--pi--si-builds-changed);
> Sales Order (§1) and Delivery Order (§2) export through the same grid-level Export
> (`GET /<doc>/export/rows`, read in windows of 500; the Sales Orders list is wired, the
> Delivery Orders list in its own PR) — differences in
> [§ What the SO / DO builds changed](#what-the-so--do-builds-changed)
> (`docs/modules/sales-order.md`, `delivery-order.md`, *Exports*). For GR / PI / SI
> the module guides (`docs/modules/grn.md`, `purchase-invoice.md`,
> `sales-invoice.md`, *The one Export*) describe the build. Import is
> desktop-only by the owner's decision (「手机不需要导入」, 2026-09-15).

> Status of the facts in here: every count was measured on **production**
> (Supabase project `anogrigyjbduyzclzjgn`) through a **read-only transaction**
> on 2026-09-15 between 04:04 and 04:15 UTC. The data is live and moves while
> you read it — two delivery orders received their AutoCount number between two
> of the reads. Re-run the queries in [§ How the counts were measured](#how-the-counts-were-measured)
> before quoting a number. Labels: **PROVEN** = measured or read in the running
> schema; **LIKELY** = read in code, not observed; **UNKNOWN** = not settled.

---

## The grid-driven mechanism (2026-09-15) — how every list exports by line

Owner 2026-09-15: ONE Export per list, one row per line, the columns the grid
shows (hidden columns are not exported), following the grid's filter and view.
Built once in `DataTable`; each list plugs in.

- **Column** (`frontend/src/components/DataTable.tsx`, `Column<T, L>`):
  `lineValue(row, line)` is the cell for one line (blank on a document with no
  lines); `exportValue(row)` is a document value for the file when it differs
  from `getValue` (money in ringgit where `getValue` holds sen for sorting);
  `exportFormat` is `text | number | money | rate | date` (date = a real Excel
  date cell shown yyyy/mm/dd; money #,##0.00; rate up to 4 decimals). A column
  with neither `lineValue` nor `exportValue` repeats its `getValue` on each line.
- **DataTable prop** `exportLines = { fetchRows({ exportKeys, filterKeys }),
  linesOf(row), sheetName, onError }`. `fetchRows` returns EVERY row the list's
  server filter matches (all pages), each with its lines, and throws to refuse
  (for example when the server says `truncated`). The toolbar Export then
  applies the grid's funnels and sort with the SAME functions the grid uses
  (`frontend/src/components/dataTableRows.ts`: `applyColumnFilters`,
  `sortTableRows`) and writes `<exportName>-YYYY-MM-DD.xlsx` through
  `frontend/src/components/dataTableLineExport.ts`. A line column should give
  `getFilterValues` every line's value, so a funnel keeps a document when ANY
  line matches.
- **Server contract** per document: `GET /<doc-route>/export/rows` with the list's
  query parameters and no `page`, answering
  `{ <docs>: Array<ListRow & { lines }>, total, lineCount, truncated }`. Read
  through the list's own filter and sort, page headers past the PostgREST
  ceiling, read lines by header id with the company predicate on the line read
  too, and attach them with the SAME function the list page endpoint uses.
- Without `exportLines`, the CSV export is unchanged except that `exportValue` is
  honoured.

## 0. Rules that apply to every document

1. **One row per line.** The document's header values (number, date, party,
   salesperson…) repeat on every line of that document.
2. **Every matched row.** The export reads every document the list's current
   filters and tab match, then every line of those documents. Today's list
   exports do not do this (see §0.2).
3. **Money** is a number in ringgit, so Excel can add it up (stored as sen ÷ 100).
   A unit price keeps up to 4 decimals, a total 2 — the same as the PO export.
4. **Dates** are written `YYYY-MM-DD`, so the sheet sorts them and the import
   reads them back without guessing day/month — the same as the PO export.
5. **Cost and margin are never exported.** These files go to outsiders. The
   finance-only columns on the screens (unit cost, line cost, margin) stay off.
6. **Line ID is always the last column.** It is the line table's `id` (a uuid).
   The import matches rows by it and nothing else.
7. **Location** is AutoCount's SHORT code (`KL`, not the ERP's `KL WAREHOUSE`) —
   owner 2026-09-15 (Q2). The PO export resolves it through the write-back's own
   `bookSpellingOrOwn(code ?? name, LOCATION_MAP)`.
8. **2990's Home (company 2) never syncs to AutoCount**, so its
   "AutoCount Doc No" is blank by design — PROVEN: 175 of 175 of its sales orders,
   65 of 65 delivery orders, 110 of 110 purchase orders, 68 of 68 goods receipts,
   56 of 56 purchase invoices and 10 of 10 sales invoices have none.
   Every Houzs Century (company 1) document of those six types has one.
9. **Item Code, Item Description, Item Group and UOM as the book holds them**
   (2026-09-15): `bookLineItem` in `backend/src/services/autocount-book-item.ts`,
   shared by every document export. Item Code is the write-back's
   `resolveAcItemCode`; Description, Item Group and UOM come from the AutoCount
   item master snapshot (`backend/scripts/data/ac-item-master.tsv`, written
   read-only by `export-ac-item-master.py`, compiled by
   `gen-autocount-item-master.mjs`, CI `audit:ac-item-master`), falling back to the
   ERP's own values. PROVEN on the live book 2026-09-15 by AutoCount item code:
   Item.ItemGroup equals the listed group on 61,818 / 61,818 SO lines and
   47,928 / 47,928 DO lines; BaseUOM equals the line UOM on 61,795 / 61,818 and
   47,906 / 47,928. Re-export when items are opened in AutoCount.

### 0.1 The Purchase Order template (not changed here)

Doc No, AutoCount Doc No, Doc Date, Status, Supplier Code, Supplier Name,
SO Doc No., Item Code, Supplier SKU, Item Description, Item Description 2,
Remarks, Category, Location, Qty, Received Qty, Remaining Qty, Unit Price,
Line Total, Delivery Date, Estimate Delivery Date 1, Estimate Delivery Date 2,
Estimate Delivery Date 3, Line ID.

It matches the one line-level AutoCount export this repo records:
`reference/PO_Outstanding.gs` pulls AutoCount's outstanding PO lines as
Doc No, SO Doc No, Creditor Code/Name, Item Code, Item Description,
Item Description 2, Location, Item Group, Doc Date, Remaining Qty, Delivery Date,
Supplier Delivery Date 1–3 (LIKELY — read in the script, not run).

The names below reuse the PO header words wherever the meaning is the same
(`Category` for the item group, `Remarks` for the line remark), so a person who
knows one file can read all of them. On sales documents the party columns are
`Customer Code` / `Customer Name` instead of `Supplier …`.

### 0.2 What the list exports do today (why this is needed)

LIKELY (read in code, not clicked):

- The main lists export through `frontend/src/components/DataTable.tsx`
  (`handleExport`): a **CSV of the header rows on the loaded page only**, visible
  columns only. The Sales Order, Delivery Order, Sales Invoice, Delivery Return,
  Purchase Order, Goods Receipt and Purchase Invoice lists are paged on the
  server (default 50 per page), so the file holds one page.
- The purchase-return list reads at most the newest **300** returns
  (`backend/src/scm/routes/purchase-returns.ts`, `.limit(300)`); the stock
  adjustment list asks for no limit and gets the server default of **200**
  (`backend/src/scm/routes/inventory.ts`). An export built on those reads would
  inherit the cap.
- Four line-level **Detail Listing** reports already exist —
  `frontend/src/pages/scm-v2/SalesOrderDetailListing.tsx`,
  `DeliveryOrderDetailListing.tsx`, `SalesInvoiceDetailListing.tsx`,
  `DeliveryReturnDetailListing.tsx` — backed by
  `backend/src/scm/routes/reports.ts`. They read **all** matching lines and export
  an `.xlsx` of what is filtered. They are the closest thing to what the owner
  asked for, but they are separate report pages (not the lists), they carry no
  Line ID and no delivered/remaining quantities, and several columns are
  AutoCount placeholders that always print a constant (Inclusive? "Yes",
  Detail Tax Code "SR", Creditor Code "—").
- The six consignment lists export `.xlsx` through
  `frontend/src/components/DataGridCompat.tsx` (DataTable's plain `.xlsx`
  export), one row per document.

### 0.3 Which columns the import may change (owner's ruling)

Only **Delivery Date**, **Estimate Delivery Date 1/2/3**, **Item Description 2**
and **Remarks**, matched by **Line ID**, with a preview before anything is saved.
Every document section ends with which of those four exist on that document.
Summary:

| Document | Delivery Date | Estimate Dates 1–3 | Item Description 2 | Remarks |
|---|---|---|---|---|
| Purchase Order (template) | yes | yes | yes | yes |
| Sales Order | yes | **no column** | yes | yes (see Q7) |
| Delivery Order | yes | no column | yes | yes |
| Sales Invoice | yes | no column | yes | yes |
| Delivery Return | no column | no column | yes | yes |
| Goods Receipt | yes | no column | yes | yes |
| Purchase Invoice | no column | no column | yes | yes |
| Purchase Return | no column | no column | yes | yes |
| Consignment Order / Note | yes | no column | yes | yes |
| Consignment Return | no column | no column | yes | yes |
| Purchase Consignment Order | yes | yes | yes | yes |
| Purchase Consignment Receive | yes | no column | yes | yes |
| Purchase Consignment Return | no column | no column | yes | yes |
| Stock Transfer / Take / Adjustment | **proposed read-only** — posted stock records | | | |

Two cautions that apply to every AutoCount-synced document (SO, PO, DO, SI, GR,
PI): an edited line is sent to AutoCount again, and the write-back sends the
whole document, not one field. And the write-back composes AutoCount's
`Desc2` from the line's variants (`composeDescription2` in
`backend/src/services/autocount-writeback.ts`), so an imported Item Description 2
may not be what AutoCount shows (LIKELY; see Q1).

---

## 1. Sales Order

Tables: `scm.mfg_sales_orders` (header, keyed by `doc_no` + `company_id`) and
`scm.mfg_sales_order_items` (lines, joined by `doc_no` + `company_id` — there is
no header uuid). Production: **3,132 orders, 16,219 lines**; 16,208 lines sit on
an order that is not cancelled (PROVEN).

Screens: the list (`MfgSalesOrdersListV2.tsx`), the Sales Order Detail Listing,
and the detail page line grid (Item, Qty, Unit price, Disc, Amount, Remark,
Stock, Incoming PO). AutoCount: `SO` header `DocNo, DocDate, DebtorCode,
DebtorName, SalesAgent, SalesLocation, Ref, UDF_BRANDING, UDF_VENUE, UDF_PDate`;
lines `ItemCode, Description, Desc2, Qty, UnitPrice, Location, DeliveryDate`.

| # | Group | Column | Source | Notes (PROVEN counts unless marked) |
|---|---|---|---|---|
| 1 | identity | Doc No | `h.doc_no` | |
| 2 | identity | AutoCount Doc No | `h.linked_ac_docno` | set on 2,957 / 2,957 Houzs orders |
| 3 | identity | Doc Date | `h.so_date` | |
| 4 | identity | Status | `h.status`, shown with the screen word (`CONFIRMED` → Submitted) | see Q9 |
| 5 | identity | Customer Code | `h.debtor_code` | |
| 6 | identity | Customer Name | `h.debtor_name` — the **header**, never the line copy | the line copy differs from the header on 36 lines |
| 7 | identity | Customer Ref | `h.customer_so_no`, else `h.ref` (the screen's `refOf`) | |
| 8 | line | Item Code | `i.item_code` | |
| 9 | line | Item Description | `i.description` | |
| 10 | line | Item Description 2 | `i.description2` | empty on 10,688 of the 15,284 lines still to deliver; for 128 lines in all the screen can build a text from the variants, the other empties have nothing to build from |
| 11 | line | Remarks | `i.remark` | 4,323 of the 4,560 non-empty remarks hold the account book's words (`账本原文: …`) — Q7 |
| 12 | line | Category | `i.item_group` | accessory, mattress, bedframe, sofa, service, fabric_accessory, others, dining |
| 13 | line | Location | `warehouses.code` via `i.warehouse_id`, else `i.location` | `i.location` holds AutoCount's short code (`KL`) and never equals the warehouse code (`KL WAREHOUSE`) on 15,217 lines where both are set; 138 live lines have no warehouse |
| 14 | line | UOM | `i.uom` | |
| 15 | line | Qty | `i.qty` | |
| 16 | line | Delivered Qty | Σ `delivery_order_items.qty` linked by `so_item_id`, on delivery orders that have **shipped** (not DRAFT, LOADED or CANCELLED), plus unlinked delivery lines attributed by item code | the app's own reading: `soDeliverableRemaining` → `netDeliveredBySoItem` (`backend/src/scm/lib/do-unlinked-coverage.ts`) |
| 17 | line | Returned Qty | Σ `delivery_return_items.qty_returned` on non-cancelled returns, traced through the delivery line | 0 today (the only return is cancelled) |
| 18 | line | Remaining Qty | Qty − Delivered + Returned | 15,284 of 16,208 live lines > 0 (linked lines only; the app's unlinked attribution can only lower this); 8 lines < 0 |
| 19 | line | On Delivery Order Qty | Σ qty on DRAFT/LOADED delivery orders — loaded, not yet shipped | 554 lines |
| 20 | line | Stock Status | `i.stock_status` | PENDING 13,129 · READY 3,078 · PARTIAL 12 (all lines) |
| 21 | money | Unit Price | `i.unit_price_sen` ÷ 100 | 0 on 12,335 of 16,219 lines — the price sits on some lines of a set; lines add up to the header total on 3,132 / 3,132 orders |
| 22 | money | Discount | `i.discount_sen` ÷ 100 | |
| 23 | money | Line Total | `i.total_sen` ÷ 100 | |
| 24 | money | Doc Balance | `h.balance_sen` ÷ 100 (repeats per line) | **not** `i.balance_sen`: that column equals the line total on 16,219 / 16,219 lines, so it is not a balance |
| 25 | follow-up | Delivery Date | `i.line_delivery_date`, else `h.customer_delivery_date` | of the 15,284 lines still to deliver: 11,892 have no line date and 11,882 have no date on either — the chase list will be mostly blank here |
| 26 | follow-up | Processing Date | `h.processing_date` | empty for 11,862 of those 15,284 lines |
| 27 | people/place | Salesperson | `staff.name` via `h.salesperson_id`, else `h.agent` | resolves on 3,129 / 3,132 orders |
| 28 | people/place | Branding | `h.branding` | line copy differs on 273 lines — use the header |
| 29 | people/place | Venue | `h.venue` | line copy differs on 282 lines — use the header |
| 30 | people/place | Sales Location | `h.sales_location` | |
| 31 | people/place | Phone | `h.phone` | |
| 32 | people/place | Delivery Address | `h.delivery_address1..4`, else `h.address1..4`, joined | |
| 33 | people/place | State | `h.customer_state` | |
| 34 | links | DO No. | distinct `delivery_orders.do_number` of non-cancelled delivery lines linked to this line, joined `, ` | |
| 35 | links | PO No. | distinct `purchase_orders.po_number` of non-cancelled PO lines with `so_item_id` = this line | 1,435 lines have one |
| 36 | links | PO Delivery Date | earliest `purchase_order_items.delivery_date` of those PO lines | set for 1,404 of the 1,435 |
| 37 | | Line ID | `i.id` | |

Import-editable here: **Delivery Date** (`line_delivery_date`),
**Item Description 2**, **Remarks**. There are **no estimate delivery dates** on a
sales order (Q4).

---

## 2. Delivery Order

Tables: `scm.delivery_orders` + `scm.delivery_order_items`
(`delivery_order_id`). Production: **343 delivery orders** (DELIVERED 213,
LOADED 126, CANCELLED 4) and **1,525 lines**, 1,507 on a non-cancelled order.

Screens: the list, the Delivery Order Detail Listing (DO No., Date, Transfer From
(SO), Customer, Driver, Vehicle, City, State, Expected, Item Code, Description,
Item Group, UOM, Qty, m³, Unit Price, Discount, Line Total, Status), the detail
grid (Item, Type, Qty to deliver, Delivery date). AutoCount: converted from the SO
(`/so-to-do`); same line fields as the SO.

| # | Group | Column | Source | Notes |
|---|---|---|---|---|
| 1 | identity | Doc No | `h.do_number` | |
| 2 | identity | AutoCount Doc No | `h.linked_ac_docno` | set on 278 / 278 Houzs orders |
| 3 | identity | Doc Date | `h.do_date` | |
| 4 | identity | Status | `h.status` with the screen word (`LOADED` → Confirmed, `DISPATCHED` → Loaded) | |
| 5 | identity | Customer Code | `h.debtor_code` | |
| 6 | identity | Customer Name | `h.debtor_name` | |
| 7 | identity | Customer Ref | `h.customer_so_no`, else `h.ref` | |
| 8 | line | Item Code | `i.item_code` | |
| 9 | line | Item Description | `i.description` | |
| 10 | line | Item Description 2 | `i.description2` | empty on 979 of 1,507 live lines |
| 11 | line | Remarks | `i.notes` | empty on 1,501 of 1,507; not shown on any DO screen today |
| 12 | line | Category | `i.item_group` | |
| 13 | line | Location | `warehouses.code` via `h.warehouse_id`, else `h.sales_location` | the delivery warehouse lives on the DO header; 170 of 343 headers have no warehouse, `sales_location` is set on all 343 |
| 14 | line | UOM | `i.uom` | |
| 15 | line | Qty | `i.qty` | |
| 16 | line | Invoiced Qty | Σ `sales_invoice_items.qty` by `do_item_id`, non-cancelled invoices | |
| 17 | line | Returned Qty | Σ `delivery_return_items.qty_returned` by `do_item_id`, non-cancelled returns | 0 today |
| 18 | line | Uninvoiced Qty | Qty − Invoiced | > 0 on 735 of 953 lines of DELIVERED orders, 388 of 554 of LOADED |
| 19 | line | m³ | `i.m3_milli` ÷ 1000 | on the Detail Listing today; useful for lorry planning |
| 20 | money | Unit Price | `i.unit_price_sen` ÷ 100 | the DO detail page shows no price — Q3 |
| 21 | money | Discount | `i.discount_sen` ÷ 100 | |
| 22 | money | Line Total | `i.line_total_sen` ÷ 100 | |
| 23 | follow-up | Delivery Date | `i.line_delivery_date`, else `h.customer_delivery_date` | line empty on 454 of 1,507 live lines; empty on both for 5 |
| 24 | follow-up | Expected Delivery | `h.expected_delivery_at` | |
| 25 | follow-up | Delivered On | `h.delivered_at` (date part) | set on 41 of 213 DELIVERED orders |
| 26 | people/place | Salesperson | `staff.name` via `h.salesperson_id`, else `h.agent` | resolves on 343 / 343 |
| 27 | people/place | Branding | `h.branding` | |
| 28 | people/place | Venue | `h.venue` | |
| 29 | people/place | Driver | `h.driver_name` | **empty on 343 / 343**; `scm.delivery_order_crew` has 0 rows and no trip stop names a DO — Q8 |
| 30 | people/place | Vehicle | `h.vehicle` | **empty on 343 / 343** — Q8 |
| 31 | people/place | Phone | `h.phone` | |
| 32 | people/place | Delivery Address | `h.address1`, `h.address2`, `h.city`, `h.postcode` joined | |
| 33 | people/place | State | `h.state` | |
| 34 | links | SO Doc No. | the SO line's `doc_no` via `i.so_item_id`, else `h.so_doc_no` | only 3 live lines lack the link |
| 35 | links | Invoice No. | distinct `sales_invoices.invoice_number` via `do_item_id` | |
| 36 | | Line ID | `i.id` | |

Import-editable here: **Delivery Date** (`line_delivery_date`), **Item
Description 2**, **Remarks** (`notes`). No estimate dates. Note: the header
delivery date cascades to the lines (`docs/modules/delivery-order.md`, "The header
delivery date CASCADES to the lines"), so a line date imported here can be
overwritten by a later header edit.

---

## 3. Sales Invoice

Tables: `scm.sales_invoices` + `scm.sales_invoice_items` (`sales_invoice_id`).
Production: **82 invoices** (SENT 78, PAID 3, CANCELLED 1), **371 lines**.

Screens: the list, the Sales Invoice Detail Listing (Invoice No., Date, Due,
Transfer From (SO), Customer, Item Code, Description, Item Group, UOM, Qty, Unit
Price, Discount, Line Total, Invoice Total, Paid, Balance, Status), the detail grid
(Item, Delivery, Qty, Unit price, Disc, Amount). AutoCount: `IV`, converted from
the DO (`/do-to-iv`).

| # | Group | Column | Source | Notes |
|---|---|---|---|---|
| 1 | identity | Doc No | `h.invoice_number` | |
| 2 | identity | AutoCount Doc No | `h.linked_ac_docno` | set on 72 / 72 Houzs invoices |
| 3 | identity | Doc Date | `h.invoice_date` | |
| 4 | identity | Status | `h.status` with the screen word (`SENT` → Submitted) | |
| 5 | identity | Customer Code | `h.debtor_code` | |
| 6 | identity | Customer Name | `h.debtor_name` | |
| 7 | identity | Customer Ref | `h.customer_so_no`, else `h.ref` | |
| 8 | line | Item Code | `i.item_code` | |
| 9 | line | Item Description | `i.description` | |
| 10 | line | Item Description 2 | `i.description2` | empty on 236 of 367 live lines |
| 11 | line | Remarks | `i.notes` | empty on all 371; not on any SI screen |
| 12 | line | Category | `i.item_group` | |
| 13 | line | Location | the DO header's warehouse code, via `i.do_item_id` | the invoice has no warehouse of its own |
| 14 | line | UOM | `i.uom` | |
| 15 | line | Qty | `i.qty` | |
| 16 | money | Unit Price | `i.unit_price_sen` ÷ 100 | |
| 17 | money | Discount | `i.discount_sen` ÷ 100 | |
| 18 | money | Line Total | `i.line_total_sen` ÷ 100 | |
| 19 | money | Invoice Total | `h.total_sen` ÷ 100 (repeats) | |
| 20 | money | Paid | `h.paid_sen` ÷ 100 (repeats) | |
| 21 | money | Balance | max(total − paid − SO deposit applied, 0), per invoice | the Detail Listing's rule (`reports.ts`, `stampOrderDeposit`); 348 of 367 live lines sit on an invoice with total > paid |
| 22 | follow-up | Delivery Date | `i.line_delivery_date` | empty on 202 of 367 live lines |
| 23 | follow-up | Due Date | `h.due_date` | **empty for 359 of 367 live lines** — a collection chase has no due date to sort on (Q10) |
| 24 | follow-up | Overdue Days | today − Due Date, when Balance > 0 | blank while Due Date is blank |
| 25 | people/place | Salesperson | `staff.name` via `h.salesperson_id`, else `h.agent` | `salesperson_id` set on 177 of 371 lines' invoices |
| 26 | people/place | Branding | `h.branding` | |
| 27 | people/place | Venue | `h.venue` | |
| 28 | people/place | Phone | `h.phone` | |
| 29 | links | SO Doc No. | `h.so_doc_no` | |
| 30 | links | DO No. | `delivery_orders.do_number` via `i.do_item_id` | resolves on 371 / 371; `i.so_item_id` is empty on all 371, so go through the DO line |
| 31 | | Line ID | `i.id` | |

Import-editable here: **Delivery Date** (`line_delivery_date`), **Item
Description 2**, **Remarks** (`notes`). No estimate dates.

---

## 4. Delivery Return (sales return)

> **BUILT 2026-09-15** on the grid-driven mechanism above. `GET /delivery-returns/export/rows`
> (`backend/src/scm/routes/delivery-return-exports.ts`, builder
> `buildDeliveryReturnExportRows` in `backend/src/scm/lib/delivery-return-list-read.ts`),
> the list `frontend/src/pages/scm-v2/DeliveryReturnsListV2.tsx`, the column contract
> `backend/src/scm/lib/return-line-export-columns.ts` (`DR_LINE_COLUMNS`, mirrored in
> `frontend/src/vendor/scm/lib/`). This section replaces the proposal that stood here.

Tables: `scm.delivery_returns` + `scm.delivery_return_items` (`delivery_return_id`).
Production, read-only at 2026-09-15 09:25 UTC: **company 1 HOUZS 0 returns; company 2
2990 1 return (CANCELLED) with 2 lines** (PROVEN, `backend/scripts/check-return-line-export.mjs`).

**AutoCount HAS this document, and the ERP does not sync it.** The earlier line here
("no AutoCount mapping exists") is right about the ERP — the outbox accepts SO, PO,
DO, IV, GR and PI only — but the book itself holds Delivery Returns: `DR` / `DRDTL` in
AED_HOUZS, **87 documents / 113 lines, 2024-09-03 .. 2026-08-21** (PROVEN, read-only
2026-09-15 16:12 MYT). None is in the ERP (company 1 has 0 returns).

**The columns ARE AutoCount's.** AutoCount Accounting 2.2's own "Print Delivery Return
Detail Listing" grid, read from the installed program's embedded form resources
(`AutoCount.Sales.dll`, `AutoCount.Invoicing.Sales.DeliveryReturn.FormDeliveryReturnPrintDetailListing.resources`:
each column's `Caption` and `VisibleIndex`). The book's `Layout` table holds no saved
layout for that form, so every AutoCount user sees these defaults (PROVEN). They are the
grid's DEFAULT visible columns, in this order:

| # | Label (AutoCount caption) | Level | ERP value | AutoCount's own values on its 113 DR lines |
|---|---|---|---|---|
| 1 | Doc No | doc | `return_number` | |
| 2 | Doc Date | doc | `return_date` (Excel date, yyyy/mm/dd) | |
| 3 | Debtor Code | doc | `debtor_code` | |
| 4 | Debtor Name | doc | `debtor_name` | |
| 5 | Agent | doc | HOUZS: the write-back's `resolveAcAgent(agent, salesperson name)`; 2990: salesperson name, else `agent` | |
| 6 | Curr. Code | doc | `currency` | MYR on 113 |
| 7 | Curr. Rate | doc | 1 when MYR, else blank (a return stores no rate) | 1 |
| 8 | Inclusive? | doc | blank — the ERP holds no tax setting | T on 110 of 113 |
| 9 | SubTotal (Ex) | doc | `local_total_sen` ÷ 100 | |
| 10 | Tax | doc | 0 — a return carries no tax in the ERP | 0 on 113 |
| 11 | Total | doc | `local_total_sen` ÷ 100 | |
| 12 | Local Total | doc | `local_total_sen` ÷ 100 | |
| 13 | Cancelled | doc | Yes / No from `status` | F on 113 |
| 14 | Item Code | line | HOUZS: `bookLineItem` (the write-back's item resolver + the book's item master); 2990: `item_code` | |
| 15 | Detail Description | line | HOUZS: the book item's description, else `description`; 2990: `description` | |
| 16 | UOM | line | HOUZS: the book item's base UOM, else `uom`; 2990: `uom` | |
| 17 | Location | line | the warehouse the line went back into, by the stock rule (SO line's warehouse via the DO line, else the DO's, else the return's) as AutoCount's short code (`LOCATION_MAP`) | KL 80, PG 28, SRW 4, SBH 1 |
| 18 | Proj No | line | blank | blank on 113 |
| 19 | Dept No | line | blank | blank on 113 |
| 20 | Batch No. | line | blank | blank on 113 |
| 21 | Qty | line | `qty_returned` | |
| 22 | Unit Price | line | `unit_price_sen` ÷ 100 (rate) | |
| 23 | Discount | line | `discount_sen` ÷ 100 | blank on 113 |
| 24 | Total | line | `line_total_sen` ÷ 100 | |
| 25 | Tax Code | line | blank | blank on 113 |
| 26 | Tax | line | 0 | 0 on 113 |
| 27 | Total (Ex) | line | `line_total_sen` ÷ 100 | |
| 28 | Total (Inc) | line | `line_total_sen` ÷ 100 | |
| 29 | Serial No. List | line | blank | blank on 113 |

AutoCount itself captions the document total and the line total both "Total", and the
document tax and the line tax both "Tax"; the file keeps its captions.

In the chooser, hidden by default (ERP facts; AutoCount captions where the same form has
one): Status (the word on screen), Ref (the list's customer ref), Reason, Note, DO No.
(`do_doc_no`), SO Doc No. (the DO line's SO line, else the DO's), Detail Description 2
(composed from the line's variants by `buildVariantSummary`, the stored `description2`
only when the variants compose nothing), Remarks (`notes`), Item Group (the book item's,
2990: `item_group`), Condition, Line ID; and the list's own columns: Salesperson, Sales
Location, Branding / Venue (HOUZS: `BRANDING_MAP` / `VENUE_MAP` in the file), Phone,
Email, Address 1/2, City, Postcode, State, Customer Type, Building Type, and for a
finance viewer the category and cost columns (ringgit in the file).

A sofa is one row per ERP line (owner 2026-09-15), not AutoCount's one collapsed line:
2990-DR-2608-001 exports XAMMAR-L(LHF) and XAMMAR-2A(RHF) as two rows (PROVEN).

Filters: the list's server read is company + SALES SCOPE + `status`; the tab and search
filter in the browser, and the export applies the same predicate
(`deliveryReturnsInView`) to every row the server returns. The screen read stops at 500;
the export does not.

---

## 5. Goods Receipt (GRN)

Tables: `scm.grns` + `scm.grn_items` (`grn_id`). Production: **610 receipts**
(all POSTED), **1,226 lines**.

Screens: the list (GRN No., Received, Transfer From (PO), Assigned SO, Delivered,
Supplier, Code, Delivery note, Status, Value); the detail grid (Item, Supplier SKU,
PO, Ordered, Received, Remark, ETA, Unit cost, Amount). AutoCount: `GR`, converted
from the PO (`/po-to-gr`); header `DocNo, DocDate, SupplierDONo, PurchaseLocation`;
line `ItemCode, Description, Desc2, Qty (= accepted qty), UnitPrice, Location`.

| # | Group | Column | Source | Notes |
|---|---|---|---|---|
| 1 | identity | Doc No | `h.grn_number` | |
| 2 | identity | AutoCount Doc No | on a migrated receipt (`h.migrated_no_stock`): `h.linked_ac_gr_docno`; otherwise `h.linked_ac_docno` | **`linked_ac_docno` holds the AutoCount PURCHASE ORDER number on every migrated receipt** (migration `20260907T2345_grn_linked_ac_gr_docno.sql`). PROVEN by prefix: 473 migrated receipts carry `PO-…` there; 400 of them have the GR number in `linked_ac_gr_docno`, **73 have no GR number anywhere**; the 69 receipts the ERP created carry `HC-GRN-…` in `linked_ac_docno` |
| 3 | identity | Doc Date | `h.received_at` | |
| 4 | identity | Status | `h.status` with the screen word (`POSTED` → Submitted) | |
| 5 | identity | Supplier Code | `suppliers.code` via `h.supplier_id` | |
| 6 | identity | Supplier Name | `suppliers.name` | |
| 7 | identity | Supplier DO No. | `h.delivery_note_ref` | empty for 853 of 1,226 lines |
| 8 | line | Item Code | `i.item_code` | |
| 9 | line | Supplier SKU | `i.supplier_sku` | empty on 282 |
| 10 | line | Item Description | `i.material_name` (as the PO export), `i.description` is empty on 1,207 of 1,226 | |
| 11 | line | Item Description 2 | `i.description2` | empty on 490 |
| 12 | line | Remarks | `i.notes` | empty on 1,139 |
| 13 | line | Category | `i.item_group` | empty on 59 |
| 14 | line | Location | `warehouses.code` via `h.warehouse_id` | set on 610 / 610 |
| 15 | line | UOM | `i.uom` | |
| 16 | line | Received Qty | `i.qty_accepted` | AutoCount's GR Qty is the accepted qty; received = accepted on 1,226 / 1,226 today, rejected is 0 |
| 17 | line | Invoiced Qty | Σ `purchase_invoice_items.qty` by `grn_item_id`, invoices not CANCELLED/VOID | the stored `i.invoiced_qty` disagrees with that sum on 69 lines, all on migrated receipts, the stored value always the larger — Q11 |
| 18 | line | Returned Qty | `i.returned_qty` | 0 on all 1,226 |
| 19 | line | Uninvoiced Qty | Received − Invoiced − Returned | > 0 on 602 lines by the sum, 533 by the stored column |
| 20 | money | Currency | `h.currency` | |
| 21 | money | Unit Price | `i.unit_price_sen` ÷ 100 | |
| 22 | money | Discount | `i.discount_sen` ÷ 100 | |
| 23 | money | Line Total | `i.line_total_sen` ÷ 100 | |
| 24 | follow-up | Delivery Date | `i.delivery_date` (the screen calls it ETA) | empty on 1,204 of 1,226 |
| 25 | links | PO No. | `purchase_orders.po_number` via `i.purchase_order_item_id` | 1,139 of 1,226 lines link |
| 26 | links | SO Doc No. | the SO number of that PO line's `so_item_id` | 905 of 1,226 |
| 27 | links | Invoice No. | distinct `purchase_invoices.invoice_number` by `grn_item_id` | |
| 28 | | Line ID | `i.id` | |

Import-editable here: **Delivery Date** (`delivery_date`), **Item Description 2**,
**Remarks** (`notes`). No estimate dates on a receipt line (they live on the PO).

---

## 6. Purchase Invoice

Tables: `scm.purchase_invoices` + `scm.purchase_invoice_items`
(`purchase_invoice_id`). Production: **252 invoices** (POSTED 233, PAID 19),
**653 lines**.

Screens: the list (PI No., Date, Due, Source, Assigned SO, Delivered, Supplier,
Code, Status, Owed, vs PO price, Total); the detail grid (Item, Supplier SKU, PO,
Qty, Remark, PO price, PI price, Amount). AutoCount: `PI`, converted from the GR
(`/gr-to-pi`); header `DocDate, SupplierInvoiceNo`.

| # | Group | Column | Source | Notes |
|---|---|---|---|---|
| 1 | identity | Doc No | `h.invoice_number` | |
| 2 | identity | AutoCount Doc No | `h.linked_ac_docno` | set on 196 / 196 Houzs invoices |
| 3 | identity | Doc Date | `h.invoice_date` | |
| 4 | identity | Status | `h.status` with the screen word | |
| 5 | identity | Supplier Code | `suppliers.code` | |
| 6 | identity | Supplier Name | `suppliers.name` | |
| 7 | identity | Supplier Invoice No. | `h.supplier_invoice_ref` | **empty for 524 of 653 lines** |
| 8 | line | Item Code | `i.item_code` | |
| 9 | line | Supplier SKU | the GRN line's `supplier_sku` via `i.grn_item_id` | the invoice line has no SKU column |
| 10 | line | Item Description | `i.material_name` | `i.description` is empty on all 653 |
| 11 | line | Item Description 2 | `i.description2` | empty on 340 |
| 12 | line | Remarks | `i.notes` | empty on all 653 |
| 13 | line | Category | `i.item_group` | |
| 14 | line | Location | the GRN header's warehouse code via `i.grn_item_id` | the invoice has no warehouse |
| 15 | line | UOM | `i.uom` | |
| 16 | line | Qty | `i.qty` | |
| 17 | money | Currency | `h.currency` | |
| 18 | money | PO Unit Price | `i.po_unit_price_sen` ÷ 100 | empty on 29 |
| 19 | money | Unit Price | `i.unit_price_sen` ÷ 100 | |
| 20 | money | Discount | `i.discount_sen` ÷ 100 | |
| 21 | money | Line Total | `i.line_total_sen` ÷ 100 | |
| 22 | money | Invoice Total | `h.total_sen` ÷ 100 | |
| 23 | money | Balance | (`h.total_sen` − `h.paid_sen`) ÷ 100 | 609 of 653 lines on an invoice with a balance |
| 24 | follow-up | Due Date | `h.due_date` | **empty for 520 of 653 lines** (Q10) |
| 25 | follow-up | Overdue Days | today − Due Date, when Balance > 0 | |
| 26 | links | GRN No. | `grns.grn_number` via `i.grn_item_id` | 624 of 653 link |
| 27 | links | PO No. | via the GRN line's `purchase_order_item_id` | 624 of 653 |
| 28 | links | SO Doc No. | via that PO line's `so_item_id` | |
| 29 | | Line ID | `i.id` | |

Import-editable here: **Item Description 2**, **Remarks** (`notes`). No delivery or
estimate date on an invoice line.

---

## 7. Purchase Return

> **BUILT 2026-09-15** on the grid-driven mechanism above. `GET /purchase-returns/export/rows`
> (`backend/src/scm/routes/purchase-return-exports.ts`, builder
> `buildPurchaseReturnExportRows` in `backend/src/scm/lib/purchase-return-list-read.ts`),
> the list `frontend/src/pages/scm-v2/PurchaseReturnsListV2.tsx`, the column contract
> `PR_LINE_COLUMNS` in `return-line-export-columns.ts`. This section replaces the
> proposal that stood here.

Tables: `scm.purchase_returns` + `scm.purchase_return_items` (`purchase_return_id`).
Production, read-only at 2026-09-15 09:25 UTC: **0 returns, 0 lines in both companies**
(PROVEN; the export and SQL both answer 0). Not synced to AutoCount by the ERP; the book
holds its own: `PR` / `PRDTL` in AED_HOUZS, **4 documents / 5 lines, 2024-01-27 ..
2025-10-28** (PROVEN, read-only 2026-09-15 16:12 MYT).

The columns are AutoCount Accounting 2.2's "Print Purchase Return Detail Listing"
(`AutoCount.Purchase.dll`, `FormPurchaseReturnPrintDetailListing.resources`; no saved
layout in the book), the grid's DEFAULT visible columns in this order:

| # | Label | Level | ERP value | AutoCount's own values on its 5 PR lines |
|---|---|---|---|---|
| 1 | Doc No | doc | `return_number` | |
| 2 | Doc Date | doc | `return_date` | |
| 3 | Creditor Code | doc | `suppliers.code` | |
| 4 | Creditor Name | doc | `suppliers.name` | |
| 5 | Agent | doc | blank — a purchase return has no agent in the ERP | blank on 4 |
| 6 | Curr. Code | doc | the source GRN's `currency` | MYR |
| 7 | Curr. Rate | doc | 1 when MYR, else blank | 1 |
| 8 | Inclusive? | doc | blank | F on 4 |
| 9 | SubTotal (Ex) | doc | `refund_sen` ÷ 100 | |
| 10 | Tax | doc | 0 | 0 |
| 11 | Total | doc | `refund_sen` ÷ 100 | |
| 12 | Local Total | doc | `refund_sen` ÷ 100 when MYR, else blank | |
| 13 | Rounding Adj. | doc | 0 | 0 |
| 14 | Final Total | doc | `refund_sen` ÷ 100 | |
| 15 | Cancelled | doc | Yes / No | F |
| 16 | Item Code | line | HOUZS: `bookLineItem(…, supplier code)`; 2990: `item_code` | |
| 17 | Detail Description | line | HOUZS: the book item's, else `material_name`, else `description` | |
| 18 | UOM | line | HOUZS: the book item's base UOM, else `uom` | |
| 19 | Location | line | the source GRN line's receipt warehouse, else the return's GRN's, short code | PG, KL, HQ |
| 20–22 | Proj No · Dept No · Batch No. | line | blank | blank |
| 23 | Qty | line | `qty_returned` | |
| 24 | Unit Price | line | `unit_price_sen` ÷ 100 (rate) | |
| 25 | Discount | line | blank — a return line has no discount | "5%" on 2 of 5 |
| 26 | Total | line | `line_refund_sen` ÷ 100 | |
| 27 | Local Total | line | `line_refund_sen` ÷ 100 when MYR, else blank | |
| 28 | Tax Code | line | blank | blank |
| 29 | Tax | line | 0 | 0 |
| 30 | Total (Ex) | line | `line_refund_sen` ÷ 100 | |
| 31 | Total (Inc) | line | `line_refund_sen` ÷ 100 | |
| 32 | Serial No. List | line | blank | blank |
| 33 | Is Rounding Adj. | doc | No | F |

Hidden by default: Status (the word on screen), Supplier C/N No. (`credit_note_ref`),
Reason (the line's, else the return's), GRN No. (via `grn_item_id`, else the return's GRN),
Our PO No. (the GRN line's PO, else the return's), Detail Description 2 (from the
variants, else stored), Remarks (`notes`), Item Group, Line ID.

Filters: company + `status` + `supplierId` on the server; the tab and search in the
browser, applied by the export to every row (`purchaseReturnsInView`). The screen read
stops at 300; the export does not.

---

## 8. Consignment documents

None of the six syncs to AutoCount. They are copies of the owned-stock documents,
so each export is the owned-stock export with the differences below.

| Document | Tables | Production | Export = | Differences |
|---|---|---|---|---|
| Consignment Order | `consignment_sales_orders` / `consignment_sales_order_items` (by `doc_no`) | 0 / 0 | §1 Sales Order | Delivered Qty = Σ `consignment_delivery_order_items.qty` by `consignment_so_item_id`, notes not cancelled; no invoice; no AutoCount Doc No; Customer PO (`customer_po`) added |
| Consignment Note | `consignment_delivery_orders` / `consignment_delivery_order_items` | 0 / 0 | §2 Delivery Order | Returned Qty = Σ `consignment_delivery_return_items.qty_returned` by `consignment_do_item_id`; no Invoiced Qty; link = CO number (`consignment_so_doc_no`) |
| Consignment Return | `consignment_delivery_returns` / `consignment_delivery_return_items` | 0 / 0 | §4 Delivery Return | link = note number (`do_doc_no`) |
| Purchase Consignment Order | `purchase_consignment_orders` / `purchase_consignment_order_items` | 0 / 0 | the PO template | Doc No = `pc_number`; Received Qty = stored `received_qty` (net of returns, recomputed by `recomputePcoReceived`); **has Delivery Date and Estimate Dates 1–3** (`delivery_date`, `supplier_delivery_date_2..4`); no SO link |
| Purchase Consignment Receive | `purchase_consignment_receives` / `purchase_consignment_receive_items` | 4 / 10 | §5 Goods Receipt | Doc No = `receive_number`; Returned Qty = `returned_qty`; no invoice; link = `pc_order_no` (empty on 4 / 4 and `pc_order_item_id` empty on 10 / 10) |
| Purchase Consignment Return | `purchase_consignment_returns` / `purchase_consignment_return_items` | 0 / 0 | §7 Purchase Return | link = receive number via `pc_receive_item_id` |

---

## 9. Stock documents

These move stock and are posted on save. **Proposed: export yes, import no** —
a posted stock record is a ledger entry, and none of them carries a delivery
date or an estimate date anyway. No money columns (their only money is cost).

### 9a. Stock Transfer

`scm.stock_transfers` + `scm.stock_transfer_lines`. Production: 5 transfers
(all POSTED), 22 lines.

Doc No (`transfer_no`) · Doc Date (`transfer_date`) · Status · From Location
(`from_warehouse_id` → code) · To Location (`to_warehouse_id` → code) · Item Code ·
Item Description (`product_name`) · Variant (`variant_key` — empty on 22 / 22) ·
Remarks (`notes` — empty on 22 / 22) · Qty · Created By (`created_by` → name) ·
Line ID.

There is **no Item Description 2 column** on a transfer line; the detail page
shows one but the table cannot hold it (LIKELY always blank on screen).

### 9b. Stock Take

`scm.stock_takes` + `scm.stock_take_lines`. Production: 1 take (OPEN), 344 lines,
`counted_qty` empty on 344 / 344 (nobody has counted yet).

Doc No (`take_no`) · Doc Date (`take_date`) · Status · Location · Scope
(`scope_type` / `scope_value`) · Assignee (`assignee_staff_id` → name) · Item Code ·
Item Description (`product_name`) · Variant (`variant_label`) · System Qty
(`system_qty` — **left blank on a blind take**, as the screen hides it) · Counted Qty ·
Variance · Counted By · Counted On · Remarks (`notes`) · Line ID.

### 9c. Stock Adjustment

**Not a header-and-lines document.** Each adjustment is one row in
`scm.inventory_movements` with `source_doc_type = 'ADJUSTMENT'` (there is no
stock-adjustment table). Production: 12 rows (10 ADJUSTMENT, 2 OUT). The export
row is the movement row:

Doc No (`source_doc_no`) · Doc Date (`movement_date`, else `created_at` — date empty
on 5 of the 10 ADJUSTMENT rows) · Location · Item Code · Item Description
(`product_name`) · Item Description 2 (`description2`) · Variant (`variant_key`) ·
Batch No (`batch_no`) · Qty Change (`qty`, signed) · Reason (`reason_code` — empty
on 12 / 12) · Remarks (`notes`) · Performed By · Line ID (the movement `id`).

The 3,478 `AC_CUTOVER` adjustment rows are the go-live opening balances, not
adjustments staff made; the list filters on `ADJUSTMENT` and so should the export.

---

## 10. Not covered here

Quotes, amendments (SO / PO), cancel requests and the Finance documents (credit
notes, deposit invoices, payment vouchers, receipts, AP invoices) have their own
line tables or none, and were not in the owner's request. See Q12.

---

## Open questions for the owner

1. **Item Description 2 vs AutoCount.** The write-back builds AutoCount's
   `Desc2` from the item's options (fabric, size…), not from the text in the
   ERP's Item Description 2. If staff change Item Description 2 through the
   import, should AutoCount receive the typed text, or keep the built one?
2. **Location wording.** ANSWERED 2026-09-15: AutoCount's short code (`KL`).
3. **Prices on delivery lists.** A Delivery Order file often goes to a driver, a
   3PL or a customer. Keep Unit Price / Discount / Line Total in it, or leave
   money out of the DO export?
4. **Estimate delivery dates on sales documents.** Only the PO (and the
   consignment PO) has Estimate Delivery Date 1–3. Does he want them on the Sales
   Order too? That needs new columns — it is not an export change.
5. **Delivery date: line or document?** A sales order's delivery date is stored
   per line and per order. The import proposal changes the LINE date only. On a
   Delivery Order a later change of the order's date overwrites every line's.
   Is line-only right?
6. **Status word.** ANSWERED 2026-09-15: the word on screen ("Submitted"), for
   every document. The PO export writes it (`PO_STATUS_WORDS`).
7. **Sales order remarks hold the account book's words.** 4,323 of the 4,560
   sales-order line remarks start with `账本原文:` — the text copied from the
   book at go-live. An imported remark would replace it. Allow that, append
   instead of replace, or lock remarks that carry the book text?
8. **Driver and Vehicle are empty on every delivery order (343 of 343).** Keep
   the two columns (blank until the delivery module fills them), or drop them?
9. **Cancelled documents.** ANSWERED 2026-09-15: the export follows the list's
   filter — cancelled documents are in the file only when the tab includes them.
10. ANSWERED 2026-09-15: export the STORED due date only; never derive one from a
    credit term. **Due dates are mostly empty.** Sales invoices: 359 of 367 live lines have no
    due date. Purchase invoices: 520 of 653. A collection chase list cannot sort by
    due date until these are filled. Fill them from the customer's / supplier's
    credit term, or leave blank?
11. ANSWERED 2026-09-15: the ERP's own SUM of purchase invoice lines, not the
    stored figure. **Goods receipt "invoiced" figure.** On 69 migrated receipt lines the stored
    invoiced quantity is larger than what the purchase invoices in the ERP add up
    to (the rest was LIKELY invoiced in AutoCount before go-live — UNKNOWN until
    checked against the book). Export the ERP's own sum, or the stored figure?
12. **Other documents.** Quotes, amendments, credit notes, deposit invoices,
    payment vouchers and receipts — do these need a line export too?

---

## What the SO / DO builds changed

Owner rulings 2026-09-15 applied: the Delivery Order lines carry **no Unit Price,
Discount or Line Total** (§2 rows 20–22 removed); **Driver and Vehicle stay**; no
estimate dates on either. The file is no longer a fixed column list: it is the grid's
visible columns under **AutoCount's captions** (`SO_LABELS` / `DO_LABELS`; the Detail
Listing's caption where two listings differ), opening on AutoCount's layouts
"SALES ORDER DETAILS-SALES" and "LISTING ITEM DETAIL" without prices. Header values are
the book's spelling where the document is in AutoCount (Doc No, Agent, Debtor Code, Venue,
Branding; line Item Code / Description / Item Group / UOM through `bookLineItem`); 2990
prints its own. **Item Description 2 follows the variant summary** by owner decision
2026-09-15, so it deliberately differs from AutoCount's typed Desc2 on older documents.
Money is ringgit. Where the build differs from the tables above, and why — each is the
reading of the screen the export stands beside:

- **SO Customer Ref / DO Customer Ref** is `ref`, else `customer_so_no` — the screens'
  `customerRefOf` (the tables above said `customer_so_no` first).
- **SO Doc Balance** is the view's live `balance_sen_live` (total − Σ payments), the
  list's Balance column; the stored `balance_sen` is the gross total rewritten on every
  edit and is only the fallback.
- **SO Status** is the list pill, which is DERIVED: Partially Delivered / Delivered /
  Invoiced / Delivery Return when the order's delivery records say so, not only the
  stored word (`CONFIRMED` → Submitted).
- **SO On Delivery Order Qty** counts linked delivery orders that have not shipped by
  the app's rule today, `doCountsAsDelivered`: DRAFT only. The table above said
  DRAFT/LOADED; LOADED (Confirmed) has counted as delivered since 2026-08-22, so a
  LOADED order's lines are in Delivered Qty.
- **SO Salesperson** follows the list: the header `agent` text when it is a name, else
  the staff row of `salesperson_id`. **DO Salesperson** is the staff row of
  `salesperson_id`, else `agent`.
- **SO Location**: a line with no warehouse keeps its stored `location` text (already
  the book's code). **DO Location** falls back to the header `sales_location`.
- **SO lines**: every line of a matched order is exported; a line the deliverable
  reading does not cover (a cancelled line — 0 of 16,229 in production on 2026-09-15)
  prints blank Delivered / Returned / Remaining.
- **DO Uninvoiced Qty** is the app's Pending (qty − invoiced − returned), blank on a
  DRAFT or CANCELLED delivery order. **DO Delivered On** is the Malaysian calendar day.

## What the GR / PI / SI builds changed

Where the build differs from the tables above, and why.

- **Columns follow AutoCount's Detail Listing.** GR = the book's saved layout
  "S", PI = layout "SS" (read from AutoCount's `Layout` table, 2026-09-15); the
  Sales Invoices grid keeps its own columns as the default (owner 2026-09-15,
  「默认跟我的data grid啊」) and offers AutoCount's IV listing columns in the
  chooser, hidden. One constant each (`GRN_DEFAULT_COLUMN_KEYS`,
  `PI_DEFAULT_COLUMN_KEYS`, `SI_AC_COLUMN_KEYS`).
- **Doc No** is the AutoCount number (a migrated GR's `linked_ac_gr_docno`, never
  the PO number in `linked_ac_docno`), else ours.
- **Item Code, Detail Description, Item Group, UOM** come from `bookLineItem` with
  the write-back's supplier bindings; **Location** is AutoCount's short code;
  **Detail Description 2** is the owner's variant rule
  (`lib/line-export-description2.ts`), the stored text only when the rule
  composes nothing; **SI Agent** is `resolveAcAgent`.
- **A sofa is one row per ERP piece**; the book holds one set line, so Item Code,
  Unit Price and Line Total differ there by design. Header SubTotal / Total print
  the ERP's own totals, which hold only the lines brought into the ERP.
- **Values the ERP does not hold print blank or the ERP's value**, never pulled from
  AutoCount: Proj No, Tax Code, line Tax, the Desc2 UDF, Inclusive?, PI Supplier
  Invoice No., GR Supplier DO No. and Delivery Date.
- **GR Invoiced Qty** (chooser) excludes DRAFT as well as CANCELLED purchase
  invoices — the rule `recomputeGrnInvoiced` (routes/purchase-invoices.ts) recounts
  the stored counter by.
- **Money** is written in ringgit (unit price to 4 decimals); dates are real
  Excel dates.
- **Line order** follows each detail page: GR / PI by creation, category rank and
  sofa module; SI by `line_no` then creation.

## How the counts were measured

All counts above came from one read-only runner: it opens a transaction,
runs `SET TRANSACTION READ ONLY`, confirms `transaction_read_only = on` and
aborts otherwise (a `CREATE TEMP TABLE` probe was refused with "cannot execute
CREATE TABLE in a read-only transaction"). The connection string was read from a
local file outside any repository and never printed. To reproduce without a local
credential, the repo's pattern is a `workflow_dispatch` check on
`secrets.DATABASE_URL` (see `backend/scripts/check-soak-gate.mjs`).

Empty means `NULL`, a blank string, an empty JSON object/array, or an empty array.
The per-column empty counts were one `count(*) FILTER (WHERE <col> IS NULL OR
btrim(<col>) = '')` per column of each table. The derived figures:

```sql
-- SO remaining (linked delivery lines only; shipped = not DRAFT/LOADED/CANCELLED)
WITH d AS (
  SELECT di.so_item_id,
         sum(di.qty) FILTER (WHERE upper(o.status::text) NOT IN ('DRAFT','LOADED','CANCELLED')) AS shipped,
         sum(di.qty) FILTER (WHERE upper(o.status::text) IN ('DRAFT','LOADED')) AS preship
  FROM scm.delivery_order_items di JOIN scm.delivery_orders o ON o.id = di.delivery_order_id
  WHERE di.so_item_id IS NOT NULL GROUP BY 1
), r AS (
  SELECT di.so_item_id, sum(ri.qty_returned) AS q
  FROM scm.delivery_return_items ri
  JOIN scm.delivery_returns dr ON dr.id = ri.delivery_return_id
  JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
  WHERE upper(dr.status::text) <> 'CANCELLED' GROUP BY 1
)
SELECT count(*) AS live_lines,
       count(*) FILTER (WHERE i.qty - coalesce(d.shipped,0) + coalesce(r.q,0) > 0) AS remaining_pos,
       count(*) FILTER (WHERE coalesce(d.preship,0) > 0) AS on_loaded_do
FROM scm.mfg_sales_order_items i
JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = i.company_id
LEFT JOIN d ON d.so_item_id = i.id LEFT JOIN r ON r.so_item_id = i.id
WHERE NOT i.cancelled AND h.status <> 'CANCELLED';
-- 2026-09-15: 16208 | 15284 | 554

-- SO line balance_sen is the line total, not a balance
SELECT count(*), count(*) FILTER (WHERE i.balance_sen = i.total_sen)
FROM scm.mfg_sales_order_items i;
-- 16219 | 16219

-- Remarks carrying the book's words
SELECT count(*) FILTER (WHERE remark LIKE '%账本原文%'),
       count(*) FILTER (WHERE coalesce(btrim(remark),'') <> '')
FROM scm.mfg_sales_order_items;
-- 4323 | 4560

-- Goods receipt: which column holds the AutoCount GR number
SELECT linked_ac_gr_docno IS NOT NULL AS has_gr_no,
       regexp_replace(coalesce(linked_ac_docno,'(null)'), '[0-9].*$', '') AS prefix,
       migrated_no_stock, count(*)
FROM scm.grns GROUP BY 1,2,3;
-- f | (null) | f | 68 ;  f | HC-GRN- | f | 69 ;  f | PO- | t | 73 ;  t | PO- | t | 400

-- Goods receipt invoiced: stored column vs purchase invoice lines
WITH pi AS (
  SELECT pii.grn_item_id, sum(pii.qty) AS q
  FROM scm.purchase_invoice_items pii JOIN scm.purchase_invoices p ON p.id = pii.purchase_invoice_id
  WHERE p.status NOT IN ('CANCELLED','VOID') AND pii.grn_item_id IS NOT NULL GROUP BY 1
)
SELECT g.migrated_no_stock, count(*)
FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id LEFT JOIN pi ON pi.grn_item_id = gi.id
WHERE coalesce(pi.q,0) <> gi.invoiced_qty GROUP BY 1;
-- t | 69   (stored value larger on all 69)

-- Delivery order driver / vehicle / crew
SELECT count(*) FILTER (WHERE coalesce(driver_name,'') = '' AND driver_id IS NULL),
       count(*) FILTER (WHERE coalesce(vehicle,'') = ''), count(*)
FROM scm.delivery_orders;
-- 343 | 343 | 343   (scm.delivery_order_crew: 0 rows)

-- Due dates on live invoice lines
SELECT count(*) FILTER (WHERE s.status <> 'CANCELLED'),
       count(*) FILTER (WHERE s.status <> 'CANCELLED' AND s.due_date IS NULL)
FROM scm.sales_invoice_items si JOIN scm.sales_invoices s ON s.id = si.sales_invoice_id;
-- 367 | 359
```

## See also

- `docs/modules/purchase-order.md` — the template document
- `docs/modules/document-status-vocabulary.md` — the words shown for each status
- `docs/modules/document-conversion.md` — how each document is made from the one before it (the links above)
- `docs/modules/sales-order.md` §0 — what moves a sales order's status
- `docs/autocount-integration-map.md` — which documents reach AutoCount
