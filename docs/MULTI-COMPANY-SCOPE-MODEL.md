# The multi-company scope model

**Owner decisions, 2026-08-20.** One document rather than four, because the four
drafts repeated each other and disagreed on the numbers.

Everything here is either the owner's own words or a measurement with the
command that produced it. Where something is not settled it says so.

---

## 1. The test: is the FUNCTION centralised?

> "这个 TMS 是 centralise 的啊 所以统一的 servicecase 也是 centralise 的 除了
> salesperson 不 centralise 而已"

Ask whether the function is run centrally or per company. Do **not** ask whether
the thing is physical, and do **not** count `company_id` columns. Both of those
methods have already produced wrong answers on this codebase, in opposite
directions, on the same tables (`CLAUDE.md`: *"Read the DDL's own words, not its
column list"*).

The owner also gave the upstream version of the rule, which generalises further:

> "你的场地,基本上都是根据你的 project 的,我们 project 是完全分开的 Modular 来的。
> 所以你 Modular 分开的情况之下,你 project 等等肯定都是分开的。"

**The module is separate, so everything hanging off it is separate.** For a new
thing, ask which module owns it and whether that module is separate — rather than
asking the owner case by case.

---

## 2. The classification

Measured from the code — migration headers, the guides' actual sentences, and the
READ paths — not from keyword matching. 31 module guides.

The in-repo authority is `backend/src/scm/lib/companyScope.ts:8-23`, which names
both patterns outright: PER-COMPANY modules where *"the top-bar switcher ISOLATES
the two companies' books"*, versus CROSS-COMPANY view modules where reads
*"WIDEN, don't isolate"*. So the discriminator is **which helper the read path
calls** — `scopeToCompany` isolates (A); `scopeToAllowedCompanies` or no
predicate widens (B/C).

### A — PER COMPANY (23)

sales-order · sales-invoice · quote · delivery-order · delivery-return ·
purchase-order · purchase-order-amendment · purchase-return ·
purchase-consignment-order · grn · stock-take · warehouses · accounting ·
payment-voucher · mail-center · mrp · combo-pricing · scan-to-so · projects-pms ·
so-handover · document-traceability · document-conversion · autocount-writeback

Two worth knowing:

- **warehouses**: mig `0177` makes cross-company **COPIES** — each company gets
  its own row for KL/CHINA. Not one shared row. This is what "venue, warehouse
  and showroom follow the company" looks like in the schema.
- **document-conversion** carries one deliberate exception (`companyScope.ts:610`):
  `POST /from-sos` INHERITS the source order's company, because the delivery-
  planning queue crosses companies by design.

### B — CENTRALISED (4)

- **delivery-tms** — `trips.ts:20-29`: *"CROSS-COMPANY, which is NOT the same as
  unscoped… reads WIDEN to the caller's granted companies, and so do the WRITES."*
- **fleet-maintenance** — migs `0202`/`0203`/`0204`: `company_id` is *"STAMPED on
  insert for provenance but NOT used to scope reads"*. A lorry is one physical
  vehicle whichever book paid for it. `scm.workshops` is the exception and IS
  per-company.
- **address-cascade** — postcodes are the same for every caller.
- **global-search** — one palette, per-source predicates.

**But the TMS's CONFIGURATION is per-company.** Post-mig-0176 each company holds
its own regions, zones, residence rules, 3PL master and driver leave
(`delivery-planning-regions.ts:71-78`). The function is central; its settings are
not. `docs/MULTICOMPANY-MODULE-MAP.md` still says regions are unified and is stale
on that point.

### C — CENTRALISED WITH ONE SCOPED AXIS (4)

| module | the axis |
| --- | --- |
| **service-case** | **the salesperson** — see §3 |
| announcements | the target-company audience (`target_company_ids` ∩ the reader's grants) |
| team-members | the member's own company grant; company is a filter chip, not a fence |
| delivery-rate-card | the rate card follows the active company while the queue is shared |

**3PL rate cards are bucket B, settled by the owner:**

> "3PL 它是根据我的 TMS 计算的,所以不跟着公司,其实是算 centralized 的意思,就是说
> building centralized 的意思,然后只是 bold 去看什么公司,我们到时之后再去 set."

Built once against the TMS; the company tag comes later.

### Not yet classified (8)

announcements-adjacent surfaces and: combo-pricing detail, delivery-order
detail, delivery-return detail, quote detail, system-health, plus three with no
guide statement at all. Silence is not evidence either way — these need the same
three-source read.

---

## 3. Service Case — the live incident and the rule

**Symptom.** A batch of Sales Agents suddenly could not see or raise Service
Cases.

**Cause, traced.** Visibility was decided by an org SUBTREE plus a **free-text
`sales_agent` NAME MATCH** (`routes/assr.ts:285`, `agent.includes(n)`). That
fails suddenly and in batches when a tier changes, when reporting lines move, or
when the name mirrored from AutoCount stops matching the ERP user's — a rename, a
space, a different spelling. **The "binding" was a string comparison, not an id.**

The owner's diagnosis of why it should never have existed:

> "那些单是从 auto-count 来的,如果已经在 ERP 里面开了,原本就可以开到 service case"

### The rule

| | |
| --- | --- |
| **Company boundary** | A grant for both companies sees both; a grant for one sees one. **Job title and department do not enter into it.** |
| **AutoCount-sourced orders** | To raise one as a Service Case you must be a **Houzs (Houzs Century) employee** — that is, hold the HOUZS company grant. No agent filter: the agent data in AutoCount is itself unreliable, so filtering on it removes access from people who should have it. |
| **ERP-sourced orders** | **Own + DOWNLINE** — "service case 往下看 而不是往上". Resolved by ID through the ERP order, never by name text. |
| **Office / unrestricted tier** | **Everything.** Reason, and it is a requirement not an accident: *"要不然 office 的帮不到 sales 处理东西了"* — office works cases on a salesperson's behalf. |

**互通 means the data is PRESENTED TOGETHER — one list instead of two company
tabs. It does not mean the read is open.** An earlier draft of this rule read it
as an open read; that draft was wrong.

### What the census showed, and why it matters

Implementing "holds a HOUZS grant" and measuring it against production first
(run 32351722894): route admittance **49 → 77 users**, **+45,168** user-to-case
grants, **0 lost**. Of 859 non-archived cases, **852 are AutoCount-sourced and 7
are ERP-sourced**.

The 28 who gain include **Drivers, Warehouse Crew and Outsource Transporters** —
each able to read those 852 cases including customer name, phone and address,
because they hold a Houzs Century grant. The owner was shown this and confirmed
the rule.

**Recorded because it was measured before shipping, not reasoned about after.**

### Still open

For an ERP order, does "own" key off the SO's salesperson or the case's creator?
The implementation assumes the salesperson and says so. **Affects 7 cases.**

---

## 4. Where isolation actually rests, and what that costs

The SCM client is **service-role**, so it bypasses RLS — and mig `0061` enabled
RLS while creating **zero policies** (`grep -c "CREATE POLICY"` over
`migrations-pg/` returns 0). So the `company_id` predicate each query carries is
the **entire** tenant boundary.

Measured today:

| | |
| --- | --- |
| SCM route handlers | 1,032 |
| `.from(` call sites in `scm/routes` + `scm/lib` | **2,609** |
| unscoped findings from `check-company-scope.mjs` | 19, **0 of them writes** |
| database-level policies | **0** |

**The handler count understates the job by about 2.5×** — the unit of work is the
query, not the handler. Any mechanism has to work file-by-file, with converted
and unconverted code coexisting.

### What a normal ERP does

SAP enforces the client (mandant) at the kernel; Oracle and NetSuite use
row-level security plus data-access roles; Odoo applies record rules in the ORM
on every read and write. All of them enforce in **one place**. This system asks
~2,600 call sites each to remember.

### The three options, honestly

| | coverage today | can a clean run be wrong? | runtime cost | failure mode |
| --- | --- | --- | --- | --- |
| text checker (`check-company-scope.mjs`) | whole tree | **yes, demonstrably** — it once reported 0 while 20 unscoped writes existed | none | false clean |
| required-scope argument (compile error) | only converted files | no — but `any` silences it | none | compile error |
| database policies | none until built | no | ~0 with a per-request JWT | **a wrong policy is mig 0189 again — that one emptied a view's ACL and took the Sales Order list down for every user** |

**`SET LOCAL` is not available**: the SCM path is supabase-js over PostgREST
HTTP, stateless by construction, so there is no session to set a GUC on. The
viable database route is a per-request JWT whose claims the policies read — which
costs ~nothing in latency but requires policies on all 119 `scm.*` tables and
abandoning service-role.

**Recommendation: the compile-time argument as the forward gate, keep the text
checker as the tree-wide backstop, write the database route down as the end state
without starting it.** The reason is narrow and worth stating plainly: the checker
tells a reviewer *afterwards* that a regex suspects something, and it has been
wrong in four distinct ways in one day; the compiler tells the *author*, at the
moment of writing, that they have not said which company this is for.

Seventeen manual sweeps in eight weeks, during which unscoped writes rose
345 → 359. Found-later does not converge on this class.

---

## 5. Fixed today

- **Showroom leak.** `GET /api/projects/venues?includeShowrooms=1` listed
  `scm.warehouses` showrooms with no company predicate. Measured against
  production: HOUZS saw **1 → 0** foreign showrooms (2990's "PJ SHOWROOM"), 2990
  keeps its own, and **0** rows have a NULL `company_id`, so nobody loses their
  own data. A second hole found in the same sweep — `active-venue` mapped venue
  text to an id with no predicate — was closed preventatively.
- **Fleet annotations.** The three fleet route files now carry
  `company-scope-file:` markers so their ~13 deliberate findings stop burying real
  ones. In `fleet-maintenance.ts` the marker rides the comment that already said
  it, because that file sits at its size ceiling and could not take two lines.

### One left alone, deliberately

`loadVenueNames` in `scan-so.ts` reads `project_venues` unscoped on purpose: it
feeds an OCR allowed-values pool that must stay byte-identical across `/extract`,
`/warm` and the headless cron, none of which carry a request scope. A HOUZS scan
could still match a 2990 venue name. **Flagged, not changed** — it needs the
owner's call.
