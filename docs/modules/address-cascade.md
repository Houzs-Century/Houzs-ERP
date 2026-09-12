# Module: Address cascade (State / City / Postcode)

> **Line numbers here are INDICATIVE.** Resolve a symbol with
> `git grep -n "<symbol>" -- frontend/src` rather than trusting a `:NNN`.

Every form in this app that captures an address picks the same three fields off
the same reference table, `scm.my_localities`. This guide covers the rules that
decide **what each field offers** and **what happens when one is picked** — the
part that used to be hand-copied into each form, and drifted.

The owner's rule, 2026-08-15: *"它可以由上往下，也可以由下往上，双边启动都是可以的"* —
top-down and bottom-up both have to work.

---

## 1. Where the code is

| File | What it holds |
|---|---|
| `frontend/src/vendor/scm/lib/localities-queries.ts` | `useLocalities` (the query) and the pure derivations over its rows |
| `frontend/src/vendor/scm/lib/address-cascade.ts` | **the cascade rules** — option pools, pick handlers, placeholders, `useAddressCascade` |
| `frontend/src/vendor/scm/components/StatePicker.tsx` | the State control (grouped by country, type-to-search, no free-text escape) |
| `frontend/src/vendor/scm/lib/address-cascade.test.ts` | the cascade contract |
| `frontend/src/vendor/scm/lib/localities-reverse-resolve.test.ts` | the resolver contract underneath it |

`useLocalities` reads `GET /api/scm/localities` and is cached for 24h
(`queryKey: ['my_localities']`) — the table is maintained, not transactional.
Rows are maintained through **SO Maintenance → Localities**
(`frontend/src/pages/scm-v2/SalesOrderMaintenance.tsx`), which is the only write
surface. There is no free-text fallback on any document form: a state, city or
postcode that is not in the table must be added there first.

Since 2026-09-11 the table carries a UNIQUE index on `(country, state, city,
postcode)` (mig `20260911T1730`), so the same locality cannot exist twice —
`POST /localities` returns **409** on a duplicate instead of silently creating
one. The index was added after the MY set was found seeded twice (every postcode
held two identical rows; `docs/bugs/0816-scm-my-localities-was-seeded-twice-so-every-malaysian-postco.md`).
A city/postcode carries at most one row per state now, so a postcode that legibly
spans several neighbourhoods (53300 = Wangsa Maju / Danau Kota / Setapak Jaya)
still resolves to a single stored `city` until the set is enriched.

(That page also hosts the Salesperson Handover section since 2026-08-17 — an
unrelated tool behind `scm.so.attribute_other`, documented in `so-handover.md`.
It touches no locality data.)

The table is **not Malaysia-only** — mig 0181 seeded CN and SG rows, so
`country` is a real dimension and `statesInCountry` / `distinctCountries` exist
for the country-first surfaces (Warehouse, Supplier, Venue).

**Singapore postcodes are LIVE-resolved, not seeded (2026-09-11).** The 55 SG
rows are one representative code per URA planning area; Singapore's real ~150k
per-building 6-digit postcodes are NOT in the table, so a real SG postcode shows
"No match" against the seeded set. `GET /api/scm/sg-postcode/:code`
(`backend/src/scm/routes/sg-postcode.ts`; testable logic in
`backend/src/scm/lib/onemap-sg.ts`) resolves a real SG code to its address via
Singapore's official OneMap API. It is **INERT until configured**: with no
`ONEMAP_EMAIL` / `ONEMAP_PASSWORD` Worker secret it returns
`{ configured: false }` and the SG address forms keep the seeded 55-area picker —
the same no-op contract `RESEND_API_KEY` uses. Front-end callers must degrade on
`configured: false`, never assume a live lookup.

**A real SG postcode also fills City + State, not just the address (2026-09-12).**
After the address search, the backend calls OneMap's `getPlanningarea` with the
result's coordinates to get the URA planning area (`pln_area_n`) and returns it as
`planningArea` on each result. That planning area is exactly one of the 55 seeded
SG cities (mig 0181 stores the planning area as `city` and the URA region as
`state`), so `resolveSgPlanningArea(rows, planningArea)` in `sg-postcode-queries.ts`
maps it back to the seeded `{ state, city }` and the field fills all three — a real
SG postcode behaves like a Malaysian one (postcode → address + City + State).
`getPlanningarea` is **best-effort**: if it fails for any reason the backend leaves
`planningArea: ""`, `resolveSgPlanningArea` returns `null`, and the field fills the
address only (the pre-2026-09-12 behaviour). The `getPlanningarea` round trip is
auth-gated (Worker token) and cannot be exercised in CI, so the parse + the
planning-area→{state,city} match are unit-tested while the live call itself is not.

The front-end field is `vendor/scm/components/SgPostcodeField.tsx` (hook
`sg-postcode-queries.ts`); `AddressPostcodeField.tsx` chooses it over the cascade
dropdown when `country === 'Singapore'`. Its one-tap offer calls
`onResolve({ address, state, city })` — `state`/`city` are `null` when the planning
area did not resolve, and each host writes State + City in a single set that leaves
the typed Postcode untouched (the same "never route a back-filled State through the
State picker" rule as trap #1 below). Wired into `SupplierDetail` and the Sales
Order delivery address — `SalesOrderNew` / `SalesOrderDetail` (desktop) and
`MobileNewSO` (`bare` mode, inside the mobile `<Field>`). Country on the SO forms
is DERIVED from the picked State, so a SG address is reached by picking a Singapore
region as State; because the resolved State is always a SG region, the country
stays Singapore and the field does not disappear mid-fill.

## 2. The two directions

**Top-down** (`由上往下`) — each pick narrows the next field:

```
State  ──> cityOptionsFor(rows, state)          = citiesInState
       ──> postcodeOptionsFor(rows, state, '')  = postcodesInState
City   ──> postcodeOptionsFor(rows, state, city) = postcodesInCity
```

**Bottom-up** (`由下往上`) — a pick back-fills what sits above it:

```
Postcode ──> resolvePostcode  ──> { state, city }
City     ──> resolveCityState ──> state          (only when unambiguous)
```

With nothing picked, City and Postcode offer the **cross-state pool**
(`allCities` / `allPostcodes`), which is what makes them valid starting points.
An ambiguous city that could not resolve a State still narrows Postcode, via
`postcodesForCity`.

## 3. The API a form uses

```ts
const { states, cities, postcodes } = useAddressCascade(rows, state, city);

pickState(next)                       // -> { state: next, city: '', postcode: '' }
pickCity(rows, current, nextCity)     // -> full triple, State back-filled
pickPostcode(rows, current, nextPc)   // -> full triple, State + City back-filled

cityPlaceholder(state)                // "Pick city — State fills in"
postcodePlaceholder(state, city)      // "Pick postcode — State and City fill in"
```

The `pick*` functions are **pure and return the whole triple**. That is not
style — it is what lets both call-site shapes work:

```ts
// object-shaped form (the Detail pages) — ONE setForm
setForm((s) => ({ ...s, ...pickPostcode(rows, s, next) }));

// three useState atoms (the New pages, mobile)
const t = pickPostcode(rows, { state, city, postcode }, next);
setState(t.state); setCity(t.city); setPostcode(t.postcode);
```

## 4. Three traps this module exists to hold

**A back-filled State must NEVER go through the State picker's own handler.**
That handler is `pickState`, and `pickState` clears City and Postcode by
design — a city chosen under the old state is not valid under the new one. Route
a reverse-resolved State through it and the operator watches the postcode they
just picked vanish. This is why an object-shaped form writes the triple in one
`setForm` (PR #2117; regression pinned in `address-cascade.test.ts`).

**Ambiguity is REFUSED, never guessed.** `resolveCityState` returns `null` for a
city that sits under more than one state, and `resolvePostcode` returns `null`
rather than pick a side when its rows disagree. `pickCity` / `pickPostcode`
leave State untouched in that case, so the operator resolves it. Do not
"improve" either into a best guess — a wrong State silently re-routes the
delivery and, through the state→warehouse mapping, the Sales Location on the
supplier PO.

**Narrowing is not optional on the top-down leg.** Before 2026-08-15 every form
fell back to the nationwide postcode pool whenever City was blank, so a picked
State narrowed City but not Postcode — and picking a postcode from another state
silently flipped the State just chosen. `postcodesInState` is what closes it.

## 5. Who calls it

Re-run this rather than trusting a list:

```bash
git grep -l "lib/address-cascade" -- frontend/src
```

As of 2026-08-15 that is eleven document forms — the SO New/Detail pair,
`MobileNewSO`, `SalesInvoiceNew`, `DeliveryReturnNew`, and the Consignment
Note / Order / Return New+Detail pairs — plus the module itself.

## 6. Address surfaces that deliberately do NOT use it

These capture a **supplier, warehouse or venue** address, not a customer
delivery address, and they pick **Country first** with State filtered by
country. Reversing them means back-filling Country as well as State, and in the
Warehouse drawer the City and Postcode fields are not rendered at all until
State and City exist. That is a redesign, not a wiring change, and none of them
sits on an operator throughput path.

| Surface | Shape |
|---|---|
| `pages/scm-v2/SupplierDetail.tsx` | Country → State → City → Postcode. Its `PostcodeSelect` calls `postcodesInState` for the city-blank case. |
| `pages/scm-v2/Suppliers.tsx` (quick-add) | `StatePicker` + free-text Area / Postcode / City, so non-MY suppliers can be entered. |
| `vendor/scm/components/WarehouseFormDrawer.tsx` | Country first; City/Postcode conditionally rendered. |
| `pages/ProjectMaintenance.tsx` (VenueManager) | State + City dropdowns, free-text Postcode, in a compact row-add grid. |

**`pages/scm-v2/DeliveryOrderNewV2.tsx` is an open gap, not a decision.** Its
State / City / Postcode are three plain `TextInput`s whose placeholders read
"Pick state / city / postcode" — text boxes dressed as pickers, and the only
editable delivery address in the tree that is not catalog-validated. Converting
it changes what production can SAVE (a prefilled value the table lacks would
blank on open), so it needs the owner's call first.
