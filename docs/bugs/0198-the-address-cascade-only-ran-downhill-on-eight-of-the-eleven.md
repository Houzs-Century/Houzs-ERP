## The address cascade only ran downhill, on eight of the eleven forms [high]

<!-- area: Frontend + mobile -->

**Symptom.** Owner, 2026-08-15: *"City 和 Postcode … 它可以由上往下，也可以由下往上，
双边启动都是可以的。"* On New Consignment Order — and seven sibling forms — City sat
disabled reading *"— pick state first"* and Postcode disabled reading *"— pick city
first"*. An operator holding a postcode the customer just read out could not enter
it: the only way in was to already know the State.

**Root cause, traced.** Two distinct faults, both from the wiring being
hand-copied per form rather than shared.

1. **Reverse resolution existed and was never called on eight forms.**
   `resolvePostcode` / `resolveCityState` / `allCities` / `allPostcodes` have
   been in `localities-queries.ts` since the SO work, with tests whose own header
   names the SO forms as the caller. Only `SalesOrderNew`, `MobileNewSO` and
   `SalesOrderDetail` (#2117) ever wired them. The other eight kept
   `disabled={!form.state}` / `disabled={!form.city}`.

2. **Top-down stopped one step short, on ALL of them — including the three that
   already had the reverse.** Every copy computed the postcode pool as
   `(state && city) ? postcodesInCity(...) : allPostcodes(rows)`. With a State
   picked and City still blank, that second arm is the whole country. Observed on
   production 2026-08-15 in Chrome on `/scm/sales-orders/new`: State set to
   **Johor**, Postcode typed `43300` — a **Selangor** code — and it was offered.
   Picking it silently flipped the State the operator had just chosen.

**Fix.** One shared layer, `frontend/src/vendor/scm/lib/address-cascade.ts`:
`cityOptionsFor` / `postcodeOptionsFor` for the option pools and pure
`pickState` / `pickCity` / `pickPostcode` returning the whole
`{state, city, postcode}` triple. Pure and triple-returning because the call
sites disagree on state shape — some hold three `useState` atoms, some one
`form` object — and an object-shaped form must write the result in ONE `setForm`
or the State picker's own handler (which exists to CLEAR the cascade) wipes the
value just picked. Two new derivations close fault 2: `postcodesInState` for
State-picked-City-blank, `postcodesForCity` for the ambiguous-city case where
State legitimately stays empty. All eleven forms now call in; the placeholders
say *"Pick city — State fills in"* instead of describing a gate that is gone.

**Ambiguity stays refused.** `resolveCityState` still returns null for a city in
two states and `resolvePostcode` still returns null rather than pick a side —
`pickCity`/`pickPostcode` leave State alone in that case rather than guess.
Pinned in `address-cascade.test.ts`.

**Ref.** 2026-08-15. Lesson: **the reverse of "a rule expressed twice is two
rules" — a rule expressed once per FORM is one rule per form.** Three copies of
this cascade had already drifted from each other (one cleared the postcode in
JSX, one inside the resolver) and all three carried the same nationwide-pool
bug, so the bug that was fixed three times in a row was fixed nowhere. The
trigger to extract is not elegance, it is the fourth copy.
