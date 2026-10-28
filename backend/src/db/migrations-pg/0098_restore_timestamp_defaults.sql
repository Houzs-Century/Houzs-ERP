-- 0093_restore_timestamp_defaults.sql
-- The D1->PG cutover baseline dropped every DEFAULT (datetime('now'))
-- on the row-creation stamp columns, so inserts that omit created_at /
-- uploaded_at / entered_at wrote NULL (23 tables affected; the visible
-- symptom was form-intake cases showing "-" in the ASSR Timeline).
--
-- Part 1 restores a default on every such column (generated from the
-- live information_schema on 2026-07-13): TEXT columns get the ISO
-- stamp the recent rows already use; the two timestamptz columns get
-- plain now(). One statement per line - pg-migrate splits on
-- semicolon-newline, so no DO blocks.
--
-- Part 2 backfills the NULLs that can be derived honestly:
--   * assr_cases / assr_activity from the [gform:] note timestamps
--     (form submission time, MYT -> UTC)
--   * photo activity + attachments from the R2 key's embedded epoch ms
--   * remaining ASSR activity/attachments from the case complained_date
--     (Farra-import notes), else the 2026-07-05 import day
--   * sessions from expires_at minus the 7-day session TTL
-- Other modules' historical NULLs (email_log, project_*) stay NULL -
-- nothing to derive them from; the restored defaults stop new ones.

-- ── Part 1: restore defaults ─────────────────────────────────────

ALTER TABLE "agent_feedback" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_activity" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_attachments" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_cases" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_issue_categories" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_logistics" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_ncr_categories" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_priorities" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_resolution_methods" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_stage_history" ALTER COLUMN entered_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "assr_survey_tokens" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "case_track_tokens" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "creditors" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "daily_inspections" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "delivery_status_log" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "delivery_tracking" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "departments" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "document_agent_findings" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "email_address_access" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "email_addresses" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "email_attachments" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "email_labels" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "email_log" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "email_messages" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "email_threads" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "events" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "execution_logs" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "idea_comments" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "invitations" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "lorries" ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE "lorry_incidents" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "mail_user_scope" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "password_resets" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_activity" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_attachments" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_brands" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_checklist" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_checklist_attachments" ALTER COLUMN uploaded_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_checklist_comments" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_checklist_sections" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_checklist_template_sections" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_checklist_templates" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_event_types" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_finance_lines" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_organizers" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_sales_reports" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_stock_transfers" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_team" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "project_venues" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "projects" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "purchase_order_docs" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "role_page_access" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "roles" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "salary_records" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "salary_trip_lines" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_commission_tiers" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_entries" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_entry_activity" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_entry_items" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_entry_payments" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_orders" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_positions" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_rep_commission_tiers" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_reps" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sales_team_activity" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "sessions" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "stock_items" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "supplier_accounts" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "supplier_communications" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "supplier_invitations" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "supplier_sessions" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "suppliers" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "trip_stops" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "trips" ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE "udf_fields" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "user_brands" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
ALTER TABLE "users" ALTER COLUMN created_at SET DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

-- ── Part 2: backfills ────────────────────────────────────────────

UPDATE assr_cases c
   SET created_at = to_char(timezone('UTC', to_timestamp(substring(a.note from '\[gform:[0-9]+:([0-9/]+ [0-9:]+):'), 'MM/DD/YYYY HH24:MI:SS') - interval '8 hours'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  FROM assr_activity a
 WHERE a.assr_id = c.id
   AND a.note LIKE '%[gform:%'
   AND c.created_at IS NULL
   AND substring(a.note from '\[gform:[0-9]+:([0-9/]+ [0-9:]+):') IS NOT NULL;

UPDATE assr_activity a
   SET created_at = to_char(timezone('UTC', to_timestamp(substring(a.note from '\[gform:[0-9]+:([0-9/]+ [0-9:]+):'), 'MM/DD/YYYY HH24:MI:SS') - interval '8 hours'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
 WHERE a.created_at IS NULL
   AND a.note LIKE '%[gform:%'
   AND substring(a.note from '\[gform:[0-9]+:([0-9/]+ [0-9:]+):') IS NOT NULL;

UPDATE assr_activity a
   SET created_at = to_char(timezone('UTC', to_timestamp((substring(att.r2_key from '-([0-9]{13})\.'))::bigint / 1000.0)), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  FROM assr_attachments att
 WHERE a.created_at IS NULL
   AND a.to_value ~ '^[0-9]+$'
   AND att.id = a.to_value::bigint
   AND att.assr_id = a.assr_id
   AND substring(att.r2_key from '-([0-9]{13})\.') IS NOT NULL;

UPDATE assr_activity a
   SET created_at = COALESCE(c.complained_date || 'T00:00:00Z', '2026-07-05T00:00:00Z')
  FROM assr_cases c
 WHERE a.created_at IS NULL
   AND c.id = a.assr_id;

UPDATE assr_attachments att
   SET created_at = to_char(timezone('UTC', to_timestamp((substring(att.r2_key from '-([0-9]{13})\.'))::bigint / 1000.0)), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
 WHERE att.created_at IS NULL
   AND substring(att.r2_key from '-([0-9]{13})\.') IS NOT NULL;

UPDATE assr_attachments att
   SET created_at = COALESCE(c.complained_date || 'T00:00:00Z', '2026-07-05T00:00:00Z')
  FROM assr_cases c
 WHERE att.created_at IS NULL
   AND c.id = att.assr_id;

UPDATE case_track_tokens
   SET created_at = '2026-07-06T00:00:00Z'
 WHERE created_at IS NULL;

UPDATE sessions
   SET created_at = to_char(timezone('UTC', (expires_at)::timestamptz) - interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
 WHERE created_at IS NULL
   AND expires_at IS NOT NULL;
