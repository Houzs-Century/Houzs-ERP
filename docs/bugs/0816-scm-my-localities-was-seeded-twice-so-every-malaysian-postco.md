## scm.my_localities was seeded twice, so every Malaysian postcode carried two identical rows [low]

<!-- area: Cutover + migrated data -->
<!-- status: fixed -->

**Symptom.** An operator reported postcode `53300` as "not in the system" — the
delivery-address postcode picker showed `No match for "53300"`. It is in fact
present. Investigating the master turned up a second, unrelated problem: the
Malaysian reference set in `scm.my_localities` is exactly DOUBLE its true size.
On prod (`anogrigyjbduyzclzjgn`) the MY rows numbered 5,866 for only 2,929
distinct postcodes — every postcode present twice. The duplication is invisible
in the UI because `postcodesInCity`/`allPostcodes` collapse the option lists
through a `Set` (`frontend/src/vendor/scm/lib/localities-queries.ts`), so the
only cost paid is on the wire: `GET /api/scm/localities` ships ~0.9 MB of
reference data on every cold page load and half of it is a duplicate.

**Root cause (traced).** The MY dataset was inserted twice into a table with **no
unique constraint**. `scm.my_localities`' only key is its uuid PK
(`backend/src/scm/routes/localities.ts` header: *"no DB unique constraint on
my_localities"*; mig 0181's own comment: *"scm.my_localities has no UNIQUE
constraint beyond its uuid PK, so ON CONFLICT has no target"*), so a re-run of
the seed appended a whole second copy rather than colliding. Proven against the
live DB, not inferred from a file:

```
-- every postcode has exactly two rows, none has one:
postcodes_1_row = 0, postcodes_exactly_2_rows = 2,925, postcodes_multi_city = 4
-- the duplicate rows are byte-identical across ALL columns:
natural_key_groups_gt1 (by postcode,city,state,state_code,country)      = 2,933
full_tuple_exact_dup_rows (adds warehouse_id)                           = 2,933   (equal -> no column varies within a group)
-- collapsing to the natural key loses nothing that is not a duplicate:
distinct (country,state,city,postcode)                                  = 3,040
total rows                                                              = 5,973   (3,040 MY-and-foreign kept + 2,933 dup)
rows_with_warehouse_override (would be lost on a careless dedupe)        = 0
```

The CN/SG rows added by mig 0181 (`INSERT ... WHERE NOT EXISTS`) are the ~107
singletons — they were seeded idempotently and are NOT doubled; only the MY seed
ran twice.

**Fix.** `backend/src/db/migrations-pg/20260911T1730_scm_localities_dedupe_unique.sql`
de-duplicates on the natural key `(country, state, city, postcode)` — keeping,
per key, the row with a non-null `warehouse_id` if any (a defensive tie-break;
there are none today) else the lowest `id` — then adds a UNIQUE index on that
key so a re-run can never double it again (it fails loudly instead, the
behaviour CLAUDE.md's *Migrations* section wants). Row count falls 5,973 ->
3,040, proven equal to `distinct (country,state,city,postcode)` above.
`POST /localities` now maps the Postgres unique-violation (`23505`) to a clean
`409` ("this locality already exists") instead of the raw `500 insert_failed`
the new index would otherwise produce, so the SO Maintenance Localities editor
stays legible.

The pin is the **structural** unique index, not a vitest test: the test suite
runs on D1, while this table and its dedupe are Postgres-only and applied by
`pg-migrate` on deploy, so there is nothing a D1 test can execute here. The
evidence is the live before/after count measured on the same connection
(variance = 0; 5,973 -> 3,040), and the deploy's own `APPLIED <file>` log plus a
re-count is the production verification. **UNVERIFIED until deployed:** the
migration has not yet run against prod at the time of writing.

**Not the reported bug.** `53300` was never missing. The `No match` the operator
saw is a separate, older-build symptom — before 2026-08-15 the postcode picker
fell back on City and offered nothing until a City was chosen
(`docs/modules/address-cascade.md` §4). On the current build `postcodesInState`
lists it under State alone. No code change was needed for that half; it is
recorded here only so the next reader does not chase "missing postcode" again.

**Ref.** fix/scm-localities-dedupe, 2026-09-11.
