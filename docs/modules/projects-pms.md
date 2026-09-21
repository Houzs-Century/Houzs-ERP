# Projects / PMS

The exhibitions-and-events ERP module: project list, calendar, venues, the
checklist/tasklist workflow, project finance (P&L), and the hard link from a
Sales Order back to the fair it was written at. Used by sales reps/directors,
ops/logistics, field crew (drivers, helpers, storekeepers), purchasers, and —
via public no-login share links — outside contractors and brand partners.

## Statuses and flow

- A project carries `stage`, `status`, and `archived_at`. Archiving withholds
  only the status dropdown control; every other action keeps its normal
  permission terms (do not gate other controls on `!archived`).
- Checklist items carry `status` and `review_status` (pending / pending
  review / rejected, etc.), gated per item by `required_perm` and/or
  `role_label`. Uploading to a gated, not-yet-in-review item auto-flips it to
  `pending_review` on either surface.
- Defect photo review is a two-stage, append-only action timeline per
  attachment: `done | replace` (legacy `ongoing` reads as fresh). Stage 1
  reviewer (region-split: Ops Exec for Pulau Pinang/Kelantan/Terengganu/Perak,
  else the Storekeeper Supervisor by position name) sets `replace` to
  escalate; Stage 2 (Purchaser) closes with `done`.
- Stock transfers (`project_stock_transfers`) mirror into one checklist row
  per transfer (`notes = auto:stock_transfer=<id>`); confirm/unconfirm/delete
  re-sync or drop that row. A missing `transferred_at` defaults to today
  (MYT) at creation; existing NULL rows are left as-is.
- Venue on a Sales Order carries `venue_source`: `PMS | SHOWROOM | MANUAL |
  NULL`. Once `MANUAL` (a human edited it), automatic re-resolution never
  overwrites it.
- `scm.mfg_sales_orders.project_id` links an SO to the fair it was written
  at; nullable, no FK (cross-schema), resolved non-fatally at SO create time
  and never blocks a sale on failure.

## Permissions

Access is layered on **four independent axes** — do not conflate them:

1. **Page entry**, by POSITION, resolved in code by
   `backend/src/services/positionPolicy.ts` (keyed on position + department
   name, NOT the permission-matrix tables, which still exist but no longer
   resolve access for a positioned user). Default is **full access**; only
   Driver, Helper, Storekeeper, Storekeeper Supervisor, Calendar Viewer and
   the four Sales tiers are restricted — an unclassified position falls to
   FULL, never to none (anti-lockout). Enforced by `requirePageAccess`
   (`backend/src/middleware/auth.ts`; ranks `full=3, edit=2, view=1,
   partial=1, none=0`, default `minLevel="partial"`), mirrored by
   `frontend/src/auth/PageGuard.tsx`. A page-access level, even `edit`,
   **grants no write** on its own — nearly every route gated by it is a GET;
   the one exception is `POST /:id/read`.
2. **Row visibility** is COMPANY scope only. The former PIC/brand row-level
   ACL (`services/projectAcl.ts`) was **removed 2026-08-19** — within their
   active company, any non-crew user with projects page access now sees
   every project, regardless of PIC or brand.
3. **Write authority** is the flat role permission matrix
   (`backend/src/services/permissions.ts`): `projects.read`, `.chat`,
   `.checklist.tick`, `.write`, `.approve`, `.manage`, plus
   `stock_transfer.approve`, `agreement.approve`, `projects.finance.view`,
   `stock_in.approve`. A bare `*` does **not** confer the four
   `EXPLICIT_APPROVAL_KEYS` (`projects.approve`, `stock_transfer.approve`,
   `agreement.approve`, and the stock-in equivalent) — those gate checklist
   tick/status/review explicitly.
4. **Within a visible project**, `backend/src/services/pmsAccess.ts`
   (`getPmsRole` / `getPmsAccess`) strips sections (e.g. FINANCIAL) by PMS
   role. `DIRECTOR_POSITION_NAMES` = `{Super Admin, Sales Director, Finance
   Manager}` + `*`, matched on **exact** normalised name (not a substring
   regex, to stop a rename silently granting director access). The frontend
   mirror is `frontend/src/auth/salesAccess.ts` and must stay in lockstep
   (test-pinned).

Crew scoping is a separate, additional filter on top of all of this:
`CREW_SCOPED_POSITIONS` = `{Helper, Storekeeper}` forces `assigned_to_me` on
the project list; Driver is crew-scoped on the **calendar only**, not the
list. Holding `projects.write` escapes crew scoping entirely on both.

## Rules that must not break

- Venue resolution (`backend/src/scm/lib/venue-binding.ts`) has exactly
  three outcomes in order — PIC/attending PMS project whose period contains
  the order date, then showroom parking, then **nothing** — never a company
  default or first-venue guess; an unresolved venue must stay blank/unset,
  not invented, because it drives commission and exhibition P&L.
- A `MANUAL` `venue_source` (a human-edited venue) must never be silently
  overwritten by an automatic re-resolve.
- Money/finance fields on the project list are stripped **server-side**
  (`financeHiddenForUser`) before the response is built, for any caller who
  is not a finance viewer — never hidden only in the UI.
- The P&L total query and its drill-down keep **separate copies** of the
  same filter fragment (`projectCostFrom`/`serviceCostFrom`); a filter added
  to one and not the other makes a drilled total disagree with its card.
- Cost-line company scope is the line's **project's** `company_id`, not the
  denormalised `project_finance_lines.company_id` copy (not reliably
  stamped) — filtering on the copy silently drops legitimate cost lines.
- `rawProjectCost` (P&L) must JOIN `projects` and require `archived_at IS
  NULL`, or an archived project's cost keeps reporting forever.
- Every project child table addressed directly by its own id (checklist
  item, finance line, attachment, defect, team row, stock transfer, etc.,
  with no `project_id` in the URL) must be scoped through
  `backend/src/routes/lib/project-company-gate.ts`
  (`refuseForeignChild`/`refuseForeignProject`, both answer 404) — do not
  assume "children are always reached through their parent."
- Venue, checklist-template and their child masters are per-company
  (`company_id` / `activeCompanySql`); creates must resolve the active
  company and refuse (`company_unresolved`, 409) rather than fall through to
  a column default that silently mis-assigns the row to the wrong company.
- A known venue-name alias must be added in **four places together**: the
  canonical-venue TS module, its PG migration function, the D1 parity file,
  and the backfill script — a DB trigger also re-applies it on any direct
  write, so a route bypass cannot reintroduce the alias.
- Checklist-tick UI controls must gate on the **role-label badge**
  (`roleLabelAdmits`, shared by desktop and mobile), not on `projects.write`
  alone — a `projects.checklist.tick`-only holder (e.g. Purchaser) is
  restricted to tasks whose `role_label` admits their role.
- Whoever may attach a file to a task may also remove it — file-delete
  permission must mirror attach permission on every surface (desktop
  `TaskAttachmentRow`/`ChecklistRow`, and all three mobile gates).
- Public contractor/brand share links must re-derive their scope from the
  **token row** on every query (never trust a client-supplied flag), return
  only whitelisted columns, and respect the `revoked_at` kill switch; which
  floorplan task and whether money is exposed is decided by the route, not
  by a request parameter.
- The Fair/Sales Report is gated **per stage** (`so|do|invoice|pnl`):
  ordinary salespeople see none; Sales Director sees `so` only; "management"
  (a finance viewer who is not a Sales Director, or any
  `projects.finance.view` holder) sees all four stages.
- Shared PMS vocabularies (`pms-ledger-categories.ts`,
  `pms-reviewable-titles.ts`, `pms-project-status.ts`,
  `venue-binding.ts`) must stay the single source for their value↔label
  contract across desktop and mobile — each surface may keep its own visual
  styling, but never a second copy of the values/labels/matching rule.
- The in-project Sales Order panel (`Sales.tsx` `EntryPanel`, opened from
  `Projects.tsx` `ProjectSalesEntriesSection`) labels its Project field through
  `pages/projects/soloOrganizerMask.ts`: a **solo** event's organizer (the mall
  management) reads `SOLO` and the code is dropped, for everyone except
  `salesAccess.canSeeSoloOrganizer` (BD role, Owner position, weisiang). An
  exhibition's organizer shows to everybody. Display-only — the stored name,
  the list, the calendar and the API still carry the organizer.

## Gotchas

- Do not reintroduce PIC- or brand-based row filtering — that ACL
  (`projectAcl.ts`) was deliberately deleted 2026-08-19; row visibility is
  company scope plus crew scoping only.
- Do not read `projects.read` as "can view the Projects tab" — it actually
  gates `/api/finance/pnl`, inbox filtering and the phase-photo read; the
  tab itself is gated by the page-access key `projects.list`.
- Do not treat `stock_transfer.approve` as functional — it has no live
  reference. `agreement.approve` is live (grants WF_SENSITIVE section
  visibility); do not assume the two behave the same way.
- Do not grant `projects.write` to a crew position casually — it silently
  escapes that user's crew scoping on both the list and the calendar.
- Do not key the defect-review reviewer on anything but the Storekeeper
  Supervisor **position name** (plus the Ops Exec role for the four
  region-split states) — reassigning that person to a different position
  silently strips their reviewer access everywhere.
- Do not AND `!archived` into a mobile action gate — only the status
  dropdown should be disabled on an archived project; every other control
  keeps its normal permission check.
- Do not add a new director/staffing "My Pending" lane without the
  `CONTRACT_CLEAR` gate (project's CONTRACT section has no open item), or
  every far-future imported event floods that queue.
- Do not hand-roll a second copy of a shared PMS vocabulary or matching rule
  per surface — four such drifts (category labels, reviewable-title
  matching, status/payment-pill labels) have already shipped visible
  mismatches between desktop and mobile before being unified.
- Do not assume `getProjectDetail` is cheap — it issues roughly 16 fully
  sequential queries with no `Promise.all`; this is the module's largest
  backend hotspot and is not yet on the perf-plan tracker.

## Where the code is

- Desktop: `frontend/src/pages/Projects.tsx` (all PMS views except
  maintenance — 12k+ lines, grep to the symbol you need rather than reading
  it whole), `frontend/src/pages/ProjectMaintenance.tsx` (masters),
  `frontend/src/components/ProjectChat.tsx`, `ProjectGantt.tsx`,
  `PnlCalendar.tsx`. Public share pages: `frontend/src/pages/
  ContractorCalendar.tsx`, `ShareCalendar.tsx`.
- PMS agent pages: `frontend/src/pages/SetupInvoiceFill.tsx`,
  `ScheduleReconcile.tsx`, `FairReportFill.tsx`,
  `frontend/src/pages/scm-v2/FairReport.tsx`.
- Mobile: `frontend/src/mobile/MobilePMS.tsx` (list, detail, checklist, crew,
  photos, defects — single file, no separate detail file), `MobileCalendar.tsx`,
  `MobileFairReport.tsx`, `MobilePmsDefectActions.tsx`,
  `MobilePmsFloorPlanTiles.ts`, `MobileEditProjectSheet.tsx` (the detail-header
  Edit control — name/booth/venue/organizer/start/end on one sheet, gated by
  `canWrite && access.canEdit`, saved through the same project PATCH).
- Backend routes: `backend/src/routes/projects.ts` (~90 routes — see
  `docs/generated/route-capability-matrix.csv` for the full inventory),
  `projects_print.ts`, `finance.ts`, `notifications.ts`,
  `publicContractorCalendar.ts`, `publicBrandCalendar.ts`, `brandShare.ts`,
  `backend/src/scm/routes/reports.ts` (Fair/Sales Report).
- Backend services: `backend/src/services/projects.ts`, `auth.ts`,
  `positionPolicy.ts`, `pmsAccess.ts`, `projectGates.ts`, `contractorShare.ts`,
  `brandShare.ts`, `shareCalendar.ts`, `permissions.ts`,
  `agents/fair-report-parse.ts`, `agents/schedule-reconcile.ts`.
- Backend libs: `backend/src/scm/lib/venue-binding.ts`, `canonical-venue.ts`,
  `canonical-state.ts`, `fair-report.ts`,
  `backend/src/routes/lib/project-company-gate.ts`.
- Shared frontend vocab/auth: `frontend/src/auth/salesAccess.ts`,
  `PageGuard.tsx`, `roleLabelAdmits.ts`, `crewScope.ts`,
  `frontend/src/vendor/scm/lib/pms-ledger-categories.ts`,
  `pms-reviewable-titles.ts`, `pms-project-status.ts`.
