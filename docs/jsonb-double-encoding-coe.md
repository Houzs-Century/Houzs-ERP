# COE — a stringified value bound to a jsonb parameter, three times in one day

**Date** — 2026-08-10, during the AutoCount cutover.

## Trigger

Three production apply runs of `refresh-sofa-colours.mjs` reported

```
APPLIED - stamped 127 sofa lines.     run 31405014029, 15:42
APPLIED - stamped 146 sofa lines.     run 31408769884, 16:24
APPLIED - stamped 146 sofa lines.     run 31409522533, 16:34:27
```

with `raced` 0 on every one — meaning every UPDATE came back with a non-zero
rowcount. The dry-run 29 seconds after the last (31409538247, read at 16:35:00)
reported the identical `already set 440 / TO FILL 146`.

`already set` read **440 in every run of the script that day** — 15:22, 15:42,
16:24, 16:25, 16:26, 16:33, 16:35. 419 claimed stamps moved the number zero
times, and the cutover spent an afternoon believing three successful writes had
happened.

The writes had happened. They were destroying the column.

## Root cause, traced with evidence

The tool that proved it: a read-only probe (`probe-write-persistence.mjs`,
`.github/workflows/probe-write-persistence.yml`), prod run **31416469998**,
printing the raw `variants` jsonb of five lines an apply claimed to have
stamped.

```
[{"colourId": null, "fabricId": null, "specials": [], "legHeight": "Default",
  "seatHeight": "28", "colourLabel": "J9047-1-Brunette", "fabricLabel": null},
 "{\"fabricId\":\"GIRONA J9047\",\"colourId\":\"GIRONA J9047-01 BEUNETTE\",...}",
 "{\"fabricId\":\"GIRONA J9047\",...}",
 "{\"fabricId\":\"GIRONA J9047\",...}"]
```

`variants` is an **array**: the original object at element 0, then one JSON
**string** per apply run. The database confirmed the shape independently by
refusing the probe's own key histogram — `cannot call jsonb_object_keys on an
array` — which is what ended that probe run.

The chain, each link checkable:

1. `refresh-sofa-colours.mjs` bound `JSON.stringify(u.patch)` — already a
   string — to a `$1::jsonb` parameter.
2. The client is `postgres` (postgres.js 3.4.9) with `prepare: false`.
   `node_modules/postgres/src/connection.js:238` sets
   `q.describeFirst = q.onlyDescribe || (parameters.length && !q.prepared)`.
   With parameters and no prepared statement that is unconditionally true, so
   the driver sends Parse+Describe and waits for the **server** to report the
   parameter types before it binds (`connection.js:632-633`).
3. The server resolves `$1` to jsonb, OID 3802.
4. `types.js:17-19` registers `serialize: x => JSON.stringify(x)` for the json
   type with `from: [114, 3802]`, and `types.js:205-206` installs that
   serializer under **every** OID in `from`. The driver therefore JSON-encoded
   the value a second time and sent `"{\"fabricId\":...}"`.
5. `$1::jsonb` evaluated to a jsonb **string scalar**, not an object.
6. In PostgreSQL, `jsonb || jsonb` merges only when both operands are objects.
   Object `||` non-object **concatenates into an array**. `variants` became
   `[original, "patch"]`.
7. `variants->>'fabricId'` on an array is NULL, so the guard
   `COALESCE(variants->>'fabricId','') = ''` stayed TRUE and re-admitted the
   same row on the next run — hence exactly one appended string per apply, and
   `raced` 0 every time.
8. The row genuinely was updated on each pass, so the command tag genuinely said
   `UPDATE 1`. `res.count` was telling the truth about the wrong question.

**The class had already bitten this repo twice the same day, and was documented
rather than fixed.** `backfill-sofa-special-orders.mjs` did it to
`custom_specials` (#1913); `check-specials-and-ocr.mjs:67` and
`check-sofa-bedframe-completeness.mjs:57` were then given careful comments
explaining that the column holds a jsonb STRING and teaching readers to coerce
it. Nobody changed the writers. Hours later a third script walked into the same
trap, and a fourth (`cross-fill-so-po-variants.mjs`) and fifth
(`backfill-specials-into-variants.mjs`) were sitting in the tree loaded.

## Fixes shipped

| PR | Effect |
|---|---|
| #1927 | Read-only probe: connection identity, relation identity in every schema, raw `variants` + `xmin` of rows an apply claims it stamped, key histogram. This is what produced the evidence above. |
| #1938 | `tx.json(patch)` instead of `JSON.stringify` in `refresh-sofa-colours.mjs`; the same one-line change in the three other scripts still binding a stringified value to a jsonb parameter; `RETURNING` with the script counting what came BACK rather than the command tag; a shape repair driven by `jsonb_typeof(variants) = 'array'` restoring `variants -> 0`; a post-apply read on a fresh connection that prints bound-before / bound-after and emits `::error::` if the number did not move. Removes `probe-write-shapes`, which wrote through the corrupting shape. |

## What the audit RULED OUT

Each of these was a live theory and each is refuted, so nobody re-chases them:

- **The transaction never committed.** Refuted. `sql.begin` issues `commit`
  through the same handler on the same reserved connection
  (`postgres/src/index.js:275-279`); a failed commit rejects and the script
  would have exited non-zero. The rows *were* modified — element 0 plus the
  appended strings prove three separate committed writes.
- **`sql.begin` + `tx.unsafe` is broken in postgres.js.** Refuted. This was the
  most expensive wrong theory, because it briefly looked like a go-live blocker:
  `scm/lib/pg-supabase-transaction.ts` puts exactly that shape behind seven
  staff endpoints. It is fine. `apply-sofa-compartment-corrections.mjs` uses
  `sql.begin` + `tx` tagged templates with `tx.json(obj)` and its writes landed
  (verified in prod: HC-PO-000254 carries `5526-1ABOX(LHF)`, `5526-2A(RHF)`,
  `5526-1NA`). `import-ac-outstanding-so.mjs` uses `tx.unsafe(text)` with **no**
  parameter array — the simple protocol, where no serializer runs — and it
  landed the entire SO migration. The defect needs a stringified value AND a
  jsonb parameter; neither of those scripts has both.
- **Hyperdrive caching.** Refuted. Both the write and the verifying read ran
  direct from GitHub Actions on `secrets.DATABASE_URL`; Hyperdrive was never in
  that path.
- **The write freeze.** Refuted. `scm/lib/write-freeze.ts` is API middleware on
  `/api/scm/*`; it is not enforced in the database and cannot touch a script.
- **A concurrent writer clobbering the rows.** Refuted. The concurrency group
  `refresh-sofa-colours-prod` serialises the runs, and the only writes between
  the 16:34:27 apply and the 16:35:00 read were none.
- **A near-miss key name** — the failure mode the script's own docstring warns
  about, and which bit the venue picker earlier in the cutover. Refuted: the
  detector tests three independent keys (`fabricId`, `colourId`, `fabricCode`)
  and the patch writes all three plus two more. A single misspelling could not
  hide from all three.
- **A `BEFORE UPDATE` trigger returning OLD, or an `INSTEAD OF` rule.** Refuted
  by reading the catalogue: the only trigger on either table is
  `trg_po_item_qty_guard` (BEFORE UPDATE **OF qty** on `purchase_order_items`),
  and `pg_rules` returns zero rows for both.
- **A replica or a second database.** Refuted: `pg_is_in_recovery()` false,
  `current_database()` `postgres`, `transaction_read_only` off.
- **A duplicate table shadowing via `search_path`.** Genuinely present but not
  the cause — there IS a `public.mfg_sales_order_items` alongside
  `scm.mfg_sales_order_items`, and `search_path` is `"$user", public,
  extensions`. Every statement in the script is schema-qualified `scm.`, so it
  was never reached. **This is still a live hazard for any unqualified query and
  is listed under Deferred.**

## Deferred

- **The sibling data damage is not repaired by #1938.** The encoding is fixed in
  all four writers, but rows already written by
  `backfill-sofa-special-orders.mjs` (`custom_specials` as a jsonb string) and
  `backfill-specials-into-variants.mjs` (`variants.specials` as a jsonb string)
  still hold the double-encoded shape. #1938's probe now measures both so the
  size is known. Decision owner: the specials workstream, which already has
  `check-specials-and-ocr.mjs` reading these rows.
- **`public.mfg_sales_order_items` shadowing `scm.`** with `public` ahead of
  `scm` on the search_path. Nothing hit it today because everything is
  schema-qualified. Decision owner: the owner / IT, as a schema cleanup.
- **Every other `res.count`-only writer in `backend/scripts`.** #1938 fixed the
  reporting in the scripts it touched. There are ~50 scripts using `sql.begin`;
  any that report success from a command tag can mislead the same way even
  without this encoding bug.

## Lessons

1. **A rowcount answers "did a row change", never "does the row now hold what I
   meant".** Every sweep that reports success from a command tag is reporting
   its own intention. Use `RETURNING`, count what comes back, and confirm on a
   fresh connection — the connection that just wrote is the worst available
   witness.
2. **Never hand a pre-serialized string to a json/jsonb parameter in
   postgres.js.** Pass the value; let `sql.json()` type it. The driver applies
   its own `JSON.stringify` to anything it resolves to OID 114 or 3802, and with
   `prepare: false` it always learns that type from the server first, so the
   `::jsonb` cast in your SQL is what triggers the double encoding.
3. **`jsonb || jsonb` is not a merge operator.** It is a merge operator only
   between two objects. Anything else concatenates, silently, into an array —
   and an array answers `->>'anykey'` with NULL, which is exactly the value a
   `COALESCE(..., '') = ''` guard is looking for. A write guard that reads the
   column it writes will loop forever on a shape it did not anticipate.
4. **Documenting a trap is not fixing it.** Two files were given careful
   comments explaining this exact double-encoding after its first occurrence.
   The comments taught readers to tolerate the bad data. The writers stayed
   broken, and the trap caught a third script the same afternoon. When a defect
   class is identified, fix every instance of the class in that PR, or the
   comment becomes a monument to it.

## Lesson 2 now has an executable form

**`npm --prefix backend run audit:jsonb-binds`** — `backend/scripts/check-jsonb-binds.mjs`,
wired into `.github/workflows/ci.yml` (`backend-typecheck`), proved by
`backend/tests/jsonbBindScan.node.mjs`.

It fails on any `JSON.stringify` bound as a query parameter anywhere in
`backend/src` or `backend/scripts`, in both shapes this repo writes: interpolated
into a SQL tagged template, or placed in the params array of `.unsafe(text, [...])`.
The single legal escape is `$n::text::jsonb`, matched per placeholder.

This section exists because Lesson 4 was right about this COE too. The document
was written on 2026-08-11, read, and the class fired again on 2026-08-13 in the
repair script written to undo the damage — seven production rows went from
array-shaped to string-shaped. When the check was added on 2026-08-13, **two
violations were still live on `main`**:

- `backend/scripts/split-collapsed-sofa-lines.mjs` — `$2::jsonb` with a
  stringified bind, ten lines below a correct `tx.json()` in the same file.
- `backend/scripts/backfill-2990-delivered-dos.mjs` — a stringified array into
  `scm.mfg_so_audit_log.field_changes` (`jsonb NOT NULL`) with **no cast at all**.

That second one is why Lesson 2's last clause needs amending. It says *"the
`::jsonb` cast in your SQL is what triggers the double encoding"* — and the sweeps
that grepped for the cast therefore missed this site. The cast is not the trigger;
the **server-resolved parameter type** is, and the column being jsonb is enough on
its own. Look at the parameter, not the cast. The check does.

One reviewed exception is allowlisted in the checker, with its reason:
`seed-user-management.mjs` writes `roles.permissions`, which is a `text` column
holding JSON as text (`0000_baseline.sql:471`), so the string is the intended value.

See `docs/bug-classes.md`, class A. **A COE is not closed until it names the file
path of the check that now fails on its shape.**
