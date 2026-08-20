## The apply that hit the corrupted rows from the other side, and rolled back [medium]

**Symptom** - the prod apply of the zero-priced specials subset, run
31417530815, printed its whole report and then
`ROLLED BACK - path element at position 1 is not an integer: "specials"`.
Exit 1, nothing written.

**Root cause (traced, not guessed)** - the same damage as the entry above, met
from the writing side instead of the reading side. `refresh-sofa-colours.mjs`
had turned some `variants` values into jsonb ARRAYS (#1938). This backfill
writes with `jsonb_set(COALESCE(variants, '{}'::jsonb), '{specials}', ...)`,
and a jsonb path element addresses an OBJECT key - against an array Postgres
demands an integer index and raises exactly that error. `COALESCE` is no
defence: it replaces SQL NULL, not a JSON value of the wrong shape. The script
had the shape guard on its READ side already and none on its WRITE side.

One malformed row failed the statement, and because this apply deliberately
runs as a SINGLE transaction, the other 413 lines rolled back with it.

**Fix** - the shape check now runs before a line is queued, and a line whose
`variants` is not an object is SKIPPED and listed in the report. It is NOT
coerced to `{}`: that would delete whatever the array holds, and the owner's
rule of 2026-08-11 is 不可以删只可以 cancel - #1938's `variants = variants -> 0`
repair is the right owner of those rows, not this backfill. A second guard sits
in the UPDATE's WHERE (`variants IS NULL OR jsonb_typeof(variants) = 'object'`)
for a row that changes shape between the read and the write; it is left alone,
shows as a shortfall in the affected-row count, and rolls the transaction back
rather than half-applying.

**What this run got RIGHT, and is worth copying** - the failure was loud and
total. Because the apply sums the affected rows' money columns inside one
transaction and throws on any difference, an unrelated error rolled everything
back. The batched `sql.begin`-per-200 shape the older backfills use would have
committed the first batch and then died, leaving the data half-written.

**The class, for next time** - `COALESCE(col, '{}'::jsonb)` reads like "make
sure this is an object". It is not; it only handles SQL NULL. A jsonb column
with several writers over several years holds shapes nobody declared, so test
`jsonb_typeof` before addressing a path inside it. And corruption spreads by
blocking the NEXT writer, not only by being read wrong - this backfill found
#1938's damage without looking for it.

**Ref** - 2026-08-11, PR #1940 (fix/specials-variants-not-object), after run
31417530815. Origin of the bad shape: #1938.
