## A Sales Director could invite a new account straight into Super Admin [high]

<!-- area: Auth, permissions, sessions -->

**Symptom.** Found by the 2026-09-14 phone-vs-desktop permission audit, not
reported by staff. On the phone, Profile > Directory > "+" opens the Member
invite form with a required **Role** picker listing every role, Super Admin and
Owner included. A Sales Director (a department-scoped Team admin, no
`users.manage`) can fill it in. The desktop invite for the same person has no
Role picker.

**Root cause (traced).** `POST /api/users/invite` admits a Sales Director
(`requirePermissionOrSalesDirector("users.manage")`). Its scoped branch forced
the department and checked the position, but set the baseline role only
`if (!body.role_id)` — a role the client DID send was looked up for existence
and written to `users.role_id` and `invitations.role_id` unchanged
(`backend/src/routes/users.ts`, invite handler). `GET /api/roles` admits a Sales
Director precisely so that picker can load (`routes/roles.ts`, whose own
comment says a scoped invite "forces a baseline role server-side … regardless
of what the picker sends" — it did not). `PATCH /:id` already deleted
`role_id` for the same caller; the invite was the half that was missed. The
invite also accepts `password`, which activates the account at once, so no
admin ever sees the new member before it can sign in.

Read in code only; not exercised against production. Who could use it, from
the read-only role diagnostic run 34817494633 (2026-09-14): two active users
hold the Sales Director position.

**Fix.** A scoped invite now ALWAYS stores the baseline role
(`resolveDefaultRoleId`), whatever it carries — create and re-invite alike.
The phone form drops its Role field for a scoped Sales Director
(`frontend/src/mobile/member-invite-form.ts`), so it no longer offers a choice
the save ignores. Pinned by `backend/tests/salesDirectorInviteRole.test.ts`
(source test — the handler is Drizzle/Postgres and cannot run in the suite),
proved RED on the unfixed tree (1 of 6 failed: the conditional on the client's
`role_id`), and by `frontend/src/mobile/member-invite-form.test.ts`.

Not changed here, and worth a separate look: whether any account was already
created this way — every invite writes an `audit_events` row (`user.invite` /
`user.create`) naming the actor and the role.

**Ref.** fix/sd-invite-forces-baseline-role, 2026-09-14.
