## The GR shape check said clean per-receipt data did not exist [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** `check-gr-shape.mjs`'s first production run
([34135520445](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34135520445),
2026-09-07 22:55 local) ended with a FEASIBILITY section that told the reader
option A could not be built from the tree, and printed the SQL for a fresh
AutoCount export to go and fetch:

```
  Per-receipt QUANTITY is not in any committed snapshot:
  A shape-A writer needs ONE clean export, one row per GRDTL detail key:
    SELECT gr.DocNo, gr.DocDate, g.DtlKey, g.FromDocNo, g.ItemCode, g.Qty ...
```

That export already exists in the repo. Acting on the section would have meant
a needless read against the live book — the one operation the go-live guardrails
single out, because a heavy AutoCount read starves the ERP write-back.

**Root cause (traced).** The check surveyed the snapshots whose *names* say
"gr" — `ac-gr-refs.json.gz` and `ac-fidelity-gr-by-po-item.json.gz` — plus
`ac-fidelity-manifest.json`, found both extracts unusable for per-receipt
quantity (correctly: one fans out, the other aggregates), and concluded the data
did not exist anywhere. It never opened `ac-convert-edges.json.gz`, whose name
says nothing about goods receipts.

That file states its own grain in a field: *"one row per AutoCount DocNo
(headers) and per DtlKey (lines); NO filtering"*, and its `counts` block carries
`GR: {headers: 5353, lines: 21746}`. Its GR headers hold `docNo`, `docDate` and
`cancelled`; its GR lines hold `docNo`, `dtlKey`, `itemKey`, `qty`,
`fromDocType`, `fromDocNo`. It was cut 2026-09-07T08:39:50Z — fresher than
either file that was consulted. `check-gr-fidelity.mjs`, written the same day by
another session, had already picked it as its PRIMARY snapshot for exactly this
reason.

The rows are ARRAYS, positional per `line_fields`, so a first look through
object keys shows `undefined` for every field and reads as an empty or
irrelevant file. That is the trap: the negative result looked like evidence.

**Fix.** The check now reads `ac-convert-edges` for the book at line grain,
cross-checks its (PO, receipt) pair set against `ac-gr-refs` — measured
IDENTICAL, 400 of 400 pairs, 214 receipts, 318 purchase orders, split 248/58/12
from both — and reports the book's own receipt lines and units. The FEASIBILITY
section now separates what a writer HAS from the one thing it does not: the
purchase-order LINE, `FromDocDtlKey` being 0 book-wide in both extracts. The
header carries a per-snapshot guide to which file answers which question, so the
next reader does not repeat the survey.

**Lesson.** "I could not find it" is a statement about the search, not about the
tree, and a check that prints a remedy is making a claim strong enough to need
proving. Two cheap habits would each have caught it: enumerate
`backend/scripts/data/` and read every `grain` / `counts` field before declaring
an absence, and check whether another script already answers the same question —
`check-gr-fidelity.mjs` was on `main` and using the right file the whole time.

**Ref.** #3094, 2026-09-07.
