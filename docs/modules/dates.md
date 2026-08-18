# Dates — every date fact in the system, its ONE storage, and the names it still answers to

**Read this before you add, rename, merge or "unify" any date anywhere in this
repo.**

---

## Why this page exists

Owner, restated 2026-08-18 and at least four times before it:

> *"最主要的是 'date'，我们分了几种 date，全部要统一掉，不要有那么多种列出来。然后
> 看一下有没有所谓的矛盾点，把这些问题处理掉。然后记得是看源代码的。"*

And the pinned one from 2026-08-13, recorded at the top of
`backend/src/scm/shared/so-processing-date.ts` *"after saying it more than three
times"*:

> *"internal expected date、processing date 和 process date … 这三个 date 其实都是
> 指向同一个东西。"*

`so-processing-date.ts` answers that for **one** date. This page answers it for
**all** of them, because the question he keeps asking is one level up: across the
whole system, how many date facts are there really, and which of them are the
same thing wearing different names.

Every claim below was read out of source on `origin/main` `12322f31b`
(2026-08-18). Where a doc and the source disagreed, the source won and the
disagreement is written down. **Nothing here was taken from another document.**

---

## 1. The answer, in numbers

On the **Sales Order** — the document the question is really about:

| | count |
|---|---|
| Date/timestamp columns on `scm.mfg_sales_orders` + `…_items` | **13** |
| Genuine date FACTS among them | **8** |
| Columns with **no writer at all** | **2** (`sales_exemption_expiry`, `target_date`) |
| Facts stored in **more than one live column** | **1** (the Processing Date) |
| Distinct machine names the Processing Date alone answers to | **7** |

System-wide, counting purchase orders, delivery orders, trips, service cases and
the two deliberately-separate modules: **14 genuine date facts**.

**So the short answer for the owner: about fourteen real dates, and the mess is
not fourteen — it is that four or five of them answer to more than one name, and
one of them (the Processing Date) still has two live columns. That last one is
not cosmetic; it is producing a wrong answer in production today (§5.1).**

### The 13 SO columns, and which fact each one is

| column | fact | status |
|---|---|---|
| `so_date` | Order date | live, sole storage |
| `mfg_sales_order_items.line_date` | Order date, per line | live — a line added later does NOT equal `so_date` |
| `processing_date` | **Processing Date** | live, THE storage |
| `proceeded_at` | **Processing Date** (same fact, timestamp shape) | live — **second home, see §5.1** |
| `customer_delivery_date` | Promised delivery, header | live, sole storage |
| `mfg_sales_order_items.line_delivery_date` | Promised delivery, per line | live — guarded by `line_delivery_date_overridden` |
| `amend_date_from_customer` | What the customer ASKED to move to | live, sole storage |
| `amended_delivery_date` | What we CONFIRMED we would move to | live, sole storage — **but ungated, see §5.2** |
| `payment_date` | When money was taken | live — denormalised copy of the payments ledger |
| `possession_date` | When the customer gets the keys | live, sole storage |
| `customer_po_date` | The date on the CUSTOMER's own PO | live, sole storage |
| `sales_exemption_expiry` | — | **DEAD: zero writers, still rendered (§6)** |
| `target_date` | — | **ORPHAN: no UI writer, four API write paths (§6)** |

---

## 2. The failure mode this page guards

Copied deliberately from `so-processing-date.ts`, because it is the reason a
rename in this repo is dangerous and the reason four discussions produced four
bugs:

> Every surface that reads a date by NAME rather than by binding fails the same
> way when the name moves: **no error, no type failure, no 500 — the value simply
> stops arriving.** A PostgREST select of a column that does not exist is loud
> (`42703`); a JS property read of a key that does not exist is `undefined`, and
> `if (pdate)` then sends nothing at all.

There are **four** kinds of string-keyed read in this system, and a rename plan
that does not enumerate all four is wrong:

1. **PostgREST select lists** — `.select('processing_date, …')`. Loud (`42703`),
   but the error is frequently discarded (`const { data: cur }`), which turns a
   loud failure into a silent `null`. That is exactly what happened after mig
   `0286` — see the incident box in `sales-order.md`.
2. **`Record<string, unknown>` payload lookups** — `body.processingDate`,
   `effOf('processing_date')`. Silent `undefined`.
3. **Stored jsonb keys** — `so_amendments.header_changes` is client-authored at
   REQUEST time and read at APPROVE time, days later and across a deploy. A
   renamed key is skipped by the apply loop: the amendment is approved, audited,
   marked done, and the date is never written.
4. **Dynamic SQL built from the catalog** — `scm.apply_so_header_cas` feeds the
   patch through `jsonb_populate_record`, which **IGNORES a JSON key that is not
   a column**. A caller still sending the old name does not error; the date just
   stops saving.

`SO_PROCESSING_DATE_COLUMN` / `SO_PROCESSING_DATE_PAYLOAD_KEY` in
`backend/src/scm/shared/so-processing-date.ts` exist so that (1) and (2) move
with a rename; `SO_PROCESSING_DATE_LEGACY_COLUMNS` and
`SO_HEADER_LEGACY_PAYLOAD_KEYS` exist so that the 2990 mirror and already-queued
amendments survive one. **A `.mjs` script cannot import the `.ts` — it must use
the pinned mirror `backend/scripts/lib/so-processing-date.mjs`.**

---

## 3. The concepts, one by one

Each entry names the ONE storage, every other name the concept answers to, who
writes it, and what DECIDES on it. "Decides" means a gate, a lock or an ordering
— not a column that merely appears in a response.

### 3.1 Order date — `so_date` / `line_date`

* **Means:** the day the document was raised.
* **Storage:** `scm.mfg_sales_orders.so_date` (`date NOT NULL DEFAULT now()`),
  written at `routes/mfg-sales-orders.ts:4986`; per-line twin
  `mfg_sales_order_items.line_date`, stamped `todayMyt()` when the line is added,
  so a line added later does **not** equal `so_date`.
* **Other names:** `soDate` on the wire; `DocDate` out to AutoCount
  (`services/autocount-writeback.ts:1162`).
* **Decides:** nothing gates on it. It is an MRP window basis and a sort column.
* **Verdict: clean. Leave it alone.**

### 3.2 Processing Date — the go-to-production date (= "Proceed")

* **Means:** the day the factory starts. *Having one IS being proceeded* (owner,
  pinned 2026-08-13: *"只要有 Processing Date，就代表他 Proceed 了 … 没有
  processing date 就代表没有 proceed"*).
* **THE storage:** `scm.mfg_sales_orders.processing_date` (`date`, nullable),
  renamed from `internal_expected_dd` by **mig 0286**. Bind to
  `SO_PROCESSING_DATE_COLUMN`, never a hand-typed literal. Consignment twin
  `scm.consignment_sales_orders.processing_date`, same migration
  (`routes/consignment-orders.ts:1142`).
* **The SECOND live home:** `scm.mfg_sales_orders.proceeded_at` (`timestamptz`).
  Same fact, wrong shape. **This is the open wound — §5.1.**
* **Every other name it answers to (7 machine names, one fact):**

  | name | where | why it exists |
  |---|---|---|
  | `processing_date` | the column | THE storage |
  | `proceeded_at` | a second column | historical; not yet retired |
  | `processingDate` | API payload key | THE wire key |
  | `internal_expected_dd` | inbound mirror column alias | 2990 is a separate repo on its own deploy schedule and still POSTs the old name. **Deliberate.** |
  | `internalExpectedDd` | stored-jsonb payload alias | already frozen inside pending `so_amendments`. **Deliberate.** |
  | `PDate` | AutoCount UDF, outbound | `autocount-writeback.ts:1692` |
  | `so_processing_date` / `soProcessingDate` | derived field on SI + DO list rows | `routes/sales-invoices.ts:699`, `routes/delivery-orders-mfg.ts:2911`; read by three frontends. **Rename BOTH ends or neither.** |

  Plus the human words *"internal expected date"* and *"process date"*, which are
  the same thing and should stop being said.
* **Writers:** SO create (`mfg-sales-orders.ts:5087`), SO header PATCH,
  `/status` → IN_PRODUCTION (`:5821`), amendment approve, CO create + PATCH.
* **Decides:** the SO edit lock (`soProcessingLocked`, `mfg-sales-orders.ts:490`
  onwards); the proceed gate; the pair rule; the delivery-planning board's
  admission filter and Days-Left; the MRP display basis; the AutoCount `PDate`
  push. **NOT the stock allocator — that is the bug in §5.1.**

### 3.3 Promised customer delivery date

* **Means:** what the customer was promised. One fact, a header value and an
  optional per-line override.
* **Storage:** `scm.mfg_sales_orders.customer_delivery_date` (header) and
  `mfg_sales_order_items.line_delivery_date` + `line_delivery_date_overridden`.
  **Both are needed** — the flag is what makes them safe.
* **Other names:** `customerDeliveryDate` / `lineDeliveryDate` on the wire; out to
  AutoCount the header travels as **`SalesExemptionExpiryDate`**
  (`autocount-writeback.ts:1697`) — see the collision warning in §6.
* **The cascade:** a header change cascades onto every line through
  `apply_so_header_cas`. **On the SO the cascade resets
  `line_delivery_date_overridden = false` and overwrites every line
  unconditionally** (mig `0173`, and `lib/so-revision.ts` on amendment approve).
  **On the Consignment Order it does not** — the CO updates only rows where the
  flag is already `false` (`routes/consignment-orders.ts:1299` area). Two
  documents, cloned from each other, reasoning the opposite way. See §7.
* **Decides:** the pair rule; MRP's "is this line dated" test and its allocation
  ordering; stock-allocation priority; inventory demand buckets; DO convert
  tiebreak; PO-from-SO line dates; the proceed gate's `hasDeliveryDate`.

### 3.4 The amendment pair — requested vs confirmed

* **Means:** two SEPARATE facts. `amend_date_from_customer` is what the customer
  ASKED for; `amended_delivery_date` is what WE confirmed. The original promise in
  `customer_delivery_date` is **deliberately never overwritten**.
* **Storage:** both on `scm.mfg_sales_orders`, plus `amend_reason`.
* **Also appears as:** the computed board key `effective_delivery_date`
  (`routes/delivery-planning.ts`), which is `amended_delivery_date ??
  customer_delivery_date`. That is a derived value, not a fourth storage.
* **Decides:** Days-Left and the OVERDUE window on the board; PO outstanding
  dates; ready-stock ordering; PO/SO coverage; DO listing; trip proposal.
* **What it does NOT decide, and should:** MRP and the stock allocator never read
  it. **§5.2.**

### 3.5 Supplier ETA on a purchase order — *the model to copy*

* **Storage:** `scm.purchase_orders.po_date`, `.expected_at`,
  `.supplier_delivery_date_2/_3/_4`, and the same set again on
  `purchase_order_items`.
* **Four names, ONE shared reader.** `effectiveDelivery()` in
  `backend/src/scm/shared/effective-delivery.ts` returns the MAX of the non-nulls,
  and **every** supply-side reader calls it — `lib/outstanding-po-lines.ts`,
  `routes/inventory.ts`, `lib/do-live-allocator.ts`, `lib/dropship-batch.ts`.
* **This is the one date family in the system where no caller can invent a fifth
  answer, and it is the shape every other family should be moved to.** Contrast
  §5.3, where the SO's effective date is hand-written in a dozen places and the
  copies disagree.

### 3.6 Delivery-order dates

* **Document date:** `delivery_orders.do_date`.
* **Expected delivery: TWO columns for one fact** — `expected_delivery_at` and
  `customer_delivery_date`, written from the **same value in the same INSERT**
  (`routes/delivery-orders-mfg.ts:4071` — one falls back to `today`, the other to
  `null`), and both separately editable through the PATCH map (`:4432`). See §5.4.
* **Execution stamps:** `dispatched_at`, `signed_at`, `delivered_at`,
  `arrival_at`, `departure_at`, `shipout_date`, `customer_delivered_date`,
  `arrives_em_warehouse_date`. These are genuinely distinct milestones — keep.
* **One type wart:** `eta_arriving_port` was created **`TEXT`**
  (`migrations-pg/0053_scm_delivery_planning_tms.sql:188`) while every sibling on
  the same migration is `DATE` or `TIMESTAMPTZ` (`:184-187`, `:195`). It rides the
  same PATCH field map as the real dates, so Postgres never type-checks what lands
  in it. Not urgent; named so nobody "discovers" it again.
* **There is no shared date-coercion module, and this page will not pretend
  otherwise.** The empty-string-to-null rule that keeps an unfilled `<input
  type="date">` from reaching a Postgres `date` column as `""` is written per
  route: `emptyDate` is a file-local function in
  `backend/src/scm/routes/delivery-orders-mfg.ts:3675`, and
  `backend/src/scm/routes/scan-lorry-invoice.ts:175` declares its own `dateOrNull`.
  Other routes call a `dateOrNull` they import from elsewhere. **If you are adding
  a date column, find the coercion your route actually uses — do not assume a
  shared one exists.** An earlier draft of this page cited a shared
  date-coerce module under `scm/lib`, with a date-column regex inside it.
  **Neither the file nor the regex exists anywhere in the tree** — the repo's own
  `audit:doc-refs` gate caught the invented path before this merged. Recorded
  here rather than quietly deleted, because "a module that sounds like it ought to
  exist" is exactly how these docs went wrong the last four times.

### 3.7 The rest, briefly

| fact | storage | decides |
|---|---|---|
| Payment date | `mfg_sales_orders.payment_date` + `mfg_sales_order_payments.paid_at` — one request key `paymentDate` feeds both | nothing gates on the DATE (the deposit gates read amounts) |
| Possession date | `mfg_sales_orders.possession_date` | scheduling judgement only |
| Customer's own PO date | `mfg_sales_orders.customer_po_date` | nothing |
| Trip date | `scm.trips.trip_date` | lorry capacity counting, DP number mint |
| Service-case (ASSR) leg dates | `assr_cases.sched_*`, mig `0282` | one synthetic board row per set date — **but written into the SO's date keys, §5.5** |

---

## 4. The two modules that deliberately keep their own "processing date"

**Do not merge these. Do not rename them either.**

| what | why it is separate | why a rename is UNSAFE |
|---|---|---|
| `public.sales_entries.processing_date` / `.delivery_date` — the legacy native Sales module (`/sales`, `frontend/src/pages/Sales.tsx`) | a `sales_entry` is a **different document**: no SO row, no doc flow, no deposit gate, no elapsed lock, no `scm.so.remove_processing_date`, no stock allocation | `applyEntryPatch` builds `SET ${k} = ?` from allowlisted keys, and the change-request approval path replays a JSON payload stored days earlier. After a rename those stored keys match nothing and the field is **silently dropped on approve** |
| `public.sales_orders.ac_udf_pdate` — AutoCount's own `SO.UDF_PDate`, copied verbatim | AutoCount's number for AutoCount's document. Renamed off `processing_date` by mig `0285` precisely so nobody joins it | zero readers today; leave it isolated |

One nuance mig `0285`'s note understates: for an ERP-born SO that was written
back, `ac_udf_pdate` is the **round trip** of `scm.mfg_sales_orders.processing_date`
via AutoCount — same value, different row, different table. No code joins them.
Keep the names apart so nobody starts.

**The one thing here the owner can see with his own eyes:** the words
**"Processing Date"** appear as a UI label on `frontend/src/pages/Sales.tsx:1158`
for the `sales_entries` fact, and on ten SCM screens for the SO's fact. Same
words, same app, two different documents. The column must keep its name; **the
label does not have to.** This is the cheapest single fix on the whole list.

---

## 5. Contradictions that are LIVE in production today

These are not naming complaints. Each one is a wrong answer reachable right now.

### 5.1 The stock allocator gates on the WRONG COLUMN — money-costing, live

`backend/src/scm/lib/so-stock-allocation.ts:211-220` carries a comment titled
*"Processing-date allocation gate"* quoting the owner verbatim (*"有 processing
date 才来分配"*) — and then filters on the **other** column:

```
const allocGated = new Set(
  orders.filter((o) => !o.proceeded_at).map((o) => o.doc_no),
);
```

The `.select()` at `:190` does not even fetch `processing_date`.

Meanwhile **`proceeded_at` has exactly two writers left**: create-time
auto-proceed (`routes/mfg-sales-orders.ts:4984`) and `PATCH /:docNo/status` →
IN_PRODUCTION (`:5838`). The header PATCH maps `['proceededAt','proceeded_at']`
at `:6597` — **and no client sends that key**: `grep -rn proceededAt frontend/`
returns **zero**. Nothing in the shipped frontend POSTs `IN_PRODUCTION` either.

So the ordinary path — open an existing SO, set its Processing Date on the detail
screen — writes `processing_date`, leaves `proceeded_at` NULL, and the order is:

* **locked** (`soProcessingLocked` sees the date once the day elapses),
* **on the delivery board** (the board admits on `processing_date`),
* **pushed to AutoCount** as `PDate`,
* and **silently excluded from stock allocation** — every line forced `PENDING`,
  never consuming a bucket or claiming a sofa batch, never reaching
  `READY_TO_SHIP`, **with stock physically on the floor and no error anywhere.**

`docs/modules/sales-order.md` §0.2 calls this *"the single most common 'why is my
order not READY'"* — and then labels the behaviour **"intended"**. It is not: the
owner's rule names the Processing Date and the code reads a different column.
`backend/scripts/unify-processing-date.mjs` says so in its own header — the data
move landed, the **reader flip** was left pending. It is still pending.

**Fix (one line plus one column in a select, source-side, not this PR):** read
`processing_date` at `:219` and add it to the select at `:190`.

### 5.2 `amended_delivery_date` is a delivery date with no rules on it

`SO_HEADER_FIELD_POLICY` (`backend/src/scm/shared/so-field-policy.ts`) declares
`processing_date` and `customer_delivery_date` CONTROLLED, and the file's own rule
is *"every other patchable header column is FREE by omission"*.
**`amended_delivery_date` appears nowhere in it.** So it has: no processing lock,
no amendment approval, no past-date check, no pair rule, no cascade to the lines.

It is also written by an ordinary board click —
`routes/delivery-planning.ts:2323`, `updates.amended_delivery_date =
dateOrNull(p.scheduleDate)` — and it is the date Days-Left and OVERDUE count
against.

Net effect: on a processing-locked, already-PO'd SO the Delivery Date is frozen
and can only move through a Logistics-approved amendment — **but the date the
delivery schedule actually uses can be moved by anyone with the board open, in one
click, with no approval and no lock.**

### 5.3 Two lanes compute "when is this order due" from different columns

| lane | formula | call sites |
|---|---|---|
| Logistics / planning | `amended_delivery_date ?? customer_delivery_date` | `delivery-planning.ts`, `mfg-purchase-orders.ts:798`, `inventory.ts:1548`, `po-so-coverage.ts:167`, `delivery-orders-mfg.ts:3169` |
| Manufacturing / supply | `line_delivery_date ?? customer_delivery_date` | `mrp.ts:611`, `:999-1000`, `:1092`, `:1196-1197`, `:1227`, `inventory.ts:652` |

`grep -c amended_delivery_date backend/src/scm/routes/mrp.ts` → **0**.
Same over `backend/src/scm/lib/so-stock-allocation.ts` → **0** (it orders by
`customer_delivery_date` alone).

**So when logistics reschedules an order, the board and PO coverage move to the
new date while MRP and the stock allocator keep planning and prioritising against
the ORIGINAL.** `routes/inventory.ts` uses **both** formulas, 900 lines apart, in
one file.

This is the same disease as the Processing Date, one layer down — and unlike the
naming, **a rename cannot fix it.** It needs the owner to say which date
production should follow (§8).

### 5.4 `delivery_orders` stores its expected date twice

`routes/delivery-orders-mfg.ts:4071` writes **both** `expected_delivery_at` and
`customer_delivery_date` from `head.customer_delivery_date` in the same INSERT,
differing only in whether a null becomes `today`. The manual create path at
`:3479` falls one back to the other. Both are selected, both are sortable, both
are in the PATCH field map (`:4432`) — **so a user can edit them apart and they
will disagree, with no rule saying which wins.**

### 5.5 The board's synthetic rows put a service-case leg date in `processing_date`

`routes/delivery-planning.ts:1128` (ASSR), `:1288` (DP jobs) and `:1425` (project
legs) each write ONE leg date into **four** keys at once:
`customer_delivery_date`, `amended_delivery_date`, `effective_delivery_date` and
`processing_date`.

`delivery-tms.md` already documents this correctly, including that the intended
`job_date` fix **is not on main** — it was added by `9fa8e0ff` and deleted by a
batch-merge conflict resolution. Two SOURCE comments still tell the reader
otherwise and are out of scope for a docs-only change:
`backend/src/scm/shared/so-processing-date.ts:26-28` and
`frontend/src/mobile/MobileDeliveryPlanning.tsx:145`.
**`grep -rn job_date backend/src` returns one hit, and it is that comment.**

---

## 6. Dead and orphan date columns

| column | state | evidence |
|---|---|---|
| `mfg_sales_orders.sales_exemption_expiry` | **ZERO WRITERS, STILL RENDERED.** Selected by the SO header read, the consignment shape and reports; rendered at `frontend/src/pages/scm-v2/SalesOrderDetailListing.tsx:439-441` as **"Tax Exemption Expiry"**, sortable, `filterType: 'date'`. Nothing in the product ever fills it. | same shape as the 2026-07-24 "blank Processing date" incident that mig `0189` was written to end |
| `mfg_sales_orders.target_date` | **ORPHAN.** No screen sends it, but it is still accepted and persisted by four API paths: SO create (`mfg-sales-orders.ts:5067`), SO PATCH map (`:6608`), CO create, CO PATCH map (`consignment-orders.ts:1152`). `SalesOrderDetail.tsx` says it was *"replaced by Processing + Delivery Date"*. | an open second home for a delivery-ish date, reachable by any API caller |
| `mfg_sales_orders.internal_expected_dd` | **GONE from the database.** Mig `0286` renamed it, with a post-condition that RAISEs if any relation in schema `scm` still carries the name. | survives only as the two deliberate aliases — and in ~20 SOURCE comments that still call it "the storage" |
| `consignment_sales_orders.processing_date` (the DEAD legacy twin) and `consignment_sales_orders.proceeded_at` | **DROPPED** — mig `0286` step 1 and mig `0284`. Closed; do not re-open. | |
| `mfg_sales_orders.payment_date` | **REDUNDANT, LOW RISK.** A denormalised header copy of `mfg_sales_order_payments.paid_at`; both fed from the same request key. Nothing gates on the date. | tidy-up, not a hazard |

**⚠ The `sales_exemption_expiry` name means two different things on the two sides
of the AutoCount integration.** The ERP's own column is dead — but AutoCount's
field of *that exact name* is where the ERP writes the **customer delivery date**
(`services/autocount-writeback.ts:1697`, `customer_delivery_date:
'SalesExemptionExpiryDate'`). Anyone who "fixes" one by reasoning from the other
will corrupt delivery dates in AutoCount.

---

## 7. One more divergence, deliberate on one side and unexamined on the other

The SO's header delivery-date cascade **destroys** per-line overrides
(`line_delivery_date_overridden = false` for every line, unconditionally — mig
`0173`, and `lib/so-revision.ts` on amendment approve). The Consignment Order's
cascade **respects** them (`WHERE line_delivery_date_overridden = false`,
`routes/consignment-orders.ts`).

The SO behaviour is argued for in `so-revision.ts` (*"so MRP's order-by
derivation … stays accurate"*). The CO was cloned from the SO and reasons the
opposite way. **Neither file mentions the other.** `line_delivery_date_overridden`
exists to prevent exactly this, and on the SO it is never consulted — so a
per-line delivery date a human typed is silently discarded the next time anyone
edits the header date, and that moves the line's material priority in MRP with
nobody touching it.

This one is a **decision**, not a defect: see §8.

---

## 8. What only the owner can decide

Business meaning, not implementation. Recommendations given, not menus.

1. **When logistics reschedules a delivery, should the factory rebuild to the new
   date?** Today the board moves and MRP does not (§5.3).
   *Recommendation: yes — make `amended_delivery_date` part of the supply lane's
   effective-date chain, through ONE shared helper on the model of
   `effective-delivery.ts`. A reschedule that production never hears about is the
   whole reason the two answers exist.*
2. **Should a per-line delivery date survive a header date change?** The SO says
   no, the CO says yes (§7).
   *Recommendation: make the SO behave like the CO — respect the override flag.
   The flag exists for no other purpose, and silently discarding a date a human
   typed is worse than a stale line date, which MRP can at least see.*
3. **Should moving a date on the delivery board be as free as it is?** (§5.2)
   *Recommendation: no. Put `amended_delivery_date` in `SO_HEADER_FIELD_POLICY`
   as CONTROLLED with the same lock the Delivery Date has. Locking one and leaving
   the other open means the lock protects nothing that matters.*
4. **Is the native Sales module's "Processing Date" the same idea as the SO's?**
   *Recommendation: no, and the code already treats them as separate. Keep both
   columns; change the LABEL on `Sales.tsx` (e.g. "Entry Processing Date") so the
   same two words stop naming two documents.*
5. **`target_date` — was it ever meant to be a date the business uses?** No screen
   writes it and no rule reads it, but the API still accepts it.
   *Recommendation: retire it. If Marketing genuinely needs a "target date" stamp,
   it should be re-specified, not resurrected.*

---

## 9. What this page does NOT know

Written down on purpose, because a doc that hides its gaps is how this repo got
docs that lie.

* **No production database was queried.** Every count here is a count of SOURCE.
  Any figure about how many ORDERS are in a given state — including the
  "81.9% of Houzs demand is undated" number quoted in various write-ups — is
  **not verified here.** The mechanism behind it was confirmed (the AutoCount
  cutover importer's column list carries neither a delivery nor a processing
  date); the number was not.
* **`backend/scripts/scm-schema/2990s-full-schema.sql` is a dump of the 2990
  SOURCE system, not this database's DDL, and it is already known to lag
  production.** It shows `mfg_sales_orders` carrying BOTH `processing_date` and
  `internal_expected_dd`, and carries no `amend_date_from_customer` or
  `possession_date` at all. Use it for enum labels and FK shapes, never as an
  answer to "what columns does the SO have".
* **The ~20 remaining source comments that still name `internal_expected_dd` as
  the storage are listed nowhere in this file by line**, because line numbers rot.
  Re-derive them: `grep -rn 'internal_expected_dd\|internalExpectedDd' backend/src
  frontend/src`. Every hit that is not one of the two alias constants in
  `so-processing-date.ts`, or a test, is a comment pointing at a column that no
  longer exists.
* **Company 2 (2990) was not audited.** The mirror route
  (`routes/so-mirror.ts`) deliberately does **not** run the pair rule — that is a
  documented decision, not an omission, because refusing a mirror row wedges
  2990's outbox drainer forever. So the pair invariant is enforced for company 1
  by construction and for company 2 only by 2990's own write paths. If unpaired
  company-2 rows ever need counting, that is
  `backend/scripts/probe-so-date-xor.mjs`, per company.
* **Nothing here was measured against a running Worker.** "No client sends
  `proceededAt`" is a statement about `frontend/` in this repo — it says nothing
  about the POS/native surface or any direct API caller.

---

## 10. How to re-run this census

```
# every date/timestamp column the SO actually carries, from the migrations
grep -rhoiE 'ADD COLUMN[^;]*"?[a-z_]+"? (date|timestamptz|timestamp)' \
  backend/src/db/migrations-pg/ > /tmp/date-cols.txt; echo "rc=$?"; wc -l < /tmp/date-cols.txt

# who WRITES a column (not merely mentions it)
grep -rnE "processing_date['\"]?\s*[:=]" backend/src > /tmp/w.txt; echo "rc=$?"; wc -l < /tmp/w.txt

# the two-lane split
grep -c amended_delivery_date backend/src/scm/routes/mrp.ts backend/src/scm/lib/so-stock-allocation.ts
```

**Redirect to a file and check the real `rc`.** `grep … | head; echo $?` reports
**head's** status — that turned "found nothing" into "check passed" twice in one
week in this repo.

---

## See also

* `backend/src/scm/shared/so-processing-date.ts` — the naming authority for the
  Processing Date, and the standard of honesty this page is modelled on. Note its
  header currently still calls `proceeded_at` *"stop-writing / stop-reading"* and
  still says the CO's date is `internal_expected_dd`; both are false on `main`
  today (§5.1, mig `0286`). They are source comments and are out of scope for a
  docs-only change.
* `backend/src/scm/shared/effective-delivery.ts` — what "done" looks like: four
  names, one shared reader.
* `docs/modules/sales-order.md` — the SO's gate tables and the mig `0286` incident.
* `docs/modules/delivery-tms.md` — the board's date columns and the `job_date`
  correction.
