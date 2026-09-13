## One confirmed merchant link kept the amount Finance had corrected away [low]

<!-- area: Accounting + GL -->

**Symptom.** On Merchant reconciliation, PBB's 2026-07-12 line (ref 005805)
shows its linked payment, 2990-SO-2607-012, as RM 3,053.00; the payment
itself, and the books, say RM 3,052.00. Owner 2026-09-13, shown the RM 1.00:
可以 (to a one-row correction).

**Root cause (traced).** Finance corrected the payment on 2026-09-11
(docs/bugs/0821: 3,053 → 3,052, JE-2607-0127 reversing 0126). The link row
(`scm.acc_settlement_matches` id 65) had been written at upload with the
amount as of then, and the line was confirmed the same day (JE-2607-0128).
#3723 (docs/bugs/0833) then made the report re-read every UNCONFIRMED link's
payment when it is opened — and, by design, never touches a confirmed one:
a confirmed link is the ledger's record of what was reconciled. This link
was confirmed before that rule landed, so nothing ever re-read it. The fee
and the posting are right (they come off the report's own line); only the
link's displayed amount is stale.

**Fix.** Migration
`backend/src/db/migrations-pg/20260913T1700_acc_settlement_link_so_2607_012_amount.sql`:
one data row — the link's `amount_sen` becomes 305200, guarded on the
payment id, the document number and the stale value, so it is a no-op
anywhere the row already reads right; verified on staging (the same row,
same values). No code change: the refresh rule stays as 0833 set it, and a
confirmed link that ever needs correcting again is corrected this way, by a
named row, not by code rewriting the ledger's record.

**Ref.** acc/settlement-link-so-2607-012-amount, 2026-09-13.
