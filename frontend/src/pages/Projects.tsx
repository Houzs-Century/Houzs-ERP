import { Fragment, createContext, useContext, useState, useMemo, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams, Navigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Circle,
  Ban,
  Lock,
  Trash2,
  Upload,
  FileText,
  ImageOff,
  Image as ImageIcon,
  Upload as UploadIcon,
  X,
  ExternalLink,
  MessageSquare,
  Truck,
  Banknote,
  Monitor,
  Receipt,
  AlertTriangle,
  Info,
  AlertOctagon,
  Printer,
  BarChart3,
  Download,
  Pencil,
  Send,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Paperclip,
  Eye,
  EyeOff,
  Play,
  UserCircle2,
  Users,
  Phone,
  ClipboardList,
  DollarSign,
  Wrench,
  Search,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { HubGrid } from "../components/HubGrid";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { ProjectMaintenanceView } from "./ProjectMaintenance";
import { TabStrip } from "../components/TabStrip";
import { getHolidaysOn } from "../lib/holidays";
import { compareCalendarEvents } from "../lib/calendarSort";
import { toCSV, downloadCSV } from "../lib/csv";
import { PnlCalendar } from "../components/PnlCalendar";
import { DataTable, type Column } from "../components/DataTable";
import { ListErrorPanel, SearchPendingPanel } from "../components/SearchProgress";
import { StatusDot } from "../components/StatusDot";
import { Pagination } from "../components/Pagination";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import { ProjectChat } from "../components/ProjectChat";
import { ProjectGantt } from "../components/ProjectGantt";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  HeaderButton,
} from "../components/DetailLayout";
import { InlineEdit } from "../components/InlineEdit";
import { StatCard } from "../components/StatCard";
import { DashboardGrid } from "../components/Dashboard";
import { useQuery, type QueryState } from "../hooks/useQuery";
import { useSearchResultTransition } from "../hooks/useServerSearch";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { Skeleton, ListSkeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { useUdf } from "../hooks/useUdf";
import {
  EntryPanel,
  STATUS_BADGE as SALES_STATUS_BADGE,
  PAYMENT_TYPE_LABEL,
  type SalesEntry,
  type EntryStatus as SalesEntryStatus,
} from "./Sales";
import {
  booleanPreference,
  enumPreference,
  pageSizePreference,
  useIdentityPreference,
} from "../hooks/useIdentityPreference";
import { useServerSort } from "../hooks/useServerSort";
import { useFocusFromUrl } from "../hooks/useFocusFromUrl";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { useRafCoalescedHover } from "../hooks/useRafCoalescedHover";
import { useAuth } from "../auth/AuthContext";
import { usePageAccess } from "../auth/PageGuard";
import { isSalesStaff, isDirectorUser, isSalesDirectorUser, canCreateEvent, canLogSalesEntry, canWriteProjectFinance } from "../auth/salesAccess";
import { readProjectAccess, projectAccessUnresolved, holdsChecklistApproval } from "../auth/projectAccess";
import { isCrewScopedUser } from "../auth/crewScope";
import { PMS_STAGE_LABEL, pmsStageVariant } from "../vendor/scm/lib/pms-status";
import { LEDGER_COST_CATS, LEDGER_INCOME_CATS, ledgerCategoryLabel } from "../vendor/scm/lib/pms-ledger-categories";
import { isReviewableTitle } from "../vendor/scm/lib/pms-reviewable-titles";
import { PROJECT_STATUS_OPTIONS, paymentPillOptions, type ProjectStatus as SharedProjectStatus } from "../vendor/scm/lib/pms-project-status";
import { Forbidden } from "./Forbidden";
import { useNotifications } from "../hooks/useNotifications";
import { api, buildQuery, humanHttpMessage, tokenStore } from "../api/client";
import { formatPhone } from "../vendor/shared/phone";
import { companyHeader } from "../lib/activeCompany";
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromError,
  requestIdFromResponse,
} from "../lib/requestCorrelation";
import { MediaLightbox } from "../components/MediaLightbox";
import { ResetFiltersButton } from "../components/ResetFiltersButton";
import { PrintPreviewModal, usePrintPreview } from "../components/scm-v2/PrintPreviewModal";
import { formatDate, formatDateTime, formatTimestamp, formatCurrency, cn, relativeTime, todayInAppTz } from "../lib/utils";
import { fmtDate } from "../vendor/shared/format";
import { DateField } from "../vendor/scm/components/DateField";
import { DateTimeField } from "../vendor/scm/components/DateTimeField";

// ── Types (module-local) ─────────────────────────────────────
// Kept in this file until something else imports them. Promoting to
// types.ts is a no-brainer move once a second page needs them.

// Simplified lifecycle (mig 053):
//   draft → setup → live → dismantle → completed
// "planning" + "build" collapsed into "setup"; "teardown" → "dismantle";
// "closed"/"cancelled" → "completed".
type ProjectStage =
  | "draft"
  | "setup"
  | "live"
  | "dismantle"
  | "completed";

type ChecklistStatus = "pending" | "done" | "na" | "blocked";

// mig 088 — boss-facing lifecycle, drives the calendar tint and replaces
// the old Go Live button. Independent from `stage` which keeps driving
// the internal workflow + section tracker.
type ProjectStatus = SharedProjectStatus;

interface ProjectRow {
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
  // Ledger-derived per-category finance sums (whole RM integers) from the
  // list endpoint. Null for finance-hidden users (redacted server-side).
  // GP / NP / percent columns are derived from these in the column defs.
  fin_revenue?: number | null;
  fin_cogs?: number | null;
  fin_cogs_matt_sofa?: number | null;
  fin_cogs_bedframe?: number | null;
  fin_cogs_accessories?: number | null;
  fin_rental?: number | null;
  fin_total_cost?: number | null;
  // Venue physical size (m²) — populated once feat/pms-venue-size-field lands
  // the `size` column on project_venues and the list joins it. Guarded: the
  // column renders "—" while this is absent.
  venue_size?: number | null;
  progress_pct: number;
  pic_id: number | null;
  pic_name: string | null;
  created_by: number | null;
  created_by_name: string | null;
  // Section-driven stage tracker (mig 050). active_section_name is null
  // when every section is done OR the project has no sections defined.
  // Combine with sections_total / sections_complete to distinguish
  // "everything done" from "no sections yet".
  active_section_name?: string | null;
  sections_total?: number;
  sections_complete?: number;
  // Populated only when a real section is picked in the Status filter (owner
  // 2026-08-14). Tasks of that section: 'title=status=due' pairs joined by '|',
  // where due is a bare YYYY-MM-DD or empty. Drives the per-project task badges.
  section_tasks_map?: string | null;
}

interface ProjectDetail {
  project: ProjectRow & {
    organizer: string | null;
    venue_address: string | null;
    event_type_id: number | null;
    notion_url: string | null;
    notes: string | null;
    created_by_name: string | null;
    created_at: string;
    updated_at: string;
    duration_days: number | null;
    pic_id: number | null;
    pic_name: string | null;
    pic_email: string | null;
    pic_phone: string | null;
    // Logistics schedule (Notion parity)
    setup_start_at: string | null;
    setup_end_at: string | null;
    dismantle_start_at: string | null;
    dismantle_end_at: string | null;
    setup_driver_user_id: number | null;
    setup_driver_name: string | null;
    setup_lorry_id: string | null;
    setup_lorry_plate: string | null;
    dismantle_driver_user_id: number | null;
    dismantle_driver_name: string | null;
    dismantle_lorry_id: string | null;
    dismantle_lorry_plate: string | null;
    // Phase helper crew (mig 083)
    setup_helper_1_id: number | null;
    setup_helper_1_name: string | null;
    setup_helper_2_id: number | null;
    setup_helper_2_name: string | null;
    setup_helper_outsourced: number;
    dismantle_helper_1_id: number | null;
    dismantle_helper_1_name: string | null;
    dismantle_helper_2_id: number | null;
    dismantle_helper_2_name: string | null;
    dismantle_helper_outsourced: number;
    // Phase crew editor (mig 097) -- JSON: drivers/helpers (name+phone),
    // lorries, outsourced (name/phone/plate). Read by the stage stepper
    // (setup_crew) and written by the Setup & Dismantle crew editor.
    setup_crew: string | null;
    dismantle_crew: string | null;
    // service_crew (owner 2026-07-22): mid-fair Service / Exchange trip — same
    // JSON as setup/dismantle plus a `remark` ("what service/exchange").
    // Optional so existing project mocks/fixtures without it still typecheck.
    service_crew?: string | null;
    // Schedule Reference remark (owner 2026-07-23): free-text setup/dismantle
    // times for solo events with no handbook screenshot (mig 0218).
    schedule_remark?: string | null;
    banner_message: string | null;
    banner_tone: "info" | "warning" | "error" | null;
    // Payment workflow
    payment_status: PaymentStatus | null;
    payment_proof_r2_key: string | null;
    payment_proof_file_name: string | null;
    payment_notes: string | null;
    payment_updated_at: string | null;
  };
  /** Per-project access tier computed server-side. "limited" = scoped
   *  rep — finance / logistics / linked POs panels should be hidden. */
  _access?: {
    level: "full" | "limited";
    is_pic: boolean;
    scoped: boolean;
    /** PMS role-based visibility (sales-department feature). When present it
     *  refines what the viewer may see/edit; when absent (older cached
     *  response) callers fall back to `level === "full"`. */
    pms?: {
      role:
        | "DIRECTOR"
        | "PIC"
        | "SALES"
        | "PURCHASING"
        | "LOGISTIC"
        | "DRIVER"
        | "OTHER"
        | "NONE";
      canOpen: boolean;
      canEdit: boolean;
      canFinancial: boolean;
      canRental: boolean;
      canPayment: boolean;
      canSensitive: boolean;
      /** Setup & Dismantle section (crew editor + documents). Owner
       *  2026-07-15: hidden from non-director Sales, even the PIC. */
      canSetupDismantle: boolean;
      sections: string[];
    };
  };
  finance: {
    rental: number | null;
    contractor_cost: number | null;
    license_fee: number | null;
    deposit_paid: number | null;
    deposit_refund: number | null;
    misc_cost: number | null;
    total_sales: number | null;
    notes: string | null;
  } | null;
  finance_lines: FinanceLine[];
  stock_transfers: StockTransfer[];
  checklist: ChecklistItem[];
  checklist_comments: ChecklistComment[];
  /** Per-task attachments (mig 050). Replaces project-level Attachments. */
  checklist_attachments?: TaskAttachment[];
  /** Tasklist sections (mig 050). Tasks group under these. */
  sections?: TasklistSection[];
  /** Per-section progress for the stage chip row. */
  section_progress?: SectionProgress[];
  attachments: ProjectAttachment[];
  defects: ProjectDefect[];
  activity: ActivityRow[];
  team: any[];
  trips: ProjectTrip[];
  /** Sales reps attending the project (mig 087). */
  sales_attendees?: SalesAttendee[];
}

interface SalesAttendee {
  sales_rep_id: number;
  rep_code: string | null;
  rep_name: string | null;
  rep_phone: string | null;
  rep_user_id: number | null;
  user_name: string | null;
  created_at: string | null;
}

interface TasklistSection {
  id: number;
  name: string;
  sort_order: number;
  /** mig 085 — "list" (default) or "documents" (6-col table layout). */
  display_mode?: "list" | "documents";
}

interface SectionProgress {
  id: number;          // 0 sentinel = "Uncategorised"
  name: string;
  sort_order: number;
  total: number;
  done: number;
  na: number;
  complete: number;    // 0 | 1
}

interface TaskAttachment {
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

type PaymentStatus =
  | "not_started"
  | "deposit_paid"
  | "paid"
  | "refund_pending"
  | "refunded";

interface StockTransfer {
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

interface FinanceLine {
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
  // Synthesised rows (e.g. from sales_entries) carry a source marker so
  // the UI can suppress edit/delete — the source table is the truth.
  source?: "sales_entry";
  source_id?: number;
  // Auto-generated by the cost-rate engine (mig 063). UI locks
  // edit + delete; users adjust the rate card in Project Maintenance.
  auto_source?: "auto:transport" | "auto:merchandise" | "auto:commission" | null;
}

type AttachRole = "sales" | "driver" | "design" | "office";

interface ProjectAttachment {
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

interface ProjectDefect {
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

interface ChecklistComment {
  id: number;
  item_id: number;
  kind: "note" | "submit" | "reject" | "amend" | "approve" | "upload" | "remove"; // written as RAW SQL by routes/projects.ts:4235,:4318, bypassing the typed helper; widen with the mirror in backend/src/services/projects.ts
  body: string | null;
  user_name: string | null;
  created_at: string;
}

interface ProjectTrip {
  id: number;
  code: string;
  status: string;
  scheduled_date: string | null;
  trip_type: string | null;
  description: string | null;
}

interface ChecklistItem {
  id: number;
  seq: number;
  title: string;
  description: string | null;
  required_perm: string | null;
  /** mig 085 — display-only owner tag (e.g. "DRIVER", "SALES PIC"). */
  role_label: string | null;
  /** mig 086 — when 1, surfaces in the Driver App. */
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
  /** mig 090 — when set, row renders multi-state payment pills instead
   *  of the done/pending circle. 'rental_payment' | 'security_deposit'. */
  pill_kind: string | null;
  pill_value: string | null;
}

interface ActivityRow {
  id: number;
  action: string;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  user_id: number | null;
  user_name: string | null;
  created_at: string;
}

interface EventType {
  id: number;
  slug: string;
  name: string;
  default_template_id: number | null;
}

interface Paginated<T> {
  data: T[];
  page: number;
  per_page: number;
  total: number;
}

// Canonical event name helper. Builds the `STATE - BRAND - TYPE - VENUE`
// convention teams use internally. Empty fields are skipped so a
// half-filled project still produces something readable.
// ── Organizer picker ─────────────────────────────────────────
// Combobox-style: select from existing organizers OR add a new one
// inline. Picks land in projects.organizer (free text) and also get
// recorded in project_organizers so the next project sees them.

function OrganizerPicker({
  value,
  onChange,
  className,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  className?: string;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const q = useQuery<{ data: { id: number; name: string }[] }>("/api/projects/organizers",
    () => api.get("/api/projects/organizers"),
    []
  );
  const options = q.data?.data ?? [];

  async function addNew() {
    const name = await dialog.prompt({
      title: "Add organizer",
      message: "Add a new organizer to the picker. Subsequent projects will see it too.",
      placeholder: "e.g. PIKOM",
      required: true,
      confirmLabel: "Add",
    });
    if (!name) return;
    try {
      await api.post("/api/projects/organizers", { name });
      await q.reload();
      onChange(name);
      toast.success(`Added ${name}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to add");
    }
  }

  const SENTINEL_NEW = "__add_new__";

  return (
    <select
      value={value || ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === SENTINEL_NEW) {
          // Don't commit the sentinel — open the prompt and let it
          // call onChange with the actual new name.
          void addNew(); // same idiom as the other async handlers here (:2116, :7691)
          return;
        }
        onChange(v || null);
      }}
      className={
        className ??
        "w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
      }
    >
      <option value="">— select organizer —</option>
      {/* Surface legacy values that aren't in the lookup yet */}
      {value && !options.some((o) => o.name === value) && (
        <option value={value}>{value}</option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
        </option>
      ))}
      <option value={SENTINEL_NEW}>＋ Add new organizer…</option>
    </select>
  );
}

// Same pattern as OrganizerPicker but for project_venues. Includes an
// optional `state` callback that fires when the picked venue carries a
// state hint, so the create form can pre-fill the state field.
function VenuePicker({
  value,
  onChange,
  onStateHint,
  className,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  onStateHint?: (state: string | null) => void;
  className?: string;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const q = useQuery<{
    data: { id: number; name: string; state: string | null }[];
  }>("/api/projects/venues", () => api.get("/api/projects/venues"), []);
  const options = q.data?.data ?? [];

  async function addNew() {
    const name = await dialog.prompt({
      title: "Add venue",
      message:
        "Add a new venue to the picker. Subsequent projects will see it too.",
      placeholder: "e.g. KLCC Convention Centre",
      required: true,
      confirmLabel: "Add",
    });
    if (!name) return;
    try {
      const r = await api.post<{ id: number; name: string; state: string | null }>(
        "/api/projects/venues",
        { name }
      );
      await q.reload();
      onChange(r.name);
      if (r.state && onStateHint) onStateHint(r.state);
      toast.success(`Added ${r.name}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to add");
    }
  }

  const SENTINEL_NEW = "__add_new__";

  return (
    <select
      value={value || ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === SENTINEL_NEW) {
          addNew();
          return;
        }
        onChange(v || null);
        if (v && onStateHint) {
          const match = options.find((o) => o.name === v);
          if (match?.state) onStateHint(match.state);
        }
      }}
      className={
        className ??
        "w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
      }
    >
      <option value="">— select venue —</option>
      {value && !options.some((o) => o.name === value) && (
        <option value={value}>{value}</option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
          {o.state ? ` · ${o.state}` : ""}
        </option>
      ))}
      <option value={SENTINEL_NEW}>＋ Add new venue…</option>
    </select>
  );
}

function composeEventName(p: {
  brand?: string | null;
  event_type_name?: string | null;
  venue?: string | null;
}): string {
  const parts = [p.brand, p.event_type_name?.toUpperCase(), p.venue]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  return parts.join(" - ");
}

// Default project-name format used by the create form.
//   "{state} [{brand}] {organizer | SOLO} @ {venue}"
// A picked organizer always fills the slot — solo events included (owner
// 2026-08-17, IOI Mall Damansara: the calendar said SOLO while the Excel
// organizer column said MALL MGMT). "SOLO" appears only when no organizer is
// chosen. Mirrors deriveProjectName in backend/src/services/project-naming.ts.
function composeDefaultProjectName(p: {
  state?: string | null;
  brand?: string | null;
  organizer?: string | null;
  venue?: string | null;
  event_type_slug?: string | null;
}): string {
  const state = (p.state || "").trim();
  const brand = (p.brand || "").trim();
  const organizer = (p.organizer || "").trim();
  const venue = (p.venue || "").trim();
  const isSolo = (p.event_type_slug || "").toLowerCase() === "solo";
  const orgSlot = organizer || (isSolo ? "SOLO" : "");

  const head: string[] = [];
  // State leads the name UPPERCASE (owner 2026-07-24): the 2026-07-22 canonical
  // migration stores states Title Case ("Selangor"), but the event-name/bar
  // convention is all-caps ("SELANGOR [AKEMI] SOLO @ …") to match the older
  // UPPERCASE-stored names still on non-solo projects.
  if (state) head.push(state.toUpperCase());
  if (brand) head.push(`[${brand}]`);
  if (orgSlot) head.push(orgSlot);
  const left = head.join(" ");
  if (!venue) return left;
  if (!left) return `@ ${venue}`;
  return `${left} @ ${venue}`;
}

// Event labels show the STATE in all-caps ("KUALA LUMPUR [AKEMI] …", owner
// 2026-07-29). Stored names composed after the 2026-07-22 canonical-state
// migration lead with a Title-Case state ("Kuala Lumpur"), so uppercase that
// leading state on render. No-op when the name doesn't begin with the state.
function upcaseLeadingState(name: string, state?: string | null): string {
  const s = (state || "").trim();
  if (s && name.toLowerCase().startsWith(s.toLowerCase())) {
    return s.toUpperCase() + name.slice(s.length);
  }
  return name;
}

// The browser MIME for a file the user should be able to VIEW inline (PDF,
// image, video). Used to re-type octet-stream blobs before window.open so a
// "View" actually renders instead of downloading. Returns null for types the
// browser can't render inline (docx/xlsx) — those fall through to download.
function viewableMime(name: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "heic", "bmp"].includes(ext)) {
    return `image/${ext === "jpg" ? "jpeg" : ext}`;
  }
  if (ext === "svg") return "image/svg+xml";
  if (ext === "pdf") return "application/pdf";
  if (ext === "mp4" || ext === "webm") return `video/${ext}`;
  if (ext === "mov") return "video/quicktime";
  return null;
}

// Owner 2026-08-04: in the project EXPORT only (not the on-screen table), these
// named event organisers — individual people, not companies — are anonymised to
// "EO". Everything else (retailer organisers like Megahome/Bighome, MALL MGMT,
// Solo) exports verbatim. Matched by LEADING name so the parenthetical team /
// branch suffix doesn't matter: "KAI HAO (KL, CHEN)", "VINCENT (VTEAM EVENT)",
// "MR OOI (TS MOON)", "SYELIN (EV PLAN MKTG)" all collapse to "EO".
const EO_ANON_ORGANIZERS = ["kai hao", "vincent", "mr ooi", "syelin"];
function exportOrganizer(organizer: string | null): string {
  const v = (organizer ?? "").trim();
  const low = v.toLowerCase();
  return EO_ANON_ORGANIZERS.some((n) => low.startsWith(n)) ? "EO" : v;
}

/* Canonical Malaysian states — aligned to `scm.my_localities` after mig 0172
   (owner 2026-07-22). PMS used to store an UPPERCASE short list (`JOHOR` /
   `KL` / `PENANG`) while SCM stored the Title Case full names (`Johor` /
   `Kuala Lumpur` / `Pulau Pinang`); a shared Sales-by-state report split the
   same physical state into two buckets. This list IS the SCM one — new rows
   land canonical, existing UPPERCASE rows are back-filled by the migration. */
const PROJECT_STATES = [
  "Johor",
  "Kedah",
  "Kelantan",
  "Kuala Lumpur",
  "Labuan",
  "Melaka",
  "Negeri Sembilan",
  "Pahang",
  "Perak",
  "Perlis",
  "Pulau Pinang",
  "Putrajaya",
  "Sabah",
  "Sarawak",
  "Selangor",
  "Terengganu",
] as const;

// ── Stage helpers ────────────────────────────────────────────

const STAGE_OPTIONS: { value: "ALL" | ProjectStage; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "setup", label: "Setup" },
  { value: "live", label: "Live" },
  { value: "dismantle", label: "Dismantle" },
  { value: "completed", label: "Completed" },
];

// Stage label + variant now come from the SHARED vendor/scm/lib/pms-status so
// desktop + mobile can't drift on the stage vocabulary.
const STAGE_LABEL: Record<string, string> = PMS_STAGE_LABEL;
const stageVariant = pmsStageVariant;

// Project status palette — drives the calendar tint, the spec strip
// pill, and the header dropdown.
// Premium earth-tone status palette — pine / brass / clay — tuned for the
// cream canvas + Nature Black brand. Replaces the generic primary
// blue/amber/red. `hex` drives the calendar bar tint+rail and legend dots;
// `chip`/`ring` are the matching pill tints used by the list view + the
// status dropdown.
// WHICH statuses exist and what they are CALLED live in pms-project-status.ts,
// shared with mobile. Only the palette is desktop's — mobile styles inline, so
// the value->label contract is the part that must not drift (the same split
// pms-status.ts uses for stages).
const STATUS_TINT: Record<ProjectStatus, { hex: string; chip: string; ring: string }> = {
  confirmed: { hex: "#3f6b53", chip: "bg-[#e8efe9] text-[#2f5341]", ring: "ring-[#3f6b53]/30" },
  pending:   { hex: "#c2740f", chip: "bg-[#f7e8d2] text-[#8a4e0e]", ring: "ring-[#c2740f]/30" },
  cancelled: { hex: "#b23b3b", chip: "bg-[#f4dede] text-[#8a2f2f]", ring: "ring-[#b23b3b]/30" },
};
const STATUS_OPTIONS = PROJECT_STATUS_OPTIONS.map((o) => ({ ...o, ...STATUS_TINT[o.value] }));

const STATUS_BY_VALUE: Record<ProjectStatus, typeof STATUS_OPTIONS[number]> = STATUS_OPTIONS.reduce(
  (acc, s) => ({ ...acc, [s.value]: s }),
  {} as Record<ProjectStatus, typeof STATUS_OPTIONS[number]>
);

function statusBarStyle(status: ProjectStatus | null | undefined): React.CSSProperties {
  const opt = STATUS_BY_VALUE[status ?? "pending"] ?? STATUS_BY_VALUE.pending;
  // Colour is driven by the `.cal-bar` class off this `--bar` custom
  // property: a soft tint + status rail + ink text at rest, deepening to
  // the solid status fill on hover. Keeps the month grid calm/scannable
  // while preserving the bold colour on the bar you're pointing at.
  return { ["--bar" as string]: opt.hex } as React.CSSProperties;
}

function ProjectStatusSelect({
  value,
  onChange,
  disabled,
}: {
  value: ProjectStatus;
  onChange: (next: ProjectStatus) => void;
  disabled?: boolean;
}) {
  const cur = STATUS_BY_VALUE[value] ?? STATUS_BY_VALUE.pending;
  return (
    <div className="relative inline-flex">
      <span
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"
        style={{ background: cur.hex, width: 8, height: 8, borderRadius: 999 }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ProjectStatus)}
        disabled={disabled}
        className={cn(
          "appearance-none rounded-md border border-border bg-surface py-1.5 pl-6 pr-7 text-[12px] font-semibold uppercase tracking-wide text-ink outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60",
          cur.chip
        )}
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted" />
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────

type ProjectsView = "hub" | "list" | "calendar" | "finances" | "maintenance";

const PROJECTS_VIEWS: ProjectsView[] = [
  "list",
  "calendar",
  "finances",
  "maintenance",
];

export function Projects() {
  // URL-driven (`?view=…`). The sidebar's Project Management group has
  // one entry per view, so the page itself doesn't render a tab strip
  // — view selection lives in the sidebar.
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [storedView, setStoredView] = useIdentityPreference<ProjectsView>(
    "projects:view",
    "list",
    enumPreference(PROJECTS_VIEWS),
  );
  // Finances sub-page is DIRECTOR-level only (Super Admin, Sales Director,
  // Finance Manager, owner). Backed by the finance-viewer flag on /auth/me;
  // ANDed with the existing projects.finances page-access below.
  const canProjectFinance = !!user?.project_finance_viewer;

  // Per-view access (mig 073 — sub-page split). Each top-level view
  // gates on its own `projects.<view>` access level. The PageGuard at
  // the route already filtered users with `projects = none`; this
  // narrower check decides which views are reachable.
  // Levels are AccessLevel (none/view/edit/full or legacy partial) — let TS
  // infer so position-matrix values (view/edit) are accepted, not just the old
  // role-matrix trio.
  const access = {
    list: usePageAccess("projects.list"),
    calendar: usePageAccess("projects.calendar"),
    finances: usePageAccess("projects.finances"),
    maintenance: usePageAccess("projects.maintenance"),
  };
  // Maintenance is a FULL-or-none page by its own catalogue contract
  // (`projects.maintenance` in pageAccess.ts: supportsPartial false,
  // partialMeaning "(not used; full or none)"), and Sidebar.tsx states the same
  // rule on the nav entry with `pageAccessFull`. The generic `!== "none"` test
  // below admits view/edit — levels this page does not support — and children
  // INHERIT the parent key when they have no explicit row, so every
  // `projects = view` user resolved to `maintenance = view`: no nav entry, yet
  // the hub card below still offered the page. Match the nav's level so the two
  // gates agree.
  const canProjectMaintenance = access.maintenance === "full";
  const allowed: ProjectsView[] = PROJECTS_VIEWS.filter(
    (v) =>
      access[v as keyof typeof access] !== "none" &&
      (v !== "finances" || canProjectFinance) &&
      (v !== "maintenance" || canProjectMaintenance)
  );
  const firstAllowed: ProjectsView | null = allowed[0] ?? null;

  const urlView = params.get("view") as ProjectsView | null;
  // Distinguish "explicitly requested" from "fell through to stored".
  // When the URL explicitly names a view the user can't access, we
  // show <Forbidden> so they see why — silent fallback to a different
  // view looked like "no response from the web". When there's no
  // explicit URL view, pick the first accessible one.
  const explicit: ProjectsView | null =
    urlView === "hub"
      ? "hub"
      : urlView && PROJECTS_VIEWS.includes(urlView)
        ? urlView
        : null;
  const fallback: ProjectsView | null = params.has("focus")
    ? allowed.includes("list")
      ? "list"
      : firstAllowed
    : allowed.includes(storedView)
      ? storedView
      : firstAllowed;
  const view: ProjectsView | null = explicit ?? fallback;
  const requestedDenied =
    explicit !== null && explicit !== "hub" && !allowed.includes(explicit);

  // Persist whatever view was rendered so a bare `/projects` lands
  // back where the user left off — but only if it was accessible.
  useEffect(() => {
    if (view && view !== "hub" && !requestedDenied && view !== storedView)
      setStoredView(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, requestedDenied]);

  if (requestedDenied) {
    return <Forbidden page={`projects.${explicit}`} />;
  }
  if (!view) {
    return <Forbidden page="projects" />;
  }

  if (view === "hub") {
    const hubCards = (
      [
        { key: "list", label: "Project List", description: "All projects — status, brand, dates, PIC, budget.", icon: ClipboardList, v: "list" },
        { key: "calendar", label: "Calendar", description: "Projects & tasks on a month timeline.", icon: Calendar, v: "calendar" },
        { key: "finances", label: "Finances", description: "Revenue, spend and margin across projects.", icon: DollarSign, v: "finances" },
        { key: "maintenance", label: "Project Maintenance", description: "Templates, checklists and defaults.", icon: Wrench, v: "maintenance" },
      ] as const
    ).filter(
      (c) =>
        access[c.v] !== "none" &&
        (c.v !== "finances" || canProjectFinance) &&
        (c.v !== "maintenance" || canProjectMaintenance)
    );
    return (
      <div>
        <PageHeader
          eyebrow="Operations · Projects"
          title="Projects"
          description="Pick a section — list, calendar, finances or maintenance."
        />
        <HubGrid
          cards={hubCards.map((c) => ({
            key: c.key,
            label: c.label,
            description: c.description,
            icon: c.icon,
            onClick: () => navigate(`/projects?view=${c.v}`),
          }))}
        />
      </div>
    );
  }

  return (
    <div>
      {view === "list" && <ProjectsListView />}
      {view === "calendar" && <ProjectsCalendarView />}
      {view === "finances" &&
        (canProjectFinance ? (
          <ProjectsFinancesView />
        ) : (
          <Forbidden page="projects.finances" />
        ))}
      {view === "maintenance" &&
        (canProjectMaintenance ? (
          <ProjectMaintenanceView />
        ) : (
          <Forbidden page="projects.maintenance" />
        ))}
    </div>
  );
}

const PROJECTS_LIST_FILTER_KEYS = [
  // `stage` filter retired — the team now tracks progress via tasklist
  // sections (Pre-event / Setup / Live / Teardown). The legacy stage
  // enum stays in the DB and detail view for the next-stage button.
  // Kept in the URL keys list so any old bookmark with ?stage=… still
  // parses without throwing.
  "stage",
  // `phase=setup|dismantle` — field/sales cohort's date-derived Setup/Dismantle
  // filter (the `stage` enum is unmaintained). See ProjectsListView.
  "phase",
  // `mine=all` — field/sales cohort's "My events" toggle OFF state (absent =
  // ON, so the slim bar defaults to their own events). See ProjectsListView.
  "mine",
  "section",
  // `task` — outstanding-task filter (owner 2026-08-05): show only events where
  // this checklist task is still not complete. Sticky like the rest.
  "task",
  "search",
  "brand",
  "year",
  "month",
  // `from` / `to` — the date-range filter that replaced the year+month
  // dropdowns (owner 2026-08-14). They were missed off this list when it
  // shipped, so the range was the ONE filter that did not survive opening a
  // project and coming back: `pluck()` mirrors only the keys named here.
  "from",
  "to",
  "status",
  "page",
] as const;

/** Generic multi-select filter (owner 2026-08-07: "add multiple choice for all
 *  dropdown also"). A native <select multiple> is unusable in a filter bar
 *  (ctrl-click, fixed height), so every project-list filter uses this button +
 *  checkbox popover instead. Closes on outside click / Escape. Options may be
 *  grouped (the task filter groups by checklist section); pass one group with a
 *  null name for a flat list. Selection is a string[] the caller comma-joins
 *  into the URL. */
// Date-range filter (owner 2026-08-11) — a From/To picker chip that replaces the
// old year + month dropdowns. Two native date inputs; the list scopes to events
// overlapping the window (start <= to AND end >= from).
function DateRangeFilter({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  /* Was a month-NAME array — the exact thing utils.ts says the owner ruled
     out ("no 'Jun'/'Jul' month names anywhere on the desktop app"). */
  const fmt = (d: string) => (d ? fmtDate(d) : "…");
  const active = !!(from || to);
  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 max-w-[240px] items-center gap-1.5 rounded-md border bg-surface px-2 text-[12px]",
          active ? "border-accent font-semibold text-accent" : "border-border text-ink",
        )}
      >
        <Calendar size={13} className="shrink-0 opacity-70" />
        <span className="truncate">{active ? `${fmt(from)} – ${fmt(to)}` : "All dates"}</span>
        <ChevronDown size={13} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-[250px] rounded-md border border-border bg-surface p-3 shadow-slab">
          <div className="mb-2 flex items-center justify-between border-b border-border-subtle pb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">Date range</span>
            {active && (
              <button type="button" onClick={() => onChange("", "")} className="text-[10.5px] font-semibold text-ink-secondary hover:text-err">
                Clear
              </button>
            )}
          </div>
          <label className="mb-2 block text-[11px] font-semibold text-ink-secondary">
            From
            <DateField
              fullWidth
              value={from}
              max={to || undefined}
              onChange={(iso) => onChange(iso, to)}
              className="mt-0.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
            />
          </label>
          <label className="block text-[11px] font-semibold text-ink-secondary">
            To
            <DateField
              fullWidth
              value={to}
              min={from || undefined}
              onChange={(iso) => onChange(from, iso)}
              className="mt-0.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px]"
            />
          </label>
        </div>
      )}
    </div>
  );
}

function MultiSelectFilter({
  placeholder,
  groups,
  selected,
  onChange,
  title,
  summary,
  panelWidth = "w-[280px]",
}: {
  placeholder: string;
  groups: { name: string | null; options: { value: string; label: string; count?: number }[] }[];
  selected: string[];
  onChange: (next: string[]) => void;
  title?: string;
  /** Label when >1 is ticked, e.g. "3 brands". Defaults to "n selected". */
  summary?: (n: number) => string;
  panelWidth?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const labelFor = (v: string) => {
    for (const g of groups) {
      const hit = g.options.find((o) => o.value === v);
      if (hit) return hit.label;
    }
    return v;
  };
  const label =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? labelFor(selected[0])
        : summary
          ? summary(selected.length)
          : `${selected.length} selected`;
  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title ?? placeholder}
        className={cn(
          "inline-flex h-8 max-w-[260px] items-center gap-1.5 rounded-md border bg-surface px-2 text-[12px]",
          selected.length ? "border-accent font-semibold text-accent" : "border-border text-ink",
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={13} className="shrink-0 opacity-70" />
      </button>
      {open && (
        <div
          className={cn(
            "absolute left-0 top-9 z-30 max-h-[420px] overflow-y-auto rounded-md border border-border bg-surface p-2 shadow-slab",
            panelWidth,
          )}
        >
          <div className="mb-1.5 flex items-center justify-between border-b border-border-subtle pb-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-muted">
              {placeholder}
            </span>
            {/* Untick-all is ALWAYS shown (owner 2026-08-11) so the affordance is
                visible even before anything is ticked — it just greys out and is
                disabled while the list is empty, then activates (with a count)
                once you tick something. */}
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={selected.length === 0}
              className={cn(
                "text-[10.5px] font-semibold",
                selected.length === 0
                  ? "cursor-default text-ink-muted/50"
                  : "text-ink-secondary hover:text-err",
              )}
            >
              {selected.length > 0 ? `Untick all (${selected.length})` : "Untick all"}
            </button>
          </div>
          {groups.map((g, gi) => (
            <div key={g.name ?? `g${gi}`} className="mb-1.5">
              {g.name && (
                <div className="px-1 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-ink-muted">
                  {g.name}
                </div>
              )}
              {g.options.map((o) => (
                <label
                  key={o.value}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12px] hover:bg-primary-soft/40"
                >
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={selected.includes(o.value)}
                    onChange={() => toggle(o.value)}
                  />
                  <span className="flex-1 truncate">{o.label}</span>
                  {typeof o.count === "number" && (
                    <span className="shrink-0 tabular-nums text-[11px] text-ink-muted">
                      {o.count}
                    </span>
                  )}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Per-project task badges for the Status (section) filter (owner 2026-08-14).
// Reads the backend section_tasks_map ("title=status=due" joined by "|") and
// renders one pill per task in the chosen section: DONE (green), OVERDUE (red,
// with days late) or PENDING (amber). Overdue first, then pending, then done.
// Renders nothing unless a real section is picked (the map is absent otherwise),
// so the default project list is unchanged.
function SectionTaskBadges({ map }: { map?: string | null }) {
  if (!map) return null;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const tasks = map
    .split("|")
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split("=");
      const title = parts[0] ?? "";
      const status = parts[1] ?? "";
      const due = parts[2] ?? "";
      let kind: "done" | "overdue" | "pending";
      let daysLate = 0;
      if (status === "done") kind = "done";
      else if (due && due < today) {
        kind = "overdue";
        daysLate = Math.max(1, Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000));
      } else kind = "pending";
      return { title, kind, daysLate };
    });
  if (!tasks.length) return null;
  const rank = { overdue: 0, pending: 1, done: 2 } as const;
  tasks.sort((a, b) => rank[a.kind] - rank[b.kind] || b.daysLate - a.daysLate);
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tasks.map((t, i) => (
        <span
          key={i}
          title={t.title}
          className={cn(
            "inline-flex max-w-[170px] items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold",
            t.kind === "done"
              ? "border border-synced/40 bg-synced/15 text-synced"
              : t.kind === "overdue"
                ? "border border-err/40 bg-err/15 text-err"
                : "border border-amber-500 bg-amber-100 text-amber-800",
          )}
        >
          <span className="truncate">{t.title}</span>
          {t.kind === "overdue" && <span className="shrink-0 font-mono">{t.daysLate}d</span>}
        </span>
      ))}
    </div>
  );
}

function ProjectsListView() {
  const { can, user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { unreadByProject } = useNotifications();
  const [params, setParams] = useStickyFilters(
    "projects-list",
    PROJECTS_LIST_FILTER_KEYS
  );
  const search = params.get("search") || "";
  const brand = params.get("brand") || "";
  const year = params.get("year") || "";
  const month = params.get("month") || "";
  const section = params.get("section") || "";
  const taskPending = params.get("task") || "";
  // Multi-select (owner 2026-08-07): EVERY filter param is a comma-joined list
  // now. csvParam keeps the URL⇄checkbox mapping in one place; a single value
  // still round-trips unchanged, so old bookmarks keep working.
  const csvParam = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const taskPendingList = useMemo(() => csvParam(taskPending), [taskPending]);
  const status = params.get("status") || "";
  // Date-range filter (owner 2026-08-11) — replaces the year/month dropdowns.
  // from/to are ISO YYYY-MM-DD; the list scopes to events overlapping the window.
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  // Ticked values per filter (owner 2026-08-07 multi-select). The raw comma
  // strings above are what go on the wire; these arrays drive the checkboxes.
  const sectionList = useMemo(() => csvParam(section), [section]);
  const brandList = useMemo(() => csvParam(brand), [brand]);
  const yearList = useMemo(() => csvParam(year), [year]);
  const monthList = useMemo(() => csvParam(month), [month]);
  const statusList = useMemo(() => csvParam(status), [status]);
  // Cohort "Setup"/"Dismantle" pick a date-derived event PHASE (not the stale
  // `stage` enum) — see the field/sales slim bar below + backend f.phase.
  const phase = params.get("phase") || "";
  const page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "" || (k === "page" && v === "1")) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }
  const setSearch = (v: string) => patchParams({ search: v, page: "1" });
  const setBrand = (v: string) => patchParams({ brand: v, page: "1" });
  const setYear = (v: string) => patchParams({ year: v, page: "1" });
  const setMonth = (v: string) => patchParams({ month: v, page: "1" });
  const setSection = (v: string) => patchParams({ section: v, page: "1" });
  const setTaskPending = (v: string) => patchParams({ task: v, page: "1" });
  const setStatus = (v: string) => patchParams({ status: v, page: "1" });
  const setDateRange = (f: string, t: string) => patchParams({ from: f, to: t, page: "1" });
  const setPhase = (v: string) => patchParams({ phase: v, page: "1" });
  const setPage = (n: number) => patchParams({ page: String(n) });

  const [perPage, setPerPage] = useIdentityPreference("pp:projects", 50, pageSizePreference([10, 25, 50, 100, 200]));
  // List render mode — cards (P2 design) vs the full data table. Default cards.
  const [listMode, setListMode] = useIdentityPreference("projects:listMode", "cards", enumPreference(["cards", "table"] as const));
  const [showCreate, setShowCreate] = useState(false);
  // Deep-link: the global "+" quick-action FAB opens the New Project modal via
  // /projects?new=1. Consume the flag once and strip it so refresh/back don't reopen.
  useEffect(() => {
    if (params.get("new") === "1") {
      // Only BD / owner / weisiang may open the create modal (owner 2026-07-24);
      // strip the flag either way so it doesn't linger on the URL.
      if (canCreateEvent(user)) setShowCreate(true);
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
    }
  }, [params, setParams, user]);
  const [showImport, setShowImport] = useState(false);
  const [showArchived, setShowArchived] = useIdentityPreference("projects:showArchived", false, booleanPreference);
  // Hide projects whose every tasklist section is complete — same
  // predicate as the section=__done filter, just inverted. Disabled
  // automatically when the user picks the Completed pill so the
  // controls don't fight each other.
  const [hideCompleted, setHideCompleted] = useIdentityPreference("projects:hideCompleted", false, booleanPreference);
  // "My pending tasks" -- when on, the list shows only projects that have
  // a pending checklist item belonging to the caller's role (mapped to a
  // chip label / document title server-side). Export is unaffected.
  const [myPending, setMyPending] = useIdentityPreference("projects:myPending", false, booleanPreference);

  // Owner 2026-07-21: field/sales roles (Sales Exec/Mgr except Sales Director,
  // plus Driver/Helper/Storekeeper) get the SAME slimmed filter bar as mobile —
  // only "My events", "Setup", "Dismantle" (no section pills / brand-year-month
  // -status dropdowns / My-pending / Hide-completed). Mirrors the cohort logic
  // in MobilePMS ProjectListView so pc + phone stay in lockstep.
  const _pos = (user?.position_name ?? "").trim();
  const _dept = (user?.department_name ?? "").trim();
  const _isDirector =
    !!user?.permissions?.includes("*") ||
    /\b(super admin|sales director|finance manager)\b/i.test(_pos);
  const _isDriver = /\bdriver\b/i.test(_pos);
  // Helpers/storekeepers are FORCE-scoped server-side, drivers are not (they opt
  // in). The predicate — and why it moved here — is in auth/crewScope.ts.
  const _isCrew = _isDriver || isCrewScopedUser(user);
  const _isSalesExec = (/sales/i.test(_dept) || /^sales/i.test(_pos)) && !_isDirector;
  const restrictedCohort = _isCrew || _isSalesExec;
  const cohortTickOnly = can("projects.checklist.tick") && !can("projects.write");
  // "My events" is a REAL toggle only for drivers (server doesn't force their
  // scope and their assigned_to_me arm actually filters). Helpers/storekeepers
  // are force-scoped and sales are row-scoped server-side, so for them the
  // button is cosmetic (always on) — sending assigned_to_me for a sales user
  // would filter to crew arms and wrongly return zero rows. OFF state is
  // encoded as ?mine=all (absent = default on).
  const canToggleMyEvents = _isDriver && cohortTickOnly;
  const crewSeeAll = params.get("mine") === "all";
  const myEventsActive = restrictedCohort && (canToggleMyEvents ? !crewSeeAll : true);
  const sendAssignedToMe = canToggleMyEvents && !crewSeeAll;
  // Pill styling copied from <FilterPills/> so the cohort bar reads identically.
  const cohortPillCls = (active: boolean) =>
    "whitespace-nowrap rounded px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-all duration-150 " +
    (active ? "bg-primary text-white shadow-sm" : "text-ink-secondary hover:bg-primary-soft hover:text-primary");

  // ?focus=ID — Overview inbox deep-links straight to the detail page.
  useFocusFromUrl((id) => navigate(`/projects/${id}`, { replace: true }));

  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));

  // Skip exclude_done when the user explicitly picked the Completed
  // section pill — otherwise the page would show zero rows.
  const excludeDoneParam =
    hideCompleted && !sectionList.includes("__done") ? 1 : undefined;

  const list = useQuery<Paginated<ProjectRow>>("/api/projects:",
    (signal) =>
      api.get(
        `/api/projects${buildQuery({
          // Cohort uses ONLY stage + assigned_to_me + search; the section /
          // brand / year / month / status / my_pending filters are hidden from
          // them, so force those undefined to keep their list unfiltered.
          brand: restrictedCohort ? undefined : brand || undefined,
          year: restrictedCohort ? undefined : year || undefined,
          month: restrictedCohort ? undefined : month || undefined,
          from: restrictedCohort ? undefined : from || undefined,
          to: restrictedCohort ? undefined : to || undefined,
          section: restrictedCohort ? undefined : section || undefined,
          task_pending: restrictedCohort ? undefined : taskPending || undefined,
          phase: restrictedCohort && phase ? phase : undefined,
          assigned_to_me: sendAssignedToMe ? 1 : undefined,
          exclude_done: restrictedCohort ? undefined : excludeDoneParam,
          my_pending: restrictedCohort ? undefined : myPending ? 1 : undefined,
          search,
          // Status is filtered SERVER-side (the list endpoint's `status`
          // param), so the list stays paginated (per_page=perPage) even while
          // a status pill is active — no more fetch-all page-1 workaround.
          status: restrictedCohort ? undefined : status || undefined,
          page,
          per_page: perPage,
          include_archived: showArchived ? 1 : undefined,
          ...sortParams,
        })}`,
        { signal },
      ),
    [brand, year, month, from, to, section, taskPending, status, phase, restrictedCohort, sendAssignedToMe, excludeDoneParam, myPending, search, page, perPage, showArchived, sort?.key, sort?.dir],
    // Paginated + filter-switched list: keep the current rows on screen while
    // the next page/filter loads instead of flashing an empty table.
    { keepPreviousData: true }
  );
  const searchTransition = useSearchResultTransition({
    inputTerm: search,
    requestTerm: search,
    isFetching: list.fetching,
    isPlaceholderData: list.placeholder,
    hasData: list.data !== null,
    hasError: Boolean(list.error),
  });

  // Status (Confirmed / Pending / Cancelled) is now filtered server-side via
  // the list endpoint's `status` param, so the rows the endpoint returns are
  // already the matching, paginated set — no client-side filtering needed.
  const rows = list.data?.data ?? null;
  // Non-null view of rows for the card list + right rail (rows itself stays
  // nullable for the DataTable's loading state).
  const cardRows = searchTransition.resultsAreStale ? [] : rows ?? [];

  // Export = the FULL filtered project list (ALL pages), IGNORING the "My
  // pending tasks" toggle — that's a screen-only view (owner 2026-07-20). Loops
  // pages via `total` so neither pagination nor a server per_page cap truncates
  // the file, and drops my_pending so a filtered export isn't limited to
  // pending-task rows.
  const [exporting, setExporting] = useState(false);
  const exportProjects = async () => {
    setExporting(true);
    try {
      const all: ProjectRow[] = [];
      const per = 200;
      for (let pg = 1; pg <= 500; pg++) {
        const res = await api.get<Paginated<ProjectRow>>(
          `/api/projects${buildQuery({
            // Mirror the on-screen filter set, incl. the cohort's slim bar
            // (stage + assigned_to_me), so the export matches what they see.
            brand: restrictedCohort ? undefined : brand || undefined,
            year: restrictedCohort ? undefined : year || undefined,
            month: restrictedCohort ? undefined : month || undefined,
            from: restrictedCohort ? undefined : from || undefined,
            to: restrictedCohort ? undefined : to || undefined,
            section: restrictedCohort ? undefined : section || undefined,
            task_pending: restrictedCohort ? undefined : taskPending || undefined,
            phase: restrictedCohort && phase ? phase : undefined,
            assigned_to_me: sendAssignedToMe ? 1 : undefined,
            exclude_done: restrictedCohort ? undefined : excludeDoneParam,
            // my_pending is sent, like every other chip. It used to be omitted
            // "because export is the full filtered list", which made EXPORT
            // disagree with the screen: owner 2026-09-02 filtered Setup &
            // Dismantle + My pending tasks down to 10 rows, exported, and got
            // every confirmed event instead. The rule is now simply: the export
            // is what the toolbar says, and an unfiltered toolbar still exports
            // everything.
            my_pending: restrictedCohort ? undefined : myPending ? 1 : undefined,
            search,
            status: restrictedCohort ? undefined : status || undefined,
            page: pg,
            per_page: per,
            include_archived: showArchived ? 1 : undefined,
            ...sortParams,
          })}`
        );
        const batch = res.data ?? [];
        all.push(...batch);
        if (batch.length === 0 || all.length >= (res.total ?? all.length)) break;
      }
      // Owner 2026-08-12: cluster same-event rows (same venue + start date)
      // together so an event's different-brand projects sit side by side in the
      // export instead of being scattered by the brand/date sort. Overall order
      // is preserved — each event stays where its FIRST row appeared, and its
      // other brands are pulled up next to it (stable within the event).
      {
        const eventKey = (r: ProjectRow) =>
          `${(r.venue ?? "").trim().toUpperCase()}||${r.start_date ?? ""}`;
        const origIdx = new Map<ProjectRow, number>();
        all.forEach((r, i) => origIdx.set(r, i));
        const firstSeen = new Map<string, number>();
        for (const r of all) {
          const k = eventKey(r);
          if (!firstSeen.has(k)) firstSeen.set(k, origIdx.get(r)!);
        }
        all.sort((a, b) => {
          const fa = firstSeen.get(eventKey(a))!;
          const fb = firstSeen.get(eventKey(b))!;
          if (fa !== fb) return fa - fb;
          return origIdx.get(a)! - origIdx.get(b)!;
        });
      }
      const csvCols = columns
        .filter((c) => typeof c.getValue === "function")
        .map((c) => ({ key: c.key, label: c.label || c.key, getValue: c.getValue! }));
      // Owner 2026-07-23: add an Organizer column to the EXPORT only (not the
      // on-screen table), placed right after Brand.
      const orgCol = { key: "organizer", label: "Organizer", getValue: (r: ProjectRow) => exportOrganizer(r.organizer) };
      const brandIdx = csvCols.findIndex((c) => c.label === "Brand");
      if (brandIdx >= 0) csvCols.splice(brandIdx + 1, 0, orgCol);
      else csvCols.push(orgCol);
      // Outstanding-task columns (owner 2026-08-05; multi 2026-08-07: "once
      // export will export what already tick only"). ONE column per TICKED
      // task — nothing else is added — so the sheet shows exactly the ticked
      // tasks and Excel can be filtered per column. Values come from the
      // row's task_pending_map ("title=status" pairs joined by "|").
      if (taskPendingList.length) {
        const statusOf = (r: ProjectRow, title: string): string => {
          const map = String((r as any).task_pending_map ?? "");
          for (const pair of map.split("|")) {
            const i = pair.lastIndexOf("=");
            if (i > 0 && pair.slice(0, i) === title) return pair.slice(i + 1);
          }
          return "not on this event";
        };
        for (const title of taskPendingList) {
          csvCols.push({
            key: `task:${title}`,
            label: title,
            getValue: (r: ProjectRow) => statusOf(r, title),
          });
        }
      }
      if (!csvCols.length || all.length === 0) {
        toast.error(all.length === 0 ? "No projects match the current filter." : "Nothing to export.");
        return;
      }
      const date = new Date().toISOString().slice(0, 10);
      downloadCSV(`projects-${date}.csv`, toCSV(all, csvCols));
    } catch (e: any) {
      toast.error(e?.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const summary = useQuery<{
    by_stage: { stage: string; count: number }[];
    upcoming_30d: number;
    live_count: number;
    overdue_tasks: number;
  }>("/api/projects/summary", () => api.get("/api/projects/summary"));
  // A failed or not-yet-loaded summary read must NOT render "0" — a zero is a
  // claim the data doesn't support. Mirror Overview: unknown read → an em dash.
  const summaryUnknown = !!summary.error || !summary.data;

  const brands = useQuery<{ data: string[] }>("/api/projects/brands", () => api.get("/api/projects/brands"));
  const eventTypes = useQuery<{ data: EventType[] }>("/api/projects/event-types", () =>
    api.get("/api/projects/event-types")
  );
  // Distinct active section names — drives the Section filter dropdown.
  // Empty until any project has tasklist sections defined.
  const sectionsList = useQuery<{ data: string[] }>("/api/projects/sections-distinct", () =>
    api.get("/api/projects/sections-distinct")
  );
  // Canonical task titles (+ their section) for the outstanding-task filter.
  const taskTitles = useQuery<{ data: { title: string; section: string | null }[] }>(
    "/api/projects/task-titles-distinct",
    () => api.get("/api/projects/task-titles-distinct"),
  );
  // Task COUNT per checklist section — shown beside each section in the Status
  // filter (owner 2026-08-14: "section titles only with task counts").
  const sectionCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of taskTitles.data?.data ?? []) {
      const s = t.section ?? "Other";
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [taskTitles.data]);

  const columns: Column<ProjectRow>[] = [
    {
      // Hidden by default — the team identifies projects by name, not the
      // long hyphenated code. Still in the column chooser for the rare
      // admin who needs to grep, and still exported in CSV via getValue.
      key: "code",
      label: "Code",
      defaultHidden: true,
      render: (r) => <span className="font-mono text-xs font-medium">{r.code}</span>,
      getValue: (r) => r.code,
    },
    {
      key: "name",
      label: "Project",
      alwaysVisible: true,
      render: (r) => {
        const unread = unreadByProject[r.id] ?? 0;
        return (
          <div className="flex flex-col">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold">
              {unread > 0 && (
                <span
                  title={`${unread} new ${unread === 1 ? "update" : "updates"}`}
                  className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-err px-1 font-mono text-[9px] font-bold text-white"
                >
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
              {r.name}
              {r.archived_at && (
                <span className="inline-flex items-center rounded-full border border-ink-muted/40 bg-ink-muted/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-ink-muted">
                  Archived
                </span>
              )}
            </span>
            {r.venue && <span className="text-[10px] text-ink-muted">{r.venue}</span>}
            <SectionTaskBadges map={r.section_tasks_map} />
          </div>
        );
      },
      getValue: (r) => r.name,
    },
    {
      key: "stage",
      label: "Stage",
      // Stage = the project's current template section (mig 050). The
      // pill matches the visual language of the filter pill row above
      // the table + StageProgressRow on the detail page. The legacy
      // draft / setup / dismantle / completed enum is retired here.
      render: (r) => {
        const total = r.sections_total ?? 0;
        const active = r.active_section_name ?? null;
        const allDone = total > 0 && active == null;
        if (allDone) {
          return (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-synced bg-synced/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-synced"
              title={`${total}/${total} sections complete`}
            >
              <CheckCircle2 size={10} /> Complete
            </span>
          );
        }
        if (active) {
          return (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent"
              title={`Current stage · ${r.sections_complete ?? 0}/${total} sections complete`}
            >
              <Circle size={9} /> {active}
              <span className="font-mono text-[9px] opacity-70">
                {r.sections_complete ?? 0}/{total}
              </span>
            </span>
          );
        }
        return (
          <span
            className="inline-flex items-center rounded-full border border-dashed border-border bg-bg/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
            title="This project has no tasklist sections yet"
          >
            No sections
          </span>
        );
      },
      getValue: (r) => r.active_section_name ?? "",
    },
    {
      key: "progress_pct",
      label: "Progress",
      align: "right",
      render: (r) => <ProgressBar pct={r.progress_pct ?? 0} />,
      getValue: (r) => r.progress_pct,
    },
    {
      key: "brand",
      label: "Brand",
      render: (r) => <span className="text-[11px]">{r.brand || "—"}</span>,
      getValue: (r) => r.brand,
    },
    {
      key: "state",
      label: "State",
      render: (r) => <span className="text-[11px]">{r.state || "—"}</span>,
      getValue: (r) => r.state ?? "",
    },
    {
      key: "event_type_name",
      label: "Type",
      render: (r) => <span className="text-[11px]">{r.event_type_name || "—"}</span>,
      getValue: (r) => r.event_type_name,
    },
    {
      key: "pic_name",
      label: "PIC",
      // Falls back to the creator when no PIC is assigned — matches the
      // scope rules (COALESCE(pic_id, created_by)) used by the ACL.
      render: (r) => (
        <span className="text-[11px]">
          {r.pic_name || (
            <span className="text-ink-muted">{r.created_by_name ?? "—"}</span>
          )}
        </span>
      ),
      getValue: (r) => r.pic_name ?? r.created_by_name ?? "",
    },
    {
      key: "created_by_name",
      label: "Created By",
      render: (r) => <span className="text-[11px]">{r.created_by_name || "—"}</span>,
      getValue: (r) => r.created_by_name ?? "",
    },
    {
      key: "start_date",
      label: "Start",
      render: (r) => formatDate(r.start_date),
      getValue: (r) => r.start_date,
    },
    {
      key: "end_date",
      label: "End",
      render: (r) => formatDate(r.end_date),
      getValue: (r) => r.end_date,
    },
    {
      key: "booth_no",
      label: "Booth",
      render: (r) => <span className="font-mono text-[11px]">{r.booth_no || "—"}</span>,
      getValue: (r) => r.booth_no,
    },
    {
      key: "size_sqm",
      label: "Size (sqm)",
      align: "right",
      render: (r) => (r.size_sqm != null ? `${r.size_sqm} sqm` : "—"),
      getValue: (r) => r.size_sqm,
    },
    {
      key: "rental",
      label: "Rental (RM)",
      align: "right",
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.rental != null ? formatCurrency(r.rental, { compact: true }) : "—"}
        </span>
      ),
      getValue: (r) => r.rental,
    },
    {
      key: "total_sales",
      label: "Sales (RM)",
      align: "right",
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.total_sales != null ? formatCurrency(r.total_sales, { compact: true }) : "—"}
        </span>
      ),
      getValue: (r) => r.total_sales,
    },
    // ── Ledger-derived finance columns (opt-in via the column chooser) ──
    // Computed per project from project_finance_lines by the list endpoint
    // (SUM(amount) per category, single grouped join — no N+1). Amounts are
    // whole RM integers. GP / NP / percent are derived here from the raw
    // sums so the list matches the Finance tab (/finance/by-project). All
    // defaultHidden so the default view is unchanged; null = finance-hidden.
    {
      key: "revenue",
      label: "Revenue (RM)",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.fin_revenue != null ? formatCurrency(r.fin_revenue, { compact: true }) : "—"}
        </span>
      ),
      getValue: (r) => r.fin_revenue ?? null,
    },
    {
      key: "cogs",
      label: "COGS (RM)",
      align: "right",
      defaultHidden: true,
      render: (r) =>
        r.fin_cogs != null ? (
          <span
            className="font-mono text-[11px]"
            title={
              `Matt / sofa: ${formatCurrency(r.fin_cogs_matt_sofa ?? 0)}\n` +
              `Bedframe: ${formatCurrency(r.fin_cogs_bedframe ?? 0)}\n` +
              `Accessories: ${formatCurrency(r.fin_cogs_accessories ?? 0)}`
            }
          >
            {formatCurrency(r.fin_cogs, { compact: true })}
          </span>
        ) : (
          <span className="font-mono text-[11px]">—</span>
        ),
      getValue: (r) => r.fin_cogs ?? null,
    },
    {
      key: "cogs_matt_sofa",
      label: "COGS Matt/Sofa (RM)",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.fin_cogs_matt_sofa != null ? formatCurrency(r.fin_cogs_matt_sofa, { compact: true }) : "—"}
        </span>
      ),
      getValue: (r) => r.fin_cogs_matt_sofa ?? null,
    },
    {
      key: "cogs_bedframe",
      label: "COGS Bedframe (RM)",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.fin_cogs_bedframe != null ? formatCurrency(r.fin_cogs_bedframe, { compact: true }) : "—"}
        </span>
      ),
      getValue: (r) => r.fin_cogs_bedframe ?? null,
    },
    {
      key: "cogs_accessories",
      label: "COGS Accessories (RM)",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.fin_cogs_accessories != null ? formatCurrency(r.fin_cogs_accessories, { compact: true }) : "—"}
        </span>
      ),
      getValue: (r) => r.fin_cogs_accessories ?? null,
    },
    {
      key: "gp",
      label: "GP (RM)",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.fin_revenue != null && r.fin_cogs != null
            ? formatCurrency(r.fin_revenue - r.fin_cogs, { compact: true })
            : "—"}
        </span>
      ),
      getValue: (r) =>
        r.fin_revenue != null && r.fin_cogs != null ? r.fin_revenue - r.fin_cogs : null,
    },
    {
      key: "gp_pct",
      label: "GP %",
      align: "right",
      defaultHidden: true,
      render: (r) => {
        // Guard divide-by-zero: no revenue means GP% is undefined, not 0.
        if (r.fin_revenue == null || r.fin_cogs == null || r.fin_revenue <= 0) {
          return <span className="font-mono text-[11px]">—</span>;
        }
        const pct = ((r.fin_revenue - r.fin_cogs) / r.fin_revenue) * 100;
        return <span className="font-mono text-[11px]">{pct.toFixed(1)}%</span>;
      },
      getValue: (r) =>
        r.fin_revenue != null && r.fin_cogs != null && r.fin_revenue > 0
          ? ((r.fin_revenue - r.fin_cogs) / r.fin_revenue) * 100
          : null,
    },
    {
      key: "np",
      label: "NP (RM)",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.fin_revenue != null && r.fin_total_cost != null
            ? formatCurrency(r.fin_revenue - r.fin_total_cost, { compact: true })
            : "—"}
        </span>
      ),
      getValue: (r) =>
        r.fin_revenue != null && r.fin_total_cost != null
          ? r.fin_revenue - r.fin_total_cost
          : null,
    },
    {
      key: "margin_pct",
      label: "Margin %",
      align: "right",
      defaultHidden: true,
      render: (r) => {
        // NP / Revenue. Same divide-by-zero guard as GP%.
        if (r.fin_revenue == null || r.fin_total_cost == null || r.fin_revenue <= 0) {
          return <span className="font-mono text-[11px]">—</span>;
        }
        const pct = ((r.fin_revenue - r.fin_total_cost) / r.fin_revenue) * 100;
        return <span className="font-mono text-[11px]">{pct.toFixed(1)}%</span>;
      },
      getValue: (r) =>
        r.fin_revenue != null && r.fin_total_cost != null && r.fin_revenue > 0
          ? ((r.fin_revenue - r.fin_total_cost) / r.fin_revenue) * 100
          : null,
    },
    {
      key: "venue_size",
      label: "Venue size",
      align: "right",
      defaultHidden: true,
      // Depends on feat/pms-venue-size-field exposing `size` on the venue /
      // project payload. Renders "—" until that lands.
      render: (r) => (
        <span className="text-[11px]">
          {r.venue_size != null ? `${r.venue_size} sqm` : "—"}
        </span>
      ),
      getValue: (r) => r.venue_size ?? null,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Projects"
        title="Project List"
        description="Exhibitions and solo events — lifecycle, checklist, logistics, finance"
        secondaryActions={
          can("projects.manage")
            ? [
                {
                  icon: UploadIcon,
                  label: "Import CSV",
                  onClick: () => setShowImport(true),
                },
              ]
            : undefined
        }
        primaryAction={
          canCreateEvent(user) ? (
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
              New Project
            </Button>
          ) : undefined
        }
      />

      <DashboardGrid cols={3}>
        <StatCard
          label="Live Now"
          value={summaryUnknown ? "—" : String(summary.data!.live_count)}
          subtitle="Events currently running"
          tone={!summaryUnknown && summary.data!.live_count > 0 ? "success" : "default"}
        />
        <StatCard
          label="Upcoming (30d)"
          value={summaryUnknown ? "—" : String(summary.data!.upcoming_30d)}
          subtitle="Starting within the next month"
        />
        <StatCard
          label="Overdue Tasks"
          value={summaryUnknown ? "—" : String(summary.data!.overdue_tasks)}
          subtitle="Checklist items past due"
          tone={!summaryUnknown && summary.data!.overdue_tasks > 0 ? "error" : "default"}
        />
      </DashboardGrid>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {restrictedCohort ? (
          /* Owner 2026-07-21: field/sales cohort gets the mobile-style slim bar
             — only My events / Setup / Dismantle. Styled to match FilterPills. */
          <div className="inline-block max-w-full overflow-hidden rounded-md border border-border bg-surface shadow-stone align-middle">
            <div className="no-scrollbar flex items-center gap-0.5 overflow-x-auto p-1 [&>*]:shrink-0">
              <button
                type="button"
                onClick={() => {
                  if (canToggleMyEvents) patchParams({ mine: crewSeeAll ? "" : "all", page: "1" });
                }}
                title={canToggleMyEvents ? "Show only events you're assigned to" : "You see your own events"}
                className={cohortPillCls(myEventsActive)}
                style={canToggleMyEvents ? undefined : { cursor: "default" }}
              >
                My events
              </button>
              <button
                type="button"
                onClick={() => setPhase(phase === "setup" ? "" : "setup")}
                className={cohortPillCls(phase === "setup")}
              >
                Setup
              </button>
              <button
                type="button"
                onClick={() => setPhase(phase === "dismantle" ? "" : "dismantle")}
                className={cohortPillCls(phase === "dismantle")}
              >
                Dismantle
              </button>
            </div>
          </div>
        ) : (
        <>
        {/* Task filter — the tasklist-section dropdown; each option carries how
            many tasks that section holds. Labelled "Status" on 2026-08-14, then
            "Task" on 2026-08-19 (owner: "the left one change word status to
            task") because the real project-status chip sits two along and two
            chips reading "status" was the confusion this rename removes. */}
        <MultiSelectFilter
          placeholder="Task"
          title="Filter by tasklist section"
          summary={(n) => `${n} sections`}
          selected={sectionList}
          onChange={(next) => setSection(next.join(","))}
          groups={[
            {
              name: null,
              options: [
                ...(sectionsList.data?.data ?? []).map((s) => ({
                  value: s,
                  label: s,
                  count: sectionCounts[s],
                })),
                { value: "__done", label: "Completed" },
              ],
            },
          ]}
        />
        {/* Outstanding-TASK filter — hidden 2026-07-20 (owner: "REMOVE DROPDOWN
            STATUS BUTTON"). The label 'Status' was misleading — the dropdown
            actually filtered by tasks-not-yet-completed, so the owner saw two
            'status' controls on the toolbar (this + the real "All statuses"
            one right below) and asked to drop this. Kept the setTaskPending
            state wiring untouched so a link with ?task_pending=... still works
            and a future re-introduction under a clearer label is one line away. */}
        <MultiSelectFilter
          placeholder="All brands"
          summary={(n) => `${n} brands`}
          selected={brandList}
          onChange={(next) => setBrand(next.join(","))}
          groups={[
            { name: null, options: (brands.data?.data ?? []).map((b) => ({ value: b, label: b })) },
          ]}
        />
        <DateRangeFilter from={from} to={to} onChange={setDateRange} />
        <MultiSelectFilter
          placeholder="All statuses"
          title="Filter by project status"
          summary={(n) => `${n} statuses`}
          panelWidth="w-[200px]"
          selected={statusList}
          onChange={(next) => setStatus(next.join(","))}
          groups={[
            { name: null, options: STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label })) },
          ]}
        />
        {/* Clear-all (owner 2026-08-10): one click unticks EVERY filter dropdown
            — section, status/tasks, brand, year, month, project status. Each
            dropdown keeps its own in-panel "Clear (n)"; this resets them all
            together so the owner doesn't have to open each one. Shown only when
            at least one dropdown is active. Search + My-pending are left alone. */}
        {(section || taskPending || brand || from || to || status) && (
          <button
            type="button"
            onClick={() =>
              patchParams({
                section: "",
                task: "",
                brand: "",
                year: "",
                month: "",
                from: "",
                to: "",
                status: "",
                page: "1",
              })
            }
            title="Clear every filter"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[12px] font-semibold text-ink-secondary hover:border-err hover:text-err"
          >
            <X size={13} />
            Clear all
          </button>
        )}
        <label
          className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold text-ink-secondary"
          title="Show only projects with a task pending on your side (your role)"
        >
          <input
            type="checkbox"
            checked={myPending}
            onChange={(e) => {
              setPage(1);
              setMyPending(e.target.checked);
            }}
            className="accent-accent"
          />
          My pending tasks
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <input
            type="checkbox"
            checked={!!hideCompleted}
            onChange={(e) => {
              setPage(1);
              setHideCompleted(e.target.checked);
            }}
            className="accent-accent"
            disabled={sectionList.includes("__done")}
            title={sectionList.includes("__done") ? "Disabled while the Completed section filter is ticked" : undefined}
          />
          Hide completed
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => {
              setPage(1);
              setShowArchived(e.target.checked);
            }}
            className="accent-accent"
          />
          Show archived
        </label>
        </>
        )}
      </div>

      {/* View toggle — cards (P2 design) vs the full data table. */}
      <div className="mb-3 flex items-center justify-end gap-2">
        {/* Export is part of the Table toolbar; add it here so Cards view can
            export too (same filtered rows + columns as the table). */}
        {listMode === "cards" && (
          <button
            onClick={() => void exportProjects()}
            disabled={exporting}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent disabled:opacity-40"
            title="Download CSV of all projects matching the current filter (ignores 'My pending tasks')"
          >
            <Download size={13} /> {exporting ? "Exporting…" : "Export"}
          </button>
        )}
        <div className="inline-flex overflow-hidden rounded-md border border-border bg-surface text-[11px] font-semibold">
          <button
            onClick={() => setListMode("cards")}
            className={cn("px-3 py-1.5 transition-colors", listMode === "cards" ? "bg-primary text-white" : "text-ink-secondary hover:bg-surface-dim")}
          >
            Cards
          </button>
          <button
            onClick={() => setListMode("table")}
            className={cn("px-3 py-1.5 transition-colors", listMode === "table" ? "bg-primary text-white" : "text-ink-secondary hover:bg-surface-dim")}
          >
            Table
          </button>
        </div>
      </div>

      <div className={cn(listMode === "cards" && "grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]")}>
      <div className="min-w-0">
      {listMode === "cards" ? (
        list.error ? (
          <ListErrorPanel message={list.error} />
        ) : (list.loading && !list.data) || searchTransition.isSearching ? (
          <SearchPendingPanel label={searchTransition.statusText} />
        ) : cardRows.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-8 text-center text-[12px] text-ink-muted shadow-stone">
            No projects yet
          </div>
        ) : (
          <div className="space-y-2.5">
            {cardRows.map((r) => {
              const total = r.sections_total ?? 0;
              const active = r.active_section_name ?? null;
              const done = total > 0 && active == null;
              const rail = done ? "bg-synced" : active ? "bg-accent" : "bg-border-strong";
              const meta = [
                r.brand,
                r.start_date ? `${formatDate(r.start_date)}–${formatDate(r.end_date)}` : null,
                r.pic_name ? `PIC ${r.pic_name}` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <button
                  key={r.id}
                  onClick={() => navigate(`/projects/${r.id}`)}
                  className={cn(
                    "group relative flex w-full items-center gap-4 overflow-hidden rounded-xl border border-border bg-surface p-4 pl-5 text-left shadow-stone transition-all hover:-translate-y-px hover:border-primary hover:shadow-slab",
                    r.archived_at && "opacity-60",
                  )}
                >
                  <span className={cn("absolute left-0 top-0 h-full w-[3px]", rail)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] font-bold text-accent">{r.code}</span>
                      {/* My Pending mode tags the card with the CALLER's own
                          pending work (owner 2026-07-22, Syu report) — the
                          project's section chip reads as someone else's stage
                          (e.g. CONTRACT for a logistic caller) so it yields
                          when the row carries my_pending_titles. */}
                      {myPending && (r as any).my_pending_titles ? (
                        String((r as any).my_pending_titles).split("|").map((t: string) => (
                          <span
                            key={t}
                            className="inline-flex items-center gap-1 rounded-full border border-warning-text/30 bg-warning-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning-text"
                          >
                            <Circle size={9} /> {t}
                          </span>
                        ))
                      ) : done ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-synced bg-synced/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-synced">
                          <CheckCircle2 size={10} /> Complete
                        </span>
                      ) : active ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary-soft px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                          <Circle size={9} /> {active}
                          <span className="font-mono text-[9px] opacity-70">{r.sections_complete ?? 0}/{total}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                          No sections
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-display text-[15px] font-bold text-ink group-hover:text-primary">
                      {r.name}
                    </div>
                    {meta && <div className="mt-0.5 truncate text-[11.5px] text-ink-muted">{meta}</div>}
                    {/* Crew cards outside My Pending mode: the caller's own due
                        pending tasks below the meta line (my_pending_titles is
                        attached server-side; promoted to the tag row above when
                        the My Pending filter is on). */}
                    {!myPending && !!(r as any).my_pending_titles && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {String((r as any).my_pending_titles).split("|").map((t: string) => (
                          <span
                            key={t}
                            className="inline-flex items-center rounded-full border border-warning-text/30 bg-warning-bg px-2 py-0.5 text-[10px] font-semibold text-warning-text"
                          >
                            ⏳ {t}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-2">
                      <ProgressBar pct={r.progress_pct ?? 0} />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )
      ) : (
        <DataTable
          tableId="projects"
          exportName="projects"
          onExport={() => void exportProjects()}
          search={{
            value: search,
            onChange: (v) => setSearch(v),
            placeholder: "Search code, name, venue, organizer…",
            searching: searchTransition.isSearching,
            countPending: list.loading || list.placeholder || Boolean(list.error) || searchTransition.resultsAreStale,
            scope: "server",
            totalRecords: list.data?.total,
          }}
          resetFilters={{
            active: !!(search || brand || year || month || section || taskPending || status),
            onReset: () => {
              const next = new URLSearchParams(params);
              ["search", "brand", "year", "month", "section", "task", "status", "page"].forEach((k) =>
                next.delete(k)
              );
              setParams(next, { replace: true });
            },
          }}
          columns={columns}
          rows={rows}
          loading={list.loading || searchTransition.isSearching}
          error={list.error}
          emptyLabel="No projects yet"
          getRowKey={(r) => r.id}
          getRowClassName={(r) => (r.archived_at ? "opacity-60" : undefined)}
          onRowClick={(r) => navigate(`/projects/${r.id}`)}
          serverSort
          onSortChange={handleSortChange}
        />
      )}
      </div>
      {listMode === "cards" && (
        <aside className="space-y-4">
          <div className="rounded-xl border border-primary/30 bg-primary-soft p-4 shadow-stone">
            <div className="font-mono text-[10px] font-bold uppercase tracking-brand text-primary-ink">Total</div>
            <div className="mt-1.5 font-display text-[28px] font-extrabold leading-none text-primary-ink">
              {list.data?.total ?? 0}
            </div>
            <div className="mt-1 text-[11px] text-primary-ink/70">projects (filtered)</div>
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-primary/20 pt-3">
              <div>
                <div className="font-mono text-[16px] font-bold text-primary-ink">{summary.data?.live_count ?? 0}</div>
                <div className="text-[11px] text-primary-ink/70">Live</div>
              </div>
              <div>
                <div className="font-mono text-[16px] font-bold text-primary-ink">{summary.data?.upcoming_30d ?? 0}</div>
                <div className="text-[11px] text-primary-ink/70">Next 30d</div>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4 shadow-stone">
            <div className="mb-2.5 text-[13px] font-bold text-ink">Upcoming</div>
            {(() => {
              const today = todayInAppTz();
              const upcoming = cardRows
                .filter((r) => r.start_date && r.start_date >= today)
                .sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""))
                .slice(0, 6);
              return upcoming.length === 0 ? (
                <div className="py-3 text-center text-[11px] text-ink-muted">No upcoming projects</div>
              ) : (
                <ul className="space-y-2">
                  {upcoming.map((r) => (
                    <li key={r.id}>
                      <button
                        onClick={() => navigate(`/projects/${r.id}`)}
                        className="group flex w-full items-center justify-between gap-2 text-left"
                      >
                        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink group-hover:text-primary">
                          {r.name}
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">
                          {formatDate(r.start_date)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </div>
        </aside>
      )}
      </div>

      {list.data && !searchTransition.resultsAreStale && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}

      {showCreate && (
        <CreateProjectPanel
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/projects/${id}`);
            list.reload();
            summary.reload();
          }}
          toast={toast}
          brands={brands.data?.data ?? []}
          eventTypes={eventTypes.data?.data ?? []}
        />
      )}

      {showImport && (
        <ImportCsvPanel
          onClose={() => setShowImport(false)}
          onDone={() => {
            list.reload();
            summary.reload();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

// ── Calendar view ────────────────────────────────────────────
// Month grid: events render as colored bars spanning their date range,
// overdue checklist items render as dots on their due date. Bars are
// tinted by project status (mig 088) — see STATUS_OPTIONS + statusBarStyle.

// Per-task chip rendered inside a calendar cell. Compact: status dot,
// truncated title, owner initials, overdue tint. Click opens the
// parent project's detail panel.
function CalendarTaskChip({
  task,
  onOpen,
  onHover,
  onMove,
  onLeave,
}: {
  task: CalendarTask;
  onOpen: () => void;
  onHover?: (e: React.MouseEvent) => void;
  onMove?: (e: React.MouseEvent) => void;
  onLeave?: () => void;
}) {
  const overdue = task.is_overdue === 1;
  const initials = (task.owner_name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0])
    .join("")
    .toUpperCase();
  return (
    <button
      onClick={onOpen}
      onMouseEnter={onHover}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={cn(
        "group flex w-full items-center gap-1 rounded border px-1 py-0.5 text-left",
        overdue
          ? "border-err/40 bg-err/5 hover:bg-err/10"
          : "border-border bg-surface hover:border-accent/40 hover:bg-accent-soft/30"
      )}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: (STATUS_BY_VALUE[task.project_status ?? "pending"] ?? STATUS_BY_VALUE.pending).hex }}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[9px] font-medium",
          overdue ? "text-err" : "text-ink"
        )}
      >
        {task.title}
      </span>
      {initials ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-1 text-[8px] font-bold leading-tight",
            overdue ? "bg-err/15 text-err" : "bg-accent-soft text-accent-ink"
          )}
        >
          {initials}
        </span>
      ) : (
        <span
          className="shrink-0 rounded-full bg-bg/80 px-1 text-[8px] font-bold leading-tight text-ink-muted"
          title="Unassigned"
        >
          —
        </span>
      )}
    </button>
  );
}

interface CalendarProject {
  id: number;
  code: string;
  name: string;
  stage: ProjectStage;
  status: ProjectStatus;
  brand: string | null;
  organizer: string | null;
  start_date: string;
  end_date: string | null;
  venue: string | null;
  state: string | null;
  // Section-driven stage (mig 050). Mirrors the list endpoint's
  // active_section_name + sections_total.
  active_section_name?: string | null;
  sections_total?: number;
  // Calendar masks the title to the composed default name for solo
  // event types (backend returns event_type_name on the calendar feed).
  event_type_name?: string | null;
}

interface CalendarTask {
  id: number;
  project_id: number;
  project_code: string;
  project_name: string;
  brand: string | null;
  organizer: string | null;
  title: string;
  due_date: string;
  status: string;
  /** Parent project's status — drives the calendar tint. */
  project_status: ProjectStatus | null;
  required_perm: string | null;
  review_status: string | null;
  owner_name: string | null;
  is_overdue: number;
}

// ── Profitability / analytics ────────────────────────────────
// Aggregate view across every project. Four cuts (brand / state /
// event type / month) plus the biggest and smallest events by
// profit. All data served by /api/projects/analytics/profitability
// which reads from the finance rollup (already synced by the
// ledger write path).

interface ProfitabilityBreakdown {
  key: string;
  count: number;
  income: number;
  // Owner P&L model: Revenue − COGS = GP; GP − Cost = NP. `cost` is the
  // NON-COGS cost (rental, setup, transport, commission, merchandise,
  // others); `cogs` is the goods cost; `profit` is Net Profit. `rental` is
  // the rental slice of `cost`, pulled out so it shows as its own column.
  cogs: number;
  cost: number;
  rental: number;
  gp: number;
  profit: number;
  margin: number | null;
}

// The dimension a breakdown groups on — drives the drill-down queries.
type ProfitabilityGroupBy = "brand" | "event_type" | "organizer" | "venue" | "month";

// Filters currently active on the dashboard, forwarded to every drill query so
// a drill always reflects the same scope as the group table it opened from.
interface ProfitabilityFilters {
  date_from?: string;
  date_to?: string;
  brand?: string;
  organizer?: string;
  event_type_id?: string;
  // Lifecycle scope — must be forwarded to the drill so a drilled level totals
  // the same population as the card it was opened from.
  scope?: string;
}

// The open drill path, held in the URL (see ProjectsAnalyticsView): which
// dimension card is expanded (dim), to which value (value), and — for the four
// real dimensions — which month under it (month). Only one path is open at a
// time so the URL stays a single shareable drill.
interface ProfitabilityDrillState {
  dim: ProfitabilityGroupBy | null;
  value: string | null;
  month: string | null;
  toggleValue: (dim: ProfitabilityGroupBy, key: string) => void;
  toggleMonth: (key: string) => void;
}

// Layer 2 (dimension cards): one finance month inside a dimension value. Same
// P&L columns as the group row; `key` is the YYYY-MM bucket.
interface ProfitabilityDrillMonth {
  key: string;
  count: number;
  income: number;
  cogs: number;
  cost: number;
  rental: number;
  gp: number;
  profit: number;
  margin: number | null;
}

interface ProfitabilityMonthsResponse {
  level: "months";
  dimension: ProfitabilityGroupBy;
  value: string;
  months: ProfitabilityDrillMonth[];
}

// Layer 3: one project inside a month (or, for the By-Month card, inside the
// clicked month). Same P&L columns plus identity so the row can navigate to
// the project page (Layer 4).
interface ProfitabilityProjectRow {
  id: number;
  code: string;
  name: string;
  brand: string | null;
  organizer: string | null;
  venue: string | null;
  start_date: string | null;
  event_type_name: string | null;
  income: number;
  cogs: number;
  cost: number;
  rental: number;
  gp: number;
  profit: number;
  margin: number | null;
}

interface ProfitabilityProjectsResponse {
  level: "projects";
  dimension: ProfitabilityGroupBy;
  value: string;
  month: string | null;
  projects: ProfitabilityProjectRow[];
}

interface ProfitabilityResponse {
  filters: {
    date_from: string | null;
    date_to: string | null;
    brand: string | null;
    event_type_id: string | null;
    organizer: string | null;
    scope: string;
  };
  totals: {
    projects: number;
    income: number;
    cogs: number;
    cost: number;
    rental: number;
    gp: number;
    profit: number;
    margin_pct: number | null;
  };
  by_brand: ProfitabilityBreakdown[];
  by_organizer: ProfitabilityBreakdown[];
  by_event_type: ProfitabilityBreakdown[];
  by_venue: ProfitabilityBreakdown[];
  by_month: ProfitabilityBreakdown[];
  top: Array<{
    id: number;
    code: string;
    name: string;
    brand: string | null;
    venue: string | null;
    start_date: string | null;
    income: number;
    cogs: number;
    cost: number;
    rental: number;
    gp: number;
    profit: number;
    margin: number | null;
  }>;
  bottom: ProfitabilityResponse["top"];
}

// Finances view — tabbed: List (raw ledger lines) / Analytics
// (per-project profitability) / P&L (monthly trend).
type FinanceTab = "list" | "analytics" | "pnl";
const FINANCE_TABS: FinanceTab[] = ["list", "analytics", "pnl"];

const FINANCE_TAB_HEADER: Record<
  FinanceTab,
  { title: string; description: string }
> = {
  list: {
    title: "Finance Lines",
    description:
      "Every income and cost line across every project. Filter by date, brand, kind, category — or search.",
  },
  analytics: {
    title: "Profitability",
    description:
      "Revenue, COGS, gross profit, cost and net profit per project — sliced by brand, venue, type, and month.",
  },
  pnl: {
    title: "P&L Calendar",
    description:
      "Total project cost (COGS + other cost lines) across all projects, grouped by month.",
  },
};

const PROJECTS_FINANCES_TAB_KEYS = ["tab"] as const;

function ProjectsFinancesView() {
  const [params, setParams] = useStickyFilters(
    "projects-finances-tab",
    PROJECTS_FINANCES_TAB_KEYS
  );
  const rawTab = params.get("tab") as FinanceTab | null;
  const tab: FinanceTab =
    rawTab && FINANCE_TABS.includes(rawTab) ? rawTab : "list";
  function setTab(next: FinanceTab) {
    const p = new URLSearchParams(params);
    if (next === "list") p.delete("tab");
    else p.set("tab", next);
    setParams(p, { replace: true });
  }

  return (
    <div>
      {/* TabStrip above PageHeader — matches Orders / PurchaseOrders /
          Settings (the tabbed-module convention: tab bar is the top
          chrome, per-tab title sits beneath the active tab). */}
      <TabStrip<FinanceTab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "list", label: "List" },
          { value: "analytics", label: "Analytics" },
          { value: "pnl", label: "P&L" },
        ]}
      />
      <PageHeader
        eyebrow="Operations · Projects · Finances"
        title={FINANCE_TAB_HEADER[tab].title}
        description={FINANCE_TAB_HEADER[tab].description}
      />

      {tab === "list" && <FinanceListView />}
      {tab === "analytics" && <ProjectsAnalyticsView />}
      {tab === "pnl" && (
        <PnlCalendar
          scope="projects"
          title="Project Cost — Monthly"
          subtitle="Total project cost (COGS + other cost lines) across all projects, grouped by month."
        />
      )}
    </div>
  );
}

// ── Finance List view (per-project aggregate) ────────────────

interface FinanceProjectRow {
  id: number;
  code: string;
  name: string;
  brand: string | null;
  stage: string;
  start_date: string | null;
  end_date: string | null;
  size_sqm: number | null;
  venue: string | null;
  organizer: string | null;
  income: number;
  sales: number;
  cost: number;
  cogs: number;
  rental: number;
  setup_cost: number;
  transport_cost: number;
  commission_cost: number;
  merchandise_cost: number;
  others_cost: number;
  net: number;
  net_profit: number;
  margin_pct: number | null;
  gp_pct: number | null;
  sales_per_day: number | null;
  rent_per_sqm: number | null;
  line_count: number;
}

interface FinanceByProjectResponse {
  data: FinanceProjectRow[];
  page: number;
  per_page: number;
  total: number;
  totals: {
    income: number;
    sales: number;
    cost: number;
    cogs: number;
    rental: number;
    net: number;
    net_profit: number;
  };
}

const FINANCE_STAGE_OPTIONS = [
  "draft",
  "setup",
  "live",
  "dismantle",
  "completed",
] as const;

const FINANCE_LIST_FILTER_KEYS = [
  "date_from",
  "date_to",
  "brand",
  "stage",
  "search",
  "include_archived",
  "page",
] as const;

function FinanceListView() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // The parent (ProjectsFinancesView) only mounts this view when the viewer
  // has the DIRECTOR-level finance flag, but guard the denyFinance-protected
  // fetch with `enabled` too so a future refactor can never let it fire (and
  // 403) for a non-viewer. Fail-open when the flag is absent — backend enforces.
  const canProjectFinance = !!user?.project_finance_viewer;
  const thisYear = new Date().getFullYear();
  const defaultFrom = `${thisYear}-01-01`;
  const defaultTo = `${thisYear}-12-31`;
  const [params, setParams] = useStickyFilters(
    "projects-finance",
    FINANCE_LIST_FILTER_KEYS
  );
  const dateFrom = params.get("date_from") || defaultFrom;
  const dateTo = params.get("date_to") || defaultTo;
  const brand = params.get("brand") || "";
  const stage = params.get("stage") || "";
  const search = params.get("search") || "";
  const includeArchived = params.get("include_archived") === "1";
  const page = Math.max(1, parseInt(params.get("page") || "1", 10) || 1);
  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (
        v === "" ||
        (k === "page" && v === "1") ||
        (k === "include_archived" && v === "0") ||
        (k === "date_from" && v === defaultFrom) ||
        (k === "date_to" && v === defaultTo)
      ) {
        next.delete(k);
      } else next.set(k, v);
    }
    setParams(next, { replace: true });
  }
  const setDateFrom = (v: string) => patchParams({ date_from: v, page: "1" });
  const setDateTo = (v: string) => patchParams({ date_to: v, page: "1" });
  const setBrand = (v: string) => patchParams({ brand: v, page: "1" });
  const setStage = (v: string) => patchParams({ stage: v, page: "1" });
  const setSearch = (v: string) => patchParams({ search: v, page: "1" });
  const setIncludeArchived = (v: boolean) =>
    patchParams({ include_archived: v ? "1" : "0", page: "1" });
  const setPage = (n: number) => patchParams({ page: String(n) });

  const [perPage, setPerPage] = useIdentityPreference(
    "pp:project-finance-by-project",
    50,
    pageSizePreference([10, 25, 50, 100, 200]),
  );
  const { sort, sortParams, handleSortChange } = useServerSort(() =>
    setPage(1)
  );

  const brandsQ = useQuery<{ data: string[] }>("/api/projects/brands", () =>
    api.get("/api/projects/brands")
  );

  const list = useQuery<FinanceByProjectResponse>("/api/projects/finance/by-project",
    (signal) =>
      api.get(
        `/api/projects/finance/by-project${buildQuery({
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          brand: brand || undefined,
          stage: stage || undefined,
          search: search || undefined,
          include_archived: includeArchived ? "1" : undefined,
          page,
          per_page: perPage,
          ...sortParams,
        })}`,
        { signal },
      ),
    [dateFrom, dateTo, brand, stage, search, includeArchived, page, perPage, sort?.key, sort?.dir],
    // Paginated + filter-switched list: keep the current rows on screen while
    // the next page/filter loads instead of flashing an empty table.
    { keepPreviousData: true, enabled: canProjectFinance }
  );
  const searchTransition = useSearchResultTransition({
    inputTerm: search,
    requestTerm: search,
    isFetching: list.fetching,
    isPlaceholderData: list.placeholder,
    hasData: list.data !== null,
    hasError: Boolean(list.error),
  });

  const columns: Column<FinanceProjectRow>[] = [
    {
      key: "project",
      label: "Project",
      alwaysVisible: true,
      render: (r) => (
        <div>
          <div className="truncate text-[12px] font-semibold text-ink">
            {r.name}
          </div>
          {r.venue && (
            <div className="truncate text-[10.5px] text-ink-muted">
              {r.venue}
              {r.organizer ? ` · ${r.organizer}` : ""}
            </div>
          )}
        </div>
      ),
      getValue: (r) => r.code,
    },
    {
      key: "brand",
      label: "Brand",
      render: (r) =>
        r.brand ? (
          <span className="rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider text-accent">
            {r.brand}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
      getValue: (r) => r.brand ?? "",
    },
    {
      key: "stage",
      label: "Stage",
      render: (r) => (
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-ink-secondary">
          {r.stage}
        </span>
      ),
      getValue: (r) => r.stage,
    },
    {
      key: "start",
      label: "Dates",
      render: (r) => (
        <div className="text-[11px] text-ink-secondary">
          <div>{formatDate(r.start_date)}</div>
          {r.end_date && (
            <div className="text-ink-muted">to {formatDate(r.end_date)}</div>
          )}
        </div>
      ),
      getValue: (r) => r.start_date,
    },
    {
      key: "sales",
      label: "Sales",
      align: "right",
      alwaysVisible: true,
      render: (r) => (
        <span className="font-mono text-[12px] font-semibold text-synced">
          {formatCurrency(r.sales)}
        </span>
      ),
      getValue: (r) => r.sales,
    },
    {
      key: "sales_per_day",
      label: "Revenue / day",
      align: "right",
      defaultHidden: true,
      render: (r) =>
        r.sales_per_day == null ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span className="font-mono text-[12px] text-ink-secondary">
            {formatCurrency(r.sales_per_day)}
          </span>
        ),
      getValue: (r) => r.sales_per_day ?? -1,
    },
    {
      key: "cogs",
      label: "COGS",
      align: "right",
      alwaysVisible: true,
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {formatCurrency(r.cogs)}
        </span>
      ),
      getValue: (r) => r.cogs,
    },
    {
      key: "gp_pct",
      label: "GP %",
      align: "right",
      alwaysVisible: true,
      render: (r) =>
        r.gp_pct == null ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span
            className={cn(
              "font-mono text-[12px] font-semibold",
              r.gp_pct >= 0 ? "text-synced" : "text-err"
            )}
          >
            {r.gp_pct.toFixed(1)}%
          </span>
        ),
      getValue: (r) => r.gp_pct ?? -9999,
    },
    {
      key: "rental",
      label: "Rental",
      align: "right",
      alwaysVisible: true,
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {formatCurrency(r.rental)}
        </span>
      ),
      getValue: (r) => r.rental,
    },
    {
      key: "rent_per_sqm",
      label: "Rent / sqm",
      align: "right",
      defaultHidden: true,
      render: (r) =>
        r.rent_per_sqm == null ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span className="font-mono text-[12px] text-ink-secondary">
            {formatCurrency(r.rent_per_sqm)}
          </span>
        ),
      getValue: (r) => r.rent_per_sqm ?? -1,
    },
    {
      key: "setup",
      label: "Setup",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {formatCurrency(r.setup_cost)}
        </span>
      ),
      getValue: (r) => r.setup_cost,
    },
    {
      key: "transport",
      label: "Transport",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {formatCurrency(r.transport_cost)}
        </span>
      ),
      getValue: (r) => r.transport_cost,
    },
    {
      key: "commission",
      label: "Commission",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {formatCurrency(r.commission_cost)}
        </span>
      ),
      getValue: (r) => r.commission_cost,
    },
    {
      key: "merchandise",
      label: "Merchandise",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {formatCurrency(r.merchandise_cost)}
        </span>
      ),
      getValue: (r) => r.merchandise_cost,
    },
    {
      key: "others",
      label: "Others",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {formatCurrency(r.others_cost)}
        </span>
      ),
      getValue: (r) => r.others_cost,
    },
    {
      key: "total_cost",
      label: "Total cost",
      align: "right",
      alwaysVisible: true,
      render: (r) => (
        <span className="font-mono text-[12px] font-semibold text-err">
          {formatCurrency(r.cost)}
        </span>
      ),
      getValue: (r) => r.cost,
    },
    {
      key: "net_profit",
      label: "Net profit",
      align: "right",
      alwaysVisible: true,
      render: (r) => (
        <span
          className={cn(
            "font-mono text-[12.5px] font-bold",
            r.net_profit >= 0 ? "text-synced" : "text-err"
          )}
        >
          {formatCurrency(r.net_profit)}
        </span>
      ),
      getValue: (r) => r.net_profit,
    },
    {
      key: "income",
      label: "Revenue (all)",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span className="font-mono text-[12px] text-ink-secondary">
          {formatCurrency(r.income)}
        </span>
      ),
      getValue: (r) => r.income,
    },
    {
      key: "net",
      label: "Net (income−cost)",
      align: "right",
      defaultHidden: true,
      render: (r) => (
        <span
          className={cn(
            "font-mono text-[12px]",
            r.net >= 0 ? "text-synced" : "text-err",
          )}
        >
          {formatCurrency(r.net)}
        </span>
      ),
      getValue: (r) => r.net,
    },
    {
      key: "margin_pct",
      label: "Margin %",
      align: "right",
      defaultHidden: true,
      render: (r) =>
        r.margin_pct == null ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span
            className={cn(
              "font-mono text-[12px]",
              r.margin_pct >= 0 ? "text-synced" : "text-err"
            )}
          >
            {r.margin_pct.toFixed(1)}%
          </span>
        ),
      getValue: (r) => r.margin_pct ?? -9999,
    },
    {
      key: "lines",
      label: "Lines",
      align: "right",
      render: (r) => (
        <span className="font-mono text-[11px] text-ink-muted">
          {r.line_count.toLocaleString()}
        </span>
      ),
      getValue: (r) => r.line_count,
    },
  ];

  const totals = list.data?.totals;

  return (
    <div>
      {totals && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard
            label="Sales"
            value={formatCurrency(totals.sales, { compact: true })}
            subtitle="Filtered total"
            tone="success"
          />
          <StatCard
            label="COGS"
            value={formatCurrency(totals.cogs, { compact: true })}
            subtitle="Cost of goods sold"
          />
          <StatCard
            label="Rental"
            value={formatCurrency(totals.rental, { compact: true })}
            subtitle="Total rent paid"
          />
          <StatCard
            label="Total cost"
            value={formatCurrency(totals.cost, { compact: true })}
            subtitle="All cost categories"
            tone="error"
          />
          <StatCard
            label="Net profit"
            value={formatCurrency(totals.net_profit, { compact: true })}
            subtitle={totals.net_profit >= 0 ? "Surplus" : "Deficit"}
            tone={totals.net_profit >= 0 ? "success" : "error"}
          />
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-6">
        <FilterField label="From">
          <DateField
            fullWidth
            value={dateFrom}
            onChange={(iso) => setDateFrom(iso)}
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
        </FilterField>
        <FilterField label="To">
          <DateField
            fullWidth
            value={dateTo}
            onChange={(iso) => setDateTo(iso)}
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
        </FilterField>
        <FilterField label="Brand">
          <span className="relative inline-flex">
          <select
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              className="h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="">All</option>
              {(brandsQ.data?.data ?? []).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted" />
          </span>
        </FilterField>
        <FilterField label="Stage">
          <select
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          >
            <option value="">All</option>
            {FINANCE_STAGE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Per page">
          <select
            value={perPage}
            onChange={(e) => {
              setPerPage(parseInt(e.target.value, 10));
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </FilterField>
        <FilterField label="Archived">
          <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2 text-[11px]">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="accent-accent"
            />
            Include archived
          </label>
        </FilterField>
      </div>

      <DataTable
        tableId="project-finance-by-project"
        exportName="project-finance-by-project"
        search={{
          value: search,
          onChange: (v) => setSearch(v),
          placeholder: "Search project code, name, venue, organizer…",
          searching: searchTransition.isSearching,
          countPending: list.loading || list.placeholder || Boolean(list.error) || searchTransition.resultsAreStale,
          scope: "server",
          totalRecords: list.data?.total,
        }}
        resetFilters={{
          active: !!(
            search ||
            brand ||
            stage ||
            includeArchived ||
            dateFrom !== defaultFrom ||
            dateTo !== defaultTo
          ),
          onReset: () => {
            const next = new URLSearchParams(params);
            ["search", "brand", "stage", "date_from", "date_to", "include_archived", "page"].forEach(
              (k) => next.delete(k)
            );
            setParams(next, { replace: true });
          },
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading || searchTransition.isSearching}
        error={list.error}
        emptyLabel="No projects match these filters"
        getRowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/projects/${r.id}`)}
        serverSort
        onSortChange={handleSortChange}
      />

      {list.data && !searchTransition.resultsAreStale && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => {
            setPerPage(n);
            setPage(1);
          }}
        />
      )}
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function ProjectsAnalyticsView() {
  // Date range default: current year. User can clear or change.
  const thisYear = new Date().getFullYear();
  const navigate = useNavigate();
  const { user } = useAuth();
  // Belt-and-suspenders finance gate (see FinanceListView): the profitability
  // fetch is denyFinance-guarded server-side; never fire it for a non-viewer.
  const canProjectFinance = !!user?.project_finance_viewer;
  const toast = useToast();

  // URL is state (repo rule): the analytics filters AND the open drill path
  // both live in the query string, so a drilled view is shareable and the
  // browser Back button unwinds the drill one level at a time. A filter
  // defaults to the current year when its param is ABSENT; an explicit empty
  // param (e.g. ?af_from=) means the user cleared that bound.
  const [params, setParams] = useSearchParams();
  const dateFrom = params.get("af_from") ?? `${thisYear}-01-01`;
  const dateTo = params.get("af_to") ?? `${thisYear}-12-31`;
  const brand = params.get("af_brand") ?? "";
  const organizer = params.get("af_org") ?? "";
  const eventTypeId = params.get("af_type") ?? "";
  // Owner decision 2026-08-11: default to the full picture. "completed" was
  // the original default (an unstarted event carries only booked rental, which
  // reads as a loss that has not happened), but half the year's sales sat on
  // events staff never marked completed, so the completed-only view kept
  // understating revenue by ~50% and reading as "the numbers are wrong".
  const scope = params.get("af_scope") ?? "all";

  // Writing a filter clears the open drill: its value may not exist under the
  // new scope, so an orphaned drill path would just render "no data".
  const setFilterParam = (key: string, val: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(key, val);
      next.delete("dim");
      next.delete("dv");
      next.delete("dm");
      return next;
    });
  };
  const setDateFrom = (v: string) => setFilterParam("af_from", v);
  const setDateTo = (v: string) => setFilterParam("af_to", v);
  const setBrand = (v: string) => setFilterParam("af_brand", v);
  const setOrganizer = (v: string) => setFilterParam("af_org", v);
  const setEventTypeId = (v: string) => setFilterParam("af_type", v);
  const setScope = (v: string) => setFilterParam("af_scope", v);
  const clearFilters = () => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      // Explicit empty bounds = "all time"; the rest default to "" when absent.
      next.set("af_from", "");
      next.set("af_to", "");
      for (const k of ["af_brand", "af_org", "af_type", "af_scope", "dim", "dv", "dm"]) next.delete(k);
      return next;
    });
  };

  // The open drill path — only one at a time keeps the URL a single shareable
  // path. Clicking a value in another card replaces the path; changing the
  // month within a card just swaps `dm`.
  const drillDim = (params.get("dim") as ProfitabilityGroupBy | null) ?? null;
  const drillState: ProfitabilityDrillState = {
    dim: drillDim,
    value: params.get("dv"),
    month: params.get("dm"),
    toggleValue: (dim, key) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (next.get("dim") === dim && next.get("dv") === key) {
          next.delete("dim");
          next.delete("dv");
          next.delete("dm");
        } else {
          next.set("dim", dim);
          next.set("dv", key);
          next.delete("dm");
        }
        return next;
      }),
    toggleMonth: (key) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (next.get("dm") === key) next.delete("dm");
        else next.set("dm", key);
        return next;
      }),
  };

  const brands = useQuery<{ data: string[] }>("/api/projects/brands", () => api.get("/api/projects/brands"));
  const eventTypes = useQuery<{ data: EventType[] }>("/api/projects/event-types", () =>
    api.get("/api/projects/event-types")
  );
  const organizers = useQuery<{ data: { id: number; name: string }[] }>("/api/projects/organizers", () =>
    api.get("/api/projects/organizers")
  );

  const q = useQuery<ProfitabilityResponse>("/api/projects/analytics/profitability",
    () =>
      api.get(
        `/api/projects/analytics/profitability${buildQuery({
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
          brand: brand || undefined,
          organizer: organizer || undefined,
          event_type_id: eventTypeId || undefined,
          scope,
        })}`
      ),
    [dateFrom, dateTo, brand, organizer, eventTypeId, scope],
    { enabled: canProjectFinance }
  );

  const d = q.data;
  // Owner P&L model shares: COGS runs ~48-50% of revenue for this business,
  // gross margin = GP / Revenue, net margin = NP / Revenue (from the server).
  const totals = d?.totals;
  const cogsPctOfRevenue =
    totals && totals.income > 0 ? (totals.cogs / totals.income) * 100 : null;
  const grossMarginPct =
    totals && totals.income > 0 ? (totals.gp / totals.income) * 100 : null;

  // Active filters forwarded to every drill-down query, so a group's project
  // list stays inside the same scope the group table was computed under.
  const drillFilters: ProfitabilityFilters = {
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    brand: brand || undefined,
    organizer: organizer || undefined,
    event_type_id: eventTypeId || undefined,
    scope,
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <span className="h-px w-6 bg-accent" />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-accent">
          Profitability breakdown
        </span>
        {d && (
          <span className="ml-auto text-[10px] font-medium text-ink-muted">
            {d.totals.projects.toLocaleString()} projects in scope
          </span>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            From
          </div>
          <DateField
            fullWidth
            value={dateFrom}
            onChange={(iso) => setDateFrom(iso)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[12px]"
          />
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            To
          </div>
          <DateField
            fullWidth
            value={dateTo}
            onChange={(iso) => setDateTo(iso)}
            className="h-8 rounded-md border border-border bg-surface px-2 text-[12px]"
          />
        </div>
        <select
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          className="h-8 appearance-none rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All brands</option>
          {(brands.data?.data ?? []).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select
          value={eventTypeId}
          onChange={(e) => setEventTypeId(e.target.value)}
          className="h-8 appearance-none rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All types</option>
          {(eventTypes.data?.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          title="Unsettled events have their rental and setup booked while sales are still being keyed, so including them understates profit. Settled-only is the true P&L."
          className="h-8 appearance-none rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="completed">Completed only</option>
          <option value="started">Started events</option>
          <option value="all">All incl. upcoming</option>
        </select>
        <select
          value={organizer}
          onChange={(e) => setOrganizer(e.target.value)}
          className="h-8 appearance-none rounded-md border border-border bg-surface px-2 text-[12px]"
        >
          <option value="">All organizers</option>
          {(organizers.data?.data ?? []).map((o) => (
            <option key={o.id} value={o.name}>
              {o.name}
            </option>
          ))}
        </select>
        <button
          onClick={clearFilters}
          className="h-8 rounded-md border border-border bg-surface px-2.5 text-[11px] text-ink-secondary hover:border-accent/40 hover:text-accent"
        >
          Clear
        </button>
        {q.loading && <span className="text-[11px] text-ink-muted">Loading…</span>}
      </div>

      {q.error && (
        <div className="mb-4 rounded-md border border-err/40 bg-err/5 px-4 py-2 text-[12px] text-err">
          {q.error}
        </div>
      )}

      {d && (
        <>
          {/* Headline — the owner's P&L waterfall:
              Revenue − COGS = GP;  GP − Cost = NP. */}
          <DashboardGrid cols={5}>
            <StatCard
              label="Revenue"
              value={formatCurrency(d.totals.income, { compact: true })}
              subtitle="Total sales + other income"
            />
            <StatCard
              label="COGS"
              value={formatCurrency(d.totals.cogs, { compact: true })}
              subtitle={
                cogsPctOfRevenue != null
                  ? `${cogsPctOfRevenue.toFixed(0)}% of revenue`
                  : "Cost of goods sold"
              }
              tone="error"
            />
            <StatCard
              label="Gross profit"
              value={formatCurrency(d.totals.gp, { compact: true })}
              subtitle={
                grossMarginPct != null
                  ? `${grossMarginPct.toFixed(1)}% gross margin`
                  : "Revenue − COGS"
              }
              tone={d.totals.gp >= 0 ? "success" : "error"}
            />
            <StatCard
              label="Cost"
              value={formatCurrency(d.totals.cost, { compact: true })}
              subtitle="Rental, setup, transport, commission…"
              tone="error"
            />
            <StatCard
              label="Net profit"
              value={formatCurrency(d.totals.profit, { compact: true })}
              subtitle={
                d.totals.margin_pct != null
                  ? `${d.totals.margin_pct.toFixed(1)}% net margin`
                  : "GP − Cost"
              }
              tone={d.totals.profit >= 0 ? "success" : "error"}
            />
          </DashboardGrid>

          {/* Breakdowns — two columns. Each row expands in place (Layer 2) to
              the projects behind it, and each project navigates to its page
              (Layer 3). */}
          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BreakdownCard
              title="By Brand"
              rows={d.by_brand}
              groupBy="brand"
              filters={drillFilters}
              drill={drillState}
              onOpenProject={(id) => navigate(`/projects/${id}`)}
            />
            <BreakdownCard
              title="By Event Type"
              rows={d.by_event_type}
              groupBy="event_type"
              filters={drillFilters}
              drill={drillState}
              onOpenProject={(id) => navigate(`/projects/${id}`)}
            />
            <BreakdownCard
              title="By Organizer"
              rows={d.by_organizer}
              groupBy="organizer"
              filters={drillFilters}
              drill={drillState}
              onOpenProject={(id) => navigate(`/projects/${id}`)}
            />
            <BreakdownCard
              title="By Venue"
              rows={d.by_venue}
              groupBy="venue"
              filters={drillFilters}
              drill={drillState}
              onOpenProject={(id) => navigate(`/projects/${id}`)}
            />
            <BreakdownCard
              title="By Month"
              rows={d.by_month}
              groupBy="month"
              filters={drillFilters}
              drill={drillState}
              onOpenProject={(id) => navigate(`/projects/${id}`)}
              monthMode
            />
          </div>

          {/* Ranked events */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RankedCard
              title="Top 5 by profit"
              tone="synced"
              rows={d.top}
              onOpen={(id) => navigate(`/projects/${id}`)}
            />
            <RankedCard
              title="Bottom 5 by profit"
              tone="err"
              rows={d.bottom}
              onOpen={(id) => navigate(`/projects/${id}`)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function BreakdownCard({
  title,
  rows,
  groupBy,
  filters,
  drill,
  onOpenProject,
  monthMode,
}: {
  title: string;
  rows: ProfitabilityBreakdown[] | undefined;
  groupBy: ProfitabilityGroupBy;
  filters: ProfitabilityFilters;
  drill: ProfitabilityDrillState;
  onOpenProject: (id: number) => void;
  monthMode?: boolean;
}) {
  // Defensive: a stale API response (or a cache miss against an older
  // worker version) can leave a breakdown field undefined. Don't crash.
  const safeRows = rows ?? [];
  const maxAbsProfit = Math.max(1, ...safeRows.map((r) => Math.abs(r.profit)));

  // This card owns the drill only while the URL's `dim` points at it; the open
  // value / month come straight from the URL so the drill is shareable and the
  // Back button unwinds it. One value (and, for a dimension card, one month)
  // is open at a time.
  const isCardActive = drill.dim === groupBy;
  const expandedValue = isCardActive ? drill.value : null;
  const expandedMonth = isCardActive ? drill.month : null;

  // Layer 2 — the value's performance BY MONTH. Only the four real dimensions
  // have a month level; the By-Month card drills straight to projects. Keyed by
  // the value AND the active filters so it re-fetches when either changes.
  const monthsQuery = useQuery<ProfitabilityMonthsResponse>(
    [
      "profitability-drill-months",
      groupBy,
      expandedValue ?? "",
      filters.date_from ?? "",
      filters.date_to ?? "",
      filters.brand ?? "",
      filters.organizer ?? "",
      filters.event_type_id ?? "",
    ],
    () =>
      api.get(
        `/api/projects/analytics/profitability/drill${buildQuery({
          dimension: groupBy,
          value: expandedValue ?? undefined,
          date_from: filters.date_from,
          date_to: filters.date_to,
          brand: filters.brand,
          organizer: filters.organizer,
          event_type_id: filters.event_type_id,
          scope: filters.scope,
        })}`
      ),
    [
      groupBy,
      expandedValue,
      filters.date_from,
      filters.date_to,
      filters.brand,
      filters.organizer,
      filters.event_type_id,
      filters.scope,
    ],
    { enabled: !monthMode && isCardActive && expandedValue != null }
  );

  // Layer 3 — the projects inside the open month (dimension cards) or inside
  // the open month value itself (By-Month card). One projects query per card;
  // the open-at-a-time rule means only the current month renders it.
  const projectsQuery = useQuery<ProfitabilityProjectsResponse>(
    [
      "profitability-drill-projects",
      groupBy,
      expandedValue ?? "",
      monthMode ? "" : expandedMonth ?? "",
      filters.date_from ?? "",
      filters.date_to ?? "",
      filters.brand ?? "",
      filters.organizer ?? "",
      filters.event_type_id ?? "",
    ],
    () =>
      api.get(
        `/api/projects/analytics/profitability/drill${buildQuery({
          dimension: groupBy,
          value: expandedValue ?? undefined,
          month: monthMode ? undefined : expandedMonth ?? undefined,
          date_from: filters.date_from,
          date_to: filters.date_to,
          brand: filters.brand,
          organizer: filters.organizer,
          event_type_id: filters.event_type_id,
          scope: filters.scope,
        })}`
      ),
    [
      groupBy,
      expandedValue,
      monthMode,
      expandedMonth,
      filters.date_from,
      filters.date_to,
      filters.brand,
      filters.organizer,
      filters.event_type_id,
      filters.scope,
    ],
    { enabled: isCardActive && expandedValue != null && (monthMode ? true : expandedMonth != null) }
  );

  // 8 columns: Name/Month, #, Revenue, COGS, GP, Rental, NP, Margin.
  const COLSPAN = 8;

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
      <header className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <h3 className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-brand text-ink">
          <BarChart3 size={12} className="text-accent" />
          {title}
        </h3>
        <span className="text-[10px] text-ink-muted">{safeRows.length} groups</span>
      </header>
      {safeRows.length === 0 ? (
        <div className="px-4 py-6 text-center text-[11px] text-ink-muted">No data.</div>
      ) : (
        <div className="max-h-[320px] overflow-auto">
          {/* Full P&L model per group: Revenue − COGS = GP; GP − Cost = NP,
              with Rental (a slice of Cost) pulled out as its own column. Click
              a row to drill: a dimension value opens its months (Layer 2), a
              month opens its projects (Layer 3), a project opens its page
              (Layer 4). min-width keeps the eight columns legible; the wrapper
              scrolls horizontally on a narrow (mobile / half-width) card. */}
          <table className="w-full min-w-[600px] text-[11px]">
            <thead className="bg-bg/40 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
              <tr>
                <th className="px-2 py-1.5 text-left">{monthMode ? "Month" : "Name"}</th>
                <th className="whitespace-nowrap px-1.5 py-1.5 text-right">#</th>
                <th className="whitespace-nowrap px-1.5 py-1.5 text-right">Revenue</th>
                <th className="whitespace-nowrap px-1.5 py-1.5 text-right">COGS</th>
                <th className="whitespace-nowrap px-1.5 py-1.5 text-right">GP</th>
                <th className="whitespace-nowrap px-1.5 py-1.5 text-right">Rental</th>
                <th className="whitespace-nowrap px-1.5 py-1.5 text-right">NP</th>
                <th className="whitespace-nowrap px-1.5 py-1.5 text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {safeRows.map((r) => {
                const barPct = Math.round((Math.abs(r.profit) / maxAbsProfit) * 100);
                const isExpanded = expandedValue === r.key;
                return (
                  <Fragment key={r.key}>
                    <tr
                      onClick={() => drill.toggleValue(groupBy, r.key)}
                      aria-expanded={isExpanded}
                      className={cn(
                        "cursor-pointer border-t border-border-subtle hover:bg-accent-soft/30",
                        isExpanded && "bg-accent-soft/20"
                      )}
                    >
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          {isExpanded ? (
                            <ChevronDown size={11} className="shrink-0 text-ink-muted" />
                          ) : (
                            <ChevronRight size={11} className="shrink-0 text-ink-muted" />
                          )}
                          <span className="font-semibold text-ink">
                            {monthMode ? formatMonth(r.key) : r.key}
                          </span>
                        </div>
                        <div className="mt-0.5 h-[3px] w-full min-w-[64px] rounded-full bg-bg">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              r.profit >= 0 ? "bg-synced" : "bg-err"
                            )}
                            style={{ width: `${barPct}%` }}
                          />
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono">{r.count}</td>
                      <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono">
                        {formatCurrency(r.income, { compact: true })}
                      </td>
                      <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                        {formatCurrency(r.cogs, { compact: true })}
                      </td>
                      <td
                        className={cn(
                          "whitespace-nowrap px-1.5 py-1.5 text-right font-mono",
                          r.gp >= 0 ? "text-ink" : "text-err"
                        )}
                      >
                        {formatCurrency(r.gp, { compact: true })}
                      </td>
                      <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                        {formatCurrency(r.rental, { compact: true })}
                      </td>
                      <td
                        className={cn(
                          "whitespace-nowrap px-1.5 py-1.5 text-right font-mono font-bold",
                          r.profit >= 0 ? "text-synced" : "text-err"
                        )}
                      >
                        {formatCurrency(r.profit, { compact: true })}
                      </td>
                      <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                        {r.margin != null ? `${r.margin.toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                    {isExpanded && !monthMode && (
                      <BreakdownMonthRows
                        monthsQuery={monthsQuery}
                        projectsQuery={projectsQuery}
                        parentValue={r.key}
                        expandedMonth={expandedMonth}
                        onToggleMonth={drill.toggleMonth}
                        colSpan={COLSPAN}
                        onOpenProject={onOpenProject}
                      />
                    )}
                    {isExpanded && monthMode && (
                      <BreakdownProjectRows
                        projectsQuery={projectsQuery}
                        expectValue={r.key}
                        expectMonth={null}
                        colSpan={COLSPAN}
                        onOpenProject={onOpenProject}
                      />
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// A single full-width message row (loading / error / empty) spanning the drill
// table, so nested states never break the column grid.
function DrillMessageRow({
  colSpan,
  tone,
  children,
}: {
  colSpan: number;
  tone?: "muted" | "err";
  children: React.ReactNode;
}) {
  return (
    <tr className="border-t border-border-subtle bg-bg/30">
      <td
        colSpan={colSpan}
        className={cn(
          "px-2 py-3 text-center text-[10px]",
          tone === "err" ? "text-err" : "text-ink-muted"
        )}
      >
        {children}
      </td>
    </tr>
  );
}

// Layer-2 body: the months behind one expanded dimension value, rendered as
// sibling <tr>s so their P&L columns line up under the group's. Each month
// expands in turn to its projects (Layer 3).
function BreakdownMonthRows({
  monthsQuery,
  projectsQuery,
  parentValue,
  expandedMonth,
  onToggleMonth,
  colSpan,
  onOpenProject,
}: {
  monthsQuery: QueryState<ProfitabilityMonthsResponse>;
  projectsQuery: QueryState<ProfitabilityProjectsResponse>;
  parentValue: string;
  expandedMonth: string | null;
  onToggleMonth: (key: string) => void;
  colSpan: number;
  onOpenProject: (id: number) => void;
}) {
  if (monthsQuery.loading) {
    return <DrillMessageRow colSpan={colSpan}>Loading months…</DrillMessageRow>;
  }
  if (monthsQuery.error) {
    return (
      <DrillMessageRow colSpan={colSpan} tone="err">
        {monthsQuery.error}
      </DrillMessageRow>
    );
  }
  // Guard on value match so a resolving query never flashes another value's
  // months under this one.
  const months =
    monthsQuery.data && monthsQuery.data.value === parentValue
      ? monthsQuery.data.months
      : [];
  if (months.length === 0) {
    return <DrillMessageRow colSpan={colSpan}>No monthly activity.</DrillMessageRow>;
  }
  return (
    <>
      {months.map((m) => {
        const isMonthExpanded = expandedMonth === m.key;
        return (
          <Fragment key={m.key}>
            <tr
              onClick={() => onToggleMonth(m.key)}
              aria-expanded={isMonthExpanded}
              className={cn(
                "cursor-pointer border-t border-border-subtle bg-bg/20 hover:bg-accent-soft/30",
                isMonthExpanded && "bg-accent-soft/20"
              )}
            >
              <td className="px-2 py-1.5 pl-6">
                <div className="flex items-center gap-1">
                  {isMonthExpanded ? (
                    <ChevronDown size={11} className="shrink-0 text-ink-muted" />
                  ) : (
                    <ChevronRight size={11} className="shrink-0 text-ink-muted" />
                  )}
                  <span className="font-medium text-ink">{formatMonth(m.key)}</span>
                </div>
              </td>
              <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono">{m.count}</td>
              <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono">
                {formatCurrency(m.income, { compact: true })}
              </td>
              <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                {formatCurrency(m.cogs, { compact: true })}
              </td>
              <td
                className={cn(
                  "whitespace-nowrap px-1.5 py-1.5 text-right font-mono",
                  m.gp >= 0 ? "text-ink" : "text-err"
                )}
              >
                {formatCurrency(m.gp, { compact: true })}
              </td>
              <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                {formatCurrency(m.rental, { compact: true })}
              </td>
              <td
                className={cn(
                  "whitespace-nowrap px-1.5 py-1.5 text-right font-mono font-bold",
                  m.profit >= 0 ? "text-synced" : "text-err"
                )}
              >
                {formatCurrency(m.profit, { compact: true })}
              </td>
              <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                {m.margin != null ? `${m.margin.toFixed(1)}%` : "—"}
              </td>
            </tr>
            {isMonthExpanded && (
              <BreakdownProjectRows
                projectsQuery={projectsQuery}
                expectValue={parentValue}
                expectMonth={m.key}
                colSpan={colSpan}
                onOpenProject={onOpenProject}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// Layer-3 body: the projects behind one expanded month (or, for the By-Month
// card, one expanded month value). Each project row navigates to its detail
// page (Layer 4). Guarded on value+month so a resolving query never flashes
// the wrong slice under this row.
function BreakdownProjectRows({
  projectsQuery,
  expectValue,
  expectMonth,
  colSpan,
  onOpenProject,
}: {
  projectsQuery: QueryState<ProfitabilityProjectsResponse>;
  expectValue: string;
  expectMonth: string | null;
  colSpan: number;
  onOpenProject: (id: number) => void;
}) {
  const d = projectsQuery.data;
  const matches =
    !!d && d.value === expectValue && (d.month ?? null) === (expectMonth ?? null);
  if (projectsQuery.loading || !matches) {
    if (projectsQuery.error) {
      return (
        <DrillMessageRow colSpan={colSpan} tone="err">
          {projectsQuery.error}
        </DrillMessageRow>
      );
    }
    return <DrillMessageRow colSpan={colSpan}>Loading projects…</DrillMessageRow>;
  }
  const projects = d!.projects;
  if (projects.length === 0) {
    return <DrillMessageRow colSpan={colSpan}>No projects.</DrillMessageRow>;
  }
  return (
    <>
      {projects.map((p) => (
        <tr
          key={p.id}
          onClick={() => onOpenProject(p.id)}
          className="cursor-pointer border-t border-border-subtle bg-bg/30 hover:bg-accent-soft/40"
        >
          <td className="px-2 py-1.5 pl-10">
            <div className="flex items-center gap-1">
              <span className="truncate font-medium text-ink">{p.name}</span>
              <ExternalLink size={9} className="shrink-0 text-ink-muted" />
            </div>
            <div className="text-[9.5px] text-ink-muted">
              {p.code}
              {p.start_date ? ` · ${formatDate(p.start_date)}` : ""}
            </div>
          </td>
          <td className="px-1.5 py-1.5" />
          <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono">
            {formatCurrency(p.income, { compact: true })}
          </td>
          <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
            {formatCurrency(p.cogs, { compact: true })}
          </td>
          <td
            className={cn(
              "whitespace-nowrap px-1.5 py-1.5 text-right font-mono",
              p.gp >= 0 ? "text-ink" : "text-err"
            )}
          >
            {formatCurrency(p.gp, { compact: true })}
          </td>
          <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
            {formatCurrency(p.rental, { compact: true })}
          </td>
          <td
            className={cn(
              "whitespace-nowrap px-1.5 py-1.5 text-right font-mono font-bold",
              p.profit >= 0 ? "text-synced" : "text-err"
            )}
          >
            {formatCurrency(p.profit, { compact: true })}
          </td>
          <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
            {p.margin != null ? `${p.margin.toFixed(1)}%` : "—"}
          </td>
        </tr>
      ))}
    </>
  );
}

function RankedCard({
  title,
  tone,
  rows,
  onOpen,
}: {
  title: string;
  tone: "synced" | "err";
  rows: ProfitabilityResponse["top"] | undefined;
  onOpen: (id: number) => void;
}) {
  const safeRows = rows ?? [];
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-stone">
      <header className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <h3
          className={cn(
            "text-[11px] font-bold uppercase tracking-brand",
            tone === "synced" ? "text-synced" : "text-err"
          )}
        >
          {title}
        </h3>
        <span className="text-[10px] text-ink-muted">{safeRows.length}</span>
      </header>
      {safeRows.length === 0 ? (
        <div className="px-4 py-6 text-center text-[11px] text-ink-muted">No data.</div>
      ) : (
        <ul>
          {safeRows.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => onOpen(r.id)}
                className="flex w-full items-start gap-3 border-t border-border-subtle px-4 py-2 text-left hover:bg-accent-soft/30"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    {r.brand && (
                      <span className="rounded bg-accent/10 px-1 text-[9px] font-bold text-accent">
                        {r.brand}
                      </span>
                    )}
                    <span className="truncate text-[12px] font-semibold text-ink">
                      {r.name}
                    </span>
                  </div>
                  <div className="text-[10px] text-ink-muted">
                    {r.venue || "—"}
                    {r.start_date && ` · ${formatDate(r.start_date)}`}
                  </div>
                  {/* Model context: Revenue and GP (COGS = Revenue − GP). */}
                  <div className="mt-0.5 font-mono text-[10px] text-ink-muted">
                    Rev {formatCurrency(r.income, { compact: true })}
                    {" · "}
                    GP {formatCurrency(r.gp, { compact: true })}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      "font-mono text-[12px] font-bold",
                      tone === "synced" ? "text-synced" : "text-err"
                    )}
                  >
                    {formatCurrency(r.profit, { compact: true })}
                  </div>
                  <div className="text-[10px] text-ink-muted">
                    {r.margin != null ? `${r.margin.toFixed(1)}% NP` : "—"}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatMonth(yyyy_mm: string): string {
  const [y, m] = yyyy_mm.split("-");
  if (!y || !m) return yyyy_mm;
  // Numeric MM/YYYY month-group label (no "Jun"/"Jul" month names).
  return `${m}/${y}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

type CalendarMode = "month" | "week";
type CalendarCell = { date: Date; iso: string };
type CalendarWeekSeg = {
  project: CalendarProject;
  startCol: number;
  endCol: number;
  clipLeft: boolean;
  clipRight: boolean;
  lane: number;
};

const CALENDAR_BAR_H = 18;
const CALENDAR_LANE_GAP = 3;
const CALENDAR_LANE_TOTAL = CALENDAR_BAR_H + CALENDAR_LANE_GAP;
const EMPTY_CALENDAR_PROJECTS: CalendarProject[] = [];
const EMPTY_CALENDAR_TASKS: CalendarTask[] = [];

export function buildCalendarWindow(
  mode: CalendarMode,
  monthStr: string,
  weekStartStr: string,
): {
  anchor: Date;
  startDay: Date;
  endDay: Date;
  cells: CalendarCell[];
  weekCount: number;
  totalCells: number;
  fromStr: string;
  toStr: string;
} {
  let monthAnchor: Date;
  if (/^\d{4}-\d{2}$/.test(monthStr)) {
    monthAnchor = new Date(Number(monthStr.slice(0, 4)), Number(monthStr.slice(5, 7)) - 1, 1);
  } else {
    monthAnchor = new Date();
    monthAnchor.setDate(1);
  }

  let weekAnchor: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(weekStartStr)) {
    weekAnchor = new Date(weekStartStr + "T00:00:00Z");
  } else {
    weekAnchor = new Date();
    weekAnchor.setUTCHours(0, 0, 0, 0);
  }
  weekAnchor.setUTCDate(weekAnchor.getUTCDate() - ((weekAnchor.getUTCDay() + 6) % 7));

  const anchor = mode === "week" ? weekAnchor : monthAnchor;
  const weekCount = mode === "week" ? 1 : 6;
  const totalCells = weekCount * 7;
  let startDay: Date;
  if (mode === "week") {
    startDay = new Date(anchor);
  } else {
    const first = new Date(Date.UTC(anchor.getFullYear(), anchor.getMonth(), 1));
    startDay = new Date(first);
    startDay.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  }
  const endDay = new Date(startDay);
  endDay.setUTCDate(startDay.getUTCDate() + totalCells - 1);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < totalCells; i++) {
    const date = new Date(startDay);
    date.setUTCDate(startDay.getUTCDate() + i);
    cells.push({ date, iso: date.toISOString().slice(0, 10) });
  }
  return {
    anchor,
    startDay,
    endDay,
    cells,
    weekCount,
    totalCells,
    fromStr: startDay.toISOString().slice(0, 10),
    toStr: endDay.toISOString().slice(0, 10),
  };
}

/**
 * Pure calendar projection. Keeping this outside React makes hover/popover and
 * viewport-height renders O(1) with respect to project/task count: React only
 * rebuilds the model when its actual data/filter/window inputs change.
 */
export function buildProjectsCalendarModel({
  allProjects,
  allTasks,
  cells,
  weekCount,
  mode,
  anchorMonth,
  brand,
  status,
  organizer,
  q = "",
  showTasks,
  expandAll,
}: {
  allProjects: CalendarProject[];
  allTasks: CalendarTask[];
  cells: CalendarCell[];
  weekCount: number;
  mode: CalendarMode;
  anchorMonth: number;
  brand: string;
  status: string;
  organizer: string;
  /** Free-text search — matches venue/organizer/brand/project code/name/event
   *  type. Empty string = no filter. Defaults to "" so callers pre-dating the
   *  search box (tests) still pass. */
  q?: string;
  showTasks: boolean;
  expandAll: boolean;
}) {
  // Filter by project STATUS (owner 2026-07-28) — the calendar's old "section"
  // dropdown is now confirmed / pending / cancelled.
  const matchesStatus = (project: CalendarProject): boolean =>
    !status || (project.status || "").toLowerCase() === status;

  // Free-text search — case-insensitive over the visible/label fields.
  const needle = q.trim().toLowerCase();
  const matchesQuery = (project: CalendarProject): boolean => {
    if (!needle) return true;
    const hay = [
      project.code,
      project.name,
      project.venue ?? "",
      project.organizer ?? "",
      project.brand ?? "",
      project.state ?? "",
      project.event_type_name ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  };

  const projects = allProjects.filter((project) => {
    if (brand && project.brand !== brand) return false;
    if (!matchesStatus(project)) return false;
    if (organizer && (project.organizer || "") !== organizer) return false;
    if (!matchesQuery(project)) return false;
    return true;
  });
  const projectById = new Map(projects.map((project) => [project.id, project] as const));
  const tasks = showTasks
    ? allTasks.filter((task) => {
        if (brand && task.brand !== brand) return false;
        if (organizer && (task.organizer || "") !== organizer) return false;
        // With a search: only render tasks whose parent project passed the
        // filter — keeps the view consistent (task chips beside their bar).
        if (needle && !projectById.has(task.project_id)) return false;
        return !status || projectById.has(task.project_id);
      })
    : [];

  const tasksByDate = new Map<string, CalendarTask[]>();
  for (const task of tasks) {
    const key = (task.due_date ?? "").slice(0, 10);
    if (!key) continue;
    const sameDay = tasksByDate.get(key);
    if (sameDay) sameDay.push(task);
    else tasksByDate.set(key, [task]);
  }

  const totalCells = cells.length;
  const maxLanes = mode === "week" || expandAll ? Infinity : 3;
  const weekSegs: CalendarWeekSeg[][] = Array.from({ length: weekCount }, () => []);
  const overflowByCell: number[] = Array(totalCells).fill(0);
  let renderedWeeks = 0;

  for (let week = 0; week < weekCount; week++) {
    const weekCells = cells.slice(week * 7, week * 7 + 7);
    if (mode !== "month" || weekCells.some((cell) => cell.date.getUTCMonth() === anchorMonth)) {
      renderedWeeks += 1;
    }
    const weekStart = weekCells[0].iso;
    const weekEnd = weekCells[6].iso;
    let monthFirstCol = 0;
    let monthLastCol = 6;
    if (mode === "month") {
      monthFirstCol = -1;
      for (let day = 0; day < 7; day++) {
        if (weekCells[day].date.getUTCMonth() === anchorMonth) {
          if (monthFirstCol === -1) monthFirstCol = day;
          monthLastCol = day;
        }
      }
    }

    const segments: CalendarWeekSeg[] = [];
    if (mode !== "month" || monthFirstCol !== -1) {
      for (const project of projects) {
        const start = project.start_date.slice(0, 10);
        const end = (project.end_date || project.start_date).slice(0, 10);
        if (end < weekStart || start > weekEnd) continue;
        const clipLeft = start < weekStart;
        const clipRight = end > weekEnd;
        let startCol = clipLeft ? 0 : daysBetween(weekStart, start);
        let endCol = clipRight ? 6 : daysBetween(weekStart, end);
        if (mode === "month") {
          if (endCol < monthFirstCol || startCol > monthLastCol) continue;
          startCol = Math.max(startCol, monthFirstCol);
          endCol = Math.min(endCol, monthLastCol);
        }
        segments.push({ project, startCol, endCol, clipLeft, clipRight, lane: 0 });
      }
    }

    segments.sort(
      (a, b) =>
        compareCalendarEvents(a.project, b.project) ||
        a.startCol - b.startCol ||
        b.endCol - b.startCol - (a.endCol - a.startCol),
    );
    const lanes: CalendarWeekSeg[][] = [];
    for (const segment of segments) {
      let lane = lanes.findIndex((items) =>
        items.every((item) => item.endCol < segment.startCol || item.startCol > segment.endCol),
      );
      if (lane === -1) {
        lanes.push([segment]);
        lane = lanes.length - 1;
      } else {
        lanes[lane].push(segment);
      }
      segment.lane = lane;
    }
    for (const segment of segments) {
      if (segment.lane < maxLanes) {
        weekSegs[week].push(segment);
      } else {
        for (let day = segment.startCol; day <= segment.endCol; day++) {
          overflowByCell[week * 7 + day] += 1;
        }
      }
    }
  }

  const barsAreaHByWeek = weekSegs.map((segments) => {
    const lanesUsed = segments.reduce((max, segment) => Math.max(max, segment.lane + 1), 0);
    return mode === "week" || expandAll
      ? Math.max(lanesUsed, 1) * CALENDAR_LANE_TOTAL
      : 3 * CALENDAR_LANE_TOTAL;
  });
  const cellBarsH = Array(totalCells).fill(0);
  for (let week = 0; week < weekCount; week++) {
    for (const segment of weekSegs[week]) {
      for (let col = segment.startCol; col <= segment.endCol; col++) {
        const index = week * 7 + col;
        cellBarsH[index] = Math.max(cellBarsH[index], (segment.lane + 1) * CALENDAR_LANE_TOTAL);
      }
    }
  }

  return {
    projects,
    projectById,
    tasks,
    tasksByDate,
    weekSegs,
    overflowByCell,
    barsAreaHByWeek,
    cellBarsH,
    renderedWeeks,
  };
}

const PROJECTS_CALENDAR_FILTER_KEYS = [
  "brand",
  "stage",
  "organizer",
  "month",
  // 2026-05-08 — week view toggle. `mode=week` swaps the 6×7 month
  // grid for a single 1×7 row anchored on `week` (Sunday ISO date).
  "mode",
  "week",
  // 2026-05-15 — `section` replaces the legacy `stage` filter (the
  // tasklist sections are the new stages). `stage` stays in the keys
  // list so old bookmarks parse without throwing.
  "section",
  // 2026-07-20 — free-text search (venue/organizer/brand/code/title).
  "q",
] as const;

// Per-day task-count chip in calendar cells. Neutral by default; an
// overdue day gets a small red dot rather than a fully-red pill so the
// month grid isn't a wall of alarm-red badges.
function DayCountBadge({
  count,
  overdue,
  className,
}: {
  count: number;
  overdue: boolean;
  className?: string;
}) {
  return (
    <span
      title={`${count} task(s) due${overdue ? " — includes overdue" : ""}`}
      className={cn(
        "inline-flex h-4 items-center gap-1 rounded-full bg-surface-dim px-1.5 text-[9px] font-bold text-ink-secondary",
        className
      )}
    >
      {overdue && <span className="h-1.5 w-1.5 rounded-full bg-err" aria-hidden />}
      {count}
    </span>
  );
}

function ProjectsCalendarView() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useStickyFilters(
    "projects-calendar",
    PROJECTS_CALENDAR_FILTER_KEYS
  );
  const brand = params.get("brand") || "";
  const status = params.get("status") || "";
  const organizer = params.get("organizer") || "";
  // 2026-07-20 — free-text search. Named `search` (not `q`) to avoid a
  // collision with the useQuery result later in this component that already
  // owns the identifier `q`. URL key stays "q" for a short, shareable URL.
  const search = params.get("q") || "";
  // anchor lives in URL as `month=YYYY-MM` so a refresh / shared link
  // lands on the same month.
  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }
  const setBrand = (v: string) => patchParams({ brand: v });
  const setStatus = (v: string) => patchParams({ status: v });
  const setOrganizer = (v: string) => patchParams({ organizer: v });
  const setSearch = (v: string) => patchParams({ q: v });

  // showTasks / showHolidays are personal display prefs (checkbox toggles
  // on the legend, not data filters), so they stay in localStorage per
  // CLAUDE.md's URL-state convention.
  const [showTasks, setShowTasks] = useIdentityPreference(
    "projects:cal:showTasks",
    false,
    booleanPreference,
  );
  const [showHolidays, setShowHolidays] = useIdentityPreference(
    "projects:cal:showHolidays",
    true,
    booleanPreference,
  );
  // Owner 2026-07-23: the calendar always shows every project bar + task inline
  // (no "+N more", no Expand-all toggle) — pc and mobile both default-expanded.
  const expandAll = true;
  const brandsQ = useQuery<{ data: string[] }>("/api/projects/brands", () =>
    api.get("/api/projects/brands")
  );
  const organizersQ = useQuery<{ data: { id: number; name: string }[] }>("/api/projects/organizers", () =>
    api.get("/api/projects/organizers")
  );
  // Active template's sections, mirroring the list-view pill row.
  const sectionsListQ = useQuery<{ data: string[] }>("/api/projects/sections-distinct", () =>
    api.get("/api/projects/sections-distinct")
  );
  // ?mode=week swaps the 6×7 month grid for a single 1×7 row anchored
  // on `?week=YYYY-MM-DD` (Sunday). `?month=YYYY-MM` is the existing
  // monthly anchor; both URL params persist via stickyFilters.
  const mode: CalendarMode =
    params.get("mode") === "week" ? "week" : "month";
  const monthStr = params.get("month") || "";
  const weekStartStr = params.get("week") || "";

  // Stable across hover/popover renders: new Date objects here used to
  // invalidate every downstream calendar projection on each mousemove.
  const calendarWindow = useMemo(
    () => buildCalendarWindow(mode, monthStr, weekStartStr),
    [mode, monthStr, weekStartStr],
  );
  const { anchor, startDay, endDay, cells, weekCount, totalCells, fromStr, toStr } = calendarWindow;

  const setAnchor = (next: Date) => {
    if (mode === "week") {
      // Save the Monday ISO date.
      const yyyy = next.getUTCFullYear();
      const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(next.getUTCDate()).padStart(2, "0");
      patchParams({ week: `${yyyy}-${mm}-${dd}` });
    } else {
      const yyyy = next.getFullYear();
      const mm = String(next.getMonth() + 1).padStart(2, "0");
      patchParams({ month: `${yyyy}-${mm}` });
    }
  };
  // Day modal — opened by month-view "+N more" expanders to surface every
  // project / task that lands on a single day without forcing a switch to
  // week mode. Previously these expanders called expandToWeekForCell()
  // which navigated the whole view; ops asked for a lighter overlay.
  const [dayModalIso, setDayModalIso] = useState<string | null>(null);
  // Hover popover — replaces the native bar `title` tooltip with a
  // styled card carrying the project's basic info (code, brand, venue,
  // span, organizer, stage). Anchored to the cursor; cleared on leave.
  // Mousemove can fire hundreds of times per second. Keep entry/exit immediate,
  // but coalesce cursor-position updates to one React state update per frame.
  const barHoverState = useRafCoalescedHover<{
    project: CalendarProject;
    x: number;
    y: number;
  }>();
  const taskHoverState = useRafCoalescedHover<{
    task: CalendarTask;
    x: number;
    y: number;
  }>();
  const barHover = barHoverState.hover;
  const taskHover = taskHoverState.hover;
  const enterBarHover = useCallback(
    (project: CalendarProject, x: number, y: number) => barHoverState.enter({ project, x, y }),
    [barHoverState.enter],
  );
  const moveBarHover = useCallback(
    (project: CalendarProject, x: number, y: number) => barHoverState.move({ project, x, y }),
    [barHoverState.move],
  );
  const leaveBarHover = barHoverState.leave;
  const enterTaskHover = useCallback(
    (task: CalendarTask, x: number, y: number) => taskHoverState.enter({ task, x, y }),
    [taskHoverState.enter],
  );
  const moveTaskHover = useCallback(
    (task: CalendarTask, x: number, y: number) => taskHoverState.move({ task, x, y }),
    [taskHoverState.move],
  );
  const leaveTaskHover = taskHoverState.leave;

  // Wheel-over-grid navigates months (month mode). Refs keep the handler
  // reading the latest anchor/setAnchor without re-binding the listener;
  // a timestamp throttles to one month per gesture. Non-passive so we can
  // preventDefault and stop the page scrolling under the cursor.
  const gridRef = useRef<HTMLDivElement>(null);
  const wheelTsRef = useRef(0);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const setAnchorRef = useRef(setAnchor);
  setAnchorRef.current = setAnchor;
  useEffect(() => {
    const el = gridRef.current;
    if (!el || mode !== "month") return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      // Only flip months when scrolling over BLANK calendar space (e.g. the
      // empty leading cells, or a day with no items). Over a project bar, task
      // chip, or a "+N more" link the page scrolls normally — so Expand all can
      // still be scrolled by dragging over its content. Works in both modes.
      const target = e.target as HTMLElement | null;
      if (target && target.closest(".cal-bar,[data-cal-content]")) return;
      /* Owner 2026-07-16 — never hijack the wheel while the page can still
         scroll in that direction. Owner 2026-07-23 — but the flip must SURVIVE
         a scrollable page: 6c29e5cc (always expand all bars) made the grid
         overflow the viewport on any busy month, which turned the old
         "scrollable ⇒ never flip" guard into a permanent kill-switch — the
         tip kept promising a scroll-to-change-month that could never fire.
         Boundary rule instead: wheeling over blank space flips the month only
         at the edge being pushed past (down at the bottom, up at the top);
         mid-scroll the page scrolls normally. An empty short calendar is at
         both edges at once, which is exactly the pre-expand behaviour. */
      const scroller = el.closest("main");
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
        const atTop = scroller.scrollTop <= 1;
        const atBottom =
          scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
        if (e.deltaY > 0 ? !atBottom : !atTop) return;
      }
      e.preventDefault();
      const now = Date.now();
      if (now - wheelTsRef.current < 380) return;
      wheelTsRef.current = now;
      const d = new Date(anchorRef.current);
      d.setMonth(d.getMonth() + (e.deltaY > 0 ? 1 : -1));
      setAnchorRef.current(d);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mode]);

  // Month grid fills from its top to the viewport bottom, so the 5–6 week
  // rows share that height EQUALLY (uniform rows, no tiny empty week, no
  // dead gap at the bottom). Re-measured on resize / month change since the
  // grid's top is fixed by the header+toolbar+legend above it.
  const [availH, setAvailH] = useState<number | null>(null);
  useEffect(() => {
    if (mode !== "month") {
      setAvailH(null);
      return;
    }
    const measure = () => {
      const el = gridRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setAvailH(Math.max(440, Math.round(window.innerHeight - top - 14)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [mode, anchor]);

  const setMode = (next: "month" | "week") => {
    // When flipping to week mode for the first time, snap the week
    // anchor to the Monday of "today" so the user lands on the
    // current week instead of an unrelated one.
    if (next === "week" && !weekStartStr) {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      patchParams({ mode: next, week: `${yyyy}-${mm}-${dd}` });
    } else {
      patchParams({ mode: next === "month" ? "" : next });
    }
  };

  // Window: month = 6 weeks (42 cells) from the first Monday on/before
  // the 1st; week = 1 week (7 cells) from the week anchor.
  const q = useQuery<{ projects: CalendarProject[]; tasks: CalendarTask[] }>("/api/projects/calendar/events?from=:&to=:",
    () => api.get(`/api/projects/calendar/events?from=${fromStr}&to=${toStr}`),
    [fromStr, toStr]
  );

  const allProjects = q.data?.projects ?? EMPTY_CALENDAR_PROJECTS;
  const allTasks = q.data?.tasks ?? EMPTY_CALENDAR_TASKS;
  const anchorMonth = anchor.getMonth();
  const calendarModel = useMemo(
    () =>
      buildProjectsCalendarModel({
        allProjects,
        allTasks,
        cells,
        weekCount,
        mode,
        anchorMonth,
        brand,
        status,
        organizer,
        q: search,
        showTasks,
        expandAll,
      }),
    [
      allProjects,
      allTasks,
      cells,
      weekCount,
      mode,
      anchorMonth,
      brand,
      status,
      organizer,
      search,
      showTasks,
      expandAll,
    ],
  );
  const {
    projects,
    tasks,
    tasksByDate,
    weekSegs,
    overflowByCell,
    barsAreaHByWeek,
    cellBarsH,
    renderedWeeks,
  } = calendarModel;

  // Calendar header shows the full month name (owner request 2026-07):
  // "November 2025", not "11/2025". Row/cell dates stay numeric elsewhere.
  const monthLabel = anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  // Period label for the calendar header. Month → "April 2026"; week
  // → "06 Apr – 12 Apr 2026" so the user knows the exact window.
  const periodLabel =
    mode === "week"
      ? (() => {
          const start = startDay;
          const end = new Date(startDay);
          end.setUTCDate(start.getUTCDate() + 6);
          const fmt = (d: Date) =>
            d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
          const yearSuffix = end.getUTCFullYear();
          return `${fmt(start)} – ${fmt(end)} ${yearSuffix}`;
        })()
      : monthLabel;
  const today = todayInAppTz();

  // Per-week lane-packing. Each project that overlaps a week becomes a
  // single segment for that week (clipped to the visible Sun..Sat range)
  // with a lane index. Segments are rendered as absolutely-positioned
  // bars overlaid on the week row, so a multi-day project shows as ONE
  // continuous bar from start to end with the project name on it — not
  // a chain of per-cell pills. Bars wrap at week boundaries; the
  // clipLeft/clipRight flags drive the rounded-corner + chevron hint.
  // Layout constants for the per-week bar overlay. BAR_TOP_OFFSET puts the
  // bars below the day-number row; week mode's pill header needs a bigger one.
  const BAR_H = CALENDAR_BAR_H;
  const LANE_TOTAL = CALENDAR_LANE_TOTAL;
  const BAR_TOP_OFFSET = mode === "week" ? 52 : 24;
  // Compact month shows up to 3 project-event lanes per cell; extra bars fold
  // into "+N more". Tasks render separately (2 rows, pinned to the bottom).
  // Week mode + expand-all never cap — they show everything inline.
  const MAX_LANES = mode === "week" || expandAll ? Infinity : 3;
  // Compact month: every row is the SAME height — tall enough for 3 bars + 2
  // task rows (COMPACT_ROW_MIN), but stretched to fill the viewport when
  // there's room. If the month needs more than the viewport, the page scrolls
  // (and the wheel-to-change-month is disabled so scrolling works normally).
  const BAR_TOP_OFFSET_M = 24;
  const COMPACT_ROW_MIN =
    BAR_TOP_OFFSET_M +
    3 * 21 /* 3 bar lanes */ +
    16 /* project "+N more" line */ +
    (showTasks ? 70 : 8) /* 2 task rows when tasks shown, else just padding */;
  const compactRowH =
    mode === "month" && !expandAll
      ? Math.max(
          COMPACT_ROW_MIN,
          availH ? Math.floor((availH - 34) / Math.max(renderedWeeks, 1)) : COMPACT_ROW_MIN,
        )
      : null;
  return (
    <div>
      <PageHeader
        eyebrow="Operations · Projects"
        title="Calendar"
        dense
      />

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            const d = new Date(anchor);
            if (mode === "week") d.setUTCDate(d.getUTCDate() - 7);
            else d.setMonth(d.getMonth() - 1);
            setAnchor(d);
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary transition-colors hover:border-primary/40 hover:text-primary"
          title={mode === "week" ? "Previous week" : "Previous month"}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          onClick={() => {
            if (mode === "week") {
              const d = new Date();
              d.setUTCHours(0, 0, 0, 0);
              d.setUTCDate(d.getUTCDate() - d.getUTCDay());
              setAnchor(d);
            } else {
              const d = new Date();
              d.setDate(1);
              setAnchor(d);
            }
          }}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] text-ink-secondary transition-colors hover:border-primary/40 hover:text-primary"
        >
          Today
        </button>
        <button
          onClick={() => {
            const d = new Date(anchor);
            if (mode === "week") d.setUTCDate(d.getUTCDate() + 7);
            else d.setMonth(d.getMonth() + 1);
            setAnchor(d);
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface text-ink-secondary transition-colors hover:border-primary/40 hover:text-primary"
          title={mode === "week" ? "Next week" : "Next month"}
        >
          <ChevronRight size={16} />
        </button>
        <span className="ml-2 font-display text-[15px] font-bold leading-tight tracking-tight text-ink">{periodLabel}</span>

        {/* Month / Week toggle */}
        <div className="ml-3 inline-flex overflow-hidden rounded-md border border-border">
          {(["month", "week"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "px-3 py-1.5 text-[11px] font-semibold transition-colors",
                // Theme C: petrol is the FUNCTIONAL accent (active states);
                // brass is brand-only (owner 2026-07-23 calendar pass).
                mode === m
                  ? "bg-primary text-white"
                  : "bg-surface text-ink-secondary hover:bg-bg/50",
              )}
            >
              {m === "month" ? "Month" : "Week"}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Free-text search (owner 2026-07-20) — live-filters bars + task
              chips; URL-persisted (?q=). */}
          <label className="relative inline-flex h-8 items-center">
            <Search size={12} className="pointer-events-none absolute left-2 text-ink-muted" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search venue, organizer, brand…"
              className="h-8 w-56 rounded-md border border-border bg-surface pl-7 pr-6 text-[11px] text-ink-secondary outline-none transition-colors hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/15"
              title="Search events on the calendar"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-1 flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-bg/50 hover:text-ink"
                title="Clear search"
              >
                <X size={11} />
              </button>
            )}
          </label>
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="h-8 appearance-none rounded-md border border-border bg-surface pl-2 pr-7 text-[11px] text-ink-secondary outline-none transition-colors hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/15"
            title="Filter by brand"
          >
            <option value="">All brands</option>
            {(brandsQ.data?.data ?? []).map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
          <span className="relative inline-flex">
          <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-8 appearance-none rounded-md border border-border bg-surface pl-2 pr-7 text-[11px] text-ink-secondary outline-none transition-colors hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/15"
              title="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="confirmed">Confirmed</option>
              <option value="pending">Pending</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted" />
          </span>
          <span className="relative inline-flex">
          <select
              value={organizer}
              onChange={(e) => setOrganizer(e.target.value)}
              className="h-8 appearance-none rounded-md border border-border bg-surface pl-2 pr-7 text-[11px] text-ink-secondary outline-none transition-colors hover:border-primary/40 focus:border-primary focus:ring-2 focus:ring-primary/15"
              title="Filter by organizer"
            >
              <option value="">All organizers</option>
              {(organizersQ.data?.data ?? []).map((o) => (
                <option key={o.id} value={o.name}>
                  {o.name}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted" />
          </span>
          <ResetFiltersButton
            active={!!(brand || status || organizer || params.get("stage"))}
            onReset={() => {
              // Functional form so the latest URL state is read at call
              // time rather than the closure-captured `params` snapshot
              // — avoids losing later deletes when React re-renders
              // between paint and click. Also clears legacy `stage` key
              // that mig-050 retired but still sits in some sticky
              // storage entries.
              setParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  ["brand", "status", "organizer", "stage"].forEach((k) =>
                    next.delete(k)
                  );
                  return next;
                },
                { replace: true }
              );
            }}
          />
          {/* Tasks toggle button removed 2026-07-20 per owner request
              ("remove button task"). Task chips still render when the
              projects:cal:showTasks localStorage pref is true (default false);
              a one-line re-add of this <button> restores the toggle if needed. */}
          <button
            onClick={() => setShowHolidays(!showHolidays)}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
              showHolidays
                ? "border-primary/40 bg-primary-soft text-primary-ink"
                : "border-border bg-surface text-ink-muted hover:text-ink"
            )}
            title="Show Malaysian federal public holidays"
          >
            {showHolidays ? <Check size={12} /> : <Circle size={12} />} MY Holidays
          </button>
          {(brand || status || organizer) && (
            <button
              onClick={() => {
                setBrand("");
                setStatus("");
                setOrganizer("");
              }}
              className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted hover:text-err"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Status legend — bars are tinted by project status (mig 088). */}
      <div className="mb-1.5 flex flex-wrap items-center gap-3 text-[12px]">
        {STATUS_OPTIONS.map((s) => (
          <span key={s.value} className="inline-flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: s.hex }}
            />
            <span className="text-ink-muted">{s.label}</span>
          </span>
        ))}
        {mode === "month" && (
          <span className="ml-auto text-[10.5px] text-ink-muted">
            Tip: scroll over empty space to change month
          </span>
        )}
      </div>

      {q.loading && <div className="text-[12px] text-ink-muted">Loading calendar…</div>}
      {q.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-3 text-[12px] text-err">
          {q.error}
        </div>
      )}

      {/* The grid always fits its container: the 7 day columns shrink to
          the viewport width on mobile rather than scrolling horizontally. */}
      <div>
        <div ref={gridRef} className="rounded-md border border-border bg-surface">
        {/* Weekday header — month view only. In week view each cell
            renders its own "Day. DD/MM" header with a today pill, so
            this row would be redundant. */}
        {mode === "month" && (
          <div className="grid shrink-0 grid-cols-7 border-b border-border bg-bg/60">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div
                key={d}
                className="px-2 py-1.5 text-[12.5px] font-semibold uppercase tracking-wider text-ink-muted"
              >
                {d}
              </div>
            ))}
          </div>
        )}
        {/* 6 week rows. Each row is a relative grid so an absolute bar
            overlay can paint a single continuous pill from start col to
            end col on top of the day cells. */}
        {Array.from({ length: weekCount }).map((_, w) => {
          // Month mode shows only the current month's weeks — a week whose
          // every cell falls in an adjacent month is dropped entirely.
          if (
            mode === "month" &&
            !Array.from({ length: 7 }).some(
              (_, d) => cells[w * 7 + d].date.getUTCMonth() === anchor.getMonth()
            )
          ) {
            return null;
          }
          const segs = weekSegs[w];
          const barsAreaH = barsAreaHByWeek[w];
          // Compact month: every row is the SAME fixed height (compactRowH) —
          // an empty week (29/30) matches a busy one, and the height always
          // fits 3 bars + 2 task rows so they never overlap. Week / expand-all:
          // content-driven min-height so every bar + task shows inline.
          const rowMinHeight =
            mode === "week"
              ? BAR_TOP_OFFSET + barsAreaH + (showTasks ? 320 : 90)
              : expandAll
                ? BAR_TOP_OFFSET + barsAreaH + (showTasks ? 40 : 8)
                : 96;
          return (
            <div
              key={w}
              className="relative grid grid-cols-7"
              style={
                compactRowH != null
                  ? { height: compactRowH }
                  : { minHeight: rowMinHeight }
              }
            >
              {Array.from({ length: 7 }).map((_, d) => {
                const idx = w * 7 + d;
                const cell = cells[idx];
                // In week mode every cell is part of the active
                // window, so don't grey-out anything.
                const inMonth =
                  mode === "week"
                    ? true
                    : cell.date.getUTCMonth() === anchor.getMonth();
                const cellTasks = tasksByDate.get(cell.iso) ?? [];
                const isToday = cell.iso === today;
                const holidays = showHolidays ? getHolidaysOn(cell.iso) : [];
                const isHolidayCell = holidays.length > 0;
                const overflow = overflowByCell[idx];
                // Week-view per-day header label: "Su. 03/05".
                const weekHeaderLabel =
                  mode === "week"
                    ? `${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][cell.date.getUTCDay()]}. ${String(cell.date.getUTCDate()).padStart(2, "0")}/${String(cell.date.getUTCMonth() + 1).padStart(2, "0")}`
                    : null;
                // Adjacent-month cells render blank — only the current
                // month's dates carry content.
                if (mode === "month" && !inMonth) {
                  return (
                    <div
                      key={idx}
                      className="border-b border-r border-border bg-surface-dim/25"
                    />
                  );
                }
                return (
                  <div
                    key={idx}
                    className={cn(
                      "relative border-b border-r border-border text-[10px]",
                      mode === "week"
                        ? "px-2 py-2"
                        : expandAll
                          ? "px-1.5 py-1"
                          : "flex flex-col overflow-hidden px-1.5 py-1",
                      !inMonth && "bg-bg/40 text-ink-muted",
                      isHolidayCell && inMonth && "bg-[#e7e8f5]",
                      // Today highlight only on month view; week view
                      // moves the highlight onto the header pill so
                      // the cell body stays neutral. A brass inset ring +
                      // stronger tint makes today unmistakable.
                      mode === "month" && isToday && "bg-accent-soft/50 ring-1 ring-inset ring-accent/50",
                    )}
                    data-cal-content={
                      mode === "month" &&
                      (cellBarsH[idx] > 0 || cellTasks.length > 0 || isHolidayCell)
                        ? ""
                        : undefined
                    }
                  >
                    {mode === "week" ? (
                      // Week-mode header: centred "Day. DD/MM" with a
                      // filled accent pill on today's column.
                      <div className="mb-1.5 flex items-center justify-center">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-3 py-1 text-[12px] font-semibold",
                            isToday
                              ? "bg-primary text-white"
                              : "text-ink-secondary",
                          )}
                        >
                          {weekHeaderLabel}
                        </span>
                        {cellTasks.length > 0 && (
                          <DayCountBadge
                            count={cellTasks.length}
                            overdue={cellTasks.some((t) => t.is_overdue)}
                            className="ml-1"
                          />
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {isToday ? (
                          <span className="inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[13px] font-bold text-white">
                            {cell.date.getUTCDate()}
                          </span>
                        ) : (
                          <span className="shrink-0 text-[14px] font-semibold text-ink">
                            {cell.date.getUTCDate()}
                          </span>
                        )}
                        {/* Holiday marker sits right beside the date (deeper
                            tint than before so it reads at a glance). */}
                        {isHolidayCell && (
                          <span
                            className="min-w-0 truncate rounded bg-[#bcc0e6] px-1.5 py-0.5 text-[9.5px] font-semibold text-[#2b3063]"
                            title={holidays.map((h) => h.name).join(", ")}
                          >
                            {holidays[0].name}
                            {holidays.length > 1 && ` +${holidays.length - 1}`}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Reserved vertical space for the absolute bar overlay so
                        cell content (holiday + tasks) sits below this cell's
                        own bars. Month caps at the visible-lane count so the
                        overflowing bars don't reserve space ("+N more" instead). */}
                    <div
                      className="shrink-0"
                      style={{
                        height:
                          mode === "week" || expandAll
                            ? cellBarsH[idx]
                            : MAX_LANES * LANE_TOTAL,
                      }}
                      aria-hidden
                    />

                    {/* Bar overflow — month mode only (week mode has
                        unlimited lanes). Clicking expands the cell's
                        week into week view, showing every bar inline
                        without a popover. Old popover behaviour removed
                        per the team's request. */}
                    {mode === "month" && overflow > 0 && (
                      <button
                        type="button"
                        data-cal-content
                        onClick={(e) => {
                          e.stopPropagation();
                          setDayModalIso(cell.iso);
                        }}
                        className="block w-full pr-0.5 text-right text-[9px] font-semibold text-accent hover:underline"
                        title="Show every project + task on this day"
                      >
                        +{overflow} more
                      </button>
                    )}

                    {cellTasks.length > 0 && (
                      <div
                        data-cal-content
                        className={cn(
                          "space-y-0.5 border-t border-border-subtle pt-1",
                          // Compact month: pin tasks to the cell bottom so every
                          // cell's tasks line up on the last rows regardless of
                          // how many bars (or a "+N more") sit above.
                          mode === "month" && !expandAll
                            ? "absolute inset-x-1.5 bottom-1 z-20 bg-inherit"
                            : "mt-1",
                        )}
                      >
                        {/* Week mode shows every task — there's room.
                            Month mode keeps a 2-task cap + "+N more"
                            expander since cells are tighter. */}
                        {(mode === "week" || expandAll ? cellTasks : cellTasks.slice(0, 2)).map((t) => (
                          <CalendarTaskChip
                            key={t.id}
                            task={t}
                            onOpen={() => navigate(`/projects/${t.project_id}`)}
                            onHover={(e) => enterTaskHover(t, e.clientX, e.clientY)}
                            onMove={(e) => moveTaskHover(t, e.clientX, e.clientY)}
                            onLeave={leaveTaskHover}
                          />
                        ))}
                        {mode === "month" && !expandAll && cellTasks.length > 2 && (
                          <button
                            onClick={() => setDayModalIso(cell.iso)}
                            title={cellTasks
                              .slice(2)
                              .map((t) => `${t.project_code}: ${t.title}`)
                              .join("\n")}
                            className="block text-[9px] font-semibold text-accent hover:underline"
                          >
                            +{cellTasks.length - 2} more
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Bar overlay — one absolutely-positioned pill per
                  segment, spanning startCol..endCol. Pointer events
                  pass through the wrapper so the underlying cells stay
                  clickable; the bars themselves opt back in. */}
              <div
                className="pointer-events-none absolute left-0 right-0 z-10"
                style={{ top: BAR_TOP_OFFSET }}
                aria-hidden={false}
              >
                {segs.map((seg) => {
                  const span = seg.endCol - seg.startCol + 1;
                  const leftPct = (seg.startCol / 7) * 100;
                  const widthPct = (span / 7) * 100;
                  return (
                    <button
                      key={`${w}-${seg.project.id}-${seg.startCol}`}
                      onClick={() => navigate(`/projects/${seg.project.id}`)}
                      onMouseEnter={(e) =>
                        enterBarHover(seg.project, e.clientX, e.clientY)
                      }
                      onMouseMove={(e) =>
                        moveBarHover(seg.project, e.clientX, e.clientY)
                      }
                      onMouseLeave={leaveBarHover}
                      style={{
                        position: "absolute",
                        left: `calc(${leftPct}% + 4px)`,
                        width: `calc(${widthPct}% - 8px)`,
                        top: seg.lane * LANE_TOTAL,
                        height: BAR_H,
                        ...statusBarStyle(seg.project.status),
                      }}
                      className={cn(
                        "cal-bar pointer-events-auto truncate px-2 text-left text-[10.5px] font-semibold leading-[18px] hover:-translate-y-px",
                        seg.clipLeft ? "rounded-l-none" : "rounded-l-md",
                        seg.clipRight ? "rounded-r-none" : "rounded-r-md"
                      )}
                    >
                      {upcaseLeadingState(
                        (seg.project.event_type_name || "").toLowerCase() === "solo"
                          ? composeDefaultProjectName({
                              state: seg.project.state,
                              brand: seg.project.brand,
                              // Bars always say SOLO (owner 2026-08-19); organizer
                              // stays in the field / lists / stored names (08-17 rule).
                              organizer: null,
                              venue: seg.project.venue,
                              event_type_slug: "solo",
                            })
                          : seg.project.name,
                        seg.project.state,
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        </div>
      </div>

      {dayModalIso && (
        <CalendarDayModal
          iso={dayModalIso}
          projects={projects.filter((p) => {
            const s = p.start_date.slice(0, 10);
            const e = (p.end_date || p.start_date).slice(0, 10);
            return s <= dayModalIso && e >= dayModalIso;
          })}
          tasks={tasksByDate.get(dayModalIso) ?? []}
          holidays={showHolidays ? getHolidaysOn(dayModalIso) : []}
          onClose={() => setDayModalIso(null)}
          onOpenProject={(id) => {
            setDayModalIso(null);
            navigate(`/projects/${id}`);
          }}
        />
      )}

      {barHover && <CalendarBarPopover info={barHover} />}
      {taskHover && <CalendarTaskPopover info={taskHover} />}

    </div>
  );
}

// ── Calendar bar hover popover ───────────────────────────────
// A lightweight, cursor-anchored card showing a project's basic info
// when the pointer is over its calendar bar. Pointer-events-none so it
// never steals the hover; flips left/up near the viewport edges.
function CalendarBarPopover({
  info,
}: {
  info: { project: CalendarProject; x: number; y: number };
}) {
  const p = info.project;
  const opt = STATUS_BY_VALUE[p.status] ?? STATUS_BY_VALUE.pending;
  const fmt = (iso: string | null) => (iso ? fmtDate(iso) : null);
  const span =
    p.end_date && p.end_date.slice(0, 10) !== p.start_date.slice(0, 10)
      ? `${fmt(p.start_date)} – ${fmt(p.end_date)}`
      : fmt(p.start_date);
  const stage =
    p.active_section_name ??
    (p.sections_total ? "All sections complete" : null);

  // Anchor near the cursor, flipping when close to the right/bottom edge.
  const W = 268;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = info.x + W + 16 > vw ? info.x - W - 12 : info.x + 16;
  const top = Math.min(info.y + 14, vh - 190);

  const rows: Array<[string, string | null]> = [
    ["Brand", p.brand],
    ["Venue", p.venue],
    ["When", span],
    ["Organizer", p.organizer],
    ["Stage", stage],
  ];

  return createPortal(
    <div
      className="pointer-events-none fixed z-[60] w-[268px] rounded-md border border-border bg-surface p-3 shadow-slab"
      style={{ left, top }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-accent">
          {p.code}
        </span>
        <span
          className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{
            backgroundColor: `color-mix(in srgb, ${opt.hex} 15%, white)`,
            color: opt.hex,
          }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: opt.hex }} />
          {opt.label}
        </span>
      </div>
      <div className="mt-1 font-display text-[13px] font-bold leading-snug tracking-tight text-ink">
        {upcaseLeadingState(p.name, p.state)}
      </div>
      <div className="mt-2 space-y-1">
        {rows
          .filter(([, v]) => !!v)
          .map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px] leading-tight">
              <span className="w-[58px] shrink-0 text-ink-muted">{k}</span>
              <span className="min-w-0 flex-1 text-ink-secondary">{v}</span>
            </div>
          ))}
      </div>
    </div>,
    document.body
  );
}

// ── Calendar task-chip hover popover ─────────────────────────
// Cursor-anchored card for a checklist task chip: parent project, task
// title, due date, owner, and an overdue flag. Mirrors the project bar
// popover so both hovers feel consistent.
function CalendarTaskPopover({
  info,
}: {
  info: { task: CalendarTask; x: number; y: number };
}) {
  const t = info.task;
  const opt = STATUS_BY_VALUE[t.project_status ?? "pending"] ?? STATUS_BY_VALUE.pending;
  const overdue = t.is_overdue === 1;
  const due = (() => {
    return fmtDate(t.due_date);
  })();

  const W = 268;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = info.x + W + 16 > vw ? info.x - W - 12 : info.x + 16;
  const top = Math.min(info.y + 14, vh - 180);

  const rows: Array<[string, string | null]> = [
    ["Project", t.project_name],
    ["Due", due],
    ["Owner", t.owner_name || "Unassigned"],
  ];

  return createPortal(
    <div
      className="pointer-events-none fixed z-[60] w-[268px] rounded-md border border-border bg-surface p-3 shadow-slab"
      style={{ left, top }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-accent">
          {t.project_code}
        </span>
        {overdue ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-err/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-err">
            <span className="h-1.5 w-1.5 rounded-full bg-err" />
            Overdue
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
            style={{
              backgroundColor: `color-mix(in srgb, ${opt.hex} 15%, white)`,
              color: opt.hex,
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: opt.hex }} />
            {opt.label}
          </span>
        )}
      </div>
      <div className="mt-1 font-display text-[13px] font-bold leading-snug tracking-tight text-ink">
        {t.title}
      </div>
      <div className="mt-2 space-y-1">
        {rows
          .filter(([, v]) => !!v)
          .map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px] leading-tight">
              <span className="w-[58px] shrink-0 text-ink-muted">{k}</span>
              <span className="min-w-0 flex-1 text-ink-secondary">{v}</span>
            </div>
          ))}
      </div>
    </div>,
    document.body
  );
}

// ── Calendar "+N more" day modal ─────────────────────────────
// Surfaces every project + task on a single day without forcing the
// user to swap into week view. Triggered by the month-view "+N more"
// expanders on bar and task overflow.

function CalendarDayModal({
  iso,
  projects,
  tasks,
  holidays,
  onClose,
  onOpenProject,
}: {
  iso: string;
  projects: CalendarProject[];
  tasks: CalendarTask[];
  holidays: Array<{ name: string; type?: string | null }>;
  onClose: () => void;
  onOpenProject: (id: number) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const heading = (() => {
    const [y, m, d] = iso.split("-");
    const weekday = new Date(Number(y), Number(m) - 1, Number(d))
      .toLocaleDateString("en-GB", { weekday: "long" });
    return `${weekday} ${fmtDate(iso)}`;
  })();

  // Portal into document.body so the fixed-position overlay escapes any
  // transformed ancestor (the calendar's transformed bar segments would
  // otherwise scope the "fixed" element to the calendar, not the
  // viewport — leaving the modal offscreen on long calendars).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="thin-scroll max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
              Day view
            </div>
            <h2 className="font-display text-[16px] font-extrabold tracking-tight text-ink">
              {heading}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full border border-border bg-bg/40 p-1.5 text-ink-secondary transition-colors hover:border-accent/50 hover:text-accent"
          >
            <X size={14} />
          </button>
        </div>

        {holidays.length > 0 && (
          <div className="mb-3 rounded-md border border-[#c9cbe3] bg-[#ecedf6] px-3 py-2 text-[12px] text-[#474d79]">
            <div className="text-[10px] font-semibold uppercase tracking-wider">
              Holiday
            </div>
            <div className="mt-0.5">{holidays.map((h) => h.name).join(", ")}</div>
          </div>
        )}

        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Projects · {projects.length}
        </div>
        {projects.length === 0 ? (
          <div className="mb-4 rounded-md border border-dashed border-border px-3 py-3 text-[12px] text-ink-muted">
            No projects on this day.
          </div>
        ) : (
          <ul className="mb-4 divide-y divide-border-subtle rounded-md border border-border">
            {projects.map((p) => {
              const opt = STATUS_BY_VALUE[p.status] ?? STATUS_BY_VALUE.pending;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => onOpenProject(p.id)}
                    className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-bg/40"
                  >
                    <span
                      className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: opt.hex }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium text-ink">
                        {upcaseLeadingState(p.name, p.state)}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                            opt.chip
                          )}
                        >
                          {opt.label}
                        </span>
                        {p.brand && (
                          <span className="shrink-0 font-mono text-ink-muted">
                            {p.brand}
                          </span>
                        )}
                        {p.venue && (
                          <span className="min-w-0 truncate text-ink-secondary">
                            · {p.venue}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {tasks.length > 0 && (
          <>
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Tasks due · {tasks.length}
            </div>
            {/* Grouped by project so the (long) project code shows once as a
                section header instead of repeating on every task row. */}
            <div className="space-y-2.5">
              {(() => {
                const groups: Array<{
                  id: number;
                  code: string;
                  name: string;
                  status: ProjectStatus | null;
                  items: CalendarTask[];
                }> = [];
                const byId = new Map<number, (typeof groups)[number]>();
                for (const t of tasks) {
                  let g = byId.get(t.project_id);
                  if (!g) {
                    g = {
                      id: t.project_id,
                      code: t.project_code,
                      name: t.project_name,
                      status: t.project_status,
                      items: [],
                    };
                    byId.set(t.project_id, g);
                    groups.push(g);
                  }
                  g.items.push(t);
                }
                return groups.map((g) => {
                  const opt =
                    STATUS_BY_VALUE[g.status ?? "pending"] ??
                    STATUS_BY_VALUE.pending;
                  return (
                    <div
                      key={g.id}
                      className="overflow-hidden rounded-md border border-border"
                    >
                      <button
                        onClick={() => onOpenProject(g.id)}
                        className="flex w-full items-center gap-2 border-b border-border-subtle bg-bg/50 px-3 py-2 text-left transition-colors hover:bg-bg/80"
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: opt.hex }}
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">
                          {g.name}
                        </span>
                        <span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-[9px] font-bold text-ink-muted">
                          {g.items.length}
                        </span>
                      </button>
                      <ul className="divide-y divide-border-subtle">
                        {g.items.map((t) => (
                          <li key={t.id}>
                            <button
                              onClick={() => onOpenProject(t.project_id)}
                              className="flex w-full items-center gap-2 px-3 py-2 pl-[26px] text-left transition-colors hover:bg-bg/40"
                            >
                              <span
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: t.is_overdue ? "#b23b3b" : "#cdc8b8" }}
                              />
                              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                                {t.title}
                              </span>
                              {t.owner_name && (
                                <span className="shrink-0 text-[10px] text-ink-muted">
                                  {t.owner_name}
                                </span>
                              )}
                              {t.is_overdue && (
                                <span className="shrink-0 rounded-full bg-err/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-err">
                                  Overdue
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                });
              })()}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

// ── Progress bar ─────────────────────────────────────────────

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="inline-flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-border">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            clamped >= 100 ? "bg-synced" : "bg-accent"
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="font-mono text-[11px] text-ink-secondary">{clamped}%</span>
    </div>
  );
}

// ── Create Panel ─────────────────────────────────────────────

function CreateProjectPanel({
  onClose,
  onCreated,
  toast,
  brands,
  eventTypes,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
  toast: ReturnType<typeof useToast>;
  brands: string[];
  eventTypes: EventType[];
}) {
  // Owner 2026-08-19: the Ownership/PIC section is REMOVED from creation
  // (supersedes the 2026-07-18/07-21 back-and-forth on who may assign at
  // create). The creator does not know the PIC — only the Sales Director
  // does, and they assign it AFTER creation on the detail page (which also
  // surfaces the "Set Sales PIC" duty in their My Pending while it is
  // empty). Projects are therefore always created unassigned; row scope
  // falls back to created_by via COALESCE(p.pic_id, p.created_by).
  const [eventTypeId, setEventTypeId] = useState<string>("");
  const [brand, setBrand] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [venue, setVenue] = useState("");
  // State is derived from the picked venue (project_venues stores it).
  // Not user-editable — the venue is the single source of truth.
  const [stateName, setStateName] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const eventTypeSlug =
    eventTypes.find((t) => String(t.id) === eventTypeId)?.slug ?? null;

  // Name is fully derived — user can't override.
  const derivedName = composeDefaultProjectName({
    state: stateName,
    brand,
    organizer,
    venue,
    event_type_slug: eventTypeSlug,
  });

  const dateInvalid = !!(startDate && endDate && endDate < startDate);

  // The backend derives the project code from state/venue/brand and
  // throws when any are missing. Validate all three client-side so the
  // user gets a clear inline message instead of a server round-trip.
  async function submit() {
    if (!brand) {
      toast.error("Brand is required");
      return;
    }
    if (!venue.trim()) {
      toast.error("Venue is required");
      return;
    }
    if (!stateName.trim()) {
      toast.error("This venue has no state set. Open Project Maintenance → Venues and add one.");
      return;
    }
    if (!derivedName.trim()) {
      toast.error("Pick a venue so a name can be derived");
      return;
    }
    if (dateInvalid) {
      toast.error("End date must be on or after start date");
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<{ id: number; code: string }>("/api/projects", {
        name: derivedName.trim(),
        event_type_id: eventTypeId ? parseInt(eventTypeId, 10) : undefined,
        brand: brand || undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        venue: venue.trim(),
        state: stateName.trim() || undefined,
        organizer: organizer.trim() || undefined,
      });
      toast.success(`Created ${res.code}`);
      onCreated(res.id);
    } catch (e: any) {
      toast.error(e?.message || "Failed to create");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title="New Project"
      subtitle="Picking an event type pre-loads the default checklist"
      width={480}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary"
          >
            Cancel
          </button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={
              submitting ||
              !brand ||
              !venue.trim() ||
              !stateName.trim() ||
              !derivedName.trim() ||
              dateInvalid
            }
          >
            {submitting ? "Creating…" : "Create Project"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Basics">
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Project Name
          </div>
          <div className="w-full rounded-md border border-dashed border-border bg-bg px-3 py-2 text-[13px] text-ink-secondary">
            {derivedName || (
              <span className="text-ink-muted">
                Pick brand, organizer and venue to derive…
              </span>
            )}
          </div>
          <div className="mt-1 text-[10px] text-ink-muted">
            Auto-derived: <span className="font-mono">{"{state} [{brand}] {organizer | SOLO} @ {venue}"}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Event Type
            </div>
            <select
              value={eventTypeId}
              onChange={(e) => setEventTypeId(e.target.value)}
              className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">— none —</option>
              {eventTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Brand<span className="ml-1 text-err">*</span>
            </div>
            <select
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">— pick a brand —</option>
              {brands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            {brands.length === 0 && (
              <div className="mt-1 text-[10px] text-warning-text">
                No brands configured yet. Add one under Project Maintenance → Brands.
              </div>
            )}
          </div>
        </div>
      </PanelSection>

      <PanelSection title="Dates">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Start
            </div>
            <DateField
              fullWidth
              value={startDate}
              onChange={(iso) => setStartDate(iso)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            />
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              End
            </div>
            <DateField
              fullWidth
              value={endDate}
              min={startDate || undefined}
              onChange={(iso) => setEndDate(iso)}
              className={cn(
                "w-full rounded-md border bg-surface px-3 py-2 text-[13px]",
                dateInvalid ? "border-err" : "border-border"
              )}
            />
          </div>
        </div>
        {dateInvalid && (
          <div className="text-[11px] text-err">
            End date must be on or after the start date.
          </div>
        )}
      </PanelSection>

      <PanelSection title="Venue">
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Venue<span className="ml-1 text-err">*</span>
          </div>
          <VenuePicker
            value={venue || null}
            onChange={(v) => {
              setVenue(v ?? "");
              if (!v) setStateName("");
            }}
            onStateHint={(s) => setStateName(s ?? "")}
          />
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            State<span className="ml-1 text-err">*</span>
          </div>
          <select
            value={stateName}
            onChange={(e) => setStateName(e.target.value)}
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="">— pick a state —</option>
            {stateName && !(PROJECT_STATES as readonly string[]).includes(stateName) && (
              <option value={stateName}>{stateName}</option>
            )}
            {PROJECT_STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <div className="mt-1 text-[10px] text-ink-muted">
            Auto-fills from the venue's record. Override here if the venue
            doesn't have one set yet — fix it later in Project Maintenance → Venues.
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Organizer
          </div>
          <OrganizerPicker
            value={organizer}
            onChange={(v) => setOrganizer(v ?? "")}
          />
        </div>
      </PanelSection>

      {/* Ownership/PIC section removed at creation (owner 2026-08-19) — the
          Sales Director assigns the PIC on the detail page after creation. */}
    </Panel>
  );
}

// ── Detail Panel ─────────────────────────────────────────────

function ProjectDetailContent({
  id,
  onUpdated,
  toast,
  brands,
  eventTypes,
}: {
  id: number;
  onUpdated: () => void;
  toast: ReturnType<typeof useToast>;
  brands: string[];
  eventTypes: EventType[];
}) {
  const { can, user } = useAuth();
  const dialog = useDialog();
  /* Declared above the loading / error early returns so the hook count is
     stable; the Print preview it drives renders down in the header row. */
  const projectPrint = usePrintPreview(async () => {
    try {
      await api.openHtml(`/api/projects-print/${id}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to open print view");
    }
  });
  const detail = useQuery<ProjectDetail>("/api/projects/:", () => api.get(`/api/projects/${id}`), [id]);
  // Users list — fetched once per open panel, reused for owner pickers
  // in the logistics section, checklist add form, and reassign dropdowns.
  const usersQ = useQuery<{ id: number; name: string }[]>("/api/users#unwrapped",
    () => api.get<any>("/api/users").then((r: any) => r.users ?? r.data ?? r ?? []),
    []
  );
  const users = usersQ.data ?? [];
  // Defect action timeline (owner 2026-07-29) — who may stamp Ongoing/Done on
  // defect uploads: the purchaser (Sim), BD, and wildcard/manage admins.
  const defectActionsValue = useMemo(
    () => ({
      actions: (((detail.data as any)?.checklist_attachment_actions ?? []) as AttachmentAction[]),
      // Two-stage defect triage (owner 2026-08-07):
      //  - canReview  = the defect reviewer for THIS project's state (owner
      //    2026-08-11 two-warehouse split): Nancy (Ops Exec role) for the region
      //    states, Shukor (Storekeeper Supervisor) for every other state; admin
      //    always. Triages a fresh defect: Done (cleaned) or Replace (escalate).
      //  - canPurchase = purchaser (Sim / Farra) / BD or admin — closes an
      //    escalated (Replace) defect with Done once the replacement is ordered.
      canReview: (() => {
        if (!user) return false;
        const perms = user.permissions ?? [];
        if (perms.includes("*") || perms.includes("projects.manage")) return true;
        const region = new Set(["pulau pinang", "kelantan", "terengganu", "perak"]);
        const inRegion = region.has(((detail.data as any)?.project?.state ?? "").trim().toLowerCase());
        const isShukor = /^storekeeper supervisor$/i.test((user.position_name ?? "").trim());
        const isNancy = /^ops exec$/i.test((user.role_name ?? "").trim());
        return (isShukor && !inRegion) || (isNancy && inRegion);
      })(),
      canPurchase:
        !!user &&
        (user.permissions?.includes("*") ||
          user.permissions?.includes("projects.manage") ||
          /purchaser|bd/i.test(user.role_name ?? "")),
      reload: () => detail.reload(),
    }),
    [detail, detail.data, user],
  );
  const [transitioning, setTransitioning] = useState(false);
  const [addItemOpen, setAddItemOpen] = useState(false);
  // Archive / Restore split-dropdown (owner 2026-07-29): one control that
  // exposes BOTH actions, so Restore (unarchive) is discoverable even from a
  // project that isn't archived — no more "the Restore button isn't there".
  const [archiveMenuOpen, setArchiveMenuOpen] = useState(false);

  const p = detail.data?.project;

  // PIC picker source — ALL Sales-department members, regardless of
  // brand (owner: Option A). The backend ?department= filter matches the
  // dept name case-insensitively/by-substring (prod = "Sales Department"),
  // and the PIC-save brand gate is brand-relaxed for Sales-dept members.
  const picUsersQ = useQuery<{ users: Array<{ id: number; name: string | null; email: string; phone?: string | null }> }>("/api/users?department=:",
    () => api.get(`/api/users?department=${encodeURIComponent("Sales")}`),
    []
  );
  const picUsers = picUsersQ.data?.users ?? [];
  const checklist = detail.data?.checklist ?? [];
  const activity = detail.data?.activity ?? [];
  const trips = detail.data?.trips ?? [];
  const attachments = detail.data?.attachments ?? [];

  // PIC-only panels (Payment, Logistics, Stock Transfers, Finance Ledger) are
  // hidden when the viewer is a scoped rep. The backend returns
  // _access.level = "limited" in that case and also omits the underlying finance
  // data, so there's nothing to show anyway.
  //
  // ALL of these now come from the ONE fail-closed reader (auth/projectAccess).
  // They used to read the raw payload with `!_access || …` and `pms ? … : true`,
  // which made a MISSING permission payload mean FULL ACCESS. See the header of
  // projectAccess.ts for what each fallback granted.
  const access = readProjectAccess(detail.data);
  const accessUnresolved = projectAccessUnresolved(detail.data);
  const fullAccess = access.full;
  // Both terms kept (it was `fullAccess && pms.canEdit`) so this stays exactly
  // as narrow as before for a RESOLVED payload; only the unresolved case moves,
  // and it moves from "true" to "false".
  const canEditDetail = fullAccess && access.canEdit;
  // Owner 2026-07-18: PIC assignment AND Sales-Attending assignment are open to
  // EVERYONE holding projects.write EXCEPT the Sales Director. This SUPERSEDES
  // the earlier director/logistics (pms.canEdit) + own-PIC gates on these two
  // pickers — every other project edit (spec strip, checklist) keeps its own
  // canEditDetail gate untouched. Sales Director matched by EXACT normalised
  // name (isSalesDirectorUser), never a \b substring, so a free-text rename
  // can't drift the block. Backend re-enforces the same rule on PATCH pic_id +
  // POST/DELETE sales-attendees — this is UX/defence-in-depth only.
  // Owner 2026-07-21: Sales-Director block reversed — projects.write is enough.
  const canAssignPeople = fullAccess && can("projects.write");
  const canEditAttending = canAssignPeople;

  async function patch(body: Record<string, any>) {
    const res = await api.patch<{ shifted_tasks?: number; delta_days?: number }>(
      `/api/projects/${id}`,
      body
    );
    if (res?.shifted_tasks && res.shifted_tasks > 0) {
      const days = res.delta_days ?? 0;
      const direction = days > 0 ? "forward" : "back";
      toast.success(
        `Shifted ${res.shifted_tasks} task${res.shifted_tasks === 1 ? "" : "s"} ` +
          `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${direction}`
      );
    }
    detail.reload();
    onUpdated();
  }

  async function transition(stage: ProjectStage) {
    setTransitioning(true);
    try {
      await patch({ stage });
    } catch (e: any) {
      toast.error(e?.message || "Transition failed");
    } finally {
      setTransitioning(false);
    }
  }

  async function setItemStatus(item: ChecklistItem, status: ChecklistStatus) {
    // 07-15: silent no-op, never a permission toast. 08-17 (0488): the key
    // gates only non-na/pending. 08-21 (0489): keyless N/A is scoped to the
    // BADGED function — write does not extend it; projects.manage may.
    if (!can("projects.write") && !can("projects.checklist.tick")) return;
    if (item.required_perm && !holdsChecklistApproval(user?.permissions, item.required_perm)) {
      if (status !== "na" && status !== "pending") return;
      const badge = (item.role_label || "").trim().toUpperCase();
      const role = (user?.role_name || "").trim().toUpperCase();
      const admits = !badge || badge.split("&").some((s) => {
        const l = s.trim();
        return l === role || (l === "DRIVER" && (role === "HELPER" || role === "STOREKEEPER"));
      });
      if (!admits && !can("projects.manage")) return;
    }
    try {
      await api.post(`/api/projects/checklist/${item.id}/status`, { status });
      detail.reload();
      onUpdated();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function deleteItem(item: ChecklistItem) {
    if (!await dialog.confirm(`Remove "${item.title}"?`)) return;
    try {
      await api.del(`/api/projects/checklist/${item.id}`);
      detail.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Projects", to: "/projects" },
        { label: p?.name || "Loading…" },
      ]}
      eyebrow="Project"
      title={p?.name || "Loading…"}
      description={p ? `${STAGE_LABEL[p.stage]}${p.brand ? ` · ${p.brand}` : ""}${p.venue ? ` · ${p.venue}` : ""}${p.duration_days ? ` · ${p.duration_days} day${p.duration_days === 1 ? "" : "s"}` : ""}` : undefined}
      // Owner 2026-07-29: keep the event title (+ actions) pinned while
      // scrolling the project detail — same sticky chrome ASSR detail uses.
      stickyTitle
      backTo="/projects"
      loading={detail.loading && !p}
      error={detail.error}
      actions={
        p ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Both items POST /:id/archive|/unarchive = projects.manage. Their
                `disabled` is STATE, never permission; the button carries the gate. */}
            {can("projects.manage") && (
            <div className="relative">
              <HeaderButton variant="ghost" onClick={() => setArchiveMenuOpen((o) => !o)}>
                {p.archived_at ? "Restore" : "Archive"} <ChevronDown size={12} />
              </HeaderButton>
              {archiveMenuOpen && (
                <>
                  {/* click-outside backdrop */}
                  <div className="fixed inset-0 z-30" onClick={() => setArchiveMenuOpen(false)} />
                  <div className="absolute right-0 z-40 mt-1 min-w-[150px] rounded-md border border-border bg-surface py-1 text-[12px] shadow-lg">
                    <button
                      className="flex w-full items-center px-3 py-1.5 text-left hover:bg-bg/60 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!!p.archived_at}
                      title={p.archived_at ? "Already archived" : undefined}
                      onClick={async () => {
                        setArchiveMenuOpen(false);
                        if (!(await dialog.confirm("Archive this project?"))) return;
                        try {
                          await api.post(`/api/projects/${id}/archive`);
                          toast.success("Archived");
                          detail.reload();
                          onUpdated();
                        } catch (e: any) {
                          toast.error(e?.message || "Something went wrong. Please try again.");
                        }
                      }}
                    >
                      Archive
                    </button>
                    <button
                      className="flex w-full items-center px-3 py-1.5 text-left hover:bg-bg/60 disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={!p.archived_at}
                      title={!p.archived_at ? "Only an archived project can be restored" : undefined}
                      onClick={async () => {
                        setArchiveMenuOpen(false);
                        try {
                          await api.post(`/api/projects/${id}/unarchive`);
                          toast.success("Restored");
                          detail.reload();
                          onUpdated();
                        } catch (e: any) {
                          toast.error(e?.message || "Something went wrong. Please try again.");
                        }
                      }}
                    >
                      Restore
                    </button>
                  </div>
                </>
              )}
            </div>
            )}
            <HeaderButton variant="ghost" onClick={projectPrint.openPreview}>
              <Printer size={12} /> Print
            </HeaderButton>
            {/* Same Print preview the rest of the app opens. A project prints
                from a SERVER-rendered HTML view, so there is no PDF file to
                download here — Print hands over to that view. */}
            <PrintPreviewModal
              open={projectPrint.open}
              onClose={projectPrint.close}
              docTitle="Project"
              docNo={p.code ?? String(id)}
              rows={[
                { label: "Project", value: p.name || "—" },
                { label: "Status", value: p.status || "—" },
                { value: "Print now opens the print view in a new tab." },
              ]}
              onPrint={projectPrint.handlers.onPrint}
            />
            {/* PATCH /:id = projects.write; canEditDetail is the PMS-EDIT term
                mobile also carries (owner 2026-07-20) and was never applied here. */}
            {can("projects.write") && canEditDetail && !p.archived_at && (
              <ProjectStatusSelect
                value={p.status}
                disabled={transitioning}
                onChange={async (next) => {
                  setTransitioning(true);
                  try {
                    await patch({ status: next });
                  } catch (e: any) {
                    toast.error(e?.message || "Failed to update status");
                  } finally {
                    setTransitioning(false);
                  }
                }}
              />
            )}
          </div>
        ) : undefined
      }
    >
      {detail.loading && (
        <div className="space-y-4 p-6">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <ListSkeleton rows={5} />
        </div>
      )}
      {detail.error && !detail.loading && (
        <div className="m-5 rounded-md border border-err/40 bg-err/5 p-4 text-sm">
          <div className="font-semibold text-err">Failed to load project</div>
          <div className="mt-1 text-[12px] text-ink-secondary break-words">{detail.error}</div>
        </div>
      )}
      {p && (
        <>
          {/* The project loaded but carried NO permission payload. Every
              section gate above therefore reads false and most of this page is
              missing. That is the safe answer, but silently hiding half a page
              is the outage nobody reports — people stop using the feature and
              never file a ticket. Say which of the two it is: "we couldn't load
              your permissions" sends an operator to IT, "you don't have
              permission" sends them to their manager. */}
          {accessUnresolved && (
            <ProjectBanner
              message="We couldn't load your permissions for this project, so some sections are hidden. This is a system problem, not a restriction on your account — please reload, and tell IT if it persists."
              tone="error"
            />
          )}

          {/* Banner — optional per-project warning */}
          {p.banner_message && <ProjectBanner message={p.banner_message} tone={p.banner_tone} />}

          {/* ── Stage progress (directly under page title) ──────────
             Per-section pills with completion tick + lead time chip.
             Print button lives in the title actions now. */}
          <div className="mb-4 border-b border-border-subtle pb-3">
            <StatusDot variant={stageVariant(p.stage)} label={STAGE_LABEL[p.stage]} />
            <div className="mt-3">
              {(detail.data?.section_progress ?? []).length > 0 ? (
                <ProjectStageStepper checklist={checklist} startDate={p.start_date} setupCrew={p.setup_crew} setupStartAt={p.setup_start_at} />
              ) : (
                <ProgressBar pct={p.progress_pct ?? 0} />
              )}
            </div>
          </div>

          {/* ── Project spec strip ──────────────────────────────────
             Editorial titleblock-style metadata grid. Sits under the
             stage row. Each cell hosts an InlineEdit or read-only
             field — no PanelSection chrome (the team called the old
             card grid "weird / too heavy"). */}
          <ProjectSpecStrip
            project={p}
            brands={brands}
            eventTypes={eventTypes}
            fullAccess={canEditDetail}
            patch={patch}
            financeLines={detail.data?.finance_lines ?? []}
            onFinanceChange={() => detail.reload()}
            toast={toast}
          />
          {/* Payment status now lives in the checklist as the "Rental
              Payment" pill row (PAYMENT section) — see mig 090. The old
              standalone Payment panel was removed at the boss's request. */}

          {/* Operational area — Chat on the side; Sales / Tasklist /
              Logistics / Finance Ledger stacked in Main (Finance at the
              bottom; Logistics directly above it per the team's request). */}
          <DefectActionsCtx.Provider value={defectActionsValue}>
          <DetailGrid>
            <DetailMain>
              <ProjectSalesEntriesSection
                projectId={id}
                projectCode={p.code}
                projectName={p.name}
                canManage={can("sales.manage")}
                currentTotalSales={detail.data?.finance?.total_sales ?? null}
                onTotalSaved={() => detail.reload()}
                toast={toast}
              />

              <TasklistSections
                projectId={id}
                projectStartDate={p.start_date}
                projectEndDate={p.end_date}
                checklist={checklist}
                sections={detail.data?.sections ?? []}
                sectionProgress={detail.data?.section_progress ?? []}
                attachments={detail.data?.checklist_attachments ?? []}
                comments={detail.data?.checklist_comments ?? []}
                users={users}
                canTick={can("projects.write") || can("projects.checklist.tick")}
                canManage={can("projects.write")}
                addItemOpen={addItemOpen}
                setAddItemOpen={setAddItemOpen}
                onReload={() => detail.reload()}
                onItemStatus={setItemStatus}
                onItemDelete={deleteItem}
                toast={toast}
              />

              {/* Setup & Dismantle (crew-per-lorry editor + phase photos).
                  Owner 2026-07-15: hidden entirely from non-director Sales —
                  even this project's PIC — via the PMS SETUP_DISMANTLE flag.
                  Layered ON TOP of the existing fullAccess gate so no other
                  role's visibility widens; the new flag only SUBTRACTS. When
                  hidden it renders NOTHING (off, not read-only): the
                  /api/fleet/staff + /api/scm/lorries + phase-photos fetches
                  never fire. An UNRESOLVED payload now hides it too — it used to
                  fall back to `true`, i.e. show. */}
              {fullAccess && access.canSetupDismantle && (
                <>
                  <LogisticsCrewSection project={p} patch={patch} />
                  <PhasePhotosSection projectId={id} />
                </>
              )}
              {/* Finance Ledger + Financial Snapshot: DIRECTOR-level only.
                  The backend NULLs finance data for non-directors, so this
                  gate keeps a sales PIC from seeing an empty finance shell.

                  This was `pms ? pms.canFinancial : fullAccess`. The fallback
                  was not just fail-open, it was fail-open to the WRONG COHORT:
                  `fullAccess` is the ROW tier (PIC on this project), which every
                  project's own PIC satisfies, while canFinancial is the SECTION
                  tier (isFinanceViewer). An unresolved payload therefore opened
                  the Finance Ledger to every PIC. It now closes. */}
              {access.canFinancial && (
                <FinanceLedgerSection
                  projectId={id}
                  sizeSqm={p.size_sqm ?? null}
                  durationDays={p.duration_days ?? null}
                  lines={detail.data?.finance_lines ?? []}
                  lumpSales={detail.data?.finance?.total_sales ?? null}
                  onChange={() => detail.reload()}
                  toast={toast}
                />
              )}
            </DetailMain>

            <DetailAside>
              <ProjectTeamSection
                projectId={id}
                project={p}
                attendees={detail.data?.sales_attendees ?? []}
                picUsers={picUsers}
                picUsersLoading={picUsersQ.loading}
                canEditPic={canAssignPeople}
                canEditAttending={canEditAttending}
                patch={patch}
                onChanged={() => detail.reload()}
                toast={toast}
              />
              <PanelSection title="Chat">
                <ProjectChat
                  projectId={id}
                  activity={activity}
                  canPost={can("projects.write") || can("projects.chat")}
                  onPosted={() => detail.reload()}
                  toast={toast}
                />
              </PanelSection>
            </DetailAside>
          </DetailGrid>
          </DefectActionsCtx.Provider>
        </>
      )}
    </DetailLayout>
  );
}

// ── ProjectTeamSection ────────────────────────────────────────────
// Lives in the right sidebar above Chat. Carries the project's PIC
// (one User, the project owner) plus the list of sales reps who'll
// physically attend the event (project_sales_attendees, mig 087).
// Both pickers list ALL Sales-department members regardless of brand
// (owner: Option A): PIC = Sales-dept users (GET /api/users?department=Sales),
// attendees = active sales_person reps (GET /api/projects/sales-rep-options).

interface SalesRepBrief {
  id: number;
  code: string;
  name: string;
  phone?: string | null;
  brands?: string[];
  brands_csv?: string | null;
}

function ProjectTeamSection({
  projectId,
  project: p,
  attendees,
  picUsers,
  picUsersLoading,
  canEditPic,
  canEditAttending,
  patch,
  onChanged,
  toast,
}: {
  projectId: number;
  project: ProjectDetail["project"];
  attendees: SalesAttendee[];
  picUsers: Array<{ id: number; name: string | null; email: string }>;
  picUsersLoading: boolean;
  /** Owner 2026-07-18: may this user (re)assign the PIC — open to every
   *  projects.write holder EXCEPT the Sales Director. */
  canEditPic: boolean;
  /** Owner 2026-07-18: may this user change Sales Attending — same
   *  everyone-except-Sales-Director rule as canEditPic. */
  canEditAttending: boolean;
  patch: (body: Record<string, any>) => Promise<void>;
  onChanged: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  // Sales-attending picker — gated on projects.write, role-filtered to
  // sales_person. Brand-relaxed (owner: Option A): lists ALL active
  // Sales Persons regardless of brand. See GET /api/projects/sales-rep-options.
  const repsQ = useQuery<{ data: SalesRepBrief[] }>("/api/projects/sales-rep-options",
    () => api.get(`/api/projects/sales-rep-options`),
    []
  );
  // Alphabetical by NAME (owner 2026-07-28) — was code order (SR-004, SR-005…);
  // the SR-xxx code is just a stable id and does NOT need to be renumbered.
  const reps = [...(repsQ.data?.data ?? [])].sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? ""),
  );
  const takenRepIds = new Set(attendees.map((a) => a.sales_rep_id));
  const availableReps = reps.filter((r) => !takenRepIds.has(r.id));
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const filteredAvailable = availableReps.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (r.code ?? "").toLowerCase().includes(q) ||
      (r.name ?? "").toLowerCase().includes(q)
    );
  });

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Owner 2026-06-25: multi-select — tick several reps + add them in one go
  // (was one-at-a-time). POSTs each selected id sequentially, then reloads once.
  async function addSelected() {
    const ids = [...selected].filter((id) => availableReps.some((r) => r.id === id));
    if (ids.length === 0) return;
    setBusy(true);
    try {
      for (const repId of ids) {
        await api.post(`/api/projects/${projectId}/sales-attendees`, {
          sales_rep_id: repId,
        });
      }
      setSelected(new Set());
      setSearch("");
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Failed to add");
    } finally {
      setBusy(false);
    }
  }

  async function removeRep(a: SalesAttendee) {
    const label = a.rep_name || a.user_name || `Rep #${a.sales_rep_id}`;
    const ok = await dialog.confirm({
      title: "Remove from attendance?",
      message: `${label} will no longer be listed as attending this project.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(
        `/api/projects/${projectId}/sales-attendees/${a.sales_rep_id}`
      );
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || "Failed to remove");
    }
  }

  return (
    <PanelSection title="Project Team">
      {/* PIC row */}
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
          <UserCircle2 size={11} /> PIC
        </div>
        {canEditPic ? (
          <>
            <select
              value={p.pic_id ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                patch({ pic_id: v ? parseInt(v, 10) : null });
              }}
              className={SPEC_INPUT_CLASS}
            >
              <option value="">— unassigned —</option>
              {p.pic_id != null && p.pic_name &&
                !picUsers.some((u) => u.id === p.pic_id) && (
                  <option value={p.pic_id}>
                    {p.pic_name} (out of scope)
                  </option>
                )}
              {picUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
            {p.pic_phone && (
              <div className="mt-1 flex items-center gap-1 text-[11px] text-ink-secondary">
                <Phone size={11} /> {formatPhone(p.pic_phone)}
              </div>
            )}
            {picUsers.length === 0 && !picUsersLoading && (
              <div className="mt-1 text-[9.5px] leading-snug text-warning-text">
                No Sales-department members found.
              </div>
            )}
          </>
        ) : (
          <>
            <div className="text-[12.5px] font-medium text-ink">
              {p.pic_name || "—"}
            </div>
            {p.pic_phone && (
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-secondary">
                <Phone size={11} /> {formatPhone(p.pic_phone)}
              </div>
            )}
          </>
        )}
      </div>

      {/* Sales attending */}
      <div className="border-t border-border pt-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
          <Users size={11} /> Sales Attending
          <span className="ml-auto font-mono text-[9.5px] text-ink-muted">
            {attendees.length}
          </span>
        </div>
        {attendees.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {attendees.map((a) => (
              <span
                key={a.sales_rep_id}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-bg/60 py-0.5 pl-2 pr-0.5 text-[11px]"
                title={a.rep_code ?? undefined}
              >
                <span className="font-medium text-ink">
                  {a.rep_name || a.user_name || `#${a.sales_rep_id}`}
                </span>
                {a.rep_phone && (
                  <span className="font-mono text-[9px] text-ink-muted">
                    {formatPhone(a.rep_phone)}
                  </span>
                )}
                {a.rep_code && (
                  <span className="font-mono text-[9px] text-ink-muted">
                    {a.rep_code}
                  </span>
                )}
                {canEditAttending && (
                  <button
                    onClick={() => removeRep(a)}
                    aria-label={`Remove ${a.rep_name ?? "rep"}`}
                    className="rounded-full p-0.5 text-ink-muted hover:bg-err/10 hover:text-err"
                  >
                    <X size={11} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {canEditAttending && (
          <div className="mt-2">
            {/* Multi-select (owner 2026-06-25: "直接可以 multiselect 多选,不用
                一个一个按") — filter + tick several + "Add N" in one go. */}
            {reps.length === 0 ? (
              !repsQ.loading && (
                <div className="text-[9.5px] leading-snug text-warning-text">
                  No Sales Persons found. This picker reads the active Sales Reps
                  master (not the User Management member list). A rep is
                  auto-created when a user is assigned to the Sales department —
                  make sure that rep exists and is active (not archived).
                </div>
              )
            ) : availableReps.length === 0 ? (
              <div className="text-[11px] italic text-ink-muted">
                All sales reps added.
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter reps…"
                  className={SPEC_INPUT_CLASS}
                />
                <div className="mt-1 max-h-44 overflow-auto rounded-md border border-border">
                  {filteredAvailable.length === 0 ? (
                    <div className="px-2 py-2 text-[10.5px] text-ink-muted">
                      No matches.
                    </div>
                  ) : (
                    filteredAvailable.map((r) => (
                      <label
                        key={r.id}
                        className="flex cursor-pointer items-center gap-2 border-t border-border px-2 py-1.5 text-[11px] first:border-t-0 hover:bg-bg/60"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggleSelected(r.id)}
                        />
                        <span className="font-mono text-[9px] text-ink-muted">
                          {r.code}
                        </span>
                        <span className="truncate text-ink">{r.name}</span>
                        {r.phone && (
                          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-muted">
                            {formatPhone(r.phone)}
                          </span>
                        )}
                      </label>
                    ))
                  )}
                </div>
                <button
                  onClick={addSelected}
                  disabled={busy || selected.size === 0}
                  className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-md border border-accent/40 bg-surface px-2 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus size={11} /> Add{selected.size > 0 ? ` ${selected.size} selected` : ""}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </PanelSection>
  );
}

// ── ProjectSpecStrip ──────────────────────────────────────────────
// Editorial titleblock-style metadata grid. Read-only by default;
// click "Edit" in the header to reveal inputs/selects. The same
// editor classes are used across InlineSpecText / Date / Select /
// VenuePicker / OrganizerPicker so dropdowns look consistent.

// Shared className for every editable input in the strip — keeps
// dropdowns + text inputs + date inputs visually identical.
const SPEC_INPUT_CLASS =
  "w-full appearance-none rounded border border-border bg-surface px-2 py-1 text-[12.5px] font-medium text-ink outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";

// Quick Rental (RM) — writes a single `rental` cost line to the finance
// ledger (the same category the Financial Snapshot's Rental row edits),
// so keying rental here syncs the Rental row, Total Cost, Net Profit, the
// Rental KPI card, and the Project List "Rental (RM)" column. Saves on
// blur / Enter.
function QuickRentalField({
  projectId,
  financeLines,
  onSaved,
  toast,
}: {
  projectId: number;
  financeLines: FinanceLine[];
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const existing = financeLines.filter(
    (l) => l.kind === "cost" && (l.category ?? "").trim() === "rental" && !l.auto_source,
  );
  const current = existing.reduce((s, l) => s + (l.amount || 0), 0);
  const [val, setVal] = useState(current ? String(current) : "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setVal(current ? String(current) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const save = async () => {
    const trimmed = val.trim();
    const n = trimmed === "" ? 0 : parseFloat(trimmed);
    if (isNaN(n) || n < 0) {
      toast.error("Enter a valid rental amount");
      return;
    }
    if (Math.abs(n - current) < 0.005) return; // unchanged
    setSaving(true);
    try {
      if (n <= 0) {
        for (const l of existing) await api.del(`/api/projects/finance/lines/${l.id}`);
      } else if (existing.length === 1) {
        await api.patch(`/api/projects/finance/lines/${existing[0].id}`, { amount: n });
      } else {
        // 0 existing → create; >1 → consolidate the duplicates into one.
        for (const l of existing) await api.del(`/api/projects/finance/lines/${l.id}`);
        await api.post(`/api/projects/${projectId}/finance/lines`, {
          kind: "cost",
          category: "rental",
          amount: n,
          description: "Rental",
        });
      }
      toast.success("Rental updated");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed to save rental");
    } finally {
      setSaving(false);
    }
  };

  return (
    <input
      className={SPEC_INPUT_CLASS}
      type="number"
      inputMode="decimal"
      value={val}
      placeholder="—"
      disabled={saving}
      onChange={(e) => setVal(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/** Read the total m² off the project's uploaded Display Floor Plan (owner
 *  2026-08-04). The server does the reading; this is the manual trigger +
 *  result feedback. `overwrite=1` because pressing the button IS the operator
 *  asking to replace whatever is in the box. Shared with the automatic run
 *  that fires after a floorplan upload (see detectFloorplanSize). */
function DetectSizeButton({
  projectId,
  onDetected,
  toast,
}: {
  projectId: number;
  onDetected: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      title="Read the size off the uploaded Display Floor Plan"
      onClick={async () => {
        setBusy(true);
        try {
          const r = await detectFloorplanSize(projectId, true);
          if (r.detected_sqm != null) {
            toast?.success(
              `Read ${r.detected_sqm} sqm from ${r.source_file}${
                r.confidence && r.confidence !== "high" ? ` (${r.confidence} confidence — please check)` : ""
              }`,
            );
            onDetected();
          } else {
            toast?.error("Couldn't find a size on that floorplan — please type it in.");
          }
        } catch (e: any) {
          toast?.error(e?.message || "Couldn't read the floorplan.");
        } finally {
          setBusy(false);
        }
      }}
      className="shrink-0 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
    >
      {busy ? "Reading…" : "Auto"}
    </button>
  );
}

/** POST the detect-size call. Shared by the manual button and the automatic
 *  post-upload run so both behave identically. */
async function detectFloorplanSize(projectId: number, overwrite = false) {
  return api.post<{
    detected_sqm: number | null;
    applied: boolean;
    skipped_reason: string | null;
    method: string;
    evidence: string | null;
    confidence: string;
    source_file: string;
  }>(`/api/projects/${projectId}/floorplan/detect-size${overwrite ? "?overwrite=1" : ""}`, {});
}

function ProjectSpecStrip({
  project: p,
  brands,
  eventTypes,
  fullAccess,
  patch,
  financeLines,
  onFinanceChange,
  toast,
}: {
  project: ProjectDetail["project"];
  brands: string[];
  eventTypes: EventType[];
  fullAccess: boolean;
  patch: (body: Record<string, any>) => Promise<void>;
  /** Finance ledger lines — the quick Rental box reads/writes the
   *  `rental` cost line here so it stays in sync with the Financial
   *  Snapshot, Total Cost, Net Profit, and the Rental KPI/column. */
  financeLines: FinanceLine[];
  onFinanceChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [editing, setEditing] = useState(false);
  const slug = eventTypes.find((t) => t.id === p.event_type_id)?.slug ?? null;
  const suggested = composeDefaultProjectName({
    state: p.state,
    brand: p.brand,
    organizer: p.organizer,
    venue: p.venue,
    event_type_slug: slug,
  });
  const hasAutoSuggestion = suggested && suggested !== p.name;

  // Helper for resolving a foreign-key label so read mode shows the
  // human-readable name instead of an opaque id.
  const eventTypeLabel = p.event_type_id
    ? (eventTypes.find((t) => t.id === p.event_type_id)?.name ?? "—")
    : "—";

  return (
    <section className="mb-6">
      <header className="mb-2 flex items-center justify-between border-b border-border-strong pb-2">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Project Detail
          </h2>
        </div>
        {fullAccess && (
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[10.5px] font-semibold transition-colors",
              editing
                ? "border-primary bg-primary text-white hover:bg-primary-ink"
                : "border-border bg-surface text-ink hover:border-accent/40 hover:text-accent"
            )}
            title={editing ? "Lock edits" : "Edit project details"}
          >
            {editing ? (
              <>
                <Check size={11} /> Done
              </>
            ) : (
              <>
                <Pencil size={11} /> Edit
              </>
            )}
          </button>
        )}
      </header>
      <div
        className={cn(
          "grid grid-cols-1 divide-x divide-y divide-border-subtle border-y border-border-subtle md:grid-cols-2",
          // View mode = 5 key fields on one row; Edit mode = 4-col grid for all fields.
          editing ? "lg:grid-cols-4" : "lg:grid-cols-5",
        )}
      >
        {/* View mode shows only the key fields (Organizer, Start, End, Booth,
            Venue). Clicking Edit reveals every field. */}
        {editing && (<>
        <SpecCell label="Brand">
          {editing ? (
            <select
              value={p.brand ?? ""}
              onChange={(e) => {
                const newBrand = e.target.value || null;
                const updates: Record<string, any> = { brand: newBrand };
                // Keep the project title's [brand] tag in sync with the Brand.
                if (p.name && /\[[^\]]*\]/.test(p.name)) {
                  updates.name = newBrand
                    ? p.name.replace(/\[[^\]]*\]/, `[${newBrand}]`)
                    : p.name.replace(/\s*\[[^\]]*\]\s*/, " ").replace(/\s+/g, " ").trim();
                } else if (newBrand) {
                  updates.name = composeDefaultProjectName({
                    state: p.state,
                    brand: newBrand,
                    organizer: p.organizer,
                    venue: p.venue,
                    event_type_slug: slug,
                  });
                }
                patch(updates);
              }}
              className={SPEC_INPUT_CLASS}
            >
              <option value="">— none —</option>
              {brands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          ) : (
            <SpecValue>{p.brand ?? "—"}</SpecValue>
          )}
        </SpecCell>
        <SpecCell label="Event Type">
          {editing ? (
            <select
              value={p.event_type_id ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                patch({ event_type_id: v ? parseInt(v, 10) : null });
              }}
              className={SPEC_INPUT_CLASS}
            >
              <option value="">— none —</option>
              {eventTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : (
            <SpecValue>{eventTypeLabel}</SpecValue>
          )}
        </SpecCell>
        <SpecCell label="Created">
          <SpecValue muted>
            {formatDate(p.created_at)} · {p.created_by_name || "—"}
          </SpecValue>
        </SpecCell>

        <SpecCell label="Duration">
          <SpecValue>
            {p.duration_days != null
              ? `${p.duration_days} day${p.duration_days === 1 ? "" : "s"}`
              : "—"}
          </SpecValue>
        </SpecCell>
        </>)}
        <SpecCell label="Start">
          {editing ? (
            <DateField
              fullWidth
              value={p.start_date ?? ""}
              onChange={async (iso) => {
                const v = iso || null;
                if (v && p.end_date && p.end_date < v) {
                  // New start is past the current end — don't block; shift the
                  // whole event forward, keeping its length (owner reschedule).
                  const base = p.start_date ?? p.end_date;
                  const len = Math.max(0, Math.round((Date.parse(p.end_date + "T00:00:00Z") - Date.parse(base + "T00:00:00Z")) / 86400000));
                  const ne = new Date(v + "T00:00:00Z");
                  ne.setUTCDate(ne.getUTCDate() + len);
                  await patch({ start_date: v, end_date: ne.toISOString().slice(0, 10) });
                  return;
                }
                await patch({ start_date: v });
              }}
              className={SPEC_INPUT_CLASS}
            />
          ) : (
            <SpecValue mono>{p.start_date ?? "—"}</SpecValue>
          )}
        </SpecCell>
        <SpecCell label="End">
          {editing ? (
            <DateField
              value={p.end_date ?? ""}
              onChange={async (iso) => {
                const v = iso || null;
                if (v && p.start_date && v < p.start_date) {
                  // New end is before the current start — don't block; shift the
                  // whole event earlier, keeping its length (owner reschedule).
                  const base = p.end_date ?? p.start_date;
                  const len = Math.max(0, Math.round((Date.parse(base + "T00:00:00Z") - Date.parse(p.start_date + "T00:00:00Z")) / 86400000));
                  const ns = new Date(v + "T00:00:00Z");
                  ns.setUTCDate(ns.getUTCDate() - len);
                  await patch({ start_date: ns.toISOString().slice(0, 10), end_date: v });
                  return;
                }
                await patch({ end_date: v });
              }}
              className={SPEC_INPUT_CLASS}
            />
          ) : (
            <SpecValue mono>{p.end_date ?? "—"}</SpecValue>
          )}
        </SpecCell>
        <SpecCell label="Booth">
          <SpecTextField
            editing={editing}
            value={p.booth_no}
            placeholder="—"
            onChange={(v) => patch({ booth_no: v })}
          />
        </SpecCell>

        <SpecCell label="Venue *">
          {editing ? (
            <VenuePicker
              value={p.venue}
              onChange={(v) =>
                patch(v ? { venue: v } : { venue: null, state: null })
              }
              onStateHint={(s) => {
                if (s && s !== p.state) patch({ state: s });
              }}
              className={SPEC_INPUT_CLASS}
            />
          ) : (
            <SpecValue>{p.venue ?? "—"}</SpecValue>
          )}
        </SpecCell>
        {editing && (
        <SpecCell label="State">
          <SpecValue muted mono>{p.state ?? "—"}</SpecValue>
        </SpecCell>
        )}
        <SpecCell label="Organizer">
          {editing ? (
            <OrganizerPicker
              value={p.organizer}
              onChange={(v) => patch({ organizer: v })}
              className={SPEC_INPUT_CLASS}
            />
          ) : (
            <SpecValue>{p.organizer ?? "—"}</SpecValue>
          )}
        </SpecCell>
        {editing && (<>
        <SpecCell label="Size · sqm">
          <div className="flex items-center gap-1.5">
            <SpecTextField
              editing={editing}
              type="number"
              value={p.size_sqm}
              placeholder="—"
              onChange={(v) => patch({ size_sqm: v ? parseFloat(v) : null })}
            />
            {/* Read the m² off the uploaded Display Floor Plan (owner
                2026-08-04). Runs automatically right after a floorplan upload;
                this button re-runs it on demand (and overwrites, since the
                operator asked for it explicitly). */}
            <DetectSizeButton
              projectId={p.id}
              onDetected={onFinanceChange}
              toast={toast}
            />
          </div>
        </SpecCell>

        <SpecCell label="Rental · RM">
          <QuickRentalField
            projectId={p.id}
            financeLines={financeLines}
            onSaved={onFinanceChange}
            toast={toast}
          />
        </SpecCell>

        <SpecCell label="Name" span={p.start_date ? 2 : 3}>
          <SpecTextField
            editing={editing}
            value={p.name}
            placeholder="—"
            onChange={(v) => patch({ name: v })}
          />
          {editing && hasAutoSuggestion && (
            <button
              onClick={() => patch({ name: suggested! })}
              className="mt-1.5 inline-flex max-w-full items-center gap-1 truncate rounded border border-dashed border-accent/40 bg-accent-soft/20 px-1.5 py-0.5 text-[9.5px] font-semibold text-accent transition-colors hover:bg-accent-soft/40"
              title="Replace name with {state} [{brand}] {organizer | SOLO} @ {venue}"
            >
              <span className="truncate">↺ {suggested}</span>
            </button>
          )}
        </SpecCell>
        {p.start_date && (
          <SpecCell label="Add to Calendar">
            <a
              href={googleCalendarUrl(p)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink hover:text-accent"
            >
              <Calendar size={11} /> Google Calendar
              <ExternalLink size={9} />
            </a>
          </SpecCell>
        )}
        </>)}
      </div>
    </section>
  );
}

// Text input that flips between read-only display and an editable
// input depending on `editing`. Centralised here so every text field
// in the spec strip looks identical.
function SpecTextField({
  editing,
  value,
  placeholder,
  type = "text",
  onChange,
}: {
  editing: boolean;
  value: string | number | null | undefined;
  placeholder?: string;
  type?: "text" | "number";
  onChange: (v: string | null) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);
  async function commit() {
    const original = value == null ? "" : String(value);
    if (draft === original) return;
    try {
      await onChange(draft === "" ? null : draft);
    } catch {
      setDraft(original);
    }
  }
  if (!editing) {
    return (
      <SpecValue muted={value == null || value === ""}>
        {value == null || value === "" ? "—" : String(value)}
      </SpecValue>
    );
  }
  return (
    <input
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value == null ? "" : String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={SPEC_INPUT_CLASS}
    />
  );
}

// ── Spec-strip helpers ────────────────────────────────────────────
// Each cell renders its own label + a children slot for the value
// (text or input). Designed to be visually flat — the dividing
// borders come from the parent `divide-x divide-y` on the grid.

function SpecCell({
  label,
  span,
  children,
}: {
  label: string;
  span?: 2 | 3;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-w-0 px-3.5 py-2.5",
        span === 2 && "md:col-span-2",
        span === 3 && "md:col-span-2 lg:col-span-3"
      )}
    >
      <div className="mb-1 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
        {label}
      </div>
      <div className="min-w-0 text-[12.5px] font-medium text-ink">
        {children}
      </div>
    </div>
  );
}

function SpecValue({
  children,
  muted,
  mono,
}: {
  children: React.ReactNode;
  muted?: boolean;
  mono?: boolean;
}) {
  return (
    <div
      className={cn(
        "truncate",
        muted && "text-ink-secondary",
        mono && "font-mono tracking-tight"
      )}
    >
      {children}
    </div>
  );
}

/**
 * Page wrapper — mounted at /projects/:id. Reads the URL, fetches the
 * brand + event-type lookup lists once, hands the inner content the
 * project id and a no-op `onUpdated` (the page owns its own queries).
 */
export function ProjectDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = idStr ? parseInt(idStr, 10) : NaN;
  const toast = useToast();
  const brandsQ = useQuery<{ data: string[] }>("/api/projects/brands", () => api.get("/api/projects/brands"));
  const eventTypesQ = useQuery<{ data: EventType[] }>("/api/projects/event-types", () =>
    api.get("/api/projects/event-types")
  );

  if (isNaN(id)) return <Navigate to="/projects" replace />;

  return (
    <ProjectDetailContent
      id={id}
      onUpdated={() => {}}
      toast={toast}
      brands={brandsQ.data?.data ?? []}
      eventTypes={eventTypesQ.data?.data ?? []}
    />
  );
}

// ── Helpers ──────────────────────────────────────────────────
function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ── Task attachment row ──────────────────────────────────────
// Renders one attachment as a table row: Name (with thumbnail or
// file-type icon, clickable to download) | Uploaded by | Date |
// Delete. Auth-protected R2 fetch goes through api.fetchBlobUrl so
// the browser's <img> tag can render the bytes (it can't carry the
// Bearer header on its own).
// ── Defect-file ACTION TIMELINE (owner 2026-07-29) ──────────────
// Append-only Ongoing / Done log the purchaser (Sim) + BD stamp on each
// defect-list upload — every click ADDS an entry (status · name · time +
// optional remark); history is never overwritten. Provided by the project
// detail view; consumed inside TaskAttachmentRow so no prop-drilling.
interface AttachmentAction {
  id: number;
  attachment_id: number;
  status: string;
  remark: string | null;
  user_name?: string | null;
  created_at: string;
}
const DefectActionsCtx = createContext<{
  actions: AttachmentAction[];
  canReview: boolean;
  canPurchase: boolean;
  reload: () => void;
} | null>(null);

function TaskAttachmentRow({
  attachment,
  canManage,
  showRemark,
  itemTitle,
  onDelete,
  toast,
}: {
  attachment: TaskAttachment;
  canManage?: boolean;
  showRemark?: boolean;
  /** Title of the checklist item this file belongs to — gates the defect
   *  action timeline to Defect List rows. */
  itemTitle?: string;
  onDelete: () => void;
  toast?: ReturnType<typeof useToast>;
}) {
  const defectCtx = useContext(DefectActionsCtx);
  // Owner 2026-08-04: deleting a file is a MANAGER action. projects.write (held
  // by Logistic — e.g. Syu — and Sales) can upload and edit, but must NOT remove
  // files; only projects.manage (BD / managers / directors) sees the trash.
  const { can } = useAuth();
  const canDeleteFile = can("projects.manage");
  const isDefectFile = /^defect (list|item)/i.test((itemTitle ?? "").trim());
  const fileActions = isDefectFile && defectCtx
    ? defectCtx.actions.filter((x) => x.attachment_id === attachment.id)
    : [];
  // Latest timeline entry drives the two-stage state machine: no action (or a
  // legacy 'ongoing') = fresh, awaiting the Storekeeper Supervisor's triage;
  // 'replace' = escalated to the purchaser; 'done' = resolved (no buttons).
  const latestAction = fileActions.length
    ? fileActions.reduce((m, a) => (a.id > m.id ? a : m))
    : null;
  const isFreshDefect =
    !latestAction || (latestAction.status !== "done" && latestAction.status !== "replace");
  const isEscalatedDefect = latestAction?.status === "replace";
  const [actionDraft, setActionDraft] = useState<null | "done" | "replace">(null);
  const [actionRemark, setActionRemark] = useState("");
  const [savingAction, setSavingAction] = useState(false);
  async function saveAction() {
    if (!actionDraft) return;
    setSavingAction(true);
    try {
      await api.post(`/api/projects/checklist/attachments/${attachment.id}/actions`, {
        status: actionDraft,
        remark: actionRemark,
      });
      setActionDraft(null);
      setActionRemark("");
      defectCtx?.reload();
    } catch (e: any) {
      toast?.error(e?.message || "Failed to save");
    } finally {
      setSavingAction(false);
    }
  }
  const isImage = (attachment.content_type ?? "").startsWith("image/");
  // Owner 2026-07-20: PDFs get an inline first-page preview too, using the
  // browser's built-in PDF viewer via <embed>. No pdfjs dep needed and no
  // bundle weight; every modern browser + iOS/Android WebView renders it.
  const isPdf =
    (attachment.content_type ?? "").includes("pdf") ||
    attachment.file_name.toLowerCase().endsWith(".pdf");
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Per-photo remark (owner 2026-07-16): each attachment carries its own caption.
  const [caption, setCaption] = useState(attachment.caption ?? "");
  const [lastSavedCaption, setLastSavedCaption] = useState(attachment.caption ?? "");
  const [savingCaption, setSavingCaption] = useState(false);

  async function saveCaption() {
    const v = caption.trim();
    if (v === lastSavedCaption.trim()) return;
    setSavingCaption(true);
    try {
      await api.patch(`/api/projects/checklist/attachments/${attachment.id}`, { caption: v });
      setLastSavedCaption(v);
    } catch (e: any) {
      toast?.error(e?.message || "Failed to save remark");
    } finally {
      setSavingCaption(false);
    }
  }

  // Fetch a blob URL for anything we can preview inline (images AND PDFs) so
  // the same effect handles cleanup + revocation on unmount for both.
  const wantsInlinePreview = isImage || isPdf;
  useEffect(() => {
    if (!wantsInlinePreview) return;
    let cancelled = false;
    let revoke: string | null = null;
    api
      .fetchBlobUrl(
        `/api/projects/attachments/${attachment.r2_key}`,
        isPdf ? "application/pdf" : undefined,
      )
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
        } else {
          revoke = url;
          setThumbUrl(url);
        }
      })
      .catch(() => {
        // Silent — falls through to the file-type icon.
      });
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [attachment.r2_key, wantsInlinePreview, isPdf]);

  async function download() {
    try {
      await api.downloadFile(
        `/api/projects/attachments/${attachment.r2_key}`,
        attachment.file_name
      );
    } catch (e: any) {
      toast?.error(e?.message || "Download failed");
    }
  }

  async function viewInTab() {
    try {
      const url = await api.fetchBlobUrl(
        `/api/projects/attachments/${attachment.r2_key}`,
        viewableMime(attachment.file_name),
      );
      window.open(url, "_blank", "noopener");
    } catch (e: any) {
      toast?.error(e?.message || "Failed to open");
    }
  }

  // Every attachment: medium preview + download. Images open a lightbox on
  // click (medium inline preview so the content is visible without leaving
  // the page); other files (PDF/xlsx/docx) open inline in a new tab via the
  // "View" button. A Download button is always available alongside.
  return (
    <>
      <div className="border-t border-border-subtle px-2 py-1.5 text-[10.5px]">
        {isImage && thumbUrl ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setPreviewing(true); }}
            title="Click to enlarge"
            className="block cursor-zoom-in"
          >
            <img
              src={thumbUrl}
              alt={attachment.file_name}
              className="max-h-44 w-auto max-w-full rounded border border-border object-contain"
              draggable={false}
            />
          </button>
        ) : isPdf && thumbUrl ? (
          // Native browser PDF viewer — shows page 1 inline. Wrapped in a
          // click-through overlay so the PDF's own scrollbars don't swallow
          // the click; the label + click always opens the full doc in a tab.
          <div
            className="relative block max-w-full overflow-hidden rounded border border-border bg-surface"
            title="Click to open the full document"
          >
            <embed
              src={`${thumbUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
              type="application/pdf"
              className="pointer-events-none block h-44 w-full"
            />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); viewInTab(); }}
              className="absolute inset-0 flex cursor-zoom-in items-end justify-end bg-transparent p-1.5 text-[9px] font-semibold text-ink-muted opacity-0 transition hover:bg-black/5 hover:opacity-100"
            >
              <span className="rounded bg-surface/95 px-1.5 py-0.5 shadow-sm">
                Open PDF
              </span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); viewInTab(); }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-ink hover:border-accent/40 hover:text-accent"
          >
            <FileText size={12} /> View {attachment.file_name}
          </button>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ink-muted">
          <span className="max-w-[220px] truncate">{attachment.file_name}</span>
          <span>· {attachment.uploader_name || "—"}</span>
          <span>· {formatDateTime(attachment.uploaded_at)}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); download(); }}
            className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[9.5px] font-semibold text-ink hover:border-accent/40 hover:text-accent"
            title="Download"
          >
            <Download size={10} /> Download
          </button>
          {canManage && canDeleteFile && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="rounded p-0.5 text-ink-muted hover:bg-err/10 hover:text-err"
              aria-label="Remove attachment"
              title="Remove"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
        {/* A saved per-photo remark is ALWAYS visible read-only (owner
            2026-07-27: Defect List remarks were hidden until the row's Remark
            toggle was opened, so uploaded captions looked missing). Editing
            still lives behind the Remark toggle for managers. */}
        {canManage && showRemark ? (
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onBlur={() => void saveCaption()}
            onClick={(e) => e.stopPropagation()}
            disabled={savingCaption}
            rows={2}
            placeholder="Add a remark for this photo…"
            className="mt-1.5 w-full resize-y whitespace-pre-wrap break-words rounded-md border border-border bg-surface px-2 py-1 text-[10.5px] leading-snug outline-none focus:border-primary disabled:opacity-60"
          />
        ) : (
          caption.trim() && (
            <div className="mt-1.5 text-[10.5px] text-ink-secondary whitespace-pre-wrap break-words">
              <span className="font-semibold text-ink-muted">Remark:</span> {caption}
            </div>
          )
        )}
        {/* Defect action timeline (two-stage, owner 2026-08-07): a FRESH defect
            shows Done + Replace to the Storekeeper Supervisor (Shukor); once he
            escalates with Replace it shows Done to the purchaser (Sim / Farra).
            A resolved (Done) file shows only the stacked history, for everyone. */}
        {isDefectFile && defectCtx && (
          <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
            {isFreshDefect && defectCtx.canReview && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => { setActionDraft("done"); }}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[10px] font-bold",
                    actionDraft === "done"
                      ? "border-green-600 bg-green-100 text-green-700"
                      : "border-green-300 bg-surface text-green-600 hover:bg-green-50",
                  )}
                >
                  Done
                </button>
                <button
                  type="button"
                  onClick={() => { setActionDraft("replace"); }}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[10px] font-bold",
                    actionDraft === "replace"
                      ? "border-rose-600 bg-rose-100 text-rose-700"
                      : "border-rose-300 bg-surface text-rose-600 hover:bg-rose-50",
                  )}
                >
                  Replace
                </button>
              </div>
            )}
            {isEscalatedDefect && defectCtx.canPurchase && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => { setActionDraft("done"); }}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[10px] font-bold",
                    actionDraft === "done"
                      ? "border-green-600 bg-green-100 text-green-700"
                      : "border-green-300 bg-surface text-green-600 hover:bg-green-50",
                  )}
                >
                  Done
                </button>
              </div>
            )}
            {actionDraft && (
              <div className="mt-1.5">
                <textarea
                  value={actionRemark}
                  onChange={(e) => setActionRemark(e.target.value)}
                  disabled={savingAction}
                  rows={2}
                  placeholder="Add a remark (optional)…"
                  className="w-full resize-y rounded-md border border-border bg-surface px-2 py-1 text-[10.5px] leading-snug outline-none focus:border-primary disabled:opacity-60"
                />
                <div className="mt-1 flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => { setActionDraft(null); setActionRemark(""); }}
                    disabled={savingAction}
                    className="rounded-md border border-border bg-surface px-2.5 py-1 text-[10px] font-semibold text-ink-secondary hover:border-accent/40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveAction()}
                    disabled={savingAction}
                    className="rounded-md bg-ink px-2.5 py-1 text-[10px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {savingAction ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            )}
            {fileActions.length > 0 && (
              <div className="mt-1.5 space-y-1.5 border-t border-border-subtle pt-1.5">
                {[...fileActions].reverse().map((a) => (
                  <div key={a.id}>
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          a.status === "done"
                            ? "bg-green-600"
                            : a.status === "replace"
                              ? "bg-rose-600"
                              : "bg-amber-500",
                        )}
                      />
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 font-bold",
                          a.status === "done"
                            ? "bg-green-100 text-green-700"
                            : a.status === "replace"
                              ? "bg-rose-100 text-rose-700"
                              : "bg-amber-100 text-amber-700",
                        )}
                      >
                        {a.status === "done"
                          ? "Done"
                          : a.status === "replace"
                            ? "Replace"
                            : "Ongoing"}
                      </span>
                      <span className="text-ink-muted">
                        {a.user_name || "—"} · {formatDateTime(a.created_at)}
                      </span>
                    </div>
                    {a.remark && (
                      <div className="ml-3 mt-0.5 whitespace-pre-wrap break-words text-[10.5px] text-ink-secondary">
                        {a.remark}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {previewing && (
        <MediaLightbox
          items={[{ r2_key: attachment.r2_key, content_type: attachment.content_type, caption: attachment.file_name }]}
          index={0}
          onChange={() => {}}
          onClose={() => setPreviewing(false)}
          baseUrl="/api/projects/attachments"
        />
      )}
    </>
  );
}

// ── Project Stage stepper ─────────────────────────────────────
// Auto-detected 9-step timeline (Floorplan → Done) with T-offset
// deadlines from the project's start date. A step is "done" when its
// mapped checklist item(s) are done; steps whose items don't exist
// (e.g. removed from the template) are treated as pass-through so they
// never block. The current step is the first not-done one — shown red
// when today is past its deadline.
const PROJECT_STAGES: { label: string; offset: number; titles: string[]; kind?: "crew" }[] = [
  { label: "Floorplan", offset: -21, titles: ["Blank Floorplan"] },
  { label: "3D", offset: -14, titles: ["3D Design"] },
  // "Stocks Request" retired — the "Stocks Request Listing" item was
  // removed, so the step is dropped from the tracker.
  { label: "Stocks Transfer", offset: -7, titles: ["Stock Out Transfer Record"] },
  { label: "Driver Info", offset: -3, titles: ["Stock In Transfer Record"] },
  // Setup/Dismantle crew arrangement — not a checklist item; goes green
  // when the Setup & Dismantle section is filled (kind: "crew").
  { label: "Setup/Dismantle", offset: -2, titles: [], kind: "crew" },
  { label: "Setup Image", offset: 0, titles: ["Setup Image"] },
  { label: "Filled Floorplan", offset: 3, titles: ["Filled Floorplan"] },
  { label: "Event Complete", offset: 7, titles: ["Event Complete Image"] },
  { label: "Done", offset: 7, titles: [] },
];

function ProjectStageStepper({
  checklist,
  startDate,
  setupCrew,
  setupStartAt,
}: {
  checklist?: ChecklistItem[];
  startDate?: string | null;
  /** Setup & Dismantle crew JSON — drives the "Setup/Dismantle" step. */
  setupCrew?: string | null;
  setupStartAt?: string | null;
}) {
  const items = checklist ?? [];
  // Setup is considered "arranged" when a setup time is set OR the setup
  // crew JSON holds anything (dismantle may be left empty = same as setup).
  const setupArranged =
    !!setupStartAt ||
    (!!setupCrew && !["", "{}"].includes(setupCrew.trim()));
  const stepDone = (idx: number): boolean => {
    const st = PROJECT_STAGES[idx];
    if (st.kind === "crew") return setupArranged;
    if (st.titles.length === 0) return false; // final "Done" handled below
    const present = items.filter((i) => st.titles.includes(i.title));
    if (present.length === 0) return true; // no signal → pass-through
    // A stage is satisfied when every mapped item is done OR N/A — an item
    // marked N/A (not applicable for this event) must not block the flow,
    // mirroring the section progress bar which also excludes N/A.
    return present.every((i) => i.status === "done" || i.status === "na");
  };
  const lastIdx = PROJECT_STAGES.length - 1;
  let currentIdx = PROJECT_STAGES.findIndex((_, i) => i < lastIdx && !stepDone(i));
  const allDone = currentIdx === -1;
  if (allDone) currentIdx = lastIdx;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const startMs = startDate ? new Date(`${startDate}T00:00:00`).getTime() : null;
  const deadlineMs = (offset: number) => (startMs != null ? startMs + offset * 86400000 : null);

  return (
    <div className="w-full overflow-x-auto">
      <div className="mb-2 flex items-center gap-3 text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
        <span>Auto-detected</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-synced" /> Done</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#f97316]" /> Pending</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-err" /> Overdue</span>
      </div>
      <div className="flex min-w-fit items-start">
        {PROJECT_STAGES.map((st, i) => {
          const dl = deadlineMs(st.offset);
          const isDone = allDone ? true : i < currentIdx;
          const isCurrent = !allDone && i === currentIdx;
          const overdue = isCurrent && dl != null && todayMs > dl && i !== lastIdx;
          const lateDays = overdue && dl != null ? Math.round((todayMs - dl) / 86400000) : 0;
          const circle = isDone
            ? "bg-synced text-white border-synced"
            : overdue
              ? "bg-err text-white border-err"
              : isCurrent
                ? "bg-[#f97316] text-white border-[#f97316]"
                : "bg-surface text-ink-muted border-border";
          const txt = isDone
            ? "text-synced"
            : overdue
              ? "text-err"
              : isCurrent
                ? "text-[#f97316]"
                : "text-ink-muted";
          return (
            <div key={st.label} className="flex min-w-[72px] flex-1 flex-col items-center text-center">
              <div className="flex w-full items-center">
                <div className={cn("h-0.5 flex-1", i === 0 ? "opacity-0" : i <= currentIdx ? "bg-synced/50" : "bg-border")} />
                <div className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold", circle)}>
                  {isDone ? <Check size={12} strokeWidth={3} /> : i + 1}
                </div>
                <div className={cn("h-0.5 flex-1", i === lastIdx ? "opacity-0" : i < currentIdx ? "bg-synced/50" : "bg-border")} />
              </div>
              <div className={cn("mt-1.5 text-[9px] font-semibold uppercase tracking-wider", txt)}>{st.label}</div>
              <div className="text-[8px] tabular-nums text-ink-muted">
                {st.offset >= 0 ? `T+${st.offset}` : `T${st.offset}`}d
              </div>
              {overdue && <div className="text-[8px] font-semibold text-err">{lateDays}d late</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Stage progress row ───────────────────────────────────────
// One pill per tasklist section. Solid + check when every non-NA task
// in the section is done; partial gradient based on done/total when
// in-progress; muted outline when nothing's started. Replaces the
// percentage progress bar (mig 050).
function StageProgressRow({
  sections,
  checklist,
}: {
  sections: SectionProgress[];
  /** Optional — when provided, each pill shows a lead-time chip
   *  derived from the latest due_date among unfinished items in that
   *  section. Falls back to a plain "done/N" count when omitted. */
  checklist?: ChecklistItem[];
}) {
  // Pre-bucket the checklist by section so each pill's lead-time calc
  // is O(items) total, not O(sections × items).
  const itemsBySection = useMemo(() => {
    const m = new Map<number, ChecklistItem[]>();
    for (const it of checklist ?? []) {
      const key = it.section_id ?? 0;
      const arr = m.get(key) ?? [];
      arr.push(it);
      m.set(key, arr);
    }
    return m;
  }, [checklist]);

  function leadTimeFor(sectionId: number): { days: number; targetIso: string } | null {
    const items = itemsBySection.get(sectionId);
    if (!items) return null;
    const dates = items
      .filter((i) => i.status !== "done" && i.status !== "na" && !!i.due_date)
      .map((i) => i.due_date as string);
    if (dates.length === 0) return null;
    const latest = dates.sort().slice(-1)[0];
    const target = new Date(`${latest}T00:00:00Z`);
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    return {
      days: Math.round((target.getTime() - now.getTime()) / 86400000),
      targetIso: latest,
    };
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sections.map((s) => {
        const denom = s.total - s.na;
        const pct = denom > 0 ? Math.round((s.done / denom) * 100) : 0;
        const complete = s.complete === 1;
        const lt = !complete ? leadTimeFor(s.id) : null;
        const ltTone =
          lt == null
            ? null
            : lt.days < 0
              ? "overdue"
              : lt.days <= 3
                ? "soon"
                : "ok";
        return (
          <span
            key={s.id || s.name}
            title={
              `${s.name} — ${s.done}/${denom || 0} done${s.na ? ` · ${s.na} N/A` : ""}` +
              (lt
                ? `\nLatest open task due ${lt.targetIso}${
                    lt.days < 0 ? ` (${-lt.days}d overdue)` : ` (${lt.days}d left)`
                  }`
                : "")
            }
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors",
              complete
                ? "border-synced bg-synced/15 text-synced"
                : pct > 0
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border text-ink-muted"
            )}
          >
            {complete ? (
              <CheckCircle2 size={11} className="text-synced" />
            ) : (
              <Circle size={10} />
            )}
            <span>{s.name}</span>
            {!complete && pct > 0 && (
              <span className="font-mono text-[9px] opacity-70">
                {s.done}/{denom}
              </span>
            )}
            {lt && (
              <span
                className={cn(
                  "rounded px-1 py-px font-mono text-[8.5px] font-semibold tracking-tight",
                  ltTone === "overdue"
                    ? "bg-err/15 text-err"
                    : ltTone === "soon"
                      ? "bg-warning-bg text-warning-text"
                      : "bg-bg/60 text-ink-muted"
                )}
              >
                {lt.days < 0
                  ? `${-lt.days}d over`
                  : lt.days === 0
                    ? "today"
                    : `${lt.days}d`}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ── Tasklist (grouped by section) ─────────────────────────────
// Mig 050: replaces the flat checklist with section headers + grouped
// rows. Each section is collapsible; admins can add/rename/delete
// sections inline. Tasks without a section land in an "Uncategorised"
// bucket pinned at the bottom.
function TasklistSections({
  projectId,
  projectStartDate,
  projectEndDate,
  checklist,
  sections,
  sectionProgress,
  attachments,
  comments,
  users,
  canTick,
  canManage,
  addItemOpen,
  setAddItemOpen,
  onReload,
  onItemStatus,
  onItemDelete,
  toast,
}: {
  projectId: number;
  projectStartDate: string | null;
  projectEndDate: string | null;
  checklist: ChecklistItem[];
  sections: TasklistSection[];
  sectionProgress: SectionProgress[];
  attachments: TaskAttachment[];
  comments: ChecklistComment[];
  users: { id: number; name: string }[];
  canTick: boolean;
  canManage: boolean;
  addItemOpen: boolean;
  setAddItemOpen: (v: boolean) => void;
  onReload: () => void;
  onItemStatus: (item: ChecklistItem, s: ChecklistStatus) => void;
  onItemDelete: (item: ChecklistItem) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const { can, user } = useAuth();
  const dialog = useDialog();
  const [addSectionOpen, setAddSectionOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [editingSectionId, setEditingSectionId] = useState<number | null>(null);
  const [editingSectionName, setEditingSectionName] = useState("");
  // List vs Gantt view toggle, URL-backed so a Gantt link is shareable.
  const [viewParams, setViewParams] = useSearchParams();
  const view = viewParams.get("tasklist_view") === "gantt" ? "gantt" : "list";
  function setView(next: "list" | "gantt") {
    const p = new URLSearchParams(viewParams);
    if (next === "list") p.delete("tasklist_view");
    else p.set("tasklist_view", next);
    setViewParams(p, { replace: true });
  }
  // Sort mode for the list view. "section" keeps the section grouping
  // (default); "due" flattens to a single list ordered by due_date so
  // the user can scan what's coming up next across sections.
  const sort = viewParams.get("tasklist_sort") === "due" ? "due" : "section";
  function setSort(next: "section" | "due") {
    const p = new URLSearchParams(viewParams);
    if (next === "section") p.delete("tasklist_sort");
    else p.set("tasklist_sort", next);
    setViewParams(p, { replace: true });
  }
  // Click → list scroll target. The list-view rows carry data-task-id;
  // the handler sets the focus id, which a useEffect below scrolls into
  // view + briefly highlights via a CSS animation.
  const [focusTaskId, setFocusTaskId] = useState<number | null>(null);
  useEffect(() => {
    if (focusTaskId == null || view !== "list") return;
    const el = document.querySelector<HTMLElement>(
      `[data-task-id="${focusTaskId}"]`
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-accent", "ring-offset-2");
      const t = setTimeout(() => {
        el.classList.remove("ring-2", "ring-accent", "ring-offset-2");
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [focusTaskId, view]);
  // Which section the "Add item" form is targeting. Null = no section
  // (Uncategorised). Keyed off button click below.
  const [addInSectionId, setAddInSectionId] = useState<number | null>(null);

  const groups = useMemo(() => {
    const buckets: Array<{
      section: TasklistSection | null;
      items: ChecklistItem[];
    }> = [];
    if (sort === "due") {
      // Flat list, ascending by due_date with nulls (no due) at the end.
      // Same comparator the calendar uses for task ordering.
      const sorted = [...checklist].sort((a, b) => {
        const ad = a.due_date ?? "";
        const bd = b.due_date ?? "";
        if (!ad && !bd) return a.seq - b.seq;
        if (!ad) return 1;
        if (!bd) return -1;
        return ad.localeCompare(bd);
      });
      buckets.push({ section: null, items: sorted });
      return buckets;
    }
    for (const sec of sections) {
      buckets.push({
        section: sec,
        items: checklist.filter((it) => it.section_id === sec.id),
      });
    }
    const uncat = checklist.filter((it) => it.section_id == null);
    if (uncat.length > 0 || sections.length === 0) {
      buckets.push({ section: null, items: uncat });
    }
    return buckets;
  }, [sections, checklist, sort]);

  // Crew setup/dismantle photos (owner 2026-07-31). Driver/helper uploads land
  // in project_phase_photos — the Driver App and the mobile Setup & dismantle
  // card both write there — NOT in the task's own attachments. So the
  // "Setup Image" / "Dismantle Image" rows read EMPTY on this page while the
  // photo sat in the Phase Photos block below (e.g. project 371: 4 setup
  // photos, 0 task files). Merge the phase photos into those two rows so one
  // file set shows in both places, whichever door the crew uploaded through.
  const phasePhotosQ = useQuery<{ photos: PhasePhoto[] }>(
    "/api/projects/:/phase-photos",
    () => api.get(`/api/projects/${projectId}/phase-photos`),
    [projectId],
  );

  const attachmentsByItem = useMemo(() => {
    const m = new Map<number, TaskAttachment[]>();
    for (const a of attachments) {
      const arr = m.get(a.item_id) ?? [];
      arr.push(a);
      m.set(a.item_id, arr);
    }
    // Merged-in phase photos carry a NEGATIVE id: they live in a different
    // table, so delete / defect-action calls (which take an attachment id)
    // must not fire on them — the render sites gate on `id > 0`.
    const photos = phasePhotosQ.data?.photos ?? [];
    if (photos.length > 0) {
      // "Setup Image" exists twice (DRIVER + SALES PIC badges); crew photos
      // belong to the DRIVER one. Dismantle Image is DRIVER-only.
      const pickRow = (re: RegExp) => {
        const rows = checklist.filter((it) => re.test((it.title || "").trim()));
        return rows.find((it) => (it.role_label ?? "").toUpperCase().includes("DRIVER")) ?? rows[0];
      };
      for (const [phase, item] of [
        ["setup", pickRow(/^setup image/i)],
        ["dismantle", pickRow(/^dismantle image/i)],
      ] as const) {
        if (!item) continue;
        const arr = m.get(item.id) ?? [];
        const seen = new Set(arr.map((a) => a.r2_key));
        for (const ph of photos) {
          if (ph.phase !== phase || !ph.r2_key || seen.has(ph.r2_key)) continue;
          arr.push({
            id: -ph.id,
            item_id: item.id,
            r2_key: ph.r2_key,
            file_name: ph.r2_key.split("/").pop() || `${phase} photo`,
            content_type: ph.content_type,
            size_bytes: null,
            uploaded_by: ph.uploaded_by,
            uploader_name: ph.uploaded_by_name,
            uploaded_at: ph.uploaded_at,
            caption: ph.caption,
          });
        }
        m.set(item.id, arr);
      }
    }
    return m;
  }, [attachments, checklist, phasePhotosQ.data]);

  async function addSection() {
    const name = newSectionName.trim();
    if (!name) return;
    try {
      await api.post(`/api/projects/${projectId}/sections`, { name });
      toast.success(`Added section "${name}"`);
      setNewSectionName("");
      setAddSectionOpen(false);
      onReload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function renameSection(id: number) {
    const name = editingSectionName.trim();
    if (!name) return;
    try {
      await api.patch(`/api/projects/sections/${id}`, { name });
      toast.success("Section renamed");
      setEditingSectionId(null);
      setEditingSectionName("");
      onReload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function deleteSection(id: number, name: string) {
    if (
      !(await dialog.confirm({
        title: "Delete section",
        message: `Delete section "${name}"? Tasks in it will move to Uncategorised.`,
        danger: true,
        confirmLabel: "Delete",
      }))
    ) {
      return;
    }
    try {
      await api.del(`/api/projects/sections/${id}`);
      toast.success("Section removed");
      onReload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  // Reorder a section by one slot. The order drives the stage-chip
  // progress bar at the top of the page, so admins reach for this
  // when they want stages displayed in lifecycle order.
  async function moveSection(sectionId: number, delta: -1 | 1) {
    const idx = sections.findIndex((s) => s.id === sectionId);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= sections.length) return;
    const next = sections.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      await api.put(`/api/projects/${projectId}/sections/reorder`, {
        ids: next.map((s) => s.id),
      });
      onReload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reorder");
    }
  }

  return (
    <PanelSection
      title={`Tasklist (${checklist.length})`}
      action={
        <div className="flex items-center gap-1.5">
          {/* List / Gantt toggle. URL-backed (?tasklist_view=) so a
              Sales Director can deep-link to a single project's
              Gantt without further navigation. */}
          <div className="inline-flex overflow-hidden rounded-md border border-border bg-bg/40 font-mono text-[9.5px] font-semibold uppercase tracking-wider">
            <button
              type="button"
              onClick={() => setView("list")}
              className={cn(
                "px-2 py-1 transition-colors",
                view === "list"
                  ? "bg-accent text-white"
                  : "text-ink-muted hover:text-accent"
              )}
              aria-pressed={view === "list"}
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setView("gantt")}
              className={cn(
                "px-2 py-1 transition-colors",
                view === "gantt"
                  ? "bg-accent text-white"
                  : "text-ink-muted hover:text-accent"
              )}
              aria-pressed={view === "gantt"}
            >
              Gantt
            </button>
          </div>
          {/* Sort: section (default grouping) vs due (flat, by due_date).
              Only meaningful in list view. URL-backed so a "what's
              next?" view is bookmarkable. */}
          {view === "list" && (
          <div className="inline-flex overflow-hidden rounded-md border border-border bg-bg/40 font-mono text-[9.5px] font-semibold uppercase tracking-wider">
            <button
              type="button"
              onClick={() => setSort("section")}
              className={cn(
                "px-2 py-1 transition-colors",
                sort === "section"
                  ? "bg-accent text-white"
                  : "text-ink-muted hover:text-accent"
              )}
              aria-pressed={sort === "section"}
              title="Group by section"
            >
              Section
            </button>
            <button
              type="button"
              onClick={() => setSort("due")}
              className={cn(
                "px-2 py-1 transition-colors",
                sort === "due"
                  ? "bg-accent text-white"
                  : "text-ink-muted hover:text-accent"
              )}
              aria-pressed={sort === "due"}
              title="Flatten and sort by due date"
            >
              Due
            </button>
          </div>
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => setAddSectionOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary hover:border-accent/40 hover:text-accent"
            >
              <Plus size={11} /> Section
            </button>
          )}
        </div>
      }
    >
      {view === "gantt" ? (
        <ProjectGantt
          projectStartDate={projectStartDate}
          projectEndDate={projectEndDate}
          sections={sections}
          sectionProgress={sectionProgress}
          tasks={checklist.map((c) => ({
            id: c.id,
            title: c.title,
            status: c.status,
            due_date: c.due_date,
            section_id: c.section_id,
            required_perm: c.required_perm,
            owner_name: c.owner_name,
          }))}
          onTaskClick={(taskId) => {
            setView("list");
            setFocusTaskId(taskId);
          }}
        />
      ) : null}

      {view === "list" && addSectionOpen && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-dashed border-accent/40 bg-accent-soft/20 p-2">
          <input
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addSection();
              if (e.key === "Escape") {
                setAddSectionOpen(false);
                setNewSectionName("");
              }
            }}
            placeholder="e.g. Pre-event, Setup, Live, Teardown"
            autoFocus
            className="h-7 flex-1 rounded-md border border-border bg-surface px-2 text-[11.5px] outline-none focus:border-primary"
          />
          <button
            onClick={addSection}
            disabled={!newSectionName.trim()}
            className="rounded-md bg-accent px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white disabled:opacity-50"
          >
            Add
          </button>
          <button
            onClick={() => {
              setAddSectionOpen(false);
              setNewSectionName("");
            }}
            className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
          >
            Cancel
          </button>
        </div>
      )}

      {view === "list" && (
      <div className="space-y-3">
        {groups.map(({ section, items }) => {
          const sectionId = section?.id ?? null;
          const headerName =
            section?.name ?? (sort === "due" ? "By due date" : "Uncategorised");
          const denom = items.length - items.filter((i) => i.status === "na").length;
          const done = items.filter((i) => i.status === "done").length;
          // Section lead time — latest due_date among unfinished items in
          // the section. Tells the team "this section needs to be wrapped
          // up by X". Skips done/na rows so a finished item doesn't peg
          // the deadline in the past. Returns null when there are no
          // dated open items.
          const sectionLeadTime: { days: number; targetIso: string } | null = (() => {
            const dates = items
              .filter((i) => i.status !== "done" && i.status !== "na" && !!i.due_date)
              .map((i) => i.due_date as string);
            if (dates.length === 0) return null;
            const latest = dates.sort().slice(-1)[0];
            const target = new Date(`${latest}T00:00:00Z`);
            const now = new Date();
            now.setUTCHours(0, 0, 0, 0);
            const ms = target.getTime() - now.getTime();
            const days = Math.round(ms / 86400000);
            return { days, targetIso: latest };
          })();
          return (
            <div
              key={section?.id ?? "uncat"}
              className="rounded-md border border-border-subtle bg-bg/30"
            >
              <div className="flex items-center gap-2 border-b border-border-subtle bg-bg/50 px-2.5 py-1.5">
                {editingSectionId === section?.id ? (
                  <>
                    <input
                      value={editingSectionName}
                      onChange={(e) => setEditingSectionName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") renameSection(section!.id);
                        if (e.key === "Escape") setEditingSectionId(null);
                      }}
                      autoFocus
                      className="h-6 flex-1 rounded-md border border-accent bg-surface px-2 text-[11.5px] font-semibold outline-none"
                    />
                    <button
                      onClick={() => renameSection(section!.id)}
                      className="rounded bg-accent px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase text-white"
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-[11.5px] font-semibold uppercase tracking-wider text-ink-secondary">
                      {headerName}
                    </span>
                    {sectionLeadTime && (
                      <span
                        className={cn(
                          "rounded px-1.5 py-px font-mono text-[9.5px] font-semibold uppercase tracking-wider",
                          sectionLeadTime.days < 0
                            ? "bg-err/15 text-err"
                            : sectionLeadTime.days <= 3
                              ? "bg-warning-bg text-warning-text"
                              : "bg-bg text-ink-muted"
                        )}
                        title={`Last open task due ${sectionLeadTime.targetIso}`}
                      >
                        {sectionLeadTime.days < 0
                          ? `${-sectionLeadTime.days}d overdue`
                          : sectionLeadTime.days === 0
                            ? "due today"
                            : `${sectionLeadTime.days}d left`}
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-ink-muted">
                      {done}/{denom || 0}
                    </span>
                    {section && canManage && (
                      <>
                        {/* Up / down arrows reorder the section. The
                            order here drives the stage-chip progress
                            bar at the top of the page. */}
                        <button
                          onClick={() => moveSection(section.id, -1)}
                          disabled={
                            sections.findIndex((s) => s.id === section.id) === 0
                          }
                          className="rounded p-0.5 text-ink-muted hover:bg-surface-dim hover:text-accent disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
                          title="Move up"
                        >
                          <ChevronUp size={12} />
                        </button>
                        <button
                          onClick={() => moveSection(section.id, 1)}
                          disabled={
                            sections.findIndex((s) => s.id === section.id) ===
                            sections.length - 1
                          }
                          className="rounded p-0.5 text-ink-muted hover:bg-surface-dim hover:text-accent disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
                          title="Move down"
                        >
                          <ChevronDown size={12} />
                        </button>
                        <button
                          onClick={() => {
                            setEditingSectionId(section.id);
                            setEditingSectionName(section.name);
                          }}
                          className="rounded p-0.5 text-ink-muted hover:bg-surface-dim hover:text-accent"
                          title="Rename"
                        >
                          <Pencil size={11} />
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
              {section?.display_mode === "documents" ? (
                <DocumentTable
                  items={items}
                  comments={comments}
                  canManage={!!canManage}
                  canApproveFor={(it) => !it.required_perm || holdsChecklistApproval(user?.permissions, it.required_perm)}
                  attachmentsByItem={attachmentsByItem}
                  onStatus={(it, s) => onItemStatus(it, s)}
                  onReview={async (it, action, payload) => {
                    try {
                      await api.post(`/api/projects/checklist/${it.id}/review`, {
                        action,
                        ...payload,
                      });
                      onReload();
                    } catch (e: any) {
                      toast.error(e?.message || "Something went wrong. Please try again.");
                    }
                  }}
                  onReload={onReload}
                  toast={toast}
                />
              ) : section?.name === "3D APPROVAL" ? (
                <ThreeDApprovalBlock
                  items={items}
                  attachmentsByItem={attachmentsByItem}
                  canManage={!!canManage}
                  canTick={canTick}
                  onStatus={(it, s) => onItemStatus(it, s)}
                  onReload={onReload}
                  toast={toast}
                />
              ) : (
              <div className="space-y-1.5 p-2">
                {items.map((item) => (
                  <Fragment key={item.id}>
                  <ChecklistRow
                    item={item}
                    projectId={projectId}
                    comments={comments.filter((c) => c.item_id === item.id)}
                    canTick={canTick}
                    canApprove={!item.required_perm || holdsChecklistApproval(user?.permissions, item.required_perm)}
                    canManage={canManage}
                    attachments={
                      // 3D shared upload: the Peter approval row mirrors the
                      // file uploaded on the "3D Checked by MGT" row.
                      item.title === "3D Approved by Peter"
                        ? attachmentsByItem.get(
                            items.find((i) => i.title === "3D Checked by MGT")?.id ?? -1
                          ) ?? []
                        : attachmentsByItem.get(item.id) ?? []
                    }
                    readOnlyAttach={
                      item.title === "3D Approved by Peter" &&
                      !!items.find((i) => i.title === "3D Checked by MGT")
                    }
                    attachCaption={
                      item.title === "3D Approved by Peter"
                        ? "3D file shared from the “3D Checked by MGT” step."
                        : item.title === "3D Checked by MGT"
                          ? "Shared 3D file — also shown on the “3D Approved by Peter” step."
                          : undefined
                    }
                    onStatus={(s) => onItemStatus(item, s)}
                    onDelete={() => onItemDelete(item)}
                    onCrewVisible={async (visible) => {
                      try {
                        await api.patch(`/api/projects/checklist/${item.id}`, {
                          crew_visible: visible ? 1 : 0,
                        });
                        onReload();
                      } catch (e: any) {
                        toast.error(e?.message || "Something went wrong. Please try again.");
                      }
                    }}
                    onReview={async (action, payload) => {
                      try {
                        await api.post(`/api/projects/checklist/${item.id}/review`, {
                          action,
                          ...payload,
                        });
                        onReload();
                      } catch (e: any) {
                        toast.error(e?.message || "Something went wrong. Please try again.");
                      }
                    }}
                    onAttachmentsChanged={onReload}
                    toast={toast}
                  />
                  </Fragment>
                ))}
                {items.length === 0 && (
                  <div className="px-1 py-1 text-[10.5px] text-ink-muted">
                    No tasks in this section yet.
                  </div>
                )}
              </div>
              )}
            </div>
          );
        })}
      </div>
      )}
    </PanelSection>
  );
}

// ── Checklist row ────────────────────────────────────────────

const REVIEW_BADGES: Record<string, { label: string; cls: string }> = {
  pending_review: { label: "In Review", cls: "bg-amber-100 text-amber-800" },
  rejected: { label: "Rejected", cls: "bg-err/10 text-err" },
  amended: { label: "Amended", cls: "bg-accent/15 text-accent" },
  approved: { label: "Approved", cls: "bg-synced/15 text-synced" },
};

// Which rows carry the submit/approve/reject workflow is decided by
// isReviewableTitle (pms-reviewable-titles.ts), shared with mobile. It is a
// PREFIX rule: this Set of seven EXACT titles used to withhold the workflow
// from "3D Design (Revision 2)" on desktop while mobile granted it.

// Documents that are view-only: a medium preview opens (image → lightbox,
// other files → inline new tab) and there's no download button.
// ── Document table (section display_mode = 'documents') ───────
// Renders a section's items as a 6-column document table
// (DOCUMENT / REMARKS / FILES / UPLOADED BY / APPROVAL / ACTIONS).
// Approve/Reject reuses the review pipeline and shows only on
// reviewable items (e.g. Stock Out Transfer Record).
// NOTE: roleChipClass is NOT defined here — it lives in the crew-editor
// block (single authoritative definition shared by both features).
function DocumentTable({
  items,
  comments,
  canManage,
  canApproveFor,
  attachmentsByItem,
  onStatus,
  onReview,
  onReload,
  toast,
}: {
  items: ChecklistItem[];
  comments: ChecklistComment[];
  canManage: boolean;
  canApproveFor: (it: ChecklistItem) => boolean;
  attachmentsByItem: Map<number, TaskAttachment[]>;
  onStatus: (it: ChecklistItem, s: ChecklistStatus) => void;
  onReview: (
    it: ChecklistItem,
    action: "submit" | "reject" | "approve" | "comment",
    payload: { reason?: string; note?: string }
  ) => void | Promise<void>;
  onReload: () => void;
  toast?: ReturnType<typeof useToast>;
}) {
  const { can, user } = useAuth();
  // Owner 2026-08-10: "kris can upload fill in floorplan". A view-only Sales
  // Director has no projects.write, so canManage is false and the Attach button
  // was hidden — for this ONE document they get it. Backend enforces the same
  // narrow rule (salesDirectorMayAttach), this is just the affordance.
  const isSalesDirectorPos =
    (user?.position_name ?? "").trim().toLowerCase() === "sales director";
  // Owner 2026-08-24: a tick-only role (no projects.write — the Purchaser after
  // that permission was stripped from the role, and drivers before her) attaches
  // to documents badged for its OWN function. The upload endpoint has always
  // allowed this (projects.checklist.tick + roleLabelAdmits), and mobile shows
  // the button; only this desktop table demanded projects.write, so the
  // Purchaser saw an empty Actions column on her own Stock Out Transfer Record.
  const canTick = can("projects.checklist.tick");
  const mayAttach = (it: ChecklistItem) =>
    canManage ||
    (isSalesDirectorPos && /^filled floor\s*plan/i.test((it.title || "").trim())) ||
    (canTick && roleLabelAdmitsRole(it.role_label, user?.role_name));
  return (
    <div className="p-2 sm:overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-border-subtle text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
            <th className="px-3 py-2 text-left">Document</th>
            <th className="px-3 py-2 text-left">Remarks</th>
            <th className="hidden px-3 py-2 text-left sm:table-cell">Files</th>
            <th className="hidden px-3 py-2 text-left sm:table-cell">Uploaded By</th>
            <th className="hidden px-3 py-2 text-left sm:table-cell">Approval</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {items.map((it) => (
            <DocRow
              key={it.id}
              item={it}
              comments={comments.filter((c) => c.item_id === it.id)}
              attachments={attachmentsByItem.get(it.id) ?? []}
              canManage={mayAttach(it)}
              canApprove={canApproveFor(it)}
              onStatus={onStatus}
              onReview={onReview}
              onReload={onReload}
              toast={toast}
            />
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-2 text-ink-muted">
                No documents.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DocRow({
  item,
  comments,
  attachments,
  canManage,
  canApprove,
  onStatus,
  onReview,
  onReload,
  toast,
}: {
  item: ChecklistItem;
  comments: ChecklistComment[];
  attachments: TaskAttachment[];
  canManage: boolean;
  canApprove: boolean;
  onStatus: (it: ChecklistItem, s: ChecklistStatus) => void;
  onReview: (
    it: ChecklistItem,
    action: "submit" | "reject" | "approve" | "comment",
    payload: { reason?: string; note?: string }
  ) => void | Promise<void>;
  onReload: () => void;
  toast?: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [remark, setRemark] = useState("");
  const [postingRemark, setPostingRemark] = useState(false);
  // Free-text remark notes on this document (excludes the review decision trail).
  const remarkNotes = comments.filter((c) => c.kind !== "submit" && c.kind !== "reject" && c.kind !== "approve" && c.kind !== "amend" && c.body);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const reviewable = isReviewableTitle(item.title);
  const latest = attachments[0];
  // Per-file decision status (owner 2026-08-10, Part 2): tie each uploaded
  // VERSION to the approve/reject decision made while it was the newest file, so
  // the FILES list shows "Approved/Rejected · who · when" per version and greys a
  // rejected one — instead of only the item-level trail. No schema change:
  // uploaded_at and comment.created_at are both ISO-Z, so a plain lexical compare
  // is correct. A decision in [thisUpload, nextUpload) belongs to this version;
  // the current newest file with no later decision stays unlabelled (still
  // pending). Batch uploads take the last decision inside their window. Merged
  // crew photos (id < 0) are excluded — they're not review versions.
  const versionStatus = useMemo(() => {
    const decisions = comments
      .filter((c) => c.kind === "approve" || c.kind === "reject")
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const asc = attachments
      .filter((a) => a.id > 0)
      .sort((a, b) => ((a.uploaded_at || "") < (b.uploaded_at || "") ? -1 : 1));
    const m = new Map<number, { kind: "approve" | "reject"; who: string; at: string }>();
    asc.forEach((att, i) => {
      const ta = att.uploaded_at || "";
      const tnext = i + 1 < asc.length ? asc[i + 1].uploaded_at || "" : "￿";
      const d = decisions
        .filter((dec) => dec.created_at >= ta && dec.created_at < tnext)
        .pop();
      if (d)
        m.set(att.id, {
          kind: d.kind as "approve" | "reject",
          who: d.user_name || "—",
          at: d.created_at,
        });
    });
    return m;
  }, [comments, attachments]);
  const rs = item.review_status;
  const awaiting = rs === "pending_review" || rs === "amended";
  const naActive = item.status === "na";

  async function upload(file: File) {
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      toast?.error("File needs an extension");
      return;
    }
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      await api.putBinary(
        `/api/projects/checklist/${item.id}/attachments?ext=${encodeURIComponent(
          ext
        )}&name=${encodeURIComponent(file.name)}`,
        buf,
        file.type || "application/octet-stream"
      );
      toast?.success("Uploaded");
      onReload();
    } catch (e: any) {
      toast?.error(e?.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeAtt(attId: number) {
    if (
      !(await dialog.confirm({
        message: "Remove this attachment?",
        danger: true,
        confirmLabel: "Remove",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/checklist/attachments/${attId}`);
      onReload();
    } catch (e: any) {
      toast?.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function postRemark() {
    const t = remark.trim();
    if (!t) return;
    setPostingRemark(true);
    try {
      await onReview(item, "comment", { note: t });
      setRemark("");
      setRemarkOpen(false);
    } catch (e: any) {
      toast?.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setPostingRemark(false);
    }
  }

  return (
    <Fragment>
      <tr className={cn("align-top", naActive && "opacity-60")}>
        <td className="px-3 py-2">
          <div className="flex items-start gap-1.5">
            <FileText size={13} className="mt-0.5 shrink-0 text-ink-muted" />
            <div className="min-w-0">
              <div className="font-medium text-ink">{item.title}</div>
              {item.role_label && roleLabelParts(item.role_label).map((part) => (
                <span key={part} className={cn("mr-1 mt-0.5 inline-block whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[9px] font-bold tracking-wide", roleChipClass(part))}>
                  {formatRoleLabel(part)}
                </span>
              ))}
            </div>
          </div>
        </td>
        <td className="px-3 py-2 text-ink-secondary">
          {(() => {
            // Remarks = the document's own notes PLUS any reason text
            // entered during review (e.g. a rejection reason). The
            // approve/reject *decision trail* stays in the Approval
            // column; the remark text itself belongs here.
            const remarkComments = comments
              // Remarks column shows human-typed notes only. Excludes:
              // - 'submit' (empty ping, always body=null anyway)
              // - 'upload' / 'remove' (system audit lines, filename is the body
              //   but belongs in the History column, not Remarks — owner 2026-07-20).
              .filter((c) => c.kind !== "submit" && c.kind !== "upload" && c.kind !== "remove" && c.body)
              .slice()
              .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
            if (!item.notes && remarkComments.length === 0)
              return <span className="text-ink-muted">—</span>;
            return (
              <div className="space-y-0.5">
                {item.notes && <div className="whitespace-pre-wrap break-words">{item.notes}</div>}
                {remarkComments.map((c) => (
                  <div key={c.id} className="text-[9px] leading-snug text-ink-muted whitespace-pre-wrap break-words">
                    <span className={cn("font-semibold", commentKindColor(c.kind))}>
                      {commentKindLabel(c.kind)}:
                    </span>{" "}
                    {c.body}
                  </div>
                ))}
              </div>
            );
          })()}
        </td>
        <td className="hidden px-3 py-2 sm:table-cell">
          {attachments.length > 0 ? (
            <button
              onClick={() => setOpen((x) => !x)}
              className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-ink hover:border-accent/40 hover:text-accent"
            >
              <Paperclip size={11} /> {attachments.length}
            </button>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </td>
        <td className="hidden px-3 py-2 sm:table-cell">
          {latest ? (
            <div>
              <div className="text-ink">{latest.uploader_name || "Unknown"}</div>
              <div className="text-[9.5px] text-ink-muted">{formatDateTime(latest.uploaded_at)}</div>
            </div>
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </td>
        <td className="hidden px-3 py-2 sm:table-cell">
          {!reviewable ? (
            <span className="text-ink-muted">—</span>
          ) : (
            <div className="space-y-1">
              {/* Chronological history (oldest → newest): uploads, removes,
                  approves, rejects. 'submit' pings hidden as noise — the
                  upload comment beside them carries the filename instead. */}
              {comments.filter((c) => c.kind !== "submit").length > 0 && (
                <div className="space-y-0.5">
                  {comments
                    .filter((c) => c.kind !== "submit")
                    .slice()
                    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
                    .map((c) => {
                      // Upload/remove comments carry the filename in `body`;
                      // approve/reject leave body null (the decision itself is
                      // the whole story).
                      const showFile = (c.kind === "upload" || c.kind === "remove") && c.body;
                      return (
                        <div key={c.id} className="text-[9px] leading-snug text-ink-muted">
                          <span className={cn("font-semibold", commentKindColor(c.kind))}>
                            {commentKindLabel(c.kind)}
                          </span>
                          {showFile && (
                            <>
                              {" "}
                              {/* inline-block, not inline: truncate is dead on
                                  inline elements, which is how full 100-char
                                  filenames wrapped the whole cell (owner
                                  2026-08-17: "make it short and fit in box
                                  only"). Full name stays on hover. */}
                              <span
                                title={c.body ?? undefined}
                                className="inline-block max-w-[150px] truncate align-bottom text-ink"
                              >
                                {c.body}
                              </span>
                            </>
                          )}
                          {" · "}
                          {c.user_name || "—"} · {formatDateTime(c.created_at)}
                        </div>
                      );
                    })}
                </div>
              )}
              {/* Approve/Reject visibility. The control appears once a file is
                  uploaded (owner 2026-07-27 — nothing to decide before that) AND
                  the caller can approve: a gated document (required_perm) offers
                  it to a permission holder at any time so a decision can be
                  revisited (owner 2026-07-21/07-31); non-gated docs keep the
                  submit-then-review flow (only while a submission awaits review).
                  WHICH of the two buttons shows is the per-decision toggle just
                  below (owner 2026-08-10). */}
              {attachments.length > 0 && canApprove && (item.required_perm || awaiting) ? (
                <div className="flex flex-wrap items-center gap-1">
                  {/* Toggle (owner 2026-08-10): show only the button that
                      REVERSES the current decision. On upload (no decision) both
                      show; once Approved the Approve button is HIDDEN and Reject
                      stays (so an issue found later can still reject it); once
                      Rejected the Reject button is HIDDEN and Approve stays (so
                      it can be approved once fixed). Hiding Approve after an
                      approval also closes the old double-approve bug (owner
                      2026-08-08) for free. The decision itself stays visible as
                      the "Approved/Rejected · name · date" trail in this column. */}
                  {rs !== "approved" && (
                    <button
                      onClick={() => onReview(item, "approve", {})}
                      title="Approve this document"
                      className="rounded-md bg-synced/90 px-2 py-0.5 text-[9.5px] font-semibold text-white hover:bg-synced"
                    >
                      Approve
                    </button>
                  )}
                  {rs !== "rejected" && (
                    <button
                      onClick={() => setRejectOpen((x) => !x)}
                      className="rounded-md border border-err/40 bg-surface px-2 py-0.5 text-[9.5px] font-semibold text-err hover:bg-err/5"
                    >
                      Reject…
                    </button>
                  )}
                </div>
              ) : (
                comments.filter((c) => c.kind !== "submit").length === 0 && (
                  <span className="text-ink-muted">—</span>
                )
              )}
            </div>
          )}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center justify-end gap-1">
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={async (e) => {
                const files = Array.from(e.target.files || []);
                for (const f of files) await upload(f);
                if (files.length && reviewable) await onReview(item, "submit", {});
              }}
            />
            {/* View button removed (owner 2026-07-16): the FILES paperclip already opens the gallery. */}
            {canManage && (
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                title="Attach file"
                aria-label="Attach file"
                className={ACTION_BTN_BASE + " border-border bg-surface text-ink-muted hover:border-accent/40 hover:text-accent disabled:opacity-50"}
              >
                <Paperclip size={12} />
                {uploading ? "…" : "Attach"}
              </button>
            )}
            {canManage && (
              <button
                onClick={() => setRemarkOpen((x) => !x)}
                className={cn(
                  ACTION_BTN_BASE,
                  remarkNotes.length > 0
                    ? "border-accent/40 bg-accent/5 text-accent"
                    : "border-border bg-surface text-ink-muted hover:border-accent/40 hover:text-accent"
                )}
                title="Add a remark"
              >
                <MessageSquare size={12} />
                {remarkNotes.length > 0 ? `Remark (${remarkNotes.length})` : "Remark"}
              </button>
            )}
            {canManage && (
              <button
                onClick={() => onStatus(item, naActive ? "pending" : "na")}
                className={cn(
                  ACTION_BTN_BASE,
                  naActive
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border bg-surface text-ink-muted hover:border-accent/40 hover:text-accent"
                )}
                title={naActive ? "Mark applicable" : "Mark N/A"}
              >
                <Ban size={12} />
                N/A
              </button>
            )}
          </div>
        </td>
      </tr>
      {remarkOpen && (
        <tr>
          <td colSpan={6} className="px-3 pb-2">
            <div className="rounded-md border border-border bg-bg/40 p-2">
              {remarkNotes.length > 0 && (
                <div className="mb-1.5 space-y-0.5">
                  {remarkNotes
                    .slice()
                    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
                    .map((c) => (
                      <div key={c.id} className="text-[10px] leading-snug text-ink-secondary whitespace-pre-wrap break-words">
                        <span className="text-ink-muted">{c.user_name || "—"} · {formatDateTime(c.created_at)}:</span>{" "}
                        {c.body}
                      </div>
                    ))}
                </div>
              )}
              <div className="flex items-start gap-2">
                <textarea
                  value={remark}
                  onChange={(e) => setRemark(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void postRemark(); } }}
                  rows={2}
                  placeholder="Add a remark… (Enter to post, Shift+Enter for a new line)"
                  autoFocus
                  className="min-h-[2.5rem] flex-1 resize-y whitespace-pre-wrap break-words rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] leading-snug outline-none focus:border-primary"
                />
                <button
                  onClick={() => void postRemark()}
                  disabled={!remark.trim() || postingRemark}
                  className="rounded-md bg-accent px-2.5 py-1 text-[10px] font-semibold text-white disabled:opacity-40"
                >
                  {postingRemark ? "…" : "Post"}
                </button>
                <button
                  onClick={() => { setRemarkOpen(false); setRemark(""); }}
                  className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
      {rejectOpen && (
        <tr>
          <td colSpan={6} className="px-3 pb-2">
            <div className="rounded-md border border-err/30 bg-err/5 p-2">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for rejection…"
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] outline-none focus:border-err"
              />
              <div className="mt-1.5 flex gap-2">
                <button
                  onClick={async () => {
                    if (!reason.trim()) return;
                    await onReview(item, "reject", { reason: reason.trim() });
                    setRejectOpen(false);
                    setReason("");
                  }}
                  className="rounded-md bg-err px-2 py-1 text-[10px] font-semibold text-white"
                >
                  Confirm reject
                </button>
                <button
                  onClick={() => setRejectOpen(false)}
                  className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink-muted"
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
      {open && attachments.length > 0 && (
        <tr>
          <td colSpan={6} className="px-3 pb-2">
            <div className="overflow-hidden rounded-md border border-border-subtle">
              {attachments.map((a) => {
                // Part 2 (owner 2026-08-10): a rejected version stays in the list,
                // greyed, tagged with who rejected it and when; an approved one is
                // tagged in green. Undecided current file: no tag.
                const vs = versionStatus.get(a.id);
                return (
                  <div key={a.id} className={vs?.kind === "reject" ? "opacity-60" : undefined}>
                    <TaskAttachmentRow
                      attachment={a}
                      /* id < 0 = merged crew phase photo — view/download only. */
                      canManage={canManage && a.id > 0}
                      showRemark={remarkOpen}
                      itemTitle={item.title}
                      onDelete={() => { if (a.id > 0) removeAtt(a.id); }}
                      toast={toast}
                    />
                    {vs && (
                      <div
                        className={cn(
                          "px-2 pb-1.5 text-[9px] font-semibold",
                          vs.kind === "approve" ? "text-synced" : "text-err",
                        )}
                      >
                        {vs.kind === "approve" ? "Approved" : "Rejected"} · {vs.who} ·{" "}
                        {formatDateTime(vs.at)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── 3D Approval block ─────────────────────────────────────────
// Renders the 3D APPROVAL section as simple status rows
// (PENDING / DONE / N/A) with ONE shared "Upload 3D" panel between
// the MGT and Peter steps (the file is shared between both).
function ThreeDApprovalBlock({
  items,
  attachmentsByItem,
  canManage,
  canTick,
  onStatus,
  onReload,
  toast,
}: {
  items: ChecklistItem[];
  attachmentsByItem: Map<number, TaskAttachment[]>;
  canManage: boolean;
  canTick: boolean;
  onStatus: (it: ChecklistItem, s: ChecklistStatus) => void;
  onReload: () => void;
  toast?: ReturnType<typeof useToast>;
}) {
  const mgt = items.find((i) => i.title === "3D Checked by MGT");
  const peter = items.find((i) => i.title === "3D Approved by Peter");
  const ordered = [mgt, peter].filter(Boolean) as ChecklistItem[];
  const list = ordered.length ? ordered : items;
  const sharedItem = mgt ?? items[0];
  const sharedAtt = sharedItem ? attachmentsByItem.get(sharedItem.id) ?? [] : [];
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    if (!file || !sharedItem) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      toast?.error("File needs an extension");
      return;
    }
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      await api.putBinary(
        `/api/projects/checklist/${sharedItem.id}/attachments?ext=${encodeURIComponent(
          ext
        )}&name=${encodeURIComponent(file.name)}`,
        buf,
        file.type || "application/octet-stream"
      );
      toast?.success("Uploaded");
      onReload();
    } catch (e: any) {
      toast?.error(e?.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const STAT: [ChecklistStatus, string][] = [
    ["pending", "Pending"],
    ["done", "Done"],
    ["na", "N/A"],
  ];
  const tone = (s: ChecklistStatus, active: boolean) =>
    !active
      ? "border-border bg-surface text-ink-muted hover:border-accent/40 hover:text-accent"
      : s === "done"
        ? "border-synced bg-synced/15 text-synced"
        : s === "na"
          ? "border-border bg-surface-dim text-ink-muted"
          : "border-warning bg-warning-bg text-warning-text";

  return (
    <div className="p-2">
      {list.map((it, idx) => (
        <Fragment key={it.id}>
          <div className="flex flex-wrap items-center gap-2 px-1 py-1.5">
            <button
              type="button"
              onClick={() =>
                canTick && onStatus(it, it.status === "done" ? "pending" : "done")
              }
              disabled={!canTick}
              title={it.status === "done" ? "Mark as not done" : "Mark as done"}
              aria-label={it.status === "done" ? "Mark as not done" : "Mark as done"}
              className={cn(
                "shrink-0 rounded-full",
                canTick ? "cursor-pointer hover:opacity-70" : "cursor-not-allowed opacity-60"
              )}
            >
              {it.status === "done" ? (
                <CheckCircle2 size={16} className="text-synced" />
              ) : (
                <Circle
                  size={16}
                  className={cn(
                    it.status === "na" ? "text-ink-muted" : "text-warning-text"
                  )}
                />
              )}
            </button>
            <span
              className={cn(
                "flex-1 text-[12px] font-medium",
                it.status === "done" && "text-ink-muted"
              )}
            >
              {it.title}
            </span>
            {it.required_perm && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-semibold text-accent">
                <Lock size={8} /> gated
              </span>
            )}
            <div className="flex items-center gap-1">
              {STAT.map(([s, label]) => {
                const active = it.status === s || (s === "pending" && it.status === "blocked");
                return (
                  <button
                    key={s}
                    onClick={() => onStatus(it, s)}
                    disabled={!canTick}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-[10px] font-semibold tracking-wide",
                      tone(s, active),
                      !canTick && "cursor-not-allowed opacity-60"
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          {idx === 0 && sharedItem && (
            <div className="my-1 ml-6 flex flex-wrap items-center justify-center gap-2 rounded-md border border-dashed border-border bg-bg/40 px-3 py-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={async (e) => {
                  const fs = Array.from(e.target.files || []);
                  for (const f of fs) await upload(f);
                }}
              />
              {canManage && (
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
                >
                  <Paperclip size={12} />
                  {sharedAtt.length > 0
                    ? `${sharedAtt.length} file${sharedAtt.length > 1 ? "s" : ""}`
                    : uploading
                      ? "Uploading…"
                      : "Upload 3D"}
                </button>
              )}
              {sharedAtt.length > 0 && (
                <span className="max-w-[260px] truncate text-[11px] text-ink-secondary">
                  {sharedAtt[0].file_name}
                  {sharedAtt.length > 1 ? ` + ${sharedAtt.length - 1}` : ""}
                </span>
              )}
              <span className="text-[9px] italic text-ink-muted">
                · shared between MGT &amp; Peter
              </span>
            </div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

// Inline remark box rendered under specific checklist items (e.g.
// "Deco / Coffee Table"). Edits the item's notes field; saves on blur.
function ChecklistRemark({
  item,
  onSaved,
  toast,
}: {
  item: ChecklistItem;
  onSaved: () => void;
  toast?: ReturnType<typeof useToast>;
}) {
  const [val, setVal] = useState(item.notes ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = val !== (item.notes ?? "");
  async function save() {
    if (!dirty) return;
    setSaving(true);
    try {
      await api.patch(`/api/projects/checklist/${item.id}`, { notes: val });
      onSaved();
    } catch (e: any) {
      toast?.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="rounded-md border border-border bg-bg/40 px-2.5 py-2">
      <div className="mb-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
        Remark
      </div>
      <textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        rows={2}
        placeholder="Theme / items / vendor notes…"
        className="w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] text-ink placeholder:text-ink-muted focus:border-primary/40 focus:outline-none"
      />
      {dirty && (
        <div className="mt-1 text-[9.5px] text-ink-muted">
          {saving ? "Saving…" : "Unsaved — click away to save"}
        </div>
      )}
    </div>
  );
}

function ChecklistRow({
  item,
  projectId,
  comments,
  canTick,
  canApprove,
  canManage,
  attachments,
  onStatus,
  onDelete,
  onReview,
  onCrewVisible,
  onAttachmentsChanged,
  readOnlyAttach,
  attachCaption,
  toast,
}: {
  item: ChecklistItem;
  /** Owning project — needed by the floorplan size auto-detect that runs
   *  after a Display Floor Plan upload (ChecklistItem carries no project_id). */
  projectId: number;
  comments: ChecklistComment[];
  canTick: boolean;
  canApprove: boolean;
  canManage?: boolean;
  attachments?: TaskAttachment[];
  onStatus: (s: ChecklistStatus) => void;
  onDelete: () => void;
  onReview: (
    action: "submit" | "reject" | "amend" | "approve" | "comment",
    payload: { reason?: string; note?: string }
  ) => void | Promise<void>;
  onCrewVisible?: (visible: boolean) => void | Promise<void>;
  onAttachmentsChanged?: () => void;
  /** mig: 3D shared-file — when set, the row shows another item's
   *  attachments read-only (no upload button) plus a caption. */
  readOnlyAttach?: boolean;
  attachCaption?: string;
  toast?: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const { user: authUser } = useAuth();
  // Attach capability for THIS row. canManage is projects.write; a tick-only
  // role (Purchaser since projects.write was stripped, drivers before her) may
  // also attach to a task badged for its own function — the upload endpoint has
  // always allowed exactly that, and mobile already shows the button. DELETE is
  // deliberately NOT widened here: it stays on canManage (owner 2026-08-05
  // "managers only"), matching the mobile rule.
  const mayAttachRow =
    !!canManage || (!!canTick && roleLabelAdmitsRole(item.role_label, authUser?.role_name));
  const [expanded, setExpanded] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Defect List (owner 2026-07-16): a remark is COMPULSORY before each photo —
  // Attach opens a required-remark prompt first, then the file picker, and the
  // photo uploads carrying that remark.
  const isDefectList = /^defect (list|item)/i.test((item.title || "").trim());
  const pendingCaptionRef = useRef<string | undefined>(undefined);
  async function startAttach() {
    if (isDefectList) {
      const remark = await dialog.prompt({
        title: "Remark for this photo",
        message: "Write a remark before uploading (required).",
        placeholder: "Describe the defect",
        required: true,
        multiline: true,
        confirmLabel: "Choose photo…",
      });
      if (remark == null || !remark.trim()) return;
      pendingCaptionRef.current = remark.trim();
    }
    fileInputRef.current?.click();
  }

  // Remove a file from a card-section task (owner 2026-08-11: "add remove button
  // for whoever can edit"). Gated in the UI on the SAME attach capability
  // (canManage) as the Attach button, so anyone who can add a file can remove it;
  // the backend DELETE already allows projects.write / tick-for-own-role.
  async function removeAttachment(att: TaskAttachment) {
    if (
      !(await dialog.confirm({
        message: `Remove "${att.file_name}"?`,
        danger: true,
        confirmLabel: "Remove",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/checklist/attachments/${att.id}`);
      onAttachmentsChanged?.();
    } catch (e: any) {
      toast?.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  /** Open one attachment in a new tab (auth-protected R2 goes through
   *  api.fetchBlobUrl, same as the stock-transfer + TaskAttachmentRow viewers).
   *  Used by the per-file chips on pill rows (Rental Payment / Security
   *  Deposit), where every file must be individually clickable. */
  async function openAttachment(a: TaskAttachment) {
    try {
      const url = await api.fetchBlobUrl(
        `/api/projects/attachments/${a.r2_key}`,
        viewableMime(a.r2_key),
      );
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast?.error(e?.message || "Failed to open");
    }
  }

  async function uploadAttachment(file: File, caption?: string) {
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      toast?.error("File needs an extension");
      return;
    }
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const capParam = caption && caption.trim() ? `&caption=${encodeURIComponent(caption.trim())}` : "";
      const url = `/api/projects/checklist/${item.id}/attachments?ext=${encodeURIComponent(
        ext
      )}&name=${encodeURIComponent(file.name)}${capParam}`;
      await api.putBinary(url, buf, file.type || "application/octet-stream");
      toast?.success("Uploaded");
      // Reviewable items auto-submit on upload so the approver's
      // Approve/Reject reappear (and a prior decision is superseded).
      if (isReviewableTitle(item.title)) {
        await onReview("submit", {});
      }
      // Floorplan → read the m² automatically (owner 2026-08-04: "once display
      // floorplan uploaded, auto read the measurement and fill in in size
      // box"). Best-effort and non-overwriting: a hand-typed size stands, and
      // any failure here must never make a successful upload look failed.
      if (/^(display floor\s*plan|blank floorplan)/i.test((item.title || "").trim())) {
        try {
          const r = await detectFloorplanSize(projectId);
          if (r.applied && r.detected_sqm != null) {
            toast?.success(
              `Size read from the floorplan: ${r.detected_sqm} sqm${
                r.confidence !== "high" ? " (please double-check)" : ""
              }`,
            );
          } else if (r.detected_sqm != null && r.skipped_reason === "already_set") {
            toast?.info?.(`Floorplan reads ${r.detected_sqm} sqm — the size box already has a value, left as is.`);
          }
        } catch { /* silent: the upload itself succeeded */ }
      }
      onAttachmentsChanged?.();
    } catch (e: any) {
      toast?.error(e?.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function deleteAttachment(attId: number) {
    if (
      !(await dialog.confirm({
        message: "Remove this attachment?",
        danger: true,
        confirmLabel: "Remove",
      }))
    )
      return;
    try {
      await api.del(`/api/projects/checklist/attachments/${attId}`);
      toast?.success("Attachment removed");
      onAttachmentsChanged?.();
    } catch (e: any) {
      toast?.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  const overdue =
    item.status === "pending" &&
    item.due_date &&
    new Date(item.due_date) < new Date(todayInAppTz());
  const reviewBadge = item.review_status ? REVIEW_BADGES[item.review_status] : null;
  const awaitingReview = item.review_status === "pending_review" || item.review_status === "amended";
  const reviewable = isReviewableTitle(item.title);

  // mig 090 — payment / deposit rows render as multi-state pills instead
  // of the done/pending circle. pill_value is stored via the standard
  // checklist PATCH; the row's status stays 'na' (off the progress bar).
  if (item.pill_kind) {
    const opts = paymentPillOptions(item.pill_kind);
    const cur = item.pill_value || "unpaid";
    // Terminal pill values (N/A, FULLY PAID, REFUNDED) = treat the row as done:
    // green check + greyed title. Only PENDING ("unpaid") stays "not done".
    const pillDone = cur !== "unpaid";
    const selTone = (v: string) =>
      v === "unpaid"
        ? "border-warning bg-warning-bg text-warning-text"
        : v === "none"
          ? "border-border bg-surface-dim text-ink-muted"
          : "border-synced bg-synced/15 text-synced";
    const setPill = async (v: string) => {
      if (v === cur) return;
      try {
        await api.patch(`/api/projects/checklist/${item.id}`, { pill_value: v });
        onAttachmentsChanged?.();
      } catch (e: any) {
        toast?.error(e?.message || "Something went wrong. Please try again.");
      }
    };
    return (
      <div
        className="rounded-md border border-border bg-surface px-2.5 py-2"
        data-task-id={item.id}
      >
        <div className="flex flex-wrap items-center gap-2">
          {pillDone ? (
            <CheckCircle2 size={16} className="shrink-0 text-synced" />
          ) : (
            <Circle size={16} className="shrink-0 text-ink-muted" />
          )}
          <div className="min-w-0">
            <div className={cn("text-[12px] font-medium", pillDone && "text-ink-muted")}>{item.title}</div>
            {item.role_label && roleLabelParts(item.role_label).map((part) => (
              <span key={part} className={cn("mr-1 mt-0.5 inline-block rounded-full border px-1.5 py-0.5 text-[9px] font-bold tracking-wide", roleChipClass(part))}>
                {formatRoleLabel(part)}
              </span>
            ))}
          </div>
          <span className="flex-1" />
          {mayAttachRow && (
            <button
              onClick={() => void startAttach()}
              disabled={uploading}
              className="rounded-md border border-border bg-surface p-1.5 text-ink-muted hover:border-accent/40 hover:text-accent disabled:opacity-50"
              title={attachments && attachments.length ? `${attachments.length} file(s)` : "Attach"}
            >
              <Paperclip size={13} />
            </button>
          )}
          {opts.map(([v, label]) => (
            <button
              key={v}
              onClick={() => setPill(v)}
              disabled={!canTick}
              className={cn(
                "rounded-md border inline-flex items-center justify-center min-w-[42px] whitespace-nowrap px-2 py-1 text-[8.5px] font-semibold tracking-wide",
                v === cur
                  ? selTone(v)
                  : "border-border bg-surface text-ink-muted hover:border-accent/40 hover:text-accent",
                !canTick && "cursor-not-allowed opacity-60"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Attach below the row — allow multiple (e.g. deposit + balance slips). */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={async (e) => {
            const files = Array.from(e.target.files || []);
            for (const f of files) await uploadAttachment(f);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
        {/* Every attachment gets its OWN clickable chip (owner 2026-08-01:
            "got 2 file but list only appear one … so i can click in"). The old
            single line printed "<first> + N more", which hid the other files
            and opened nothing. */}
        {attachments && attachments.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {attachments.map((a) => (
              <div key={a.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void openAttachment(a); }}
                  title={`Open ${a.file_name}`}
                  className="flex min-w-0 items-center gap-1 text-left text-[10px] text-ink-muted hover:text-accent"
                >
                  <Paperclip size={11} className="shrink-0" />
                  <span className="truncate underline decoration-dotted underline-offset-2">
                    {a.file_name}
                  </span>
                </button>
                {/* Remove file — shown to whoever can attach here (owner
                    2026-08-11). id < 0 = merged crew photo, never removable. */}
                {canManage && !readOnlyAttach && a.id > 0 && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); void removeAttachment(a); }}
                    title="Remove file"
                    aria-label={`Remove ${a.file_name}`}
                    className="shrink-0 text-ink-muted hover:text-err"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-surface px-2.5 py-2",
        item.status === "done" && "bg-synced/5",
        item.status === "na" && "opacity-60",
        overdue && "border-err/40 bg-err/5",
        item.review_status === "rejected" && "border-err/30",
        "transition-shadow"
      )}
      data-task-id={item.id}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={() => onStatus(item.status === "done" ? "pending" : "done")}
          disabled={!canTick || !canApprove}
          className="mt-0.5 shrink-0"
          title={
            !canTick
              ? "You don't have permission to tick checklist items"
              : !canApprove
              ? `Requires ${item.required_perm}`
              : "Toggle done"
          }
        >
          {item.status === "done" ? (
            <CheckCircle2 size={16} className="text-synced" />
          ) : !canTick || !canApprove ? (
            <Lock size={16} className="text-ink-muted" />
          ) : (
            <Circle size={16} className="text-ink-muted hover:text-accent" />
          )}
        </button>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0">
            <span
              className={cn(
                "text-[12px] font-medium",
                item.status === "done" && "text-ink-muted line-through"
              )}
            >
              {item.title}
            </span>
            {(item.role_label || item.required_perm || reviewBadge) && (
              <div className="mt-0.5 flex basis-full flex-wrap items-center gap-1.5">
                {item.role_label && roleLabelParts(item.role_label).map((part) => (
                  <span
                    key={part}
                    className={cn("rounded-full border px-1.5 py-0.5 text-[9px] font-bold tracking-wide", roleChipClass(part))}
                    title="Owner role"
                  >
                    {formatRoleLabel(part)}
                  </span>
                ))}
                {item.required_perm && (
                  <span
                    className="inline-flex items-center gap-0.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-semibold text-accent"
                    title={item.required_perm}
                  >
                    <Lock size={8} /> gated
                  </span>
                )}
                {reviewBadge && (
                  <span
                    className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider", reviewBadge.cls)}
                  >
                    {reviewBadge.label}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ink-muted">
            {item.due_date && (
              <span className={cn(overdue && "font-semibold text-err")}>
                Due {formatDate(item.due_date)}
              </span>
            )}
            {item.owner_name && <span>· {item.owner_name}</span>}
            {item.completed_at && item.completed_by_name && (
              <span>
                · Done by {item.completed_by_name} {formatDate(item.completed_at)}
              </span>
            )}
            {item.description && (
              <span className="basis-full text-ink-secondary">{item.description}</span>
            )}
            {attachments && attachments.length > 0 && (
              <span className="basis-full text-ink-muted">
                {attachments[0].uploader_name || "Unknown"} ·{" "}
                {formatDateTime(attachments[0].uploaded_at)}
                {attachments.length > 1 && ` · +${attachments.length - 1} more`}
              </span>
            )}
            {item.rejection_reason && item.review_status === "rejected" && (
              <span className="basis-full rounded bg-err/10 px-2 py-1 text-err">
                Rejected: {item.rejection_reason}
              </span>
            )}
            {/* Per-task attachments (mig 050). Table layout: clicking
                the name downloads; delete button on the right when the
                user can manage. */}
            {((attachments && attachments.length > 0) || canManage) && (
              <div className="mt-1 basis-full">
                {attachments && attachments.length > 0 && (
                  <div className="overflow-hidden rounded-md border border-border-subtle">
                    <div className="grid grid-cols-[minmax(0,1fr)_110px_90px_28px] items-center gap-2 bg-bg/60 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
                      <span>Name</span>
                      <span>Uploaded by</span>
                      <span>Date</span>
                      <span />
                    </div>
                    {attachments.map((a) => (
                      <TaskAttachmentRow
                        key={a.id}
                        attachment={a}
                        /* id < 0 = a crew phase photo merged in from the
                           phase-photos table — view/download only; deleting it
                           needs the Phase Photos block, not this row. */
                        canManage={canManage && a.id > 0}
                        showRemark={expanded}
                        itemTitle={item.title}
                        onDelete={() => { if (a.id > 0) deleteAttachment(a.id); }}
                        toast={toast}
                      />
                    ))}
                  </div>
                )}
                {attachCaption && (
                  <div className="mt-1 text-[10px] italic text-ink-muted">
                    {attachCaption}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              const cap = pendingCaptionRef.current;
              pendingCaptionRef.current = undefined;
              if (f) uploadAttachment(f, cap);
            }}
          />
          {/* Attach / Remark / N/A — BOXED style (owner 2026-08-11):
              "one consistent button style for this action group across the
              entire desktop PMS". These were an icon-stack (icon over label, no
              border) while the table sections (Contract, Booth Layout & Setup)
              used a bordered box, so the same three actions looked like two
              different controls depending on the section. Now every section
              uses the DocRow treatment: icon + label inside one bordered pill,
              accent-filled when active. */}
          {mayAttachRow && !readOnlyAttach && (
            <button
              onClick={() => void startAttach()}
              disabled={uploading}
              className={ACTION_BTN_BASE + " border-border bg-surface text-ink-muted hover:border-accent/40 hover:text-accent disabled:opacity-50"}
              title="Attach file"
            >
              <Paperclip size={12} />
              {uploading ? "…" : "Attach"}
            </button>
          )}
          <button
            onClick={() => setExpanded((x) => !x)}
            className={cn(
              ACTION_BTN_BASE,
              expanded
                ? "border-accent/40 bg-accent/5 text-accent"
                : "border-border bg-surface text-ink-muted hover:border-accent/40 hover:text-accent"
            )}
            title="Remark"
          >
            <MessageSquare size={12} />
            Remark
          </button>
          <button
            onClick={() => onStatus(item.status === "na" ? "pending" : "na")}
            className={cn(
              ACTION_BTN_BASE,
              item.status === "na"
                ? "border-accent bg-accent/10 text-accent"
                : "border-border bg-surface text-ink-muted hover:border-accent/40 hover:text-accent"
            )}
            title={item.status === "na" ? "Mark applicable" : "Mark N/A"}
          >
            <Ban size={12} />
            N/A
          </button>
        </div>
      </div>

      {/* Management approve/reject. A gated task (required_perm) offers the
          buttons to a permission holder whenever it still needs the decision
          (owner 2026-07-21); non-gated reviewable docs keep submit-then-review.
          BUT only once a file is uploaded (owner 2026-07-27): there is nothing
          to approve before the document exists. */}
      {/* Owner 2026-07-31 (final): on a gated document the approver ALWAYS
          keeps Approve/Reject once a file exists — approved ones included — so
          a decision can be reviewed or reversed. Mirrors the mobile
          checklistReviewVisible gate; the decision stays on the review badge. */}
      {/* Owner 2026-08-10 toggle, applied here 2026-08-17 ("i cant click
          approve"): show only the button that REVERSES the current decision.
          The table rows (DocRow) got this on 08-10 but this card block kept
          showing an enabled Approve on an already-approved item — the backend
          approve is idempotent (08-08), so the click was a silent no-op that
          read as a dead button. Approved → Reject only; rejected → Approve
          only; undecided → both. */}
      {!!attachments && attachments.length > 0 && (item.required_perm
        ? canApprove
        : reviewable && awaitingReview && canApprove) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Management remark (required to reject)…"
              className="min-w-[160px] flex-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] outline-none focus:border-primary/40"
            />
            {item.review_status !== "approved" && (
              <button
                onClick={async () => {
                  if (reason.trim()) await onReview("comment", { note: reason.trim() });
                  await onReview("approve", {});
                  setReason("");
                }}
                className="rounded-md bg-synced/90 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-synced"
              >
                Approve
              </button>
            )}
            {item.review_status !== "rejected" && (
              <button
                onClick={async () => {
                  if (!reason.trim()) {
                    toast?.error("Add a remark to reject");
                    return;
                  }
                  await onReview("reject", { reason: reason.trim() });
                  setReason("");
                }}
                className="rounded-md border border-err/40 bg-surface px-2.5 py-1 text-[10px] font-semibold text-err hover:bg-err/5"
              >
                Reject
              </button>
            )}
          </div>
        )}

      {/* Owner 2026-07-22: the item-level "Note" thread duplicated the per-file
          remark under each attachment, so it's hidden for tasks that carry
          files (use the per-file remark there). A file-LESS task — e.g. Weekend
          Activity, "remark only, no file needed" — has no per-file remark, so it
          keeps this simple remark box. Falls away the moment a file is added. */}
      {expanded && (!attachments || attachments.length === 0) && (
        <div className="mt-2 border-t border-border pt-2">
          {comments.filter((c) => c.kind !== "submit" && c.kind !== "upload" && c.kind !== "remove" && c.body).length > 0 && (
            <div className="mb-2 space-y-1">
              {comments
                .filter((c) => c.kind !== "submit" && c.kind !== "upload" && c.kind !== "remove" && c.body)
                .map((c) => (
                  <div key={c.id} className="rounded bg-bg/60 px-2 py-1 text-[10.5px] whitespace-pre-wrap break-words">
                    <span className={cn("font-semibold", commentKindColor(c.kind))}>
                      {commentKindLabel(c.kind)}
                    </span>
                    {c.body && <span className="ml-1 text-ink-secondary">— {c.body}</span>}
                    <span className="ml-2 text-ink-muted">
                      {c.user_name || "—"} · {formatDate(c.created_at)}
                    </span>
                  </div>
                ))}
            </div>
          )}
          <div className="flex items-start gap-1.5">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Add a remark…"
              className="min-h-[2.25rem] flex-1 resize-y whitespace-pre-wrap break-words rounded-md border border-border bg-surface px-2 py-1 text-[11px] leading-snug outline-none focus:border-primary"
            />
            <button
              onClick={async () => {
                if (!note.trim()) return;
                await onReview("comment", { note: note.trim() });
                setNote("");
              }}
              disabled={!note.trim()}
              className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-40"
            >
              Post
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function commentKindLabel(k: string): string {
  switch (k) {
    case "submit":
      return "Submitted for review";
    case "reject":
      return "Rejected";
    case "amend":
      return "Marked amended";
    case "approve":
      return "Approved";
    case "upload":
      return "Uploaded";
    case "remove":
      return "Removed";
    default:
      return "Note";
  }
}

function commentKindColor(k: string): string {
  switch (k) {
    case "reject":
    case "remove":
      return "text-err";
    case "approve":
      return "text-synced";
    case "submit":
    case "amend":
    case "upload":
      return "text-accent";
    default:
      return "text-ink";
  }
}

function AddChecklistItem({
  projectId,
  users,
  sectionId,
  onAdded,
  onCancel,
  toast,
}: {
  projectId: number;
  users: { id: number; name: string }[];
  sectionId?: number | null;
  onAdded: () => void;
  onCancel: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [ownerId, setOwnerId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await api.post(`/api/projects/${projectId}/checklist`, {
        title: title.trim(),
        description: description.trim() || undefined,
        due_date: dueDate || undefined,
        owner_user_id: ownerId ? parseInt(ownerId, 10) : undefined,
        section_id: sectionId ?? undefined,
      });
      onAdded();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="mt-2 rounded-md border border-border bg-bg/60 p-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title…"
        className="mb-2 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] outline-none focus:border-primary"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional) — context, instructions, acceptance criteria…"
        rows={2}
        className="mb-2 w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
      />
      <div className="mb-2 flex items-center gap-2">
        <DateField
          fullWidth
          value={dueDate}
          onChange={(iso) => setDueDate(iso)}
          placeholder="Due date"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px]"
        />
        <select
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
          className="flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        >
          <option value="">— assign to —</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting || !title.trim()}
          className="ml-auto rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          Add
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Datetime field (inline commit on blur) ───────────────────
// InlineEdit supports only text/date/number; this is the logistics analog, and
// NOT the shared DateTimeField also imported here — they differ in CONTRACT.

function LogisticsDateTimeField({
  label,
  value,
  onSave,
  readOnly = false,
}: {
  label: string;
  value: string | null | undefined;
  onSave: (next: string | null) => Promise<void> | void;
  /** View-only for Sales (owner 2026-07): disable inputs, no commit. */
  readOnly?: boolean;
}) {
  // Split into a separate date + time input — the native datetime-local
  // control is too wide for the Logistics 2-col grid (browser locale +
  // AM/PM stretches it on Windows). Two narrow controls side-by-side
  // pack tighter and the unambiguous DD/MM/YYYY HH:mm caption sits
  // below for confirmation.
  const initial = toLocalInput(value);
  const [datePart, setDatePart] = useState(initial.slice(0, 10));
  const [timePart, setTimePart] = useState(initial.slice(11, 16));
  useEffect(() => {
    const v = toLocalInput(value);
    setDatePart(v.slice(0, 10));
    setTimePart(v.slice(11, 16));
  }, [value]);

  const draft = datePart && timePart ? `${datePart}T${timePart}` : datePart;

  async function commit() {
    // Treat "date only" as midnight-local so the user can still tap a
    // date and hit save; without this, half-filled inputs would never
    // persist.
    const normalized =
      datePart && !timePart
        ? `${datePart}T00:00`
        : datePart && timePart
          ? `${datePart}T${timePart}`
          : null;
    if ((normalized ?? "") === (toLocalInput(value) || "")) return;
    await onSave(normalized);
  }

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <div className="flex gap-1.5">
        <DateField
          fullWidth
          value={datePart}
          disabled={readOnly}
          onChange={(iso) => setDatePart(iso)}
          onBlur={readOnly ? undefined : commit}
          className="flex-1 min-w-0 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-bg/40 disabled:opacity-70"
        />
        <input
          type="time"
          value={timePart}
          disabled={readOnly}
          onChange={(e) => setTimePart(e.target.value)}
          onBlur={readOnly ? undefined : commit}
          className="w-[88px] rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:bg-bg/40 disabled:opacity-70"
        />
      </div>
      <div className="mt-1 font-mono text-[10px] text-ink-muted">
        {formatDateTime(draft)}
      </div>
    </div>
  );
}

// datetime-local inputs expect "YYYY-MM-DDTHH:mm" (no seconds, no Z).
// Our backend stores ISO strings like "2025-08-25T23:00:00.000Z" OR
// "2025-08-25T23:00". Strip to the first 16 chars after normalization.
function toLocalInput(v: string | null | undefined): string {
  if (!v) return "";
  // Drop any trailing "Z" or ms — we treat stored values as already
  // local-ish since the user enters them in local time.
  return v.slice(0, 16);
}

// ── Project banner ───────────────────────────────────────────
// Optional warning/info strip shown above every section.

function ProjectBanner({
  message,
  tone,
}: {
  message: string;
  tone: "info" | "warning" | "error" | null;
}) {
  const t = tone || "warning";
  const palette =
    t === "error"
      ? "border-err/40 bg-err/10 text-err"
      : t === "info"
      ? "border-accent/40 bg-accent-soft/30 text-ink"
      : "border-amber-500/50 bg-amber-50 text-amber-900";
  const Icon = t === "error" ? AlertOctagon : t === "info" ? Info : AlertTriangle;
  return (
    <div
      className={cn(
        "mb-4 flex items-center gap-2 rounded-md border px-4 py-2 text-[12px]",
        palette
      )}
    >
      <Icon size={14} className="shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// ── Logistics schedule + crew ────────────────────────────────
// Separate from the customer-facing event date range. This is when
// the booth is actually being built / torn down, who's driving, and
// which lorry is moving stock.

// ── Stock transfer section ───────────────────────────────────
// OUT (to venue) + RETURN (back to warehouse). Each row has optional
// attached sheet image/PDF and a confirmed-at stamp separate from
// transferred_at — "we moved it" vs "someone verified the count".

function StockTransferSection({
  projectId,
  transfers,
  onChange,
  toast,
}: {
  projectId: number;
  transfers: StockTransfer[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [adding, setAdding] = useState<null | "out" | "return">(null);
  const outgoing = transfers.filter((t) => t.direction === "out");
  const returning = transfers.filter((t) => t.direction === "return");

  async function toggleConfirm(t: StockTransfer) {
    try {
      if (t.confirmed_at) {
        await api.post(`/api/projects/stock-transfers/${t.id}/unconfirm`, {});
      } else {
        await api.post(`/api/projects/stock-transfers/${t.id}/confirm`, {});
      }
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function remove(t: StockTransfer) {
    if (!await dialog.confirm("Remove this transfer record?")) return;
    try {
      await api.del(`/api/projects/stock-transfers/${t.id}`);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function openFile(t: StockTransfer) {
    if (!t.record_r2_key) return;
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${t.record_r2_key}`, viewableMime(t.record_r2_key));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  function Row({ t }: { t: StockTransfer }) {
    const confirmed = !!t.confirmed_at;
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-3 py-2 text-[11px]",
          confirmed ? "border-synced/30 bg-synced/5" : "border-border bg-surface"
        )}
      >
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
            t.direction === "out" ? "bg-amber-100 text-amber-800" : "bg-accent/15 text-accent"
          )}
        >
          {t.direction === "out" ? "OUT" : "RETURN"}
        </span>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {t.transferred_at && (
              <span>{formatDateTime(t.transferred_at)}</span>
            )}
            {t.notes && <span className="text-ink-secondary">— {t.notes}</span>}
          </div>
          <div className="text-[10px] text-ink-muted">
            {t.created_by_name && `Logged by ${t.created_by_name}`}
            {confirmed && t.confirmed_by_name && (
              <span className="ml-2 inline-flex items-center gap-1 text-synced">
                <Check size={11} /> Confirmed by {t.confirmed_by_name} {formatDate(t.confirmed_at)}
              </span>
            )}
          </div>
        </div>
        {t.record_r2_key && (
          <button
            onClick={() => openFile(t)}
            className="rounded p-1 text-ink-muted hover:text-accent"
            title="Open transfer sheet"
          >
            <ExternalLink size={12} />
          </button>
        )}
        <button
          onClick={() => toggleConfirm(t)}
          className={cn(
            "rounded p-1",
            confirmed ? "text-synced hover:bg-synced/10" : "text-ink-muted hover:bg-accent-soft hover:text-accent"
          )}
          title={confirmed ? "Unconfirm" : "Confirm"}
        >
          <CheckCircle2 size={12} />
        </button>
        <button
          onClick={() => remove(t)}
          className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
          title="Remove"
        >
          <Trash2 size={12} />
        </button>
      </div>
    );
  }

  return (
    <PanelSection title={`Stock Transfer (${transfers.length})`}>
      <div className="mb-3">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-800">
            OUT — to venue ({outgoing.length})
          </div>
          <button
            onClick={() => setAdding("out")}
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
          >
            <Plus size={11} /> Log OUT
          </button>
        </div>
        {outgoing.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-2 text-[11px] text-ink-muted">
            No outbound transfers.
          </div>
        ) : (
          <div className="space-y-1">{outgoing.map((t) => <Row key={t.id} t={t} />)}</div>
        )}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-accent">
            RETURN — back to warehouse ({returning.length})
          </div>
          <button
            onClick={() => setAdding("return")}
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
          >
            <Plus size={11} /> Log RETURN
          </button>
        </div>
        {returning.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-2 text-[11px] text-ink-muted">
            No return transfers.
          </div>
        ) : (
          <div className="space-y-1">{returning.map((t) => <Row key={t.id} t={t} />)}</div>
        )}
      </div>

      {adding && (
        <AddStockTransferForm
          projectId={projectId}
          direction={adding}
          onCancel={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            onChange();
          }}
          toast={toast}
        />
      )}
    </PanelSection>
  );
}

function AddStockTransferForm({
  projectId,
  direction,
  onCancel,
  onSaved,
  toast,
}: {
  projectId: number;
  direction: "out" | "return";
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [transferredAt, setTransferredAt] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      let r2Key: string | undefined;
      let fileName: string | undefined;
      let mimeType: string | undefined;
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          toast.error("File exceeds 10MB");
          setSubmitting(false);
          return;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const buf = await file.arrayBuffer();
        const up = await api.putBinary<{ key: string; mime_type: string }>(
          `/api/projects/${projectId}/stock-transfers/upload?ext=${ext}`,
          buf,
          file.type
        );
        r2Key = up.key;
        fileName = file.name;
        mimeType = up.mime_type;
      }
      await api.post(`/api/projects/${projectId}/stock-transfers`, {
        direction,
        transferred_at: transferredAt || undefined,
        notes: notes.trim() || undefined,
        record_r2_key: r2Key,
        file_name: fileName,
        mime_type: mimeType,
      });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">
        New {direction === "out" ? "OUT" : "RETURN"} transfer
      </div>
      <div className="grid grid-cols-2 gap-2">
        <DateTimeField
          aria-label="Transferred at"
          value={transferredAt}
          onChange={setTransferredAt}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
        <input
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.pdf,.xlsx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none"
        />
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (item list, qty, driver, etc.)"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── PIC role chip colour by role ──────────────────────────────
// Shared helper used by the crew section's "LOGISTIC" badge. (The
// branch also uses this on checklist rows; that doc-mode work is out
// of scope for this port, so the helper is introduced here standalone.)
// Owner 2026-07-29: a combined role_label ("SALES PIC & DRIVER") renders as
// SEPARATE tags — one chip per role, each in its own colour — never one
// merged "Sales PIC & Driver" pill.
function roleLabelParts(label: string): string[] {
  return label.split("&").map((s) => s.trim()).filter(Boolean);
}

/** Does the task's role badge admit this user's role? MIRRORS the backend
 *  `roleLabelAdmits` (backend/src/services/projectGates.ts) and the mobile copy
 *  in MobilePMS.tsx: exact match on each "&"-separated part, plus DRIVER-badged
 *  field tasks admitting HELPER / STOREKEEPER (no task is ever badged those).
 *  Desktop had no copy of this rule, which is why a tick-only role saw no
 *  Attach button on its OWN badged documents while mobile and the API allowed
 *  the upload — see attachAdmitsRole below. */
function roleLabelAdmitsRole(
  label: string | null | undefined,
  roleName: string | null | undefined,
): boolean {
  const r = (roleName ?? "").trim().toUpperCase();
  if (!r) return false;
  return roleLabelParts((label ?? "").toUpperCase()).some(
    (l) => l === r || (l === "DRIVER" && (r === "HELPER" || r === "STOREKEEPER")),
  );
}

/** THE Attach / Remark / N/A button shape for the whole desktop PMS (owner
 *  2026-08-11: "one consistent button style for this action group across the
 *  entire desktop PMS"). Boxed = icon + label inside a bordered pill, the style
 *  the Contract / Booth Layout tables already used; the checklist-card sections
 *  (Operation, Setup & Dismantle Documents, Expo Map) were an unbordered
 *  icon-stack. Callers append only the colour/state classes, so the geometry can
 *  never drift between sections again. */
const ACTION_BTN_BASE =
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[9px] font-semibold leading-none min-w-[46px]";

function roleChipClass(role: string | null | undefined): string {
  switch ((role || "").toUpperCase()) {
    case "SALES PIC":
    // Shared sales+driver deliverables (the Defect List pair, owner 2026-07-29).
    case "SALES PIC & DRIVER":
      return "border-pink-300 bg-pink-100 text-pink-700";
    case "DRIVER":
      return "border-blue-300 bg-blue-100 text-blue-700";
    case "PURCHASER":
      return "border-orange-300 bg-orange-100 text-orange-700";
    case "LOGISTIC":
    case "LOGISTICS":
      return "border-green-300 bg-green-100 text-green-700";
    case "BD":
      return "border-purple-300 bg-purple-100 text-purple-700";
    default:
      return "border-border bg-bg/40 text-ink-secondary";
  }
}

// Owner 2026-07-15: role badges read sentence-case ("Purchaser", "Driver",
// "Sales PIC") instead of shouting all-caps — genuine acronyms (BD, PIC) stay
// uppercase, matching how the app writes them elsewhere.
const ROLE_ACRONYMS = new Set(["BD", "PIC", "PO", "DO", "PPE", "3D", "2D"]);
function formatRoleLabel(label: string): string {
  return label
    .trim()
    .split(/\s+/)
    .map((w) => (ROLE_ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

// ── Setup & Dismantle crew editor (JSON: setup_crew / dismantle_crew) ──
type CrewSlot = { name: string; phone: string };
// Per-lorry crew (owner 2026-07-13): each lorry carries its OWN drivers + helpers.
// provider (owner 2026-07-23): a trip that is NOT an internal lorry is done by
// Grab or Lalamove — chosen per lorry card. "" = internal lorry (use plate).
type LorryCrew = { plate: string; provider?: string; drivers: CrewSlot[]; helpers: CrewSlot[] };
// Outsourced trip (owner 2026-07-23): Setup & Dismantle offer three providers.
// Outsource / Lalamove carry a manual name·phone·plate; Grab carries two staff
// helpers (helper1/helper2) instead. `provider` absent = legacy Outsource entry.
type OutsourcedProvider = "outsource" | "lalamove" | "grab";
type OutsourcedEntry = {
  provider?: OutsourcedProvider;
  name?: string;
  phone?: string;
  plate?: string;
  helper1?: string;
  helper2?: string;
};
interface PhaseCrew {
  /** The editable per-lorry structure. */
  lorryCrew: LorryCrew[];
  /** Flat mirrors DERIVED from lorryCrew on save — kept so the mobile view,
   *  the stage stepper, and any other legacy reader of {drivers,helpers,lorries}
   *  keep working unchanged. Never edited directly. */
  drivers: CrewSlot[];
  helpers: CrewSlot[];
  lorries: string[];
  outsourced: { enabled: boolean; entries: OutsourcedEntry[] };
  /** Free-text note — used by the Service / Exchange phase ("what service /
   *  exchange"). This one is the INTERNAL-LORRY remark. Empty for
   *  setup/dismantle. Persisted inside the same JSON. */
  remark: string;
  /** Second Service / Exchange note — for the OUTSOURCED (Grab/Lalamove) side,
   *  kept separate from the lorry remark (owner 2026-07-23). */
  outsourcedRemark: string;
}
function deriveFlatCrew(lorryCrew: LorryCrew[]): { drivers: CrewSlot[]; helpers: CrewSlot[]; lorries: string[] } {
  const named = (a: CrewSlot[]) => (Array.isArray(a) ? a : []).filter((x) => x && x.name && x.name.trim());
  return {
    drivers: lorryCrew.flatMap((l) => named(l.drivers)),
    helpers: lorryCrew.flatMap((l) => named(l.helpers)),
    lorries: lorryCrew.map((l) => l.plate).filter((pl) => pl && pl.trim()),
  };
}
function parsePhaseCrew(s: string | null | undefined): PhaseCrew {
  const empty: PhaseCrew = { lorryCrew: [], drivers: [], helpers: [], lorries: [], outsourced: { enabled: false, entries: [] }, remark: "", outsourcedRemark: "" };
  if (!s) return empty;
  try {
    const p = JSON.parse(s) || {};
    const outsourced = {
      enabled: !!(p.outsourced && p.outsourced.enabled),
      entries: Array.isArray(p.outsourced?.entries)
        ? p.outsourced.entries
        : p.outsourced?.name
          ? [{ name: p.outsourced.name, phone: p.outsourced.phone ?? "", plate: p.outsourced.plate ?? "" }]
          : [],
    };
    let lorryCrew: LorryCrew[];
    if (Array.isArray(p.lorry_crew) && p.lorry_crew.length) {
      lorryCrew = p.lorry_crew.map((l: any) => ({
        plate: typeof l?.plate === "string" ? l.plate : "",
        provider: typeof l?.provider === "string" ? l.provider : "",
        drivers: Array.isArray(l?.drivers) ? l.drivers : [],
        helpers: Array.isArray(l?.helpers) ? l.helpers : [],
      }));
    } else {
      // Legacy flat crew → fold into one lorry per plate, crew on the first.
      const oldDrivers: CrewSlot[] = Array.isArray(p.drivers) ? p.drivers : [];
      const oldHelpers: CrewSlot[] = Array.isArray(p.helpers) ? p.helpers : [];
      const oldPlates: string[] = Array.isArray(p.lorries) ? p.lorries.filter((x: any) => typeof x === "string" && x.trim()) : [];
      if (oldPlates.length) {
        lorryCrew = oldPlates.map((plate, i) => (i === 0 ? { plate, drivers: oldDrivers, helpers: oldHelpers } : { plate, drivers: [], helpers: [] }));
      } else if (oldDrivers.length || oldHelpers.length) {
        lorryCrew = [{ plate: "", drivers: oldDrivers, helpers: oldHelpers }];
      } else {
        lorryCrew = [];
      }
    }
    return {
      lorryCrew,
      ...deriveFlatCrew(lorryCrew),
      outsourced,
      remark: typeof p.remark === "string" ? p.remark : "",
      outsourcedRemark: typeof p.outsourced_remark === "string" ? p.outsourced_remark : "",
    };
  } catch {
    return empty;
  }
}
function serializePhaseCrew(pc: PhaseCrew): string {
  return JSON.stringify({
    lorry_crew: pc.lorryCrew,
    ...deriveFlatCrew(pc.lorryCrew),
    outsourced: pc.outsourced,
    remark: pc.remark ?? "",
    outsourced_remark: pc.outsourcedRemark ?? "",
  });
}

function CrewSlotRow({
  label,
  color,
  options,
  slot,
  onChange,
  readOnly = false,
}: {
  label: string;
  color: string;
  options: CrewMember[];
  slot: CrewSlot | undefined;
  onChange: (s: CrewSlot) => void;
  /** View-only for Sales (owner 2026-07): disable both controls. */
  readOnly?: boolean;
}) {
  const cur = slot ?? { name: "", phone: "" };
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,1fr)_6.75rem] sm:items-center">
      <div className="flex min-w-0 items-center gap-1">
        <UserCircle2 size={12} className={cn("shrink-0", color)} />
        <span className="w-11 shrink-0 text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
          {label}
        </span>
        <select
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-1.5 py-1 text-[12px] disabled:bg-bg/40 disabled:opacity-70"
          value={cur.name}
          disabled={readOnly}
          onChange={(e) => {
            const u = options.find((o) => o.name === e.target.value);
            onChange({ name: e.target.value, phone: u?.phone ?? (e.target.value ? cur.phone : "") });
          }}
        >
          <option value="">Name…</option>
          {options.map((o) => (
            <option key={o.id} value={o.name}>
              {o.name}
            </option>
          ))}
          {cur.name && !options.some((o) => o.name === cur.name) && (
            <option value={cur.name}>{cur.name}</option>
          )}
        </select>
      </div>
      <input
        className="min-w-0 rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] disabled:bg-bg/40"
        placeholder={cur.name ? "Phone…" : "(pick a name first)"}
        value={cur.phone}
        disabled={readOnly || !cur.name}
        onChange={(e) => onChange({ name: cur.name, phone: e.target.value })}
      />
    </div>
  );
}

function OutsourcedBox({
  onAdd,
}: {
  onAdd: (o: { name: string; phone: string; plate: string }) => void;
}) {
  const [d, setD] = useState({ name: "", phone: "", plate: "" });
  return (
    <div className="space-y-2 rounded-md border border-dashed border-border bg-bg/40 p-2">
      <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Name…" className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]" />
      <input value={d.phone} onChange={(e) => setD({ ...d, phone: e.target.value })} placeholder="Phone number…" className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]" />
      <input value={d.plate} onChange={(e) => setD({ ...d, plate: e.target.value })} placeholder="Lorry plate…" className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]" />
      <button
        onClick={() => {
          if (!d.name.trim() && !d.plate.trim()) return;
          onAdd(d);
          setD({ name: "", phone: "", plate: "" });
        }}
        className="rounded-md bg-synced/90 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-synced"
      >
        + Add
      </button>
    </div>
  );
}

// Grab trip (owner 2026-07-23): instead of a manual name/phone/plate, a Grab
// trip is two staff helpers riding together, picked from the full helper list.
function GrabHelperBox({
  helpers,
  onAdd,
}: {
  helpers: CrewMember[];
  onAdd: (o: { helper1: string; helper2: string }) => void;
}) {
  const [h, setH] = useState({ helper1: "", helper2: "" });
  const HelperSelect = ({ which, label }: { which: "helper1" | "helper2"; label: string }) => (
    <select
      value={h[which]}
      onChange={(e) => setH({ ...h, [which]: e.target.value })}
      className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
    >
      <option value="">{label}…</option>
      {helpers.map((o) => (
        <option key={o.id} value={o.name}>{o.name}</option>
      ))}
    </select>
  );
  return (
    <div className="space-y-2 rounded-md border border-dashed border-border bg-bg/40 p-2">
      <HelperSelect which="helper1" label="Helper 1" />
      <HelperSelect which="helper2" label="Helper 2" />
      <button
        onClick={() => {
          if (!h.helper1 && !h.helper2) return;
          onAdd(h);
          setH({ helper1: "", helper2: "" });
        }}
        className="rounded-md bg-synced/90 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-synced"
      >
        + Add
      </button>
    </div>
  );
}

const OUTSOURCED_PROVIDER_LABEL: Record<OutsourcedProvider, string> = {
  outsource: "Outsource",
  lalamove: "Lalamove",
  grab: "Grab",
};

// One chip per outsourced trip — Grab shows its two helpers, the others show
// the manual name / phone / plate. Falls back to name/phone/plate for any
// legacy Grab row that predates the helper picker. Shared by every phase.
function OutsourcedEntryChips({
  entries,
  readOnly,
  onRemove,
}: {
  entries: OutsourcedEntry[];
  readOnly: boolean;
  onRemove: (i: number) => void;
}) {
  if (!entries.length) return null;
  const rawProvider = (o: OutsourcedEntry) => (o.provider ?? "outsource").toString().toLowerCase();
  const providerKey = (o: OutsourcedEntry): OutsourcedProvider =>
    rawProvider(o) === "grab" ? "grab" : rawProvider(o) === "lalamove" ? "lalamove" : "outsource";
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map((o, i) => {
        const provider = providerKey(o);
        const helperDetail = [o.helper1, o.helper2].filter(Boolean).join(" · ");
        const manualDetail = [o.name, o.phone ? formatPhone(o.phone) : "", o.plate].filter(Boolean).join(" · ");
        const detail = provider === "grab" && helperDetail ? helperDetail : manualDetail || helperDetail;
        return (
          <span key={i} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[11px]">
            <span className="font-semibold text-ink-secondary">{OUTSOURCED_PROVIDER_LABEL[provider]}</span>
            {detail && <span className="text-ink">· {detail}</span>}
            {!readOnly && (
              <button onClick={() => onRemove(i)} className="text-ink-muted hover:text-err">
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

function PhaseCrewEditor({
  title,
  field,
  value,
  drivers,
  helpers,
  lorryOptions,
  patch,
  emptyHint,
  headerExtra,
  showRemark = false,
  remarkLabel = "Remark",
  readOnly = false,
}: {
  title: string;
  field: "setup_crew" | "dismantle_crew" | "service_crew";
  value: string | null | undefined;
  drivers: CrewMember[];
  helpers: CrewMember[];
  lorryOptions: string[];
  patch: (body: Record<string, any>) => Promise<void>;
  emptyHint?: string;
  /** Rendered above the "{title} Drivers" heading (e.g. the Dismantle Time field). */
  headerExtra?: React.ReactNode;
  /** Show a free-text remark box under the crew (Service / Exchange phase). */
  showRemark?: boolean;
  remarkLabel?: string;
  /** View-only for Sales (owner 2026-07): render current crew/plates but
   *  disable every control and suppress the add/remove/save actions. */
  readOnly?: boolean;
}) {
  const [pc, setPc] = useState<PhaseCrew>(() => parsePhaseCrew(value));
  useEffect(() => {
    setPc(parsePhaseCrew(value));
  }, [value]);
  function save(next: PhaseCrew) {
    setPc(next);
    patch({ [field]: serializePhaseCrew(next) });
  }
  // Remarks save on blur (not per keystroke) so a long note isn't a PATCH storm.
  const [remarkDraft, setRemarkDraft] = useState(pc.remark);
  useEffect(() => setRemarkDraft(pc.remark), [pc.remark]);
  // Which provider's add-box is open in the Setup/Dismantle outsourced row.
  const [openProvider, setOpenProvider] = useState<OutsourcedProvider | null>(null);
  const addOutsourced = (entry: OutsourcedEntry) =>
    save({ ...pc, outsourced: { enabled: true, entries: [...pc.outsourced.entries, entry] } });
  const removeOutsourced = (i: number) => {
    const entries = pc.outsourced.entries.filter((_, j) => j !== i);
    save({ ...pc, outsourced: { enabled: entries.length > 0, entries } });
  };
  // Always show at least one lorry card so an empty project isn't blank —
  // the card is only persisted once the user actually fills something in.
  const lorries = pc.lorryCrew.length ? pc.lorryCrew : [{ plate: "", drivers: [], helpers: [] }];
  const setLorrySlot = (li: number, kind: "drivers" | "helpers", si: number, s: CrewSlot) => {
    const arr = lorries.map((l, i) => {
      if (i !== li) return l;
      const slots = [...l[kind]];
      while (slots.length <= si) slots.push({ name: "", phone: "" });
      slots[si] = s;
      return { ...l, [kind]: slots };
    });
    save({ ...pc, lorryCrew: arr });
  };
  const updateLorry = (li: number, p: Partial<LorryCrew>) =>
    save({ ...pc, lorryCrew: lorries.map((l, i) => (i === li ? { ...l, ...p } : l)) });
  const addLorry = () => save({ ...pc, lorryCrew: [...lorries, { plate: "", drivers: [], helpers: [] }] });
  const removeLorry = (li: number) => save({ ...pc, lorryCrew: lorries.filter((_, i) => i !== li) });
  // Owner 2026-07-22: the Driver 2 / Helper 2 rows stay HIDDEN until needed —
  // most lorries run one driver + one helper, so the empty second slots were
  // noise. A filled slot always shows; an empty one shows only after its
  // "+ Add …" button (styled like "+ Add lorry") is clicked. UI-only state:
  // collapsing back happens by clearing the name (row hides on next open).
  const [openSlot2, setOpenSlot2] = useState<Set<string>>(new Set());
  const showSlot2 = (li: number, kind: "d" | "h") => setOpenSlot2((s) => new Set(s).add(`${li}${kind}`));
  return (
    <div className="mt-3 space-y-2">
      {emptyHint && <div className="text-[9px] italic text-ink-muted">{emptyHint}</div>}
      {headerExtra}
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">{title} — crew per lorry</div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {lorries.map((lorry, li) => (
          <div key={li} className="space-y-1 rounded-lg border border-border bg-bg/30 p-2.5">
            {/* Same icon size / gap / fixed label width as CrewSlotRow so the
                LORRY label and its select column-align with the crew rows. */}
            <div className="flex items-center gap-1">
              <Truck size={12} className="shrink-0 text-ink-secondary" />
              <span className="w-11 shrink-0 text-[9px] font-bold uppercase tracking-wider text-ink-secondary">Lorry {li + 1}</span>
              <select
                value={lorry.plate}
                onChange={(e) => updateLorry(li, { plate: e.target.value })}
                disabled={readOnly}
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-[12px] disabled:bg-bg/40 disabled:opacity-70"
              >
                <option value="">Select plate…</option>
                {lorry.plate && !lorryOptions.includes(lorry.plate) && <option value={lorry.plate}>{lorry.plate}</option>}
                {lorryOptions.map((pl) => (
                  <option key={pl} value={pl}>{pl}</option>
                ))}
              </select>
              {!readOnly && (
                <button onClick={() => removeLorry(li)} className="shrink-0 text-ink-muted hover:text-err" title="Remove lorry">
                  <X size={13} />
                </button>
              )}
            </div>
            <CrewSlotRow label="Driver 1" color="text-synced" options={drivers} slot={lorry.drivers[0]} onChange={(s) => setLorrySlot(li, "drivers", 0, s)} readOnly={readOnly} />
            {(!!lorry.drivers[1]?.name || openSlot2.has(`${li}d`)) && (
              <CrewSlotRow label="Driver 2" color="text-synced" options={drivers} slot={lorry.drivers[1]} onChange={(s) => setLorrySlot(li, "drivers", 1, s)} readOnly={readOnly} />
            )}
            <CrewSlotRow label="Helper 1" color="text-warning-text" options={helpers} slot={lorry.helpers[0]} onChange={(s) => setLorrySlot(li, "helpers", 0, s)} readOnly={readOnly} />
            {(!!lorry.helpers[1]?.name || openSlot2.has(`${li}h`)) && (
              <CrewSlotRow label="Helper 2" color="text-warning-text" options={helpers} slot={lorry.helpers[1]} onChange={(s) => setLorrySlot(li, "helpers", 1, s)} readOnly={readOnly} />
            )}
            {!readOnly && (!(lorry.drivers[1]?.name || openSlot2.has(`${li}d`)) || !(lorry.helpers[1]?.name || openSlot2.has(`${li}h`))) && (
              <div className="flex gap-1.5 pt-0.5">
                {!(lorry.drivers[1]?.name || openSlot2.has(`${li}d`)) && (
                  <button
                    onClick={() => showSlot2(li, "d")}
                    className="rounded-md border border-dashed border-border bg-surface px-2.5 py-1 text-[10.5px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
                  >
                    + Add driver
                  </button>
                )}
                {!(lorry.helpers[1]?.name || openSlot2.has(`${li}h`)) && (
                  <button
                    onClick={() => showSlot2(li, "h")}
                    className="rounded-md border border-dashed border-border bg-surface px-2.5 py-1 text-[10.5px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
                  >
                    + Add helper
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {!readOnly && (
        <button
          onClick={addLorry}
          className="rounded-md border border-dashed border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
        >
          + Add lorry
        </button>
      )}
      <div className="mt-1 space-y-1.5">
        {/* Outsourced trips (owner 2026-07-27): the same three-provider row on
            Service / Exchange as Setup & Dismantle. Outsource / Lalamove open a
            name/phone/plate box; Grab opens a Helper 1 / Helper 2 picker. */}
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">Outsourced trips</div>
        <OutsourcedEntryChips entries={pc.outsourced.entries} readOnly={readOnly} onRemove={removeOutsourced} />
        {!readOnly && (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {(["outsource", "lalamove", "grab"] as OutsourcedProvider[]).map((prov) => (
                <button
                  key={prov}
                  type="button"
                  onClick={() => setOpenProvider(openProvider === prov ? null : prov)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-[11px] font-semibold",
                    openProvider === prov
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                  )}
                >
                  {OUTSOURCED_PROVIDER_LABEL[prov]}
                </button>
              ))}
            </div>
            {(openProvider === "outsource" || openProvider === "lalamove") && (
              <OutsourcedBox
                onAdd={(o) => {
                  addOutsourced({ provider: openProvider, ...o });
                  setOpenProvider(null);
                }}
              />
            )}
            {openProvider === "grab" && (
              <GrabHelperBox
                helpers={helpers}
                onAdd={(o) => {
                  addOutsourced({ provider: "grab", ...o });
                  setOpenProvider(null);
                }}
              />
            )}
          </>
        )}
      </div>
      {showRemark && (
        <label className="mt-1 block">
          {/* Single service/exchange remark (owner 2026-07-27): the earlier
              split lorry/outsource remarks collapsed back to one box. */}
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
            {remarkLabel}
          </span>
          <textarea
            value={remarkDraft}
            disabled={readOnly}
            rows={2}
            onChange={(e) => setRemarkDraft(e.target.value)}
            onBlur={() => {
              if (remarkDraft !== pc.remark) save({ ...pc, remark: remarkDraft });
            }}
            placeholder="What service / exchange…"
            className="w-full resize-y whitespace-pre-wrap break-words rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-primary/40 disabled:bg-bg/40"
          />
        </label>
      )}
    </div>
  );
}

// Service / Exchange as an OPTIONAL, collapsed block (owner 2026-08-10). The
// crew-per-lorry fields used to sit permanently below Dismantle, which read to
// Logistic staff as a compulsory third trip. Now it lives in its own divided
// section: just a "+ Service / Exchange" button until opened, then a bordered
// card (crew grid + outsourced + "what" remark + read-only service photos) with
// a close X. It auto-opens only when it ALREADY holds data, so nothing keyed
// earlier is hidden; closing never deletes — real data resurfaces on reload.
function ServiceExchangeBlock({
  serviceCrew,
  projectId,
  drivers,
  helpers,
  lorryOptions,
  patch,
  readOnly,
}: {
  serviceCrew: string | null | undefined;
  projectId: number;
  drivers: CrewMember[];
  helpers: CrewMember[];
  lorryOptions: string[];
  patch: (body: Record<string, any>) => Promise<void>;
  readOnly: boolean;
}) {
  const hasData = useMemo(() => {
    const pc = parsePhaseCrew(serviceCrew);
    return (
      pc.lorryCrew.length > 0 ||
      pc.outsourced.entries.length > 0 ||
      !!pc.remark?.trim()
    );
  }, [serviceCrew]);
  const [open, setOpen] = useState(hasData);
  // If data arrives while the card is closed (e.g. saved on another device),
  // reveal it — a filled Service / Exchange must never stay hidden.
  useEffect(() => {
    if (hasData) setOpen(true);
  }, [hasData]);

  // Sales / view-only: show the block only when it actually has content — never
  // an empty optional section or an add button.
  if (readOnly && !hasData) return null;

  return (
    <div className="mt-4 border-t border-border pt-3">
      {open ? (
        <div className="relative rounded-lg border border-border bg-surface p-3 pt-4 shadow-stone">
          {!readOnly && (
            <button
              type="button"
              onClick={() => setOpen(false)}
              title="Close — anything already entered is kept"
              aria-label="Close Service / Exchange"
              className="absolute right-2 top-2 rounded p-0.5 text-ink-muted hover:text-err"
            >
              <X size={14} />
            </button>
          )}
          <PhaseCrewEditor
            title="Service / Exchange"
            field="service_crew"
            value={serviceCrew}
            drivers={drivers}
            helpers={helpers}
            lorryOptions={lorryOptions}
            patch={patch}
            readOnly={readOnly}
            emptyHint="Optional — a mid-fair service visit or part exchange"
            showRemark
            remarkLabel="Service / Exchange — what"
          />
          <ServicePhotos projectId={projectId} readOnly />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-dashed border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
        >
          + Service / Exchange
        </button>
      )}
    </div>
  );
}

function LogisticsCrewSection({
  project,
  patch,
}: {
  project: ProjectDetail["project"];
  patch: (body: Record<string, any>) => Promise<void>;
}) {
  const { user } = useAuth();
  // Owner 2026-07-23: EVERYONE may VIEW the logistics crew (Setup / Dismantle /
  // Service), but only LOGISTIC + BD may EDIT it — plus Owner / Management /
  // Super Admin (directors), who edit everything. Everyone else (Sales, ops,
  // purchasing, storekeeper…) renders read-only. (The schedule reference is
  // stricter still — see canViewSchedule below.)
  const _pos = (user?.position_name ?? "").toLowerCase();
  const _role = (user?.role_name ?? "").toLowerCase();
  const _email = (user?.email ?? "").toLowerCase();
  // Logistic = position "Logistic Admin" OR role "Logistic" — Syu / Syasya /
  // Logistic Admin all carry both, so any of them matches (owner 2026-07-23).
  const canEditLogistics =
    isDirectorUser(user) ||
    !!user?.permissions?.includes("*") ||
    /logistic/.test(_pos) ||
    /logistic/.test(_role) ||
    /\bbd\b/.test(_role);
  const readOnly = !canEditLogistics;
  // Schedule reference is TIGHTER than the rest of the section (owner
  // 2026-07-23): only BD + weisiang (Lim, weisiang329@gmail.com) may edit it —
  // plus the Owner / admins (wildcard "*"), who can edit everything.
  const canEditSchedule =
    !!user?.permissions?.includes("*") ||
    /\bbd\b/.test(_role) ||
    _email === "weisiang329@gmail.com";
  // …and HIDDEN from everyone else (owner 2026-07-29): logistic may view /
  // download, the edit tier above may edit; nobody else sees the block at all.
  const canViewSchedule =
    canEditSchedule || /logistic/.test(_pos) || /logistic/.test(_role);
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [lorryOptions, setLorryOptions] = useState<string[]>([]);
  // A failed reference read must not render as an empty list. `.catch(() => {})`
  // here meant a 403 (or a cold-pool 503, or a network drop) left `crew` and
  // `lorryOptions` at [], and the crew/lorry pickers then said "no drivers" —
  // the same defect that made a 403 look like an empty dropdown, and the same
  // one that printed an SO PDF claiming the full amount owed. The message is
  // already plain language: api.client throws HttpError whose `.message` is
  // humanHttpMessage(status, body).
  const [refError, setRefError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const fail = (e: unknown) => {
      if (!live) return;
      setRefError(
        e instanceof Error && e.message
          ? e.message
          : "We couldn't load the crew and lorry lists. Please try again.",
      );
    };
    api
      .get<{ data: CrewMember[] }>("/api/fleet/staff")
      .then((r) => { if (live) setCrew(r.data ?? []); })
      .catch(fail);
    api
      .get<{ lorries: { plate: string }[] }>("/api/scm/lorries")
      .then((r) => { if (live) setLorryOptions((r.lorries ?? []).map((l) => l.plate).filter(Boolean)); })
      .catch(fail);
    return () => { live = false; };
  }, []);
  const isType = (u: CrewMember, kind: string) =>
    (u.role_name || "").toLowerCase() === kind || (u.user_type || "").toLowerCase() === kind;
  const drivers = useMemo(() => crew.filter((u) => isType(u, "driver") && (u.name || "").trim() !== ""), [crew]);
  const helpers = useMemo(() => crew.filter((u) => isType(u, "helper") && (u.name || "").trim() !== ""), [crew]);
  return (
    <PanelSection
      muted
      title={
        <span className="inline-flex items-center gap-2">
          {"Setup & Dismantle"}
          <span className={cn("rounded-full border px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider", roleChipClass("LOGISTIC"))}>
            LOGISTIC
          </span>
          {readOnly && (
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider text-ink-muted">
              View only
            </span>
          )}
        </span>
      }
    >
      {refError && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err"
        >
          {refError} The crew and lorry choices below may be incomplete — don't
          save until they load.
        </div>
      )}
      {/* Schedule reference (owner 2026-07-23): the mall handbook's official
          event schedule screenshot, so logistics can read off setup/dismantle
          dates + times. Owner 2026-07-29: hidden from everyone except
          logistic (view/download) and the BD/owner edit tier. */}
      {canViewSchedule && (
        <ScheduleRef
          projectId={project.id}
          readOnly={!canEditSchedule}
          remark={project.schedule_remark}
          onSaveRemark={(v) => patch({ schedule_remark: v })}
        />
      )}
      <div>
        <LogisticsDateTimeField label="Setup Time" value={project.setup_start_at} onSave={(v) => patch({ setup_start_at: v })} readOnly={readOnly} />
      </div>
      <PhaseCrewEditor title="Setup" field="setup_crew" value={project.setup_crew} drivers={drivers} helpers={helpers} lorryOptions={lorryOptions} patch={patch} readOnly={readOnly} />
      <div className="my-3 border-t border-dashed border-border" />
      {/* Dismantle Time sits above Dismantle Drivers, mirroring Setup. */}
      <PhaseCrewEditor
        title="Dismantle"
        field="dismantle_crew"
        value={project.dismantle_crew}
        drivers={drivers}
        helpers={helpers}
        lorryOptions={lorryOptions}
        patch={patch}
        readOnly={readOnly}
        emptyHint="Leave empty if same as setup"
        headerExtra={
          <LogisticsDateTimeField label="Dismantle Time" value={project.dismantle_start_at} onSave={(v) => patch({ dismantle_start_at: v })} readOnly={readOnly} />
        }
      />
      {/* Service / Exchange (owner 2026-07-22; collapsible 2026-08-10): an
          OPTIONAL mid-fair service visit or part exchange. Hidden behind its own
          "+ Service / Exchange" button under a solid divider — no longer welded
          below Dismantle's outsourced trips, where the always-on fields read as
          a compulsory third trip to Logistic. The read-only desktop service
          gallery moved inside the card (mobile still captures the photos). */}
      <ServiceExchangeBlock
        serviceCrew={project.service_crew}
        projectId={project.id}
        drivers={drivers}
        helpers={helpers}
        lorryOptions={lorryOptions}
        patch={patch}
        readOnly={readOnly}
      />
    </PanelSection>
  );
}

function LogisticsScheduleSection({
  project,
  trips,
  patch,
}: {
  project: ProjectDetail["project"];
  /** Trips already linked to this project — used to surface a
   *  clickable chip above each phase that opens the matching
   *  logistics event. Matched by `trip_type` ("setup" / "dismantle"),
   *  case-insensitive so a stray capitalisation doesn't break the
   *  link. */
  trips: ProjectTrip[];
  patch: (body: Record<string, any>) => Promise<void>;
}) {
  const [crew, setCrew] = useState<CrewMember[]>([]);
  // Lorries from scm.lorries (UUID id, type enum replaces the old `size` text).
  const [lorries, setLorries] = useState<{ id: string; plate: string; type: string | null }[]>([]);
  // /api/fleet/staff filters server-side by role.name IN ('Driver','Helper');
  // user_type is a parallel column that isn't always populated, so we
  // discriminate on role_name (the field the server already filters on).
  const isType = (u: { user_type: string | null; role_name: string | null }, kind: string) =>
    (u.role_name || "").toLowerCase() === kind ||
    (u.user_type || "").toLowerCase() === kind;
  const drivers = useMemo(() => crew.filter((u) => isType(u, "driver") && (u.name || "").trim() !== ""), [crew]);
  const helpers = useMemo(() => crew.filter((u) => isType(u, "helper") && (u.name || "").trim() !== ""), [crew]);

  // Same swallow, same section: a 403 / 503 / dropped connection used to leave
  // both lists empty and silent, so the driver and lorry pickers below simply
  // offered nothing and the phase-header chips resolved to no driver. An empty
  // list and a failed read must not look identical.
  const [refError, setRefError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const fail = (e: unknown) => {
      if (!live) return;
      setRefError(
        e instanceof Error && e.message
          ? e.message
          : "We couldn't load the crew and lorry lists. Please try again.",
      );
    };
    api
      .get<{ data: CrewMember[] }>("/api/fleet/staff")
      .then((r) => { if (live) setCrew(r.data ?? []); })
      .catch(fail);
    api
      .get<{ lorries: { id: string; plate: string; type: string | null }[] }>("/api/scm/lorries")
      .then((r) => { if (live) setLorries(r.lorries ?? []); })
      .catch(fail);
    return () => { live = false; };
  }, []);

  const setupTrip = trips.find(
    (t) => (t.trip_type || "").toLowerCase() === "setup"
  );
  const dismantleTrip = trips.find(
    (t) => (t.trip_type || "").toLowerCase() === "dismantle"
  );

  // Driver resolution for the phase header chips and the info cards. The
  // select already loaded the full crew list, so reuse it instead of
  // relying on a denormalised name on the project row.
  const setupDriver =
    drivers.find((u) => u.id === project.setup_driver_user_id) ?? null;
  const dismantleDriver =
    drivers.find((u) => u.id === project.dismantle_driver_user_id) ?? null;
  const setupDriverName = setupDriver?.name ?? null;
  const dismantleDriverName = dismantleDriver?.name ?? null;

  return (
    <PanelSection title="Logistics Schedule" muted>
      {refError && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err"
        >
          {refError} Driver and lorry choices may be incomplete — don't save
          until they load.
        </div>
      )}
      <PhaseHeader
        phase="Setup"
        trip={setupTrip}
        scheduledAt={project.setup_start_at}
        driverName={setupDriverName}
      />
      <div className="grid grid-cols-2 gap-3">
        <LogisticsDateTimeField
          label="Setup Start"
          value={project.setup_start_at}
          onSave={(v) => patch({ setup_start_at: v })}
        />
        <LogisticsDateTimeField
          label="Setup End"
          value={project.setup_end_at}
          onSave={(v) => patch({ setup_end_at: v })}
        />
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Setup Driver
          </div>
          <select
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            value={project.setup_driver_user_id ?? ""}
            onChange={(e) =>
              patch({
                setup_driver_user_id: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
          >
            <option value="">— none —</option>
            {drivers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          {setupDriver && <CrewInfoCard member={setupDriver} />}
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Setup Lorry
          </div>
          <select
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            value={project.setup_lorry_id ?? ""}
            onChange={(e) =>
              patch({
                setup_lorry_id: e.target.value || null,
              })
            }
          >
            <option value="">— none —</option>
            {lorries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.plate}
                {l.type && ` · ${l.type}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <HelperSelect
          label="Setup Helper 1"
          value={project.setup_helper_1_id}
          helpers={helpers}
          onChange={(v) => patch({ setup_helper_1_id: v })}
        />
        <HelperSelect
          label="Setup Helper 2"
          value={project.setup_helper_2_id}
          helpers={helpers}
          onChange={(v) => patch({ setup_helper_2_id: v })}
        />
      </div>
      <label className="mt-2 inline-flex items-center gap-2 text-[12px] text-ink-secondary">
        <input
          type="checkbox"
          checked={!!project.setup_helper_outsourced}
          onChange={(e) => patch({ setup_helper_outsourced: e.target.checked ? 1 : 0 })}
        />
        Outsourced helpers
      </label>

      <div className="mt-4 border-t border-border pt-3">
        <PhaseHeader
          phase="Dismantle"
          trip={dismantleTrip}
          scheduledAt={project.dismantle_start_at}
          driverName={dismantleDriverName}
        />
        <div className="grid grid-cols-2 gap-3">
        <LogisticsDateTimeField
          label="Dismantle Start"
          value={project.dismantle_start_at}
          onSave={(v) => patch({ dismantle_start_at: v })}
        />
        <LogisticsDateTimeField
          label="Dismantle End"
          value={project.dismantle_end_at}
          onSave={(v) => patch({ dismantle_end_at: v })}
        />
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Dismantle Driver
          </div>
          <select
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            value={project.dismantle_driver_user_id ?? ""}
            onChange={(e) =>
              patch({
                dismantle_driver_user_id: e.target.value ? parseInt(e.target.value, 10) : null,
              })
            }
          >
            <option value="">— none —</option>
            {drivers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          {dismantleDriver && <CrewInfoCard member={dismantleDriver} />}
        </div>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Dismantle Lorry
          </div>
          <select
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
            value={project.dismantle_lorry_id ?? ""}
            onChange={(e) =>
              patch({
                dismantle_lorry_id: e.target.value || null,
              })
            }
          >
            <option value="">— none —</option>
            {lorries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.plate}
                {l.type && ` · ${l.type}`}
              </option>
            ))}
          </select>
        </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <HelperSelect
            label="Dismantle Helper 1"
            value={project.dismantle_helper_1_id}
            helpers={helpers}
            onChange={(v) => patch({ dismantle_helper_1_id: v })}
          />
          <HelperSelect
            label="Dismantle Helper 2"
            value={project.dismantle_helper_2_id}
            helpers={helpers}
            onChange={(v) => patch({ dismantle_helper_2_id: v })}
          />
        </div>
        <label className="mt-2 inline-flex items-center gap-2 text-[12px] text-ink-secondary">
          <input
            type="checkbox"
            checked={!!project.dismantle_helper_outsourced}
            onChange={(e) => patch({ dismantle_helper_outsourced: e.target.checked ? 1 : 0 })}
          />
          Outsourced helpers
        </label>
      </div>
    </PanelSection>
  );
}

// Small reusable select for helper rows inside LogisticsScheduleSection.
function HelperSelect({
  label,
  value,
  helpers,
  onChange,
}: {
  label: string;
  value: number | null;
  helpers: CrewMember[];
  onChange: (id: number | null) => void;
}) {
  const selected = helpers.find((u) => u.id === value) ?? null;
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <select
        className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? parseInt(e.target.value, 10) : null)}
      >
        <option value="">— none —</option>
        {helpers.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      {selected && <CrewInfoCard member={selected} />}
    </div>
  );
}

// Driver / helper profile surfaced when one is picked in the Logistics
// Schedule. Fields come straight from /api/fleet/staff (set up in the
// Driver App or Logistics > Fleet > Driver). Pay rates and IC are
// intentionally omitted — they don't belong in the project view, and the
// endpoint no longer serves them to this page's wide Sales-view gate.
type CrewMember = {
  id: number;
  name: string;
  phone: string | null;
  user_type: string | null;
  role_name: string | null;
};

function CrewInfoCard({ member }: { member: CrewMember }) {
  return (
    <div className="mt-1.5 rounded-md border border-border bg-paper px-3 py-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <InfoBit
          label="Phone"
          value={formatPhone(member.phone)}
          href={member.phone ? `tel:${member.phone}` : undefined}
        />
      </div>
    </div>
  );
}

function InfoBit({
  label,
  value,
  href,
}: {
  label: string;
  value: string | null | undefined;
  href?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      {href && value ? (
        <a
          href={href}
          className="font-medium text-ink underline-offset-2 hover:underline"
        >
          {value}
        </a>
      ) : (
        <span className="font-medium text-ink">{value || "—"}</span>
      )}
    </div>
  );
}

// ── Phase Photos — crew-uploaded evidence panel (read-only office side) ──

interface PhasePhoto {
  id: number;
  phase: "setup" | "dismantle" | "service" | "schedule";
  r2_key: string;
  content_type: string | null;
  caption: string | null;
  uploaded_by: number | null;
  uploaded_by_name: string | null;
  uploaded_at: string;
}

function PhasePhotosSection({ projectId }: { projectId: number }) {
  const photos = useQuery<{ photos: PhasePhoto[] }>("/api/projects/:/phase-photos",
    () => api.get(`/api/projects/${projectId}/phase-photos`),
    [projectId]
  );
  const setup = (photos.data?.photos ?? []).filter((p) => p.phase === "setup");
  const dismantle = (photos.data?.photos ?? []).filter((p) => p.phase === "dismantle");

  return (
    <PanelSection title="Phase Photos" muted>
      <div className="text-[11px] text-ink-muted">
        Uploaded by setup / dismantle crew from the Driver App.
      </div>
      <PhotoGroup label="Setup" photos={setup} onChange={() => photos.reload()} />
      <PhotoGroup label="Dismantle" photos={dismantle} onChange={() => photos.reload()} />
    </PanelSection>
  );
}

// Schedule reference (owner 2026-07-23) — the mall handbook's official event
// schedule screenshot, so logistics can read setup/dismantle dates + times off
// it. Also on mobile since 2026-07-23 (MobilePMS SetupDismantle, same
// phase="schedule" rows), so the "desktop only" badge is retired.
// Reuses the phase-photos machinery with phase="schedule".
function ScheduleRef({
  projectId,
  readOnly = false,
  remark,
  onSaveRemark,
}: {
  projectId: number;
  readOnly?: boolean;
  /** Project-level schedule remark (owner 2026-07-23): solo events have no
   *  handbook to screenshot, so logistics types the setup/dismantle times as
   *  free text INSTEAD of uploading — no file required. Saves on blur. */
  remark?: string | null;
  onSaveRemark?: (v: string) => void;
}) {
  const toast = useToast();
  const [remarkDraft, setRemarkDraft] = useState(remark ?? "");
  // Owner 2026-08-10: the remark editor is hidden until the Remark button is
  // pressed (an always-open empty box was just noise on the panel).
  const [remarkOpen, setRemarkOpen] = useState(false);
  useEffect(() => setRemarkDraft(remark ?? ""), [remark]);
  const fileRef = useRef<HTMLInputElement>(null);
  // Owner 2026-08-03: NO remark step before upload. Clicking Upload opens the
  // file picker straight away — the earlier prompt (even made optional) was an
  // unwanted extra click. Setup/dismantle times go in the standalone Remark box
  // below (onSaveRemark), not a per-screenshot caption.
  const [busy, setBusy] = useState(false);
  const photos = useQuery<{ photos: PhasePhoto[] }>(
    "/api/projects/:/phase-photos",
    () => api.get(`/api/projects/${projectId}/phase-photos`),
    [projectId],
  );
  const items = (photos.data?.photos ?? []).filter((p) => p.phase === "schedule");
  const startUpload = () => fileRef.current?.click();
  const upload = async (file: File, caption?: string) => {
    if (file.size > 50 * 1024 * 1024) {
      toast?.error("That file is over 50MB.");
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      toast?.error("The file needs an extension.");
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const up = await api.putBinary<{ key: string; mime_type: string }>(
        `/api/projects/${projectId}/phase-photos/upload?phase=schedule&ext=${encodeURIComponent(ext)}`,
        buf,
        file.type || "application/octet-stream",
      );
      await api.post(`/api/projects/${projectId}/phase-photos`, {
        phase: "schedule",
        r2_key: up.key,
        content_type: up.mime_type,
        caption: caption ?? null,
      });
      photos.reload();
    } catch (e) {
      toast?.error(e instanceof Error ? e.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  return (
    <div
      // PASTE-TO-UPLOAD (owner 2026-08-11): a schedule screenshot is normally
      // on the clipboard (Snipping Tool / PrtSc), not saved as a file, so
      // click-to-browse alone forced a pointless save-then-pick detour. Click
      // the box (tabIndex makes it focusable) then Ctrl+V / Cmd+V and the
      // clipboard image uploads straight away. Both routes stay available.
      tabIndex={readOnly ? -1 : 0}
      onPaste={(e) => {
        if (readOnly || busy) return;
        const items = Array.from(e.clipboardData?.items ?? []);
        const img = items.find((i) => i.kind === "file" && i.type.startsWith("image/"));
        if (!img) return; // let a normal text paste through untouched
        const blob = img.getAsFile();
        if (!blob) return;
        e.preventDefault();
        const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
        // Clipboard blobs are nameless — stamp one so the row reads sensibly.
        void upload(new File([blob], `schedule-${Date.now()}.${ext}`, { type: blob.type }));
      }}
      className="mb-3 rounded-lg border border-dashed border-border bg-bg/30 p-3 outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
          Schedule reference
        </span>
        {!readOnly && (
          <span className="text-[9.5px] text-ink-muted">
            click here, then Ctrl+V to paste a screenshot
          </span>
        )}
      </div>
      {items.length > 0 ? (
        <PhotoGroup label="Schedule" photos={items} onChange={() => photos.reload()} />
      ) : (
        <div className="text-[12px] text-ink-muted">No schedule screenshot uploaded yet.</div>
      )}
      {items.some((p) => p.caption) && (
        <div className="mt-1.5 space-y-0.5">
          {items.filter((p) => p.caption).map((p) => (
            <div key={p.id} className="text-[10.5px] text-ink-secondary whitespace-pre-wrap break-words">
              <span className="font-semibold text-ink-muted">Remark:</span> {p.caption}
            </div>
          ))}
        </div>
      )}
      {!readOnly && (
        <>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/*,application/pdf,.heic"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <button
            onClick={() => void startUpload()}
            disabled={busy}
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
          >
            <Paperclip size={12} />{" "}
            {busy ? "Uploading…" : items.length ? "Replace / add screenshot" : "Upload handbook schedule screenshot"}
          </button>
        </>
      )}
      {/* Standalone remark (owner 2026-07-23): solo events have no handbook —
          logistics types the setup/dismantle times here instead.
          Owner 2026-08-10: the empty box no longer sits open taking space —
          it hides behind a Remark button and appears only when clicked. A
          SAVED remark still shows as text (hiding it would hide real data),
          and the button then reads "Edit remark". */}
      {onSaveRemark && (
        <div className="mt-2">
          {(remark ?? "").trim() !== "" && !remarkOpen && (
            <div className="mb-1 text-[11px] text-ink-secondary whitespace-pre-wrap break-words">
              <span className="font-semibold text-ink-muted">Remark:</span> {remark}
            </div>
          )}
          {!readOnly && !remarkOpen && (
            <button
              type="button"
              onClick={() => setRemarkOpen(true)}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
            >
              <MessageSquare size={12} />
              {(remark ?? "").trim() ? "Edit remark" : "Remark"}
            </button>
          )}
          {!readOnly && remarkOpen && (
            <label className="block">
              <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-ink-muted">
                Remark (no handbook — type setup / dismantle times)
              </span>
              <textarea
                autoFocus
                value={remarkDraft}
                rows={2}
                onChange={(e) => setRemarkDraft(e.target.value)}
                onBlur={() => {
                  if (remarkDraft !== (remark ?? "")) onSaveRemark(remarkDraft);
                  setRemarkOpen(false);
                }}
                placeholder="e.g. solo event — setup 15/8 9pm after mall close, dismantle 19/8 10pm"
                className="w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-primary/40"
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}

// Service / Exchange photos (owner 2026-07-22) — office/logistics UPLOAD +
// display, unlike the read-only Setup/Dismantle PhasePhotosSection (those come
// from the Driver App). Uploads via the same phase-photos endpoints with
// phase="service"; reuses PhotoGroup for the gallery + lightbox + delete.
function ServicePhotos({ projectId, readOnly = false }: { projectId: number; readOnly?: boolean }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const photos = useQuery<{ photos: PhasePhoto[] }>(
    "/api/projects/:/phase-photos",
    () => api.get(`/api/projects/${projectId}/phase-photos`),
    [projectId],
  );
  const service = (photos.data?.photos ?? []).filter((p) => p.phase === "service");
  const upload = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      toast?.error("That file is over 50MB.");
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      toast?.error("The file needs an extension.");
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const up = await api.putBinary<{ key: string; mime_type: string }>(
        `/api/projects/${projectId}/phase-photos/upload?phase=service&ext=${encodeURIComponent(ext)}`,
        buf,
        file.type || "application/octet-stream",
      );
      await api.post(`/api/projects/${projectId}/phase-photos`, {
        phase: "service",
        r2_key: up.key,
        content_type: up.mime_type,
      });
      photos.reload();
    } catch (e) {
      toast?.error(e instanceof Error ? e.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };
  return (
    <div className="mt-3">
      {!readOnly && (
        <div className="mb-1 flex items-center justify-end">
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/*,video/*,application/pdf,.heic"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
          >
            <Paperclip size={12} /> {busy ? "Uploading…" : "Add service photo"}
          </button>
        </div>
      )}
      <PhotoGroup label="Service" photos={service} onChange={() => photos.reload()} />
    </div>
  );
}

function PhotoGroup({
  label,
  photos,
  onChange,
}: {
  label: string;
  photos: PhasePhoto[];
  onChange: () => void;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  return (
    <div className="mt-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label} · {photos.length}
      </div>
      {photos.length === 0 ? (
        <div className="text-[12px] text-ink-muted">No {label.toLowerCase()} photos yet.</div>
      ) : (
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          {photos.map((p, i) => (
            <PhasePhotoThumb
              key={p.id}
              photo={p}
              onOpen={() => setLightboxIndex(i)}
              onDeleted={onChange}
            />
          ))}
        </div>
      )}
      {lightboxIndex !== null && (
        <MediaLightbox
          items={photos}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          baseUrl="/api/projects/attachments"
          badge={label}
        />
      )}
    </div>
  );
}

function PhasePhotoThumb({
  photo,
  onOpen,
  onDeleted,
}: {
  photo: PhasePhoto;
  onOpen: () => void;
  onDeleted: () => void;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const isImage = (photo.content_type || "").startsWith("image/");
  const isVideo = (photo.content_type || "").startsWith("video/");
  const [url, setUrl] = useState<string | null>(null);
  // A thumbnail that fails to load used to render an empty grey square,
  // indistinguishable from one still loading and from a photo that isn't there.
  // Keep the reason: the tile shows a broken-image state and the tooltip carries
  // the plain-language message (api.client throws HttpError whose `.message` is
  // already humanHttpMessage — a 403 reads "You don't have permission to do
  // that", not a status dump).
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    let revoke: string | null = null;
    setLoadError(null);
    api
      .fetchBlobUrl(`/api/projects/attachments/${photo.r2_key}`)
      .then((u) => {
        revoke = u;
        setUrl(u);
      })
      .catch((e: unknown) => {
        setLoadError(
          e instanceof Error && e.message ? e.message : "This preview couldn't be loaded.",
        );
      });
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [photo.r2_key, isImage]);

  const extLabel = (() => {
    const m = photo.r2_key.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toUpperCase() : "FILE";
  })();

  // Compact card: thumb fills the cell; uploader + delete sit in a tiny
  // hover-revealed strip so the grid reads as a dense gallery rather
  // than a stack of metadata cards. Lightbox surfaces the full caption
  // + uploader, so this surface stays terse on purpose.
  return (
    <div className="group relative overflow-hidden rounded-md border border-border bg-surface">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Open preview"
        title={
          [photo.caption, photo.uploaded_by_name, formatTimestamp(photo.uploaded_at)]
            .filter(Boolean)
            .join(" · ")
        }
        className="block w-full"
      >
        <div className="aspect-square bg-bg">
          {isImage ? (
            url ? (
              <img src={url} alt={photo.caption || ""} className="h-full w-full object-cover" />
            ) : loadError ? (
              <div
                className="flex h-full w-full flex-col items-center justify-center gap-0.5 p-1 text-center"
                title={loadError}
              >
                <ImageOff size={18} className="text-err" />
                <div className="text-[8px] font-semibold uppercase tracking-wide text-err">
                  Failed
                </div>
              </div>
            ) : (
              <div className="h-full w-full" />
            )
          ) : isVideo ? (
            <div className="relative flex h-full w-full items-center justify-center bg-ink/90">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 shadow-md">
                <Play size={13} className="ml-0.5 text-ink" fill="currentColor" />
              </div>
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[7px] font-bold uppercase tracking-wider text-white">
                {extLabel}
              </span>
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 p-1 text-center">
              <FileText size={18} className="text-ink-secondary" />
              <div className="text-[8px] font-semibold uppercase tracking-wide text-ink-muted">
                {extLabel}
              </div>
            </div>
          )}
        </div>
      </button>
      {/* Uploader strip — single line at the bottom edge, very small.
          Stays visible (not hover-gated) so a glance reads "who took
          this" without opening the lightbox. */}
      <div className="flex items-center justify-between gap-1 border-t border-border-subtle bg-bg/40 px-1.5 py-0.5">
        <span className="truncate text-[9px] text-ink-secondary" title={photo.uploaded_by_name || "Unknown"}>
          {photo.uploaded_by_name || "—"}
        </span>
        <button
          className="rounded p-0.5 text-ink-muted opacity-0 transition-opacity hover:bg-err/10 hover:text-err group-hover:opacity-100"
          title="Delete"
          onClick={async (e) => {
            e.stopPropagation();
            const ok = await dialog.confirm({
              title: "Delete this file?",
              message:
                photo.caption ||
                photo.uploaded_by_name
                  ? `Uploaded by ${photo.uploaded_by_name || "Unknown"}. This can't be undone.`
                  : "This can't be undone.",
              confirmLabel: "Delete",
              danger: true,
            });
            if (!ok) return;
            // The refresh must not run unless the delete actually happened.
            // It used to be `.catch(() => {})` followed by an unconditional
            // onDeleted(): a denied or failed delete re-rendered the grid with
            // the file still in it and said nothing, so the operator read the
            // reappearing tile as the UI being slow and clicked again.
            try {
              await api.del(`/api/projects/phase-photos/${photo.id}`);
            } catch (e: any) {
              toast.error(e?.message || "Couldn't delete this file. It is still there — please try again.");
              return;
            }
            onDeleted();
          }}
        >
          <Trash2 size={10} />
        </button>
      </div>
    </div>
  );
}

/**
 * Per-phase header inside the Logistics Schedule section. Reflects
 * whichever logistics surface this phase currently maps to:
 *
 *   1. A real Trip linked via the Linked Trips sub-section
 *      (matching trip_type) → chip links to /trips/:id.
 *   2. A scheduled date on the project itself (setup_start_at /
 *      dismantle_start_at) → chip links to the Logistics Events tab,
 *      which renders the project-derived row alongside manual events.
 *   3. Neither set → muted "Not scheduled" hint.
 *
 * The previous version only handled case (1), which read as "No trip
 * linked" even when the dispatcher had already configured the date +
 * driver and the event was visible in /logistics?tab=events.
 */
function PhaseHeader({
  phase,
  trip,
  scheduledAt,
  driverName,
}: {
  phase: "Setup" | "Dismantle";
  trip: ProjectTrip | undefined;
  /** Project's setup_start_at / dismantle_start_at — the source of
   *  truth for the synthetic event surfaced in /logistics?tab=events. */
  scheduledAt: string | null;
  driverName: string | null;
}) {
  // Match Logistics outer (`tab=trips`) + Trips inner (`sub=events`).
  // Inner sub-tabs use `?sub=` so they don't collide with the outer
  // `?tab=` that picks between Trips and Fleet.
  const eventsHref = "/logistics?tab=trips&sub=events";

  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-secondary">
        {phase} Phase
      </div>
      {trip ? (
        <Link
          to={`/trips/${trip.id}`}
          title={`Open trip ${trip.code}${trip.scheduled_date ? ` · ${formatDate(trip.scheduled_date)}` : ""}`}
          className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/40 px-2 py-1 font-mono text-[10px] font-semibold tracking-wider text-accent transition-colors hover:bg-accent-soft/70"
        >
          <Truck size={11} />
          <span className="normal-case">{trip.code}</span>
          {trip.status && (
            <span className="text-ink-muted/80">· {trip.status}</span>
          )}
          <ExternalLink size={10} />
        </Link>
      ) : scheduledAt ? (
        <Link
          to={eventsHref}
          title={`Scheduled ${formatDateTime(scheduledAt)}${driverName ? ` · ${driverName}` : ""} — open Logistics Events`}
          className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/40 px-2 py-1 font-mono text-[10px] font-semibold tracking-wider text-accent transition-colors hover:bg-accent-soft/70"
        >
          <Calendar size={11} />
          <span>{formatDateTime(scheduledAt)}</span>
          {driverName && (
            <span className="text-ink-muted/80 normal-case">
              · {driverName}
            </span>
          )}
          <ExternalLink size={10} />
        </Link>
      ) : (
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-ink-muted">
          Not scheduled
        </span>
      )}
    </div>
  );
}

// ── Defects ──────────────────────────────────────────────────
// Two sub-lists per project — one for Setup, one for Dismantle. Each
// entry records who reported it (Sales vs Logistics) because that
// distinction is the point: they cross-check each other.

const DEFECT_ROLE_META: Record<
  "sales" | "logistic",
  { label: string; Icon: LucideIcon; cls: string }
> = {
  sales: { label: "Sales", Icon: Banknote, cls: "text-emerald-700 bg-emerald-50" },
  logistic: { label: "Logistic", Icon: Truck, cls: "text-amber-800 bg-amber-50" },
};

function DefectsSection({
  projectId,
  defects,
  onChange,
  toast,
}: {
  projectId: number;
  defects: ProjectDefect[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [adding, setAdding] = useState<null | { phase: "setup" | "dismantle" }>(null);
  const setupItems = defects.filter((d) => d.phase === "setup");
  const dismantleItems = defects.filter((d) => d.phase === "dismantle");

  return (
    <PanelSection title={`Defect Items (${defects.length})`}>
      <DefectList
        title="Setup phase"
        items={setupItems}
        onAdd={() => setAdding({ phase: "setup" })}
        onRemove={async (id) => {
          if (!await dialog.confirm("Remove this defect item?")) return;
          try {
            await api.del(`/api/projects/defects/${id}`);
            onChange();
          } catch (e: any) {
            toast.error(e?.message || "Something went wrong. Please try again.");
          }
        }}
        onToggleResolved={async (d) => {
          try {
            await api.patch(`/api/projects/defects/${d.id}`, { resolved: d.resolved ? 0 : 1 });
            onChange();
          } catch (e: any) {
            toast.error(e?.message || "Something went wrong. Please try again.");
          }
        }}
      />
      <DefectList
        title="Dismantle phase"
        items={dismantleItems}
        onAdd={() => setAdding({ phase: "dismantle" })}
        onRemove={async (id) => {
          if (!await dialog.confirm("Remove this defect item?")) return;
          try {
            await api.del(`/api/projects/defects/${id}`);
            onChange();
          } catch (e: any) {
            toast.error(e?.message || "Something went wrong. Please try again.");
          }
        }}
        onToggleResolved={async (d) => {
          try {
            await api.patch(`/api/projects/defects/${d.id}`, { resolved: d.resolved ? 0 : 1 });
            onChange();
          } catch (e: any) {
            toast.error(e?.message || "Something went wrong. Please try again.");
          }
        }}
      />
      {adding && (
        <AddDefectForm
          projectId={projectId}
          phase={adding.phase}
          onCancel={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            onChange();
          }}
          toast={toast}
        />
      )}
    </PanelSection>
  );
}

function DefectList({
  title,
  items,
  onAdd,
  onRemove,
  onToggleResolved,
}: {
  title: string;
  items: ProjectDefect[];
  onAdd: () => void;
  onRemove: (id: number) => void;
  onToggleResolved: (d: ProjectDefect) => void;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          {title} ({items.length})
        </div>
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-ink-muted">No defects reported.</div>
      ) : (
        <div className="space-y-1">
          {items.map((d) => (
            <div
              key={d.id}
              className={cn(
                "flex items-start gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[11px]",
                d.resolved ? "opacity-60" : ""
              )}
            >
              {(() => {
                const m = DEFECT_ROLE_META[d.reported_by_role];
                const I = m.Icon;
                return (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                      m.cls
                    )}
                  >
                    <I size={10} /> {m.label}
                  </span>
                );
              })()}
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  {d.item_code && <span className="font-mono font-semibold">{d.item_code}</span>}
                  {d.item_description && <span>{d.item_description}</span>}
                  {d.size && <span className="text-ink-muted">· {d.size}</span>}
                  {d.quantity != null && d.quantity > 0 && (
                    <span className="text-ink-muted">× {d.quantity}</span>
                  )}
                </div>
                {d.reason && <div className="mt-0.5 text-ink-secondary">{d.reason}</div>}
                <div className="mt-0.5 text-[10px] text-ink-muted">
                  {d.reported_by_name || "—"} · {formatDate(d.reported_at)}
                  {d.linked_assr_no && (
                    <span className="ml-2 text-accent">→ {d.linked_assr_no}</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => onToggleResolved(d)}
                  className={cn(
                    "rounded p-1 hover:bg-synced/10 hover:text-synced",
                    d.resolved ? "text-synced" : "text-ink-muted"
                  )}
                  title={d.resolved ? "Mark unresolved" : "Mark resolved"}
                >
                  <CheckCircle2 size={12} />
                </button>
                <button
                  onClick={() => onRemove(d.id)}
                  className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                  title="Remove"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddDefectForm({
  projectId,
  phase,
  onCancel,
  onSaved,
  toast,
}: {
  projectId: number;
  phase: "setup" | "dismantle";
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [role, setRole] = useState<"sales" | "logistic">("sales");
  const [itemCode, setItemCode] = useState("");
  const [desc, setDesc] = useState("");
  const [size, setSize] = useState("");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!itemCode.trim() && !desc.trim()) {
      toast.error("Item code or description required");
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/api/projects/${projectId}/defects`, {
        phase,
        reported_by_role: role,
        item_code: itemCode.trim() || null,
        item_description: desc.trim() || null,
        size: size.trim() || null,
        quantity: parseInt(qty, 10) || 1,
        reason: reason.trim() || null,
      });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-accent">
          New defect — {phase}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRole("sales")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold",
              role === "sales" ? "bg-accent text-white" : "bg-surface text-ink-muted"
            )}
          >
            <Banknote size={11} /> Sales
          </button>
          <button
            onClick={() => setRole("logistic")}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold",
              role === "logistic" ? "bg-accent text-white" : "bg-surface text-ink-muted"
            )}
          >
            <Truck size={11} /> Logistic
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          value={itemCode}
          onChange={(e) => setItemCode(e.target.value)}
          placeholder="Item code"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-primary"
        />
        <input
          value={size}
          onChange={(e) => setSize(e.target.value)}
          placeholder="Size"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Description"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
        <input
          type="number"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="Qty"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason / notes"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Project Sales Entries (rep-facing log, scoped to one project) ──
// The standalone /sales page used to host this. We moved it inside the
// project page because the workflow is per-exhibition: a rep opens the
// project they're working, drafts the sales they collected, then submits.
// The entry's project_id is hard-locked here so a rep can't accidentally
// re-target a draft to a different exhibition.

function ProjectSalesEntriesSection({
  projectId,
  projectCode,
  projectName,
  canManage,
  currentTotalSales,
  onTotalSaved,
  toast,
}: {
  projectId: number;
  projectCode: string | null;
  projectName: string;
  canManage: boolean;
  currentTotalSales: number | null;
  onTotalSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const auth = useAuth();
  const meId = auth.user?.id;
  // Three gates, three DIFFERENT server rules — they were two, and the write
  // half asked for the flat sales.write key, which neither write route reads.
  //   view  GET  /api/sales/entries        requirePageAccessOrSalesView("sales")
  //   log   POST /api/sales/entries        requirePageAccess("sales")
  //   total PATCH /api/projects/:id/finance  projects.write + denyFinance
  // The org-position arm belongs to the READ gate only (owner 2026-07: a Sales
  // Director has no matrix "sales" row and must still see the list), so it is
  // ORed on canViewSales alone — off, not hide, and no render-then-403.
  const salesLevel = usePageAccess("sales");
  const canLogSale = canLogSalesEntry(salesLevel);
  const canSetTotalSales = canWriteProjectFinance(auth.user, auth.can);
  const canViewSales = canLogSale || isSalesStaff(auth.user) || isDirectorUser(auth.user);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SalesEntry | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  // Quick-log inline form state. The full EntryPanel is too heavy
  // for the floor; reps just need amount + ref_no + date.
  const [quickLogOpen, setQuickLogOpen] = useState(false);
  const [qlAmount, setQlAmount] = useState("");
  const [qlRefNo, setQlRefNo] = useState("");
  const [qlDate, setQlDate] = useState(() => todayInAppTz());
  const [qlSaving, setQlSaving] = useState(false);
  // Quick Total Sales — set the project's lump-sum total sales directly
  // (project_finance.total_sales) without logging individual entries. Used
  // for exhibitions where only the final total is known. Shows on the
  // Project List "Sales" column + Overview P&L.
  const [quickTotalOpen, setQuickTotalOpen] = useState(false);
  const [qtValue, setQtValue] = useState("");
  const [qtSaving, setQtSaving] = useState(false);

  async function saveQuickTotal() {
    const n = parseFloat(qtValue);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Enter a valid total sales amount");
      return;
    }
    setQtSaving(true);
    try {
      await api.patch(`/api/projects/${projectId}/finance`, { total_sales: n });
      toast.success("Total sales updated");
      setQuickTotalOpen(false);
      onTotalSaved();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setQtSaving(false);
    }
  }

  async function saveQuickLog() {
    const n = parseFloat(qlAmount);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Amount must be a positive number");
      return;
    }
    if (!qlRefNo.trim()) {
      toast.error("Ref No is required");
      return;
    }
    setQlSaving(true);
    try {
      await api.post("/api/sales/entries", {
        project_id: projectId,
        ref_no: qlRefNo.trim(),
        amount: n,
        occurred_at: qlDate,
        quick_log: true,
      });
      toast.success("Quick log saved — complete details on the Sales page when you have time");
      setQuickLogOpen(false);
      setQlAmount("");
      setQlRefNo("");
      setQlDate(todayInAppTz());
      list.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setQlSaving(false);
    }
  }

  const list = useQuery<{
    data: SalesEntry[];
    totals: { amount: number; count: number; by_status: { draft: number; submitted: number; pushed: number } };
  }>("/api/sales/entries?project_id=::",
    () =>
      api.get(
        `/api/sales/entries?project_id=${projectId}${
          statusFilter ? `&status=${statusFilter}` : ""
        }&per_page=200`
      ),
    [projectId, statusFilter],
    { enabled: canViewSales }
  );
  const udf = useUdf("sales_entries");

  async function submitEntry(e: SalesEntry) {
    try {
      await api.post(`/api/sales/entries/${e.id}/submit`);
      toast.success(`Submitted — ${e.customer_name}`);
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong. Please try again.");
    }
  }
  async function voidEntry(e: SalesEntry) {
    if (!(await dialog.confirm(`Void sale for ${e.customer_name}?`))) return;
    try {
      await api.post(`/api/sales/entries/${e.id}/void`);
      toast.success("Voided");
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong. Please try again.");
    }
  }
  async function deleteEntry(e: SalesEntry) {
    if (!(await dialog.confirm(`Delete draft for ${e.customer_name}?`))) return;
    try {
      await api.del(`/api/sales/entries/${e.id}`);
      toast.success("Deleted");
      list.reload();
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong. Please try again.");
    }
  }

  const rows = list.data?.data ?? [];
  const totals = list.data?.totals;
  const projectLabel = projectCode ? `${projectCode} · ${projectName}` : projectName;

  // When an event has no individual sales entries, fall back to the project's
  // lump-sum total (project_finance.total_sales) so this box matches the
  // Project List + dashboard instead of showing RM 0.00. Individual sales
  // (any status) take over the moment they exist.
  const salesEntryCount = totals
    ? totals.by_status.draft + totals.by_status.submitted + totals.by_status.pushed
    : 0;
  const showLumpTotal = salesEntryCount === 0 && currentTotalSales != null;

  // Off, not hide: a user who can't access sales neither renders this section
  // nor fires the (now enabled-gated) request. All hooks above run first.
  if (!canViewSales) return null;

  return (
    <PanelSection title={`Sales (${rows.length})`}>
      {/* Toolbar: totals · status filter · new-sale */}
      <div className="mb-2 flex flex-col gap-3 rounded-md border border-border-subtle bg-bg/30 px-3 py-2 text-[10.5px] sm:flex-row sm:flex-wrap sm:items-center">
        {totals && (
          <div className="flex flex-wrap items-center gap-3">
            <Stat
              label="Total"
              value={formatCurrency(showLumpTotal ? (currentTotalSales ?? 0) : totals.amount)}
              accent
            />
            {showLumpTotal && (
              <span
                className="rounded bg-emerald-100 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wider text-emerald-700"
                title="Final lump-sum total for this event (no individual sales logged yet). Logging individual sales will replace this."
              >
                final total
              </span>
            )}
            <Stat label="Drafts" value={String(totals.by_status.draft)} />
            <Stat label="Submitted" value={String(totals.by_status.submitted)} />
            <Stat label="Pushed" value={String(totals.by_status.pushed)} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto sm:flex-nowrap">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-6 rounded-md border border-border bg-surface px-1.5 text-[10.5px]"
            title="Filter status"
          >
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="pushed">Pushed</option>
            <option value="void">Void</option>
          </select>
          <button
            onClick={async () => {
              try {
                const qs = `project_id=${projectId}${
                  statusFilter ? `&status=${statusFilter}` : ""
                }`;
                await api.downloadFile(
                  `/api/sales/entries/export?${qs}`,
                  `sales_${projectCode || projectId}.csv`
                );
              } catch (e: any) {
                toast.error(e?.message || "Export failed");
              }
            }}
            className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface px-2 text-[10.5px] font-semibold text-ink-secondary hover:border-accent/40 hover:text-accent"
            title="Download CSV"
            disabled={rows.length === 0}
          >
            <Download size={11} /> Export
          </button>
          {canSetTotalSales && (
            <button
              onClick={() => {
                setQtValue(
                  currentTotalSales != null ? String(currentTotalSales) : ""
                );
                setQuickTotalOpen((v) => !v);
              }}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[10.5px] font-semibold",
                quickTotalOpen
                  ? "border-emerald-600/60 bg-emerald-600 text-white"
                  : "border-emerald-600/40 bg-emerald-100 text-emerald-800 hover:bg-emerald-200",
              )}
              title="Set the project's total sales figure directly (shows on the Project List + dashboard)"
            >
              <Plus size={11} /> Total Sales
            </button>
          )}
          {canLogSale && (
            <button
              onClick={() => setQuickLogOpen((v) => !v)}
              className={cn(
                "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-[10.5px] font-semibold",
                quickLogOpen
                  ? "border-amber-500/60 bg-amber-500 text-white"
                  : "border-amber-500/40 bg-amber-100 text-amber-800 hover:bg-amber-200",
              )}
              title="Capture amount + ref no only — fill customer details later from the Sales page"
            >
              <Plus size={11} /> Quick Log
            </button>
          )}
          {canLogSale && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border border-accent/40 bg-accent-soft/60 px-2 text-[10.5px] font-semibold text-accent hover:bg-accent hover:text-white"
            >
              <Plus size={11} /> New Sale
            </button>
          )}
        </div>
      </div>
      {/* Quick Total Sales inline form — sets project_finance.total_sales
          directly (lump sum), no individual entries. */}
      {quickTotalOpen && (
        <div className="mb-2 rounded-md border border-emerald-600/40 bg-emerald-50/60 p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-800">
              Total Sales · lump sum for this project
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[9.5px] font-semibold uppercase tracking-wider text-ink-secondary">
                Total Sales (RM)
              </span>
              <input
                type="number"
                inputMode="decimal"
                value={qtValue}
                onChange={(e) => setQtValue(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="h-7 w-40 rounded-md border border-border bg-surface px-2 text-[12px]"
              />
            </label>
            <button
              onClick={saveQuickTotal}
              disabled={qtSaving}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-600/60 bg-emerald-600 px-2.5 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {qtSaving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setQuickTotalOpen(false)}
              className="inline-flex h-7 items-center rounded-md border border-border bg-surface px-2.5 text-[11px] font-semibold text-ink-secondary hover:text-ink"
            >
              Cancel
            </button>
          </div>
          <p className="mt-1.5 text-[9.5px] text-ink-secondary">
            Sets the project's total sales directly — shows in the Project List
            "Sales" column and the dashboard. Use for exhibitions where you only
            record the final total. (If individual sales are logged, those take over.)
          </p>
        </div>
      )}
      {/* Quick-log inline form — three required fields, no full
          customer / deposit panel. Reps complete the rest later via
          the Sales page (the row gets a yellow "Quick log" pill). */}
      {quickLogOpen && (
        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-50/60 p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-800">
              Quick log · amount + ref only
            </span>
            <button
              onClick={() => setQuickLogOpen(false)}
              className="text-amber-800/60 hover:text-amber-900"
              aria-label="Close"
            >
              <X size={11} />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_140px_auto]">
            <input
              type="number"
              step="0.01"
              min="0"
              value={qlAmount}
              onChange={(ev) => setQlAmount(ev.target.value)}
              placeholder="Amount (RM)"
              className="rounded-md border border-amber-500/40 bg-surface px-2.5 py-1.5 font-mono text-[11.5px] outline-none focus:border-amber-500"
              autoFocus
            />
            <input
              value={qlRefNo}
              onChange={(ev) => setQlRefNo(ev.target.value)}
              placeholder="Ref No (e.g. HC1234)"
              className="rounded-md border border-amber-500/40 bg-surface px-2.5 py-1.5 font-mono text-[11.5px] outline-none focus:border-amber-500"
              onKeyDown={(ev) => {
                if (ev.key === "Enter") saveQuickLog();
              }}
            />
            <DateField
              fullWidth
              value={qlDate}
              onChange={(ev) => setQlDate(ev)}
              className="rounded-md border border-amber-500/40 bg-surface px-2.5 py-1.5 text-[11.5px] outline-none focus:border-amber-500"
            />
            <button
              onClick={saveQuickLog}
              disabled={qlSaving || !qlAmount.trim() || !qlRefNo.trim()}
              className="rounded-md bg-amber-500 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {qlSaving ? "Saving…" : "Save"}
            </button>
          </div>
          <div className="mt-1.5 text-[10px] text-amber-800/80">
            Submit-to-AutoCount is gated until customer details are filled in via the Sales page.
          </div>
        </div>
      )}

      {list.loading && rows.length === 0 && (
        <div className="text-[11px] text-ink-muted">Loading sales…</div>
      )}
      {list.error && (
        <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">
          {list.error}
        </div>
      )}
      {!list.loading && rows.length === 0 && (
        <EmptyState
          compact
          message="No sales drafted yet for this exhibition."
          cta={
            canLogSale
              ? { label: "Draft your first sale", onClick: () => setCreating(true) }
              : undefined
          }
        />
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full min-w-[760px]">
            <thead className="bg-bg/60">
              <tr className="text-left font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                <th className="px-2 py-1.5">Date</th>
                <th className="px-2 py-1.5">Ref No</th>
                <th className="px-2 py-1.5">Customer</th>
                <th className="px-2 py-1.5 text-right">Amount</th>
                <th className="px-2 py-1.5 text-right">Deposit</th>
                <th className="px-2 py-1.5 text-right">Balance</th>
                <th className="px-2 py-1.5">Sales Person</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="w-px px-1 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const badge = SALES_STATUS_BADGE[e.status as SalesEntryStatus];
                const isMine = e.created_by === meId;
                const canEdit = canManage || (isMine && e.status === "draft");
                const canSubmit = canEdit && e.status === "draft";
                const deposit = e.deposit_amount ?? e.amount;
                const balance = Math.max(0, e.amount - deposit);
                const salesPerson =
                  e.sales_person_name ||
                  e.sales_person_email ||
                  e.created_by_name ||
                  e.created_by_email ||
                  "—";
                return (
                  <tr
                    key={e.id}
                    className="border-t border-border-subtle text-[11.5px] hover:bg-bg/40"
                  >
                    <td className="px-2 py-1.5 font-mono text-ink-secondary">
                      {formatDate(e.occurred_at)}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10.5px] text-ink-secondary">
                      {e.ref_no || "—"}
                    </td>
                    <td className="px-2 py-1.5">
                      {e.customer_name === "(quick log)" ? (
                        <div className="flex items-center gap-1.5">
                          <span className="rounded-full border border-amber-500/40 bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-800">
                            Quick log
                          </span>
                          {canLogSale && (
                            <button
                              onClick={() => setEditing(e)}
                              className="text-[10px] font-semibold text-accent hover:underline"
                            >
                              Complete
                            </button>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="font-semibold text-ink">{e.customer_name}</div>
                          {e.customer_phone && (
                            <div className="font-mono text-[9.5px] text-ink-muted">
                              {formatPhone(e.customer_phone)}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">
                      {formatCurrency(e.amount)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      <div>{formatCurrency(deposit)}</div>
                      {e.deposit_payment_type && (
                        <div className="mt-0.5 text-[9px] text-ink-muted">
                          {PAYMENT_TYPE_LABEL[e.deposit_payment_type]}
                        </div>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right font-mono",
                        balance > 0 ? "font-semibold text-amber-700" : "text-ink-muted"
                      )}
                      title={balance > 0 ? "Balance to chase post-event" : "Settled in full"}
                    >
                      {formatCurrency(balance)}
                    </td>
                    <td className="px-2 py-1.5 text-[10.5px] text-ink-muted">
                      {salesPerson}
                    </td>
                    <td className="px-2 py-1.5">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider",
                          badge.cls
                        )}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-1 py-1">
                      <div className="flex items-center gap-0.5">
                        {canSubmit && (
                          <button
                            onClick={() => submitEntry(e)}
                            className="rounded p-1 text-ink-muted hover:bg-accent-soft hover:text-accent"
                            title="Submit"
                          >
                            <CheckSquare size={12} />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => setEditing(e)}
                            className="rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink"
                            title="Edit"
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                        {canManage && e.status === "submitted" && (
                          <button
                            disabled
                            className="rounded p-1 text-ink-muted opacity-50"
                            title="Push to AutoCount (disabled until integration is enabled)"
                          >
                            <Send size={12} />
                          </button>
                        )}
                        {canManage && e.status !== "void" && (
                          <button
                            onClick={() => voidEntry(e)}
                            className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                            title="Void"
                          >
                            <X size={12} />
                          </button>
                        )}
                        {canEdit && e.status === "draft" && (
                          <button
                            onClick={() => deleteEntry(e)}
                            className="rounded p-1 text-ink-muted hover:bg-err/10 hover:text-err"
                            title="Delete"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <EntryPanel
          mode="create"
          udfFields={udf.fields}
          lockedProjectId={projectId}
          lockedProjectLabel={projectLabel}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            list.reload();
          }}
        />
      )}
      {editing && (
        <EntryPanel
          mode="edit"
          entry={editing}
          udfFields={udf.fields}
          lockedProjectId={projectId}
          lockedProjectLabel={projectLabel}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </PanelSection>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </span>
      <span
        className={cn(
          "text-[12.5px] font-medium leading-none",
          accent ? "text-accent" : "text-ink"
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ── Finance ledger ───────────────────────────────────────────
// Line-item finance. Each entry is an income or cost line tagged with
// a category. Live totals + margin + per-sqm / per-day views are
// computed client-side so edits feel instant; the backend keeps
// project_finance in sync for list-view rollups.

// The picker lists and their labels live in pms-ledger-categories.ts, shared
// with mobile — which used to humanize() the slugs, so one P&L row read
// "COGS — Matt/Sofa" on the PC and "Cogs Matt Sofa" on the phone.

function FinanceLedgerSection({
  projectId,
  sizeSqm,
  durationDays,
  lines,
  lumpSales,
  onChange,
  toast,
}: {
  projectId: number;
  sizeSqm: number | null;
  durationDays: number | null;
  lines: FinanceLine[];
  /** project_finance.total_sales — the quick lump-sum "Total Sales" box.
   *  Used as the snapshot's sales figure when no individual sales-entry
   *  lines exist, so the green box and the snapshot agree. */
  lumpSales: number | null;
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  // Snapshot is the editor (2026-05-08). Each editable cost row's
  // value cell is click-to-edit; saving consolidates that
  // category's existing non-auto lines into one line at the typed
  // amount. Empty/0 archives them all.
  const [savingCat, setSavingCat] = useState<string | null>(null);
  // 2026-05-08 (revised) — boss said no per-row expand; attachments
  // live in a single dedicated section at the bottom of the card.
  // Click-to-edit on each cost row still consolidates that category
  // into one tally line. Receipts are managed via the Attachments
  // section below.
  const [addingReceipt, setAddingReceipt] = useState(false);
  const dialog = useDialog();
  async function replaceCategoryAmount(category: string, nextAmount: number) {
    const existing = lines.filter(
      (l) =>
        l.kind === "cost" &&
        (l.category ?? "").trim() === category &&
        // Auto rows are managed by the rate engine — never touched here.
        !l.auto_source &&
        // Sales-entry-sourced income lines never live in cost; defensive.
        !l.source,
    );
    // If the typed amount equals the current single-line amount, nothing to do.
    if (existing.length === 1 && Math.abs((existing[0].amount || 0) - nextAmount) < 0.005) {
      return;
    }
    if (existing.length > 1) {
      const ok = await dialog.confirm(
        `${existing.length} existing lines in this category will be consolidated into one entry of ${formatCurrency(nextAmount)}. Continue?`,
      );
      if (!ok) return;
    }
    setSavingCat(category);
    try {
      if (nextAmount <= 0) {
        // Zeroing the row — archive every line in the category.
        for (const line of existing) {
          await api.del(`/api/projects/finance/lines/${line.id}`);
        }
      } else if (existing.length === 1) {
        // Edit the amount in place so the line keeps its receipt
        // (r2_key) and identity. Delete+recreate would drop the file.
        await api.patch(`/api/projects/finance/lines/${existing[0].id}`, {
          amount: nextAmount,
        });
      } else {
        // Consolidating many into one. Carry the first attached receipt
        // forward so collapsing the rows never silently loses a file.
        const withReceipt = existing.find((l) => l.r2_key);
        for (const line of existing) {
          await api.del(`/api/projects/finance/lines/${line.id}`);
        }
        await api.post(`/api/projects/${projectId}/finance/lines`, {
          kind: "cost",
          category,
          amount: nextAmount,
          description: `${ledgerCategoryLabel(category)} (snapshot)`,
          r2_key: withReceipt?.r2_key ?? undefined,
          file_name: withReceipt?.file_name ?? undefined,
          mime_type: withReceipt?.mime_type ?? undefined,
        });
      }
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSavingCat(null);
    }
  }

  const income = lines.filter((l) => l.kind === "income");
  const cost = lines.filter((l) => l.kind === "cost");
  const sumBy = (kind: "income" | "cost", category?: string) =>
    lines
      .filter(
        (l) =>
          l.kind === kind &&
          (category === undefined ? true : l.category === category),
      )
      .reduce((s, l) => s + (l.amount || 0), 0);
  // 2026-05-08: NAMED_COSTS includes the new COGS sub-categories +
  // transport split so they don't double-count under "Others".
  const NAMED_COSTS = new Set([
    "cogs",
    "cogs_matt_sofa",
    "cogs_bedframe",
    "cogs_accessories",
    "rental",
    "setup",
    "transport",
    "transport_fee",
    "transport_setup_dismantle",
    "commission",
    "merchandise",
  ]);
  const totalIncome = income.reduce((s, l) => s + (l.amount || 0), 0);
  const totalCost = cost.reduce((s, l) => s + (l.amount || 0), 0);
  const profit = totalIncome - totalCost;
  const margin = totalIncome > 0 ? (profit / totalIncome) * 100 : null;
  // Prefer individual sales-entry lines; if none exist, fall back to the
  // quick lump-sum Total Sales box (project_finance.total_sales) so the
  // snapshot matches the green Total Sales figure the user keyed in.
  const salesLinesSum = sumBy("income", "sales");
  const sales = salesLinesSum > 0 ? salesLinesSum : (lumpSales ?? 0);
  // COGS family — break out + total. Legacy `cogs` slug folds into
  // the total alongside the three product sub-cats.
  const cogsLegacy = sumBy("cost", "cogs");
  const cogsMattSofa = sumBy("cost", "cogs_matt_sofa");
  const cogsBedframe = sumBy("cost", "cogs_bedframe");
  const cogsAccessories = sumBy("cost", "cogs_accessories");
  const cogs = cogsLegacy + cogsMattSofa + cogsBedframe + cogsAccessories;
  const rentalTotal = sumBy("cost", "rental");
  const setupTotal = sumBy("cost", "setup");
  // Transport split — fee = rate-driven, setup_dismantle = manual.
  // Legacy `transport` rows fold into the fee bucket.
  const transportFee = sumBy("cost", "transport") + sumBy("cost", "transport_fee");
  const transportSetupDismantle = sumBy("cost", "transport_setup_dismantle");
  const transportTotal = transportFee + transportSetupDismantle;
  const commissionTotal = sumBy("cost", "commission");
  const merchandiseTotal = sumBy("cost", "merchandise");
  const othersTotal = cost
    .filter((l) => !NAMED_COSTS.has((l.category ?? "").trim()))
    .reduce((s, l) => s + (l.amount || 0), 0);
  const netProfit = sales - totalCost;
  const gpPct = sales > 0 ? ((sales - cogs) / sales) * 100 : null;
  const salesPerDay =
    durationDays && durationDays > 0 ? sales / durationDays : null;
  const rentPerSqm = sizeSqm && sizeSqm > 0 ? rentalTotal / sizeSqm : null;
  const rentPerDay =
    durationDays && durationDays > 0 ? rentalTotal / durationDays : null;

  const grossProfit = sales - cogs;
  const netMarginPct = sales > 0 ? (netProfit / sales) * 100 : 0;
  const rentPerSqmPerDay =
    rentalTotal > 0 && sizeSqm && sizeSqm > 0 && durationDays && durationDays > 0
      ? rentalTotal / sizeSqm / durationDays
      : 0;

  return (
    <PanelSection title={`Finance Ledger (${lines.length})`} muted>
      {/* ── Financial Snapshot — single source of truth ─
          The previous design showed three different views of the
          same data (3-up totals, 12-cell breakdown grid, line
          lists). Boss flagged the repetition; this snapshot
          replaces the first two with one canonical card matching
          the Exhibition Report cost model. Line lists below stay
          for adding / editing the underlying data. */}
      <div className="rounded-md border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-[11px] font-bold uppercase tracking-brand text-ink">
            Financial Snapshot
          </h3>
          <p className="mt-0.5 text-[10.5px] text-ink-muted">
            From Exhibition Report cost model · Sales − COGS = GP · Sales − all costs = Net Profit
          </p>
        </div>

        {/* 4 KPI tiles */}
        <div className="grid grid-cols-2 divide-x divide-y divide-border-subtle border-b border-border sm:grid-cols-4 sm:divide-y-0">
          <SnapshotKpi
            label="Total Sales"
            value={formatCurrency(sales)}
            subtitle={
              salesPerDay != null
                ? `${formatCurrency(salesPerDay)} / day`
                : "—"
            }
          />
          <SnapshotKpi
            label="Gross Profit"
            value={formatCurrency(grossProfit)}
            tone={grossProfit >= 0 ? "synced" : "err"}
            subtitle={
              gpPct != null ? `${gpPct.toFixed(1)}% after COGS` : "0.0% after COGS"
            }
          />
          <SnapshotKpi
            label="Total Cost"
            value={formatCurrency(totalCost)}
            subtitle="All cost lines"
          />
          <SnapshotKpi
            label="Net Profit"
            value={formatCurrency(netProfit)}
            tone={netProfit >= 0 ? "synced" : "err"}
            subtitle={`${netMarginPct.toFixed(1)}% bottom line`}
          />
        </div>

        {/* Itemized cost table — single editor surface (2026-05-08).
            Click any non-auto row to inline-edit the amount; saving
            consolidates that category's lines into one. Per-row
            expanders are gone (boss feedback) — receipts live in the
            single Attachments section below. */}
        <div className="text-[12px]">
          <SnapshotRow
            label="COGS — Matt/Sofa"
            value={cogsMattSofa}
            indent
            editable={{ onSave: (n) => replaceCategoryAmount("cogs_matt_sofa", n) }}
            busy={savingCat === "cogs_matt_sofa"}
          />
          <SnapshotRow
            label="COGS — Bedframe"
            value={cogsBedframe}
            indent
            editable={{ onSave: (n) => replaceCategoryAmount("cogs_bedframe", n) }}
            busy={savingCat === "cogs_bedframe"}
          />
          <SnapshotRow
            label="COGS — Accessories"
            value={cogsAccessories}
            indent
            editable={{ onSave: (n) => replaceCategoryAmount("cogs_accessories", n) }}
            busy={savingCat === "cogs_accessories"}
          />
          {cogsLegacy > 0 && (
            <SnapshotRow label="COGS — Other" value={cogsLegacy} indent />
          )}
          <SnapshotRow label="COGS Total" value={cogs} subtotal />
          <SnapshotRow
            label="Rental"
            annotation={`RM ${rentPerSqmPerDay.toFixed(0)}/sqm/day`}
            value={rentalTotal}
            editable={{ onSave: (n) => replaceCategoryAmount("rental", n) }}
            busy={savingCat === "rental"}
          />
          <SnapshotRow
            label="Setup"
            value={setupTotal}
            editable={{ onSave: (n) => replaceCategoryAmount("setup", n) }}
            busy={savingCat === "setup"}
          />
          <SnapshotRow
            label="Transport Fee"
            annotation="auto · % of sales"
            value={transportFee}
          />
          <SnapshotRow
            label="Transport Setup & Dismantle"
            value={transportSetupDismantle}
            editable={{ onSave: (n) => replaceCategoryAmount("transport_setup_dismantle", n) }}
            busy={savingCat === "transport_setup_dismantle"}
          />
          <SnapshotRow
            label="Commission"
            annotation="auto · % of sales"
            value={commissionTotal}
          />
          <SnapshotRow
            label="Merchandise"
            annotation="auto · % of sales"
            value={merchandiseTotal}
          />
          <SnapshotRow label="Others Costing" value={othersTotal} />
          <SnapshotRow
            label="Total Cost"
            value={totalCost}
            subtotal
          />
          <SnapshotRow
            label="Net Profit"
            value={netProfit}
            subtotal
            tone={netProfit >= 0 ? "synced" : "err"}
            annotation={`(${netMarginPct.toFixed(1)}%)`}
          />
        </div>

        {/* Cost lines — single section at the bottom of the snapshot
            card. Lists every non-auto cost line (with or without a
            receipt) so each can be edited in place and have a file
            attached. "+ Add cost line" opens AddFinanceLineForm, whose
            dropdown hides already-used categories to prevent duplicates. */}
        <FinanceAttachmentsSection
          projectId={projectId}
          lines={lines}
          adding={addingReceipt}
          onAddOpen={() => setAddingReceipt(true)}
          onAddClose={() => setAddingReceipt(false)}
          onChange={onChange}
          toast={toast}
        />
      </div>
      <p className="mt-1 text-[10.5px] text-ink-muted">
        Tap a row to set its amount. Individual cost lines and their receipts live in the Cost lines section above. Sales live in the Sales section above; auto rows are computed from the rate card.
      </p>
    </PanelSection>
  );
}

// Single Cost Lines section at the bottom of the Financial Snapshot.
// Lists every non-auto, manually-entered cost line (with or without a
// receipt) with open / edit / delete affordances, so each can be edited
// in place and have a receipt attached. "+ Add cost line" opens
// AddFinanceLineForm, whose category dropdown hides already-used
// categories so a category never gets a duplicate line.
function FinanceAttachmentsSection({
  projectId,
  lines,
  adding,
  onAddOpen,
  onAddClose,
  onChange,
  toast,
}: {
  projectId: number;
  lines: FinanceLine[];
  adding: boolean;
  onAddOpen: () => void;
  onAddClose: () => void;
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const costLines = lines.filter(
    (l) => l.kind === "cost" && !l.auto_source && !l.source,
  );
  // Categories that already have an editable cost line. The add form
  // hides these so a category never gets a duplicate line — the user
  // edits the existing row instead.
  const usedCategories = new Set(costLines.map((l) => (l.category ?? "").trim()));
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">
          Cost lines ({costLines.length})
        </h4>
        {!adding && (
          <button
            onClick={onAddOpen}
            className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-accent hover:underline"
          >
            <Plus size={11} /> Add cost line
          </button>
        )}
      </div>
      {costLines.length === 0 && !adding && (
        <div className="text-[11px] text-ink-muted">
          No cost lines yet. Add one to record a cost and attach a receipt.
        </div>
      )}
      {costLines.length > 0 && (
        <CategoryDetailLines
          lines={costLines}
          onChange={onChange}
          toast={toast}
        />
      )}
      {adding && (
        <div className="mt-2">
          <AddFinanceLineForm
            projectId={projectId}
            kind="cost"
            usedCategories={usedCategories}
            onCancel={onAddClose}
            onSaved={() => {
              onAddClose();
              onChange();
            }}
            toast={toast}
          />
        </div>
      )}
    </div>
  );
}

// EditableSnapshotRow was deleted on 2026-05-08 along with the
// per-row expand UI — boss preferred a single Attachments section
// at the bottom of the snapshot card. SnapshotRow's `editable` prop
// (click-to-edit consolidate) covers the inline edit need; the new
// FinanceAttachmentsSection above covers receipts.

// Compact list of the underlying lines for one category, with the
// existing edit/delete/openFile affordances. Lifted from LedgerGroup
// but stripped of the section chrome so it nests cleanly under a
// snapshot row.
function CategoryDetailLines({
  lines,
  onChange,
  toast,
}: {
  lines: FinanceLine[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [editingId, setEditingId] = useState<number | null>(null);
  async function del(line: FinanceLine) {
    if (!await dialog.confirm("Remove this line? Totals will re-compute.")) return;
    try {
      await api.del(`/api/projects/finance/lines/${line.id}`);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }
  async function openFile(line: FinanceLine) {
    if (!line.r2_key) return;
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${line.r2_key}`, viewableMime(line.r2_key));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }
  return (
    <div className="space-y-1">
      {lines.map((l) =>
        editingId === l.id ? (
          <EditFinanceLineRow
            key={l.id}
            line={l}
            onCancel={() => setEditingId(null)}
            onSaved={() => {
              setEditingId(null);
              onChange();
            }}
            toast={toast}
          />
        ) : (
          <div
            key={l.id}
            className="group flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1 text-[10.5px]"
          >
            <span className="min-w-0 flex-1 truncate" title={l.description || undefined}>
              {l.description || <span className="text-ink-muted">No description</span>}
            </span>
            <span className="font-mono text-[10px] text-ink-muted">
              {l.occurred_at ? formatDate(l.occurred_at) : formatDate(l.created_at)}
            </span>
            <span className="font-mono text-[11px] font-bold text-err">
              −{formatCurrency(l.amount)}
            </span>
            {l.r2_key && (
              <button
                onClick={() => openFile(l)}
                className="rounded p-0.5 text-ink-muted hover:text-accent"
                title="Open receipt"
              >
                <ExternalLink size={11} />
              </button>
            )}
            <button
              onClick={() => setEditingId(l.id)}
              className="rounded p-0.5 text-ink-muted opacity-0 hover:bg-accent/10 hover:text-accent group-hover:opacity-100"
              title="Edit"
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={() => del(l)}
              className="rounded p-0.5 text-ink-muted opacity-0 hover:bg-err/10 hover:text-err group-hover:opacity-100"
              title="Remove"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ),
      )}
    </div>
  );
}

function TotalCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "synced" | "err";
}) {
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "font-mono text-[13px] font-bold",
          tone === "synced" && "text-synced",
          tone === "err" && "text-err",
          !tone && "text-ink"
        )}
      >
        {value}
      </div>
    </div>
  );
}

// Financial Snapshot tile — large value above a one-line subtitle.
// Mirrors the Exhibition Report layout the boss vibecoded.
function SnapshotKpi({
  label,
  value,
  subtitle,
  tone,
}: {
  label: string;
  value: string;
  subtitle: string;
  tone?: "synced" | "err";
}) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-display text-[20px] font-extrabold leading-none tracking-tight",
          tone === "synced" && "text-synced",
          tone === "err" && "text-err",
          !tone && "text-ink",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[10px] text-ink-muted">{subtitle}</div>
    </div>
  );
}

// One row of the itemized cost table. `subtotal` flag bolds the row
// and tints the background so it reads as a footer — used for COGS
// Total, Total Cost, and Net Profit rows. `indent` nests the label
// under its parent subtotal (the COGS sub-rows under COGS Total).
// When `editable` is set the value cell becomes click-to-edit and
// calls onSave with the typed amount. `lineCount` + `expanded` +
// `onToggleExpand` add the chevron affordance for drilling into
// per-line detail (descriptions / dates / attachments).
function SnapshotRow({
  label,
  value,
  annotation,
  subtotal,
  indent,
  tone,
  editable,
  busy,
  lineCount,
  expanded,
  onToggleExpand,
}: {
  label: string;
  value: number;
  annotation?: string;
  subtotal?: boolean;
  indent?: boolean;
  tone?: "synced" | "err";
  editable?: { onSave: (n: number) => Promise<void> };
  busy?: boolean;
  lineCount?: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  function startEdit() {
    if (!editable) return;
    setDraft(value > 0 ? String(value) : "");
    setEditing(true);
  }
  async function commit() {
    if (!editable) return;
    const n = parseFloat(draft.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) {
      setEditing(false);
      return;
    }
    setEditing(false);
    if (Math.abs(n - value) < 0.005) return; // unchanged
    await editable.onSave(n);
  }
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-border-subtle py-1.5",
        indent ? "pl-8 pr-4" : "px-4",
        subtotal && "bg-bg/50",
        editable && !editing && !busy && "cursor-pointer hover:bg-accent-soft/30",
      )}
      onClick={editable && !editing ? startEdit : undefined}
      title={editable ? "Click to edit" : undefined}
    >
      <span
        className={cn(
          "truncate",
          subtotal ? "font-bold text-ink" : "text-ink-secondary",
        )}
      >
        {label}
        {annotation && (
          <span className="ml-1.5 font-mono text-[10px] font-normal text-ink-muted">
            {annotation}
          </span>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {onToggleExpand && lineCount != null && lineCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] text-ink-muted hover:bg-bg/60 hover:text-accent"
            title={expanded ? "Hide line detail" : `Show ${lineCount} line${lineCount === 1 ? "" : "s"} (descriptions / receipts)`}
          >
            {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            <span>{lineCount}</span>
          </button>
        )}
        {editing ? (
          <input
            type="number"
            step="0.01"
            min="0"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(false);
            }}
            className="w-32 rounded border border-accent bg-surface px-2 py-0.5 text-right font-mono tabular-nums outline-none focus:ring-2 focus:ring-primary/20"
          />
        ) : (
          <span
            className={cn(
              "font-mono tabular-nums",
              subtotal && "font-bold",
              tone === "synced" && "text-synced",
              tone === "err" && "text-err",
              !tone && "text-ink",
              busy && "opacity-50",
            )}
          >
            {busy ? "…" : formatCurrency(value)}
          </span>
        )}
      </div>
    </div>
  );
}

/** Smaller, denser variant of TotalCell — used in the per-category
 *  breakdown grid below the headline (Sales/Cost/Profit) strip on
 *  the project detail Finance tab. Accepts a number (formatted as
 *  currency, "—" when null/zero-without-data) or a pre-rendered
 *  string (for percentages). */
function BreakdownCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string | null;
  tone?: "synced" | "err";
}) {
  let display: string;
  if (value == null) {
    display = "—";
  } else if (typeof value === "string") {
    display = value;
  } else {
    display = formatCurrency(value);
  }
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-[12px] font-semibold tabular-nums",
          tone === "synced" && "text-synced",
          tone === "err" && "text-err",
          !tone && "text-ink",
        )}
      >
        {display}
      </span>
    </div>
  );
}

function LedgerGroup({
  title,
  tone,
  lines,
  onAdd,
  onChange,
  toast,
}: {
  title: string;
  tone: "synced" | "err";
  lines: FinanceLine[];
  onAdd: () => void;
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const [editingId, setEditingId] = useState<number | null>(null);

  async function del(line: FinanceLine) {
    if (!await dialog.confirm("Remove this line? Totals will re-compute.")) return;
    try {
      await api.del(`/api/projects/finance/lines/${line.id}`);
      onChange();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function openFile(line: FinanceLine) {
    if (!line.r2_key) return;
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${line.r2_key}`, viewableMime(line.r2_key));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wider",
              tone === "synced" ? "text-synced" : "text-err"
            )}
          >
            {title}
          </span>
          <span className="font-mono text-[10px] text-ink-muted">
            {lines.length} line{lines.length === 1 ? "" : "s"} · {formatCurrency(total)}
          </span>
        </div>
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-accent hover:underline"
        >
          <Plus size={11} /> Add
        </button>
      </div>
      {lines.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-bg/40 px-3 py-2 text-[11px] text-ink-muted">
          No {title.toLowerCase()} lines.
        </div>
      ) : (
        <div className="space-y-1">
          {lines.map((l) =>
            editingId === l.id ? (
              <EditFinanceLineRow
                key={l.id}
                line={l}
                onCancel={() => setEditingId(null)}
                onSaved={() => {
                  setEditingId(null);
                  onChange();
                }}
                toast={toast}
              />
            ) : (
            <div
              key={l.id}
              className="group flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[11px]"
            >
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                  tone === "synced" ? "bg-synced/10 text-synced" : "bg-err/10 text-err"
                )}
              >
                {ledgerCategoryLabel(l.category)}
              </span>
              <div className="min-w-0 flex-1">
                <div
                  className="truncate"
                  title={l.description || undefined}
                >
                  {l.description || <span className="text-ink-muted">No description</span>}
                </div>
                <div className="text-[10px] text-ink-muted">
                  {l.occurred_at ? formatDate(l.occurred_at) : formatDate(l.created_at)}
                  {l.created_by_name && ` · ${l.created_by_name}`}
                </div>
              </div>
              <span
                className={cn(
                  "font-mono text-[12px] font-bold",
                  tone === "synced" ? "text-synced" : "text-err"
                )}
              >
                {tone === "err" && "−"}
                {formatCurrency(l.amount)}
              </span>
              {l.source === "sales_entry" && (
                <span
                  className="rounded-full border border-accent/30 bg-accent-soft/30 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-accent"
                  title="Synced from Sales — manage this row in the Sales section"
                >
                  Sales
                </span>
              )}
              {l.auto_source && (
                <span
                  className="rounded-full border border-ink-muted/30 bg-ink-muted/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-muted"
                  title="Generated by the cost-rate engine — adjust the rate card in Project Maintenance to change."
                >
                  Auto
                </span>
              )}
              {l.r2_key && (
                <button
                  onClick={() => openFile(l)}
                  className="rounded p-1 text-ink-muted hover:text-accent"
                  title="Open attached file"
                >
                  <ExternalLink size={12} />
                </button>
              )}
              {!l.source && !l.auto_source && (
                <button
                  onClick={() => setEditingId(l.id)}
                  className="rounded p-1 text-ink-muted opacity-0 hover:bg-accent/10 hover:text-accent group-hover:opacity-100"
                  title="Edit"
                >
                  <Pencil size={12} />
                </button>
              )}
              {!l.source && !l.auto_source && (
                <button
                  onClick={() => del(l)}
                  className="rounded p-1 text-ink-muted opacity-0 hover:bg-err/10 hover:text-err group-hover:opacity-100"
                  title="Remove"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function AddFinanceLineForm({
  projectId,
  kind,
  onCancel,
  onSaved,
  toast,
  categoryDefault,
  usedCategories,
}: {
  projectId: number;
  kind: "income" | "cost";
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
  // When set, the category dropdown is pre-selected (and the field
  // hidden) so the row-level "+ Add detailed line" CTA goes straight
  // to amount + description + date + receipt.
  categoryDefault?: string;
  // Categories that already have a line — hidden from the dropdown so
  // the user edits the existing row rather than adding a duplicate.
  usedCategories?: Set<string>;
}) {
  const allCategories = kind === "income" ? LEDGER_INCOME_CATS : LEDGER_COST_CATS;
  const categories = categoryDefault
    ? allCategories
    : allCategories.filter((c) => !usedCategories?.has(c));
  const [category, setCategory] = useState<string>(
    categoryDefault ?? categories[0] ?? "",
  );
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Amount must be a non-negative number");
      return;
    }
    setSubmitting(true);
    try {
      let r2Key: string | undefined;
      let fileName: string | undefined;
      let mimeType: string | undefined;
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          toast.error("File exceeds 10MB");
          setSubmitting(false);
          return;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const buf = await file.arrayBuffer();
        const up = await api.putBinary<{ key: string; mime_type: string }>(
          `/api/projects/${projectId}/finance/upload?ext=${ext}`,
          buf,
          file.type
        );
        r2Key = up.key;
        fileName = file.name;
        mimeType = up.mime_type;
      }
      await api.post(`/api/projects/${projectId}/finance/lines`, {
        kind,
        category,
        amount: n,
        description: description.trim() || null,
        occurred_at: occurredAt || null,
        r2_key: r2Key,
        file_name: fileName,
        mime_type: mimeType,
      });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!categoryDefault && categories.length === 0) {
    return (
      <div className="mt-3 rounded-md border border-border bg-surface p-3 text-[11px] text-ink-secondary">
        Every category already has a line. Edit the existing row to change its
        amount or attach a receipt instead of adding a duplicate.
        <div className="mt-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">
        New {kind} line
        {categoryDefault && ` · ${ledgerCategoryLabel(categoryDefault)}`}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {!categoryDefault && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {ledgerCategoryLabel(c)}
              </option>
            ))}
          </select>
        )}
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (RM)"
          className={cn(
            "rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-primary",
            categoryDefault && "col-span-2",
          )}
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
        <DateField
          fullWidth
          value={occurredAt}
          onChange={(iso) => setOccurredAt(iso)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
          title="Payment date"
        />
        <input
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.pdf,.xlsx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none"
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting || !amount}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function EditFinanceLineRow({
  line,
  onCancel,
  onSaved,
  toast,
}: {
  line: FinanceLine;
  onCancel: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const categories = line.kind === "income" ? LEDGER_INCOME_CATS : LEDGER_COST_CATS;
  const initialCategory = categories.includes(line.category)
    ? line.category
    : categories[0];
  const [category, setCategory] = useState<string>(initialCategory);
  const [amount, setAmount] = useState<string>(String(line.amount ?? ""));
  const [description, setDescription] = useState<string>(line.description ?? "");
  const [occurredAt, setOccurredAt] = useState<string>(
    line.occurred_at ? line.occurred_at.slice(0, 10) : ""
  );
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Amount must be a non-negative number");
      return;
    }
    setSubmitting(true);
    try {
      const patch: Record<string, any> = {
        category,
        amount: n,
        description: description.trim() || null,
        occurred_at: occurredAt || null,
      };
      // Replacing / attaching a receipt — upload then carry the key on
      // the patch. An existing r2_key is left untouched when no new file
      // is picked.
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          toast.error("File exceeds 10MB");
          setSubmitting(false);
          return;
        }
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const buf = await file.arrayBuffer();
        const up = await api.putBinary<{ key: string; mime_type: string }>(
          `/api/projects/${line.project_id}/finance/upload?ext=${ext}`,
          buf,
          file.type,
        );
        patch.r2_key = up.key;
        patch.file_name = file.name;
        patch.mime_type = up.mime_type;
      }
      await api.patch(`/api/projects/finance/lines/${line.id}`, patch);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-md border border-accent/40 bg-accent-soft/20 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-accent">
        Edit {line.kind} line
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {ledgerCategoryLabel(c)}
            </option>
          ))}
          {!categories.includes(line.category) && (
            <option value={line.category}>{ledgerCategoryLabel(line.category)}</option>
          )}
        </select>
        <input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (RM)"
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-primary"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="col-span-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
        />
        <DateField
          fullWidth
          value={occurredAt}
          onChange={(iso) => setOccurredAt(iso)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none focus:border-primary"
          title="Payment date"
        />
        <div className="col-span-2">
          {line.r2_key && (
            <div className="mb-1 text-[10px] text-ink-muted">
              Current receipt: {line.file_name || "attached"} · pick a file to replace
            </div>
          )}
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.pdf,.xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] outline-none"
            title={line.r2_key ? "Replace receipt" : "Attach receipt"}
          />
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={submitting || !amount}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Attachments ──────────────────────────────────────────────

const ATTACH_CATEGORIES: { value: string; label: string }[] = [
  { value: "floorplan", label: "Floorplan" },
  { value: "render_3d", label: "3D Render" },
  { value: "contract", label: "Contract" },
  { value: "permit", label: "Permit" },
  { value: "photo", label: "Photo" },
  { value: "stock_transfer", label: "Stock Transfer" },
  { value: "other", label: "Other" },
];

const ATTACH_ROLES: {
  value: AttachRole;
  Icon: LucideIcon;
  label: string;
}[] = [
  { value: "design", Icon: Monitor, label: "Design" },
  { value: "office", Icon: Receipt, label: "Office" },
  { value: "sales", Icon: Banknote, label: "Sales" },
  { value: "driver", Icon: Truck, label: "Driver" },
];

function roleMeta(role: AttachRole | null | undefined) {
  return ATTACH_ROLES.find((x) => x.value === role) ?? null;
}

function roleLabel(role: AttachRole | null | undefined): string {
  return roleMeta(role)?.label ?? "";
}

function RoleBadge({
  role,
  withLabel = true,
  size = 10,
}: {
  role: AttachRole | null | undefined;
  withLabel?: boolean;
  size?: number;
}) {
  const meta = roleMeta(role);
  if (!meta) return null;
  const Icon = meta.Icon;
  return (
    <span className="inline-flex items-center gap-1">
      <Icon size={size} />
      {withLabel && meta.label}
    </span>
  );
}

function AttachmentsSection({
  projectId,
  attachments,
  onChange,
  toast,
}: {
  projectId: number;
  attachments: ProjectAttachment[];
  onChange: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [category, setCategory] = useState<string>("floorplan");
  const [uploadRole, setUploadRole] = useState<AttachRole | "">("");
  const [filterRole, setFilterRole] = useState<AttachRole | "">("");
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);

  const filtered = filterRole
    ? attachments.filter((a) => a.uploaded_by_role === filterRole)
    : attachments;

  async function onFiles(list: FileList | null) {
    if (!list || !list.length) return;
    const files = Array.from(list);
    const MAX = 25 * 1024 * 1024;
    const ALLOWED = new Set(["jpg", "jpeg", "png", "webp", "mp4", "pdf", "dwg", "skp"]);
    const staged: File[] = [];
    for (const f of files) {
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      if (!ALLOWED.has(ext)) {
        toast.error(`${f.name}: unsupported type`);
        continue;
      }
      if (f.size > MAX) {
        toast.error(`${f.name}: exceeds 25MB`);
        continue;
      }
      staged.push(f);
    }
    if (!staged.length) return;
    setUploading({ done: 0, total: staged.length });
    let failed = 0;
    for (let i = 0; i < staged.length; i++) {
      const f = staged[i];
      try {
        const ext = f.name.split(".").pop()?.toLowerCase() || "jpg";
        const buf = await f.arrayBuffer();
        const roleQs = uploadRole ? `&role=${uploadRole}` : "";
        await api.putBinary(
          `/api/projects/${projectId}/attachments?category=${category}&ext=${ext}&name=${encodeURIComponent(f.name)}${roleQs}`,
          buf,
          f.type
        );
      } catch (e: any) {
        failed++;
        console.warn(e);
      }
      setUploading({ done: i + 1, total: staged.length });
    }
    setUploading(null);
    if (failed > 0) toast.error(`${failed} upload(s) failed`);
    else toast.success(`Uploaded ${staged.length} file(s)`);
    onChange();
  }

  return (
    <PanelSection title={`Attachments (${attachments.length})`}>
      {/* Upload controls */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-[11px]"
        >
          {ATTACH_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          value={uploadRole}
          onChange={(e) => setUploadRole(e.target.value as AttachRole | "")}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-[11px]"
          title="Your role for this upload"
        >
          <option value="">— no role —</option>
          {ATTACH_ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold hover:border-accent/40 hover:text-accent cursor-pointer">
          <Upload size={11} />
          Upload
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        {uploading && (
          <span className="text-[10px] text-ink-muted">
            Uploading {uploading.done}/{uploading.total}…
          </span>
        )}
      </div>

      {/* Role filter chips */}
      {attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <button
            onClick={() => setFilterRole("")}
            className={cn(
              "rounded-full border inline-flex items-center justify-center min-w-[42px] whitespace-nowrap px-2 py-1 text-[8.5px] font-semibold",
              filterRole === ""
                ? "border-accent bg-accent text-white"
                : "border-border bg-surface text-ink-muted hover:border-accent/40"
            )}
          >
            All ({attachments.length})
          </button>
          {ATTACH_ROLES.map((r) => {
            const count = attachments.filter((a) => a.uploaded_by_role === r.value).length;
            if (count === 0) return null;
            const active = filterRole === r.value;
            const Icon = r.Icon;
            return (
              <button
                key={r.value}
                onClick={() => setFilterRole(active ? "" : r.value)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border inline-flex items-center justify-center min-w-[42px] whitespace-nowrap px-2 py-1 text-[8.5px] font-semibold",
                  active
                    ? "border-accent bg-accent text-white"
                    : "border-border bg-surface text-ink-muted hover:border-accent/40"
                )}
              >
                <Icon size={10} /> {r.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="mt-2 text-[11px] text-ink-muted">
          {attachments.length === 0 ? "No attachments yet." : "No attachments match that role."}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {filtered.map((a) => (
            <AttachmentTile key={a.id} attachment={a} onArchive={onChange} toast={toast} />
          ))}
        </div>
      )}
    </PanelSection>
  );
}

function AttachmentTile({
  attachment,
  onArchive,
  toast,
}: {
  attachment: ProjectAttachment;
  onArchive: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const [thumb, setThumb] = useState<string | null>(null);
  // See PhasePhotoThumb: a swallowed thumbnail failure is indistinguishable from
  // "still loading" and from "not an image". Keep the reason and show it.
  const [thumbError, setThumbError] = useState<string | null>(null);
  const isImage = (attachment.mime_type || "").startsWith("image/");

  useEffect(() => {
    if (!isImage) return;
    let revoked = false;
    setThumbError(null);
    api
      .fetchBlobUrl(`/api/projects/attachments/${attachment.r2_key}`)
      .then((url) => {
        if (revoked) URL.revokeObjectURL(url);
        else setThumb(url);
      })
      .catch((e: unknown) => {
        if (revoked) return;
        setThumbError(
          e instanceof Error && e.message ? e.message : "This preview couldn't be loaded.",
        );
      });
    return () => {
      revoked = true;
      if (thumb) URL.revokeObjectURL(thumb);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.r2_key, isImage]);

  async function openFile() {
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${attachment.r2_key}`, viewableMime(attachment.file_name || attachment.r2_key));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Failed to open");
    }
  }

  async function downloadFile() {
    try {
      const url = await api.fetchBlobUrl(`/api/projects/attachments/${attachment.r2_key}`);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        attachment.file_name || attachment.r2_key.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      toast.error(e?.message || "Download failed");
    }
  }

  async function renameFile() {
    const next = await dialog.prompt({
      title: "Rename attachment",
      message: "Pick a new display name. The file content stays the same.",
      defaultValue: attachment.file_name || "",
      placeholder: "e.g. floorplan-final-v3.pdf",
      required: true,
      confirmLabel: "Rename",
    });
    if (!next || next === attachment.file_name) return;
    try {
      await api.patch(`/api/projects/attachments/${attachment.id}`, {
        file_name: next,
      });
      toast.success("Renamed");
      onArchive(); // reuses the parent's reload callback
    } catch (e: any) {
      toast.error(e?.message || "Rename failed");
    }
  }

  return (
    <div className="group relative overflow-hidden rounded-md border border-border bg-surface">
      <button onClick={openFile} className="block w-full text-left">
        {isImage && thumb ? (
          <img
            src={thumb}
            alt={attachment.file_name || ""}
            className="h-24 w-full object-cover"
          />
        ) : isImage && thumbError ? (
          <div
            className="flex h-24 w-full flex-col items-center justify-center gap-1 bg-bg/60 px-2 text-center text-err"
            title={thumbError}
          >
            <ImageOff size={22} />
            <span className="text-[9px] font-semibold uppercase tracking-wide">
              Preview failed
            </span>
          </div>
        ) : (
          <div className="flex h-24 w-full items-center justify-center bg-bg/60 text-ink-muted">
            {isImage ? <ImageIcon size={24} /> : <FileText size={24} />}
          </div>
        )}
        <div className="px-2 py-1.5">
          <div className="truncate text-[11px] font-semibold">
            {attachment.file_name || attachment.r2_key.split("/").pop()}
          </div>
          <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-ink-muted">
            <span>{attachment.category || "—"}</span>
            {attachment.uploaded_by_role && (
              <>
                <span>·</span>
                <span
                  className="inline-flex items-center gap-0.5"
                  title={roleLabel(attachment.uploaded_by_role)}
                >
                  <RoleBadge role={attachment.uploaded_by_role} size={9} />
                </span>
              </>
            )}
          </div>
        </div>
      </button>
      {/* Hover action cluster — download / rename / remove. Stays
          hidden until the tile is hovered so the thumbnail isn't
          cluttered. */}
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          onClick={downloadFile}
          className="rounded bg-surface/80 p-1 text-ink-muted hover:bg-accent-soft hover:text-accent"
          title="Download"
        >
          <Download size={11} />
        </button>
        <button
          onClick={renameFile}
          className="rounded bg-surface/80 p-1 text-ink-muted hover:bg-accent-soft hover:text-accent"
          title="Rename"
        >
          <Pencil size={11} />
        </button>
        <button
          onClick={async () => {
            if (!(await dialog.confirm("Remove this attachment?"))) return;
            try {
              await api.post(`/api/projects/attachments/${attachment.id}/archive`, {});
              onArchive();
            } catch (e: any) {
              toast.error(e?.message || "Something went wrong. Please try again.");
            }
          }}
          className="rounded bg-surface/80 p-1 text-ink-muted hover:bg-err/10 hover:text-err"
          title="Remove"
        >
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

// ── Google Calendar URL ──────────────────────────────────────
// Uses the public /calendar/render?action=TEMPLATE endpoint — no OAuth,
// opens Google Calendar with the event pre-filled. User still has to
// click "Save" in Google.

function googleCalendarUrl(p: {
  name: string;
  code: string;
  start_date: string | null;
  end_date: string | null;
  venue: string | null;
  venue_address: string | null;
  organizer: string | null;
}): string {
  const fmt = (d: string) => d.replace(/-/g, "");
  const start = p.start_date ? fmt(p.start_date) : "";
  // Google wants end date exclusive for all-day events, so +1 day
  const endRaw = p.end_date || p.start_date || "";
  const endDate = endRaw ? new Date(endRaw) : null;
  if (endDate) endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = endDate ? endDate.toISOString().slice(0, 10).replace(/-/g, "") : start;
  const dates = `${start}/${end}`;
  const details = [
    `Project: ${p.code}`,
    p.organizer && `Organizer: ${p.organizer}`,
  ]
    .filter(Boolean)
    .join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: p.name,
    dates,
    details,
    location: [p.venue, p.venue_address].filter(Boolean).join(", "),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ── Import CSV panel ─────────────────────────────────────────

function ImportCsvPanel({
  onClose,
  onDone,
  toast,
}: {
  onClose: () => void;
  onDone: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: string[]; total_rows: number } | null>(null);

  async function submit() {
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      // Raw text body (POST text/csv) — api helpers all assume JSON, so
      // we call the correlated raw-body transport. Auth token is the same one api uses — read it
      // THROUGH tokenStore, not from localStorage: a session-only login (Remember
      // me unchecked, or the owner's view-as) keeps the token in sessionStorage,
      // and the old inline read sent `Bearer ` and 401'd.
      // No timeout here would hang the dialog forever on a stalled cold-start;
      // cap it with an upload-length AbortSignal and surface a retryable error.
      const token = tokenStore.get();
      let signal: AbortSignal | undefined;
      try { signal = AbortSignal.timeout(120_000); } catch { signal = undefined; }
      let resp: Response;
      try {
        resp = await correlatedFetch(`${api.baseUrl}/api/projects/import/csv`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "text/csv",
            // Without X-Company-Id the backend stamps the hostname-default company
            // (HOUZS), so importing while "2990" is active would write to the wrong
            // company. Mirror lib/branding.ts.
            ...companyHeader(),
          },
          body: text,
          signal,
        });
      } catch (err) {
        if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw correlateError(
            new Error("The server took too long to respond. Please check your connection and try again."),
            requestIdFromError(err),
          );
        }
        throw err;
      }
      if (!resp.ok) throw correlateError(
        new Error(humanHttpMessage(resp.status, await resp.text().catch(() => ""))),
        requestIdFromResponse(resp),
      );
      const data = await consumeCorrelated(
        resp,
        () => resp.json() as Promise<{ imported: number; errors: string[]; total_rows: number }>,
      );
      setResult(data);
      if (data.imported > 0) toast.success(`Imported ${data.imported} of ${data.total_rows} row(s)`);
      onDone();
    } catch (e: any) {
      toast.error(e?.message || "Import failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title="Import Projects from CSV"
      subtitle="Paste rows from the Google Sheet — header row recognised"
      width={560}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-border bg-surface px-3 py-2 text-[12px]">
            Close
          </button>
          <Button variant="primary" onClick={submit} disabled={submitting || !text.trim()}>
            {submitting ? "Importing…" : "Import"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Columns">
        <div className="space-y-1.5 text-[11px] text-ink-secondary">
          <p>Supported header names (case-insensitive, use underscores or spaces):</p>
          <ul className="ml-4 list-disc space-y-0.5 font-mono text-[10.5px]">
            <li>name <span className="text-err">(required)</span></li>
            <li>brand · event_type · start_date · end_date</li>
            <li>venue · state · organizer · booth_no · size_sqm</li>
            <li>rental · total_sales · contractor_cost · license_fee</li>
            <li>notion_url</li>
          </ul>
          <p>Dates may be YYYY-MM-DD or DD/MM/YYYY. Unknown columns are ignored.</p>
        </div>
      </PanelSection>

      <PanelSection title="CSV">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"name,brand,event_type,start_date,end_date,venue,state\nPIKOM PC Fair 2026,AKEMI,exhibition,2026-05-10,2026-05-12,KLCC,Kuala Lumpur"}
          rows={14}
          className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] outline-none focus:border-primary"
        />
      </PanelSection>

      {result && (
        <PanelSection title="Result" muted>
          <div className="text-[11px]">
            <span className="font-semibold text-synced">{result.imported}</span> imported,{" "}
            <span className="font-semibold text-ink-muted">{result.total_rows - result.imported}</span> skipped of{" "}
            {result.total_rows}
          </div>
          {result.errors.length > 0 && (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-err/30 bg-err/5 p-2 text-[10px]">
              {result.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
        </PanelSection>
      )}
    </Panel>
  );
}

// ── Chat panel ───────────────────────────────────────────────
// Free-text messages interleaved with the project's system activity
// (stage transitions, finance edits, checklist changes…). Mirrors the
// ASSR notes pattern — same backend table (project_activity), one
// composer that POSTs to /api/projects/:id/notes with action="note".

// ── Collapsible "Project Details" wrapper ───────────────────
// The aside used to dump every basics/dates/venue/booth panel up-front
// which pushed the useful content (chat, checklist actions on the
// main column) far down the page. Collapsed by default; one click to
// expand when the operator actually needs to edit metadata.
