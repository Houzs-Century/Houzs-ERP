## SO V2 "History" was a button that could never have worked, and Recent activity had no time to show [medium]

<!-- area: Frontend + mobile -->

**Symptom.** Owner on `2990-SO-2608-036`, 2026-08-13: *"点history的时候没有反应"*
and *"recent activity 加上时间"*. Pressing **History** on the V2 Sales Order
detail page did nothing at all, and the Recent activity card printed the same
date on all three rows with no time on any of them.

**Root cause (traced, two independent defects).**

1. *History.* The handler was
   `navigate(`/scm/sales-orders/${docNo}?tab=history`)` — a navigation to the
   route the user is ALREADY on, carrying a query parameter no code reads. Both
   halves are independently fatal, so the button could not have worked on any
   code path. Verified by enumerating every `params.get("tab")` /
   `searchParams.get("tab")` consumer in `frontend/src`: the hits are
   `Settings`, `ServiceSettings`, `Team`, `Projects`, `WarehouseRacks`,
   `Products` and `MobileApp` — no Sales Order detail page among them. This is
   the same disease as the dead `?print=1` navigation this file already records;
   print was fixed and history was left behind.
2. *Recent activity.* All three rows read `salesOrder.so_date`, which is a
   Postgres **DATE** column and carries no time of day, so no formatting change
   could have produced one. Two of the three rows were also inferred rather than
   recorded — nothing had ever written a "Lines added" or status-change event to
   that card's source.

**Fix.** History opens the shared `AuditHistoryPanel` over `mfg_so_audit_log`
with the same `SO_AUDIT_LABELS` vocabulary the V1 detail page uses, so History
means one thing on both pages. Recent activity reads the same audit entries and
renders `created_at` through the shared `fmtDateTime`, falling back to the old
synthesized rows only when an order has no audit entries yet (pre-audit
history, or the query still loading) — a dateless card being a better answer
than no card.

**Test.** `frontend/src/pages/scm-v2/so-v2-history-and-activity.test.tsx` mounts
the real page under a real router with only its data hooks faked, and asserts
what the operator sees: the drawer appears AND the URL does not change (the old
handler's only effect was to push the URL already on screen), and the activity
row carries a clock time. Proven to bite — reverting the page to its pre-fix
source takes the file from `3 passed` to `2 failed | 1 passed`; the one that
still passes is the no-audit-entries fallback, which is deliberately the old
behaviour. Both defects were invisible to `tsc` and to every existing test,
which is how the same disease (`?print=1`) got fixed once and recurred here.

**Ref.** PR #2226, fix/so-v2-history-and-activity-time-0813, 2026-08-16.
