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

**The numbering step reaches ACROSS SCHEMAS, and that is the one thing to know
before touching it.** `jePrefixForCompany` (`scm/lib/doc-no.ts`) resolves the
per-company prefix from the company's CODE — HOUZS mints bare, every other
company takes `<CODE>-` — and the companies master is **`public.companies`**,
while the SCM client is pinned to `scm` (`db/supabase.ts:77`). The read must
therefore say `sb.schema('public')` explicitly. It is the only
`from('companies')` in the backend; every other reader goes through raw SQL
(`middleware/companyContext.ts:120`), so there is no sibling call to disagree
with a mistake here.

It **fails closed** — minting under the wrong company's prefix would collide two
ledgers' running numbers — but `postJournal` CONTAINS that failure as
`je_prefix_failed` rather than letting it escape. Between 2026-08-18 and
2026-08-23 it escaped, and no journal entry was written in either company for
five days while the documents themselves posted normally: see
`docs/bugs/0522`.

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
`GET /accounts` also carries `acc_money`, so pickers can offer only the
money set. **The roles window (2026-08-30)**: `GET /roles` answers the
resolved role→account map for the active company (overrides first, seeded
defaults where nothing is set, plus which are overridden); `PUT
/roles/BANK_DEFAULT` repoints the default bank — money accounts only,
active only, this company's chart only, GL-post permission — the owner's
own lever (默认银行我可以自己maintenance), surfaced as the Default bank card
on /scm/settlement-setup and pre-filling every voucher's Paid From
(docs/modules/payment-voucher.md §0c). Contract:
`backend/src/scm/routes/accountRoles.test.ts`.

**The chart maintenance surface (2026-09-03, roadmap A)**: `GET
/accounting/chart` unions every GRANTED company's accounts into one row per
code (definition led by the lowest company id, per-company active map;
grants fail closed), `PUT /accounting/chart/tick` turns one code on/off for
one company — ON instantiates the row from the master definition with its
parent riding along (the tree stays whole), OFF cascades down the children
(the owner's rule; the confirm lives in the UI) — and `POST
/accounting/chart/import` upserts the accountant's parsed rows into the
target company and copies rows marked `shared` to every other granted
company, parents included. The owner's design verbatim: 可能类似recon setup
我tick 后选择这个公司要不要用 — a future company is a new tick column.
All three behind the same GL-post key as the rest of the chart surface;
handlers in `accounting-chart.ts`, contract
`backend/tests/accountingChart.test.ts`. The page (/scm/chart-of-accounts,
Finance menu) parses the AutoCount xlsx IN THE BROWSER — digit and letter
code series, 4-space indent → parent, section headings → account_type,
Special Acc Type SBK/SCH → acc_money, banks / related-party loans /
directors / HP+borrowings pre-classified company-specific — so the file
never enters the repo. 父户不记账 is enforced three-deep: the GL gate
(engine rule 3), `requireLeafAccount` at PV create/patch (typing time), and
AccountSelect simply not offering a header with children.

**Chart management arms (2026-09-03, the owner's six-point review)**:
`accounts.special_type` stores the AutoCount special column verbatim
(migration 0347 backfills the export's 56; import/tick/seed carry it
forward). Three more doors, same GL-post key, handlers in
`accounting-chart.ts`: `PUT /accounting/chart/rename` is 改码全账跟 — one
call to `scm.acc_rename_account(old, new)` (0347) moves the code in every
company's accounts row, the children's parent_code and all nine reference
homes 0346 relayed, in ONE transaction, insert-move-delete so 0188's
composite FKs hold at every step; a collision refuses (renaming onto a live
code would merge two books) and nothing half-moves. `PUT
/accounting/chart/update` changes name/type/money for the code in EVERY
company at once — one definition per code, two books never disagree. And
`DELETE /accounting/chart/account` kills ONLY a never-used code (the
owner's rule: 零交易零引用的才可以真删) — eleven reference probes, one hit
anywhere and the 409 names the holdouts, with the tick column as the
offered path. CONTROL accounts (special SDC/SCC/SBS — AR, AP + deposits,
stock) are locked out of manual picks: `requireLeafAccount` refuses them
(由模块自动过账) and AccountSelect hides them. Contracts:
`backend/tests/accountingChart.test.ts` (handlers + lock),
`backend/tests-pg/accChartRename.pg.test.ts` (the rename function against a
real Postgres with the 0188 FKs verbatim). The page grows fold/expand
chevrons on headers, an edit panel (code/name/type) and per-row delete.

**The AP split (2026-09-03, the owner deciding with the blast radius on the
table: 会影响到现在运作的东西吗? → checked → 做)**: 405-x supplier codes are
AutoCount's OTHER CREDITORS, and their paper books to the AP_OTHER control
(role default 405-0000) instead of AP (400-0000). ONE home for the prefix —
`apControlRole` in acc/rules.ts — used by `piLines` (the bill's credit), by
the AP-payment create guard (`wrong_ap_control` refuses a voucher debiting
the other supplier-class's control, so an out-of-date client cannot
mis-book), and mirrored by the AP Payment page for display. AP_OTHER joins
CONTROL_ROLES (manual journals refuse it) and the self-check grows a third
arm — balance + foreign-line scan on 405-0000 only, because the
per-document drift walk is control-agnostic and the AP arm already reports
each PI once. History moved by migration 0349: exactly one journal
(2990-PI-2608-018, RM 16,440, the only 405-supplier bill that ever posted)
reclassed 400-0000 → 405-0000; its July sibling predates the GL foundation
and has no journal. The supplier LIST and every screen stay exactly as they
were — only the GL landing follows the code. Contracts:
`backend/src/acc/apSplit.test.ts`, `backend/tests/pvApControlGuard.test.ts`,
the AP_OTHER block of
`backend/src/scm/routes/apControlCheckUnpostedPi.test.ts`.

**One door to open an account (2026-09-03, the owner: 照理说应该维护
overall chart of account 罢了)**: `POST /accounting/chart/account` creates
the definition ONCE and lands it in every company the caller ticks (granted
only; the parent chain instantiates per company via the same master-def
walk as tick-ON, so no company ever receives a child without its header).
A code that exists anywhere refuses toward the tick column (turning it on
elsewhere is a tick, changing it is a rename). The Chart page carries the
"Add account" form (code / name / type / optional parent / money flag /
company ticks); the OLD Accounting tab's add-and-edit went read-only with a
link over — it used to create the row in whichever company the caller stood
in, which is exactly the two-doors drift the owner called out. Detail
accounts for other debtors/creditors are children under the 305-0000 /
405-0000 controls, one per counterparty, opened through this same door.

**The recognition-rules window (2026-09-02)**: `GET /bank/rules` (every rule,
off rows included), `POST /bank/rules`, `PATCH /bank/rules/:id` — the rules
that say "this credit is PBB's payout", seed-only since 0336, now the owner's
own screwdriver (the Bank recognition rules card on /scm/settlement-setup).
GLOBAL like the table — no company scoping to do. Every regex is compiled AT
WRITE TIME and refused with the engine's sentence (a broken pattern would
silently un-recognise an acquirer's money); date/merchant patterns must carry
a capture group; no DELETE — `is_active=false` is the off switch. Contract:
the rules block of `backend/tests/bankRoutes.test.ts`.

**Phase 1 (2026-08-16).** One AutoCount-style chart for every company
(migration 0297; company 2 template copied to company 1, ledger lines
remapped, roles repointed to 300-0000 / 310-0000 / 400-0000 / 500-0000,
legacy codes deactivated as alias records). MANUAL journals are blocked from
control accounts by the engine. The Accounting page carries seven tabs:
Chart of Accounts (add/rename/deactivate), Journal Entries (+ manual JV
form, post, reverse), General Ledger, Trial Balance (born with its own
zero-difference self-check tile), AR/AP Aging, and Self-check (layer 1).

**Phase 2A (2026-08-16).** Customer payments reach the ledger: acc/payments.ts posts each sales-panel payment row through the gate (Dr CASH / BANK_DEFAULT / acquirer transit by the panel 3-method model, Cr AR; source SOPAY/SIPAY keyed on the payment row uuid). scm.acc_acquirers is the 2.13 master (display_name = the exact merchant_provider strings; CIMB/GHL/HLB/MBB/PBB seeded; 决定4 config columns NULL until the owner fills them). imported-method rows and payments on migrated invoices never book - AutoCount carries that money. GET /acquirers lists the master; POST /backfill/customer-payments walks unposted rows batched + idempotent. The sales-side insert/delete HOOKS are NOT yet wired - listed for owner approval per brief 6.3/6.4.

**Phase 2B part 1 (2026-08-16): Daily Bank.** GET /accounting/daily-bank?date= answers the owner one question - today, where is the money and how much can actually move - live from the ledger (2.3: no caches): opening/in/out/closing per money account (scm.accounts.acc_money flag, migration 0299), settlement-in-transit balances per acquirer (visible, never counted movable), and — since phase 3 (2026-08-28, mig 0339) — pendingApprovalSen: every DRAFT payment voucher sitting in the approval queue, converted to MYR the way posting will, subtracted from available. Page /scm/daily-bank (Finance menu): date navigation + Get Image (canvas-drawn PNG to clipboard for WhatsApp, download fallback). Board arithmetic pinned in acc/daily-bank.test.ts. 946-0000 Cash Over/Short + OVER_SHORT role seeded for the coming daily cashup.

**Phase 3 (2026-08-28): PV approval — money leaves only after a yes.** The full write-up lives in docs/modules/payment-voucher.md §0b (marker columns per the 0324 lesson, the pure rule table in scm/lib/pv-approval.ts, the post gate, the scm.payment_voucher.approve key, the audit verbs). What belongs to THIS module: the Daily Bank board's available figure now answers "closing minus what is already asked for", which is the question the owner's phase-3 placeholder was holding a seat for.

**Phase 2B part 2 (2026-08-16): Daily close (layer 2).** GET/PUT /accounting/daily-close + POST /daily-close/confirm: each day each company counts the drawer against the system takings (both sales panels, bucketed cash / transfer / per-acquirer; imported rows never count). Confirming freezes the day (scm.acc_daily_closes, migration 0300) and posts the CASH over/short THAT DAY through the gate (946-0000, source CASHUP, idempotent per company+date); card/transfer differences are settlement timing owned by layer 3 - recorded, never posted here. UI: the Daily close view on the Daily Bank page. Confirmed buckets refuse edits - corrections are manual journals, on the record.

**Phase 2B part 3 (2026-08-16): acquirer settlement reconciliation (layer 3).**
The layer that empties `326-0000` (the EDC clearing code since mig 0346 —
the owner's AutoCount code relay, 2026-09-02: 迁到 AutoCount 码; the whole
relay map lives in that migration's header, and the two production
failures that shaped its defer-sandwich are docs/bugs/0614 + 0615). The acquirer master follows the owner's
"define once, all companies share" principle: `scm.acc_acquirer_config` is
GLOBAL (statement format, unique-ref flag, fee method, date tolerance, column
map — 决定4, taught once) and `scm.acc_company_acquirers` is the per-company
link (which bank/transit/fee accounts); migration 0332 splits them and leaves
`scm.acc_acquirers` behind as a VIEW of the same shape, so every phase-2A
reader is untouched. **The five layouts arrive TAUGHT** (migration 0338 seeds
HLB/MBB/GHL/PBB/AEON with the validated column maps — the owner, 2026-08-27:
为什么report setup 我还需要自己set; tests/acquirerLayoutSeed.test.mjs runs each
seeded layout against its committed fixture). The seed fills only rows still
untaught, so a layout corrected in the UI is never overwritten. What setup
still asks per company is ONLY the account links below.

**Which bank receives the money is PER COMPANY** (owner, 2026-08-18: 例如pbb，在
houzs 可能是maybank 收钱，但是在2990 是hong leong bank 收钱). That is exactly what
`acc_company_acquirers.bank_account_code` is for, and the screens now say so:
`GET /setup` returns `bankReady` per merchant plus the ACTIVE company's own money
accounts (`accounts.acc_money`), so the setup field is a CHOICE from this
company's bank accounts rather than a typed account code; `GET /batches/:id`
returns `receiving_bank` { code, name, configured } so the bank screen names the
account BEFORE the money is recorded. Unset still falls back to the company's
BANK_DEFAULT role — the books never stop — but the fallback is now stated on
screen in red instead of only in a server log.

Migration 0302 adds `acc_settlement_batches` (one upload,
UNIQUE on the file's content hash), `acc_settlement_rows` (the four screen
buckets MATCHED / NEEDS_CONFIRM / UNMATCHED / IGNORED) and
`acc_settlement_matches` (which payments a line covers — UNIQUE
`(payment_source, payment_id)`, so the database itself refuses to settle the
same money twice). `acc/settlement-parse.ts` reads a statement entirely from
config and REFUSES by name rather than parsing 0 rows (§2.14);
`acc/settlement-match.ts` auto-matches ONLY on a unique reference — an acquirer
without one (or one whose 决定4 is still blank) sends every line to a human, and
the date tolerance comes from the config row, not a literal. A reference that
matches NOTHING falls through to amount+date, because the owner cannot guarantee
the code was typed correctly (2026-08-18: 我没办法确定 authorised code salesperson
一定填对); when exactly ONE payment makes that amount in range — one payment, or
one exact-summing pair — it comes back as `suggested`, pre-ticked on screen with
the reason, for a human to confirm. Offered, never taken: two possible answers is
a question, so nothing is ticked and he chooses;
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

**And the way back out (2026-08-29, the owner's 上传了能cancel 掉? made the gap
loud): POST /settlement/rows/:id/unconfirm** — the door the ignore refusal has
always pointed at, now with a button behind it (an Undo beside every "done"
row on /scm/merchant-recon). It reverses the `SETTLE-<row id>` fee entry
(never deletes), releases the payment links so the money is claimable again,
and sends the row back to NEEDS_CONFIRM for a fresh decision — never silently
back to matched. REFUSED while the statement has recorded receipts: undo those
credits first (they have their own button). `unconfirmSettlementRow` in
acc/settlement.ts; contract in tests/settlementRoutes.test.ts.

**One statement, one or more credits** (owner, same day: 我实际收到的钱可能是多笔
的哦). Hong Leong pays a multi-day statement one credit per trading day, Maybank
credits each trading date separately, and Public Bank goes the other way — one
advice covering three days. So each credit is a row in
`scm.acc_settlement_receipts` (migration 0335) with its own date, amount and
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
check on top of the area guard.

**Two pages, named by the owner** (2026-08-17: 就不能分成 merchant
reconciliation, bank statement reconciliation 吗？) — because it is two jobs on
two days:

- `/scm/merchant-recon` — **Merchant reconciliation** (step 1 of 2): the
  MERCHANT statement against what the ERP recorded. It books fees; it never
  books the bank. Setup moved out to its own screen, so this one is the work.

  Uploading lands on WHAT THE UPLOAD FOUND, across every file at once (owner,
  2026-08-18: 当我上传完全部文件后…让我知道我 upload 的文件有哪里几笔是 match 的，
  有哪里几笔是我要 manual check 或 verify 的，有哪里几笔会是 merchant 收到但完全
  match 不上的) — three counts because they are three different jobs, a per-file
  breakdown, and one button that confirms every reference-matched line in the
  whole upload, report by report so a refusal names its own file.

  Then the work list, which shows ONLY what is not matched yet (owner: 应该就只会
  显示还没对上的 transaction 吧): the reports with lines still to decide, split by
  the kind of problem (`to_confirm_count` — matched by reference, one button;
  `to_choose_count` — a choice he can make; `no_record_count` — the report has it
  and no sale in the ERP does), and underneath, the card
  payments the sales team keyed in that no report has reported yet. A report
  whose lines are all decided leaves the screen, saying where it went. Opening
  one shows its open lines and nothing else; one checkbox brings the finished
  lines back. The four buckets still exist in the data and in the CSV export —
  the screen shows the work instead of a pile switcher.
- `/scm/bank-recon` — **Bank statement reconciliation** (step 2 of 2): the BANK
  statement against what the merchants owe. **GATED**: a report appears here
  only once every one of its lines is decided (owner: 核对完了没有问题才会显示去
  bank statement 的 reconciliation) — the ones not ready are counted and NAMED
  rather than silently missing, and the record-a-credit box is withheld from a
  report that goes back to undecided. Tabs: Money to come in (the reports still
  owed money, the credits banked against each, a date+amount box for the next
  one, undo), Still with the merchants (the in-transit detail — three states,
  each naming who keyed the payment in, each showing what is STILL owed after
  fees, statement charges and part-payments). This is the screen layer 4 will
  feed from the bank statement file.

- `/scm/settlement-setup` — **Reconciliation setup**: ONE maintenance TABLE,
  every company at once (owner, 2026-08-18: 我应该 overall maintenance table，左手
  边是 merchant、bank，上面 header 是公司，这个公司有就 tick). Merchants and banks
  are the ROWS, companies are the COLUMNS, and a tick in a cell means that
  company uses it; a ticked merchant cell also carries WHICH of that company's
  banks its money lands in. The shared half — how the report reads — sits on the
  row, outside every company column, because that is what it is. The read
  answers for every company the caller is granted; the two writes take the
  company as a PARAMETER and re-check it against those same grants
  (`allowedCompanyIds`)
  — a company id in a request body is an instruction, not an authorisation. A
  company nobody has set up shows every merchant unticked and creates its link
  row on the first tick, so a new company needs no migration. Unticking a bank a
  merchant still pays into is REFUSED by name. Nothing new is stored: the ticks
  are `acc_company_acquirers` (0301) and `accounts.is_active` on the company's
  money accounts — the chart is already maintained centrally (0297), which is the
  owner's own answer to where banks are defined ("chart of account 我也是会做成总
  维护不是？").

On both reconciliation screens, working a statement REPLACES the list rather than stacking under it —
the owner on the version that stacked: 就感觉很多东西挤在一页. Each page links to
the other where the work hands over. What they share is presentation only
(`settlement-ui.ts`); every rule stays on the server, so the two screens cannot
drift into two answers.

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

## Which company's masters a posting reads

`acc/masters-company.ts` is the ONE place that answers it, and the three lookups
call it: `checkAccounts` (the chart), `resolveRoles` (the account roles) and
`transitFor` (the acquirer map).

`accMastersCompanyId(companyId, where)` returns the entry's own company when it
has one, and falls back to the base company when it does not — **logging at
error level and naming the call site every time it substitutes.**

**The fallback is not a rule anyone chose. It is debt with an owner decision
attached.** Until 2026-09-02 the expression was written three times, inline and
silently, and `engine.ts` used `companyId == null` to mean two different things
inside one call: the WRITE path reads it as "stamp no company" (`:208`), the
LOOKUP path read it as "company 1". So an entry whose company could not be
resolved was validated against company 1's chart and then written with no
company at all — and looked exactly like one validated against its own books.

That contradicts the house rule for a write — `requireActiveCompanyId`
(`scm/lib/companyScope.ts:114`) is documented *"Never degrades, never
defaults"*. It was **not** changed to a refusal because null is reachable from
real rows, not only from a degraded request: `scm/routes/accounting.ts:295`,
`payment-vouchers.ts:694` and `:1409` all pass the DOCUMENT's own nullable
`company_id`. Refusing today would stop those documents posting.

The probe needed before flipping it, and the three options, are in
`docs/bugs/0615-the-accounting-masters-fell-back-to-company-1-in-silence.md`.
`backend/tests/accMastersOneHome.test.ts` fails the PR if any `acc/` module
re-implements the fallback inline.
