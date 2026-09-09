## A line added to a sales order after the import is never carried, and four of them are money [high]

**Symptom.** The go-live reconcile's SO line-count column stood at 19 all day.
After #3192 declared AutoCount's own empty rows it stood at 11, and those 11
looked like eleven separate accidents. Four of the six SO document-total
differences sat on the same documents — `SO-010789` RM 150.00, `SO-003945`
RM 150.00, `SO-008319` RM 150.00, `SO-012842` RM 300.00 — and had been read as
four unrelated money bugs.

**Root cause (traced).** They are one population, and the DtlKey proves it.
`probe-cutover-so-do-lines.mjs` section B classifies every unclaimed book line
across all 2,882 paired sales orders. There are exactly 24 of them, and the
split by AutoCount's own line key is total:

```
EMPTY BOOK ROW  11 lines, every key in  31219 .. 152540
CODED LINE      11 lines, every key in 915889 .. 926603
TEXT-ONLY LINE   2 lines
```

Not one coded line falls below 915889 and not one empty row rises above 152540 —
a gap of 763,349 between the two populations. `SODTL.DtlKey` is monotonic, so a
key in the 9xx,xxx band on an order dated 2024-12-14 is a line **added to that
order after our import ran**. `SO-003945` is the clean case: its own lines run
267789..847974, its docDate is 2024-12-14, and the missing `STORAGE` line is key
915889. Nothing re-reads an existing document's lines after the first import, so
a line added later is never picked up.

Measured over the whole book from the committed cut
(`backend/scripts/data/ac-reconcile-truth.json.gz`), the class is **bounded**:

| type | documents holding a late line beside older ones | lines | money |
| --- | --- | --- | --- |
| SO | 16 | 22 | **RM 750.00** |
| PO | 0 | 0 | RM 0.00 |
| DO | 0 | 0 | RM 0.00 |

The reconcile reports 9 of those 16 documents (11 lines) and **every ringgit**:
150 + 150 + 300 + 150 = RM 750.00. The other 11 late lines are all RM 0.00.

Seven documents carry a late line the reconcile does **not** report. One of them,
`SO-012128`, is PROVEN missing from the ERP and invisible only because its sofa
decomposed into two rows, so the line-count column reads 2 = 2 — the blind spot
`docs/bugs/0691` named. The remaining six are UNKNOWN: they are either outside
the migrated population or invisible the same way.

**Fix.** Not fixed here. This entry records the population, its boundary and its
proof so that one repair can carry all of it instead of four money bugs being
chased one at a time. The repair must copy the book's line — never compute one
(`migration-copy-never-compute`) — and must not write an inventory movement onto
a migrated document.

**Ref.** fix/cutover-127-sweep, 2026-09-08. Probe run `34186980493` (section B,
the exhaustive classification) and run `34188565498` (the seven unreported
candidates, each book line beside its ERP row).
