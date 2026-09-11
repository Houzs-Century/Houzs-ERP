## What a card movement looks like was decided once at upload, so a credit stored as 'check which' stayed that way after the charge fix [medium]

<!-- area: Accounting + GL -->

**Symptom.** After docs/bugs/0812 shipped, 2990's June Hong Leong statement
still read line 25 — PBB's 8 June credit of RM 8,143.29 — as *"a card payout
— check which … 11 are still waiting"*, while the candidates under it now
showed the corrected figure (20260606 owed RM 3,024.18) and the three June
days plainly added up to the credit. The owner (2026-09-11): 「这个还是没有
修吗？」.

**Root cause (traced).** `bankUpload` runs `matchBankMovements` once and
writes the decision on the line — `kind`, `acquirer_code`, `trading_date`,
`merchant_no`, `matched_batch_id`, `split`, `note` — and the statement and
month details returned those columns as stored. Only `candidates` (and
`entryCandidates`) were recomputed on read, which is why the figures under
the line were right while the sentence above them was the one written on
2026-09-11 morning, before the charge was taken off what the report was owed.
June was uploaded before the fix; the fix could never reach it.

**Fix.** `freshDecisions` (`backend/src/scm/routes/accounting-bank.ts`): every
OPEN money-in line of a statement is rebuilt as a movement (amount and the
charge the upload joined) and run through the same `matchBankMovements`
against today's recognition rules, reports still owed and payment advices;
the statement detail and the month detail return the fresh `kind`,
acquirer, trading day, `matched_batch_id`, `split` and clue over the stored
ones. Nothing is written — the line on disk is what the upload said, the
screen is what is true now, and booking writes what the person confirmed. A
POSTED or IGNORED line is left as it was booked.

Pinned by `backend/tests/bankRoutes.test.ts` ("what a card movement looks
like is re-decided on every read": a credit uploaded as PAYOUT_UNSURE reads
as the advice's PAYOUT once the advice and the charge are in, on the
statement and the month views, while the stored row still says
PAYOUT_UNSURE; a movement already booked keeps what it was booked as).
Proved RED on the unfixed tree, then GREEN. The month detail route is now
mounted in that contract for the first time.

**Ref.** acc/bank-redecide-payouts, 2026-09-11.
