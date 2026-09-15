## An internal transfer's entry could be matched on one bank's statement only: the second bank was refused with one entry cannot account for two [medium]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, on the Maybank July statement: the RM 20,000
withdrawal of 08/07 ("MBB CT 2990 HOME SDN. BHD.") offered 2990-JE-2607-0088
— PV 2990-MPV-2607-001, the internal transfer Maybank → HLBB — and "This is
that entry" answered 「2990-JE-2607-0088 is already reconciled against another
movement on a bank statement. One entry cannot account for two.」 The entry
WAS already matched: on the HLB July statement, to the RM 20,000 "Instant
Transfer at KLM" deposit of the same day. 「什么意思？」— and, told why:
「这个要做」.

**Root cause (traced).** Both match routes in
`backend/src/scm/routes/accounting-bank.ts` — `bankLineMatch` and
`bankLinesMatchGroup` — read the match rows of the entry by `je_no` alone
and refused when any of them sat on a POSTED line, whichever statement that
line belonged to. An internal transfer is ONE journal with a leg on each
bank (Cr 310-0010 Maybank, Dr 310-0020 HLBB); each bank's statement shows
its own movement, and the reconciliation itself already reasons per account
(`loadClaimedElsewhere` reads one account's statements; the unique index has
been (company, je_no, bank_line_id) since docs/bugs/0803) — only the two
routes still counted the entry once across every bank. So whichever bank
was reconciled first won the entry, and the other bank's movement could
never be matched, its month never closed.

**Fix.** One entry, one claim PER BANK ACCOUNT. `liveClaimsOn` reads the
match rows of the entries with the bank account each claiming line sits on
(its statement's `account_code`), split into live claims (POSTED lines) and
the rows an older undo left behind (docs/bugs/0802). `bankLineMatch` refuses
a live claim by another movement of THIS bank by the bank's name
(`already_matched`, "…on 330-0000's statements. One entry cannot account for
two movements of the same bank."); a claim on another bank is the entry's
other leg and stands — and then the entry must have a line on this bank
(`entryOnAccount`; `not_this_account` names the bank it has no line on) so
a bank the entry never touches cannot claim it. `bankLinesMatchGroup` keeps
the same rule (its entries come off this account's ledger, so the leg is
known). Nothing changes for a second claim on the same bank, for the undo,
for the reconciliation or the lock.

Proved RED on main's route (the route file stashed, the tests kept): the
four tests in `backend/tests/bankMatchPerAccount.test.ts` (their own rig — `bankRoutes.test.ts` is at the 2,000-line cap) failed — the second bank
refused with the old sentence, the same-bank refusal without the bank's
name, the stranger bank allowed, the group match refused. Green after.

**Ref.** acc/bank-match-per-account, 2026-09-15.
