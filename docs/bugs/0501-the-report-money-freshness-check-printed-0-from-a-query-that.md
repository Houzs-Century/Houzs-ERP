## The report-money freshness check printed 0 from a query that never ran [medium]

**Symptom.** Section 7 of `backend/scripts/check-report-money.mjs` answers the
one question that decides whether the AR-aging snapshot is TRUSTWORTHY: are the
snapshot-vs-live differences just nightly lag, or a real rule drift? It reported
`outstanding POs created AFTER the refresh: 0` and the same for SOs — which reads
as "nothing explains the delta", i.e. a rule drift. Both numbers came from
queries that had already died. Run 32466235033 shows it plainly:
`!! po since failed: 42703 column "doc_no" does not exist`, then `0` on the next
line. This is the CLAUDE.md trap "a checker that cannot match reports a clean
run", committed by a checker written the same day the rule was quoted.

**Root cause (traced).** Two mistakes, both from assuming a shape instead of
reading it. (1) The query named `doc_no` and `created_at` on
`scm.v_po_outstanding`; the live view has `po_number` and `po_date` and neither
of the others (read from `pg_attribute` in run 32473455059). (2) `tryQ` swallows
a failed query and returns `[]`, so `rows.length` was 0 for the same reason a
genuinely empty answer would be — the successful result and the broken one are
indistinguishable.

Then a third, subtler one once the columns were right: the outstanding VIEWS
carry the DOCUMENT's date (`po_date`, `so_date`), not when the row was written.
A document dated yesterday can be entered this morning, so a document date can
neither prove nor refute lag — asking it returned 0 again, honestly this time
and still useless.

**Fix.** Section 7 now reads each view's columns from `pg_attribute` and prints
`UNPROVEN` — naming the columns it did find — when no usable date or id column
exists, instead of a number. A failed query prints `UNPROVEN — the query failed:
<code> <message>`, never 0. The freshness question is answered from the BASE
row's `created_at` (`scm.purchase_orders`, `scm.mfg_sales_orders`) joined to the
view, and the join key is named per view by the caller rather than assumed —
`v_po_outstanding` exposes `id`, `v_so_outstanding` exposes `doc_no`, and
assuming `id` for both is what produced the third wrong 0.

**Verified against production** — run 32473721062, section 7. The snapshot
refreshed at `2026-08-21T02:00:35.903Z`; the two deltas were `2/po RM -2,640.00`
and `2/so RM -3,240.00`; the corrected check names exactly one PO created
`04:29:41.327Z` worth RM 2,640.00 and exactly one SO `2990-SO-2608-026` created
`04:26:55.703Z` worth RM 3,240.00. Both deltas are fully accounted for, so the
AR-aging snapshot reproduces the live rule and the difference is nightly lag —
the answer the broken version had been reporting as its opposite.

**Ref.** `fix/report-money-freshness-check`, 2026-08-21.
