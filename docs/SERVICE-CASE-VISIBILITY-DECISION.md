# Service Case visibility: company, not agent — owner decision 2026-08-20

**Live problem this answers.** Many Sales Agents suddenly stopped seeing Service
Cases. It is NOT their data and NOT the AutoCount binding. It is this module's
visibility rule.

## What the code does today

`assrVisibleAgentNames` (`services/assrVisibility.ts:55`):

```
assrUnrestricted(user) -> undefined      // sees everything
user.id == null        -> []             // fail closed
otherwise              -> subtreeAgentNames(env, user.id)
```

and a case is visible when `created_by` / `assigned_to` / `assigned_to_2` is in
the caller's subtree, OR the case's **free-text `sales_agent` string** contains a
name from that subtree (`routes/assr.ts:279-285`).

So visibility is decided by **an org subtree plus a NAME-TEXT match**. Three
things make that fail suddenly and in batches:

1. a person's tier changes and they drop from "unrestricted" to "my subtree";
2. reporting lines move, so subtrees shrink;
3. the `sales_agent` text mirrored from AutoCount stops matching the ERP user's
   name — a rename, a space, a different spelling. **This is the "binding": it is
   a string comparison, not an id.**

The route gate is separate and also title-based: `canAccessServiceCases`
(`routes/assr.ts:98`) admits `service_cases.*` holders OR `isSalesUser(user)` OR
`isDirectorUser(user)`, and `isSalesUser` (`services/pmsAccess.ts:147`) tests
`position_name` against `/^sales/i` and `department_name` for "sales".

## The decision

> "我们不 control Agent，可是我们 control Company."
> "有 Houzs 这家公司的授权 就好（不看职称）"
> "office 的 RBAC 好像是跟着公司的？然后没有限制 sales agent" — yes, and Sales
> should work the same way.

| source of the SO | who may see / open a case |
| --- | --- |
| **AutoCount mirror** (`sales_orders`) | **anyone holding the HOUZS company grant** — no agent, no subtree, no job title. There is no dependable agent binding on this side, so any agent filter here is guesswork that silently removes access |
| **ERP's own SO** (`scm.mfg_sales_orders`) | **own + DOWNLINE** — self and the people under you. ERP has a real binding, so a per-person scope is meaningful here |

Rationale in the owner's words: AutoCount has no dependable agent binding, so
filtering by agent there is guesswork — and guesswork that silently removes
access. ERP does have one, so ERP-sourced work can be per-person.

## What to change

1. `canAccessServiceCases` — replace `isSalesUser(user)` with **holds the HOUZS
   company grant**. The machinery already exists in this file:
   `houzsCompanyId(c)` and `assrCompanyIds(c)` (`routes/assr.ts:1257-1260`), used
   today to decide whether the AutoCount mirror is searched at all.
   Drop the `/sales/i` title test — it is the most brittle input and the owner
   has ruled it out.
2. Visibility for AutoCount-sourced cases — stop consulting the subtree and the
   name text; scope by company.
3. ERP-sourced cases — keep the **self + downline** scope. Note carefully what
   this does and does not mean for the existing code: the SUBTREE stays, and
   `subtreeAgentNames` is not deleted. What must change is what it is matched
   ON. Today a case is admitted when the free-text `sales_agent` string CONTAINS
   a subtree member's name (`routes/assr.ts:285`, `agent.includes(n)`) - a
   substring test over a mirrored string. For ERP-sourced orders resolve the
   salesperson by ID through `scm.mfg_sales_orders`, which is the real binding,
   and let the subtree decide on ids.

   Still open, and small: for an ERP order does "own" key off the SO's
   salesperson or the case's creator? Ask before choosing - they differ whenever
   office raises a case on a salesperson's behalf, which the tier above exists
   to allow.

Do NOT widen write / manage / approve / delete. Those keep their existing
`requirePermission` gate; this decision is about READ and CREATE only, which is
already how `requireServiceCaseAccess` is applied.

## Two things to check BEFORE writing the code

- **The `assrUnrestricted` tier must not narrow — and here is the REASON, in the
  owner's words: "要不然 office 的帮不到 sales 处理东西了."** Office staff see
  everything because their job is to work a case on a salesperson's behalf. A
  later reader tempted to "tighten permissions" here would be removing the thing
  the tier exists for. This is a requirement, not an accident of history.
- **Measure who gains access.** This widens what Sales can see. Count the
  affected users and cases first, with a read-only workflow, and put the number
  in the PR — this repo does not ship access changes on reasoning alone.
