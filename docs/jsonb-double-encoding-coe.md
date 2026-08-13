# COE — a stringified value bound to a jsonb parameter, three times in one day

**Date** — 2026-08-10, during the AutoCount cutover.
**Recurred** — 2026-08-13, in this COE's own repair script. Seven production
rows were damaged and recovered the same afternoon. **The rule this document
originally gave was not sufficient**; the corrected one is `$n::text::jsonb`.
If you are here for the rule, read [*IT RECURRED*](#it-recurred--2026-08-13-and-the-script-that-reproduced-it-was-this-coes-own-repair)
first — Lesson 2 as first written is what produced the recurrence.

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

## IT RECURRED — 2026-08-13, and the script that reproduced it was this COE's own repair

Three days after this document was written, the repair built to clean up the
damage it describes **caused the same damage again**, on production.

`backend/scripts/repair-array-shaped-variants.mjs` reads an array-shaped
`variants`, proves the tail is redundant against element 0, and writes element 0
back. Its first version bound the recovered object as **`$2::jsonb`**. That is
the fix everybody reaches for after reading this COE, and it is a no-op:

- postgres.js infers the bind type and sends the parameter **already typed
  jsonb**;
- `::jsonb` applied to a value the server has already typed jsonb casts nothing;
- so the serialized text was stored as a **jsonb string scalar** instead of
  being parsed into an object.

Prod apply run **31697989427** (2026-08-13T12:01, `MODE=apply COMPANY=1`) found
7 array-shaped rows on `scm.mfg_sales_order_items`, reported `written: 7 of 7`,
and left all seven as jsonb STRINGS — array-shaped damage converted into
string-shaped damage. The rows were the real ones: `8030-1A(RHF)` ×5,
`8030-1NA`, `9058-1A(RHF)`.

**They were recovered the same afternoon.** Prod run **31711751493**
(2026-08-13T14:48) re-classified all seven as *"jsonb STRING holding the object —
double-encoded, one parse recovers it"*, wrote them with the corrected bind, and
verified on a fresh connection:

```
  written: 7 of 7
  === VERIFIED ON A FRESH CONNECTION ===
  mis-shaped blocks remaining: 0 (was 7); 0 of those are the refused rows
  SO 742ac930-…: variants is object, fabricCode reads "HR805-40"
  SO ad8aa735-…: variants is object, fabricCode reads "AM275-07"
  SO a9c58080-…: variants is object, fabricCode reads "HR805-30"
  SO 2fc633eb-…: variants is object, fabricCode reads "CHINO-12"
  SO f3fb6912-…: variants is object, fabricCode reads "MODENZA-04"
  SO b1906ba2-…: variants is object, fabricCode reads "MODENZA-04"
  SO 9dc36f6f-…: variants is object, fabricCode reads "BO315-21"
```

`jsonb_typeof` is `object` on all seven and `variants->>'fabricCode'` answers
with a real colour, which is the only assertion that distinguishes a repaired
row from a plausibly-shaped one.

**THE CORRECTED RULE — `$n::text::jsonb`. The `::text` is load-bearing.**

```sql
UPDATE … SET variants = $2::text::jsonb WHERE …
```

`::text` forces the parameter to arrive as TEXT, so the following `::jsonb` is a
real **parse** rather than a cast that has nothing to do. Written out, the three
shapes and what each produces:

| bind | what the server receives | result |
|---|---|---|
| `sql.json(obj)` / `tx.json(obj)` | jsonb, driver-serialized once | correct object — preferred in tagged-template code |
| `$n::jsonb` with a `JSON.stringify`d value | jsonb, serialized a second time by the driver | **jsonb STRING scalar** |
| `$n::text::jsonb` with a `JSON.stringify`d value | text, parsed by Postgres | correct object — the shape to use in `sql.unsafe` |

`::text::jsonb` is what `sql.unsafe(sqlText, params)` needs, because there is no
tagged template there to hang `sql.json()` off. Both live uses are in
`repair-array-shaped-variants.mjs` (the bind at line 215, the reason at 198).

**Why this recurrence is the important half of the document.** The original
lesson said *"never hand a pre-serialized string to a jsonb parameter"*, and the
repair's author obeyed it in spirit while writing the exact statement that
re-creates the bug — because the lesson named the value and not the CAST. It is
the same failure as Lesson 4 one level up: the first COE documented the trap
precisely enough to be quoted and not precisely enough to be followed.

What caught it was not the rowcount — that said `7 of 7` both times. It was the
post-write verification asserting `jsonb_typeof` and re-reading `fabricCode` on
a fresh connection. **A repair that reports rows touched has not verified
anything.**

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

- ~~**The sibling data damage is not repaired by #1938.**~~ **CLOSED.** The
  jsonb-STRING `custom_specials` rows were NULLed by #1944. The array-shaped
  remainder was then deliberately NOT touched: the census
  (`backend/scripts/census-custom-specials-arrays.mjs`) classified them from
  their ELEMENTS and found they are the BEDFRAME specials pass's correct
  `string[]`, not this bug's output — NULLing them would have deleted a
  currently-rendering line item from historical documents. That reasoning is in
  `BUG-HISTORY.md` under *"The array-shaped custom_specials are NOT the same
  damage"*. The genuinely array-shaped `variants` rows were repaired on
  2026-08-13 — see the recurrence section above for how that went.
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
   postgres.js — and `::jsonb` alone does NOT rescue you.** Pass the value and
   let `sql.json()` type it. The driver applies its own `JSON.stringify` to
   anything it resolves to OID 114 or 3802, and with `prepare: false` it always
   learns that type from the server first, so the `::jsonb` cast in your SQL is
   what triggers the double encoding — it is not the fix for it. Where you must
   bind a string (`sql.unsafe`, no tagged template), the cast is
   **`$n::text::jsonb`**: `::text` makes Postgres PARSE the value instead of
   re-labelling something it has already typed. Writing `$n::jsonb` there is the
   mistake that made this incident happen a second time on 2026-08-13 — see the
   recurrence section above.
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
