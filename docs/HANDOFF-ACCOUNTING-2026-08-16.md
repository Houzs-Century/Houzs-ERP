# Accounting module — session checkpoint (2026-08-16)

> For the next session: read this + `docs/modules/accounting.md` +
> `docs/新ERP会计模块需求书.md` §3.5/§6, then continue at **NEXT UP**.
> The auto-memory file `accounting-module-decisions.md` carries the owner
> decisions; `gh-cli-ship-directly.md` carries the shipping mechanics.

## Shipped and live in production (all verified against the live DB)

| PR | What |
|---|---|
| #2260 | Phases 0+1: one posting gate (`backend/src/acc/engine.ts` + `rules.ts`), DB second-layer (balanced CHECKs + `acc_je_one_active_source` unique index, mig 0296), unified AutoCount-style chart + roles (mig 0297), Accounting page 7 tabs (CoA mgmt, manual JV, TB with 0.00 self-check, GL, AR/AP aging, layer-1 control self-check) |
| #2261/#2262 | Phase 2A: customer payments post through the gate (`acc/payments.ts`, SOPAY/SIPAY keyed on payment-row uuid); acquirer master `scm.acc_acquirers` (mig 0298; CIMB/GHL/HLB/MBB/PBB); five one-line hooks live in sales files (so-payment-row insert, mfg-sales-orders delete, sales-invoices 2 inserts + delete); backfill endpoint exists but MUST NOT RUN (owner: trial period, no historical backfill; ~2,703 rows / RM 9.34M stay unbooked until he sets the official start date) |
| #2263 | Phase 2B pt 1: Daily Bank board (`acc/daily-bank.ts` pure compute + `GET /accounting/daily-bank`, page `/scm/daily-bank`, `acc_money` flag mig 0299, canvas Get-Image to clipboard) |
| #2265 | Phase 2B pt 2: Daily close (`acc/daily-close.ts`, `scm.acc_daily_closes` mig 0300, GET/PUT `/daily-close` + `/confirm`; CASH over/short posts on confirm via source `CASHUP` to 946-0000; card/transfer diffs recorded only — layer 3 owns them; UI = Daily close view inside the Daily Bank page) |

## BUILT, NOT MERGED — layer 3, waiting on the OWNER'S LOCAL TEST

Branch `feat/acc-settlement` (off origin/main, worktree
`.claude/worktrees/accounting`), commits `dad6e2e1` + `4062166b`. **Do not open
a PR until the owner has clicked through it locally** — his explicit gate:
最好到时我在本地测试确定没问题才上；银行对账包括卡机.

What is on the branch:

- **Migration 0301** — the acquirer master follows the unify principle:
  `scm.acc_acquirer_config` (GLOBAL: statement_format, has_unique_ref,
  fee_method, date_tolerance_days, column_map) + `scm.acc_company_acquirers`
  (per company: transit / fee / bank account codes, active). `acc_acquirers`
  survives **as a VIEW of the same shape**, so phase-2A readers (payments.ts,
  `/acquirers`, Daily Bank) changed by zero characters.
- **Migration 0302** — `acc_settlement_batches` (UNIQUE on the file's SHA-256:
  the same file twice is refused), `acc_settlement_rows` (the four screen
  buckets), `acc_settlement_matches` (UNIQUE `(payment_source, payment_id)` —
  the DB's own refusal to settle the same payment twice).
- **`acc/settlement-parse.ts`** — config-driven CSV read; refuses BY NAME
  (missing column, unreadable line, PDF-only acquirer, missing 决定4) and never
  parses to 0 silent rows. Three fee methods; prorated fees sum exactly.
- **`acc/settlement-match.ts`** — auto-match ONLY on a unique reference; an
  acquirer without one (or with `has_unique_ref` still NULL) sends every line to
  NEEDS_CONFIRM; tolerance comes from the config row; exact-summing PAIRS are
  surfaced for the one-swipe-many-orders case.
- **`acc/settlement.ts`** — confirm = post, that moment: Dr bank + Dr fee /
  Cr transit, source `SETTLE`, doc `SETTLE-<row id>`. Links first, post second,
  stamp last, so a failure is retryable and never leaves a "confirmed" line with
  nothing in the ledger.
- **Ten endpoints** `/accounting/settlement/*` registered one path each in
  `routes/accounting.ts` (the route-capability audit only follows top-level
  `app.route`/`scm.route`, so a sub-router would have hidden them); handlers in
  `routes/accounting-settlement.ts`, each behind its own permission check.
- **Page `/scm/settlement-recon`** (Finance menu, "Card Settlement"): upload,
  four piles, multi-select candidates with combo hints, two watchlists, CSV
  export, and an **Acquirer setup tab that is where 决定4 gets typed in**.

Green locally: backend light 4933 · backend workers 335 · frontend 1472 ·
route matrix regenerated (1076 routes) · release-discipline no new violations ·
file-size ratchet OK · frontend lint ratchet OK. Coverage ratchet could NOT run
in this worktree (`@vitest/coverage-istanbul` is absent from the junctioned
node_modules) — every new file does carry a test that executes it, but CI is
the real answer.

### How to run the owner's local test

1. `preview_start` both servers (backend `npm run dev` in `backend/`, frontend
   `npm run dev` in `frontend/`) from this worktree.
2. Apply migrations 0301 + 0302 to whatever DB the local backend points at.
3. Acquirer setup tab: fill MBB in as CSV / unique ref YES / fee stated /
   tolerance 3 / column map, and GHL as CSV / unique ref **NO** — GHL is the
   one that proves nothing auto-confirms without a reference.
4. Seed a few card payments, export a matching CSV, upload it, and walk him
   through: the auto-matched pile, "confirm all matched", a needs-confirm line
   where he ticks two orders that add up, a wrong file (it must refuse by name),
   and the two watchlists.
5. Only after he approves: PR + merge.

## NEXT UP after layer 3 merges

Phase 3 (approvals) then phase 4 (openings + bank reconciliation, layer 4).
Layer 4 must, from day one: support MANY bank accounts (系统3 hardwired one
Hong Leong account), add the "which acquirer is this bank line" rule for every
acquirer AT THE SAME TIME as the acquirer itself, and keep 系统3's gate that
blocks bank reconciliation while any settlement line is still unmatched — the
`/settlement/watchlist` endpoint's `clean` flag already answers that question.

## Waiting on the owner (asked, not yet delivered)

- **His REAL chart of accounts** (current 31-account chart is a placeholder
  template). One shared chart auto-synced to all companies. Swap promptly on
  arrival (plan in auto-memory), repoint every role, remap trial entries.
- **决定4 acquirer sheet** (ask each acquirer ONCE + which companies use it,
  into which bank account each): statement format, unique ref yes/no, fee
  presentation, receiving bank. **The setup tab is now the place to enter it** —
  until it is entered, an acquirer simply cannot have a statement uploaded.
- Trial period stands: NO backfill, official ledger start date = his call at
  the phase-4 openings moment.
- Approved for later: GROUP CONSOLIDATED reports (companies summed,
  intercompany eliminated) in phase 4/5.
- Fee SST split (expense + input tax) is deliberately phase 5; the fee is
  booked whole today rather than split at a guessed rate.

## House rules that bit us (all now encoded in memory / this repo's gates)

backend-typecheck job front-loads ~20 audits (route matrix regen, bug-index
area registration, swallowed-reads bind+branch, release-discipline
`-- REVERSAL:` header in every migration + `Reversal:`/`Verified against:`
lines in the PR body); frontend: lint ratchet (void floating promises,
no-unnecessary-condition at ZERO for new files), coverage ratchet (every NEW
file needs a test executing it — a module the page test MOCKS does not count),
route-manifest count seal (TWO numbers in routeManifestDrift.test.ts, staff and
contract, both bumped with a dated comment), file-size ratchet (2000-line cap
for new files; it measures the COMMITTED tree, so commit before running it).
`fakeSb` now also supports `range/gte/lte`, returns inserted rows when the
insert `.select()`s them, and can mint NUMERIC ids for BIGINT-identity tables.
Run the FULL suites before pushing, not targeted ones.
