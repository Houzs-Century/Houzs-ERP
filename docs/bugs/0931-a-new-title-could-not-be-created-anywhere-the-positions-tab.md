## A new Title could not be created anywhere: the Positions tab was switched off on every surface [medium]

<!-- area: Auth, permissions, sessions -->

**Symptom.** Owner 2026-09-14, the same report as 0923: 「我加了新的role 但是title没有」.
Wanting a Title "PG WH Assistant" for the Penang warehouse account he had just
created, he found no screen that makes one. Team's strip offered Directory, Org
Chart, Departments, Mailboxes and Roles & Permissions; the profile's Title picker
answered `No match for "PG"`; so he created a role of that name instead, which
lives in a different list (0923). Read-only on production (`anogrigyjbduyzclzjgn`,
2026-09-15): `positions` holds no "PG WH Assistant"; the account (#151, created
2026-09-14T08:57Z) carries Title "Warehouse Crew KL", role "Position Preview" and
division "PG WH Assistant"; role #337 "PG WH Assistant" (created 09:32Z, 4 read
permissions, 4 pages) is held by nobody.

**Root cause (traced).** #740 pulled the Positions tab from the Team strip, and
#744 (owner: 「整個關掉先」) forced `canViewTab.positions` to `false` in
`frontend/src/pages/Team.tsx`, so `/team?tab=positions` fell through to the
first visible tab and `PositionsTab` (`frontend/src/pages/Positions.tsx`) never
mounted. The phone keeps Positions out of every menu row and route gate
(`frontend/src/mobile/MobileApp.tsx`, pinned by `mobileMenuGates.test.ts`:
"owner-managed through backend/tooling only"). The reason for the switch-off was
the tab's page-access matrix, whose writes `services/auth.ts` no longer read; the
matrix was later replaced by a read-only note and `PATCH
/api/positions/:id/page-access` answers 409 without writing. Creating, renaming,
moving and deleting a Title (`POST` / `PATCH` / `DELETE /api/positions`,
`users.manage`) kept working and had no screen. The owner's decision on
2026-09-15 was to reopen the page for admins (option 2 of three offered: keep the
KL title, reopen the page, or seed the title by script).

**Fix.** `Team.tsx` lists the tab in the strip again as **Titles** (the name the
profile's picker uses) for `users.manage`, and `canViewTab.positions` is
`canManageUsers`, the one-line restore the previous comment described. Nothing
about access changes: the page-access writer stays disabled and the tab's matrix
stays a read-only note; page access per Title is edited on Roles & Permissions.
The phone stays as it was: its Positions module exists (`FORM_POSITIONS`) but is
not in the menu, and the gate test still pins that. Pinned by
`frontend/src/pages/teamTitlesTab.test.tsx`: the strip shows Titles to a
`users.manage` caller and not to a `users.read`-only one, and `?tab=positions`
mounts the Positions page for the former and falls through for the latter.
Proved RED against `main`'s `Team.tsx`: the `users.manage` case failed (no
Titles button); the read-only case passes on both trees, as it should.

**Ref.** fix/team-positions-tab-reopened, 2026-09-15.
