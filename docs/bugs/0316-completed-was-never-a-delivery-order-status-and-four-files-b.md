## COMPLETED was never a Delivery Order status, and four files believed it was [medium]

<!-- area: Delivery, DO, returns -->

**Symptom.** `GET /api/scm/delivery-orders-mfg?status=delivered` 500'd in both
tenants; the Delivery Agent's DO pipeline silently reported no COMPLETED bucket.

**Root cause (traced).** `scm.do_status` has eight labels — the schema's seven
plus `DRAFT` from migration 0040 — and no migration ever added `COMPLETED`. No
code has ever written it; it lived only in read predicates and whitelists,
asserted once in a comment as settled fact and mirrored into three more files. In
`DO_STATUSES` it was worse than absent: `PATCH /delivery-orders-mfg/:id/status`
accepted it and the UPDATE then 500'd. `delivery-agent.ts` queried
`.eq('status','COMPLETED')` inside `try {} catch {}`, so from 2026-08-13 it threw
22P02 on every run and nothing said so.

**Fix.** Removed from `DO_STOCK_OUT_STATES`, `DO_STATUSES`, the `.mjs` mirror and
three raw-SQL copies; the four assertion comments now carry the evidence; the
mirror test no longer pins the false belief and `doStatusCaseNormalisation`
imports the vocabulary instead of re-typing it. The agent now counts from the
column rather than enumerating a list, so there is no second vocabulary to drift.

Ref: PR #2382, 2026-08-18.
