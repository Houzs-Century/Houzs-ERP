## Position reorg silently stripped the defect reviewer (Shukor) [medium]

**Symptom.** Owner (2026-09-15): Shukor cannot see or act on uploaded defect
items on mobile — no Done / Replace buttons anywhere, so nothing escalates to
the purchasers.

**Root cause (traced).** All three defect-review gates key Shukor on the exact
position name `storekeeper supervisor`: the My Pending lane
(`routes/projects.ts` lane selection), the action route's `isReviewer`, and the
frontend `DefectActionsCtx.canReview` (both PMS surfaces). The 2026-08-28 org
change moved every helper/storekeeper — Shukor included — onto the new position
`Warehouse Crew KL` (users.position_id 19 → 24, confirmed in prod), so all
three predicates went false at once. No code changed; a Team-page bulk edit
turned the reviewer off. Nancy (keyed on her unique role `Ops Exec`) was
untouched, which is why only the non-region states lost their reviewer.

**Fix.** Operational, not code: Shukor's account must stay on the
`Storekeeper Supervisor` position — restored via Team ▸ Edit member. There is
deliberately no code fallback: his role (`Storekeeper`) and his new position
are both shared by the whole warehouse crew, so any org-field widening would
make every storekeeper a reviewer. The companion change in this PR gives the
reviewer a dedicated mobile "Defect list" card (`DEFECT_REVIEW_TILES`,
mounted on `canReview`) and the module guide now carries the warning that the
reviewer key is the position name. Not test-pinnable: the breakage is a DATA
state (a position row edit), and the predicate itself was verified live —
`canReview` false with position `Warehouse Crew KL`, true with
`Storekeeper Supervisor`.

**Ref.** fix/defect-review-card, 2026-09-15.
