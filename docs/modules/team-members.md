# Team — Members & Invitations

The System > Team > Members surface: the member list, lifecycle actions
(invite, edit, enable/disable, resend, revoke, reset-password, impersonate),
the pending-invitations queue, POS PIN issuance, and company-scoped staff
pickers. Used by anyone holding `users.read`/`.manage`, plus a scoped
Sales-Director carve-out for their own department.

## Statuses and flow

- `users.status`: only invite sets `invited`; `PATCH /:id` may only move it to
  `active` or `disabled` — never back to `invited`, and an edit never
  re-sends the invite.
- Invitation rows: `pending` → `accepted` (`accepted_at` set) or **revoked**
  (row deleted, and its placeholder user deleted with it). "Expiring soon
  (<2d)" / "Expired" are computed client-side from `expires_at`
  (`frontend/src/lib/invitations.ts`, shared desktop/mobile).
- A pending person exists **twice**: a `status='invited'` user row and an
  `invitations` row. The stat card counts the former; the Pending
  Invitations table lists the latter (expired rows included) — counts can
  legitimately differ.

## Permissions

- `users.read` (or the Sales-Director carve-out) — see the lists.
- `users.manage` — every mutation: invite, edit (incl. enable/disable),
  resend, revoke, reset-password, impersonate/totp actions, department lead
  + headcount, Titles (positions) CRUD, role assignment.
- `roles.manage` — `PUT /api/position-capabilities` (the page-access
  matrix), a separate key from `users.manage`.
- **Invite carries a Role** (`POST /api/users/invite` `role_id`, required): the
  desktop modal's Role select (default `defaultRoleId` = the baseline role, the
  0-key placeholder) and the phone form's Role field both post it. Accepting
  the invite (`POST /api/auth/accept-invite`) keeps whatever Role an admin set
  on the profile in the meantime; the invitation's role fills in only if the
  placeholder row has none.
- **Scoped Sales Director** (`requirePermissionOrSalesDirector`): may invite
  into and edit within their OWN department without `users.manage`. An
  invite from this caller always gets the **baseline role**
  (`resolveDefaultRoleId`) regardless of what is posted; an edit from this
  caller is filtered server-side to name/phone/status/status_reason/division
  only — `role_id`, `position_id`, `department_id(s)`, `manager_id`,
  `company_ids`, `password`, `email`, `email_alias` are stripped even if the
  form sends them. Desktop and mobile must read the identical field list
  from one place (`memberEditFormFor` / `editMemberScope.tsx`).
- **Title gates menus, Role gates permissions** — they are different
  columns (`position_id` vs `role_id`); a role created in Roles &
  Permissions never appears under the Title picker. What a Title opens is its
  `position_policy` row (Roles & Permissions › **Titles**: cohort god / full /
  restricted / sales, profile, money / config / fleet); a new Title has no row
  and follows its name (an unknown name is full) until it is set there.
  Renaming a Title no longer changes anyone's access once its row exists.

## Rules that must not break

- Invite links (`token` / `invite_url`) are live credentials — never give
  them a `getValue` (CSV export), never render them on screen; Copy Link
  goes straight to the clipboard.
- Reset-password does **not** touch the account (hash, status, live
  sessions all unchanged) until the link is actually redeemed — do not
  reintroduce deleting the target's sessions on send, and never return the
  token/link to the admin (both were deliberately removed; returning the
  token was a silent account-takeover primitive).
- `POST /:id/impersonate` is registered **twice** on the same router; only
  the FIRST registration (wildcard-only, always a 1-hour session, reachable
  in prod) actually runs — the second (staging-flag door, 7-day session) is
  dead code and must stay dead until the owner explicitly picks a door.
  Deleting either registration is a security decision, not a cleanup.
- Account-takeover actions (`impersonate`, `reset-password`,
  `totp/disable`) must require the target's companies to be a **subset** of
  the actor's `allowedCompanyIds`. An unresolved actor scope (`undefined`)
  falls through as allowed (cold start); a target holding **no** grants is
  refused (a grant-less user's implicit "every active company" makes them
  the widest reach available, not the safest).
- Writing `users.name` or `users.status` fires an `AFTER` trigger into
  `scm.staff` in the **same statement** — an exception there rolls back the
  `users` write too, and the operator only sees a generic 500. Check the
  trigger's effect before trusting that 500 points at the route you changed.
- A PATCH from a scoped Sales Director must filter to the allowed field list
  **server-side** — hiding a field client-side is not enough; both mobile
  and the classic desktop panel have separately shipped this gap.
- Staff pickers (`GET /staff`, `/staff/pickable`, `/hr/pickers`) must all
  resolve company through the shared `staffCompanyScope` lib — `scm.staff`
  has no `company_id` of its own, it is derived from Team grants.
  `/staff/pickable` must always include the caller's own active row plus any
  `?include=` ids regardless of `onlySales` narrowing, capped at 50 ids (400
  over the cap — never silently truncated).
- `PATCH /staff/by-user/:userId/showroom` must verify the **target** is in
  the caller's company before writing — there is no `company_id` column on
  `scm.staff` to filter the write on directly.
- A PIN on a non-sales title must be refused up front by **both** PIN
  writers (`posPinWriteRefusal`) — otherwise it "saves" but the tablet login
  reads it as a permanently wrong PIN. A failed PIN-status read must never
  render as "no PIN" — that invites overwriting a working credential blind.
- A targeting PATCH (department/position/role/status/department_ids/
  company_ids/division) must bust the member's announcement banner cache
  (`bustBannerForUser`) — a session bust alone does not cover it.

## Gotchas

- Both desktop and mobile invite/edit forms must change together in the
  same PR (`MobileModuleList` config, `member-invite-form.ts`,
  `MemberActions`) — mobile has repeatedly shipped a stale copy after a
  desktop-only fix (a blank-vs-`invited` seed bug, a Sales-Director field
  leak).
- The classic (`?tab=members`) and redesigned (`?tab=directory`) Team
  screens currently coexist — a scoping/permission fix must land on **both**;
  the classic panel independently shipped the same Sales-Director field leak
  after the redesign was already fixed.
- `/api/users` is one unbounded fetch — every filter, count and search on
  the list is computed client-side; there is no server pager to lean on.
- Impersonation is registered twice in `users.ts` — always confirm which
  registration Hono actually dispatches (the first) before changing either.

## Where the code is

- `backend/src/routes/users.ts` — member list, invite, edit,
  reset-password, impersonate (both registrations).
- `frontend/src/pages/Team.tsx` — classic Members tab + shell.
- `frontend/src/pages/team/TeamDirectory.tsx`,
  `frontend/src/pages/team/TeamInviteModal.tsx` — redesigned directory +
  invite modal.
- `frontend/src/pages/team/PosPinCard.tsx`,
  `frontend/src/pages/team/posPinEligibility.ts` — POS PIN card + gating.
- `frontend/src/mobile/MobileInvitations.tsx`,
  `frontend/src/mobile/MobileModuleList.tsx` — mobile invitations + member
  list.
- `frontend/src/mobile/member-invite-form.ts` — the shared scoped-caller
  field-list rule.
- `backend/src/routes/pos.ts` — POS PIN issue/reset/status routes.
- `backend/src/scm/lib/staffCompanyScope.ts` — staff-picker company
  derivation.
- `backend/src/routes/departments.ts` — department lead/headcount/code.
- `backend/src/routes/position-capabilities.ts`,
  `backend/src/services/positionCapabilities.ts`,
  `backend/src/services/positionPageOverrides.ts` — the page-access matrix.
- `frontend/src/pages/Positions.tsx` — Titles tab.
- `frontend/src/pages/Roles.tsx` — Roles editor.
