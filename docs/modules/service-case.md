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

### The two SO typeahead dropdowns are placed by the shared positioner

Both SO search boxes — the one on the case detail panel and the one on the
intake form — portal their suggestion list to `<body>` and place it with
`frontend/src/lib/anchoredPanel.ts`, the same module every other floating picker
in this app uses. It opens the list on whichever side of the input has more
room and clamps its height to that room, so the last suggestion is never below
the fold; each passes 288px as its preferred cap (what the old `max-h-72` class
asked for) and keeps this page's own `z-index: 60`. The detail-panel list also
keeps its 320px width floor, which overrides the anchor's own width.

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop list + detail | `frontend/src/pages/ServiceCases.tsx` | **8,032 lines** — list, calendar, create panel, detail panel, workflow card, stage accordion all in one file. Exports `ServiceCases` and `ServiceCaseDetail`. Do not open whole. |
| Desktop "my cases" | `frontend/src/pages/MyCases.tsx` | Assignee-scoped card view (`MyCases`, `MyCaseDetail`). |
| Desktop sub-views | `ServiceMetrics.tsx`, `ServiceSettings.tsx`, `ServiceLeadTimePortal.tsx` | Imported by `ServiceCases.tsx:79-81`. |
| Mobile (list + detail + create) | `frontend/src/mobile/MobileServiceCase.tsx` | Tabbed detail (Overview / Stage / Info / Timeline) + `NewCaseSheet`. |
| Mobile READ-ONLY detail (Sales rep) | `frontend/src/mobile/MobileMyCaseDetail.tsx` | The mobile half of `/my-cases/:id`. Case + items + issue + the customer/sales/nudge conversation, and NO write control. Mounted in place of `CaseDetail` for `isSalesNonDirector`. |
| Shared stage logic | `frontend/src/vendor/scm/lib/assr/stages.ts` | No React, no I/O. The one place the PIPELINE (order, supplier-only rule, sub-statuses) is defined. It no longer holds the words. |
| Shared stage WORDS | `backend/src/scm/shared/assr-stage-labels.ts` + `frontend/src/vendor/scm/lib/assr-stage-labels.ts` | Byte-identical pair, refereed by `check-shared-mirrors.mjs --strict`. Every stage label — including `voided`, which the pipeline table correctly has no row for. |

Desktop routes: `/assr`, `/assr/:id`, `/my-cases`, `/my-cases/:id`
(`frontend/src/App.tsx:366-416`). Mobile mounts `MobileServiceCase` for
`/assr` (`frontend/src/mobile/MobileApp.tsx`) and as the "Service" bottom tab —
and a non-director Sales rep gets `MobileMyCaseDetail` in place of the editable
detail, the mobile half of the desktop `/my-cases/:id` redirect.

### The 7-stage pipeline (and why a case sometimes runs 5)

`frontend/src/vendor/scm/lib/assr/stages.ts` (`ASSR_STAGES`) is the canonical
ordered table; the backend's `ALL_STAGES` (`backend/src/services/assr.ts`)
carries the same seven plus the terminal `voided` below.

`ASSR_STAGES` owns the ORDER, not the WORDS. Each row's `long` is read from
`assr-stage-labels.ts`, which is where every surface — the portal, the printed
report, desktop and mobile — gets its stage wording. The two questions were
fused until 2026-08-18 and that is what produced the `voided` bug recorded
below.

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

That last fact used to have a bad consequence, because `ASSR_STAGES` also owned
the stage WORDS: a surface needing a word for a non-step had to invent one. The
customer portal's `customerStatusFor` never grew a `voided` arm and fell through
to `default: { label: stage }`, so the portal printed the raw slug `voided` — and
since `portal.ts` builds the salesperson stepper by mapping `ALL_STAGES` through
it, that slug appeared as a step label on EVERY sales-portal view. The words now
live in `assr-stage-labels.ts`, which answers for every value the column can
hold, step or not; `ASSR_STAGES` still (correctly) has no `voided` row.
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

- Desktop detail: `getActiveStages()` filters `DETAIL_STAGES` through the shared
  `isStageActive`; the result is memoised once per case and threaded into the
  workflow card, summary bar and stage accordion. The card renders
  `Step {curIdx + 1} / {n}` where `n = stages.length` plus a dot rail. There
  is **no percentage** on desktop.

  > **FIXED 2026-08-21 — the counter and the dropdown used to disagree.** The
  > "Change to" `<select>` mapped the module-level, UNFILTERED `DETAIL_STAGES`
  > while the `Step n / N` counter two lines above it read the FILTERED `stages`
  > prop it had been handed. On an internal-resolution case that read
  > "Step 2 / 5" beside a list of 7, the two supplier-only stages included.
  > `docs/bugs/0481-the-desktop-stage-picker-offered-stages-the-case-does-not-ru.md`.
  >
  > **`DETAIL_STAGES` no longer holds any stage WORDS.** It is
  > `ASSR_STAGES.map(...)`. It used to type its own `long` column and four rows
  > had drifted from the canonical table — desktop printed "Review", "Solution",
  > "Verification", "Delivery / Service" where mobile, the portal and the printed
  > report say "Pending Review", "Pending Solution", "Under Verification",
  > "Pending Delivery / Service". The funnel-dot caption `desc` moved onto
  > `AssrStageDef` (`stages.ts`), so the whole stage row has one home.

**`voided` is offered on DESKTOP ONLY, and that is an open question, not a
defect.** The desktop select appends `<option value="voided">` after the mapped
stages; mobile's picker has never carried it. So a case can be voided from a
desktop and not from a phone. Left exactly as it shipped when the filtering bug
above was fixed — whether the phone SHOULD be able to void is a business call
(the standing philosophy is to loosen rather than restrict), and merging it under
cover of a drift fix would have made that decision silently.
- Mobile list card: `activeMStages(...)` per row (`MobileServiceCase.tsx:522-523`),
  showing `idx+1 / rowStages.length` (`:587`) and one mini bar per active stage
  (`:591-596`).
- Mobile Stage tab: percentage bar width is
  `round(max(curStageIdx,0) / max(activeStages.length - 1, 1) * 100)`
  (`:1274`) — a fraction of the LAST INDEX, so stage 1 reads 0% and the final
  stage reads 100% — beside the same `n/N` counter (`:1277`). Phases
  (Intake / Repair / Return, `PHASE_DEFS` `:83-87`) are keyed by stage, so the
  whole Repair phase disappears for an internal-resolution case (`:1279-1285`).

**Sub-statuses** (小类) live inside two stages only — `ASSR_SUB_STATUSES`
(`stages.ts`): Under Verification → `pending_inspection` / `qc_issue_result`;
Supplier Pickup → `pending_customer_pickup` / `pending_supplier_pickup` /
`pending_supplier_return` — THREE legs since Nico 2026-09-01: the stage now
ENTERS on the customer-pickup leg (`transitionStage` seeds it) because
collecting the item FROM the customer comes first; ops advances the sub as the
item moves. The collect-from-customer dispatch words moved with that leg:
`sheetDetailStatus` (assrFormIntake.ts) emits the sheet's unchanged PICKUP
trigger word "Pending Supplier Pickup (Customer Pickup)" only while the sub is
`pending_customer_pickup` AND Pickup by = Customer pickup. The sheet's
column-A vocabulary is FROZEN (Nico 2026-09-01: A列不要修改), so the bare
customer-pickup leg exports the stage's bare word — the finer
"Pending Customer Pickup" label exists in the ERP UI only, and the export
never emits a word the sheet's validation would reject. Subs are directly switchable
by ops (desktop select), stored on `assr_cases.sub_status`, and
`assrSubStatusAddsInfo()` (`stages.ts`) hides one that merely restates its
stage label — with one exception (Nico 2026-08-22): under the combined
"Pickup / Return" stage the list's stage cell shows the sub line on EVERY leg,
because naming the leg is how ops splits its chase list. The same split reaches
the other read surfaces: the stage column's `getValue` appends the sub label
("Pickup / Return — Pending Supplier Return"), so the column filter menu and
the CSV export isolate one leg; and the `/api/assr/summary` `stage_funnel`
rows carry `sub_customer` + `sub_return` counts so the funnel card's caption
reads "X customer pickup · Y supplier pickup · Z supplier return" instead of
the static description.

The stage itself was RENAMED "Supplier Pickup / Return" → **"Pickup / Return"**
(Nico 2026-09-04, canonical tables both sides + the six hand-copy pill maps):
with the customer-pickup leg the stage is no longer supplier-specific, so the
name went neutral and the sub-status names the actor. The same decision emptied
`ASSR_SUPPLIER_ONLY_STAGES` — an own-team repair also collects and returns the
item and has its own QC phase, so **EVERY case now runs the full 7-stage
pipeline** and the old internal-vs-supplier 7-vs-5 filtering is retired (the
`isStageActive` machinery survives as an identity filter). The customer-portal
wording ("Pending Supplier Pickup") stays deliberately unchanged. The sheet's
frozen column-A words are untouched by the rename — they live in
`ASSR_SHEET_STATUS`, a separate table.

> `frontend/src/components/ServiceProgressTracker.tsx` [gone] **was DELETED** (with its
> unused `ServiceCases.tsx` import) after this audit: it was never rendered
> anywhere in the tree, and it carried its own 7-stage copy with **no** resolution
> filter, so wiring it up would have regressed the then-current 7-vs-5 rule
> (retired 2026-09-04 — see above). Any future stepper must derive its stages
> from `stages.ts`.
>
> `backend/src/services/printTracker.ts` still carries the same unfiltered
> 7-stage copy for the PDF stepper. It has **no importer** either at this commit,
> so it is inert — but it is the next place the rule would break, and it is not
> covered by that deletion.

### `issue_category` and `service_category` are two different questions

They are not old and new versions of each other, and reading them that way is
what put free text into a maintained lookup.

| column | question | shape | where it is edited |
|---|---|---|---|
| `issue_category` | WHAT WENT WRONG (damage, defect, wrong item) | one value | intake form on both surfaces; drives the dispatcher breakdown and SLA |
| `service_category` | WHICH PRODUCT it is about (Mattress, Bedframe, Sofa) | **an ARRAY** — one complaint can be a bedframe AND a mattress | chips on the desktop detail + intake, chips on the phone's Product info accordion |

`backend/src/routes/assr.ts` describes the intake form as having "replaced the
older service_category-driven flow". **That is about the INTAKE / dashboard role
only.** `service_category` itself is live and maintained: `assr_product_categories`
(mig 0112) is the admin-editable lookup, `assr_case_categories` is the join table
every count and breakdown reads, and the desktop list still filters on it.

**A hand-typed value is lossy in two ways at once**, which is why the phone's
`type: "text"` binding was a defect and not a style difference.
`resolveCategories` (`backend/src/services/assr.ts`) keeps an unrecognised token
in the flat DISPLAY string but writes it **no row** in the join table. So a typed
"Mattres" becomes its own bucket in desktop's category filter AND leaves the case
uncategorised for every report. Neither failure says anything.

The rule now lives in one place both surfaces import —
`frontend/src/lib/assrProductCategories.ts` (the endpoint constant,
`splitCategories`, `categoryChipList`, `toggleCategory`). The chip MARKUP is
per-surface: `CategoryChips` in `pages/ServiceCases.tsx`,
`frontend/src/mobile/MobileAssrCategoryChips.tsx` on the phone. Both send the
complete ARRAY on every save, because `PATCH /api/assr/:id` rewrites the join
rows from what it is given — a partial list deletes categories nobody deselected.

### Required fields at create

Enforced on **both** halves as of 2026-07-21:

| Field | Frontend gate | Server guard |
|---|---|---|
| `doc_no` (SO) | desktop `ServiceCases.tsx`; mobile `MobileServiceCase.tsx` | `backend/src/routes/assr.ts` → one combined 400 `"doc_no, complaint_issue and issue_category are required"` |
| `complaint_issue` | same | same 400 |
| `issue_category` | same (desktop also requires the custom label when "Other…" is picked) | same 400 — `hasCategory` treats whitespace-only as missing |

### Optional at create, and worth capturing there anyway

| Field | Why it belongs on the intake form |
|---|---|
| `customer_email` | **This is the satisfaction-survey address.** When a case reaches `completed`, `backend/src/routes/assr.ts` resolves the CSAT recipient as `email_for_survey \|\| customer_email`; a case created without either has nobody to send to, and somebody has to go back and fill it in. Desktop has captured it since it was written; the phone did not send the key on any path until 2026-08-21. |
| `ref_no` | the customer's own pre-printed reference. Blank falls back to the SO's `Ref`. |
| `service_category` | the PRODUCT category — see the section below. Optional at intake on the phone (it is set on the detail screen); desktop offers the chips at intake too. |

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

### The SO picker: a refusal used to render as "no results"

*Create Service Case* stays disabled until a Sales Order is linked, so **the SO
picker is the gate on the whole form**. When it finds nothing, the button is grey
and the person is stuck — and until 2026-08-19 the screen could not say why.

`useSoSearch` destructured only `{ data, isFetching }` from its `useQuery` and
returned `data?.results ?? []`. **The error was dropped**, so a refusal rendered
byte-identical to an honest empty answer. That matters because `GET
/api/assr/search-so` can come back empty for three unrelated reasons:

| | cause | fix |
| --- | --- | --- |
| 1 | `requireServiceCaseAccess()` 403s the caller | see the gate note below |
| 2 | the caller does not hold HOUZS, so `assr.ts:1256` skips the AutoCount mirror where a bare `SO-XXXXXX` lives | grant it on the Team screen |
| 3 | the order is not in the mirror, or its `doc_no` is spelled differently | `?since=` backfill — see `docs/modules/system-health.md`. Since 2026-08-28 a migrated/写回 SCM order is also found by its AutoCount number directly (`linked_ac_docno`, SCM arm), so the backfill is only for mirror-only orders |

The hook now returns `error` and the picker renders it **instead of** the
not-found line. `check-silent-mutations` enforces this for `useMutation`, not
`useQuery`, which is how it survived.

**The gate WAS TEXT, and that is the part nobody thought to check — FIXED
2026-08-20.** `canAccessServiceCases` used to admit the `service_cases.read`
holder **or** `isSalesUser` **or** `isDirectorUser`, and `isSalesUser`
(`services/pmsAccess.ts`) tests `position_name` against `/^sales/i` and
`department_name` for the substring "sales". So a real salesperson whose position
or department field was blank, or spelled another way ("Executive Sales" fails
`/^sales/i`), was refused — and their permission list looked perfectly fine.

The middle term is now `holdsHouzsCompanyGrant(c)` — the owner's ruling,
"有 Houzs 这家公司的授权 就好（不看职称）". A company grant is provisioned
deliberately, in one place, by someone who meant to; a job title is free text
nobody re-checks against this gate. The permission and director terms are
unchanged. See §6 *Route admission* and
`docs/SERVICE-CASE-VISIBILITY-DECISION.md`.

**Worked example, 2026-08-19.** A salesperson could not raise a case against
`SO-005263`. Two hypotheses were raised and both were guesses, because the screen
carried nothing that separated them. The read-only diagnostic
(`Actions -> Why can this person not find this SO`) settled it: he held HOUZS,
his position read "Sales Executive" and his department "Sales Department", so the
gate admitted him — the order was simply never collected into the mirror. Cause 3.

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
| GET | `/api/assr/my-cases` | `requireServiceCaseAccess()` `:1447` | Sales-side "my cases" list. Body is `listMyCases` (`services/assrVisibility.ts`) — keyed on WHO RAISED the case since 2026-08-21, see §6 |
| GET | `/api/assr/export.csv`, `/:id/timeline.csv` | `requireServiceCaseAccess()` `:1103`, `:2714` | Exports |
| POST/DELETE | `/:id/track-link`, `/:id/supplier-link`, `/:id/survey-token` | `service_cases.write` `:1765`, `:1842`, `:1890` | Mint / revoke portal tokens |
| PUT | `/:id/attachments`, `/:id/attachments/thumb` | `service_cases.write` `:2881`, `:2928` | R2 upload (+ thumb) |
| GET | `/attachments/:key{.+}` | scope via `caseInCallerScope` `:3212` | Streams the R2 object. Sends `X-Content-Type-Options: nosniff` (PR #2522) so the server-derived content-type cannot be MIME-sniffed into html/svg — parity with `mail-center.ts`'s INLINE_SAFE serve. |
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

1. **Scope** — `assrVisibleUserIds(c)`, keyed off the tier predicate
   `assrUnrestricted`. `undefined` = unrestricted. The ids are turned into a
   WHERE fragment by `assrVisibilityPredicateSql`
   (`services/assrVisibility.ts`) — see §6 *Row visibility*.
   `assrVisibleAgentNames` was removed on 2026-08-20 with the free-text
   `sales_agent` match it fed.
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

**Case-level** — the source of truth is **`assr_priorities.sla_hours`**, the
"SLA hrs" cell managers edit in Service Maintenance -> Priorities.
`slaHoursForPriority(env, slug)` in `services/assrSla.ts` reads it; both SLA
computations in `services/assr.ts` call that. Blank means "use the module default", which is
`slaHoursFor()` over the hardcoded `SLA_HOURS_BY_PRIORITY` — the LAST-RESORT
fallback, not the answer:

| Priority | fallback SLA hours |
|---|---|
| `urgent` | 24 |
| `high` | 72 |
| `normal` (default) | 168 (7 days) |
| `low` | 336 (14 days) |

The fallback is also used when the row is missing, the stored value is not a
positive whole number, or the read throws (wrapped in try/catch, same posture as
`lookupStageTargetDays()`); `slaHoursFor()` defaults anything unknown to 168.
There is deliberately **no `active` predicate** on the read — deactivating a
priority must not swing the SLA of a case that still carries it.

`deadline_at = now + slaHours` at create; changing priority via PATCH recomputes
`deadline_at` off `created_at` unless the request also sets `deadline_at` or
`sla_hours` explicitly. **Editing the cell does NOT recompute deadlines already
on existing cases** — only new cases and priority changes pick it up (mig 065
says the same).

> **Until 2026-08-20 that cell was written and never read.** Both computations
> called `slaHoursFor()` directly, so an edit saved, answered `{ ok: true }` and
> changed nothing; the seeded values equal the constant, so it looked correct
> until somebody edited one. `BUG-HISTORY.md` has the trace, and
> `backend/tests/assrSlaHoursOverride.test.ts` is the guard.
>
> **Adding a priority still does not work**, and that is a different defect left
> open: `assr_cases.priority` carries
> `CHECK (priority IN ('low','normal','high','urgent'))`, so a
> Service-Maintenance-added priority saves and lists but 500s every case create
> that uses it. Widening it needs its own migration.

`sla_hours` writes are validated on both `POST /lookups/priorities` and
`PATCH /lookups/priorities/:id`: a positive whole number, or blank. Anything
else is a 400 rather than a stored value nothing can use.

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

### Company scope: there is NO Houzs pin, and there has not been since 2026-07-20

`assrCompanySql` (`backend/src/routes/assr.ts`) is `allowedCompaniesSql` — it
consults no role. EVERY caller, rank-and-file sales included, is scoped to the
companies they are GRANTED.

It was not always so. Until 2026-07-20 the rule pinned rank-and-file sales to
HOUZS alone; the owner reversed it when 2990 began raising service cases on the
merged platform, and PR #934 deleted `assrPinsToHouzs()` and the
`houzsCompanySql` branch outright.

**What that reversal cost, because it is the reason this section exists.** #934
changed the rule in `assr.ts` and its own test, and missed TWO other places
holding a copy: a private `assrCompanySql` inside `routes/search.ts`, and the
frozen expectation in `tests/searchScope.test.ts`. So global search and
`/api/assr` answered the SAME REP DIFFERENTLY for three weeks — a 2990 rep was
shown HOUZS cases and NOT shown their own — and neither copy looked wrong,
because the stale test asserted the stale copy's behaviour and both agreed.
Both are removed; `search.ts` now imports the one function.

**And it cost a THIRD place, found 2026-08-21 — the Delivery Planning board.**
Its Service-Case rows read `public.assr_cases` through raw `c.env.DB` SQL
(supabase-js helpers cannot reach a `DB.prepare()` string, so the predicate has
to be written by hand) and carried NO company term at all, so a dispatcher
granted one company saw the other's service cases on the board while
`/api/assr` hid them. The owner ruled it out: 「这个也不可以啊」. Fixed the same
way as `search.ts` — `scm/routes/delivery-planning.ts` now imports
`assrCompanySql` and appends it in `assrBoardUnionSql()` (the read) and
`assrOpenCaseGuardSql()` (the schedule write, which 404s an out-of-scope case
exactly as `caseInCallerScope` does). Pinned by
`backend/tests/deliveryBoardAssrScope.test.ts`. **The pattern to take from three
occurrences: if a surface reads `assr_cases`, it imports this function — a
hand-written predicate, however correct today, is the bug.**

The three-state sentinel applies as everywhere else: `undefined` = unresolved
(pre-migration, D1 test mirror, cold start) → no predicate at all; `[]` = the
caller is granted no active company → matches nothing. They are NOT
interchangeable, and collapsing the first into the second is a cross-company
leak while collapsing the second into the first is an empty-list outage.

### Route admission (who gets THROUGH)

Two gates, deliberately different:

- `requireServiceCaseAccess(perms)` wraps `canAccessServiceCases`: pass if the
  caller holds any of the listed permissions **OR** holds **any company grant**
  (`holdsAnyCompanyGrant`) **OR** is a director (`isDirectorUser` =
  `*` / Super Admin / Sales Director / Finance Manager). Applied only to READS
  and to CREATE.

  The middle term was `isSalesUser` — a job-title test — until 2026-08-20.
  It reads `allowedCompanyIds` with the usual three-state sentinel: `undefined`
  (unresolved company context) degrades to YES, exactly as `allowedCompaniesSql`
  degrades to no predicate, so a cold start does not 403 everyone; `[]` (granted
  nothing) is NO; any non-empty resolved set is YES.

  **Known consequence, measured, not guessed.** Census run 32351722894
  (2026-08-20, production): admittance goes 49 -> 77 active users, **+28 gained,
  0 lost**. The 28 are Operation Department staff — Drivers, Warehouse Crew,
  Outsource Transporters — plus HR and an Operation Executive. That is what
  "不看职称" means in this data.

  **That gap is CLOSED, 2026-09-03** — by the second option this paragraph named.
  The middle term is now `holdsAnyCompanyGrant(c)`: holds a company grant at
  all. The ruling replaced a job TITLE with a company GRANT (「不看职称」); the
  HOUZS literal came from the incident being about HOUZS, and it was narrower
  than the rule already recorded in this file's 2026-07-20 trail ("a future 2990
  rep's is {2990}"). `census-service-case-visibility.mjs` §1 had even named the
  stranded cohort in the PR that shipped the literal. Nobody lost access in
  between — the six were each admitted by the permission or director term too —
  so this is prevention, not repair. `holdsHouzsCompanyGrant` STAYS: the
  AutoCount mirror arm still needs the HOUZS-specific question, because
  `sales_orders` holds only HOUZS rows. Trace:
  `docs/bugs/0621-the-company-grant-rule-shipped-with-a-company-literal.md`.

  **Admitting is not showing.** Every read is already scoped by `assrCompanySql`
  → `allowedCompaniesSql`, so a 2990 grantee admitted here sees 2990's cases and
  nothing else.
- `requirePermission("service_cases.<verb>")` — plain, for every write /
  manage / approve route. Owner rule 8 widened intake for Sales; it never
  widened mutation access (comment `:52-65`).

Permission keys in play: `service_cases.read`, `.create`, `.write`, `.manage`,
`.approve`.

### Row visibility (WHICH cases)

`assrUnrestricted(user)` — `*`, or `service_cases.manage`, or a director — sees
everything, and **must not be narrowed**: office staff work a case on a
salesperson's behalf ("要不然 office 的帮不到 sales 处理东西了", owner
2026-08-20). Everyone else is narrowed to their reporting subtree by
`assrVisibleUserIds` (`subtreeUserIds`, full depth), which fails **closed** (`[]`)
when the caller has no resolvable identity. Scoped callers additionally lose
creditor fields (`stripCreditorFields`).

**What the subtree is matched ON changed on 2026-08-20**, and this is the whole
rule now — `assrVisibilityPredicateSql` in
`backend/src/services/assrVisibility.ts`:

| source of the case's SO | who may see it |
|---|---|
| ERP-native — `doc_no` resolves to a non-DRAFT, non-CANCELLED `scm."mfg_sales_orders"` row | `created_by` / `assigned_to` / `assigned_to_2` in the subtree, **or** the order's `salesperson_id` -> `scm.staff.user_id` (mig 0066) in the subtree. BY ID. |
| AutoCount `sales_orders` mirror, or no resolvable SO | whoever the COMPANY predicate admits. No agent test at all. |

The asymmetry is about DATA QUALITY, not trust: "AutoCount 那一边，它的 SysAgent
可能也不准吧". The old rule OR-ed
`LOWER(sales_agent) LIKE '%<subtree member name>%'` — a substring match over text
mirrored from AutoCount — which is what silently removed a batch of Sales Agents
from their own cases. `assrVisibleAgentNames` is **gone**; `subtreeAgentNames`
(`services/orgScope.ts`) stays, because `/my-cases` still uses it (below).

**One predicate, four readers.** `pushVisibilityScope` (list + CSV export),
`assrVisibilitySql` (the five aggregate endpoints), `assrCaseRowInScope` (detail
GET + printable) and `caseInCallerScope` (the mutating `/:id` guard) all resolve
through that one string — `assrCaseRowInScope` by asking the database with it
rather than restating it in TypeScript. The two SQL twins and the two TS copies
that existed before are the drift `fix/assr-aggregate-scope` had to close once
already. `backend/tests/assrVisibilityRule.test.ts` scans the reader files and
fails if the id clause reappears in any of them.

**How much this widened, measured.** Census run 32351722894 (2026-08-20,
production): of 859 non-archived cases, **7** are ERP-sourced and **852** are
AutoCount-sourced — so in practice almost the whole case book is now
company-open. All 60 visibility-scoped users gain cases; **36 go from ZERO
visible cases to some** (the reported outage); 45,168 user-case grants added, 0
lost.

**ASSUMPTION AWAITING THE OWNER — "own" keys off the SO's SALESPERSON, not the
case's CREATOR.** `docs/SERVICE-CASE-VISIBILITY-DECISION.md` leaves this open in
so many words: *"for an ERP order does 'own' key off the SO's salesperson or the
case's creator? Ask before choosing - they differ whenever office raises a case
on a salesperson's behalf."* The shipped rule takes the SALESPERSON, because that
is the binding the same paragraph calls real, and because the creator is already
covered by the separate `created_by` term — so office raising a case on a rep's
behalf leaves the case visible to office (unrestricted tier) AND to the rep and
their upline (salesperson term), which is the outcome the tier exists to allow.
If the owner rules the other way, the change is to drop the `es.user_id` arm from
`assrVisibilityPredicateSql` and rely on `created_by` alone. It affects 7 cases
today (census run 32351722894).

**`/my-cases` answers a different question — "cases that are MINE" — and since
2026-08-21 it keys on WHO RAISED the case.** Owner ruling: 「如果是他开的 就算不是
他as agent它也可以看啊 … 那就是他submit就代表他认领这个case了啊」 — a case a person
opened is theirs whether or not the order names them as agent. The reasoning is
the same one that opened AutoCount-sourced cases to everyone above: AutoCount's
agent data is unreliable, so anyone may raise a case on those orders — and once
anyone may raise it, **submitting is claiming**.

THE RULE is `myCasesPredicateSql` (`services/assrVisibility.ts`), two arms
OR-ed:

| arm | what it reaches |
|---|---|
| `created_by IN (subtree ids)` | the ruling. Self + full downline BY ID — the pyramid rule stands, and nothing depends on how a name is typed. |
| `LOWER(COALESCE(sales_agent,'')) LIKE '%<subtree display name>%'` | the LEGACY reach, KEPT. |

**The name arm is unioned, never replaced, and that is a measurement.** Census
run **32463589829** (2026-08-21, production, §6): 862 non-archived cases, **856**
carry a `created_by`, only **5** have none — but **1,113 user→case pairs across
28 users are reachable ONLY by the agent text**. Almost all of them are office
staff raising a case on a rep's behalf (`created_by` = the office user,
`sales_agent` = the rep); replacing the arm would have taken those cases out of
those reps' lists. The creator arm ADDS 2,359 pairs across 20 users, and **824**
cases were raised by someone the agent text does not name — the cohort the ruling
makes visible. Company split 854 HOUZS / 8 2990.

The name match is exactly as brittle as it ever was. That is what the creator arm
is for: every case raised in the ERP from here on is keyed by id and cannot be
lost to a rename. The name arm only has to keep reaching what is already there.
`subtreeAgentNames` (`services/orgScope.ts`) therefore stays; it now delegates to
`agentNamesForUserIds` so `listMyCases` can take the ids and the names off ONE
subtree expansion instead of running the manager_id walk twice per request.

Note the two lists still answer differently by design: the main list admits an
AutoCount case to anyone the company predicate allows, while My Cases admits only
what you raised or are named on. A rep can still see a case in the main list that
is not under My Cases — that is the difference between "may I see it" and "is it
mine".

**The FRONTEND gate is now NARROWER than the backend**, deliberately and
temporarily. `PageGuard allowSales` still asks `org.sales.staff`
(= `isSalesUser`), so a HOUZS grantee who is not Sales-titled needs the
`service_cases` page grant to reach the screen even though the API would answer
them. It is not a regression — that person could not open the page before either
— and it cannot be closed by OR-ing two capabilities on the client, which
`frontend/src/auth/capabilities.ts` forbids by name. The composed capability has
to be resolved on the server, and `/auth/me` is registered BEFORE the
`companyContext` middleware, so it has no company grant to read. Closing it means
resolving the grant inside `/auth/me`.

Company scope is orthogonal: every reader filters on `allowedCompanyIds`
(`assrCompanySql` `:109`, `assrCompanyIds` `:115`), every creator stamps
`assrCreateCompanyId` (`:124`), and an SO-attached case inherits the SO's own
company (`createAssrCase`).

**The PRINTABLE route was the exception, until 2026-08-13.**
`backend/src/routes/assr_print.ts` GET `/:id` was guarded by
`requirePermission("service_cases.read")` and nothing else, while
`getAssrDetail`'s SQL is `WHERE c.id = ?` with no company predicate at all — so
it rendered ANY company's service case, as a document with letterhead, to anyone
holding the read permission. **A permission says what you may do, never whose.**
PR #2086 applied `allowedCompanyIds(c)` there with the same semantics the JSON
detail route documents, and the distinction matters: an **UNRESOLVED** scope
(`undefined` — pre-migration / the D1 test mirror) skips the check, while an
**EMPTY** scope means the caller is granted no active company and every
company-stamped case must 404. Those two used to share `[]`, and the merged state
failed open. Out-of-scope answers 404, indistinguishable from a missing id. See
BUG-HISTORY, *"The writes the read-hardening audit left"*.

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
| `assrCaseRowInScope(c, caseRow)` | may this caller see this case at all? The id terms are checked in memory, then the rest is asked of the database using `assrVisibilityPredicateSql` — the SAME string the list builds its WHERE from, never a second copy. `true` for an unrestricted caller; fails CLOSED if the query throws. |
| `assrCallerIsScoped(c)` | is this caller visibility-restricted, i.e. must not see supplier identity? |
| `stripCreditorFields(row)` | removes the creditor columns, both naming conventions. |

If you add a third surface that renders a case, it calls these. A rule enforced
on one of two routes that emit the same content is not enforced.

### Frontend gates

| Surface | What it checks | File |
|---|---|---|
| Desktop routes `/assr`, `/assr/:id`, `/my-cases`, `/my-cases/:id` | `PageGuard page="service_cases" allowSales` | `App.tsx:369, 386, 402, 410` |
| `PageGuard`'s `allowSales` | the **server's** answer — `capability(user, "org.sales.staff")` = `pmsAccess.isSalesUser`. **No longer the same classifier the API admits on**: `requireServiceCaseAccess` moved to the HOUZS company grant on 2026-08-20 and this term did not follow. See §6 *Row visibility*, last paragraph, for why and what closing it takes. | `frontend/src/auth/PageGuard.tsx`, `backend/src/services/capabilities.ts` |
| Mobile Service tab admission | shell nav gate `allowed("/assr")` | `frontend/src/mobile/MobileApp.tsx` |
| **Mobile case DETAIL, non-director Sales rep** | `isSalesNonDirector(user)` — the SAME predicate the desktop route redirects on, imported not re-derived. A rep opens `MobileMyCaseDetail` (read-only + comment/nudge); everyone else opens the editable `CaseDetail`. The LIST and the create sheet are unaffected. | `frontend/src/mobile/MobileServiceCase.tsx`, `frontend/src/mobile/MobileMyCaseDetail.tsx` |
| Mobile list query `enabled` | `can("service_cases.read") \|\| capability(user, "org.sales.staff") \|\| capability(user, "org.director")` — `canViewCases` | `frontend/src/mobile/MobileServiceCase.tsx` |

> **The ruling had ONE enforcement point for 13 months, and it was desktop.**
> Owner 2026-07-23: 「sales agent 不应该有 edit case 功能」. `App.tsx` redirected;
> mobile mounted the FULL editable detail, and `isSalesNonDirector` had exactly
> one mobile call site in the tree (`MobilePMS`, unrelated). Closed 2026-08-21 —
> `docs/bugs/0483-a-sales-rep-could-not-edit-a-case-on-desktop-and-got-a-scree.md`.
>
> **The backend has never enforced it, and that is not the gap it looks like.**
> Every write route is `requirePermission("service_cases.write")`, which knows
> nothing about the Sales cohort. So what was live was decided by the permission
> MATRIX, and it was read rather than assumed
> (`backend/scripts/census-service-case-visibility.mjs` §5, run 32395787958):
> **32 active non-director Sales staff, all on the role `Sales Person`, and
> `service_cases.write` held by ZERO of them.** No rep could ever have edited a
> case from the phone — the buttons all 403'd. The ruling IS enforced, by the
> grant. **Do not "fix" this by changing a permission**: the grant already
> implements the owner's rule, and changing one is his call.
>
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
| Stage pipeline, supplier-only rule, sub-statuses | `pages/ServiceCases.tsx` (`DETAIL_STAGES`, `getActiveStages`) | `mobile/MobileServiceCase.tsx` (`STAGES`, `activeMStages`, `PHASE_DEFS`) | **`vendor/scm/lib/assr/stages.ts`** — put the rule HERE; both surfaces already import it |
| Stage LABELS (what any reader sees for a stage) | `pages/ServiceCases.tsx`, `pages/MyCases.tsx`, `portal/pages/PortalSupplierCase.tsx` | `mobile/MobileServiceCase.tsx` (`prettyStage`) | **`vendor/scm/lib/assr-stage-labels.ts`** and its byte-identical backend twin — the words had five hand-written homes and the customer-facing one printed a raw slug |
| Intake required fields | `ServiceCases.tsx:2857-2872` (disabled gate) + `:2425-2467` (submit) | `MobileServiceCase.tsx:1921` (`valid`) + `:1858-1890` (payload) | server guard `backend/src/routes/assr.ts:1548-1566` — change this FIRST |
| Enum option lists (priority / issue category / resolution / verification / QC) | `ServiceCases.tsx` lookups | `MobileServiceCase.tsx` hardcoded fallbacks + `useLookupNames`/`useLookupSlugs` | `/api/assr/lookups/:kind` is the source; the constants are only a pre-fetch fallback |
| **Note audience + issue-category fallback** | `ServiceCases.tsx` (add-note form, create panel) | `MobileServiceCase.tsx` (Timeline picker, NoteSheet, intake sheet) | **`vendor/scm/lib/assr/case-fields.ts`** — `ASSR_NOTE_AUDIENCES`, `assrNoteIsCustomerVisible()`, `ASSR_ISSUE_CATEGORIES` |
| Patchable fields | `InlineEdit` sites in `ServiceCases.tsx` | `EditableAcc` field list in `MobileServiceCase.tsx` | `PATCH_FIELDS` `backend/src/services/assr.ts:785-830` |
| Product category (`service_category`) | `CategoryChips` in `pages/ServiceCases.tsx` | `mobile/MobileAssrCategoryChips.tsx`, wired as the `chips` field type in `EditableAcc` | **`frontend/src/lib/assrProductCategories.ts`** — the endpoint, the split, which chips exist, what a toggle produces. Markup only is per-surface |
| Survey address (`customer_email`) | intake form + Customer panel in `pages/ServiceCases.tsx` | intake sheet + Customer accordion in `mobile/MobileServiceCase.tsx` | `email_for_survey \|\| customer_email` in `backend/src/routes/assr.ts` decides who the CSAT mail goes to |
| Row readers / formatters on the phone | — | **`frontend/src/mobile/assr-case-fields.ts`** — `get`, `caseNo`, `slaText`, `prettyStage`. Extracted from the screen so it stays under its size ceiling AND so they are testable | — |
| SO typeahead on the phone | `CreatePanel` in `pages/ServiceCases.tsx` | **`frontend/src/mobile/MobileAssrSoField.tsx`** — `useSoSearch` + `SoSearchField`, used by both the create sheet and the detail | `GET /api/assr/search-so` |
| Attachment upload / thumbs | `ServiceCases.tsx:2472-2498` | `MobileServiceCase.tsx:1890-1905` | `lib/assrAttachmentUpload.ts`, `lib/imagePipeline.ts` |
| Access gating | `App.tsx` `PageGuard` | `MobileApp.tsx` nav gate + `MobileServiceCase.tsx` | backend capabilities (`services/capabilities.ts`) |
| **The 2026-07-23 rule: a Sales rep may not EDIT a case** | `App.tsx` `SalesRepCaseDetailRoute` redirects `/assr/:id` -> `/my-cases/:id` | `MobileServiceCase.tsx` opens `MobileMyCaseDetail` instead of `CaseDetail` | **`auth/salesAccess.isSalesNonDirector`** — one predicate, imported by both. Pinned on BOTH surfaces by `auth/permissionDivergence.test.ts` |

The history is not hypothetical: `stages.ts:1-16` exists because mobile once
ignored the internal-resolution skip and mis-routed cases into the two
supplier-only stages with the wrong progress denominator.

Nor is the row above it. The two note-audience copies had ALREADY come apart by
the time anyone compared them: desktop offered "Customer-visible", mobile offered
"Customer" — and `customer` is the only bucket the portal shows a customer, so
the phone's label named the bucket while the desktop's named the consequence.
One home now, on the explicit wording; the mobile chips wrap 2x2 because
`.sochip` is `white-space: nowrap` and the longer labels overflow a 375px row
(measured, `docs/bugs/0482-two-assr-field-lists-were-written-twice-and-the-note-audienc.md`).

---

## Related

- `docs/CODEBASE-MAP.md` §5.3 — the full ASSR + portal endpoint inventory.
- `docs/generated/route-capability-matrix.csv` — machine-generated gate per route.
- `docs/SERVICE_MODULE_TEST_GUIDE.md` — manual test walkthrough.
- `docs/modules/delivery-tms.md` — service cases with a `customer_pickup_at`,
  `do_date` or own-team `inspection_visit_at` also surface as fleet jobs on the
  delivery board.
- `BUG-HISTORY.md` — read the Service Case entries before touching this module.

## The pre-auth intake endpoints are scoped to their SECRET's company (2026-08-18)

`GET /api/assr-form-intake/status-export` and `POST /api/assr-form-intake/delivery-dates`
are pre-auth by design — Google's servers call them, there is no session and no
`X-Company-Id`, so `companyContext` never runs. That is why neither could be
given a caller's predicate, and why both ran unscoped across BOTH companies: the
export returned `customer_name`, `phone`, `addr1-4` and `complaint_issue` for
every non-archived case, and `/delivery-dates` resolved a case by `assr_no` —
which is not unique across companies — and UPDATEd it.

The rule now: **each shared secret carries its own company.** `FORM_INTAKE_KEY`
and `SHEET_SYNC_KEY` are both Houzs Century artifacts (the staff service-request
form and the HC Delivery sheet), so both map to `HOUZS` in
`INTAKE_KEY_COMPANY` (`backend/src/routes/assrFormIntake.ts`). A future 2990
sheet gets its OWN key and its own row there; it must never be handed one of
these two. A readable companies master with no row for the code is a
MISCONFIGURATION and answers 503 — it does not fall back to "no predicate".

## `/so-export` feeds the sheet 2990's ready-to-ship orders (2026-08-26)

Houzs orders reach the HC Delivery sheet's **Delivery Details** tab through the
AutoCount pull (`GetAutoCountData.gs`). 2990's orders are born in the ERP's own
SCM module and never touch AutoCount, so dispatch had been hand-typing them —
19 rows, every AutoCount-fed column blank, 11 of them already past the
customer's date with no DO raised. `GET /api/assr-form-intake/so-export` closes
that gap.

**Trigger** — the header status `recomputeSoStockAllocation` already derives:
`READY_TO_SHIP`, i.e. every MAIN line (SOFA / BEDFRAME / MATTRESS) allocated.
Accessories never block a delivery, so a main-ready order exports with
`stock_remark` reading `READY (PARTIAL)` — the operator's Remarks-2 wording.

**It is the FIRST 2990 intake secret.** Per the rule above, `FORM_INTAKE_KEY`
and `SHEET_SYNC_KEY` speak for HOUZS and must never open 2990 data — and this
export carries 2990 customers' names, phones and addresses. So `/so-export`
accepts **`SHEET_SYNC_KEY_2990` and nothing else**, resolves the company id from
the master under code `2990`, and refuses (503 `company_unresolved`) when the
master cannot answer. It does NOT inherit the ASSR exports' "degrade to no
predicate" branch: an unscoped read here would BE the Houzs export.

**Full state, no cursor.** The sheet appends only the `Doc. No.`s it lacks, so
re-sending an order it already carries is a no-op and a missed sweep heals on
the next one. The two follow-up reads (order lines, `scm.staff`) bind their
errors and refuse the whole export: a swallowed line-read reads as "no lines",
and `summariseReadiness([])` would then write a BLANK Remarks 2 and call the
order ready.

**Balance comes from the VIEW.** `mfg_sales_orders.balance_sen` is a stored
column nothing maintains — it still equals `local_total` on orders paid in full
months ago — so the first cut wrote "everything outstanding" into the sheet.
The export reads `mfg_sales_orders_with_payment_totals.balance_sen_live`, the
same figure the SO list shows. **PO No.** is not a header column either: it is
collected through SO line → `purchase_order_items.so_item_id` →
`purchase_orders.po_number`, comma-joined when an order has several, cancelled
POs dropped.

Column map lives in the handler's header comment. Two traps recorded there:
the tab's frozen-column freezebar renders as an extra cell, so counting cells
by eye shifts every letter from G on by one; and `Sales Exemption Expiry Date`
deliberately carries `customer_delivery_date` — that field is NULL on all 126
SCM orders, so the column was free and dispatch reads the requested date there.
