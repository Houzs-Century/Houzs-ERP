CREATE TABLE "award_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"award_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"cost_points" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"shipping_addr" text,
	"admin_note" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"shipped_at" text,
	"delivered_at" text,
	"cancelled_at" text,
	"cancelled_by" integer,
	"ledger_tx_id" integer
);
--> statement-breakpoint
CREATE TABLE "awards" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cost_points" integer NOT NULL,
	"stock" integer,
	"image_r2_key" text,
	"active" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "creditors" (
	"creditor_code" text PRIMARY KEY NOT NULL,
	"company_name" text,
	"desc2" text,
	"email" text,
	"phone1" text,
	"mobile" text,
	"tax_register_no" text,
	"currency_code" text,
	"type" text,
	"type_description" text,
	"purchase_agent" text,
	"purchase_agent_description" text,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text DEFAULT '64748b' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "departments_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"event_date" text NOT NULL,
	"address" text,
	"status" text,
	"notes" text,
	"created_by" integer,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "gamify_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"target_id" integer NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text,
	"size_bytes" integer,
	"uploaded_by" integer,
	"uploaded_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "innovations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tags" text,
	"status" text DEFAULT 'review' NOT NULL,
	"decided_by" integer,
	"decided_at" text,
	"decline_reason" text,
	"awarded_at" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role_id" integer NOT NULL,
	"token" text NOT NULL,
	"invited_by" integer NOT NULL,
	"expires_at" text NOT NULL,
	"accepted_at" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "leaderboard_cache" (
	"scope" text NOT NULL,
	"period" text NOT NULL,
	"computed_at" text NOT NULL,
	"rows_json" text NOT NULL,
	CONSTRAINT "leaderboard_cache_scope_period_pk" PRIMARY KEY("scope","period")
);
--> statement-breakpoint
CREATE TABLE "lorries" (
	"id" serial PRIMARY KEY NOT NULL,
	"plate" text NOT NULL,
	"size" text,
	"default_driver_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "lorry_incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer
);
--> statement-breakpoint
CREATE TABLE "order_details" (
	"doc_no" text PRIMARY KEY NOT NULL,
	"delivery_date" text,
	"time_range" text,
	"time_confirmed" integer,
	"lorry_plate" text,
	"driver_name" text,
	"driver_contact" text,
	"days_left" integer,
	"internal_purchasing" text,
	"property_type" text,
	"new_house_replacement" text,
	"item_details" text,
	"done_delivery" integer,
	"consignment_no" text,
	"eta_port" text,
	"estimate_delivery" text,
	"m3" integer,
	"vessel_voyage" text,
	"etd_port_klang" text,
	"eta_destination" text,
	"transporter_remarks" text,
	"seafreight" integer,
	"local_charges" integer,
	"inland" integer,
	"agent_fee" integer,
	"insurance" integer,
	"total_cost" integer,
	"shipout_date" text,
	"warehouse" text,
	"state" text,
	"lat" integer,
	"lng" integer,
	"order_type" text,
	"proposed_delivery_date" text,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "overdue_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"pull_date" text NOT NULL,
	"doc_no" text NOT NULL,
	"debtor_name" text,
	"location" text,
	"region" text,
	"balance" integer,
	"original_expiry_date" text,
	"extended_to" text,
	"remark4" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"requested_by" integer,
	"expires_at" text NOT NULL,
	"consumed_at" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "password_resets_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "petty_cash_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"category" text,
	"counterparty" text,
	"note" text,
	"receipt_r2_key" text,
	"posted_by" integer NOT NULL,
	"occurred_on" text NOT NULL,
	"archived_at" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "point_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"pool" text NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"ref_type" text,
	"ref_id" integer,
	"counterparty_user_id" integer,
	"note" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "project_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"user_id" integer,
	"action" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"note" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "project_brands" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '64748b' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "project_brands_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "project_checklist" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"section_id" integer,
	"seq" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"required_perm" text,
	"role_label" text,
	"crew_visible" integer DEFAULT 0 NOT NULL,
	"due_date" text,
	"due_offset_days" integer,
	"owner_user_id" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_r2_key" text,
	"completed_by" integer,
	"completed_at" text,
	"notes" text,
	"review_status" text,
	"rejection_reason" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "project_checklist_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"r2_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text,
	"size_bytes" integer,
	"uploaded_by" integer,
	"uploaded_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "project_checklist_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"display_mode" text DEFAULT 'list' NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "project_checklist_template_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"section_id" integer,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"required_perm" text,
	"role_label" text,
	"crew_visible" integer DEFAULT 0 NOT NULL,
	"due_offset_days" integer,
	"requires_review" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_checklist_template_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"display_mode" text DEFAULT 'list' NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "project_checklist_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "project_cost_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"brand" text NOT NULL,
	"transport_pct" integer DEFAULT 0 NOT NULL,
	"merchandise_pct" integer DEFAULT 0 NOT NULL,
	"commission_normal_pct" integer DEFAULT 0 NOT NULL,
	"commission_boost_pct" integer,
	"boost_min_gp_pct" integer,
	"boost_min_sales" integer,
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_by" integer,
	CONSTRAINT "project_cost_rates_brand_unique" UNIQUE("brand")
);
--> statement-breakpoint
CREATE TABLE "project_finance" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"rental" integer,
	"total_sales" integer,
	"contractor_cost" integer,
	"license_fee" integer,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "project_finance_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"kind" text NOT NULL,
	"category" text,
	"description" text,
	"amount" integer,
	"occurred_at" text,
	"notes" text,
	"r2_key" text,
	"file_name" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"created_by" integer,
	"archived_at" text,
	"auto_source" text
);
--> statement-breakpoint
CREATE TABLE "project_phase_photos" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"phase" text NOT NULL,
	"r2_key" text NOT NULL,
	"content_type" text,
	"caption" text,
	"uploaded_by" integer,
	"uploaded_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_reads" (
	"project_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"last_read_at" text NOT NULL,
	CONSTRAINT "project_reads_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "project_sales_attendees" (
	"project_id" integer NOT NULL,
	"sales_rep_id" integer NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"created_by" integer,
	CONSTRAINT "project_sales_attendees_project_id_sales_rep_id_pk" PRIMARY KEY("project_id","sales_rep_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"stage" text DEFAULT 'draft' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"start_date" text,
	"end_date" text,
	"venue" text,
	"venue_address" text,
	"brand" text,
	"pic_id" integer,
	"created_by" integer,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"archived_at" text,
	"setup_start_at" text,
	"setup_end_at" text,
	"dismantle_start_at" text,
	"dismantle_end_at" text,
	"setup_driver_user_id" integer,
	"setup_lorry_id" integer,
	"dismantle_driver_user_id" integer,
	"dismantle_lorry_id" integer,
	"setup_helper_1_id" integer,
	"setup_helper_2_id" integer,
	"setup_helper_outsourced" integer DEFAULT 0 NOT NULL,
	"dismantle_helper_1_id" integer,
	"dismantle_helper_2_id" integer,
	"dismantle_helper_outsourced" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "projects_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_docs" (
	"doc_no" text PRIMARY KEY NOT NULL,
	"doc_date" text,
	"ref" text,
	"creditor_code" text,
	"creditor_name" text,
	"cancelled" integer,
	"doc_status" text,
	"final_total" integer,
	"local_ex_tax" integer,
	"currency_code" text,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text NOT NULL,
	"doc_date" text,
	"creditor_code" text,
	"creditor_name" text,
	"item_code" text,
	"item_description" text,
	"remaining_qty" integer,
	"delivery_date" text,
	"supplier_date1" text,
	"supplier_date2" text,
	"supplier_date3" text,
	"overdue_days" text,
	"amount" integer,
	"unit_price" integer,
	"amount_source" text,
	"amount_updated_at" text,
	"amount_updated_by" integer,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "role_page_access" (
	"role_id" integer NOT NULL,
	"page_key" text NOT NULL,
	"level" text NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "role_page_access_role_id_page_key_pk" PRIMARY KEY("role_id","page_key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" text DEFAULT '[]' NOT NULL,
	"is_system" integer DEFAULT 0 NOT NULL,
	"scope_to_pic" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "salary_trip_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_commission_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"rate" integer DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "sales_commission_tiers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sales_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_no" text,
	"project_id" integer,
	"ref_no" text,
	"customer_name" text NOT NULL,
	"customer_code" text,
	"customer_address" text,
	"customer_address_2" text,
	"customer_postcode" text,
	"customer_state" text,
	"customer_phone" text,
	"customer_phone_2" text,
	"customer_email" text,
	"amount" integer NOT NULL,
	"deposit_amount" integer,
	"deposit_payment_type" text,
	"currency" text DEFAULT 'MYR' NOT NULL,
	"occurred_at" text NOT NULL,
	"processing_date" text,
	"delivery_date" text,
	"status_2" text,
	"venue" text,
	"warehouse" text,
	"branding" text,
	"po_doc_no" text,
	"payment_status" text,
	"source" text,
	"remarks" text,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"autocount_doc_no" text,
	"autocount_doc_type" text,
	"pushed_at" text,
	"push_error" text,
	"sales_person_id" integer,
	"created_by" integer NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "sales_entry_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"line_no" integer DEFAULT 0 NOT NULL,
	"item_code" text,
	"item_description" text,
	"remarks" text,
	"qty" double precision DEFAULT 1 NOT NULL,
	"unit_price" double precision DEFAULT 0 NOT NULL,
	"amount" double precision DEFAULT 0 NOT NULL,
	"group_tag" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "sales_entry_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"paid_at" text NOT NULL,
	"payment_method" text NOT NULL,
	"amount" double precision NOT NULL,
	"account_sheet" text,
	"approval_code" text,
	"collected_by" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"doc_no" text PRIMARY KEY NOT NULL,
	"doc_date" text,
	"ref" text,
	"branding" text,
	"debtor_name" text,
	"phone" text,
	"sales_location" text,
	"sales_agent" text,
	"region" text,
	"local_total" integer,
	"balance" integer,
	"remark2" text,
	"remark3" text,
	"remark4" text,
	"processing_date" text,
	"expiry_date" text,
	"po_doc_no" text,
	"venue" text,
	"attention" text,
	"last_modified" text,
	"sync_status" text,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "sales_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"level" integer DEFAULT 20 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "sales_positions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sales_rep_brands" (
	"rep_id" integer NOT NULL,
	"brand" text NOT NULL,
	CONSTRAINT "sales_rep_brands_rep_id_brand_pk" PRIMARY KEY("rep_id","brand")
);
--> statement-breakpoint
CREATE TABLE "sales_rep_commission_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"rep_id" integer NOT NULL,
	"threshold" integer DEFAULT 0 NOT NULL,
	"rate" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "sales_reps" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"nric" text,
	"position_id" integer,
	"upline_id" integer,
	"upline_secondary_id" integer,
	"user_id" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"is_admin" integer DEFAULT 0 NOT NULL,
	"commission_rate" integer,
	"commission_tier_id" integer,
	"commission_min_rate" integer DEFAULT 0 NOT NULL,
	"joined_on" text,
	"notes" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"archived_at" text,
	"archived_by" integer,
	CONSTRAINT "sales_reps_code_unique" UNIQUE("code"),
	CONSTRAINT "sales_reps_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "sales_team_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"rep_id" integer NOT NULL,
	"action" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"note" text,
	"user_id" integer,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"status" text DEFAULT 'review' NOT NULL,
	"decided_by" integer,
	"decided_at" text,
	"decline_reason" text,
	"awarded_at" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"archived_at" text
);
--> statement-breakpoint
CREATE TABLE "trip_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"lat" integer NOT NULL,
	"lng" integer NOT NULL,
	"accuracy" integer,
	"recorded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_stops" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"pod_photo_r2_key" text,
	"signature_r2_key" text,
	"updated_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" serial PRIMARY KEY NOT NULL,
	"driver_user_id" integer,
	"lorry_id" integer,
	"warehouse" text,
	"trip_date" text NOT NULL,
	"status" text NOT NULL,
	"started_at" text,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "user_brands" (
	"user_id" integer NOT NULL,
	"brand" text NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "user_brands_user_id_brand_pk" PRIMARY KEY("user_id","brand")
);
--> statement-breakpoint
CREATE TABLE "user_streak_weeks" (
	"user_id" integer NOT NULL,
	"iso_week" text NOT NULL,
	"upvotes_count" integer DEFAULT 0 NOT NULL,
	"qualified" integer DEFAULT 0 NOT NULL,
	"computed_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	CONSTRAINT "user_streak_weeks_user_id_iso_week_pk" PRIMARY KEY("user_id","iso_week")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"role_id" integer NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by" integer,
	"invited_at" text,
	"joined_at" text,
	"last_login_at" text,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
	"manager_id" integer,
	"department_id" integer,
	"points_balance" integer DEFAULT 0 NOT NULL,
	"gifting_balance" integer DEFAULT 0 NOT NULL,
	"gifting_reset_at" text,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"profile_pic_r2_key" text,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"target_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
