# HANDOFF — phone vs desktop permissions and restrictions (2026-09-14)

Owner-facing thread: 「去查看houzs erp的RBAC和限制 我发现电脑电话版本好像有差别有些限制电话有而已
电脑没有」. The full findings, evidence and options are in
`docs/mobile-desktop-permission-parity-audit-2026-09-14.md`. This file is the state.

---

## 1. What LANDED

All merged on 2026-09-14 and in production: the Worker's `/health` answered sha
`b9d05153` when checked at about 13:03Z, and each merge commit below is its ancestor
(`git merge-base --is-ancestor`).

| item | PR | merged (UTC) |
|---|---|---|
| Sales Director invite always stores the baseline role (security, B-1) | #3831 | 08:19 |
| The audit document + this handoff | #3832 | 08:13 |
| Phone convert-from-SO picker lists every deliverable order (B-3) | #3836 | 09:13 |
| Phone fabric sheet honours the Model's fabric pool (B-4) | #3838 | 09:13 |
| Supplier invoices are paid only with an AP Payment (B-2 + B-15); probe run 34833260858: 0 direct payments, RM 0.00, in the 53 purchase-invoice audit rows since 2026-07-23 | #3841 | 09:59 |
| Service-case sub-status list has one home, "Pending Customer Pickup" saves (B-5) | #3843 | 09:59 |
| Archived projects editable on the phone as on the desktop (D4, projects half) | #3851 | 10:32 |
| Permission audit asks the policy; diagnostics print user ids, not names (B-9 + 0895) | #3858 | 12:27 |
| Fabric search applies retired and pool rules BEFORE the 50-row cap — the recurring "cannot pick a fabric" (owner report on #3838) | #3856 | 12:40; live bundle's `fabric-queries` chunk carries `&itemCode=` |

## 2. What is OPEN

| item | state |
|---|---|
| D4, service-case half | the desktop banner (since 2026-04-20) and the phone disagree field by field (SC-1, SC-7). The owner could not place the question twice; measured read-only: **0 of 904 cases archived**. No change while unused — align both to the desktop banner's rule if archiving starts |
| Staff names in the logs of earlier *Diag role permissions* runs (13 runs, 2026-07-27 to 2026-09-14) | deleting run logs is permanent: a repository admin's call, not done here |
| B-6, B-8, B-10 to B-14, MD-3 | open as the audit §5 lists them |
| B-7 driver POD | a feature to build rather than a permission to flip; re-trace the backend path before building |

## 3. The owner's answers (§7 of the audit)

D1 merge now; D2 option C, staged, Sales Orders first; D3 and D5
「根据最新的version」: the July phone-only project rules are superseded (phone
follows desktop and server), supplier payments go through vouchers. D4: see §2 —
projects done, service cases corrected and deferred.

## 4. NEXT, in order

1. Apply D3 on the phone: drop the July phone-only project cohort rules so the
   phone follows the desktop and server permissions.
2. Option C, phase 1 — Sales Orders: a design doc first, then the SO read returns
   `actions` computed by the same guards the write routes enforce, both screens
   render from it, and a check fails a screen that computes its own. Then service
   cases, projects, the downstream documents.
3. The remaining §5 defects, one PR each.
4. Before each module PR: re-grep the cited lines — §4 of the audit is at
   `081a3fe72`.

## 5. Re-run before quoting a number

- Population: "Role permissions diag (read-only)" workflow — last run 34817494633
  (2026-09-14): 79 active users.
- Production build: `curl https://autocount-sync-api.houzs-erp.workers.dev/health`
  and compare `sha` with the merge commit.
