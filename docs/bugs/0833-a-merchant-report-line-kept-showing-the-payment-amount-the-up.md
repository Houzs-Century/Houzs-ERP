## A merchant report line kept showing the payment amount the upload had written down, not the one Finance had corrected since [low]

<!-- area: Accounting + GL -->

**Symptom.** Finance corrected a sales-order payment after the merchant
report that matched it had been uploaded (the 3,053 → 3,052 of
docs/bugs/0821). The Merchant Recon screen went on showing 3,053 beside the
line: the link written at upload time carried the amount as of then, and
nothing re-read it until confirm, which re-reads the payment and refuses a
selection that no longer adds up. Owner (2026-09-12), asked whether a refresh
was wanted: 要刷新功能，而且我希望是我打开自动刷新，而不是手动触发刷新.

**Root cause (traced).** `acc_settlement_matches.amount_sen` is a copy taken
at upload; the batch detail read the copy and never the payment.

**Fix.** `refreshUnconfirmedLinks` (`backend/src/acc/settlement.ts`), run by
`settlementBatchDetail` every time a report is opened: every UNCONFIRMED
line's links re-read their payment — the window's candidates first, a
payment outside the window by id — and a moved amount (or order number) is
written back to the link and named in the reply as `refreshedLinks` (line,
document, from, to), which the Merchant Recon page shows above the lines.
No button. Confirmed lines are the ledger's and are never touched; a payment
that is gone is left as it was, for confirm to refuse by name.

Pinned by `backend/tests/settlementRoutes.test.ts` ("an unconfirmed link
follows its payment": the corrected amount read back and named, nothing
named when nothing moved, a confirmed line left alone).

**Ref.** acc/settlement-link-refresh, 2026-09-12.
