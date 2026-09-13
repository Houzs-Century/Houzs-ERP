## The Delivery Order convert screen took State, City and Postcode as free text [medium]

**Symptom.** The owner, 2026-09-14, on the Delivery Order screen reached by
converting a sales order: the address could be changed, but State, City and
Postcode were plain text boxes — 「它应该跟 Sales Order 的方法一样，是 dropdown 的格式」.

**Root cause (traced).** `frontend/src/pages/scm-v2/DeliveryOrderNewV2.tsx`
rendered the three as `TextInput` bound straight to `setState` / `setCity` /
`setPostcode` (placeholders "Pick state" / "Pick city" / "Pick postcode", which
describe a picker that was never wired). Every other document form that edits
an address — Sales Order new/detail, Sales Invoice new, Delivery Return new, the
six consignment screens — wires `StatePicker` and `useAddressCascade` from
`vendor/scm/lib/address-cascade.ts` by hand, and this one form was simply never
given the wiring. Nothing checked that a form had it.

**Fix.** The DO form now uses the same shared layer AND the same widgets as the
Sales Order form (owner: 「一定要跟 Sales Order 一模一样」): `StatePicker`, a
typeable `SearchableSelect` for City and the shared `AddressPostcodeField` for
Postcode (State-first popup, Singapore lookup), all fed by `useAddressCascade`, picked through `pickState` /
`pickCity` / `pickPostcode` so each pick back-fills the other two exactly as on
the order form. Picking a State fills Sales Location from its state-warehouse
mapping (in the pick handler, so a location carried from the order is not
overwritten on load). A carried City/Postcode the locality list lacks stays
visible instead of rendering as the empty placeholder.

Guard: `frontend/src/pages/scm-v2/addressFormsUseCascade.test.ts` scans every
form under `pages/scm-v2`, `mobile` and `vendor/scm/components` that labels both
a State and a Postcode field and requires `StatePicker`, and requires the DO form
to use the same three widgets as `SalesOrderNew.tsx`; two read-only/CRUD
screens are exempted by name with a reason. Proved RED against `main`'s
`DeliveryOrderNewV2.tsx` (it names that file), green on the fix.

**Ref.** fix/do-address-cascade, 2026-09-14.
