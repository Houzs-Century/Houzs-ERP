## Nine receipts stood at "1 of 2 matched" because the book never had the second line [high]

**Symptom.** After the relink learned the book's own spelling
(`docs/bugs/0816`), nine goods receipts moved from `0 matched` to `1 matched`
and stopped there:

```
GR HC-GRN-2609-015: 2 keyless, 1 matched
   refused: 'AK-SLEEP ESSENTIAL 7 HOLES' — the account book has no unclaimed line with that item code
```

The mattress matched. The free pillow that rides with it did not, on eleven
lines across nine documents — and a document only moves when EVERY line is
keyed, so all nine stayed exactly where they were.

**Root cause.** The book's copy of the receipt has no pillow line at all. The
conversion transferred the purchase order's lines and the pillow was never one
of them, so it is not a line the matcher failed to find — **it is a line the
book does not have**. No amount of matching will ever key it.

**AcSyncService names this exit itself**, in the refusal it raises:

> *"Store the line's AutoCount DtlKey (scm.\*_items.linked_ac_dtlkey) **or mark
> the line IsNewLine**, then retry."*

`IsNewLine` is the sanctioned second way, and `enqueueEdit` has carried
`newLineIds` since `docs/bugs/0588`. The relink path simply never used it.

**What makes the declaration honest, and both halves are required.**

1. **Every other line on the document is keyed** — which is what the run just
   finished doing, and the same condition `composeEdit` already demands before
   it will believe a declared-new line.
2. **The book carries no line with that item code, claimed or not** — the new
   `RelinkPlan.absent`, which is NOT the "no unclaimed line" sentence in
   `refused`. A book line another ERP row has claimed still EXISTS; declaring
   against it would append a second copy of a line the book already holds.

**Why the bar is that high.** This SDK gives `DeleteDetail` to `SalesOrder`
alone — `AcSyncService.cs:3523`. A duplicate appended to a purchase order or a
goods receipt is permanent, and the entire keyless guard exists because of it. A
declaration that were merely probable would be worse than the refusal it
replaces.

**Three refusals deliberately excluded.** A claimed line (it exists), an
ambiguous repeat (the book holds those lines and only cannot separate them), and
the folded-sofa refusal — that one asks about `<model>-1S`, and a build the book
holds under its compartments' own codes is absent under the folded code while
being entirely present.

**This is not a rebuild, and it should not be one.** `Rebuild` destroys and
reissues every DtlKey on the document and `AcSyncService` refuses it outright
once any line has been transferred downstream. `IsNewLine` touches the one row.

**Tests.** Four in `autocount-relink-lines.test.ts` and three in
`autocountRelinkSweep.test.ts`, all RED against the unfixed tree: a code on no
book line is absent; a code whose only book line another row claimed is NOT; an
ambiguous repeat never is; a folded-sofa refusal never is; the edit is queued
naming the absent row; nothing is declared while another line is unmatched for a
different reason; nothing is declared when the run stamped no key at all.
`scm/` whole: **3240 passed**. `typecheck` clean.

**Ref.** 2026-09-11. The chain that had to land first: `0812` (the sofa fold),
`0813` (the drain's silence), `0815` (the sweep's silence), `0816` (the book's
spelling). This is the last link.
