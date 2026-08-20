## normCategory is hand-written SIX times, and one copy silently drops SERVICE [low]

<!-- area: Sales orders + pricing -->

**Symptom.** None observable today, and the reason it is not observable is the
whole finding. Found while paying file-size debt on `delivery-planning.ts`.

**The divergence, proven.** `normCategory` — free-text `item_group` to one of
six buckets — exists in six hand-written copies:

| where | has a SERVICE branch |
|---|---|
| `scm/lib/so-readiness.ts` (exported, the natural shared one) | yes |
| `scm/lib/so-display-branding.ts` (private) | yes |
| `scm/routes/delivery-planning.ts` (private) | yes |
| `scm/routes/delivery-zones.ts` (private, different return type) | yes |
| `scm/routes/mfg-sales-orders.ts` (inline) | yes |
| **`scm/routes/consignment-orders.ts` (inline)** | **NO — SERVICE falls to OTHERS** |

So a SERVICE line on a consignment order buckets as `OTHERS`, and the same line
on a Sales Order buckets as `SERVICE`.

**Why nothing shows it, traced rather than assumed.** That copy feeds
`item_categories`, written in exactly two places
(`consignment-orders.ts`, `mfg-sales-orders.ts` — where its own comment calls it
"kept for back-compat"). Its only other appearance anywhere in the tree is a
TYPE DECLARATION at `frontend/src/pages/scm-v2/ConsignmentOrders.tsx`. Nothing
reads the value. This is latent, not live — and it is latent by luck, not by
design: the day someone renders that column, two pages disagree about one line.

**What was NOT wrong, checked in the same pass.** `deriveBranding` also exists
twice — `delivery-planning.ts` and the frontend `ConsignmentOrders.tsx` — and
those two ARE behaviourally identical, including the `/^2990('?s)?$/i`
house-brand test. And the Malaysia +8 "today" rule is hand-written at 20 sites
tree-wide in 4 shapes; the 17 that produce a date string are all equivalent. No
live bug in either. Both are the same shape of debt as this one.

**Fix (partial, by design).** `delivery-planning.ts` now imports the shared
`normCategory` from `so-readiness.ts` and the shared `todayMyt` from
`my-time.ts`, and its `deriveBranding` moved to `so-display-branding.ts` as an
export — which also deleted THAT file's private `normCategory`. Three copies
gone, twelve tests added, including one that asserts SERVICE is its own bucket
precisely because a copy dropped it.

The `consignment-orders.ts` copy is deliberately left for the PR that shrinks
that file (it is 70 lines over its own ceiling, so removing it is both the fix
and the payment). `delivery-zones.ts` returns a different type and needs a
reader, not a sweep.

`delivery-planning.ts` 2950 -> 2907 lines, ceiling follows.

**Ref.** 2026-08-15, file-size debt paydown.
