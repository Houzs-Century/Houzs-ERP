# HANDOFF — phone vs desktop permissions and restrictions (2026-09-14)

Owner-facing thread: 「去查看houzs erp的RBAC和限制 我发现电脑电话版本好像有差别有些限制电话有而已
电脑没有」. The full findings, evidence and options are in
`docs/mobile-desktop-permission-parity-audit-2026-09-14.md`. This file is the state.

---

## 1. What LANDED

Nothing on production yet from this thread.

## 2. What is OPEN

| item | where | state |
|---|---|---|
| Sales Director invite always stores the baseline role (security) | PR #3831, branch `fix/sd-invite-forces-baseline-role` | CI running at handoff; merge waits on owner decision D1 (no staging walk-through was possible — no Sales Director session) |
| The audit document + this handoff | branch `docs/rbac-mobile-desktop-audit` | this PR |

## 3. BLOCKED on the owner (§7 of the audit)

- D1 merge #3831 now
- D2 option A / B / C (recommended C, staged, Sales Orders first)
- D3 keep or drop the July phone-only project rules (and move named user ids to a permission)
- D4 archived projects / service cases: locked on both or editable on both
- D5 turn off the phone's Purchase Invoice "Record payment"

## 4. NEXT, in order, once decided

1. Defects that do not wait for the option (one PR each): B-2 phone PI payment,
   B-3 convert-from-SO picker, B-4 fabric pool on the phone line, B-5 service-case
   sub-status allowlist, B-7 driver POD dead end, B-9 stale classifier in
   `backend/scripts/audit-permission-grants.mjs`.
2. The chosen option, module by module, starting with Sales Orders (§4.1 rows).
3. Before each module PR: re-grep the cited lines — they are at `081a3fe72`.

## 5. Re-run before quoting a number

- Population: "Role permissions diag (read-only)" workflow — last run 34817494633
  (2026-09-14): 79 active users.
