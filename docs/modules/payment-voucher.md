> ## Corrections — 2026-08-12 code-read sweep
>
> 1. pv_allocations + purpose ship in 0081_scm_payment_vouchers.sql (a port of 2990's 0189+0202) — this repo's 0202 is the lorry compliance vault; the route comments repeat the source-repo number and the guide transcribed them.
> 2. “No deposit concept anywhere in backend/src” is scope-false: customer-side deposits exist (customer-credits.ts:22,:489-523; finance-keys.ts). The AP-side intent is verified true — a PV settles invoices, never orders.
> 3. nextPvNo lives in payment-vouchers.ts:99-104, not doc-no.ts.

# Module: Payment Voucher / PV (SCM Finance)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Per-module technical doc — the screen down to the database. Sibling of `grn.md` and
`sales-order.md`.

A **Payment Voucher is money leaving**. It pays a vendor: a freight forwarder, a
one-off service, or — the case this doc spends most of its length on — a supplier
whose Purchase Invoices it settles. It is the only document in the buy chain that
records cash-out, and since 2026-07-30 it is also **the document that decides a
foreign purchase invoice's exchange rate**, which makes it a costing document as
well as a cash one. Read §6 before changing anything in it.

> Convention: money is **integer sen / centi** end-to-end (`total_sen`,
> `amount_sen`, `applied_sen`). `exchange_rate` is `numeric(14,6)` = **MYR per 1
> unit of the document's currency**; MYR is always 1, a byte-for-byte no-op. Dates
> stored UTC, displayed DD/MM/YYYY. All reads/writes through `/api/scm/*`.

Doc-flow position: **PO → GRN → PI → PV**. The PV is the end of the chain, and the
only arrow that points backwards (its rate reaches back to the PI, and through the
PI to the GRN's inventory).

---

## 0a. A HELD invoice is not payable (mig 0320, owner 2026-08-21)

`ON_HOLD` arrived on `scm.purchase_invoice_status` for the disputed supplier bill
that must not go out while it is being queried.

**This is the ONE hold of the three that needed a written guard, and that is the
useful part.** A PO on hold is not receivable because `grns.ts` filters through
an allow-list; a GRN on hold cannot be invoiced because the billable read is
`.eq('status','POSTED')`. Both blocks came for free. **The settle path reads
invoices BY ID and had no status gate at all**, so a held invoice would have been
paid exactly as before.

> **IT READS THE MARKER SINCE MIG 0324 (2026-08-22).** The hold left the status
> column — owner: 「我们的hold是给我们知道一个 order hold这的」 — so a held invoice
> arrives here reading `POSTED` or `PARTIALLY_PAID`, and the old
> `status === 'ON_HOLD'` test would have matched nothing for ever while still
> looking like a guard. `allocationPisOnHold` now selects `on_hold` and calls
> `isDocumentHeld`, which checks the flag AND the retired label. Selecting the
> column is half the fix: an unselected column reads `undefined`, which is not
> held, which is the permissive answer.
>
> This is also the document where the marker earns its keep most visibly. Under
> the old status-hold, a PARTIALLY_PAID invoice put on hold stopped saying how
> much had been paid — on the one screen a person opens to decide whether to pay
> the rest. It now says both.

`allocationPisOnHold` refuses with **409 `allocation_on_hold`**, checked where the
id ENTERS — beside the company guard, and for the same reason that one gives:
nothing has been written yet, so the operator gets a straight refusal instead of
a voucher that quietly pays a bill somebody stopped. It **fails closed** on a read
error, because absence is what refuses here.

`PurchaseInvoiceDetailV2`'s `effectiveOf` names ON_HOLD **before** its money
checks. Those read `paid_sen`, so a partly-paid invoice later put on hold would
have shown "Partially paid" and the hold would have been invisible on the one
screen a person opens to decide whether to pay the rest.

## 0b. Money leaves only after a yes (phase 3, mig 0339, 2026-08-28)

The accounting brief's phase 3, delivered against the placeholder Daily Bank
carried since phase 2B. **Marker columns, not new statuses** — the 0324 lesson
one section up applies verbatim: `submitted_at/by` and `approved_at/by` live on
the voucher, `status` stays `DRAFT` through the whole cycle, and every
`.eq('status', ...)` filter in the tree is untouched.

The state machine is a pure table in `backend/src/scm/lib/pv-approval.ts`
(tests beside it; the route half is `backend/tests/pvApproval.test.ts`):

| Voucher is…            | Edit | Submit | Approve/Reject | Withdraw | Post |
|------------------------|------|--------|----------------|----------|------|
| DRAFT, unsubmitted     | ✓    | ✓      | —              | —        | ✗ refused |
| DRAFT, submitted       | ✗ frozen | ✗  | ✓              | ✓        | ✗ refused |
| DRAFT, approved        | ✗ frozen | ✗  | ✗ (already)    | ✓        | ✓    |
| POSTED / CANCELLED     | ✗    | ✗      | ✗              | ✗        | (idempotent echo only) |

Routes: `POST /:id/submit`, `/:id/withdraw` (write permission),
`/:id/approve`, `/:id/reject` (the new `scm.payment_voucher.approve` key —
held by nobody but `*` until the owner grants it per position). A reject's
`note` lands on the entity-audit trail (`REJECT` + `rejection_note`), where
the submitter reads the why; every step writes its own audit verb
(`SUBMIT_FOR_APPROVAL` / `WITHDRAW_FROM_APPROVAL` / `APPROVE` / `REJECT`).

The post GATE sits in `postPaymentVoucherHandler` AFTER the idempotency echo:
a voucher whose active JE already exists has already paid, and re-posting
stays an echo whatever its marks say; a FRESH post without `approved_at` is
refused 409 `not_approved`. Editing a queued voucher is refused the same way
— what was approved is what gets paid, or it goes back through the queue
(withdraw clears BOTH marks).

**Daily Bank effect**: every DRAFT with `submitted_at` set (approved or not)
counts into `pendingApprovalSen` and subtracts from the board's available
money — money already asked for is not money the owner may still spend. MYR
conversion per voucher mirrors posting: `round(total_sen × exchange_rate)`.

## 1. Frontend

| Surface | File |
|---------|------|
| Desktop list | `frontend/src/pages/scm-v2/PaymentVouchers.tsx` |
| Desktop new | `frontend/src/pages/scm-v2/PaymentVoucherNew.tsx` |
| Desktop detail + edit | `frontend/src/pages/scm-v2/PaymentVoucherDetail.tsx` |

**There is NO mobile surface.** Nothing under `frontend/src/mobile` mentions a
voucher. This is the one procure-to-pay document that is desktop-only, so the repo's
"desktop and mobile move together" rule has no counterpart to honour here — if a
mobile PV is ever added, it must carry §4 and §6 with it.

Data hooks: `frontend/src/vendor/scm/lib/payment-voucher-queries.ts` —
`usePaymentVouchers(status?)`, `usePaymentVoucherDetail(id)`,
`useCreatePaymentVoucher`, `useUpdatePaymentVoucher`, `usePostPaymentVoucher`,
`useCancelPaymentVoucher`. Query keys `['payment-vouchers', …]` and
`['payment-voucher-detail', id]`.

Shared components: `CurrencySelect` (`frontend/src/vendor/scm/components/`) draws the
currency picker plus the rate input, and is shared with GRN and PI — **a change there
touches three documents**. The FX rules themselves live in
`frontend/src/pages/scm-v2/fx-rate.ts` (`resolveFxRate`, `deriveRateFromMyrPaid`),
which both PV surfaces and the GRN/PI forms call.

### Ringgit in, rate out (2026-07-30)
For a foreign voucher both PV surfaces show an optional **Actual MYR paid** field.
The rate is derived from it (`deriveRateFromMyrPaid(myrPaidSen, foreignFaceTotal)`)
and shown read-only underneath; the rate field stays editable as the fallback for
anyone who does think in rates. The owner does not — he knows what left the bank.

`deriveRateFromMyrPaid` returns **null**, never `0` / `NaN` / `Infinity`, for a blank
MYR figure or a zero foreign total (the divide-by-zero). Null means *leave the
existing rate alone*: a `0` written into the rate field would be `resolveFxRate`'d
back to 1 on submit and post the raw foreign figure as ringgit — the exact mis-cost
this whole feature exists to stop. It rounds to 6 decimals so the rate on screen is
the rate the column will hold.

`PaymentVoucherNew` tracks WHERE the rate came from in `rateSource`
(`'auto' | 'rate' | 'myr'`) so the currency-master auto-fill only ever overwrites a
rate nobody has taken ownership of.

---

## 2. API surface

Mounted at `/api/scm/payment-vouchers`, behind
`scmAreaGuard("scm.finance.accounting")` (`backend/src/scm/index.ts:342-343`).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/` | area guard | `limit(500)`, company-scoped, `?status=` |
| GET | `/:id` | area guard | header + lines + allocations (joined PI number / total / paid) |
| POST | `/` | `scm.payment_voucher.create` | creates **DRAFT**; allocations persisted but settle nothing yet |
| PATCH | `/:id` | `scm.payment_voucher.write` | **DRAFT only** (409 `not_editable`); a cleared Voucher Date is refused 400 `voucher_date_required` — §7 |
| POST | `/:id/post` | `scm.payment_voucher.post` | writes the GL entry, DRAFT → POSTED, settles PIs, **adopts the FX rate** |
| POST | `/:id/cancel` | `scm.payment_voucher.cancel` | reverses the GL entry, unwinds settlement, **retains the FX rate** |

`postPaymentVoucherHandler` and `cancelPaymentVoucherHandler` are **exported** so the
vitest harness can mount them on a bare Hono app (the `supabaseAuth` bridge cannot
run there). Precedent and shape: `backend/tests/companyScopeHardening.test.ts`.

**`POST /:id/post` was UNSCOPED until 2026-08-13** (PR #2086; BUG-HISTORY, *"The
writes the read-hardening audit left"*). The voucher was loaded with
`.eq('id', id)` and no company predicate while the `GET /:id` of the same row
already carried one, so a voucher id from the other company loaded here and went
on to post a journal entry against it. Three statements were scoped in that fix —
the voucher read, the `journal_entries` idempotency lookup, and the POSTED status
flip — behind `requireActiveCompanyId`. Note the asymmetry that let this survive
an audit: `backend/tests/companyScopeHardening.test.ts`, cited as the precedent
directly above, covers the **cancel** path and not the **post** path.

**The idempotency read now reports its own failure.** It used to be
`const { data: existingRows }` with the error discarded: a failed query left
`existingRows` undefined, `?? []` turned that into *"no journal entry exists"*,
and the handler posted a SECOND GL entry against the same voucher. It now returns
`500 post_failed` with the reason. **A failed read must never read as an absence
when the absence is what authorises the write** — this is the rule for every
idempotency check in this module, not a detail of this one.

### POST /:id/post response
```
{ ok, jeNo, jeId, totalSen,
  overAllocated?: string[],   // an allocation the DB clamped — somebody tried to over-pay an invoice
  rateAdopted?:   string[],   // invoices whose un-rated FX rate this payment filled in
  rateMismatch?:  string[] }  // invoices carrying a DIFFERENT deliberate rate — LEFT UNCHANGED
```
### POST /:id/cancel response
```
{ paymentVoucher: { id, status },
  fxRateRetained?: string[] }  // invoices still carrying the rate this voucher set (NOT reverted)
```
All four arrays are omitted when empty. None of them is an error: they are money
facts an operator has to be able to see.

---

## 3. Backend

`backend/src/scm/routes/payment-vouchers.ts` (~950 lines). Shared libs it owns or
leans on:

| Lib | Role |
|---|---|
| `lib/pv-rate-adoption.ts` | **PURE.** The FX-rate decision table (§6) and the cancel-path retention predicate. No database. |
| `lib/pi-settlement.ts` | `settlePiPaidCenti` + the pure `computePiSettlement`. The clamp that stops two vouchers over-paying one invoice lives in PL/pgSQL (`scm.settle_pi_paid_sen`, mig 0147) with a legacy optimistic fallback. |
| `lib/recost.ts` | `recostFromGrn` — the costing cascade the rate adoption triggers. |
| `lib/fx.ts` | `normalizeCurrency` / `normalizeExchangeRate` / `safeRate` / `toMyrSen` / `masterRateForCurrency`. |
| `lib/entity-audit.ts` | `recordEntityAudit` + the `assertAuditWritable` pre-flight. |
| `lib/doc-no.ts` | `nextPvNo` via `mintMonthlyDocNo`, and `nextJeNo`. Both claim from `scm.doc_number_counters` (mig 0316) with the live max only as a floor — a deleted document does NOT return its number, and gaps are permanent. |

### The GL entry (source_type `PV`)
Dynamic legs, unlike the PI's fixed Dr INVENTORY / Cr AP (resolved by role):
```
Dr each line.debit_account_code   round(amount_sen * exchange_rate)   -- MYR
Cr header.credit_account_code     = Σ of those rounded Dr legs          -- MYR
```
The credit leg is the **sum of the rounded debit legs**, so the JE balances
byte-for-byte even when rounding splits across lines. `totalSen` (the sum) is the MYR
that actually hit the ledger.

Idempotent both ways: a post early-returns on an existing ACTIVE (non-reversed) `PV`
JE for the same `pv_number`; a cancel's contra is keyed on the original JE's
`reversed` flag. The cancel's ACTIVE→CANCELLED flip is an atomic conditional UPDATE
(`.neq('status','CANCELLED')`), so two concurrent cancels race and only one reverses.

---

## 4. Database

| Table | Notes |
|---|---|
| `scm.payment_vouchers` | header. `currency` + `exchange_rate numeric(14,6)` since mig **0081**; `purpose` since **0202**. |
| `scm.payment_voucher_lines` | description + `debit_account_code` + `amount_sen`. |
| `scm.pv_allocations` | mig **0202**. `pv_id`, `pi_id`, `amount_sen` (requested), `applied_sen` (what actually landed). **No `po_id`, and there is no deposit / prepayment concept anywhere in `backend/src`** — a PV settles invoices, never orders. |
| `scm.purchase_invoices` | `paid_sen` / `status` moved by the settle; `exchange_rate` written by the rate adoption (§6). |
| `scm.journal_entries` / `_lines` | `source_type` `PV` and `PV_REVERSAL`. |
| `scm.entity_audit_log` | `PAYMENT_VOUCHER` and — for the rate adoption — `PURCHASE_INVOICE` rows. |

`applied_sen` is the one to respect: **record what the database applied, never what
the allocation asked for.** A cancel reverses that exact figure, so storing the
request after a clamp shrank it would un-apply money that never moved.

### purpose (mig 0202)
`SUPPLIER_PAYMENT` (default) is the only value that settles AP. `FREIGHT` and `OTHER`
post the GL and touch no invoice — and therefore never adopt a rate.

---

## 5. Settlement: what a knock-off does

For each `pv_allocations` row on a POSTED `SUPPLIER_PAYMENT` voucher:

1. `settlePiPaidCenti(sb, pi_id, amount_sen)` — the **database** evaluates the clamp
   (`GREATEST(paid, LEAST(total, paid + delta))`) under a row lock, at write time.
   It returns `appliedCenti` and `clampedCenti`.
2. `pv_allocations.applied_sen` is set to `appliedCenti`.
3. A non-zero `clampedCenti` is logged and pushed onto `overAllocated`. The voucher
   stays POSTED — the GL entry is correct and the money did leave; what is in question
   is only how much of it this invoice absorbed.
4. **The FX rate step, §6.**

Cancel walks the same allocations and settles `-applied_sen`, clearing
`applied_sen` only when the reversal actually landed.

Do NOT re-introduce a caller-side cap. The pre-0147 code read the PI, computed
`outstanding = total - paid`, capped the allocation and then wrote — a cap that was
true when read and false when written, so two vouchers settling one invoice each
applied their full share and the invoice ended up paid twice over. It is not a lost
update and retrying does not fix it; only the database evaluating the cap at write
time does.

---

## 6. THE PAYMENT DEFINES THE FX RATE (owner-approved 2026-07-30)

**Read this before touching the settlement loop.** This is the surface change that
makes a Payment Voucher a costing document.

### Why
Houzs buys from China and **pays first**: money leaves the bank, then the goods
arrive (GRN), then the supplier's invoice is entered (PI). So the exchange rate is not
a figure anyone should be maintaining by hand — it is a fact about a payment that has
already happened. Owner: *"我把给钱的 knock off 掉这个 PI 就会计算到 costing"*.

The failure this fixes is audit finding **R2**
(`docs/inventory-costing-integrity-audit.md`). `safeRate` degrades a missing rate to
**1**, and a currency the owner has not rated also reads 1 — as of 2026-07-30 the
master reads `1.000000` for RMB, SGD **and** USD. A foreign GRN/PI raised before the
rate is entered therefore capitalises its raw yuan figure into the FIFO lot as if it
were ringgit (`toMyrSen(x, 1) === x`), and because `recostFromGrn` re-reads the PI's
**own stored** rate, the error is sticky and never self-heals.

### The decision table
`planPvRateAdoption` in `lib/pv-rate-adoption.ts`, in evaluation order. Pure, so all
of it is unit-tested without a database (`pv-rate-adoption.test.ts`).

| # | Condition | Outcome |
|---|---|---|
| 1 | `appliedCenti <= 0` | skip `nothing_applied` — no money reached the invoice, so the payment says nothing about it |
| 2 | PI currency is MYR | skip `myr_invoice` — rate 1 by definition |
| 3 | PV currency is MYR, **or** the PV rate is not finite > 0, **or** the PV rate is exactly **1** | skip `voucher_rate_unusable` — the voucher is itself un-rated; that is not evidence |
| 4 | PV currency ≠ PI currency | skip `currency_mismatch` — an RMB payment says nothing about a USD invoice |
| 5 | PI stored rate is **1** | **ADOPT** the PV's rate, then `recostFromGrn(pi.grn_id)` |
| 6 | PI rate === PV rate | skip `already_at_this_rate` |
| 7 | PI rate is anything else | **`report_mismatch`** — invoice **UNCHANGED**, disagreement returned |

Row 5 keys on the stored rate being 1 rather than on "is it wrong?", because 1 is the
only value indistinguishable from never having been set. Every other value is
somebody's answer, and row 7 respects it — a partial payment at a second rate is
legitimate, and choosing which rate wins is a policy call the owner has not made.

Row 3 is **deliberately stricter than `fx-guard.ts`**, which honours an
operator-typed rate of 1 at the POST boundary. The guard can tell a typed 1 from an
unset master's 1 because it reads the raw master value before the two are flattened;
by the time a stored numeric reaches this module that provenance is gone.

### What ADOPT does
1. `purchase_invoices.exchange_rate = plan.rate` (rounded to the stored 6 dp).
2. `recordEntityAudit` on **`PURCHASE_INVOICE`** — the row that changed — with
   `exchangeRate` from→to, `rateSourcePv` (the voucher number, i.e. the evidence) and
   `appliedCenti`.
3. `recostFromGrn(sb, pi.grn_id)` — cascades lot cost → consumptions → OUT movements
   → DO lines → SI lines.
4. After the loop, one summary row on the **`PAYMENT_VOUCHER`** carrying
   `fxRateAdoptedOnPi` / `fxRateMismatchOnPi`.

**Why both audit rows.** The invoice is the correct entity for the change, but the
Purchase Invoice detail page has **no History drawer** — only GRN, PV, stock take and
stock transfer mount `EntityHistoryPanel`. So the invoice-side row is right by data
model and not yet readable, and the voucher-side row is the one the owner can
actually see today. **Adding a History panel to the PI detail page is the obvious
follow-up.**

### Best-effort, never fails the payment
By the time the loop runs the journal entry is committed and the money has left the
bank. There is no transaction to roll back into, and nothing about a costing refresh
justifies 500-ing a payment that already went through. Every failure — the rate write,
the audit, the recost — is logged (`[pv-fx-rate] …`) and stepped over, exactly as a
failed settle already is. The recost gets its own `try/catch` on top of its internal
one. **Do not make any of this throw.**

### Cancel: the rate is RETAINED
Cancelling unwinds the AP settlement and **deliberately leaves the adopted rate and
the re-costed inventory in place.**

Reverting is not the conservative option, it is the destructive one. The only value
there is to revert *to* is 1 — the R2 mis-cost — so "putting it back" would knowingly
restore a 1:1 foreign basis and cascade it through every lot, DO and SI the recost had
just corrected. A cancelled voucher also does not un-happen the bank transfer it
recorded; the observed rate remains the best evidence anyone has.

Because silence there would read as "the rate went back", the cancel NAMES the
invoices it is leaving alone: `isRateRetainedFromPv` per allocation → the
`fxRateRetained` response array plus a `PURCHASE_INVOICE` audit row whose note says
the rate is retained and inventory is not re-costed back.

---

## 7. The write-path guards this depends on

### `voucher_date` is REQUIRED on edit, and defaulted on create (2026-08-18)

`PATCH /:id` refuses a blank Voucher Date with **400 `voucher_date_required`**
(`backend/src/scm/routes/payment-vouchers.ts`), alongside the `payee_name` and
`credit_account_code` refusals it already carried. That is a field which starts
being required on edit, so it belongs here rather than being re-derived by the next
reader.

Why a refusal and not a coercion to NULL. `scm.payment_vouchers.voucher_date` is
`date NOT NULL DEFAULT current_date`
(`backend/src/db/migrations-pg/0081_scm_payment_vouchers.sql`). The handler used to
assign `updates.voucher_date = body.voucherDate` straight through, and
`PaymentVoucherDetail` sends `voucherDate` on every save while its date field emits
`""` once cleared — so Postgres received a blank and answered 500
`invalid input syntax for type date: ""`, losing the whole save. NULL is not the fix
either: the column is NOT NULL, so it would trade an invalid-syntax 500 for a
not-null 500. A named 400 is the only answer that reaches the operator.

**Create and edit deliberately disagree.** `POST /` still accepts a missing or blank
`voucherDate` and defaults to today, which is exactly what the column's own
`DEFAULT current_date` says a new voucher with no date typed means. An edit that
CLEARS the field is a different request: a date is already stored, the user is asking
to remove it, and the column cannot hold "no date". So create defaults and edit
refuses; do not "harmonise" them without changing the column.

Proved by `backend/src/scm/routes/pvBlankVoucherDate.test.ts` (the real PATCH driven
through the router), and held for the whole class by
`backend/tests/dateWriteCoercion.test.ts`, which fails on any request-supplied value
reaching a date/timestamptz column uncoerced anywhere in `backend/src`.

### Foreign-rate guards

`backend/src/scm/lib/fx-guard.ts` stops NEW documents entering the state §6 exists to
heal. It is not a PV surface, but the PV's 422 message points at it and the two must
stay consistent.

- `assertForeignRatePostable` — refuses a **POST** of a non-MYR GRN/PI when the
  operator entered no positive rate AND the currency master has no positive
  `rate_to_myr`. Wired at GRN `POST /`, `/from-pos`, `/from-po-items`, and PI `POST /`.
- `assertForeignRatePatchable` — refuses a **currency FLIP** to a non-MYR code on
  `PATCH /grns/:id` and `PATCH /purchase-invoices/:id` under the same conditions.
  Added 2026-07-30: both PATCH handlers leave the stored rate untouched when no rate
  is sent, so flipping MYR → RMB left `exchange_rate` at the 1 it held for being
  ringgit. Fires ONLY on a genuine flip; an edit that does not touch the currency is
  never re-litigated, or every notes/warehouse edit on a foreign document would start
  being refused.

Both return 422 `foreign_rate_unset`, never a 500, and the message names all three
ways out — set the master rate, enter the rate on the document, or **record the
payment first**, which for the pay-before-goods cycle is usually easiest and always
the most accurate.

**An all-MYR flow is untouched by every one of these.** MYR returns early in each
predicate, `toMyrSen(x, 1) === x`, and the derived-rate UI is hidden. That matters
because all-MYR is the overwhelming majority of documents in this system.

---

## 8. Tests

| File | What it proves |
|---|---|
| `backend/src/scm/lib/pv-rate-adoption.test.ts` | the §6 decision table, exhaustively, with no DB (47 cases) |
| `backend/tests/pvRateFromPayment.test.ts` | the route: the rate is written, the **real** `recostFromGrn` moves the FIFO lot off its 1:1 basis, the audit rows land, a costing failure cannot fail the payment, all-MYR is inert, cancel retains (13 cases). Its supabase stub is hand-rolled, so it must model `.schema()` — the JE-number prefix reads `public.companies` from a client pinned to `scm` (`docs/bugs/0522`), and a stub without it 500s the whole post. |
| `backend/tests-pg/pvRateAdoption.pg.test.ts` | real Postgres: the PL/pgSQL `settle_pi_paid_sen` clamp composed with the decision, and the `numeric(14,6)` round-trip. Runs in CI's `backend-postgres` job; SKIPS with no local PG |
| `backend/src/scm/lib/fx-guard.test.ts` | both write-path guards (41 cases) |
| `backend/tests/fulfillmentCosting.test.ts` | `parseAmountCenti` / `buildLines` / `buildAllocations` — negative and fractional amounts are REFUSED, not clamped to 0 |
| `backend/tests/companyScopeHardening.test.ts` | the cancel cannot reverse another company's GL entry |
| `frontend/src/pages/scm-v2/fx-rate.test.ts` | `resolveFxRate` and `deriveRateFromMyrPaid` (13 cases) |

`vi.mock` is **not** used in the route suite: it does not reliably intercept module
imports under the Cloudflare Workers pool (`so-revision.reviseBoundPo.test.ts`
records the same finding). Driving the real `recostFromGrn` against the fake
PostgREST client is the stronger test anyway — a mock proves a function was called,
not that the adopted rate reached the inventory basis.

---

## 9. Traps

- **`applied_sen`, not `amount_sen`, is what a cancel reverses.** Getting this
  backwards swaps an over-payment for an under-payment.
- **Never cap an allocation in the caller** (§5).
- **Never overwrite a PI rate that is not 1** (§6 row 7).
- **Never make the rate/recost path throw** (§6). The money has already moved.
- **A negative or fractional `amountCenti` is refused, not clamped.** `parseAmountCenti`
  returns `null` and the request 400s. A supplier payment that is quietly RM 0 is
  worse than one that is refused, because nobody goes looking for it
  (HOOKKA BUG-2026-05-20-002).
- **`CurrencySelect` is shared with GRN and PI.** Changing it changes three documents.
- **No mobile surface** (§1) — do not assume a counterpart file exists.
