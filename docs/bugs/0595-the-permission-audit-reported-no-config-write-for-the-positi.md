## the permission audit reported no config-write for the position that had just been granted it [medium]

**Symptom.** #2844 granted the Sales Director `canWriteConfig` (owner 2026-09-01,
so he can maintain retail price, sofa combos and Model activation). The grant was
then checked the way this repo checks such things — a read-only run of
`diag-role-permissions.yml`, on the merge commit `dc3d8bb1`, run 33489422359. Its
position table printed:

```
   5 | Sales Director  | Sales Department | 2 | sales (L2 ENFORCED) | DIRECTOR | pms-DIRECTOR,sales-director-admin
  10 | Operation Manager | Operation Department | 0 | FULL (L2 inert) | OTHER | config-write
  14 | Logistic Admin  | Operation Department | 3 | FULL (L2 inert) | OTHER | config-write
```

No `config-write` on the row the grant was made for, while every other holder
showed it. Read at face value the audit says the deploy did not take — which it
had; the backend tests asserting `resolvePositionPolicy("Sales Director")
.flags.canWriteConfig === true` were green on that same commit.

**Root cause (traced).** `backend/scripts/audit-permission-grants.mjs:39` — the
column is computed from `CONFIG_WRITE_POSITIONS`, a list **hand-copied into the
script** from `services/positionPolicy.ts`, and membership of that copy is the
whole test (`:109`, `if (CONFIG_WRITE_POSITIONS.includes(n))`). It never asks the
policy.

Copying that particular set was already the wrong shape for the question, and the
grant is what exposed it: `canWriteConfig` has **two** sources, and
CONFIG_WRITE_POSITIONS is only one of them. The set is layered on inside the
full/unclassified branch of `resolvePositionPolicy`; the sales branch returns its
flags object (`FLAGS_SALES_DIRECTOR`) directly and never reaches that layering.
So a sales-cohort grant *cannot* appear in the copied set, by construction — and
the column that claims to answer "who can write SCM master data" was structurally
incapable of reporting it.

**Fix.** The list stays, but its meaning changes from "a copy of
CONFIG_WRITE_POSITIONS" to "every position that RESOLVES to `canWriteConfig:
true`" — the question the column actually claims to answer — with the comment
naming both sources and saying that anything added to either belongs here.
Sales Director is added.

No test pins this: the audit scripts are standalone `.mjs` diagnostics with no
harness, and adding one for a display list would be the larger change. The RED
evidence is the live run above, on the unfixed tree; the fix is confirmed by the
next run of the same workflow.

**Ref.** fix/audit-config-write-misses-sales-director, 2026-09-01. Follow-up to #2844.
