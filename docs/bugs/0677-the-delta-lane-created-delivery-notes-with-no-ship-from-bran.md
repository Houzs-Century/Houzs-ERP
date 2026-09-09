## The delta lane created delivery notes with no ship-from branch after the cutover path got one [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** #3121 gave every migrated delivery order a ship-from branch — owner
ruling 2026-09-07, 「记在单头就好」, header not per line — and the ERP now shows
*Ship-from warehouse* on both surfaces. Every delivery note created from that
moment on by `sync-ac-delta.mjs` still lands with `warehouse_id` and
`sales_location` **NULL**: the very documents raised most recently are the ones
that cannot say which branch shipped them.

**Root cause (traced, not guessed).** `lib/migrated-do-writer.mjs`'s own header
names **two** callers:

```
//   create-migrated-documents.mjs  rows from data/ac-partial-dos.json.gz
//   sync-ac-delta.mjs              rows projected from ac-reconcile-truth.json.gz
```

#3121 updated the first. `sync-ac-delta.mjs:1409` went on calling
`insertMigratedDo(sql, d, { companyId, sysUser, debtorFallback })` — no
`warehouseId`, no `salesLocation`. Both parameters default to `null` in the
writer, deliberately (an unresolved location must stay visibly absent), so the
omission **cannot fail**: it defaults, silently, exactly like the eleven-column
omission #3121 itself was fixing. Same shape as
`docs/bugs/0617-the-migrated-delivery-orders-carried-no-money-at-all.md`.

**And the lane could not have resolved a location even if it had asked.** It
reads `data/ac-reconcile-truth.json.gz`, whose line projection carries no
`Location` column at all — so source 2 of `lib/ac-do-location.mjs` ("the
document's own line Locations, and ONLY when unanimous") was unreachable from
here. Source 1 is unreachable too, and by construction: a note raised AFTER the
fidelity cut has no row in `ac-fidelity-do-headers.json.gz`, and notes raised
after the cut are precisely the population this lane exists for.

**Fix.**

- `sync-ac-delta.mjs` imports `resolveAcDeliveryLocation` from
  `lib/ac-do-location.mjs` — the same module, not a restatement — collects the
  document's line `Location`s where it reads the rows, loads the company's
  warehouses once, and passes `warehouseId` + `salesLocation` into the writer.
  Every document it cannot resolve is PRINTED by name with the module's own
  `why`, and the lane ends with `ship-from branch stamped on N of M`.
- `export-ac-reconcile-truth.mjs` appends `location` to the line projection, so
  source 2 is reachable. **This needs a re-cut**: on the committed snapshot the
  index is `-1`, `cell()` answers null, and the lane says it could not resolve
  rather than defaulting. An absent column must read as "not stated".

**No migration.** Both columns already existed on `scm.delivery_orders`; this is
the second writer learning to fill them.

**Proved.** `backend/tests/acDoLocation.test.mjs` gained 4 assertions over the
wiring (source-level, because what was missing was the wiring, and the rule
itself is already covered by the 12 tests above them). Planted RED by restoring
the original call — `× passes BOTH location fields into insertMigratedDo`,
1 failed / 15 passed — and green with it back: 16 passed.

**Ref.** fix/delta-lane-do-location, 2026-09-08. Second caller of
`docs/bugs/0675-*` / #3121.
