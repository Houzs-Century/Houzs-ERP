## The cancel guard was working, and the earlier finding against it is unresolved [medium]

<!-- area: AutoCount sync + write-back -->

**Withdrawn, in part.** `qa-convert.ps1` reported on 2026-08-15 that a sales
order cancelled while its delivery order was still live, and that was written up
as "the link did not hold". A second run the same night refutes it:

```
2026-08-15 23:07:35 ERROR /cancel:
  AutoCount.Invoicing.TransferedDocNotAllowToCancelException:
  The document was transfered to other document, so it is not allow to cancel.
```

So AutoCount does refuse, by a named exception, and `/doc-read` separately
proved the link exists on that document's lines (`FromDocType=SO`,
`FromDocNo=...`).

**What is NOT resolved, and is deliberately not smoothed over:** the earlier run
really did cancel — the log carries no `ERROR /cancel` at that timestamp, so it
was not refused and then retried. Two runs of the same shape behaved
differently and the difference has not been established. Recorded as an open
question rather than bridged with a story that makes both fit.

**Ref:** this PR, 2026-08-15.
