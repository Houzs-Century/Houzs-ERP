## The venue picker offered every company's showrooms — `GET /venues?includeShowrooms=1` read `scm.warehouses` with no company predicate [high]

<!-- area: Projects + PMS + fair report -->

**白话.** Houzs 的人开单、开 project 选 Venue 的时候，清单里会跑出 2990 的展厅
「2990s PJ」。两家公司的 Venue、Warehouse、Showroom 本来就该各看各的。原因很单纯：
这支 API 的 Venue 清单是两半拼起来的——上半截读 `project_venues`，早就有加公司条件；
下半截读 `scm.warehouses` 里标成 Showroom 的仓，那一半漏了没加。同一份清单，
Members 页那支 `/staff/showrooms` 早就修好了，这一半没跟上。

**Symptom.** Owner, 2026-08-19: *"客人开单不能看到 2990 的展厅啊。分开的公司都不一
样啊，收入单也不一样。venue 都不一样啊"* and *"我们的 Venue、我们的 Warehouse、我们的
Showroom 等等，都是跟着看到自己公司的"*. A HOUZS user raising a project or an SO saw
2990's showroom in the venue picker.

**Root cause, traced.** `GET /api/projects/venues?includeShowrooms=1`
(`backend/src/routes/projects.ts`) builds its list from two reads. The
`project_venues` half carries `activeCompanySql(c)` (mig 0093). The SHOWROOM half
ran `SELECT id, code, name, venue_name FROM scm.warehouses WHERE is_showroom =
true AND is_active = true AND venue_name IS NOT NULL AND btrim(venue_name) <> ''`
with **no `company_id`** — so it returned the same rows to every caller. The SCM
client is service-role and bypasses RLS (mig 0061 enabled RLS with no policies),
so the missing predicate was the entire tenant boundary. Measured against prod,
not reasoned: `backend/scripts/check-showroom-venue-scope.mjs` via the
**Venue showroom parking check (read-only)** workflow, run 32350415733 —
one flagged showroom venue exists system-wide, `PJ SHOWROOM` / `"2990s PJ"`,
owned by `company_id 2`, and HOUZS's picker listed it. Per company: HOUZS
`BEFORE 1 -> AFTER 0` (the foreign row removed), 2990 `BEFORE 1 -> AFTER 1`
(keeps its own). Rows with a NULL `company_id`, which the fix would have hidden
from everyone: **0**.

**Second, narrower hole found in the same sweep.** `GET
/mfg-sales-orders/active-venue` maps the resolved venue TEXT onto a
`project_venues` id with `WHERE lower(trim(name)) = lower(trim(?)) AND active = 1`
and no company predicate, and that id is what the SO dropdown then selects.
Scoped the same way. This one is PREVENTATIVE, stated plainly: the same run shows
**0** venue names held by more than one company, and the single showroom venue is
mastered by nobody (`owners [none]`, so `venueId` was already null). The exposure
is real but currently unexercised — 2990 masters **0** of the 92 active
`project_venues` rows, so any name a 2990 caller resolves can only match a HOUZS
row.

**Fix.** `activeCompanySql(c, "company_id")` on the showroom SELECT;
`activeCompanySql(c)` on the active-venue id lookup. Guarded by
`backend/tests/showroomVenueCompanyScope.test.ts`, which asserts the SQL SHAPE
rather than the response: `scm.warehouses` exists in Postgres only, the D1 test
mirror has no such table, and the route's own try/catch degrades to an empty list
when that read throws — so a request-level test would pass with or without the
predicate. The test locators THROW when they cannot find their statement, so a
rename fails loudly instead of checking nothing. Proven red before trusting it:
removing the predicate fails `it carries a company predicate`.

**Left alone, and why — needs an owner decision.** `loadVenueNames` in
`backend/src/scm/routes/scan-so.ts` reads `SELECT name FROM project_venues WHERE
active = 1` with no company predicate, and its comment says that is deliberate:
it feeds `buildCachedPrefix`, which must stay byte-identical across `/extract`,
`/warm` and the headless cron + queue job, none of which carry a request scope.
Scoping it is a cached-prefix redesign, not a predicate. It is an OCR
allowed-values pool rather than a picker, but a HOUZS scan could still match a
2990 venue name onto a HOUZS SO. Flagged, not changed.

**Everything else in this class was already scoped**, checked one by one:
`/staff/showrooms` and the parking write (`scm/routes/staff.ts`), `GET
/warehouses` and the dead-stock warehouse read (`scm/routes/inventory.ts`), the
`scm.showrooms` reads in `hr.ts`, `slips.ts` and `scan-payment.ts`, and every
`project_venues` statement in `scm/routes/venues.ts` and the rest of
`routes/projects.ts`. `venue-binding.ts`'s showroom resolve follows the caller's
own `staff.showroom_warehouse_id`, whose write is company-checked.

**Ref.** PR #2536, `fix/showroom-venue-company-scope`, 2026-08-20.
