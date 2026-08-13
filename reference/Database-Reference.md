# Houzs ERP — Database Reference

Every table in the Houzs database, grouped by module. Built so you can find
any table fast: Ctrl+F a table name, a module name, or a keyword (e.g.
"commission", "lorry", "checklist").

- **Engine:** migrating D1 (SQLite) -> Supabase Postgres (Singapore). See
  `docs/archive/MIGRATION-D1-TO-SUPABASE.md` for status (archived — that
  migration completed 2026-06-13). Migration coverage is marked per
  module below.
- **Total:** ~107 tables across 12 modules.
- **Naming:** snake_case, module-prefixed (`assr_*`, `project_*`, `sales_*`,
  `lorry_*`, `trip_*`, `assr_*`). Lookup tables hold dropdown/enum rows.
  `*_activity` tables are append-only audit/chat trails. `*_new` / `*_rebuild`
  are transitional copies left by a migration — not live, safe to ignore.

How this maps to a standard ERP (ERPNext/Odoo) is noted on each module so the
structure is familiar to any ERP developer.

---

## Module map (jump list)

| # | Module | ERPNext/Odoo equivalent | Tables |
|---|---|---|---|
| 1 | Auth, Users & Access | Users / Roles / Permissions | 9 |
| 2 | External Portals & Public Tokens | Portal / Website users | 8 |
| 3 | Projects / Event Management (PMS) | Projects | 21 |
| 4 | Project Finance | Project Costing / Profitability | 3 |
| 5 | Sales | Selling | 10 |
| 6 | Procurement, Suppliers & Stock | Buying / Stock | 7 |
| 7 | Delivery, Fleet & Logistics (TMS) | Stock Delivery / Fleet (custom) | 17 |
| 8 | After-Sales Service / QMS (ASSR) | Support / Quality (NCR/CAPA) | 18 |
| 9 | Company Finance | Accounting (light) | 1 |
| 10 | Gamification & Engagement | (no standard equivalent) | 11 |
| 11 | AutoCount Integration / Sync | External accounting sync | 4 |
| 12 | System & Config | Settings / Email queue | 2 |

---

## 1. Auth, Users & Access Control
ERPNext: User + Role + Role Permission. Internal staff directory and the flat
string-permission model (`projects.read` etc.).

| Table | Purpose |
|---|---|
| `users` | Internal staff directory. Login, role, manager/department, Houzs Points balances, profile pic. |
| `roles` | Role definitions; `permissions` is a JSON array of flat permission strings. |
| `role_page_access` | Per-page access matrix (role x page -> none/partial/full). mig 073. |
| `sessions` | Bearer-token sessions; AuthMiddleware walks this every request. |
| `invitations` | One-shot email + role invite tokens; consumed on accept. |
| `password_resets` | Admin-triggered 1-hour reset tokens. mig 027. |
| `departments` | Department directory. |
| `department_brands` | Department -> brand mapping. |
| `user_brands` | Person-level brand allow-list; drives sales project visibility. mig 049. |

## 2. External Portals & Public Tokens
ERPNext: Portal users / Website. Separate auth for customers, suppliers, and
public one-shot links (no internal account).

| Table | Purpose |
|---|---|
| `customer_accounts` | Customer portal accounts. |
| `customer_invitations` | Customer portal invites / password reset. |
| `customer_sessions` | Customer portal sessions. |
| `supplier_accounts` | Supplier portal accounts. |
| `supplier_invitations` | Supplier portal invites. |
| `supplier_sessions` | Supplier portal sessions. |
| `case_track_tokens` | Per-case public tracking link tokens. |
| `assr_supplier_tokens` / `assr_survey_tokens` | Public ASSR links (supplier action / customer survey). |

## 3. Projects / Event Management (PMS)
ERPNext: Projects + Tasks. The core entity — each `project` is an exhibition/
event. Checklists, photos, team, venue/organizer masters hang off it.

| Table | Purpose |
|---|---|
| `projects` | Central entity: each event/exhibition. Stage, status, brand, PIC, setup/dismantle crew. |
| `project_event_types` | Event type lookup. |
| `project_brands` | Brand lookup. |
| `project_venues` | Venue master. |
| `project_organizers` | Organizer master. |
| `project_team` | Project team members. |
| `project_sales_attendees` | Reps attending a project (booth duty). mig 087. |
| `project_activity` | Append-only audit + chat trail; drives notifications + in-project chat. |
| `project_reads` | Per-user x per-project last-read timestamp (unread dot). mig 045. |
| `project_attachments` | Project-level files (legacy; kept for old data). |
| `project_phase_photos` | Crew-uploaded setup/dismantle phase evidence. |
| `project_checklist` | Per-project tasklist rows. |
| `project_checklist_sections` | Tasklist sections (Pre-event / Setup / Live / Teardown). mig 050. |
| `project_checklist_attachments` | Per-task file attachments. mig 050. |
| `project_checklist_comments` | Per-task comments. |
| `project_checklist_templates` | Checklist templates. |
| `project_checklist_template_sections` | Template-side sections. mig 050. |
| `project_checklist_template_items` | Template-side tasks. mig 050. |
| `project_defects` | Per-project defect log. |
| `project_stock_transfers` | Stock transfers tied to a project. |
| `project_sales_reports` | Per-project sales reports. |

## 4. Project Finance
ERPNext: Project profitability / costing. Per-event revenue, cost, and the
auto cost-line engine.

| Table | Purpose |
|---|---|
| `project_finance` | One row per project: rental + sales + cost totals. |
| `project_finance_lines` | Per-line ledger; `kind` = income/cost, `auto_source` for engine-generated lines. |
| `project_cost_rates` | Per-brand rate card driving the auto cost-line engine. mig 063. |

## 5. Sales
ERPNext: Selling (Sales Order, Sales Person, Commission). Rep-keyed sales
plus the AutoCount-mirrored sales orders.

| Table | Purpose |
|---|---|
| `sales_entries` | Rep-keyed sales transactions (gross + deposit split). mig 041/051. |
| `sales_entry_items` | Per-line items on a sales entry. |
| `sales_entry_payments` | Per-payment rows on a sales entry. |
| `sales_orders` | AutoCount-mirrored sales orders (see module 11). |
| `sales_reps` | Retail rep org chart (separate from `users`). mig 067. |
| `sales_positions` | Rep position lookup (level, sort). |
| `sales_commission_tiers` | Commission tier lookup. |
| `sales_rep_commission_tiers` | Per-rep commission tier table. |
| `sales_rep_brands` | Per-rep brand allow-list. |
| `sales_team_activity` | Sales-team audit log (mirrors project_activity shape). |

## 6. Procurement, Suppliers & Stock
ERPNext: Buying + Stock (Item, Warehouse). Local suppliers plus AutoCount
PO/creditor mirrors.

| Table | Purpose |
|---|---|
| `suppliers` | Local supplier master. |
| `supplier_communications` | Supplier relationship history (calls, emails, meetings). |
| `creditors` | AutoCount-mirrored creditors (read-only). |
| `purchase_order_docs` | PO header records (joined with PO lines for "outstanding"). |
| `purchase_orders` | AutoCount-mirrored PO line items (in Drizzle schema). |
| `stock_items` | Stock item master. |
| `warehouses` | Warehouses (5 internal + 1 SG hub). |

## 7. Delivery, Fleet & Logistics (TMS)
ERPNext: Delivery Note + a custom Fleet module. Trips, lorries, drivers, GPS,
compliance, driver pay.

| Table | Purpose |
|---|---|
| `trips` | Delivery trips (driver, lorry, warehouse, date, status). |
| `trip_stops` | Stops on a trip (sequence, status, POD/signature R2 keys). |
| `trip_locations` | Trip GPS pings (append-only). |
| `trip_proposals` | Planner-generated trip proposals. |
| `trip_proposal_trips` | Proposal -> trip link rows. |
| `lorries` | Fleet vehicles. |
| `lorry_compliance` | Compliance docs (PUSPAKOM, road tax, insurance). |
| `lorry_incidents` | Incidents & claims. |
| `lorry_maintenance` | Maintenance / service records. |
| `driver_clock_records` | Driver daily clock (independent of trips). |
| `daily_inspections` | Daily vehicle inspections. |
| `delivery_tracking` | Delivery tracking state. |
| `delivery_status_log` | Delivery status history (audit log). |
| `salary_records` | Monthly salary aggregate per user. |
| `salary_trip_lines` | Per-trip salary breakdown. |
| `warehouses` / `state_warehouse_map` | Warehouse master + state->warehouse routing. |
| `events` | Setup/dismantle calendar entries (also AutoCount-related). |

## 8. After-Sales Service / QMS (ASSR)
ERPNext: Support (Issue/Warranty) + Quality (Non-conformance, CAPA). The
biggest module — a full case lifecycle with SLA stage targets and lead times.

| Table | Purpose |
|---|---|
| `assr_cases` | ASSR cases — the live case table (renamed from `assr_cases_new` in mig 074). |
| `assr_items` | Items selected for service from the SO. |
| `assr_activity` | Audit trail: stage transitions, notes, assignments. |
| `assr_attachments` | Photos, videos, completion evidence. |
| `assr_stage_history` | Per-(case, stage) lifecycle rows; closed rows have `exited_at`. |
| `assr_stage_targets` | SLA target per stage. |
| `assr_priority_stage_targets` | SLA target per (priority x stage). |
| `assr_priorities` | Priority lookup. |
| `assr_issue_categories` | Issue category lookup. |
| `assr_ncr_categories` | NCR (non-conformance) category lookup. |
| `assr_resolution_methods` | Resolution method lookup. |
| `assr_logistics` | Pickup / delivery scheduling for a case. |
| `assr_lead_time_profiles` | Lead-time profiles. |
| `assr_lead_time_activations` | Lead-time activations. |
| `assr_lead_time_scheduled_activations` | Scheduled lead-time activations. |
| `assr_lead_time_amendments` | Lead-time amendments. |
| `assr_alert_acks` | SLA alert acknowledgements. |
| (`assr_supplier_tokens`, `assr_survey_tokens`) | Public tokens — see module 2. |

## 9. Company Finance
ERPNext: Accounting (light). Currently just the petty-cash float.

| Table | Purpose |
|---|---|
| `petty_cash_entries` | Single global petty-cash float; `direction` gives the sign. mig 060. |

## 10. Gamification & Engagement
No standard ERP equivalent. Houzs Points, streaks, awards store, idea/suggestion
boards. Points balances on `users` are caches derived from `point_transactions`.

| Table | Purpose |
|---|---|
| `point_transactions` | Append-only points ledger (source of truth for balances). mig 055. |
| `user_streak_weeks` | Weekly streak tally (one row per user per ISO week). |
| `leaderboard_cache` | Pre-aggregated top-N leaderboard rows per scope/period. |
| `gamify_settings` | Admin-tunable values (point values, thresholds). |
| `awards` | Redeemable award catalogue. mig 056. |
| `award_redemptions` | Redemption lifecycle (pending -> shipped -> delivered). |
| `votes` | Polymorphic upvotes (one per target x voter). mig 057. |
| `innovations` | Strategic ideas (build/explore/improve). mig 057. |
| `suggestions` | Operational fix suggestions. mig 057. |
| `idea_attachments` | Files on innovation/suggestion posts. mig 059. |
| `idea_comments` | Comments on innovation/suggestion posts. |

## 11. AutoCount Integration / Sync
External accounting sync. These tables are read-mirrors of AutoCount, refreshed
by the `*/5` and `*/30` cron pulls. Distinct from the local sales/procurement
tables.

| Table | Purpose |
|---|---|
| `sales_orders` | AutoCount sales-order mirror (also in module 5). |
| `creditors` | AutoCount creditor mirror (also in module 6). |
| `purchase_order_docs` | AutoCount PO header mirror (also in module 6). |
| `events` | Calendar entries synced from / aligned with AutoCount jobs. |

## 12. System & Config

| Table | Purpose |
|---|---|
| `app_settings` | Key-value application config. |
| `email_log` | Outbound transactional email log. |

---

## Conventions cheat-sheet

- **Prefix = module.** `assr_*` after-sales, `project_*` PMS, `sales_*` sales,
  `lorry_*`/`trip_*` fleet, `customer_*`/`supplier_*` portals.
- **Lookup tables** (`*_categories`, `*_priorities`, `*_positions`, `*_tiers`,
  `*_event_types`, `*_resolution_methods`) hold dropdown/enum rows — small,
  rarely change, often seeded in migrations.
- **`*_activity`** = append-only audit + chat trail.
- **`*_tokens`** = one-shot public links (no login).
- **Ledgers** (`point_transactions`, `project_finance_lines`) are append-only;
  any cached balance is derived from them.
- **Transitional / dead:** `projects_new`, `projects_rebuild`, `assr_cases_new`
  came from table-rebuild migrations. The live ASSR table is **`assr_cases`**
  (`assr_cases_new` was renamed to it in mig 074); the `projects_*` copies are inert.

## Migration status (D1 -> Supabase)

- 57 tables already in Supabase (the Drizzle-reflected set in `schema.pg.ts`).
- ~50 tables still D1-only (raw-SQL tables, mostly `assr_*`, portal, fleet,
  lookups). They need their DDL ported before cutover — tracked in
  `docs/archive/MIGRATION-D1-TO-SUPABASE.md`.
- Data not yet copied: requires a `wrangler d1 export autocount-sync` from the
  Cloudflare account that owns the D1 database.

---

## A-Z table index

Ctrl+F a table name; the number is its module section above.

| Table | Module |
|---|---|
| `app_settings` | 12 System |
| `assr_activity` | 8 ASSR/QMS |
| `assr_alert_acks` | 8 ASSR/QMS |
| `assr_attachments` | 8 ASSR/QMS |
| `assr_cases_new` | 8 ASSR/QMS |
| `assr_issue_categories` | 8 ASSR/QMS |
| `assr_items` | 8 ASSR/QMS |
| `assr_lead_time_activations` | 8 ASSR/QMS |
| `assr_lead_time_amendments` | 8 ASSR/QMS |
| `assr_lead_time_profiles` | 8 ASSR/QMS |
| `assr_lead_time_scheduled_activations` | 8 ASSR/QMS |
| `assr_logistics` | 8 ASSR/QMS |
| `assr_ncr_categories` | 8 ASSR/QMS |
| `assr_priorities` | 8 ASSR/QMS |
| `assr_priority_stage_targets` | 8 ASSR/QMS |
| `assr_resolution_methods` | 8 ASSR/QMS |
| `assr_stage_history` | 8 ASSR/QMS |
| `assr_stage_targets` | 8 ASSR/QMS |
| `assr_supplier_tokens` | 8 ASSR/QMS |
| `assr_survey_tokens` | 8 ASSR/QMS |
| `award_redemptions` | 10 Gamify |
| `awards` | 10 Gamify |
| `case_track_tokens` | 2 Portals |
| `creditors` | 6 Procurement |
| `customer_accounts` | 2 Portals |
| `customer_invitations` | 2 Portals |
| `customer_sessions` | 2 Portals |
| `daily_inspections` | 7 Delivery/TMS |
| `delivery_status_log` | 7 Delivery/TMS |
| `delivery_tracking` | 7 Delivery/TMS |
| `department_brands` | 1 Auth/Users |
| `departments` | 1 Auth/Users |
| `driver_clock_records` | 7 Delivery/TMS |
| `email_log` | 12 System |
| `events` | 7 Delivery/TMS |
| `gamify_settings` | 10 Gamify |
| `idea_attachments` | 10 Gamify |
| `idea_comments` | 10 Gamify |
| `innovations` | 10 Gamify |
| `invitations` | 1 Auth/Users |
| `leaderboard_cache` | 10 Gamify |
| `lorries` | 7 Delivery/TMS |
| `lorry_compliance` | 7 Delivery/TMS |
| `lorry_incidents` | 7 Delivery/TMS |
| `lorry_maintenance` | 7 Delivery/TMS |
| `password_resets` | 1 Auth/Users |
| `petty_cash_entries` | 9 Finance |
| `point_transactions` | 10 Gamify |
| `project_activity` | 3 Projects/PMS |
| `project_attachments` | 3 Projects/PMS |
| `project_brands` | 3 Projects/PMS |
| `project_checklist` | 3 Projects/PMS |
| `project_checklist_attachments` | 3 Projects/PMS |
| `project_checklist_comments` | 3 Projects/PMS |
| `project_checklist_sections` | 3 Projects/PMS |
| `project_checklist_template_items` | 3 Projects/PMS |
| `project_checklist_template_sections` | 3 Projects/PMS |
| `project_checklist_templates` | 3 Projects/PMS |
| `project_cost_rates` | 4 ProjFinance |
| `project_defects` | 3 Projects/PMS |
| `project_event_types` | 3 Projects/PMS |
| `project_finance` | 4 ProjFinance |
| `project_finance_lines` | 4 ProjFinance |
| `project_organizers` | 3 Projects/PMS |
| `project_phase_photos` | 3 Projects/PMS |
| `project_reads` | 3 Projects/PMS |
| `project_sales_attendees` | 3 Projects/PMS |
| `project_sales_reports` | 3 Projects/PMS |
| `project_stock_transfers` | 3 Projects/PMS |
| `project_team` | 3 Projects/PMS |
| `project_venues` | 3 Projects/PMS |
| `projects` | 3 Projects/PMS |
| `purchase_order_docs` | 6 Procurement |
| `purchase_orders` | 6 Procurement |
| `role_page_access` | 1 Auth/Users |
| `roles` | 1 Auth/Users |
| `salary_records` | 7 Delivery/TMS |
| `salary_trip_lines` | 7 Delivery/TMS |
| `sales_commission_tiers` | 5 Sales |
| `sales_entries` | 5 Sales |
| `sales_entry_items` | 5 Sales |
| `sales_entry_payments` | 5 Sales |
| `sales_positions` | 5 Sales |
| `sales_rep_brands` | 5 Sales |
| `sales_rep_commission_tiers` | 5 Sales |
| `sales_reps` | 5 Sales |
| `sales_team_activity` | 5 Sales |
| `sessions` | 1 Auth/Users |
| `state_warehouse_map` | 7 Delivery/TMS |
| `stock_items` | 6 Procurement |
| `suggestions` | 10 Gamify |
| `supplier_accounts` | 2 Portals |
| `supplier_communications` | 6 Procurement |
| `supplier_invitations` | 2 Portals |
| `supplier_sessions` | 2 Portals |
| `suppliers` | 6 Procurement |
| `trip_locations` | 7 Delivery/TMS |
| `trip_proposal_trips` | 7 Delivery/TMS |
| `trip_proposals` | 7 Delivery/TMS |
| `trip_stops` | 7 Delivery/TMS |
| `trips` | 7 Delivery/TMS |
| `user_brands` | 1 Auth/Users |
| `user_streak_weeks` | 10 Gamify |
| `users` | 1 Auth/Users |
| `votes` | 10 Gamify |
| `warehouses` | 7 Delivery/TMS |
