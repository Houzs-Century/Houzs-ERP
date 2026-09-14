## The pgrest shim could not run the MRP engine: quoted not-in lists kept their quotes and LEFT embeds were refused [medium]

**Symptom.** A read-only check that wanted the REAL answer to "which purchase
order does this sales-order line show" (staff issues #18 / #19) could not run
`computeMrp` over `scripts/lib/pgrest-shim.mjs`. Every existing MRP check here
is a hand-ported replica for that reason (`check-mrp-so-line.mjs` says
"computeMrp ... cannot be invoked from node").

**Root cause (traced, reproduced 2026-09-14 against production read-only).** Two
shim gaps, hit in order:

1. `.not(col, 'in', '("CANCELLED","DRAFT")')` — the QUOTED list `mrp.ts`
   `sqlNotInList` writes — was split on commas without unquoting, so the value
   bound was `"CANCELLED"` with its quotes and the first read died with
   `invalid input value for enum scm.mfg_so_status: ""CANCELLED""`.
2. `parent:delivery_orders(status)` in `scm/lib/do-unlinked-coverage.ts` is a
   LEFT embed (no `!inner`), which the shim refused as a gap, so computeMrp threw
   `delivered_sum`.

**Fix.** Quoted in-lists go through the one grammar parser
(`parsePgrestInList`); bare lists keep their old trim. LEFT embeds are
implemented: to-one is a `LEFT JOIN` whose object is null when unmatched, to-many
aggregates without the `EXISTS` that `!inner` adds, and a FILTER on a LEFT embed
stays a loud gap (PostgREST narrows the embedded value there, not the parents).
With both, `computeMrp` ran over production in 22s (2,122 SKU rows, 1,216 sofa
sets) with an empty gap list. Three new tests in `tests/pgrestShim.test.ts` /
`tests/pgrestShim.test.mjs` were proved RED on the unfixed shim
(`3 failed | 39 passed`); the old test that pinned the LEFT-embed refusal was
replaced by the one pinning the new behaviour and the filter refusal.

**Ref.** fix/so-po-link-18-19, 2026-09-14.
