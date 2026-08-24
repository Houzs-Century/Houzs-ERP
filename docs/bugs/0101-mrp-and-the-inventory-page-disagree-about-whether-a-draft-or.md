## MRP and the Inventory page disagree about whether a DRAFT or SHIPPED order still demands stock [med, LEFT OPEN]

**Symptom** - not a report from staff; found by grep on 2026-08-13 while
collapsing duplicated constant lists. The "which sales orders are still live"
set exists in THREE sizes across two files and nothing reconciles them.

**Root cause (traced)** - `routes/mrp.ts` and `lib/so-stock-allocation.ts` treat
SIX statuses as terminal - CANCELLED, CLOSED, SHIPPED, DELIVERED, INVOICED,
DRAFT. `routes/inventory.ts` declares TWO sets of its own and neither matches:
`GET /reservations` (:1424) has FIVE, missing DRAFT; `GET /products` (:494) has
FOUR, missing DRAFT and SHIPPED. So a DRAFT order counts as open demand on BOTH
Inventory surfaces and as finished everywhere else, and a SHIPPED order does the
same on one of them - feeding committed_scheduled / available / surplus, the
numbers the Inventory page puts in front of staff.

The comment above `mrp.ts`'s set asserted the opposite - "the /inventory/
reservations SO_DONE drops its claims" - listing that endpoint as one of the
consumers already aligned when SHIPPED was added on 2026-08-01. It was never
checked because checking it meant opening a second file that had no link to the
first, and the second file turned out to hold two answers rather than one. Same
disease as the delivery-agent entry below: a citation standing in for a
mechanism.

**Fix (partial, deliberately)** - the SIX-status set is now
`backend/src/scm/shared/so-terminal-states.ts`, read by `mrp.ts`,
`so-stock-allocation.ts` (as `SO_TERMINAL_STATES_PGREST`, which renders the
PostgREST `not.in` string byte-identically) and eight audit scripts via
`scripts/lib/so-terminal-states.mjs`, pinned by
`tests/soTerminalStatesMirror.test.ts`. Fourteen copies across ten files, under
four names, became one. The false claim in mrp.ts's comment is corrected in
place.

**LEFT OPEN for the owner** - `inventory.ts`'s sets are NOT collapsed into the
shared file, and each now carries a comment saying so and why. Note there are
TWO of them in that one file: `GET /products` (:494) has four statuses and
`GET /reservations` (:1424) has five (it adds SHIPPED), so the page answers "is
this order open" differently in two places of its own. Widening either changes committed / available / surplus on a
page staff act on; that is a business decision about whether a DRAFT order
reserves stock, not a tidy-up. Those two are now the only survivors, and each
says in code where the others are.

**Lesson** - **when two lists of the same fact differ, find out which is right
BEFORE merging them.** The tempting move here was to import the shared set into
`inventory.ts` and call the class fixed. That would have silently changed
numbers on a live page under cover of a refactor - the opposite of the point.

**Ref** - PR sweep/duplicated-list-drift, 2026-08-13.

---
