# COE — the Sales Orders list showed nothing while the database held 2,726 orders

**Status: RESOLVED 2026-08-19 03:05 MYT.** Every timestamp below came from the
deploy run list and the commit dates, re-read at the time of writing. All times
are given in **MYT (UTC+8)**, because that is the clock the shop floor works to;
the raw UTC stamps in the evidence sections differ by eight hours.

---

## 白话 — 这件事到底发生了什么

8 月 19 号凌晨，销售订单列表打开是空的。数据库里 HOUZS 的 2,726 张单一张都没少，
单子、金额、那张 view 全都是好的。坏的是中间那一层「对外读取服务」：改名之后它没有
跟着刷新，一直用旧的状态在回答，所以前端拿到 0 张单。

**发生在凌晨 00:28 到 03:05，大概两个半小时**，那个时段没有人上班，所以很可能没有
同事真的撞到。没有任何资料丢失或改错。

要人手叫那层服务重新刷新才会好 —— 光改代码不会好，等它自己好也不会好。

---

## What staff would have seen

The Sales Orders list opening empty, with the grid's ordinary "No sales orders
yet" message. That wording is the part worth noticing: **the screen said there
were no orders, not that it had failed to load them.** Underneath, the request
was returning an error.

Nobody reported it. It was found by the engineer working through the batch, and
the reason nobody reported it is in the clock, not in the monitoring — see below.

## Timeline

| MYT | What happened |
| --- | --- |
| 18 Aug 23:49 | The money rename (`_centi` → `_sen`) merges — an owner-approved one-shot. |
| 18 Aug 23:53 | Its deploy **fails**: the migration cannot drop a view because a materialized view depends on it. Nothing is applied; the migration is atomic and rolls back whole. |
| 19 Aug 00:08 | The next merge's deploy **fails** the same way. The backend is now not shipping. |
| 19 Aug 00:23 | The corrected migration deploys **successfully**. |
| **19 Aug 00:28** | The migration applies to production (`16:27:59Z`). Eleven views and one materialized view are dropped and recreated. **The Sales Orders list starts returning nothing from this moment.** |
| 19 Aug 01:49 | A read-only probe ships to compare what the database holds against what the view returns. |
| 19 Aug 02:40 | The probe is given credentials for the hosted read layer, so it can test the path the app actually uses. That is what isolates the fault. |
| **19 Aug 03:05** | The forced refresh deploys. The list returns. |

**Two outages, not one, and they are different.** The backend could not deploy at
all between 23:53 and 00:23 (about 30 minutes). The Sales Orders list was empty
between 00:28 and 03:05 (**2 hours 37 minutes**).

**Bounded by construction, not by recollection.** The failure is the read layer
serving *recreated* views from stale state. The migration is what recreated them,
it runs inside a single transaction, and the two earlier attempts failed and
rolled back — so no view existed in recreated form before 00:28, and the list
could not have been empty before then.

> **Correction to the ledger entry.** `BUG-HISTORY.md` describes the list as empty
> *整天 / "all day"* and as not self-healing *"across the day"*. The deploy
> timestamps bound it to 2 hours 37 minutes, entirely between midnight and 3am.
> The distinction matters to the business reading: "the Sales Orders list was down
> all day" and "it was down overnight while nobody was working" call for very
> different levels of alarm. The technical content of that entry is sound; only
> the duration reads wider than the evidence supports.

**Did any staff actually hit it? UNKNOWN.** The whole window falls between 00:28
and 03:05 Malaysia time, so LIKELY nobody. What would settle it: request logs for
`/api/scm/mfg-sales-orders` in that window. Nothing in this repository answers it.

## Root cause, traced

The Sales Order screens do not read the database directly. They read through a
**hosted API layer** (PostgREST) that sits in front of it and turns tables and
views into a web API.

The rename dropped and recreated eleven views plus a materialized view. Database
triggers exist to tell that API layer "the schema changed, reload" — and they are
enabled, and they fired. But the API layer's own connection pool was **44 days
old**, opened long before the rename, and it kept answering from stale state that
a schema reload does not clear.

So every layer was individually fine and the system as a whole was wrong:

| Layer | What it returned |
| --- | --- |
| The database, directly | 2,726 orders for HOUZS |
| The recreated view, directly | 2,726 — faithful to the base table |
| The service-role account through that view | all 2,726 — permissions fine |
| **The hosted API layer the app uses** | **0, then a 500** |

Proven by elimination with two read-only probes against production, not by
reasoning: `backend/scripts/check-so-list-empty.mjs` established the first three
rows; the fourth is the only remaining thing between a database holding 2,726 and
an app showing none.

**One thing is still UNKNOWN and is recorded as such:** the exact internal
mechanism by which that layer returns a count of zero. The hosted API layer is not
reachable from CI — no service-role key exists in any Actions scope — so it can
only be confirmed from the live application.

## What the audit ruled out

Each was a live suspicion, and each was refuted rather than argued away.

| Suspicion | How it was refuted |
| --- | --- |
| **The orders were deleted or corrupted by the rename.** | The base table holds 2,726 for HOUZS. The migration is atomic and had already rolled back twice without applying anything. |
| **The recreated view was wrong — a bad column, a lost filter.** | Base and view both return 2,726. The view is faithful. |
| **Permissions were lost.** This was the real precedent: a 2026-07 migration recreated a view and took the Sales Order list down for every user, because a recreated view starts with an empty permission list. | The service-role account read all 2,726 rows through the recreated view. Grants are intact. Worth stating plainly, because it is the failure everyone expected and it is not this one. |
| **The company scoping work in the same batch hid the rows.** | The probe counts per company against the base table and the view and gets the same number. Scoping is not what dropped them. |
| **It would self-heal once caches expired.** | It did not, across more than two hours, and the schema-reload triggers had already fired. Only forcing the connections to recycle fixed it. |

## Fixes shipped

| Change | Effect |
| --- | --- |
| Corrected migration | The rename now drops and recreates the materialized view and its index too, so the deploy stops failing. |
| Read-only probe | Compares base table, view, and the hosted layer per company. This is what located the fault; it stays, so the next occurrence is minutes of work rather than hours. |
| Forced refresh (gated workflow) | Tells the API layer to reload, and escalates to recycling its connections so it reconnects fresh. Default is plan; recycling is opt-in. |
| Error-surfacing hardening | Shipped separately, and it is the one worth keeping visible: a count of zero could reach the screen as "No sales orders yet". An empty list and a failed request must never look the same. |

## Deferred — an owner decision, with options

The ledger records durable prevention as unresolved. A view-recreate that leaves
the API layer stale will do this again. Three ways to close it:

| Option | What it costs | What you live with |
| --- | --- | --- |
| **A. Refresh the API layer automatically on every deploy that changed the schema** | One step in the release, added once | This is the industry convention — the hosted product's own guidance is to notify the API layer after a schema change. Recycling connections briefly interrupts requests in flight, which is why it belongs in the deploy window rather than during the day. |
| **B. Stop dropping and recreating exposed views; alter them in place** | Constrains how migrations are written, permanently | **It would not have prevented this one.** Renaming a column is precisely the case where in-place alteration is not available. Real for other changes, useless for this one. |
| **C. Check the Sales Orders list after every deploy and fail the release if it returns nothing** | One smoke check | Does not prevent it, but bounds it to minutes instead of hours — and would have caught this one immediately, at 00:28, instead of at 02:40. |

**Recommendation: A and C together.** A removes the cause; C means that when
something else produces the same symptom, the release tells you rather than a
person noticing. B is worth having as a habit but must not be sold as the fix.

**Second deferred item, same night, different problem.** The backend could not
deploy for 30 minutes because a migration failed. Migrations run *before* the
Worker deploy, so a bad one blocks every release behind it. That is by design and
is not being changed here — but it is the third time in a month that a migration
has held up shipping, and it is worth a separate decision about whether migrations
should be able to block unrelated releases.

## Lessons

1. **Every layer can be correct while the system is wrong.** Four checks passed —
   table, view, permissions, service account — and the answer was still zero. When
   each component is fine, stop testing components and start testing *the path the
   application actually takes*. That is what the credentialed probe did, and it is
   the step that ended a two-hour hunt.

2. **An empty result and a failed request must never look identical on screen.**
   The grid said "No sales orders yet" while the request was returning an error.
   Anyone who opened it would have concluded the data was gone. This was fixed
   separately, and it is the most reusable lesson here.

3. **The expected cause was not the cause, and the precedent nearly cost time.**
   A recreated view losing its permissions has taken this exact screen down before
   and is written up in the working agreement. It was the right first suspicion —
   and it was wrong, and the probe is what said so. A known precedent is a place to
   look, never an answer.

4. **Nobody reported it, and that is not reassurance.** The only reason this was
   harmless is that it happened between midnight and 3am. The same change at 10am
   would have had the sales floor looking at an empty order list with a message
   telling them there were no orders. Timing is not a control.

5. **The write-up said "all day" and it was two and a half hours.** Written in the
   small hours, at the end of a long batch, in good faith. It is the same class the
   working agreement already names — a number in a document is a fact with an
   expiry date — and it is why this correction is recorded rather than quietly
   fixed.
