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
- **`acc/settlement.ts`** — confirm = post, that moment. Links first, post
  second, stamp last, so a failure is retryable and never leaves a "confirmed"
  line with nothing in the ledger.
- **Migration 0304 + the TWO-STEP** (owner's correction, 2026-08-17: 全部卡机都
  是隔几天收到的。应该是先对卡机报告，然后 match 了就会去 match bank statement).
  Reconciling the card machine and receiving the money are days apart, so they
  are two entries: confirming a line books the FEE only (Dr fee / Cr transit,
  `SETTLE`, dated by the transaction), and each payout credit books Dr bank /
  Cr transit, dated by the BANK statement. In between, in-transit holds exactly
  what the acquirer still owes. AR is still knocked off by the full gross at the
  swipe — his constraint: 顾客还款确定到时是记录6000哦，不然knock off 不到. The
  statement-level charge (AEON's subvention fee) now credits in-transit too, not
  the bank. Layer 4 will supply the credits automatically; nothing asks for a
  payout date at upload time, which is the one moment he cannot know it.
- **`scm.acc_settlement_receipts` — one statement, one or more credits** (his
  second correction the same day: 我实际收到的钱可能是多笔的哦). HLB pays a
  multi-day statement one credit per trading day, MBB one per trading date, PBB
  one advice for three days. Each credit is its own row and its own entry
  (`SETTLEBANK-<batch>-<receipt>`, so two identical credits on one day both
  post); the statement is square only when they add up to `stated_net_sen ??
  net_sen`; an overshoot is refused with both numbers named; a wrong credit is
  UNDONE by reversing its entry. Partly in the bank never reads as in the bank.
- **Thirteen endpoints** `/accounting/settlement/*` registered one path each in
  `routes/accounting.ts` (the route-capability audit only follows top-level
  `app.route`/`scm.route`, so a sub-router would have hidden them); handlers in
  `routes/accounting-settlement.ts`, each behind its own permission check.
- **TWO pages, named by him, in HIS flow** (就不能分成 merchant
  reconciliation, bank statement reconciliation 吗？). His words for the flow:
  系统先抓 sales 输入的收款 → 上传 merchant report 去核对 → 核对完了没有问题才会
  显示去 bank statement 的 reconciliation → 期间给他看「还没收到钱的」和
  「merchant report 有但找不到 transaction 的」。So:
  `/scm/merchant-recon` shows ONLY what is not matched yet (应该就只会显示还没
  对上的 transaction 吧) — reports with lines to decide, split into "to choose"
  vs "no sale in the ERP", plus the sales-team payments no report has reported.
  `/scm/bank-recon` is GATED on the first being clean: an unreconciled report is
  not listed there at all, only counted and named. Opening anything replaces the
  list. Shared presentation only (`settlement-ui.ts`).
- **`/scm/settlement-setup` — ONE maintenance TABLE, every company at once**
  (他: 我应该 overall maintenance table，左手边是 merchant、bank，上面 header 是公
  司，这个公司有就 tick). Merchants and banks are the rows, companies the columns;
  a ticked merchant cell also carries which of that company's banks it pays
  into. The read answers for every company he is granted; the two writes take
  the company as a parameter and re-check it against those same grants. A company nobody set up shows everything unticked and creates its row
  on the first tick — no migration for a new company. Unticking a bank a
  merchant still uses is refused by name. Banks come from the chart, which is
  already central (0297) — no second bank master.
- **"Paid, not yet in the bank"** — the detail list he asked for (我需要看到说顾
  客还钱了，但是还没收款或还没对账。我要明细的), with WHO keyed each payment in
  (我还要看到谁记录这笔的) and three states: the acquirer has not reported it /
  waiting to be confirmed / reconciled but the payout has not arrived. Its total
  ties to 320-0000 to the sen at every point in the two-step — proven on the rig
  against the real AEON file (19,658.00 both sides).

Green locally: backend light 4933 · backend workers 335 · frontend 1472 ·
route matrix regenerated (1076 routes) · release-discipline no new violations ·
file-size ratchet OK · frontend lint ratchet OK. Coverage ratchet could NOT run
in this worktree (`@vitest/coverage-istanbul` is absent from the junctioned
node_modules) — every new file does carry a test that executes it, but CI is
the real answer.

### How to run the owner's local test

No database and no credentials needed — there is a rig:

1. `npx tsx scripts/settlement-demo-server.ts` from `backend/` (port 8788,
   in-memory; the REAL handlers, parser, matcher and posting engine).
2. `npm run dev:settlement-demo` in `frontend/`, then open
   `/demo-settlement.html`. NOT plain `npm run dev`: authed-fetch falls back to
   the PRODUCTION Worker when VITE_API_URL is unset, so the rig screens 401 and
   render blank — an empty company picker with the reason only in the browser
   console. The script (`frontend/demo/dev.mjs`) sets it and says so on boot.
3. Test files are in `demo-statements/` at the worktree root — the owner's own
   exports with merchant/card numbers replaced. All five acquirers are already
   configured from those files, plus `wrong-file.csv` for the refusal.
4. Walk him through, in the order the work happens: upload → the auto-matched
   pile → "confirm all matched" (fee only) → **Bank statement reconciliation**
   (the second page) → record a credit, then a second one → try one bigger than the
   statement (it must refuse, naming both numbers) → Undo one → "Paid, not yet
   in the bank" (three states, ageing, who keyed it in) → back to page one for
   the watchlists and a wrong file (it must refuse by name, keeping the file
   selected).
   `POST /api/scm/demo/reset` starts over; `GET /api/scm/demo/ledger` shows
   every entry that posted.
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
