## projects.finance.view was ignored by the project-detail strip, so the Rental box booked a duplicate line per retype [high]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner, 2026-09-04: *"why since yesterday i key in rental amount until
just now suddenly auto deleted"*. Nothing was deleted. Every entry saved — and
saved AGAIN on each retype. Project 2257 (Setia Spice DUNLOPILLO) carried **12
manual rental lines** booked between 06:36 and 06:48 UTC (18125 x3, 18126 x7, one
mis-key of 1812), so its Rental box read **RM 201,195** for an event whose rental
is **RM 18,126**. Three older projects carry 2 lines each from the same
mechanism.

**Root cause (traced).** `getPmsAccess` returned `canFinancial:
sections.includes("FINANCIAL")` — section list only. Its two siblings in the same
object literal are additive on a permission (`canEdit` on `projects.manage`,
`canSensitive` on `agreement.approve`), and `isFinanceViewer` has honoured
`projects.finance.view` since 2026-07-23 for exactly this case ("a specific
non-director role may be given finance-view explicitly, e.g. the BD role").
`canFinancial` was the one reader that did not.

`GET /projects/:id` gates on that flag (`routes/projects.ts`, `stripFinance =
user.position_id != null && !pms.canFinancial`) and blanks `finance` +
`finance_lines`. So the reporter — role **BD Exec**, which already HELD
`projects.finance.view`, position **Operation Executive** — was served an empty
ledger on every load.

The money damage comes from what reads that list. `QuickRentalField`
(`pages/Projects.tsx`) chooses PATCH vs CREATE by counting the rental lines it
can SEE: one line → PATCH, zero → CREATE. Served zero forever, it took the
CREATE branch every time, and its `useEffect` re-derived the input from the same
empty list and blanked the box after each save — which is what made the owner
retype. Twelve times.

Verified against prod before the fix: `roles.permissions` for BD Exec contains
`projects.finance.view`; the 12 lines all carry `auto_source IS NULL` and
`archived_at IS NULL`; `project_finance.rental` for 2257 was 201195.

**Fix.** `canFinancial` becomes `sections.includes("FINANCIAL") ||
permissions_set.has("projects.finance.view")` — the shape its two siblings
already had. `tests/pmsAccess.test.ts` pins it and was proved RED on the unfixed
tree (`expected false to be true` at the `canFinancial` assertion, 1 failed /
31 passed). The existing BD-without-the-permission test still asserts `false`, so
the grant stays opt-in and no cohort widens: role stays `OTHER`, `isDirectorUser`
stays false, `canPayment` stays false.

**Data repaired separately (owner instruction "zero kan balik ... nanti ak
masukkan semula"):** the 12 lines on 2257 archived, `project_finance.rental`
recomputed to 0. The 3 older duplicate pairs are left for the owner to value.

**Still open.** The Rental box is never gated on `canRental` — that flag is
declared in `Projects.tsx` and never read — so a user who genuinely cannot see
finance can still type into a box whose contents are withheld, and duplicate
lines the same way. This fix removes the reporter from that path; it does not
close the path.

**Ref.** fix/finance-view-permission-ignored, 2026-09-04.
