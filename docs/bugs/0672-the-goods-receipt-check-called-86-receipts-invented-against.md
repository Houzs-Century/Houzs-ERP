## The goods receipt check called 86 receipts invented against a snapshot a month out of date [high]

<!-- area: Cutover + migrated data -->

**Symptom.** `check-gr-fidelity.mjs`, the check written hours earlier to answer
the owner's 「可是 DO GR 你都检查对了？」, ran against production as run
**34134695504** and reported, as its headline:

```
goods receipts INVENTED      86 of 320 migrated goods receipts
   (AutoCount's PO line says TransferedQty 0 AND no GRDTL row exists)
   they assert 259 unit(s) received across 194 line(s)
```

Read at face value that says the ERP believes 259 units arrived from suppliers
that never arrived — a stock and supplier-chasing defect on the eve of go-live.

**Root cause (traced).** The check's AutoCount side was `ac-fidelity-*`, cut
**2026-08-11**. `ac-convert-edges.json.gz` was cut from the same live book on
**2026-09-07 08:39** and carries `PODTL.TransferedQty` per line. Measured
against it, **40 of the 40 named purchase orders had been received** — after the
older cut was taken:

```
PO-009117  11-Aug 0 -> 7-Sep 1        PO-009771  11-Aug 0 -> 7-Sep 22
PO-009435  11-Aug 0 -> 7-Sep 4        PO-009467  11-Aug 0 -> 7-Sep 1
```

Across the whole book between the two cuts: **145 purchase orders received more,
8,935 unchanged, 0 received less.** The ERP was right on every one of them. The
finding was the snapshot's age, reported as the ERP's defect.

This is the shape of `docs/bugs/0666` in a different dimension: there a checker
could not see the CURRENCY axis and reported it as a money difference; here it
could not see the TIME axis and reported it as an invented receipt. Both come
from comparing two things that are not commensurable and printing the gap.

Two things did NOT catch it. The check states its snapshot timestamp on every
run — it printed `2026-08-11T11:57:13` directly above the finding, and a
timestamp nobody subtracts from today is decoration. And the finding reproduced
a pattern that looked exactly like a known real defect (`received_qty` above
AutoCount's own `TransferedQty`, `check-migration-fidelity.mjs`), which made it
plausible instead of suspicious.

**Fix.** The live cut is now the primary truth and the older pair is a second
measure that may only ever RAISE the received figure, never lower it — a receipt
it has not seen yet is staleness, not a defect. Specifically:

- `ac-convert-edges.json.gz` PO lines build `liveTransferByPo` and
  `liveByPoItem`; `acNeverReceived` requires the purchase order to be present in
  the LIVE export and to show zero there.
- The report opens with both timestamps, the gap in days between them, and the
  count of purchase orders that moved between the cuts — before any finding, so
  the reader meets the confound first.
- A new bucket, **STALE, NOT INVENTED**, counts and names every receipt the old
  cut would have flagged and the live book confirms. It is printed and
  explicitly not counted in the verdict.
- A purchase order absent from the live export is UNVERIFIABLE, not a finding.

**The rule to keep.** A checker that reads a committed snapshot must compare its
age against the freshest snapshot in the tree and refuse to call anything a
defect on the older one alone. Printing a timestamp is not the same as using it.
When two sources of the same fact exist at different vintages, the fresher one
decides and the gap between them is a REPORTED QUANTITY, never a silent input.

**Proved.** The false headline is run 34134695504 (2026-09-07 22:46 local); the
refutation is the 40-of-40 comparison above, computed offline against the two
committed snapshots. The corrected run is recorded in
`docs/bugs/0668-the-goods-receipt-contents-were-never-compared-to-autocount.md`.

**Ref.** fix/gr-fidelity-stale-snapshot, 2026-09-07.
