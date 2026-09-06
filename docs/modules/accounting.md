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
| Purchase invoice posted | Dr each group's purchase account (601-x/602 by scm.acc_item_group_accounts; unbound group REFUSES) / Cr AP | `PI` | `PI_REVERSAL` |
| AP invoice posted (non-stock supplier bill) | Dr each line's own account / Cr AP control (400 or 405 by the supplier's code) | `API` | `API_REVERSAL` |
| Payment voucher posted | Dr expense legs / Cr bank-or-AP header; a supplier payment's Dr leg on the AP control carries the supplier as party (since 2026-09-06) | `PV` | `PV_REVERSAL` |
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

**The bridge is per router (docs/bugs/0648, 2026-09-06).** `scm/index.ts`
mounts no global `supabaseAuth`; every finance router —
`backend/src/scm/routes/accounting.ts`, `backend/src/scm/routes/payment-vouchers.ts`,
`backend/src/scm/routes/receipts.ts`, `backend/src/scm/routes/other-debtors.ts`,
`backend/src/scm/routes/ap-invoices.ts` — declares `router.use('*', supabaseAuth)`
itself, because that middleware is what stashes the real caller as
`houzsUser` (the only source `hasHouzsPerm` reads) and hands out
`c.get('supabase')`. Three of them shipped without the line and answered
500 / 403 in production while every test passed (the harnesses set both by
hand); `backend/tests/scmRouterBridge.test.ts` now parses the mounts in
`scm/index.ts` and refuses a router without it (a by-design skip must carry
a reason). A route harness that mounts a router sets `user` to the pinned
system-staff id (`SCM_SYSTEM_STAFF_ID`), the bridge's own "already
translated" mark, so it steps aside and the hand-set client stays in force.

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

**AP Invoices — the non-stock supplier bill (2026-09-06).** AutoCount's A/P
Invoice, the owner's ask verbatim: 可以不可以像 autocount 这样 purchase invoice
一边,然后再多一个 AP invoice,这样我就可以把 other creditor 的 invoice 放过去,
也不会影响 operation 那边的 purchase invoice — and, confirmed: 我想要两个都看到,
现有的 purchase invoice remain. `scm.ap_invoices` + `scm.ap_invoice_lines`
(`backend/src/db/migrations-pg/20260906T1500_ap_invoices.sql`), numbered
`{co}API-YYMM-NNN` (a new series, his prefix), MYR only in this first cut.
Routes `/scm/ap-invoices` (`backend/src/scm/routes/ap-invoices.ts`, PV key
family, finance area; settle twin `backend/src/scm/lib/ap-invoice-settlement.ts`):
`GET /` lists BOTH kinds —
the operational purchase invoices as a read-only mirror (`kind: 'PI'`,
POSTED / PARTIALLY_PAID / PAID / ON_HOLD) beside the AP invoices raised here
(`kind: 'API'`) — `POST /` raises a DRAFT (1–50 lines, each a leaf
non-control account: 父户不记账 / 由模块过账), `PATCH /:id` edits a draft,
`POST /:id/post` books through the gate (rule `apInvoiceLines`: Dr each
line's own account / Cr the supplier's AP control, 400 or 405 by the
supplier's code, source `API`, dated by the invoice; a second post echoes),
`POST /:id/cancel` writes the contra (`API_REVERSAL`) and refuses a bill with
money on it (`has_payments`). It is PAID by the same AP Payment that pays
purchase invoices: `pv_allocations` names a PI **or** an AP invoice
(`ap_invoice_id`, CHECK exactly one), the post settles it through
`scm.settle_api_paid_sen` — the twin of `settle_pi_paid_sen`, same clamp
(lib/ap-invoice-settlement.ts) — and cancel unwinds exactly what was
applied; `v_ap_aging` is a UNION of both with a trailing `kind`. The five
journals file it under PURCHASE. Pinned by tests/apInvoices.test.ts.
Screens: **/scm/ap-invoices** (`frontend/src/pages/scm-v2/ApInvoices.tsx`,
Finance menu "AP Invoices") — one table with a Kind column, purchase
invoices linking to their own page, AP invoices opening a detail card with
Post / Cancel, and a New-AP-invoice card whose lines pick only leaf
non-control accounts; the **New AP Payment** picker lists a supplier's
open AP invoices beside its purchase invoices (an `AP` tag on the row) and
sends `apInvoiceId` for those; the AP Aging tab shows the kind. Pinned by
ApInvoices.test.tsx + PaymentVoucherNew.test.tsx.

**The AP invoice's paper — files, OCR, the bundle (2026-09-06; owner, told
the first cut had neither: 做,附件也一起做,bundle 也带上).** The supplier's bill
LIVES with the AP invoice as the scanned bill lives with its voucher:
`scm.acc_ap_invoice_files` (`backend/src/db/migrations-pg/20260906T2100_acc_ap_invoice_files.sql`,
the shape of `acc_pv_files`, FK `ON DELETE CASCADE`), bytes in the SLIPS R2
bucket under `ap-invoice-files/<company>/<invoice>/<uuid>.<ext>`, routes
`/ap-invoices/:id/files` (`backend/src/scm/routes/ap-invoice-files.ts`,
mounted before `/:id`). The four handlers come from ONE factory,
`backend/src/scm/lib/doc-files.ts` — the MIME allowlist, the 20 MB cap, the
key layout and the upload/list/stream/delete bodies — fed two specs: the AP
invoice's and the PV's (`backend/src/scm/routes/pv-files.ts` keeps only its
spec and the print bundle). The AP spec's rules: upload takes the create
keys; a CANCELLED bill takes no more files (409 `invoice_cancelled`); delete
is refused once POSTED (409 `evidence_locked` — no check layer, so the ledger
is the lock; a posted bill still takes a late scan). **The bundle**: `POST
/payment-vouchers/print-bundle` appends, after each voucher's own files, the
files of every AP invoice that voucher pays (`pv_allocations.ap_invoice_id`,
allocation order, `loadDocAttachments` labelling each under its invoice
number so a notice page says whose); purchase-invoice allocations add
nothing. **OCR**: the New card's **Scan bill** posts to the shared `POST
/payment-vouchers/extract` (`backend/src/acc/bill-extract.ts`) and pre-fills
the supplier (the server's match), the supplier's invoice number, both dates
and the lines — the account from vendor memory only, never a model guess —
and a create now TEACHES memory (`learnVendorMemory` with source
`AP_INVOICE`: supplier name → the first line's account, purpose
SUPPLIER_PAYMENT; the skip that keeps AP *payments* from teaching stays for
vouchers). The read pages attach after save, scan order. Screens: the New
card and a Files card on the detail — `frontend/src/vendor/scm/components/DocFilesCard.tsx`,
the one card the PV detail's `PvFilesCard` and the AP page's
`ApInvoiceFilesCard` both bind (hooks in
`frontend/src/vendor/scm/lib/ap-invoice-queries.ts`; the authed byte reader
`fetchDocFileBlobUrl` in `payment-voucher-queries.ts` takes the path).
Pinned by `backend/tests/apInvoiceFiles.test.ts` (upload/list/stream/delete
on the fake R2 binding + the bundle carrying a paid bill's files after the
voucher page), tests/apInvoices.test.ts (a save teaches memory) and
ApInvoices.test.tsx (scan pre-fill + attach after save; the Files card's
draft/posted rules).

**Round 2 (owner, the same evening, screenshots in hand).** The supplier box
wears the form's `fieldInput` dress (it was a borderless strip he could not
tell was a field: supplier 筛选无法按下选择), the lines are a table in HIS
order — account number, description, amount — with a remove button, the
bill carries an overall **Description** (the `notes` column, returned as
`description` on the list rows of BOTH kinds and shown on the list, the
detail and the listing), the list filters by supplier (the suppliers ON the
list, not the registry, so every choice shows something), and **Print
listing** (`frontend/src/vendor/scm/lib/ap-invoice-listing-pdf.ts`:
`apListingTable` pure, `generateApListingPdf` on the shared letterhead,
landscape A4, the three money columns totalled in the foot) prints exactly
the rows on screen after the kind and supplier filters — paper and screen
never disagree. Reads (`GET /`, `GET /:id`) ride the finance area guard like
the receipts and other-debtors lists; the PV keys gate the writes. Pinned by
`ap-invoice-listing-pdf.test.ts` (cells, totals, title, preview exit) and
ApInvoices.test.tsx (filter + print what is shown, line order + remove, the
description on list and detail).

**Round 3 (owner, the same night; each ask checked on the live page first).**
A bill OPENS OVER the list in `frontend/src/vendor/scm/components/Modal.tsx`
(点开时他是跑上去 — the detail used to be a card pushed in above the list) with
Edit · Copy · Post · Cancel bill and its Files card; the one form behind New,
Edit and Copy is `frontend/src/pages/scm-v2/ApInvoiceForm.tsx` (Insert adds
a line and lands on its account picker, Enter on an amount moves down; the
amount is the shared `MoneyInput`; the scan sits on New and Copy). **Every
field can be edited** (edit 这个不能全部都设成可以改吗): `PATCH /:id` takes a
DRAFT as before and RE-POSTS a posted bill — the old journal gets its contra
dated as the old bill was, a fresh entry books the bill as saved, one active
entry stands — with three guards: money already paid caps the new total
(`total_below_paid`), a bill with money on it keeps its supplier
(`supplier_locked`), a cancelled bill refuses. **Copy** raises a new bill from
the old one's supplier, description and lines (no supplier number, today's
date). Three shared components moved for this round and for every page
that uses them: `frontend/src/vendor/scm/components/SearchCombo.tsx` scrolls
the highlighted option into view as ↓ moves and opens ON the first option;
`frontend/src/vendor/scm/components/DateField.tsx` selects a pre-filled date
on focus and masks typed digits (31032026 → 31/03/2026, `maskDmy`);
`frontend/src/vendor/scm/components/MoneyInput.tsx` rests as 1,800.00
(`fmtMoneyAtRest`) and edits plain. Pinned by `backend/tests/apInvoiceEdit.test.ts`,
ApInvoices.test.tsx (pop-out, Edit, Copy, Insert / Enter, amounts),
`SearchCombo.keys.test.tsx`, `DateField.mask.test.tsx`, `MoneyInput.test.tsx`.

**The AutoCount sections (2026-09-06).** Every account carries a `section`
(`scm.accounts.section`, migration 20260906T0900) — the top node the
accountant's chart hangs it under: CAPITAL, RETAINED EARNING, FIXED ASSETS,
OTHER ASSETS, CURRENT ASSETS, CURRENT / LONG TERM / OTHER LIABILITIES,
SALES, SALES ADJUSTMENTS, COST OF GOODS SOLD, OTHER INCOMES, EXTRA-ORDINARY
INCOME, EXPENSES, TAXATION, APPROPRIATION A/C. The section DECIDES the
five-way `account_type` (CAPITAL is EQUITY), never the reverse. One home:
`backend/src/scm/lib/account-sections.ts` — the ordered vocabulary, the
seed rule (`defaultSectionFor`, the code ranges the migration ran once over
his 397 codes) and the section→type map; `GET /accounting/chart` and `GET
/accounting/accounts` hand the list down, so the chart page's header rows,
its Section pickers, the xlsx import (the heading now travels with the row)
and the Item Groups picker all read the server's list and carry no copy.
The owner's rule (你先帮我分类,然后我自己还能调动 — 用拖拉式): the chart page
renders one header row per section, foldable, and dropping a header-level
account on one re-shelves it — `PUT /accounting/chart/update {section}`
sets the section AND the type it decides on the account and its whole
subtree, in every company carrying the code; a CHILD refuses with its
header named (子户跟着 header 走, `section_child`), and a parent in another
section refuses at create (`section_mismatch`). Statements read the section
(next PR); the migration's CASE mirrors `defaultSectionFor` — change one,
change both. Pinned by tests/accountingChart.test.ts §sections +
ChartOfAccounts.test.tsx.

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
AccountSelect simply not offering a header with children. One-off chart
repairs travel as repair workflows beside the seed (plan/apply + CONFIRM):
.github/workflows/reparent-900-expenses.yml +
backend/scripts/reparent-900-expenses.mjs hung the flat AutoCount 900-x
expense roots under 900-0000 (owner 2026-09-04: 批量挂, 全部挂到 900-0000
下), replicating chartUpdateHandler's reparent guards. The income split
(owner 2026-09-04: 就做一个 header 分类就好, 不要放 code — 4xx reads as
liability; other income 挂在 700-0000; 530，592都挂other income; 别乱分类)
is ONE header and zero new codes: .github/workflows/reparent-other-income.yml
+ backend/scripts/reparent-other-income.mjs hang the owner's ENUMERATED
other-income roots (530/540/550/560/570/580/590/591/592/598/599-series)
under 700-0000; trading revenue (500/501/502/509/510/520) is deliberately
untouched — "not under 700-0000" IS the definition of 生意 income. The
Chart page DERIVES the badge from the tree (INCOME · Other for the 700-0000
subtree, one source of truth, never a stored flag), and the Add form says
where the choice lives when Type = INCOME. 700-0000 therefore LEFT the
deletable-legacy list.

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

**Other Debtors (2026-09-03, the owner confirming the design line by line:
other debtor 主要就是我会开 bill 其他和生意性质没有关系的人或公司收回钱)**:
a counterparty REGISTRY plus two documents, at /scm/other-debtors
(handlers in `other-debtors.ts`; the mount sits beside the PV router in
`backend/src/scm/index.ts` under the finance area guard, mirrored in
`backend/src/scm/lib/scm-areas.ts`'s SCM_AREA_MOUNTS table, and the nav
entry joins Finance in `frontend/src/components/Sidebar.tsx`; permission
keys are the PV family's on purpose — the same people raise, prepare,
check and approve money documents). 资料 lives in
the registry, never as chart sub-accounts: the GL keeps ONE control,
305-0000, as role AR_OTHER (default in acc/rules.ts, CONTROL_ROLES member,
so manual journals refuse it and the self-check runs a fourth scan-only arm
on it — family ODB/ODR). A **Debtor Bill** posts DIRECTLY on create (his
call: bill 直接过账): Dr AR_OTHER / Cr each line's own account (明细行自由
选户口 — every credit line walks `requireLeafAccount`, so headers and
control accounts refuse), source ODB, minted `<prefix>ODB-yymm-nnn`, and
the create is atomic — a failed journal takes the bill back out with it.
Cancel reverses the journal (ODB_REVERSAL) and refuses once any money was
received. A **Receipt** walks the PV's four layers verbatim (Draft →
Prepared → Checked → Approved, reject 一律退回 Draft clearing every mark,
withdraw only before checked, approve stamps once and a resume never
rewrites it): approve posts Dr bank / Cr AR_OTHER (source ODR) and knocks
the ticked bills off AP-Payment-style — tick pays in full, type for
partial, over-allocation refuses at raise time and the approve clamps at
each bill's live outstanding (a concurrent receipt may have landed first);
a fully-knocked bill flips PAID. Receipts reach Daily Bank for free: the
posted ODR debits a money account and Daily Bank reads the GL — display
polish deferred at the owner's word (具体要显示什么到时再决定).
Contracts: `backend/tests/otherDebtors.test.ts` (the route contract with
the REAL engine posting into the harness), `OtherDebtors.test.tsx`
(registry, bill lines, tick-full/type-partial, the four-layer buttons).
Tables land in migration 0350.

**Receipts (2026-09-03, later the same day: 未来如果我收到其他的钱不是
under other debtor 的呢? 就我只想开 receipt 罢了)**: /scm/receipts is the
unified money-in list — one month-windowed table holding GENERAL receipts
(raised here), the Other Debtor receipts (read-only mirrors, four-layered
on their own page) and the customer sales payments (read-only mirrors —
顾客的钱 keeps the sales flow it always had; nothing is re-entered).
Handlers in `receipts.ts` (mounted beside other-debtors in
`backend/src/scm/index.ts`, mirrored in `scm-areas.ts`, nav entry in
`Sidebar.tsx`, route in `frontend/src/routing/routeManifest.ts`; PV key
family). A GENERAL receipt is the no-registry case:
payer typed free, a money landing account (guarded), lines that free-pick
their credit accounts through `requireLeafAccount` — and it POSTS DIRECTLY
on create (his call: 不需要走四层，就录入就好), source RCT
(`<prefix>OR-yymm`), create-and-journal atomic. The only undo is VOID
(错就 delete 或 void): RCT_REVERSAL plus status CANCELLED — a posted
document leaves the ledger by reversal, never by vanishing. Tables in
migration 0351. Contracts: `backend/tests/receipts.test.ts` (post shape,
control/money refusals, void semantics, the three-kind month list),
`Receipts.test.tsx` (kinds + links + raise payload + void gating).

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
in, which is exactly the two-doors drift the owner called out. Its
read-only tree got legible the same day (the owner, that table in hand:
父子account不是很明显): headers render BOLD with a `header` tag like the
union page's, children step in behind a └ glyph, parents column muted.
The union page itself learned the same lesson on 2026-09-04 (owner, with
78 accounts now under 900-0000: 父子account 不清楚): the NAME column
indents per level too (the old indent was code-column-only and a
has-parent boolean, so grandchildren sat flush), children wear └, and the
depth walk shares isHidden's 6-level cap.
Since 2026-09-04 (owner, three rounds: 按 edit 时要跑回上去 / 往下滑时看不
到 header / 不好看…做成一个 pop out) the union LIST scrolls inside its card
(`frontend/src/pages/scm-v2/ChartOfAccounts.tsx` cardBody: maxHeight +
overflowY, padding 0 so the stuck header sits FLUSH — no strip of scrolled
rows above it) and the header row sticks inside that scroll (th sticky,
solid background, `borderCollapse: separate` — Chromium mis-offsets sticky
th under collapsed borders; `.card{overflow:hidden}` would swallow a
page-scroll sticky anyway). **✎ Edit is a pop-out dialog** in the
ConfirmDialog family style — it appears wherever you are, the list never
moves, and the backdrop deliberately does NOT close it (a stray click must
not eat a half-typed rename; Cancel is the way out). A ⚡ **Quick mode**
toggle (owner, mid tidy-up: 就 for 先阶段…过后这个 function 还是要有;
默认都是要弹的) lives in the page header — session-only, OFF on every
visit, so the confirms come back by themselves. ON: a LEAF untick and a
delete run without a dialog (the server's 11-probe delete guard is the
net); a HEADER untick still asks — it sweeps the children and re-ticking
the header does not bring them back. Pinned in
`ChartOfAccounts.test.tsx`. Detail
accounts for other debtors/creditors are children under the 305-0000 /
405-0000 controls, one per counterparty, opened through this same door.
The Add form also speaks the vocabulary (the owner, SFA/SAD pairs in hand:
create new fixed assets 时照理就需要 create depreciation account; special
account add account 如何选?): a Special-type select carries the export's
twelve codes (SBK/SCH force the money flag — the import's equivalence,
live on the form; the control trio labelled 由模块过账), and picking SFA
offers the SAD twin pre-derived by his own chart's convention — the
asset's code with the last digit +5, named `ACCUM. DEPRN. - <asset>` —
created in the SAME call, same parent, same companies, or refused whole
(`bad_depreciation` off an SFA-less twin; a taken twin code 409s before
anything lands). Contract: the SFA/SBK blocks of
`backend/tests/accountingChart.test.ts` and `ChartOfAccounts.test.tsx`.
**And the tree re-arranges by hand (2026-09-03: 我希望可以拖动式 put
account under 别的 account 前提是那个 account 没有 transaction)**: drag a
row onto another on the Chart page (or set Under in the ✎ panel; 留空 =
root) and `PUT /chart/update` carries `parentCode` — the moved account
keeps its own GL untouched (lines hang on its code; the tree is
presentation), while the rule sits on the TARGET: 父户不记账, so a target
with postings or any reference refuses `parent_has_postings` (a target
already serving as a header passes as-is); parents share the child's type,
cycles refuse, and the new header is instantiated into every company the
child lives in. Contract: the parentCode block of
`backend/tests/accountingChart.test.ts` and the drag/edit-panel tests of
`ChartOfAccounts.test.tsx`.

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

**Which payments are candidates (2026-09-04, the owner's first real uploads
made the gap loud: four MBB lines all UNMATCHED while their sales sat in the
ERP).** `couldBeAcquirers` in acc/settlement.ts is the one rule: a card payment
(merchant / installment) tagged with THIS acquirer, a card payment tagged with
nothing, or an `imported` payment tagged with nothing — migration-era rows all
look like that, and the payout still lands in this system's bank, so the
statement must be able to find them. A payment tagged with a DIFFERENT acquirer
is never offered (someone else's stream), and cash/transfer never settle
through one. An untagged candidate reaches the screen marked 未标 merchant — a
question, not an answer: the matcher still auto-takes only on a unique
reference. Confirming STAMPS the tag onto the payment row (NULL only, never
over a tag chosen at the till), so the next statement finds it named. Note the
phase-2A posting rule is unchanged: `imported` rows still never book — being a
candidate is about RECONCILING the payout, not re-posting the sale.

**Item groups — the product-group ↔ account registry (GL redesign item 1,
2026-09-05).** The ledger is moving to the AutoCount periodic shape (owner:
ledger 只根据 invoice 认,Dr purchase / Cr supplier;月结抓 stock value), and
the first brick is WHICH purchase/sales account a document line belongs to.
`scm.acc_item_groups` (migration 20260905T0900) registers every product
category label — the nine the `mfg_product_category` enums hold are seeded —
and `scm.acc_item_group_accounts` binds each group, per company, to four
accounts: Purchase, Sales, Sales Return, Purchase Return. A group with no
binding row is UNBOUND and the posting rules refuse it by name (owner: 挡下来
提醒我去绑,不要静默丢进 OTHERS). New groups are born only through
`scm.acc_register_item_group` (SECURITY DEFINER) which extends BOTH enums and
registers the row in one call — so the taxonomy and the registry cannot drift
— and the API forces the four bindings at create (born bound). Discounts stay
company-level (520-0000 / 610-0001), never per-group. Maintenance UI: the
**Item Groups** tab on /scm/accounting — unbound groups arrive pre-filled with
the SUGGESTED defaults marked 建议·unsaved, and nothing writes until the owner
presses Save (his sign-off, row by row). The account pickers offer only the
slot's own ledger side (purchase slots EXPENSE, sales slots INCOME) under
AutoCount-style section headers — Cost of goods sold / Expenses, Sales /
Sales adjustments / Other incomes, the same 6xx boundary the standard P&L
reads (owner 2026-09-05: 不能这样做一个header 分类吗). Routes in
backend/src/scm/routes/accounting-item-groups.ts (guard: the GL permission),
pinned by tests/itemGroups.test.ts + ItemGroups.test.tsx.

**PI posts the periodic way (GL redesign item 2, 2026-09-05).**
`postPiAccounting` reads the invoice's LINES, folds each line's `item_group`
(lower-case from the sales panels) up to the registry's code, sums per group
in the invoice's own currency, converts per group (the rounding remainder —
a sen or two, foreign invoices only — lands on the largest group so the
debits sum EXACTLY to the header's MYR), and debits each group's
`purchase_account` from `scm.acc_item_group_accounts`; the credit stays on
the supplier's AP control (400/405 by apControlRole). An invoice with an
UNBOUND group refuses with the group named (400 at the manual endpoint;
best-effort at confirm, with the entity-audit note as the trail) — never
silently into a default account. 330-0000 is no longer touched by documents;
stock value reaches the GL as the month-end adjustment (item 4). Entries
posted before this change carry Dr 330-0000 and are re-shaped by the item-3
backfill (reversal + re-post under the new rule). Pinned by
tests/piPeriodicPosting.test.ts and the re-shaped apSplit.test.ts.

**The one-shot PI ledger repair (GL redesign item 3).**
`POST /accounting/backfill/pi-periodic` brings every posted PI of the active
company into the periodic shape: an invoice with NO journal (the 33 the
pre-hook era left, docs/bugs/0640) is posted; one with an active Dr-330
journal is REVERSED (a contra pair, never a delete) and re-posted under the
item-2 rule; one already periodic is left alone. Nothing is re-implemented —
each invoice walks through reversePiAccounting + postPiAccounting, so the
entry is dated by the INVOICE (money lands back in its own month), engine
idempotency holds, and an unbound group fails THAT invoice by name instead of
dying. `?dryRun=1` lists the plan without writing; the write pass batches
(limit ≤ 25 per call, `remaining` in the response) and re-running is a no-op.
A reshape's contra carries the ORIGINAL journal's date (not the run day —
docs/bugs/0647: the first live run dated 19 contras in September and left
July/August's 330 and AP over-stated), so the invoice's month cancels within
itself; `reversePiAccounting` takes that date as an option and keeps
today's for a real cancel. Handler in accounting-pi-backfill.ts; pinned by
tests/piPeriodicBackfill.test.ts.
The owner presses it himself: the **PI backfill card** at the foot of the Item
Groups tab (PiBackfill.tsx) runs Dry run first — 执行写入 stays disabled until
a preview exists — then loops the batch until `remaining` is 0, stopping the
moment a pass completes nothing so unbound-group failures list themselves
instead of spinning. Per active company: 2990 and HOUZS are two visits.

**Month-end stock close (GL redesign item 4).** Stock value reaches the GL
once a month, from the live engine (owner: 可以不可以抓实时的): every night at
00:05 MYT the cron sweeps the two most recent closed months per company —
on the 1st that POSTS the pair for the month that just ended
(`STOCKADJ-{co}-{YYYY-MM}` Dr 330-0000 / Cr 620-0000 dated the last day, and
`STOCKADJ-REV-…` the mirror dated the 1st of the next month, both active, so
the month-end TB carries the stock and every month's P&L reads purchases +
opening − closing), and on every other night it is the cheap re-check that
heals a late-keyed document by REVERSING the old pair and re-posting — never
an edit. The replay runs on `inventory_movements.movement_date`, the BUSINESS
date (migration 20260905T1200 backfilled it: GRN rows from grns.received_at,
DO rows from dispatch, the rest from their keyed time; writeMovements now
stamps every new row, GRN passing its received date) — so 迟进的 GRN lands in
its own month, the owner's first question about the design. Every run —
including the quiet 'unchanged' — writes `scm.acc_stock_close_runs`, shown on
the **Month-end** tab of /scm/accounting along with the live value and a
manual Run. acc/stock-close.ts (engine-gated), route
accounting-stock-close.ts, cron branch `5 16 * * *` in index.ts; pinned by
acc/stock-close.test.ts. Month-close LOCKING is deliberately later — the
owner signs that design off separately.

**The standard statements (GL redesign item 6).** P&L and Balance Sheet tabs
on /scm/accounting, standard layout first (the owner iterates the 样板 later
— his call; the NUMBERS ship now). One source — `v_gl_entries`, posted and
not reversed — so they can never argue with the Journal/GL/TB tabs beside
them. Both CLASSIFY BY SECTION (2026-09-06 — the AutoCount tree stored on
`scm.accounts.section`, so an account the owner drags on the chart page
moves in the statements too, the way AutoCount's do; one home
`lib/account-sections.ts`, a row with no section takes its type's default
shelf by the same rule the migration seeded with). The P&L follows his
AutoCount arithmetic under the periodic scheme: trading income = SALES +
SALES ADJUSTMENTS, cost of sales = COST OF GOODS SOLD with the month-close
620 pair included (gross profit therefore reads purchases + opening −
closing with no stock arithmetic in the report itself), other income =
OTHER INCOMES + EXTRA-ORDINARY INCOME, expenses = EXPENSES, then TAXATION
under a profit-before-tax line (shown only when something posted there —
the layout otherwise stays as he left it); the balance sheet cuts the same
read at a date, groups by the section's type with every line naming its
section in AutoCount order, shows cumulative earnings inside equity, and
carries its own self-check line — assets − liabilities − equity − earnings
prints BALANCED at zero or the difference in red, never absorbed. Handlers
in accounting-reports.ts
(`GET /accounting/reports/pnl?from&to`, `/reports/balance-sheet?asOf`), UI in
Reports.tsx; pinned by tests/accountingReports.test.ts + Reports.test.tsx.

**A half-failed upload cannot hold its file hostage.** The upload writes the
batch head first and its lines after; a failure between the two used to leave
a batch with no lines still owning the file hash, so the SAME file was refused
as "already uploaded" for ever (the owner's PBB statement of 2026-08-01 sat
exactly like this). Now every failure after the head is written takes the head
back out, and `clearOrphanBatch` clears any such wreck at the next upload of
its file — a batch WITH lines keeps the duplicate refusal, because that one
really was uploaded.

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

**Voucher numbering (GL redesign item 8a).** `GET/PUT /accounting/numbering`
(handlers in accounting-numbering.ts, GL permission) — the owner's own levers:
one prefix letter per money account (`scm.acc_bank_letters`, UNIQUE per
company+letter — two banks on one letter would share a number series) and the
suffix width (`scm.acc_numbering`, 3-5). Maintained on the Voucher numbering
card of /scm/settlement-setup; full detail in
docs/modules/payment-voucher.md §12. The OR channels (item 9) and transfers
(item 10) read the same letter table. The cash drawer (`roles.CASH`) is the
one FIXED series — C on both papers, CPV / COR — reported `fixedCash` by the
GET, rendered read-only, refused by the PUT in both directions.

**The five journals (GL redesign item 7).** Every entry is labelled the
AutoCount way — SALES / PURCHASE / BANK / CASH / GENERAL — derived, never
stored: `classifyJournal` (acc/journal-class.ts) maps the source type
(reversals ride their originals), and the money-side documents
(SOPAY/SIPAY/PV) split CASH vs BANK by which money account their lines
actually touch, via the company's CASH role. `GET /accounting/journal-entries`
stamps `journal_class` per row and filters on `?journal=`; the JE tab carries
the five chips and a Journal column. The manual JV is simply the GENERAL
journal — the owner's own vocabulary, unchanged. Pinned by
tests/journalClasses.test.ts.

**Official Receipts (GL redesign item 9).** Every customer payment births a
receipt (`scm.acc_receipts`, one per payment forever — a reprint reprints,
never re-issues): DRAFT on the `{co}DraftOR-YYMM` series at recording, FORMAL
the moment the money is CONFIRMED — cash immediately on `{co}COR-YYMM`
(钱当场在手), card when merchant reconciliation confirms that payment (the
settlement hook formalises on the acquirer's payout bank, best-effort so a
missing letter leaves the OR in draft for the manual button and never unwinds
a settlement), transfer by the manual confirm — which any human can also use
after verifying a slip (客户催收据). Channel letters are the PV letter table
(`scm.acc_bank_letters`; **C reserved for cash**, the numbering PUT refuses
it for banks) so a bank is one letter on voucher and receipt alike; formal
order per channel = the order money was confirmed, and a slow recon never
scrambles the cash run. No approvals (his call). Born inside the payment
writers (so-payment-row.ts hook, the SI payment route) with
`ensureReceiptForPayment` healing history and unhooked paths on demand.
Surface: `GET /accounting/receipts`, `POST /accounting/receipts/ensure`
(returns the WHOLE row — the print button's one round trip),
`POST /accounting/receipts/:id/formalise` (accounting-receipts.ts). Pinned by
tests/officialReceipts.test.ts.

**Printing the OR (item 9b).** The pdf (frontend receipt-pdf.ts, A5
landscape) carries amount-in-words and a diagonal DRAFT watermark until the
money confirms — the salesperson can hand paper over the moment the payment
is keyed, and nobody mistakes it for the confirmed copy. Three doors: the
`/scm/official-receipts` book page (status chips, Print, Confirm money —
distinct from `/scm/receipts`, the money-in LIST), and a printer button on
every persisted payment row in the shared PaymentsTable (SO detail SAVED
mode; SI detail passes `receiptFor.persistedIds` since its rows ride DRAFT
mode) — ensure-then-print, so payments recorded before the module existed
heal their OR on first print.
