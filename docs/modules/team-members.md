# Module: Team — Members & Invitations

Per-module technical doc for the System > Team > Members surface: the member
list, the member lifecycle actions, and the pending-invitations queue. The
Roles / Positions / Org Chart / Departments / Mailboxes tabs that share the
Team page shell are separate concerns and are only referenced here.

> Auth model: `users.read` (or the Sales-Director carve-out) to see the lists,
> `users.manage` for every mutation. Positions gate MENUS, roles gate
> PERMISSIONS — see the permission-architecture note; nothing in this module
> grants SCM capabilities.

---

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop tab | `frontend/src/pages/Team.tsx` → `MembersTab` | List view = shared `DataTable` (`tableId="team-members"`); grid view = `VirtualMemberGrid` of `MemberCard`s (windowed past ~40). |
| Desktop detail | same file → `MemberDetail` | Full-page; reached from grid card click or list row click. Sub-tab `?view=org-performance`. |
| Edit drawer | same file → `EditMemberPanel` | One `PATCH /api/users/:id` on save; showroom parking via `/api/scm/staff`. |
| Invite drawer | same file → `InvitePanel` | `POST /api/users/invite`. |
| Mobile list | `frontend/src/mobile/MobileModuleList.tsx` (`members` module) | Person cards; chips All / Active / Invited. |
| Mobile actions | `frontend/src/mobile/MobileModuleDetail.tsx` → `MemberActions` | Mirrors desktop resend-invite / reset-password 1:1 (single-logic-layer rule). |

### Members list anatomy (top to bottom)
1. **Stat cards** — Active / Pending Invites / Disabled / Total. Clickable
   filters (toggle `filterStatus`); counts are over USERS by `status`, so
   "Pending Invites" counts `status='invited'` users, not invitation rows.
2. **Section header row** — brass dash + `Members (filtered/total)`; right side
   holds the Filters popover (dept / position / role / brand / company +
   quick segments), the grid-sort select and the grid/list toggle. The grid
   view keeps its own search input; the list view searches inside the
   DataTable toolbar (`search` prop, client-side over name / email / phone /
   role / department / position).
3. **Status pills** — `FilterPills` slab (All / Active / Pending / Disabled
   with counts), same state as the stat cards.
4. **DataTable** — ~22 declared columns, 13 of them `defaultHidden` (Email,
   Phone, Role, Division, Brands, Email Alias, Presence, Direct Reports,
   Invited, Invited By, Joined, Created, Status Reason). Every data column has
   `getValue`, so sort / funnel filter / CSV export work on all of them.
   Row click opens `MemberDetail`. The select column is hand-rolled (not the
   DataTable `selection` prop) because it must exclude self + non-manageable
   rows; bulk bar offers enable / disable / resend invites / reset passwords /
   set dept / set position.
5. **Pending Invitations** — its own `DataTable` (`tableId="team-invitations"`):
   Email, Role, Status (Pending / Expiring soon <2d / Expired), Invited,
   Expires, Emailed, Invited By (hidden), and per-row Resend / Copy Link /
   Revoke for `users.manage`. Expired rows render dimmed; header carries the
   bulk "Revoke N expired" action.

Layout persistence: standard DataTable localStorage keys
(`dt:hidden|shown|order|sort|widths|pinned:team-members` / `:team-invitations`,
company-prefixed). View + grid-sort prefs are identity-scoped
(`team:view`, `team:gridSort`).

---

## 2. API surface (`backend/src/routes/users.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/users` | Full member list (unbounded; `?q=` caps at 50 for typeahead). |
| GET | `/api/users/invitations` | Open invites (`accepted_at IS NULL`; Sales-Director dept-scoped). |
| POST | `/api/users/invite` | Create invite (+ placeholder `status='invited'` user). |
| POST | `/api/users/invitations/:id/resend` | Re-email an invite (same token). |
| POST | `/api/users/:id/resend-invite` | Same, keyed by the placeholder user. |
| DELETE | `/api/users/invitations/:id` | Revoke — also deletes the placeholder user. |
| PATCH | `/api/users/:id` | Edit fields / enable / disable (`status_reason`). |
| DELETE | `/api/users/:id?hard=1` | Hard delete; FK references block it — use Disable instead. |
| POST | `/api/users/:id/reset-password` | Email a 1h reset link (never shown in UI). |
| POST | `/api/users/:id/impersonate` | Staging-only; probe `GET /api/users/impersonation-enabled`. |
| GET | `/api/presence` | Online ids — drives presence dots + the Presence column. |

Member rows already return everything the table renders — id, email, name,
status(+reason), role, manager, department(+ids/color), division, position,
invited_at/by(+name/email), joined_at, last_login_at, created_at, phone,
email_alias, brands, company_ids, profile_pic_r2_key. Add columns from THIS
payload before touching the backend select.

Invitation rows return id, email, role, token, created/expires/accepted_at,
invited_by_email, invite_url (canonical PUBLIC_APP_URL link), email_status +
emailed_at (latest `email_log` outcome). The invite's target department /
position / manager ids exist in the `invitations` table but are NOT selected.

---

## 3. Traps

- **Users vs invitation rows.** A pending person exists twice: a
  `status='invited'` user AND an `invitations` row. The stat card counts the
  former; the Pending Invitations table lists the latter (expired ones
  included, hence the counts differ). Revoking removes both.
- **Invite links are live credentials.** `token` / `invite_url` must never get
  a `getValue` (CSV export) and are never rendered — Copy Link goes straight
  to the clipboard, preferring the server-built `invite_url`.
- **Client-side list.** `/api/users` is one unbounded fetch; every filter,
  count and search is computed in the component. No `ListPager`.
- **Both surfaces or neither.** Invite/edit/action semantics changed on
  desktop must land in the mobile pair (`MobileModuleList` config +
  `MemberActions`) in the same PR.
