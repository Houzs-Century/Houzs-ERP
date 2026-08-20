# User Management — module guide

How staff access is controlled in Houzs ERP. Deployed to prod 2026-06-13.
Companion docs: [PERMISSION-MATRIX.md](PERMISSION-MATRIX.md) (the agreed grid),
[archive/DEPLOY-USER-MGMT.md](archive/DEPLOY-USER-MGMT.md) (the one-shot deploy
runbook, archived — it targets the long-merged `migrate/d1-to-supabase` branch;
the live release path is [STAGING-RELEASES.md](STAGING-RELEASES.md)).

## The model: two orthogonal dimensions
A user has both a **role** and a **position**:
- **Role** (`roles` table, flat permission verbs like `projects.read`, `*` for Owner/IT)
  — decides what ACTIONS a user can perform (write/manage gates via `requirePermission`).
- **Position** (`positions` table = department × job, e.g. SALES/Sales Executive)
  — decides which PAGES a user can see, via a 4-level matrix.

Departments are the 3 canonical ones: **HQ / SALES / OPERATION**. Positions belong to a
department; the 17 seeded positions are in PERMISSION-MATRIX.md.

## Page-access matrix (`position_page_access`)
Per (position × page) one of **none / view / edit / full** (`pageAccess.ts AccessLevel`).
- The legacy ROLE matrix (`role_page_access`, mig 073) stays 3-level (none/partial/full);
  `partial` is ranked equal to `view`, so both coexist with no data migration.
- **Inherit model** (`loadPageAccessForPosition`): a sub-page inherits its parent's level
  unless it has its own row. So grant a whole area with one parent row
  (`projects = view`) and override a sub-page (`projects.finances = none`); or grant a
  single tab (`projects = none` + `projects.calendar = view`).

## How a login resolves access (`auth.ts hydrateAuthUser`)
`page_access = `
- `*` wildcard role → everything full; else
- has a position → `loadPageAccessForPosition(position_id)`; else
- no position (un-migrated user) → `loadPageAccessForRole(role_id)` (fallback, keeps
  existing users working during rollout).

The resolved `page_access` map is attached to the session user (KV-cached 60s).

## Enforcement — no "乱跳" (no jumping into pages you shouldn't see)
- **Frontend**: every data-page route is wrapped in `<PageGuard page="…">` (App.tsx); a
  denied page renders `<Forbidden>` inline (URL preserved, no redirect loop). The Sidebar
  hides nav items via each item's `pageAccess` key. So a position only ever sees + reaches
  its own pages.
- **Backend**: `requirePageAccess("…")` middleware on routes reads the same `page_access`.

## Project detail (PMS) section gating (`pmsAccess.ts`)
On top of page access, the project-detail view shows different SECTIONS per PMS role
(Director / Sales-PIC / Sales / Logistic / Purchasing / Driver / Other). The **financial
snapshot + rental are stripped SERVER-SIDE** (`projects.ts GET /:id` sets `finance:null`)
for any position whose role isn't FINANCIAL — never just hidden in the UI. Gated on
`position_id` so un-migrated users keep legacy access.

## Project visibility (PIC/brand ACL REMOVED 2026-08-19)
The project row-level ACL — PIC one-hop + brand allow-list + a 30-day grace window
(`services/projectAcl.ts` [gone]) — was REMOVED by owner decision. Within a company, any
user with the projects page permission now sees EVERY one of that company's projects;
visibility is governed only by the page-access gate and company scope. Crew scoping
(helpers/storekeepers/drivers → their crewed events) is a separate axis and stays. See
`docs/modules/projects-pms.md` Axis 2. (`projects.pic_id` is still a per-project assignment
field, just no longer a visibility filter.)

## Invite flow
`POST /api/users/invite` carries **email, name, role, department, position, manager**. The
placeholder user is created with those org fields; accept-invite activates it. Frontend:
User Management → Members → "Invite Member" (Department → Position auto-scoped → Reports-to).

**Two credentials, not one.** `password` is the DESKTOP/mobile credential (email + password;
leave blank to send an invite link instead). `pos_pin` is the TABLET credential — the POS has
no password field at all, you pick your name and type 6 digits. A member created without a PIN
therefore has no way into the POS until an admin uses Members → Set PIN. The invite panel shows
the POS PIN field only when the picked position's slug starts with `sales`, and the backend
**refuses** a PIN for any other position: `/api/pos/pin-login` rejects non-sales slugs, so a PIN
stored elsewhere is a credential that can never sign in. The response carries `pos_pin_set` when
a PIN was sent — `false` means the member exists but has no `scm.staff` row yet, and the UI says
so rather than letting them discover it at the tablet. `services/posPin.ts` is the single writer
for `scm.pos_pins` (invite + Members → Set PIN both go through it).

Mobile's generic Members form (`MobileModuleList.tsx FORM_MEMBERS`) carries neither password nor
PIN — it is a schema-driven fallback with no conditional fields. Credential provisioning is a
desktop surface.

## Managing it in the UI
- **User Management → Members**: Position column (inline edit), filter by Department/Position.
- **User Management → Positions**: pick a position → set each page none/view/edit/full → Save
  (`Positions.tsx`, writes `/api/positions/:id/page-access`).
- **Org Chart** tab: reporting lines (manager_id).

## Test accounts (seeded)
One ACTIVE account per position, password `houzs1234`, emails `<slug>@example.my`
(`super_admin@…`, `sales_director@…`, `purchasing@…`, etc.). Driver/Helper route to the
driver mobile portal. Remove with `seed-user-management.mjs --remove-tests`.

## POS role (2990 tablet) — derived from the position
The 2990 POS gates its own behaviour (view-all sales, Quick-Pick curation,
passcode login) on the `role` field of the caller's GET /api/scm/staff row — the
2990 role vocabulary, NOT the Houzs page matrix. Since owner ruling 2026-07-24
(HANDOFF #104: "我要2990s的直接跟houzs的") that role is **derived from the
member's POSITION at read time** (`scm/lib/pos-staff-role.ts`, applied to every
/staff read in `scm/routes/staff.ts`):

| positions.slug | POS role | POS effect |
|---|---|---|
| super_admin | super_admin | view-all + curator (email login) |
| sales_director | sales_director | view-all + curator (email login) |
| sales_manager | outlet_manager | view-all + passcode login ("管理级") |
| sales_executive | sales_executive | own orders, passcode login |
| sales_person / sales_trainee | sales | own orders, passcode login |
| any other position | stored scm.staff.role (inert) | owner: non-sales members don't use POS |

`scm.staff.role` in the DB stays untouched (mig 0066 stamps 'sales' on every
member and that remains true) — the derivation happens only on the read
surface, so changing someone's Position in User Management changes their POS
powers immediately, with nothing to re-sync. PIN issuance (Members → Set PIN)
remains the real gate for tablet login; the PIN-login endpoint additionally
requires a sales-side position (routes/pos.ts).

## Key files
- `backend/src/services/pageAccess.ts` — levels, PAGES catalogue, loaders (role + position)
- `backend/src/services/auth.ts` — hydrateAuthUser (position → page_access)
- `backend/src/routes/positions.ts` — positions CRUD + matrix read/write
- `backend/src/services/pmsAccess.ts` — project-detail section gating
- ~~`backend/src/services/projectAcl.ts`~~ — REMOVED 2026-08-19 (project PIC/brand row-level ACL deleted; visibility is company-scope only)
- `backend/src/routes/users.ts` — invite/PATCH/list carry dept/position/manager
- `frontend/src/auth/PageGuard.tsx`, `App.tsx`, `components/Sidebar.tsx` — FE enforcement
- `frontend/src/pages/Team.tsx`, `Positions.tsx` — the UI
- `backend/scripts/seed-user-management.mjs` — departments + positions + matrix + test accounts
- migrations: `0004_positions.sql` (PG) / `094_positions.sql` (D1)
- tests: `positions.test.ts`, `pmsAccess.test.ts`, `projectAcl.test.ts`, `pageAccess.test.ts`
