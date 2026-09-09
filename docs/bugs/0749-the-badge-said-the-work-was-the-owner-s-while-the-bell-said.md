## The badge said the work was the owner's while the bell said it was not [low]

<!-- area: Sales orders + pricing -->

**Symptom.** Two surfaces built four days apart for the same purpose — telling an
approver that an amendment is waiting — disagreed about the Owner account. The
notification bell said nothing to it (the notice audience excludes `*` holders on
purpose, so the owner is not pinged about every amendment ever raised); the new
sidebar count put every desk's backlog on its menu. Same question, two answers,
neither visibly wrong on its own.

**Root cause (traced).** The two surfaces asked different functions.
`services/permissionHolders.ts` resolves the notice audience from the ROLES table
and filters out any role whose grant is `["*"]`. The pending-count endpoints
asked `hasHouzsPerm`, whose entire job is to honour the wildcard —
`hasPermission` short-circuits on `*` (`services/permissions.ts`), which is
correct for a GATE and wrong for an ADDRESS. Confirmed against prod: the Owner
account (users.id 1, role `Owner`) holds `["*"]` and no literal amendment key,
while Nico (5), Lim (4) and Farra (83) hold the real keys — so the owner was the
one account where the two readings could differ, and it did.

The shape worth remembering: the wildcard is not a rule you apply once. It is a
property of every permission read, and a feature that spans two reads has to
decide the same way in both. Nothing enforced that here; the second surface
simply reached for the obvious helper.

**Fix.** Owner ruling 2026-09-09 ("Owner 号也不显示数字"): both surfaces exclude
the wildcard. `hasPermissionLiterally` now sits beside `hasPermission` in
`services/permissions.ts` — one file owning both readings of a permission set,
with the rule stated for the next caller: `hasPermission` for *may they do it*,
`hasPermissionLiterally` for *is it theirs*. `holdsHouzsPermLiterally` wraps it
for the SCM routes, and the two pending-count endpoints are its only callers.

Proved RED on the unfixed tree: swapping the four call sites back to
`hasHouzsPerm` fails both new wildcard cases —
`expected 4 to be +0` (SO) and `expected 3 to be +0` (PO), the two counts a `*`
holder was being shown. Green after; 10 tests across the two suites.

**Ref.** fix/approval-badge-exclude-wildcard-0909, 2026-09-09.
