# Module: Payment Voucher / PV (SCM Finance)

Per-module technical doc — the screen down to the database. Sibling of `grn.md` and
`sales-order.md`.

A **Payment Voucher is money leaving**. It pays a vendor: a freight forwarder, a
one-off service, or — the case this doc spends most of its length on — a supplier
whose Purchase Invoices it settles. It is the only document in the buy chain that
records cash-out, and since 2026-07-30 it is also **the document that decides a
foreign purchase invoice's exchange rate**, which makes it a costing document as
well as a cash one. Read §6 before changing anything in it.

> Convention: money is **integer sen / centi** end-to-end (`total_centi`,
> `amount_centi`, `applied_centi`). `exchange_rate` is `numeric(14,6)` = **MYR per 1
> unit of the document's currency**; MYR is always 1, a byte-for-byte no-op. Dates
> stored UTC, displayed DD/MM/YYYY. All reads/writes through `/api/scm/*`.

Doc-flow position: **PO → GRN → PI → PV**. The PV is the end of the chain, and the
only arrow that points backwards (its rate reaches back to the PI, and through the
PI to the GRN's inventory).

---

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
| PATCH | `/:id` | `scm.payment_voucher.write` | **DRAFT only** (409 `not_editable`) |
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
| `lib/pi-settlement.ts` | `settlePiPaidCenti` + the pure `computePiSettlement`. The clamp that stops two vouchers over-paying one invoice lives in PL/pgSQL (`scm.settle_pi_paid_centi`, mig 0147) with a legacy optimistic fallback. |
| `lib/recost.ts` | `recostFromGrn` — the costing cascade the rate adoption triggers. |
| `lib/fx.ts` | `normalizeCurrency` / `normalizeExchangeRate` / `safeRate` / `toMyrSen` / `masterRateForCurrency`. |
| `lib/entity-audit.ts` | `recordEntityAudit` + the `assertAuditWritable` pre-flight. |
| `lib/doc-no.ts` | `nextPvNo` via `mintMonthlyDocNo` (max+1, self-healing), `nextJeNo`. |

### The GL entry (source_type `PV`)
Dynamic legs, unlike the PI's fixed Dr 1200 / Cr 2000:
```
Dr each line.debit_account_code   round(amount_centi * exchange_rate)   -- MYR
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
| `scm.payment_voucher_lines` | description + `debit_account_code` + `amount_centi`. |
| `scm.pv_allocations` | mig **0202**. `pv_id`, `pi_id`, `amount_centi` (requested), `applied_centi` (what actually landed). **No `po_id`, and there is no deposit / prepayment concept anywhere in `backend/src`** — a PV settles invoices, never orders. |
| `scm.purchase_invoices` | `paid_centi` / `status` moved by the settle; `exchange_rate` written by the rate adoption (§6). |
| `scm.journal_entries` / `_lines` | `source_type` `PV` and `PV_REVERSAL`. |
| `scm.entity_audit_log` | `PAYMENT_VOUCHER` and — for the rate adoption — `PURCHASE_INVOICE` rows. |

`applied_centi` is the one to respect: **record what the database applied, never what
the allocation asked for.** A cancel reverses that exact figure, so storing the
request after a clamp shrank it would un-apply money that never moved.

### purpose (mig 0202)
`SUPPLIER_PAYMENT` (default) is the only value that settles AP. `FREIGHT` and `OTHER`
post the GL and touch no invoice — and therefore never adopt a rate.

---

## 5. Settlement: what a knock-off does

For each `pv_allocations` row on a POSTED `SUPPLIER_PAYMENT` voucher:

1. `settlePiPaidCenti(sb, pi_id, amount_centi)` — the **database** evaluates the clamp
   (`GREATEST(paid, LEAST(total, paid + delta))`) under a row lock, at write time.
   It returns `appliedCenti` and `clampedCenti`.
2. `pv_allocations.applied_centi` is set to `appliedCenti`.
3. A non-zero `clampedCenti` is logged and pushed onto `overAllocated`. The voucher
   stays POSTED — the GL entry is correct and the money did leave; what is in question
   is only how much of it this invoice absorbed.
4. **The FX rate step, §6.**

Cancel walks the same allocations and settles `-applied_centi`, clearing
`applied_centi` only when the reversal actually landed.

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
| `backend/tests/pvRateFromPayment.test.ts` | the route: the rate is written, the **real** `recostFromGrn` moves the FIFO lot off its 1:1 basis, the audit rows land, a costing failure cannot fail the payment, all-MYR is inert, cancel retains (13 cases) |
| `backend/tests-pg/pvRateAdoption.pg.test.ts` | real Postgres: the PL/pgSQL `settle_pi_paid_centi` clamp composed with the decision, and the `numeric(14,6)` round-trip. Runs in CI's `backend-postgres` job; SKIPS with no local PG |
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

- **`applied_centi`, not `amount_centi`, is what a cancel reverses.** Getting this
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
