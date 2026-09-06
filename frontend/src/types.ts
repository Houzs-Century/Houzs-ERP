export type Region = "WEST" | "EAST" | "SG";
export type SyncStatus = "SYNCED" | "ERROR";

export interface PurchaseOrder {
  id: number;
  doc_no: string;
  so_doc_no: string | null;
  creditor_code: string | null;
  creditor_name: string | null;
  item_code: string;
  item_description: string | null;
  location: string | null;
  doc_date: string | null;
  remaining_qty: number | null;
  delivery_date: string | null;
  supplier_date1: string | null;
  supplier_date2: string | null;
  supplier_date3: string | null;
  overdue_days: string | null;
  // Cost fields used by P&L. amount_source distinguishes 'sync' (from
  // AutoCount payload) vs 'manual' (typed by a user) so the next sync
  // knows whether to overwrite. (Line-level amounts only — doc totals
  // live on PurchaseOrderDoc.)
  unit_price?: number | null;
  amount?: number | null;
  amount_source?: string | null;
  amount_updated_at?: string | null;
  amount_updated_by?: number | null;
}

/**
 * Creditor (procurement supplier) mirrored locally from AutoCount
 * /Creditor/getAll. Read-only — AutoCount is the system of record.
 * po_count / open_po_count / total_local_ex_tax come from a join
 * against purchase_order_docs in the list endpoint.
 */
export interface Creditor {
  creditor_code: string;
  company_name: string | null;
  desc2: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
  post_code: string | null;
  deliver_address1: string | null;
  deliver_address2: string | null;
  deliver_address3: string | null;
  deliver_address4: string | null;
  deliver_post_code: string | null;
  attention: string | null;
  phone1: string | null;
  phone2: string | null;
  mobile: string | null;
  fax1: string | null;
  fax2: string | null;
  email: string | null;
  web_url: string | null;
  contact_info: string | null;
  nature_of_business: string | null;
  currency_code: string | null;
  display_term: string | null;
  rounding_method: string | null;
  inclusive_tax: number | null;
  price_category: string | null;
  statement_type: string | null;
  aging_on: string | null;
  credit_limit: number | null;
  overdue_limit: number | null;
  tax_code: string | null;
  tax_register_no: string | null;
  gst_register_no: string | null;
  sst_register_no: string | null;
  self_billed_approval_no: string | null;
  exempt_no: string | null;
  exempt_expiry_date: string | null;
  register_no: string | null;
  gst_status_verified_date: string | null;
  area_code: string | null;
  area_description: string | null;
  area_desc2: string | null;
  type: string | null;
  type_description: string | null;
  type_desc2: string | null;
  purchase_agent: string | null;
  purchase_agent_description: string | null;
  parent_acc_no: string | null;
  note: string | null;
  last_modified: string | null;
  last_modified_user_id: string | null;
  created_timestamp: string | null;
  created_user_id: string | null;
  is_active: number;
  raw: string | null;
  created_at: string;
  updated_at: string;
  // Joined aggregates from purchase_order_docs:
  po_count?: number;
  open_po_count?: number;
  total_local_ex_tax?: number;
}

// v3.1 workflow (backend mig 074) — 8 stages since mig 0105 retired
// pending_inspection (inspection folded into Under Verification).
// Stage names mirror the SQL enum. The legacy 6-stage vocabulary is
// no longer accepted by writes.
export type AssrStage =
  | "pending_review"
  | "under_verification"
  | "pending_solution"
  | "pending_supplier_pickup"
  | "pending_item_ready"
  | "pending_delivery_service"
  | "completed"
  | "voided";
export type ResolutionMethod = "replace_unit" | "supplier_repair" | "field_service_own" | "field_service_supplier" | "return_visit";

export interface AssrCase {
  id: number;
  assr_no: string;
  status: string;
  stage: AssrStage;
  /** Switchable 小类 inside Verification / Supplier (mig 0116). */
  sub_status?: string | null;
  doc_no: string;
  complained_date: string | null;
  customer_name: string | null;
  customer_email: string | null;
  phone: string | null;
  location: string | null;
  sales_agent: string | null;
  item_code: string | null;
  complaint_issue: string | null;
  action_remark: string | null;
  service_category: string | null;
  supplier: string | null;
  completion_date: string | null;
  po_no: string | null;
  resolution_method: ResolutionMethod | null;
  issue_category: string | null;
  priority: string;
  assigned_to: number | null;
  assigned_to_name?: string | null;
  // Co-assignee — the after-sales desk is run by two people.
  assigned_to_2?: number | null;
  assigned_to_2_name?: string | null;
  ref_no: string | null;
  delivery_order: string | null;
  /** Live DO numbers from scm.delivery_orders (so_doc_no join), merged by
   *  the list/export endpoints; "DO1 · DO2" when the SO has several. */
  do_numbers?: string | null;
  do_date: string | null;
  closed_at: string | null;
  created_by: number | null;
  created_by_name?: string | null;
  /** Owning company's code ("HOUZS" / "2990") — joined by the list endpoint;
   *  the cross-company portal tags non-HOUZS rows with it. */
  company_code?: string | null;
  satisfaction_rating: number | null;
  satisfaction_notes: string | null;
  /** Why a case was voided (not valid / not warranty-covered). */
  void_reason?: string | null;
  // AutoCount-derived creditor (procurement supplier). Auto-resolved
  // from the case's item_code via StockItem.MainSupplier.
  creditor_code?: string | null;
  creditor_name?: string | null;
  creditor_email?: string | null;
  creditor_phone?: string | null;
  creditor_mobile?: string | null;
  creditor_attention?: string | null;
  // QMS: manager sign-off + NCR
  approved_by?: number | null;
  approved_at?: string | null;
  approved_by_name?: string | null;
  quality_review_passed?: number | null; // 0 | 1 | null
  ncr_category?: string | null;
  // v3.1 — separate CSAT survey recipient (mig 074)
  email_for_survey?: string | null;
  inspection_result?: "pass" | "fail" | "na" | null;
  // v3.1 — per-stage lifecycle snapshots (mig 074)
  stage_entered_at?: string | null;
  stage_target_days?: number | null;
  lead_time_profile_id?: number | null;
  // QMS: cost tracking
  po_amount?: number | null;
  customer_amount?: number | null;
  supplier_invoice_ref?: string | null;
  cost_notes?: string | null;
  // SLA tracking
  sla_hours?: number | null;
  deadline_at?: string | null;
  escalated_at?: string | null;
  hours_to_deadline?: number | null; // negative = past deadline
  is_breached?: number | null;       // 0 | 1
  // Aging fields (populated on list/detail reads — computed from activity log)
  stage_since?: string | null;
  days_in_stage?: number | null;
  // Mig 064 — supplier handover + items-ready dates, plus the
  // `stage_changed_at` snapshot the new lead-time column reads.
  supplier_pickup_at?: string | null;
  // Mig 107 — date we collect the faulty item from the customer's house.
  customer_pickup_at?: string | null;
  /* Mig 127 — on-site own-team inspection visit date, de-conflated from
     customer_pickup_at; drives a distinct INSPECTION leg on Delivery Planning. */
  inspection_visit_at?: string | null;
  // Mig 0073 — who performs the issue inspection: 'own' | 'supplier'.
  // Lives on the Under Verification stage since mig 0105.
  inspection_by?: "own" | "supplier" | null;
  /** Who collects the faulty item in the Supplier stage — 'customer' =
   *  our logistics picks up from the customer's house. */
  pickup_by?: "customer" | "supplier" | null;
  items_ready_at?: string | null;
  stage_changed_at?: string | null;
  // Mig 081 — Verification card (gate between Under Verification and
  // Pending Solution). 'accepted' = real defect we'll fix, 'rejected' =
  // not-our-issue short-circuit to Completed, 'needs_more_info' = wait
  // on customer.
  verification_outcome?: "accepted" | "rejected" | "needs_more_info" | null;
  verified_root_cause?: string | null;
  verified_by?: number | null;
  verified_by_name?: string | null;
  verified_at?: string | null;
  // Mig 105 — editable QC-on-receipt inspection date, distinct from
  // the auto-stamped verified_at audit timestamp.
  qc_receipt_date?: string | null;
  // Mig 0105 — result of the QC-on-receipt issue inspection (the
  // retired Pending Inspection stage folded into Verification).
  qc_issue_result?: "pass" | "fail" | "na" | null;
  // Mig 106 — paperwork that travels with the item between Houzs and
  // supplier. Ops edits goods_returned_note; supplier edits
  // supplier_service_note from their portal.
  goods_returned_note?: string | null;
  supplier_service_note?: string | null;
  // Soft-delete
  archived_at?: string | null;
  archived_by?: number | null;
  addr1: string | null;
  addr2: string | null;
  addr3: string | null;
  addr4: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssrItem {
  id: number;
  assr_id: number;
  item_code: string;
  item_description: string | null;
  qty: number;
}

export interface AssrAttachment {
  id: number;
  assr_id: number;
  r2_key: string;
  file_name: string | null;
  content_type: string | null;
  category:
    | "complaint"
    | "evidence"
    | "completion"
    | "signature"
    | "sign_off"
    | "inspection_report"
    | "receipt_evidence"
    | "pickup_form"
    | "ready_doc"
    | "delivery_pod";
  uploaded_by: number | null;
  created_at: string;
}

export type AssrActivityCategory = "purchasing" | "customer" | "system";

export interface AssrActivity {
  id: number;
  assr_id: number;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name?: string | null;
  created_at: string;
  // Mig 064 — drives the timeline filter pills.
  category?: AssrActivityCategory | null;
  // Where the activity originated (e.g. "customer_portal" vs office) — used by
  // the case-detail header + timeline actor role.
  source_channel?: string | null;
}

export interface AssrLogistics {
  id: number;
  assr_id: number;
  type: "pickup" | "delivery";
  scheduled_date: string | null;
  scheduled_time_range: string | null;
  assigned_to: number | null;
  assigned_to_name?: string | null;
  status: string;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// v3.1 — per-stage lifecycle row. One per (case, stage) entry, in
// chronological order. The Workflow Progress Tracker walks this list.
export interface AssrStageHistoryRow {
  id: number;
  stage: AssrStage;
  entered_at: string;
  exited_at: string | null;
  target_days: number | null;
  status: "green" | "amber" | "red" | null;
  skipped: number;
  skip_reason: string | null;
  alerts_fired: number;
  snoozes_applied: number;
}

export interface AssrDetail {
  case: AssrCase;
  /** Product categories as a list — what the multi-select form binds to.
   *  The flat `case.service_category` string stays for read-only surfaces
   *  (list column, CSV, print, portals, mobile). */
  service_categories?: string[];
  items: AssrItem[];
  attachments: AssrAttachment[];
  activity: AssrActivity[];
  logistics: AssrLogistics[];
  related_pos: PurchaseOrder[];
  portal_token?: string | null;
  stage_history?: AssrStageHistoryRow[];
}

export interface ExecutionLog {
  id: number;
  request_id: string;
  type: string;
  started_at: string;
  ended_at: string | null;
  status: "SYNCED" | "FAILED" | "SKIPPED";
  message: string | null;
  created_at: string;
}

export interface Paginated<T> {
  data: T[];
  page: number;
  per_page: number;
  total: number;
}

export interface SyncStatusResponse {
  checkpoint: string | null;
  last_pull: ExecutionLog | null;
  last_pull_all: ExecutionLog | null;
  error_count: number;
  autocount_writes_disabled?: boolean;
}

export interface AssrMetrics {
  since_days: number;
  headline: {
    total: number;
    closed: number;
    open_count: number;
    breached: number;
    qa_passed: number;
    avg_resolution_hours: number | null;
    avg_satisfaction: number | null;
  };
  ncr: Array<{ category: string; count: number }>;
  /** Customer-facing intake category (Product defect / Incorrect item / …). */
  issue_categories: Array<{ category: string; count: number }>;
  resolutions: Array<{ method: string; count: number }>;
  repeat_items: Array<{ item_code: string; cases: number; latest: string }>;
  repeat_customers: Array<{ customer_name: string; phone: string | null; cases: number; latest: string }>;
  creditor_performance: Array<{
    creditor_code: string;
    name: string | null;
    total_cases: number;
    closed_cases: number;
    breached: number;
    avg_rating: number | null;
    avg_resolution_hours: number | null;
  }>;
  monthly_trend: Array<{ month: string; opened: number; closed: number }>;
  /** Mirrors the legacy Excel "Case Duration" tile. All counts are *open* cases. */
  case_duration: {
    opening_count: number;
    over_1_month: number;
    over_3_weeks: number;
    over_2_weeks: number;
    /** Rolling monthly intake, last 4 months. */
    avg_per_month: number | null;
  };
}

export interface AssrSummary {
  total: number;
  /** Cases still in progress (not completed, not archived). Optional —
   *  older deployed backends omit it; the Overview KPI falls back to
   *  deriving it from by_stage. */
  active_count?: number;
  by_stage: Array<{ stage: string; count: number }>;
  by_status: Array<{ status: string; count: number }>;
  by_location: Array<{ location: string; count: number }>;
  by_category: Array<{ name: string; count: number }>;
  recent_30d: number;
  aging_count: number;
  breach_count: number;
}

// ──────────────────────────────────────────────────────────
// Auth, users, roles
// ──────────────────────────────────────────────────────────
/**
 * Per-page access level. Mirrors backend's `AccessLevel`.
 * Role matrix is 3-level (none/partial/full); the position matrix is 4-level
 * (none/view/edit/full). `partial` is treated as rank-equal to `view`, so both
 * coexist. `none` = hidden / 403.
 */
export type AccessLevel = "none" | "partial" | "view" | "edit" | "full";

/** Numeric ordering — higher = more access. partial == view (rank 1). */
export const ACCESS_RANK: Record<AccessLevel, number> = {
  none: 0,
  view: 1,
  partial: 1,
  edit: 2,
  full: 3,
};

/** Page catalogue entry. Returned by GET /api/roles/pages. */
export interface PageDef {
  key: string;
  label: string;
  partialMeaning: string;
  supportsPartial: boolean;
  /** When set, this page is a sub-tab under `parent`. Used by the
   *  Roles UI to indent and to disable child radios when the parent
   *  is full/none (cascade rule). */
  parent: string | null;
  /** The key exists in the catalogue but NOTHING in the repo reads it —
   *  setting it has never done anything (backend DORMANT_PAGE_KEYS). BOTH
   *  access-matrix editors grey the control and keep the row: Positions
   *  (#709) and the legacy Roles matrix. Sent by /api/positions/pages AND
   *  /api/roles/pages off the one DORMANT_PAGE_KEYS set, so the two editors
   *  cannot disagree about which cells are dead.
   *  Still optional: absent means "not told", never "wired". */
  dormant?: boolean;
}

/** Per-page access entry on a role. `explicit = true` means the
 *  level came from a `role_page_access` row; `false` means it's
 *  computed by backfill rules — i.e. inferred from the role's
 *  permissions JSON. */
export interface RolePageAccess {
  level: AccessLevel;
  explicit: boolean;
}

export interface AuthUser {
  id: number;
  email: string;
  /** The signed-in member's outward Mail Center alias (users.email_alias).
   *  Lets them compose/reply FROM their own address. Older backends omit it. */
  email_alias?: string | null;
  name: string | null;
  role_id: number;
  role_name: string;
  status: string;
  permissions: string[];
  /**
   * Per-page access map (mig 073). Keys are stable page identifiers
   * (e.g. "sales", "projects"). Missing keys default to "none" on
   * the consuming side. Hydrated once per session at /api/auth/me.
   */
  page_access?: Record<string, AccessLevel>;
  manager_id?: number | null;
  scope_to_pic?: boolean;
  joined_at?: string | null;
  last_login_at?: string | null;
  /** R2 key for the user's profile picture (mig 058). */
  profile_pic_r2_key?: string | null;
  /** True when the member has an explicit SCM L2 page-access config; the mobile
   *  nav then requires the specific area key (not the bare scm.access). Optional
   *  — older backends omit it, so consumers treat undefined as "not configured". */
  scm_l2_configured?: boolean;
  /** True ONLY for DIRECTOR-level users (Super Admin, Sales Director,
   *  Finance Manager, owner `*`). Gates the Projects "Finances" sub-page
   *  (nav + route). Older backends omit it → treated as false. */
  project_finance_viewer?: boolean;
  /** True for the COST cohort — Purchasing, Finance Manager, Sales Director,
   *  owner `*` (owner 2026-07-17). Gates SKU/product cost only; see
   *  auth/salesAccess.canViewProductCost. Deliberately NOT the same question as
   *  project_finance_viewer above (PMS project financials) — a Purchasing user
   *  is true here and false there. Older backends omit it → treated as false,
   *  which falls back to the director-only behaviour, not to open. */
  product_cost_viewer?: boolean;
  /** True when this user may WRITE SCM master data / config — the ONE answer to
   *  the `scm.config.write` question, computed by the backend
   *  (services/positionPolicy.userCanWriteScmConfig) and used verbatim by the
   *  API gate (scm/lib/houzs-perms.canWriteScmConfig). It is the flat permission
   *  key OR the position policy's canWriteConfig flag; a screen must NOT ask
   *  `can('scm.config.write')` instead, which is the flat half only and was
   *  showing "Read-only view" to positions whose edits the API accepted.
   *  Older backends omit it → treated as false by the helper, which then falls
   *  back to the flat key, i.e. exactly today's behaviour. */
  scm_config_writer?: boolean;
  /**
   * The RESOLVED capability set — the server's answers to "what may this user
   * do", computed once per /auth/me by backend services/capabilities.ts and
   * consumed verbatim by desktop and mobile. Owner's ruling 2026-07-19: the
   * frontend is TOLD a permission, it does not compute one.
   *
   * Read it through auth/capabilities.ts (`useCapability` / `capability`), never
   * by indexing this object directly — those helpers fail closed on an absent
   * set and an absent key, and the direct read is where a `?? true` eventually
   * gets written. The two flags above are the same idea grown one field at a
   * time; they stay for a cached SPA shell that predates this response.
   *
   * OPTIONAL ONLY FOR THE DEPLOY WINDOW. `undefined` means the Worker predates
   * the capabilities response, NOT that the user has no permissions — every gate
   * reads false and auth/capabilities.capabilitiesUnresolved reports the
   * condition so it can be surfaced as a load failure rather than a denial.
   * Values are `boolean | undefined` per key for the same reason: a key the
   * server has not shipped yet must not be indistinguishable from `true`.
   */
  capabilities?: Partial<Record<string, boolean>>;
  /** Org POSITION name (positions.name) — e.g. "Sales Executive",
   *  "Super Admin". Sent by /auth/me (services/auth.ts → hydrateAuthUser).
   *  Drives the code-keyed Sales-access model (director / sales detection in
   *  auth/salesAccess.ts), NOT the configurable page matrix. */
  position_name?: string | null;
  /** Org position id (positions.id). Sent by /auth/me. */
  position_id?: number | null;
  /** Primary DEPARTMENT id (users.department_id). Sent by /auth/me. */
  department_id?: number | null;
  /** Primary DEPARTMENT name (departments.name) — e.g. "Sales". Sent by
   *  /auth/me (backend #400 → services/auth.ts). Primary signal for the
   *  code-keyed Sales-access model (auth/salesAccess.ts isSalesStaff), which
   *  is more robust than keying off the position name alone. */
  department_name?: string | null;
  /** Operational-capability grants for this member's POSITION
   *  (position_capabilities, mig 0322) — the editable Roles & Permissions
   *  matrix. e.g. "scm.do.load", "scm.do.dispatch". Sent by /auth/me. Drives
   *  UX gating that mirrors the backend hasPositionCapability check (the scan-
   *  confirm route + button); the server endpoint is the real boundary. Older
   *  backends omit it → treated as no grants. */
  position_capabilities?: string[];
}

export interface TeamMember {
  id: number;
  email: string;
  name: string | null;
  status: "invited" | "active" | "disabled";
  /** Why the account was disabled (cleared on re-enable). */
  status_reason?: string | null;
  role_id: number;
  role_name: string;
  /** Who this user reports to in the org chart. null = root. */
  manager_id: number | null;
  manager_name: string | null;
  manager_email: string | null;
  /** Department grouping — orthogonal to role, purely for visibility. */
  department_id: number | null;
  department_name: string | null;
  /** 6-char hex without the leading '#'. */
  department_color: string | null;
  /**
   * Full department membership set (mig 0020). Includes the primary
   * `department_id` (listed first) plus any additional departments. The
   * colour stripe/dot still follows the primary. Older deployed backends omit
   * this — fall back to `[department_id]` when absent.
   */
  department_ids?: number[];
  /** Free-text sub-grouping within a department (mig 0021) — drives the org
   *  chart's columns. Null = the department's default column. */
  division?: string | null;
  /** Position = department×position org unit (mig 094). Drives the page matrix. */
  position_id: number | null;
  position_name: string | null;
  /**
   * Per-user brand allow-list (mig 049). Drives sales-dept project
   * visibility for users in scope_to_pic roles. Empty array when no
   * brands assigned (or role isn't sales-scoped — empty here doesn't
   * imply anything for unscoped users).
   */
  brands: string[];
  /**
   * Per-user company grants (Phase 0e — user_companies). Company ids the member
   * may act in. Empty array = no grant row → the user fail-opens to ALL
   * companies (companyContext). Older backends omit this field. Drives the Team
   * "Company" column and the edit/invite Company selector.
   */
  company_ids?: number[];
  invited_at: string | null;
  /** Who issued the invite (mig: users.invited_by). */
  invited_by?: number | null;
  invited_by_name?: string | null;
  invited_by_email?: string | null;
  joined_at: string | null;
  last_login_at: string | null;
  created_at: string;
  /** R2 key for the user's profile picture (mig 058). */
  profile_pic_r2_key: string | null;
  /** Contact phone (mig 0013). Captured at invite. */
  phone: string | null;
  /** The member's outward email alias (e.g. lim@houzscentury.com). Surfaced in
   *  User Management; complements the Mail Center `email_addresses` link. Older
   *  backends omit it. */
  email_alias?: string | null;
}

export interface Department {
  id: number;
  name: string;
  description: string | null;
  /** 6-char hex without the leading '#'. */
  color: string;
  sort_order: number;
  member_count: number;
  /** 2–4 letter reference-number segment (mig 20260906T1417), e.g. "OPS".
   *  null = not assigned yet; a department without one cannot mint numbers. */
  code?: string | null;
  /** The department's chosen lead (mig-pg 0331). null = no lead set — the real
   *  lead takes precedence over the derived one; see teamShared.buildDeptNodes. */
  lead_user_id?: number | null;
  /** Optional planned headcount an HR lead fills in. null = no target. */
  headcount_target?: number | null;
  created_at?: string;
}

export interface Position {
  id: number;
  department_id: number | null;
  department_name: string | null;
  slug: string;
  name: string;
  level: number;
  sort_order: number;
  active: boolean;
  member_count: number;
}

export interface Invitation {
  id: number;
  email: string;
  role_id: number;
  role_name: string;
  token: string;
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  invited_by_email: string | null;
  /** Canonical link built server-side from PUBLIC_APP_URL. */
  invite_url?: string;
  /** Latest email_log outcome: 'sent' | 'skipped' | 'error' | null. */
  email_status?: string | null;
  emailed_at?: string | null;
}

export interface Role {
  id: number;
  name: string;
  description: string | null;
  permissions: string[];
  /** Keys stored on this role that the BACKEND CATALOGUE does not declare, so
   *  they are dropped at session hydration and decide nothing. Served by
   *  GET /api/roles so a dead grant is visible instead of silent — a key
   *  missing from the catalogue used to produce no signal at all, which is how
   *  service_cases.approve stayed accidentally Owner-only for weeks.
   *  Optional because an older backend does not send it; absent means "the
   *  server did not say", never "there are none". */
  unknown_permissions?: string[];
  is_system: boolean;
  /** When true, users with this role can only see projects where they
   *  or their manager is the PIC. Drives the sales-team ACL. */
  scope_to_pic?: boolean;
  member_count: number;
  created_at?: string;
}

export interface PermissionDef {
  key: string;
  resource: string;
  verb: "read" | "write" | "manage";
  label: string;
  description: string;
}

export interface ActiveMember {
  id: number;
  email: string;
  name: string | null;
  role_id: number;
  role_name: string;
  last_seen_at: string;
  /** Last SPA pathname the 60s heartbeat reported — deep-link target for the
   *  who's-online popover. Null until that user's client sends it. */
  last_path?: string | null;
  is_self: boolean;
}

export interface PresenceResponse {
  active: ActiveMember[];
  /** Quiet for 2–15 min (tab hidden/idle). Optional: absent from a backend
   *  that predates the who's-online popover (deploy skew). */
  away?: ActiveMember[];
  count: number;
  window_seconds: number;
  away_window_seconds?: number;
}

// ──────────────────────────────────────────────────────────
// Planner / scheduling agent
// ──────────────────────────────────────────────────────────

export interface PlannerStop {
  doc_no: string;
  sequence: number;
  debtor_name: string | null;
  lat: number;
  lng: number;
  local_total: number;
  expiry_date: string;
  reason?: string;
}

export interface PlannerTrip {
  id: number;
  proposal_id: number;
  warehouse: string;
  warehouse_name: string | null;
  warehouse_lat: number | null;
  warehouse_lng: number | null;
  trip_date: string;
  suggested_lorry_id: number | null;
  suggested_driver_user_id: number | null;
  trip_type: "delivery" | "setup" | "dismantle" | "sg" | "blocked";
  total_revenue: number;
  total_distance_km: number;
  stop_count: number;
  is_outsourced: number;
  lorry_plate: string | null;
  lorry_size: string | null;
  lorry_is_internal: number | null;
  driver_name: string | null;
  driver_email: string | null;
  payload: {
    stops: PlannerStop[];
    reason: string;
    blocked_reason?: string;
    full_route_km?: number;
    route_chain?: { label: string; lat: number; lng: number; type: string }[];
  };
}

export interface PlannerSummary {
  horizon_days: number;
  generated_at: string;
  total_trips: number;
  total_revenue: number;
  total_orders: number;
  blocked_orders: number;
  by_warehouse: Record<string, { trips: number; revenue: number }>;
  outsourced_trips: number;
}

export interface PlannerProposal {
  id: number;
  generated_at: string;
  generated_by: number | null;
  horizon_days: number;
  status: "draft" | "confirmed" | "discarded";
  summary: PlannerSummary | null;
}

// ──────────────────────────────────────────────────────────
// Events — manual setup / dismantle calendar entries
// ──────────────────────────────────────────────────────────

export type EventType = "setup" | "dismantle";

export interface CalendarEvent {
  /** Numeric ids belong to manual rows in the `events` table.
   *  Project-sourced rows use a string id like "project-42-setup" so
   *  they never collide with autoincrement values. The `source` field
   *  is the canonical signal — id type is just the implementation
   *  detail. */
  id: number | string;
  type: EventType;
  title: string;
  event_date: string;
  address: string | null;
  status: string | null;
  notes: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  /** "manual" → row in events table, fully editable here.
   *  "project" → derived from a project's setup/dismantle config,
   *  read-only at this surface (clicks navigate to the project). */
  source?: "manual" | "project";
  project_id?: number;
  project_code?: string | null;
  driver_name?: string | null;
  lorry_plate?: string | null;
  end_at?: string | null;
}

// ── Sales Team (mig 067) ─────────────────────────────────────
// Retail rep org chart, separate from the workspace `users`
// directory. A workspace user may or may not be a sales rep, and a
// sales rep may or may not have a workspace login.

export interface SalesPosition {
  id: number;
  slug: string;
  name: string;
  level: number; // 10 = Director, 20 = Executive, 30 = Sub-Executive
  sort_order: number;
  active: number;
}

export interface SalesCommissionTier {
  id: number;
  slug: string;
  name: string;
  rate: number; // percent
  sort_order: number;
  active: number;
}

export interface SalesRep {
  id: number;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  // Mig 068
  nric?: string | null;
  position_id: number | null;
  position_slug?: string | null;
  position_name?: string | null;
  position_level?: number | null;
  upline_id: number | null;
  upline_secondary_id?: number | null;
  upline_code?: string | null;
  upline_name?: string | null;
  user_id: number | null;
  user_email?: string | null;
  user_name?: string | null;
  status: "active" | "inactive";
  is_admin: number;
  commission_rate: number | null;
  commission_min_rate?: number | null;
  commission_tier_id: number | null;
  joined_on: string | null;
  notes: string | null;
  archived_at: string | null;
  brands: string[];
  team_size?: number; // populated by list endpoint
}

export interface SalesRepTier {
  id?: number;
  threshold: number; // sales threshold in RM
  rate: number; // percent
  sort_order?: number;
}

export interface SalesTeamActivity {
  id: number;
  rep_id: number;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name?: string | null;
  created_at: string;
}
