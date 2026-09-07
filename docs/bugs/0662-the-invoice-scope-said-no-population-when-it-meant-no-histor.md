## The invoice scope said "no population" when it meant "no history" [high]

**Symptom.** The go-live reconciliation reported every sales and purchase
invoice of a migrated document as a DECISION — "the owner declined these" —
rather than as a gap. The owner read that and rejected it in one line:

> 没有的 SO DO 何来发票？有的 SO DO 自然要发票

and again, confirming the mechanism:

> 发票确定也是 autocount 开了我们才开

**Root cause (traced).** `backend/scripts/lib/ac-scope.mjs` — the single place
the in-scope population is written down — carried `IV no population.` /
`PI no population.` and returned `IV: new Set(), PI: new Set()`, with
`MIGRATION_SOURCE.IV/PI` all `null`. The comment justified it with the owner's
earlier 「这个不要」.

That ruling declined importing AutoCount's invoice **history** — 10,292 sales
and 5,283 purchase invoices. It never meant that an in-scope document's own
invoice stays behind. The two populations are three orders of magnitude apart,
and the writer for the smaller one already existed:
`create-migrated-invoices.mjs` turns the GR and DO the ERP already carries into
the invoices AutoCount actually raised from them, reading `grToPi` (5,277 real
links) and `doToIv` (10,458) out of `ac-invoice-refs.json.gz`. It invents
nothing.

So an empty Set made 239 real, closable documents invisible, and pointed at a
decision that had never been made.

**Fix.** IV is in scope when a line names an in-scope DO (or an in-scope SO,
which the SO rule makes empty by construction — an order invoiced direct is
excluded from SO scope). PI is in scope when a line names an in-scope GR or PO.
`MIGRATION_SOURCE` now names `ac-invoice-refs.json.gz` and
`create-migrated-invoices.yml` for both.

`check-ac-gap-attribution.mjs` needed one change to read it: that file is a MAP
keyed by invoice number, not an array of rows, so a `keysOf` field names the
sub-map and `held()` handles both shapes. Iterating the map as an array throws —
an honest failure, but a useless one.

Measured after the fix, against the 2026-09-07 17:37 cut taken with AutoCount
locked: **IV 47 in scope / 47 carried, PI 192 / 192, and 3,810 of 3,810 in-scope
documents across all six types are in a committed migration source — 0 absent.**

**Lesson.** A scope of `new Set()` is not a neutral default. It silently
reclassifies every member of the population as "not wanted", and no checker can
tell that apart from "genuinely none". Where a population is empty ON PURPOSE,
say which ruling made it empty and re-read that ruling before trusting it.

**Ref.** fix/ac-scope-invoices, 2026-09-07.
