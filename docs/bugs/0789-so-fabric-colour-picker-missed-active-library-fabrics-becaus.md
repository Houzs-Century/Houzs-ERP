## SO fabric colour picker missed active library fabrics because per-model allowed_options.fabrics was hand-curated and never auto-filled [medium]

**Symptom.** Owner, 2026-09-10: 「在 fabric 这边明明有 HR805-90，可是我的
special order 颜色那边要去选择却没有，是什么问题呢？」 The Fabric library
(HOUZS, filtered "805") holds seven active codes — HR805-09, HR805-10,
HR805-20, HR805-30, HR805-31, HR805-40, HR805-90. Typing `805-` in the SO
line "Special Order" colour combobox on Model 2376 returns only five —
HR805-10 and HR805-90 are missing. Both missing ones carry a Sofa/Bedframe
Tier of Price 2 in the library; the other five have no tier. That looked
like a tier-driven filter, and it is not.

Also, in the owner's plain-language ask: 「我发现了我的 houzs-century 这间
公司 CO1，special order 并不是 open for 全部的。它不会像 2990 这样有局限，
帮我把全部 sofa module 的那些 special order 开放到完，还有全部颜色、
variant 全部开放到完」 — the SAME pattern hits specials, seat sizes and
leg heights too, whenever a Model's `allowed_options.<key>` was hand-
curated rather than auto-filled.

**Root cause (traced).** The colour picker route
`backend/src/scm/routes/fabric-colours.ts:34-69` selects from
`scm.fabric_colours` with only `active=true` + company_id + optional
ilike on colour_id / label — NO tier predicate anywhere. The tier
correlation in the sighting is coincidence. Client-side,
`FabricColourCombobox` in
`frontend/src/vendor/scm/components/SoLineCard.tsx:1470-1478` applies
two extra filters: drop any code whose `fabric_trackings.is_active===false`,
then restrict to the Model's `allowed_options.fabrics` pool IF that
pool is non-empty. Empty pool = no restriction (per the "empty means all"
rule the whole `allowed_options` layer follows).

So the picker is exactly showing what the Model's whitelist allows. The
Model row's whitelist is stored per Model in
`scm.product_models.allowed_options.fabrics` (jsonb array). Model 2376's
whitelist contains 5 codes and omits HR805-10 / HR805-90.

Why the whitelist stays narrow: `ProductModelDetail.tsx:222-226` auto-
fills `compartments / sizes / leg_heights / specials` from the pool when
a Model has an EMPTY entry for that key (`fillIfEmpty`), but does NOT
auto-fill fabrics. So a Model whose fabrics were once hand-picked keeps
that hand-pick forever; a fabric later added to the library never
propagates. The same shape narrowed specials / sizes / leg_heights on
older Models until their `fillIfEmpty` was added, and it still bites
whichever key never gets that treatment.

**Fix.** One-shot MODE-gated script + workflow_dispatch:
`backend/scripts/open-all-sofa-model-options.mjs` +
`.github/workflows/open-all-sofa-model-options.yml`. For every active
SOFA `product_models` row under company HOUZS, UNION each of the five
`allowed_options` keys with the current pool for that key
(`sofaCompartments`/`sofaSizes`/`sofaLegHeights` from the latest master
`maintenance_config_history`, all `SOFA` `special_addons`, and every
active `fabric_library` row). Any custom Model-specific code beyond the
pool is preserved — `fillIfEmpty` semantics still hold downstream. Runs
in dry-run by default and rolls the transaction back so the delta is
reviewable; `MODE=apply` requires `CONFIRM="I HAVE REVIEWED THE DRY-RUN"`.
Convergent: a second apply run writes zero.

The frontend auto-fill gap for `fabrics` — the reason this drifts back
in — stays for a separate decision (fabric libraries can be very large,
and pre-filling all of them by default may crowd new Models). This
script closes the CURRENT gap for existing rows; whether new Models
auto-fill fabrics too is owner-picked in a follow-up.

**Ref.** `chore/open-all-sofa-model-options`, 2026-09-10.
