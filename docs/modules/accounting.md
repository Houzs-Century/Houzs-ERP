# Accounting

Houzs's own general ledger, kept to formal-book standard while AutoCount runs in parallel (the ERP pushes documents to AutoCount).
Covers the posting engine, chart of accounts, finance documents (AP invoices, Other Debtors, receipts, credit/debit notes, deposit invoices, official receipts), merchant and bank reconciliation, daily and month-end closes, and the financial reports.
Used by Finance and the owner on desktop, through the Finance sidebar (Money in, Money out, Bank & cards, Books, Reports, Setup).
Payment vouchers have their own guide (`docs/modules/payment-voucher.md`); the requirements brief is `docs/新ERP会计模块需求书.md`.

## Statuses and flow

Journal entries
- Every entry is written POSTED by the engine; a manual journal (JV) starts DRAFT and posts via `POST /accounting/journal-entries/:id/post`.
- A reversal is a contra entry, never a delete: the original carries `reversed`, the contra `reversed_by_je`. Manual journals reverse via `/reverse`; document entries only through their document's own cancel.
- Editing a manual journal (`PUT /journal-entries/:id`): validate, write the corrected DRAFT, reverse the old entry with a contra dated the OLD entry's day, post. A DRAFT is rewritten in place; document entries refuse `not_manual`, reversed ones `already_reversed`.
- Journal class (SALES / PURCHASE / BANK / CASH / GENERAL) is derived by `classifyJournal`, never stored; SOPAY/SIPAY/PV split CASH vs BANK by the money account they touch.

Auto-posting source types (reversal = `<TYPE>_REVERSAL`)
- `SI` sales invoice: Dr AR (customer party) / Cr each item group's sales account; posts at create/confirm, resync voids and re-posts after post-issue edits.
- `PI` purchase invoice: Dr each item group's purchase account / Cr the supplier's AP control (400 or 405). `API` AP invoice: Dr each line's account / Cr AP control.
- `PV` payment voucher: posts at approve, reverses at cancel.
- `SOPAY` / `SIPAY` customer payment: Dr cash, default bank or the acquirer's clearing account / Cr AR. `SOCONV` money moved off a cancelled order: Dr AR (old customer) / Cr AR (new customer).
- `CASHUP` daily-close cash over/short (946-0000; corrected by JV). `STOCKADJ` month-end stock pair: Dr 330-0000 / Cr 620-0000 on the last day, mirror dated the 1st.
- `SETTLE` merchant fee at confirm; `SETTLEMOVE` untagged card money to the merchant's own clearing account; `SETTLEADJ` statement charge with no transaction; `SETTLEBANK` payout credit; `SETTLECHARGE` bank charge kept from a payout.
- `ODB` debtor bill, `ODR` debtor receipt, `RCT` general receipt, `CN` / `DN` / `SCN` notes, `DI` deposit invoice.

Documents
- AP invoice: DRAFT → POSTED → PARTIALLY_PAID / PAID (paid by an AP Payment voucher through `scm.settle_api_paid_sen`). Cancel writes `API_REVERSAL`, refused once money is on it (`has_payments`). Editing a posted bill re-posts. The list also mirrors purchase invoices read-only (`kind: 'PI'`).
- Other Debtor bill: posts on create (atomic with its journal); PAID when fully knocked off; cancel refused once money received; edit re-posts; prints as an INVOICE to the debtor (description and amount per line, never the account code; total, received, balance due, words; CANCELLED watermark). The registry holds the party's data as a supplier's — TIN, business reg no, contact person, attention, phones, email, fax, four address lines, city, postcode, state, country (`debtor-party.ts`; one pop-out form for New and Edit) — and BILL TO prints the address, attention, phone, email, TIN and reg no.
- Other Debtor receipt: Draft → Prepared → Checked → Approved (approve posts ODR and knocks off bills, clamped at live outstanding). Reject returns to Draft clearing every mark; withdraw only before Checked. From the Receipts page with `postNow: true` it posts in the same call.
- General receipt (RCT): posts on create; the only undo is VOID (RCT_REVERSAL + CANCELLED). Editing a posted receipt reverses and re-posts on the new date and keeps its number; a void one refuses (`receipt_cancelled`).
- Credit / debit note (CN and DN to a customer, SCN from a supplier): DRAFT → POSTED → CANCELLED by contra; a posted note is never edited (`not_editable`).
- Deposit invoice (DI): issued and posted per qualifying customer payment; closed by one CN when the order's final invoice posts (`credit_note_id`); cancel needs a reason (row kept); `POST /deposit-invoices/:id/post` retries a journal refused at birth.
- Official receipt: DRAFT (`{co}DraftOR-YYMM`) when the payment is recorded → FORMAL when the money is confirmed: cash at once (`{co}COR`), card at merchant-recon confirm, transfer by the manual Confirm money button.
- Merchant settlement line: MATCHED / NEEDS_CONFIRM / UNMATCHED / IGNORED. Confirm posts SETTLE (+ SETTLEMOVE); Undo (`/settlement/rows/:id/unconfirm`) reverses, releases the links and returns to NEEDS_CONFIRM, refused while the report has recorded payout credits.
- Bank statement line `state`: OPEN → POSTED (matched or money received) or IGNORED (incl. duplicates and bank reversal pairs); Undo reopens the whole match group.
- Bank month (company × account × month): open → locked (`/lock`) → unlocked (`/unlock` sets `released_at`; the row stays).
- Daily close: confirming freezes the day's buckets and posts CASHUP; card/transfer differences are recorded, never posted there.
- Month-end stock close: nightly 00:05 MYT; on the 1st posts the pair for the month just ended, other nights heal late documents by reversing and re-posting; every run logs to `scm.acc_stock_close_runs`.
- Money on a sales order, cancelled or live: refund (a Customer Refund voucher DRAFT for Finance; no floor) or convert (a `converted` payment row on the new order); un-convert = delete that row. A LIVE order keeps its Processing-Date deposit fraction of the total (Houzs 30% / 2990 50%, transport included) — `convertGuard` refuses past it (`convert_keeps_deposit`); a cancelled order keeps nothing. Money that leaves an order is MIRRORED on it as a negative `converted` row (`converted_to_so_doc_no` + `mirror_of_payment_id`, or `refund_pv_id` once the voucher posts) so Paid / Balance / the deposit gate / AutoCount move; a mirror books nothing, gets no receipt or deposit invoice, and is never edited or deleted by hand — it follows its counterpart. Both exits from the order's money panel, or from the Sales Orders list with several orders ticked (any customers, any status with money; one refund draft per order; the new order copies the first ticked order); the convert picker takes another order by number. Lists: `/cancelled-with-money` (Finance's card) and `/with-money` (any status).

## Permissions

- Area guard `scm.finance.accounting` on `/accounting`, `/payment-vouchers`, `/other-debtors`, `/receipts`, `/ap-invoices`, `/credit-notes`, `/deposit-invoices`. Chart, journal list, GL stream, balances, aging, and AP invoice / receipt / Other Debtor lists read on the area alone.
- `scm.payment_voucher.post` — every GL write and ledger maintenance (manual journals, chart, account roles, voucher numbering, item groups, backfills, stock close), merchant and bank reconciliation, the statements and reports (P&L, balance sheet, R&P, performance, collection, merchant charges, general ledger view, layouts), posting AP invoices and notes, deposit-invoice switch / backlog / re-post.
- `scm.payment_voucher.create` / `.write` — raise and edit AP invoices, credit notes, general receipts, Other Debtor bills and receipts (raise, prepare).
- `scm.payment_voucher.check` — check an Other Debtor receipt. `scm.payment_voucher.approve` — approve-and-post it; also unlock a closed bank month (with a reason).
- `scm.payment_voucher.cancel` — cancel AP invoices, debtor bills, credit notes, deposit invoices; void general receipts.
- `scm.so_payment.amend` — role key (Team > Roles & Permissions; the Finance role has it): correct a sales-order payment after its keyed day, never past reconciliation. A role literally holding it owes a reason on every SO payment add / edit / delete / proof attach (`KEY_HOLDER_REASON_REQUIRED`); the `*` wildcard alone is not a holder.

## Rules that must not break

Engine and chart
- Only `postJournal` / `reverseJournal` (`backend/src/acc/engine.ts`) write journal lines; a new auto-posting type needs a rule in `acc/rules.ts`, a caller building lines through it, and a behaviour-lock test.
- Gate order: shape (≥2 one-sided integer-sen lines) → balance → chart (exists for the company, active, not a header) → idempotency (one ACTIVE entry per company + source_type + source_doc_no; read fails closed) → per-company number. `validateJournal` is the read-only half.
- Database backstops stay: `acc_je_balanced_totals`, `acc_jel_nonneg`, `acc_jel_one_sided`, partial unique `acc_je_one_active_source`, trigger `trg_je_balanced`.
- Account codes resolve through roles (`scm.acc_account_roles`, per company); never hardcode a code at a call site.
- `jePrefixForCompany` (`scm/lib/doc-no.ts`) reads `public.companies` via `sb.schema('public')`; it fails closed and `postJournal` returns `je_prefix_failed`.
- Which company's chart / roles / acquirers a posting reads is decided only by `accMastersCompanyId` (`acc/masters-company.ts`); never re-implement its fallback inline.
- New finance tables take the `acc_` prefix; never reuse an existing `scm` table name in a migration.
- Every finance router declares `router.use('*', supabaseAuth)` itself (pinned by `backend/tests/scmRouterBridge.test.ts`).
- Reads are company-scoped and page past the 1,000-row cap; a company id sent in a body is re-checked against the caller's grants.
- Header accounts never post (父户不记账): engine, `requireLeafAccount` and AccountSelect all refuse; an account with any sub-account, retired ones included, is a header.
- Control accounts are never hand-picked: roles AR, AR_OTHER, AP, AP_OTHER (`CONTROL_ROLES`; manual journals refuse) and special types SDC/SCC/SBS (`requireLeafAccount` refuses).
- One definition per code across companies: rename via `scm.acc_rename_account` (one transaction, collision refuses), updates hit every company, delete only a never-used code, tick OFF cascades to children, tick ON brings the parent chain.
- `section` decides the account type (`scm/lib/account-sections.ts`); moving a header moves its subtree, a child refuses (`section_child`); a reparent onto an account with postings refuses (`parent_has_postings`); parent shares the type; no cycles.
- 405-x suppliers book to AP_OTHER (405-0000), all others to AP (400-0000) — `apControlRole` only; an AP payment on the other control refuses `wrong_ap_control`.
- Lines post per item group (`acc/item-group-split.ts`): ungrouped (`line_ungrouped`) or unbound (`group_unbound`) refuses by name, never a default account. Groups are born only via `scm.acc_register_item_group`; discounts stay company-level.
- PI posts periodic: documents never touch 330-0000; stock value reaches the GL only through STOCKADJ, replayed on `inventory_movements.movement_date`.
- Migrated documents (`migrated_no_stock`) and `imported`-method payments book nothing — AutoCount already carries them.

Customer payments
- Every sales-order payment insert (panel, scan job, both SO-create inserts) goes through `bookSoPaymentBestEffort` (`scm/lib/so-payment-row.ts`): books SOPAY, issues the deposit invoice, births the official receipt; never blocks the order; logs refusals.
- AR lines carry `party_code` from `customerPartyCode`: the debtor code when kept, else the order's `customer_id`.
- A payment edit re-posts only if amount, paid date, method or merchant provider changed; the contra is dated on the original entry's day. A delete's contra is dated today.
- A payment changes only as a draft, on its keyed day, or under the amend right with a reason. A reconciled payment (confirmed settlement line, bank match on its entry, locked bank month on its money leg) is locked for everyone; each check fails closed.
- A converted payment row cannot be PATCHed; refunds plus conversions never exceed the pool (`orderMoney`, `scm/lib/so-money.ts`); converted rows are skipped by daily close, drift check and receipt healing.

Deposit invoices, notes, receipts
- A DI is issued only when the company switch is on, the payment is on/after the start day, the order is live (`order_not_live` for DRAFT/CANCELLED) and has no live sales invoice; one DI stands per payment.
- With the switch on, the delivery reconciler raises the final invoice when an order turns DELIVERED; `postSiRevenue` closes each standing DI with a CN (Dr 509 / Cr AR) dated the invoice day; cancelling that invoice contras the CNs.
- Backlog order: issue missing DIs first, then invoice already-delivered orders (dated when the goods left).
- A posted Customer Refund voucher naming an SO raises a CN per deposit invoice it draws on, oldest first; cancelling the voucher contras them.
- One official receipt per payment for ever; a reprint never re-issues. Table `scm.acc_official_receipts` (`scm.acc_receipts` is the general receipt). The Official Receipts page opens on the current month: `GET /accounting/receipts?month=YYYY-MM` lists the month whole (oldest first), `GET /accounting/receipts/check?month=` reads the month's SO + SI payments that arrived (no converted, mirror or zero rows) against its receipts by payment day — totals, difference, payments without a receipt, receipts whose amount is not their payment's, receipts whose payment is gone.
- A settled purchase invoice is locked (`pi_locked`): cancel the voucher (unwinds `applied_sen`), edit, pay again.
- AP invoice edit refuses `total_below_paid`, `supplier_locked`, or a cancelled bill; files refused on a cancelled bill (`invoice_cancelled`), delete refused once posted (`evidence_locked`). Debtor bill edit: `total_below_received`, debtor fixed.
- OCR pre-fill writes UPPER CASE and takes the account from vendor memory only, never a model guess.

Numbering and dates
- Finance series (AP invoice, PV draft and formal, OR draft and formal, general receipt, debtor bill and receipt) take YYMM from the document date (`docMonthTag`); a later date change never re-mints. Operational series keep the keyed day.
- CN / DN / SCN / DI mint `{co}-<KIND>-YYMM-NNN` via `mintMonthlyDocNo`.
- A correction's contra is dated as the original (its month nets to zero); a real cancel's contra is dated today.
- Voucher letters: one per money account, unique per company; C is reserved for cash (CPV / COR) and refused for banks.

Merchant reconciliation
- Auto-match only on a unique reference inside the tolerance; amount+date matches and out-of-window references are offered pre-ticked for a person, never taken. "Confirm all matched" rescues only `matched`, never `suggested`.
- Confirm re-reads the chosen payments (`payment_not_found`, `not_card_payment`, `amount_mismatch` on database figures) and stamps the acquirer tag only where it is NULL.
- Candidates: card payments tagged with this acquirer or untagged, and untagged `imported` rows; never another acquirer's, never cash/transfer, never a CANCELLED order's; untagged ones list once.
- `acc_settlement_matches` is UNIQUE on (payment_source, payment_id); a report file is unique by hash; a line already on another report (day + ref + gross) is left out and a file with nothing new refuses `already_on_report`; a failed upload deletes its batch head.
- Unconfirmed links refresh from their payment each time a report opens; a confirmed link is changed only by a named migration.
- Confirm books the fee only; each bank credit books SETTLEBANK separately, and a credit overshooting the report's net refuses.
- Fee and payout-charge accounts must be ACTIVE EXPENSE LEAVES of the company; a payout charge is dated the settlement day, needs a note, cannot exceed the difference, one per day.
- An acquirer's clearing account must be a live 326-/327- account of that company; untagged card money stays on generic 326-0000.
- Bank recognition rules are global; regexes compile at write time and need a capture group; no delete (`is_active = false`).

Bank reconciliation
- Columns are found by heading text, never position; overlapping uploads dedupe by `movementFingerprint`; CSV and PDF cannot mix in one account-month (`mixed_sources`).
- A movement belongs to the month of its own date; a file's balance speaks for a month only if the file lies wholly inside it; files must chain; a typed month-end closing applies only where no file prints one.
- Entries offered for a movement: same amount to the sen, same direction, within 7 days, never already claimed; proposed, not applied. Auto "obvious" match needs exactly one such entry whose names agree.
- Group match is several movements → one entry or one → several (`one_side_only` otherwise), totals equal to the sen (`amount_mismatch`); undo reopens every movement in the group.
- One entry is claimed at most once per bank account (a transfer once on each bank); a line may name several entries (`jeNosOf`); claims count only from POSTED lines.
- A month locks only when a statement is filed, nothing is undecided, it is covered end to end, a closing balance exists and it tallies (`not_tallied`); there is no reason override.
- A closed month refuses booking, matching, ignoring, undoing and uploads with a movement dated inside it; a failed lock read refuses. It is not a GL period close.
- Card decisions on OPEN lines are recomputed on every read (`freshDecisions`); POSTED and IGNORED lines keep what they were booked as.

Reports
- Every reader counts only posted entries on neither side of a reversal pair (`acc/reversal-pairs.ts`): statements, R&P, GL, Daily Bank, bank ledger, `scm.v_account_balances`.
- Statements classify accounts by section; the balance sheet prints its own difference, never absorbs it.
- Report layouts (`scm.acc_report_layouts`) are presentation only: the section still decides the block; one tree per report for all companies with per-company hiding; unplaced accounts print under Unassigned so a total equals what is printed.
- Cash Flow (`rp`) is one directed tree (`layOutCashFlow`): every top category is In or Out and prints with its own subtotal name (`totalLabel`); an account line carries a flow (In, Out, Net = in − out) so one account may sit twice, once per direction, and an Out line under an In category prints negative; a `subtotal` item at the top level is the running sum of everything above it, In less Out; unassigned receipts and payments print as their own groups last; Cash Surplus / (Deficit), Balance b/f and Balance c/f close the report. A stored tree with no direction marks is read as RECEIPTS (In) / PAYMENTS (Out), so the report reads as before until it is rearranged in the Layout editor (the side of a top category, a line's direction, a category's subtotal name, subtotal rows, spares offered per side).
- The P&L and the Performance P&L `expenses` block was seeded with the Cash Flow tree's own expense groups (`backend/scripts/seed-pnl-layout.mjs` over `backend/scripts/lib/pnl-tree.mjs`, 2026-09-19: Cost of funds → Transport & logistics / Commission; Exhibition (Houzs only); Showrooms; Warehouse (Houzs only); General expense → Salary / Rental / Homestay / Marketing / Professional / Office & admin; Finance cost — one rule table with the Cash Flow, `groupOf`); every other block stays the chart's own. Plan by default, `CONFIRM` on apply, a re-run replaces the editor's changes.
- Figures print positive; parentheses only where credits beat debits in the period; never a minus inside brackets (`fmtSenParen`).
- By-month columns are one call each to the report's own endpoint; nothing is stored. A cell with nothing prints a dash in both slots; an account's lines open under their own month (the name opens the range, a month's figure that month alone), read from the ledger endpoint; rows are dashed, lit on hover, the name column frozen; total and subtotal rows shaded apart from the account rows, an opened account's lines shaded lighter, cut at the column's width, their figures under the amount slot. Every Finance report prints money as `1,234.56` / `(1,234.56)` with no RM prefix (`fmtSenPlain`, one home for the four). Every Finance report (P&L, Balance Sheet, Cash Flow, Performance P&L, each By month too) exports Excel and PDF that mirror the screen through one sheet (`frontend/src/vendor/scm/lib/report-sheet.ts` → `report-sheet-xlsx.ts` / `report-sheet-pdf.ts`): the same columns, the lines at the level chosen, amounts or %, the same shades; amounts are numbers in Excel with the bracketed-negative format; on paper a % rides BESIDE its amount (small, grey — owner 2026-09-20), and the page grows with the table (A4 portrait ≤ 4 figure columns, A4 landscape ≤ 8, A3 landscape beyond).
- Performance P&L: sales and cost from sales orders by SO date (not DRAFT/CANCELLED); expenses from the ledger with the company's operating-expense account replaced by its rate of non-service sales.
- Daily Bank reads the ledger live; settlement-in-transit is shown but never movable; draft vouchers awaiting approval come off the available figure.

Process and UI
- Merchant and bank reconciliation changes are tested by the owner locally before merge.
- Server refusal sentences stay under 200 characters; curated codes (`payment_edit_locked`, `already_on_report`) are listed in `SERVER_SENTENCE_WINS`.
- The Accounting page has no tab strip: tabs are `/scm/accounting?tab=<name>` from `accounting-tabs.ts`, reached from the sidebar; a new report joins Reports, a maintenance screen joins Setup.
- Accounts display as code over name (`AccountCell`). Desktop only; no mobile surface.
- Endpoints: see `docs/generated/route-capability-matrix.csv`.

## Gotchas

- Reading `companies` on the scm-pinned client wrote no journals for days — always `sb.schema('public')`.
- Finance routers without their own `supabaseAuth` failed in production while harness tests passed — declare it on every new router.
- Payment inserts that skipped the hook never reached the books — use `bookSoPaymentBestEffort`; run the Self-check dry run (`POST /accounting/backfill/customer-payments {dryRun: true}`) before backfilling.
- Selecting columns `mfg_sales_orders` lacks passes the fake client — use `debtor_name` / `phone`; `soPaymentOrderColumns.test.ts` pins the selects.
- A route's response shaping dropped a computed field — assert the route reply, not only the library.
- A source type the control check does not know shows as foreign lines — add every new source type to its control's family.
- `CREATE TABLE IF NOT EXISTS` on a taken name is a silent no-op — choose a new name.
- Writing an enum column from a CASE of text literals fails (42804) — type each branch as the enum.
- Backfill contras dated on the run day overstated earlier months — pass the original entry's date.
- Counting an unconfirmed settlement link as reconciled locked correctable payments — lock only on a confirmed line.
- A fee account left on an inactive code refused every confirm unnoticed — setup offers only postable leaves and names a bad one.
- Candidate reads bound to the date window missed late-keyed payments — fetch references regardless of date; Find the sale searches everything.
- Batch detail reading only `candidates` / `suggested` showed matched lines as unexplained — fall back to `matched`; refuse an upload whose row insert returns fewer ids.
- Untagged payments walked per acquirer were counted once per merchant — list them once.
- Bank Undo left match rows behind and blocked re-matching — undo deletes them.
- The lock and the screen built different match indexes and disagreed — both use `matchesByLineOf`.
- Trial balance summed both sides of reversal pairs and drafts — filter lines before the join.
- Bank rows seeded state on mount and ignored the matcher's fresh decision — key rows on the decision (`decisionKey`).
- Header detection that read only active children let a header take postings — count retired children too.
- `fetchMonthlyDocNos` reading whole rows minted -001 twice — read the named column.
- DateField on touch: `showPicker()` from onClick is dead on iOS and a full-field overlay blocks typing — keep the native date input on the icon only.
- A card settlement confirm moves money keyed under no bank or the wrong bank: one `SETTLEMOVE` line per clearing account the payment debited, into the merchant's own clearing account (`clearingMoveLinesFrom`, `backend/src/acc/rules.ts`), and it corrects the payment's `merchant_provider` with an `UPDATE_PAYMENT` history line.

## Where the code is

- `backend/src/acc/engine.ts`, `backend/src/acc/rules.ts` — posting gate, rule table, `CONTROL_ROLES`, `apControlRole`.
- `backend/src/acc/payments.ts`, `payment-repost.ts`, `payment-reconciled.ts`, `payment-drift.ts`, `payment-corrections.ts` — customer payments.
- `backend/src/acc/settlement.ts`, `settlement-parse.ts`, `settlement-match.ts`, `payout-advice.ts`, `payout-charge.ts` — merchant reconciliation.
- `backend/src/acc/bank.ts`, `bank-parse.ts`, `bank-parse-pdf.ts`, `bank-match.ts`, `bank-month.ts`, `bank-lock.ts`, `bank-reconcile.ts` — bank reconciliation.
- `backend/src/acc/credit-notes.ts`, `deposit-invoices.ts`, `deposit-refunds.ts`, `receipts.ts`, `item-group-split.ts`, `stock-close.ts`, `daily-close.ts`, `daily-bank.ts`.
- `backend/src/acc/journal-refs.ts`, `journal-class.ts`, `reversal-pairs.ts`, `report-layout.ts`, `performance-pnl.ts`, `masters-company.ts`, `bill-extract.ts`.
- `backend/src/scm/routes/accounting.ts` (mounts the rest) plus `accounting-chart.ts`, `accounting-reports.ts`, `accounting-rp.ts`, `accounting-ledger.ts`, `accounting-journal-edit.ts`, `accounting-settlement.ts`, `accounting-bank.ts`, `accounting-bank-months.ts`, `accounting-bank-locks.ts`, `accounting-bank-config.ts`, `accounting-item-groups.ts`, `accounting-pi-backfill.ts`, `accounting-stock-close.ts`, `accounting-numbering.ts`, `accounting-receipts.ts`, `accounting-collection.ts`, `accounting-merchant-charges.ts`, `accounting-performance.ts`, `accounting-report-layouts.ts` (same folder).
- `backend/src/scm/routes/ap-invoices.ts`, `ap-invoice-files.ts`, `other-debtors.ts`, `receipts.ts`, `credit-notes.ts`, `deposit-invoices.ts`, `so-money-routes.ts`.
- `backend/src/scm/lib/so-payment-row.ts`, `so-money.ts`, `post-si-revenue.ts`, `auto-final-invoice.ts`, `si-from-do.ts`, `account-sections.ts`, `doc-no.ts`, `doc-files.ts`, `ap-invoice-settlement.ts`, `so-payment-reason.ts`; `backend/src/scm/shared/so-field-policy.ts`.
- Mounts and area map: `backend/src/scm/index.ts`, `backend/src/scm/lib/scm-areas.ts`.
- `frontend/src/pages/scm-v2/Accounting.tsx`, `accounting-tabs.ts`, `JournalEntries.tsx`, `JournalEntryCards.tsx`, `GeneralLedger.tsx`, `Reports.tsx`, `ReportLayoutEditor.tsx`, `ReportLayoutTree.tsx`, `MonthlyReport.tsx`, `PerformancePnl.tsx`, `ReceiptsPayments.tsx`, `CollectionReport.tsx`, `MerchantChargesReport.tsx`, `PaymentCorrectionsTab.tsx`, `CancelledWithMoneyCard.tsx`, `ItemGroups.tsx`, `PiBackfill.tsx`.
- `frontend/src/pages/scm-v2/ChartOfAccounts.tsx`, `ApInvoices.tsx`, `ApInvoiceForm.tsx`, `OtherDebtors.tsx`, `Receipts.tsx`, `CreditNotes.tsx`, `DepositInvoices.tsx`, `OfficialReceipts.tsx`, `DailyBank.tsx`.
- `frontend/src/pages/scm-v2/MerchantRecon.tsx`, `PayoutAdviceTab.tsx`, `BankRecon.tsx`, `BankStatementTab.tsx`, `BankMonthTab.tsx`, `bank-reconcile-pick.tsx`, `SettlementSetup.tsx`, `settlement-queries.ts`, `bank-queries.ts`.
- `frontend/src/vendor/scm/lib/accounting-queries.ts`, `report-layout.ts`, `report-monthly.ts`; `frontend/src/vendor/shared/format.ts`; `frontend/src/components/Sidebar.tsx`.
