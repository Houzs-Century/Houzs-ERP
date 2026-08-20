## Cancelled and unconfirmed events kept generating everyone's My Pending work [medium]

<!-- area: Projects + PMS + fair report -->

**Symptom.** Owner 2026-08-17: "why event on status cancelled and pending appear
in my pending task??" — past events (e.g. a cancelled REX Johor show that ended
2026-08-16) surfaced in the purchaser's My Pending as an incomplete Stock Out
Transfer Record. Measured at report time: 22 lane items sat on cancelled events
and 24 on unconfirmed ('pending'-status) ones, across every lane.

**Root cause (traced).** `listProjects` assembles the `pendingOr` lanes (role /
title / approver / logistic / director / defect) and pushes them into WHERE with
no gate on the PROJECT's own status. Every lane predicate looks only at
checklist rows + due dates, so a cancelled event's untouched checklist kept
qualifying forever — and the DUE_GATE (`due <= today`) means a PAST event always
qualifies, which is why they "suddenly" pile up after the end date passes.

**Fix.** One `COALESCE(p.status,'confirmed') NOT IN ('cancelled','pending')`
pushed alongside the OR-block, so every lane inherits it and NULL-status legacy
rows stay visible. Only confirmed events generate pending work.

**Ref.** 2026-08-17, same PR as the N/A-gate entry below.
