import type { ProjectStatus as SharedProjectStatus } from "../../vendor/scm/lib/pms-project-status";


export type ProjectStage =
  | "draft"
  | "setup"
  | "live"
  | "dismantle"
  | "completed";

export type ChecklistStatus = "pending" | "done" | "na" | "blocked";

export type ProjectStatus = SharedProjectStatus;

export interface ProjectRow {
  id: number;
  code: string;
  name: string;
  stage: ProjectStage;
  status: ProjectStatus;
  brand: string | null;
  start_date: string | null;
  end_date: string | null;
  state: string | null;
  venue: string | null;
  organizer: string | null;
  booth_no: string | null;
  size_sqm: number | null;
  archived_at: string | null;
  event_type_name: string | null;
  rental: number | null;
  total_sales: number | null;
  contractor_cost: number | null;
  fin_revenue?: number | null;
  fin_cogs?: number | null;
  fin_cogs_matt_sofa?: number | null;
  fin_cogs_bedframe?: number | null;
  fin_cogs_accessories?: number | null;
  fin_rental?: number | null;
  fin_total_cost?: number | null;
  venue_size?: number | null;
  progress_pct: number;
  pic_id: number | null;
  pic_name: string | null;
  created_by: number | null;
  created_by_name: string | null;
  active_section_name?: string | null;
  sections_total?: number;
  sections_complete?: number;
  section_tasks_map?: string | null;
  task_pending_map?: string | null;
}

export interface SalesAttendee {
  sales_rep_id: number;
  rep_code: string | null;
  rep_name: string | null;
  rep_phone: string | null;
  rep_user_id: number | null;
  user_name: string | null;
  created_at: string | null;
}

export interface TasklistSection {
  id: number;
  name: string;
  sort_order: number;
  display_mode?: "list" | "documents";
}

export interface SectionProgress {
  id: number;
  name: string;
  sort_order: number;
  total: number;
  done: number;
  na: number;
  complete: number;
}

export interface TaskAttachment {
  id: number;
  item_id: number;
  r2_key: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_by: number | null;
  uploader_name: string | null;
  uploaded_at: string;
  caption: string | null;
}

export type PaymentStatus =
  | "not_started"
  | "deposit_paid"
  | "paid"
  | "refund_pending"
  | "refunded";

export interface StockTransfer {
  id: number;
  project_id: number;
  direction: "out" | "return";
  transferred_at: string | null;
  record_r2_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  notes: string | null;
  confirmed_at: string | null;
  confirmed_by: number | null;
  confirmed_by_name: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
}

export interface FinanceLine {
  id: number;
  project_id: number;
  kind: "income" | "cost";
  category: string;
  description: string | null;
  amount: number;
  occurred_at: string | null;
  r2_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
  source?: "sales_entry" | "books";
  source_id?: number;
  doc_no?: string | null;
  account_code?: string | null;
  account_name?: string | null;
  auto_source?: "auto:transport" | "auto:merchandise" | "auto:commission" | null;
}

/** The books on the event page (owner 2026-10-01, payment-request item 5:
 *  某一行只要有了入账，就用入账的数字，取代原本手填的或自动算的) — server:
 *  backend/src/scm/lib/event-books.ts. finance_lines already carries the
 *  books' lines in place of the ones they replaced. */
export interface FinanceBooks {
  ok: boolean;
  reason: string | null;
  rows: string[];
  closed_categories: string[];
  replaced: FinanceLine[];
}

/** A % row of the P&L: Finance's figure, a typed line, or the rate card. */
export interface PnlPctRow {
  amount: number;
  from: "books" | "typed" | "rate" | "none";
  pct: number | null;
}

/** One of the event's two P&Ls (backend services/eventPnl.ts). */
export interface PnlColumn {
  sales: number;
  salesFrom: "lines" | "box" | "so" | "none";
  cogs: { mattSofa: number; bedframe: number; accessories: number; other: number; total: number; from: "typed" | "so" | "so_ratio" | "none" };
  rental: number;
  setup: number;
  transportSetupDismantle: number;
  others: number;
  serviceRevenue: number;
  transportFee: PnlPctRow & { serviceCost: number };
  commission: PnlPctRow & { boost: boolean };
  merchandise: PnlPctRow;
  totalCost: number;
  grossProfit: number;
  netProfit: number;
}

/** The event's two P&Ls (owner 2026-10-16): by the Total Sales he keys, and by
 *  the Sales Orders opened at the fair. `by_so` is null with no order opened. */
export interface EventPnl {
  by_sales: PnlColumn;
  by_so: PnlColumn | null;
  so_count: number;
}

export type AttachRole = "sales" | "driver" | "design" | "office";

export interface ProjectAttachment {
  id: number;
  category: string | null;
  r2_key: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  uploader_name: string | null;
  uploaded_by_role: AttachRole | null;
  created_at: string;
}

export interface ProjectDefect {
  id: number;
  project_id: number;
  phase: "setup" | "dismantle";
  reported_by_role: "sales" | "logistic";
  item_code: string | null;
  item_description: string | null;
  size: string | null;
  quantity: number | null;
  reason: string | null;
  photo_r2_key: string | null;
  reported_by_name: string | null;
  reported_at: string;
  resolved: number;
  resolved_notes: string | null;
  linked_assr_id: number | null;
  linked_assr_no: string | null;
}

export interface ProjectTrip {
  id: number;
  code: string;
  status: string;
  scheduled_date: string | null;
  trip_type: string | null;
  description: string | null;
}

export interface ChecklistItem {
  id: number;
  seq: number;
  title: string;
  description: string | null;
  required_perm: string | null;
  role_label: string | null;
  crew_visible: number;
  due_date: string | null;
  owner_user_id: number | null;
  owner_name: string | null;
  status: ChecklistStatus;
  review_status: "pending_review" | "rejected" | "amended" | "approved" | null;
  rejection_reason: string | null;
  completed_by: number | null;
  completed_by_name: string | null;
  completed_at: string | null;
  notes: string | null;
  section_id: number | null;
  pill_kind: string | null;
  pill_value: string | null;
}

export interface ActivityRow {
  id: number;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name: string | null;
  created_at: string;
}

export interface EventType {
  id: number;
  slug: string;
  name: string;
  default_template_id: number | null;
}

export interface Paginated<T> {
  data: T[];
  page: number;
  per_page: number;
  total: number;
}
