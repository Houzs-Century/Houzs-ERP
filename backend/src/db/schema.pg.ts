// ---------------------------------------------------------------------------
// GENERATED FILE - do not hand-edit.
//
//   DATABASE_URL=... node backend/scripts/gen-schema-artifact.mjs
//
// Produced by `drizzle-kit pull` against the LIVE database, restricted to the
// tables backend/src actually imports from "../db/schema" (the list is derived
// from those imports, never typed by hand). One mechanical repair pass runs
// over the output: drizzle-kit 0.31.10 emits invalid TypeScript for a
// function-call column default, and that shape is rewritten to .default(sql``).
//
// WHY IT IS GENERATED. The hand-ported predecessor drifted from production and
// the drift was invisible: it lacked project_brands.company_id (mig 0093) and
// .logo_r2_key (mig 0069), so the SO letterhead's drizzle read could not name a
// company predicate and neither company-scope checker could see the leak that
// printed Houzs's mark on 69 of 2990's sales orders. It also declared a UNIQUE
// on project_brands.name that production does not have, and typed `trips` and
// `lorries` as tables when production has them as VIEWs.
//
// backend/scripts/check-schema-artifact-drift.mjs fails a PR when this file and
// the migration tree disagree, and answers the same question against the live
// catalog when dispatched. See docs/schema-artifact.md.
// ---------------------------------------------------------------------------
import { pgTable, index, text, bigint, foreignKey, unique, integer, timestamp, serial, doublePrecision, uuid, uniqueIndex, check, primaryKey, pgSequence, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const addon_kind = pgEnum("addon_kind", ['qty', 'floors_items', 'flat'])
export const comp_group = pgEnum("comp_group", ['1-seater', '2-seater', 'Corner', 'L-Shape', 'Accessory'])
export const consignment_do_status = pgEnum("consignment_do_status", ['LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED', 'CANCELLED'])
export const consignment_dr_status = pgEnum("consignment_dr_status", ['PENDING', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'CREDIT_NOTED', 'REJECTED', 'CANCELLED'])
export const consignment_so_status = pgEnum("consignment_so_status", ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'ON_HOLD', 'CANCELLED'])
export const currency_code = pgEnum("currency_code", ['MYR', 'RMB', 'USD', 'SGD'])
export const delivery_return_status = pgEnum("delivery_return_status", ['PENDING', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'CREDIT_NOTED', 'REJECTED', 'CANCELLED'])
export const do_status = pgEnum("do_status", ['LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED', 'CANCELLED'])
export const fabric_category = pgEnum("fabric_category", ['B.M-FABR', 'S-FABR', 'S.M-FABR', 'LINING', 'WEBBING'])
export const fabric_price_tier = pgEnum("fabric_price_tier", ['PRICE_1', 'PRICE_2', 'PRICE_3'])
export const grn_status = pgEnum("grn_status", ['POSTED', 'CLOSED', 'CANCELLED'])
export const inventory_movement_type = pgEnum("inventory_movement_type", ['IN', 'OUT', 'ADJUSTMENT', 'TRANSFER'])
export const material_kind = pgEnum("material_kind", ['mfg_product', 'fabric', 'raw'])
export const mfg_product_category = pgEnum("mfg_product_category", ['SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE', 'DINING', 'BEDLINES', 'DIFFUSER', 'CARPET'])
export const mfg_product_status = pgEnum("mfg_product_status", ['ACTIVE', 'INACTIVE'])
export const mfg_so_status = pgEnum("mfg_so_status", ['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'ON_HOLD', 'CANCELLED'])
export const po_status = pgEnum("po_status", ['SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'])
export const pricing_kind = pgEnum("pricing_kind", ['size_variants', 'sofa_build', 'bedframe_build', 'flat', 'tbc'])
export const purchase_consignment_order_status = pgEnum("purchase_consignment_order_status", ['SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'])
export const purchase_consignment_receive_status = pgEnum("purchase_consignment_receive_status", ['POSTED', 'CLOSED', 'CANCELLED'])
export const purchase_consignment_return_status = pgEnum("purchase_consignment_return_status", ['POSTED', 'COMPLETED', 'CANCELLED'])
export const purchase_invoice_status = pgEnum("purchase_invoice_status", ['POSTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'])
export const purchase_return_status = pgEnum("purchase_return_status", ['POSTED', 'COMPLETED', 'CANCELLED'])
export const sales_invoice_status = pgEnum("sales_invoice_status", ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'])
export const slip_state = pgEnum("slip_state", ['none', 'pending', 'verified', 'flagged'])
export const supplier_status = pgEnum("supplier_status", ['ACTIVE', 'INACTIVE', 'BLOCKED'])

export const assr_activity_id_seq = pgSequence("assr_activity_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_alert_acks_id_seq = pgSequence("assr_alert_acks_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_attachments_id_seq = pgSequence("assr_attachments_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_cases_id_seq = pgSequence("assr_cases_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_issue_categories_id_seq = pgSequence("assr_issue_categories_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_items_id_seq = pgSequence("assr_items_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_lead_time_activations_id_seq = pgSequence("assr_lead_time_activations_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_lead_time_amendments_id_seq = pgSequence("assr_lead_time_amendments_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_lead_time_profiles_id_seq = pgSequence("assr_lead_time_profiles_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_lead_time_scheduled_activations_id_seq = pgSequence("assr_lead_time_scheduled_activations_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_logistics_id_seq = pgSequence("assr_logistics_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_ncr_categories_id_seq = pgSequence("assr_ncr_categories_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_priorities_id_seq = pgSequence("assr_priorities_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_priority_stage_targets_id_seq = pgSequence("assr_priority_stage_targets_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_resolution_methods_id_seq = pgSequence("assr_resolution_methods_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_stage_history_id_seq = pgSequence("assr_stage_history_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_stage_targets_id_seq = pgSequence("assr_stage_targets_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_supplier_tokens_id_seq = pgSequence("assr_supplier_tokens_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const daily_inspections_id_seq = pgSequence("daily_inspections_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const delivery_status_log_id_seq = pgSequence("delivery_status_log_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const email_log_id_seq = pgSequence("email_log_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const events_id_seq = pgSequence("events_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const execution_logs_id_seq = pgSequence("execution_logs_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const idea_comments_id_seq = pgSequence("idea_comments_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const lorry_incidents_id_seq = pgSequence("lorry_incidents_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_attachments_id_seq = pgSequence("project_attachments_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_checklist_id_seq = pgSequence("project_checklist_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_checklist_attachments_id_seq = pgSequence("project_checklist_attachments_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_checklist_comments_id_seq = pgSequence("project_checklist_comments_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_checklist_sections_id_seq = pgSequence("project_checklist_sections_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_checklist_template_items_id_seq = pgSequence("project_checklist_template_items_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_checklist_template_sections_id_seq = pgSequence("project_checklist_template_sections_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_checklist_templates_id_seq = pgSequence("project_checklist_templates_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_cost_rates_id_seq = pgSequence("project_cost_rates_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_defects_id_seq = pgSequence("project_defects_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_event_types_id_seq = pgSequence("project_event_types_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_finance_project_id_seq = pgSequence("project_finance_project_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_organizers_id_seq = pgSequence("project_organizers_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_phase_photos_id_seq = pgSequence("project_phase_photos_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_sales_reports_id_seq = pgSequence("project_sales_reports_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_stock_transfers_id_seq = pgSequence("project_stock_transfers_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_team_id_seq = pgSequence("project_team_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_venues_id_seq = pgSequence("project_venues_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const purchase_orders_id_seq = pgSequence("purchase_orders_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const salary_records_id_seq = pgSequence("salary_records_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const salary_trip_lines_id_seq = pgSequence("salary_trip_lines_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const sales_commission_tiers_id_seq = pgSequence("sales_commission_tiers_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const sales_entry_activity_id_seq = pgSequence("sales_entry_activity_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const sales_entry_items_id_seq = pgSequence("sales_entry_items_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const sales_entry_payments_id_seq = pgSequence("sales_entry_payments_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const sales_orders_id_seq = pgSequence("sales_orders_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const sales_positions_id_seq = pgSequence("sales_positions_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const sales_rep_commission_tiers_id_seq = pgSequence("sales_rep_commission_tiers_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const sales_reps_id_seq = pgSequence("sales_reps_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const sales_team_activity_id_seq = pgSequence("sales_team_activity_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const supplier_accounts_id_seq = pgSequence("supplier_accounts_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const supplier_communications_id_seq = pgSequence("supplier_communications_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const supplier_invitations_id_seq = pgSequence("supplier_invitations_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const suppliers_id_seq = pgSequence("suppliers_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const trip_proposal_trips_id_seq = pgSequence("trip_proposal_trips_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const trip_proposals_id_seq = pgSequence("trip_proposals_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const trip_stops_id_seq = pgSequence("trip_stops_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const udf_fields_id_seq = pgSequence("udf_fields_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const audit_events_id_seq = pgSequence("audit_events_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "2147483647", cache: "1", cycle: false })
export const sales_entry_change_requests_id_seq = pgSequence("sales_entry_change_requests_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const assr_product_categories_id_seq = pgSequence("assr_product_categories_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "2147483647", cache: "1", cycle: false })
export const client_errors_id_seq = pgSequence("client_errors_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "2147483647", cache: "1", cycle: false })
export const phone_normalisation_backup_id_seq = pgSequence("phone_normalisation_backup_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const project_checklist_attachment_actions_id_seq = pgSequence("project_checklist_attachment_actions_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const tmp_sheet_capture_id_seq = pgSequence("tmp_sheet_capture_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "2147483647", cache: "1", cycle: false })
export const table_layouts_id_seq = pgSequence("table_layouts_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })
export const ac_snapshot_runs_id_seq = pgSequence("ac_snapshot_runs_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })

export const sessions = pgTable("sessions", {
	token: text().primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	user_id: bigint({ mode: "number" }).notNull(),
	expires_at: text().notNull(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	origin: text(),
}, (table) => [
	index("idx_sessions_expires").using("btree", table.expires_at.asc().nullsLast().op("text_ops")),
	index("idx_sessions_user").using("btree", table.user_id.asc().nullsLast().op("int8_ops")),
]);

export const departments = pgTable("departments", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "departments_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	name: text().notNull(),
	description: text(),
	color: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sort_order: bigint({ mode: "number" }).notNull(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
});

export const password_resets = pgTable("password_resets", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "password_resets_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	user_id: bigint({ mode: "number" }).notNull(),
	token: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	requested_by: bigint({ mode: "number" }),
	expires_at: text().notNull(),
	consumed_at: text(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
}, (table) => [
	index("idx_pr_token").using("btree", table.token.asc().nullsLast().op("text_ops")),
	index("idx_pr_user").using("btree", table.user_id.asc().nullsLast().op("int8_ops"), table.consumed_at.asc().nullsLast().op("int8_ops")),
]);

export const project_activity = pgTable("project_activity", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "project_activity_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	project_id: bigint({ mode: "number" }).notNull(),
	action: text().notNull(),
	from_value: text(),
	to_value: text(),
	note: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	user_id: bigint({ mode: "number" }),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	archived_at: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	company_id: bigint({ mode: "number" }).default(1).notNull(),
}, (table) => [
	index("idx_pact_project").using("btree", table.project_id.asc().nullsLast().op("int8_ops"), table.created_at.asc().nullsLast().op("int8_ops")),
	index("idx_project_activity_company_id").using("btree", table.company_id.asc().nullsLast().op("int8_ops")),
	index("idx_project_activity_project_created").using("btree", table.project_id.asc().nullsLast().op("int8_ops"), table.created_at.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.company_id],
			foreignColumns: [companies.id],
			name: "project_activity_company_id_fkey"
		}),
]);

export const roles = pgTable("roles", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "roles_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	name: text().notNull(),
	description: text(),
	permissions: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	is_system: bigint({ mode: "number" }).notNull(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	scope_to_pic: bigint({ mode: "number" }).notNull(),
});

export const companies = pgTable("companies", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "companies_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	code: text().notNull(),
	name: text().notNull(),
	is_active: integer().default(1).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("companies_code_key").on(table.code),
]);

export const positions = pgTable("positions", {
	id: serial().primaryKey().notNull(),
	department_id: integer(),
	slug: text().notNull(),
	name: text().notNull(),
	level: integer().default(100).notNull(),
	sort_order: integer().default(100).notNull(),
	active: integer().default(1).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.department_id],
			foreignColumns: [departments.id],
			name: "positions_department_id_fkey"
		}),
	unique("positions_slug_key").on(table.slug),
]);

export const project_finance_lines = pgTable("project_finance_lines", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "project_finance_lines_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	project_id: bigint({ mode: "number" }).notNull(),
	kind: text().notNull(),
	category: text().notNull(),
	description: text(),
	amount: doublePrecision().notNull(),
	occurred_at: text(),
	r2_key: text(),
	file_name: text(),
	mime_type: text(),
	notes: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_by: bigint({ mode: "number" }),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	updated_at: text(),
	archived_at: text(),
	auto_source: text(),
	company_id: integer(),
}, (table) => [
	index("idx_pfl_auto_source").using("btree", table.project_id.asc().nullsLast().op("text_ops"), table.auto_source.asc().nullsLast().op("text_ops")),
	index("idx_pfl_category").using("btree", table.category.asc().nullsLast().op("text_ops")),
	index("idx_pfl_company_kind").using("btree", table.company_id.asc().nullsLast().op("int4_ops"), table.kind.asc().nullsLast().op("int4_ops")),
	index("idx_pfl_occurred").using("btree", sql`COALESCE(occurred_at, created_at)`),
	index("idx_pfl_project").using("btree", table.project_id.asc().nullsLast().op("int8_ops"), table.kind.asc().nullsLast().op("int8_ops"), table.category.asc().nullsLast().op("text_ops")),
]);

export const projects = pgTable("projects", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "projects_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	code: text(),
	name: text().notNull(),
	stage: text().notNull(),
	start_date: text(),
	end_date: text(),
	organizer: text(),
	state: text(),
	venue: text(),
	venue_address: text(),
	brand: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	event_type_id: bigint({ mode: "number" }),
	booth_no: text(),
	size_sqm: doublePrecision(),
	notion_url: text(),
	notes: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_by: bigint({ mode: "number" }),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	updated_at: text(),
	archived_at: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	archived_by: bigint({ mode: "number" }),
	setup_start_at: text(),
	setup_end_at: text(),
	dismantle_start_at: text(),
	dismantle_end_at: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	setup_driver_user_id: bigint({ mode: "number" }),
	setup_lorry_id: uuid(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dismantle_driver_user_id: bigint({ mode: "number" }),
	dismantle_lorry_id: uuid(),
	banner_message: text(),
	banner_tone: text(),
	payment_status: text(),
	payment_proof_r2_key: text(),
	payment_proof_file_name: text(),
	payment_notes: text(),
	payment_updated_at: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	payment_updated_by: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	pic_id: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	setup_helper_1_id: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	setup_helper_2_id: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	setup_helper_outsourced: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dismantle_helper_1_id: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dismantle_helper_2_id: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	dismantle_helper_outsourced: bigint({ mode: "number" }).default(0).notNull(),
	status: text().default('pending').notNull(),
	setup_crew: text(),
	dismantle_crew: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	company_id: bigint({ mode: "number" }).default(1).notNull(),
	service_crew: text(),
	schedule_remark: text(),
}, (table) => [
	index("idx_projects_archived").using("btree", table.archived_at.asc().nullsLast().op("text_ops")),
	index("idx_projects_brand").using("btree", table.brand.asc().nullsLast().op("text_ops")),
	index("idx_projects_company_id").using("btree", table.company_id.asc().nullsLast().op("int8_ops")),
	index("idx_projects_payment").using("btree", table.payment_status.asc().nullsLast().op("text_ops")),
	index("idx_projects_pic").using("btree", table.pic_id.asc().nullsLast().op("int8_ops")),
	index("idx_projects_stage").using("btree", table.stage.asc().nullsLast().op("text_ops")),
	index("idx_projects_start").using("btree", table.start_date.asc().nullsLast().op("text_ops")),
	index("idx_projects_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("trgm_proj_brand").using("gin", table.brand.asc().nullsLast().op("gin_trgm_ops")),
	index("trgm_proj_code").using("gin", table.code.asc().nullsLast().op("gin_trgm_ops")),
	index("trgm_proj_name").using("gin", table.name.asc().nullsLast().op("gin_trgm_ops")),
	index("trgm_proj_organizer").using("gin", table.organizer.asc().nullsLast().op("gin_trgm_ops")),
	index("trgm_proj_venue").using("gin", table.venue.asc().nullsLast().op("gin_trgm_ops")),
	foreignKey({
			columns: [table.company_id],
			foreignColumns: [companies.id],
			name: "projects_company_id_fkey"
		}),
]);

export const invitations = pgTable("invitations", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "invitations_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	email: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	role_id: bigint({ mode: "number" }).notNull(),
	token: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	invited_by: bigint({ mode: "number" }).notNull(),
	expires_at: text().notNull(),
	accepted_at: text(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	position_id: integer(),
	department_id: integer(),
	manager_id: integer(),
}, (table) => [
	index("idx_invitations_email").using("btree", table.email.asc().nullsLast().op("text_ops")),
	index("idx_invitations_token").using("btree", table.token.asc().nullsLast().op("text_ops")),
]);

export const sales_entries = pgTable("sales_entries", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "sales_entries_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	project_id: bigint({ mode: "number" }),
	customer_name: text().notNull(),
	customer_code: text(),
	amount: doublePrecision().notNull(),
	currency: text().notNull(),
	occurred_at: text().notNull(),
	notes: text(),
	status: text().default('draft').notNull(),
	autocount_doc_no: text(),
	autocount_doc_type: text(),
	pushed_at: text(),
	push_error: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	created_by: bigint({ mode: "number" }).notNull(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	updated_at: text(),
	archived_at: text(),
	ref_no: text(),
	deposit_amount: doublePrecision(),
	deposit_payment_type: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sales_person_id: bigint({ mode: "number" }),
	customer_address: text(),
	customer_phone: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sales_rep_id: bigint({ mode: "number" }),
	doc_no: text(),
	processing_date: text(),
	delivery_date: text(),
	status_2: text(),
	customer_address_2: text(),
	customer_postcode: text(),
	customer_state: text(),
	customer_phone_2: text(),
	customer_email: text(),
	venue: text(),
	warehouse: text(),
	branding: text(),
	po_doc_no: text(),
	payment_status: text(),
	source: text(),
	remarks: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	company_id: bigint({ mode: "number" }).default(1).notNull(),
}, (table) => [
	index("idx_sales_entries_by_project").using("btree", table.project_id.asc().nullsLast().op("text_ops"), table.occurred_at.desc().nullsFirst().op("int8_ops")),
	index("idx_sales_entries_by_user").using("btree", table.created_by.asc().nullsLast().op("text_ops"), table.occurred_at.desc().nullsFirst().op("text_ops")),
	index("idx_sales_entries_company_id").using("btree", table.company_id.asc().nullsLast().op("int8_ops")),
	index("idx_sales_entries_customer_phone").using("btree", table.customer_phone.asc().nullsLast().op("text_ops")),
	uniqueIndex("idx_sales_entries_doc_no").using("btree", table.doc_no.asc().nullsLast().op("text_ops")).where(sql`(doc_no IS NOT NULL)`),
	index("idx_sales_entries_occurred").using("btree", table.occurred_at.desc().nullsFirst().op("text_ops")),
	index("idx_sales_entries_ref_no").using("btree", table.ref_no.asc().nullsLast().op("text_ops")),
	index("idx_sales_entries_rep").using("btree", table.sales_rep_id.asc().nullsLast().op("int8_ops")),
	index("idx_sales_entries_sales_person").using("btree", table.sales_person_id.asc().nullsLast().op("int8_ops"), table.occurred_at.desc().nullsFirst().op("text_ops")),
	index("idx_sales_entries_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.company_id],
			foreignColumns: [companies.id],
			name: "sales_entries_company_id_fkey"
		}),
]);

export const project_brands = pgTable("project_brands", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "project_brands_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	name: text().notNull(),
	color: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sort_order: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	active: bigint({ mode: "number" }).default(1).notNull(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	logo_r2_key: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	company_id: bigint({ mode: "number" }).default(1).notNull(),
}, (table) => [
	index("idx_project_brands_company_id").using("btree", table.company_id.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.company_id],
			foreignColumns: [companies.id],
			name: "project_brands_company_id_fkey"
		}),
]);

export const users = pgTable("users", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity({ name: "users_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	email: text().notNull(),
	name: text(),
	password_hash: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	role_id: bigint({ mode: "number" }).notNull(),
	status: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	invited_by: bigint({ mode: "number" }),
	invited_at: text(),
	joined_at: text(),
	last_login_at: text(),
	last_seen_at: text(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	user_type: text(),
	phone: text(),
	ic_number: text(),
	license_no: text(),
	license_expiry: text(),
	emergency_contact_name: text(),
	emergency_contact_phone: text(),
	base_salary: doublePrecision(),
	trip_allowance_rate: doublePrecision(),
	ot_rate: doublePrecision(),
	max_continuous_hours: doublePrecision(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	manager_id: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	department_id: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	points_balance: bigint({ mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	gifting_balance: bigint({ mode: "number" }).default(0).notNull(),
	gifting_reset_at: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	current_streak: bigint({ mode: "number" }).default(0).notNull(),
	profile_pic_r2_key: text(),
	company_phone: text(),
	position_id: integer(),
	totp_secret: text(),
	totp_enabled: integer().default(0).notNull(),
	totp_enrolled_at: text(),
	totp_backup_codes: text(),
	status_reason: text(),
	division: text(),
	email_alias: text(),
	assr_email_muted: integer().default(0).notNull(),
	last_path: text(),
}, (table) => [
	index("idx_users_department").using("btree", table.department_id.asc().nullsLast().op("int8_ops")),
	index("idx_users_last_seen").using("btree", table.last_seen_at.asc().nullsLast().op("text_ops")),
	index("idx_users_manager").using("btree", table.manager_id.asc().nullsLast().op("int8_ops")),
	index("idx_users_position").using("btree", table.position_id.asc().nullsLast().op("int4_ops")),
	index("idx_users_role").using("btree", table.role_id.asc().nullsLast().op("int8_ops")),
	index("idx_users_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("idx_users_type").using("btree", table.user_type.asc().nullsLast().op("text_ops")),
	index("trgm_users_email").using("gin", table.email.asc().nullsLast().op("gin_trgm_ops")),
	index("trgm_users_name").using("gin", table.name.asc().nullsLast().op("gin_trgm_ops")),
	foreignKey({
			columns: [table.position_id],
			foreignColumns: [positions.id],
			name: "users_position_id_fkey"
		}),
]);

export const push_devices = pgTable("push_devices", {
	id: serial().primaryKey().notNull(),
	user_id: integer().notNull(),
	platform: text().default('ios').notNull(),
	token: text().notNull(),
	created_at: text().default(sql`to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD HH24:MI:SS'::text)`).notNull(),
	last_seen_at: text().default(sql`to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD HH24:MI:SS'::text)`).notNull(),
	disabled_at: text(),
	last_error: text(),
	last_reminder_sent_on: text(),
}, (table) => [
	index("idx_push_devices_user").using("btree", table.user_id.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "push_devices_user_id_fkey"
		}).onDelete("cascade"),
	unique("push_devices_token_key").on(table.token),
	check("push_devices_platform_check", sql`platform = 'ios'::text`),
]);

export const user_departments = pgTable("user_departments", {
	user_id: integer().notNull(),
	department_id: integer().notNull(),
	created_at: text().default(sql`to_char((now() AT TIME ZONE 'UTC'::text), 'YYYY-MM-DD HH24:MI:SS'::text)`),
}, (table) => [
	index("idx_user_departments_dept").using("btree", table.department_id.asc().nullsLast().op("int4_ops")),
	primaryKey({ columns: [table.user_id, table.department_id], name: "user_departments_pkey"}),
]);

export const project_reads = pgTable("project_reads", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	user_id: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	project_id: bigint({ mode: "number" }).notNull(),
	last_read_at: text(),
}, (table) => [
	index("idx_project_reads_user").using("btree", table.user_id.asc().nullsLast().op("int8_ops"), table.last_read_at.desc().nullsFirst().op("int8_ops")),
	primaryKey({ columns: [table.user_id, table.project_id], name: "project_reads_pkey"}),
]);

export const user_brands = pgTable("user_brands", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	user_id: bigint({ mode: "number" }).notNull(),
	brand: text().notNull(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
}, (table) => [
	index("idx_user_brands_brand").using("btree", table.brand.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.user_id, table.brand], name: "user_brands_pkey"}),
]);

export const role_page_access = pgTable("role_page_access", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	role_id: bigint({ mode: "number" }).notNull(),
	page_key: text().notNull(),
	level: text().notNull(),
	created_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'::text)`),
	updated_at: text(),
}, (table) => [
	index("idx_role_page_access_role").using("btree", table.role_id.asc().nullsLast().op("int8_ops")),
	primaryKey({ columns: [table.role_id, table.page_key], name: "role_page_access_pkey"}),
]);

export const position_page_access = pgTable("position_page_access", {
	position_id: integer().notNull(),
	page_key: text().notNull(),
	level: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updated_at: text().default(sql`to_char(timezone('UTC'::text, now()), 'YYYY-MM-DD HH24:MI:SS'::text)`).notNull(),
}, (table) => [
	index("idx_position_page_access_position").using("btree", table.position_id.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.position_id],
			foreignColumns: [positions.id],
			name: "position_page_access_position_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.position_id, table.page_key], name: "position_page_access_pkey"}),
	check("position_page_access_level_check", sql`level = ANY (ARRAY['none'::text, 'view'::text, 'edit'::text, 'full'::text])`),
]);
