## A Sales Director's desktop classic Edit Member panel offered fields and actions their save strips or refuses [medium]

<!-- area: Auth, permissions, sessions -->

**Symptom.** Found 2026-09-15 while fixing the phone half
(`docs/bugs/0924-a-sales-director-s-phone-edit-of-a-member-s-role-department.md`
flags this as the desktop remainder), not reported by staff. On the classic
desktop Members tab (`/team?tab=members`, reachable only by typing the address
since the Team redesign), a department-scoped Sales Director (the Sales Director
position without `users.manage`) opens Edit on a member of their department.
The panel offers Email, Email Alias, Primary department, Also in, Position,
Role, Company, Reports to and Set password, plus Change photo, a Sales venue
section, Send password reset link, Resend invitation and Delete permanently.
Changing any of those fields and pressing Save Changes shows "Saved <name>" and
the member is unchanged. Change photo, the showroom parking, the reset link,
the resend and the delete are refused by the server, because each needs
`users.manage`. The redesigned member profile shows the same caller those
fields locked, so the two desktop screens disagreed about what they may edit.

**Root cause (traced).**

1. `MembersTab` (`frontend/src/pages/Team.tsx`) already received
   `salesDirScoped` and used it to show the Edit button, but never passed it to
   `EditMemberPanel`. The panel rendered every field and every account action
   for every caller.
2. The panel's save diffs normalised state against the stored member and sends
   every changed key in one `PATCH /api/users/:id`. A key the caller never saw
   can be in that body: a stored alias of `""` goes out as `null`.
3. `PATCH /api/users/:id` (`backend/src/routes/users.ts`, the
   `salesDirectorScope(c, "users.manage").scoped` branch, "STRIP (not 403)")
   deletes `role_id`, `position_id`, `department_id`, `department_ids`,
   `manager_id`, `company_ids`, `password`, `email` and `email_alias` and
   answers `{ ok: true }` as long as anything remains, so the panel reported
   "Saved" for a body it had mostly discarded.
4. The photo upload, showroom parking, reset link, resend invite and delete
   endpoints require `users.manage`, so those actions could only be refused
   for that caller.

How it was observed: read on this branch, built on #3933. The new test renders
the real `EditMemberPanel` in jsdom with `api` faked and asserts on the PATCH
body; the branch was also opened in the browser with a seeded render of the
panel as a scoped Sales Director and as an admin (a throwaway harness, not
committed). Not exercised against production.

**Fix.** `frontend/src/pages/team/editMemberScope.tsx`: `editMemberOffers(write,
scoped)` answers whether the panel offers one write to this caller, using the
same `SCOPED_DIRECTOR_EDITABLE_MEMBER_FIELDS` list the phone form uses
(`frontend/src/mobile/member-invite-form.ts`, which
`member-invite-form.test.ts` derives from the handler). `EditMemberField` wraps
each field with its PATCH key; the photo, showroom section, reset link, resend
and delete are gated by name; `editMemberPatchFor` keeps only listed keys in a
scoped caller's body, so a hidden field whose stored value differs still stays
out. `Team.tsx` passes `salesDirScoped` into the panel. As with 0924, the rule
keeps listed keys rather than dropping stripped ones, so a field added to the
panel later stays hidden from that caller until the server applies it. A
scoped Sales Director now sees Name, Phone and Division, Save Changes, and
Enable/Disable; everyone else sees the panel unchanged.

Pinned by `frontend/src/pages/team/editMemberScope.test.tsx`: the real panel as
a scoped director offers only the applied fields and no photo, showroom, reset,
resend or delete; a Save sends only applied keys, and a differing hidden alias
stays out of the body; a full admin still gets every field and action and a
changed email still goes out; and `Team.tsx` hands `salesDirScoped` to both the
tab and the panel. Proved RED: with the offer rule disabled (every write
offered), the scoped-director tests fail on the offered Email field, the
offered Change photo button and a Save body carrying `email_alias: null`.

**Ref.** fix/team-classic-edit-member-scoped-director, 2026-09-15.
