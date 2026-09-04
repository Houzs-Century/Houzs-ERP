## probe-so-lock-doors read the audit log by a column it does not have [low]

<!-- area: Sales orders + pricing -->

**Symptom.** The read-only probe that prints WHO wrote a Sales Order (the
`[E1 vs E2]` audit-trail section) had run exactly once, on 2026-08-16 (run
31943751292), and died there: `FAIL column "doc_no" does not exist`. Everything
after that section — the automation-frequency count and the both-doors-shut
census — never printed. On 2026-09-04 the owner asked whether the square-pillow
line on `2990-SO-2609-007` was auto-added or hand-added, and this was the only
dispatchable tool that prints an audit row's `source`, so it was needed and it
was broken.

**Root cause (traced).** `scm.mfg_so_audit_log` keys the order as `so_doc_no`
(`backend/src/scm/lib/so-audit.ts` inserts `so_doc_no`; `check-amendment-apply.mjs`
reads it). The probe wrote `WHERE doc_no = ${DOC}` in both of its audit queries.
Observed in the run log of 31943751292, not inferred: the `[E]` section (which
reads `mfg_sales_orders`, where the column IS `doc_no`) printed, and the very next
query failed. A workflow_dispatch workflow is not shipped until it has been
dispatched once and reported success (CLAUDE.md rule 5); this one shipped on
2026-08-16 with a failed first dispatch and nobody went back.

**Fix.** Both audit queries now use `so_doc_no`. While there, the probe gained an
`[L]` section printing every line's `unit_price_sen`, `variants.freeGift` and
`variants.pwpCode` — the two facts that separate a campaign-added gift line
(RM0.00, `freeGift=true`) from a hand-picked one — and the audit `field_changes`
print is no longer cut at 70 characters. Proved by dispatching the workflow on
the fix branch: see the run URL in the PR.

**Ref.** fix/probe-so-lock-doors-audit-column, 2026-09-04.
