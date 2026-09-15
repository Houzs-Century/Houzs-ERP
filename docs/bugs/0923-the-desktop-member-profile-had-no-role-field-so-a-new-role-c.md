## The desktop member profile had no Role field, so a new role could not be given to anyone from a computer [medium]

<!-- area: Auth, permissions, sessions -->

**Symptom.** Owner 2026-09-14, with screenshots of Team > Roles & Permissions and a
member's profile: 「我加了新的role 但是title没有」. He created the role
"PG WH Assistant", then looked for it on a member's profile, where the nearest
picker, Title, answered `No match for "PG"`. Read-only on production
(`anogrigyjbduyzclzjgn`, 2026-09-15T06:22Z): role #337 "PG WH Assistant" was created
2026-09-14T09:32:01Z and is held by 0 accounts; since its creation no audit row sets
any account's `role_id`, and the warehouse account's one edit that day (09:38:40Z)
changed only `division`.

**Root cause (traced).** Title and Role are two separate lists: Title is
`users.position_id` (the pages a member sees), Role is `users.role_id` (what they
may do). A role created in Roles & Permissions is a `roles` row, so it can never
appear under Title. The picker that sets a role existed on the phone's member form
(`FORM_MEMBERS_EDIT` in `frontend/src/mobile/MobileModuleList.tsx`) and on the classic
desktop edit panel (`EditMemberPanel` in `frontend/src/pages/Team.tsx`, re-added by
the owner 2026-07-20). The Team redesign (#2650, 2026-08-22) made the Directory the
strip's member home, and the Directory opens
`frontend/src/pages/team/TeamMemberProfile.tsx`, whose assignment draft held
`department_id`, `division`, `position_id`, `manager_id` and `company_ids` but no
`role_id`; the classic Members tab left the strip and is reachable only by typing
`?tab=members`. From 2026-08-22 a computer therefore offered no way to change a
member's role. `PATCH /api/users/:id` always accepted `role_id` from a
`users.manage` caller, so nothing was wrong on the server.

**Fix.** The profile's Assignment section gains a Role picker beside Title: every
role by name (`roleOptions` in `frontend/src/pages/team/teamShared.tsx`, which keeps
the member's own role when the list lacks it), saved in the same PATCH as the other
fields and sent only when it changed. It is locked for a viewer without
`users.manage` (the Directory already passes `canManage` false to a department-scoped
Sales Director, whose PATCH strips `role_id`) and while no role list is loaded.
Pinned by `frontend/src/pages/team/TeamMemberProfile.test.tsx`: its four Role tests
(names the current role, a picked role saves as `{ role_id }` alone, locked without
`users.manage`, locked with no role list) were proved RED against `main`'s
`TeamMemberProfile.tsx`, and "an edit that leaves the role alone does not send one"
guards the other direction.

**Ref.** `feat/desktop-member-role-picker`, 2026-09-15.
