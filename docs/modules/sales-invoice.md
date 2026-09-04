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
| Desktop list | `frontend/src/pages/scm-v2/SalesInvoicesListV2.tsx` | Server-paginated, `pageSize = 50` (`:777`). Outstanding column / cards / drawer / KPI are all net of the source order's deposit, via `vendor/scm/lib/si-outstanding.ts`; a `dep` marker on the cell and an off-by-default **SO deposit** column say why the figure is smaller. **Mark paid** here opens the detail screen's payment editor rather than writing a status — see the section below. |
| Desktop detail | `frontend/src/pages/scm-v2/SalesInvoiceDetailV2.tsx` | Header + lines + payments + a separate read-only **Collected on `<SO>`** panel. `outstandingOf` / `effectiveOf` both take the applied order deposit as a REQUIRED argument, so the Outstanding figure and the status pill cannot disagree. **Mark paid** records a receipt — it does not write a status; the rule is `frontend/src/pages/scm-v2/markPaidPlan.ts`, see the section below. |
| Desktop new | `frontend/src/pages/scm-v2/SalesInvoiceNew.tsx` | Salesperson picker — see the note under this table. |
| Desktop from-DO | `frontend/src/pages/scm-v2/SalesInvoiceFromDo.tsx` | Line-level picker over `/invoiceable-do-lines`. |
| Desktop report | `frontend/src/pages/scm-v2/SalesInvoiceDetailListing.tsx` | Detail-listing report. |
| Mobile list | `frontend/src/mobile/MobileModuleList.tsx` | `MODULE_CONFIGS["sales-invoices"]` (`:1113-1152`). Balance is `balanceSen`, which since 2026-08-23 also subtracts the source order's deposit through `vendor/scm/lib/si-outstanding.ts`. Shared with purchase invoices, whose rows carry no such key, so PI is untouched. |
| Mobile detail | `frontend/src/mobile/MobileModuleDetail.tsx` | Config `:275`; status actions `:498-511`. |
| Mobile convert (DO→SI) | `frontend/src/mobile/MobileConvertWizard.tsx` | `target = "si"` (`:73`). |

> **The Salesperson picker names the person the source document already carries
> (2026-08-21).** It reads `usePickableStaff({ onlySales: true, include: [<the
> source doc's salesperson_id>] })`. `onlySales` narrows to Sales positions
> (owner 2026-07-22), and `include` is what stops that narrowing labelling a
> sitting employee **"(former staff)"** — the label is now reachable only for a
> row that genuinely is gone. Contract: `team-members.md`, *"`GET
> /staff/pickable` ALWAYS holds the caller"*. Trace:
> `docs/bugs/0504-the-salesperson-picker-hid-the-person-using-it-so-the-so-sai.md`.

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

> **Right-click on a list row** opens the same actions — see
> `docs/modules/document-conversion.md` §8a for the shape, the table of what
> every list offers, and the two absences that are deliberate.

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

**Which deliveries may be invoiced — the server's answer, since 2026-08-18.** Both
entry points above call `siTransferRefusal` (`scm/lib/do-line-remaining.ts`),
which reads the one declaration `SI_TRANSFERABLE_DO_STATES`
(`scm/shared/do-shipped-states.ts`). Before it, the rule lived only in clients and
had four disagreeing spellings — this route refused just `CANCELLED`, so anything
else went through from the API or a phone while the desktop greyed the button out.
Three 409s, and the codes matter to API callers:

| code | when |
|---|---|
| `do_cancelled` | the delivery was cancelled — raise a new one |
| `do_not_confirmed` | still a DRAFT; #2485 keeps Confirm a prerequisite |
| `do_not_transferable` | any other status, `INVOICED` included (nothing writes it, so the label means "somebody set it") |

`LOADED` is deliberately NOT refused. #2485 widened the rule to every CONFIRMED
delivery on 2026-08-19; #2557 took LOADED back out of the server's PICKER on
2026-08-20 as a side effect of a stock fix, leaving the button offered and the
lines unavailable; and the owner settled it the same day — **不要拦 ——
人自己知道**, 「我们自己开啊 manually开的不是吗」. The invoice is raised by hand
by someone who knows whether the goods arrived, so the system does not
second-guess them. The picker, this gate and the write-path cap all now read
the `'invoiceable'` basis of `do-line-remaining.ts`, so they cannot disagree
again; `backend/tests/loadedStaysInvoiceable.test.ts` fails by name if LOADED is
re-excluded.

**#2485's argument was false for LOADED and stopped being false on 2026-08-22.**
It justified itself with "stock was already deducted at dispatch", which was true
of `DISPATCHED` and `IN_TRANSIT` and not of `LOADED` — so the rule stood on the
owner's choice rather than on that reasoning. He has since moved the deduction to
the confirm step (「once confirmed就代表出货了 就是直接扣库存」), so `LOADED` is a
member of `DO_SHIPPED_STATES` and the stock IS out by the time an invoice can be
raised. Nothing about this gate changes: the rule was already right, and it is
now right for the reason #2485 gave as well as the one it actually rested on.
Full trace in `docs/modules/delivery-order.md`.

The batch path's `DO_HEADER` projection must keep selecting `status`;
it did not at first, and the guard then refused every batch invoice
(`backend/tests/oneSystemTwoOrganisations.test.ts` pins both halves).
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
     `invoice_date | invoice_number | debtor_name | status | total_sen` (`:682`)
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
- **Create from DO lines** (`POST /from-dos`, `createSalesInvoiceFromDoLinesHandler`).
  Same `asDraft` contract, read strictly (`body.asDraft === true`) and landed at
  `status: isDraft ? 'DRAFT' : 'SENT'`, with `invoice_date` forced to
  `todayMyt()`. **Since 2026-08-20 the phone always sends `asDraft: true`** — see
  the ruling below.
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
- **What AutoCount is told about a create.** Both create paths write exactly one
  `scm.autocount_outbox` row, before the DRAFT early return, so a draft and a
  posted invoice record the same one. `POST /from-dos` decides inline from its
  picks; `POST /` delegates to `scm/lib/si-autocount-source.ts`, which resolves
  the source from the PERSISTED links (`sales_invoice_items.do_item_id`, then
  `sales_invoices.delivery_order_id`). One source DO with every line linked
  queues `do_to_iv`; several record the merged-conversion skip; a linked line
  beside a standalone line is refused as `mixed-source-lines`; only a genuine
  no-source invoice is recorded parentless. Until 2026-08-17 `POST /` recorded
  parentless UNCONDITIONALLY, so every desktop from-DO invoice was filed as
  ERP-only — see BUG-HISTORY and `docs/modules/autocount-writeback.md` §7d.

### Every line verb on an invoice is STRICTLY company-scoped — a stamp is not a gate

All four line verbs resolve the invoice by `id`, which is a uuid and therefore
globally unique — so the danger here is not an ambiguous key, it is that a uuid
from the other company's books resolves perfectly well. Each one must prove the
INVOICE is ours before touching a line:

| verb | gate |
| --- | --- |
| `POST /:id/items` | `requireActiveCompanyId` + `scopeToCompanyId` |
| `PATCH /:id/items/:itemId` | `requireActiveCompanyId` + `scopeToCompanyId` |
| `DELETE /:id/items/:itemId` | `requireActiveCompanyId` + `scopeToCompanyId` |
| `POST /:id/items/from-do/:doId` | `scopeToCompany` on the invoice AND on the source DO |

`POST /:id/items` had none of it until 2026-08-19 — the other three were fixed in
the 2026-08-13 sweep and this one was missed. What made it invisible is worth
knowing, because the shape recurs: the insert carried
`company_id: activeCompanyId(c)`, so the statement MENTIONED the company and read
as scoped. **A stamp is not a predicate.** It wrote our company onto a line
appended to their invoice, and the recompute, the AR/GL re-post and the AutoCount
outbox row all followed from that line. This is the fifth blind spot named in
`CLAUDE.md`; `check-company-scope.mjs` asserts against it in its own self-test.

**Use the STRICT pair, not `scopeToCompany`, on a money write.** `scopeToCompany`
DEGRADES to no predicate when the company is unresolved — correct for a read that
must keep serving, wrong for a write that posts to a ledger.
`requireActiveCompanyId` refuses with a 409 instead.

**The gate goes BEFORE business validation.** Item-code validation used to run
first, so a caller pointed at another company's invoice was told its *item code*
was wrong — an answer about a document they cannot see. Same ordering rule the
price-override handler in `mfg-sales-orders.ts` adopted on 2026-07-22.

Covered by `backend/tests/companyScopeSalesInvoiceMoney.test.ts`, which mounts the
exported handlers against a fake PostgREST client and asserts BOTH directions plus
"nothing was written" — a refusal that still inserted would pass a status-only
check.

### `recomputePaid` — read this before touching payments

It no longer lives in this router. Since 2026-08-23 it is
`recomputeSiPaid` in `backend/src/scm/lib/si-order-deposit.ts`, re-exported into
`sales-invoices.ts` under its old name; it moved because the SALES ORDER's
payment writer has to run the same roll (see the section below).

Fails **closed**: a failed payments read or header read aborts with a log rather
than writing `paid = 0`. The comment records why — folding a transient blip into
0 does not merely understate `paid_sen`, it drives the status ladder, so a fully
PAID invoice silently reverted to SENT and re-entered the AR chase. DRAFT and
CANCELLED are frozen out of the ladder entirely. A failed read of the ORDER's
deposit is the third case and behaves the same way: `paid_sen` is still written
(that read succeeded), and the STATUS is left exactly as it was rather than
guessed at zero.

### The deposit taken on the SALES ORDER (2026-08-23)

Money can arrive on either of two ledgers — `scm.mfg_sales_order_payments`
(keyed by `so_doc_no`) or `scm.sales_invoice_payments` (keyed by
`sales_invoice_id`) — and until this date nothing applied one to the other. An
order holding a MYR 2,000 deposit produced an invoice reading
"No payments recorded yet" with the full total outstanding
(`docs/bugs/0525-payments-taken-on-the-sales-order-never-reached-the-sales-in.md`).

**It READS THROUGH; it does not copy rows.** Copying would double-post: an order
payment books SOPAY and an invoice payment books SIPAY, both through
`customerPaymentLines` (`backend/src/acc/rules.ts`), which is Dr cash/bank and
**Cr AR** — so a copied row would debit cash twice and relieve the same
receivable twice, and `acc/daily-close.ts`'s `systemTakings` sums BOTH tables for
one day's cash-up. Nothing in this change posts, journals or writes back to
AutoCount.

`backend/src/scm/lib/si-order-deposit.ts` owns the rule:

| Question | Answer |
|---|---|
| What has the order collected? | `soPaidSen` from `scm/shared/so-outstanding.ts` — the SO's own rule, imported not re-derived, so it carries the LEGACY header `deposit_sen` on an AutoCount-migrated order too |
| One order, several invoices? | earliest first, consume until exhausted, spill to the next (owner 2026-08-23:「先扣第一张，扣完再溢到下一张」) |
| Ordering key | `invoice_date` then `invoice_number` — a total order. NOT `created_at`, which two invoices converted in one action can tie on |
| Which invoices absorb? | every status except **CANCELLED** and **DRAFT**, both of which the payment routes already refuse (`not_payable`) |
| How much does one absorb? | `min(what is left of the order's money, its own total less its own paid_sen)` |
| Does `paid_sen` change meaning? | **No.** It is still receipts banked against THIS invoice. The deposit is added to the STATUS decision only, and served to the screen as its own field |

`GET /:id` therefore returns two more keys beside `salesInvoice` and `items`:
`orderDeposit` (`{ so_doc_no, order_collected_sen, applied_sen, transactions[] }`,
or `null`) and `orderDepositUnavailable` — the honest third answer for an invoice
whose order could not be read, which the screen surfaces as a warning rather than
silently reporting a bigger outstanding.

#### ONE field name, on every surface — `so_deposit_applied_sen`

*Added 2026-08-23, the day after the rule shipped detail-only.* The detail page
knowing this and the LIST not knowing it was worse than neither knowing: the two
screens then disagreed about the same invoice, and the list is the one the office
scans to decide who to chase (measured on production: detail 2,400, list 4,400,
list KPI 10,200 — `docs/bugs/0527-the-invoice-list-still-chased-money-the-order-had-collected.md`).

`stampOrderDeposit` (`scm/lib/si-order-deposit.ts`, re-exported from
`scm/lib/si-list-stamps.ts`) stamps the scalar onto a PAGE of rows in **three
batched reads**, whatever the page size — the style `stampSoDates` and
`stampDoNumber` set. It is called by:

| endpoint | what it feeds |
|---|---|
| `GET /sales-invoices` (both the legacy and the paginated path) | the desktop list + KPI + cards + drawer + CSV, and the mobile list |
| `GET /sales-invoices/:id` | the detail header (beside the richer `orderDeposit` object) and, through it, the invoice PDF |
| `GET /outstanding/si` (`backend/src/scm/routes/outstanding.ts`) | the `/scm/outstanding` SI tab — the handler subtracts the slice from the row's `outstanding_sen` |
| `GET /reports/sales-invoice-detail-listing` (`backend/src/scm/routes/reports.ts`) | the SI Detail Listing `balance_sen`, resolved once per invoice rather than once per line — that join returns one row per LINE, so stamping per row would re-read the same orders dozens of times. `DetailListingShell`'s Outstanding tile and its `?outstanding=1` filter both read `balance_sen`, so they follow. |

**The page is not the population.** The split depends on an invoice's SIBLINGS,
which can sit on another page or be filtered out of this one, so the sibling read
is keyed by `so_doc_no` and the allocation runs over the order's whole set before
the page's rows take their slice. A page-local allocation would hand the same
money to two pages.

**`null` is not zero.** A failed stamp leaves the field `null`, every reader
treats it as no deposit, and the screen shows the UN-adjusted, LARGER figure —
today's behaviour, and the only direction a statement of what is owed may be
wrong in.

#### The Outstanding Dashboard's SI card (2026-08-23)

`GET /outstanding/summary` gives every module one PostgREST aggregate over its
`v_*_outstanding` view. For SI that sums `outstanding_sen` — `total_sen -
paid_sen` — so the card sat above a row list that already subtracted the order
deposit and disagreed with it, and the card was the bigger number
(`docs/bugs/0529-the-outstanding-card-was-bigger-than-the-table-under-it.md`).

**`si` alone** now takes the paginate-and-reduce path the endpoint's own header
already offered as the correct-but-slower fallback, and applies the deposit per
row (`backend/src/scm/lib/si-outstanding-summary.ts`). The other six modules
keep their single aggregate. No view and no grant is touched — 0189 is why.

| property | what it does |
|---|---|
| the aggregate is the FLOOR | the SQL number is computed first and kept; the scan only ever refines it DOWNWARD, so the figure is never smaller than the truth |
| `SI_SUMMARY_ROW_CAP` = 4,000 | past that the aggregate stands with `deposit_applied: false` and a note. The cap limits what is READ, never what is COUNTED — a summary that quietly stops counting is worse than one that is too big |
| a failed read | answers `unavailable: true`, not a zeroed module. On this page a `0` reads as "nothing outstanding" |
| an unresolved order | keeps its LARGER figure, is still counted, and flips `deposit_applied` to false with the count in the note |
| `?snapshot=1` | reads `scm.mv_ar_aging`, which has the same blindness. The MV is NOT rewritten; the response marks its SI figure `deposit_applied: false` instead |

The card renders "at most RM x outstanding" whenever `deposit_applied` is false,
and a dash plus "Could not read" when `unavailable` is set.

**Cost.** At most `4 scan pages + 3 reads per batch of <=200 distinct orders` =
**<=64 subrequests** for this module, against 7 for the whole summary before.
How many outstanding invoices a busy tenant carries is **UNKNOWN** here and is
not guessed; `GET /outstanding/si` already pages the same row set with no cap,
and the Outstanding page issues it the moment anyone opens the SI tab, so this
is not a new class of cost.

The frontend has ONE reader, `frontend/src/vendor/scm/lib/si-outstanding.ts`
(`siOutstandingSen` / `siDepositAppliedSen` / `siSettledSen`), replacing six
copies of `Math.max(0, total - paid)`. Its test file reads each surface's SOURCE
and asserts the call is there, because a screen that never calls the rule is
invisible to any test of the rule.

**Deliberately NOT adjusted, and why:**

| surface | why |
|---|---|
| `scm.v_si_outstanding`, `scm.mv_ar_aging` | recreating a view is a NEW object with an empty ACL — the 0189 incident that took the SO list down for every user. The split is also a per-order rule no SQL column can express. `/outstanding/si` adjusts the served row instead |
| `GET /outstanding/summary` | **FIXED 2026-08-23** — see the section below. |
| `collection-agent.ts` (`:112`), `document-agent.ts` (`UNPAID_SI` `:494`, the PAID-but-short detector `:652`, the AR-aging buckets `:901-912`) | raw SQL `si.total_sen - si.paid_sen`, some of it bucketed aggregates. **Still wrong as of 2026-08-23** and NOT reached by the summary fix below: they over-state, so they propose chasing too much. Fixing them means restructuring those SQL aggregates, whose cost is not measurable from here |
| customer-credit auto-apply (`sales-invoices.ts` `remainingDueSen`, `customer-credits.ts`) | a credit is REAL money movement against this invoice. Applying less of it because the order holds a deposit would strand the customer's credit. Left on `total − paid_sen` on purpose |


`recomputeSiPaidForOrder` re-rolls every invoice on an order whenever that
order's payments change (add / edit / delete), so the invoice LIST — which reads
the persisted `status` — cannot fall behind the detail screen.

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

### Who sets each status — manual vs automatic (2026-08-16)

DB type is the `scm.sales_invoice_status` ENUM (`DRAFT` added by
`migrations-pg/0041_scm_sales_invoice_status_draft.sql`); column default `SENT`.
Unlike the DO and the GRN, **half of this document's statuses are machine-set**:

| Value | Set by | Manual / automatic |
|---|---|---|
| `DRAFT` | create with the draft flag | manual |
| `SENT` | the confirm branch; create-not-draft; **and `recomputePaid` writes it back** when the paid total rolls back to 0 | both |
| `PARTIALLY_PAID` | `recomputePaid` only | **automatic**, on payment add/delete — on THIS invoice or on its source Sales Order |
| `PAID` | `recomputePaid` only | **automatic**, same two triggers. The status PATCH still ACCEPTS `PAID` and no caller in this repo sends it any more — see *Mark paid records a receipt* below |
| `OVERDUE` | **no writer exists in `backend/src`.** It is a legal target of the transition table and is read by the collection agent, but nothing in this repo computes or writes it. UNKNOWN whether an external job does. Since 2026-08-17 it is at least VISIBLE if one arrives: it sits in the `sent` filter bucket, where it was in none | — |
| `CANCELLED` | the status PATCH handler | manual |

`recomputePaid` deliberately refuses to touch a DRAFT or CANCELLED invoice, so a
payment can never drag a cancelled document back into a live state.

Locks worth knowing: `isIssuedSi` (anything except DRAFT / CANCELLED) freezes
lines on add / edit / delete / from-DO with
`This invoice has already been issued to the customer, so its items can no longer
be changed. Cancel the invoice and reopen it if it is wrong.`, and freezes the
header fields `invoiceDate` / `currency` / `debtorName` / `debtorCode`. Payments
on a non-live SI are refused with `SI is cancelled` / `SI is a draft — confirm it
before recording payments` (`not_payable`).

> `VOID` appears as a UI pill label in `frontend/src/vendor/scm/lib/status-pill.ts`
> for both SI and PI. **No backend path writes it and it is in no enum** — it is a
> dead label. The live pill relabelings that DO fire are `SENT` → "Issued",
> `SUBMITTED` / `POSTED` → "Confirmed", `DISPATCHED` → "Shipped".

### Mark paid records a RECEIPT, never a status (2026-08-23)

**What it did until this date.** The button PATCHed `/:id/status` with
`{ status: 'PAID' }` and wrote no payment. That left `status = 'PAID'` beside
`paid_sen = 0` on one document, and the derivation above then reverted it the
next time anything touched that invoice's money. Full trace:
`docs/bugs/0528-mark-paid-on-a-sales-invoice-recorded-no-payment-status-said.md`.

**What it does now.** It seeds the same payments editor **Record payment** opens
with one row pre-filled at the outstanding balance, and commits on Save through
`POST /:id/payments`. Nothing about the status is written by the client at all —
`recomputeSiPaid` derives it, exactly as it does for a hand-entered receipt, so
the GL posting, the overpay/credit reconciliation and the AutoCount enqueue all
happen once and on one path.

| Question | Answer |
|---|---|
| How much? | the invoice's outstanding **net of the source order's deposit** — the same `outstandingOf(header, items, depositSen)` the Outstanding hero prints. A MYR 4,400 invoice whose order collected MYR 2,000 records **2,400** |
| Why net? | the order's deposit is read THROUGH, never copied, because both ledgers post Dr cash/bank and Cr AR and `acc/daily-close.ts` sums both for one day's takings. Recording the gross total would debit cash twice |
| Which method? | the OPERATOR's. There is no honest default — a silent `cash` lands in the daily cash-up and leaves the drawer short — so the button stops at the editor and Save is the commit point |
| When is it offered? | only when it can write an honest receipt. `canOfferMarkPaid` in `frontend/src/pages/scm-v2/markPaidPlan.ts` |

`markPaidPlan.ts` refuses four ways, and every refusal is a refusal to record
money that did not arrive:

| Refusal | Why |
|---|---|
| `nothing_outstanding` | a zero-value receipt is not a payment. The button is HIDDEN rather than shown-and-refusing |
| `deposit_unknown` | `orderDepositUnavailable` — the server could not read the source order, so the outstanding on screen fell back to the full total and is too high by the whole deposit |
| `not_payable` (CANCELLED) | `POST /:id/payments` and `PATCH /:id/payment` both 409 it; an entry that can only 409 is not offered |
| `not_payable` (DRAFT) | same, and a draft has posted no revenue yet |

> **The visibility rule INVERTED.** It was `outstanding === 0` from #311 until
> this change, so the button was only ever reachable on an invoice that owed
> nothing — which is why it could not have been recording a receipt. It is now
> offered when there IS a balance and hidden when there is not.

> **The LIST delegates here rather than computing.** Its **Mark paid** and
> **Record payment** both navigate to this screen carrying `?pay=balance` /
> `?pay=open` (`frontend/src/pages/scm-v2/siPaymentIntent.ts`), and this screen
> acts on the intent once and strips it. The list must NOT compute a receipt
> itself: a list row carries only `so_deposit_applied_sen`, and
> `siDepositAppliedSen` reads absent-or-null as 0 — so "the order collected
> nothing" and "we could not read the order" are the same value there. That is
> the safe default for a DISPLAYED figure and the dangerous one for cash.
> `orderDepositUnavailable`, served only by `GET /:id`, is what tells them apart.
>
> The old link was `?tab=payments&record=1`, which **nothing read** — this page
> calls `useSearchParams()` and never calls `.get()` — so Record payment from
> the list opened the invoice and did nothing. The param lives in a shared
> module now so the writer and the reader can be tested together.

Pinned by `frontend/src/pages/scm-v2/markPaidRecordsTheMoney.test.tsx`, which
mounts the real page and asserts the operator's outcome; proved RED by deleting
each of the six guards in turn.

### THE PHONE DRAFTS AN INVOICE, IT NEVER SENDS ONE (owner ruling, 2026-08-20)

His words: **「以电脑为准 —— 手机也先出草稿」** — the desktop is the standard, and
the phone drafts first too.

**What the phone did until this ruling.** `MobileConvertWizard`'s DO→SI arm
posted `{ picks }` and nothing else. `POST /from-dos` reads `asDraft` strictly,
so an absent flag is not a neutral default — it is `status: 'SENT'`, with
`sent_at` and `confirmed_at` stamped, revenue posted, and `invoice_date` forced
to today. **Three taps on a phone therefore ISSUED a customer-facing invoice**:
no due date, no terms, no review, and no way back except cancelling a document
the customer may already have been given.

**Why that was a defect and not merely a difference.** The desktop cannot reach
that endpoint at all — it goes `SalesInvoiceFromDo` → `SalesInvoiceNew` → `POST /`
with a ~30-key header form, which IS the review step. (`useConvertDosToSi` in
`vendor/scm/lib/sales-invoice-queries.ts` exists and has zero consumers.) So one
surface made issuing an invoice a deliberate act and the other made it a
side effect of transferring lines.

**What it does now.** The SI arm sends `asDraft: true`, mirroring the GRN arm of
the same wizard, which had already reasoned its way to the same answer for
stock: post the draft, let the operator confirm it from the document. Confirm
(DRAFT → SENT) is the single AR/revenue-writing chokepoint, exactly as
`PATCH /:id/post` is for a GRN's stock.

**The operator can still see and issue it.** The mobile detail screen already
offers `Confirm Invoice` on a DRAFT (`mobile/MobileModuleDetail.tsx`,
`sales-invoices` status actions: DRAFT → SENT, plus Cancel), and the wizard
returns to the convert home screen exactly as it does for the draft GRN — no
navigation assumed a sent invoice, so nothing else had to move.

Pinned by `frontend/src/mobile/mobileConvertDraftInvoice.test.tsx`, which drives
the real wizard and asserts the POSTED BODY, not the source text.

---

## 4. Database

Schema `scm`. Baseline DDL `backend/scripts/scm-schema/2990s-full-schema.sql:1305`
(`sales_invoices`) and `:1277` (`sales_invoice_items`); the payments + credits
tables come from `backend/scripts/scm-schema/0103-0110-si-payments-and-credits.sql`.
The authoritative in-code column lists are `HEADER` (`sales-invoices.ts:187-198`),
`ITEM` (`:222-225`) and `PAYMENT_COLS` (`:237-240`).

| Table | Role |
|-------|------|
| `scm.sales_invoices` | SI header. `invoice_number`, `so_doc_no`, **`delivery_order_id`** (the DO link), `debtor_code/name`, `invoice_date`, `due_date`, `currency`, `subtotal_sen`, `discount_sen`, `tax_sen`, `total_sen`, **`paid_sen`**, `salesperson_id`, `branding`, `venue_id`, per-category revenue + cost subtotals, `local_total_sen`, `total_cost_sen`, `total_margin_sen`, `line_count`, `status`, `sent_at` / `paid_at` / `confirmed_at`, `company_id`. |
| `scm.sales_invoice_items` | SI lines. `so_item_id`, **`do_item_id`** (what the remaining-pool maths joins on), `item_code`, `item_group`, `qty`, `unit_price_sen`, `discount_sen`, `tax_sen`, `line_total_sen`, `unit_cost_sen`, `line_cost_sen`, `line_margin_sen`, `variants`. |
| `scm.sales_invoice_payments` | Payments ledger. Same method vocabulary as the DO ledger. `recomputePaid` sums `amount_sen` over this table. |
| `scm.mfg_sales_order_payments` | READ ONLY from here. The deposit taken on the source Sales Order, applied to this invoice by `scm/lib/si-order-deposit.ts`. No row is ever copied into `sales_invoice_payments` — see *The deposit taken on the SALES ORDER* above. |
| `scm.customer_credits` | Overpay / cancelled-invoice credit. Written by `applyCustomerCreditToSi`, `creditFromCancelledSi`, `reverseCancelledSiCredit`, `reconcileSiOverpay` (`backend/src/scm/lib/customer-credits.ts`). |
| `journal_entries` + `journal_entry_lines` | GL. Dr **1100** (AR) / Cr **4000** (Sales Revenue) = `total_sen`, keyed on `(source_type='SI', source_doc_no=invoice_number)` so it can never double-post (`sales-invoices.ts:10-14`). |
| `scm.delivery_orders` / `scm.delivery_order_items` | Upstream. The DO's `has_children` lock counts non-cancelled SIs. |

Status vocabulary: canonical set at `SI_STATUS_CANON`. Filter buckets
(`SI_STATUS_BUCKETS`): `sent` = DRAFT+SENT+OVERDUE, `partial` = PARTIALLY_PAID,
`paid` = PAID, `cancelled` = CANCELLED. Note `sent` deliberately includes DRAFT.
Every member of `sales_invoice_status` is in exactly one bucket and no bucket
holds a non-member — pinned by
`backend/tests/statusBucketsEnumMembership.test.mjs`.

> **FIXED 2026-08-17, two faults in one map.** (1) The buckets carried `ISSUED`,
> `PARTIAL` and `COMPLETED` under a comment calling them a "backward-compatible
> fallback". They are not members of the enum, so no row can ever have held one,
> and each made its tab **500 `invalid input value for enum
> sales_invoice_status`** while its count failed silently to 0 (production, both
> companies: `total=1` with `{sent:0, partial:0, paid:0, cancelled:0}`). The
> three spellings survive on the WRITE path via `SI_STATUS_CANON`, which is where
> an input alias belongs. (2) `OVERDUE` was in NO bucket, so an overdue invoice
> counted in `all` and appeared in no tab; it is in `sent` now — the bucket
> `SalesInvoicesListV2`'s `statusFor()` already put it in by fallback, and an
> overdue invoice is an issued, unpaid one. A count that cannot be read now
> returns `500 status_counts_failed` rather than 0.

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
| Create (non-draft) or DRAFT→SENT confirm | `postSiRevenue` → Dr 1100 / Cr 4000 for `total_sen` (`:946`, `:1978`) |
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
| `unit_price_sen`, `discount_sen`, `tax_sen`, `line_total_sen` | line | Live **only while DRAFT**. Frozen the moment the invoice is issued (§6). |
| `unit_cost_sen`, `line_cost_sen`, `line_margin_sen` | line | **Live — overwritten in place** by `restampSiFromDo` (`backend/src/scm/lib/recost.ts:113`), which the GRN/PI recost cascade calls whenever a supplier invoice lands. This is the ③ "landed cost" leg of the three-way comparison; it is deliberately allowed to move after issue because it is internal cost, not the customer-facing price. |
| `subtotal_sen`, `discount_sen`, `tax_sen`, `total_sen` | header | Derived by `recomputeTotals` (`:264`); `total_sen` is what the GL posts. |
| `paid_sen` | header | Derived by `recomputePaid` from `sales_invoice_payments` — receipts on THIS invoice only. The source order's deposit is deliberately NOT added here (the GL, `scm.v_si_outstanding` and the AutoCount write-back all read this column); it reaches the screen and the status ladder separately. Never hand-set on the route paths — with ONE legacy exception: when the `apply_customer_credit_to_si` RPC is absent, `applyCustomerCreditToSiLegacy` (`customer-credits.ts:248-257`) hand-writes it in an optimistic-concurrency loop; callers then run `recomputePaid` so it converges. |
| per-category `*_sen` / `*_cost_sen`, `total_cost_sen`, `total_margin_sen`, `margin_pct_basis` | header | Derived; **finance-gated** (`SI_FINANCE_KEYS`, `:205-209`). `total_sen`, `local_total_sen` and `paid_sen` are NOT gated — everyone sees what is owed. |
| `amount_sen` | `sales_invoice_payments` | The ledger rows `paid_sen` sums. |

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
| DO→SI conversion | `pages/scm-v2/SalesInvoiceFromDo.tsx` → `SalesInvoiceNew.tsx` → **`POST /`** (an editable form: prices, dates, address, payment drafts) | `mobile/MobileConvertWizard.tsx` (`target: "si"`) → **`POST /from-dos`** with **`asDraft: true`** (a straight transfer, no edit step — so it DRAFTS, see below) |
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

## The transfer says at SAVE time what it could not carry (2026-08-20)

This document reaches AutoCount by **TRANSFER**, not by a create, and the
transfer route applies a **strictly narrower** set of header fields than an edit
does — `SalesHeader` / `PurchaseHeader` only, plus one extra assignment on each
purchase arm. So the account book can hold this document and still be missing
fields it has: until 2026-08-20 the conversion payload carried the ERP's number
and the account and nothing else, so every one of these landed under the DRAIN's
date with a blanked reference.

The payload now derives from `AcDownstreamSpec.facts` — the ONE description of
this document, projected onto the keys this route can apply — so a field added
there reaches the transfer with no further edit. What it still cannot carry, or
what the ERP has no value for, is **said on the save**: the create handler
returns `acNotSent` on its 201 and the New screen calls `notifyAcNotSent` before
navigating, exactly as the sales- and purchase-order creates do (#2499). The
problems carry `AC_SENT_INCOMPLETE`, not `AC_NOT_SENT`, and their title says the
document ARRIVED and part of it did not — the other wording would send someone
to raise it a second time into a book that already holds it. It never blocks.

Full reasoning, and the per-field table of what each conversion used to drop:
`docs/modules/autocount-writeback.md` §7c5.

## Right-click Print, for the whole chain (owner ruling, 2026-08-22)

**The list's right-click Print prints the chain (2026-08-23).** An SI row offers
`Print`, `Print Sales Order <no>` and `Print Delivery Order <no>` in place — the
row already carries `so_doc_no` and `delivery_order_id` + `do_number`, so no
extra read is needed and no payload change was required. `document-conversion.md`
§8b has the rule and the per-list enumeration.

## The source Delivery Order's NUMBER, not its uuid

`sales_invoices` stores its parent delivery order only as `delivery_order_id`, a
uuid — **there is no `do_number` column on the invoice**. The readable number is
stamped on at read time by `stampDoNumber` in `backend/src/scm/routes/sales-invoices.ts`,
which batches one lookup against `delivery_orders` and writes `r.do_number`.

**It is called on all three read paths** — both list paths and the detail path.
The detail was missing until 2026-08-23 and its own comment said "Called on BOTH
list paths", which was true and was the bug: the field simply was not served
there.

**The field is `do_number`.** `do_doc_no` is a real column on DELIVERY RETURNS
and has never existed on a sales invoice; the detail page read that name and so
always saw `undefined`. The list read `do_number` and was correct throughout, so
the two screens disagreed about the same invoice.

**No uuid slug fallback.** The detail page used to render
`delivery_order_id.slice(0, 8)` when it had no number, justified as "so the field
never renders blank". A dash is the better answer: a blank says we have nothing
to show; an eight-character hex fragment in a field labelled "Transfer From (DO)"
says something FALSE in the exact shape of the true answer, and cost the owner a
question about whether his own document chain was linked at all.

See `docs/bugs/0526-the-invoice-showed-its-delivery-order-as-a-uuid-fragment.md`.

## A line added here reaches the account book (since 2026-08-31)

Adding a line to a document AutoCount already holds used to refuse the WHOLE
document's edit: a line with no AutoCount key is indistinguishable from one the
backfill missed, and guessing "new" appends a duplicate into a live book. The
route now DECLARES the row it inserted (`newLineIds` -> `IsNewLine`), so the book
appends it. A keyless line the route did not name is still refused.

Full rule and the matrix: `docs/modules/autocount-writeback.md`,
`docs/bugs/0588-a-line-added-to-a-delivery-order-receipt-or-invoice-never-re.md`.

## Drill-down columns and "still loading"

A cell fed by a SECOND query renders **WORKING…** while that query is in flight
and **NOT LOADED** if it fails — never `STOCK` or a bare dash, which are
answers. `coverage` is a required prop on the shared drill-down; the rule, the
five surfaces that fetch separately, and how to add a sixth are in
`docs/modules/coverage-state.md` (trace: `docs/bugs/0603-a-drill-down-printed-stock-while-the-answer-was-still-loadin.md`).
