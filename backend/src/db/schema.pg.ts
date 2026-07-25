// ---------------------------------------------------------------------------
// DRAFT - Postgres (pg-core) port of schema.ts. UNTESTED until validated with
// `drizzle-kit` against the live Supabase DB (Phase 2 of the migration).
//
// Additive: this file does NOT replace schema.ts yet, so the D1 build stays
// green. The cutover swaps client.ts to drizzle-orm/postgres-js + this schema
// and renames it over schema.ts.
//
// Faithful mapping choices (deliberately low-churn so the 600+ snake_case
// readers and 685 raw-SQL sites keep working):
//   - integer("id").primaryKey({autoIncrement:true})  -> serial(...).primaryKey()
//   - other integer(...)        -> integer(...)        (kept int4)
//   - 0/1 flag columns          -> integer(...)        (NOT boolean — app r/w 0/1)
//   - real(...)                 -> doublePrecision(...) (SQLite REAL is float8)
//   - *_at / created_at columns -> text(...)           (app reads ISO strings,
//                                  not Date objects; keep them text)
//   - default (datetime('now')) -> `nowText` (UTC text, same 'YYYY-MM-DD HH:MM:SS' shape)
//
// REVIEW BEFORE IMPORT (Phase 4): SQLite INTEGER holds int64, Postgres
// `integer` is int4 (max ~2.1e9). Money/amount columns stored in sen could
// overflow. Promote these to `bigint({mode:"number"})` if a real value
// exceeds int4 (the import will fail loudly otherwise — verify per table):
//   sales_orders.local_total/balance, order_details.total_cost + freight cols,
//   purchase_orders.amount/unit_price, purchase_order_docs.final_total/local_ex_tax,
//   project_finance.*, project_finance_lines.amount, sales_entries.amount/deposit_amount,
//   petty_cash_entries.amount_cents, project_cost_rates.boost_min_sales.
// ---------------------------------------------------------------------------
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  bigint,
  text,
  doublePrecision,
  primaryKey,
  uuid,
  boolean,
  jsonb,
  timestamp,
  date,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// SQLite datetime('now') yields 'YYYY-MM-DD HH:MM:SS' (UTC). Reproduce the same
// text shape so existing string parsing/sorting is unchanged.
const nowText = sql`(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`;

// ── users ──────────────────────────────────────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  password_hash: text("password_hash"),
  role_id: integer("role_id").notNull(),
  status: text("status").notNull().default("invited"),
  status_reason: text("status_reason"),
  invited_by: integer("invited_by"),
  invited_at: text("invited_at"),
  joined_at: text("joined_at"),
  last_login_at: text("last_login_at"),
  created_at: text("created_at").default(nowText),
  manager_id: integer("manager_id"),
  department_id: integer("department_id"),
  // Free-text sub-grouping within a department — drives the org chart's
  // columns ("divisions"). Super-admin editable (mig 0021).
  division: text("division"),
  position_id: integer("position_id"),
  points_balance: integer("points_balance").notNull().default(0),
  gifting_balance: integer("gifting_balance").notNull().default(0),
  gifting_reset_at: text("gifting_reset_at"),
  current_streak: integer("current_streak").notNull().default(0),
  profile_pic_r2_key: text("profile_pic_r2_key"),
  phone: text("phone"),
  // The member's outward Mail Center alias (e.g. lim@houzscentury.com). Surfaced
  // in User Management; complements the email_addresses link (mig 0039+).
  email_alias: text("email_alias"),
  // Per-user opt-out of ASSR service-case digest/escalation emails. The user
  // keeps service_cases.manage (can still view + manage cases) — this only
  // mutes the outbound mail. 0 = receives, 1 = muted.
  assr_email_muted: integer("assr_email_muted").notNull().default(0),
});

// ── roles ──────────────────────────────────────────────────
export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  permissions: text("permissions").notNull().default("[]"),
  is_system: integer("is_system").notNull().default(0),
  scope_to_pic: integer("scope_to_pic").notNull().default(0),
  created_at: text("created_at").default(nowText),
});

// ── role_page_access (mig 073) ─────────────────────────────
export const role_page_access = pgTable(
  "role_page_access",
  {
    role_id: integer("role_id").notNull(),
    page_key: text("page_key").notNull(),
    level: text("level").notNull(),
    created_at: text("created_at").default(nowText),
    updated_at: text("updated_at").default(nowText),
  },
  (t) => ({ pk: primaryKey({ columns: [t.role_id, t.page_key] }) }),
);

// ── departments ────────────────────────────────────────────
export const departments = pgTable("departments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  color: text("color").notNull().default("64748b"),
  sort_order: integer("sort_order").notNull().default(0),
  created_at: text("created_at").default(nowText),
});

// ── projects ───────────────────────────────────────────────
export const projects = pgTable("projects", {
  // Multi-company (mig-pg 0093). Declared for the Drizzle-based readers
  // (events / notifications / finance rollups); raw-SQL paths reference the
  // column by name. Nullable in the model — the PG DEFAULT backfills.
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  code: text("code").unique(),
  name: text("name").notNull(),
  stage: text("stage").notNull().default("draft"),
  status: text("status").notNull().default("pending"),
  start_date: text("start_date"),
  end_date: text("end_date"),
  venue: text("venue"),
  venue_address: text("venue_address"),
  brand: text("brand"),
  pic_id: integer("pic_id"),
  created_by: integer("created_by"),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
  archived_at: text("archived_at"),
  setup_start_at: text("setup_start_at"),
  setup_end_at: text("setup_end_at"),
  dismantle_start_at: text("dismantle_start_at"),
  dismantle_end_at: text("dismantle_end_at"),
  setup_driver_user_id: integer("setup_driver_user_id"),
  setup_lorry_id: integer("setup_lorry_id"),
  dismantle_driver_user_id: integer("dismantle_driver_user_id"),
  dismantle_lorry_id: integer("dismantle_lorry_id"),
  setup_helper_1_id: integer("setup_helper_1_id"),
  setup_helper_2_id: integer("setup_helper_2_id"),
  setup_helper_outsourced: integer("setup_helper_outsourced").notNull().default(0),
  dismantle_helper_1_id: integer("dismantle_helper_1_id"),
  dismantle_helper_2_id: integer("dismantle_helper_2_id"),
  dismantle_helper_outsourced: integer("dismantle_helper_outsourced").notNull().default(0),
});

// ── project_phase_photos ───────────────────────────────────
export const project_phase_photos = pgTable("project_phase_photos", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  phase: text("phase").notNull(),
  r2_key: text("r2_key").notNull(),
  content_type: text("content_type"),
  caption: text("caption"),
  uploaded_by: integer("uploaded_by"),
  uploaded_at: text("uploaded_at").notNull().default(nowText),
});

// ── project_brands ─────────────────────────────────────────
export const project_brands = pgTable("project_brands", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("64748b"),
  sort_order: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

// ── user_brands (mig 049) ──────────────────────────────────
export const user_brands = pgTable(
  "user_brands",
  {
    user_id: integer("user_id").notNull(),
    brand: text("brand").notNull(),
    created_at: text("created_at").default(nowText),
  },
  (t) => ({ pk: primaryKey({ columns: [t.user_id, t.brand] }) }),
);

// ── user_departments (mig 0020) ────────────────────────────
// Full set of departments a user belongs to. users.department_id stays the
// PRIMARY; this carries the primary plus any extras (the primary is one row
// here too). Replace-set on PATCH /api/users/:id, same shape as user_brands.
export const user_departments = pgTable(
  "user_departments",
  {
    user_id: integer("user_id").notNull(),
    department_id: integer("department_id").notNull(),
    created_at: text("created_at").default(nowText),
  },
  (t) => ({ pk: primaryKey({ columns: [t.user_id, t.department_id] }) }),
);

// ── project_activity ───────────────────────────────────────
export const project_activity = pgTable("project_activity", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  user_id: integer("user_id"),
  action: text("action").notNull(),
  from_value: text("from_value"),
  to_value: text("to_value"),
  note: text("note"),
  created_at: text("created_at").default(nowText),
  archived_at: text("archived_at"),
});

// ── project_reads (mig 045) ────────────────────────────────
export const project_reads = pgTable(
  "project_reads",
  {
    project_id: integer("project_id").notNull(),
    user_id: integer("user_id").notNull(),
    last_read_at: text("last_read_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.project_id, t.user_id] }) }),
);

// ── sessions ───────────────────────────────────────────────
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  user_id: integer("user_id").notNull(),
  expires_at: text("expires_at").notNull(),
  created_at: text("created_at").default(nowText),
});

// ── invitations ────────────────────────────────────────────
export const invitations = pgTable("invitations", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  role_id: integer("role_id").notNull(),
  token: text("token").notNull().unique(),
  invited_by: integer("invited_by").notNull(),
  expires_at: text("expires_at").notNull(),
  accepted_at: text("accepted_at"),
  created_at: text("created_at").default(nowText),
  // Org dimensions carried by the invite + applied on accept (mig 094).
  position_id: integer("position_id"),
  department_id: integer("department_id"),
  manager_id: integer("manager_id"),
});

// ── positions (mig 094) — staff org unit (department × position) ──
export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  department_id: integer("department_id"),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  level: integer("level").notNull().default(100),
  sort_order: integer("sort_order").notNull().default(100),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

// ── position_page_access (mig 094) — 4-level matrix (none/view/edit/full) ──
export const position_page_access = pgTable(
  "position_page_access",
  {
    position_id: integer("position_id").notNull(),
    page_key: text("page_key").notNull(),
    level: text("level").notNull(),
    created_at: text("created_at").default(nowText),
    updated_at: text("updated_at").default(nowText),
  },
  (t) => ({ pk: primaryKey({ columns: [t.position_id, t.page_key] }) }),
);

// ── password_resets (mig 027) ──────────────────────────────
export const password_resets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id").notNull(),
  token: text("token").notNull().unique(),
  requested_by: integer("requested_by"),
  expires_at: text("expires_at").notNull(),
  consumed_at: text("consumed_at"),
  created_at: text("created_at").default(nowText),
});

// ── events ─────────────────────────────────────────────────
export const events = pgTable("events", {
  // Multi-company (mig-pg 0093) — see projects.company_id above.
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  event_date: text("event_date").notNull(),
  address: text("address"),
  status: text("status"),
  notes: text("notes"),
  created_by: integer("created_by"),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
});

// ── lorries ────────────────────────────────────────────────
export const lorries = pgTable("lorries", {
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  plate: text("plate").notNull(),
  size: text("size"),
  default_driver_user_id: integer("default_driver_user_id"),
});

// ── warehouses ─────────────────────────────────────────────
export const warehouses = pgTable("warehouses", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
});

// ── trips ──────────────────────────────────────────────────
export const trips = pgTable("trips", {
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  driver_user_id: integer("driver_user_id"),
  lorry_id: integer("lorry_id"),
  warehouse: text("warehouse"),
  trip_date: text("trip_date").notNull(),
  status: text("status").notNull(),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
});

// ── trip_stops ─────────────────────────────────────────────
export const trip_stops = pgTable("trip_stops", {
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  trip_id: integer("trip_id").notNull(),
  sequence: integer("sequence").notNull(),
  status: text("status").notNull(),
  pod_photo_r2_key: text("pod_photo_r2_key"),
  signature_r2_key: text("signature_r2_key"),
  updated_at: text("updated_at").default(nowText),
});

// ── trip_locations ─────────────────────────────────────────
export const trip_locations = pgTable("trip_locations", {
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  trip_id: integer("trip_id").notNull(),
  lat: integer("lat").notNull(),
  lng: integer("lng").notNull(),
  accuracy: integer("accuracy"),
  recorded_at: text("recorded_at").notNull(),
});

// ── sales_orders ───────────────────────────────────────────
export const sales_orders = pgTable("sales_orders", {
  company_id: bigint("company_id", { mode: "number" }),
  doc_no: text("doc_no").primaryKey(),
  doc_date: text("doc_date"),
  ref: text("ref"),
  branding: text("branding"),
  debtor_name: text("debtor_name"),
  phone: text("phone"),
  sales_location: text("sales_location"),
  sales_agent: text("sales_agent"),
  region: text("region"),
  local_total: integer("local_total"),
  balance: integer("balance"),
  remark2: text("remark2"),
  remark3: text("remark3"),
  remark4: text("remark4"),
  processing_date: text("processing_date"),
  expiry_date: text("expiry_date"),
  po_doc_no: text("po_doc_no"),
  venue: text("venue"),
  attention: text("attention"),
  last_modified: text("last_modified"),
  sync_status: text("sync_status"),
  updated_at: text("updated_at"),
  // Houzs-side recipient for auto-sent DO/invoice email; AutoCount debtor sync
  // carries no email, so this is maintained manually (mig 098/0009).
  customer_email: text("customer_email"),
});

// ── order_details ──────────────────────────────────────────
export const order_details = pgTable("order_details", {
  company_id: bigint("company_id", { mode: "number" }),
  doc_no: text("doc_no").primaryKey(),
  delivery_date: text("delivery_date"),
  time_range: text("time_range"),
  time_confirmed: integer("time_confirmed"),
  lorry_plate: text("lorry_plate"),
  driver_name: text("driver_name"),
  driver_contact: text("driver_contact"),
  days_left: integer("days_left"),
  internal_purchasing: text("internal_purchasing"),
  property_type: text("property_type"),
  new_house_replacement: text("new_house_replacement"),
  item_details: text("item_details"),
  done_delivery: integer("done_delivery"),
  consignment_no: text("consignment_no"),
  eta_port: text("eta_port"),
  estimate_delivery: text("estimate_delivery"),
  m3: integer("m3"),
  vessel_voyage: text("vessel_voyage"),
  etd_port_klang: text("etd_port_klang"),
  eta_destination: text("eta_destination"),
  transporter_remarks: text("transporter_remarks"),
  seafreight: integer("seafreight"),
  local_charges: integer("local_charges"),
  inland: integer("inland"),
  agent_fee: integer("agent_fee"),
  insurance: integer("insurance"),
  total_cost: integer("total_cost"),
  shipout_date: text("shipout_date"),
  warehouse: text("warehouse"),
  state: text("state"),
  lat: integer("lat"),
  lng: integer("lng"),
  order_type: text("order_type"),
  proposed_delivery_date: text("proposed_delivery_date"),
  updated_at: text("updated_at"),
});

// ── purchase_orders ────────────────────────────────────────
export const purchase_orders = pgTable("purchase_orders", {
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  doc_no: text("doc_no").notNull(),
  doc_date: text("doc_date"),
  creditor_code: text("creditor_code"),
  creditor_name: text("creditor_name"),
  item_code: text("item_code"),
  item_description: text("item_description"),
  remaining_qty: integer("remaining_qty"),
  delivery_date: text("delivery_date"),
  supplier_date1: text("supplier_date1"),
  supplier_date2: text("supplier_date2"),
  supplier_date3: text("supplier_date3"),
  overdue_days: text("overdue_days"),
  amount: integer("amount"),
  unit_price: integer("unit_price"),
  amount_source: text("amount_source"),
  amount_updated_at: text("amount_updated_at"),
  amount_updated_by: integer("amount_updated_by"),
  updated_at: text("updated_at"),
});

// ── creditors ──────────────────────────────────────────────
export const creditors = pgTable("creditors", {
  company_id: bigint("company_id", { mode: "number" }),
  creditor_code: text("creditor_code").primaryKey(),
  company_name: text("company_name"),
  desc2: text("desc2"),
  email: text("email"),
  phone1: text("phone1"),
  mobile: text("mobile"),
  tax_register_no: text("tax_register_no"),
  currency_code: text("currency_code"),
  type: text("type"),
  type_description: text("type_description"),
  purchase_agent: text("purchase_agent"),
  purchase_agent_description: text("purchase_agent_description"),
  updated_at: text("updated_at"),
});

// ── overdue_history ────────────────────────────────────────
export const overdue_history = pgTable("overdue_history", {
  id: serial("id").primaryKey(),
  pull_date: text("pull_date").notNull(),
  doc_no: text("doc_no").notNull(),
  debtor_name: text("debtor_name"),
  location: text("location"),
  region: text("region"),
  balance: integer("balance"),
  original_expiry_date: text("original_expiry_date"),
  extended_to: text("extended_to"),
  remark4: text("remark4"),
  created_at: text("created_at").default(nowText),
});

// ── purchase_order_docs ────────────────────────────────────
export const purchase_order_docs = pgTable("purchase_order_docs", {
  company_id: bigint("company_id", { mode: "number" }),
  doc_no: text("doc_no").primaryKey(),
  doc_date: text("doc_date"),
  ref: text("ref"),
  creditor_code: text("creditor_code"),
  creditor_name: text("creditor_name"),
  cancelled: integer("cancelled"),
  doc_status: text("doc_status"),
  final_total: integer("final_total"),
  local_ex_tax: integer("local_ex_tax"),
  currency_code: text("currency_code"),
  updated_at: text("updated_at"),
});

// ── project_finance ────────────────────────────────────────
export const project_finance = pgTable("project_finance", {
  project_id: integer("project_id").primaryKey(),
  rental: integer("rental"),
  total_sales: integer("total_sales"),
  contractor_cost: integer("contractor_cost"),
  license_fee: integer("license_fee"),
  updated_at: text("updated_at"),
});

// ── project_checklist_sections (mig 050) ───────────────────
export const project_checklist_sections = pgTable("project_checklist_sections", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  name: text("name").notNull(),
  sort_order: integer("sort_order").notNull().default(0),
  display_mode: text("display_mode").notNull().default("list"),
  created_at: text("created_at").default(nowText),
});

// ── project_checklist_template_sections (mig 050) ──────────
export const project_checklist_template_sections = pgTable(
  "project_checklist_template_sections",
  {
    id: serial("id").primaryKey(),
    template_id: integer("template_id").notNull(),
    name: text("name").notNull(),
    sort_order: integer("sort_order").notNull().default(0),
    display_mode: text("display_mode").notNull().default("list"),
    created_at: text("created_at").default(nowText),
  },
);

// ── project_checklist_attachments (mig 050) ────────────────
export const project_checklist_attachments = pgTable(
  "project_checklist_attachments",
  {
    id: serial("id").primaryKey(),
    item_id: integer("item_id").notNull(),
    r2_key: text("r2_key").notNull(),
    file_name: text("file_name").notNull(),
    content_type: text("content_type"),
    size_bytes: integer("size_bytes"),
    uploaded_by: integer("uploaded_by"),
    uploaded_at: text("uploaded_at").default(nowText),
    archived_at: text("archived_at"),
    // Per-attachment remark (owner 2026-07-16): each uploaded photo can carry
    // its own caption, editable from the Defect List / photo checklist rows.
    caption: text("caption"),
  },
);

// ── project_checklist ──────────────────────────────────────
export const project_checklist = pgTable("project_checklist", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  section_id: integer("section_id"),
  seq: integer("seq").notNull().default(0),
  title: text("title").notNull(),
  description: text("description"),
  required_perm: text("required_perm"),
  role_label: text("role_label"),
  crew_visible: integer("crew_visible").notNull().default(0),
  due_date: text("due_date"),
  due_offset_days: integer("due_offset_days"),
  owner_user_id: integer("owner_user_id"),
  status: text("status").notNull().default("pending"),
  evidence_r2_key: text("evidence_r2_key"),
  completed_by: integer("completed_by"),
  completed_at: text("completed_at"),
  notes: text("notes"),
  review_status: text("review_status"),
  rejection_reason: text("rejection_reason"),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
});

// ── project_checklist_templates ────────────────────────────
export const project_checklist_templates = pgTable("project_checklist_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

// ── project_checklist_template_items (mig 050) ─────────────
export const project_checklist_template_items = pgTable(
  "project_checklist_template_items",
  {
    id: serial("id").primaryKey(),
    template_id: integer("template_id").notNull(),
    section_id: integer("section_id"),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    required_perm: text("required_perm"),
    role_label: text("role_label"),
    crew_visible: integer("crew_visible").notNull().default(0),
    due_offset_days: integer("due_offset_days"),
    requires_review: integer("requires_review").notNull().default(0),
  },
);

// ── sales_entries (mig 041 / 051) ──────────────────────────
export const sales_entries = pgTable("sales_entries", {
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  doc_no: text("doc_no"),
  project_id: integer("project_id"),
  ref_no: text("ref_no"),
  customer_name: text("customer_name").notNull(),
  customer_code: text("customer_code"),
  customer_address: text("customer_address"),
  customer_address_2: text("customer_address_2"),
  customer_postcode: text("customer_postcode"),
  customer_state: text("customer_state"),
  customer_phone: text("customer_phone"),
  customer_phone_2: text("customer_phone_2"),
  customer_email: text("customer_email"),
  amount: integer("amount").notNull(),
  deposit_amount: integer("deposit_amount"),
  deposit_payment_type: text("deposit_payment_type"),
  currency: text("currency").notNull().default("MYR"),
  occurred_at: text("occurred_at").notNull(),
  processing_date: text("processing_date"),
  delivery_date: text("delivery_date"),
  status_2: text("status_2"),
  venue: text("venue"),
  warehouse: text("warehouse"),
  branding: text("branding"),
  po_doc_no: text("po_doc_no"),
  payment_status: text("payment_status"),
  source: text("source"),
  remarks: text("remarks"),
  notes: text("notes"),
  status: text("status").notNull().default("draft"),
  autocount_doc_no: text("autocount_doc_no"),
  autocount_doc_type: text("autocount_doc_type"),
  pushed_at: text("pushed_at"),
  push_error: text("push_error"),
  sales_person_id: integer("sales_person_id"),
  created_by: integer("created_by").notNull(),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
  archived_at: text("archived_at"),
});

// ── sales_entry_items ──────────────────────────────────────
export const sales_entry_items = pgTable("sales_entry_items", {
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  entry_id: integer("entry_id").notNull(),
  line_no: integer("line_no").notNull().default(0),
  item_code: text("item_code"),
  item_description: text("item_description"),
  remarks: text("remarks"),
  qty: doublePrecision("qty").notNull().default(1),
  unit_price: doublePrecision("unit_price").notNull().default(0),
  amount: doublePrecision("amount").notNull().default(0),
  group_tag: text("group_tag"),
  created_at: text("created_at").default(nowText),
});

// ── sales_entry_payments ───────────────────────────────────
export const sales_entry_payments = pgTable("sales_entry_payments", {
  company_id: bigint("company_id", { mode: "number" }),
  id: serial("id").primaryKey(),
  entry_id: integer("entry_id").notNull(),
  paid_at: text("paid_at").notNull(),
  payment_method: text("payment_method").notNull(),
  amount: doublePrecision("amount").notNull(),
  account_sheet: text("account_sheet"),
  approval_code: text("approval_code"),
  collected_by: text("collected_by"),
  created_at: text("created_at").default(nowText),
});

// ── project_finance_lines ──────────────────────────────────
export const project_finance_lines = pgTable("project_finance_lines", {
  id: serial("id").primaryKey(),
  project_id: integer("project_id").notNull(),
  kind: text("kind").notNull(),
  category: text("category"),
  description: text("description"),
  amount: integer("amount"),
  occurred_at: text("occurred_at"),
  notes: text("notes"),
  r2_key: text("r2_key"),
  file_name: text("file_name"),
  created_at: text("created_at").default(nowText),
  created_by: integer("created_by"),
  archived_at: text("archived_at"),
  auto_source: text("auto_source"),
});

// ── project_cost_rates (mig 063) ───────────────────────────
export const project_cost_rates = pgTable("project_cost_rates", {
  id: serial("id").primaryKey(),
  brand: text("brand").notNull().unique(),
  transport_pct: integer("transport_pct").notNull().default(0),
  merchandise_pct: integer("merchandise_pct").notNull().default(0),
  commission_normal_pct: integer("commission_normal_pct").notNull().default(0),
  commission_boost_pct: integer("commission_boost_pct"),
  boost_min_gp_pct: integer("boost_min_gp_pct"),
  boost_min_sales: integer("boost_min_sales"),
  updated_at: text("updated_at").default(nowText),
  updated_by: integer("updated_by"),
});

// ── sales_positions / tiers / reps (mig 067) ───────────────
export const sales_positions = pgTable("sales_positions", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  level: integer("level").notNull().default(20),
  sort_order: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

export const sales_commission_tiers = pgTable("sales_commission_tiers", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  rate: integer("rate").notNull().default(0),
  active: integer("active").notNull().default(1),
  created_at: text("created_at").default(nowText),
});

export const sales_reps = pgTable("sales_reps", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  nric: text("nric"),
  position_id: integer("position_id"),
  upline_id: integer("upline_id"),
  upline_secondary_id: integer("upline_secondary_id"),
  user_id: integer("user_id").unique(),
  status: text("status").notNull().default("active"),
  is_admin: integer("is_admin").notNull().default(0),
  commission_rate: integer("commission_rate"),
  commission_tier_id: integer("commission_tier_id"),
  commission_min_rate: integer("commission_min_rate").notNull().default(0),
  joined_on: text("joined_on"),
  notes: text("notes"),
  created_at: text("created_at").default(nowText),
  updated_at: text("updated_at").default(nowText),
  archived_at: text("archived_at"),
  archived_by: integer("archived_by"),
});

export const sales_rep_commission_tiers = pgTable(
  "sales_rep_commission_tiers",
  {
    id: serial("id").primaryKey(),
    rep_id: integer("rep_id").notNull(),
    threshold: integer("threshold").notNull().default(0),
    rate: integer("rate").notNull().default(0),
    sort_order: integer("sort_order").notNull().default(0),
    created_at: text("created_at").default(nowText),
  },
);

export const sales_rep_brands = pgTable(
  "sales_rep_brands",
  {
    rep_id: integer("rep_id").notNull(),
    brand: text("brand").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.rep_id, t.brand] }) }),
);

export const sales_team_activity = pgTable("sales_team_activity", {
  id: serial("id").primaryKey(),
  rep_id: integer("rep_id").notNull(),
  action: text("action").notNull(),
  from_value: text("from_value"),
  to_value: text("to_value"),
  note: text("note"),
  user_id: integer("user_id"),
  created_at: text("created_at").default(nowText),
});

// ── project_sales_attendees (mig 087) ──────────────────────
export const project_sales_attendees = pgTable(
  "project_sales_attendees",
  {
    project_id: integer("project_id").notNull(),
    sales_rep_id: integer("sales_rep_id").notNull(),
    created_at: text("created_at").default(nowText),
    created_by: integer("created_by"),
  },
  (t) => ({ pk: primaryKey({ columns: [t.project_id, t.sales_rep_id] }) }),
);

// ── companies (multi-company master; Phase 0a) ─────────
export const companies = pgTable("companies", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  is_active: integer("is_active").notNull().default(1),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
