## The open-all-sofa-model-options apply added compartments with no backing SKU because it skipped SKU minting [high]

**Symptom.** Owner, 2026-09-10 immediately after the apply landed:
「compartment 不需要啊」. The `open-all-sofa-model-options` script had
just unioned every sofa Model's `allowed_options.compartments` with the
full compartment pool (33 codes) under HOUZS — 1894 additions across
79 Models. In the SO line variant picker every Model now offers pieces
its build never had (a 3-seater sofa Model shows `CNR`, a plain-body
Model shows `STOOL`); worse, none of those newly-listed pieces has a
paired `mfg_products` row `{model_code}-{compartment}`, so selecting one
and saving lands on the SKU-not-minted refusal the earlier compartment
work always paired with a SKU insert.

**Root cause (traced).** `backend/scripts/open-all-sofa-model-options.mjs`
opened five `allowed_options` keys with the same UNION shape. The four
"catalog" keys — sizes / leg_heights / specials / fabrics — are model-
agnostic (a fabric is a fabric on any sofa, a special is defined once
against the SPECIAL_ADDONS table). Compartments are not: they name the
physical pieces a Model is built out of, so what belongs on Model 8038
is a design decision, and every opened compartment has to be minted as a
`mfg_products` row `{model}-{comp}` (see the precedent
`open-5526-model.mjs` §"1. the model row" + §"2 + 3. compartments and
SKUs") — the open-all script did the pool union without any SKU minting.

**Fix.** `backend/scripts/revert-non-mintable-sofa-compartments.mjs` +
its `workflow_dispatch` workflow. For every active SOFA
`product_models` row under HOUZS, filter `allowed_options.compartments`
to only entries where `mfg_products.code = ${model_code}-${compartment}`
exists in the same company. Anything without a paired SKU is dropped
back out. The other four keys (sizes / leg_heights / specials / fabrics)
are not touched — those were opened correctly. Same MODE/CONFIRM
discipline + fresh-connection shape check as the open-all script.
Convergent: a second apply run finds no unbacked compartments and
writes zero. Follow-up (owner-picked, separate PR): change the open-all
script itself to skip `compartments` altogether, so this class cannot
recur if the script is ever re-run on a new company.

**Ref.** `chore/revert-non-mintable-sofa-compartments`, 2026-09-10.
