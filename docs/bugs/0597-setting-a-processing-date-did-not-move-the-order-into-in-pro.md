## Setting a Processing Date did not move the order into In Production, so the board showed zero [high]

**Symptom.** The owner, 2026-09-01, on the 2990 Sales Order board:

> 「不是说好了吗？In Production 就是当你 proceed 了订单，就要直接 show 出来在 In
> Production 了呀。**全套系统 而不是针对单一公式**」

and then, when told company 2 was affected:

> 「这是**全套系统** 而不是 单一organisation」

The board read **IN PRODUCTION 0** beside **CONFIRMED 108**.

**Root cause (traced).** The rule was implemented in ONE direction only.

`PATCH /mfg-sales-orders/:docNo/status` to `IN_PRODUCTION` refuses without a
Processing Date (`routes/mfg-sales-orders.ts`, the `toStatus === 'IN_PRODUCTION'`
branch) — so the STATUS implies the DATE. Nothing made the DATE imply the STATUS:
the header PATCH wrote `processing_date` and left `status` alone, so an order
could carry a release date and sit in CONFIRMED, invisible to the board the
factory works from.

Two consequences, and the second is why a data repair alone was not the answer:

1. every AutoCount-imported order was in that state — the import wrote the dates
   and wrote `CONFIRMED`, independently;
2. **every future header save re-created it.** The repair that ran on company 1
   on 2026-08-31 was already being undone the next day.

**Fix, both halves.**

*The rule* — `scm/shared/so-proceeded-status.ts`,
`statusAfterProcessingDateSet()`, wired into the header PATCH. Setting a
Processing Date on a CONFIRMED order moves it to IN_PRODUCTION. What it refuses
is the load-bearing part and each refusal has a reason:

| case | answer | why |
| --- | --- | --- |
| the date was already there | no move | editing an order is not a proceed |
| status is READY_TO_SHIP / DELIVERED / INVOICED / CLOSED | no move | further along; a move would be a demotion |
| status is DRAFT | no move | not confirmed |
| status is CANCELLED | no move | — |
| the date is CLEARED | no move | clearing is super-admin-only and what the status becomes is the owner's decision |

*The data* — `repair-proceeded-status.mjs` now sweeps **every company by
default** (`COMPANY=all`), reading the company list from the data so one added
later is included without editing the file. It used to default to company 1, and
that default is exactly how company 2 was missed for a week: a per-company switch
means somebody has to remember the other companies, and nobody did.

**Applied to production.**

```
company 1 (2026-08-31): APPLIED — 364 order(s) moved CONFIRMED -> IN_PRODUCTION.
company 2 (2026-09-01, run 33520265784):
  CONFIRMED orders: 108; of those carrying a Processing Date: 44
  APPLIED — 44 order(s) moved CONFIRMED -> IN_PRODUCTION.
  VERIFY (fresh connection, values not counts): 44 of 44 rows re-read;
    status is IN_PRODUCTION on 44; the Processing Date is still present on 44
  and CONFIRMED orders still carrying a Processing Date: 0
```

**Test.** `src/scm/shared/so-proceeded-status.test.ts` — 8 cases, of which 6 are
refusals, because a rule that fires too widely drags a delivered order back into
production and that is worse than the gap it closes.

**UNTESTED: the all-companies sweep has not been dispatched with `COMPANY=all`**
— companies 1 and 2 were each repaired by an individual run, so the new default
is proven by neither. The first `COMPANY=all` plan run is the proof, and it
should report zero movable rows on both.

**Ref.** fix/proceeded-status-system-wide, 2026-09-01.
