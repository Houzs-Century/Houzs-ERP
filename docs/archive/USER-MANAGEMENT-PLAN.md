> **ARCHIVED 2026-08-13.** Built and deployed **2026-06-13**. Superseded by `docs/USER-MANAGEMENT.md` (the module guide) and `docs/PERMISSION-MATRIX.md` (the grid the seed script transcribes). Kept for history; do not follow it as a current instruction.

# User Management — uplift spec (departments, positions, org chart, invites)

Written 2026-06-13 from the owner's detailed requirements. Goal: one unified
Active Users list, invites that carry Department + Position + Role, Operation
positions with preset access, an Operation org chart, and parity-plus with
Hookka's invite UX. NOTE: build + verify needs prod DB up (currently recovering
from a Hyperdrive connection throttle) and the Resend key for the email test.

## What exists today
- **Invite** (`POST /api/users/invite`, routes/users.ts:249): captures email +
  display name + **role_id only**. Sends `member_invite` email (Resend, 72h link).
- **Users**: `users` table has `department_id` (PATCH can set it; invite cannot).
- **Departments** (`departments` + `department_brands`, mig 040/048): exist; used
  for brand-scope, not for position/access presets.
- **Roles** (`roles` + flat permissions + `role_page_access` mig 073): the access
  model. ~40 permission keys (services/permissions.ts).
- **Sales org** (`sales_reps` + `sales_positions` + commission tiers + brands,
  mig 067): a SEPARATE org chart for retail reps, with positions + one-hop
  manager hierarchy + `is_admin`. This is the "Sales already exists" piece.
- **Reset password** (`password_resets`, mig 027): exists; `password_reset` email.
- **Forgot-password / invite-accept**: routes exist (auth.ts).

## Target (owner's requirements)
1. **Unified Active Users** — all staff in one `users` list (already the case).
2. **Two departments with different invite paths:**
   - **Sales** — invitable from BOTH the System/Sales Portal AND User Management.
     (Sales chain already modelled in `sales_reps`; wire its invite into User Mgmt.)
   - **Operation** — invitable ONLY from User Management; then an Org Chart.
3. **Operation positions** (each a preset bundle of role-permissions + page access):
   purchasing, logistic, service_team, driver, helper, storekeeper.
4. **Invite carries**: email, display name, **department**, **position**, **role**,
   and where the position sits (manager/parent in the org chart).
5. **Org Chart + relationship chain** for Operation (mirror the Sales org tree;
   reuse `OrgChartView`/`HierarchyTree` components).
6. **One simplest test account per position**, simplest password.
7. **Send invite + reset to weisiang329@gmail.com** to verify email delivery.

## Proposed design (concrete, file-level)

### Data model (new migration, e.g. migrations-pg/0003_positions.sql + numbered D1)
- `positions` table: id, slug (purchasing|logistic|service_team|driver|helper|
  storekeeper|...sales slugs), name, department ('sales'|'operation'), default_role_id,
  sort_order, active. Seed the 6 Operation positions + map Sales positions.
- `position_presets`: position_id → JSON permission list + page_access map (the
  "preset 这些 position 看到的东西"). Or fold preset perms onto a default role per
  position (cleaner: each position → a system role with the right permissions).
- `users.position_id` (nullable FK) + `users.reports_to` already covered by
  `manager_id` (one-hop). Operation org chart = users where department='operation'
  linked by manager_id.
- Position preset permission bundles (draft):
  - purchasing → purchase_orders.read/write, service_cases.read, creditors view.
  - logistic → trips.read.all/write/manage, planner.run, fleet.read, delivery_orders.*
  - service_team → service_cases.read/write/manage.
  - driver → trips.read.own, trips.write, fleet.salary (the existing driver shell).
  - helper → fleet.salary (+ trips.read.own if they ride along).
  - storekeeper → purchase_orders.read, delivery_orders.read, (future inventory.*).

### Backend
- Extend `POST /api/users/invite` body: `{ email, name, role_id, department_id,
  position_id, manager_id }`. Persist on `invitations` (add columns) and apply on
  accept (set users.department_id, position_id, manager_id, role from preset).
- New `GET /api/positions` (list by department, with presets) for the invite form.
- Wire the Sales-portal invite to the same path (or a `source` flag).
- `GET /api/org-chart?department=operation` → tree from users+manager_id.

### Frontend (Team.tsx + portal)
- Invite form: add Department select → Position select (filtered) → Role (auto-
  filled from position preset, editable) → Manager/parent select. Matches Hookka's
  invite + the extra fields.
- Operation Org Chart tab (reuse OrgChartView).
- Sales invite also surfaced in System/Sales Portal.

### Test accounts (create one per position, simplest password)
Seed via a one-shot `backend/scripts/seed-test-accounts.mjs` (NOT a numbered
migration — per CLAUDE.md, demo data is a script). One account per Operation
position + the Sales positions, password e.g. `Test1234!`. Print the list.

### Email verification
With prod up + RESEND_API_KEY set: send one `member_invite` + one
`password_reset` to **weisiang329@gmail.com**; confirm receipt + working links.
(Cannot be tested locally — Resend key is a prod secret.)

## Execution note
Do this on a dedicated branch/worktree off migrate/d1-to-supabase; build +
locally test DB logic via `wrangler dev` against the SG session pooler (5432,
reachable); the email send + final verify require prod (Hyperdrive) up. Merge to
main → CI deploys (the safe path that also has the correct VITE_API_URL + token).
