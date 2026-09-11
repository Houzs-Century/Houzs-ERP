## A merchant report's unconfirmed auto-match locked the payment it only suggested, and the refusal's reason was hidden behind the generic clash text [high]

<!-- area: Accounting + GL -->

**Symptom.** 2990, 2026-09-11: Finance corrected the card payment on
2990-SO-2607-012 from RM 3,053.00 to RM 3,052.00 (the PBB report's line 3,
ref 005805, is RM 3,052.00 — the RM 1 was a mis-key) and Save answered
*Failed to save changes — That clashes with something already in the system.
Please refresh and check.* Refreshing changed nothing. Owner: 「我改的时候出现
这个」.

**Root cause (traced).** Two faults in one refusal.

1. The July PBB report uploaded at 11:57 UTC matched line 3 to that payment
   by reference and, as every upload does for a MATCHED line, wrote an
   `acc_settlement_matches` link at once — `acc_settlement_rows` 31 still
   `confirmed_at null`, `posted_je_no null`, nobody had confirmed it.
   `paymentReconciliation` (`backend/src/acc/payment-reconciled.ts`) read the
   link and answered *matched on a merchant settlement report*, so
   `paymentMayChange` refused the amend right: `409 payment_edit_locked`.
   The link is the matcher's suggestion; the books had closed over nothing.
2. The refusal's sentence — *This payment can no longer be changed because it
   was matched on a merchant settlement report on 2026-09-11. Changing it
   would break a reconciliation already reported. Record a new payment, or
   raise a credit note.* — is 212 characters (bank kind 219, month kind 209).
   `humanApiError` (`frontend/src/vendor/scm/lib/authed-fetch.ts`) keeps a
   server sentence only under 200, and `payment_edit_locked` had no curated
   entry, so the refusal fell to the status catch-all. The server-side test
   allowed 240.

**Fix.** `paymentReconciliation` reads the settlement LINE behind each link and
answers `merchant` only when that line is confirmed (`confirmed_at`, or
`posted_je_no`), dated by the confirmation; the read fails closed. An
unconfirmed link leaves the payment correctable, and `confirmSettlementRow`
already reads the amount back from the row, so the correction is what
settles. `paymentReconciledMessage` (server and vendored copy alike) now reads
*This payment is locked: it was confirmed on a merchant settlement report on
2026-09-11. Undo that confirmation first, or record a new payment.* — under
200 with a date, an entry number or an account code inside — and
`payment_edit_locked` is curated in `authed-fetch.ts` as the floor and listed
in `SERVER_SENTENCE_WINS`, so the server's sentence is what the operator sees.

Pinned by `backend/src/acc/payment-reconciled.test.ts` (a link nobody
confirmed does not lock the payment; the day named is the confirmation's; a
posted line without the stamp still counts; the line read fails closed;
`paymentMayChange` opens a payment under a mere suggestion and refuses one
under a confirmed line — the one call both payment routes make, pinned as
such by `backend/tests/soPaymentAmendRoutes.test.ts`),
`soPaymentAmendRight.test.ts` and `so-field-policy.test.ts` (under 200), and
`authed-fetch.payment-locked.test.ts` (the server's sentence is shown; a
dropped one falls to a line about a locked payment, never the generic 409).
Proved RED on the unfixed tree, then GREEN.

**Ref.** acc/payment-gate-confirmed-only, 2026-09-11.
