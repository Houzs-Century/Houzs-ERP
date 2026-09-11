## A pre-serialized patch turned two variants blocks into arrays, and two holes in the guard let it through [high]

**Symptom.** `apply-supplier-bedframe-variants.mjs`'s first production run
(34575444258, 2026-09-11) reported `APPLIED — 1 purchase line(s), 1 sales line(s)`
and then its own verify said:

    VERIFY FAILED — 1 line/axis pair(s) did not land:
    HC-PO-010153 TRION (A)-(K): gap reads (blank), wanted 10"

Read back, both rows of that chain held an ARRAY where an object belongs:

    [ {"gap": null, "divanHeight": "8\"", "legHeight": "1\"", …},
      "{\"gap\":\"10\\\"\"}" ]

Every reader asks `variants->>'fabricCode'`, `->>'gap'` and so on, which is NULL
on an array — so the line does not read as *wrong*, it reads as *unspecified*.
Two rows: the purchase line and its sales line. No stock row was touched (this
tool does not move stock), and no other row in the database is array-shaped.

**Root cause (traced).** The write bound a pre-serialized string to a jsonb
parameter — `const patch = JSON.stringify(w.set)` then
``variants || ${patch}::jsonb`` — so the driver typed the parameter as json and
Postgres received a jsonb STRING. `object || string` is not a merge; it is array
concatenation. This is `docs/jsonb-double-encoding-coe.md` exactly, a class this
repo had already paid for three times and built a scanner against.

**The scanner did not fire, for two reasons, and that is the real finding.**
`npm run audit:jsonb-binds` runs in CI (`ci.yml`) and passed on the PR that
shipped this.

1. **`t` was not in `SQL_TAGS`.** postgres.js names the transaction handle `t`
   (`sql.begin(async (t) => …)`), and the tag list held `sql, tx, pg, client,
   conn, db, trx, dst, src`. Without the tag, the scanner never entered the
   template, so the bind inside it was never examined at all.
2. **It only matched `JSON.stringify(` INSIDE the interpolation.** One line of
   detour through a variable — the shape above — walked past it.

**Fix.**
- Both writers now build the patch with `jsonb_object($1::text[], $2::text[])`
  over TEXT parameters, and both refuse a row whose `variants` is not an object
  rather than merging into a shape they do not understand.
- `lib/jsonb-bind-scan.mjs` learned both holes: `t` is a SQL tag, and an
  identifier assigned from `JSON.stringify` is the same finding as the call. That
  second rule needed a limit — the scanner has no scopes, and on the run that
  added it 4 of 9 hits were a short name that is a PARAMETER elsewhere in the
  file (`const v = JSON.stringify(…)` in one function, `async (v) => sql\`… =
  ${v}\`` in another), so a name used as a parameter is dropped. Four fixtures in
  `tests/jsonbBindScan.test.mjs` pin all of it, each failing on the unfixed
  scanner.
- With the sharpened scanner the tree showed two more real sites, both in
  `audit-special-addon-prices.mjs` (`@> ${j}::jsonb` against a stringified
  `[code]`): funnelled through `::text::jsonb`. That audit's counts were being
  computed against a double-encoded comparand.
- `repair-array-shaped-variants.mjs` learned the `[ {...}, "{...}" ]` shape:
  where the tail only fills slots element 0 leaves null or empty, it is MERGED,
  because taking element 0 alone would drop the very measurement the write was
  for. A tail that CONTRADICTS a stated value is still refused, unchanged.

**What it cost, plainly:** one bedframe line's gap did not land, and two rows
needed repair. It was caught by the tool's own VERIFY, on the first run, before
anything read those rows — which is the argument for making every apply re-read
on a fresh connection and assert the SHAPE, not the row count.

**Ref.** fix/stock-aware-variants, 2026-09-11. Follows
`docs/jsonb-double-encoding-coe.md`.
