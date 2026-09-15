## Two read-only permission diagnostics printed staff names into a public Actions log [medium]

**Symptom.** Seen while verifying docs/bugs/0894 on 2026-09-14: the *Diag role
permissions* workflow's log listed active staff by name beside their role and
position. The repository is public, so its Actions logs are readable outside
the company. `gh run list --workflow=diag-role-permissions.yml` lists 13 runs
from 2026-07-27 to 2026-09-14, the last of them the verification run for 0894
(34840591941), which printed the list again. No contact details were printed —
names beside roles, positions and company grants.

**Root cause (traced).** Both steps of the workflow selected `users.name` and
printed it:

- `backend/scripts/diag-role-permissions.mjs` section (3) —
  `SELECT u.name AS user_name, ...` and a `user_name` column in the output. Its
  header said "name + position only — no contact PII", which treated a name as
  harmless without asking where the output is published.
- `backend/scripts/audit-permission-grants.mjs` sections (3), (3c), (4) and
  (10) — positionless users, wildcard holders, department-only sales staff,
  people with no company grant, and audit-event actors, each by name.

Sections (9b) and (10) of the second script also carried a hand-written list of
"unclassified" position names (`'outsource transporter', 'warehouse crew kl',
...`), another copy of the policy that docs/bugs/0894 removes elsewhere —
Warehouse Crew KL had been restricted since 2026-09-01.

**Fix.** Both scripts print a person as `user #<id>`, which opens the user in
Team > Users for someone entitled to the name, and no longer select
`users.name`. (9b) and (10) select every active position and keep the rows
`classifyPosition(...)` files as FULL, instead of naming positions.
`backend/tests/positionClassification.test.ts` asserts that neither script
selects `u.name` and that the hand-written position list is gone.

**Not fixed here, and not mine to do:** the logs of the earlier runs still hold
the names. Deleting a run's logs is permanent, so it is left to a repository
admin (Actions -> the run -> Delete all logs).

**Ref.** fix/audit-grants-read-policy, 2026-09-14.
