## The repair expected one outbox row per document and production had five [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The first PLAN dispatch of `repair-outbox-sent-by-hand.mjs` (run
`31985282257`, 2026-08-17) refused with `HC-DO-2608-001: expected exactly one
so_to_do outbox row, found 2` and the same for `HC-DO-2608-002`. Five rows for
three documents, not three.

**Root cause — read off the plan's own dump, not reasoned about.** Both delivery
orders carry TWO `so_to_do` rows, because the **Send again** button had already
been pressed on 2026-08-16 15:12:

| row | `last_error` starts | state the page shows |
|---|---|---|
| the original | `[re-queued 2026-08-16T15:12:18.208Z -> outbox 07a12861-…]` | `requeued` — history |
| the row that press inserted | `Gave up after 6 attempts. Last error: Invalid transfer item. \|\| source SO lines as the book holds them: …` | `failed` — live backlog |

`annotate` deliberately leaves a re-queued row's status alone (nothing was ever
sent for it), so the predecessor stays `failed` in the column while
`acOutboxState` reads the marker and reports `requeued`. Counting rows by
`(doc_no, op)` therefore over-counts by exactly the number of times anyone has
pressed the button.

**This also settles the window question with production data rather than code
reading.** The live row on each delivery order is `failed`, its payload is
composed (`writeback` names `delivery_orders.id=441fd56a-…` and
`2c61d592-…`), and the ERP document carries no `linked_ac_docno` — the three
facts `transferVerdict` requires to re-send. The predecessor is not re-sendable:
`requeueOneRow` answers `already-requeued` to any row carrying the marker,
before it looks at status or payload.

**Fix.** Select the LIVE row — the one without the re-queue marker — and require
exactly one of those, reporting the superseded predecessors and leaving them
untouched. The post-repair assertion changed with it: the window is closed when
every row is `sent` **or** carries the marker, which are the two rungs
`requeueOneRow` refuses unconditionally, rather than the cruder "every row is
`sent`" that would have failed against a predecessor it was right to leave alone.

**Lesson.** The plan mode earned its keep on its first run. Had this shipped
straight to APPLY it would have written nothing and exited 3 — the refusal was
correct — but the assumption behind it ("one document, one outbox row") was
invisible until a production dispatch printed the rows.

**Ref.** PR #2344, 2026-08-17.
