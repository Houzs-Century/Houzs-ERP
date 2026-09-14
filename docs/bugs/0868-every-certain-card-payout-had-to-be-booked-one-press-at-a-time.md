## Every certain card payout had to be booked one press at a time [low]

<!-- area: Accounting + GL -->

**Symptom.** On a Hong Leong July statement the Still to decide table was
row after row of card payouts, each already saying "a card payout, matched
— RM X is exactly what 2990HOMESB_CSV_….csv is still owed", each with its
own **Money received** button. Owner 2026-09-14: 这些我还需要自己确定吗？ It was
yes: the matcher decides which report a payout is, and booking the money —
Dr bank / Cr settlement-in-transit, the report leaving Money to come in — is
a person's press, one row at a time. Nothing was wrong on any row; there
were simply many of them and nothing to choose on any.

**Root cause (traced).** The matcher's certainty (docs/bugs/0814: kind
PAYOUT with the matched report owed exactly the credit) was shown on the row
but never used to save the press. The only bulk control on the table was the
group-match tick (docs/bugs/0803), which is for several movements that are
ONE entry, not for many movements that are each their own.

**Fix.** `frontend/src/pages/scm-v2/BankStatementTab.tsx` — `BookAllMatched`,
rendered at the top of the Still to decide table on both the file screen and
the month (the month reuses `OpenLines`). A CERTAIN payout is an OPEN line of
kind PAYOUT whose matched report's outstanding equals the credit; the button
**Money received — all N matched payouts** posts each such row through the
row's own door (`useBookBankReceipt`, the row's own allocation), one by one,
so what is booked is exactly what the row would have booked. The server
judges each again (a closed month, a report paid meanwhile); a refusal is
named with the line and the amount and the rest still post. A split, an
unsure or an unmatched payout is not certain and stays for a person. No
server change.

Pinned by `frontend/src/pages/scm-v2/BankStatementTab.test.tsx` (the count,
the row's own allocation, the split and the plain movement left alone, a
refusal named while the others post, nothing offered when none is certain)
and `BankMonthTab.test.tsx` (offered on the month).

**Ref.** acc/bank-book-all-matched, 2026-09-14.
