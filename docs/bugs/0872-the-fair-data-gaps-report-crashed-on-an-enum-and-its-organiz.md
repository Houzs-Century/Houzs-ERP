## The fair data-gaps report crashed on an enum, and its organizer fold could not see an abbreviation [medium]

**Symptom.** The first ever dispatch of **Fair data gaps (read-only)** — run
34767215583, 2026-09-13, against production — printed section 1 and then died:

```
1. ORGANIZER SPELLINGS — 1 organizer(s) written more than one way
   "KAI HAO (KL CHEN)" (1)  vs  "KAI HAO (KL, CHEN)" (43)
fair-data-gaps FAILED: function upper(scm.mfg_product_category) does not exist
```

Sections 2 and 3 — the SKUs with no brand and the duplicate fairs — never ran.

**Root cause (traced).** Two, and the second is the more useful one.

1. `scm.mfg_products.category` is **not text**. `information_schema.columns`
   reports `data_type = USER-DEFINED`, `udt_name = mfg_product_category`, so
   `upper(category)` has no matching overload and Postgres refuses the statement.
   The query was written from the shape of an earlier probe that did
   `SELECT category, count(*) … GROUP BY category`, which never calls `upper()` —
   so the enum never showed itself. Reading the column's own type would have;
   assuming it matched the surrounding text columns did not. Fixed by casting:
   `upper(category::text)`.

2. **The organizer fold cannot catch an abbreviation, and the script's own
   header claimed the case it misses as its worked example.** `orgKey()`
   normalises case, spacing and punctuation, so `MALL MGMT` and `MALL MGT` —
   one organizer to a human — remain two different keys. The header cited
   exactly that pair as what section 1 finds. It does not find it. What it
   actually found on the live data was a different pair entirely,
   `KAI HAO (KL CHEN)` / `KAI HAO (KL, CHEN)`, which the fold does handle.

   No safe rule closes this: anything loose enough to fold `MGT` into `MGMT`
   would also fold organizers that really are different, and a wrong fold here
   merges two fairs' P&L. So section 1 now prints the WHOLE roster — about 15
   rows — beside the automatic finding, and a person reads it. A list a human
   scans beats a cleverer rule nobody can audit.

**Fix.** `upper(category::text)` at both use sites; section 1 gained the full
organizer roster; the header no longer claims a case the fold cannot see and now
states the limit, citing this run as the evidence for it.

**Why no test pins this.** The crash is a Postgres type error against the live
schema, which nothing in CI can reach — the repo has no production DB in tests,
by design. What pins it instead is the rule that found it: a `workflow_dispatch`
workflow is not shipped until it has been dispatched once and reported success
(CLAUDE.md). This one was dispatched on the day it merged, failed, and was fixed
the same hour. The PR that shipped it said so in as many words — *"the workflow
has never been dispatched … **UNTESTED** until someone runs it once"* — which is
the only reason the failure was expected rather than discovered by the owner.

**Ref.** `fix/fair-data-gaps-category-enum`, 2026-09-13. Shipped by #3778
(`docs/bugs/0862-a-sales-order-could-not-record-which-fair-it-was-written-at.md`).
