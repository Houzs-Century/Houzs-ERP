# Module: Service Case (ASSR)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Per-module technical doc — after-sales service cases from intake to close:
the screen, the pipeline, the API, the tables, and who is allowed to do what.
Second of the per-module set (see `docs/modules/sales-order.md` for the shape).

Verified against `main` @ `8f8427ed`. Line citations are that commit.

> Conventions: `assr_cases` lives in the **public** schema (NOT `scm`), so every
> read/write goes through the D1-shim raw SQL (`c.env.DB.prepare`), not the
> PostgREST client. All endpoints are under `/api/assr` (plus the token-gated
> portals). Dates display DD/MM/YYYY; `complained_date` is a `YYYY-MM-DD` text
> column stamped in MYT.

---

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop list + detail | `frontend/src/pages/ServiceCases.tsx` | **8,032 lines** — list, calendar, create panel, detail panel, workflow card, stage accordion all in one file. Exports `ServiceCases` and `ServiceCaseDetail`. Do not open whole. |
| Desktop "my cases" | `frontend/src/pages/MyCases.tsx` | Assignee-scoped card view (`MyCases`, `MyCaseDetail`). |
| Desktop sub-views | `ServiceMetrics.tsx`, `ServiceSettings.tsx`, `ServiceLeadTimePortal.tsx` | Imported by `ServiceCases.tsx:79-81`. |
| Mobile (list + detail + create) | `frontend/src/mobile/MobileServiceCase.tsx` | 3,042 lines. Tabbed detail (Overview / Stage / Info / Timeline), `NewCaseSheet` at `:1775`. |
| Shared stage logic | `frontend/src/vendor/scm/lib/assr/stages.ts` | 178 lines, no React, no I/O. The one place the pipeline is defined. |

Desktop routes: `/assr`, `/assr/:id`, `/my-cases`, `/my-cases/:id`
(`frontend/src/App.tsx:366-416`). Mobile mounts `MobileServiceCase` for
`/assr` (`frontend/src/mobile/MobileApp.tsx:109,717`) and as the "Service"
bottom tab (`:756`).

### The 7-stage pipeline (and why a case sometimes runs 5)

`frontend/src/vendor/scm/lib/assr/stages.ts` (`ASSR_STAGES`) is the canonical
ordered table; the backend's `ALL_STAGES` (`backend/src/services/assr.ts`)
carries the same seven plus the terminal `voided` below.

**Order changed 2026-08-11 (Nico): Solution now comes BEFORE Verification** —
decide the fix first, then inspect/verify.

| # | `assr_cases.stage` | Chip | Owner role |
|---|---|---|---|
| 1 | `pending_review` | Review | Service Admin |
| 2 | `pending_solution` | Solution | Service Admin |
| 3 | `under_verification` | Verify | Service Admin |
| 4 | `pending_supplier_pickup` | Supplier | Service Admin |
| 5 | `pending_item_ready` | Pending Item Ready | Service Admin |
| 6 | `pending_delivery_service` | Delivery | Logistic Admin |
| 7 | `completed` | Completed | System |

**`voided` is an EIGHTH stage value and is NOT in the pipeline table** (Nico
2026-07-29). It is the terminal alt-outcome for a case verified as not valid /
not warranty-covered, parallel to `completed`, never a step. It is in the
backend `Stage` union and in `ALL_STAGES` (so `transitionStage` accepts it) but
absent from `ASSR_STAGES`, so no surface renders it as a stage chip.
`statusForStage` maps both `completed` and `voided` to "Closed". The difference
that matters: BOTH stamp `closed_at` and stop the SLA clock, but only
`completed` stamps `completion_date` and feeds the satisfaction survey — a
voided case stays out of the completed count and out of CSAT. Its reason is
captured in `void_reason` (a `PATCH_FIELDS` member).

**Stages 4 and 5 are supplier-only.** `ASSR_SUPPLIER_ONLY_STAGES`
(`stages.ts:53-56`) drops out when the case's `resolution_method` routes
`internal` — `resolutionRoute()` (`stages.ts:63-69`) returns `internal` for
exactly `field_service_own` and `return_visit`, `supplier` for every other
non-empty method, and `null` (full 7 shown) when the method is not yet chosen.
So a case runs **7 stages, or 5 when resolution is in-house**.

`isStageActive()` (`stages.ts:76-84`) keeps the case's CURRENT stage in the
list unconditionally — a case parked on a filtered-out stage still renders.

**Progress is computed off the filtered list, not the 7-stage table:**

- Desktop detail: `getActiveStages()` (`ServiceCases.tsx:5058-5063`) filters
  `DETAIL_STAGES` (`:5036`) through the shared `isStageActive`; the result is
  memoised once per case at `:2906-2909` and threaded into the workflow card,
  summary bar and stage accordion. The card renders `Step {curIdx + 1} / {n}`
  where `n = stages.length` (`:5215-5216`, `:5222-5224`) plus a dot rail. There
  is **no percentage** on desktop.
- Mobile list card: `activeMStages(...)` per row (`MobileServiceCase.tsx:522-523`),
  showing `idx+1 / rowStages.length` (`:587`) and one mini bar per active stage
  (`:591-596`).
- Mobile Stage tab: percentage bar width is
  `round(max(curStageIdx,0) / max(activeStages.length - 1, 1) * 100)`
  (`:1274`) — a fraction of the LAST INDEX, so stage 1 reads 0% and the final
  stage reads 100% — beside the same `n/N` counter (`:1277`). Phases
  (Intake / Repair / Return, `PHASE_DEFS` `:83-87`) are keyed by stage, so the
  whole Repair phase disappears for an internal-resolution case (`:1279-1285`).

Two **sub-statuses** (小类) live inside two stages only — `ASSR_SUB_STATUSES`
(`stages.ts:112-121`): Under Verification → `pending_inspection` /
`qc_issue_result`; Supplier Pickup → `pending_supplier_pickup` /
`pending_supplier_return`. They are directly switchable by ops (desktop select
at `ServiceCases.tsx:5241-5252`), stored on `assr_cases.sub_status`, and
`assrSubStatusAddsInfo()` (`stages.ts:156-161`) hides one that merely restates
its stage label.

> `frontend/src/components/ServiceProgressTracker.tsx` **was DELETED** (with its
> unused `ServiceCases.tsx` import) after this audit: it was never rendered
> anywhere in the tree, and it carried its own 7-stage copy with **no** resolution
> filter, so wiring it up would have regressed the 7-vs-5 rule. Any future stepper
> must derive its stages from `stages.ts`.
>
> `backend/src/services/printTracker.ts` still carries the same unfiltered
> 7-stage copy for the PDF stepper. It has **no importer** either at this commit,
> so it is inert — but it is the next place the rule would break, and it is not
> covered by that deletion.

### Required fields at create

Enforced on **both** halves as of 2026-07-21:

| Field | Frontend gate | Server guard |
|---|---|---|
| `doc_no` (SO) | desktop `ServiceCases.tsx`; mobile `MobileServiceCase.tsx` | `backend/src/routes/assr.ts` → one combined 400 `"doc_no, complaint_issue and issue_category are required"` |
| `complaint_issue` | same | same 400 |
| `issue_category` | same (desktop also requires the custom label when "Other…" is picked) | same 400 — `hasCategory` treats whitespace-only as missing |

**`items[]` is NOT required — that changed on owner audit 2026-07-22.** The
server used to 400 `"At least one item is required"`; it no longer does, and the
literal is gone from the tree. A Service Case is not necessarily about a
defective product (a driver damaged the customer's floor, a lorry problem left
the delivery incomplete), and the old guard forced staff to invent a fake item
code to submit. `item_code` (old shape) and `items[]` (new) are both accepted
and an empty result is fine.

**Create also has a duplicate-open-case guard** (same audit): if any submitted
`item_code` is already attached to a non-archived, non-`completed` case on the
SAME `doc_no` (company-scoped), create refuses **409 `duplicate_open_case`**
carrying an `existing[]` array grouped by case id, so the caller can offer "add
to that case instead". Item-less cases skip it — they have no product signature
to collide on.

The desktop comment at `ServiceCases.tsx` saying *"server still accepts a null
category"* is **stale** — the server `hasCategory` guard is the authority now.

### Complaint date is automatic and locked

- Server stamps it: `createAssrCase` accepts an explicit `complained_date`
  only if it matches `/^\d{4}-\d{2}-\d{2}$/`, else falls back to `todayMyt()`
  (`backend/src/services/assr.ts:357-363`).
- Mobile sends today and shows it disabled: fixed state with no setter
  (`MobileServiceCase.tsx:1804-1808`), rendered `readOnly disabled`
  (`:2107-2119`).
- Desktop's create panel does not send the field at all — the server default
  applies (`ServiceCases.tsx:2453-2467`).
- It cannot be edited afterwards: `complained_date` is **absent** from
  `PATCH_FIELDS` (`backend/src/services/assr.ts:785-830`), so `PATCH /api/assr/:id`
  silently ignores it. Detail screens render it read-only as "Created"
  (`ServiceCases.tsx:4172`, `:4238`).

### Data hooks and caching

Desktop uses the repo's own `useQuery` wrapper (`frontend/src/hooks/useQuery.ts`,
TanStack underneath, keys namespaced `["uq", …]`):

- List — `useQuery<Paginated<AssrCase>>("assr-list", …)` at
  `ServiceCases.tsx:438-457`; deps carry stage / search / page / perPage /
  archived / exclude_stage / assigned_to / creditor / sort; `keepPreviousData:
  true` so a filter or page switch never flashes an empty table.
- Detail — `useQuery<AssrDetail>("/api/assr/:", …)` at `:2897-2900`, keyed by id.
- Summary KPIs — `"/api/assr/summary?since_days=730"` at `:1050`.
- Calendar and export use separate keys (`"assr-list-date-range"` `:1444`,
  `"assr-list-export"` `:1210`) so they cannot share the list's cache entry.
- Lookups (issue categories, resolution methods, priorities, NCR categories)
  are their own keys at `:2251-2260` and `:2956-2968`.

Mobile uses TanStack directly:

- List — `useInfiniteQuery(["mobile-assr-list-paged", debouncedQ, sort, mineParam])`
  (`MobileServiceCase.tsx:390-401`): `staleTime 30_000`, `placeholderData: prev`,
  and **`enabled: canViewCases`** so a user without access never fires the
  request (off, not hidden).
- Detail — `["mobile-assr-detail", id]`, `staleTime 15_000` (`:672-676`).
- Every mobile write funnels through `runWrite` (`:680-696`), which refetches
  the detail and invalidates the `["mobile-assr-list-paged"]` **prefix** — the
  comment at `:687-688` records the bug where a non-prefix key never invalidated.
- Chip count badges are computed over LOADED rows only (`:404-412`); the honest
  total comes from the server envelope.

---

## 2. API surface

All under `backend/src/routes/assr.ts` (3,097 lines, ~50 endpoints). This table
is the ones that matter; the full machine-checked gate list is
`docs/generated/route-capability-matrix.csv` (filter `/api/assr`).

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/api/assr` | `requireServiceCaseAccess()` `:807` | Paginated list (stage / status / search / assigned_to / creditor / from+to / sort) |
| GET | `/api/assr/:id` | `requireServiceCaseAccess()` `:1399` | Case + items + attachments + activity + logistics + related POs + stage history + portal token |
| POST | `/api/assr` | `requireServiceCaseAccess(["service_cases.create","service_cases.write","service_cases.manage"])` `:1517-1528` | Create (see required fields above) |
| PATCH | `/api/assr/:id` | `requirePermission("service_cases.write")` `:1657` | Field edits, whitelisted by `PATCH_FIELDS` |
| POST | `/api/assr/:id/transition` | `service_cases.write` `:2570` | Move stage (any-to-any; fires the survey email on `completed`) |
| POST | `/api/assr/:id/mark-opened` | `service_cases.write` | Auto-advance on first open. Since the 2026-08-11 order change it lands on **`pending_solution`**, not `under_verification` (`markCaseOpened`, `services/assr.ts`). No-op unless the case is currently `pending_review`. |
| POST | `/api/assr/:id/approve` | `service_cases.approve` | Cost approval. **The key was UNDECLARED until 2026-08-13** — the route had always checked it, but it was missing from `services/permissions.ts`, so it never reached `PERMISSION_KEYS`, could not be granted in the roles matrix, and only `*` holders passed. Cost approval was accidentally Owner/IT-only. Now declared; who can approve today is unchanged, but the gate is grantable. |
| POST | `/api/assr/:id/generate-po` | `service_cases.manage` `:2470` | Mint the service PO number |
| GET | `/api/assr/summary` | `service_cases.read` `:584` | KPI tiles (backlog, aging, SLA breach, by stage/status/location/category) |
| GET | `/api/assr/metrics`, `/metrics/drill` | `service_cases.read` `:2064`, `:2320` | Reporting |
| GET | `/api/assr/my-cases` | `requireServiceCaseAccess()` `:1297` | Assignee board |
| GET | `/api/assr/export.csv`, `/:id/timeline.csv` | `requireServiceCaseAccess()` `:1103`, `:2714` | Exports |
| POST/DELETE | `/:id/track-link`, `/:id/supplier-link`, `/:id/survey-token` | `service_cases.write` `:1765`, `:1842`, `:1890` | Mint / revoke portal tokens |
| PUT | `/:id/attachments`, `/:id/attachments/thumb` | `service_cases.write` `:2881`, `:2928` | R2 upload (+ thumb) |
| POST/PATCH | `/:id/logistics`, `/:id/items`, `/:id/notes` | `service_cases.write` `:3051`, `:2799`, `:2656` | Child records |
| PUT/POST/PATCH/DELETE | `/settings`, `/lookups/:kind*` | `service_cases.manage` `:321-475` | Admin config (read is `:296` / `:371`) |
| POST | `/bulk/archive`, `/bulk/unarchive`, `/bulk/assign`, `/run-escalation` | `service_cases.manage` `:1025`, `:1042`, `:1058`, `:2057` | Bulk + manual SLA sweep |

Token-gated companions (no session): `/api/track` (customer verify),
`/api/portal/*` (customer), `/api/supplier-portal/*` (supplier),
`/api/survey/:token`, `/api/assr-print/:id`. See `docs/CODEBASE-MAP.md` §5.3.

---

## 3. Backend

`backend/src/routes/assr.ts` is a thin gate + shape layer; the logic is in
`backend/src/services/assr.ts` (1,929 lines).

### List (`assr.ts:807-835` → `services/assr.ts:1553-1727`)

1. **Scope** — `assrVisibleUserIds(c)` (`assr.ts:148-156`) and
   `assrVisibleAgentNames(c)` (`:163-…`), both keyed off the same tier
   predicate `assrUnrestricted` (`:140-146`). `undefined` = unrestricted.
2. **Company** — `assrCompanyIds(c)` (`:115-117`) → `pushAllowedCompanies`.
   Service Cases are a cross-company queue that follows the caller's granted
   companies (decision trail in the header comment `:91-106`).
3. **Filters** — stage / exclude_stage (both accept CSV), status, assigned_to
   (matches `assigned_to` OR `assigned_to_2`), creditor_code, and a search
   predicate that covers case no / SO doc / ref / customer / complaint text /
   item code / phone (separator-free, via `cleanPhone`) plus a correlated
   `EXISTS` over `assr_items` (`services/assr.ts:1610-1614`).
4. **Calendar window** — optional `from`/`to` compared on `substr(col,1,10)`
   against `complained_date` or `COALESCE(deadline_at, complained_date)`
   (`services/assr.ts:1626-1638`). Absent = unbounded, so the List view is
   unaffected.
5. **Query** — one `COUNT(*)` + one page, issued CONCURRENTLY (they are
   independent reads over the same predicate). The row SELECT joins `users` three
   times (assignee, creator, second assignee), `creditors`, `companies`, and
   computes `stage_since`, `days_in_stage`, `hours_to_deadline`, `is_breached`
   inline, wrapped in a subselect so `ORDER BY` can use the aliases
   (`services/assr.ts:1667-1719`). `per_page` capped at 200, default 50
   (`:1643`).
6. **Redaction** — for any scoped (non-unrestricted) caller, creditor fields
   are stripped from every row (`assr.ts:832-834`, `stripCreditorFields` `:800`).

### Create (`assr.ts:1517-1637` → `services/assr.ts:createAssrCase`)

Resolves the SO context (local scm SO first, else AutoCount `getSingle`
`services/assr.ts:342-354`), mints the ASSR number, stamps `complained_date`,
derives `sla_hours` + `deadline_at` from priority (`:370-372`), resolves the
default assignees from `system_settings` on every create so a settings change
takes effect without a deploy (`:383-401`), snapshots the stage target
(`:409-411`), resolves the owning company (SO's company outranks the request,
`:415-418`) and inserts. The route then reads the row back and fires
`notifyServiceCaseResponsible` for assignees + creator + upline
(`assr.ts:1608-1631`), best-effort.

### SLA targets

Two independent clocks.

**Case-level** — `SLA_HOURS_BY_PRIORITY` (`services/assr.ts:62-69`) is the
single source of truth:

| Priority | SLA hours |
|---|---|
| `urgent` | 24 |
| `high` | 72 |
| `normal` (default) | 168 (7 days) |
| `low` | 336 (14 days) |

`slaHoursFor()` (`:71-73`) defaults anything unknown to 168.
`deadline_at = now + slaHours` at create (`:370-372`); changing priority via
PATCH recomputes `deadline_at` off `created_at` unless the request also sets
`deadline_at` or `sla_hours` explicitly (`:994-1006`).

**Per-stage** — `lookupStageTargetDays()` (`:126-160`) resolves in order:
1. `assr_priority_stage_targets` joined to `assr_priorities` on the case's
   priority slug (mig 082);
2. the active Lead Time profile — `assr_stage_targets` × `assr_lead_time_profiles
   WHERE is_active = 1` (mig 075);
3. the hardcoded Normal defaults `DEFAULT_STAGE_TARGET_DAYS` (`:102-111`):
   review 1, verification 2, solution 2, supplier pickup 3, item ready 5,
   delivery 4, completed 0.

Each read is wrapped in try/catch so a missing config table can never crash a
transition. The resolved value is **snapshotted** onto
`assr_cases.stage_target_days` when the case enters the stage
(`transitionStage` `:650-706`), so amending a profile later does not rewrite
history.

**Escalation** — `runSlaEscalation` (`backend/src/services/assrEscalation.ts`)
stamps `escalated_at` on open cases more than 24 h past `deadline_at`, logs to
`assr_activity`, and emails the assignee plus `service_cases.manage` holders.
Runs from the daily cron (`backend/src/index.ts`) and manually via
`POST /api/assr/run-escalation`.

**"Open" means neither terminal stage, and not archived (2026-08-14).** There
are TWO terminal stages — `completed` and `voided`. Both stamp `closed_at`, both
render as "Closed". Every open / backlog / aging / SLA-breach predicate used to
be a hand-written `stage != 'completed'`, roughly thirty copies naming one of the
two, so a VOIDED case stayed in the backlog, kept aging, kept breaching, and was
picked up by this cron — which mailed the assignee and every manager about a case
somebody had closed precisely so it would stop demanding attention. Archived
cases were never excluded either.

The predicate now has one home: `assrOpenStageSql(alias)` in
`backend/src/services/assrStages.ts`, used by the escalation candidates, the
three `is_breached` CASE arms in `services/assr.ts`, and every count and list
filter in `routes/assr.ts`. Two rules go with it:

- The **closed** side (`stage = 'completed'`) is deliberately NOT collapsed into
  it. That drives the resolved counts and the average-resolution-time figures,
  and a voided case was not resolved. "Not open" and "resolved" are different
  questions.
- The `stage IS NULL` arm is load-bearing. `stage NOT IN (…)` is NULL for a
  legacy row, which is not TRUE, so those rows would silently leave every count.

### Transition (`services/assr.ts:650-706`)

Transitions are deliberately **unrestricted** in both directions — ops can
revert a completed case or skip stages; the only bound is `ALL_STAGES.includes`,
which throws `Unknown stage: …` (prod PG carries no CHECK on the column; the D1
test mirror's CHECK does not list `voided`, so do not write a voided-stage test
there). Each transition refreshes `stage_changed_at` +
`stage_entered_at`, re-snapshots `stage_target_days`, and seeds `sub_status`
to the stage's first sub-state (or NULL for stages without one, `:689-702`) so
a stale sub-status cannot leak across stages.

---

## 4. Database

Schema `public` (not `scm`). Core table `assr_cases`; children keyed by
`assr_id`.

| Table | Role |
|---|---|
| `assr_cases` | The case. `assr_no`, `status`, `stage`, `sub_status`, `doc_no`, `complained_date`, identity columns mirrored from the SO (`customer_name`, `phone`, `location`, `sales_agent`, `addr1..4`), `complaint_issue`, `issue_category`, `priority`, `resolution_method`, `assigned_to` / `assigned_to_2`, `created_by`, `creditor_code` (+ `creditor_source`), `sla_hours`, `deadline_at`, `escalated_at`, `stage_entered_at`, `stage_changed_at`, `stage_target_days`, `lead_time_profile_id`, `company_id`, `archived_at`, `closed_at` |
| `assr_items` | Affected products (`item_code`, `item_description`, qty, remark) |
| `assr_stage_history` | Per-stage `entered_at` / `exited_at` / `target_days` / `skipped` — the reporting spine |
| `assr_activity` | Append-only timeline (field changes, stage changes, notes, audience bucket) |
| `assr_attachments` | R2 keys + visibility flag (+ thumbs) |
| `assr_logistics` | Pickup / return legs |
| `assr_priorities`, `assr_priority_stage_targets` | Priority master + per-(priority, stage) target days |
| `assr_lead_time_profiles`, `assr_stage_targets`, `assr_lead_time_activations`, `assr_lead_time_amendments`, `assr_lead_time_scheduled_activations` | The Lead Time portal |
| `assr_issue_categories`, `assr_resolution_methods`, `assr_ncr_categories` | Editable lookups |
| `assr_alert_acks` | Alert ack / snooze / override |
| `assr_supplier_tokens`, `assr_survey_tokens`, `case_track_tokens` | The three portal token families |

Columns that were added late and are easy to miss (all in `migrations-pg/`):
`0062` `qc_receipt_date` · `0063` supplier/goods-returned notes · `0064`
`customer_pickup_at` · `0065` supplier accept-quote · `0073` `inspection_by`
(`own` | `supplier`) · `0075` `assigned_to_2` · `0077` email mute · `0083`
`company_id` · `0105` folded Pending Inspection into Under Verification ·
`0110` retired Item Pickup · `0115` `creditor_source` · `0116` `sub_status` ·
`0158` `inspection_visit_at`.

Indexes that matter: `idx_assr_stage`, `idx_assr_status`, `idx_assr_assigned`,
`idx_assr_deadline`, `idx_assr_cases_archived`, `idx_assr_stage_entered`,
`idx_assr_stage_history_open (assr_id, exited_at)` — all in
`backend/src/db/migrations-pg/0002_indexes.sql:15-49`; plus
`idx_assr_activity_stage_since (assr_id, action, to_value, created_at)`
(mig 0232), which backs the per-row `stage_since` correlated subquery used by
BOTH the list SELECT and the summary's aging aggregate; plus trigram GIN on
`assr_no` / `customer_name` / `phone` / `complaint_issue` / `doc_no` / `po_no`
in `0001_search_trgm.sql:32-37`.

---

## 5. Performance summary

Measured (`docs/scm-scaling-audit.md:15`): Service Cases at 761 cases →
page 492 ms, of which `/api/assr` is **118 ms** (paginated to 50 rows) and
`/api/assr/summary` **219 ms**.

Optimized:
- Server-side pagination + server-side sort (`ASSR_SORT_MAP`), `per_page`
  capped at 200.
- Calendar view passes the visible month as `from`/`to` so it pulls a window,
  not the whole backlog (`services/assr.ts:1626-1638`).
- Mobile list is an infinite query with `placeholderData: prev`; the row cards
  read only columns the list SELECT already returns.
- Search is trigram-indexed on the six hot columns.

Watch as data grows:
- `/api/assr/summary` runs its **13 independent aggregates as ONE concurrent
  wave** (`routes/assr.ts`, `Promise.all`) — it used to run them serially, which
  measured 219ms and was the slower half of the page load. Each still re-applies
  the visibility + company predicates. Caching is the next lever if it regresses
  again; do NOT re-serialize it.
- The list's `days_in_stage` / `stage_since` use a correlated `MAX()` over
  `assr_activity` per row (`services/assr.ts:1678-1696`). `assr_cases.stage_entered_at`
  already carries the same fact since mig 074; the subselect exists for rows
  written before that. Retiring it is the obvious next win.
- `MyCases.tsx:79` still fetches `/api/assr/my-cases` with no limit — open item
  B6 in `docs/perf-optimization-plan.md:115`.

---

## 6. Who can see and do what

**The backend is the authority. Nothing on the frontend re-derives the rule —
where it does today, that is called out below as a divergence, not a pattern.**

### Route admission (who gets THROUGH)

Two gates, deliberately different:

- `requireServiceCaseAccess(perms)` (`backend/src/routes/assr.ts:78-89`) wraps
  `canAccessServiceCases` (`:66-74`): pass if the caller holds any of the listed
  permissions **OR** is Sales staff (`isSalesUser`) **OR** is a director
  (`isDirectorUser` = `*` / Super Admin / Sales Director / Finance Manager).
  Applied only to READS and to CREATE.
- `requirePermission("service_cases.<verb>")` — plain, for every write /
  manage / approve route. Owner rule 8 widened intake for Sales; it never
  widened mutation access (comment `:52-65`).

Permission keys in play: `service_cases.read`, `.create`, `.write`, `.manage`,
`.approve`.

### Row visibility (WHICH cases)

`assrUnrestricted(user)` (`assr.ts:140-146`) — `*`, or `service_cases.manage`,
or a director — sees everything. Everyone else is narrowed to their reporting
subtree by `assrVisibleUserIds` (`:148-156`, `subtreeUserIds`, full depth) plus
`assrVisibleAgentNames` (`:163-…`) for legacy cases that only carry a free-text
`sales_agent`. Both fail **closed** (`[]`) when the caller has no resolvable
identity. Scoped callers additionally lose creditor fields (`stripCreditorFields`
`:800`, applied at `:832-834`).

Company scope is orthogonal: every reader filters on `allowedCompanyIds`
(`assrCompanySql` `:109`, `assrCompanyIds` `:115`), every creator stamps
`assrCreateCompanyId` (`:124`), and an SO-attached case inherits the SO's own
company (`createAssrCase`).

**The PRINT route applies both halves too (2026-08-14).**
`GET /api/assr-print/:id` (`routes/assr_print.ts`) emits the same case content as
the JSON detail route, as a letterheaded document. It had the company check and
nothing else, so a visibility-scoped salesperson could render ANY case in their
own company by walking the id — and get MORE out of it than the JSON route would
give them, because the office variant printed `creditor_name` in full. Both rules
now live in `backend/src/services/assrVisibility.ts` — `services/` cannot import
from `routes/`, so that is the only direction in which both surfaces can share
them — and are called by both:

| exported from `services/assrVisibility.ts` | answers |
|---|---|
| `assrCaseRowInScope(c, caseRow)` | may this caller see this case at all (self + downline + the legacy `sales_agent` reach)? `true` for an unrestricted caller. |
| `assrCallerIsScoped(c)` | is this caller visibility-restricted, i.e. must not see supplier identity? |
| `stripCreditorFields(row)` | removes the creditor columns, both naming conventions. |

If you add a third surface that renders a case, it calls these. A rule enforced
on one of two routes that emit the same content is not enforced.

### Frontend gates

| Surface | What it checks | File |
|---|---|---|
| Desktop routes `/assr`, `/assr/:id`, `/my-cases`, `/my-cases/:id` | `PageGuard page="service_cases" allowSales` | `App.tsx:369, 386, 402, 410` |
| `PageGuard`'s `allowSales` | the **server's** answer — `capability(user, "org.sales.staff")`, the same `pmsAccess.isSalesUser` classifier `requireServiceCaseAccess` admits on | `frontend/src/auth/PageGuard.tsx:70`, `backend/src/services/capabilities.ts:244` |
| Mobile Service tab admission | shell nav gate `allowed("/assr")` | `frontend/src/mobile/MobileApp.tsx:474` |
| Mobile list query `enabled` | `can("service_cases.read") \|\| capability(user, "org.sales.staff") \|\| capability(user, "org.director")` — `canViewCases` | `frontend/src/mobile/MobileServiceCase.tsx` |

> **The director divergence this section used to report is FIXED.** The mobile
> predicate carried only two of the backend's three terms and omitted the
> director branch, so a director holding neither `service_cases.read` nor Sales
> staffing was admitted by the API but left the mobile infinite query
> `enabled: false`. It now consumes the backend's own `org.director` capability
> (`capabilities.ts`), the way `PageGuard` consumes `org.sales.staff` — all
> three terms, no second local copy of the rule.

---

## 7. Desktop and mobile files that must change together

The owner's standing rule is ONE logic layer, two presentations. For this
module that means:

| Change | Desktop | Mobile | Shared |
|---|---|---|---|
| Stage pipeline, stage labels, supplier-only rule, sub-statuses | `pages/ServiceCases.tsx` (`DETAIL_STAGES` `:5036`, `getActiveStages` `:5058`) | `mobile/MobileServiceCase.tsx` (`STAGES` `:74`, `activeMStages` `:78`, `PHASE_DEFS` `:83`) | **`vendor/scm/lib/assr/stages.ts`** — put the rule HERE; both surfaces already import it |
| Intake required fields | `ServiceCases.tsx:2857-2872` (disabled gate) + `:2425-2467` (submit) | `MobileServiceCase.tsx:1921` (`valid`) + `:1858-1890` (payload) | server guard `backend/src/routes/assr.ts:1548-1566` — change this FIRST |
| Enum option lists (priority / issue category / resolution / verification / QC) | `ServiceCases.tsx` lookups `:2251-2260`, `:2956-2968` | `MobileServiceCase.tsx:92-118` hardcoded fallbacks + `useLookupNames`/`useLookupSlugs` `:215` | `/api/assr/lookups/:kind` is the source; the constants are only a pre-fetch fallback |
| Patchable fields | `InlineEdit` sites in `ServiceCases.tsx` | `EditableAcc` field list `MobileServiceCase.tsx:1197` | `PATCH_FIELDS` `backend/src/services/assr.ts:785-830` |
| Attachment upload / thumbs | `ServiceCases.tsx:2472-2498` | `MobileServiceCase.tsx:1890-1905` | `lib/assrAttachmentUpload.ts`, `lib/imagePipeline.ts` |
| Access gating | `App.tsx` `PageGuard` | `MobileApp.tsx` nav gate + `MobileServiceCase.tsx:340` | backend capabilities (`services/capabilities.ts`) |

The history is not hypothetical: `stages.ts:1-16` exists because mobile once
ignored the internal-resolution skip and mis-routed cases into the two
supplier-only stages with the wrong progress denominator.

---

## Related

- `docs/CODEBASE-MAP.md` §5.3 — the full ASSR + portal endpoint inventory.
- `docs/generated/route-capability-matrix.csv` — machine-generated gate per route.
- `docs/SERVICE_MODULE_TEST_GUIDE.md` — manual test walkthrough.
- `docs/modules/delivery-tms.md` — service cases with a `customer_pickup_at`,
  `do_date` or own-team `inspection_visit_at` also surface as fleet jobs on the
  delivery board.
- `BUG-HISTORY.md` — read the Service Case entries before touching this module.
