# Module: Sales Invoice (SCM)

Per-module technical doc — the data flow from the screen down to the database,
plus the performance characteristics. Sibling of `sales-order.md`; the SI is a
clone of the Delivery Order API (itself an SO clone), with two things neither
of them has: **GL revenue posting** and a hard **ISSUED = FROZEN** rule.

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.
>
> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Doc-flow position: **SO → DO → SI**. The SI is the end of the sell chain and the
only document in it that leaves the building as a customer's own copy.

---

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/SalesInvoicesListV2.tsx` | Server-paginated, `pageSize = 50` (`:777`). |
| Desktop detail | `frontend/src/pages/scm-v2/SalesInvoiceDetailV2.tsx` | Header + lines + payments. Status flags computed at `:991-998`. |
| Desktop new | `frontend/src/pages/scm-v2/SalesInvoiceNew.tsx` | |
| Desktop from-DO | `frontend/src/pages/scm-v2/SalesInvoiceFromDo.tsx` | Line-level picker over `/invoiceable-do-lines`. |
| Desktop report | `frontend/src/pages/scm-v2/SalesInvoiceDetailListing.tsx` | Detail-listing report. |
| Mobile list | `frontend/src/mobile/MobileModuleList.tsx` | `MODULE_CONFIGS["sales-invoices"]` (`:1113-1152`). Balance is computed client-side as `total − paid`, floored at 0 (`balanceCenti`, `:287-291`). |
| Mobile detail | `frontend/src/mobile/MobileModuleDetail.tsx` | Config `:275`; status actions `:498-511`. |
| Mobile convert (DO→SI) | `frontend/src/mobile/MobileConvertWizard.tsx` | `target = "si"` (`:73`). |

Desktop routes: `frontend/src/App.tsx:658-661`, behind
`<ScmGuard area="scm.sales.invoices" allowSales>` for list + detail, without
`allowSales` for new / from-do.

### Data hooks
`frontend/src/vendor/scm/lib/sales-invoice-queries.ts`

- `useSalesInvoicesPaged({page,pageSize,status,q,sort})` (`:46`) — the desktop list.
  `queryKey: ['sales-invoices-paged', ...]`, `placeholderData: prev`,
  `staleTime: 30_000`.
- `useSalesInvoices(status?)` (`:29`) — legacy unpaginated,
  `['sales-invoices', status ?? 'all']`.
- `useSalesInvoiceDetail(id)` (`:63`) — `['sales-invoice-detail', id]`.
- `useSalesInvoicePayments(id)` (`:295`) — `['sales-invoices', id, 'payments']`,
  `staleTime: 2 * 60_000`.
- `useInvoiceableDoLines()` (`:163`) — `['sales-invoices', 'invoiceable-do-lines']`.

**The accounting fan-out is the distinguishing feature of this hook file.** Every
mutation that can move revenue also invalidates the ledger queries —
`['journal-entries']`, `['account-balances']`, `['ar-aging']` — EXCEPT `useAppendDoToSalesInvoice`, which invalidates the first two but NOT `['ar-aging']` (`sales-invoice-queries.ts:206-215`, read 2026-08-12) even though its endpoint posts revenue on a non-draft SI (`sales-invoices.ts` append handler) — the exact staleness gap this paragraph warns about, live in one of the four hooks. See
`useCreateSalesInvoice` (`:89-92`), `useUpdateSalesInvoiceStatus` (`:105-111`),
`useConvertDosToSi` (`:186-189`) and `useAppendDoToSalesInvoice` (`:207-210`).
A new SI mutation that forgets those three keys leaves the Accounting screens
stale.

`useConvertDosToSi` additionally force-refetches the two DO-side pickers and the
DO list (`:193-195`), because invoicing consumes a DO line's remaining pool.

### Caching / loading behaviour
Three layers as in `docs/modules/sales-order.md` §1. SI specifics:

- `"sales-invoices"` is whitelisted for the localStorage snapshot
  (`frontend/src/lib/query-persist.ts:96`); `"sales-invoices-paged"` is a
  different first segment and is not.
- `['sales-invoices', <id>, 'payments']` is explicitly excluded from persistence
  (`query-persist.ts:100-133`) — a persisted payment ledger of unknown age
  reads exactly like a fresh one.

---

## 2. API surface

`backend/src/scm/routes/sales-invoices.ts`, mounted at `/api/scm/sales-invoices`
(`backend/src/scm/index.ts:267`) behind
`scmAreaGuard('scm.sales.invoices', { readInheritsFrom: 'scm.sales.orders' })`
(`:266`) — a salesperson may READ (and re-send) the invoices raised off their own
SOs; writes need `edit` on `scm.sales.invoices`.

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/` | `:651` | List. `?page=` opts into pagination + `statusCounts`. |
| GET | `/invoiceable-do-lines` | `:749` | DO lines with `remaining > 0`. |
| GET | `/:id` | `:759` | Header + items. Sales-scoped, finance-gated. |
| POST | `/` | `:797` | Create. `asDraft: true` → DRAFT (no GL); else posts revenue at `:946`. |
| POST | `/from-dos` | `:985` | Line-level batch convert from DO picks. |
| POST | `/:id/items/from-do/:doId` | `:1216` | Append another DO's lines onto an existing invoice. |
| PATCH | `/:id` | `:1319` | Header edit (ISSUED-gated, see §6). |
| POST/PATCH/DELETE | `/:id/items[/:itemId]` | `:1426` / `:1515` / `:1632` | Line CRUD (frozen once issued). |
| GET/POST/DELETE | `/:id/payments[/:paymentId]` | `:1685` / `:1777` / `:1850` | Payments ledger. |
| PATCH | `/:id/status` | `:2182` (handler `:1896`) | Confirm / cancel / reopen. |
| PATCH | `/:id/payment` | `:2186` | Legacy single-payment path. |

Deployment prerequisites recorded in the mount comment (`index.ts:258-261`):
`scm.sales_invoice_payments` + `scm.customer_credits` applied from
`backend/scripts/scm-schema/0103-0110-si-payments-and-credits.sql`, and
`scm.accounts` seeded with codes **1100** (AR) and **4000** (Sales Revenue) for GL
posting.

---

## 3. Backend

### The list handler — `salesInvoices.get('/')` (`:651-745`)

1. **Row scope** (`:655`) — `resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id,
   canViewAllSales(c))` → `.in('salesperson_id', scopeIds)`. Pass the **Houzs**
   user id, not `user.id` (the comment at `:654` records that as the non-admin 500).
2. **Two paths, chosen by `page`** (`:662-663`).
   - Legacy (`:665-675`): `order invoice_date desc`, `.limit(500)`, scope, raw
     `status`, `scopeToCompany`.
   - Paginated (`:677-744`): sort whitelist
     `invoice_date | invoice_number | debtor_name | status | total_centi` (`:682`)
     with `invoice_number` as tiebreaker; bucket resolution via
     `SI_STATUS_BUCKETS` (`:542-547`); `q` ilikes over `invoice_number,
     so_doc_no, debtor_name, debtor_code, ref, branding, sales_location` plus
     normalized phone parts (`:706-710`); `from`/`to` on `invoice_date`.
   - `statusCounts` = five `head:true count:'exact'` in one `Promise.all` (`:728-734`).
3. **Enrichment — THREE batched, row-mutating passes**, all called on BOTH list
   paths: `stampSoDates`, `stampDoNumber` and `stampSourcePos` (:675, :699,
   :725). None is per-row. `stampDoNumber` exists because the SI stores its
   Delivery Order only as `delivery_order_id` (there is no `do_doc_no` column),
   so the list cannot show a readable "From DO" without resolving the ids.
   `stampSoDates` pulls `mfg_sales_orders.processing_date` +

   `customer_delivery_date` for the distinct `so_doc_no` set and stamps
   **`so_processing_date`** (the linked SO's "Processing date") and
   **`so_customer_delivery_date`** (delivery-date fallback for pre-snapshot SIs)
   on each row — both list paths. Feeds the SI quick-view drawer (desktop
   `SalesInvoicesListV2` + mobile `MobileModuleList`). **Both are DERIVED
   response keys read as strings** (mobile via `pick(r, "soProcessingDate",
   "so_processing_date")` — `MobileModuleList.tsx:1147,1198`; corrected
   2026-08-14, this line named `soInternalExpectedDd` /
   `so_internal_expected_dd`, which mig 0286 retired on both ends), so a rename
   of the SO column must move this key
   on BOTH ends or neither — a backend-only rename blanks the column with no
   error. See docs/modules/sales-order.md, "surfaces that read this date by
   NAME". There is still no `has_children` on an SI because nothing hangs off it.
   `stampSourcePos` (both list paths) additionally stamps **`source_pos`** per
   row — **since 2026-08-02 via `resolveSiHeaderSources`: the union of the SI's
   OWN invoiced lines' traces (each line matched into its DO's ledger buckets,
   the exact per-line rule the SI detail applies), never the DO's raw `byDo`
   rollup** (which surfaced orphan ledger buckets as phantom chips and could
   include DO lines the SI never invoiced — header ≡ ∪(lines)); the SI detail
   resolves per-line `source_pos` from the SI's DO ledger through the same lib.
   Since 2026-08-01 both also carry **`source_adj`** (shipped from a PO-less
   stock ADJUSTMENT lot → a "STOCK ADJ" chip, desktop + mobile detail, never a
   blank), and NULL-batch GRN lots are healed to their PO at read time. An SI
   is born FROM a Sales Order, so it shows **Source PO** (`batch_no` = source
   PO), NOT an Assigned SO — see `docs/modules/document-traceability.md` §2.5 +
   §2.8 + §2.9 (owner 2026-07-31 / 2026-08-01 / 2026-08-02). A manual SI with
   no DO shows "—".
4. **Finance gate** — `gateSiFinance(rows, canViewScmFinance(c))` (`:213-220`)
   deletes every `SI_FINANCE_KEYS` column (`:205-209`) from every row. Applied on
   both list paths and on the detail (`:787-792`, which also strips
   `SO_ITEM_FINANCE_KEYS` from each line).

### Main mutation paths

- **Create** (`:797`). Validates item codes, then `asDraft === true` lands DRAFT
  with `sent_at` / `confirmed_at` NULL and **commits nothing** — no AR/GL, no
  customer credit (`:872-876`). A non-draft create calls `postSiRevenue` at
  `:946`.
- **Confirm** (DRAFT → SENT, inside the status handler at `:1958-2005`). Stamps
  `sent_at` + `confirmed_at` with a `.eq('status','DRAFT')` race gate (`:1969-1971`),
  posts revenue (`:1978`, idempotent), then auto-applies any customer credit.
  A lost race returns an idempotent echo with no second posting (`:1975`).
- **Cancel** (`:2055-2135`). Atomic `.neq('status','CANCELLED')` update, then
  `reverseSiRevenue` (`:2095`) and `creditFromCancelledSi` (`:2122`).
- **Reopen** (CANCELLED → SENT only). Re-posts revenue (`:2139`) and reverses the
  cancellation credit (`:2162`); the delivered-qty re-check guards against the
  goods having been re-invoiced meanwhile (`:2035`).
- **Any line/total change on a live invoice** calls `resyncSiRevenue`
  (`:1510`, `:1627`, `:1679`) — a void + repost of the JE. That mechanic is the
  owner's 2026-06-01 ruling and is deliberately untouched; what makes it correct
  is the ISSUED gate in front of it (see §6).
- **Payments** (`:1777`). Refuses CANCELLED and DRAFT (`:1782-1786`), then
  `recomputePaid` (`:1730`) re-sums the ledger and re-derives the status ladder.

### `recomputePaid` (`:1730-1775`) — read this before touching payments

Fails **closed**: a failed payments read or header read aborts with a log rather
than writing `paid = 0` (`:1738-1752`). The comment records why — folding a
transient blip into 0 does not merely understate `paid_centi`, it drives the
status ladder, so a fully PAID invoice silently reverted to SENT and re-entered
the AR chase. DRAFT and CANCELLED are frozen out of the ladder entirely
(`:1760`).

### Status canonicalisation

`canonicalSiStatus` (`:568`) maps every accepted spelling to one of
DRAFT / SENT / PARTIALLY_PAID / PAID / OVERDUE / CANCELLED via `SI_STATUS_CANON`
(`:552-567`). It runs **before any branch** in the status handler (`:1912`). The
comment at `:1901-1911` is the post-mortem: a lowercase `'cancelled'` used to be
persisted verbatim and slip past the `status === 'CANCELLED'` gate, so a SENT
invoice was marked cancelled **without reversing AR/GL revenue** while
`do-line-remaining` (which upper-cases) freed the delivered goods for
re-invoicing.

`SI_LEGAL_TRANSITIONS` (`:635-642`) is the single transition authority. Nothing
moves back to DRAFT; a CANCELLED invoice may only reopen to SENT. An
**unrecognised persisted** status fails OPEN so a legacy row is never bricked.

---

## 4. Database

Schema `scm`. Baseline DDL `backend/scripts/scm-schema/2990s-full-schema.sql:1305`
(`sales_invoices`) and `:1277` (`sales_invoice_items`); the payments + credits
tables come from `backend/scripts/scm-schema/0103-0110-si-payments-and-credits.sql`.
The authoritative in-code column lists are `HEADER` (`sales-invoices.ts:187-198`),
`ITEM` (`:222-225`) and `PAYMENT_COLS` (`:237-240`).

| Table | Role |
|-------|------|
| `scm.sales_invoices` | SI header. `invoice_number`, `so_doc_no`, **`delivery_order_id`** (the DO link), `debtor_code/name`, `invoice_date`, `due_date`, `currency`, `subtotal_centi`, `discount_centi`, `tax_centi`, `total_centi`, **`paid_centi`**, `salesperson_id`, `branding`, `venue_id`, per-category revenue + cost subtotals, `local_total_centi`, `total_cost_centi`, `total_margin_centi`, `line_count`, `status`, `sent_at` / `paid_at` / `confirmed_at`, `company_id`. |
| `scm.sales_invoice_items` | SI lines. `so_item_id`, **`do_item_id`** (what the remaining-pool maths joins on), `item_code`, `item_group`, `qty`, `unit_price_centi`, `discount_centi`, `tax_centi`, `line_total_centi`, `unit_cost_centi`, `line_cost_centi`, `line_margin_centi`, `variants`. |
| `scm.sales_invoice_payments` | Payments ledger. Same method vocabulary as the DO ledger. `recomputePaid` sums `amount_centi` over this table. |
| `scm.customer_credits` | Overpay / cancelled-invoice credit. Written by `applyCustomerCreditToSi`, `creditFromCancelledSi`, `reverseCancelledSiCredit`, `reconcileSiOverpay` (`backend/src/scm/lib/customer-credits.ts`). |
| `journal_entries` + `journal_entry_lines` | GL. Dr **1100** (AR) / Cr **4000** (Sales Revenue) = `total_centi`, keyed on `(source_type='SI', source_doc_no=invoice_number)` so it can never double-post (`sales-invoices.ts:10-14`). |
| `scm.delivery_orders` / `scm.delivery_order_items` | Upstream. The DO's `has_children` lock counts non-cancelled SIs. |

Status vocabulary: canonical set at `:552-567`. Filter buckets (`:542-547`):
`sent` = DRAFT+SENT+ISSUED, `partial` = PARTIALLY_PAID+PARTIAL,
`paid` = PAID+COMPLETED, `cancelled` = CANCELLED. Note `sent` deliberately
includes DRAFT.

---

## 5. Stock direction

**A Sales Invoice moves NO inventory, in either direction, at any status.**

Verified 2026-08-13: `backend/src/scm/routes/sales-invoices.ts` contains **zero**
references to `inventory_movements`, `writeMovements`, or any movement table
(grep over the whole 2,547-line file returns nothing). The goods left at the
**Delivery Order**
(`docs/modules/delivery-order.md` §5); by the time an SI exists the stock has
already moved.

What the SI moves instead is **money and the ledger**:

| Event | What is written |
|-------|-----------------|
| Create (non-draft) or DRAFT→SENT confirm | `postSiRevenue` → Dr 1100 / Cr 4000 for `total_centi` (`:946`, `:1978`) |
| Line or total change on a live invoice | `resyncSiRevenue` → void + repost (`:1510`, `:1627`, `:1679`) |
| Cancel | `reverseSiRevenue` (`:2095`) + `creditFromCancelledSi` (`:2122`) |
| Reopen | `postSiRevenue` (`:2139`) + `reverseCancelledSiCredit` (`:2162`) |
| Payment add/delete | `recomputePaid` (`:1730`) + `reconcileSiOverpay` (`:1818`, `:1864`) |

GL posting failures never roll back the invoice — audit-DLQ pattern, stated in
the file header (`:14`).

The **quantity** an SI consumes is the DO line's remaining invoiceable pool
(`doInvoiceableRemaining`, `:398`; `checkSiOverRemaining`, `:403`), not stock.

---

## 5a. Carried-over deliveries cannot be invoiced by hand

A delivery order flagged `migrated_no_stock` (migration 0276) was carried over
from AutoCount at the 2026-08 cutover, and AutoCount already raised its sales
invoice. Every path that can attach one to an invoice refuses it with **409
`migrated_source_document`**:

| path | how it reaches the delivery |
|---|---|
| `POST /from-dos` | delivery ids from the picks |
| `POST /` | `body.deliveryOrderId`, or a line's `doItemId` |
| `POST /:id/items` | the line's `doItemId` |
| `POST /:id/items/from-do/:doId` | the delivery id in the path |

One migrated document anywhere in the pick refuses the WHOLE invoice — a partial
invoice cannot carry AutoCount's number, so the pick is never silently narrowed
to the ordinary rows. A failed source lookup returns 500 rather than proceeding:
a guard that fails open is not a guard.

The invoices for those deliveries are written by
`backend/scripts/create-migrated-invoices.mjs`, numbered
`HC-<AutoCount's invoice number>`, flagged `migrated_no_stock` on
`scm.sales_invoices` (migration 0280). Such an invoice posts **no** revenue
journal — `postSiRevenue` reads the flag on its own header and returns
`{ ok: true, status: 'migrated_source' }` before writing anything, so every
caller is covered rather than every call site. `revenue.posted` is `false` and
there is no `jeNo`; that is success, not failure.

It also spends **no customer credit**. `applyCustomerCreditToSi` re-reads the
header and returns `{ applied: 0, reason: 'migrated_source' }` — paying a
carried-over invoice out of the customer's ERP balance would spend a real
balance a second time, on paperwork AutoCount already settled. A failed read
refuses (`migrated_check_failed`) rather than proceeding. What is deliberately
NOT blocked: a payment an operator records against a migrated invoice behaves
normally, and cancelling it still turns the paid amount into credit — that money
moved in THIS book and is ours to account for.

## 6. What locks and when

The governing rule is in the file header (`:16-27`) and implemented as
`isIssuedSi` (`:587-590`):

> **ISSUED = every status except DRAFT and CANCELLED.**

Not PAID — the SENT → PARTIALLY_PAID window is most of an invoice's life and is
exactly when the customer is holding the PDF deciding what to pay. An
**unrecognised** status counts as issued (fails closed).

| Trigger | What stops being editable | Enforced at |
|---------|---------------------------|-------------|
| Status is issued | header fields `invoiceDate`, `currency`, `debtorName`, `debtorCode` — and only those four | `SI_ISSUED_FROZEN_FIELDS` (`:607-612`), checked `:1358-1367`. Rejected as a **set** with a readable message, never silently dropped. |
| Status is issued | **all** line add / edit / delete — frozen wholesale, not field-by-field | `SI_ISSUED_LINE_MESSAGE` (`:623`), checked at `:1445-1447` and the sibling line handlers |
| Status CANCELLED | every header edit and line add | `:1350-1352`, `:1439-1441` — "reopen it before editing" |
| Status CANCELLED or DRAFT | recording a payment | `:1782`, `:1786` |
| Illegal transition | the status flip | `SI_LEGAL_TRANSITIONS` (`:635-642`), checked `:1942-1950` |
| Not in the caller's sales scope | header PATCH, detail GET, payments GET | `salesDocOutOfScope` (`:1344`, `:776`) — answers 404, indistinguishable from missing |

Why the header freeze is narrow: every other header field (phone, email, address,
agent, venue, remarks) stays editable forever, because correcting a typo'd phone
number on a 3-month-old invoice is a real workflow and changes neither what is
owed nor the GL (`:592-597`). `invoice_date` earns its place because
`postSiRevenue` fixes the JE's `entry_date` from it while `resyncSiRevenue`
compares only the total — moving an issued invoice's date would strand its JE in
the original period (`:599-606`).

**Amendment path — yes: cancel → fix → reopen.** It is first-class, not a
workaround: cancel reverses revenue and mints a credit, reopen re-posts and
reverses the credit, and `recomputePaid` re-derives the payment status from the
ledger. It is the sanctioned correction route for an issued invoice
(`:621-622`, `:643-648`). There is no in-place revision table for an SI.

Frontend mirror: `SalesInvoiceDetailV2.tsx:991-998` computes `isDraft` /
`isCancelled` / `isTerminal` and gates the action bar (`:1130-1150`) and the
payments panel (`:1481`) off them.

---

## 7. The cost / money columns — frozen vs live

Everything is integer sen.

| Column | Where | Frozen or live |
|--------|-------|----------------|
| `unit_price_centi`, `discount_centi`, `tax_centi`, `line_total_centi` | line | Live **only while DRAFT**. Frozen the moment the invoice is issued (§6). |
| `unit_cost_centi`, `line_cost_centi`, `line_margin_centi` | line | **Live — overwritten in place** by `restampSiFromDo` (`backend/src/scm/lib/recost.ts:113`), which the GRN/PI recost cascade calls whenever a supplier invoice lands. This is the ③ "landed cost" leg of the three-way comparison; it is deliberately allowed to move after issue because it is internal cost, not the customer-facing price. |
| `subtotal_centi`, `discount_centi`, `tax_centi`, `total_centi` | header | Derived by `recomputeTotals` (`:264`); `total_centi` is what the GL posts. |
| `paid_centi` | header | Derived by `recomputePaid` (`:1730`) from `sales_invoice_payments`. Never hand-set on the route paths — with ONE legacy exception: when the `apply_customer_credit_to_si` RPC is absent, `applyCustomerCreditToSiLegacy` (`customer-credits.ts:248-257`) hand-writes it in an optimistic-concurrency loop; callers then run `recomputePaid` so it converges. |
| per-category `*_centi` / `*_cost_centi`, `total_cost_centi`, `total_margin_centi`, `margin_pct_basis` | header | Derived; **finance-gated** (`SI_FINANCE_KEYS`, `:205-209`). `total_centi`, `local_total_centi` and `paid_centi` are NOT gated — everyone sees what is owed. |
| `amount_centi` | `sales_invoice_payments` | The ledger rows `paid_centi` sums. |

`recomputeTotals` (`:264`) **fails closed and never throws** (`:254-263`): a read
it cannot vouch for must not become a written total, and it aborts by logging
rather than throwing because it runs after its triggering line write already
committed — a throw would become a 500 the client retries into a duplicate line.

Price-drift warnings: `siPriceDriftWarnings` (`:488`) flags a line whose price
diverges from the source DO by more than `SI_PRICE_DRIFT_THRESHOLD = 0.005`
(`:484`) and returns them alongside the response (`withPriceWarnings`, `:531`) —
a warning, not a block.

---

## 8. Desktop and mobile files that must change together

| Concern | Desktop | Mobile |
|---------|---------|--------|
| List columns / filters / buckets | `pages/scm-v2/SalesInvoicesListV2.tsx` | `mobile/MobileModuleList.tsx` config `:1113` |
| Balance display (`total − paid`) | `SalesInvoicesListV2.tsx` / `SalesInvoiceDetailV2.tsx` | `mobile/MobileModuleList.tsx` `balanceCenti` (`:287`) — a duplicated computation, so a change to how balance is derived must land on both |
| Server pagination opt-in | `useSalesInvoicesPaged` | `mobile/MobileModuleList.tsx` `SERVER_PAGINATED` (`:326`) |
| Detail fields | `pages/scm-v2/SalesInvoiceDetailV2.tsx` | `mobile/MobileModuleDetail.tsx` config `:275` |
| Confirm / Cancel / Reopen | `SalesInvoiceDetailV2.tsx:1130-1150` | `mobile/MobileModuleDetail.tsx:498-511`, gated by `useMayOperateDoc` (`:454`) → `canOperateSalesInvoices` (`frontend/src/auth/salesAccess.ts:210`) — the SAME helper the desktop uses |
| DO→SI conversion | `pages/scm-v2/SalesInvoiceFromDo.tsx` | `mobile/MobileConvertWizard.tsx` (`target: "si"`) |
| Cache invalidation after a write | the hooks in `vendor/scm/lib/sales-invoice-queries.ts` (including the three ledger keys) | `mobile/sharedInvalidate.ts:70` |

`canOperateSalesInvoices` matters here for the same reason as on the DO: Sales
staff get view + Print PDF but no operate, on both surfaces, resolved through one
helper (`salesAccess.ts:187-196`).

---

## 9. Performance summary

Optimized:
- List does **zero** per-row enrichment reads — its three enrichment passes
  (`stampSoDates` / `stampDoNumber` / `stampSourcePos`) are each ONE batched read
  keyed by the page's ids, and there is still no `has_children` to compute
  because nothing hangs off an SI.
- Detail loads header + items in one `Promise.all` (`:761-766`).
- Desktop list is server-paginated (50/page) with server-side search, sort and
  status counts.
- The finance gate is a plain in-place `delete` over the already-fetched rows
  (`:213-220`), not a second query.

Watch as data grows:
- The legacy unpaginated path still `.limit(500)` (`:667`).
- `statusCounts` costs five `count:'exact'` queries per paginated request
  (`:728-734`), each carrying the sales-scope `.in(...)`.
- `resolveSalesScopeIds` runs on every list request (`:655`); a deep reporting
  downline makes the scope array large.
- `resyncSiRevenue` is a **void + repost** of the journal entry and fires on every
  line-level change to a live invoice (`:1510`, `:1627`, `:1679`). Bulk line edits
  therefore write GL churn proportional to the number of edits, not to the number
  of invoices.
- AR aging (`/outstanding/summary`) is called out in
  `docs/perf-optimization-plan.md` §G9 as the server-snapshot candidate as debtor
  count grows. **That candidate SHIPPED and this paragraph outlived it** (read
  2026-08-12): `GET /outstanding/summary?snapshot=1` serves the materialized
  view `scm.mv_ar_aging` (`outstanding.ts:135-161`, migration
  `0152_scm_mv_ar_aging.sql`), refreshed nightly by the `0 2` cron
  (`index.ts` REFRESH MATERIALIZED VIEW CONCURRENTLY). The live query stays
  the default; the snapshot is opt-in and only honoured with no date range.
  data grows.

Cross-module context: `docs/perf-optimization-plan.md`. Route/permission
inventory: `docs/generated/`.
