## The Sales Order list money strip ignored a customer-phone search [low]

**Symptom.** Searching the Sales Orders list by a customer's phone number
listed the matching orders, but the Revenue / Outstanding / Paid tiles above
them summed a different set — the orders whose other text fields matched —
because the tiles' search term had no phone arm. The number of orders and the
money beside it could disagree on the same screen (LIKELY observable only for a
search that matches on phone alone; not reproduced in a browser).

**Root cause (traced).** `GET /mfg-sales-orders` (paginated arm,
`backend/src/scm/routes/mfg-sales-orders.ts`) built its search predicate twice:
once on the page query, where #816 added `phoneSearchOrParts(...)`, and once in
`applyMoneyFilters` for `soListMoneyKpis`, a hand copy of the same `.or()` string
that #816 did not touch. Its own comment said "The SAME term as the page query".

**Fix.** Both reads now take ONE predicate set from `lib/so-list-read.ts`
(`prepareSoListRead(...).header`), which carries the phone arm and the
approval-code arm once; the line export reads through it too.

Pinned by `backend/src/scm/lib/so-list-read.test.ts`: the phone search finds an
order over the fake PostgREST, and the list handler's money strip is asserted to
be `read.header(moneyQ0)`. RED on the unfixed tree: the two wiring cases failed
(`expected ... to contain 'prepareSoListRead('`, and the money block did not
contain `.header(`).

**Ref.** feat/so-do-line-export, 2026-09-15.
