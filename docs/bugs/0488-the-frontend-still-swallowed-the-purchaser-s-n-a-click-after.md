<!-- area: PMS checklist status / approvals -->

## The frontend still swallowed the purchaser's N/A click after the backend allowed it [medium]

**Symptom.** Owner 2026-08-21: "why sim still cannot click N/A for her part?" —
four days after the backend N/A-gate fix (2026-08-17, the entry that let the
role-badged owner function set 'na'/'pending' on a gated row), Sim clicking N/A
on Exchange List still did nothing. No error, no request, no toast.

**Root cause (traced).** The desktop `setItemStatus` handler carries a
CLIENT-side mirror of the OLD backend rule:

```ts
if (item.required_perm && !holdsChecklistApproval(user?.permissions, item.required_perm)) return;
```

— a deliberate silent no-op (owner 2026-07-15: "never surface a
permission-error toast on a checklist control"). The 08-17 fix relaxed the
BACKEND gate only; this guard returned before the request was sent, so the
backend never got the chance to allow it. Observed by tracing the N/A button's
onClick → onStatus → onItemStatus → setItemStatus chain: the guard is the first
early-return that fires for a keyless purchaser on a gated row. The silent-no-op
design is exactly what made this regression invisible — the same class of miss
as the 08-10/08-17 "one render site got the rule, its sibling didn't".

Mobile had the same blanket guard (`permBlocked` → `canRowTick`), with a twist:
its status control is a tap-to-CYCLE (pending → done → na), so simply unblocking
it would let a keyless user attempt 'done', which must stay key-only.

**Fix.** Desktop: the client guard now matches the backend verb split — the key
is required only when `status` is not 'na'/'pending'. Mobile: a gated row where
the keyless caller's role matches the badge gets a RESTRICTED cycle that skips
'done' (pending ↔ na); key holders keep the full cycle. Tooltip says
"Toggle N/A" in that state instead of "Requires <perm>".

**Ref.** fix/na-click-frontend-guard, 2026-08-21.
