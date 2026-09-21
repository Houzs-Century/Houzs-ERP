## The fair picker offered an archived fair, and refused every order written after its fair closed [high]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-19, on New Sales Order: 「why there is megahome pavillion bukit
jalil, but i didnt saw this event in calender, is that any error」. `PAVILION BUKIT JALIL —
MEGAHOME` sat under **Running now** in the fair dropdown while the Projects calendar showed no
such event. Pulling that thread reached the bigger one, in his words: 「我可能是下个星期，才开给
上个星期 event 的 sales order」 — orders written up after a fair had closed could not be
attributed to it, so revenue per venue per organizer per occurrence could not be computed.

**Root cause (traced).** Read-only probe against production
(`backend/scripts/probe-fair-picker-vs-calendar.mjs`, Actions run **35432690927**, 2026-09-19).
Two independent faults, both in the SCM fair layer:

1. **ARCHIVED WAS NEVER CHECKED.** The owner's row is project **359** — PAVILION BUKIT JALIL,
   MEGAHOME, AKEMI, 2026-09-18 → 09-20, status `confirmed`, **`archived_at` = 2026-08-03**:
   archived six weeks before its own event was due to open. `GET /api/projects/calendar/events`
   carries `WHERE p.archived_at IS NULL` and so drew nothing; `LIVE_FAIR` in
   `scm/lib/fair-binding.ts` never mentioned the column, so the picker offered it as running.
   The probe found **2 of the 7** "Running now" rows archived that day (359, and 346 MVEC
   SOUTHKEY — MLE, which hid because its unarchived twins 344/345 render the same dropdown row),
   out of **155 archived among Houzs Century's 924 projects**. Every other reader of `projects`
   in the system already excluded them — projects list, calendar, brand/contractor share
   calendars, project P&L, inbox, search, finance, delivery planning. `fair-binding.ts` (2
   queries), `venue-binding.ts` (1) and `mfg-so-fairs.ts` (1) were the only four that did not,
   and `venue-binding.ts` checked neither `archived_at` NOR `status`, so a cancelled, archived
   project could be stamped onto a new order **automatically**. An archived project's revenue
   lands where `rawProjectCost` excludes it by definition, so the money leaves exhibition P&L
   without a trace.

2. **THE ORDER DATE VETOED THE OPERATOR'S PICK.** The New Sales Order form — desktop and phone —
   has **no date field at all** (no `soDate:` is sent from anywhere in `frontend/src`;
   `so_date: dateOrNull(body.soDate) ?? todayMyt()`), so an order is always dated the day it was
   keyed. Both forms also passed `soDate={null}` to `FairPicker`, so the dropdown listed the
   fairs of *that* day. `FairPickValue` carried only `{venue, organizer}`, dropping the picked
   row's period, and `resolveFairForSave` → `loadFairsAtVenue` then re-derived the event with
   `p.start_date <= soDate AND (p.end_date IS NULL OR p.end_date >= soDate)`. For an order
   written after its fair closed that matched nothing, so a correct human pick was recorded
   `PENDING`; the nightly reconcile retried through the same line and failed identically; and
   `POST /:docNo/fair` — the settle-by-hand screen — refused with 409
   `fair_not_running_on_so_date`. **No path in the system could attribute such an order.**
   Two smaller faults sat behind the same window: it was the order date's whole CALENDAR MONTH,
   so a 2 Oct order never saw an 18-20 Sep fair at all, while offering fairs that had not
   happened yet; and `periodContains` read a blank `end_date` as *never ends* while the calendar
   read the same blank as `COALESCE(end_date, start_date)` — one day. (0 such rows today, so
   that half was a trap, not a live number.)

**Fix.**
- **Archived is not pickable.** `archived_at IS NULL` added to `LIVE_FAIR` (covers both
  `fair-binding.ts` loaders) and to `venue-binding.ts`, which also gained the missing
  `status <> 'cancelled'`.
- **The pick is the answer, not a hint.** `FairPickValue` gained `startDate` / `endDate` as
  REQUIRED fields, so the compiler enumerated all four call sites; both create forms send
  `fairStart` / `fairEnd`; `fairPickedPeriod` validates them; `loadFairsForEvent` matches the
  event on venue + organizer + period **inside the company predicate** (a client-supplied
  `project_id` is still never trusted — `project_id` carries no company scope of its own).
  `resolveFair` no longer re-checks the order date, and `POST /:docNo/fair`'s 409 is gone. An
  order dated outside its fair's run stays visible: `so_date` against the project's own
  start/end says so at any time, with no flag to keep in step.
- **The window is 28 days back from the order date, never forward** (owner: 「往前推四个星期…
  跟着 week 来算」, 「日期还没到，还没开单，不可能嘛」). `lookbackWindow` lives in the pure module
  and both the SQL and the grouping read it, so they cannot drift. `month` → `earlier`, labelled
  "Recently closed (last 4 weeks)"; sorted newest first.
- **Every row shows its dates**, reversing the owner's 2026-09-13 "no dates" ruling — he
  reversed it himself describing the task: 「它是一号到三号的，我就点那个」. `showDates` is deleted
  rather than widened. He asked for no year — 「日期不需要年份」 — which the window makes safe:
  nothing inside 28 days needs one. His first spelling was 「放 Aug 13 - 17 这样」, which
  `check-date-formatting.mjs` fails a build over: he had ruled on 2026-08-18 that this app has
  ONE date format and month names are not it. That is two of his own instructions in conflict, so
  it went back to him rather than through the gate's allowlist, and he chose `13/08 - 17/08`.
  The formatter is `fmtDayMonthRange` in `shared/format.ts` — beside the rule it varies, mirrored
  on both sides, and inside the range `format.date.canonical.test.ts` already compares byte for
  byte, so the two copies cannot drift. A one-day fair renders `13/08`.
- **The booth key now carries the period**, so REX/AKEMI at one venue twice inside the window no
  longer collapses to the lower id and posts the second fair's sales to the first fair's P&L —
  a hazard the old date filter had masked.
- **NOT done here** (owner: 「nvm for this, we focus on new order」): the orders already linked to
  archived projects, and the historical orders that could never be attributed. The SO edit screen
  still sends a place only.

**Ref.** `fix/fair-picker-window-and-archive`, 2026-09-19. Module guide:
`docs/modules/sales-order.md`. Probe: `backend/scripts/probe-fair-picker-vs-calendar.mjs` (#4153).
Ledger scaffold `scripts/new-bug.mjs` is still absent on `main`, so the number was taken by
listing `docs/bugs/`.
