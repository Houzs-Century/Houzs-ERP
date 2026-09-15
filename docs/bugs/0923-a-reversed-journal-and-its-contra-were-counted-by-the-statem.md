## A reversed journal and its contra were counted by the statements, listed by the ledger and summed by the trial balance [high]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, after deleting a Sales Order keyed twice
(SO-2608-004): its RM 1,610 payment journal was reversed on 15 September, and
the contra (2990-JE-2609-0088) read as −RM 1,610 of September sales on the
P&L, as a September payment on the receipts & payments, and as two entries on
the General Ledger tab. His rule: 「照理就是对冲掉，所以都不应该显示，je 可以留记
录就好」— a reversed journal and the contra that undid it are one correction;
the journal keeps both, the books show neither, whatever month either is
dated in.

**Root cause (traced).** Every reader drew its own line, and each drew it
somewhere else. `loadSums` in
`backend/src/scm/routes/accounting-reports.ts` (the P&L, the balance sheet
and, through it, the Performance P&L) skipped `reversed === true` — the
flagged ORIGINAL — and counted the contra, which carries `reversed = false`
and only `reversed_by_je`, in the contra's own month. `live()` in
`backend/src/scm/routes/accounting-rp.ts` did the same. `GET /accounting/gl`
in `backend/src/scm/routes/accounting.ts` returned both sides (migration
0290, owner 2026-08-13: show both, let them net). `scm.v_account_balances`
(the Trial Balance) put `j.posted = true AND j.reversed = false` in the ON
of a LEFT JOIN while summing the lines, so it counted BOTH sides of every
pair and every unposted draft — migrations 0290 and 0306 both recorded that
and left it for the owner. Measured on 2990 HOME before the fix: 65 pairs,
14 draft lines, 28 accounts with a gross no statement carries (330-0000
read Dr 194,438.70 / Cr 194,438.70 against Dr 137,524.10 / Cr 137,524.10
in the books). Only the bank reconciliation (`loadAccountLedger` in
`backend/src/acc/bank.ts`) already skipped both sides (docs/bugs/0802).

**Fix.** One predicate, `backend/src/acc/reversal-pairs.ts` —
`isReversalPair` (either side: `reversed` or `reversed_by_je` set) and
`countsInTheBooks` (posted, and on neither side) — read by every ledger
reader:

- `loadSums` (P&L, balance sheet, Performance) and the receipts & payments
  select `reversed_by_je` and count only what `countsInTheBooks` admits;
- `GET /accounting/gl` (now `glStreamHandler`) leaves both sides out unless
  asked with `showReversed=1`, and the General Ledger tab
  (`frontend/src/pages/scm-v2/Accounting.tsx`, `GlTab`) gains the tick
  "Show reversed entries" — off by default, and when on a Reversal column
  marks each row `reversed` or `contra` (`reversalSideOf` in
  `frontend/src/vendor/scm/lib/accounting-queries.ts`);
- `GET /accounting/daily-bank` (now `dailyBankHandler`) counts neither
  side, so the board agrees with the reconciliation's ledger;
- the bank reconciliation reads the same helper;
- migration
  `backend/src/db/migrations-pg/20260915T1400_acc_account_balances_count_the_books.sql`
  replaces `scm.v_account_balances` in place (columns unchanged): the lines
  are chosen BEFORE the outer join — posted, `reversed = false`,
  `reversed_by_je IS NULL` — so the Trial Balance counts the books and
  nothing else, and an account with no lines still reports zero. Verified on
  staging: every account's totals equal the sums over posted, pairless lines.

The journal list keeps its REVERSED mark and both entries still open — the
record is not touched.

Proved RED on main's source: `backend/tests/accountingReports.test.ts` (the
September contra read as −1,610 of sales; the bank at 30 September carried
its leg), `backend/tests/rpReport.test.ts` (the contra of the reversed
voucher was a receipt and a row), `backend/tests/glStreamSkipsReversalPairs.test.ts`
(the handlers were not exported; the stream and the board counted the
pair); `backend/tests-pg/accountBalancesCountTheBooks.pg.test.ts` seeds a
pair and a draft, proves 0306's view counts them, applies the migration on
top and proves the column shape unchanged and the totals right;
`frontend/src/pages/scm-v2/GlTabReversed.test.tsx` and
`frontend/src/vendor/scm/lib/accounting-queries-gl.test.tsx` (the tick,
the mark, the wire). Green after.

**Ref.** acc/reversed-pairs-hidden, 2026-09-15.
