## Every ERP-created Sales Order and Purchase Order would have failed in the live account book, on a foreign key nobody had hit [high]

**Symptom** - none yet, and that is the point: the write-back has never been
switched on, so this would have surfaced as EVERY create failing on the first
day of go-live, on the owner's own P0 slice.

**Root cause (traced, not guessed)** - read off the AutoCount host's own log,
which the cutover file server happens to publish:

```
2026-08-11 11:54:59  /create-so  (no Location on either line)
  -> AutoCount.Data.ForeignKeyException  FK_SODTL_Location
     "dbo.Location", column 'Location'
2026-08-11 11:57:43  /create-so  (Location "KL" on both lines)  -> saved
```

`AcSyncService`'s create path applies the key unconditionally
(`Set(() => d.Location = Str(it, "Location"))`) and `Str` turns an ABSENT key
into `""`, which is not a row in `dbo.Location`. Meanwhile the ERP composer
could not send a location at all: `SO_ITEM_COLS` and `PO_ITEM_COLS` never
selected `warehouse_id`, so every `ErpLine.location` was `undefined` and the
omit-don't-null rule (correct for an edit) dropped the key on every create.

The omit rule arrived with a comment asserting it was "a NO-OP on the create
routes ... so one rule serves both". The two paths need OPPOSITE rules, and the
comment was wrong in the direction that fails every create.

**Fix** - the composer resolves a location per line: the line's own
`warehouse_id` -> the `scm.warehouses` CODE -> `LOCATION_MAP`; then the
document's `sales_location` (a PO has none, its ship-to warehouse being per
line); then REFUSES with `MissingLocationError`, a visible skipped row, rather
than sending `""`. An edit still omits the key, because a blank would erase the
location the account book owns. `composeSoState` / `composePoState` now compose
`create` LAZILY - an edit builds the same state object, and eagerly composing a
create it will never send refused the edit for the create's reasons.

**Mutation-verified**: removing the refusal fails exactly the two tests that
assert it; removing nothing else changes. 84 tests pass across the two suites.

**Ref** - feat/ac-writeback-sofa-collapse, 2026-08-11.
