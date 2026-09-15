## A card payment keyed under the wrong bank stayed on that bank's clearing account after the right bank's statement confirmed it, and the payment kept the wrong bank [medium]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, from the balance sheet as at 31/08/2026:
「card machine clearing 的 amount 看起来不太对」. On 2990: 326-0010 CARD
MACHINE CLEARING — PBB read RM 23,343.00 and 326-0040 — HLB read
(RM 3,384.00), a credit balance on an asset. Traced on prod (read-only):
SO-2608-013's RM 3,240.00 was keyed at the till as PBB, so its payment
entry debited PBB's clearing account; the money came through the HLB
terminal and was matched and confirmed on HLB's statement (row 67,
2026-08-10 ref 822776), whose payout was then cleared out of HLB's clearing
account — PBB RM 3,240 too high, HLB the same too low, and the Payments
card still said PBB. The other RM 1,499 of HLB's shortfall was THE CONTS
SDN BHD's loan repaid by card at the HLB terminal (payout 26/08), a payout
with no sale behind it; the rest of every clearing balance was money
legitimately in transit or not yet matched.

**Root cause (traced).** `moveUntaggedBooking` in
`backend/src/acc/settlement.ts` read the chosen payments' entries with
`.eq('account_code', generic)` — only money keyed WITHOUT a bank, sitting on
the generic 326-0000, was moved to the merchant's own clearing account (做 2,
2026-09-08). Money keyed under another bank sat on THAT bank's clearing
account and was never read. The stamp step wrote the acquirer onto a payment
only when `merchant_provider` was NULL ("a tag chosen at the till is not the
confirm's to change"), so the wrong bank stayed on the record.

**Fix.**

- **`backend/src/acc/settlement.ts`** — `moveUntaggedBooking` reads every
  clearing account of the company (the generic one and each acquirer's
  `transit_account_code` from `acc_acquirers`) and moves, in ONE `SETTLEMOVE`
  per line keyed `SETTLEMOVE-<row id>` and dated the settlement day, whatever
  the chosen payments debited on any of them but the merchant's own: one
  debit on the merchant's account, one credit per account the money leaves
  (`clearingMoveLinesFrom`, `backend/src/acc/rules.ts`; the narration names
  each move). Un-confirm reverses it as before. The stamp step corrects the
  payment: the merchant's statement outranks the till (owner: 要), so a
  payment keyed under another bank gets the acquirer as its bank, its
  account sheet following when it was the bank's own name (a hand-typed
  sheet is kept), with an `UPDATE_PAYMENT` line in the order's history
  (source `automation`: "Bank corrected by the HLB settlement match: PBB →
  HLB"); an untagged payment is stamped as before, a right one is untouched.
  The payment cannot be edited after confirmation (docs/bugs/0821), so the
  corrected tag never re-posts the entry the move already corrected.
- **`backend/src/db/migrations-pg/20260915T2200_acc_2990_clearing_repairs.sql`**
  — the two 2990 entries the old rule owed, on the owner's word: SETTLEMOVE-67
  dated 2026-08-10 Dr 326-0040 / Cr 326-0010 RM 3,240.00 (SO-2608-013, the
  entry the fixed confirm would have written), and the MANUAL entry dated
  2026-08-24 Dr 326-0040 / Cr 350-0010 RM 1,499.00 (THE CONTS SDN BHD, loan
  repaid by card at the HLB terminal; source_doc_no REPAIR-THECONTS-1499).
  Idempotent on source_doc_no, numbered next in the 2990-JE-2608 series.
  After both, as at 31/08/2026: PBB RM 20,103.00 (six payments not yet
  matched), HLB RM 1,355.00 (SO-2608-057, not yet matched), 350-0010 nil.

No new number series (the two entries take JE numbers the way any backdated
entry does).

Pinned by `backend/src/acc/settlement.test.ts`: money keyed on another bank's
clearing account moves too — one entry, one credit per account it leaves,
both wrong homes empty and the merchant's own holding the net after its fee;
the wrongly tagged payment is corrected with a history line and its sheet
follows when it was the bank name, a hand-typed sheet is kept, a right tag
writes nothing. RED before: the move read the generic account alone (the PBB
balance stayed), and the stamp left a tagged payment alone.

**Ref.** acc/settlement-transit-move, 2026-09-15.
