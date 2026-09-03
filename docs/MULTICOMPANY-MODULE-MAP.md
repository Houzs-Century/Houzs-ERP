# Multi-company module map — Houzs + 2990 merged system

Owner-locked 2026-07-14. One codebase (hello-houzs/Houzs-ERP), one Supabase,
`company_id` scoping, top-bar company switcher (抬头). HOUZS = company 1,
2990 = company 2. Hostname `erp.houzscentury.com` → HOUZS default,
`erp.2990shome.com` → 2990.

Three module classes: **SEPARATE** (per-company data), **SHARED** (one copy,
all companies), **UNIFIED-MODULE + PER-COMPANY TARGETING** (one interface, a
company dimension decides audience/ownership).

## ⚠️ THE PREDICATE IS THE ONLY ISOLATION — read this before writing a query

The SCM/Houzs supabase client is the **service role**. It **bypasses RLS**.
Migration `0061_enable_rls_scm.sql` turned RLS ON for every `scm.*` table and
created **no policies** — which locks out anon/authenticated and changes nothing
for this application, because "service_role bypasses RLS as a built-in
convention" (that migration's own header). No policy is ever evaluated on an app
request. There is **no second line of defence**. The
`company_id` predicate that `scopeToCompany` / `scopeToCompanyId` /
`scopeToAllowedCompanies` put on a statement is the *entire* tenant boundary.

Three consequences, all learned the hard way:

1. **A scoped READ does not protect the WRITE that follows it.** Nothing
   re-checks between two PostgREST round trips. Load-then-update needs the
   predicate on BOTH statements. "The read already 404'd it" is the reasoning
   that left every write in the system open after the 2026-08-10 read audit.
2. **"Reads are scoped, therefore the module is safe" is false** and this
   document used to imply it. A module can have a perfectly scoped list and a
   completely open `PATCH /:id`. Ownership predicates that are NOT `company_id`
   — `so_doc_no`, `purchase_invoice_id`, `trip_id`, `lorry_id` — prove the row
   belongs to that PARENT. They do not prove the parent is in your books.
3. **Cross-company is not the same as unscoped.** A shared-queue module (TMS
   trips / delivery planning / fleet) widens with `scopeToAllowedCompanies` to
   the caller's GRANTED companies. That is still a predicate. Writing with none
   at all lets a caller reach a company they hold no grant for.

Use `maybeSingle`, not `single`, on any by-id statement carrying a company
predicate: the predicate can legitimately match zero rows, and `single()` turns
that honest 404 into a 500.

## ⚠️ THE OTHER HALF — one system, two organisations

Everything above is about **isolation**: company A must not read company B's
rows. There is a second requirement, and until 2026-08-18 this document did not
state it, which is part of why it kept being violated. The owner put it plainly:

> 两个公司不是用着同一个系统吗？他们只是 Multi-Organization 关系而已啊.

**One system. One set of behaviours. Two organisations' DATA.** A company may
legitimately have its own documents, its own numbering prefix, its own branding,
and a small number of per-company RULES THE OWNER SET HIMSELF. It may **not**
have different CAPABILITIES by accident. Isolation and symmetry are different
properties and a module can pass one while failing the other: a perfectly scoped
screen that offers one organisation a button and the other nothing is isolated
and wrong.

### The five ways this repo has actually produced an asymmetry

Ranked by how often, and NONE of the top four is a company branch in code:

1. **A guard keyed on a proxy that CORRELATES with company.** The one that
   caused the 2026-08-18 report. The DO → Sales Invoice transfer button was
   gated on a hand-typed `["signed","delivered"]` while the system's own
   `DO_SHIPPED_STATES` is five states wide. No company term anywhere in it. It
   fired on one organisation only because 2990's source system had no
   "delivered" step, so its deliveries sit at `DISPATCHED`. **Identical code is
   not identical behaviour when the data behind it differs.**
2. **A config or master row present for one company and absent for the other.**
   A document type, a numbering series, a warehouse, a settings row, a lookup a
   picker reads. Source review cannot find these — only a query can.
3. **A data-shape difference.** A column one company's importer writes and the
   other's does not; a link column missing from one source schema entirely.
4. **A scope that fails closed.** `.in('company_id', [])` matches nothing and
   returns `[]` with `error: null`, which is indistinguishable from "this
   company has none".
5. **An explicit company branch.** The rarest, the easiest to find, and mostly
   legitimate when it is there.

### What holds each of them

| # | what catches it |
|---|---|
| 1 | **One declaration per concept**, mirrored rather than re-typed, pinned by `check-shared-mirrors.mjs --strict`. A literal cannot drift from a constant it does not contain. This is the real defence and the only one that would have caught the reported bug. |
| 2, 3 | Nothing automated. A query, run by a person. Say so rather than implying coverage. |
| 4 | `check-company-scope.mjs --strict`, plus the rule that an empty read may never claim the work is done (`check-empty-state-claims.mjs`). |
| 5 | `check-company-divergence.mjs --strict` — a reviewed allowlist over every line that NAMES a company, each with a reason and **whose decision it was**. A new one fails the build. |

`backend/scripts/data/company-divergence-allowlist.json` is therefore the
canonical list of per-company differences that somebody has deliberately
accepted. Read it before "fixing" an asymmetry into symmetry: two entries on it
are real capability differences the owner set on purpose —

- the **mobile build exists for HOUZS only** (`frontend/src/auth/AuthGate.tsx`,
  owner: "2990 手机关闭"), and
- the **SO-PO edit lock applies to 2990 orders only**
  (`backend/src/scm/lib/so-po-lock.ts`, owner 2026-08-12; locking HOUZS would
  have flipped a two-year backlog to amendment-only in one deploy).

The deposit threshold (HOUZS 30% / 2990 50%,
`backend/src/scm/shared/order-rules.ts`) is the third and most-quoted.

**The gate's honest limit, repeated here because a green CI run is not
coverage:** it reads source and sees code that names a company. It cannot count
rows, so it will never fail on a config row one organisation lacks — and it
would not have caught the bug it was written after.

**Measured 2026-08-13** (`.from()` write statements on tables that carry
`company_id`, across `backend/src/scm/routes` + `backend/src/routes`): 634 write
statements, of which **294 carried no company predicate on their own statement**.
The unscoped-write sweep closed the directly-reachable ones and left the rest
listed in its PR; re-measure with the same method rather than trusting this
number after the next change.

> **THE RE-MEASURE INSTRUCTION IS UNENFORCED — noted 2026-08-14.** There is no
> committed script that performs the measurement above, so "re-measure with the
> same method" cannot actually be followed; each attempt re-implements the
> heuristic and gets a slightly different denominator. That is not a nit — an
> independent replication on 2026-08-13 reproduced this denominator to within one
> statement (633 vs 634) and then applied the same unchanged script to five
> `git archive` snapshots. The **trend** it found is the part worth keeping:
>
> | tree date | unscoped / total |
> |---|---|
> | 2026-07-15 | 382 / 533 (72%) |
> | 2026-08-01 | 345 / 619 (56%) |
> | 2026-08-10 | 360 / 634 (57%) |
> | 2026-08-12 | 359 / 631 (57%) |
> | 2026-08-13 | 327 / 633 (52%) |
>
> Unscoped writes **ROSE** 345 → 359 between 08-01 and 08-12 while two dedicated
> leak PRs (#1802, #1804 "7 more cross-company read leaks") were shipping. The
> absolute counts over-count — `.insert(stampCompany(rows, c))` is scoped via a
> helper, and compensating deletes on a just-minted id are safe — so trust the
> direction, not the number.
>
> **Why this class does not converge: every remedy so far has been a sweep, and a
> sweep is a snapshot.** Seventeen of them in eight weeks, visible in the PR
> numbers alone: #625 → #632 ("third #600/#625 leak") → #637 → #639 → #640 →
> #644 → #648 → #652 → #666 ("close the costing leak #649 missed") → #826 → #851
> ("audit #826 items 3–9") → #878/#881 ("leaks beyond #851") → #1015 ("13
> remaining audit endpoints") → #1802 → #1804 → #2086 ("the writes the earlier
> audit left"). The next PR adds the 295th unscoped write with nothing objecting.
> The SCM supabase client is the **service role**, so RLS is bypassed and the
> predicate is the only tenant boundary.
>
> **The mechanical remedy, not yet built:** a lint rule (ESLint
> `no-restricted-syntax` or a custom AST check in CI) failing any `.from(<table
> carrying company_id>)` chained to `.update` / `.delete` / `.upsert` without
> `company_id` / `scopeToCompany` / `stampCompany` in the same statement, with an
> explicit allowlist for the deliberately shared masters (`currencies`,
> `lorries`, `lorry_maintenance`, `lorry_service_records`). Until that exists,
> treat the number above as a historical measurement and this section as a
> description of a hazard, not of a control.

## SEPARATE (per company — scoped by company_id)
- **SO / DO / PO / GRN / Sales Invoices / Delivery Returns / Consignment** (all docs).
- **Procurement — Products & Maintenance**: Products, SKU Master, MRP · Stock Status,
  Suppliers, Procurement Advice, and **SO maintenance** (specials / fabrics / sizes /
  combo pricing). Each company its own catalog + prices (verified live: 2990 = 334
  SKUs w/ prices, Houzs = 1326). 2990's PMS exists but unused — leave it; a fresh
  2990 company starts empty (branding / venue / warehouse / supplier / maintenance
  all need setup).
- **Warehouses / Rack** (warehouse binds at SO line, no cross-company pooling).
- **Mail Center** (mig 0107; inbound routed by recipient address).
- **Overview** (each company its own dashboard).
- **Letterhead / branding / documents** — branding is a per-SO field, captured from
  each SO (AKEMI / HOUZS / 2990S / HAPPI.S …); the mechanism is common, the value
  is per-SO.

## SHARED (one copy, all companies)
- **TMS**: drivers / helpers / lorries (global fleet) + **Delivery Planning** — ONE
  unified view across both companies, grouped by region (customer state). Orders
  auto-flow in on Ready / Processing-Date; statuses (Pending Schedule / Overdue /
  Delivered) identical both sides. **Region config is UNIFIED** — managed once via
  Delivery Planning → "Manage regions" (NOT in per-company SO maintenance).
  Multi-select → Convert to DO generates each company's own (separate) DO.
- **Service Cases module + Service Maintenance** — UNIFIED (owner 2026-07-14): one
  shared service/repair config, all cases land in one portal. (Only the Overview
  dashboard is per-company.) Caveat: unified = one config, one price; if the two
  companies ever charge different prices for the same service, this must re-split.
- **Agent Console + System Health** — unified.
- **Delivery Planning + Service Case dashboards** — unified (both companies see the
  same content).
  - CLARIFIED (2026-08-21): "both companies see the same content" describes a
    caller GRANTED both companies. It never meant "no predicate". The Delivery
    Planning board's Service-Case rows were reading `public.assr_cases` with no
    company term — raw `c.env.DB` SQL, which the supabase-js scoping helpers
    cannot reach — so a caller granted ONE company saw the other's cases there
    while `/api/assr` hid them. Owner ruling: 「这个也不可以啊」. The board's ASSR
    read AND its schedule write now carry `assrCompanySql` (the caller's granted
    companies), same as `/api/assr`. See `docs/modules/delivery-tms.md`,
    *Service Cases on the board are company-scoped*.
- **Staff roster** (scm.staff), **currencies**, so_settings,
  mrp_category_lead_times, my_localities.
  - NOTE `series` is **per-company** (`company_id NOT NULL`, mig 0083) — each
    company draws its own doc numbers; the prefix keeps the global unique safe.
  - CORRECTION (2026-07-23): **chart of accounts is SEPARATE, not SHARED.**
    `scm.accounts.company_id` is `NOT NULL` (mig 0083) and the `/accounts`,
    `/journal-entries`, `/gl` routes all `scopeToCompany` — every company has its
    own chart. 2990's 31 accounts were imported under `company_id=2`. See
    `MULTICOMPANY-SCALING.md`.
  - **SUPERSEDED 2026-09-02 — Fleet Maintenance is SHARED, records included.**
    The owner, asked directly which way to settle it:
    「共用的，因为 TMS 是共用的。这个东西 TMS 就像我们的运输公司一样」. One
    transport company, one fleet, one set of maintenance records. `scm.lorries`,
    `scm.drivers`, `scm.helpers`, `scm.lorry_maintenance` windows and
    `scm.lorry_service_records` are SHARED — and so are the module's OWN records:
    compliance vault + attachments, maintenance plans, mileage readings,
    breakdown cases, work orders + parts, components + events. `company_id` is
    still STAMPED on insert for provenance (migs 0202/0203/0204/0238 say exactly
    that) and is NOT used to scope reads or by-id writes.
    `backend/tests/fleetMaintenanceUnifiedScope.test.ts` enforces it.
  - **`scm.workshops` remains the ONE exception** and IS per-company (mig 0241).
    It is the repair-shop MASTER, not a maintenance record; the ruling was about
    the records and did not reach it.
  - *The 2026-08-13 correction this replaces said those records were SEPARATE and
    that their writes had been `scopeToCompany`d "as of the unscoped-write
    sweep", with the LIST reads left unscoped and the gap "open and tracked".
    That gap was the defect: `GET /dashboard` listed rows the by-id handlers then
    404'd, which is precisely what `fleet-maintenance.ts`'s own file marker warned
    would happen. Recorded rather than deleted, because the sweep's reasoning was
    sound and only its answer was wrong — see
    `docs/bugs/0620-the-fleet-dashboard-listed-rows-nobody-could-open.md`.*

## UNIFIED MODULE + PER-COMPANY TARGETING
- **Team** — ONE unified interface (Members / Positions / Org Chart / Departments /
  Mailboxes). Every member has a company via `public.user_companies`. Enforcement is
  Phase 0e (below). Owner/IT/管理层 = both; everyone else their company.
- **Announcements** — ONE unified module (targets by dept / position / user across the
  merged team) PLUS a **company** dimension (`target_company_ids`, mig 0113, PR #494).
  Author picks Houzs / 2990 / Both; a reader sees a notice only if its target
  intersects their `user_companies` (NULL/empty = all). Existing per-company notices
  were backfilled to their own company so nothing leaks cross-company.

## Phase 0e — per-user company enforcement (LIVE on prod 2026-07-14)
`backend/src/middleware/companyContext.ts` reads `user_companies` FAIL-OPEN: a user
with ≥1 grant is restricted to their granted companies; 0 grants (or absent table)
→ ALL companies. `/api/companies` filters the switcher list by allowedCompanyIds.
**Backfill applied (staging + prod):** every user → Houzs (company 1); role Owner /
Super Admin → also 2990 (both). Prod both-list = weisiang329 (Lim), nicochoong93
(Nico), hello@houzscentury.com, houzs.test.admin. SQL:
`backend/scripts/phase0e-backfill-user-companies.sql`. New users: invite defaults to
Houzs (Team-company PR); manage via the Team "Company" column/selector.

## Data flow (POS ↔ mirror)
- **Houzs**: orders from phone / scan (OCR) + direct backend entry.
- **2990**: orders from its POS → 2990 backend → **one-way SO mirror** (outbox trigger
  + pg_net/pg_cron on 2990) → Houzs receiver `/api/sync/so-mirror` → company_2 (LIVE
  2026-07-14; 62 SOs delivered; doc_no prefixed `2990-` so mirror overwrites the
  batch-imported rows, no duplicates). POS **NOT retired** — dual-write; P4/P5 repoint
  deferred. Any user may also open these docs directly in the merged backend.

## Verify / open follow-ups
- Overview truly per-company (spot-check).
- Delivery-Planning multi-select → DO generates the correct per-company DO.
- document-flow.ts by-id reads: adequately mitigated (company-checked roots + the main
  flow query scoped by cid) — at worst an existence oracle, not a data leak.
- Owner pre-launch: clean `SO-2607-*` test seed; assign SO Sales-Attending + 22 venues.
