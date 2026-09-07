## The MRP allocation-rules probe could not load its own predicates [low]

<!-- area: Sales orders + pricing -->

**Symptom.** `probe-mrp-allocation-rules` — written to answer the owner's
2026-09-07 question about whether bedframe/sofa really light Ready through their
own PO — died at load on its first production dispatch, run 34134410877:

```
SyntaxError: The requested module '../src/scm/shared' does not provide an
export named 'computeVariantKey'
```

**Root cause (traced).** `src/scm/shared/index.ts` is a barrel of
`export * from './variant-key'` lines and it does re-export the symbol. The
Worker reaches it through a bundler that resolves the bare directory specifier
to that index; `tsx` under Node 22 resolves it differently, and the named import
is not found. Nothing about the probe's logic was wrong — only where it asked
for the predicate.

**Fix.** Each predicate is imported from the file that declares it
(`shared/variant-key.ts`, `shared/service-sku.ts`,
`shared/do-shipped-states.ts`, `lib/so-stock-allocation.ts`,
`lib/so-readiness.ts`), with the `.ts` extension the other tsx scripts in
`backend/scripts` already carry.

**Why it was not caught first.** GitHub refuses `workflow_dispatch` for a
workflow that is not on the default branch — `HTTP 404: workflow ... not found
on the default branch` — so the probe could not be run before its own merge.
That is CLAUDE.md's *"a `workflow_dispatch` workflow is not shipped until it has
been dispatched once and reported success"* meeting a case where the dispatch is
only possible after the merge. The cheap guard that WOULD have caught it, and is
now the habit: run `npx tsx scripts/<probe>.mjs` locally with no `DATABASE_URL`
first — imports evaluate before the credential check, so a load error surfaces in
about two seconds and a resolvable one exits with the script's own
`DATABASE_URL required`.
