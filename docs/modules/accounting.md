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
| Untagged card money named by a settlement | Dr the merchant's own clearing / Cr generic clearing | `SETTLEMOVE` | `SETTLEMOVE_REVERSAL` |
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
a line and lands on its account picker, Enter on an amount moves down, F3 or
Ctrl+S is the save button once the form is ready — `useSaveHotkey`,
payment-voucher.md; the amount is the shared `MoneyInput`; the scan sits on
New and Copy).

**The bill pile for AP invoices (2026-09-08, owner: AP invoice 的 OCR 要优化像 PV
这样 … 我可能同时 upload 多张 supplier 给的 invoice, 所以要分出来一张一张).**
"📷 Scan bills" beside "+ New AP invoice" opens `/scm/ap-invoices/scan` — the
voucher's pile page (`frontend/src/pages/scm-v2/PaymentVoucherScan.tsx`,
`target="ap"`): drop or paste many files, one file = one bill, tick pages and
Merge for a bill photographed in pieces, read them in one call. The difference
from the voucher's pile is the last step: a bill IS an invoice with its own
number, so every bill opens as ITS OWN AP invoice ("Open as AP invoice"; a
same-supplier group is never offered as one). The hand-off lands on
`frontend/src/pages/scm-v2/ApInvoices.tsx` as `location.state.apPrefill`, the
pages riding the voucher's module stash (pv-file-handoff.ts); the list opens
its New form pre-filled through `formFromExtraction` — the one home the form's
own Scan bill fills through too (`ApInvoiceForm.tsx`, which also takes a bill
DROPPED on its scan row) — and attaches the pages on save. What the reader
fills goes UPPER CASE (`upperFill`, `frontend/src/vendor/scm/lib/ocr-fill.ts`;
owner: 帮我 fill data 时默认全部大写, typed text left alone: 打字不需要先).
Contracts: `ApInvoices.test.tsx` (the button, the hand-off, the drop, the
casing), `PaymentVoucherScan.test.tsx` (the AP pile), routeManifest 154.

**Every
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
on focus and masks typed digits (31032026 → 31/03/2026, `maskDmy`) — but only
while every `/` on screen is one the mask itself placed (`separatorsAreMaskOwn`);
a separator the operator typed is left alone and read by `parseDmy`, so
`7/9/2026` no longer collapses to `79/20/26`. On blur, text that does not parse
STAYS on screen with `aria-invalid` and a `role="alert"` message rather than
reverting in silence. **On a coarse pointer the field is SPLIT: the calendar
icon is a real `<input type="date">`, the rest is the text box** —
`useCoarsePointer` swaps the native input from a 20px strip (`.nativeHidden`) to
a transparent 44 by 44 target pinned to the right-hand end (`.nativeIconTarget`,
`pointer-events: auto`, `z-index: 3`, marked `data-touch-target` in the DOM), so
a finger tap on the icon opens the OS picker with no script involved, while a
tap anywhere else focuses the masked text box and raises the keyboard. Both
entry methods work on a phone: pick a date, or type one. The day-first masked
text stays visible underneath, so the display is still ours. `showPicker()` is
the MOUSE path only, reached from the calendar button, which keeps its 44px hit
area; the 44px target overflows the ~30px field vertically rather than growing
it, so no form row re-flows (measured 30px on both pointers, before and after).
Typing also stays on every fine pointer (`pointer: coarse` is the PRIMARY
pointer, so a keyboard-case iPad and a touchscreen laptop both keep the text
box) and on any hardware keyboard. Two earlier spellings are recorded and should
not be re-tried: a `showPicker()` call fired from the text box's `onClick`,
which worked on Chrome and did nothing at all on iOS
(`docs/bugs/0725-the-touch-date-picker-called-showpicker-on-an-untappable-inp.md`),
and a full-field `inset: 0` overlay, which reached the picker but covered the
text box so a phone could not type at all — the owner asked for typing back the
next day, 「可以保留手打」
(`docs/bugs/0726-pr-3311-took-hand-typing-away-on-a-phone-the-date-input-cove.md`).
`frontend/src/vendor/scm/components/MoneyInput.tsx` rests as 1,800.00
(`fmtMoneyAtRest`) and edits plain. Pinned by `backend/tests/apInvoiceEdit.test.ts`,
ApInvoices.test.tsx (pop-out, Edit, Copy, Insert / Enter, amounts),
`SearchCombo.keys.test.tsx`, `DateField.mask.test.tsx`,
`DateField.touch.test.tsx`, `MoneyInput.test.tsx`.

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
AccountSelect simply not offering a header with children. A header is any
account with a sub-account, RETIRED ones included, at all three doors
(docs/bugs/0693, 2026-09-08: 900-R006 RENTAL- SHOWROOM kept three retired
showrooms under it; the two typing-time doors read only the active children
and let it onto 2990-HPV-2607-003, the gate would have refused it at approve).
The pickers take their list from `postableAccounts` / `leafAccounts` in
`frontend/src/vendor/scm/lib/accounting-queries.ts` — the one home, fed the
WHOLE chart — on `PaymentVoucherNew.tsx`, `PaymentVoucherDetail.tsx`,
`ApInvoices.tsx`, `OtherDebtors.tsx`, `Receipts.tsx` and the manual journal on
`Accounting.tsx`; contracts `AccountSelect.test.tsx` and the leaf block of
`backend/tests/accountingChart.test.ts`. One-off chart
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

**Other Debtors, round 2 (2026-09-06 — 刚刚说的功能 … other debtor bill 那边
也要有, the AP invoice's round 3 carried to its sibling).** The bill is a
pop-out form (`DebtorBillForm.tsx` inside `Modal`, opened from the page
`frontend/src/pages/scm-v2/OtherDebtors.tsx`): lines in the owner's
order — account, description, amount — Insert adds a line and lands on its
account, Enter on an amount moves down (adding a line at the end), F3 or
Ctrl+S posts once the form is ready (`useSaveHotkey`, payment-voucher.md),
amounts read 1,800.00 (`MoneyInput`), the date takes bare digits (`DateField`).
Every bill can be EDITED — every field, `PATCH /other-debtors/bills/:billId`
(`updateDebtorBillHandler`) — and because a debtor bill is on the books from
birth, an edit RE-POSTS: the old ODB gets its contra dated as the old bill
was (`reverseJournal` with `entryDate`, the old date snapshotted before the
row is touched), then a fresh ODB dated as saved books the bill as it now
reads, both through the one gate; the reply says `reposted: true` and names
the new `jeNo`. A second edit contra's the live entry, never the voided one
(the engine skips `reversed` rows). Guards: `total_below_received` (money
received caps the total), `cancelled` refuses (raise it again instead), each
edited line walks `requireLeafAccount` so the control still refuses, and the
debtor is fixed — a bill belongs to its debtor. COPY starts a NEW bill from
an old one: lines and description ride over, today's date, a new number on
post. The detail (`debtorDetailHandler`) hands each bill its `lines` so Edit
and Copy start from them; the receipt's amounts wear the same money dress.
Pinned in `otherDebtors.test.ts` (re-post dates, the second edit, refusals
leaving the books alone) and `OtherDebtors.test.tsx` (dialog, Insert/Enter,
Edit's cap and payload, Copy). The plain Payment Voucher's line cards got
the same Insert/Enter manners the same day — payment-voucher.md.

**Receipts (2026-09-03, later the same day: 未来如果我收到其他的钱不是
under other debtor 的呢? 就我只想开 receipt 罢了)**: /scm/receipts is the
unified money-in list — one table holding GENERAL receipts
(raised here), the Other Debtor receipts (read-only mirrors, four-layered
on their own page) and the customer sales payments (read-only mirrors —
顾客的钱 keeps the sales flow it always had; nothing is re-entered). It opens
on EVERY month and the month field is a filter (owner 2026-09-08: 月份只是筛选;
until then it opened on this month alone): `GET /receipts` with no `month`
reads the three tables whole and answers `month: null`, `?month=YYYY-MM`
narrows to that month, and a malformed month is a 400 rather than "this
month" (`listReceiptsHandler`, `backend/src/scm/routes/receipts.ts`;
`useReceipts` in `frontend/src/vendor/scm/lib/accounting-queries.ts`; the
page keeps an "All months" button beside the picker,
`frontend/src/pages/scm-v2/Receipts.tsx`). F3 or Ctrl+S posts the open
receipt form once it is complete (`useSaveHotkey`, payment-voucher.md). Since
2026-09-08 the list is the voucher list's grid (owner, pointing at that
header: Filter 我要这样的 filter function) — `DataGrid`
(`frontend/src/vendor/scm/components/DataGrid.tsx`): every column sorts and
funnels (Kind / Status by value, No. type-to-find, Date by preset or range,
Amount by min/max), the search box finds a number, a payer or a bank, Export
Excel; the month picker, the count and the total ride in its toolbar and the
total follows what is filtered. New / Edit open in the pop-out over the list
(`Modal`, the AP invoice's) — the form used to be pushed in above the table,
which sent the operator to the top of a long list (如果我在下面我要滑到很上面).
**The same New receipt takes an Other Debtor's money (2026-09-08, owner:
不可能链接起来吗? 想 pv 也可以付 AP invoice, expense — receipt 页我也希望这样 →
用这个方式).** A kind switch — Sundry income / Other Debtor — and in the
debtor kind the registry (active debtors, what each owes), the debtor's open
bills with tick-in-full or a typed partial (the Other Debtors page's own
picker), Received into, date; Post raises the ODR through
`POST /other-debtors/:id/receipts` with `postNow: true`
(`createDebtorReceiptHandler`, `backend/src/scm/routes/other-debtors.ts`),
which stamps the three marks with the one hand that keyed it and books the
identical entry the fourth layer's Approve writes — `postDebtorReceipt`, Dr
bank / Cr 305, bills knocked off — in the same call (录入即过账; no four layers
on this door; the Other Debtors page's own raise still starts at Draft). The
bill itself is still raised on Other Debtors. Contracts:
`backend/tests/otherDebtors.test.ts` ("postNow books the receipt in the same
call", "without postNow nothing changes"), `Receipts.test.tsx` ("an Other
Debtor's money is received here").
Contracts:
`backend/tests/receipts.test.ts` ("no month asked for lists every month"),
`Receipts.test.tsx` ("opens on every month").
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
`Receipts.test.tsx` (kinds + links + raise payload + void gating). **The
form carries the receipt's own date and one field dress (2026-09-07,
owner: 没办法输入日期, 格子等等不整齐, 有些有格子有些没有)**: a Date field
(DateField, today by default, sent as `receiptDate` — the server already
took it and dated the number's month by it; the page had simply never
offered it), and every control — payer, both account pickers, description,
amount — wears the PV form's `fieldInput` class on a grid (Date | Received
from | Received into; Description | Account | Amount), the amount a
MoneyInput that re-dresses to 1,800.00 on blur. Pinned in
`Receipts.test.tsx`. **Edit and re-post (later the same day — four receipts
keyed on the wrong day: 这四张我开的还可以 edit 吗? → 做 b)**: a POSTED general
receipt takes a pencil on its row (`frontend/src/pages/scm-v2/Receipts.tsx`,
shown to the PV write or create key); the same form opens seeded from
`GET /receipts/:id` (`getReceiptHandler`, header + lines) and **Save &
re-post** sends `PATCH /receipts/:id` (`updateReceiptHandler`, the same
keys): date, payer, landing account and lines may all change, with the
same doors as create (money account, leaf and non-control lines); the server
reverses the old RCT entry dated as the receipt WAS and books a fresh RCT on
the new date — the AP invoice's edit-and-repost, the trail kept. **The number
stays** (改日期号码不重发): a receipt dated back into August keeps its
September series number; entry_date is what the reports and the
reconciliation read. A void receipt is left alone (409 `receipt_cancelled`).
Contracts: `backend/tests/receipts.test.ts` (re-post on a new date, the
doors, the void refusal) and `Receipts.test.tsx` (the pencil, the seeded
form, the PATCH payload).

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

**Customer payments that never reached the books (2026-09-07, docs/bugs/0652).**
Checking the Receipt & Payment report's data found 2990 with ZERO `SOPAY`
journals against 171 non-imported SO payments since June (RM 403,593.50).
Two causes, both in code: `createSalesOrderCore` (mfg-sales-orders.ts) wrote
the POS split payments and the SO-create deposit straight into
`mfg_sales_order_payments` without the booking hook — 64 of the 78 rows since
the hook landed — and the 15 panel-path rows that DID reach `postSoPayment`
were refused with the reason going to the console and nowhere else, while the
Self-check card read "all of them" because its boundary is the first booked
payment and there was none. Now: both inserts book through the shared `bookSoPaymentBestEffort` hook in
`lib/so-payment-row.ts` (best-effort, never blocking the order —
`tests/soCreateDepositBooks.test.ts` pins the shape, RED on the unfixed tree); the engine's read-only half is `validateJournal`
(steps 1–3b, shared with `postJournal`), `postSoPayment(…, { dryRun })` and
`backfillSoPayments(…, { dryRun })` answer "would this post, and if not why?"
without writing, `POST /backfill/customer-payments { dryRun: true }` exposes
it, and the card has a never-booked state (red, with the money and the dates)
plus a **Why? (dry run)** button that prints each payment's verdict and the
gate's reason (`UnbookedPaymentsCard.test.tsx`, `acc/payments.test.ts`). The
backfill itself — the same endpoint without dryRun, batched, idempotent — is
the self-heal, run on the owner's word once the dry run has spoken. Two
misreadings on the same page fixed the day after (docs/bugs/0654): the
`neverBooked` figure was computed and then dropped by the route's response
shaping, so the card still read "all of them" over 171 unbooked rows; and the
control check knew nothing of AP invoices — every `API` / `API_REVERSAL` line
on 400/405 was reported as a foreign source (21 findings on 2990's 405-0000).
The AP arm now walks `ap_invoices` for drift the way it walks PIs, and both
source types are family on the creditor controls
(`tests/controlCheckPayments.test.ts`, `apControlCheckUnpostedPi.test.ts`).
The dry run then named the reason the hook had been failing since it landed
(docs/bugs/0655): `postSoPayment` read `customer_name, customer_phone` off
`mfg_sales_orders`, columns the order table never had — it names its customer
`debtor_name` and the phone `phone` — so PostgREST refused the read and every
customer payment died at `so_read_failed`, 171 of them in 2990. The two reads
(`acc/payments.ts`, `acc/settlement.ts`) now use the real columns;
`tests/soPaymentOrderColumns.test.ts` pins the accounting module's
`mfg_sales_orders` SELECTs against the table's real column list (the fake
client cannot catch a wrong column — it hands back whatever the fixture row
has, which is exactly how this shipped). The card's **Book N payments now**
button, offered only after a dry run the gate refused nothing on and behind a
confirm, is the same endpoint without dryRun — the owner presses it.

**A payment that reached the ledger and then stopped agreeing with it
(2026-09-10, docs/bugs/0774).** The card above answers "did the money reach
the books". It had no answer for "does it still say what the books say".
`PATCH /:docNo/payments/:id` writes the payment row and never re-posts its
entry — only DELETE touches the ledger, through `afterSoPaymentRemoved`. The
one thing holding the two in step is `paymentRowMutable`
(`scm/shared/so-field-policy.ts`): a payment is editable only on the day it
was keyed, so almost nothing survives long enough to drift (production
2026-09-10: 0 amount disagreements, 3 date). The owner has confirmed with
management that FINANCE should hold the power to correct a mis-keyed payment,
which removes that accident — so the divergence is now watched before the
window opens. `acc/payment-drift.ts` is the pure comparison (amount, date,
and the method read back out of the poster's own narration
`Payment {method} on {docNo}` — an unrecognised narration makes NO method
claim); `paymentEntryDisagreements` in `acc/payments.ts` does the reads,
paging both payment tables in full because the date is one of the things
under suspicion; `/control-check` returns it as `paymentDrift`; the Self-check
tab shows both sides of every difference. A changed acquirer is deliberately
out of scope — it lives in the entry's LINES — and the card says so. It
writes nothing and offers no fix button, because the fix is the next step:
**make the edit reverse and re-post**, and only then the Finance permission,
gated on "editable until the payment has been RECONCILED" rather than by time
(`so-field-policy.ts` already reserves the one place that condition lands).
Pinned by `acc/payment-drift.test.ts`,
`scm/routes/controlCheckPaymentDrift.test.ts` and `PaymentDriftCard.test.tsx`.

**The edit now moves the entry with it (2026-09-10, docs/bugs/0778) — step 2.**
`acc/payment-repost.ts` reverses the old entry and books a fresh one, the
pattern general receipts already use, and the PATCH route calls it through
`repostSoPaymentBestEffort` (beside `bookSoPaymentBestEffort` in
`scm/lib/so-payment-row.ts`, same never-blocks contract). Two decisions live in
that module. **Which edits move the books:** four fields and only four —
`amount_sen`, `paid_at`, `method` (picks the debit account) and
`merchant_provider` (picks WHICH transit account); an approval code, account
sheet, collector, installment term or online sub-type changes no line, and
re-posting for one would spend a JE number rewriting the same entry.
**Where the correcting contra is dated:** on the ORIGINAL entry's date, so the
wrong entry and its reversal net to zero in the month they were made — dated
today it would leave the money standing in one month's bank column and a
matching negative in another. DELETE keeps its own hook and still dates its
contra TODAY, because removing a payment is an event that happens today. A
refusal is carried up and logged, never swallowed: it leaves the payment with
no active entry, which is the unbooked card's finding and the backfill's to
heal. SI payments have no edit route at all, so there is nothing to mirror.
Pinned by `acc/payment-repost.test.ts` (through the real poster and the fake
client) and `tests/soPaymentEditReposts.test.ts` (that the ROUTE calls it —
RED against the unfixed route file).

**Finance holds the correction right (2026-09-10, docs/bugs/0780) — step 3, the
last.** `acc/payment-reconciled.ts` answers "has this payment been reconciled",
and names WHICH of three places closed over it rather than collapsing them into
one flag: `acc_settlement_matches` claims the payment ROW (the only one that
speaks for a payment that never booked); `acc_bank_statement_matches` claims its
ACTIVE entry by je_no; `acc_bank_month_locks` closes that entry's MONEY-leg
account for the month — read off the DEBIT line, because the credit leg is Trade
Debtors and a guard on the wrong line would find no lock and wave everything
through. **Every read fails CLOSED**: an unreadable check refuses and says to
retry, never "not reconciled", or the guard switches itself off exactly when the
database is unhappy (the `loadLineMonth` rule, same reason). `paymentMayChange`
is the one call the two SO payment routes make — loading the fact AND asking
`paymentRowMutable`, because a route that did only the first half would read as
if it had checked. The permission is `scm.so_payment.amend`, held by nobody but
`*` until granted in Team > Positions, and it does NOT reach past a reconciled
payment. Pinned by `scm/shared/soPaymentAmendRight.test.ts`,
`acc/payment-reconciled.test.ts` (one case per read proving a failing read
refuses) and `tests/soPaymentAmendRoutes.test.ts` (RED against the unfixed
route file).

**The reason, and the Corrections report (2026-09-10, docs/bugs/0785).** A
correction made on the amend right owes a reason and is a Finance event; a
same-day fix by whoever keyed the payment is neither (owner: 靠权限改的来决定).
`paymentRowMutable` now says WHY a row may change — `via: 'draft' | 'same_day'
| 'amend' | null` — and both payment routes act on `via === 'amend'`: refuse
without a reason (`reason_required`), and audit the correction with
`source = 'amend'`, the reason in `note`, and two extra field changes —
`ledger: original → new` (what replaced what) and `ledgerReversal: null →
contra` (the PATCH re-posts BEFORE it audits so the row can carry the numbers;
`repostSoPaymentEdit` and `afterSoPaymentRemoved` hand all three back, and
`reverseJournal`'s `reversed` result now names `originalJeNo`). The first
version carried only the contra, as `ledger.from`, and the report printed
"0099 reversed → 0100" — read as if 0099 were the entry reversed, when 0099 IS
the reversal (owner: 不明白; docs/bugs/0786). The Ledger column now reads
**"0047 → reversed by 0099 → 0100"**; the one legacy row is read as
contra-only and never presents the contra as the original. No new table: `GET /accounting/payment-corrections?month=` is a
filtered read of `mfg_so_audit_log` — `source = 'amend'`, the two payment
actions, this company, this month — shaped by `acc/payment-corrections.ts`
(newest first, the ledger pair pulled out, the summary added up). The Accounting
page's **Corrections** tab shows month, a person filter, three cards (count,
net effect on money received, deleted), the table with the reason and both JE
numbers, and Print through `payment-corrections-pdf.ts` — built by
`correctionsDocument`, the same pure-then-draw shape as the bank statement. The
screens ask through `usePrompt` (an optional text input on the shared
ConfirmDialog; a required input cannot be confirmed blank). A fake-client trap
surfaced on the way: its `lt` compared numerically, so a timestamptz month
window returned nothing against the fake — fixed to match `gte`/`lte`.

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

**A REFERENCE IS NOT BOUND BY THE DATE WINDOW (2026-09-09, docs/bugs/0760).**
`loadPaymentCandidates` used to read the tolerance window only, and the
reference was consulted afterwards — so a payment outside the window was never
loaded and its reference never looked at. Four PBB lines on prod read "No
payment recorded near …" while their payment sat in the ERP with the identical
reference and the identical amount, keyed five to eleven days later because the
sale was written up late. The window answers "which payments could plausibly be
this amount on this day"; it is the wrong instrument for a reference, which is
the acquirer's own identifier for the swipe. The loader now takes the
statement's own refs and fetches them whatever their date (deduplicated against
the window read, so one payment reaches the matcher once). The matcher **offers**
such a payment pre-ticked with the distance named, rather than auto-taking it —
a reference matching across two weeks is also the shape of a code mis-keyed onto
a later sale, and this is the one path that books money without a human. Inside
the tolerance the automatic match is unchanged.

**A ref-matched line carries its payment in `matched`, not `candidates`
(same bug).** matchStatement empties `candidates`/`suggested` for that bucket on
purpose — there is nothing to choose. The batch detail read only those two
fields, so a matched line whose link had not persisted arrived with no payment
and the screen ran its last branch, "No payment in the ERP explains this money",
directly under the clue naming the sale it had matched; Confirm then sent an
empty selection and was refused. The detail now falls back to `matched` for
both, and the upload REFUSES when its rows insert returns fewer ids than
decisions — the silent skip that left nine MATCHED lines with zero links.

**THE MERCHANT FEE ACCOUNT (2026-09-09, docs/bugs/0762).** Every acquirer link
in both companies had `fee_account_code = '930-0000'`, seeded by migration 0332
when the chart was the old one. The AutoCount relay (0346) and the 397-account
seed replaced the chart underneath, and in the new one 930-0000 is
"MISCELLANEOUS EXPENSES XXX" and **inactive** — so the posting gate refused
every settlement confirm with *"account 930-0000 is deactivated"*, in both
companies, and had done since the chart moved. It stayed hidden because nothing
reads the fee account until a line is CONFIRMED, and confirms were blocked by
0760/0761. Migration `20260910T0147` repoints the links and the column default
to **900-T009 TERMINAL INTEREST CHARGES** (the owner's choice), guarded so only
rows still on the placeholder move and the target must be an EXPENSE, ACTIVE and
a LEAF in that same company. The route's fallbacks are now one
`MERCHANT_FEE_ACCOUNT` constant so the code and the column default cannot drift.
**And the Setup screen can now pick it** (owner: 这个需要). Reconciliation setup
offers each company its own ACTIVE EXPENSE LEAVES — server-filtered to the same
properties the posting gate checks, so a code on the list cannot be one the gate
refuses — and the PATCH re-checks all four by name (in this chart, active, an
EXPENSE, a leaf) rather than accepting a code that fails later at confirm time.
A fee account the chart can no longer post to is NAMED on the cell, because that
silence is how 930-0000 went unnoticed while every confirm in both companies
refused.

**AND THE BULK BUTTON IS ITS OWN PATH (docs/bugs/0761).** `settlementConfirmMatched`
("Confirm all N matched") builds each line's payments from `acc_settlement_matches`
alone, so the detail fix left it still answering *Posted 0* over lines whose
payment the screen was by then showing. It now applies the same fallback — for a
pending MATCHED row with **no link**, recompute and take the matcher's `matched`
— recomputed only for unlinked rows, so a stored human decision is never
overridden, and confirming writes the link back so the data heals as it is
worked. **Only `matched` is rescued, never `suggested`:** nobody reads each line
on this path, and an out-of-window reference or a lone amount match is offered on
the detail screen precisely because it needs eyes. The handler also 404s on a
missing batch rather than reporting an empty success.

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

**Confirming also moves untagged money onto the merchant's own clearing
account (做 2, owner 2026-09-08: match 了就不见).** A card payment keyed in
without a bank was booked to the GENERIC clearing account (role `TRANSIT_EDC`,
326-0000, 未标银行 on Daily Bank) because nobody could say whose it was. The
merchant's statement has now named it, so `confirmSettlementRow`
(`backend/src/acc/settlement.ts`) reads the chosen payments' own live `SOPAY` /
`SIPAY` entries, sums what they debited on the generic account, and posts ONE
more entry per line: Dr the merchant's own clearing account / Cr generic
(`clearingMoveLines`, `backend/src/acc/rules.ts`; source `SETTLEMOVE`, keyed
`SETTLEMOVE-<row id>`, dated by the transaction like the fee). The payout then
clears the merchant's account, and the generic account reads zero once every
untagged payment has been matched. Nothing moves when the merchant sits on the
generic account itself (CIMB, AEON, HOUZS), when the payment was booked on the
merchant's account already (tagged at the till), or when the payment never
reached the ledger. The move that fails after the fee posted says so and asks
for a second press, which resumes through the gate's idempotency. Undo reverses
the move alongside the fee. Contract: `backend/src/acc/settlement.test.ts`
("money keyed in without a bank moves to the merchant's own clearing account").

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

**Reading the bank's file — headings, never positions (2026-09-08; owner, on
the eight Hong Leong files for 2990's 310-0020 / account 23600602788: 别卡死
读 column, 我怕未来 bank 可能换 format … 可能隔几天我就做一次).**
`backend/src/acc/bank-parse.ts` finds every column by its heading text
(case, spaces and punctuation folded): the names the config teaches first,
then `DEFAULT_HEADINGS` — the captions banks are known to print for each
role (Date / Transaction Date / Txn Date…, Deposit / Credit Amount…,
Withdrawal / Payment Amount…) — so a re-captioned or reordered export still
reads, and a file matching none of them is refused with its own headings
quoted. A column map's values are one heading or SEVERAL (JSON arrays); the
`reference` role JOINS every present heading (Hong Leong's any-day export
splits the narrative into sender name, reference and "other details"). It
strips Excel's `="…"` guard from every cell, reads the opening balance from
the statement's own row ("Balance from previous statement", "Prior Day
Balance :") instead of deriving it from a day's single printed balance, and
hands lines back in DATE ORDER whichever way the bank printed them (the
any-day export runs newest first), closing = the newest printed balance.
Uploads overlap by design: `movementFingerprint` (day + amount + the
narrative's WORDS in any order, a split word glued back — "MERCHAN T") keys
what this account already carries on ANY earlier statement, counted, so a
longer export marks what it repeats DUPLICATE/IGNORED (naming the entry or
the statement it sits on) and adds only the movements beyond that count —
two identical transfers on one day stay two
(`bankUpload`, `backend/src/scm/routes/accounting-bank.ts`). Setup lives on
Reconciliation setup's **Bank statements** card
(`frontend/src/pages/scm-v2/SettlementSetup.tsx`, hooks in
`frontend/src/pages/scm-v2/bank-queries.ts`): per company, the account, the
bank, the account number the file must mention, format, delimiter, amount
style, and each heading role as a comma-separated list, a blank role falling
back to the built-in names — `GET/POST /accounting/bank/config`
(`backend/src/scm/routes/accounting-bank-config.ts`; money accounts of this
company's chart only, CSV/TXT only, an amount named one way only; the
`ready` flag on `/bank/setup` is now always true for that reason).
`backend/src/db/migrations-pg/20260908T2100_acc_bank_statement_hlb_2990.sql`
seeds 2990's HLB account (both layouts' captions), adds the GHL recognition
rule ("/GHL/<merchant> … (FOR GHL)" on an interbank GIRO credit) and loosens
the HLB rule to the split word. Contracts: `backend/src/acc/bank-parse.test.ts`
(both Hong Leong layouts on synthetic rows, the built-in headings, the
fingerprint), `backend/src/acc/bank-match.test.ts` (GHL, HLB whole and
split), `backend/tests/bankRoutes.test.ts` ("uploading overlapping exports",
"setting up a statement account"), `SettlementSetup.test.tsx` (the card).

**A MONTH, not a file at a time (2026-09-09; owner, uploading one a day: 每天我
上传bank statement 和 merchant report 测试，但是有办法选这个是几月的？因为我发现
好像没有).** Layer 4 reconciled one FILE, which is the right unit for a monthly
statement and the wrong one for Hong Leong's any-day export — a file per day made
September thirty separate answers and none of them the answer to "did September
agree". `backend/src/acc/bank-month.ts` assembles the month by three rules and
hands it to the SAME `reconcileBankStatement`, so nothing new judges money:
(1) a MOVEMENT belongs to the month its own date falls in, never to the file it
arrived in — a date cannot lie about its month, a filing label can, so a file
straddling a month end feeds both and daily/monthly/both uploads build the same
September; (2) a BALANCE speaks for a month only when its file lies wholly
inside it — the opening on a 28 Aug–3 Sep file is August's, and using it as
September's is wrong by four days of movement while looking authoritative, so
such a file is listed and LABELLED rather than dropped; (3) the files are
CHAINED and the chain is CHECKED — Hong Leong prints the prior day's balance, so
each file should open where the previous closed, and a break is reported with
both file names, both dates and the amount that moved between them (an
overlapping longer export is NOT a break). The reconciliation window follows the
days actually uploaded, not the calendar, so ten days of bank are never set
against thirty of ledger. Doors: `GET /accounting/bank/months` (every account ×
month, with whether it is covered end to end) and
`GET /accounting/bank/months/:accountCode/:month`
(`backend/src/scm/routes/accounting-bank-months.ts`, guarded by the same
`bankGuard` exported from `accounting-bank.ts`). **By month** is the first tab of
`/scm/bank-recon`; the per-file view stays one press away
(`frontend/src/pages/scm-v2/BankMonthTab.tsx`, reusing the file screen's own
reconciliation panel and movement rows so one movement has one set of buttons).
What is MISSING prints above the verdict — a difference computed over a month
short of four days is an answer about a different month.

**The reconciliation statement on paper (2026-09-09; owner: 然后就是match 完了我
要report).** `frontend/src/vendor/scm/lib/bank-reconciliation-pdf.ts` walks
balance per bank statement − on the bank not in the books + in the books not on
the bank − difference brought forward = balance per the books, which is the
identity `acc/bank-reconcile` checks, written as lines. It TIES BY CONSTRUCTION
and is then checked against the ledger balance the server sent; three refusals
keep it from being filed when it should not be — the walk arriving anywhere but
the ledger, the server having already found the figures inconsistent (no walk is
drawn at all, because a tidy one would launder the error), and no file printing a
closing balance (a zero is not an absence). Every step names the count behind it
and every count has its list: unposted movements with the file they came off,
ledger entries the bank never showed, movements POSTED, and — printed whether or
not the month reconciles — everything LEFT OUT with the reason given, which is
the only record that decision will ever have. Reached through the house's one
print dialog (`PrintPreviewModal`) from the month view. Contracts:
`backend/src/acc/bank-month.test.ts` (leap February, a missing day, an
overlapping export that is not a break, a straddling file speaking only for its
movements), `frontend/src/pages/scm-v2/BankMonthTab.test.tsx`,
`frontend/src/vendor/scm/lib/bank-reconciliation-pdf.test.ts` (the walk ties, or
it is not drawn).

**Closing a reconciled month (2026-09-09; owner: 还有lock 起来不可以随便碰).**
Until now every bank movement could be booked, ignored or UNDONE at any time,
for ever — right while a month is being worked, wrong the moment it has been
reconciled and its statement printed, because a reconciliation somebody filed is
a claim and a month that can still move behind the paper makes the paper a lie.
`backend/src/acc/bank-lock.ts` holds both rules. **May it close:** never while
movements are still undecided (an unfinished month is not a month with a problem,
so a reason must NOT buy a way past it) and never when it is empty; freely when
it reconciles and is covered end to end; WITH A REQUIRED REASON when the bank and
books still differ, a day was never uploaded, no file printed a closing balance,
or the figures failed the identity check — businesses do close over known
differences, and what must not happen is closing silently. **What a closed month
refuses:** booking, matching, ignoring, undoing, and uploading a statement whose
movements land inside it — checked by the movement's OWN date (bank-month rule 1)
so a straddling file cannot smuggle a write into a closed September, and a lock
read that FAILS is a refusal rather than a pass. The refusal names the month, who
closed it and when. Doors: `GET /accounting/bank/locks` and
`POST /accounting/bank/months/:accountCode/:month/lock` | `/unlock`
(`backend/src/scm/routes/accounting-bank-locks.ts`). Unlock asks a SECOND key —
`scm.payment_voucher.approve`, because reopening undoes a document somebody filed
— plus its own required reason. Migration `20260909T0243_acc_bank_month_lock.sql`
adds `scm.acc_bank_month_locks`: one row per company × account × month, a partial
unique index keeping one live lock at a time, and the two closing balances, the
difference, the file count and `was_complete` SNAPSHOTTED at the moment of
closing — deliberately frozen, because a claim that silently follows today's data
is not a claim and a later disagreement with the ledger IS the finding. A lock is
never deleted: releasing sets `released_at` and the row stays. **It is not a GL
period close** — it stops the bank reconciliation screens from changing a closed
month, not a journal entry posted into those dates from elsewhere. Contracts:
`backend/src/acc/bank-lock.test.ts` (an unfinished month refuses even with a
reason; each unclean month refuses without one and closes with one).

**"This movement is already in the books" (2026-09-09; owner, on a RM 3,000
transfer sitting beside the RM 3,000 receipt that posted it: the only button was
"Not ours to reconcile", which is not true).** `POST /bank/lines/:id/match` has
existed since layer 4 shipped and had NO user interface, so everything on a
statement that is not card money — a customer's transfer, a bank charge, a
deposit — had no correct action. `entryCandidatesFor`
(`backend/src/acc/bank-match.ts`) now ranks the posted entries a movement could
be, and both `/bank/statements/:id` and `/bank/months/...` return them per line
as `entryCandidates` (open lines only). Deliberately narrow, because the
operator is agreeing that two records are ONE FACT: the amount must agree **to
the sen and in the same direction** (a tolerance would let RM 3,000.00 reconcile
against RM 3,000.50 and lose the fifty sen for ever), the entry must be within
`ENTRY_MATCH_WINDOW_DAYS` (7 — a cheque banked on Friday clears on Monday), and
an entry another movement already claims is not offered at all rather than
refused after choosing. Ranked closest-day first with a deterministic tie-break;
**proposed, never auto-applied**. The row shows the entry number, its date, how
many days apart it is, and the document behind it; nothing is pre-selected and
the button will not fire until a choice is made.

**Where a reconciliation is "saved" (same day, same question: 我也没有看到哪里可
以save 这个recon).** There is no Save because there is no draft — every decision
writes when pressed, and the reconciliation is recomputed from the ledger on
every read (§2.3, no caches). What records one is **closing its month** (above).
The file view now says both, and names the month its own dates fall in, because
the difference between finding that and hunting for it is one sentence.

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

**Document numbers follow the document date (owner 2026-09-07: 要根据文件日期,
而不是文件几时 create 的日期).** Six finance series take their YYMM from the
paper's own date — the AP invoice from `invoice_date`, the payment voucher
(the Draft number at birth AND the formal `{co}{letter}PV` number at Checked)
from `voucher_date`, the Official Receipt (draft and formal) from the
payment's `paid_at`, the general receipt from `receipt_date`, the Other
Debtor bill and receipt from theirs — through one helper, `docMonthTag` in
`backend/src/scm/lib/doc-no.ts` (blank or unparseable → today in Malaysia, so
the before-08:00-on-the-1st UTC slip is gone with it). A March bill keyed in
September sits in March's series. Editing the date afterwards does NOT
re-mint (his rule: 单据存了后改日期号码不要重发) — a number is an id, not a
date. The operational series (SO, PO, PI, SI, DO, GRN, returns, trips…) keep
the keyed day on purpose (那些别碰先). The one paper issued before this rule,
`2990-API-2609-001` (dated 31/03/2026), moves to `2990-API-2603-001` through
`.github/workflows/repair-doc-number.yml` (plan → apply, confirm
`RENUMBER DOCUMENT`; script `backend/scripts/repair-doc-number.mjs`), which
also renames the journal's `source_doc_no` (the engine finds a document's
entry by it) and the number as text in narration, line notes and the audit
ledger, and drops the emptied 2609 counter so September's next bill is 001
again. Pinned in `doc-no.test.ts`, `apInvoices.test.ts`,
`pvDraftNumbering.test.ts`, `officialReceipts.test.ts`, `otherDebtors.test.ts`
and `receipts.test.ts` — each with a document dated in another month than
the test runs in.

**Receipts & Payments (2026-09-06/07, owner: 我希望做一个 receipt & Payment
版式 … 做).** AutoCount's report, in the Accounting page as its own tab:
a COLUMN per cash/bank account (tick the ones you want) plus Total, RECEIPTS
above PAYMENTS, opening and closing per column, rows in the owner's own
accounts — 这个目前我有分 account, 你可以先不要自己分类; the big groups
(showroom 费用 / operation 费用 …) come later, dragged onto rows on this
page. `GET /accounting/reports/receipts-payments?from&to&accounts&party`
(`backend/src/scm/routes/accounting-rp.ts`) reads `v_gl_entries` — posted,
not reversed, the one source the P&L, balance sheet and trial balance beside
it read — groups the period by journal, takes each money leg as a receipt
(debit) or a payment (credit) and books the journal's OTHER lines against it.
The one rule beyond "the other side's account": a SUPPLIER PAYMENT is read
through what the voucher settled (his rule A) — a purchase invoice's own
purchase groups in the proportion of the PI's own debit lines (exact when
paid in full; a single-group PI is simply its group), an AP invoice's own
lines, and money paid beyond what was settled as "Supplier advances (预付)".
A transfer between two money accounts reads as "Transfer to/from <account>",
never as an unexplained movement; a money account left out of the columns is
a transfer counterpart the same way. `party=1` is AutoCount's "display trade
debtor/creditor in details": control-account rows are named by the party and
the supplier split is not applied. The tab (`ReceiptsPayments.tsx`,
`rp-report-queries.ts`) opens the entries behind any figure and prints the
same table landscape (`rp-report-pdf.ts`). Bank clearing accounts (EDC /
online, 326/327) are not money, so a card sale appears when the settlement
lands. Pinned in `backend/tests/rpReport.test.ts` (opening / period /
closing, the rule-A split, the advance remainder, the transfer, party mode,
the column filter, a reversed journal invisible) and
`ReceiptsPayments.test.tsx` / `rp-report-pdf.test.ts`.

**Official Receipts (GL redesign item 9).** Every customer payment births a
receipt (`scm.acc_official_receipts`, one per payment forever — a reprint
reprints, never re-issues): DRAFT on the `{co}DraftOR-YYMM` series at recording, FORMAL
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
tests/officialReceipts.test.ts. **The table is its own since docs/bugs/0658
(2026-09-07):** the module's first migration (20260905T1800) said
`CREATE TABLE IF NOT EXISTS scm.acc_receipts` — the name 0351 had already
given the general money-in receipt — so on every database the statement was
a silent no-op, the tracker called it applied, and or_number / payment_source
never existed: every birth failed best-effort, the book page could not load,
the settlement hook formalised nothing. Migration 20260907T1600 creates
`scm.acc_official_receipts` (same columns), the module reads it, and
`tests/officialReceiptsTable.test.ts` pins that no two migrations ever
CREATE one scm table name again. Receipts for payments recorded while the
table was missing heal on first print (`ensure`), as before.

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

**Customer Refund (2026-09-07).** The refund to a customer is a payment
voucher of purpose `CUSTOMER_REFUND` — payment-voucher.md §14 is the guide.
Its entry is `customerRefundLines` in `backend/src/acc/rules.ts`, the mirror
of `customerPaymentLines`: Dr AR (role `AR`, party CUSTOMER — the customer's
code, see "One customer, one code" below, the name always) / Cr the money
account the refund leaves from, both legs stamped with the customer. It
offsets the Cr AR the customer's own payment booked; the two meet by the
party code the voucher copies from the document.
Migrations `20260907T1700_pv_purpose_customer_refund.sql` (the enum value)
and `20260907T1705_pv_customer_refund_columns.sql` (source and customer on
the header). Pinned by `backend/tests/pvCustomerRefund.test.ts`.

**One customer, one code (2026-09-08, owner: 不是一个 customer 一个 account
code 吗 → 做,第 3 点也做).** The AR control keeps customers apart by the
party on each line, and 2990 keeps no debtor codes, so until this day its
lines carried the customer's NAME alone: two customers sharing a name merged
in every party view, one customer typed two ways split. `customerPartyCode`
(`backend/src/acc/payments.ts`) is the one rule — the debtor code when the
business keeps one (blank = not kept), else the document's own `customer_id`,
which every 2990 order carries — and `postSoPayment` reads both off the order
to stamp `party_code` beside `party_name`; SI payments keep the invoice's
debtor code (invoices carry no customer_id); the refund voucher applies the
same rule to its header's `debtor_code` / `customer_id`
(`backend/src/scm/routes/payment-vouchers.ts`). The R&P party mode keys
control rows by the code where one is stamped and still names them
(`backend/src/scm/routes/accounting-rp.ts`). The lines booked before the rule
— the 171 SOPAY entries of 2026-09-08 and any refund posted before it — are
stamped from their documents by `.github/workflows/repair-customer-party-code.yml`
+ `backend/scripts/repair-customer-party-code.mjs` (plan/apply, environment-
scoped, CONFIRM "STAMP CUSTOMER PARTY CODES"; a line whose document yields no
code is listed and left alone; convergent; fresh-connection verification).
Contracts: `backend/src/acc/payments.test.ts` (the code beside the name, the
debtor code winning, a blank one falling back), `backend/tests/pvCustomerRefund.test.ts`.

**A paid purchase invoice is marked paid (2026-09-08, docs/bugs/0700, owner:
这个要做).** Approving a SUPPLIER_PAYMENT voucher settles each purchase invoice
it pays through `scm.settle_pi_paid_sen`, and until this day that function
failed on every call: it wrote the new status as a CASE of bare text literals
into the enum column `scm.purchase_invoice_status` (42804 — no assignment cast
from text to an enum). The voucher's journal was posted and the bank credited;
the invoice stayed POSTED at paid_sen 0, open in the AP Payment picker and
unlocked for edits, and the allocation recorded applied_sen 0, so a cancel
would have released nothing.
`backend/src/db/migrations-pg/20260908T0900_scm_settle_pi_paid_sen_enum_status.sql`
re-creates the function with each branch typed as the enum — nothing else in
the body moves — and `backend/tests-pg/settlePiPaidSenEnum.pg.test.ts` pins
the newest definition in the tree against a fixture that declares the real
enum. The 21 prod allocations the failure left behind (two 2990 vouchers,
RM 46,948.10) are settled by `.github/workflows/repair-pi-settlement.yml` +
`backend/scripts/repair-pi-settlement.mjs` (plan/apply, environment-scoped,
CONFIRM "SETTLE PI ALLOCATIONS"): the same function, the same clamp, vouchers
in approval order, `applied_sen` recorded from what it applied; a refused or
foreign-currency row is listed and left alone; convergent; refuses to run while
the target still carries the broken function; fresh-connection verification.
Once settled an invoice is locked (`pi_locked`) — to correct its price, cancel
the voucher first (which unwinds exactly `applied_sen`), edit, and pay again.

**One clearing account per card machine (2026-09-07, owner: 我想要拆账户，因为这样
我比较然后检查回).** Until now every acquirer's card money sat in ONE account,
326-0000 CARD MACHINE CLEARING (EDC), so Daily Bank could only say what "the
machines" owed as a lump. `20260907T2200_acc_per_bank_clearing_2990.sql` gives
2990 a clearing account per bank — 326-0010 PBB, 326-0020 MBB, 326-0030 GHL,
326-0040 HLB, siblings of 326-0000 (父户不记账: the generic account keeps its
job for a card payment recorded without a bank — 2990's 43 untagged
installment rows, and the 4 the owner chose to leave tagged CIMB) — and points
each acquirer link (`scm.acc_company_acquirers.transit_account_code`) at its
own; CIMB and AEON (switched off) stay on the generic account, HOUZS is not
touched. The posting rules already read the acquirer's account
(`transitFor`, acc/payments.ts) and the settlement layer posts fees and
payouts against it, so the split needs no rule change. The Recon Setup
maintenance matrix (`frontend/src/pages/scm-v2/SettlementSetup.tsx`) grows a
**clearing** picker under each merchant's payout bank, fed by the new
`clearings` block of `GET /accounting/settlement/maintenance` (each company's
live 326-/327- accounts) and written through `PATCH
/accounting/settlement/maintenance/merchant` `transitAccountCode`, which
refuses anything that is not a live clearing account of that company
(`backend/src/scm/routes/accounting-settlement.ts`). Daily Bank
(`backend/src/scm/routes/accounting.ts`) keeps the generic account on the
board as 未标银行 once no active acquirer points at it, so untagged card money
stays visible. Contracts: `backend/tests/settlementRoutes.test.ts` (the
clearing list, the write and its refusals), `SettlementSetup.test.tsx` (the
picker). Merchant reconciliation moving a matched untagged payment from the
generic account to its bank's followed on 2026-09-08 — see "Confirming also
moves untagged money" above.

**One line per untagged card payment (docs/bugs/0688, 2026-09-08).** The
morning the per-bank accounts went live the owner opened Merchant
reconciliation and saw 2990-SO-2606-013 four times — once under each active
merchant, and the header counting it four times. That is `couldBeAcquirers`
doing its job (a card payment recorded without a bank could be any of theirs,
so every statement must be able to find it) walked acquirer by acquirer by the
two watch screens: 2990's 43 untagged instalments read as 172 rows and
RM 749,724 instead of 125 rows and RM 326,994. `listOnce`
(`backend/src/acc/settlement-match.ts`) now puts an untagged payment on the
watchlist and on the in-transit list ONCE, under no acquirer
(`backend/src/scm/routes/accounting-settlement.ts`; the ageing table keys it
未标), and the screens show the chip as 未标 with a line saying how many were
keyed in without a bank (`frontend/src/pages/scm-v2/MerchantRecon.tsx`,
`BankRecon.tsx`, the types in `settlement-queries.ts`). Matching is untouched:
the payment is still offered to every merchant's report, and the confirm that
stamps its bank is what moves it onto that merchant's list. Contracts:
`settlement-match.test.ts` (listed once), `backend/tests/settlementRoutes.test.ts`
(both lists, the acquirer filter, the ageing key), `MerchantRecon.test.tsx` and
`BankRecon.test.tsx` (the chip and the counts).
