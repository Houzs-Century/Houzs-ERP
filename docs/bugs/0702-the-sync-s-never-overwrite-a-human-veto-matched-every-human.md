## The sync's never-overwrite-a-human veto matched every human as the system, so it refused nothing [critical]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Not seen by anyone, because there was nothing to see — which is
what makes it the shape worth writing down. `sync-ac-delta.mjs`'s header lane
prints `sales orders where a PERSON changed a header field`, and that number was
structurally incapable of being anything but the count of rows written by a
handful of named system writers. The lane it guards copies AutoCount's header
values into the ERP. Once the owner opened sales orders, delivery orders,
purchase orders and goods receipts to staff (2026-09-08, 「谁改了 都根据他们改的数据
为最高标准」), the next run of that lane would have written the account book's
older value over a salesperson's correction with no signal at all.

**Root cause (traced).** `backend/scripts/sync-ac-delta.mjs:1175` decided
authorship like this:

```js
const SYS_ACTOR = "00000000-0000-4000-8000-000000000001";
if (!r.actor_id || String(r.actor_id) === SYS_ACTOR) { sysAuthored++; continue; }
```

That uuid is `SCM_SYSTEM_STAFF_ID`. `backend/src/scm/middleware/auth.ts:112`
**pins it onto `c.get('user').id` for every authenticated SCM caller** — a type
shim, because the ported 2990 routes expect a uuid and Houzs users are integers
— and all 21 `recordSoAudit` call sites in
`backend/src/scm/routes/mfg-sales-orders.ts` pass `actorId: user.id`. So every
sales-order edit a person makes through the browser is stored with
`actor_id = SCM_SYSTEM_STAFF_ID`. The test matched all of them, counted them as
`sysAuthored`, and `continue`d — so `humanField` and `humanDocs` stayed empty and
the veto vetoed nothing.

Only the NAME is personalised: `auth.ts` carries the real caller's name into
`user_metadata.name`, which was itself a later fix for the same confusion.

Traced by reading the two files, and pinned as an executable assertion rather
than left as prose — `backend/src/scm/shared/audit-author.test.ts` runs the old
predicate against a salesperson's own audit row and asserts it answers "not a
person", then runs the new rule against the identical row and asserts the field
is refused. 21 tests, run 2026-09-08 14:22 MYT, green.

**A second, opposite defect in the same script.** The desc2/pay lanes folded
`version > 1` into the same `touched` set. `version` is an optimistic-locking
token bumped by seven automated paths; `check-so-version-provenance.mjs` (#3042)
measured **80 of 81 "conflicts" as the stock-allocation sweep and exactly 1 as a
person**. So that arm refused ~79 orders on a robot's behalf and buried the one
real person inside the same set. It is removed from the veto and kept as a
printed comparison.

**And the rule had three homes.** `check-so-open-for-new.mjs` held the closest
to correct — `actor_id IS NULL AND actor_name_snapshot ILIKE 'system%'`, written
after run 34183368917 reported "50 staff actions" that were 50 of 50 the
allocation cron (#3177) — while this script held the broken one and nothing else
had an opinion at all.

**Fix.** Landed in two PRs that crossed in the air, which is worth recording
because the second was needed only because the first stopped one step short.
`#3205` created `backend/scripts/lib/ac-human-edit.mjs` and fixed the NULL-actor
arm. This branch found that the rule it settled on still classified every human
sales-order edit as the system through a SECOND arm, and closed that — the trace
is `docs/bugs/0704`, and it is where the measurement lives.

The rule now has ONE home for the whole repo:
`backend/src/scm/shared/audit-author.ts`. A row is MACHINE-written when
`actor_name_snapshot` starts with "system"; everything else is a PERSON,
including an unattributed row (the direction that SURFACES it). `actor_id` is
not consulted at all, because it is a constant. Read by `ac-human-edit.mjs`
(which keeps the indexing and the refusal wording),
`check-so-open-for-new.mjs` and the new
`backend/src/scm/routes/change-log.ts`; both scripts now run under `npx tsx`
so they can import it (the runner `golive-parity-check.yml` already uses).

The rule GENERALISES #3177's rather than contradicting it: dropping the
`actor_id IS NULL` arm means `so-delivery-sync.ts`'s two writers — which pass the
caller's pinned uuid through with the name `System (delivery sync)` — are now
correctly machines. Every row #3177 called a machine is still a machine. All
seven machine writers in the tree are pinned verbatim in the test.

**And the refusal now goes somewhere.** A refusal that reaches nobody is the
failure this repo has already paid for (35 write paths refused correctly and told
no one). `sync-ac-delta.mjs` prints every person-owned field the book still
disagrees with, on the PLAN path, whether or not anything is armed — and
`LANES=push` carries the ERP's own value OUT to the account book through
`enqueueEdit`, the same composer the sales-order routes call. That is the owner's
reversal made executable: after opening, the ERP is master on a row a person
edited, so the book is the side that moves.

**Ref.** `feat/golive-change-log-and-sync-guard`, 2026-09-08.
