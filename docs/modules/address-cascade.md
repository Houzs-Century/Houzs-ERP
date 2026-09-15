# Address Cascade (State / City / Postcode)

Every form that captures a Malaysian-style address picks State, City and Postcode off the same reference table, `scm.my_localities`. This module holds the shared cascade rules — what each field offers, and what happens when one is picked — so the logic isn't hand-copied (and drifted) per form. Both top-down and bottom-up picking must work.

## Statuses and flow

- **Top-down:** picking State narrows City and Postcode to that state; picking City further narrows Postcode to that city.
- **Bottom-up:** picking City back-fills State (only when the city is unambiguous across states); a Postcode set by scan or prefill (not by the picker) back-fills both State and City.
- **Postcode is State-first:** the Postcode field's option pool is empty with no State picked — its placeholder reads "Select State first" and interacting with it pops an explanatory dialog. City-first bottom-up still works (it back-fills State, which then opens Postcode).
- The reference table also carries China and Singapore rows (`country` is a real dimension for country-first surfaces like Warehouse/Supplier/Venue). Singapore postcodes are LIVE-resolved through Singapore's OneMap API (`GET /api/scm/sg-postcode/:code`) rather than fully seeded — only 55 representative planning-area rows exist locally. The live lookup is INERT until the `ONEMAP_EMAIL`/`ONEMAP_PASSWORD` Worker secrets are configured, returning `{configured: false}`; callers must degrade to the seeded picker in that case. A successful SG lookup also best-effort fills City + State from the resolved planning area; a failed planning-area lookup fills the address only.

## Rules that must not break

- A back-filled State must never be routed through the State picker's own handler (`pickState`) — that handler always clears City and Postcode by design (a city under the old state may be invalid under the new one). A bottom-up resolve must write the whole `{state, city, postcode}` triple in one update, never call `pickState` with just the new state.
- Ambiguity is refused, never guessed — `resolveCityState`/`resolvePostcode` return `null` (leaving State untouched for the operator) rather than pick a side when rows disagree. A wrong auto-picked State would silently re-route the delivery and, through the state→warehouse mapping, the Sales Location on the supplier PO.
- The top-down leg must narrow Postcode by State (`postcodesInState`), never fall back to the nationwide postcode pool when City is blank — otherwise picking a postcode from another state silently flips the State just chosen.
- `scm.my_localities` has a UNIQUE index on `(country, state, city, postcode)` — `POST /localities` must 409 on a duplicate rather than silently create one.
- There is no free-text fallback on any cascade-using document form — a state, city or postcode missing from the table must be added there first (via SO Maintenance → Localities), not typed around.

## Gotchas

- The `pick*` functions (`pickState`/`pickCity`/`pickPostcode`) are pure and return the WHOLE triple, not just the changed field — write handlers must spread the entire result back into form state (or three `useState` atoms), never merge just one key.
- A city or postcode that legibly spans multiple areas still resolves to exactly one stored row per state (the unique index forces this) — don't expect the table to disambiguate a real-world postcode that covers several neighbourhoods.
- Supplier, Warehouse and Venue address forms deliberately do NOT use this cascade — they pick Country first (with State filtered by country) because they capture a different kind of address; this is a design difference, not a bug to unify.
- `DeliveryOrderNewV2.tsx`'s address fields are still plain free-text inputs styled as pickers — the only editable delivery address in the tree that isn't catalog-validated. Converting it needs the owner's decision first, since a currently-saved value that isn't in the table would go blank on open.
- Re-derive which forms use the cascade with `git grep -l "lib/address-cascade" -- frontend/src` rather than trusting a written list — it changes as forms are added.

## Where the code is

- `frontend/src/vendor/scm/lib/address-cascade.ts` — the cascade rules, option pools, pick handlers, `useAddressCascade`.
- `frontend/src/vendor/scm/lib/localities-queries.ts` — `useLocalities` and pure derivations over its rows.
- `frontend/src/vendor/scm/components/StatePicker.tsx` — the State control.
- `frontend/src/vendor/scm/components/SgPostcodeField.tsx`, `frontend/src/vendor/scm/lib/sg-postcode-queries.ts` — the Singapore live-lookup field.
- `backend/src/scm/routes/sg-postcode.ts`, `backend/src/scm/lib/onemap-sg.ts` — the OneMap SG resolver.
- `frontend/src/pages/scm-v2/SalesOrderMaintenance.tsx` — the only write surface for `my_localities` rows.
