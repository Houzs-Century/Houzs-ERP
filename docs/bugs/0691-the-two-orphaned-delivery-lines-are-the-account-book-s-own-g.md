## the two orphaned delivery lines are the account book's own gap, not a link the ERP lost [low]

**Symptom.** The `DO->SO link orphan sentinel` has been FAILING since
2026-09-08 04:33 local — `4 orphan DO lines across 3 documents [baseline 1]` —
and it emails the owner on every scheduled run. Two of the four are
`HC-DO-001800 from HC-SO-002281` (`HB109M-CC` qty 3, `HB109NL` qty 3) and one is
`HC-DO-005583 from HC-SO-007435` (`AK-SK FX AIRLOFT PIL` qty 2). The same two
documents are the entire `DO <- SO` gap in the convert symmetry matrix — forward
171 of 173 (`docs/transaction-flow-tally.md`).

The standing reading was that a live mechanism blanks `so_item_id` and that
repairing the rows under it would re-orphan them, so nothing was written.

**Root cause (traced).** That reading is wrong for these three lines. They were
never linkable, because the item is not on the sales order **in AutoCount
either**. Read out of `ac-convert-edges.json.gz` (the whole book, cut 2026-09-07
16:39 local):

```
SO-002281  2024-08-10  cancelled=F
   seq  16 | AK-ARMOUR MATT (Q)        qty 1 | transfered 0
   seq  32 | AK- LTX CLS PIL           qty 3 | transfered 3
   seq  48 | NTYR-CS LTX PIL + CSC     qty 3 | transfered 3
   seq  64 | AK-SK + MICROFIL PIL      qty 1 | transfered 0

DO-001800  2024-10-30  cancelled=F
   seq  32 | HB109NL                   qty 3 | from SO SO-002281
   seq  48 | HB109M-CC                 qty 3 | from SO SO-002281
```

Neither `HB109NL` nor `HB109M-CC` is on the order. AutoCount recorded the
delivery anyway and consumed OTHER lines' quantity for it — seq 32 and 48 both
read `TransferedQty 3` of `3`.

`DO-005583` is the same shape, one step subtler:

```
SO-007435  seq 144 | AK-SK + MICROFIL PIL   qty 2 | transfered 2
DO-005583  seq 144 | AK-SK FX AIRLOFT PIL   qty 2 | from SO SO-007435
```

Same sequence number, same quantity, a different product name — a substitution
AutoCount recorded on the delivery note and never on the order.

`repair-do-so-item-links.mjs` reaches the same verdict from the ERP side alone,
without seeing the book, and refuses all three:
`no_so_line_with_that_item_code` (run
[`34182380708`](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34182380708),
2026-09-08 11:07 local, `WOULD REPAIR 0 delivery line(s); 4 refused`). Both
sides agree, which is what makes this the book's gap and not ours.

**Fix.** Nothing to repair — writing `so_item_id` here would INVENT a
relationship AutoCount does not record, against the owner's standing
「跟 autocount 一样」 and against migration-copy-never-compute. What changed is
that the answer is now WRITTEN DOWN and the alarm reflects it:
`BASELINE_ORPHANS` 1 -> 4 in `do-link-orphan-sentinel.mjs`, with each of the
four named beside its answer, and with the condition that would make it a defect
again stated (AutoCount's own order gaining a line for one of these items — a
book change, so it arrives as a re-import, not as silent drift).

That baseline is defined in the file as *"the count of orphans we have an ANSWER
for, not a tolerance"*, and raising it without one is called out there as the
one thing not to do. Three answers are the price of these three, and they are
above.

**What this does NOT say.** It does not clear the blanking mechanism. The
sentinel's own header records that a third mechanism was live and unfound, and
`SO-line deletes in the last 25h: 20` on the same run says deletes still happen.
This entry narrows the population: these three were never a delete's doing, so
they are not evidence for it either way. The sentinel keeps watching for a
FIFTH.

**Ref.** fix/close-flow-gaps-do, 2026-09-08.
