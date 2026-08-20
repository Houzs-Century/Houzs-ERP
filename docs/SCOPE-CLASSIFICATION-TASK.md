# Classify every module: per-company / centralised / centralised-but-salesperson-scoped

**Owner asked for this 2026-08-20**, together with "clear掉整个 RBAC 的问题".
Written as a task rather than an answer because a partial classification of
WHO CAN SEE WHAT is worse than none — it reads as complete and gets trusted.

## The test, which the owner already gave

> "这个 TMS 是 centralise 的啊 所以统一的 servicecase 也是 centralise 的 除了
> salesperson 不 centralise 而已"

Ask whether the FUNCTION is run centrally, not whether the thing is physical and
not whether a `company_id` column exists. Both of those have already produced
wrong answers here (see MASTER-DATA-SCOPE-RULE.md, "Correction on the record").

| bucket | test | known members |
| --- | --- | --- |
| **A. Per company** | belongs to one company's books; raises that company's revenue documents | Venue, Warehouse, Showroom |
| **B. Centralised** | one desk / one pool serves both companies | Fleet + TMS (migs 0202/0203/0204 say so in their own headers) |
| **C. Centralised, one scoped dimension** | central desk, but one axis still follows a person | Service Case — salesperson only |

## Why a column count cannot answer this

Measured 2026-08-20: counting `company_id` / `scopeToCompany` mentions per SCM
route file produces a ranking, not a classification. `ar-reconciliation` and
`write-freeze-status` score ZERO; that could mean per-company-and-broken, or
centralised-and-correct, and the number cannot tell you which. `CLAUDE.md`
already records this trap — "Read the DDL's own words, not its column list" —
after counting columns gave the wrong answer twice, in OPPOSITE directions, on
the fleet tables.

So the classification is a READ, module by module, of three things:

1. the migration header for the module's tables — the fleet ones state their
   intent explicitly, and that is the strongest evidence available;
2. the module guide in `docs/modules/`;
3. the READ path — a table can carry `company_id` and never use it (the fleet
   case), or lack one and still be correctly scoped through its parent.

## The corpus, so nobody re-derives it

32 module guides in `docs/modules/`. ~1,033 SCM route handlers
(`node backend/scripts/check-company-scope.mjs` prints the count on line 1 —
re-run it, do not quote this number).

## Do these FIRST, because they are already decided and still unfixed

- **`backend/src/routes/projects.ts:1357`** lists showroom venues with no company
  predicate, so a Houzs user sees 2990's showrooms. Bucket A. Owner ruled on it:
  "客人开单不能看到 2990 的展厅". Not yet fixed.
- **Service Case visibility** — the full rule is in
  SERVICE-CASE-VISIBILITY-DECISION.md, including the live bug it explains and the
  machinery that already exists. Not yet implemented.

## And the honest state of "clear掉整个 RBAC"

UNKNOWN, and it must be said that way. Specific RBAC fixes landed recently
(impersonation, presence, the SO guard's company dimension), but **no
comprehensive sweep has been done**, so nobody can say what remains. The three
buckets above are the prerequisite: RBAC answers "who may act", and it cannot be
settled before "what is this data scoped by" is settled per module.

Suggested order: classify (this doc) -> fix the two decided items above -> then
sweep RBAC against the classification, module by module, with the count of
who GAINS or LOSES access measured and put in each PR. This repo does not ship
access changes on reasoning alone.
