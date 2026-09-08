## Merchant recon watchlist and in-transit listed an untagged card payment once per acquirer [medium]

<!-- area: Accounting + GL -->

**Symptom.** The owner, 2026-09-08, on Merchant reconciliation the morning the
per-bank clearing accounts (#3109) went live: the same four orders
(2990-SO-2606-009 / 011 / 012 / 013, paid 2026-06-14) sat under GHL and again
under HLB with the same amounts and approval codes, and further down under MBB
and PBB too. "Card payments no merchant report has reported yet" counted 254
and RM 749,724.00; prod holds 125 such payments worth RM 326,994.00. The
in-transit list on Bank reconciliation, its total and its ageing table did the
same.

**Root cause (traced).** `settlementWatchlist` and `settlementInTransit`
(backend/src/scm/routes/accounting-settlement.ts) walk the active acquirers,
call `loadPaymentCandidates` for each and push every candidate with THAT
acquirer's code. `couldBeAcquirers` (acc/settlement.ts) deliberately hands a
payment tagged with NOTHING to every acquirer's pool — that is what lets any
statement find it — so 2990's 43 untagged instalments came back four times,
once per active merchant, and the in-transit ageing keyed each copy under a
different acquirer. Seen in prod by read-only SQL: 43 `installment` rows with
`merchant_provider` NULL, four active acquirers; 82 tagged + 43 × 4 = 254.

**Fix.** `listOnce` (acc/settlement-match.ts) lists a tagged payment under its
acquirer and an untagged one ONCE, under no acquirer (`acquirerCode: null`; the
in-transit ageing keys it `UNTAGGED_LIST` = 未标). Both routes use it, the
screens show the chip as 未标 and the watchlist says how many were keyed in
without a bank (MerchantRecon.tsx, BankRecon.tsx, settlement-queries.ts).
Matching, confirming and the stamp are untouched. Pinned by
`backend/tests/settlementRoutes.test.ts` "an untagged payment sits on each
watch list once, under no acquirer" — RED on the unfixed tree (`u1` came back
under an acquirer, and under both of them: `{ u1: 'MBB', p1: 'MBB' }` for the
watchlist), GREEN after — and by `settlement-match.test.ts` (the rule),
`MerchantRecon.test.tsx` / `BankRecon.test.tsx` (the chip and the counts).

**Ref.** fix/watchlist-untagged-once, 2026-09-08.
