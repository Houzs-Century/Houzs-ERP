## A first-pass NAME match made RDS-5526 into someone else's sofa [high]

**Symptom** — Two 5526 sofa builds could not be corrected: the correction tool
answers `piece SKU not minted`, because the piece it needs is on a model that
does not exist. Nine cutover document lines were sitting on `8038-*` codes, and
the AutoCount item they came from is `RDS-5526 SOFA`. Owner 2026-08-10: **"5526
就是 5526 啊,你应该要 remain ... 8038 原本都不是 5526."**

**Root cause** — One row of `backend/scripts/data/autocount-erp-mapping-1561.csv`:
`RDS-5526 SOFA,8038-1S,EXISTS(1st-pass),SOFA,400-R001`. The status column says
what it is — a fuzzy match on NAME, both models being called DISCOVERY — and
`400-R001` (RED SOFA) vs 8038's `400-D004` (DSL) says they are different
suppliers' products. The row contradicts its own neighbour: `RDS-5526 CONSOLE`
was mapped `NEW/ACCESSORY`, not to `8038-Console`, which exists. Because the
importers read the mapping to derive the model (`erp.replace(/-1S$/,"")`), 5526
never got the `scm.product_models` row every other AutoCount sofa code got —
`align-models-houzs-century.json` seeded 69 of them, each `name = model_code`,
`compartments: ["1S"]` — so there was no 5526 SKU for a line to point at, and
the 2026-08 supplier price list then bound RED SOFA's 5526 prices onto 8038
SKUs on top.

**Fix** — `backend/scripts/open-5526-model.mjs` + workflow: creates model 5526
(name `5526`, the convention its sibling RED SOFA model 5527 and 8133 were
seeded with — reusing `DISCOVERY` is the bug), opens the nine compartments its
own documents need, mints `SOFA 5526 {comp}` SKUs, appends new codes to the
master pool, and re-points the nine AutoCount source lines off 8038, carrying
the change down SO -> PO -> GRN and SO -> DO. The mapping row now reads
`5526-1S,NEW`, and the script refuses to run unless it does. Same pass mints
`8133-STOOL`, the piece `HC-PO-000136`'s correction was refusing on.

**What was deliberately NOT done** — the supplier bindings. `8038-1A(LHF)`,
`8038-1NA`, `8038-2A(RHF)`, `8038-CNR`, `8038-Console`, `8038-STOOL` all carry
`supplier_sku = "RDS-5526 SOFA"`, and `8038-1S` is RED SOFA's main binding for
it. Moving those moves prices, so it is the owner's decision. Two builds also
stay `SOFA UNPARSED` on purpose: `"1 ELT / T + NA +2ER"` is not readable, and
the rule is never guess a piece.

**The class, for next time** — `EXISTS(1st-pass)` in that CSV is a machine's
guess wearing the same clothes as an owner's answer; 319 rows carry it. A
first-pass NAME match between two products from DIFFERENT suppliers deserves
the supplier column read before it is trusted, and a model that ends up with no
row of its own is the symptom that one was wrong.

**Ref** — 2026-08-10, PR feat/open-5526-model.
