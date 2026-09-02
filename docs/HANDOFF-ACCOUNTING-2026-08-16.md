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

## LAYER 4 IS ON THE SAME BRANCH (2026-08-19) — also unmerged

The owner asked for it in the middle of testing layer 3, looking at a screen
that wanted the date and amount of every payout typed in by hand:

> 我不是应该upload bank statement 或 daily transaction report 然后你也自动核对吗

and, asked how far it should go: **整张月结单全部对.** So layer 4 is the whole
statement, not only the card credits.

| File | What |
|---|---|
| `backend/src/acc/bank-parse.ts` | Reads a bank's own export. Three amount shapes (one signed column; one unsigned plus a CR/DR column; separate debit and credit), pipe or comma, decimal or zero-padded integer sen. Proven against the real `ACCOUNTACTIVITYREPORT_564418610346.csv`: 225 transactions, RM 1,393,935.59 in, RM 1,298,413.88 out. |
| `backend/src/acc/bank-match.ts` | What a line IS. Joins a credit to the charge taken back against it; recognises the acquirer from CONFIG. |
| `backend/src/acc/bank-reconcile.ts` | The reconciliation statement, and the identity it CHECKS (see below). |
| `backend/src/acc/bank.ts` | Readers, and nothing that decides. |
| `backend/src/scm/routes/accounting-bank.ts` | Eight handlers, registered one path each in `accounting.ts`. |
| Migration **0305** | 5 tables + the four recognition rules SEEDED from the owner's own statements. |
| `frontend/src/pages/scm-v2/BankStatementTab.tsx` | The screen — the FIRST tab of Bank Recon now; typing a credit by hand is the fallback. |

**The three things worth knowing before touching it.**

1. **The reconciliation is falsifiable.** It rests on one identity —
   `closing(statement) − closing(ledger) = (bank has, books do not) − (books
   have, bank does not) + brought forward` — computed four different ways and
   then CHECKED. Numbers that fail it are reported as inconsistent and the
   difference is withheld. A reconciliation that publishes a gap it cannot
   account for is worse than none: it looks like work has been done.

2. **Do NOT join bank lines by shared reference.** The owner's own file
   disproves it seventeen times: three separate AEON payouts of RM 3,262.46,
   RM 6,619.48 and RM 10,114.61 all carry `MA458030163361` on 2026-08-03, and
   half the retail credits use the literal reference "Fund Transfer". Only ONE
   credit plus the debits sharing its reference and date are joined — which is
   exactly the Maybank debit-card shape (gross credited, fee taken back) and
   nothing else.

3. **One notion of "the acquirer paid us."** Booking a credit calls layer 3's
   `postBatchReceipt`; this module has no writer of its own. Migration 0304's
   header said so before this code existed.

Two owner answers on 2026-08-19 shaped it, and both made it smaller — recorded
in `docs/acquirer-statement-formats.md`: MBB's split credit is the BANK's
presentation, not a fourth fee shape (偶尔会在 bank statement 显示进全额然后扣),
and AEON pays net like any acquirer (他不理顾客是不是分期，他会进扣了手续费的钱给我).

## CHECKPOINT 2026-08-21 — READ THIS FIRST

`feat/acc-settlement`, worktree `.claude/worktrees/accounting`.
**HIS GATE OPENED 2026-08-24** — mbb, pbb都没有问题。大致都可以了。可以try
push 上去了 — so the branch is pushed and **PR #2694 is open**, carrying
origin/main merged in (418 commits, including the scm `_centi`→`_sen` rename
and `fmtCenti`→`fmtSen`, both swept through this branch's files by hand — the
fakeSb suite passes either way and cannot catch that drift; check against
origin/main file-by-file, not the suite). The gate's history, for whoever
reads this next: 最好到时我在本地测试确定没问题才上 — and he did.

### Where testing stands

- **Merchant reconciliation — HE HAS PASSED IT.** 2026-08-20: 卡机那边的 recon
  已经没有什么问题了. Do not reopen it without a reason from him.
- **Bank statement reconciliation** — he has run AEON through it end to end and
  it was correct to the sen. MBB, PBB, HLB and GHL not yet clicked through.
- **PBB payment advice — BUILT 2026-08-24, AND HE PASSED THE SCREEN THE SAME
  DAY.** He answered the open question with 继续 PBB 的界面, both halves
  landed (screen + matcher wiring), and he then clicked it with HIS REAL
  FILES on the rig: uploaded HOUZSCENTURY_IBG_20260810, saw 08-09 agree to
  the sen (RM 99,148.27) against his real report and the two missing days
  named by the blocker sentence, and accepted it — 可以了，没有问题就行.
  Do not re-ask him about this screen. STILL OPEN if he wants the full
  three-day green: fetch the 08-07 and 08-08 CSVs from the PBB portal,
  reconcile them, and the same advice card flips Ready by itself (it
  re-checks live); then his real MBB statement's RM 188,955.86 credit books
  across the three reports from the advice.

### The payment advice, as built (2026-08-24)

The screen is a **"Payment advice" tab on BOTH settlement screens** — one
component (`PayoutAdviceTab.tsx`), two doors. The owner placed it on
/scm/merchant-recon himself (2026-08-24: 毕竟它属于card merchant 那边 — the
advice is the acquirer's paperwork, and everything a person DOES about one is
merchant-side work); /scm/bank-recon keeps its door because the credit lands
there. It uploads the PDF as
`contentBase64` (acquirer fixed to PBB — the server refuses any other by
name), shows total / payee bank + account / advice date, every day's
`AGREES` / `DIFFERS` / `REPORT_MISSING` / `REPORT_NOT_RECONCILED`, and the
one-sentence `blockedBy` verbatim. Once ready it says the credit will book
itself, against how many reports.

**The bank matcher reads payouts now** (`bank-match.ts`, loaded by
`loadPayoutAdvices` in `acc/bank.ts`). An uploaded advice whose amount equals
the credit and whose days resolve EXACTLY onto reconciled, still-owed reports
IS the decision — no combination search, no cap-at-four; the clue names it
("PBB's payment advice of … says this credit pays …"). An advice that no
longer lines up — a report re-opened, partly paid, missing — simply fails to
resolve and the ordinary search takes over. Two same-amount advices are told
apart by the credit's own day, or left to a person. All pinned in
`bank-match.test.ts`. One property to keep in mind: matching happens AT
UPLOAD TIME, so an advice uploaded after its bank statement does not
re-decide stored lines — upload the advice first (it arrives before the
money anyway).

Proven end to end on the rig, twice over (this window and the one it
resumed): seed `PBB-2990HOME-Jun.csv` → reconcile → upload
`PBB-IBG-advice-Jun.pdf` → readyToReceive → bank CSV with the one
RM 11,814.44 credit → matcher answers from the advice → booked, owed 0.00.

The fixture pair is committed: `demo-statements/PBB-IBG-advice-Jun.pdf`
(synthetic, generated by `backend/scripts/make-demo-pbb-advice.mjs`, pinned
by `backend/tests/pbbAdviceFixture.test.mjs` reading the shipped bytes) pays
the June PBB CSV's one day. The PDF is all-ASCII, so `.gitattributes` marks
`demo-statements/*.pdf -text` — autocrlf once rewrote it and cut the last
batch row off the stream; the reader refused the file, which is how it was
caught.

### Still to do on layer 4 beyond that

- Hong Leong's own bank statement arrives as `acs_*.pdf`; `acc/bank-parse` reads
  CSV only, and `acc/settlement-pdf` is the machinery to reuse.
- A maintenance screen for `acc_bank_statement_config` — today a bank account is
  configured by inserting a row.
- **2990's `BANK_DEFAULT` role.** For Houzs it is right (he confirmed: only
  Maybank receives customer transfers). 2990 has no `acc_account_roles` row, so
  it falls back to 330-0000 Maybank; if 2990 takes transfers into Hong Leong,
  that row must be set or its bank reconciliation can never balance.

### Things he decided in this session (do not re-ask)

| His words | What it settled |
|---|---|
| 多张 so 那边放的 approval code 都一样…你不能自动核对吗 | Payments sharing a reference that sum to the line auto-match |
| 这个情况当他对的上卡机报告的数额也不应该出现不是？ | An exact-summing SUBSET is enough; the odd one out stays open and shows on the watchlist |
| 他可能不止两张单加起来，可能超过两张 | No ceiling by reference (exhaustive to 14); amount-only path bounded at 6 |
| for houzs 实际只有 maybank 在收 | The BANK_DEFAULT hardcode is correct for Houzs; leave it |
| 支票…很少甚至一个月都没有 | No uncleared-cheque account; the bank rec surfaces them |
| 一定会开 [Sales Invoice] | Revenue always reaches the P&L; deposits sit in AR briefly — do NOT move them to 410-0000 |
| 要 [a list of payments that never reached the ledger] | Built, on the Self-check tab |
| 当我重新上传他应该是 ignore 已经 recon 了的 transaction | A DUPLICATE bank movement arrives IGNORED |
| for pbb 就是几份 excel 对一份 pdf | The payout-advice model |

### The test rig (how to get back to it)

```
backend:  npx tsx scripts/settlement-demo-server.ts        (port 8788)
frontend: npm run dev:settlement-demo                      (port 5173)
          http://localhost:5173/demo-settlement.html
```

`POST /api/scm/demo/reset` clears it. To test against a REAL file, give the rig
the ERP side of it first — otherwise every transaction correctly reads as "no
sale in the ERP" and there is nothing to watch match:

```
node scripts/demo-seed-from.mjs PBB "…/HOUZSCENTURY_CSV_20260809 （PBB）.csv"
```

**重来一次 wipes the seeding.** The reset button restores the INVENTED demo
payments, so real files uploaded after it read as 31× "no sale in the ERP" —
which looks like broken matching and is not (it bit the owner on 2026-08-24).
After any reset, run demo-seed-from.mjs again before uploading real files.

His real files live in `Desktop/Houzs - ERP/` — `Merchant Report/` and
`Bank Statement/`. **They are not in the repo and must not be**: 225 live bank
transactions with customer names do not belong in git history. The fixtures in
`demo-statements/` are synthetic copies of their SHAPES.

## NEXT UP after this branch merges

Phase 3 (approvals) and phase 4's remaining half (opening balances).
Layer 4 already does what the note here used to demand of it: MANY bank
accounts (系统3 hardwired one Hong Leong account), a recognition rule for every
acquirer at the same time as the acquirer, and the gate that keeps a merchant
statement out of bank reconciliation until its lines are all decided —
`loadPayableBatches` refuses to offer one with an open line.

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
