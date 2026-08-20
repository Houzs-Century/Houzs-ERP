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

Rationale, in the owner's words and worth keeping verbatim because it is what
stops someone "improving" this later by adding the filter back:

> "AutoCount 那一边，它的 SysAgent 可能也不准吧，所以也麻烦，所以 AutoCount 就去
> 开放给每一个人吧"

**The agent data in AutoCount is itself unreliable.** So an agent filter on that
side is not a weak control — it is a control driven by wrong input, which
silently removes access from people who should have it. That is what happened:
a batch of Sales Agents lost their cases and nothing said why.

ERP has a real binding, so ERP-sourced work stays scoped to self + downline.
The asymmetry is deliberate and is about DATA QUALITY, not about trust.

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

## CONFIRMED BY THE OWNER 2026-08-20 — and one axis left deliberately undecided

The company boundary is the whole of it, and it is simpler than the code assumes:

> "我们的 team 会 set 员工 under 哪家公司,可以 under specific company,也可以 under
> both company。如果 under both company,所有数据都可以看;如果 under single
> company,就只能看到对应那一家"

So: a grant for both companies sees both; a grant for one sees one. **Job title
and department do not enter into it** — the `/^sales/i` test on `position_name`
is out, per "有 Houzs 这家公司的授权 就好（不看职称）".

**Service Case is 互通** — cases from both companies are visible. The owner also
named why the live incident should never have existed: the orders come from
AutoCount, and "如果已经在 ERP 里面开了,原本就可以开到 service case".

### The ERP-sourced branch is NOT being changed yet, on purpose

The owner described the salesperson axis THREE times and the direction was not
consistent — twice as **下线** (the people I manage, looking down) and once as
**上线** (the person who manages me, looking up). Asked to settle it, he answered
"autocount".

Read straightforwardly: the AutoCount branch is the one that is broken now and
the one he has confirmed without ambiguity, so **ship that and leave the
ERP-sourced branch exactly as it is**. ERP-raised orders are described as future
usage ("之后会开始用 ERP"), so the axis can be decided when it carries real
traffic.

**Do not guess the direction.** 下线 and 上线 are opposite, both are
implementable, and getting it wrong means somebody sees an order they should not.
Ask before touching that branch.

### 3PL rate cards — answered

"3PL 它是根据我的 TMS 计算的,所以不跟着公司,其实是算 centralized 的意思,就是说
building centralized 的意思,然后只是 bold 去看什么公司,我们到时之后再去 set."

Centralised: built once against the TMS, with the company tag applied later.
The Medium-confidence flag on `delivery-rate-card` in the classification is
resolved as **bucket B**, not a scoping bug.

### Venues — the owner's reason is more general than the one recorded above

This doc and MASTER-DATA-SCOPE-RULE.md justify per-company venues as "separate
companies raise separate revenue documents". The owner's own reason is upstream
of that:

> "你的场地,基本上都是根据你的 project 的,我们 project 是完全分开的 Modular 来的。
> 所以你 Modular 分开的情况之下,你 project 等等肯定都是分开的。"

**The MODULE is separate, so everything hanging off it is separate.** That
generalises: for a new thing, ask which module owns it and whether that module is
separate — rather than asking the owner case by case.


## SETTLED 2026-08-20 — the axis is DOWNLINE, and 互通 does not mean open

**Direction: DOWN.** "service case 往下看 而不是往上". A salesperson sees their own
cases and their downline's — the people they manage. Not their manager's. This
resolves the contradiction recorded above (twice 下线, once 上线); it is now
answered directly and is not a guess.

**互通 means the DATA IS PRESENTED TOGETHER, not that everyone may see it.**

> "互通的就是它的数据都是呈现在一起的,不会像 Sales Order 这样分开两个。不过,这也得是
> 自己只能看到自己的 order 而已,除非是 AutoCount 来的单,并且他也得是 houzs-entry 的
> 员工,才可以 submit 这些 AutoCount 来的单"

One combined list rather than two company tabs — a PRESENTATION property. The
permission rule underneath is unchanged and NARROW: own + downline, with the
AutoCount orders as the single exception, and that exception is itself gated on
being a Houzs-entry employee.

**This corrects an earlier reading in this document.** "Service Case is 互通" was
taken to mean the read is open to any Houzs grant holder. It does not. Anyone
implementing from the earlier paragraph alone would ship something too wide —
which is exactly what happened; see below.

### Why this matters, with the number that shows it

PR #2538 implemented "holds a HOUZS company grant" as the admission test and
MEASURED the effect against production (run 32351722894): route admittance
49 -> 77 users, +45,168 user-to-case grants, 0 lost. The 28 who gained are
Drivers, Warehouse Crew, **Outsource Transporters**, HR and an Operation
Executive — each able to read 852 AutoCount cases including customer name, phone
and address.

A Houzs company grant is NOT the same thing as a Houzs-entry employee. The PR is
correct in structure and too wide in its admission test; it is held unmerged for
that reason. The census is what made this visible before it shipped — reasoning
would not have.

### STILL OPEN — one blocker, one small assumption

1. **BLOCKER: what defines a "houzs-entry 员工"?** Not the company grant (proved
   too wide above), and preferably not a job-title regex — that string test is the
   root cause of the outage this whole change exists to fix. The recommendation is
   a PERMISSION the owner grants on the Team screen, so who qualifies is a
   deliberate click rather than a guessed substring. Awaiting his definition.
2. For an ERP order, does "own" key off the SO's salesperson or the case's
   creator? #2538 assumes the salesperson and says so in its body. **Affects 7
   cases today** (859 non-archived: 7 ERP-sourced, 852 AutoCount-sourced), so it
   is small and safe to settle later.
