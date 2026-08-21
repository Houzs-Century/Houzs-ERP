## Four repair scripts whose SECOND run destroys what their first run created [high]

**Symptom** - a production PLAN of `normalize-fabric-codes.mjs` on 2026-08-13
proposed 200 rewrites. Every one of them left the CODE unchanged and shortened
the LABEL: `J9226-01 SAND` -> `J9226-01`. The whole diff was a colour name being
erased, on the same rows a previous apply had just put right. Caught before
apply; a sweep for the shape then found three more.

**Root cause** - the script derives the label from the name it parses out of the
CODE. Before 2026-08-11 the name lived there (`J9226-1 SAND`), so run one
produced code `J9226-01` and label `J9226-01 SAND` - it MOVED the name out of the
code and into the label. Run two parses a now-clean code, finds no name, and
rebuilds the label without one. The script's own output had destroyed its own
input, and nothing in it read the label back.

That is the class, and the sweep asked one question of every writing script in
`backend/scripts`: what does the SECOND run do? Three more answered badly.

- **`retier-sofa-tiers.mjs`** shifts the 2026-08 sofa price bands by POSITION -
  `PRICE_1`->`PRICE_2`, `PRICE_2`->`PRICE_3`, old `PRICE_3` soft-deleted. The
  seat grids, binding matrices and flat lanes are value-guarded and inert. The
  combo block is not guarded at all: it selects every live row in the batch and
  shifts it. A second run pushes the band the first run promoted to `PRICE_2` on
  to `PRICE_3`, and DELETES the band it promoted to `PRICE_3`.
- **`backfill-sofa-special-orders.mjs`** writes the legacy `string[]` shape of
  `custom_specials`, unioned with whatever the column already holds. The declared
  shape is `Array<{ description, surchargeSen }>`
  (`mfg-pricing-recompute.ts:117`) and the recompute writes that whenever a line
  is edited. A second run over a recomputed line runs `String()` over each object
  and stores `["[object Object]"]` - a surcharge breakdown that carries money,
  replaced by a placeholder.
- **`backfill-so-dates.mjs`** wrote `proceeded_at`, `customer_delivery_date` and
  `line_delivery_date` with no predicate at all. All three are columns people
  change: a customer moves a delivery date, and a Super Admin CLEARS the
  Processing Date (`scm.so.remove_processing_date`) to pull an order back out of
  Proceed. A second run silently reverted every one of those decisions - and it
  has been applied on production three times already (runs 31304117373,
  31322311557, 31349208508; `docs/autocount-cutover-ledger.md`). Worse, it would
  re-manufacture the `proceeded_at`-vs-AutoCount agreement that
  `unify-processing-date.mjs` uses as its migration key, so a date somebody had
  deliberately removed could then be promoted into `internal_expected_dd` as if
  the source had proved it.

**Fix** - one per shape, and each one keeps the first run's behaviour identical.

- `lib/fabric-code.mjs` gains `nameFromLabel()`: the label is a name SOURCE, not
  only an output. Only a label whose own series+number canonicalise to the same
  id may donate, so a stale label can never move a name onto a different colour;
  `stripNote()` cuts the `[MERGED into X]` stamp off first so the stamp can never
  become the name. `backend/tests/fabricCodeRerun.test.ts` is the regression - it
  runs the transform twice and asserts the second pass is a fixed point.
- `retier-sofa-tiers.mjs` REFUSES a second run, in both modes. The receipt is in
  the data, not a flag file: the 2026-08 combo batch has no soft-deleted rows
  before the shift and does after, so one soft-deleted row in the batch stops the
  script and prints why.
- `backfill-sofa-special-orders.mjs` refuses any row whose `custom_specials`
  holds a non-string element - the pricing engine's own output - and prints them.
- `backfill-so-dates.mjs` re-asserts `IS NULL` inside every UPDATE, and refuses
  any document whose `scm.mfg_so_audit_log` names one of these dates. Both guards
  are copied from `unify-processing-date.mjs`, which had already reasoned this
  out for the same columns.

**Lesson** - **a repair script's own write is part of its next run's input, and
"keyed on IS NULL" is only safe when nothing but the script can produce that
NULL.** `unify-processing-date.mjs` states the sharper version of the rule and is
the model to copy: a key a legitimate human action can restore - a Super Admin
removing a Processing Date - is not a key, it is a trap. The two safe shapes are
a key the write itself destroys (`jsonb_typeof = 'string'` -> NULL; a `-1S` line
re-coded away) and a value re-derived from an immutable source. Everything else
either converges by construction or has to refuse. A writing script has to state
its re-run behaviour in its own header, because "is it safe to run this again"
was a question nobody could answer without reading the whole file - and three
times this month somebody answered it wrong.

**Correction, 2026-08-13.** This entry originally claimed that "every script in
`backend/scripts` that writes now states its re-run behaviour in its own
header". It did not, and saying so stopped anybody checking. Measured by
`npm --prefix backend run audit:release-discipline` on the day this was written:
**162 scripts write, and 67 of them carry no re-run note.** They are listed, one
by one, in `backend/scripts/release-discipline-grandfathered.json`, and a NEW
writing script without one now fails CI. The rule is real from here; the claim
that it was already universal was not.
either converges by construction or has to refuse. Every script in
`backend/scripts` that writes now states its re-run behaviour in its own header,
because "is it safe to run this again" was a question nobody could answer without
reading the whole file - and three times this month somebody answered it wrong.
