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

Working tree: `.claude/worktrees/accounting`, branch `feat/accounting-p2b`
(everything merged; start the next PR on a FRESH branch off origin/main —
squash-merges orphan old commits and every same-branch follow-up PR goes
DIRTY; recipe if it happens anyway: `git merge origin/main`, `checkout --ours`
on the superset files, verify main had no third-party edits via
`git show origin/main:<file>`). node_modules are junctions into
`.claude/worktrees/finance`'s (backend) — frontend has its own real install.

## NEXT UP — acquirer settlement reconciliation (layer 3, LAST phase-2 piece)

Design already decided with the owner:
1. **Restructure the acquirer master to the unify principle** (owner said it
   three times: chart / recon / reports are defined ONCE, companies share):
   global config table (code, display_name, statement_format, has_unique_ref,
   fee_method, date_tolerance) + `acc_company_acquirers` link (company_id,
   acquirer_code, bank_account_code, transit_account_code, active). Config
   columns are still NULL so the restructure is free.
2. **Tables**: `acc_settlement_batches` (upload: acquirer, company, file name,
   parsed row count, status) + `acc_settlement_rows` (txn date, ref, gross,
   fee, net, matched payment id, bucket MATCHED / NEEDS_CONFIRM / UNMATCHED /
   IGNORED).
3. **Matching** vs SOPAY/SIPAY payment rows: by unique ref when the acquirer
   has one; amount+date(tolerance) otherwise — and a no-unique-ref acquirer
   NEVER auto-confirms (brief). Wrong file format = loud refusal, never a
   silent 0-row parse (§2.14).
4. **Confirm posts THAT MOMENT** through the gate: Dr bank (per company link)
   + Dr fee 930-0000 / Cr the acquirer transit — clears 320-0000. Fee SST
   split is phase 5.
5. **Four-bucket UI** (reuse the described 系统3 skeleton): bulk-confirm the
   auto-matched, candidate list with clues for needs-confirm (multi-select for
   one-settlement-many-orders), two standing watchlists (recorded-not-arrived
   / arrived-not-recorded), Excel export of unmatched + fees.
6. **OWNER GATE — DO NOT MERGE**: when built, run the app locally for the
   owner (preview_start both servers) with seeded test data; he clicks through
   the whole flow and approves; only then PR+merge. His words: 最好到时我在
   本地测试确定没问题才上；银行对账包括卡机.

## Waiting on the owner (asked, not yet delivered)

- **His REAL chart of accounts** (current 31-account chart is a placeholder
  template). One shared chart auto-synced to all companies. Swap promptly on
  arrival (plan in auto-memory), repoint every role, remap trial entries.
- **决定4 acquirer sheet** (ask each acquirer ONCE + which companies use it,
  into which bank account each): statement format, unique ref yes/no, fee
  presentation, receiving bank.
- Trial period stands: NO backfill, official ledger start date = his call at
  the phase-4 openings moment.
- Approved for later: GROUP CONSOLIDATED reports (companies summed,
  intercompany eliminated) in phase 4/5.

## House rules that bit us (all now encoded in memory / this repo's gates)

backend-typecheck job front-loads ~20 audits (route matrix regen, bug-index
area registration, swallowed-reads bind+branch, release-discipline
`-- REVERSAL:` header in every migration + `Reversal:`/`Verified against:`
lines in the PR body); frontend: lint ratchet (void floating promises),
coverage ratchet (every NEW file needs a test executing it), route-manifest
count seal (bump with dated comment), file-size ratchet (sales-invoices.ts
etc. may only shrink — split into libs like `si-payment-row.ts`). fakeSb now
supports `range/gte/lte`. Run the FULL suites before pushing, not targeted
ones.
