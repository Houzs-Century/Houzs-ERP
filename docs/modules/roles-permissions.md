# Roles and Permissions

Two separate authorization systems live under Team > Roles. Flat permissions (`x.y` keys like `projects.read`) gate API capability (`requirePermission()`) and are granted per ROLE. Page access (`orders.balance` at level V/E/F) gates which menus and pages exist, and is granted per POSITION — edited from the same Roles screen (the settings drawer) but resolved separately (`docs/PERMISSION-MATRIX.md`). This page covers the flat-permission system and the Team > Roles admin surface together.

## Statuses and flow

- `PERMISSIONS[]` (`backend/src/services/permissions.ts`) is the only thing that makes a flat key real. A key absent from it cannot be granted through the UI (`Roles.tsx` renders no checkbox), cannot be stored through the API (`POST`/`PATCH /api/roles` filters with `isValidPermission`), and is silently dropped from session hydration (`parsePermissions`) — none of the three produces a log or error.
- The admin matrix (`frontend/src/pages/Roles.tsx` desktop, `MobileRoles.tsx` phone, shared model `lib/rolesPermissionModel.ts`) is DERIVED from that catalogue, not hand-authored: module strip = `resource`, columns = the five real verbs (`read`/`create`/`write`/`manage`/`approve`), rows = keys grouped by stem; a (row, verb) with no real key renders N/A.
- Edits are staged client-side (a `GrantMap` diffed against a baseline) — Save issues one `PATCH /api/roles/:id` per changed role; Discard reverts to baseline.
- Bulk edit writes a toggled cell to every selected EDITABLE role at once. System roles (`is_system` OR holding `"*"`) are never written to — filtered out of the staged set at three separate points in the model, and shown as an "All permissions" empty state instead of a matrix. "Duplicate as editable role" is the only way to get a custom, editable copy of one.
- `GET /api/roles` returns `unknown_permissions` per role (the complement of what session hydration keeps) so a role holding a since-undeclared key is visibly flagged in the UI rather than silently thinned on the next save.

## Permissions

- `roles.read` (or the Sales Director carve-out, read-only) to open the tab; `roles.manage` for every mutation, including page-access edits.
- `"*"` (wildcard) is reserved for owner-tier Titles — a `position_policy` row with cohort `god` (Super Admin, Owner, Managing Director on 2026-09-16), or, for a Title with no row, the `GOD_POSITIONS` name list — and satisfies every flat key automatically via `hasPermission`.
- Several high-value keys are declared but granted to **no seed role** on purpose — only `*` holds them until the owner explicitly assigns them: `scm.payment_voucher.check` / `.approve` (the two-yes voucher gate), `scm.so_payment.amend` (correcting a payment after its same-day window, never past a RECONCILED one), `memos.manage` (cross-department memo authority), `announcements.approve` (the publish gate for every notice).
- `hasPermission` (honours `*`) is what every access gate must use. `hasPermissionLiterally` (ignores `*`, checks only what a role explicitly lists) is a separate reading used ONLY for deciding whose desk work belongs on — amendment notice audiences and sidebar pending-approval counts — never for permitting an action. Holding a key literally can also carry an obligation (e.g. `scm.so_payment.amend` requires a reason on every action once a role names it, even for the Owner via a custom role).

## Rules that must not break

- A key with a live `requirePermission`/`can()` gate must be in `PERMISSIONS[]` — leaving it only in `UNDECLARED_ROLE_KEYS` makes it a permission nobody can ever grant, with no error anywhere (`service_cases.approve` did exactly this for weeks, silently Owner/IT-only).
- `UNDECLARED_ROLE_KEYS` is a ledger, not an allow-list — listing a key there does not grant it; it still gets dropped exactly as before. A `legacy-closed` entry means a real gate exists and is deliberately left ungrantable — declaring it OPENS access that is currently shut, so never "fix" one by moving it into `PERMISSIONS[]` without confirming that's intended.
- The ledger is a ratchet: a key that later gains a real gate must be declared in `PERMISSIONS[]` AND removed from the ledger in the same change — a drift test fails if a key is in both.
- `sales_orders.write` and `delivery_orders.write` need extra care if ever declared — their `.read` twins are deliberately `legacy-closed`, so a write key with no closed read counterpart would be a bigger opening than it looks.
- Two scripts (`census-service-case-visibility.mjs`, `backfill-role-page-access.mjs`) parse role permissions with their own parser that skips the `isValidPermission` filter — their model of a user's permissions is WIDER than the running system's; never read their output as what a user actually holds.

## Gotchas

- The inverse of the missing-catalogue bug also happens and is harder to notice: a key granted in a stored role row that gates nothing anywhere (dozens of these exist) — don't assume every checked box in the matrix corresponds to a live gate.
- A `*` (wildcard) holder passes every gate via `hasPermission` and so can never reproduce a missing-catalogue-entry bug by testing as themselves — test as a role holding the specific key, not as Owner/IT Admin.
- There is no frontend permission registry and must not be one — the client only holds booleans the server already decided (`frontend/src/auth/capabilities.ts`); don't add a second source of truth for what a role can do.
- A role's flat `permissions` only decides what it can DO — page access (what it can SEE) comes from the member's Title: its `position_policy` row (Roles & Permissions › **Titles**: cohort god / full / restricted / sales, a profile for restricted and sales, and the money / config / fleet flags; `PUT /api/position-policy/:positionId`, `roles.manage`, audited as `position_policy.update`), resolved by `positionPolicy.ts` at login. A Title with no row falls back to the name-keyed sets in that file (an unclassified name is full). The whitelists a profile names stay code. `role_page_access` is read only for a member with no Title. Editing the Roles matrix never touches menu visibility.
- The row rides the session: it is joined on the authority read and is part of the authz fingerprint, so a Titles edit reaches every member of that Title on their next request; it is carried onto `AuthUser.position_policy` and the SCM bridge's `houzsUser`, and the sales-JD, money-write, config-write and delivery-scope rules read it ahead of `position_name`. `pmsAccess` (PMS director / sales / purchasing tiers), `projectGates` (crew scope, the defect reviewer) read the row too — the **Duty** column (management / finance / purchasing / logistic / driver / helper / warehouse / other) plus cohort and profile — and fall back to their name lists only for a Title with no row; the frontend reads the answers as capabilities (`org.sales.staff`, `org.salesDirector`, `org.crew.scoped`, `org.defect.reviewer`).
- A stored key outside `PERMISSIONS[]` is dropped at login; migration `20260916T1500` stripped the 24 known dead keys from every role row and deleted five unused seed roles (Dispatcher, Manager, Customer, Supplier, duplicate Purchaser id 322). The read-only audit (`audit-permission-grants.mjs` §2c/§2d/§7b, run via *Role permissions diag*) reports stored-vs-effective keys per role, roles with zero effective keys that active people hold, and Titles whose members span several roles — run it before believing the matrix.
- `Outsource Transporter` is a restricted-cohort Title (Driver / Helper rows), not a fleet one: no member has a `scm.drivers.user_id` link, and an unlinked fleet position fails closed to an empty delivery board.
- There is no per-grant audit trail — `audit_events` records once per `role.update`, not per permission key; don't expect to find who flipped one specific checkbox.

## Where the code is

- `backend/src/services/permissions.ts` — `PERMISSIONS[]`, the catalogue, `UNDECLARED_ROLE_KEYS`.
- `backend/src/services/pageAccess.ts` — the separate page-access catalogue (`PAGES[]`).
- `backend/src/services/positionPolicy.ts` — `resolvePositionPolicy(input, row)`, `policyFromRow`, `positionGrantsWildcard`; `backend/src/services/positionPolicyRows.ts` — the row type, validation, loader and `POSITION_POLICY_SEED`; `backend/src/routes/position-policy.ts` — the Titles API; `frontend/src/pages/team/TeamTitlesPolicy.tsx` — the Titles tab.
- `backend/src/routes/roles.ts` — API surface.
- `backend/tests/permissionCatalogueDrift.test.ts` — the build-time ledger/catalogue drift gate.
- `frontend/src/pages/Roles.tsx`, `frontend/src/mobile/MobileRoles.tsx` — desktop/mobile admin surfaces.
- `frontend/src/lib/rolesPermissionModel.ts` — the shared matrix/staging model.
- `frontend/src/pages/roles/RoleSettingsDrawer.tsx`, `RolesModals.tsx` — page-access editor, create/apply/copy modals.
