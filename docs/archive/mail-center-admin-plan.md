> **ARCHIVED 2026-08-13.** The admin UI it specifies shipped as `frontend/src/pages/MailboxesTab.tsx`. Superseded by `docs/modules/mail-center.md` (**2026-08-04**). Kept for history; do not follow it as a current instruction.

# Mail Center — Admin "Assign Mailbox + Alias" UI: build plan

**Status:** plan only (2026-06-24). Completes the gap left open by
`mail-center-port-plan.md` (line ~276: *"admin grids from `/access` + `/scope-levels`…
wire them into Team when ready"*). The backend admin API was ported in full; the
**admin UI was not**. This doc specifies exactly what to build.

---

## 1. The gap, precisely

The owner can read/reply mail, but there is **no UI** to:
- (a) create an email address and assign it to a **USER** or a **DEPARTMENT** (shared mailbox);
- (b) manage **who has access** to a shared mailbox (the access matrix);
- (c) set a user's **visibility level** (personal / department / company).

Today addresses were seeded via the DB. The only provisioning affordance in the app is the
one-click **"Set up"** button on the Inbox sidebar (`createDeptMailbox` → `POST /addresses`,
`{address, assignedDept, label}`, no user). `Compose.tsx` even tells the user
*"You have no mailbox assigned… Ask an admin to assign one in User Management"* — but
**User Management (Team.tsx) has no such control**.

**Hookka** solved this with a **"Mailbox Access" tab in User Management** (`settings/Users.tsx`):
a per-user Edit modal (assign address + dept + position) plus a grant-matrix tab
(checkboxes user×shared-mailbox + a per-user view-level select + alias linking + a "peek"
popover). Houzs should mirror this, adapted to Houzs conventions.

---

## 2. Backend — what EXISTS vs what's MISSING

The Houzs backend (`backend/src/routes/mail-center.ts`) already has the **complete admin API**.
All admin handlers self-gate inline with:

```ts
isMailAdmin(user) = hasPermission(granted, "*") || hasPermission(granted, "mail_center.manage")
```

(`granted = user.permissions_set ?? user.permissions`). Failure → `403 {"error":"Forbidden: requires mail_center.manage"}`.
Reads/compose/reply gate on mailbox **scope** (`getMailScope`), not `isMailAdmin`.

### Endpoints present (WIRE-EXISTING — no backend work)

| Action | Method + path | Payload / returns |
|---|---|---|
| List addresses | `GET /api/mail-center/addresses` | → `MailAddress[]` (scope-gated; admin gets all). `Cache-Control: no-store` |
| **Create address** | `POST /api/mail-center/addresses` | `{address, label?, assignedUserId?:number\|null, assignedUserName?, assignedDept?, assignedPosition?}` → `201` row. `409` if exists. Domain enforced = `brandingDomain(env)` (→ `@houzscentury.com`) |
| **Assign / relabel / toggle active** | `PATCH /api/mail-center/addresses/:id` | minimal `{label?, assignedUserId?, assignedUserName?, assignedDept?, assignedPosition?, active?:boolean}` → row. `404` if none |
| List grants | `GET /api/mail-center/access` | → `{addressId, userId}[]`. `no-store` |
| **Grant access** | `POST /api/mail-center/access` | `{addressId, userId:number}` → `201` (idempotent) |
| **Revoke access** | `DELETE /api/mail-center/access` | `{addressId, userId}` (also accepts query string) → `{ok}` |
| List view-levels | `GET /api/mail-center/scope-levels` | → `{userId, level}[]`. `no-store` |
| **Set view-level** | `PUT /api/mail-center/scope-level` | `{userId:number, level}` where level ∈ `personal\|department\|company`. Upsert |
| Member alias field | `PATCH /api/users/:id` | `{email_alias}` (snake_case) — Team.tsx already uses this |

> **Singular/plural asymmetry (carried over from Hookka):** the LIST is `GET /scope-levels`
> (plural); the WRITE is `PUT /scope-level` (singular). Grants use the same `/access` path for
> POST and DELETE.

> **`users.id` is an integer** in Houzs → `assignedUserId` and `userId` payloads are **numbers**,
> not strings (differs from Hookka). The address `id` is text.

### Backend GAPS (decide, mostly NET-NEW-optional)

1. **No department-mailbox one-click endpoint.** Same as Hookka — there is none server-side.
   The "one-click" is a **frontend** convenience that posts to the existing `POST /addresses`
   with `{assignedDept, label}` and no user. `createDeptMailbox` in `mail-actions.ts` already
   does exactly this. **No backend work needed.**
2. **No `DELETE /addresses/:id`.** Deactivation is `PATCH … {active:false}` only (soft).
   Matches Hookka. Keep it — no hard delete. (UI uses an Active toggle.)
3. **`assigned_dept` is free text** — the backend does **not** validate against `public.departments`.
   The UI should still offer the **4 real Houzs departments** from `GET /api/departments`
   (see §4) so values stay consistent, but no FK is enforced. No backend change required.
4. *(Optional polish, not required)* the backend stores `assigned_dept` as the department **name**
   string; `GET /api/departments` returns `{id, name, color}`. The picker must send the **name**,
   not the id, to match how `'department'` scope resolution string-matches (`WHERE assigned_dept = ?`).

**Net: zero required backend changes.** The whole job is frontend.

---

## 3. WHERE the admin UI should live — recommendation

**Recommended: a new `mail` tab inside Team.tsx (User Management)** — this is the closest 1:1 to
Hookka's "Mailbox Access" tab and reuses Team's `TabStrip` + `PageHeader` chrome. Reasons:

- Hookka put it in User Management, and the Houzs Compose lockout text already points users to
  *"User Management"*.
- Team.tsx already loads `GET /api/departments` and the full user list — the two data sources the
  matrix needs — so no duplicate fetching.
- Team's tab system is a clean, declarative extension point (see §5).

**Plus a light touch already partly present in the Inbox sidebar** (`MissingMailboxItem` "Set up"
one-click for the 4 canonical departments) — keep that as the fast path; the new Team tab is the
full manager. Both write to the same `POST /addresses`, so they stay consistent.

> Do **not** build a separate top-level `/mail-center/admin` route. It would duplicate Team's chrome
> and split mailbox admin away from user admin. (If ever desired, the same `<MailboxesTab>` component
> can be mounted at a route later — but the tab is the right home.)

---

## 4. Components / pages to add or wire

All new frontend files under `frontend/src/pages/Team/` (or inline in `Team.tsx` if you prefer the
existing single-file pattern — Team.tsx already holds `MembersTab`, `PositionsTab`, etc. inline).

### 4.1 NET-NEW: `MailboxesTab` (the manager)

A new tab body, gated `can("mail_center.manage")`. Three regions, mirroring Hookka's Mailbox Access tab:

**A. Address list + create (replaces Hookka's per-user Edit modal create path)**
- Fetch: `useQuery(() => api.get("/api/mail-center/addresses"))` → `MailAddress[]`.
- A table of every address: **Address | Label | Assigned to (user or dept) | Position | Active**.
- **"New mailbox"** button → modal with:
  - Address `<input>` (default-suggest from selected user's name; validate
    `endsWith("@" + brandingDomain)` — derive domain client-side or just trust the 400). Hookka rule:
    address is **immutable after create** (PATCH can't rename) — disable the field when editing.
  - **Type toggle: "Person" vs "Department"**
    - *Person* → user `<select>` (from the Team user list) → posts `assignedUserId` (number) +
      `assignedUserName`, plus optional dept/position.
    - *Department* → dept `<select>` populated from `GET /api/departments`
      (the **4 real Houzs depts**: Sales Department / Operation Department / IT Department / Management) →
      posts `assignedDept` (the **name**), `label` (e.g. `"${dept} Team"`), **no** user. This is the
      "department shared mailbox" = the same shape `createDeptMailbox` already sends.
  - Save (Person) → `POST /addresses {address, assignedUserId, assignedUserName, assignedDept?, assignedPosition?}`.
  - Save (Dept) → reuse the existing `createDeptMailbox(address, dept, label)` helper verbatim.
- **Edit row** → `PATCH /addresses/:id` with only changed fields (dept/position/active/reassign-user).
  Active toggle = `PATCH {active:boolean}`.
- No-store responses already handle refetch; invalidate the `/addresses` query on save.

**B. NET-NEW: Access matrix (shared mailboxes × users)**
- Fetch `GET /access` → `{addressId,userId}[]` and the address list + user list.
- **Columns = "shared" mailboxes only** = addresses with **no** `assignedUserId` (and not a personal
  alias). Hookka's filter: `!(a.assignedUserId ?? "").trim() && !personalIds.has(a.id)`. Reuse that rule.
- Rows = active users. Checkbox per cell. A user's **own** assigned mailbox is forced-checked + disabled
  ("their own mailbox").
- **No naked edits** (Houzs rule): render read-only with an **Edit** button that seeds a draft Map
  (`key = \`${addressId}::${userId}\``); **Save** diffs draft↔server and fires
  `POST /access` (grant) / `DELETE /access` (revoke) per change via `Promise.all`, then refetches.
  *(This honors the repo's "no auto-save / use ConfirmDialog" convention — see `feedback_no_naked_edits`.)*

**C. NET-NEW: View-level column (personal / department / company)**
- Fetch `GET /scope-levels` → `{userId,level}[]`; absent user ⇒ `personal`.
- Per-user `<select>` ("L1 · Personal / L2 · Department / L3 · Company"), part of the same Edit/Save
  draft as B. Save → `PUT /scope-level {userId, level}`.
- Mirror Hookka's optimistic `savedLevels` guard to survive the stale read-after-write
  (the documented "set Company → Save → jumps back to Personal" bug). Cheap to copy.

**D. NET-NEW (nice-to-have, low priority): the "peek" popover** — resolve client-side what addresses a
user effectively sees at their level (own + granted, +dept at L2, all at L3). Pure presentation; can
ship in a later pass. Mirror Hookka's `resolveScopeAddresses`.

### 4.2 WIRE-EXISTING: helpers in `mail-actions.ts`

`mail-actions.ts` currently has only `createDeptMailbox`. Add thin wrappers (NET-NEW, ~6 small fns)
so the tab doesn't inline fetches:

```ts
createAddress(address, { assignedUserId, assignedUserName, assignedDept, assignedPosition, label })
patchAddress(id, patch)            // PATCH /addresses/:id
fetchAddresses()                   // GET /addresses        (or reuse api.get inline)
fetchAccess() / grantAccess(addressId,userId) / revokeAccess(addressId,userId)
fetchScopeLevels() / setScopeLevel(userId, level)
```

Keep `createDeptMailbox` as-is (Inbox sidebar uses it).

### 4.3 WIRE-EXISTING: Team.tsx tab registration

Concrete edits in `frontend/src/pages/Team.tsx`:
- `TeamTabValue` (line 28): add `| "mail"`.
- tab-validity list (line 106): add `"mail"` to the `includes([...])` array.
- `tabs` array (line ~122): add `{ value: "mail", label: "Mailboxes", show: can("mail_center.manage") }`.
- `TAB_HEADER` map (line ~131): add a `mail:` entry (eyebrow `"Workspace · Mail Center"`,
  title `"Mailboxes"`, description e.g. *"Assign email addresses to people or departments, grant
  shared-mailbox access, and set each member's mail visibility."*).
- switch body (line ~214): add `{active === "mail" && can("mail_center.manage") && <MailboxesTab/>}`.
- (Team is gated by `PageGuard page="team"`; the `mail` tab additionally self-gates on
  `mail_center.manage`, so a `users.read` user without mail-admin won't see the tab.)

### 4.4 WIRE-EXISTING: Compose lockout — already correct

`Compose.tsx` already shows the *"Ask an admin to assign one in User Management"* note when
`activeAddresses.length === 0`. Once the new tab lets an admin assign a person an address
(`POST /addresses {assignedUserId}`), `GET /addresses` returns it in that user's scope and the lockout
clears automatically. **No change needed** beyond optionally updating the copy to name the new tab
("User Management → Mailboxes").

---

## 5. Assign to USER vs DEPARTMENT — the exact flows

| | USER (personal) | DEPARTMENT (shared) |
|---|---|---|
| Trigger | New mailbox → "Person" | New mailbox → "Department" (or Inbox "Set up") |
| Picker | user `<select>` (Team user list) | dept `<select>` from `GET /api/departments` (4 real depts) |
| Endpoint | `POST /addresses` | `POST /addresses` (via `createDeptMailbox`) |
| Body | `{address, assignedUserId:<num>, assignedUserName, assignedDept?, assignedPosition?}` | `{address, assignedDept:"<dept name>", label:"<dept> Team"}` — **no** user |
| Who can read it | that user (own scope) | users **granted** via the access matrix, + dept-level / company-level users |
| Reassign later | `PATCH /addresses/:id {assignedUserId, assignedUserName}` | `PATCH /addresses/:id {assignedDept}` |

The **department picker must send the department NAME** (not id), because the backend's `'department'`
scope resolution string-matches `assigned_dept = <the user's own assigned_dept>`. Send
`d.name` from `GET /api/departments`.

---

## 6. How the alias (`users.email_alias`) fits

- `users.email_alias` is **editable today** in Team.tsx → `EditMemberPanel` → "Email Alias" input →
  `PATCH /api/users/:id {email_alias}` (snake_case, lowercased, empty→null). **Confirmed wired.**
- **But it is decoupled from the inbox today.** Compose's From default is resolved by
  `pickDefaultFromAddress(activeAddresses, user)` matching `MailAddress.assignedUserId` — **not**
  `users.email_alias`. So `email_alias` is currently **cosmetic** on the frontend.
- **Recommendation (reconcile, small):** make `email_addresses.assigned_user_id` the single source of
  truth (it already drives scope + From). Two clean options:
  1. **Keep both, link them:** when an admin assigns a person an address in the new tab
     (`POST /addresses {assignedUserId}`), also `PATCH /api/users/:id {email_alias:<address>}` so the
     Team field reflects reality. (Hookka's modal does the inverse — writes the alias row from the
     user modal.) Low effort, keeps the existing Team field meaningful.
  2. **Demote the field to read-only mirror:** show `email_alias` in Team as a read-only reflection of
     the person's `assignedUserId` address, edited only via the Mailboxes tab. Avoids two-writer drift.
- Either way: **no migration needed** — `users.email_alias` already exists (added in the port,
  `0039`/`0040`). This is a wiring decision, flagged for the owner, not a blocker for the matrix.

---

## 7. Backend gaps summary (explicit)

| Capability | Backend status |
|---|---|
| Create / assign address (user or dept) | **PRESENT** (`POST /addresses`) |
| Reassign / relabel / activate-toggle | **PRESENT** (`PATCH /addresses/:id`) |
| Access grant / revoke matrix | **PRESENT** (`GET/POST/DELETE /access`) |
| Per-user view-level | **PRESENT** (`GET /scope-levels`, `PUT /scope-level`) |
| Department one-click setup | **No endpoint — by design** (frontend posts to `POST /addresses`; matches Hookka) |
| Hard delete address | **Absent — by design** (soft `active:false` only; matches Hookka) |
| Dept FK validation | **Absent — by design** (`assigned_dept` free text; UI supplies the 4 real dept names) |
| `mail_center.manage` permission | **PRESENT** (`services/permissions.ts`; owner gets it via `"*"`) |
| `users.email_alias` column | **PRESENT** (already PATCH-able via Team) |

**→ The entire build is frontend.** One new `MailboxesTab` (regions A/B/C, optional D), ~6 helper
wrappers in `mail-actions.ts`, and 5 small registration edits in `Team.tsx`. Plus a one-line copy
tweak in `Compose.tsx` (optional) and an owner decision on the `email_alias` reconciliation (§6).

---

## 8. Build order (suggested)

1. Helpers in `mail-actions.ts` (createAddress, patchAddress, access ×3, scope-level ×2). *(NET-NEW)*
2. `MailboxesTab` region A (address list + New-mailbox modal with Person/Dept toggle). *(NET-NEW)*
3. Register the `mail` tab in `Team.tsx` (5 edits). *(WIRE-EXISTING)*
4. Region B (access matrix) + region C (view-level), with Edit→Save draft + the `savedLevels` guard. *(NET-NEW)*
5. Reconcile `email_alias` per §6 option 1 (link on assign). *(WIRE-EXISTING)*
6. (Later) Region D peek popover; Compose copy tweak.

**Verify on prod after deploy** (repo rule): assign a real person an address → confirm Compose lockout
clears for them; grant a shared mailbox → confirm the grantee sees those threads; set a user to
`company` → confirm read-after-write doesn't snap back to personal.

---

### Key file paths
- Backend (no changes): `backend/src/routes/mail-center.ts`; perms `backend/src/services/permissions.ts`
- Frontend tab host: `frontend/src/pages/Team.tsx` (tabs line ~122, switch line ~214)
- New tab + helpers: new `MailboxesTab` (in Team.tsx or `frontend/src/pages/Team/`), `frontend/src/pages/MailCenter/mail-actions.ts`
- Lockout copy: `frontend/src/pages/MailCenter/Compose.tsx` (line ~338)
- Dept source: `GET /api/departments` (already consumed in Team.tsx line ~266)
- Auth gate: `useAuth().can("mail_center.manage")` (`frontend/src/auth/AuthContext.tsx`)
- Reference (source of truth): Hookka `src/pages/settings/Users.tsx` ("Mailbox Access" tab) + `src/api/routes/mail-center.ts`
