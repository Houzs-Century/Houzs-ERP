# HANDOFF — phone vs desktop permissions and restrictions (2026-09-14)

Owner-facing thread: 「去查看houzs erp的RBAC和限制 我发现电脑电话版本好像有差别有些限制电话有而已
电脑没有」. The full findings, evidence and options are in
`docs/mobile-desktop-permission-parity-audit-2026-09-14.md`. This file is the state.

---

## 1. What LANDED

| item | PR | proof |
|---|---|---|
| Sales Director invite always stores the baseline role (security, B-1) | #3831 | merged 2026-09-14 08:19Z; production Worker `/health` answered sha `ba8a8642` (the merge commit) when re-checked that afternoon |
| The audit document + this handoff | #3832 | merged 2026-09-14 08:13Z |

## 2. What is OPEN

| item | where | state at writing (2026-09-14, afternoon) |
|---|---|---|
| Phone convert-from-SO picker lists every deliverable order (B-3) | #3836, `fix/mobile-convert-so-picker` | green, in the merge queue. After deploy: read-only look at the phone convert wizard's Sales Order list on production, creating nothing |
| Phone fabric sheet honours the Model's fabric pool (B-4) | #3838, `fix/mobile-fabric-pool` | green, in the merge queue. After deploy: read-only look at the phone fabric sheet on production |
| Supplier invoices are paid only with an AP Payment (B-2 + B-15) | `fix/pi-payment-via-vouchers` | this PR. After merge: dispatch Actions → probe-pi-direct-payments once (read-only) and report how many payments the retired route recorded, per company |

Staging cannot walk any Sales Order list flow while the staging Worker holds the
anon key (owner action pending), so these are checked read-only on production.

## 3. The owner's answers (§7 of the audit)

D1 merge now; D2 option C, staged, Sales Orders first; D3-D5 「根据最新的version」:
the July phone-only project rules are superseded (phone follows desktop and
server), archived projects and service cases stay editable on both, supplier
payments go through vouchers. Nothing is blocked on the owner in this thread.

## 4. NEXT, in order

1. Remaining defects, one PR each: B-5 service-case sub-status allowlist
   (`pending_customer_pickup`; the desktop swallows the 400), B-7 driver POD dead
   end (verify the backend path first), B-9 stale classifier in
   `backend/scripts/audit-permission-grants.mjs`, and MD-3 (the driver mileage
   photo upload rides `/slips`, gated on `scm.sales.orders`).
2. Apply D3/D4 on the phone: drop the July phone-only project cohort rules so the
   phone follows the desktop and server permissions.
3. Option C, phase 1 — Sales Orders: a design doc first, then the SO read returns
   `actions` computed by the same guards the write routes enforce, both screens
   render from it, and a check fails a screen that computes its own. Then service
   cases, projects, the downstream documents.
4. Before each module PR: re-grep the cited lines — §4 of the audit is at
   `081a3fe72`.

## 5. Re-run before quoting a number

- Population: "Role permissions diag (read-only)" workflow — last run 34817494633
  (2026-09-14): 79 active users.
- Production build: `curl https://autocount-sync-api.houzs-erp.workers.dev/health`
  and compare `sha` with the merge commit.
