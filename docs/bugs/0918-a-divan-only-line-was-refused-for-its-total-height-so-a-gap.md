## A DIVAN ONLY line was refused for its total height, so a Gap the product does not have had to be picked [high]

<!-- area: Sofa, fabric, variants -->

**Symptom.** Owner, 2026-09-15, on the phone: 「检查一下我的divan only是不需要选mattress gap的」,
then 「force key可是key了又不行」 with a screenshot of Edit Sales Order refusing to save
`DIVAN ONLY-(SS)` on HC-SO-011153 (8" divan, No Leg). The variant rule already exempts a
DIVAN ONLY line from the Gap (owner 2026-08-09, "divan only 不需要 gap",
`backend/src/scm/shared/so-variant-rule.ts` `isDivanOnly`), so nothing on screen asked for
one — the save was refused anyway.

**Root cause (traced).** Not the variant rule: the allowed-options gate. Total Height has no
box on any form; the editor computes it as divan + leg + gap
(`backend/src/scm/shared/total-height.ts` `computeTotalHeight`), and
`backend/src/scm/lib/allowed-options-check.ts` refuses a total the Model's `total_heights`
pool does not list. A DIVAN ONLY line leaves Gap blank, so 8" + No Leg + nothing = 8". The one
DIVAN ONLY Model on production (model_code `DIVAN ONLY`, all seven DIVAN ONLY SKUs of company 1
bound to it) lists totals 10"-28" only. Read from production, read-only, 2026-09-15:
`idempotency_keys` holds the refused add at 04:18:59Z — status 400, `variant_not_allowed`,
field `total_height`, value `8"`, derivedFrom divan `8"` / leg `No Leg` / gap `""`,
itemCode `DIVAN ONLY-(SS)`. The only way past was to pick a Gap that put the sum inside the
pool — exactly what the 2026-08-09 exemption says a DIVAN ONLY does not have. The exemption
was applied to "which boxes are required" and never to the one gate that adds the boxes up.

**Fix.** `checkAllowedOptions` skips the total-height pool for a DIVAN ONLY code (the same
`isDivanOnly` the variant rule uses). Its divan and leg picks are still held to their own
pools. Pinned in `backend/src/scm/lib/allowed-options-check.test.ts` with the production
DIVAN ONLY Model's pools verbatim: the refused HC-SO-011153 line passes, four catalogue and
book spellings pass, the same 8" on an ordinary bedframe is still refused, and a DIVAN ONLY
divan or leg outside its pool is still refused. Proved RED on the unfixed tree (3 of the 4
new cases fail with the skip removed).

Why the pool is skipped rather than edited: ticking 4"-9" on the DIVAN ONLY Model in the
Modular drawer would also have let this line through, but it restates the Gap exemption as a
setting someone has to keep in step, and the drawer pre-fills an empty BEDFRAME pool with the
maintenance master list (`frontend/src/pages/scm-v2/ProductModelDetail.tsx`, `fillIfEmpty`), so the
next DIVAN ONLY Model would start refused again. The ruling is about the product, so the
exemption keys off the product, like the Gap exemption beside it.

**Ref.** fix/divan-only-total-height-line-add-retry, 2026-09-15.
