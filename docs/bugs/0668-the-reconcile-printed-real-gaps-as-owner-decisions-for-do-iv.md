## The reconcile printed real gaps as owner decisions for DO, IV and PI [high]

**Symptom.** The go-live reconcile (run 34127889821, 2026-09-07) printed
`DO DOCUMENTS — in-scope AutoCount documents absent from the ERP: 2
(owner-declined)`, and the same word over 7 sales invoices and 21 purchase
invoices. None of the 30 was a decision the owner had made. Two of them are
DO-001800 (against SO-002281) and DO-005583 (against SO-007435): both
un-cancelled in the live book, both delivering against a sales order that still
has undelivered lines, both squarely inside the migration population. They were
reported as work nobody had asked for, which is the one label that guarantees
nobody goes and looks.

**Root cause (traced).** `check-ac-erp-reconcile.mjs` decides the word from a
hand-typed constant in its own `TYPES` table — `absenceIs: "DECISION"` — while
the POPULATION is computed by `scripts/lib/ac-scope.mjs`. The two are separate
statements of one rule, which is the exact failure `ac-scope.mjs`'s own header
was written to end. `ac-scope.mjs` was corrected on 2026-09-07 with the owner's
ruling 「没有的 SO DO 何来发票？有的 SO DO 自然要发票」 and now returns 84 DO, 47
IV and 192 PI in scope; the three constants were not touched, so the checker
went on describing a population of zero that had not been zero for some time. A
DECISION means the owner said do not carry these, and `ac-scope.mjs` expresses
that by putting NONE of them in scope — so a non-empty scope and a DECISION
label cannot both be true. Observed by computing `buildScope(book)` directly
against `data/ac-reconcile-truth.json.gz` (exported 2026-09-07T09:35:24Z) and
comparing the sizes with what the run printed.

The same constant also fed the gap arithmetic
(`cfg.absenceIs === "GAP" ? missingInScope.length : 0`), so all 30 absences were
worth zero in the summary's gap column.

**Fix.** The three constants now say `GAP`, and — so the pair cannot drift
apart again — the label is DERIVED rather than trusted: `decisionHolds` requires
`absenceIs === "DECISION"` **and** `scope.size === 0`, and a type that claims
DECISION over a non-empty population prints `LABEL REFUSED`, names the count,
and reports its absences as gaps anyway. The gap arithmetic reads the derived
flag, not the constant.

**Ref.** chore/golive-last-gaps-2026-09-07, 2026-09-07.
