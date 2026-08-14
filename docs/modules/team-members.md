# Module: Team — Members & Invitations

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

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
| Mobile invitations | `frontend/src/mobile/MobileInvitations.tsx` | Accordion card at the top of the members list (`aboveList` slot): count + expired badge always visible; expanded rows offer Resend / Copy Link / Revoke + bulk revoke-expired for `users.manage`. Expiry buckets + copied link shared with desktop via `frontend/src/lib/invitations.ts`. |
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
- **Impersonation is registered TWICE, and the second one is dead.** See
  section 4 below before changing either.
- **Writing `users.name` or `users.status` fires a trigger into `scm.staff`.**
  Mig 0066's `trg_sync_user_to_staff` is `AFTER INSERT OR UPDATE OF name,
  status ON public.users` — the only trigger on the table — and it mirrors the
  member into `scm.staff` so they appear in the SO Salesperson picker. It runs
  inside the firing statement, so anything it raises rolls the `users` write
  back and the member does not change. That is exactly how Disable broke
  (2026-08-01, `BUG-HISTORY.md`): the trigger's INSERT branch generated a
  `staff_code` already held by another staff row, and `staff_staff_code_unique`
  is not the constraint its `ON CONFLICT` arbitrates on. Mig 0234 makes the
  deactivate path a no-op when no staff row is linked and collision-checks the
  code otherwise. **When you touch name/status, the blast radius includes
  `scm.staff`** — and the operator only ever sees the generic 500 from
  `index.ts:385`, so check the trigger before believing the route.

---

## 4. Impersonation — two registrations, one of them dead

`POST /api/users/:id/impersonate` is registered **twice on the same Hono `app`**
in `backend/src/routes/users.ts` — once in the middle of the file, once again in
the `── Impersonation ──` section near the end. Hono composes both chains in
registration order, and the FIRST handler returns on every branch and never
calls the continuation (no handler in that file does), so **the second
registration is unreachable**.

**What actually runs** is the first one: wildcard `*` ONLY, always a 1-hour
session, minted by a direct `INSERT INTO sessions` rather than `createSession`
so the 7-day default TTL cannot apply. A non-wildcard caller gets
`403 "Owner only"`.

**What the dead one describes** — two doors, both behind `users.manage`
(Nico approved 2026-07-22):

- **Staging flag** — `IMPERSONATION_ENABLED === "true"`, set ONLY in
  `backend/wrangler.toml`'s `[env.staging.vars]`: every `users.manage` admin may
  hop between the shared test accounts. Ordinary 7-day sessions.
- **Wildcard owner** — a caller whose permissions carry `*` (Super Admin role /
  god-tier position) may impersonate EVERYWHERE, prod included, with a 1-HOUR
  session instead — the "view-as" design the owner hand-off in
  `frontend/src/main.tsx` describes: short-lived + audited.

Anyone else: the probe reports disabled and the mint endpoint 404s. It mints a
REGULAR session for the target (2FA is bypassed by design — the caller already
proved `users.manage`), so "exit" is just logging out.

**So the staging door does not exist at runtime**, even though
`backend/wrangler.toml` really does set `IMPERSONATION_ENABLED="true"` for
`[env.staging.vars]`. And `GET /api/users/impersonation-enabled` is NOT shadowed
— it is registered once, in the dead section — so on staging it still answers
`enabled: true` to any `users.manage` admin whose mint call then 403s
"Owner only". **Probe and mint disagree today.**

**LEFT AS IS on purpose** (audit 2026-08-13, `docs/audit-2026-08-13-ledger.md`
K2): which door is correct is a security decision, not a dead-code cleanup.
Deleting the second registration hides the intent; deleting the first would
silently GRANT every `users.manage` admin a 7-day impersonation session on
staging. Owner picks.

---

## 5. Reset password — the admin sends a link, and changes nothing else

`POST /api/users/:id/reset-password` is the admin-triggered "send reset link".
It emails the user a one-hour, single-use link. **THE ACCOUNT IS NOT TOUCHED**
(owner 2026-07-19: "如果他们没有点击，状态就保持不变；如果点击了，就可以重置密码"):
the password hash, the status and the user's live sessions are all left exactly
as they were. Only redeeming the link (`POST /api/auth/reset/:token`) changes
anything — and that path already sets the new hash and revokes every session.

**TWO DELIBERATE REMOVALS** from the earlier version of this handler, both of
which made "send a link" a state change:

1. It used to DELETE every session for the target the moment the admin clicked,
   so an untouched link still logged the user out of their phone mid-job. That
   is precisely the behaviour the owner ruled out.
2. It used to RETURN the token (`token`, `reset_path`) and the Team screen
   copied the live link to the admin's clipboard. That made `users.manage` a
   silent account-takeover primitive: any holder could mint a working one-hour
   credential for ANY account — including one more privileged than their own —
   and use it themselves without the target's mailbox ever being involved, while
   the audit row said only that a reset was "issued". The link is a credential;
   it goes to the mailbox, not to the person who pressed the button. If email is
   down, fix the channel (the response says which one) — do not route a
   credential through an admin.

Rate-limited on the TARGET, because an admin button that sends mail to a
colleague is also a way to spam that colleague.
