## A report's 'owed' on the bank side ignored the payout charge Finance had booked, so the advice was distrusted and a three-day PBB credit could not be matched [high]

<!-- area: Accounting + GL -->

**Symptom.** 2990's June Hong Leong statement, line 25: PBB's credit of
2026-06-08, RM 8,143.29, read *"a card payout — check which. PBB paid RM
8,143.29, and no single report of theirs is owed that. 11 are still waiting"*,
with the 2026-06-06 report offered as *"owed RM 3,348.18"*. Public Bank's
advice of 8 June had already said what the credit was: trading days 5, 6 and
7 June — RM 1,916.57 + RM 3,024.18 + RM 3,202.54 = RM 8,143.29 — the 6 June
day RM 324.00 short of its report because the bank kept a terminal fee, which
Finance had booked on that advice day (docs/bugs/0787). The owner (2026-09-11):
「我不是给你 payment advice 了吗？… bank recon 这边只需要对 payment advice 罢了啊。
不是这样吗？」— and it is.

**Root cause (traced).** `loadPayableBatches` (`backend/src/acc/bank.ts`),
the one read of "what each reconciled report is still owed" that the bank
matcher and the bank screens use, took net less receipts and nothing else.
The charge booked on `acc_settlement_payout_batches.charge_sen` (0787) was
counted by `postBatchReceipt` and `loadBatchReceipts` on the merchant side,
but not here. So the 6 June report read as owed RM 3,348.18; the matcher's
advice check (`bank-match.ts`, `adviceAllocation`: an advice is trusted only
when each day it names equals that report's outstanding) saw 3,024.18 ≠
3,348.18 and threw the advice away; no single report equalled the credit; the
three-day combination summed to RM 8,467.29; and the line fell to
PAYOUT_UNSURE with the wrong "owed" beside it.

**Fix.** `loadPayableBatches` reads `acc_settlement_payout_batches (batch_id,
charge_sen)` too and takes the charge off: outstanding = payable − received −
charged, and a report the bank fully kept is off the list. Nothing else
changes: the advice for 8 June now lines up day for day, the matcher answers
PAYOUT_SPLIT with the three reports, and Money received books three receipts
(1,916.57 + 3,024.18 + 3,202.54) — the 6 June report then reads fully received,
credit plus charge, as `postBatchReceipt` already counts it.

Pinned by `backend/tests/bankRoutes.test.ts` ("a report the bank charged": a
report with a booked charge is owed its net less the charge and the advice
for that figure is trusted — kind PAYOUT, the report as the one candidate at
the reduced figure, the advice named in the clue; booking the credit posts
the receipt for that figure). Proved RED on the unfixed tree (the credit was
PAYOUT_UNSURE), then GREEN.

**Ref.** acc/bank-owed-charge, 2026-09-11.
