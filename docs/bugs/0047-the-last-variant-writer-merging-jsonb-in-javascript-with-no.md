## The last variant writer merging jsonb in JavaScript, with no shape guard and no read-back [med]

**Symptom** - none observed. `apply-variant-patch.mjs` is the reviewed
hand-patch escape hatch: a human or AI reads a Desc2 the regex parser cannot,
and the patch arrives gzip+base64 through a workflow input. Every other script
in this family had been brought up to the COE standard after the colour sweep
destroyed `variants` three times in an afternoon; this one had not, and it was
found by audit rather than by damage.

**Root cause (traced, not guessed)** - it merged the column in JavaScript:

```js
const [row] = await sql`SELECT variants FROM scm.mfg_sales_order_items WHERE id = ${p.id}`;
const v = { ...(row.variants || {}), ...(p.variants || {}) };
await sql`UPDATE scm.mfg_sales_order_items SET variants = ${sql.json(v)}, ... WHERE id = ${p.id}`;
```

That is correct on KEY PRESERVATION, which is why it never surfaced as the
"refresh scripts REPLACE the whole variants jsonb" bug - the spread carries every
key forward. It fails on the two things `docs/jsonb-double-encoding-coe.md` is
actually about:

1. **No shape guard.** Spreading a `variants` that is an ARRAY - the shape the
   double-encoding defect leaves behind, and which #1938's repair owns - yields
   `{"0": {...}, "1": "a stringified patch"}`. That is a *valid object*. The
   write would have converted a row `jsonb_typeof` can detect as damaged into
   one nothing can detect, silently, while reporting success.
2. **No RETURNING and no read-back.** `nItems++` counted attempts, not rows. The
   colour sweep reported `APPLIED - stamped 146 sofa lines` three times while
   appending a string to an array, because a command tag answers "did a row
   change", never "does the row hold what I meant".

It also held a read-modify-write window between the SELECT and the UPDATE in
which a concurrent writer's key could be read, forgotten and overwritten.

**Fix** - the write moved into the database.
`lib/variant-merge.mjs` gained `mergeReviewedVariantPatch`, a sibling of the
sweep primitive with the same protections and a deliberately different contract:
arbitrary keys are allowed (the patch IS the reviewed artifact - constraining it
to `OWNED_VARIANT_KEYS` would stop the escape hatch setting `seatHeight` or the
picker's `special`, the very fields it exists for), and geometry uses `COALESCE`
so a patch that says nothing about `gap` leaves gap alone. Guarded on
`jsonb_typeof(COALESCE(variants,'{}'::jsonb)) = 'object'`, bound with
`db.json(patch)`, counted from `RETURNING`, and every patched key re-read on a
FRESH CONNECTION before the script reports success - it exits non-zero if any
row does not hold the value that was written. `variants` is never read into
JavaScript any more.

Pinned by `tests/variantRefreshOwnedKeys.test.ts` (the script routes through the
library; no JS-side spread; no `SELECT variants`; a read-back exists) and by
`tests-pg/variantMergePreservesKeys.pg.test.ts` against a real postgres:16 (an
unowned key lands, untouched keys survive, an omitted geometry axis is not
nulled, and an array- or string-shaped column is REFUSED rather than coerced).
The stringified-bind assertion could not reuse the sweeps' blanket
`not.toContain('JSON.stringify')` - this script uses it legitimately in log
lines - so the test scans postgres.js TAGGED TEMPLATE bodies only, which is the
invariant that actually matters.

**Lesson** - "correct on key preservation" is not the same as "safe to write".
The three COE protections are independent, and a script can pass the one the
last incident was about while failing the two it was not.

**Ref** - 2026-08-11, PR #1970 (chore/po-variant-text-check).
