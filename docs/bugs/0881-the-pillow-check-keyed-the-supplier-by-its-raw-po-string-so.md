## The pillow check keyed the supplier by its raw PO string, so one document written two ways read as two differences [low]

**Symptom.** The first production run of `check-supplier-accessory-vs-erp.mjs`
(34777318705, 2026-09-14) reported:

```
QTY DIFFERS
   HC-PO-009780     SQUARE   supplier   2   ours   3   received   3
   HC-PO-009780     SQUARE   supplier   1   ours   3   received   3
```

One purchase order, the same pillow type, listed twice with two different
supplier quantities. That shape is itself the tell: a document cannot disagree
with itself two ways.

**Root cause (traced to the rows).** The supplier export writes that one PO
under two spellings — `PO--009780` (double dash) with 2 pillows and
`PO-009780` with 1. The check keyed its supplier totals by the RAW reference,
so they became two entries; both normalised to the same purchase order at
lookup, and each half was compared against our FULL quantity of 3. The document
agrees: 2 + 1 = 3.

The double-dash was already known and handled — at LOOKUP. Normalising at
lookup but not at the point the totals are accumulated is the gap.

**Fix.** Totals are keyed by the normalised reference, so every spelling of one
PO sums into one entry before anything is compared. The check also prints, for
every row that differs, our actual item code and description AND the linked
customer line, so a difference names what we actually hold instead of a type
the reader inferred.

**Ref.** fix/accessory-check-merges-split-refs, 2026-09-14. Caught by reading
the raw supplier rows for the flagged document before acting on the report.
