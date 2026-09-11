## A split payout's two entries were compared as one number, so the books and the bank did not add up by exactly the split [high]

<!-- area: Accounting + GL -->

**Symptom.** 2990's June Hong Leong statement (2026-09-11), seven card
payouts booked, 44 movements still to decide: *"These numbers do not add up —
the difference of 2558945 sen does not equal what is unmatched on either side
(-2675260 on the bank, -1817863 in the books, 2685690 brought forward =
1828293)"*. The gap, 730,652 sen = RM 7,306.52, is exactly line 33 (RM
3,590.38, PBB's advice paying two reports) plus line 47 (RM 3,716.14, the
same) — the two PAYOUT_SPLIT movements. The owner: 「这什么意思？」.

**Root cause (traced).** Booking a split payout writes one layer-3 receipt per
report — two journal entries — and `bankLineReceipt` stores them on the line
as `posted_je_no = "2990-JE-2606-0118, 2990-JE-2606-0119"`. Every reader then
treated that string as ONE entry number: the statement detail's movements
(`jeNo: l.posted_je_no`), the month detail's `jeOf`, `loadMonthForLock`'s
`asMovement`, `claimedOutside`, and `loadClaimedElsewhere`. No ledger entry
is called "A, B", so neither receipt was claimed: 0116, 0117, 0118, 0119
(RM 1,973.08 + 1,743.06 + 1,854.10 + 1,736.28 = RM 7,306.52) sat in "in the
books, not on the bank" while the bank side counted both movements as
posted — and the identity, correctly, refused to publish a difference.

**Fix.** `jeNosOf(value)` (`backend/src/acc/bank.ts`) reads every entry
number a line names — "A, B" is two — and each reader uses it: the detail's
movements carry all of them in `jeNos` (with any match rows), the month
detail, `loadMonthForLock`, `claimedOutside` and `loadClaimedElsewhere` claim
all of them. The reconciliation's claimed set was already the union of `jeNo`
and `jeNos` (docs/bugs/0803), so nothing changes there. Nothing is
re-written on the lines; June's statement reads consistent on the first
refresh.

Pinned by `backend/tests/bankRoutes.test.ts` ("the two entries a split wrote
are both claimed by the movement, so the books and the bank agree": book a
split, put its two receipts on the ledger view, and the detail's
`unmatchedJeNos` holds neither, `booksNotOnBank` is 0 and the identity is
consistent) — proved RED on the unfixed tree (both entries listed as
unmatched), then GREEN.

**Ref.** acc/bank-split-jenos, 2026-09-11.
