## A voided service case still escalated, still emailed, and still counted as open [high]

**Symptom** - a case closed as `voided` (the terminal alt-outcome added
2026-07-29) kept behaving as if it were open: the daily 02:00 SLA sweep escalated
it and emailed its assignee, it inflated the "active backlog" tile and every
ageing bucket, and it sat in assignees' inboxes and overdue lists.

**Root cause (traced, not guessed)** - `voided` was added to the Stage union and
`statusForStage` maps it to "Closed" (`services/assr.ts:63-67,:88`), but every
consumer predicate still spelled "open" as `stage != 'completed'`. Grep found
**twelve** such predicates, not the two the audit first reported:
`assrEscalation.ts` (the escalation WHERE), `routes/assr.ts` x9 (backlog count,
period counts, stage-history join, per-creditor open/breached, unassigned,
breached tile, the three ageing buckets, per-agent breached) and
`routes/inbox.ts` x3 (my-cases, overdue, stuck-in-stage).

**Fix** - all twelve now read `stage NOT IN ('completed', 'voided')`. The
`= 'completed'` counters that define "closed" were deliberately LEFT ALONE:
folding voided into them changes what those tiles mean, which is a product
decision, not a bug fix. Verified: backend typecheck clean; assrCompanyScope,
assrSearch, assrCreateCategory and assrEscalation suites pass (21 tests); zero
`stage != 'completed'` left in `backend/src`.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-13

---
