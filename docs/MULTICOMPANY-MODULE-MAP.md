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

**Measured 2026-08-13** (`.from()` write statements on tables that carry
`company_id`, across `backend/src/scm/routes` + `backend/src/routes`): 634 write
statements, of which **294 carried no company predicate on their own statement**.
The unscoped-write sweep closed the directly-reachable ones and left the rest
listed in its PR; re-measure with the same method rather than trusting this
number after the next change.

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
- **Staff roster** (scm.staff), **currencies**, so_settings,
  mrp_category_lead_times, my_localities.
  - NOTE `series` is **per-company** (`company_id NOT NULL`, mig 0083) — each
    company draws its own doc numbers; the prefix keeps the global unique safe.
  - CORRECTION (2026-07-23): **chart of accounts is SEPARATE, not SHARED.**
    `scm.accounts.company_id` is `NOT NULL` (mig 0083) and the `/accounts`,
    `/journal-entries`, `/gl` routes all `scopeToCompany` — every company has its
    own chart. 2990's 31 accounts were imported under `company_id=2`. See
    `MULTICOMPANY-SCALING.md`.
  - CORRECTION (2026-08-13): the FLEET entry above ("drivers / helpers / lorries
    (global fleet)") is right about the MASTERS and was being read as covering
    the whole Fleet Maintenance module. It does not. `scm.lorries`,
    `scm.drivers`, `scm.helpers`, `scm.lorry_maintenance` windows and
    `scm.lorry_service_records` are SHARED — one vehicle, one crew roster, one
    workshop history, deliberately visible and editable from both companies (the
    routes now carry a comment naming that). But the Fleet Maintenance module's
    OWN records — compliance vault + attachments, maintenance plans, mileage
    readings, breakdown cases, work orders + parts, components + events,
    workshops — are **SEPARATE**: they stamp `company_id` on insert and their
    writes are `scopeToCompany`d as of the unscoped-write sweep. Their LIST reads
    are still unscoped; that gap is open and tracked in the sweep PR.

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
