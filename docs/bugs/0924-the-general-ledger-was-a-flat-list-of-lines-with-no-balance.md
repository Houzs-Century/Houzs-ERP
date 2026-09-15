## The General Ledger was a flat list of lines with no balance brought forward, no running balance, no document reference and no way in from a statement [medium]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-14, holding an AutoCount ledger print against
the General Ledger tab: 「点开看明细其实就是看 general ledger … gl 显示的资料也要优
化」. The tab was one flat table of every line — no block per account, no
BALANCE B/F, no running balance, the source printed as a system word and a
key (`SOPAY · 0bb232ad-…`), no journal type, no other side — and a figure
on the P&L or the balance sheet led nowhere.

**Root cause (traced).** `GlTab` in `frontend/src/pages/scm-v2/Accounting.tsx`
drew `GET /accounting/gl` — the raw `v_gl_entries` stream — through the
generic DataTable; nothing in the system computed an opening balance, a
running balance or the other side of an entry, and the references the bank
reconciliation had learnt to name (docs/bugs/0918) were not on the ledger.

**Fix.**

- **`backend/src/scm/routes/accounting-ledger.ts`** — `GET
  /accounting/gl/ledger?from&to&accounts=a,b|fromAccount&toAccount&showReversed=1`
  (the statements' permission): one block per account in code order —
  BALANCE B/F (the counted lines before `from`, on the account's natural
  side: debit for assets and expenses, credit for the rest), the period's
  lines in date order each with its running balance, the block's totals,
  the grand totals. Each line names its journal type (`classifyJournal`),
  its other side (`counterOf`: the one other account, else the largest
  opposite account and how many more), Ref. 1 / Ref. 2 and the who off
  `resolveJournalRefs`, and the description off the line's note or the
  entry's narration. A reversal pair is neither listed nor counted
  (docs/bugs/0923); asked for, its lines are listed and marked but move no
  balance and no total. A wide scope reads the ledger once rather than
  send the codes down the URL.
- **`backend/src/acc/journal-refs.ts`** — `doc` (Ref. 1) and `doc2`
  (Ref. 2) beside `reference` and `who`: the receipt or the order for a
  payment; the voucher and what a refund refunds; the invoice and the
  supplier's own ref (PI / API); the document and its order (SI / DI / CN);
  "<acquirer> settlement dd/mm/yyyy" and the merchant's ref (SETTLE /
  SETTLEMOVE); "<acquirer> payout dd/mm/yyyy" and the bank ref (SETTLEBANK);
  "<acquirer> charge dd/mm/yyyy" (SETTLECHARGE); "Stock mm/yyyy" (STOCKADJ).
- **`frontend/src/pages/scm-v2/GeneralLedger.tsx`** — the tab
  (`/scm/accounting?tab=gl`): filters in the URL (period, picked accounts as
  chips or a code range, Show reversed entries), the blocks with the code
  over the name (`AccountCell`), Export (`ledgerCsv`,
  `frontend/src/vendor/scm/lib/ledger-queries.ts`) and Print
  (`ledgerTable` / `generateLedgerPdf`, `frontend/src/vendor/scm/lib/ledger-pdf.ts`)
  — both exactly the rows the screen shows.
- **点开明细** — a figure on the P&L or the balance sheet
  (`frontend/src/pages/scm-v2/Reports.tsx`, `LaidBlock` → `onPick`) opens
  the ledger on the row's accounts (`leafCodes`, `ledgerHref` in
  `frontend/src/vendor/scm/lib/report-layout.ts`) for the period — the
  balance sheet on the month of its as-of day, brought forward from before it.

The flat stream `GET /accounting/gl` and its hook stay for anything that
reads them. No migration, no new number series.

Proved RED on main's source: `backend/tests/glLedger.test.ts` (no handler to
import), `backend/src/acc/journal-refs.test.ts` (no `doc` / `doc2`),
`frontend/src/pages/scm-v2/GeneralLedger.test.tsx` and
`frontend/src/vendor/scm/lib/ledger-queries.test.ts` (no module),
`frontend/src/pages/scm-v2/Reports.test.tsx` (a figure opened nothing). Green
after.

**Ref.** acc/gl-page, 2026-09-15.
