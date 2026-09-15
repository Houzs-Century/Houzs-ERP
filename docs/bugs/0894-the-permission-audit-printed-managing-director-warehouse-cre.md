## The permission audit printed Managing Director, Warehouse Crew KL and Calendar Viewer as full-access positions [low]

**Symptom.** Found during the phone/desktop permission audit of 2026-09-14
(`docs/mobile-desktop-permission-parity-audit-2026-09-14.md`, item B-9). The
read-only diagnostic *Diag role permissions* (`diag-role-permissions.yml`,
`backend/scripts/audit-permission-grants.mjs`) prints each live position name
with the code cohort it lands in. It listed **Managing Director**, **Warehouse
Crew KL** and **Calendar Viewer** as `FULL (L2 inert)`. The per-position
headcounts were right; the cohort each was filed under was not, so any total
read off that section overstated the full-access population and understated the
restricted one. No user's access was affected: the script only reads.

**Root cause (traced).** The script restated the policy instead of asking it. It
carried its own copies of the position lists that `services/positionPolicy.ts`
and `services/pmsAccess.ts` enforce, and the policy moved three times without
the copies:

- `audit-permission-grants.mjs:37` held `GOD_POSITIONS = ["Super Admin", "Owner"]`;
  Managing Director joined the policy's god set on 2026-09-07 (#3030).
- `audit-permission-grants.mjs:51` held `RESTRICTED_POSITIONS = ["Driver",
  "Helper", "Storekeeper", "Storekeeper Supervisor"]`; the policy's
  `RESTRICTED_ROWS` gained `"Warehouse Crew KL"` (and the `Warehouse Crew`
  prefix) on 2026-09-01 (#2843) and `"Calendar Viewer"` on 2026-08-26 (#2728).

A name in neither copy fell through to the script's `FULL` branch. This is the
duplicated-list bug class with a report attached: the rule lived in one module
and a second, unenforced copy described it.

**Fix.** `backend/scripts/lib/position-classification.mjs` classifies a
position by calling `positionGrantsWildcard` / `resolvePositionPolicy` and the
`pmsAccess` helpers directly, and `audit-permission-grants.mjs` uses it for every
section that named a cohort or a flag; the copied lists are gone. Because the
classifier imports TypeScript from `src/`, the workflow runs the script under
`npx tsx`. `backend/tests/positionClassification.test.ts` pins the three names
it got wrong, checks that the classifier agrees with `resolvePositionPolicy` over
the live position names, and asserts that the script holds no position list and
that the workflow runs it under tsx. Not RED-provable as a unit test on the old
tree (the module did not exist); the old lists quoted above are the observation.

**Ref.** fix/audit-grants-read-policy, 2026-09-14.
