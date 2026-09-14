## A service case could never be switched back to Pending Customer Pickup [medium]

<!-- area: Service cases (ASSR) -->

**Symptom.** Found by the 2026-09-14 phone-vs-desktop permission audit (defect
B-5). A service case entering the Pickup / Return stage starts on the
customer-pickup leg. Once ops switched it to Pending Supplier Pickup or Pending
Supplier Return, choosing Pending Customer Pickup again did not save. The phone
showed "Couldn't switch sub-status" with the server's "Unknown sub-status"; the
desktop select showed nothing, and the choice simply did not stick.

**Root cause (traced in the source).** The sub-status list was typed by hand in
five places. On 2026-09-01 (Nico) the customer-pickup leg was added to the
screens' list (`frontend/src/vendor/scm/lib/assr/stages.ts`) and to the
stage-entry seed (`transitionStage` in `backend/src/services/assr.ts`). The save
allowlist, `SUB_STATUS_VALUES` in `backend/src/routes/assr.ts` [gone], still
listed four values without it, so `PATCH /api/assr/:id` answered 400 for a value
the system itself had written on entry. The printed report's sub-status map and
the activity-log label map lacked it too: the report printed no sub-status line
for a case on that leg, and the activity log wrote the raw key. The desktop's
`onSubChange` called an `async patch()` with no catch, so its refusal reached
nobody.

**Fix.** One list: `backend/src/scm/shared/assr-sub-statuses.ts`, byte-identical
with `frontend/src/vendor/scm/lib/assr-sub-statuses.ts` (the shared-mirror
check covers the pair). The save allowlist is `ASSR_SUB_STATUS_KEYS`, the seed is
`assrSubStatusSeed`, the activity log and the printed report read
`assrSubStatusLabelOf` (the report keeps its two "— our team" wordings).
`stages.ts` re-exports the list for the screens. The desktop select now shows the
server's refusal as an error toast. Pinned by
`backend/src/scm/shared/assr-sub-statuses.test.ts`,
`backend/tests/assrSubStatusOneHome.test.ts` and
`frontend/src/vendor/scm/lib/assr-sub-statuses.canonical.test.ts`; with the five
changed source files put back to `main`, 5 of those tests fail (3 backend, 2
frontend). `backend/tests/subStatus.test.ts` (the seed, run against the D1 test
database) still passes.

**Not changed, on purpose.** The server still accepts a sub-status from either
stage on any case; the screens only offer the current stage's legs. Refusing a
leg from another stage is a server-held rule for the option C work on service
cases, not part of this fix.

**Ref.** fix/assr-sub-status-list, 2026-09-14.
