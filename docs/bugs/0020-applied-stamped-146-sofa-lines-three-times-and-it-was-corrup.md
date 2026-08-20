## "APPLIED - stamped 146 sofa lines", three times, and it was corrupting them [high]

**Symptom** — `refresh-sofa-colours.mjs` was dispatched against prod with
`apply=1` three times on 2026-08-10 (runs 31405014029, 31408769884,
31409522533) and reported `APPLIED - stamped 127 / 146 / 146 sofa lines` with
`raced` 0, meaning every single UPDATE came back with a non-zero rowcount. The
dry-run 29 seconds after the last one (31409538247) reported the identical
`already set 440 / TO FILL 146`. In fact **every** run of the script that day —
15:22, 15:42, 16:24, 16:25, 16:26, 16:33, 16:35 — reported `already set 440`.
419 claimed stamps moved the number zero times.

**Root cause (traced, not guessed)** — the write was not lost. It landed, and
it destroyed the column. Probe run 31416469998 read the raw jsonb of five lines
an apply claimed to have stamped:

```
[{"colourId": null, "fabricId": null, "specials": [], "legHeight": "Default",
  "seatHeight": "28", "colourLabel": "J9047-1-Brunette", ...},
 "{\"fabricId\":\"GIRONA J9047\",\"colourId\":\"GIRONA J9047-01 BEUNETTE\",...}",
 "{\"fabricId\":\"GIRONA J9047\",...}",
 "{\"fabricId\":\"GIRONA J9047\",...}"]
```

`variants` is an **array**: the original object, then one JSON **string** per
apply run. The chain, every link verifiable:

1. `refresh-sofa-colours.mjs` bound `JSON.stringify(u.patch)` — already a
   string — to a `$1::jsonb` parameter.
2. postgres.js is configured `prepare: false`, and `connection.js:238` sets
   `describeFirst = q.onlyDescribe || (parameters.length && !q.prepared)`. With
   parameters and no prepared statement that is unconditionally true, so the
   driver sends Parse+Describe and **waits for the server to tell it the
   parameter types** before it binds (`connection.js:632-633`).
3. The server resolves `$1` to jsonb, OID 3802.
4. `types.js:17-19` registers `serialize: x => JSON.stringify(x)` for the json
   type, and `types.js:205-206` installs that serializer under every OID in its
   `from` list — 114 **and 3802**. So the driver JSON-encoded the value a
   second time and sent `"{\"fabricId\":...}"`.
5. `$1::jsonb` therefore evaluated to a jsonb **string scalar**, not an object.
6. In PostgreSQL `jsonb || jsonb` only merges when **both** sides are objects.
   Object `||` non-object concatenates into an array. `variants` became
   `[original, "patch"]`.
7. `variants->>'fabricId'` on an array is NULL, so
   `COALESCE(variants->>'fabricId','') = ''` stayed true and the guard admitted
   the row again on the next run — which is why there is one appended string
   per apply, and why `raced` was 0 every time.
8. The row genuinely was updated each time, so the command tag genuinely said
   `UPDATE 1`. `res.count` was reporting the truth about the wrong question.

Why the day's other applies were fine, which is what made this look like a
driver-wide fault: `apply-sofa-compartment-corrections.mjs` binds `tx.json(p.v)`
— an object, encoded once — and `import-ac-outstanding-so.mjs` calls
`tx.unsafe(text)` with **no** parameter array, which takes the simple protocol
where no serializer runs at all. Neither can hit this. The defect is not
`sql.begin`, not `unsafe`, not Hyperdrive, not the pooler: it is
`JSON.stringify` into a jsonb parameter.

**This class was already in the tree, twice.** `check-specials-and-ocr.mjs:67`
and `check-sofa-bedframe-completeness.mjs:57` both carry comments describing
exactly this trap after `backfill-sofa-special-orders.mjs` did it to
`custom_specials` earlier the same day (#1913). Those comments taught readers to
*tolerate* the bad shape; nobody fixed the writers, so a third script walked
into it hours later.

**Fix** — PR #1938.
- `tx.json(u.patch)` instead of `JSON.stringify(u.patch)`. An explicit
  `Parameter` carries its own type, so `ParameterDescription` does not overwrite
  it (`connection.js:632` only fills types that are falsy) and the object is
  encoded exactly once.
- The same one-line change in the three other scripts that still bound a
  stringified value to a jsonb parameter — `backfill-sofa-special-orders.mjs`,
  `backfill-specials-into-variants.mjs`, `cross-fill-so-po-variants.mjs` —
  because leaving a proven trap loaded in three places is how it found a fourth.
- The statement now ends in `RETURNING variants->>'fabricId'` and the script
  counts **what came back**, not the command tag.
- A shape repair driven by `jsonb_typeof(variants) = 'array'`, not by the fill
  list: `variants = variants -> 0` restores the original object. It is scoped by
  shape so that a damaged row whose colour no longer resolves is still repaired,
  and it refuses any array whose element 0 is not an object.
- The script re-opens a **new connection** after `sql.end()` and prints the
  bound count before and after. It emits `::error::` if the count did not move.

**Lesson** — a non-zero rowcount answers "did a row change", never "does the row
now hold what I meant". Any sweep that reports success from a command tag is
reporting its own intention. Verify with `RETURNING`, and confirm with a read on
a fresh connection; the script that just wrote is the worst available witness.
And: never hand a pre-serialized string to a json/jsonb parameter in
postgres.js — pass the value and let `sql.json()` type it.

**Ref** — 2026-08-10, PR #1938 (fix/colour-write-persistence). Evidence: probe
run 31416469998; damage confirmed by the database itself refusing
`jsonb_object_keys` on those rows.
