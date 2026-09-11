## The invoice-link diagnostic counted only the rows that fitted on screen [medium]

**Symptom.** `diag-pi-gr-links.mjs` answers the question that decides whether the
purchase-invoice chain repair is safe: of the invoice lines whose receipt does
not name its book receipt, how many are DERIVABLE (the book's receipt is already
stamped on their purchase order, so the stamp states a fact we hold) and how many
are ERP-native (where stamping would INVENT a link). On 2026-09-09 the same tree,
the same book snapshot and the same database gave two different answers minutes
apart:

| run | `SHOW` | what it printed |
|---|---|---|
| [34355044338](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34355044338) | 40 (the default) | `invoice lines on cause B: 59 · IS stamped on their PO: 40 · NOT on the PO: 0 · no receipt row read: 0` |
| [34355268645](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34355268645) | 300 | `invoice lines on cause B: 59 · IS stamped on their PO: 59 · NOT on the PO: 0 · no receipt row read: 0` |

The first line reads as 19 invoice lines nobody can account for — 19 lines that
might be the ERP-native ones the repair must never touch. They are not: the
number is a display setting.

**Root cause (traced).** The classification and the printing were ONE loop over
`[...grnDocGaps].slice(0, SHOW)` (`backend/scripts/diag-pi-gr-links.mjs`, the
cause-B block of section 3). The three counters were incremented inside it, so
they described only the rows that were printed, while the denominator beside them
— `grnDocGaps.size` — described all of them. `SHOW` defaults to 40 and the
workflow passes its own default of 40, so every run of this diagnostic since it
was written has under-reported the classification whenever there were more than
40 lines, and the summary silently stopped adding up.

This is `CLAUDE.md`'s *check that answers a different question*: nothing failed,
nothing was empty, and the successful result was ALSO true of a smaller
population than the one it named. The sibling block in the same file — section 4,
cause A — counts over the whole `linkMissing` array and only slices for display,
which is what makes this an accident rather than a convention.

**Fix.** Classify every line first into a `classified` array, then print at most
`SHOW` of it. The three buckets are asserted to sum to the classified length, so
a fifth verdict added later refuses rather than printing a summary that does not
add up, and the truncation notice now says the counts below cover every line,
printed or not.

**Proved RED against production before the change**, which is the only place this
can be proved: the two runs in the table above are the same code, the same data
and the same day, differing only in `SHOW`. Re-dispatching the workflow at its
default `SHOW=40` after this lands must print `59` where it printed `40`.

**Not a data defect, and no repair acted on the wrong number.** The
purchase-invoice chain repair had not been written when this was found; the
diagnostic was being read to decide whether to write it. The correct figure is
that all 59 lines across 20 invoices are DERIVABLE.

**Ref.** fix/pi-align-2026-09-09, 2026-09-09.
