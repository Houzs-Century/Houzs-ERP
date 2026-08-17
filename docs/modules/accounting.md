# Module: Accounting (财务/会计)

> The requirements brief is `docs/新ERP会计模块需求书.md` — twelve iron rules,
> a five-phase build order, and the boundary rules (§6) that govern every
> change this module makes. Read it before extending this module. Phase
> tracking and owner decisions live with the owner; the standing ones are
> restated here.

**Owner decisions (2026-08-13):** the existing Finance menu pages are THIS
module's to upgrade · AutoCount runs in parallel (ERP pushes documents to it;
the module is built to formal-book standard so it can eventually replace it) ·
multi-company WITH intercompany invoicing · tax data structures in phase 2,
MyInvois in phase 5 · account codes unify on AutoCount-style `XXX-XXXX` in
phase 1 · **reconciliation features (acquirer/card-machine + bank) must be
tested by the owner locally before they merge.**

## 1. The one posting gate

Every journal entry is written by `backend/src/acc/engine.ts` —
`postJournal` / `reverseJournal` — and nowhere else. The rules table
(`backend/src/acc/rules.ts`) is the single, readable list of "which action
books which entry":

| action | entry | source_type | reversal |
|---|---|---|---|
| Sales invoice issued | Dr AR / Cr SALES | `SI` | `SI_REVERSAL` |
| Purchase invoice posted | Dr INVENTORY / Cr AP | `PI` | `PI_REVERSAL` |
| Payment voucher posted | Dr expense legs / Cr bank-or-AP header | `PV` | `PV_REVERSAL` |
| Manual journal (JV) | operator lines, draft first | `MANUAL` | `MANUAL_REVERSAL` |
| Customer payment collected | Dr CASH/BANK/transit / Cr AR | `SOPAY` / `SIPAY` | `*_REVERSAL` |
| Daily cash close | Dr/Cr OVER_SHORT / Cr/Dr CASH | `CASHUP` | (correct by JV) |
| Acquirer settlement confirmed | Dr fee / Cr transit | `SETTLE` | `SETTLE_REVERSAL` |
| Statement charge with no transaction | Dr fee / Cr transit | `SETTLEADJ` | `SETTLEADJ_REVERSAL` |
| Acquirer payout received | Dr bank / Cr transit | `SETTLEBANK` | `SETTLEBANK_REVERSAL` |

Adding an auto-posting document type means: a rule in `rules.ts`, a caller
that builds its lines through that rule, and a behaviour-lock test — the
brief makes the test MANDATORY (系统 3 died of an untested copy).

The gate enforces, in order: shape (≥2 one-sided integer-sen lines) →
balance (Σdr = Σcr > 0) → chart (code exists for the company, active, not a
parent header) → idempotency (one ACTIVE entry per company+source_type+
source_doc_no; the read fails CLOSED) → numbering (per-company `JE-YYMM-NNNN`,
mint-retry on collision). Account codes resolve through ROLES
(`scm.acc_account_roles`, per company) — never hardcoded at call sites.

## 2. Database layer (second checks, migration 0296)

- `acc_je_balanced_totals` CHECK — header totals always equal.
- `acc_jel_nonneg` / `acc_jel_one_sided` CHECKs on lines.
- `acc_je_one_active_source` partial unique index — the database itself
  refuses a second ACTIVE entry for the same source document. A race or read
  blip can delay a posting; it can no longer double-book it.
- `scm.acc_account_roles` — role → account_code per company (AR / SALES /
  INVENTORY / AP today; settlement-in-transit and friends arrive in phase 2).
- `trg_je_balanced` (pre-existing): on the posted flip, re-sums the REAL
  lines, refuses unbalanced/empty, stamps totals + `posted_at`.

Ledger tables stay `scm.accounts`, `scm.journal_entries`,
`scm.journal_entry_lines` (live before this module; renaming them buys risk,
not clarity). NEW tables take the `acc_` prefix — that is the boundary
marker other teams can rely on.

## 3. API surface (backend/src/scm/routes/accounting.ts)

`/accounting/*`, all behind `supabaseAuth`; GL writes additionally gated on
`scm.payment_voucher.post` (owner decision recorded in-file; dedicated
`acc.*` keys arrive with the phase-1 UI).

Reads: `GET /accounts`, `/journal-entries`, `/journal-entries/:id`, `/gl`
(v_gl_entries), `/balances` (v_account_balances), `/ar-aging`, `/ap-aging` —
all company-scoped, all paginated past PostgREST's 1000-row cap.
Writes: `POST /journal-entries` (manual JV **draft** through the gate; source
type is FORCED to MANUAL and the chart is validated), `POST
/journal-entries/:id/post`, `POST /journal-entries/:id/reverse` (MANUAL only
— documents reverse through their own cancel flows), `POST /post/si/:inv`,
`POST /post/pi/:inv` (manual re-post endpoints; DRAFT guarded), `POST
/accounts` + `PATCH /accounts/:code` (chart management: code immutable,
parent must share the type, deactivation refused for parents-with-children
and role accounts), `GET /control-check` (reconciliation layer 1: AR/AP
control vs documents, drift named to the doc, foreign lines listed).

**Phase 1 (2026-08-16).** One AutoCount-style chart for every company
(migration 0297; company 2 template copied to company 1, ledger lines
remapped, roles repointed to 300-0000 / 310-0000 / 400-0000 / 500-0000,
legacy codes deactivated as alias records). MANUAL journals are blocked from
control accounts by the engine. The Accounting page carries seven tabs:
Chart of Accounts (add/rename/deactivate), Journal Entries (+ manual JV
form, post, reverse), General Ledger, Trial Balance (born with its own
zero-difference self-check tile), AR/AP Aging, and Self-check (layer 1).

**Phase 2A (2026-08-16).** Customer payments reach the ledger: acc/payments.ts posts each sales-panel payment row through the gate (Dr CASH / BANK_DEFAULT / acquirer transit by the panel 3-method model, Cr AR; source SOPAY/SIPAY keyed on the payment row uuid). scm.acc_acquirers is the 2.13 master (display_name = the exact merchant_provider strings; CIMB/GHL/HLB/MBB/PBB seeded; 决定4 config columns NULL until the owner fills them). imported-method rows and payments on migrated invoices never book - AutoCount carries that money. GET /acquirers lists the master; POST /backfill/customer-payments walks unposted rows batched + idempotent. The sales-side insert/delete HOOKS are NOT yet wired - listed for owner approval per brief 6.3/6.4.

**Phase 2B part 1 (2026-08-16): Daily Bank.** GET /accounting/daily-bank?date= answers the owner one question - today, where is the money and how much can actually move - live from the ledger (2.3: no caches): opening/in/out/closing per money account (scm.accounts.acc_money flag, migration 0299), settlement-in-transit balances per acquirer (visible, never counted movable), pending-approval placeholder until phase 3. Page /scm/daily-bank (Finance menu): date navigation + Get Image (canvas-drawn PNG to clipboard for WhatsApp, download fallback). Board arithmetic pinned in acc/daily-bank.test.ts. 946-0000 Cash Over/Short + OVER_SHORT role seeded for the coming daily cashup.

**Phase 2B part 2 (2026-08-16): Daily close (layer 2).** GET/PUT /accounting/daily-close + POST /daily-close/confirm: each day each company counts the drawer against the system takings (both sales panels, bucketed cash / transfer / per-acquirer; imported rows never count). Confirming freezes the day (scm.acc_daily_closes, migration 0300) and posts the CASH over/short THAT DAY through the gate (946-0000, source CASHUP, idempotent per company+date); card/transfer differences are settlement timing owned by layer 3 - recorded, never posted here. UI: the Daily close view on the Daily Bank page. Confirmed buckets refuse edits - corrections are manual journals, on the record.

**Phase 2B part 3 (2026-08-16): acquirer settlement reconciliation (layer 3).**
The layer that empties `320-0000`. The acquirer master follows the owner's
"define once, all companies share" principle: `scm.acc_acquirer_config` is
GLOBAL (statement format, unique-ref flag, fee method, date tolerance, column
map — 决定4, taught once) and `scm.acc_company_acquirers` is the per-company
link (which bank/transit/fee accounts); migration 0301 splits them and leaves
`scm.acc_acquirers` behind as a VIEW of the same shape, so every phase-2A
reader is untouched. Migration 0302 adds `acc_settlement_batches` (one upload,
UNIQUE on the file's content hash), `acc_settlement_rows` (the four screen
buckets MATCHED / NEEDS_CONFIRM / UNMATCHED / IGNORED) and
`acc_settlement_matches` (which payments a line covers — UNIQUE
`(payment_source, payment_id)`, so the database itself refuses to settle the
same money twice). `acc/settlement-parse.ts` reads a statement entirely from
config and REFUSES by name rather than parsing 0 rows (§2.14);
`acc/settlement-match.ts` auto-matches ONLY on a unique reference — an acquirer
without one (or one whose 决定4 is still blank) sends every line to a human, and
the date tolerance comes from the config row, not a literal;
`acc/settlement.ts` confirms, which POSTS that moment.

**Two events, two entries** (owner, 2026-08-17: 全部卡机都是隔几天收到的。应该是
先对卡机报告，然后 match 了就会去 match bank statement). Reconciling the card
machine and receiving the money are days apart, so the ledger keeps them apart:
confirming a line books the FEE only (Dr fee / Cr transit, source `SETTLE`,
keyed `SETTLE-<row id>`, dated by the transaction). In between, settlement-in-
transit holds exactly what the acquirer still owes — the fee is already lost and
is no longer receivable. The customer side never changes: AR is knocked off by
the full gross at the swipe (owner: 顾客还款确定到时是记录6000哦，不然knock off
不到). A fee-free line confirms with no entry at all.

**One statement, one or more credits** (owner, same day: 我实际收到的钱可能是多笔
的哦). Hong Leong pays a multi-day statement one credit per trading day, Maybank
credits each trading date separately, and Public Bank goes the other way — one
advice covering three days. So each credit is a row in
`scm.acc_settlement_receipts` (migration 0304) with its own date, amount and
entry: Dr bank / Cr transit, source `SETTLEBANK`, keyed
`SETTLEBANK-<batch id>-<receipt id>` (per receipt, so two identical credits on
one day both post), dated by the BANK statement. A statement is "in the bank"
only when its credits add up to `stated_net_sen ?? net_sen`; a credit that would
overshoot is refused with both numbers named, because that money belongs to
another statement. `undoBatchReceipt` REVERSES a credit's entry rather than
deleting it. Layer 4 (bank reconciliation) will write these same rows from the
bank statement itself, which is why the operator is never asked for a payout
date at upload time — that is the one moment he cannot know it.

Thirteen endpoints under `/accounting/settlement/*` (setup read/write, upload,
batch list/detail, confirm one, confirm-all-matched, received, receipt undo,
ignore, watchlist, in-transit, CSV export), each carrying its own permission
check on top of the area guard. Page `/scm/settlement-recon` (Finance menu):
upload, four piles, multi-select candidates with combo hints, the credits-
received step with its list of credits banked so far, the paid-not-yet-in-the-
bank detail list (three states — the acquirer has not reported it / waiting to
be confirmed / reconciled but not paid — each naming who keyed the payment in,
and each showing what is STILL owed on it after fees, statement charges and
part-payments), the two standing watchlists, Excel-ready export.

SI auto-posts on create/confirm (`lib/post-si-revenue.ts`; resync
void+reposts on post-issue edits). PI posts on demand + resyncs. PV posts on
`POST /payment-vouchers/:id/post` and reverses on cancel. All three files own
only their document specifics; the entry writing is the engine's.

**Migrated documents book nothing** (`migrated_no_stock` guard): AutoCount
already carries their revenue/payable — posting here would double the books.
This is the parallel-run seam and it stays until the owner retires AutoCount.

## 4. Tests

- `backend/src/acc/engine.test.ts` — 22 locks on the gate itself.
- `backend/src/acc/settlement-parse.test.ts` / `settlement-match.test.ts` /
  `settlement.test.ts` — the layer-3 rules: a refused file names what is wrong,
  only a unique reference auto-matches, the tolerance is the configured number,
  a prorated fee sums exactly, a selection that does not add up is refused, and
  confirming twice books once.
- `backend/tests/settlementRoutes.test.ts` — the endpoints, including the 403
  at this end and the same-file-twice refusal.
- `backend/src/scm/lib/post-si-revenue.test.ts` — the SI path's 15 locks,
  passing unchanged across the engine rewire (the proof the rewire preserved
  behaviour).
- Company scoping and permission locks: `tests/companyScopeProcurementFinance`,
  `tests/companyWriteScope`, `tests/positionPolicy`.
- All light-project suites green at the rewire commit (318 files / 4,858 tests).

## 5. What phase 0 deliberately did NOT change

No endpoint contracts, no UI, no permission keys, no call sites outside this
module. `sales-invoices.ts`, `purchase-invoices.ts` and every other caller
still import the same functions with the same signatures and results. The
two behaviour changes are both fixes the old code documented against itself:
a PV reversal of a line-less entry now aborts loudly instead of posting a
zero-line reversal header, and a manual JV naming an account the company
chart cannot explain is now a 400.
