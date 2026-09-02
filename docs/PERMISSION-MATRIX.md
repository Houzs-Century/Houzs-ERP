# Permission Matrix — User Management build spec (LIVING DOC)

Source of truth for the User-Management uplift. Design ported from the owner's
reference repo `weisiang329-eng/houzs-erp` and refined with the owner in chat,
then **mapped onto the production page catalogue** (`backend/src/services/pageAccess.ts`
`PAGES[]`) and tightened to least-privilege. The seed script transcribes this
verbatim into `position_page_access`.

Levels: **-** = none, **V** = view, **E** = edit, **F** = full.

## Cascade convention (important for the seed)
Pages with sub-tabs are a parent + children. Parent **F** → all children F;
parent **-** → all children -; parent **V/E** → children use their own row.
So to grant *some* children, set the parent to **V** (cascade-neutral) and list
each child. Any page not listed for a position = **none**.

## Red lines (owner-confirmed 2026-06-13 — hide from everyone except where noted)
- **Project profit / finances** (`projects.finances`, PMS FINANCIAL+RENTAL): Finance + Sales Director (summary) only.
- **Cost / margin**: lives in `purchase_orders` + project cost. Only **Purchasing + Finance** see cost. (No standalone SKU-costing page in prod.)
- **Commission** (`sales_team` tiers): Sales mgmt + Finance only — NOT HR (HR gets org chart, not sales_team).
- **Money pages** (`orders.balance`, `orders.overdue`, `orders.pnl`, `petty_cash`): Finance (+ Sales Director for sales P&L).
- **Other people's orders/customers**: scoped to self/PIC — never the whole list for line staff.
- **Admin** (`team.roles`, `team.departments`, `settings`): admins only.

## Per-position access (production page keys)

### HQ
- **Super Admin** — handled by the `*` wildcard role (short-circuits to full); no matrix rows needed. = everything F.
- **HR Manager**: overview V · projects(parent) V, projects.calendar V · team(parent) V, team.members E, team.org_chart V.  🚫 finances, orders, cost, sales_team(commission), settings.
- **Finance Manager**: overview F · projects V, projects.list V, projects.calendar V, projects.finances F · orders V, orders.sales_orders F, orders.balance F, orders.overdue F, orders.pnl F · delivery_orders V · purchase_orders V · petty_cash F · sales V.  🚫 team admin, settings.
- **Admin Assistant**: overview V · projects V, projects.calendar E · team V, team.members V.  🚫 finances, cost, admin.

### SALES  (rule: only own/assigned projects+customers; never cost/profit-per-item/others' data)
- **Sales Director**: overview F · projects F · projects.finances V (profit summary) · orders F · sales F · sales_team F · service_cases V · team V, team.members V · **scm.procurement.products E** (owner 2026-09-01 — he maintains product master data: retail price, sofa combos, Model activation / Modular toggles; paired with `canWriteConfig: true`, since those routes gate on BOTH).  🚫 per-item cost, settings.
  - ⚠ His page access is NOT read from `position_page_access` — the sales cohort's map is defined in code (`positionPolicy.ts` `SALES_DIRECTOR_ROWS`), so this row cannot be granted or revoked from the Team > Positions screen.
- **Sales Manager**: overview V · projects V, projects.list E, projects.calendar V (own team via upline scope) · orders V, orders.sales_orders V · sales_team V (org, no tiers edit).  🚫 finances, cost, other teams.
- **Sales Executive**: overview V · projects V, projects.list V, projects.calendar V (only assigned) · orders V, orders.sales_orders V (own, scoped).  🚫 finances, cost, sales_team, others' orders.
- **Sales Person**: same as Sales Executive.
- **Sales Trainee**: overview V · projects V, projects.list V, projects.calendar V (read-only).  🚫 orders, finances, cost.

### OPERATION
- **Ops Director**: overview V · projects V, projects.list V, projects.calendar V (no finances) · service_cases F · delivery_orders F · purchase_orders F · logistics F.  🚫 projects.finances, sales orders' money, settings.
- **Ops Manager**: overview V · projects V, projects.calendar V · service_cases E · delivery_orders E · purchase_orders V · logistics E.  🚫 finances.
- **Ops Executive**: projects V, projects.calendar V · service_cases V · delivery_orders V · logistics V.  🚫 finances, purchase manage.
- **Purchasing**: projects V, projects.list V, projects.calendar V (booth/setup needs) · purchase_orders F (the cost/supplier-facing role).  🚫 customer price/profit, delivery, sales, finances.
- **Logistic**: projects V, projects.list V, projects.calendar V (setup/dismantle schedule) · delivery_orders F · logistics F (trips/fleet).  🚫 finances, cost, purchase, sales.
- **Storekeeper**: projects V, projects.calendar V · delivery_orders V (out) · purchase_orders V (incoming/GR).  🚫 price, profit, cost-margin, sales, customers. (Dedicated stock page = future.)
- **Driver / Helper**: NO staff pages (all none). They use the separate **Driver portal** (DriverHome/DriverTrip), gated by role verbs `trips.read.own` etc. — only their own assigned jobs + POD upload.

## Project-detail (PMS) section-level visibility  (layered on top of the page matrix)

| PMS role | Sections | Financial | Rental |
|---|---|---|---|
| Director (Super Admin / Sales Director) | everything + delete | YES | YES |
| Sales **PIC** (assigned PIC of THIS project) | edit, stage, workflow, booth, setup/dismantle, expo map, event chat, integrations | NO | NO |
| Sales (assigned, not PIC) | setup/dismantle, expo map, event chat | NO | NO |
| Logistic | = Sales PIC minus event chat | NO | NO |
| Purchasing | booth layout + setup only | NO | NO |
| Driver / Helper | driver portal only (not this page) | NO | NO |
| Ops / HQ (non-admin) | stage, workflow, booth, setup, expo, chat, integrations (view-only) | NO | NO |

**PIC = per-project assignment** (project's PIC column), NOT a job title.

## Calendar visibility
- Sales / Driver / Helper → only events they're PIC of / assigned to / crew on.
- Everyone else → all events.

## "Go into each position and see it" — Impersonation (owner-requested)
Owner ("我要每个position进去看要怎么样") wants to preview each position's view.
Build **Login As** (admin-only): from the Members list, an admin clicks a user →
impersonates them → sees the app exactly as that position does → a banner shows
"X impersonating Y (position)" with a Return button. Audit-logged. Plus one
**test account per position** (seed) so there's someone to enter for each.
