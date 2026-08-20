## The variant refresh scripts REPLACE the whole variants jsonb, so any key they do not know about is dropped [medium]

**Symptom** - not yet observed in production; found while landing the
zero-priced half of the specials backfill, which merges picker codes into
`variants.specials` and is therefore directly exposed to it.

**Root cause (traced, not guessed)** - `backend/scripts/refresh-so-variants.mjs`
builds `const variants = {...}` from scratch at `:89-96` - eleven keys, no
spread of the row's existing `it.variants` - and then writes the whole column:
`UPDATE scm.mfg_sales_order_items SET variants = ${sql.json(u.variants)}`
(`:114-116`). `backend/scripts/refresh-po-variants.mjs` is the same shape
(`:83`, `:104-105`). A bedframe row's twelfth key does not survive the next
refresh run, whoever wrote it and for whatever reason.

The script itself shows the merge was understood and simply not applied on the
main path: the non-bedframe `sizeOnly` branch three lines earlier DOES spread,
`variants: { ...(it.variants || {}), size: bf.size }` (`:77`).

A concrete casualty, provable from the code rather than hypothetical:
`variants.special`, the HOOKKA-compatible singular the picker reads beside the
plural - `specialsList(variants.specials ?? variants.special)`,
`SpecialOrders.tsx:91`. `backfill-specials-into-variants.mjs` deliberately reads
and preserves it; neither refresh script carries it, so a refresh run silently
deletes a pick the picker was showing. Sofa lines are NOT exposed - they take
the spreading `sizeOnly` branch - so this is a bedframe-line defect.

**Fix** - both sweeps now compute a PATCH and merge it; neither ever writes the
whole column. `backend/scripts/lib/variant-merge.mjs` is the single owner of
both halves:

- `OWNED_VARIANT_KEYS` declares the ten keys a Desc2 re-parse is entitled to
  move (fabric/colour block, gap/divan/leg/total, size). `assertOnlyOwnedKeys`
  throws if a builder emits anything else, so widening what the sweep owns is a
  deliberate edit and never an accident.
- the write is `variants = COALESCE(variants,'{}'::jsonb) || <patch>` in the
  DATABASE, so a key nobody has heard of survives BY CONSTRUCTION - there is no
  list of foreign keys to keep in step, and no read-modify-write window either.
  Every statement carries `jsonb_typeof(...) = 'object'` in its WHERE (object
  `||` non-object CONCATENATES - see the double-encoding COE), counts with
  `RETURNING`, reports the rows that guard skipped, and re-reads the merged ids
  on a FRESH connection.

Two keys left the sweeps' ownership at the same time, both for the same reason -
they have a better-guarded owner:

- `variants.specials` belongs to `backfill-specials-into-variants.mjs`. A picked
  add-on's selling surcharge folds into the authoritative unit price
  (`mfg-pricing.ts:396-415`), so re-stamping a PRICED code reprices a historical
  migrated document, which the owner ruled out on 2026-08-11. That backfill
  refuses priced codes and proves the money columns did not move inside its own
  transaction; the sweeps resolved codes against every BEDFRAME add-on whatever
  its price, and derived a NARROWER set than
  `data/special-order-phrase-map.json`, so a run would have both repriced and
  shrunk lines #1926 had just filled.
- `custom_specials` is a DERIVED output of the pricing recompute. #1944 nulled
  478 of them on exactly that reasoning hours earlier; a sweep refilling it
  would have undone that.

**Regression test** - `backend/tests/variantRefreshOwnedKeys.test.ts` pins the
declared key set (and that `specials`/`special`/`custom_specials` are NOT in
it), asserts every patch builder stays inside it, and reads both script sources
to fail if any `variants =` is ever an assignment rather than the merge form,
if a merge loses its object guard or its `RETURNING`, or if either sweep starts
writing `custom_specials` again. `backend/tests-pg/variantMergePreservesKeys.pg.test.ts`
executes the merge against a real postgres:16 (`backend-postgres` ->
`npm run test:pg`) and reads the row back: the unknown keys are still there, the
column is still an OBJECT (which is also the double-encoding proof), an
array-shaped row is skipped rather than concatenated, and a stray key in a patch
is refused before it reaches SQL.

**The class, for next time** - `SET jsonb_col = <fresh object>` is a delete of
every key the fresh object does not mention. When a jsonb column has more than
one writer - and `variants` has the importers, both refresh sweeps, the POS
configurator, the SO/PO line editors and now a backfill - the only safe write
is a merge on the keys you own: `jsonb_set` on one key, or `col || patch`.
Rebuilding the object is only correct when you are the sole writer, and here
nobody is. And "the keys I own" is a thing to WRITE DOWN and assert, not a thing
to remember: the list that must stay in step with reality is the short one you
own, never the open-ended one you do not.

**Ref** - recorded 2026-08-11 in PR #1926 (fix/specials-zero-priced-subset);
fixed 2026-08-11 in PR #1949 (fix/variant-refresh-preserve-keys). Neither sweep
had been dispatched between the two, so nothing was lost in production.
