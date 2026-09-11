## The month lock counted an earlier entry as still outstanding when its bank line named it only in the match table, refusing a month the screen said tallied [high]

<!-- area: Accounting + GL -->

**Symptom.** 2990, Hong Leong, June 2026: the month panel read *Reconciled —
the books, allowing for 7 outstanding items, come to the bank statement's
closing*, RM 9,316.83 = RM 9,316.83, ✓ Tallies, 0 still to decide. "Close this
month" answered in red: *310-0020 2026-06 does not tally: the books, allowing
for the outstanding items, come to RM 54,316.83 and the bank statement says
RM 9,316.83 — RM 45,000.00 apart.* Owner (2026-09-11): 「什么意思？」.

**Root cause (traced).** May's RM 55,000 deposit of 7 May (statement 4, line
5) is two entries matched together (docs/bugs/0803): the RM 100,000 receipt
2990-JE-2605-0013 and the RM 45,000 rental 2990-JE-2605-0030 paid out of it.
The line's `posted_je_no` names the first; the second is a row in
`acc_bank_statement_matches` only (prod: one such line, reason `manual`).
`claimedOutside` (`backend/src/scm/routes/accounting-bank-months.ts`) takes
the lines outside the month AND their match rows; the month detail passed its
`matchesByLine`, the lock's `loadMonthForLock` passed `new Map()` — it had
read the match rows for the movements inside the month and indexed none of
them for the months before. So in the lock's reconciliation JE-2605-0030
(5 May, −RM 45,000) was an entry no statement had shown, carried into June:
computed closing = −5,121.33 + 14,438.16 + 45,000.00 = 54,316.83. Two readers
of one month, one of them reading half the sources.

**Fix.** One helper, `matchesByLineOf`, indexes the match rows; both
`loadMonthForLock` and `bankMonthDetail` use it, and the lock hands the index
to `claimedOutside` exactly as the detail does. Pinned by
`backend/tests/bankRoutes.test.ts` ("a month whose earlier entry is claimed
only by the match table": May's deposit matched to both entries, the line
left naming the first only as production's does, an empty June filed — the
month detail carries nothing and tallies at 5,800,000, and the lock answers
200 with the same closing figures). Proved RED on the unfixed tree (409
`not_tallied`), then GREEN.

**Ref.** acc/bank-lock-reads-matches, 2026-09-11.
