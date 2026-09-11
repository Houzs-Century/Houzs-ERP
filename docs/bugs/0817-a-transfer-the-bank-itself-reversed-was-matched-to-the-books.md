## A transfer the bank itself reversed was matched to the books' entry by amount and name, and the reversal was left for a hand [medium]

<!-- area: Accounting + GL -->

**Symptom.** 2990's June Hong Leong statement, 04/06/2026: an instant transfer
of RM 2,872.75 to the company's own Alliance account (line 14, reference
…OCB02763120) failed, and the bank put it back the same day as *CIB Instant
Transfer Reversal* under the same reference (line 20); a second transfer
under a fresh reference went through (line 18, …OCB03546681). After "Match
the obvious ones now", line 14 — the transfer that never happened — read
*posted · 2990-JE-2606-0058 · matched by amount and name*, while line 18 and
line 20 sat under "Still to decide" with only "Not ours to reconcile" to
press. Owner (2026-09-11): 「这两笔是 contra 的，bank transaction fail」.

**Root cause (traced).** The amount-and-name rule of docs/bugs/0812's
neighbour, docs/bugs/0814, knows a movement, an entry and a name; it does not
know the bank had already undone the movement. Line 14's text carried
*Alliance*, the voucher's payee carried *ALLIANCE*, one candidate — matched
(`acc_bank_statement_matches` row of 08:54 UTC, reason `amount+name`). Line
18's text ("2990 Fund Tranfer") named nobody the voucher names, and by then
the voucher was claimed anyway. No code read the bank's own reversal, which
names, by reference, the one line it cancels.

**Fix.** `bankReversalPairs` (`backend/src/acc/bank-match.ts`): a movement
whose description carries the bank's word *Reversal* is paired with the
earliest unpaired movement of the same statement carrying the same reference
(spacing and case forgiven, blank never), the opposite amount to the sen, and
a day no later. `applyObviousMatches`
(`backend/src/scm/routes/accounting-bank.ts`) runs it BEFORE the
amount-and-name rule, on upload and on demand: both halves go IGNORED naming
each other (`note` "Reversed by the bank on line N" / "Bank reversal of line
N", and `contra_line_id` each the other's id — migration
`20260911T1900_acc_bank_line_contra.sql`), the reply says `contraPairs`, and
neither half is offered an entry, so the voucher stays for the retry. A
POSTED half is somebody's decision and is left alone until that match is
undone. `bankLineUndo` reopens both halves of a pair (`linesReopened: 2`),
clearing the note and the link. The screen says how many pairs left, on
upload and under "Match the obvious ones now".

Pinned by `backend/src/acc/bank-match.test.ts` ("a movement the bank itself
reversed") and `backend/tests/bankRoutes.test.ts` ("a transfer the bank
itself reversed": on upload the pair is out and the voucher is the retry's
candidate, the statement tallies and the month locks once the retry is
matched; a statement up before the rule — the wrong match undone, then the
rule takes the pair; undo of either half reopens both). Proved RED on the
unfixed tree, then GREEN. `BankStatementTab.test.tsx` pins the count under
the button.

**Ref.** acc/bank-reversal-contra, 2026-09-11.
