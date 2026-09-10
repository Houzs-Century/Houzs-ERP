## Bedframe and mattress Models kept narrow allowed_options after the sofa open-all — SO Special Order shows None [medium]

**Symptom.** Owner, 2026-09-10 right after the sofa open-all landed:
「bedframe 的 special order 没有全开？」 and — showing the Product Model
detail for JACOB 2.0 (F) with every SPECIALS pill green next to a mobile
SO amendment on the same Model whose Special order card reads "None" —
「我看了这一篇 special 明明是开完的，可是为什么我去开单的时候，我的
special 却是 none 的呢？」.

**Root cause (traced).** The sofa apply
(`backend/scripts/open-all-sofa-model-options.mjs`) scoped
`WHERE category = 'SOFA'`. Bedframe + mattress Models kept whatever narrow
`allowed_options` they had. On the Model detail page,
`ProductModelDetail.tsx:222-236` (`fillIfEmpty`) auto-fills the pool
INTO LOCAL STATE on load, so the pills all look green even when the
saved row is empty — until someone hits Save Changes, the DB is
unchanged. The SO Special Order picker reads the saved
`allowed_options.specials` and correctly reports "None" against an
empty saved array.

**Fix.** `backend/scripts/open-all-bedframe-model-options.mjs` +
`.github/workflows/open-all-bedframe-model-options.yml`. Same UNION
shape as the sofa script, over BEDFRAME + MATTRESS categories, with
the right keys per category:

- BEDFRAME → `sizes / divan_heights / total_heights / gaps /
  leg_heights / specials` (pools from `maintenance_config_history` +
  `special_addons` filtered to BEDFRAME).
- MATTRESS → `sizes` only.

Compartments not applicable to these categories. Fabrics not applicable
(the SO bedframe picker reads `fabric_colours` directly with only an
`active + company_id` filter; per-Model fabric whitelisting is a sofa-
only surface). Same MODE/CONFIRM discipline and fresh-connection shape
check the sofa script uses. Convergent — a second apply writes zero.

**Ref.** `chore/open-all-bedframe-model-options`, 2026-09-10.
