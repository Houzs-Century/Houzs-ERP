> ## Corrections — 2026-08-12 code-read sweep
>
> 1. POST /invite (:936) and PATCH /:id (:1420) are requirePermissionOrSalesDirector — a Sales Director holding NEITHER verb can invite into and edit within their own department (dept-scope enforced in-handler); the carve-out is not read-only.
> 2. Impersonate is NOT staging-only: users.ts:2031 registers an owner-wildcard-only handler with NO environment check (works in prod, 1h session); the IMPERSONATION_ENABLED staging door at :2272 is unreachable dead code behind it.
> 3. GET /api/presence is its own router (routes/presence.ts, mounted index.ts:345), not part of users.ts.
> 4. UNKNOWN worth a live-DB check: users.ts:1878/:1927 reference trigger trg_sync_user_to_tms on public.users which NO migration in either tree creates — a hand-applied prod object, or dead code.

# Module: Team — Members & Invitations

> ## 2026-08-22 — Team redesign (design handoff) + editable capability matrix
>
> The Team strip was rebuilt per the 2026-08 design handoff. New screens live in
> `frontend/src/pages/team/` and mount as new `?tab=` values on the same
> `/team` route (`frontend/src/pages/Team.tsx` shell):
>
> * `directory` → `frontend/src/pages/team/TeamDirectory.tsx` — the redesigned
>   member home: department tree rail (Team = `users.division`), scoped roster
>   table, dark bulk bar (dept / team / manager / position / resend / status).
>   Derived data the schema does not carry: department LEAD is inferred from
>   reporting lines (`teamShared.deriveDeptLead`), the EMP id is derived from
>   the user id (`teamShared.empCode`, same formula as the scm.staff trigger).
> * `orgchart2` → `TeamOrgChartV2.tsx` — company lanes + department pills;
>   outsourced teams are excluded by owner ruling (`isOutsourced`).
> * `departments2` → `TeamDepartmentsV2.tsx`, `mail2` → `TeamMailboxesV2.tsx`
>   (Mail Center reskin with derived personal/department/orphaned types).
> * `permissions` → `TeamRolesV2.tsx` — the EDITABLE position-capability
>   matrix (owner 2026-08-22: "要界面可编辑"). Grants are rows in
>   `position_capabilities` (PG mig 0322, D1 mirror 150); the catalogue + the
>   fail-closed gate live in `backend/src/services/positionCapabilities.ts`;
>   the API is `backend/src/routes/position-capabilities.ts`, mounted at
>   `/api/position-capabilities` in `backend/src/index.ts` (GET rides
>   `users.read`, PUT requires `roles.manage`, every change audited).
>   Enforcement of the four keys (scm.do.load / .dispatch / .revert /
>   scm.invoice.issue) arrives with the warehouse-line PR; until then the
>   matrix is declared intent, and the screen's footer note says so.
>   **Extended same day to 全部 SCM 模块**: the screen's SCM tabs (Sales /
>   Procurement / Consignment / Transportation / Warehouse / Finance) edit
>   page-access LEVELS per position. The code policy stays the BASELINE;
>   an edited cell stores a row in `position_page_overrides` (PG mig 0323,
>   D1 mirror 151; service `backend/src/services/positionPageOverrides.ts`,
>   `PUT /api/position-capabilities/:id/pages`). Overrides compose over the
>   resolved policy at session hydration (`services/auth.ts` — applied after
>   the sales-JD caps, and any override flips `scm_l2_configured` on so the
>   SCM area guard enforces the composed map), and they ride the authz
>   fingerprint (envelope v2) so a matrix edit busts cached sessions on the
>   next request. Valid targets are the catalogue-derived SCM LEAF keys —
>   exactly what `scmAreaGuard` reads; god positions are refused (wildcard
>   bypasses the guard). Pinned by `backend/tests/positionPageOverrides.test.ts`.
> * Member profile / invite: `TeamMemberProfile.tsx` (drawer, inline
>   assignment editing, activity log) and `TeamInviteModal.tsx` (assignment +
>   position set before send; company toggle chips).
>
> The CLASSIC tabs (`members` / `orgchart` / `departments` / `mail` / `roles`)
> left the strip but stay URL-reachable during the transition; the sections
> below describe that classic Members surface, which is unchanged. The mobile
> menu rows and route mapping (`frontend/src/mobile/MobileApp.tsx`) follow the
> new NAV_TABS destinations (`?tab=directory` / `?tab=departments2`, legacy
> values still accepted) but still open the classic mobile modules
> (`frontend/src/mobile/mobileMenuGates.test.ts` pins the exact gates) until
> the handoff's mobile pass.

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
| Invite modal | `frontend/src/pages/team/TeamInviteModal.tsx` | Single + **Bulk paste** modes (owner 2026-08-26). Bulk (`parseBulkEmails` + `sendBulk`) pastes many emails, shares ONE assignment, and loops the SAME `POST /api/users/invite` — no bulk endpoint; per-email failures are collected, not fatal; per-person fields (name / phone / password / POS PIN) are single-only. "Import from AutoCount" stays a disabled placeholder (no employee pipeline yet). |
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
| GET | `/api/users/:id/profile-pic` | Streams the member's avatar bytes from R2. Sends `X-Content-Type-Options: nosniff` (PR #2522) so the server-derived content-type cannot be MIME-sniffed into html/svg — parity with `mail-center.ts`'s INLINE_SAFE serve. Cache-control is `avatarCacheControl(?k, key)`. |

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

## 2a. A department's lead + headcount are REAL fields now (mig-pg 0331)

The Team redesign rendered a department's lead and its "N / target" headcount,
but neither was in the schema: the lead was DERIVED from reporting lines
(`teamShared.deriveDeptLead`) and the target did not exist (the design's "/45"
was a placeholder). Owner 2026-08-26 made both real:
`backend/src/db/schema.pg.ts` gains `departments.lead_user_id` (FK `users`,
`ON DELETE SET NULL`) and `departments.headcount_target`
(`backend/src/db/migrations-pg/0331_departments_lead_and_headcount.sql`, D1
mirror `152`). `backend/src/routes/departments.ts` exposes both on GET and
accepts them on PATCH (lead must be a known user or `null`; target a
non-negative int or `null`).

**The derived lead did not go away — it became the FALLBACK.** The one
chokepoint is `frontend/src/pages/team/teamShared.tsx`'s `buildDeptNodes`: the
chosen `lead_user_id` wins, falling back to `deriveDeptLead` when none is set OR
when the chosen person has left the roster (so a stale id never shows a ghost).
Every screen that reads a `DeptNode` inherits this in one place; the new
`DeptNode.leadIsChosen` flag lets a card mark a still-derived lead "derived".
`frontend/src/pages/team/TeamDepartmentsV2.tsx` adds the Leadership panel (a lead
dropdown of the department's own members + a headcount input) on edit, and the
card shows `active / target` when a target is set.

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
- **A targeting edit busts the member's announcements banner cache.** The banner
  filters by department_id / position_id / company grants, and its per-user KV
  snapshot lives 300s (> the 60s poll), so PATCH `/:id` (when it changes
  department / position / role / status / department_ids / company_ids, and —
  since announcements can target a division, mig 20260906T0639 — `division`), PUT
  `/:id/companies`, and DELETE `/:id` all call `bustBannerForUser` (both scopes);
  a department DELETE (`routes/departments.ts`) bumps the banner family version
  because it un-assigns an unknown set of members at once. Session bust alone did
  NOT cover this — it fires only on disable / role change. See the announcements
  guide §6 and `configCache.ts`.
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

**`main.tsx` also chooses the PUBLIC surfaces, and gained one on 2026-08-26.**
`appSurfaceForPath` (`frontend/src/routing/appSurface.ts`) decides which tree
boots for a location, and the ones it sends OUTSIDE `AuthGate` are the app's
whole no-login surface: `/survey/:token`, `/track` + `/portal/*`,
`/reset/:token`, `/invite/:token`, `/privacy`, **`/d/:token`** — the printed
delivery-order QR (`frontend/src/pages/PublicDoScan.tsx`) — and, since
2026-08-27, **`/d/scan`**, the pile scanner
(`frontend/src/pages/PublicDoScanBasket.tsx`). Since 2026-09-03 the list also
carries **`/c/:token`** — a booth contractor's own confirmed calendar
(`frontend/src/pages/ContractorCalendar.tsx`), same no-login token rule, served
by `backend/src/routes/publicContractorCalendar.ts` mounted before the auth gate
in `index.ts`; see `docs/modules/projects-pms.md` for the token lifecycle. The QR
one is the owner's decision: the driver has no account, so the token printed on
the paper is the credential. It is 10 characters since 2026-08-27 — the length is a print setting,
see `docs/bugs/0552-…` — and the 64-hex form on every sheet already printed still
resolves.

**`/d/scan` IS DECIDED BEFORE THE TOKEN BRANCH**, and that ordering is the whole
of its correctness: `startsWith("/d/")` would otherwise classify it as a token
named `scan`, and the storekeeper would get "unknown or expired QR code" for a
page that exists. A real token cannot collide — 10 or 64 characters from a fixed
alphabet — but the specific path is still matched first rather than relying on
that. `appSurface.test.tsx` pins both. The same trap and the same fix live in the
backend's `/batch/*` routes.

**It is a page and not a button on `/d/:token`**, deliberately: that screen
offers exactly ONE button (the next rung, never a choice) and offers NO BUTTON AT
ALL when the document is held or cancelled. Both are older than the scanner and
both have tests, so the basket moved rather than the guarantees loosening. The
delivery-order page carries a text LINK to it instead, and not at all when the
document is blocked. Adding a surface here means adding a way in that
no session guards, so the list is worth reading before extending it; the backend
half of the same decision is the mount ORDER in `backend/src/index.ts` (before
`app.use("/api/*", auth)`). See `docs/modules/delivery-order.md` and
`docs/bugs/0544-the-qr-printed-for-the-driver-opened-a-page-only-the-office.md`.

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

## 6. POS Access — the 2990 tablet PIN is issued from the member profile (2026-08-24)

A 2990's Home salesperson does not sign into the showroom tablet with a
password. The tablet shows a name picker and a 6-digit keypad, so **the PIN IS
the credential**, and until it exists that member cannot start a shift no matter
how correct the rest of their account is.

**Where it lives on screen.** A POS Access card on the redesigned member profile
(`frontend/src/pages/team/PosPinCard.tsx`), rendered inside *Details &
Assignment* and **only** when the assignment currently on screen satisfies both
halves of `showsPosPinCard` (`frontend/src/pages/team/posPinEligibility.ts`):

* the member holds the company whose code is `2990` (mig 0083 seeds that code;
  the id differs between prod and a fresh database, so the rule matches on CODE
  and a hard-coded id is a bug), **and**
* their position slug starts with `sales` — `sales_executive` is the common one.

The same module gates the 6-digit field on `TeamInviteModal.tsx`, so the two
screens cannot drift apart. The card also opens its own entry box straight after
the save that FIRST made a member eligible: the classic screen had a working
"Set PIN" button that nobody knew to press, which is how a salesperson with
2990 access and no credential reached the owner as a bug report. That button
survives on the member panel (`Team.tsx` `setPosPin`) and collects the PIN
through the in-app `useDialog().prompt` — a naked `window.prompt` until
2026-08-25 (`docs/bugs/0539-the-last-two-naked-prompts-2fa-disable-and-pos-pin-entry-spo.md`); the `/^\d{6}$/` check and the
`admin-set-pin` POST are unchanged.

**The four conditions the tablet actually applies.** `GET /api/pos/sales-staff`
lists a member only when all of these hold, and the profile can see only the
first two — the other two come from `GET /api/pos/admin-pin-status/:userId`:

| condition | who knows it |
| --- | --- |
| member holds the tablet's company (`public.user_companies`) | the profile |
| position slug `LIKE 'sales%'` | the profile |
| an `scm.staff` row exists for the user (`uq_staff_user_id`, mig 0066) | the status endpoint |
| that row is `active` | the status endpoint |

**API surface** (`backend/src/routes/pos.ts`, all three `users.manage`):

| route | does |
| --- | --- |
| `POST /api/pos/admin-set-pin/:userId` | issue or replace the PIN (hashed server-side) |
| `POST /api/pos/admin-reset-pin/:userId` | clear it |
| `GET /api/pos/admin-pin-status/:userId` | has-PIN + readiness. **Never returns the hash** |

### The POS My-Orders tiles — what the three revenue rows mean

`GET /api/pos/sales-stats` (same file) feeds the two cards on the POS home
board. Each card carries a headline total plus three rows, and they sum to it:

| row | is |
| --- | --- |
| Products sales revenue | goods **minus** the item-KPI portion — the commission threshold base |
| Service sales revenue | total − goods (delivery + every SERVICE line) |
| KPI item sales revenue | the item-KPI-flagged portion of goods |

**KPI is carved OUT of Products, not added on top.** A flagged item earns a
fixed bonus INSTEAD of percentage commission (`scm/shared/hr-commission.ts`), so
leaving it in Products would pay for it twice. The split and its clamps live in
`scm/lib/pos-kpi-split.ts`; the flags come from `scm.hr_item_kpi` through
`scm/lib/kpi-units.ts` — the SAME loader `/hr/commission` reads, so the
dashboard and the commission run cannot disagree.

**Which scope the Showroom card counts** depends on the caller: staff WITH a
`showroom_id` get their showroom mates, staff without one (director / owner /
coordinator) get the whole company. The response says which in `showroomScope`,
and the POS labels the tile from it — so a director reading company-wide figures
under the word "Showroom" is a bug that has already been fixed once. Two people
sharing a `showroom_id` always see identical Showroom figures; if they don't,
the question is their `scm.staff.showroom_id`, not the query.

⚠️ **A KPI row of RM 0 means "nothing is flagged", not "not built".** It was
hardcoded `kpi: 0` until 2026-08-26 behind a comment claiming the HR commission
machinery had no Houzs home — untrue since `hr.ts` and `lib/kpi-units.ts` were
ported. Items are flagged in **HR Settings** (`hr.ts` `/item-kpi`, UI
`frontend/src/pages/scm-v2/HrSettings.tsx`); with `scm.hr_item_kpi` empty for a
company, every card in that company correctly reads RM 0.

**Traps this section exists for.**

1. **A PIN on a non-sales title is a credential that can never sign in.**
   `/pin-login` refuses it with `not_pos_role` (403), which the tablet renders as
   a wrong PIN — so the member looks forgetful and nobody looks at the title.
   Both writers refuse it up front now (`posPinWriteRefusal` in
   `backend/src/services/posPin.ts`); `admin-set-pin` did not until 2026-08-24.
2. **A failed status READ must never render as "no PIN".** That would invite an
   admin to overwrite a working credential they could not see. The card says the
   check failed and offers no box.
3. **Eligibility is read off the DRAFT, the write off the SAVED row.** The PIN
   endpoints key on `public.users.id` and resolve `scm.staff` server-side, so a
   combination that exists only in an unsaved draft cannot take a PIN — the card
   says so rather than failing a write the admin cannot diagnose.

## Staff pickers are company-scoped, and there are THREE of them (2026-08-18)

`scm.staff` has no `company_id` (mig 0089 lists it as shared reference data), so
a staff row's company is DERIVED from that person's Team grants —
`backend/src/scm/lib/staffCompanyScope.ts`. The applied pass,
`scopeStaffRowsToActiveCompany`, used to be a file-local function in
`scm/routes/staff.ts`, which is why `scm/routes/hr.ts` `GET /pickers` never used
it and returned every active staff row platform-wide while its four siblings in
the same query batch were each company-scoped. It now lives in the lib and all
three pickers go through it: `GET /staff`, `GET /staff/pickable`, `GET /hr/pickers`.

A caller of the pass must SELECT `user_id`: it is the link the derivation reads,
and a row without it is treated as UNLINKED and attributed to the 2990 mirror
source.

`GET /staff/by-ids` stays deliberately unscoped — the caller must already hold
the ids, so it cannot enumerate — but note it returns email and phone, which is
why an unscoped LIST endpoint beside it was a full directory disclosure.

### `GET /staff/pickable` ALWAYS holds the caller, and whatever you name in `?include=` (2026-08-21)

Route: `backend/src/scm/routes/staff.ts`.

`?onlySales=1` narrows the roster to Sales positions / departments (owner
2026-07-22 — keep office, admin, owner and test accounts out of the SALESPERSON
dropdown). That narrowing is unchanged. What is new is that the answer also
carries two id sets the narrowing may never remove:

| set | how | why |
| --- | --- | --- |
| the CALLER's own ACTIVE staff row | automatic — nothing to pass, matched on `staff.user_id` against `c.get('houzsUser').id` | a screen must always be able to resolve the person standing on it to a REAL employee. Without it `SalesOrderNew` synthesized a `__self__` option labelled "<name> (me)" and the Payments "Collected By" default fell to blank |
| `?include=<uuid>,<uuid>,…` | the caller passes the ids the screen already has to NAME — in practice the one `salesperson_id` stored on the document being shown | without it seven pickers labelled a sitting employee "(former staff)" |

Both defeat `onlySales` **only**. Neither resurrects a deactivated row and
neither survives the fail-closed branch (an unresolved active company still
answers `[]`), so `(former staff)` still means the row is genuinely gone.
`include` cannot enumerate — it answers exactly the ids handed to it — which
makes it strictly narrower than `GET /staff/by-ids` above. Capped at 50 ids;
past that the endpoint answers **400 `too_many_include_ids`** rather than
truncating, because a truncated include IS the bug it exists to fix.

Rule and cap live in `backend/src/scm/lib/staffCompanyScope.ts`
(`alwaysPickableStaffIds`, `unionAlwaysPickable`, `parseIncludeIds`), beside the
company derivation, and every exit from the handler goes through one `answer()`
helper so a future narrowing branch cannot forget them —
`backend/tests/staffPickableAlwaysHolds.test.ts` pins that structurally. The
frontend entry point is `usePickableStaff({ onlySales, include })`
(`frontend/src/vendor/scm/lib/admin-queries.ts`); `include` is part of the
query key. Full trace:
`docs/bugs/0504-the-salesperson-picker-hid-the-person-using-it-so-the-so-sai.md`.

`PATCH /staff/by-user/:userId/showroom` now proves the TARGET PERSON is in the
caller's company before writing. The warehouse half was already scoped; the write
keys on `user_id` alone because there is no `company_id` on `scm.staff` to
predicate on, so the membership check is what bounds it. An UNPARK sends no
warehouse at all, so the warehouse check could never have stood in for this.

## Taking over an account — the actor's grants are the boundary

`POST /:id/impersonate`, `POST /:id/reset-password` and `POST /:id/totp/disable`
all hand the caller control of someone else's account. Until 2026-08-19 they
resolved the target with `.where(eq(users.id, id))` and nothing else, and
`users.manage` is a flat permission with no company dimension — so holding it
anywhere held it everywhere.

**Owner decision 2026-08-19**, in his words:

> 我们的 team 那边是有得选这一个人是负责什么公司的。所以，如果他只是在同一间公司，
> 肯定就是限制；如果他是两间公司，那基本上就是我们换 organization 的时候，他是没有
> 限制。以 RBAC 这样子去做限制的

So the predicate is the **actor's `allowedCompanyIds`** — the grants this very
screen edits — and never the active company. Gating on the top-bar switcher would
break a two-company admin doing something they are already entitled to do.

`targetWithinActorCompanies()` requires the target's companies to be a **subset**
of the actor's. Holding `{1}` and taking over someone in `{1,2}` would be a
promotion. This is the same rule `PUT /:id/companies` twenty lines up already
enforces: *a grantor can only ever pass on what they hold.*

**Two edges are deliberate:**

| state | behaviour | why |
| --- | --- | --- |
| `allowedCompanyIds` is `undefined` | falls through | the company context could not be READ (pre-migration, cold start). Refusing there locks every admin out of a routine action, and that is the failure nobody reports. |
| the TARGET holds no grants | **refuses** | looks backwards until you read `companyContext`: it hands a grant-less user *every active company*, so taking them over is the **widest** reach available, not the safest. |

`/:id/impersonate` is registered **twice**; the second is dead (Hono keeps the
first, and the file says so at that line). The gate is on the live one.

