import { Fragment, createContext, useContext, useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useParams, Navigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  Calendar,
  Check,
  ChevronRight,
  CheckCircle2,
  Circle,
  Ban,
  Lock,
  Trash2,
  FileText,
  Upload as UploadIcon,
  X,
  ExternalLink,
  MessageSquare,
  Truck,
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
  UserCircle2,
  Users,
  Phone,
  ClipboardList,
  DollarSign,
  Wrench,
} from "lucide-react";
import { PageHeader } from "../components/Layout";
import { HubGrid } from "../components/HubGrid";
import { Button } from "../components/Button";
import { FilterPills } from "../components/FilterPills";
import { ProjectMaintenanceView } from "./ProjectMaintenance";
import { TabStrip } from "../components/TabStrip";
import { toCSV, downloadCSV } from "../lib/csv";
import { PnlCalendar } from "../components/PnlCalendar";
import { DataTable, type Column } from "../components/DataTable";
import { ListErrorPanel, SearchPendingPanel } from "../components/SearchProgress";
import { StatusDot } from "../components/StatusDot";
import { Pagination } from "../components/Pagination";
import { PanelSection, FieldRow } from "../components/Panel";
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
import { useAuth } from "../auth/AuthContext";
import { usePageAccess } from "../auth/PageGuard";
import { isSalesStaff, isDirectorUser, isSalesDirectorUser, canCreateEvent, canLogSalesEntry, canWriteProjectFinance } from "../auth/salesAccess";
import { readProjectAccess, projectAccessUnresolved, holdsChecklistApproval } from "../auth/projectAccess";
import { roleLabelAdmitsRole } from "../auth/roleLabelAdmits";
import { isCrewScopedUser } from "../auth/crewScope";
import { PMS_STAGE_LABEL, pmsStageVariant } from "../vendor/scm/lib/pms-status";
import { ledgerCategoryLabel } from "../vendor/scm/lib/pms-ledger-categories";
import { isReviewableTitle } from "../vendor/scm/lib/pms-reviewable-titles";
import { paymentPillOptions } from "../vendor/scm/lib/pms-project-status";
import { Forbidden } from "./Forbidden";
import { useNotifications } from "../hooks/useNotifications";
import { api, buildQuery } from "../api/client";
import { formatPhone } from "../vendor/shared/phone";
import { MediaLightbox } from "../components/MediaLightbox";
import { PrintPreviewModal, usePrintPreview } from "../components/scm-v2/PrintPreviewModal";
import { formatDate, formatDateTime, formatCurrency, cn, relativeTime, todayInAppTz } from "../lib/utils";
import { DateField } from "../vendor/scm/components/DateField";
import type {
  ProjectStage,
  ChecklistStatus,
  ProjectRow,
  SalesAttendee,
  TasklistSection,
  SectionProgress,
  TaskAttachment,
  PaymentStatus,
  StockTransfer,
  FinanceLine,
  ProjectAttachment,
  ProjectDefect,
  ProjectTrip,
  ChecklistItem,
  ActivityRow,
  EventType,
  Paginated,
} from "./projects/types";
import { composeDefaultProjectName, viewableMime, googleCalendarUrl } from "./projects/projectHelpers";
import { STATUS_OPTIONS, ProjectStatusSelect } from "./projects/projectStatus";
import { OrganizerPicker, VenuePicker } from "./projects/ProjectPickers";
import { CreateProjectPanel } from "./projects/CreateProjectPanel";
import { DateRangeFilter, MultiSelectFilter, SectionTaskBadges, ImportCsvPanel } from "./projects/ProjectsListParts";
import { ProjectsCalendarView } from "./projects/ProjectsCalendarView";
export { buildCalendarWindow, buildProjectsCalendarModel } from "./projects/calendarModel";
import { SPEC_INPUT_CLASS, QuickRentalField, SpecTextField, SpecCell, SpecValue } from "./projects/specFields";
import { LogisticsDateTimeField, GrabHelperBox, type CrewMember } from "./projects/logisticsParts";
import { type PhasePhoto, PhasePhotosSection, PhotoGroup } from "./projects/phasePhotos";
import { FinanceAttachmentsSection, SnapshotKpi, SnapshotRow } from "./projects/financeLedgerParts";
import {
  type ProfitabilityBreakdown,
  type ProfitabilityGroupBy,
  type ProfitabilityFilters,
  type ProfitabilityDrillState,
  type ProfitabilityMonthsResponse,
  type ProfitabilityProjectsResponse,
  type ProfitabilityResponse,
  type FinanceTab,
  FINANCE_TABS,
  FINANCE_TAB_HEADER,
  PROJECTS_FINANCES_TAB_KEYS,
  type FinanceProjectRow,
  type FinanceByProjectResponse,
  FINANCE_STAGE_OPTIONS,
} from "./projects/financeViewModel";

interface ProjectDetail {
  project: ProjectRow & {
    organizer: string | null;
    contractor: string | null;
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

interface ChecklistComment {
  id: number;
  item_id: number;
  kind: "note" | "submit" | "reject" | "amend" | "approve" | "upload" | "remove"; // written as RAW SQL by routes/projects.ts:4235,:4318, bypassing the typed helper; widen with the mirror in backend/src/services/projects.ts
  body: string | null;
  user_name: string | null;
  created_at: string;
}

// Same pattern as OrganizerPicker but for the booth setup/dismantle contractor.
// Picks land in projects.contractor (free text) and get recorded in
// project_contractors so the next project sees them. Also feeds the
// per-contractor share links.
function ContractorPicker({
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
  const q = useQuery<{ data: { id: number; name: string }[] }>("/api/projects/contractors",
    () => api.get("/api/projects/contractors"),
    []
  );
  const options = q.data?.data ?? [];

  async function addNew() {
    const name = await dialog.prompt({
      title: "Add contractor",
      message: "Add a new contractor to the picker. Subsequent projects will see it too.",
      placeholder: "e.g. DREAM ART (M) SDN BHD",
      required: true,
      confirmLabel: "Add",
    });
    if (!name) return;
    try {
      await api.post("/api/projects/contractors", { name });
      await q.reload();
      onChange(name);
      toast.success(`Added ${name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add");
    }
  }

  const SENTINEL_NEW = "__add_new__";

  return (
    <select
      value={value || ""}
      onChange={(e) => {
        const v = e.target.value;
        if (v === SENTINEL_NEW) {
          void addNew();
          return;
        }
        onChange(v || null);
      }}
      className={
        className ??
        "w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
      }
    >
      <option value="">— select contractor —</option>
      {/* Surface legacy values that aren't in the lookup yet */}
      {value && !options.some((o) => o.name === value) && (
        <option value={value}>{value}</option>
      )}
      {options.map((o) => (
        <option key={o.id} value={o.name}>
          {o.name}
        </option>
      ))}
      <option value={SENTINEL_NEW}>＋ Add new contractor…</option>
    </select>
  );
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

// ── Stage helpers ────────────────────────────────────────────

// Stage label + variant now come from the SHARED vendor/scm/lib/pms-status so
// desktop + mobile can't drift on the stage vocabulary.
const STAGE_LABEL: Record<string, string> = PMS_STAGE_LABEL;
const stageVariant = pmsStageVariant;

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
          {r.rental != null ? formatCurrency(r.rental) : "—"}
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
          {r.total_sales != null ? formatCurrency(r.total_sales) : "—"}
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
          {r.fin_revenue != null ? formatCurrency(r.fin_revenue) : "—"}
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
            {formatCurrency(r.fin_cogs)}
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
          {r.fin_cogs_matt_sofa != null ? formatCurrency(r.fin_cogs_matt_sofa) : "—"}
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
          {r.fin_cogs_bedframe != null ? formatCurrency(r.fin_cogs_bedframe) : "—"}
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
          {r.fin_cogs_accessories != null ? formatCurrency(r.fin_cogs_accessories) : "—"}
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
            ? formatCurrency(r.fin_revenue - r.fin_cogs)
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
            ? formatCurrency(r.fin_revenue - r.fin_total_cost)
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
            value={formatCurrency(totals.sales)}
            subtitle="Filtered total"
            tone="success"
          />
          <StatCard
            label="COGS"
            value={formatCurrency(totals.cogs)}
            subtitle="Cost of goods sold"
          />
          <StatCard
            label="Rental"
            value={formatCurrency(totals.rental)}
            subtitle="Total rent paid"
          />
          <StatCard
            label="Total cost"
            value={formatCurrency(totals.cost)}
            subtitle="All cost categories"
            tone="error"
          />
          <StatCard
            label="Net profit"
            value={formatCurrency(totals.net_profit)}
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
              value={formatCurrency(d.totals.income)}
              subtitle="Total sales + other income"
            />
            <StatCard
              label="COGS"
              value={formatCurrency(d.totals.cogs)}
              subtitle={
                cogsPctOfRevenue != null
                  ? `${cogsPctOfRevenue.toFixed(0)}% of revenue`
                  : "Cost of goods sold"
              }
              tone="error"
            />
            <StatCard
              label="Gross profit"
              value={formatCurrency(d.totals.gp)}
              subtitle={
                grossMarginPct != null
                  ? `${grossMarginPct.toFixed(1)}% gross margin`
                  : "Revenue − COGS"
              }
              tone={d.totals.gp >= 0 ? "success" : "error"}
            />
            <StatCard
              label="Cost"
              value={formatCurrency(d.totals.cost)}
              subtitle="Rental, setup, transport, commission…"
              tone="error"
            />
            <StatCard
              label="Net profit"
              value={formatCurrency(d.totals.profit)}
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
                        {formatCurrency(r.income)}
                      </td>
                      <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                        {formatCurrency(r.cogs)}
                      </td>
                      <td
                        className={cn(
                          "whitespace-nowrap px-1.5 py-1.5 text-right font-mono",
                          r.gp >= 0 ? "text-ink" : "text-err"
                        )}
                      >
                        {formatCurrency(r.gp)}
                      </td>
                      <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                        {formatCurrency(r.rental)}
                      </td>
                      <td
                        className={cn(
                          "whitespace-nowrap px-1.5 py-1.5 text-right font-mono font-bold",
                          r.profit >= 0 ? "text-synced" : "text-err"
                        )}
                      >
                        {formatCurrency(r.profit)}
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
                {formatCurrency(m.income)}
              </td>
              <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                {formatCurrency(m.cogs)}
              </td>
              <td
                className={cn(
                  "whitespace-nowrap px-1.5 py-1.5 text-right font-mono",
                  m.gp >= 0 ? "text-ink" : "text-err"
                )}
              >
                {formatCurrency(m.gp)}
              </td>
              <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
                {formatCurrency(m.rental)}
              </td>
              <td
                className={cn(
                  "whitespace-nowrap px-1.5 py-1.5 text-right font-mono font-bold",
                  m.profit >= 0 ? "text-synced" : "text-err"
                )}
              >
                {formatCurrency(m.profit)}
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
            {formatCurrency(p.income)}
          </td>
          <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
            {formatCurrency(p.cogs)}
          </td>
          <td
            className={cn(
              "whitespace-nowrap px-1.5 py-1.5 text-right font-mono",
              p.gp >= 0 ? "text-ink" : "text-err"
            )}
          >
            {formatCurrency(p.gp)}
          </td>
          <td className="whitespace-nowrap px-1.5 py-1.5 text-right font-mono text-ink-secondary">
            {formatCurrency(p.rental)}
          </td>
          <td
            className={cn(
              "whitespace-nowrap px-1.5 py-1.5 text-right font-mono font-bold",
              p.profit >= 0 ? "text-synced" : "text-err"
            )}
          >
            {formatCurrency(p.profit)}
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
                    Rev {formatCurrency(r.income)}
                    {" · "}
                    GP {formatCurrency(r.gp)}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      "font-mono text-[12px] font-bold",
                      tone === "synced" ? "text-synced" : "text-err"
                    )}
                  >
                    {formatCurrency(r.profit)}
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
          // View mode = the 5 fields the owner reads at a glance, one row.
          // Edit mode = a 4-col grid for every field.
          editing ? "lg:grid-cols-4" : "lg:grid-cols-5",
        )}
      >
        {/* Owner 2026-09-03: the resting strip shows START, END, SIZE, BOOTH and
            RENTAL and nothing else — "other details keep hidden behind edit".
            Venue, State, Organizer and Contractor were on it too, which pushed
            the numbers the owner actually checks off the row entirely.
            Booth came back 2026-09-09. Edit still reveals every field. */}
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
        {editing && (<>
        <SpecCell label="Venue *">
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
        </SpecCell>
        <SpecCell label="State">
          <SpecValue muted mono>{p.state ?? "—"}</SpecValue>
        </SpecCell>
        <SpecCell label="Organizer">
          <OrganizerPicker
            value={p.organizer}
            onChange={(v) => patch({ organizer: v })}
            className={SPEC_INPUT_CLASS}
          />
        </SpecCell>
        <SpecCell label="Contractor">
          <ContractorPicker
            value={p.contractor}
            onChange={(v) => patch({ contractor: v })}
            className={SPEC_INPUT_CLASS}
          />
        </SpecCell>
        </>)}
        {/* Size, Booth and Rental stay on the resting strip — what the owner
            checks without opening anything (owner 2026-09-03/09-09). */}
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

        <SpecCell label="Booth">
          <SpecTextField
            editing={editing}
            value={p.booth_no}
            placeholder="—"
            onChange={(v) => patch({ booth_no: v })}
          />
        </SpecCell>

        <SpecCell label="Rental · RM">
          <QuickRentalField
            projectId={p.id}
            financeLines={financeLines}
            onSaved={onFinanceChange}
            toast={toast}
          />
        </SpecCell>

        {editing && (<>
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
  roleLabel,
  onDelete,
  toast,
}: {
  attachment: TaskAttachment;
  canManage?: boolean;
  showRemark?: boolean;
  /** Title of the checklist item this file belongs to — gates the defect
   *  action timeline to Defect List rows. */
  itemTitle?: string;
  /** Role badge of the checklist item — a tick-only role may remove files from
   *  a task badged for ITS OWN function (owner 2026-09-02). */
  roleLabel?: string | null;
  onDelete: () => void;
  toast?: ReturnType<typeof useToast>;
}) {
  const defectCtx = useContext(DefectActionsCtx);
  const { can, user } = useAuth();
  // Owner 2026-09-03: "every user can delete/remove file or image from their own
  // task, both pc and mobile pms" — this REPLACES the 2026-08-05 managers-only
  // rule. Delete now follows ATTACH: the task you may put a file on is the task
  // you may take one off, which is what "their own task" means for both kinds of
  // caller — projects.write edits the row, a tick-only role is scoped to its own
  // badge. id < 0 is a merged crew photo, never removable from here.
  const mayDeleteFile =
    attachment.id > 0 &&
    (!!canManage ||
      (can("projects.checklist.tick") && roleLabelAdmitsRole(roleLabel, user?.role_name)));
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
          {mayDeleteFile && (
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
                      roleLabel={item.role_label}
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
                    2026-08-11), which since 2026-09-02 includes a tick-only role
                    on a task badged for its own function. id < 0 = merged crew
                    photo, never removable. */}
                {mayAttachRow && !readOnlyAttach && a.id > 0 && (
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
                        roleLabel={item.role_label}
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
            annotation={`${formatCurrency(rentPerSqmPerDay)}/sqm/day`}
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
