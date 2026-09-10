# Module: Team — Roles & Permissions

Per-module doc for the System > Team > **Roles** surface: the role list, the
permission matrix, and the staged save model. Sibling Team tabs (Members,
Positions, Org Chart, Departments, Mailboxes) are separate concerns — see
[`team-members.md`](./team-members.md).

> Auth model: `roles.read` (or the Sales-Director carve-out, read-only) to open
> the tab; `roles.manage` for every mutation. **A role's flat `permissions`
> array is "what you can DO"** (it gates the ~249 `requirePermission` API sites).
> Page access (what a role can SEE) is a SEPARATE surface — the Role-settings
> drawer, backed by `role_page_access` — and is only edited here, not resolved
> here. See `docs/CODEBASE-MAP.md` §7 and `docs/PERMISSION-MATRIX.md`.

---

## 1. Data model

| Thing | Where | Shape |
|---|---|---|
| Role | `roles` table (`backend/src/db/schema.ts`) | `{ id, name, description, permissions (JSON string[]), is_system 0/1, scope_to_pic 0/1, created_at }`. No department/group column. |
| Permission catalogue | `backend/src/services/permissions.ts` → `PERMISSIONS[]` | Flat `{ key, resource, verb, label, description }`, `verb ∈ read|create|write|manage`. `"*"` = wildcard, reserved for the Owner role. ~60 keys across ~12 `resource` groups. |
| Members | `users.role_id` | Only a `COUNT(*)` is exposed (`member_count`). There is no per-role members endpoint. |
| Page access | `role_page_access` + `backend/src/services/pageAccess.ts` (`PAGES`) | 3-level (`none|partial|full`), backfilled from `permissions` for positionless users. The second matrix; edited in the Role-settings drawer. |

There is **no** role `group`, **no** per-grant "last changed by" (actor lives
only in the `audit_events` ledger, per `role.update`, not per key), and unknown
stored keys are **silently dropped** — `parsePermissions` filters on read and
`isValidPermission` filters on create/patch, so a key not in the catalogue never
reaches the client and is lost on the next save.

## 2. API surface (`backend/src/routes/roles.ts`)

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/api/roles` | `roles.read` or Sales Director | List + `member_count`. Ordered `is_system DESC, name`. |
| GET | `/api/roles/permissions` | `roles.read` | The `PERMISSIONS` catalogue (drives the matrix columns/rows). |
| POST | `/api/roles` | `roles.manage` | Create custom role; strips invalid keys; 409 on duplicate name. |
| PATCH | `/api/roles/:id` | `roles.manage` | Update; **system roles: description only** (name + permissions locked). |
| DELETE | `/api/roles/:id` | `roles.manage` | Refuses system roles and roles still in use. |
| GET | `/api/roles/pages` | `roles.read` | Page catalogue (`{key,label,partialMeaning,supportsPartial,parent,dormant}`). |
| GET | `/api/roles/:id/page-access` | `roles.read` | Per-page levels, backfilled from `permissions`. |
| PATCH | `/api/roles/:id/page-access` | `roles.manage` | Upsert `{entries:[{page_key,level}]}`. |

## 3. Frontend

Desktop AND mobile — one shared logic layer (`lib/rolesPermissionModel.ts`), two
presentations.

| Surface | File | Notes |
|---|---|---|
| Desktop workspace | `frontend/src/pages/Roles.tsx` → `RolesTab` | Master/detail. Embedded in `frontend/src/pages/Team.tsx` at `/team?tab=roles`; the Roles tab is off the visible strip (owner "删了role") but URL-reachable. Team owns the `PageHeader` + New Role button and passes `{ creating, onCloseCreate }`. |
| Mobile screen | `frontend/src/mobile/MobileRoles.tsx` | Role list → per-role detail; each `resource` is a collapsible card of permission toggles, staged + saved through a sticky action bar. Single-role edit (no bulk). Wired into `frontend/src/mobile/MobileApp.tsx` (lazy screen + `destinationScreen` + overlay + a Profile row `{ to: "/roles", gateVia: "/team?tab=hub" }`); the screen mounts only for `can("roles.read")`. |
| Pure model | `frontend/src/lib/rolesPermissionModel.ts` (+ `.test.ts`) | `buildModules` adapts the flat catalogue into the `module → row → verb` grid; `activeIds`/`setPerm`/`setPerms`/`cellState`/`moduleCounts`/`diffGrants` are the staging + tri-state + guard logic. |
| Modals | `frontend/src/pages/roles/RolesModals.tsx` | `NewRoleModal` (name / description / start-from) + `RolePickerModal` (Apply-to = multi target, Copy-from = single source). |
| Settings drawer | `frontend/src/pages/roles/RoleSettingsDrawer.tsx` | Name / description / `scope_to_pic` + the page-access matrix (preserves the old editor's non-permission capabilities). |

### Behaviour
- **Matrix.** Module strip = `resource` values; columns = `READ · CREATE · WRITE
  · MANAGE · APPROVE` (five real verbs); rows = permission keys grouped by "stem"
  (key minus its trailing verb). CRUD resources collapse to one row × cells;
  heterogeneous ones
  (Projects, Supply Chain) spread into one-off rows, and any (row, verb) with no
  real key renders as an **N/A dashed** cell. Toggling a cell adds/removes that
  one key from the staged set.
- **Staged edits.** Grants live in a client `GrantMap` (roleId → Set<key>) with a
  `baseline` clone. The sticky save bar shows the diff; **Save** issues one
  `PATCH /api/roles/:id` per changed role, then reloads; **Discard** reverts to
  baseline. The bar attributes the count to the roles that actually changed.
- **Bulk edit.** Checking ≥2 roles → tri-state cells written to all *editable*
  selected roles. **System roles are never written** — three guards in the model:
  `activeIds` filters locked ids, `setPerm`/`setPerms` skip locked ids, and the
  system empty-state shows when no editable ids remain. "Locked" = `is_system`
  **or** holds `"*"`.
- **System roles.** Show the "All permissions" empty state (no matrix).
  "Duplicate as editable role" creates a custom copy with `"*"` expanded to every
  concrete key.
- **⋯ menu** (`RowActionsMenu`): Duplicate role · Apply these permissions to… ·
  Copy permissions from another role… · Role settings… · Delete role (confirmed
  via `useDialog().confirm`).

## 4. Traps & deviations from the design mock

- **The grid is DERIVED from the flat catalogue, not hand-authored.** Real verbs
  are read/create/write/manage/**approve** (main added `approve` —
  `scm.so_cancel.approve_l1/l2`, `announcements.approve`), so the matrix has FIVE
  columns; rows are keys grouped by stem, with N/A where a (resource, verb) has no
  key. Don't reintroduce a hand-authored module/resource/action table.
- **Groups are System/Custom**, not the mock's 9 departments (roles have no group
  field).
- **Members are derived client-side** from `/api/users` (needs `users.read`;
  degrades to `member_count` only).
- **Unrecognised keys ARE surfaced** (#2554): `GET /api/roles` returns
  `unknown_permissions` per role (`droppedPermissions()`, the complement of
  `parsePermissions`), so the rail shows a ⚠ marker, the panel shows a collapsible
  banner listing the dropped keys, and "Clear" re-saves the role's valid set — the
  backend strips unknown keys on any write, so it is all-or-nothing, not per-key.
  Mobile shows the same dropped keys read-only.
- **Still omitted, no backing:** the per-grant audit-hover line (no per-grant
  actor; `audit_events` records per-`role.update`, not per key).
- **Deferred:** permission Templates / "Save as template" — a shared store needs
  a backend table; localStorage would violate the personal-prefs-only rule.
- **DS fix that rides along:** `SearchInput` now takes `widthClassName` (default
  `w-72`); pass `w-full` for a fluid field. `.no-scrollbar` was NOT touched — it
  already ships in `src/index.css` (the README's claim only holds for the
  design-sync preview stylesheet).
- **roles.permissions vs page access.** Editing the matrix changes only what a
  role can DO. Page access (what it can SEE) is the Role-settings drawer and,
  for positioned users, is resolved from `positionPolicy.ts` at login — not from
  this table. Don't conflate them.
