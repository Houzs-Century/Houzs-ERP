## The journal list showed one flat row per entry with no lines, and the SO-create deposit rows were recorded with no official receipt [medium]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-14, from his AutoCount screenshots (the reports
queue, item 4): the Journal Entries list — 660 rows, one flat row per
entry (number, date, source, doc, totals, status) — should read the way
AutoCount's journal does, 「group lines under their JE — date/JE/Ref/
Description once, then the account lines」; today every line meant opening
the entry. And, found while planning the receipt backfill: every payment
path was meant to birth an Official Receipt (GL redesign item 9), but the
two SO-create inserts did not — 12 payments recorded at SO create since
2026-09-05 had none, while the same money keyed on the Payments card did.

**Root cause (traced).** `GET /accounting/journal-entries`
(`journalEntriesList`, `backend/src/scm/routes/accounting.ts`) read the
lines only to classify the journal and returned headers; the Journal tab in
`frontend/src/pages/scm-v2/Accounting.tsx` rendered them through the flat
`DataTable`. The receipt was born in `recordSoPaymentRow`
(`backend/src/scm/lib/so-payment-row.ts`) — the Payments-card path — while
the POS deposit and split-payment inserts at SO create
(`backend/src/scm/routes/mfg-sales-orders.ts`) reach only
`bookSoPaymentBestEffort`, the hook that books and issues the deposit
invoice.

**Fix.**

- **`backend/src/scm/routes/accounting.ts`** — `?withLines=1` on the list:
  the same one lines read carries the whole line (line no, account, debit,
  credit, party, note), each entry gets its lines in order and the GL page's
  references (`doc`, `doc2`, `who` — `backend/src/acc/journal-refs.ts`); the
  plain list is unchanged.
- **`frontend/src/pages/scm-v2/JournalEntries.tsx`** (new; `JournalTab`,
  mounted by `Accounting.tsx` in place of the flat table; hook
  `useJournalEntriesGrouped` in
  `frontend/src/pages/scm-v2/accounting-phase1-queries.ts`) — one group per
  entry: the head row once (date, number, journal, Ref. 1, Ref. 2, narration
  with the party, totals, status), then one row per line with the account as
  code over name, the party, the note, debit or credit. Reversed entries and
  their contras stay listed and marked. Filters in the URL (`from`, `to`,
  `source`, `journal`; default this month), the five journal chips, a search
  box that reads the lines, Export CSV (one row per line). Tapping a head
  opens the entry's card — Post / Reverse / Copy / Edit as before.
- **`backend/src/scm/lib/so-payment-row.ts`** — the receipt is born in
  `bookSoPaymentBestEffort`, beside the booking and the deposit invoice, so
  every path that records a sales-order payment receipts it: the Payments
  card, the scan job, both SO-create inserts. Best-effort as before; a
  converted row gets none (it was receipted when the money was first
  received). No line added to `mfg-sales-orders.ts`.

The 12 SO-create payments without a receipt, like the rest of history, are
the backfill's — the next step, on the owner's word after the number ranges
are reported.

No migration, no new number series (the receipts take the next numbers of
their series, as any recorded payment does).

Pinned by `backend/tests/journalClasses.test.ts` (`?withLines=1`: lines in
order, Ref. 1 the document, Ref. 2 the supplier's own number; the plain list
carries neither), `frontend/src/pages/scm-v2/JournalEntries.test.tsx` (the
groups, the marks, the URL filters, the chips and the search, the card, the
CSV, the states) and `backend/tests/receiptBornInHook.test.ts` (a card row
from SO-create births a DRAFT, cash a FORMAL, the same row again finds it, a
converted row none). RED before: the list had no lines, the page did not
exist, the hook birthed nothing.

**Ref.** acc/journal-grouped, 2026-09-15.
