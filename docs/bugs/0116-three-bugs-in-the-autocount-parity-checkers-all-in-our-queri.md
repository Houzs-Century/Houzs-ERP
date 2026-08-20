## Three bugs in the AutoCount parity checkers, all in OUR queries, none in the data [medium]

**Symptom** — both read-only checks crashed on 2026-08-10, and the section that
did run reported a disagreement it then disproved on the same line:
`check-autocount-parity.mjs:147 PostgresError: column h.total_centi does not
exist (42703)`; `check-line-supply-trace.mjs:70 PostgresError: invalid input
value for enum scm.po_status: "CLOSED" (22P02)`; and section 1 said "the ERP
links a DIFFERENT PO: 14" while printing examples that were identical on both
sides — `SO-000524: AutoCount says PO-000453, PO-000454; the ERP links
PO-000453, PO-000454`.

**Root cause (traced, not guessed)** — three separate mistakes:

1. **`h.total_centi`** was never a column. The header total is
   `local_total_centi`. Worse than the typo: the query then re-derived
   outstanding as total-minus-payments, a SECOND implementation of a rule the
   ERP already owns. The view `mfg_sales_orders_with_payment_totals` computes
   `paid_total_centi` + `balance_centi_live`, and `balance_centi_live` is what
   the SO list actually renders — that is the number a parity check must
   compare against, or it can disagree with the screen and be right about
   nothing.
2. **`'CLOSED'` is not a member of `scm.po_status`.** The live members are what
   `enum_range` says, not what any SQL tree says — 0042 re-added `DRAFT` after
   2990's 0078 removed it. Comparing a text literal that is not a member is a
   hard 22P02, so one bad literal aborted the whole section.
3. **`SO.UDF_ToPONo` is a COMMA-JOINED STRING** when one order was converted to
   several POs ("PO-009566, PO-009555, PO-009556"). The script did
   `have.has(r.ToPONo)` against a Set of individual doc numbers, which can never
   match a joined string, so every multi-PO order was a false positive — and
   because the "extra PO" counter only incremented on the match branch, it was
   suppressed to 0.

**Fix** — `backend/scripts/check-autocount-parity.mjs` +
`check-line-supply-trace.mjs`:

1. Balance reads `balance_centi_live` from the view, joined on `doc_no` rather
   than selected from directly (the view froze its column set at CREATE VIEW,
   so `linked_ac_docno` is not guaranteed visible through it — see the VIEW-TRAP
   note in `scm/routes/mfg-sales-orders.ts`). Column presence and doc_no
   uniqueness are PRINTED, not assumed.
2. `enum_range(NULL::scm.po_status)` is printed as the first line of the supply
   trace, and every `po_status` comparison is cast to text, so an unknown member
   can never again abort a read-only diagnostic.
3. `UDF_ToPONo` is split on commas, trimmed, and compared as SETS. The outcomes
   are reported separately: exact match, ERP links a superset, ERP is MISSING a
   named PO, ERP links none.

A fourth reporting bug found while fixing them: section 2 of the supply trace
printed `recv X/Y` as the PO LINE's `received_qty` over the SO LINE's `qty` —
two different quantities — which made a PO line legitimately covering several SO
lines read as an over-receipt ("recv 2/1"). It now prints the PO line's own
ordered qty, and a dedicated over-receipt lens counts `received_qty > qty`
against the same line. Its headline count was also taken from a `LIMIT 400`
result set, so it could never exceed 400; it is now a `COUNT(DISTINCT i.id)`
over the whole population, with an explicit adds-up check against the total.

**The class, for next time** — a diagnostic that dies on a schema fact it
guessed is worse than no diagnostic, because the crash reads as "the data is
broken". Every one of these checks now PRINTS the schema fact it depends on
(enum members, view columns, key uniqueness) before using it.

**Ref** — 2026-08-11, PR #1914 (fix/parity-checkers).
