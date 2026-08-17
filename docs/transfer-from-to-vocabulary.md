# "Transfer From" / "Transfer To" — what this ERP calls it, and what AutoCount calls it

**Written 2026-08-17**, for the owner's question: 「你确保一下我们 ERP 是不是也要 "Transfer To"
跟 "Transfer From" 两个 column 一模一样的。看一下我们整套系统的源代码，我们是用什么字眼」

**This is a SURVEY. Nothing here has been renamed.** A rename across a
money-bearing schema is the owner's decision, and §6 sets out the options so he
can make it. What the survey found instead — links stored and never shown, links
shown and never stored, and one word already meaning three different things — is
in §4 and §5, and those are findings in their own right.

**Scope and method.** Every row below was read out of the tree at
`ba001a92` (2026-08-17). Nothing was measured against production: where a count
or a live shape is quoted it says so and names where the number came from.

---

## 1. The short answer

AutoCount has ONE vocabulary for this and puts it in ONE place. We have **six**,
and they are in different places:

| # | vocabulary | where it lives | shape |
| --- | --- | --- | --- |
| 1 | relational FKs | the SCM tables | `so_doc_no`, `delivery_order_id`, `do_item_id`, `grn_item_id`, … |
| 2 | the inventory ledger | `inventory_movements`, `inventory_lots`, `journal_entries` | `source_doc_type` / `source_doc_id` / `source_doc_no`, plus `batch_no` |
| 3 | the AutoCount outbox | `scm.autocount_outbox` payloads | `FromDocNo`, `fromDoc`, `DtlKeys`, `linked_ac_docno`, `linked_ac_dtlkey` |
| 4 | the AutoCount mirror | the imported AC tables | `transfer_to` |
| 5 | URL convert params | `frontend/src/lib/convertScope.tsx` | `?doId=`, `?grnId=`, `?soDocNo=`, `?fromDo=` |
| 6 | UI labels | the list and detail screens | "From SO", "From DO", "From PO", "Source", "Source PO", "Convert to …" |

> **CORRECTED 2026-08-17.** This paragraph used to read: *"**The word "transfer"
> is almost never ours.** Where it does appear on a screen, it means something
> else: `PurchaseOrderDetailV2.tsx` renders a line column labelled **"Transfer
> to"** whose value is the destination **warehouse**, not a document."* The
> second sentence is true of that one screen and **false as a generalisation** —
> it was written from the dead-file mistake corrected in §5(b), which had
> excluded three live editors from the count.
>
> **"Transfer From/To" is ALREADY the ERP's word for document lineage on NINE
> live screens** — six routed straight from `App.tsx`, three reached through the
> `?edit=1` forward — always with the source/target document type in
> parentheses:
> "Transfer From (SO)" (DO listing, SI listing), "Transfer To (DO)" (Consignment
> Orders), "Transfer From (Order)" (PC Receives), "Transfer From (Receive)" (PC
> Returns), "Transfer To:" (GRN detail, PC Receive detail), "Transfer To" (SO
> editor), "Transfer To (GRN)" (PO editor). Enumerate with
> `git grep -n "Transfer From (\|Transfer To (\|Transfer To:" -- frontend/src`.
>
> `PurchaseOrderDetailV2`'s warehouse column is therefore the **outlier**, not
> the rule — which inverts what this section concluded. The layered rename-cost
> view is in `docs/modules/document-conversion.md` §9.

---

## 2. What AutoCount stores, for comparison

AutoCount records lineage on the **TARGET document's DETAIL rows**:

| column | on | meaning |
| --- | --- | --- |
| `FromDocType` | `DODTL`, `IVDTL`, `GRDTL`, `PIDTL` | the type of the document these goods were transferred from (`'SO'`, `'DO'`, `'PO'`, `'GR'`) |
| `FromDocNo` | the same four | that document's number |
| `FromDocDtlKey` | the same four | the source LINE — **NULL throughout this book** |
| `FullTransferFromDocList` | `DODTL` | the full list where one target row draws on several sources |
| `FromSODtlKey` | **`PODTL`** | the source SALES-ORDER LINE — **populated**, see below |
| `FromSODocList` | **`PODTL`** | that sales order's number |

**ADDED 2026-08-17. The last two rows are the correction, and this section was
wrong without them** — it said AutoCount puts lineage in ONE place, and a
purchase order is the exception in both directions. `SO → PO` is not a member of
AutoCount's general transfer family at all (its own `AddSOToPOTransferDetail`,
its own validator, its own over-transfer table — see
`docs/modules/autocount-writeback.md` §7c3c), and it records the link in the two
columns above rather than in `FromDocType` / `FromDocNo`.

**And it is the LINE key that is populated here, which is the opposite of the
four tables above.** Measured in `backend/scripts/data/ac-fidelity-po-lines.json.gz`
(`AED_HOUZS` read-only 2026-08-11, query at `export-ac-fidelity-truth.py:144`):
**10,338 of 18,148** non-cancelled `PODTL` rows, over **7,467 of 9,080** purchase
orders, carry a `FromSODtlKey`; 10,314 also carry a `FromSODocList`. The ERP has
depended on this since the cutover — `backfill-po-ac-dtlkey.mjs` and
`repair-dedication-from-autocount.mjs` both call it "the one line-to-line link
AutoCount populates". So the sentence below about line-level lineage being
unusable is true of `DODTL` / `IVDTL` / `GRDTL` / `PIDTL` and **false of
`PODTL`**.

**Reported from a live-book measurement taken 2026-08-16 by the session that
raised this question — NOT re-measured by this survey:** 47,531 `DODTL` rows
carry `FromDocType='SO'` with a `FromDocNo`, and `FromDocDtlKey` is NULL on
**all** of them. What this survey DID verify, in the tree:
`docs/autocount-migration-record.md` records the same emptiness on the other
three detail tables (`PIDTL` 0 of 20,777, `IVDTL` 0 of 43,522), and
`backend/src/scm/lib/migrated-chain.ts` is built around it. So AutoCount's own
LINE-level lineage is unusable as a join key; only the DOCUMENT-level pair
(`FromDocType`, `FromDocNo`) is real.

Two consequences the ERP already lives with:

- `backend/src/scm/lib/migrated-chain.ts` quotes exactly this: a migrated
  document's chain has to be re-derived arithmetically, because the key that
  would have joined it is empty.
- `FullTransferFromDocList` and `FromDocType` appear **nowhere** in
  `backend/src` or `frontend/src`. `FromDocNo` is the only one of the four the
  ERP writes, and it writes it at DRAIN time, resolved from the parent's
  `linked_ac_docno` (`backend/src/scm/lib/autocount-outbox.ts`).

---

## 3. Our vocabulary, per document type

"HEADER" / "LINE" is which table the link is stored on. The **UI label** column
is what the operator reads.

### Sales chain

| target | direction | HEADER column | LINE column | API field | UI label(s) |
| --- | --- | --- | --- | --- | --- |
| Delivery Order | ← Sales Order | `delivery_orders.so_doc_no` | `delivery_order_items.so_item_id` | `soDocNo`, `soItemId` | **"From SO"** (list) · **"Customer SO No."** (detail) · "DO created from …" |
| Sales Invoice | ← Delivery Order | `sales_invoices.delivery_order_id` | `sales_invoice_items.do_item_id` | `deliveryOrderId` (body), `doId`/`doIds` (params), `doItemId` | **"From DO"** |
| Sales Invoice | ← Sales Order (skip-level) | `sales_invoices.so_doc_no` | `sales_invoice_items.so_item_id` | `soDocNo`, `soItemId` | **"From SO"** |
| Delivery Return | ← DO / ← SI | `delivery_returns.delivery_order_id`, `.sales_invoice_id` | `delivery_return_items.do_item_id` | `doItemId` | **"From DO"**, "From SO" |

### Purchase chain

| target | direction | HEADER column | LINE column | API field | UI label(s) |
| --- | --- | --- | --- | --- | --- |
| Purchase Order | ← Sales Order | **none** (a free-text `"From SOs: …"` note) | `purchase_order_items.so_item_id`, and `purchase_order_item_allocations.so_item_id` | `soItemId` | "From Sales Order" (button) |
| GRN | ← Purchase Order | `grns.purchase_order_id` (NOT NULL) | `grn_items.purchase_order_item_id` | `purchaseOrderId` / `poId`, `purchaseOrderItemId` / `poItemId` | **"From PO"** |
| Purchase Invoice | ← GRN | `purchase_invoices.grn_id` | `purchase_invoice_items.grn_item_id` | `grnId`, `grnItemId` | **"Source"** |
| Purchase Invoice | ← PO (skip-level) | `purchase_invoices.purchase_order_id` | — | `purchaseOrderId` | — |
| Purchase Return | ← GRN / ← PO | `purchase_returns.grn_id`, `.purchase_order_id` | `purchase_return_items.grn_item_id` | `grnId` | **"From GRN"** (list) · **"Source"** (detail) |

### Consignment

Sales side spells the prefix in full (`consignment_so_doc_no`,
`consignment_do_item_id`); purchase side mixes full
(`purchase_consignment_receives.purchase_consignment_order_id`) with abbreviated
(`purchase_consignment_returns.pc_order_id`, `.pc_receive_id`,
`.pc_order_item_id`). Two conventions in one module.

### Quotation → Sales Order

**There is no link at all.** `docs/modules/document-conversion.md` states it:
the conversion "does not exist", and `mfg_sales_orders` carries no quote column.

### The AutoCount side of the same rows

| our op | AutoCount call | our source ref | our line subset |
| --- | --- | --- | --- |
| `so_to_do` | `AddPartialTransferDetail('SO', …)` | `payload.fromDoc` → `FromDocNo` | `DtlKeys` from `delivery_order_items.so_item_id` → the SO line's `linked_ac_dtlkey` |
| `po_to_gr` | `…('PO', …)` | same | from `grn_items.purchase_order_item_id` |
| `do_to_iv` | `…('DO', …)` | same | from `sales_invoice_items.do_item_id` |
| `gr_to_pi` | `…('GR', …)` | same | from `purchase_invoice_items.grn_item_id` |

`backend/src/scm/lib/autocount-outbox.ts`'s `DOWNSTREAM` table is the ONE place
in this repo where our column names and AutoCount's sit side by side. If a
single glossary is ever written, that table is its seed.

---

## 4. Stored but never shown · shown but never stored

Both halves of this section are findings, not commentary.

### (a) Stored and never displayed

| column | evidence |
| --- | --- |
| `mfg_sales_orders.linked_do_doc_no` | writable through `linkedDoDocNo` and selected into the header payload; the only frontend occurrence is a type field in `frontend/src/pages/scm-v2/SalesOrderDetail.tsx` — **which IS live** (`SalesOrderDetailV2` lazily mounts it at `?edit=1`; the "nothing imports it" claim here was wrong, see §5(b)'s correction). The column is still never RENDERED: `git grep -n "\.linked_do_doc_no" -- frontend/src` returns nothing |
| `mfg_sales_orders.transfer_to` | written at SO create from `body.transferTo`, patchable, selected — and no live frontend reader |
| `mfg_sales_orders.cross_category_source_doc_no` | backs a unique index used as an anti-double-dip guard; `crossCategory` has zero hits in `frontend/src` |
| `autocount_delivery_orders.so_doc_nos` | the migration that adds it says in its own comment that it "stays NULL until a detail-enrichment pass lands" — declared, and never populated |
| `sales_invoice_items.so_item_id` | written beside `do_item_id`, read as a fallback by `document-flow.ts`, surfaced by no label |
| **every LINE-level parent FK** | no detail page renders "this line came from that line". `DocumentLinesExpansion.tsx` uses `so_item_id` only as a boolean ("is this line linked at all"); `PurchaseInvoiceDetailV2.tsx` hops `grn_item_id` only to fetch a supplier SKU |

That last row is the structural one: **AutoCount shows the operator a per-line
`FromDocNo`, and we show none.** Our line links exist and are load-bearing —
every remaining-quantity calculation and every `DtlKeys` payload reads them — but
they are invisible on screen.

### (b) Displayed and never stored

Every FORWARD ("transfer-to") link in the UI is derived at read time by scanning
children backwards. There is no forward column anywhere that is both written and
read:

| UI | derived from |
| --- | --- |
| SO list "PO No." (`converted_po_nos`) | reverse scan of `purchase_order_items.so_item_id` + the `"From SOs:"` note |
| SO list "DO No." (`do_nos`) | reverse scan of `delivery_orders.so_doc_no` |
| PO list "GRN No" (`transfer_to_grns`) | reverse scan of `grns.purchase_order_id` |
| DO list "Invoiced to" (`invoiced_si_nos`) | reverse scan of `sales_invoice_items.do_item_id` |
| PO / PI list "Delivered" (`delivered_dos`) | a `batch_no` ledger walk |
| "Source PO" everywhere | `inventory_lots.batch_no`, via `backend/src/scm/lib/source-po-trace.ts` |
| PI detail "Source · N notes" (`sourceGrns`) | the invoice's LINES, because the header FK is lossy |
| the whole Relationship Map | `GET /document-flow/:type/:id`, computed per request |

**So the answer to "does a Sales Order know which Delivery Orders it produced"
is: not in any usable stored form.** `linked_do_doc_no` exists for exactly that
and is dead; the real answer is recomputed backwards every time.

### (c) The header link is a "primary ref" and the UI treats it as the truth

Three of the four downstream types say so in their own code — `grns.ts`
(`// primary PO ref (first one)`) and `purchase-invoices.ts` ("the header's
`grn_id` is the PRIMARY note ref only; the authoritative linkage is per LINE").
But the screens render the header value:

- GRN detail "From PO" reads the header only.
- SI list "From DO" reads the header only.
- **`PurchaseInvoiceDetailV2` is the only screen that reads the LINES**, and it
  is also the only one that can say "Source · 3 notes".

A multi-source document therefore shows ONE parent on every screen but one.
`backend/scripts/scan-unlinked-lines.mjs` already warns about the same split
from the other end: cancel-blocking matches children by their HEADER's
`delivery_order_id`, "not by their lines' `do_item_id`. Those two are not the
same question."

---

## 5. Where the vocabulary disagrees with itself

### (a) One column, four labels

`so_doc_no` is rendered as **"From SO"** (DO list, SI list, DR list), **"SO
No."** (Unbilled Deliveries), a bare **`SO …`** prefix (mobile), and — on
`DeliveryOrderDetailV2` — **"Customer SO No."**. That last one is actively
wrong: the same page carries a separate **"Customer SO ref"** field two rows
below for the customer's own reference, so "Customer SO No." reads as the
customer's number when it is ours.

### (b) One word, three meanings — "transfer"

| use | what it actually means |
| --- | --- |
| `PurchaseOrderDetailV2`'s line column **"Transfer to"** | the destination **WAREHOUSE** |
| `sales_orders.transfer_to` (AutoCount mirror) and `ac_snapshot_sales_orders.transfer_to` | AutoCount's real SO → DO transfer chain |
| `mfg_sales_orders.transfer_to` | a free-text field the API accepts and nothing reads |
| `transfer_to_grns` | a derived forward PO → GRN list |
| `inventory_movement_type = 'TRANSFER'` | stock moved between warehouses |

Adopting AutoCount's words wholesale would collide head-on with the first row,
which is the most user-visible of the five.

> **CORRECTED 2026-08-17.** This paragraph used to read: *"Two dead files still
> carry the phrase and neither is imported: `GoodsReceivedDetail.tsx`
> ("Downstream 'Transfer To' breakdown") and `SalesOrderDetail.tsx`
> (`data-label="Transfer To"`)."* **Both are LIVE, and so is
> `PurchaseOrderDetail.tsx`.** Each is the inline EDITOR for its document,
> lazily imported by its own `*V2` twin and rendered whenever `?edit=1` lands on
> the route — i.e. every time an operator presses Edit:
>
> | V1 file | mounted by | reached at |
> |---|---|---|
> | `SalesOrderDetail.tsx` | `SalesOrderDetailV2.tsx` | `/scm/sales-orders/:id?edit=1` |
> | `GoodsReceivedDetail.tsx` | `GoodsReceivedDetailV2.tsx` | `/scm/grns/:id?edit=1` |
> | `PurchaseOrderDetail.tsx` | `PurchaseOrderDetailV2.tsx` | `/scm/purchase-orders/:id?edit=1` |
>
> Verify with `git grep -n 'import("./SalesOrderDetail")' -- frontend/src`
> rather than believing this line either. The original claim came from checking
> `App.tsx` for a route and finding only the `*V2` twin; a lazy `import()`
> inside a sibling page is invisible to that check. Consequence for §6: those
> "Transfer To" labels are **in scope** for Option A, not exempt as dead code.

### (c) One concept, two API names inside one file

`grns.ts` uses `purchaseOrderId` and `poId` for the same column, and
`purchaseOrderItemId` and `poItemId` for the same column.
`sales-invoices.ts` uses `deliveryOrderId` in the body and `doId`/`doIds` in
params.

### (d) A label that contradicts its own value

`PurchaseReturnsListV2`'s column is headed **"From GRN"** and its value function
falls back to the PO number, so a PO-sourced return renders a PO number under a
"From GRN" heading. The detail page labels the identical function **"Source"**.

### (e) Desktop and mobile word the same button differently

Desktop: "Convert to GRN", "Convert to PI", "Convert to PR".
Mobile: "Convert to Goods Receipt", "Convert to Sales Invoice".

### (f) URL parameter names have already caused this bug twice

`frontend/src/lib/convertScope.tsx` exists because callers sent `?do=` / `?grn=`
/ `?so=` that the pickers never read, and because GRN screens sent `?fromGrn=`
while `PurchaseReturnNew` read `grnId` — so "Convert to Purchase Return" always
opened blank. Centralising the names fixed those. It does **not** cover
`appendToGrn`, `?fromConsignmentOrder=`, `?fromPcReceive=`, `?copyFrom=` or the
`?fromDo=` this document's sibling bug fix touched; each still invents its own
string.

---

## 6. Recommendation — three options, for the owner to choose

The survey's own conclusion first: **the ERP does NOT need two columns called
"Transfer From" and "Transfer To" to match AutoCount.** AutoCount stores exactly
one direction — backwards, on the detail rows — and derives the forward view. We
already store the backward direction (on both the header and the lines) and
derive the forward view too. The data model already agrees with AutoCount. What
disagrees is **the words on the screen**, and that is where the whole cost of
this is.

### Option A — align the LABELS only (recommended)

No migration, no column rename, no risk to money. One vocabulary on screen,
chosen to match what the operator sees in AutoCount:

| today | proposed | why |
| --- | --- | --- |
| "From SO" / "Customer SO No." / "SO No." / `SO …` | **"Transfer From"** with the document number, or keep "From SO" everywhere | pick one; the current four are the actual complaint |
| "Source" (PI, PR detail) | **"From GRN"** | says which document type, as the sales side already does |
| "From GRN" on a column that may show a PO | **"Source document"**, or split into two columns | the label is currently false for PO-sourced returns |
| "Invoiced to" / "GRN No" / "DO No." / "PO No." (forward) | **"Transfer To"** | this IS AutoCount's forward view, and naming it that makes the pair legible |
| "Transfer to" on the PO line (warehouse) | **"To warehouse"** | frees the word |
| mobile "Convert to Goods Receipt" | match desktop, or change desktop to match mobile | one product, one wording |

Cost: label strings and their tests. Reversible.

### Option B — Option A, plus show the LINE-level source

Add the per-line "came from" to the four detail screens, matching what AutoCount
shows the user on `DODTL` / `IVDTL` / `GRDTL` / `PIDTL`. The data is already
stored (§4a) and already trusted by the quantity maths; only the display is
missing. This also fixes §4c, because a multi-source document would stop
appearing to have one parent.

Cost: four detail screens plus their mobile twins. No schema change.

### Option C — rename the COLUMNS to `transfer_from_doc_type` /
`transfer_from_doc_no`

Faithful to AutoCount and the most expensive by a wide margin: these columns
carry foreign keys on money-bearing tables, are read by the outbox payloads, by
every remaining-quantity calculation, and by the ops scripts. A rename means a
migration per table, a rewrite of every read, and a window in which the two
names coexist.

**Not recommended, and not necessary for the owner's stated goal** — the goal is
that the ERP and AutoCount say the same thing to the same person, and Option A
achieves that at the surface where the person actually reads it.

### Independent of the choice — three things worth deciding anyway

1. **`mfg_sales_orders.transfer_to`** is a free-text column the API writes and
   nothing reads, and its name collides with two real meanings. Drop it or
   document it.
2. **`mfg_sales_orders.linked_do_doc_no`** is the only forward column in the
   schema and it is dead. Either populate and use it, or remove it — leaving it
   is how the next reader concludes the forward direction is stored.
3. **`autocount_delivery_orders.so_doc_nos`** has never been populated, by its
   own migration's admission.

---

## See also

- `docs/modules/autocount-writeback.md` — the outbox, the ops, and what a
  `skipped` row means
- `docs/modules/document-traceability.md` — the "Source PO" chips and the
  `batch_no` ledger walk behind them
- `docs/modules/document-conversion.md` — which conversions exist, and the
  Quotation → SO gap
- `docs/autocount-sync-reasons.md` — the reason catalogue the outbox writes into
