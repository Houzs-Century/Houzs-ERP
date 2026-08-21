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

---

## Amendment — 2026-08-21: "My Cases" keys on WHO RAISED the case

The open question left above — *"for an ERP order does 'own' key off the SO's
salesperson or the case's creator? Ask before choosing"* — was asked, and
answered for the **My Cases list**:

> 「如果是他开的 就算不是他as agent它也可以看啊 如果是autocount的 因为autocount的
> agent会有问题的 居然都开放给了全部人 那就是他submit就代表他认领这个case了啊」

If a person RAISED the case it is theirs, and it must appear in their My Cases,
whether or not they are the order's sales agent. The reasoning is the load-bearing
half and it is the same one behind the original decision: **AutoCount's agent data
is unreliable**, which is precisely why AutoCount-sourced orders were opened to
every Houzs staff member to raise a case on. Once anyone may raise it,
**submitting is claiming**.

**Scope of the amendment.** It changes `GET /api/assr/my-cases` only — the list
that answers *"which cases are MINE"*. The ACCESS rule above
(`assrVisibilityPredicateSql`, *"may I see this case at all"*) is untouched,
including its ERP `es.user_id` salesperson arm.

**What shipped** (`myCasesPredicateSql`, `services/assrVisibility.ts`): two arms,
OR-ed.

- `created_by IN (subtree ids)` — the ruling. Self + full downline BY ID, so the
  pyramid rule stands and nothing depends on how a name is typed.
- `LOWER(COALESCE(sales_agent,'')) LIKE '%<subtree display name>%'` — the legacy
  free-text arm, **kept**.

**The name arm was NOT dropped, and that is a measurement, not a preference.**
Census run **32463589829** (production, 2026-08-21, §6 of
`backend/scripts/census-service-case-visibility.mjs`):

| | |
|---|---|
| non-archived `assr_cases` | 862 (HOUZS 854 / 2990 8) |
| with `created_by` | 856 |
| `created_by` NULL but `sales_agent` set — reachable ONLY by the name arm | 5 |
| neither — reachable by no arm | 1 |
| raised by someone the agent text does not name — what the ruling makes visible | 824 |
| user→case pairs the CREATOR arm ADDS | 2,359 across 20 users |
| user→case pairs LOST if the name arm were REPLACED | **1,113 across 28 users** |

The 1,113 is not the 5 no-creator rows. It is overwhelmingly **office staff
raising a case on a rep's behalf** — `created_by` = the office user,
`sales_agent` = the rep — which is exactly the situation the paragraph above said
to ask about. Replacing the name arm would have taken those cases out of those
reps' lists. Union, never replace.

Caveat on what the census proves: the ERP-vs-AutoCount split it reports (4 vs
858) is distorted by the HC transaction wipe earlier the same day — a case whose
SO no longer exists in `scm.mfg_sales_orders` counts as "unresolvable". The §6
figures above do not read `scm` at all, so they are unaffected.
