## Every model carried an option list nobody chose, so a new option was invisible until 392 models were edited [medium]

<!-- area: Sofa, fabric, variants -->

**Symptom.** Owner, 2026-09-12, twice: 「限不限制是我在 Modular 那边自己选，不用去
理」 and 「我的维护，无论是打什么东西、标点符号、妖魔鬼怪，全部都是可以跳出来给我去
做选择的」. Asked whether the option lists other than `fabrics` should follow the
same rule — all of them, only the add-on ones, or none — he answered
「全部都是啊」.

**Root cause (traced).** `product_models.allowed_options` holds one list per
axis, and a non-empty list means *restrict to exactly these*
(`hasRestriction` = `Array.isArray(pool) && pool.length > 0`, read by the server
gate `allowed-options-check.ts` and by both pickers). Measured on the staging
copy of production, 2026-09-12:

| category | models | lists carried |
|---|---|---|
| SOFA | 79 | sizes 79 · compartments 79 · specials 79 · leg_heights 79 (fabrics already cleared by `docs/bugs/0842-a-fabric-added-in-modular-would-be-offered-by-no-sofa-model.md`) |
| BEDFRAME | 113 | sizes · specials · divan_heights · leg_heights · total_heights · gaps — 113 each |
| MATTRESS | 187 | sizes 187 |
| ACCESSORY / SERVICE | 13 | none |

Within a category every model carries the SAME list, which is what identifies it
as a snapshot taken once rather than 392 decisions. While a list is present, an
option added in Modular is offered by **no** model of that category until every
one of them is edited — the same defect `0842` fixed for fabric, on the other
seven axes.

**Fix.** `backend/scripts/open-model-option-pools.mjs` +
`.github/workflows/open-model-option-pools.yml` (staging / prod, plan by
default, `CONFIRM="OPEN-OPTION-POOLS"`) remove every pool key from every Model,
in every company. Empty and absent behave identically to both readers, so the
keys are removed outright.

**The backup is the part that matters.** Before a row changes, every Model's
current `allowed_options` is written as ONE JSON document into
`scm.app_config['scm.model_allowed_options_backup']`, and the script **refuses
to clear anything** if that write did not land. The insert is
`ON CONFLICT DO NOTHING`, so a second run cannot overwrite the pre-change copy
with a post-change one — the way a backup like this destroys itself. The restore
statement (`UPDATE ... FROM jsonb_array_elements(...)`) is in the script's
footer, beside the code that made it necessary.

**The concern that was raised, and recorded rather than buried.** A `sizes` or
`compartments` list is not the same kind of thing as a fabric list: a two-seater
cannot be built with a three-seater's compartment, so those lists are sometimes
RIGHT, and clearing them lets an order be keyed for something the factory cannot
make. That was put to the owner with a recommendation to keep sizes and
compartments; he chose all of them. It is written into the script's header so
the next reader does not re-derive it, and the backup is what makes the choice
cheap to revisit.

**Ref.** feat/open-all-model-option-pools, 2026-09-12.
