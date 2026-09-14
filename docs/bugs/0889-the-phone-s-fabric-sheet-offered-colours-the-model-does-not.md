## The phone's fabric sheet offered colours the Model does not enable [medium]

<!-- area: Sofa, fabric, variants -->

**Symptom.** Found by the 2026-09-14 phone-vs-desktop permission audit (row
SO-13). On a sofa or bedframe line, the phone's "Pick a fabric / colour" sheet
listed every colour matching the search. A colour the Model does not enable in
its Modular fabric list could be picked, and the save then refused the line with
`variant_not_allowed` — the "chosen but not saved" shape the owner asked to be
closed for good (0836). The desktop line editor did not offer those colours.

**Root cause (traced).** Three readers of one rule, two copies and one reader
with none:
- the save gate `backend/src/scm/lib/allowed-options-check.ts` refuses a pick
  whose colour id and series are both absent from `allowed_options.fabrics`,
  after folding quote glyphs and surrounding space (0814);
- the desktop combobox in `SoLineCard.tsx` applied the same test WITHOUT the
  folding, so a pool entry like "TARONI " could hide a colour the gate accepts;
- the phone sheet, a function inside `MobileNewSO.tsx`, never received the
  Model's pool at all — its only filter was `slice(0, 50)`.

**Fix.** The rule now lives once in `backend/src/scm/shared/fabric-pool.ts`
(`fabricAllowedByPool`), with its browser copy
`frontend/src/vendor/shared/fabric-pool.ts` held byte-identical by
`fabric-pool.canonical.test.ts`. The gate, the desktop combobox and the phone
sheet all call it. The phone sheet moved to
`frontend/src/mobile/MobileFabricPicker.tsx`, reads the pool from the same
by-code query the line card already made, and says when a search matched but
the Model enables none. Pinned by `MobileFabricPicker.test.tsx` — with the pool
filter mutated out (bytes confirmed changed), 2 of 4 fail — and by
`fabric-pool.test.ts`; the gate's own `allowed-options-check.test.ts` is
unchanged and green.

**Ref.** fix/mobile-fabric-pool, 2026-09-14.
