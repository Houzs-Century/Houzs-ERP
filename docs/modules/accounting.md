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

SI auto-posts on create/confirm (`lib/post-si-revenue.ts`; resync
void+reposts on post-issue edits). PI posts on demand + resyncs. PV posts on
`POST /payment-vouchers/:id/post` and reverses on cancel. All three files own
only their document specifics; the entry writing is the engine's.

**Migrated documents book nothing** (`migrated_no_stock` guard): AutoCount
already carries their revenue/payable — posting here would double the books.
This is the parallel-run seam and it stays until the owner retires AutoCount.

## 4. Tests

- `backend/src/acc/engine.test.ts` — 22 locks on the gate itself.
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
