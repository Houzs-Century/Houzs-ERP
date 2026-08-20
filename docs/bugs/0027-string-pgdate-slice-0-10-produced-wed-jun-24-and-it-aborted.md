## `String(pgDate).slice(0,10)` produced "Wed Jun 24", and it aborted the sofa stock opening on its first INSERT [medium]

**Symptom** - the first-ever APPLY run of `import-ac-sofa-stock.mjs` against
production (run 31420345698, 2026-08-11) died immediately with
`PostgresError: invalid input syntax for type timestamp with time zone:
"Wed Jun 24T00:00:00Z"`. None of the 109 planned sofa lots were written.

**Root cause (traced, not guessed)** - `:169` built the build's receipt date as
`String(l.po_date).slice(0, 10)`. `po_date` comes back from the `postgres`
driver as a **JS `Date`**, and `Date.prototype.toString()` is the locale form
`"Wed Jun 24 2026 08:00:00 GMT+0800 (…)"` - not ISO. Slicing ten characters
yields `"Wed Jun 24"`. The writer then pasted that straight into the SQL text as
`` `'${p.receivedAt}T00:00:00Z'` ``, so Postgres received the literal
`'Wed Jun 24T00:00:00Z'`.

The other date source was fine and is worth recording so nobody "fixes" it too:
`ac-stock-layers.json.gz` stores `Date` as a clean `"YYYY-MM-DD"` **string**, so
the same slice was correct there. One expression, two callers, only one of them
holding a `Date` - which is exactly why it survived every dry-run: the dry-run
never reaches the INSERT, and the projection does not touch the date.

**Fix** - one `isoDay()` helper that branches on `instanceof Date` (ISO via
`toISOString()`) versus a string with a leading `YYYY-MM-DD`, returning null
rather than a malformed value, applied to BOTH date sources. The INSERT now
**binds every value** instead of interpolating any of them into the SQL text,
so a bad value can no longer become syntactically-valid-looking SQL. Progress
logging tightened from every 50 rows to every 25 so a partial write is visible.

**Verified** - a re-run of the DRY-RUN read `already opened by an earlier run: 0`,
confirming from an independent query that the aborted APPLY wrote **nothing** and
left no partial state to compensate for.

**The class, for next time** - `String(x).slice(0,10)` is only an ISO date when
`x` is already an ISO string. Against a driver that hydrates `date`/`timestamp`
columns into `Date` objects it silently produces a weekday-prefixed fragment.
Use `toISOString()`, and **bind dates as parameters** - had the value been bound
rather than interpolated, the driver would have serialised the `Date` correctly
and the bug would never have existed.

**Ref** - 2026-08-11, PR #1942 (fix/stock-criterion-close).
