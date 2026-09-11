## Undo kept the entry claimed, a monthly statement covered one day, and earlier months' unmatched entries vanished from the list [medium]

<!-- area: Accounting + GL -->

**Symptom.** Three things on 2990's April Hong Leong statement, 2026-09-11.
(1) The owner matched six payments to their vouchers, then undid them: the
screen went red — *"These numbers do not add up — the difference of 310168
sen does not equal what is unmatched on either side (-206163 on the bank,
3589832 in the books, 288329 brought forward)"* — and the six could not be
matched again. (2) Every one of the statement's fifteen movements is dated
the 30th, so the period read `2026-04-30 → 2026-04-30`; the two vouchers
posted on the 28th (HPV-2604-005 TNB, HPV-2604-006 Air Selangor) were
offered on lines 4 and 5 but were not on the *"In the books, not on this
statement"* list, which held only the 30th's two entries. (3) That list
named entries by number and source only — 「我要看到 payment detail，例如 pay
to who」— and it never showed an earlier month's entry still waiting for the
bank — 「之前 in book 还没有 recon 的也要带下来，因为可能下个月才过钱」.

**Root cause (traced).** (1) `bankLineUndo` (`backend/src/scm/routes/accounting-bank.ts`)
put the line back to OPEN and cleared `posted_je_no` but never deleted its
row in `acc_bank_statement_matches`; prod held six such rows (match ids
2–7 on lines 6–11, all OPEN). The reads took a line's entry from
`posted_je_no ?? matches[0].je_no` regardless of state, so the ledger side
still counted the six entries as claimed while the bank side counted six
open movements — the identity cannot hold — and the unique index
`acc_bank_je_once` refused every re-match. (2) `parseBankStatement` sets a
statement's period to its first and last movement date; for a monthly
statement whose movements all fall on one day, that is one day, and the
detail compared the books over that one day. (3) The unmatched list was
windowed to the period by construction, `loadAccountLedger` never read
`party_name`, and — found on the way — it never skipped a REVERSED entry or
its contra, so a correction appeared as two entries "in the books, not on
the bank" and both were offered as candidates.

**Fix.** *Undo lets go.* `bankLineUndo` deletes the line's match rows.
`bankLineMatch` first clears any row on that `je_no` whose line is no longer
POSTED (the rows an older undo left — prod's six clear themselves the next
time each entry is matched), then inserts. Every read — the statement detail,
the month detail, `loadMonthForLock` — counts a claim only from a POSTED line.

*The month a dated statement covers.* Naming the month in the **Year and
month** box for a file that prints full dates now says the file is that
month's statement: period = the 1st to the last day, so the books are
compared over the same days; each movement keeps its own date (bank-month
rule 1), and one dated outside the named month refuses the file
(`month_mismatch`, naming the date). Without the box the period is still the
days the file carries.

*Carried, and who.* `reconcileBankStatement` gains `carried` (entries posted
before the period that no statement — this one or any other of the account —
has claimed, and that are not older than the first statement ever filed for
the account, before which nothing was reconciled here), `clearedFromBeforeSen`
(earlier entries a movement on THIS statement claims — the cheque that
cleared this month), and `broughtForwardExplained` (the brought-forward is
exactly those two). The identity carries the new term:
difference = bank-not-in-books − books-not-on-bank + brought forward + cleared-from-before.
`loadClaimedElsewhere` / `claimedSetFor` (`acc/bank.ts`) supply what other
statements claimed. The ledger read now carries `party_name` and skips both
sides of a reversal (`reversed` or `reversed_by_je` set). The detail and the
month routes list unmatched entries with `carried` and `partyName`; the
screens (`BooksNotOnBank`, shared by the file and month views) show a **Who**
column, a second section *"From earlier months, still not on any statement"*,
name the payee on candidate entries, and say when the brought-forward is
*"explained by N entries from earlier months"*. The printed statement gains
the Who column, an *"Add: still in the books from earlier months"* step, and
prints the brought-forward only for the part those entries do not explain.

Pinned by `bank-reconcile.test.ts` (carried counted and named; explained /
not / null; an entry claimed on this statement is cleared, not carried; one
claimed elsewhere is neither), `backend/tests/bankRoutes.test.ts` (match →
undo → matches empty, identity consistent, re-match 200; a stale row on an
OPEN line ignored and cleared; a named month sets the period and a movement
outside it refuses; carried entries with who; an entry older than the first
statement is opening, not waiting; a reversal pair on neither list and not
offered; candidates name who), `BankStatementTab.test.tsx` (Who, the earlier
section, the explained brought-forward, the candidate's payee, the month-box
sentence) and `bank-reconciliation-pdf.test.ts` (Who column, the carried
section). Proved RED on the unfixed tree (12 + 5 failed), then GREEN.

**Ref.** acc/bank-match-freely, 2026-09-11.
