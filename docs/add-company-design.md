# Add Company — self-service multi-company design

Owner ask (2026-07-24): one place to **add a company + its account book**, then
**switch** to it. The new company boots **empty (fresh)**; only a few **shared**
modules are shared; **all per-company data** (SO / DO / SI / PO / GRN / PI / GL /
inventory / catalog / suppliers …) stays **separated**; it is the **same
system** everywhere. He said explicitly *"像 Hookka ERP"* — Hookka is the
reference model.

This doc is the evidence-based design for that. It builds on two existing docs —
read them first, they are not repeated here:

- [`docs/MULTICOMPANY-MODULE-MAP.md`](./MULTICOMPANY-MODULE-MAP.md) — the
  owner-locked SEPARATE / SHARED / UNIFIED classification (2026-07-14).
- [`docs/MULTICOMPANY-SCALING.md`](./MULTICOMPANY-SCALING.md) — what it takes to
  add company 3/4/5, and the company-3 onboarding checklist.

---

## 0. Headline: we are already *ahead* of Hookka — mind the reframe

The single most important finding, before any UI is drawn, is that **Hookka does
NOT actually isolate data per company** — so "像 Hookka" has to be read as
"copy Hookka's *UX*", not "copy Hookka's *data model*". The owner's data
requirement (empty/fresh, fully separated SO/DO/GL/inventory) is the **Houzs**
model, which Houzs already implements and Hookka does not.

| Concern | Hookka (`hookka-main`) | Houzs today | For "Add Company" |
|---|---|---|---|
| Company registry | `organisations` table, CRUD-able (`migrations-postgres/0142_organisations_registry.sql`) | `public.companies` (mig 0083), **read-only API** | Houzs needs the CRUD Hookka has |
| Add-company API | `POST /api/organisations` — **inserts one row, seeds nothing** (`src/api/routes/organisations.ts:241-324`) | none (rows seeded by migration/script) | build it, **and add seeding** |
| Switcher | sidebar → `PUT /api/organisations {orgId}` → `window.location.reload()` (`src/components/layout/sidebar.tsx:419-431`) | top-bar `CompanySwitcher` → `setActiveCompanyId` → reload (`frontend/src/components/TopNavbar.tsx:84-177`) | **Houzs switcher already does this** |
| Per-company data isolation | **none in practice** — chart-of-accounts, journals, doc sequences, roles all **GLOBAL**; the `org_id` tenant skeleton is **dormant** (every row = `'hookka'`, `src/api/lib/tenant.ts:4-8`) | **real** — `company_id NOT NULL` on ~118 tables, `scopeToCompany`, per-company GL | **Houzs already wins here** |
| What "company" changes | which **letterhead** prints + a booking dimension (`sales_org_code`/`purchase_org_code`, `src/lib/company-dimension.ts:1-38`) | the whole book: every SO/DO/GL/inventory row is scoped | keep the Houzs meaning |

So the plan is: **take Hookka's self-service UX** (a Settings → Companies page
with an Add/Edit modal, plus the switcher) and **wire it to the isolation Houzs
already has**, adding the one thing Hookka never built — **per-company seeding**
so a fresh company boots empty-but-usable. On true multi-company isolation we are
not catching up to Hookka; we are already past it.

---

## A. Target UX (mirroring Hookka)

The flow the owner wants, end to end, modelled on Hookka's
`src/pages/settings/organisations.tsx` (the "Add Organisation" button at line 282
opening `OrganisationFormModal`, posting to `POST /api/organisations`):

1. **One place.** Admin opens **Settings → Companies** (new page). A card/table
   lists existing companies (HOUZS, 2990, …) with code, name, active state, and
   a **Set active** / **Switch** affordance. Top-right: **Add company**.
2. **Add a company + its account book.** The Add modal captures the identity
   (code, name, and the letterhead/registration fields the documents need) and,
   in the same submit, **which chart-of-accounts template to install** (see §D).
   On save the backend inserts the `companies` row *and* seeds the new company's
   baseline (§D) so it is immediately usable.
3. **Switch to it.** The **existing top-bar company switcher** (no new UI needed)
   now offers the new company; picking it re-boots the app under that company.
4. **It boots empty but usable.** No SOs, no DOs, no inventory, no customers —
   but the chart of accounts, a default warehouse, doc-number series, roles, and
   lookups are present, so the operator can immediately raise the first document.
5. **Same system everywhere.** Same URL, same login, same modules — the switcher
   is the only thing that changed. Cross-company shared modules (Delivery
   Planning, Service Cases) pick the new company up automatically once it has
   orders (per the module map).

Hookka's page states its own doctrine on the header — *"HOOKKA is always the
actual buyer / AP entity — this is a frontend letterhead override"*
(`src/pages/settings/organisations.tsx:269-273`). Our page must state the
**opposite** doctrine, because our companies are genuinely separate books: *"Each
company keeps its own orders, inventory, and general ledger. Shared modules are
listed below."*

---

## B. What EXISTS in Houzs today vs the GAP

**Already working (company 2 = 2990 runs on all of this in production):**

- **Companies master.** `public.companies (id bigint PK, code text UNIQUE, name,
  is_active int default 1, created_at)` — `backend/src/db/migrations-pg/0083_multicompany_company_id.sql:29-38`
  (this is the live-PG twin of the D1-tree `0061`; the file header still carries
  the `0061` name). Seeds HOUZS + 2990.
- **`company_id` everywhere.** Migration 0083 adds `company_id bigint NOT NULL`
  + FK + index to ~118 per-company and cross-company tables (SO/DO/SI/PO/GRN/PI,
  inventory, accounts, series, warehouses, …), back-filling existing rows to
  HOUZS.
- **Request scoping.** `backend/src/middleware/companyContext.ts` resolves the
  active company per request from the `X-Company-Id` header (switcher) or the
  login hostname, constrained to the caller's `user_companies` grants, and
  stashes `companyId` / `companyCode` / `allowedCompanyIds` / `companies` on the
  Hono context. `backend/src/scm/lib/companyScope.ts` is the scoping toolkit —
  `scopeToCompany` (isolate), `scopeToAllowedCompanies` (widen), `stampCompany`
  (stamp on insert), plus strict write-side `requireActiveCompanyId`.
- **Switcher (frontend).** `frontend/src/lib/activeCompany.ts` stores the pick
  (per-tab sessionStorage + durable per-user localStorage) and stamps
  `X-Company-Id` on every request; `frontend/src/components/TopNavbar.tsx:84-177`
  renders `CompanySwitcher`, which **hides until `/api/companies` returns more
  than one company** (line 120) and hard-reloads on switch.
- **Companies list API.** `backend/src/routes/companies.ts` — `GET /api/companies`
  returns the caller's granted companies + which is active. **Read-only.**
- **User→company grants.** `public.user_companies (user_id, company_id)` (mig
  0085), managed by `PUT /api/users/:id/companies` gated on `users.manage`
  (`backend/src/routes/users.ts:715-781`), surfaced as the **Company column** in
  the Team page (`frontend/src/pages/Team.tsx`).
- **Per-company doc numbering.** `companyDocPrefix(c)` prefixes non-HOUZS docs
  with the company code so monthly sequences never collide on the global unique
  index (`companyScope.ts:399-424`); `series` is per-company (`company_id NOT
  NULL`, mig 0083).

**The GAP — three things, none of which exist today:**

1. **No self-service add-company API.** `backend/src/routes/companies.ts` is
   `GET`-only. Every company so far was born from a **migration** (0083 seeds
   HOUZS + 2990) or a **one-off script** — 2990's data came in via
   `backend/scripts/migrate-2990-into-houzs.mjs` (a Supabase-to-Supabase import,
   `APPLY=1`, tagging `company_id=2`), which is a **data migration of an existing
   company**, not a fresh-empty-company provisioner.
2. **No initialization/seeding of a *fresh* company.** Nothing today creates the
   baseline (chart of accounts, default warehouse, series, roles, lookups) for a
   brand-new empty company. 2990 didn't need it — it *brought* its own books.
   Company 3, starting empty, does. This is the real engineering work.
3. **No Companies admin page.** `frontend/src/pages/` has no companies page; the
   only company UI is the switcher (read) and the Team grant column (assign
   users to an *existing* company). There is no "create a company" surface.

Plus one **prerequisite migration that is in-flight, not merged**: the
per-company UNIQUE on natural-key masters (`accounts`, `product_models`,
`product_dept_configs`, `pwp_codes`) — **PR #1165**, adding
`backend/src/db/migrations-pg/0188_percompany_natural_key_masters.sql`. It is
**open** at time of writing (this baseline is at PR #1163; `0188` is absent from
the tree). `MULTICOMPANY-SCALING.md` §3 explains why it must land **before**
company 3: those masters key on a human-chosen code (`account_code`,
`model_code`, …) that a third company will legitimately reuse, and the current
constraint is global. Two companies happen not to overlap; a third breaks.

---

## C. Module classification — what is shared, what is not

This is the crux of *"什么 share、什么不 share"*. The authoritative source is
[`docs/MULTICOMPANY-MODULE-MAP.md`](./MULTICOMPANY-MODULE-MAP.md) (owner-locked);
summarized here with the code that enforces each class.

### PER-COMPANY — isolated (scoped by `company_id`, `scopeToCompany`)
Everything transactional and every book:

- **All documents:** SO / DO / SI / PO / GRN / PI / Delivery Returns /
  Consignment (every doc table has `company_id NOT NULL`, mig 0083).
- **Inventory:** `inventory_movements`, `inventory_lots`, lot consumptions,
  warehouses + racks (warehouse binds at SO line; no cross-company pooling).
- **General Ledger:** `accounts` (chart of accounts), `journal_entries`,
  `journal_lines`, `payment_vouchers` — `accounts.company_id` is `NOT NULL` and
  the `/accounts`, `/journal-entries`, `/gl` routes all `scopeToCompany`. **This
  is the biggest divergence from Hookka, whose COA is global** (Hookka
  `migrations-postgres/0206_finance_org_id.sql:26-27`: *"chart_of_accounts is
  intentionally SHARED"*). In Houzs each company has its own chart; 2990's 31
  accounts live under `company_id=2` (imported by PR #1134).
- **Catalog / masters:** Products, SKU Master, MRP, Suppliers, Procurement
  Advice, and **SO maintenance** (specials / fabrics / sizes / combo pricing).
  Each company its own catalog + prices (live: 2990 = 334 priced SKUs, Houzs =
  1326). A fresh company starts empty here — branding, venue, warehouse,
  supplier, maintenance all need setup.
- **Doc-number series** (`series`, per-company) and **Mail Center** (mig 0107,
  routed by recipient) and **Overview** (per-company dashboard).

### CROSS-COMPANY SHARED — one copy / one queue for everyone
Named from `companyScope.ts` (`scopeToAllowedCompanies` widens rather than
isolates) and the module map:

- **TMS: Delivery Planning + fleet.** One unified delivery queue across all
  companies, grouped by region; the global **fleet** — `drivers` / `helpers` /
  `lorries` — is shared by the owner's 2026-07-14 ruling. A trip can reference
  another company's DOs; multi-select → Convert to DO still generates **each
  company's own** DO. Region config is unified.
- **Shared masters:** `staff` roster, `currencies`, `so_settings`,
  `mrp_category_lead_times`, `my_localities` (`MULTICOMPANY-SCALING.md` §5:
  intentionally global — "MYR is MYR").
- **Unified-module + per-company targeting:** **Team** (one interface, each
  member carries a company via `user_companies`), **Announcements** (one module +
  a `target_company_ids` dimension, mig 0113).

### HOUZS-ONLY — pinned to the base company
- **Service Cases / ASSR.** ~~Pinned to HOUZS.~~ **NO LONGER TRUE — the pin was
  removed on 2026-07-20, and this paragraph described the opposite for weeks.**
  `assrCompanySql` (`backend/src/routes/assr.ts:145-147`) returns
  `allowedCompaniesSql(c, col)` — it IS the caller's allowed set, so a
  both-company user DOES see 2990 service cases. `houzsCompanySql` /
  `houzsCompanyIds` have no caller left anywhere in `backend/src`,
  `frontend/src` or the tests (`scm/lib/companyScope.ts:24-34` says so), and
  `backend/tests/assrCompanyScope.test.ts` pins the widened behaviour. A doc
  asserting a tenant pin that is not there is the worst shape this file can
  take: it reads as a guarantee.

**Implication for a fresh company:** it inherits the SHARED and UNIFIED modules
for free (Delivery Planning / Service Cases / fleet / staff need **nothing** —
they pick the company up once it has orders). All the PER-COMPANY masters are
what §D must seed.

---

## D. Add-company BACKEND flow

New endpoint, `POST /api/companies`, gated on a new admin permission (propose
`companies.manage`, sibling of `users.manage`). Modelled on Hookka's
`POST /api/organisations` (`src/api/routes/organisations.ts:241-324`) **but with
the seeding step Hookka omits**. Two phases, one transaction where possible:

### D.1 Insert the registry row
```sql
INSERT INTO public.companies (code, name, is_active)
VALUES (:code /* upper-cased, unique */, :name, 1);
```
Uniqueness on `code` is already enforced (mig 0083). Validate + 409 on clash,
exactly as Hookka does (`organisations.ts:251-272`). `companyContext` caches the
companies master for up to 5 min (30 s when degraded), so the new company appears
in `GET /api/companies` within ~30 s without a redeploy
(`companyContext.ts:102-108`).

### D.2 Seed the baseline so it boots empty-but-usable
This is the new work. For company `N`, seed only the PER-COMPANY masters (SHARED
modules need nothing). Follow the company-3 onboarding checklist in
`MULTICOMPANY-SCALING.md`:

| Seed | Source of truth today | Notes |
|---|---|---|
| **Chart of accounts** | template — see open question §F | Houzs has **no COA-template mechanism** yet. Candidates: (a) the 12-account baseline in `backend/src/db/migrations-pg/0022_scm_seed_reference_data.sql` (`scm.accounts` ← 2990 mig 0052); (b) clone HOUZS's live chart; (c) a curated MY-SME template. Insert stamped `company_id=N`. |
| **Doc-number series** | `scm.series` (per-company) | Create this company's `series` rows so SO/PO/GRN/… mint. Prefix rule is automatic: `companyDocPrefix` prefixes every non-HOUZS company with its code (`companyScope.ts:416-424`), so sequences never collide — **no per-series migration needed**. |
| **Default warehouse(s)** | `scm.warehouses` (per-company, mig 0086) | At least one warehouse so inventory + SO-line binding works. `type` is `NOT NULL` since mig 0177 — set a default. |
| **Roles / positions / departments** | mostly SHARED | RBAC roles/permissions are global; positions/departments are unified in Team. Seed only if the company needs its own — default is to reuse the shared set. |
| **Lookup / enum masters** | `0022_scm_seed_reference_data.sql` | `so_dropdown_options`, `size_library`, `categories`, `addons`, `delivery_fee_config`, `so_settings` — decide per-master whether shared or re-seeded (§F). |
| **Branding / letterhead** | per-SO field | Branding is captured per-SO, not per-company (module map); the company's letterhead identity fields live on the `companies` row if we extend it (Hookka keeps `letterhead_url`, `regNo`, `tin`, `msic` on `organisations`). |

**Grant the creator.** After insert, add a `user_companies` row for the acting
admin (and any owner/super-admin) via the existing `setUserCompanies` path
(`users.ts:715-755`) so the company is immediately switch-able. The Team page
handles ongoing grants.

**Land PR #1165 first.** The per-company UNIQUE batch
(`0188_percompany_natural_key_masters.sql`) is a hard prerequisite: without it,
seeding a company-3 chart of accounts whose codes overlap HOUZS/2990 violates the
still-global `UNIQUE(account_code)`. `MULTICOMPANY-SCALING.md` §3 is the spec.

**Reference how 2990 was set up** (what *not* to copy): 2990 came in through
`backend/scripts/migrate-2990-into-houzs.mjs` — a bulk import of an existing
company's real data (customers, SKUs, orders, its own 31 GL accounts), ordered to
satisfy FKs, `company_id=2`. A fresh company is the inverse: **seed a minimal
baseline, import nothing.** The import script is the precedent for *stamping
`company_id`*, not for the volume.

---

## E. FRONTEND

### E.1 New: Settings → Companies management page
`frontend/src/pages/Companies.tsx` (new), mirroring Hookka's
`src/pages/settings/organisations.tsx`:

- **List** existing companies (from `GET /api/companies`, extended to return the
  full row for admins), each with code / name / active toggle / user count.
- **Add company** button → modal (code, name, letterhead fields, COA-template
  choice) → `POST /api/companies`. On success, invalidate the `/api/companies`
  query.
- **Edit** (name, active) → `PATCH /api/companies/:id`; **Deactivate** rather
  than delete (set `is_active=0`) — Hookka soft-deletes and refuses to delete the
  default org (`organisations.ts:428-448`); we should refuse to deactivate HOUZS
  (the base company that `houzsCompanyId` and the hostname default depend on).
- Gate the page on `companies.manage`.

### E.2 The switcher already picks up a new company — no change needed
`CompanySwitcher` (`TopNavbar.tsx:84-177`) fetches `GET /api/companies` and
**renders itself the moment the list length exceeds 1** (line 120). Because
`companyContext` refreshes its cache within ~30 s, a company created in E.1
appears in the switcher automatically for any user who has been granted it — no
frontend change, no redeploy. Picking it calls `setActiveCompanyId(id)` and
hard-reloads (`TopNavbar.tsx:139-177`), after which every request carries the new
`X-Company-Id` and the whole app is scoped to the fresh company. The
per-window/per-tab model in `activeCompany.ts` means "HOUZS in one window,
Company 3 in another" works out of the box.

One nicety: after `POST /api/companies` succeeds, offer *"Switch to it now?"*
(call `setActiveCompanyId(newId)` + reload) so the admin lands in the empty
company to finish setup — matching the owner's "add, then switch" ask.

---

## F. Risks + open questions for the owner

1. **Account-book template source (biggest open decision).** Houzs has **no
   COA-template mechanism** — every existing chart was hand-carried (HOUZS
   original, 2990 imported). Where does company 3's chart come from? Options:
   (a) clone HOUZS's current live chart; (b) the 12-account baseline seed in
   `0022_scm_seed_reference_data.sql`; (c) a proper MY-SME template the owner
   signs off. **Owner decides.** This is *the* thing that makes "add its account
   book" real rather than aspirational.
2. **Which masters are truly shared vs must be re-seeded per company.** The
   module map fixes most of it, but a few lookups (`so_dropdown_options`,
   `size_library`, `categories`, `delivery_fee_config`, `so_settings`) currently
   exist as one set. Decide per-master: share the one copy, or give each company
   its own. `app_config` has the same open question (`MULTICOMPANY-SCALING.md`
   §4). Default today is *share*; anything that must differ becomes
   `PK(company_id, key)`.
3. **PR #1165 must land before company 3.** Non-negotiable prerequisite (§B, §D).
   Until `0188` is merged and applied, an add-company that seeds a colliding
   chart of accounts, model code, product-dept config, or promo code will fail on
   the global unique. Track it to merge before shipping the Add button.
4. **`jePrefixForCompany` is hardcoded to `2990-` for every non-HOUZS company.**
   `backend/src/scm/lib/doc-no.ts:159-160`:
   `companyId == null || Number(companyId) === 1 ? '' : '2990-'`. So a company-3
   journal entry would be minted as `2990-JE-…` and **collide with 2990's JE
   sequence** — a real data-corruption landmine. This must be generalized to use
   the company *code* (like `companyDocPrefix` already does) before company 3.
   Concrete fix, in scope of this work.
5. **Team "Both" wording assumes exactly two companies.**
   `frontend/src/pages/Team.tsx:142-148` labels a full grant set "Both". With
   three companies "Both" is wrong; needs to become "All" (or list the codes).
   Minor UI, but user-visible the moment company 3 exists.
6. **User→company grant flow on creation.** Who is auto-granted the new company —
   just the creating admin, or all owners/super-admins (the current 2990 both-list
   is weisiang329 / nicochoong93 / hello@houzscentury.com / houzs.test.admin,
   per `MULTICOMPANY-MODULE-MAP.md` §0e)? Propose: creator + all `is_owner` roles,
   editable afterward in Team. Owner confirms.
7. **Hostname default has no home for company 3.** `defaultCompanyCodeForHost`
   only knows `2990` → 2990, everything else → HOUZS
   (`companyContext.ts:84-88`). A third company has no login hostname, so its
   users rely entirely on the switcher + their `user_companies` grant. Fine for
   an internal add, but note it: there is no `erp.company3.com` default.
8. **The referenced locked design doc is not in the repo.** Both
   `companyContext.ts` and `companyScope.ts` cite *"Design:
   docs/2026-07-多公司合并设计.md (locked)"*, but that file is not in the tree
   (it lives in the owner's notes / Obsidian). This doc is the repo-side design
   of record for the *add-company* slice; the isolation design of record remains
   the two `MULTICOMPANY-*.md` docs.

---

## Appendix: reusable ideas from Hookka (and what to skip)

**Borrow:** the `organisations` registry + CRUD shape; the `is_default` /
soft-delete conventions (refuse to remove the base company); the Settings page +
Add/Edit modal UX; a default-safe company resolver.

**Skip / invert:** Hookka's *"company = letterhead override, books stay global"*
model. Our companies are separate books. The `sales_org_code` /
`purchase_org_code` per-document booking dimension is Hookka's substitute for the
`company_id` isolation Houzs already has — we do not need it. And Hookka's
`POST /api/organisations` seeds nothing; **our whole engineering value is §D's
seeding step.**
