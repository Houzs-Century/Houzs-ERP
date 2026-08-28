## The Task filter asked which stage a project was at, not which tasks were open [medium]

**Symptom.** 2026-08-27, owner: filtering the Project List by Task →
`BOOTH LAYOUT & SETUP` + `EXPO MAP — COMPETITOR RESEARCH`, status `Confirmed`,
dates `01/09/2026 – 30/09/2026` returned **"No projects yet" / TOTAL 0**, while
the same page's KPI strip read `LIVE NOW 6`, `UPCOMING (30D) 34` and
`OVERDUE TASKS 655`. EXPORT then produced an empty spreadsheet, because it sends
the identical `section` param. The owner's words: *"tak nak dia tersangkut tu
… kalau filter then export akan keluar apa yg ak nk, don't follow flow chart in
project."*

**Root cause, traced.** `listProjects` (`backend/src/services/projects.ts`) did
not ask "does this project have open tasks in the ticked sections?". It computed
the project's **active section** — the lowest-`sort_order` section that still
holds a task not in `('done','na')` — and tested `IN (…ticked names…)`. That is
ONE value per project, so ticking two sections was an OR over a single scalar,
not a union of two questions.

The template's `sort_order` makes this decisive:

| section | sort_order |
| --- | --- |
| CONTRACT | 10 |
| OPERATION | 20 |
| BOOTH LAYOUT & SETUP | 30 |
| PAYMENT | 30 |
| SETUP & DISMANTLE DOCUMENTS | 50 |
| EXPO MAP — COMPETITOR RESEARCH | 50 |

CONTRACT sorts first, so a project keeps CONTRACT as its active section until
every CONTRACT task is `done`/`na` — no matter how much later-section work is
outstanding. Queried against the live data for exactly the owner's filter (18
confirmed events overlapping Sep 2026, company HOUZS):

- active section `CONTRACT`: **18**; everything-done: 1; anything else: **0**
- but open tasks in `BOOTH LAYOUT & SETUP`: **18 of 18**
- and open tasks in `EXPO MAP — COMPETITOR RESEARCH`: **17 of 18**

The work existed on every row. The filter was answering a different question.

**Why it read as a bug and not a preference.** The control is LABELLED `Task`
(renamed from `Status` on 2026-08-19), its tooltip says *"Filter by tasklist
section"*, and every option in the dropdown prints a **task count** beside it.
Three signals that all say "tasks in this section", over a predicate that meant
"current stage". The real stage chip already sits two controls along.

**Fix.** The real-name arm of the `section` predicate is now a plain `EXISTS`
over `project_checklist` joined to `project_checklist_sections`, matching any
ticked section that still holds a task not in `('done','na')`. The `__done` and
`__none` sentinels are untouched and still OR alongside the real names; bind
order is unchanged (the names arm stays last and is still the only arm that
binds). Verified against the live DB: the owner's filter now returns **18**.

Deliberately NOT changed, so the two surfaces answer different questions on
purpose:

- `active_section_name` in the list SELECT — still the project's stage, still
  what the row's section chip shows.
- The calendar handler (`routes/projects.ts` `/calendar`) — still filters on the
  active section. The calendar is a stage view.

EXPORT needed no change: `exportProjects` in `Projects.tsx` mirrors the on-screen
filter set through the same `section` param, and `section_tasks_map` already
returns the ticked sections' per-task badges for each exported row.

**Not verified by a test run.** `node` is not installed on the machine this was
authored on, so `npm run typecheck` and `vitest` were NOT executed, and no test
covers this predicate today (`backend/tests/projects.test.ts` does not touch
`section`). The SQL semantics were verified by running the equivalent statement
against the live Postgres; the TypeScript was not compiled. **Run
`npm --prefix backend run typecheck && npm --prefix backend test` before merge,
and add a case pinning "ticked section with open tasks matches even when an
earlier section is still open" — that is the exact regression this file
describes.**

**Ref.** 2026-08-27, `backend/src/services/projects.ts` (section predicate) +
`docs/modules/projects-pms.md` §3 item 7.
