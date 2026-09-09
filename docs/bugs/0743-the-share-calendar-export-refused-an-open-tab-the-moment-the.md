## The share-calendar export refused an open tab the moment the month rule deployed [medium]

**Symptom.** Owner, 2026-09-09 04:2x UTC, twice: "i cant export". Export to Excel on the
public share calendar (`/c/<token>`) showed "Could not prepare the export just now" on a
page that had exported fine an hour earlier.

**Root cause (traced).** PR #3375 made `GET .../export` REQUIRE `?month=YYYY-MM` and
answer 400 without it (`routes/publicContractorCalendar.ts`, `routes/publicBrandCalendar.ts`).
The deploy carrying it (run 3518) finished at 04:21 UTC; the owner's calendar tab was
loaded before that and still ran the previous page, which sends no month. Observed: the
export SQL itself runs on production (read-only `SELECT` over `projects` joined to
`project_event_types`, 2026-09-09 04:2x, 3 rows back), so the query was ruled out; the PR
merge time (04:13), the deploy conclusion (success, 04:21) and the complaint (04:2x) line
up on the 400. An open tab keeps its JavaScript until it reloads — the service worker
swaps the bundle for the NEXT load, and the 60s poll re-reads the list, not the code — so
a backwards-incompatible API change breaks every tab open across the deploy.

**Fix.** A missing month falls back to the whole schedule, as before the rule; a month that
is PRESENT but malformed is still 400 (`bad_month`). `listShareExportRows` takes
`month: string | null` (explicit null, per the required-parameter rule). The page always
sends the month, so the owner's rule holds for everyone on the current page. Test in
`backend/tests/publicContractorCalendarFloorplan.test.ts`: no month → 200 with the whole
schedule and a logged row; `?month=2026-13` and friends → 400, nothing logged. Proved RED
on the unfixed tree (the missing-month call answered 400).

**Lesson.** A public page that stays open for hours cannot be given a new REQUIRED request
parameter in one step. Add the parameter, let the server accept its absence, and only
tighten once no old page can still be running.

**Ref.** claude/color-border-styling-64o5a1, PR #3375 (the change), 2026-09-09.
