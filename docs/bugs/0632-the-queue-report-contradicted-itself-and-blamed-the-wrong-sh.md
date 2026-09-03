## The queue report contradicted itself and blamed the wrong shape [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The owner read the AutoCount queue report and asked:

> 「为什么会有矛盾的点呢」

Two sentences in one report, both wrong, and both caught by a person reading
rather than by any check.

**1. The totals line counted the same rows twice, two ways.**

```
queue: 30 row(s) — pending 0 / sent 26 / failed 1 / skipped 3 (3 of those have been re-queued)
```

"of those" named no set. The three re-queued rows are INSIDE `skipped 3`, and
they are history — already asked again, waiting on nobody. A reader cannot tell
from that line whether three things are outstanding or none are.

**2. The FAILED heading asserted a shape it could not know.**

```
FAILED: 1 — each is a document that is in the ERP and NOT in AutoCount.
  SO HC-SO-013361 (edit, 6 attempts): ... line 913803 not found on SO-013361
```

That sentence is true of a failed CREATE and false of everything else. It was
printed over a failed **EDIT** — of a document the owner had **open in AutoCount
at that moment**. The document was plainly there; the edit had not landed.

**Root cause.** Both are the same species: a line that asserts ONE shape for a
set that holds several. And both were unreachable by a test, written inline in a
700-line reporter — which is why the identical class was fixed on 2026-09-02 in
`check-autocount-held-back.mjs` (a row labelled history and then counted as
backlog) and the fix reached that report and not this one.

**Fix.** Both sentences moved into
`backend/scripts/lib/ac-queue-report-lines.mjs`, where a test can hold them to
what they claim:

* the totals clause now names the set the re-queued rows sit inside and calls
  them history explicitly;
* the FAILED heading reads the OPS of the rows it is about — a create means the
  document is not there, an edit or convert means it is there and the change did
  not land, and a mixed batch says both. The per-row reasons underneath are
  unchanged.

The end-of-run alarm carried the same "in the ERP and NOT in AutoCount" wording
and is corrected with it.

**Verified.** `backend/tests/acQueueReportLines.test.ts` — 9 tests, including the
exact failed-EDIT row that exposed it and an assertion that the old "of those
have been re-queued" phrasing never returns. 13 pass with the skip-grouping
suite alongside it. `node --check` parses the reporter.

**The lesson, which is the reason this entry is worth its length.** A sentence
that cannot be tested gets written once and then read hundreds of times. Both of
these were reasonable when written and became wrong when the data grew a second
shape — and nothing but a person noticed, twice.

**Ref.** fix/the-queue-report-said-two-untrue-things, 2026-09-03.
