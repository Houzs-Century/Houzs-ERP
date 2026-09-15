## The fabric search capped at 50 before hiding retired and disallowed colours, so allowed ones never showed [high]

<!-- area: Sofa, fabric, variants -->

**Symptom.** The owner, 2026-09-14, on the phone fabric sheet fix (#3838):
「这个之前也有到问题 然后很多次导致他们选不到fabric」 — this area has repeatedly
left staff unable to pick a fabric. A salesperson typed part of a fabric code
and the picker came back short or said nothing matched, while a colour they sell
existed further down the list.

**Root cause (traced in the source).** `GET /fabric-colours?q=` in
`backend/src/scm/routes/fabric-colours.ts` put the typeahead cap in the query
(`q = q.limit(limit)`, 50 from both pickers) and ran the on-offer rules on what
the cap let through: retired fabric series (0816), retired fabric codes (0818).
The desktop combobox (`SoLineCard.tsx`) and the phone sheet
(`MobileFabricPicker.tsx`) then filtered those at most 50 rows again by the
Model's fabric pool (0814, 0889). So any search whose first 50 matches, in
`sort_order`, were retired or outside the Model's pool lost the allowed colours
behind them, which the query never read. Three earlier fixes each added a filter
after the same cap.

Scope, measured read-only on production 2026-09-14 (workflow
check-allowed-options-vocabulary, run 34831123278): company 1's 392 Models carry
no fabric restriction, so only the retired-series and retired-code rules could
crowd a Houzs search; company 2 has Models restricting fabrics (56 pool values,
all resolvable), so a 2990 search could also be crowded by the pool. How many
searches actually came back short is UNKNOWN; nothing logs a search.

**Fix.** `coloursOnOffer` applies every rule — retired series, retired codes and,
when the search names its item, the Model's pool through the save gate's own
`loadProductAndModel` + `fabricAllowedByPool` — and only then caps. The query now
reads up to `OFFER_SCAN_ROWS` (1000, the PostgREST page) instead of 50. The
pickers send `itemCode` (a required option of `useFabricColoursSearch`, so a
third picker cannot forget it). A failed Model lookup degrades to no pool filter,
never an empty picker; the save gate still refuses a disallowed fabric.

Pinned by `backend/src/scm/routes/fabricColoursOnOffer.test.ts`,
`backend/tests/fabricSearchCapAfterRules.test.ts` and a case in
`frontend/src/mobile/MobileFabricPicker.test.tsx`. With the route and the phone
sheet restored to `main`, 9 of those tests fail (8 backend, 1 frontend).

**Known limit.** A company whose single search matches more than 1000 active
colours would lose the tail again; company 1 had 851 active colours in total on
2026-09-11.

**Ref.** fix/fabric-search-cap-after-filters, 2026-09-14.
