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

## 0b. The four layers (owner 2026-09-02; migs 0339 + 0343)

The owner's design in his own words: draft 就是 raw draft… 然后prepare 后会
多两层checking, 一层是checked，一层是approved, 当approved 了才会进gl. Whether
the money truly left the bank stays **bank reconciliation's** question.
This replaced phase 3's submit→approve→post (2026-08-28) same-week, at his
correction. **Marker columns, not new statuses** — the 0324 lesson, third
time running: `submitted_at/by` (the Prepared mark), `checked_at/by` (mig
0343) and `approved_at/by` live on the voucher; `status` stays `DRAFT`
until approval posts it.

The state machine is a pure table in `backend/src/scm/lib/pv-approval.ts`
(tests beside it; the route half is `backend/tests/pvApproval.test.ts`):

| Voucher is…      | Edit | Prepare | Check | Approve | Reject | Withdraw |
|------------------|------|---------|-------|---------|--------|----------|
| Draft (no marks) | ✓    | ✓       | —     | —       | —      | —        |
| Prepared         | **✓ still** | ✗ | ✓   | ✗ first yes first | ✓ | ✓ |
| Checked          | ✗ locked | ✗   | ✗     | ✓ **= posts GL** | ✓ | ✗ reject-back only |
| POSTED (label "Approved") / CANCELLED | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

The deliberate oddities, each the owner's call:
- **Prepared still edits** (prepare 还可以改) — the first yes is what locks.
- **Approve IS the posting** (当approved 了才会进gl): the approve route
  stamps the yes then walks straight into `postPaymentVoucherHandler` in the
  same request — its response is the post's (`jeNo` and all), and the
  standalone Post button is gone from the UI. If posting dies after the
  stamp, **approving again resumes** (the stamp is not rewritten, the post's
  idempotency echo makes the retry safe). The post route stays mounted and
  its gate (`not_approved` 409) stays the wall nothing else can climb; the
  approve key opens the post door alongside the post key.
- **Any reject → raw Draft** (一律退回 Draft), every mark cleared, the note
  on the audit trail (`REJECT` + `rejection_note`).
- **No fast path** — he refused one; everyone walks the layers. Check and
  approve are separate keys (`scm.payment_voucher.check` new,
  `scm.payment_voucher.approve`) but the same person MAY hold both
  (可以同一个人，可以不同人).
- **Withdraw** (the preparer's own back-out) works only BEFORE the first
  yes; after checked it is the checkers' document — ask for a reject.

Routes: `POST /:id/submit` (the Prepare action — the path kept its old name
so nothing external broke), `/:id/withdraw` (write key), `/:id/check`
(check key), `/:id/approve` (approve key; posts), `/:id/reject` (either
key). Audit verbs: `SUBMIT_FOR_APPROVAL` / `WITHDRAW_FROM_APPROVAL` /
`CHECK` / `APPROVE` / `REJECT`.

**Daily Bank effect** (his sentence verbatim: daily bank 的pending 就是第一
层的checked): every DRAFT with `checked_at` set counts into
`pendingApprovalSen` and subtracts from the board's available money — a
merely prepared voucher does NOT reserve yet. MYR conversion per voucher
mirrors posting: `round(total_sen × exchange_rate)`. The board card reads
"Checked, awaiting approval".

**List labels**: POSTED's pill now reads **Approved** (his word for the
layer that posted it); a DRAFT wears "prepared — awaiting check" or
"checked — awaiting approval" beside the pill, and the list's filter chips
split Draft / Prepared / Checked / Approved / Cancelled by the marks.

**批量tick yes** (owner, same day: 这个批量的功能肯定需要): the list grows
DataGrid's first-class multi-select for holders of the check or approve
key. Only rows whose yes is YOURS to give can be ticked (a raw draft and a
posted voucher render disabled; the header checkbox never sweeps them in);
a bar counts each button's own targets — "Prepare n" (write key, raw
drafts; no dialog — freely reversible, 我draft 也要批量去prepared) /
"Check n" / "Approve & post n" — and the check/approve dialogs state the
ticked rows' MYR-equivalent before anything moves. The run stamps ONE BY ONE through the same routes as the
detail buttons (own permission, own gate, own audit; approve carries its
whole post), so a refused voucher names itself in the summary and the rest
carry on. No batch reject — a reject wants its own note. Contract:
`frontend/src/pages/scm-v2/PaymentVouchers.test.tsx`.

## 0c. Two documents, AutoCount-style (2026-08-30)

The owner, AutoCount in hand: 正常 auto count是可以选payment voucher / AP
Payment. So the New page is TWO documents on one route:

- **Payment Voucher** (`/scm/payment-vouchers/new`) — pays expenses. Free-text
  payee, hand-written lines, **no supplier and no Apply-to-PI section**.
  Purpose stored as `OTHER` (the old three-way purpose dropdown is gone; the
  document type IS the purpose now). The detail shows it as **Type: AP Payment / Payment Voucher** (owner 2026-09-07: 为什么我一直看到 purpose - other? → the word Purpose and the old Freight choice are gone; `vendor/scm/lib/pv-type-label.ts`).
- **AP Payment** (`/scm/payment-vouchers/new?type=ap`) — settles a supplier.
  Supplier required; **no hand-written lines at all**: tick an invoice to pay
  it in full, type a figure for a partial, and the voucher total follows the
  ticks. On save the page composes the ONE GL line itself — Dr the AP control
  account (role `AP`, default 400-0000) for exactly what the ticks apply — so
  a supplier payment can never be mis-booked to an expense account. Purpose
  `SUPPLIER_PAYMENT`; same table, same PV number series, same approval cycle.

**Apply to PI shows each invoice's date, oldest first** (owner 2026-09-02:
我也要看invoice 的日期) — the settle order, not the browse order. **Every
account picker types-to-search** (同日: 我无法快速打关键字眼搜索account):
`AccountSelect` is a `SearchCombo` underneath — every space-separated token
must match the "code · name" label — and the AP Payment's supplier picker
searches the same way. Since 2026-09-04 the panel is a **BODY PORTAL,
positioned fixed** off the input's live rect
(`frontend/src/vendor/scm/components/SearchCombo.tsx`, pinned in
`SearchCombo.test.tsx`) — two rounds of the owner's same report (为什么我能
选的这么少 / 选account 时会无法看到下面的, then 还是一样) taught the real
lesson: the clipper was never the viewport but the form CARD's
`overflow:hidden` (SalesOrderDetail.module.css `.card`, there for the
rounded corners), which cut the absolute panel at the card's edge —
scrollbar included — however much screen remained. Portaled to
`document.body`, no ancestor overflow/transform can touch it; while open it
re-measures on scroll (capture) and resize, flips UP when the space below
can't fit it and above offers more, and caps its height to the side
actually available. The list itself is NEVER truncated: few visible rows
must only ever mean few matches.

**Insert and Enter on the line cards (2026-09-06, 刚刚说的功能这普通 payment
也要有)**: on the plain voucher's lines, **Insert** adds a line and lands on
its account picker, and **Enter on an amount** hops to the next line's
account — adding a line when there is none — so a long voucher is typed
without reaching for the mouse (`PaymentVoucherNew.tsx`, each card carries
`data-line`; pinned in `PaymentVoucherNew.test.tsx`). The AP invoice's
round-3 manners carried across, the same day the Other Debtor bill got them
(accounting.md, "Other Debtors, round 2").

**The batch runs in voucher-date order (2026-09-07, docs/bugs/0653).** Prepare,
Check and Approve & post stamp the ticked vouchers oldest voucher date first
(same date: Draft order), never in tick order — the formal number is minted
the moment a voucher is checked, so a batch that ran in list order once gave
the 28/04 vouchers `2990-HPV-2604-001/002` ahead of the 21/04 ones. Across
separate check sessions the number still follows the moment of checking; the
one-off `.github/workflows/repair-renumber-pv-series.yml`
(`backend/scripts/repair-renumber-pv-series.mjs`, plan → apply, confirm
`RENUMBER PV SERIES`) re-orders a month already stamped out of order —
unposted vouchers only, text mirrors (audit ledger, supplier advances)
renamed with them. Pinned in `PaymentVouchers.test.tsx`.

**An invoice a saved voucher already applies to leaves the picker (same day:
payment 已经分配了就不要显示).** An allocation reserves its invoice the moment the
voucher is saved, but `paid_sen` moves only at Approve — so the AP Payment
picker subtracts what other UNPOSTED vouchers (Draft, Prepared, Checked) have
applied: an invoice with nothing left is not listed, a partly reserved one
offers only the remainder, and a voucher being edited never counts its own
rows. `GET /payment-vouchers/reservations/list?supplierId=&excludePvId=`
(`pendingReservations`) is the source, `usePvReservations` the hook; the
create and edit doors refuse `over_allocation` (409) naming the voucher that
holds the amount (`allocationHeadroomBreach`). Advance applications settled
`paid_sen` when they were applied and are not pending. Pinned in
`tests/pvReservations.test.ts` (RED on the unfixed tree: a second voucher
could apply the same invoice in full) and `PaymentVoucherNew.test.tsx`.

**Paid From offers only money** (owner: paid from 应该只能选cash 和银行): the
picker lists `acc_money` accounts, pre-filled from the company's
`BANK_DEFAULT` role, and the server refuses any non-money credit account
(`not_a_money_account`, guarded on create AND on draft edit). The default
bank is the owner's to maintain — the "Default bank" card on
/scm/settlement-setup writes `PUT /accounting/roles/BANK_DEFAULT` (money
accounts only, per company). Contracts: `PaymentVoucherNew.test.tsx`
(frontend), `backend/src/scm/routes/accountRoles.test.ts` (server half).

**And lines take only LEAVES** (owner 2026-09-03, 父户不记账): create and
draft-edit run every debit code through `requireLeafAccount`
(accounting-chart.ts) — a header with active sub-accounts refuses
`not_a_leaf_account` at typing time, before the GL gate would refuse the
same header at approval. The same door also refuses CONTROL accounts
(AutoCount special SDC/SCC/SBS — AR, AP + customer deposits, stock; the
owner's 锁): their balances post through modules, never through a
hand-picked line, so `control_account_locked` comes back with 由模块自动过账.
AccountSelect does its half by not offering headers OR control accounts at
all (the credit side was already safe — `requireMoneyAccount` only admits
the money set). Contract: the leaf + control blocks of
`backend/tests/accountingChart.test.ts` and
`frontend/src/vendor/scm/components/AccountSelect.test.tsx`.

**The AP Payment debits the supplier's OWN control (2026-09-03 split)**: a
405-x supplier is an OTHER CREDITOR — the page composes its GL debit onto
AP_OTHER (405-0000), everyone else onto AP (400-0000). The prefix rule's one
home is `apControlRole` (acc/rules.ts); the page's pick is a display mirror
and the server is the authority: create refuses `wrong_ap_control` when a
SUPPLIER_PAYMENT debits the wrong class's control. Contracts: the 405 block
of `PaymentVoucherNew.test.tsx`, `backend/tests/pvApControlGuard.test.ts`.

**Copy as new (2026-09-03, the owner with AutoCount in hand: 我 right click
就能直接 copy)**: the list row's context menu and the detail header both
carry "Copy as new", on ANY status — a posted or cancelled voucher is the
best template. It opens `/scm/payment-vouchers/new?copyFrom=<id>`
(`&type=ap` when the source purpose is SUPPLIER_PAYMENT, so an AP Payment
copies to an AP Payment) and the New page pre-fills CONTENT ONLY: payee,
supplier, Paid From, lines, notes, currency+rate. Identity never rides:
fresh number, today's date, approvals restart at raw Draft, and nothing is
applied to PIs — the source's bills may already be knocked off, so the
Apply-to-PI section starts empty against the live outstanding list. The
same pattern lives on Purchase Invoices (`?copyFrom` on
/scm/purchase-invoices/new; the copy is an independent MANUAL bill — no
GRN links, no supplier invoice ref, that paper belongs to the source).
Contracts: the copy block of `PaymentVoucherNew.test.tsx`, the label pins
of `row-menus-remaining-lists.test.ts`.

## 0c2. An allocation names a PI or an AP invoice (2026-09-06)

The AP INVOICE (docs/modules/accounting.md, the non-stock supplier bill) is
paid by THIS document: `buildAllocations` takes `piId` **or** `apInvoiceId`
per row (both, or neither, refused — `allocation_two_targets` /
`allocation_pi_required`), the company guard has an AP twin
(`allocationApInvoicesOutsideCompany`, which also refuses a DRAFT or
CANCELLED bill), the post settles an AP row through
`settleApInvoicePaidSen` (the twin clamp) and records `applied_sen` exactly
as for a PI — the FX-adoption and GRN re-cost branches are PI-only, a rent
bill carries no stock — cancel unwinds it by what was applied, and the detail
answers each allocation with `kind` ('PI' | 'API'), `piId` / `apInvoiceId`.
On the New AP Payment screen the Apply-to-invoice list shows the supplier's
open AP invoices beside the purchase invoices (an `AP` tag on the row; tick
= pay in full, type = part) and the payload names `apInvoiceId` for those;
the detail screen's edit path lists purchase invoices only and passes the
voucher's existing AP-invoice allocations through unchanged, so an edit
never silently drops them.

## 0d. 预付挂在 supplier (2026-09-02)

The owner's design, in his words: 预付就不能直接挂在supplier 那边吗? An AP
Payment may pay MORE than the invoices it ticks — type the extra in the
**Prepay (advance)** field under the PI table. The field is there whether or
not the supplier has an open invoice: a supplier with NOTHING outstanding
still gets the box (the empty-list sentence used to swallow it — owner
2026-09-06, a new other-creditor he wanted to prepay), and a prepay-only
voucher composes the same single AP line with no allocation. The voucher's
one GL line debits AP for the WHOLE amount, so the supplier's AP subledger
simply runs ahead; on post the server records the excess in `scm.acc_supplier_advances`
(mig 0340 — one row per voucher, `amount_sen` written once, `applied_sen`
only grows).

**The control lock and the AP-control line (docs/bugs/0649, 2026-09-06).**
The typing-time door that refuses a header or a control account on a
voucher line (`requireLeafAccount`, since #2913) judged EVERY debit line —
including the supplier payment's one line, which debits the AP control the
system itself chose — so from 2026-09-03 every AP Payment, 400 and 405
suppliers alike, was refused with `control_account_locked`. Now
`supplierOwnControl` resolves the supplier's OWN control first (400-0000 or
405-0000 by `apControlRole`), the lock skips exactly that line on create and
on edit, and the `wrong_ap_control` door still refuses the other control; an
expense voucher's lines are judged as before. The posted entry also stamps
the supplier on that Dr leg (`pvLines` takes `apControlCode`): the payment
reads Dr 405-0000 · 405-H001 / Cr bank, the way the invoice side's Cr leg
does, so the GL's Party column nets a supplier's invoices and payments.
Pinned by `backend/tests/pvApControlGuard.test.ts` (the fixtures now carry
`special_type: 'SCC'`, the production shape that had never been in a test)
and `backend/tests/pvSupplierAdvance.test.ts`.

**The advance on the list (same day).** `GET /payment-vouchers`
(`listPaymentVouchersHandler`) stamps `advance_remaining_sen` on every row
(`acc_supplier_advances` amount − applied, when > 0); the list paints such
rows blue, the Status cell wears "预付未冲 MYR x", and an **Advance open**
chip keeps only them — AutoCount's blue row, plus the number colour alone
cannot say. The knock-off card on the posted voucher lists the supplier's
open **AP invoices beside its purchase invoices** (an `AP` tag; the apply
sends `apInvoiceId` for those and the route settles them through the AP
invoice's own clamp).

**Spending it posts NOTHING.** Both legs already live in AP, so the
knock-off (POST `/payment-vouchers/:id/apply-advance`, surfaced as the
"Advance on this voucher" card on the posted voucher's detail page) only
settles the invoices' `paid_sen` — same DB-clamped rule as a payment, what
is recorded is what LANDED — and burns `applied_sen`. The applications ride
`pv_allocations` rows flagged `from_advance`, so the linked-PI trail shows
them; GET `/payment-vouchers/advances/list?supplierId=` answers what is
still unspent, and the New AP Payment page points at the holding voucher(s)
when the supplier already has money on account. A voucher whose advance HAS
been spent refuses to cancel (`advance_applied`) — its value lives inside
other documents now; an unspent advance cancels with its voucher, row and
all. Contracts: `backend/tests/pvSupplierAdvance.test.ts`.

## 0e. The bill reader (OCR, 2026-09-02)

The owner's ask, his words: 我想要把ocr 功能放去payment 那边，还有就是coming 的
bill 我也想要用ocr. Two doors, one reader:

- **In the form** — "📷 Scan bill (OCR)" in the New PV Lines card header.
  Multi-select = the PAGES of one bill; the form prefills payee, date, notes
  and lines from what was read.
- **The pile** — `/scm/payment-vouchers/scan` ("📷 Scan bills" on the list).
  Many files at once, the owner's three cases, his taxonomy exactly:
  1. 一张bill 几页 — tick the pages, press Merge: ONE bill. The rule that
     keeps it honest: **one file = one bill unless a human merged pages** —
     the reader never guesses whether two files are one document.
  2. 一个supplier 多张单 — read bills group by matched supplier (unmatched
     ones by printed vendor name) and a group opens as ONE voucher, one line
     per bill.
  3. 多个supplier 多个单 — "pay each bill separately" splits a group; each
     bill opens as its own voucher.

The pile takes drag-and-drop and pasted screenshots (Ctrl+V) as well as the
picker, and each read bill renders tidy: number / dates / total on one
aligned grid, the bill's own line items tabled under it — EVERY printed
line is read, no line cap (owner 2026-09-02: 别限制最多只能读8行; the
model's output budget is sized for ~300 lines and a 300-entry runaway
guard sits in `coerceBillJson`, not in the prompt).

The reading is POST `/payment-vouchers/extract` (perm
`scm.payment_voucher.create`; 503 when `ANTHROPIC_API_KEY` is unset) →
`backend/src/acc/bill-extract.ts`, the scan-so discipline verbatim: strict
JSON, unreadable fields are **null and never invented** (an unreadable TOTAL
renders "total unreadable — will need typing", not RM 0.00), RM→sen once
server-side, and supplier matching in plain code — normalize both names
(SDN BHD / S\/B / ENTERPRISE tails stripped), exact → contains, below that
NO match, because a wrong supplier pre-selected is worse than none. Caps:
12 bills/call, 8 files/bill, 20MB/file, images + PDF (the image allowlist is
`vision-blocks.ts`'s — one home). **Nothing on either door writes.** Every
scan lands on the New page for a person to check, pick or confirm the
account (§0f fills it only from what THIS operator saved before) and save
through the untouched approval cycle. Contracts:
`backend/src/acc/bill-extract.test.ts`,
`frontend/src/pages/scm-v2/PaymentVoucherScan.test.tsx`.

**扫 → bill (2026-09-03, the owner confirming the flow himself: 他是扫
bill, 然后帮我录入 bill. 几时要还是我会开 ap payment 去还 — 对)**: beside
every "Open as voucher" sits **Open as bill** (and "Open as ONE bill" on a
grouped supplier), which lands on New Purchase Invoice instead — the
matched supplier pre-picked when the reader recognised one, the supplier's
own invoice number and date carried, one manual line per read line (or per
bill, on a group). This only RECORDS the debt into AP; paying stays a
separate AP Payment, whenever he chooses — the knock-off flow other
creditors ride too. Same discipline: nothing saves until a person does.
Contract: the 扫 → bill block of `PaymentVoucherScan.test.tsx`.

## 0f. Vendor memory (mig 0341, 2026-09-02)

The owner's ask, his words: 我想要你要有记忆我下次submit 同个类型的invoice
自动帮我填，选account 等等. `scm.acc_vendor_memory` — one row per
(company, vendor) remembering what the operator **actually saved**: the
payee's casing, the FIRST line's expense account, the purpose. NOT what the
model guessed — only a human's save teaches.

- **Learns on save**: `learnVendorMemory` runs after a successful PV create,
  and after a DRAFT edit that replaced the lines (the correction signal —
  usually the account the last prefill got wrong). AP payments teach
  nothing: their one line debits the AP control, fixed by role.
  Last-saved-wins; `times_seen` only grows. **Best-effort on purpose** —
  both legs bind their failure and skip; a habit cache must never turn a
  saved voucher into an error.
- **Keyed by `normalizeVendor`** (the supplier matcher's own normalizer), so
  "TNB", the OCR's reading of the printed name, and the matched supplier's
  clean name all land on one row.
- **Read back by POST /extract**: each read bill carries
  `memory: { payeeName, debitAccountCode, purpose, timesSeen } | null` —
  the printed name looked up first, the matched supplier's name as
  fallback, the other company's habits never (company-scoped read).
- **The form fills from it**: payee takes the operator's casing over the
  print; every drafted line gets the remembered account, announced in the
  scan note ("Account … filled from your last … voucher — check it") and
  still editable. No memory → account stays empty and a person picks it.

Contracts: `backend/tests/pvVendorMemory.test.ts` (teach / not-AP /
correction / extract hand-back + company scope),
`PaymentVoucherNew.test.tsx` (记忆自动帮我填 pin).

## 1. Frontend

| Surface | File |
|---------|------|
| Desktop list | `frontend/src/pages/scm-v2/PaymentVouchers.tsx` |
| Desktop new | `frontend/src/pages/scm-v2/PaymentVoucherNew.tsx` |
| Desktop scan (the bill pile) | `frontend/src/pages/scm-v2/PaymentVoucherScan.tsx` |
| Desktop detail + edit | `frontend/src/pages/scm-v2/PaymentVoucherDetail.tsx` |

**There is NO mobile surface.** Nothing under `frontend/src/mobile` mentions a
voucher. This is the one procure-to-pay document that is desktop-only, so the repo's
"desktop and mobile move together" rule has no counterpart to honour here — if a
mobile PV is ever added, it must carry §4 and §6 with it.

Data hooks: `frontend/src/vendor/scm/lib/payment-voucher-queries.ts` —
`usePaymentVouchers(status?)`, `usePaymentVoucherDetail(id)`,
`useCreatePaymentVoucher`, `useUpdatePaymentVoucher`, `usePostPaymentVoucher`,
`useCancelPaymentVoucher`; the bill reader's `useExtractBills` + `fileToBase64`
(§0e). Query keys `['payment-vouchers', …]` and
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
| POST | `/extract` | `scm.payment_voucher.create` | §0e — reads uploaded bills with Claude vision, returns extractions + supplier matches + the vendor memory (§0f); writes NOTHING; 503 without `ANTHROPIC_API_KEY` |
| PATCH | `/:id` | `scm.payment_voucher.write` | **DRAFT only** (409 `not_editable`); a cleared Voucher Date is refused 400 `voucher_date_required` — §7 |
| POST | `/:id/check` | `scm.payment_voucher.check` | §0b — the first yes: locks the voucher, joins Daily Bank's pending |
| POST | `/:id/post` | `scm.payment_voucher.post` **or** `.approve` | writes the GL entry, DRAFT → POSTED, settles PIs, **adopts the FX rate**; normally reached THROUGH approve (§0b) |
| POST | `/:id/cancel` | `scm.payment_voucher.cancel` | reverses the GL entry, unwinds settlement, **retains the FX rate** |
| POST | `/:id/files` | `scm.payment_voucher.write` | §10 — attach one file (JSON `{fileName, mime, dataBase64}`; JPEG/PNG/WebP/PDF, ≤20MB); 409 `voucher_cancelled` on a CANCELLED voucher |
| GET | `/:id/files` | area guard | §10 — the index rows, in `sort_no` (= attach = print) order |
| GET | `/:id/files/:fileId` | area guard | §10 — streams the bytes from R2 with the stored mime, `content-disposition: inline` |
| DELETE | `/:id/files/:fileId` | `scm.payment_voucher.write` | §10 — removes row + object; 409 `evidence_locked` once the voucher is **checked** |
| POST | `/print-bundle` | area guard | §11 — `{ parts: [{ pvId, voucherBase64 }] }` → ONE merged PDF (each voucher's page, then its stored files); 404 fails the whole bundle when a pv can't load; ≤30 parts |

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
| `backend/tests/pvFiles.test.ts` | §10 against a fake R2 binding: upload order/mime/size gates, list walks `sort_no`, stream returns the stored mime and bytes, delete removes the R2 object too and 409s `evidence_locked` once checked |
| `frontend/src/pages/scm-v2/PaymentVoucherScan.test.tsx` + `PaymentVoucherNew.test.tsx` | §10's carry: the stash holds each bill's own pages (group = all members, split = its own file only), and the New page attaches them onto the created voucher's id, in scan order |

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

---

## 10. Attachments — the bill lives with its voucher (2026-09-03)

The owner, planning printing: *我希望可以 print pv include ocr 的文件一起* — and
the audit before it found the scan flow READ the bill and kept **nothing**, so
there was no evidence to show, let alone print. Now the file lives with the
voucher.

**Storage.** Bytes go to the **SLIPS R2 binding** (the one bucket that exists —
the Worker-proxy story is in `frontend/src/vendor/scm/lib/slip.ts`'s header)
under `pv-files/<company>/<pv>/<uuid>.<ext>`; the index is `scm.acc_pv_files`
(mig `backend/src/db/migrations-pg/0352_acc_pv_files.sql`): one row per file,
`file_key UNIQUE`, `pv_id` FK `ON DELETE CASCADE`, and `sort_no` = attach order
= the order printing will append the files after the voucher page. Routes live
in `backend/src/scm/routes/pv-files.ts` (the PV spec + the print bundle; the
four handlers come from `backend/src/scm/lib/doc-files.ts`, the factory the
AP invoice's `routes/ap-invoice-files.ts` has shared since 2026-09-06 —
docs/modules/accounting.md "The AP invoice's paper") and are mounted in
`backend/src/scm/routes/payment-vouchers.ts` **before** `GET /:id`, so
`/:id/files` never falls into the detail matcher. The detail's Files card is
the shared `frontend/src/vendor/scm/components/DocFilesCard.tsx`, bound to
the voucher's hooks and rules by `PvFilesCard`.

**The four-layer rule applies to evidence.** Upload/delete take
`scm.payment_voucher.write`; a **CANCELLED** voucher takes no more files
(409 `voucher_cancelled`); delete is refused with 409 `evidence_locked` once
`checked_at` is stamped — checked 的人就不可以改了, and that includes the bill
the checker looked at. Reading rides the voucher (area guard).

**How files arrive.**
- **Scan → voucher**: the batch screen (`frontend/src/pages/scm-v2/PaymentVoucherScan.tsx`)
  keeps each read bill's payload by bill index and stashes it on *Open as
  voucher* / *Open as ONE voucher* (a group stashes every member's pages, in
  bill order; a split bill stashes only its own). The stash is **module
  memory** — `frontend/src/vendor/scm/lib/pv-file-handoff.ts` — never
  `location.state`, because `history.pushState` serializes its state and
  browsers cap an entry around 16MB: a scanned PDF could make the navigation
  itself throw. `takePvFiles()` clears, so a stale pile cannot attach to an
  unrelated voucher.
- **The New page** (`frontend/src/pages/scm-v2/PaymentVoucherNew.tsx`) takes
  the stash (and its own *Scan bill* keeps the pages it read), shows a 📎
  pending line, and after `create` succeeds uploads **sequentially** so
  `sort_no` is the scan order. A failed upload never un-saves the voucher: the
  dialog names how many attached and how many did not, and only the unattached
  remainder stays pending — a re-press replays the same voucher via the
  idempotency key and must not attach the first files twice.
- **Manually**: the detail page's **Files card**
  (`frontend/src/pages/scm-v2/PaymentVoucherDetail.tsx`, `PvFilesCard`) lists
  in `sort_no` order, attaches (`PV_FILE_ACCEPT`), views, and deletes until
  checked. *View* is an authed byte fetch → blob object URL
  (`fetchPvFileBlobUrl` in `frontend/src/vendor/scm/lib/payment-voucher-queries.ts`,
  beside the `usePvFiles` / `useUploadPvFile` / `useDeletePvFile` hooks) —
  there is no public URL to leak.

**What this is FOR**: §11 — the print appends these files to the voucher PDF,
PV page first, then its files in `sort_no` order.

---

## 11. Print — the voucher WITH its evidence (2026-09-03)

The owner: *我发现没有办法 print pv？我希望可以 print pv include ocr 的文件一起*.
Layout is my draft on his 就你做吧，不满意到时我改.

**The voucher page.** `frontend/src/vendor/scm/lib/payment-voucher-pdf.ts` —
`renderPaymentVoucherInto(doc, autoTable, header, lines, allocations,
accountLabel)` in the unified Hookka-tidy family (letterhead `drawHeader`,
`drawInfoColumns` PAY TO / VOUCHER DETAILS, plain B&W lines table, settled-PI
table when any, footer `pv_number · portal · page n of m`). Specifics of THIS
document:
- **the four-layer strip is the signature block** — four dashed boxes
  (Prepared / Checked / Approved / Received by); the first three print the
  RECORDED `*_by` name and `*_at` date, Received by stays blank for the
  payee's pen;
- the **status word** comes from `statusLabel('pv', …)` (POSTED prints
  "Approved" — the owner's vocabulary, never the raw enum);
- **amount in words is MYR-only** (`amountInWordsMyr`); a foreign voucher
  prints `CNY @ rate` and the `≈ posted to GL` MYR line instead — spelling
  yuan as RINGGIT would be a false sentence;
- accounts print through the CALLER's NAMER: the lines table gives
  **Account Code and Account Name their own columns**, ahead of Description
  (owner 2026-09-04); Paid From stays one joined string. The namer must read
  the UNFILTERED chart — an old voucher on a now-inactive account still
  deserves its name on paper.

**Owner's 2026-09-04 print polish.** The letterhead address wraps at COMMAS
now (`wrapAtCommas` in `frontend/src/vendor/scm/lib/pdf-common.ts` —
splitTextToSize had cut "No. 2," into "No." / "2,"; it lives in the shared
`drawHeader`, so every document's letterhead tidies together; pinned in
`frontend/src/vendor/scm/lib/pdf-address-wrap.test.ts`). The signature strip
sits a little lower (breathing room). And **including the files is the
operator's call per print**: a checkbox on the detail preview card (default
ON) and a "with files" tick on the batch bar (default ON; off = vouchers
only, rendered into one shared jsPDF client-side, no Worker round-trip).

**The evidence merges ON THE WORKER.** jsPDF can only draw — it cannot absorb
an existing PDF's pages, and his bills are mostly PDFs; pdf-lib does that one
job but costs ~200KB gzip, and the frontend bundle gate allows one change
+60KB. The files also already LIVE server-side, in the SLIPS bucket. So:
`POST /payment-vouchers/print-bundle` (`backend/src/scm/routes/pv-files.ts`,
mounted before `/:id`) takes `{ parts: [{ pvId, voucherBase64 }] }` — each
part one voucher's RENDERED page(s) — and `backend/src/scm/lib/pdf-attach.ts`
(pdf-lib, a backend dependency) appends that voucher's stored files after its
page, `sort_no` order, part after part, one PDF back. Per file: a PDF's pages
copy across; JPEG/PNG sits centred on its own A4 page; a file that cannot
embed (corrupt, truly locked, webp — Workers have no canvas) becomes a
**notice page naming it**, and so does an index row whose R2 object is gone —
visible failure on paper, never a silently missing bill, never a failed
print. A part whose voucher cannot load fails the WHOLE request by pv. Since
2026-09-06 (owner: bundle 也带上) the bundle also appends, after the
voucher's own files, the files of every **AP invoice the voucher pays**
(`pv_allocations.ap_invoice_id`, allocation order; each named under its
invoice number so a notice page says whose) — purchase-invoice allocations
add nothing, and a voucher paying no AP invoice prints exactly as before. The
client half is `fetchPvPrintBundle` + `pdfBytesToBase64`
(`frontend/src/vendor/scm/lib/payment-voucher-queries.ts` /
`payment-voucher-pdf.ts`); the returned blob exits through `deliverPdfBlob`
(`frontend/src/vendor/scm/lib/pdf-common.ts`), the blob twin of `deliverPdf`.

**Where it fires.** The detail page
(`frontend/src/pages/scm-v2/PaymentVoucherDetail.tsx`): a Print button →
`PrintPreviewModal` (`usePrintPreview` / `useOpenPrintPreviewFromUrl`);
`deliverPrintPdf` refuses to print when the file LIST cannot be answered — a
voucher quietly missing its bills is the dishonest branch — and bundles via
the Worker when files exist. The list
(`frontend/src/pages/scm-v2/PaymentVouchers.tsx`) context menu's Print rides
the established `?print=1` route: land on the detail, its preview opens
itself.

**Batch** (owner: 可选多张 pv + document, 就 pv+document, pv+document…): the
list's tick now means "include in the batch" — EVERY row ticks (the old
isDisabled gate fell away; the approval buttons still count only the rows
their yes applies to), and the batch bar gains **Print N + files** / **Save
PDF**. `printSelected` in `frontend/src/pages/scm-v2/PaymentVouchers.tsx`
loads each ticked voucher fresh (`fetchPvPrintDetail`), renders each as its
OWN jsPDF (its own page numbering), and posts the parts to the same
`print-bundle` route — the Worker interleaves voucher A's pages, A's files,
voucher B's, B's, list order, one PDF back. One voucher failing to load
fails the WHOLE print with its number.

**The tick itself** (owner: 这个我一点就直接tick 了…做成一定要点那个tick 的
格子, 然后我要点开 pv 时就是点两次打开): the grid takes
`selectable.checkboxOnly` (`frontend/src/vendor/scm/components/DataGrid.tsx`)
— with it, a row click only highlights, the tick lives in the checkbox cell
alone, a double-click opens, right-click menus. Default OFF, so the Commander
rule (点行=multi-select) stands on every other list; the PV list opts in.
Every step chip is the same grid, so 接下来的 step 同理 comes free.

**Tests**: `frontend/src/vendor/scm/lib/payment-voucher-pdf.test.ts` (text
draws — strip names, status word from the one home, MYR-words vs foreign
line); `backend/tests/pdfAttach.test.ts` (real pdf-lib: 2-page bill
contributes both pages, image gets a page, corrupt/webp costs a notice page
and never a throw, batch interleave pinned by page widths);
`backend/tests/pvFiles.test.ts`'s print-bundle case (voucher page first, its
files after, missing R2 object → notice page, unknown pv → 404 for the whole
bundle); `frontend/src/pages/scm-v2/PaymentVouchers.test.tsx` pins that
every row ticks, a POSTED row offers Print and no approval button, and a
ROW click ticks nothing; `frontend/src/vendor/scm/components/DataGrid.test.tsx`
pins both sides of `checkboxOnly` (the default row-click tick stays).

## §12 Voucher numbering — the owner's levers (GL redesign item 8a, 2026-09-05)

`scm.acc_bank_letters` (one prefix letter per money account — Maybank M means
the `{co}-MPV-YYMM-NNN` series; UNIQUE per company+letter, because two banks on
one letter would share a series) and `scm.acc_numbering` (suffix width 3-5 —
his 如果到时我要 2990-MPV-2609-0001 呢; width is display-only, the parsers take
any length, so changing it renumbers nothing). Maintained by the owner on the
**Voucher numbering** card of /scm/settlement-setup (`GET/PUT
/accounting/numbering`, handlers in accounting-numbering.ts) — a new bank is a
letter typed there, never a deploy. `mintMonthlyDocNo` / `nextMonthlyDocNo`
take the width as a parameter (default 3, callers unchanged). The migration
also parked the only two existing vouchers (both DRAFT) on the
`2990-Draft-YYMM-NNN` series — draft 不占正式号; item 8b mints the formal
per-bank number at CHECKED. The OR channels (item 9) and transfers (item 10)
read the SAME letter table. Pinned by backend/tests/voucherNumbering.test.ts.

### §12b The Draft → formal flow (item 8b)

A new voucher mints on the Draft series — `{co}Draft-YYMM-NNN`, YYMM being
the voucher's own `voucher_date` (owner 2026-09-07, 要根据文件日期; the rule
and the helper live in accounting.md, "Document numbers follow the document
date") — (`nextPvDraftNo`) — and earns its formal number at **CHECKED**:
`checkPaymentVoucherHandler` reads the credit account's letter and the
company width, mints `{co}{letter}PV-YYMM-NNN` — again the voucher date's
month, never the check day's — (`mintFormalPvNo`,
collision-retried the way inserts are), records the renumber on the audit
trail, and answers `pvNumber` so the screen can say so. A bank with no letter
REFUSES the check (409 `bank_letter_missing`) with the setup card named — a
voucher must never mint into a series nobody configured. **The cash drawer is
the one fixed series** (owner 2026-09-05: 我payment 出去by cash 时就会是
cpv啊): paid from `roles.CASH`, the mint takes `CASH_SERIES_LETTER` straight —
`{co}CPV-YYMM-NNN` — with no letters row involved; the same C prints COR on
the receipt side. The numbering card shows the drawer read-only (`fixedCash`
on the GET), the PUT refuses both a letter FOR it (`letter_fixed`) and C on
any bank (`letter_reserved`). A voucher already
carrying a formal number (a reject → re-check round) keeps it: a slot is
never burned twice for the same paper. Journals cannot see draft numbers by
construction — posting happens at approve, after the mint. Pinned by
backend/tests/pvDraftNumbering.test.ts.

## §13 Internal transfers ride the PV (GL redesign item 10)

The owner's call verbatim: 不能直接在 pv 那边开转账就好吗. A transfer is the
same paper: the New-PV screen (non-AP mode) carries a 付款/内部转账 toggle —
transfer mode swaps the payee for a "Transfer to" pick of OUR OWN money
accounts (Paid From excluded) and the lines for one amount box; the payload
is a normal voucher whose single line debits the destination
(payee_name = "Internal transfer to <code> <name>", the marker everything
else keys on). Same Draft→Checked→Approved chain, same per-bank number
series, same GL door (approve posts Dr destination / Cr Paid From — a money
move, not an expense); the PRINT re-titles itself TRANSFER VOUCHER off the
payee marker, batch printing included. The route refuses a line debiting the
Paid From account itself (`same_account`, create AND edit, the edit checked
against the EFFECTIVE Paid From) — a transfer into itself is meaningless and
an expense line on the paying bank is a typo. Cash bank-ins are the same
document (drawer → bank). Supplier-payment reports stay clean by
construction: a transfer's debit leg is a money account, not an expense or
AP control. Pinned by backend/tests/pvTransfer.test.ts + the same_account
refusals in the route.
