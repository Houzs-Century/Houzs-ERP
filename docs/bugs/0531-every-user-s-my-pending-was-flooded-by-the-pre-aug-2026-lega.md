## Every user's My Pending was flooded by the pre-Aug-2026 legacy backlog [medium]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner, 2026-08-24, with a screenshot of Sim's My Pending showing
Feb-2025 AKEMI events at the top and 641 overdue checklist items: "event yg
lama semua jangan bagi keluar dekat my pending task, sebab yg lama tu semua
memang byk x complete data. just start bulan ni and onward saja ... apply to
all user utk my pending task."

**Root cause (traced).** Not a defect in any lane — a missing product rule.
The `pendingOr` block in `services/projects.ts` gated on task due date
(`DUE_GATE`), review state and, since 2026-08-17, project status — but never
on the event's own date. Years of imported historical events (oldest on the
owner's screenshot: 2025-02-07) were loaded with checklists nobody was ever
going to complete, so every one of their 'pending' rows satisfied some lane
forever, for every role.

**Fix.** One project-level gate pushed beside the cancelled/'pending'-status
gate, so the whole OR-block — every lane, every user — inherits it: an event
whose `COALESCE(end_date, start_date)` is before `MY_PENDING_EPOCH`
('2026-08-01', a fixed constant beside `DUE_GATE`) never surfaces in My
Pending. Fixed epoch rather than a rolling month on purpose: rolling would
drop a just-ended event's post-event tasks (Filled Floorplan T+3d, Event
Complete T+7d) at every month turn. `end_date` over `start_date` so an event
still running into August stays visible. No per-lane change, no bind-order
change (interpolated literal, same pattern as `APPROVER_BRAND_GATE`).

**Ref.** fix/my-pending-legacy-epoch, 2026-08-24.
