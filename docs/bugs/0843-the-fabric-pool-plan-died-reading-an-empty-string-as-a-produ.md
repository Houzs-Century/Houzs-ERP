## The fabric-pool plan died reading an empty string as a product category [low]

<!-- area: Sofa, fabric, variants -->

**Symptom.** The first dispatch of **Open model fabric pools** against staging
(run 34691761762, plan mode, writes nothing) exited 1 with:

```
invalid input value for enum scm.mfg_product_category: ""
```

**Root cause (traced).** `open-model-fabric-pools.mjs` selected sofa Models with
`upper(coalesce(category, '')) = 'SOFA'`. `product_models.category` is the ENUM
`scm.mfg_product_category`, so `coalesce(category, '')` asks Postgres to read
`''` **as that enum** — and it refuses, before `upper()` is ever reached. The
comparison was always a text one; the cast was simply missing. Two statements
carried it: the model select and the fresh-connection verification.

The plan mode is what caught it, which is the point of shipping plan-first — and
it is also why CLAUDE.md's rule 5 says a `workflow_dispatch` workflow is not
shipped until it has been dispatched once. The PR that added it said so and
labelled the workflow UNTESTED rather than claiming it worked.

**Fix.** `category::text` in both statements.

Verified: plan re-dispatched on staging and on production — outputs in
`docs/bugs/0842-a-fabric-added-in-modular-would-be-offered-by-no-sofa-model.md`'s
PR thread and in this PR.

**Ref.** fix/open-fabric-pools-enum-cast, 2026-09-12.
