# Venue, Warehouse, Showroom follow the COMPANY — owner rule 2026-08-20

> "我们的 Venue、我们的 Warehouse、我们的 Showroom 等等，都是跟着看到自己公司的"
> "客人开单不能看到 2990 的展厅啊。分开的公司都不一样啊，收入单也不一样。venue 都不一样啊"

Company-scoped, no exceptions to be invented later:

| master | scope |
| --- | --- |
| Venue | own company |
| Warehouse | own company |
| Showroom | own company |

## This is NOT "physical things are shared"

The fleet tables are cross-company ON PURPOSE and say so in their own migration
headers (0202 / 0203 / 0204: `company_id` is "STAMPED on insert for provenance
but NOT used to scope reads"). 0202 gives the reason — a lorry is one physical
vehicle whichever book paid for it, and splitting its compliance by company would
hide a real vehicle from the people responsible for it.

A venue is also a physical place, and it does NOT follow that rule. The owner's
reason is the business one, not the physical one: **separate companies raise
separate revenue documents against separate venues.** Do not generalise from the
lorry precedent to any other master.

## Known violation, found 2026-08-20 and not yet fixed

`backend/src/routes/projects.ts:1357` lists showroom venues with NO company
predicate:

```sql
SELECT id, code, name, venue_name FROM scm.warehouses
 WHERE is_showroom = true AND is_active = true ...
```

So a Houzs user raising a project sees 2990's showrooms in the picker. Under this
rule that is a leak, not a feature.

**Correction on the record:** an earlier pass classified the venue lookup in
`mfg-sales-orders.ts:2493` as deliberate cross-company, reasoning that "a venue is
a physical place two companies can share". That reasoning was wrong and the owner
refuted it. Re-read every master-data lookup against THIS rule rather than
against that inference.

## What to check when fixing

- `scm.warehouses` carries `company_id`; scope the read with it.
- Check the SAME rule at every other venue / warehouse / showroom read before
  calling it done — one fixed picker while another still lists everything is the
  shape this repo keeps paying for.
- Verify with data, not reasoning: count how many showrooms/venues each company
  actually has before and after, so "the list got shorter" is a measured fact.
