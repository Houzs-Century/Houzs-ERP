## A Sales Director's phone edit of a member's role, department, title or email said saved and changed nothing [medium]

<!-- area: Auth, permissions, sessions -->

**Symptom.** Found 2026-09-15 by reading the phone's member forms after 0887,
not reported by staff. On the phone, Profile > Directory > a member > Edit shows
a Sales Director (a department-scoped Team admin, no `users.manage`) Role,
Department, Position and Email. Changing any of them and pressing Save Changes
returns to the list with no error, and the member is unchanged. The desktop
member profile shows the same person those fields locked.

Who can hit it, from the read-only Role permissions diag run 34942586162
(2026-09-15, on `main`): two active accounts hold the Sales Director position,
one on the "Sales Director" role (12 keys) and one on "Sales Director (Stock
Approver)" (15 keys); neither role grants `users.manage` or `*`, and the Sales
Director position adds no wildcard (`GOD_POSITIONS` in
`backend/src/services/positionPolicy.ts` is Super Admin, Owner, Managing
Director). Both are the scoped caller.

**Root cause (traced).**

1. The way in. The Directory nav leaf carries `showForSalesDirector`
   (`frontend/src/components/Sidebar.tsx`), which `makeNavVisible`
   (`frontend/src/components/navFilter.ts`) honours, so the phone's Profile row
   `/team?tab=directory` shows and opens the `members` module.
   `GET /api/users` admits the Sales Director for their own department.
2. The Edit button has no permission check: `MobileApp.tsx` passes `onEdit` to
   the detail of a member, and `MobileModuleDetail` offers it whenever the
   module's form has an `updatePath`, which `FORM_MEMBERS` does.
3. The line it goes wrong on: the `module-form` branch of
   `frontend/src/mobile/MobileApp.tsx` handed `FORM_MEMBERS_EDIT` to the form
   unfiltered for every caller. Only the invite went through
   `memberInviteFormFor`.
4. `MobileModuleForm` seeds every field from the row and `buildBody()` sends
   every filled one.
5. `PATCH /api/users/:id` (`backend/src/routes/users.ts`), for
   `salesDirectorScope(c, "users.manage").scoped`, deletes `role_id`,
   `position_id`, `department_id`, `department_ids`, `manager_id`,
   `company_ids`, `password`, `email` and `email_alias` ("STRIP (not 403)").
   Name, phone and status are still in the body, so the update is not empty and
   the handler answers `{ ok: true }`.

How it was observed: read on `main` at 4ad1be355. The handler cannot run in the
suite (Drizzle/Postgres, the reason 0887 gives), so the new contract test
derives the applied fields from its source — every `body.<field>` it reads,
minus every `delete body.<field>` in the scoped branch — and that gives name,
phone, status, status_reason and division. The phone half ran in a jsdom render
of the real `MobileModuleForm`: with no filtering, a scoped director's Save sent
`department_id`, `email`, `position_id` and `role_id` alongside name, phone and
status. Not exercised against production.

**Fix.** `memberEditFormFor(form, scopedSalesDirector)` in
`frontend/src/mobile/member-invite-form.ts`, beside `memberInviteFormFor`,
keeps only `SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS` for a scoped Sales
Director, so the phone form shows Name, Phone and Status. It keeps listed fields
rather than dropping stripped ones, so a field added to the form later stays
hidden from that caller until the server applies it. `MobileApp.tsx` computes
one `scopedSalesDirector` for both member forms, from the same two facts the
desktop `Team.tsx` uses for `salesDirScoped`.

Pinned by `frontend/src/mobile/member-invite-form.test.ts` (the helper; the list
equals what the handler applies; MobileApp routes both forms through the helpers
and never uses `FORM_MEMBERS_EDIT` unfiltered; the desktop decides "scoped" from
the same facts) and `frontend/src/mobile/mobileMemberEditScope.test.tsx` (the
real form: a scoped Save sends only name, phone and status; a full admin's still
sends role, department, position and email). Proved RED: against the unfixed
`MobileApp.tsx`, 4 of 22 failed (the four MobileApp pins; the unfiltered-use
test expected 1 filtered use and found 0); with the filter disabled, 6 failed,
including the Save test listing `department_id`, `email`, `position_id`,
`role_id`.

Not changed here, flagged as separate work: the classic desktop panel
(`/team?tab=members`, `EditMemberPanel` in `frontend/src/pages/Team.tsx`, now
reachable only by typing the address) offers a scoped Sales Director the same
stripped fields and reports "Saved"; and on the phone, saving an edit to an
invited member fails with "status must be active or disabled", because the form
sends the seeded `status: "invited"`.

**Ref.** fix/mobile-member-edit-scoped-director, 2026-09-15.
