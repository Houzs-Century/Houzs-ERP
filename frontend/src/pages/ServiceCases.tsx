import { useEffect, useRef, useState, useMemo, useCallback, type ReactNode } from "react";
import { NEXT_STAGE, STAGE_FUNNEL_DESC } from "./serviceCaseStages";
import { createPortal } from "react-dom";
import { useAnchoredPanel, anchoredPanelStyle } from "../lib/anchoredPanel";
import { Link, useSearchParams, useNavigate, useParams, Navigate } from "react-router-dom";
import {
  Plus,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsUp,
  ChevronUp,
  ChevronDown,
  Minus,
  Upload,
  MessageSquare,
  Truck as TruckIcon,
  Trash2,
  Pencil,
  Star,
  Package,
  UserPlus,
  Calendar,
  CalendarDays,
  List as ListIcon,
  LayoutGrid,
  ShieldCheck,
  AlertCircle,
  ClipboardCheck,
  User,
  Clock,
  DollarSign,
  Printer,
  Download,
  X,
  Check,
  ClipboardList,
  Wrench,
  Phone,
  MapPin,
  Play,
} from "lucide-react";
import { HubGrid } from "../components/HubGrid";
import { PageHeader } from "../components/Layout";
import {
  DetailLayout,
  DetailGrid,
  DetailMain,
  DetailAside,
  HeaderButton,
} from "../components/DetailLayout";
import { Button } from "../components/Button";
import { DataTable, type Column } from "../components/DataTable";
import { UserMultiSelect, type UserOptionItem } from "../components/UserMultiSelect";
import {
  StatusDot,
  stageVariant,
  stageLabel,
  priorityColor,
  resolutionLabel,
} from "../components/StatusDot";
import { Pagination } from "../components/Pagination";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "../components/Badge";
import { Panel, PanelSection, FieldRow } from "../components/Panel";
import { InlineEdit } from "../components/InlineEdit";
import { ExpandableText } from "../components/ExpandableText";
import { StatCard } from "../components/StatCard";
import { useQuery } from "../hooks/useQuery";
import { useSearchResultTransition } from "../hooks/useServerSearch";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import {
  booleanPreference,
  enumPreference,
  pageSizePreference,
  useIdentityPreference,
} from "../hooks/useIdentityPreference";
import { readAssrListFilter, writeAssrListFilter } from "../lib/assrListFilter";

/* The four /api/assr/lookups/* lists are admin-maintained reference data, not
   transactional rows. On the 30s global staleTime they were re-fetched on every
   case open: measured on prod 2026-08-01, opening ASSR/2607-074 cost FOUR
   lookup calls at 643-670ms each, on top of the case itself.

   Safe because an edit still lands immediately, not eventually: LookupManager
   (the only writer) now invalidates this exact key after every write, and
   invalidation ignores staleTime and forces an active refetch. Without that
   half this number would be the window an admin's edit went unseen — which is
   why the two changes ship together. 5 minutes matches the reference-data
   callsites in Team.tsx. */
const LOOKUP_CACHE = { staleTime: 300_000 } as const;

/* How tall the SO typeahead lists on this page want to be when there is room
   (what the old `max-h-72` class asked for). lib/anchoredPanel shortens them
   to the room actually available on the side it opens, so the last suggestion
   is never below the bottom of the window. */
const SO_SUGGEST_MAX_H = 288;
import { useServerSort } from "../hooks/useServerSort";
import { useFocusFromUrl } from "../hooks/useFocusFromUrl";
import { useAuth } from "../auth/AuthContext";
import { isSalesStaff } from "../auth/salesAccess";
import { api, buildQuery } from "../api/client";
import { formatPhone } from "../vendor/shared/phone";
import { uploadAssrAttachment } from "../lib/assrAttachmentUpload";
import {
  UploadDropZone,
  clipboardFiles,
  acceptedUploadFiles,
  hoveredUploadZones,
  useStrayFileDropGuard,
} from "../lib/uploadDropZone";
import { loadThumbFirst } from "../lib/imagePipeline";
import { formatCurrency, formatDate, formatDateTime, cn } from "../lib/utils";
import { ServiceMetrics } from "./ServiceMetrics";
import { ServiceSettingsView } from "./ServiceSettings";
import { ServiceLeadTimePortal } from "./ServiceLeadTimePortal";
import { Forbidden } from "./Forbidden";
import { PrintPreviewModal, usePrintPreview } from "../components/scm-v2/PrintPreviewModal";
import { defaultBrandingForCompany, HOUZS_COMPANY_CODE } from "../lib/branding";
import { resolutionRoute, isStageActive, assrSubStatus, assrSubStatusAddsInfo, assrSubStatusLabel, ASSR_STAGES, ASSR_SUB_STATUSES } from "../vendor/scm/lib/assr/stages";
import { ASSR_ISSUE_CATEGORIES, ASSR_NOTE_AUDIENCES, assrNoteIsCustomerVisible, type AssrNoteAudience } from "../vendor/scm/lib/assr/case-fields";
import { ASSR_STAGE_LABEL } from "../vendor/scm/lib/assr-stage-labels";
import type {
  Paginated,
  AssrCase,
  AssrDetail,
  AssrAttachment,
  AssrStage,
  PurchaseOrder,
} from "../types";
import { fmtDate } from "../vendor/shared/format";
import { DateField } from "../vendor/scm/components/DateField";
import {
  ASSR_PRODUCT_CATEGORIES_ENDPOINT,
  categoryChipList,
  splitCategories,
  toggleCategory,
} from "../lib/assrProductCategories";

type StageFilter = "ALL" | AssrStage;

// v3.1 workflow — 8 stages since mig 0105 retired Pending Inspection
// (inspection lives inside Verification now). Labels match the
// canonical proposal vocabulary; values are the SQL enum.
const STAGE_OPTIONS: { value: StageFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "pending_review", label: "Review" },
  { value: "pending_solution", label: "Solution" },
  { value: "under_verification", label: "Verification" },
  { value: "pending_supplier_pickup", label: "Supplier Pickup / Return" },
  { value: "pending_item_ready", label: "Pending Item Ready" },
  { value: "pending_delivery_service", label: "Delivery / Service" },
  { value: "completed", label: "Completed" },
  { value: "voided", label: ASSR_STAGE_LABEL.voided },
];

const RESOLUTION_OPTIONS = [
  "replace_unit",
  "supplier_repair",
  "field_service_own",
  "field_service_supplier",
  "return_visit",
] as const;

const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"] as const;


const NCR_OPTIONS = [
  "material_defect",
  "workmanship",
  "transit_damage",
  "design",
  "installation",
  "customer_misuse",
  "other",
] as const;

// Default "next" suggestion for the in-form transition button. Skips
// (Replace Unit → no supplier pickup / item ready;
// Field-Service Own Team → no supplier pickup / item ready;
// Return Visit → no item pickup / supplier pickup / item ready) are
// honored by the service-admin manually picking the correct next
// stage from the dropdown — this map only seeds the primary button.

// ── Cases-surface view modes ──────────────────────────────────
// The Cases surface can be read three ways. "list" is the dense,
// server-paginated DataTable (the original). "board" is an SLA-urgency
// kanban — cases bucketed by how close they are to their SLA deadline.
// "calendar" plots every open case on a month grid by its SLA deadline
// (or reported date). Board + Calendar fetch all matching cases in one
// shot client-side (per_page high) since they need the whole set to
// lay out, not a page at a time.
type CaseViewMode = "list" | "board" | "calendar";

// Filters shared across all three views — built once in CasesView and
// handed to Board/Calendar so every mode honours the same stage / search
// / archived / mine / creditor scope.
type CaseFilters = {
  stage?: string;
  search?: string;
  archived_only?: number;
  exclude_stage?: string;
  assigned_to?: number;
  creditor_code?: string;
};

// Stage value → human label, sourced from the canonical STAGE_OPTIONS so
// Board/Calendar chips read the same vocabulary as the filter pills
// (StatusDot.stageLabel still maps the older 6-stage enum).
const STAGE_LABEL_BY_VALUE: Record<string, string> = Object.fromEntries(
  STAGE_OPTIONS.filter((o) => o.value !== "ALL").map((o) => [o.value, o.label])
);

function caseStageLabel(stage: string): string {
  return STAGE_LABEL_BY_VALUE[stage] ?? stageLabel(stage);
}

// SLA urgency, derived from the server-computed `hours_to_deadline`
// (negative = past deadline). One model drives the colour of both the
// Board columns and the Calendar chips so the two views read identically.
type Urgency = "overdue" | "today" | "soon" | "later" | "none";

const URGENCY_ORDER: Urgency[] = ["overdue", "today", "soon", "later", "none"];

const URGENCY_META: Record<
  Urgency,
  { label: string; hint: string; hex: string; tint: string; text: string }
> = {
  overdue: { label: "Overdue",   hint: "Past SLA deadline",       hex: "#b23b3b", tint: "rgba(178,59,59,0.12)",  text: "#8f2f2f" },
  today:   { label: "Due today", hint: "SLA deadline within 24h", hex: "#c2740f", tint: "rgba(194,116,15,0.13)", text: "#8a540b" },
  soon:    { label: "Due soon",  hint: "SLA deadline in 1–3 days", hex: "#a16a2e", tint: "rgba(161,106,46,0.12)", text: "#7c5224" },
  later:   { label: "On track",  hint: "More than 3 days of SLA", hex: "#3f6b53", tint: "rgba(63,107,83,0.12)",  text: "#2f5340" },
  none:    { label: "No SLA",    hint: "No SLA deadline set",     hex: "#6c7167", tint: "rgba(108,113,103,0.10)", text: "#585d53" },
};

function caseUrgency(c: AssrCase): Urgency {
  if (c.stage === "completed") return "later";
  const h = c.hours_to_deadline;
  if (c.deadline_at == null || h == null) return "none";
  if (h < 0) return "overdue";
  if (h < 24) return "today";
  if (h < 72) return "soon";
  return "later";
}

// "3h overdue" / "2d left" — compact countdown off hours_to_deadline.
function formatCountdown(h: number | null | undefined): string | null {
  if (h == null) return null;
  const abs = Math.abs(h);
  const txt = abs >= 48 ? `${Math.round(abs / 24)}d` : `${Math.max(1, Math.round(abs))}h`;
  return h < 0 ? `${txt} overdue` : `${txt} left`;
}

// Local YYYY-MM-DD (calendar grid keys off local days, matching formatDate).
function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Main page ─────────────────────────────────────────────────

// Shell — two tabs: the case list and the quality-metrics dashboard.
// The metrics used to live at /service-metrics as its own sidebar
// entry; it's just a report about cases so it belongs here alongside
// them rather than as a top-level module.
type ServiceView = "hub" | "cases" | "metrics" | "lead_time" | "settings";

const SERVICE_VIEWS: ServiceView[] = [
  "hub",
  "cases",
  "metrics",
  "lead_time",
  "settings",
];

// The module's admin surface — both need `service_cases.manage`.
const SERVICE_ADMIN_VIEWS: ServiceView[] = ["settings", "lead_time"];

// Per-view header config so each view gets its own dedicated title.
// (settings view owns its own PageHeader, so it's not in this map.)
const VIEW_HEADER: Record<
  Exclude<ServiceView, "settings">,
  { title: string; description: string }
> = {
  hub: {
    title: "Service",
    description: "Cases, quality metrics and service maintenance — pick a section.",
  },
  cases: {
    title: "Service Cases",
    description: "Service & Warranty Requests — Managed end-to-end.",
  },
  metrics: {
    title: "Quality Metrics",
    description: "Performance breakdown — SLA, supplier ratings, resolution times.",
  },
  lead_time: {
    title: "Lead Time Portal",
    description: "Per-stage SLA targets. Switch profile (Normal / Peak / Custom) and amend with reason.",
  },
};

// Both admin views below deny with the same sentence — one element, two call
// sites, so the wording cannot drift apart.
const SERVICE_ADMIN_DENIED = (
  <Forbidden reason="Service Maintenance is limited to people who can manage service cases. Ask an administrator if you need access." />
);

export function ServiceCases() {
  // URL-driven (`?view=…`). The sidebar's Quality Management group has
  // one entry per view, so the page itself doesn't render a tab strip
  // — view selection lives in the sidebar.
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  // Service Maintenance (settings / lead_time) is the module's ADMIN surface.
  // Sidebar.tsx gates its nav entry on `service_cases.manage`; this page had no
  // matching gate, so the hub card below offered it to everyone the /assr route
  // admits — which includes Sales via `allowSales`. The backend holds (writes
  // are all `service_cases.manage`), but its READS only need
  // `service_cases.read`, so a reader without manage got the config back at 200
  // and a raw 403 toast on every write. Gate on the same permission the nav
  // uses so both agree.
  const canManageService = can("service_cases.manage");
  const [storedView, setStoredView] = useIdentityPreference<ServiceView>(
    "assr:view",
    "cases",
    enumPreference(SERVICE_VIEWS),
  );
  const urlView = params.get("view") as ServiceView | null;
  // `assr:view` persists the last view rendered, so anyone who opened Service
  // Maintenance before it was gated has "settings" stored. Falling back to it
  // would strand them on a permanent Forbidden at a bare /assr — the effect
  // below only rewrites the store once a DIFFERENT view renders, which it never
  // would. Land them on the board instead. An EXPLICIT ?view= is left alone: if
  // they typed it, they get the plain-language denial and know why.
  const storedFallback: ServiceView =
    SERVICE_ADMIN_VIEWS.includes(storedView) && !canManageService
      ? "cases"
      : storedView;
  const view: ServiceView =
    urlView && SERVICE_VIEWS.includes(urlView) ? urlView : storedFallback;

  // Persist whatever view was rendered so a bare `/assr` lands back
  // where the user left off.
  useEffect(() => {
    if (view !== storedView) setStoredView(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Legacy `/assr?view=lead_time` URL — Lead Time Portal merged into
  // Service Maintenance as a tab. Redirect any old bookmarks to the
  // new deep-link so they don't 404.
  useEffect(() => {
    if (urlView === "lead_time") {
      navigate("/assr?view=settings&tab=lead_time", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlView]);

  /* "New Case" action lives on the Cases view's header. Nick 2026-07-09:
     the global QuickActionsFAB now offers "Create Service Case" too, so we
     auto-open the create panel when the URL carries ?new=1 (e.g. the FAB
     drops the operator here with the panel already open, no extra click). */
  const [showCreate, setShowCreate] = useState(params.get("new") === "1");

  return (
    <div>
      {view !== "settings" && (
        <PageHeader
          eyebrow="Operations · Service"
          title={VIEW_HEADER[view].title}
          description={VIEW_HEADER[view].description}
          primaryAction={
            view === "cases" ? (
              <Button
                variant="primary"
                icon={<Plus size={14} />}
                onClick={() => setShowCreate(true)}
              >
                New Case
              </Button>
            ) : undefined
          }
        />
      )}

      {view === "hub" && (
        <HubGrid
          cards={[
            { key: "cases", label: "Service Cases", description: VIEW_HEADER.cases.description, icon: ClipboardList, onClick: () => navigate("/assr?view=cases") },
            { key: "metrics", label: "Quality Metrics", description: VIEW_HEADER.metrics.description, icon: ShieldCheck, onClick: () => navigate("/assr?view=metrics") },
            ...(canManageService
              ? [{ key: "settings", label: "Service Maintenance", description: "Picker lists, SLA lead-time targets and module defaults.", icon: Wrench, onClick: () => navigate("/assr?view=settings") }]
              : []),
          ]}
        />
      )}

      {view === "cases" && (
        <CasesView showCreate={showCreate} setShowCreate={setShowCreate} />
      )}
      {view === "metrics" && <ServiceMetrics />}
      {/* lead_time redirects to ?view=settings&tab=lead_time above, but the
          redirect runs in an effect — one render lands here first, which was
          enough to fire the portal's fetch. Gated for that tick. */}
      {view === "lead_time" &&
        (canManageService ? <ServiceLeadTimePortal /> : SERVICE_ADMIN_DENIED)}
      {view === "settings" &&
        (canManageService ? <ServiceSettingsView /> : SERVICE_ADMIN_DENIED)}
    </div>
  );
}

function CasesView({
  showCreate,
  setShowCreate,
}: {
  showCreate: boolean;
  setShowCreate: (v: boolean) => void;
}) {
  const toast = useToast();
  const dialog = useDialog();
  const navigate = useNavigate();
  const { user } = useAuth();
  // Search + stage restore from a per-tab session record, so opening a case and
  // clicking Back returns to the still-filtered list (owner 2026-07-24, session
  // scope — see lib/assrListFilter.ts). The other list filters already persist
  // via useIdentityPreference; these two were the reset-on-unmount gap.
  const [stage, setStage] = useState<StageFilter>(
    () => (readAssrListFilter().stage as StageFilter) || "ALL",
  );
  const [search, setSearch] = useState(() => readAssrListFilter().search);
  // Write-through: persist the current search + stage to the per-tab record on
  // every change, so a Back into this list restores them. Cleared automatically
  // once both are empty/ALL (see writeAssrListFilter).
  useEffect(() => {
    writeAssrListFilter({ search, stage });
  }, [search, stage]);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useIdentityPreference("pp:assr", 50, pageSizePreference([10, 25, 50, 100, 200]));
  const [showArchived, setShowArchived] = useIdentityPreference("assr:showArchived", false, booleanPreference);
  const [myCases, setMyCases] = useIdentityPreference("assr:myCases", false, booleanPreference);
  // Hide completed cases from the working list — closed cases pile up
  // and ops mostly only cares about what's still open.
  const [hideCompleted, setHideCompleted] = useIdentityPreference("assr:hideCompleted", false, booleanPreference);
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());
  const { sort, sortParams, handleSortChange } = useServerSort(() => setPage(1));
  const [params, setParams] = useSearchParams();
  const creditorFilter = params.get("creditor_code");

  // View mode (list / board / calendar) is URL-backed (`?cases=`) so a
  // bookmark or shared link lands on the same layout. Defaults to the
  // dense list.
  const caseViewParam = params.get("cases");
  const caseView: CaseViewMode =
    caseViewParam === "board" || caseViewParam === "calendar"
      ? caseViewParam
      : "list";
  const setCaseView = (next: CaseViewMode) => {
    const nextParams = new URLSearchParams(params);
    if (next === "list") nextParams.delete("cases");
    else nextParams.set("cases", next);
    setParams(nextParams, { replace: true });
  };

  // ?focus=ID — Overview inbox deep-links straight to the detail page.
  useFocusFromUrl((id) => navigate(`/assr/${id}`, { replace: true }));

  // Skip the hide-completed param when the stage filter is explicitly
  // "completed" — otherwise the page would return zero rows and look
  // broken. Lets the user override the toggle by picking that stage.
  const excludeStageParam =
    hideCompleted && stage !== "completed" ? "completed" : undefined;

  // Shared filter scope handed to Board / Calendar so every view honours
  // the same stage / search / archived / mine / creditor selection.
  const caseFilters: CaseFilters = {
    stage: stage === "ALL" ? undefined : stage,
    search: search || undefined,
    archived_only: showArchived ? 1 : undefined,
    exclude_stage: excludeStageParam,
    assigned_to: myCases && user?.id ? user.id : undefined,
    creditor_code: creditorFilter || undefined,
  };

  // Manual AutoCount DO-mirror refresh (backend gates on
  // service_cases.manage; the daily cron covers routine freshness).
  const [syncingDo, setSyncingDo] = useState(false);

  const list = useQuery<Paginated<AssrCase>>("assr-list",
    (signal) =>
      api.get(
        `/api/assr${buildQuery({
          stage: stage === "ALL" ? undefined : stage,
          search,
          page,
          per_page: perPage,
          archived_only: showArchived ? 1 : undefined,
          exclude_stage: excludeStageParam,
          assigned_to: myCases && user?.id ? user.id : undefined,
          creditor_code: creditorFilter || undefined,
          ...sortParams,
        })}`,
        { signal },
      ),
    [stage, search, page, perPage, showArchived, excludeStageParam, myCases, user?.id, creditorFilter, sort?.key, sort?.dir],
    // Paginated + stage/filter-switched list: keep the current rows visible
    // while the next page/filter loads instead of flashing an empty table.
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

  // Drop selections that are no longer on screen — keeps the bulk
  // toolbar count honest when you change pages or filters.
  useEffect(() => {
    if (bulkSelected.size === 0) return;
    const visibleIds = new Set((list.data?.data ?? []).map((r) => r.id));
    let changed = false;
    const next = new Set<number>();
    for (const id of bulkSelected) {
      if (visibleIds.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setBulkSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data?.data]);

  const visibleRows = list.data?.data ?? [];
  const allSelected =
    visibleRows.length > 0 && visibleRows.every((r) => bulkSelected.has(r.id));
  const someSelected =
    !allSelected && visibleRows.some((r) => bulkSelected.has(r.id));

  function toggleAll() {
    if (allSelected) {
      const next = new Set(bulkSelected);
      for (const r of visibleRows) next.delete(r.id);
      setBulkSelected(next);
    } else {
      const next = new Set(bulkSelected);
      for (const r of visibleRows) next.add(r.id);
      setBulkSelected(next);
    }
  }

  function toggleOne(id: number) {
    const next = new Set(bulkSelected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setBulkSelected(next);
  }

  const columns: Column<AssrCase>[] = [
    {
      key: "_select",
      label: "",
      alwaysVisible: true,
      width: "32px",
      // Header select-all — checks/unchecks every row on the current
      // page; indeterminate while only some are ticked.
      renderHeader: () => (
        <span
          onClick={(e) => e.stopPropagation()}
          className="flex items-center justify-center"
        >
          <input
            type="checkbox"
            aria-label={allSelected ? "Deselect all rows" : "Select all rows"}
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={toggleAll}
            className="cursor-pointer accent-accent"
          />
        </span>
      ),
      render: (r) => (
        <div
          onClick={(e) => {
            e.stopPropagation();
            toggleOne(r.id);
          }}
          className="flex h-full items-center justify-center"
        >
          <input
            type="checkbox"
            checked={bulkSelected.has(r.id)}
            readOnly
            className="accent-accent"
          />
        </div>
      ),
    },
    {
      key: "stage",
      filterable: true,
      label: "Stage",
      render: (r) => {
        // Sub-status rides a second muted line (Nick 2026-07-15); hidden when it
        // restates its stage, except the Supplier stage's legs (Nico 2026-08-22).
        const stageText = caseStageLabel(r.stage);
        const sub = assrSubStatus(r.stage, r.sub_status ?? null);
        const subText =
          sub && (r.stage === "pending_supplier_pickup" || assrSubStatusAddsInfo(stageText, sub.label))
            ? sub.label
            : null;
        return (
          <div>
            <div className="flex items-center gap-1.5">
              {r.archived_at && (
                <Badge tone="neutral" variant="outline" className="bg-ink-muted/10">
                  Archived
                </Badge>
              )}
              {/* Funnel-consistent dot: red = SLA-breached, else the stage's own colour. */}
              <StatusDot
                variant={
                  r.stage !== "completed" && r.is_breached === 1
                    ? "error"
                    : stageVariant(r.stage)
                }
                label={stageText}
              />
              {r.stage !== "completed" && (r.is_breached === 1 || r.escalated_at) && (
                // One SLA badge: solid = breached, outline = escalated (>24h overdue).
                <Badge
                  tone="error"
                  variant={r.is_breached === 1 ? "solid" : "outline"}
                  title={
                    r.is_breached === 1
                      ? `SLA breached by ${Math.abs(r.hours_to_deadline ?? 0)}h${r.escalated_at ? " · escalated" : ""}`
                      : `Auto-escalated ${fmtDate(r.escalated_at)} — SLA overdue >24h`
                  }
                >
                  SLA
                </Badge>
              )}
            </div>
            {subText && (
              <div className="mt-0.5 pl-4 text-[10px] font-medium text-ink-muted">
                {subText}
              </div>
            )}
          </div>
        );
      },
      // caseStageLabel, plus the sub label so the column FILTER and CSV split
      // the legs (pickup vs return, inspection vs QC issue result).
      getValue: (r) => {
        const sub = assrSubStatus(r.stage, r.sub_status ?? null);
        return sub ? `${caseStageLabel(r.stage)} — ${sub.label}` : caseStageLabel(r.stage);
      },
    },
    {
      key: "assr_no",
      filterable: true,
      label: "ASSR No",
      render: (r) => (
        <span className="font-mono text-xs font-medium">
          {r.assr_no}
          {r.company_code && r.company_code !== "HOUZS" && (
            <span className="ml-1.5 rounded bg-bg px-1 py-0.5 font-sans text-[10px] font-semibold text-ink-muted">
              {r.company_code}
            </span>
          )}
        </span>
      ),
      getValue: (r) => r.assr_no,
    },
    {
      key: "complained_date",
      filterable: true,
      label: "Date",
      render: (r) => formatDate(r.complained_date),
      getValue: (r) => formatDate(r.complained_date),
    },
    {
      key: "doc_no",
      filterable: true,
      label: "SO No",
      render: (r) => <span className="font-mono text-xs">{r.doc_no}</span>,
      getValue: (r) => r.doc_no,
    },
    {
      key: "ref_no",
      filterable: true,
      label: "Ref No",
      // The SO's customer reference (HC/ZNT/PG…) — what the branches
      // and suppliers quote back, so it earns a default-visible slot
      // next to SO No.
      render: (r) => <span className="font-mono text-xs">{r.ref_no || "—"}</span>,
      getValue: (r) => r.ref_no,
    },
    {
      key: "do_numbers",
      filterable: true,
      label: "DO No",
      // Hand-entered DO on the case wins; the server merge fills the rest
      // ("DO1 · DO2" when the order shipped in parts): Houzs cases from
      // AutoCount — the SO's own transfer_to chain, widened by the
      // ref-matched DO mirror — 2990 from the SCM module. Most cases
      // never get the manual field.
      render: (r) => (
        <span className="font-mono text-xs">{r.delivery_order || r.do_numbers || "—"}</span>
      ),
      getValue: (r) => r.delivery_order || r.do_numbers,
    },
    {
      key: "po_no",
      filterable: true,
      label: "PO No",
      // The customer's purchase-order reference on the case (Nico 2026-08-14).
      render: (r) => <span className="font-mono text-xs">{r.po_no || "—"}</span>,
      getValue: (r) => r.po_no,
    },
    {
      key: "customer_name",
      filterable: true,
      label: "Customer",
      render: (r) => (
        <span
          className="block max-w-[180px] truncate"
          title={r.customer_name || undefined}
        >
          {r.customer_name || "—"}
        </span>
      ),
      getValue: (r) => r.customer_name,
    },
    {
      key: "sales_agent",
      filterable: true,
      label: "Salesperson",
      // The SO's sales agent — copied onto the case at intake from the
      // AutoCount mirror; server search matches it too.
      render: (r) => (
        <span className="block max-w-[140px] truncate" title={r.sales_agent || undefined}>
          {r.sales_agent || "—"}
        </span>
      ),
      getValue: (r) => r.sales_agent,
    },
    {
      key: "priority_dwell",
      label: "Priority · Dwell",
      align: "left",
      filterable: true,
      // Merged signal, single colour axis = DWELL so dot and text always
      // agree (no clashing two-colour cells). DWELL in the current stage:
      // On track <7d (green) / Slow 7–29d (amber) / Stuck ≥30d (red). The
      // dot carries the same tier colour as the text. PRIORITY rides along
      // as a red ring around the dot, shown only for Urgent/High.
      render: (r) => {
        const d = r.days_in_stage;
        const tier =
          d == null || r.stage === "completed"
            ? null
            : d < 7
              ? { label: "On track", text: "text-synced", dot: "bg-synced" }
              : d < 30
                ? { label: "Slow", text: "text-warning-text", dot: "bg-warning-text" }
                : { label: "Stuck", text: "text-err font-semibold", dot: "bg-err" };
        const dotColor = tier ? tier.dot : "bg-ink-muted/40";
        const isHiPri = r.priority === "urgent" || r.priority === "high";
        return (
          <div className="flex items-center gap-2">
            <span
              title={isHiPri ? `${r.priority} priority${tier ? ` · ${tier.label}` : ""}` : tier?.label || undefined}
              className="inline-flex shrink-0 items-center justify-center"
            >
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  dotColor,
                  isHiPri && "ring-2 ring-offset-1 ring-offset-surface ring-err",
                )}
              />
            </span>
            {tier ? (
              <span
                className={cn("text-[11.5px] font-medium", tier.text)}
                title={`In ${caseStageLabel(r.stage)} for ${d} day(s)`}
              >
                {tier.label} <span className="font-mono tabular-nums">{d}d</span>
              </span>
            ) : (
              <span className="text-ink-muted">—</span>
            )}
          </div>
        );
      },
      // Sort by dwell days — the actionable axis. Priority stays scannable
      // via the dot colour even when sorted by dwell.
      getValue: (r) => r.days_in_stage ?? -1,
    },
    {
      key: "assigned_to_name",
      filterable: true,
      label: "Assigned To",
      // Both responsible people, primary first ("Farra · Nancy").
      render: (r) =>
        [r.assigned_to_name, r.assigned_to_2_name].filter(Boolean).join(" · ") || "—",
      getValue: (r) =>
        [r.assigned_to_name, r.assigned_to_2_name].filter(Boolean).join(" · ") || null,
    },
    {
      key: "item_code",
      filterable: true,
      label: "Item",
      // Product code — visible on the detail page; hidden here to cut
      // clutter, still available from the Columns menu.
      defaultHidden: true,
      // Product Info items first (items_codes aggregate); the legacy
      // form-era item_code only as fallback (Nico 2026-08-07).
      render: (r) => <span className="font-mono text-[11px]">{(r as any).items_codes || r.item_code || "—"}</span>,
      getValue: (r) => (r as any).items_codes || r.item_code,
    },
    {
      key: "complaint_issue",
      // Free text — a distinct-values filter menu would be noise, so no
      // filter; the column still sorts (alphabetical) and the full text
      // rides the title tooltip. (Nico 2026-08-13)
      label: "Complaint Issue",
      render: (r) =>
        r.complaint_issue ? (
          <span className="block max-w-[280px] truncate text-[12px]" title={r.complaint_issue}>
            {r.complaint_issue}
          </span>
        ) : (
          "—"
        ),
      getValue: (r) => r.complaint_issue || null,
    },
    {
      key: "resolution_method",
      filterable: true,
      label: "Resolution",
      // Empty until a case reaches the solution stage, so it's mostly
      // "—" on the working list — hidden by default to cut clutter,
      // still available from the Columns menu.
      defaultHidden: true,
      render: (r) => (
        <span className="text-[11px] text-ink-secondary">
          {resolutionLabel(r.resolution_method)}
        </span>
      ),
      getValue: (r) => resolutionLabel(r.resolution_method),
    },
    {
      key: "supplier_pickup_at",
      filterable: true,
      label: "Supplier Pickup",
      defaultHidden: true,
      render: (r) => formatDate(r.supplier_pickup_at),
      getValue: (r) => r.supplier_pickup_at,
    },
    {
      key: "items_ready_at",
      filterable: true,
      label: "Items Ready",
      defaultHidden: true,
      render: (r) => formatDate(r.items_ready_at),
      getValue: (r) => r.items_ready_at,
    },
    // The rest of the intake snapshot (already in the list payload) —
    // hidden by default, togglable from the Columns menu (Nico 2026-07-27:
    // the list was missing case info like DO / salesperson / contact).
    {
      key: "phone",
      filterable: true,
      label: "Phone",
      defaultHidden: true,
      render: (r) => <span className="font-mono text-xs">{r.phone || "—"}</span>,
      getValue: (r) => r.phone,
    },
    {
      key: "location",
      filterable: true,
      label: "Location",
      defaultHidden: true,
      render: (r) => (
        <span className="block max-w-[160px] truncate" title={r.location || undefined}>
          {r.location || "—"}
        </span>
      ),
      getValue: (r) => r.location,
    },
    {
      key: "service_category",
      filterable: true,
      label: "Service Category",
      defaultHidden: true,
      render: (r) => r.service_category || "—",
      getValue: (r) => r.service_category,
      // Multi-select: a case can be "Bedframe, Mattress". Ticking Bedframe
      // in the funnel must surface it, so the filter sees the parts.
      getFilterValues: (r) => splitCategories(r.service_category),
    },
    {
      key: "issue_category",
      filterable: true,
      label: "Issue Category",
      defaultHidden: true,
      render: (r) => r.issue_category || "—",
      getValue: (r) => r.issue_category,
    },
    {
      key: "creditor_name",
      filterable: true,
      label: "Supplier",
      defaultHidden: true,
      render: (r) => (
        <span className="block max-w-[160px] truncate" title={r.creditor_name || undefined}>
          {r.creditor_name || "—"}
        </span>
      ),
      getValue: (r) => r.creditor_name,
    },
  ];

  return (
    <div>
      {creditorFilter && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-accent/30 bg-accent-soft/40 px-3 py-2 text-[12px]">
          <span className="font-semibold uppercase tracking-wider text-accent">
            Filter · Creditor
          </span>
          <span className="font-mono text-ink">{creditorFilter}</span>
          <button
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete("creditor_code");
              setParams(next, { replace: true });
            }}
            className="ml-auto text-ink-muted hover:text-err"
            aria-label="Clear creditor filter"
          >
            ×
          </button>
        </div>
      )}
      <StageStatStrip
        stage={stage}
        onPick={(v) => { setPage(1); setStage(v); }}
      />

      {/* data-freeze-anchor: on scroll the frozen composition starts HERE —
          the view toggle + table freeze under the page header while the KPI
          cards and stage funnel above scroll away (owner: funnel 不用 freeze,
          "我要滑动到这里freeze着"); see DataTable's frozen-header block. */}
      <div data-freeze-anchor className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        {/* View mode — List / Board / Calendar. The board and calendar
            re-read the same cases through an SLA-urgency lens; the list
            stays the dense system-of-record. */}
        <div className="inline-flex overflow-hidden rounded-md border border-border bg-bg/40">
          {([
            { v: "list" as const, label: "List", icon: ListIcon },
            { v: "board" as const, label: "Board", icon: LayoutGrid },
            { v: "calendar" as const, label: "Calendar", icon: CalendarDays },
          ]).map(({ v, label, icon: Icon }) => (
            <button
              key={v}
              type="button"
              onClick={() => setCaseView(v)}
              aria-pressed={caseView === v}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold transition-colors",
                caseView === v
                  ? "bg-primary text-white"
                  : "text-ink-muted hover:text-primary"
              )}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
        {/* Stage selection now lives in the per-stage stat cards above —
            click a card to filter, click it again to clear back to All. */}
        <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <input
            type="checkbox"
            checked={!!myCases}
            onChange={(e) => { setPage(1); setMyCases(e.target.checked); }}
            className="accent-accent"
            disabled={!user?.id}
          />
          My cases
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <input
            type="checkbox"
            checked={!!hideCompleted}
            onChange={(e) => { setPage(1); setHideCompleted(e.target.checked); }}
            className="accent-accent"
            disabled={stage === "completed"}
            title={stage === "completed" ? "Disabled while the Completed stage filter is active" : undefined}
          />
          Hide completed
        </label>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => { setPage(1); setShowArchived(e.target.checked); }}
            className="accent-accent"
          />
          Archived
        </label>
        <Button
          variant="ghost"
          icon={<Download size={14} />}
          onClick={async () => {
            try {
              await api.downloadFile(
                `/api/assr/export.csv${buildQuery({
                  stage: stage === "ALL" ? undefined : stage,
                  search,
                  archived_only: showArchived ? 1 : undefined,
                  exclude_stage: excludeStageParam,
                })}`,
                "service-cases.csv"
              );
            } catch (e: any) {
              toast.error(`Export failed: ${e?.message || e}`);
            }
          }}
        >
          Export All
        </Button>
        <Button
          variant="ghost"
          icon={<RefreshCw size={14} className={syncingDo ? "animate-spin" : undefined} />}
          disabled={syncingDo}
          title="Pull the latest Delivery Orders from AutoCount (runs nightly by itself)"
          onClick={async () => {
            setSyncingDo(true);
            try {
              const r = await api.post<{ upserted: number; fetched: number }>(
                "/api/assr/sync-delivery-orders",
                {}
              );
              toast.success(`Delivery orders refreshed — ${r.upserted} of ${r.fetched} synced`);
              list.reload();
            } catch (e: any) {
              toast.error(e?.message || "DO sync failed");
            } finally {
              setSyncingDo(false);
            }
          }}
        >
          {syncingDo ? "Syncing DO…" : "Sync DO"}
        </Button>
      </div>

      {caseView === "board" && (
        <CasesBoardView filters={caseFilters} onOpen={(id) => navigate(`/assr/${id}`)} />
      )}
      {caseView === "calendar" && (
        <CasesCalendarView filters={caseFilters} onOpen={(id) => navigate(`/assr/${id}`)} />
      )}

      {caseView === "list" && (
      <>
      {bulkSelected.size > 0 && !searchTransition.resultsAreStale && (
        <BulkActionsBar
          count={bulkSelected.size}
          allSelected={allSelected}
          someSelected={someSelected}
          onToggleAll={toggleAll}
          onClear={() => setBulkSelected(new Set())}
          showArchived={showArchived}
          onArchive={async () => {
            if (!await dialog.confirm(`Archive ${bulkSelected.size} case(s)?`)) return;
            try {
              const res = await api.post<{ ok: number; failed: any[] }>(
                "/api/assr/bulk/archive",
                { ids: Array.from(bulkSelected) }
              );
              toast.success(
                `Archived ${res.ok}` + (res.failed.length ? `, ${res.failed.length} failed` : "")
              );
              setBulkSelected(new Set());
              list.reload();
            } catch (e: any) {
              toast.error(e?.message || "Bulk archive failed");
            }
          }}
          onUnarchive={async () => {
            if (!await dialog.confirm(`Restore ${bulkSelected.size} case(s)?`)) return;
            try {
              const res = await api.post<{ ok: number; failed: any[] }>(
                "/api/assr/bulk/unarchive",
                { ids: Array.from(bulkSelected) }
              );
              toast.success(
                `Restored ${res.ok}` + (res.failed.length ? `, ${res.failed.length} failed` : "")
              );
              setBulkSelected(new Set());
              list.reload();
            } catch (e: any) {
              toast.error(e?.message || "Bulk restore failed");
            }
          }}
          onAssignToMe={
            user?.id
              ? async () => {
                  try {
                    const res = await api.post<{ ok: number; failed: any[] }>(
                      "/api/assr/bulk/assign",
                      { ids: Array.from(bulkSelected), assigned_to: user.id }
                    );
                    toast.success(
                      `Assigned ${res.ok}` + (res.failed.length ? `, ${res.failed.length} failed` : "")
                    );
                    setBulkSelected(new Set());
                    list.reload();
                  } catch (e: any) {
                    toast.error(e?.message || "Bulk assign failed");
                  }
                }
              : null
          }
        />
      )}

      <DataTable
        tableId="assr"
        udfTable="assr"
        udfTableLabel="Service Cases"
        exportName="service-cases"
        search={{
          value: search,
          onChange: (v) => { setPage(1); setSearch(v); },
          placeholder: "Search ASSR no, SO no, Ref no, customer, salesperson, phone…",
          searching: searchTransition.isSearching,
          countPending: list.loading || list.placeholder || Boolean(list.error) || searchTransition.resultsAreStale,
          scope: "server",
          totalRecords: list.data?.total,
        }}
        resetFilters={{
          active: !!(
            search ||
            stage !== "ALL" ||
            showArchived ||
            myCases ||
            hideCompleted ||
            creditorFilter
          ),
          onReset: () => {
            setSearch("");
            setStage("ALL");
            setShowArchived(false);
            setMyCases(false);
            setHideCompleted(false);
            setPage(1);
            if (creditorFilter) {
              const next = new URLSearchParams(params);
              next.delete("creditor_code");
              setParams(next, { replace: true });
            }
          },
        }}
        columns={columns}
        rows={list.data?.data ?? null}
        loading={list.loading || searchTransition.isSearching}
        error={list.error}
        emptyLabel="No service cases"
        getRowKey={(r) => r.id}
        getRowClassName={(r) => (r.archived_at ? "opacity-60" : undefined)}
        onRowClick={(r) => navigate(`/assr/${r.id}`)}
        serverSort
        onSortChange={handleSortChange}
      />

      {list.data && !searchTransition.resultsAreStale && (
        <Pagination
          page={page}
          perPage={perPage}
          total={list.data.total}
          onPageChange={setPage}
          onPerPageChange={(n) => { setPerPage(n); setPage(1); }}
        />
      )}
      </>
      )}

      {/* Create panel */}
      {showCreate && (
        <CreatePanel
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/assr/${id}`);
            list.reload();
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

// ── Cases · per-stage stat strip ──────────────────────────────
// A card per workflow stage showing how many cases sit there, with
// SLA-breach count as the sub-line (red when any are overdue). Each
// card is a drill-down: click to filter the list/board/calendar to
// that stage, click again to clear back to All. Counts come from the
// shared `/api/assr/summary` aggregate (stage_funnel = archived-excluded
// totals + breach counts); a wide window captures long-open cases.
// One-line captions under the Stage-funnel filter cards (Nick
// 2026-07-23: 每个 stage 下面加 description, e.g. Verification → QC
// issue inspection). Same wording as the detail Workflow funnel.
type StageFunnelRow = { stage: string; total: number; breached: number; sub_return?: number; sub_customer?: number };
type AssrSummary = {
  total?: number;
  active_count?: number;
  breach_count?: number;
  avg_e2e_days?: number | null;
  stage_funnel?: StageFunnelRow[];
};

function StageStatStrip({
  stage,
  onPick,
}: {
  stage: StageFilter;
  onPick: (s: StageFilter) => void;
}) {
  const { can } = useAuth();
  // OFF-NOT-HIDE: the stage-funnel strip is an ORG aggregate gated behind
  // `service_cases.read`. A non-director Sales user reaches this page (their
  // My-Cases list loads via the widened requireServiceCaseAccess route) but
  // lacks that matrix permission, so firing this would 403 → "Forbidden"
  // toast. Gate the fetch so it never fires for them; the strip just renders
  // its empty/zero state instead.
  const canReadSummary = can("service_cases.read");
  const q = useQuery<AssrSummary>("/api/assr/summary?since_days=730",
    () => api.get("/api/assr/summary?since_days=730"),
    [],
    { enabled: canReadSummary }
  );

  // The /summary aggregate runs ~13 queries and flakes with a 500 on a
  // cold Supabase pool during cutover (same transient issue as the list).
  // It's a read-only count, so silently retry a few times rather than
  // stranding the cards on "Unavailable" — the next attempt usually warms
  // the pool and succeeds.
  const retriesRef = useRef(0);
  useEffect(() => {
    if (q.data) {
      retriesRef.current = 0;
      return;
    }
    if (q.error && retriesRef.current < 4) {
      retriesRef.current += 1;
      const id = setTimeout(() => q.reload(), 700);
      return () => clearTimeout(id);
    }
  }, [q.error, q.data, q.reload]);

  const byStage = new Map<string, StageFunnelRow>(
    (q.data?.stage_funnel ?? []).map((r) => [r.stage, r])
  );
  const stages = STAGE_OPTIONS.filter((o) => o.value !== "ALL");
  const ready = !!q.data;
  const allTotal = (q.data?.stage_funnel ?? []).reduce((s, r) => s + r.total, 0);
  const openCount = q.data?.active_count ?? 0;

  const completedCount = byStage.get("completed")?.total ?? 0;
  const breachTotal = q.data?.breach_count ?? 0;
  const sub = (s: string) => (!ready ? (q.loading ? "Loading…" : "Unavailable") : s);

  return (
    <div className="mb-4 space-y-3">
      {/* Summary KPIs — Open / SLA Risk / Avg Resolution / Completed. */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard
          label="Open Cases"
          value={ready ? openCount.toLocaleString() : "—"}
          subtitle={sub(`${allTotal.toLocaleString()} total`)}
          rail="bg-primary"
        />
        <StatCard
          label="SLA Risk"
          value={ready ? breachTotal.toLocaleString() : "—"}
          subtitle={sub(breachTotal > 0 ? "needs attention" : "on track")}
          tone={ready && breachTotal > 0 ? "error" : "default"}
          rail={ready && breachTotal > 0 ? "bg-err" : "bg-border-strong"}
        />
        <StatCard
          label="Avg Resolution"
          value={ready && q.data?.avg_e2e_days != null ? `${q.data.avg_e2e_days}d` : "—"}
          subtitle={sub("end-to-end")}
          rail="bg-accent-bright"
        />
        <StatCard
          label="Completed"
          value={ready ? completedCount.toLocaleString() : "—"}
          subtitle={sub("closed cases")}
          rail="bg-synced"
        />
      </div>

      {/* Stage funnel — click a stage to filter; click again (or All) to clear. */}
      <div className="rounded-xl border border-border bg-surface p-4 shadow-stone">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[13px] font-bold text-ink">Stage funnel</div>
          <span className="font-mono text-[10px] text-ink-muted">click to filter</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {[
            { value: "ALL" as StageFilter, label: "All", desc: "All stages", total: allTotal, breached: 0 },
            ...stages.map((s) => {
              const row = byStage.get(s.value);
              // Supplier bucket names its three legs (Nico 2026-08-22 / 09-01):
              // one chase count per leg — customer / supplier / return.
              const cust = row?.sub_customer ?? 0;
              const ret = row?.sub_return ?? 0;
              const desc =
                s.value === "pending_supplier_pickup" && ready && row?.total
                  ? `${cust} customer · ${row.total - cust - ret} supplier · ${ret} return`
                  : STAGE_FUNNEL_DESC[s.value] ?? "";
              return {
                value: s.value as StageFilter,
                label: s.label,
                desc,
                total: row?.total ?? 0,
                breached: row?.breached ?? 0,
              };
            }),
          ].map((s) => {
            const isActive = stage === s.value;
            const empty = ready && s.total === 0;
            // Dot: red = holds breached cases, dim grey = empty, green = All,
            // solid grey = Completed split off All (Nico 2026-07-09), petrol = open.
            const dot =
              s.breached > 0
                ? "bg-err"
                : empty
                  ? "bg-ink-muted/40"
                  : s.value === "completed"
                    ? "bg-ink-muted"
                    : s.value === "ALL"
                      ? "bg-synced"
                      : "bg-primary";
            return (
              <button
                key={s.value}
                onClick={() => onPick(isActive ? "ALL" : s.value)}
                className={cn(
                  "rounded-lg border px-3.5 py-2.5 text-left transition-colors",
                  isActive
                    ? "border-primary bg-primary-soft"
                    : "border-border bg-surface-2 hover:border-primary/40",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "font-mono text-[13px] font-bold leading-none",
                      isActive ? "text-primary" : empty ? "text-ink-muted/60" : "text-ink",
                    )}
                  >
                    {ready ? s.total : "—"}
                  </span>
                  <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
                </span>
                <span
                  className={cn(
                    "mt-1 block text-[12px] font-semibold leading-tight",
                    empty && !isActive ? "text-ink-muted" : "text-ink",
                  )}
                >
                  {s.label}
                </span>
                {s.desc && (
                  <span className="mt-0.5 block text-[10px] leading-tight text-ink-muted">
                    {s.desc}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Cases · SLA Board ─────────────────────────────────────────
// Kanban-by-urgency. Every open case is dropped into one of five
// columns by how close it is to its SLA deadline. Ops triage reads
// left-to-right: clear the red column first.

function CasesBoardView({
  filters,
  onOpen,
}: {
  filters: CaseFilters;
  onOpen: (id: number) => void;
}) {
  // Forward-looking triage board — completed cases carry no live SLA, so
  // drop them unless the user is explicitly filtering to that stage. This
  // also spends the 200-row server budget on open work, not closed noise.
  const effective: CaseFilters = {
    ...filters,
    exclude_stage: filters.stage === "completed" ? filters.exclude_stage : "completed",
  };
  const q = useQuery<Paginated<AssrCase>>("assr-list-export",
    () => api.get(`/api/assr${buildQuery({ ...effective, page: 1, per_page: 500 })}`),
    [
      effective.stage,
      effective.search,
      effective.archived_only,
      effective.exclude_stage,
      effective.assigned_to,
      effective.creditor_code,
    ]
  );
  const cases = q.data?.data ?? [];
  const total = q.data?.total ?? cases.length;

  const buckets = useMemo(() => {
    const b: Record<Urgency, AssrCase[]> = {
      overdue: [],
      today: [],
      soon: [],
      later: [],
      none: [],
    };
    for (const c of cases) b[caseUrgency(c)].push(c);
    for (const k of URGENCY_ORDER) {
      b[k].sort(
        (a, z) =>
          (a.hours_to_deadline ?? Number.POSITIVE_INFINITY) -
          (z.hours_to_deadline ?? Number.POSITIVE_INFINITY)
      );
    }
    return b;
  }, [cases]);

  if (q.loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {URGENCY_ORDER.map((u) => (
          <div
            key={u}
            className="h-64 animate-pulse rounded-lg border border-border bg-surface-dim/40"
          />
        ))}
      </div>
    );
  }
  if (q.error) {
    return (
      <EmptyState
        message="Couldn't load cases"
        description={q.error}
        icon={<LayoutGrid size={24} />}
      />
    );
  }
  if (cases.length === 0) {
    return (
      <EmptyState
        message="No open cases"
        description="Nothing matches the current filters."
        icon={<LayoutGrid size={24} />}
      />
    );
  }

  return (
    <div>
      {total > cases.length && (
        <p className="mb-2 text-[11px] text-ink-muted">
          Showing the first {cases.length} of {total} cases — narrow the
          filters to see the rest.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {URGENCY_ORDER.map((u) => {
          const meta = URGENCY_META[u];
          const items = buckets[u];
          return (
            <div
              key={u}
              className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface-dim/40"
            >
              <div
                className="flex items-center gap-2 border-b border-border px-3 py-2"
                style={{ borderTop: `2px solid ${meta.hex}` }}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: meta.hex }}
                />
                <span
                  className="text-[11px] font-semibold uppercase tracking-wider"
                  style={{ color: meta.text }}
                  title={meta.hint}
                >
                  {meta.label}
                </span>
                <span className="ml-auto font-mono text-[11px] font-bold text-ink-muted">
                  {items.length}
                </span>
              </div>
              <div className="flex-1 space-y-2 p-2">
                {items.length === 0 ? (
                  <p className="px-1 py-4 text-center text-[11px] text-ink-muted/70">
                    Nothing here
                  </p>
                ) : (
                  items.map((c) => (
                    <CaseCard key={c.id} c={c} onOpen={onOpen} />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Compact case card — shared by the Board columns and the Calendar
// day-modal. Left rail + countdown colour encode SLA urgency.
function CaseCard({ c, onOpen }: { c: AssrCase; onOpen: (id: number) => void }) {
  const u = caseUrgency(c);
  const meta = URGENCY_META[u];
  const countdown = formatCountdown(c.hours_to_deadline);
  return (
    <button
      type="button"
      onClick={() => onOpen(c.id)}
      style={{ borderLeftColor: meta.hex }}
      className="block w-full rounded-md border border-border border-l-[3px] bg-surface px-3 py-2.5 text-left shadow-stone transition hover:-translate-y-px hover:border-accent/40 hover:shadow-md"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <span className="whitespace-nowrap font-mono text-[11px] font-semibold text-ink">
          {c.assr_no}
        </span>
        {countdown && c.stage !== "completed" && (
          <span
            className="shrink-0 whitespace-nowrap text-[10px] font-semibold"
            style={{ color: meta.text }}
          >
            {countdown}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-[12px] font-medium text-ink">
        {c.customer_name || "—"}
      </div>
      {c.item_code && (
        <div className="truncate font-mono text-[10px] text-ink-muted">
          {c.item_code}
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", priorityColor(c.priority))} />
        <span className="truncate text-[10px] text-ink-secondary">
          {caseStageLabel(c.stage)}
        </span>
        {c.assigned_to_name && (
          <span className="ml-auto truncate text-[10px] text-ink-muted">
            {c.assigned_to_name}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Cases · Calendar ──────────────────────────────────────────
// Month grid plotting every open case on its SLA deadline (or the
// reported date). Chips are coloured by SLA urgency; hover reveals the
// case basics, "+N more" opens a day list. Mirrors the Projects
// calendar's visual language (blank adjacent cells, prominent today,
// wheel-to-navigate).

function CasesCalendarView({
  filters,
  onOpen,
}: {
  filters: CaseFilters;
  onOpen: (id: number) => void;
}) {
  const [params, setParams] = useSearchParams();
  // Reported date is the default basis: nearly every case has a
  // complained_date, whereas SLA deadlines are sparsely set — so the
  // calendar lands populated rather than mostly empty.
  const basis: "deadline" | "reported" =
    params.get("cbasis") === "deadline" ? "deadline" : "reported";

  function patch(next: Record<string, string>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === "") p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  }

  const monthStr = params.get("cmonth") || "";
  const anchor = useMemo(() => {
    if (/^\d{4}-\d{2}$/.test(monthStr)) {
      return new Date(Number(monthStr.slice(0, 4)), Number(monthStr.slice(5, 7)) - 1, 1);
    }
    const d = new Date();
    d.setDate(1);
    return d;
  }, [monthStr]);

  const setAnchor = (d: Date) =>
    patch({ cmonth: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` });

  // Like the board, the calendar is about live work — hide completed
  // cases unless that stage is explicitly selected.
  const effective: CaseFilters = {
    ...filters,
    exclude_stage: filters.stage === "completed" ? filters.exclude_stage : "completed",
  };

  // Bound the fetch to the visible 6×7 month grid (Mon-first, 42 cells)
  // instead of fetch-all: pass its span as from/to on the same date column
  // the grid buckets by (reported → complained_date, deadline → deadline_at).
  // The window covers the adjacent-month days that spill into the grid, so
  // no rendered cell is ever under-populated. Recomputing these from `anchor`
  // + `basis` (and listing them in the query deps) refetches on month nav.
  const gridFirst = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridLead = (gridFirst.getDay() + 6) % 7;
  const winStart = new Date(gridFirst);
  winStart.setDate(gridFirst.getDate() - gridLead);
  const winEnd = new Date(winStart);
  winEnd.setDate(winStart.getDate() + 41);
  const fromISO = isoLocal(winStart);
  const toISO = isoLocal(winEnd);
  const dateField = basis === "deadline" ? "deadline" : "reported";

  const q = useQuery<Paginated<AssrCase>>("assr-list-date-range",
    () =>
      api.get(
        `/api/assr${buildQuery({
          ...effective,
          from: fromISO,
          to: toISO,
          date_field: dateField,
          page: 1,
          per_page: 500,
        })}`
      ),
    [
      effective.stage,
      effective.search,
      effective.archived_only,
      effective.exclude_stage,
      effective.assigned_to,
      effective.creditor_code,
      fromISO,
      toISO,
      dateField,
    ]
  );
  const cases = q.data?.data ?? [];
  const total = q.data?.total ?? cases.length;

  // Group by the active date basis (local day key).
  const byDate = useMemo(() => {
    const m = new Map<string, AssrCase[]>();
    for (const c of cases) {
      const raw =
        basis === "reported" ? c.complained_date : c.deadline_at || c.complained_date;
      if (!raw) continue;
      const key = raw.slice(0, 10);
      const arr = m.get(key);
      if (arr) arr.push(c);
      else m.set(key, [c]);
    }
    // Sort each day by urgency then countdown so the worst sits on top.
    for (const arr of m.values()) {
      arr.sort(
        (a, z) =>
          URGENCY_ORDER.indexOf(caseUrgency(a)) - URGENCY_ORDER.indexOf(caseUrgency(z)) ||
          (a.hours_to_deadline ?? Number.POSITIVE_INFINITY) -
            (z.hours_to_deadline ?? Number.POSITIVE_INFINITY)
      );
    }
    return m;
  }, [cases, basis]);

  // 6×7 month grid, Monday-first, starting on the Monday on/before the 1st.
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startOffset);
  const cells: { date: Date; iso: string; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push({ date: d, iso: isoLocal(d), inMonth: d.getMonth() === anchor.getMonth() });
  }
  const today = isoLocal(new Date());
  const monthLabel = anchor.toLocaleDateString("en-GB", { month: "2-digit", year: "numeric" });

  // Wheel over the grid steps months (throttled, non-passive).
  const gridRef = useRef<HTMLDivElement>(null);
  const wheelTsRef = useRef(0);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const setAnchorRef = useRef(setAnchor);
  setAnchorRef.current = setAnchor;
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
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
  }, []);

  const [hover, setHover] = useState<{ c: AssrCase; x: number; y: number } | null>(null);
  const [dayModal, setDayModal] = useState<string | null>(null);

  const MAX_CHIPS = 3;
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const d = new Date(anchor);
              d.setMonth(d.getMonth() - 1);
              setAnchor(d);
            }}
            className="rounded-md border border-border bg-surface p-1.5 text-ink-muted transition hover:border-accent/40 hover:text-accent"
            aria-label="Previous month"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            onClick={() => {
              const d = new Date(anchor);
              d.setMonth(d.getMonth() + 1);
              setAnchor(d);
            }}
            className="rounded-md border border-border bg-surface p-1.5 text-ink-muted transition hover:border-accent/40 hover:text-accent"
            aria-label="Next month"
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <h2 className="font-display text-lg font-semibold text-ink">{monthLabel}</h2>
        <button
          type="button"
          onClick={() => {
            const d = new Date();
            d.setDate(1);
            setAnchor(d);
          }}
          className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary transition hover:border-accent/40 hover:text-accent"
        >
          Today
        </button>

        {/* Date basis */}
        <div className="ml-auto inline-flex overflow-hidden rounded-md border border-border bg-bg/40 text-[10.5px] font-semibold">
          {([
            { v: "reported", label: "Reported date" },
            { v: "deadline", label: "SLA deadline" },
          ] as const).map(({ v, label }) => (
            <button
              key={v}
              type="button"
              onClick={() => patch({ cbasis: v === "reported" ? "" : v })}
              aria-pressed={basis === v}
              className={cn(
                "px-2.5 py-1.5 transition-colors",
                basis === v ? "bg-accent text-white" : "text-ink-muted hover:text-accent"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {URGENCY_ORDER.map((u) => (
          <span key={u} className="inline-flex items-center gap-1.5 text-[10.5px] text-ink-secondary">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: URGENCY_META[u].hex }} />
            {URGENCY_META[u].label}
          </span>
        ))}
        <span className="ml-auto text-[10.5px] text-ink-muted">Scroll to change month</span>
      </div>

      {q.error ? (
        <EmptyState message="Couldn't load cases" description={q.error} icon={<CalendarDays size={24} />} />
      ) : (
        <>
          {total > cases.length && (
            <p className="mb-2 text-[11px] text-ink-muted">
              Showing the first {cases.length} of {total} cases — narrow the filters to see the rest.
            </p>
          )}
          <div
            ref={gridRef}
            className={cn(
              "overflow-hidden rounded-lg border border-border bg-surface",
              q.loading && "animate-pulse opacity-60"
            )}
          >
            {/* Weekday header */}
            <div className="grid grid-cols-7 border-b border-border bg-surface-dim/60">
              {WEEKDAYS.map((d) => (
                <div
                  key={d}
                  className="px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
                >
                  {d}
                </div>
              ))}
            </div>
            {/* Cells */}
            <div className="grid grid-cols-7">
              {cells.map((cell, i) => {
                const items = byDate.get(cell.iso) ?? [];
                const isToday = cell.iso === today;
                return (
                  <div
                    key={cell.iso}
                    className={cn(
                      "min-h-[104px] border-b border-r border-border/70 p-1.5",
                      i % 7 === 6 && "border-r-0",
                      i >= 35 && "border-b-0",
                      !cell.inMonth && "bg-surface-dim/40"
                    )}
                  >
                    {cell.inMonth && (
                      <>
                        <div className="mb-1 flex items-center justify-between">
                          <span
                            className={cn(
                              "inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-[11px] font-semibold",
                              isToday
                                ? "bg-accent text-white"
                                : "text-ink-secondary"
                            )}
                          >
                            {cell.date.getDate()}
                          </span>
                          {items.length > 0 && (
                            <span className="font-mono text-[9px] text-ink-muted">
                              {items.length}
                            </span>
                          )}
                        </div>
                        <div className="space-y-1">
                          {items.slice(0, MAX_CHIPS).map((c) => {
                            const meta = URGENCY_META[caseUrgency(c)];
                            return (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => onOpen(c.id)}
                                onMouseEnter={(e) =>
                                  setHover({ c, x: e.clientX, y: e.clientY })
                                }
                                onMouseMove={(e) =>
                                  setHover({ c, x: e.clientX, y: e.clientY })
                                }
                                onMouseLeave={() => setHover(null)}
                                style={{ background: meta.tint, borderLeft: `3px solid ${meta.hex}` }}
                                className="block w-full truncate rounded-[4px] px-1.5 py-1 text-left text-[10.5px] font-medium leading-tight text-ink transition hover:-translate-y-px"
                                title={`${c.assr_no} · ${c.customer_name || ""}`}
                              >
                                <span className="font-mono text-[9.5px] text-ink-muted">
                                  {c.assr_no}
                                </span>{" "}
                                {c.customer_name || "—"}
                              </button>
                            );
                          })}
                          {items.length > MAX_CHIPS && (
                            <button
                              type="button"
                              onClick={() => setDayModal(cell.iso)}
                              className="w-full rounded-[4px] px-1.5 py-0.5 text-left text-[10px] font-semibold text-accent hover:bg-accent-soft/40"
                            >
                              +{items.length - MAX_CHIPS} more
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {hover && <CaseChipPopover info={hover} basis={basis} />}

      {dayModal && (
        <CaseDayModal
          iso={dayModal}
          cases={byDate.get(dayModal) ?? []}
          basis={basis}
          onClose={() => setDayModal(null)}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}

// Cursor-anchored hover card for a calendar chip.
function CaseChipPopover({
  info,
  basis,
}: {
  info: { c: AssrCase; x: number; y: number };
  basis: "deadline" | "reported";
}) {
  const { c, x, y } = info;
  const meta = URGENCY_META[caseUrgency(c)];
  const countdown = formatCountdown(c.hours_to_deadline);
  const left = Math.min(x + 14, window.innerWidth - 272);
  const top = Math.min(y + 14, window.innerHeight - 220);
  return createPortal(
    <div
      className="pointer-events-none fixed z-[70] w-64 rounded-lg border border-border bg-surface p-3 shadow-xl"
      style={{ left, top }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[12px] font-semibold text-ink">{c.assr_no}</span>
        <span
          className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
          style={{ background: meta.tint, color: meta.text }}
        >
          {c.stage === "completed" ? "Completed" : meta.label}
        </span>
      </div>
      <div className="mt-1.5 text-[13px] font-semibold text-ink">
        {c.customer_name || "—"}
      </div>
      <div className="mt-2 space-y-1 text-[11px] text-ink-secondary">
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">Stage</span>
          <span className="text-right">{caseStageLabel(c.stage)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">Priority</span>
          <span className="capitalize">{c.priority}</span>
        </div>
        {c.item_code && (
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Item</span>
            <span className="font-mono text-right">{c.item_code}</span>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <span className="text-ink-muted">
            {basis === "reported" ? "Reported" : "SLA due"}
          </span>
          <span className="text-right">
            {formatDate(basis === "reported" ? c.complained_date : c.deadline_at)}
            {countdown && c.stage !== "completed" && basis === "deadline" && (
              <span className="ml-1" style={{ color: meta.text }}>
                ({countdown})
              </span>
            )}
          </span>
        </div>
        {c.assigned_to_name && (
          <div className="flex justify-between gap-2">
            <span className="text-ink-muted">Assigned</span>
            <span className="text-right">{c.assigned_to_name}</span>
          </div>
        )}
      </div>
      {c.complaint_issue && (
        <p className="mt-2 line-clamp-3 border-t border-border pt-2 text-[11px] text-ink-secondary">
          {c.complaint_issue}
        </p>
      )}
    </div>,
    document.body
  );
}

// Day overflow modal — every case landing on one day, as cards.
function CaseDayModal({
  iso,
  cases,
  basis,
  onClose,
  onOpen,
}: {
  iso: string;
  cases: AssrCase[];
  basis: "deadline" | "reported";
  onClose: () => void;
  onOpen: (id: number) => void;
}) {
  const label = `${new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long" })} ${fmtDate(iso)}`;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-ink/30 p-4 backdrop-blur-sm sm:p-10"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              {basis === "reported" ? "Reported" : "SLA due"} · {cases.length} case
              {cases.length === 1 ? "" : "s"}
            </div>
            <h3 className="font-display text-sm font-semibold text-ink">{label}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-ink-muted transition hover:bg-surface-dim hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto p-3">
          {cases.map((c) => (
            <CaseCard
              key={c.id}
              c={c}
              onOpen={(id) => {
                onClose();
                onOpen(id);
              }}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Bulk actions toolbar ─────────────────────────────────────
// Sits above the table when one or more rows are checked. Mirrors
// the staff actions from the detail panel — archive/restore are the
// safest bulk ops; assign-to-me is a one-click triage shortcut.

function BulkActionsBar({
  count,
  allSelected,
  someSelected,
  onToggleAll,
  onClear,
  showArchived,
  onArchive,
  onUnarchive,
  onAssignToMe,
}: {
  count: number;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  showArchived: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
  onAssignToMe: (() => void) | null;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-accent/30 bg-accent-soft/30 px-3 py-2 text-[12px]">
      <label className="inline-flex items-center gap-1.5 font-semibold text-ink">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = someSelected;
          }}
          onChange={onToggleAll}
          className="accent-accent"
        />
        {count} selected
      </label>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {onAssignToMe && (
          <button
            onClick={onAssignToMe}
            className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink hover:border-accent/40"
          >
            Assign to me
          </button>
        )}
        {showArchived ? (
          <button
            onClick={onUnarchive}
            className="rounded-md border border-synced/40 bg-synced/5 px-2.5 py-1 text-[11px] font-semibold text-synced hover:bg-synced/10"
          >
            Restore
          </button>
        ) : (
          <button
            onClick={onArchive}
            className="rounded-md border border-err/40 bg-surface px-2.5 py-1 text-[11px] font-semibold text-err hover:bg-err/5"
          >
            Archive
          </button>
        )}
        <button
          onClick={onClear}
          className="rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:text-ink"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// ── Create Panel ──────────────────────────────────────────────

// ── SO-No editor with the create-form's SO search (Nick 2026-07-14:
// "edit SO 的时候需要和 create case 的 search 功能一样"). Debounced
// typeahead against /search-so (the local SO mirror); picking a hit
// saves it — the backend then re-matches customer info. Typing a value
// the mirror doesn't know (post-disconnect SOs) still saves on blur.
// ── "Pull from AutoCount" affordance ──────────────────────────
// The service-case SO search reads ONLY the local `sales_orders` mirror,
// which the incremental AutoCount pull (getSince) can miss — a valid SO can
// simply be absent (sync-gap docs; see backend POST /assr/resync-so). When a
// search yields no hit but the typed value looks like a full SO doc number,
// this offers a one-click backfill: pull that doc on demand (getSingle →
// upsert) and hand the resolved doc_no back so the caller selects it and
// triggers the customer re-match. Only renders for the SO-doc shape so partial
// / name queries (which getSingle can't resolve) never show it.
const SO_DOC_RE = /^SO-\d{4,6}$/i;

function PullFromAutoCount({
  query,
  onPulled,
}: {
  query: string;
  onPulled: (docNo: string) => void | Promise<void>;
}) {
  const doc = query.trim().toUpperCase();
  const [state, setState] = useState<"idle" | "pulling" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);
  if (!SO_DOC_RE.test(doc)) return null;

  async function pull() {
    setState("pulling");
    setMsg(null);
    try {
      const res = await api.post<{ ok: boolean; region: string; mirrored: { doc_no: string } | null }>(
        `/api/assr/resync-so/${encodeURIComponent(doc)}`
      );
      await onPulled(res.mirrored?.doc_no || doc);
      setState("idle");
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      setMsg(
        status === 404
          ? `${doc} isn't in AutoCount.`
          : status === 422
            ? `${doc} isn't a West/East-Malaysia/SG sales order.`
            : status === 503
              ? "AutoCount sync is currently off — try again later."
              : "Couldn't reach AutoCount — try again."
      );
      setState("error");
    }
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] text-ink-muted">Not in the SO list yet.</span>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={pull}
          disabled={state === "pulling"}
          className={cn(
            "inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1",
            "text-[10.5px] font-medium text-ink transition-colors hover:bg-accent-soft/20 disabled:opacity-60"
          )}
        >
          {state === "pulling" ? (
            <RefreshCw size={11} className="animate-spin" />
          ) : (
            <Download size={11} />
          )}
          {state === "pulling" ? "Pulling…" : `Pull ${doc} from AutoCount`}
        </button>
      </div>
      {msg && <span className="text-[10.5px] text-err">{msg}</span>}
    </div>
  );
}

function SoNoSearchEdit({
  value,
  onSave,
}: {
  value: string | null | undefined;
  onSave: (v: string | null) => Promise<void> | void;
}) {
  const current = value == null ? "" : String(value);
  const [draft, setDraft] = useState(current);
  const [status, setStatus] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [suggestions, setSuggestions] = useState<
    { doc_no: string; ref: string | null; debtor_name: string | null; phone: string | null; doc_date: string | null }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Debounced mirror search — same endpoint + cadence as CreatePanel.
  useEffect(() => {
    const q = draft.trim();
    if (q.length < 2 || q === current) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await api.get<{ results: typeof suggestions }>(
          `/api/assr/search-so?q=${encodeURIComponent(q)}`
        );
        setSuggestions(res.results);
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, current]);

  /* Track the input rect so the portaled dropdown follows it — shared
     geometry (lib/anchoredPanel), so the list flips above the field when the
     room below cannot hold it and is never taller than the space it is in. */
  const rect = useAnchoredPanel(inputRef, suggestions.length > 0, SO_SUGGEST_MAX_H);

  async function commit(next: string) {
    setSuggestions([]);
    if (next === current) return;
    setStatus("saving");
    try {
      await onSave(next || null);
      setStatus("ok");
      setTimeout(() => setStatus("idle"), 1500);
    } catch {
      setStatus("error");
    }
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          SO No
        </label>
        {status === "saving" && (
          <span className="text-[9px] font-medium uppercase tracking-wider text-accent">saving…</span>
        )}
        {status === "ok" && <Check size={12} className="text-synced" />}
        {status === "error" && <X size={12} className="text-err" />}
      </div>
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit(draft.trim())}
        onBlur={() => commit(draft.trim())}
        placeholder="SO #, reference, or customer name…"
        className={cn(
          "w-full rounded-md border bg-surface px-3 py-2 font-mono text-[13px] text-ink outline-none transition-colors",
          "focus:border-primary focus:ring-2 focus:ring-primary/20",
          status === "error" ? "border-err" : "border-border"
        )}
      />
      <div className="mt-1 text-[10.5px] text-ink-muted">
        {searching
          ? "Searching…"
          : "Pick a result to re-match customer info from the SO."}
      </div>
      {!searching &&
        draft.trim().length >= 2 &&
        draft.trim() !== current &&
        suggestions.length === 0 && (
          <PullFromAutoCount
            query={draft}
            onPulled={(d) => {
              setDraft(d);
              return commit(d);
            }}
          />
        )}
      {rect &&
        createPortal(
          <div
            /* The SO list needs a readable minimum even under a narrow field,
               so the width floor overrides the anchor's own width. zIndex
               stays this page's 60. */
            style={{ ...anchoredPanelStyle(rect), width: Math.max(rect.width, 320), zIndex: 60 }}
            className="overflow-auto rounded-md border border-border bg-surface shadow-lg"
          >
            {suggestions.map((s) => (
              <button
                key={s.doc_no}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDraft(s.doc_no);
                  commit(s.doc_no);
                }}
                className="flex w-full flex-col gap-0.5 border-b border-border/60 px-3 py-2 text-left text-[12px] last:border-b-0 hover:bg-accent-soft/20"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-ink">{s.doc_no}</span>
                  {s.ref && (
                    <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
                      ref: {s.ref}
                    </span>
                  )}
                  {s.doc_date && <span className="ml-auto text-[10px] text-ink-muted">{s.doc_date}</span>}
                </div>
                {(s.debtor_name || s.phone) && (
                  <div className="text-[11px] text-ink-secondary">
                    {s.debtor_name ?? ""}
                    {s.debtor_name && s.phone ? " · " : ""}
                    {formatPhone(s.phone)}
                  </div>
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}

/* Product Category is multi-select since 2026-08 — a complaint can be
   mattress AND bedframe on the same case. Chips rather than <select
   multiple>: the list is five items and ctrl-click-to-multi-select is
   undiscoverable. Values the lookup doesn't know (legacy free text) render
   as chips too, so reopening a case never silently drops one. */
function CategoryChips({
  options,
  value,
  onChange,
  disabled,
}: {
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  /* Which chips exist, and what a toggle produces, come from the SHARED rule
     the phone reads too (lib/assrProductCategories.ts). Only the markup below
     is desktop's. Re-deriving either here is how the phone ended up writing
     free text into this column. */
  return (
    <div className="flex flex-wrap gap-1.5">
      {categoryChipList(options, value).map((n) => {
        const on = value.includes(n);
        return (
          <button
            key={n}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(toggleCategory(value, n))}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              on
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-surface text-ink-muted hover:border-primary/40 hover:text-ink"
            }`}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

function CreatePanel({
  onClose,
  onCreated,
  toast,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
  toast: ReturnType<typeof useToast>;
}) {
  const { can } = useAuth();
  const [docNo, setDocNo] = useState("");
  // Typeahead state: search local SO mirror by partial DocNo /
  // reference / customer name so staff don't have to remember the
  // full SO number. `pickedDocNo` is the DocNo last chosen from a
  // suggestion — used to suppress the dropdown once a selection is
  // committed (re-typing reopens it).
  const [soSuggestions, setSoSuggestions] = useState<
    { doc_no: string; ref: string | null; debtor_name: string | null; phone: string | null; doc_date: string | null; sales_agent: string | null; company_code?: string | null; case_count?: number; open_case_count?: number }[]
  >([]);
  // Existing-case duplicate warning (owner 2026-07-27: duplicates keep
  // getting raised because intake can't see an SO's earlier cases).
  // Fetched whenever an SO is picked or looked up; tagged with the
  // doc_no it answers so a stale response never labels a different SO.
  const [existingCases, setExistingCases] = useState<{
    docNo: string;
    cases: {
      id: number; assr_no: string; doc_no: string; stage: string | null;
      status: string | null; complaint_issue: string | null;
      complained_date: string | null; created_at: string | null;
      item_code: string | null; created_by_name: string | null;
    }[];
  } | null>(null);
  const [pickedDocNo, setPickedDocNo] = useState<string | null>(null);
  const [searchingSO, setSearchingSO] = useState(false);
  // The dropdown is rendered through a portal because PanelSection
  // wraps its body in `overflow-hidden` (Panel.tsx:193), which would
  // otherwise clip suggestions extending below the section. Track the
  // input's viewport rect and re-render dropdown in fixed coordinates.
  const soInputRef = useRef<HTMLInputElement | null>(null);
  const [lookupItems, setLookupItems] = useState<{ item_code: string; item_description: string | null; qty?: number }[] | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  // Per-item affected quantity (owner 2026-07: multiselect + per-product
  // qty). Seeded from the SO line qty when an item is ticked; editable via
  // the Qty input on each selected row. Backend create already stores a
  // qty per assr_items row, so this is frontend-only.
  const [itemQty, setItemQty] = useState<Record<string, number>>({});
  const [issue, setIssue] = useState("");
  // "" → unset; OTHER_SENTINEL → user picked Other but hasn't typed yet;
  // any other string → either a canonical category or a custom label.
  const [issueCategory, setIssueCategory] = useState<string>("");
  const [customCategory, setCustomCategory] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [customerInfo, setCustomerInfo] = useState<{ name?: string; phone?: string; location?: string } | null>(null);
  // Intake extras — captured up front so a case is created complete
  // rather than backfilled in the detail view. ref_no seeds from the
  // picked SO's own customer reference (below) but stays editable.
  const [refNo, setRefNo] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [serviceCategories, setServiceCategories] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  // Mig 065 — pull issue categories from the lookup endpoint so the
  // intake form mirrors what admins maintain in Service Maintenance.
  // Fall back to the shared ASSR_ISSUE_CATEGORIES list if the call
  // hasn't returned yet.
  const issueCategoriesQ = useQuery<{ data: { slug: string; name: string }[] }>("/api/assr/lookups/issue-categories",
    () => api.get("/api/assr/lookups/issue-categories"),
    [],
    LOOKUP_CACHE,
  );
  const issueCatOptions =
    issueCategoriesQ.data?.data.map((r) => r.name) ?? [];
  // Product Category options mirror AutoCount's item groups (Nick
  // 2026-07-14) — admin-maintained in Service Maintenance until the
  // AutoCount reconnect back-fills the authoritative list.
  const productCategoriesQ = useQuery<{ data: { slug: string; name: string }[] }>(ASSR_PRODUCT_CATEGORIES_ENDPOINT,
    () => api.get(ASSR_PRODUCT_CATEGORIES_ENDPOINT),
    [],
    LOOKUP_CACHE,
  );
  const productCategoryOptions =
    productCategoriesQ.data?.data.map((r) => r.name) ?? [];


  const MAX_FILES = 5;
  const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
  const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "mp4", "pdf"]);

  function addFiles(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    const next: File[] = [];
    for (const f of Array.from(picked)) {
      const ext = f.name.split(".").pop()?.toLowerCase() || "";
      if (!ALLOWED_EXT.has(ext)) {
        toast.error(`${f.name}: unsupported type`);
        continue;
      }
      if (f.size > MAX_SIZE) {
        toast.error(`${f.name}: exceeds 5MB`);
        continue;
      }
      next.push(f);
    }
    setFiles((prev) => [...prev, ...next].slice(0, MAX_FILES));
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  // A drop that misses the dropzone below must not navigate the SPA
  // away to the dropped file.
  useStrayFileDropGuard();

  // Clipboard paste — when the panel is mounted, intercept any paste
  // that carries file blobs (typically a screenshot or copied image)
  // and route it through addFiles. Plain-text pastes are left alone
  // so the Issue Description textarea still works.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const blobs = clipboardFiles(e);
      if (blobs.length === 0) return;
      e.preventDefault();
      const dt = new DataTransfer();
      blobs.forEach((b) => dt.items.add(b));
      addFiles(dt.files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // addFiles is stable enough — uses functional setFiles + constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Best-effort — the warning is advisory, so a failed fetch just shows
  // nothing rather than blocking intake.
  async function fetchExistingCases(d: string) {
    try {
      const res = await api.get<{ cases: NonNullable<typeof existingCases>["cases"] }>(
        `/api/assr/so-cases/${encodeURIComponent(d)}`
      );
      setExistingCases({ docNo: d, cases: res.cases ?? [] });
    } catch {
      setExistingCases(null);
    }
  }

  async function lookup() {
    if (!docNo.trim()) return;
    setLookingUp(true);
    setLookupItems(null);
    void fetchExistingCases(docNo.trim());
    try {
      const res = await api.get<{ items: { item_code: string; item_description: string | null; qty?: number }[] }>(
        `/api/assr/lookup-items/${encodeURIComponent(docNo.trim())}`
      );
      setLookupItems(res.items);
      setSelectedItems(new Set());
      setItemQty({});
    } catch (e: any) {
      toast.error(`Lookup failed: ${e?.message || e}`);
    } finally {
      setLookingUp(false);
    }
  }

  // Debounced typeahead — fires whenever the input changes and the
  // current value isn't an already-picked DocNo. Kept short so the
  // dropdown feels live; the backend route is a single indexed-ish
  // LIKE against the local mirror, so cost is low per call.
  useEffect(() => {
    const q = docNo.trim();
    if (q.length < 2 || pickedDocNo === q) {
      setSoSuggestions([]);
      setSearchingSO(false);
      return;
    }
    setSearchingSO(true);
    const handle = setTimeout(async () => {
      try {
        const res = await api.get<{
          results: { doc_no: string; ref: string | null; debtor_name: string | null; phone: string | null; doc_date: string | null; sales_agent: string | null }[];
        }>(`/api/assr/search-so?q=${encodeURIComponent(q)}`);
        setSoSuggestions(res.results);
      } catch {
        setSoSuggestions([]);
      } finally {
        setSearchingSO(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [docNo, pickedDocNo]);

  /* Sync the portaled dropdown to the input rect, tracking scroll/resize so
     the menu follows if the panel body scrolls — shared geometry, same flip
     and clamp as every other picker here. */
  const dropdownRect = useAnchoredPanel(
    soInputRef,
    soSuggestions.length > 0 && pickedDocNo !== docNo.trim(),
    SO_SUGGEST_MAX_H,
  );

  function pickSuggestion(s: { doc_no: string; ref?: string | null; debtor_name: string | null; phone: string | null }) {
    setDocNo(s.doc_no);
    setPickedDocNo(s.doc_no);
    setSoSuggestions([]);
    void fetchExistingCases(s.doc_no);
    setCustomerInfo({ name: s.debtor_name ?? undefined, phone: s.phone ?? undefined });
    // Seed Ref No from the SO's own customer reference; stays editable.
    if (s.ref && !refNo.trim()) setRefNo(s.ref);
    setLookupItems(null);
    setSelectedItems(new Set());
    setItemQty({});
    // Auto-run the items lookup so the form proceeds in one click.
    setTimeout(() => {
      void (async () => {
        setLookingUp(true);
        try {
          const res = await api.get<{ items: { item_code: string; item_description: string | null; qty?: number }[] }>(
            `/api/assr/lookup-items/${encodeURIComponent(s.doc_no)}`
          );
          setLookupItems(res.items);
        } catch (e: any) {
          toast.error(`Lookup failed: ${e?.message || e}`);
        } finally {
          setLookingUp(false);
        }
      })();
    }, 0);
  }

  async function submit() {
    if (!docNo.trim() || !issue.trim()) return;
    const items = [...selectedItems].map((code) => {
      const found = lookupItems?.find((i) => i.item_code === code);
      // User-chosen affected qty wins; falls back to the SO line qty.
      const chosen = itemQty[code];
      return {
        item_code: code,
        item_description: found?.item_description ?? null,
        qty: chosen && chosen > 0 ? chosen : found?.qty && found.qty > 0 ? found.qty : 1,
      };
    });
    // Owner 2026-07-22 — items MAY be empty. A Service Case is not always
    // about a defective product (driver damaged customer's floor, lorry
    // problem etc.); the backend accepts items=[] for exactly this reason.
    // Resolve the chosen issue category. "Other" requires the user to
    // have typed a custom label; otherwise we send null.
    let resolvedCategory: string | null = null;
    if (issueCategory === OTHER_SENTINEL) {
      const trimmed = customCategory.trim();
      resolvedCategory = trimmed || null;
    } else if (issueCategory) {
      resolvedCategory = issueCategory;
    }

    setSubmitting(true);
    try {
      const res = await api.post<{ assr_no: string; id: number }>("/api/assr", {
        doc_no: docNo.trim(),
        items,
        complaint_issue: issue.trim(),
        issue_category: resolvedCategory,
        // Priority + assignee are no longer picked at intake (Nick
        // 2026-07-14): the backend defaults priority to "normal" and
        // assigns the admin-configured default PIC; both are adjusted
        // on the detail page when needed.
        // Intake extras — sent trimmed-or-null so the case is created
        // complete. The backend also trims/whitelists these defensively.
        ref_no: refNo.trim() || null,
        customer_email: customerEmail.trim() || null,
        service_category: serviceCategories.length ? serviceCategories : null,
      });

      // Upload any staged defect photos/videos as "complaint" attachments.
      // WO-7: uploadAssrAttachment compresses photos + uploads their thumbs.
      if (files.length > 0) {
        setUploadProgress({ done: 0, total: files.length });
        let failed = 0;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          try {
            await uploadAssrAttachment(res.id, file, "complaint");
          } catch (err) {
            failed++;
            console.warn(`Upload failed for ${file.name}`, err);
          }
          setUploadProgress({ done: i + 1, total: files.length });
        }
        if (failed > 0) {
          toast.error(`Created ${res.assr_no}, but ${failed} file(s) failed to upload`);
        } else {
          toast.success(`Created ${res.assr_no} with ${files.length} attachment(s)`);
        }
      } else {
        toast.success(`Created ${res.assr_no}`);
      }

      onCreated(res.id);
    } catch (e: any) {
      // Duplicate-open-case guard (owner 2026-07-22) — the server returns 409
      // with { error: 'duplicate_open_case', message, existing:[{id, items,
      // ...}] } when any picked item is already attached to an open case on
      // this SO. Surface the friendly message rather than the raw "Failed:"
      // so staff know to add to the existing case instead.
      const errCode = e?.response?.body?.error ?? e?.body?.error;
      const errMsg  = e?.response?.body?.message ?? e?.body?.message;
      if (errCode === 'duplicate_open_case' && typeof errMsg === 'string') {
        toast.error(errMsg);
      } else {
        toast.error(`Failed: ${e?.message || e}`);
      }
    } finally {
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  function toggleItem(code: string) {
    const deselecting = selectedItems.has(code);
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
    if (deselecting) {
      // Drop the qty so re-ticking re-seeds from the SO line qty.
      setItemQty((q) => {
        const { [code]: _dropped, ...rest } = q;
        return rest;
      });
    } else {
      // Seed the affected qty from the SO line qty (fallback 1).
      const found = lookupItems?.find((i) => i.item_code === code);
      setItemQty((q) => ({ ...q, [code]: found?.qty && found.qty > 0 ? found.qty : 1 }));
    }
  }

  return (
    <Panel open onClose={onClose} title="New Service Case" width={560} centered>
      <PanelSection title="Sales Order">
        <div className="relative flex gap-2">
          <input
            ref={soInputRef}
            value={docNo}
            onChange={(e) => {
              setDocNo(e.target.value);
              if (pickedDocNo && e.target.value.trim() !== pickedDocNo) {
                setPickedDocNo(null);
                setCustomerInfo(null);
              }
            }}
            onKeyDown={(e) => e.key === "Enter" && lookup()}
            placeholder="SO #, reference, or customer name…"
            className="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <Button variant="secondary" icon={<Search size={14} />} onClick={lookup} disabled={lookingUp}>
            {lookingUp ? "…" : "Lookup"}
          </Button>
        </div>
        {/* Typeahead dropdown — portaled to body so PanelSection's
            overflow-hidden doesn't clip suggestions extending below
            the section. Coords are tracked in `dropdownRect`. */}
        {dropdownRect && createPortal(
          <div
            style={{ ...anchoredPanelStyle(dropdownRect), zIndex: 60 }}
            className="overflow-auto rounded-md border border-border bg-surface shadow-lg"
          >
            {soSuggestions.map((s) => (
              <button
                key={s.doc_no}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s); }}
                className="flex w-full flex-col gap-0.5 border-b border-border/60 px-3 py-2 text-left text-[12px] last:border-b-0 hover:bg-accent-soft/20"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-ink">{s.doc_no}</span>
                  {s.company_code && s.company_code !== "HOUZS" && (
                    <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted">{s.company_code}</span>
                  )}
                  {s.ref && <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">ref: {s.ref}</span>}
                  {(s.case_count ?? 0) > 0 && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                      {s.case_count} case{(s.case_count ?? 0) > 1 ? "s" : ""}
                    </span>
                  )}
                  {s.doc_date && <span className="ml-auto text-[10px] text-ink-muted">{s.doc_date}</span>}
                </div>
                {(s.debtor_name || s.phone) && (
                  <div className="text-[11px] text-ink-secondary">
                    {s.debtor_name ?? ""}
                    {s.debtor_name && s.phone ? " · " : ""}
                    {formatPhone(s.phone)}
                  </div>
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
        {(searchingSO || customerInfo) && (
          <div className="mt-1.5 text-[11px] text-ink-muted">
            {searchingSO && pickedDocNo !== docNo.trim() ? (
              "Searching…"
            ) : customerInfo ? (
              <>
                Customer: <span className="text-ink">{customerInfo.name ?? "—"}</span>
                {customerInfo.phone ? <> · {formatPhone(customerInfo.phone)}</> : null}
              </>
            ) : null}
          </div>
        )}
        {!searchingSO &&
          !customerInfo &&
          pickedDocNo !== docNo.trim() &&
          soSuggestions.length === 0 &&
          docNo.trim().length >= 2 && (
            <PullFromAutoCount
              query={docNo}
              onPulled={async (d) => {
                // Now mirrored — re-run the same search so we can select it and
                // seed customer info exactly as picking a suggestion would.
                try {
                  const r = await api.get<{
                    results: {
                      doc_no: string;
                      ref: string | null;
                      debtor_name: string | null;
                      phone: string | null;
                      doc_date: string | null;
                      sales_agent: string | null;
                    }[];
                  }>(`/api/assr/search-so?q=${encodeURIComponent(d)}`);
                  const hit =
                    r.results.find((x) => x.doc_no.toUpperCase() === d.toUpperCase()) ??
                    r.results[0];
                  if (hit) pickSuggestion(hit);
                  else setDocNo(d);
                } catch {
                  setDocNo(d);
                }
              }}
            />
          )}
        {/* Existing-case warning — shown only while the input still holds
            the doc_no the fetch answered, so retyping self-dismisses it.
            Cases open in a new tab: the operator is mid-form and likely
            wants to compare before deciding to abandon this create. */}
        {existingCases &&
          existingCases.cases.length > 0 &&
          docNo.trim().toLowerCase() === existingCases.docNo.toLowerCase() && (
            <div className="mt-2 rounded-md border border-amber-500/60 bg-amber-50/60 px-3 py-2.5 dark:bg-amber-500/10">
              <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-amber-800 dark:text-amber-300">
                <AlertCircle size={13} />
                This order already has {existingCases.cases.length} service case
                {existingCases.cases.length > 1 ? "s" : ""}
              </div>
              <div className="mt-1.5 space-y-1">
                {existingCases.cases.map((ec) => (
                  <button
                    key={ec.id}
                    type="button"
                    onClick={() => window.open(`/assr/${ec.id}`, "_blank", "noopener")}
                    className="flex w-full flex-col gap-0.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-accent-soft/20"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-ink">{ec.assr_no}</span>
                      <StatusDot variant={stageVariant(ec.stage ?? "")} label={caseStageLabel(ec.stage ?? "")} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ink-secondary">
                      <span>{formatDate(ec.complained_date || ec.created_at)}</span>
                      {ec.created_by_name && <span className="text-ink-muted">by {ec.created_by_name}</span>}
                      {ec.complaint_issue && (
                        <span className="truncate text-ink-muted" title={ec.complaint_issue}>
                          {ec.complaint_issue.length > 70 ? `${ec.complaint_issue.slice(0, 70)}…` : ec.complaint_issue}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[10.5px] text-ink-muted">
                Open the existing case and add to it instead of creating a duplicate — only continue if this is a genuinely new issue.
              </div>
            </div>
          )}
      </PanelSection>

      {lookupItems !== null && (
        <PanelSection title={`Items (${lookupItems.length})`}>
          {lookupItems.length === 0 ? (
            <div className="text-[12px] text-ink-muted">
              No PO items found for this SO. You can still create the case — enter item details manually.
            </div>
          ) : (
            <div className="space-y-1.5">
              {lookupItems.map((item) => (
                <label
                  key={item.item_code}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent-soft/20"
                >
                  <input
                    type="checkbox"
                    checked={selectedItems.has(item.item_code)}
                    onChange={() => toggleItem(item.item_code)}
                    className="accent-accent"
                  />
                  <span className="font-mono text-[11px] font-medium">{item.item_code}</span>
                  {item.item_description && (
                    <span
                      className="flex-1 truncate text-ink-secondary"
                      title={item.item_description}
                    >
                      {item.item_description}
                    </span>
                  )}
                  {selectedItems.has(item.item_code) ? (
                    // Selected → editable affected qty (seeded from the SO
                    // line qty). Click/keys stay in the input — never toggle
                    // the row's checkbox.
                    <span
                      className="ml-auto flex flex-none items-center gap-1"
                      onClick={(e) => e.preventDefault()}
                    >
                      <span className="text-[10px] uppercase tracking-brand text-ink-muted">Qty</span>
                      <input
                        type="number"
                        min={1}
                        value={itemQty[item.item_code] ?? (item.qty && item.qty > 0 ? item.qty : 1)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          setItemQty((q) => ({ ...q, [item.item_code]: Number.isFinite(n) && n > 0 ? n : 1 }));
                        }}
                        className="w-14 rounded-md border border-border bg-bg px-2 py-1 text-right text-[12px] outline-none focus:border-primary"
                      />
                    </span>
                  ) : (
                    item.qty != null && item.qty > 0 && (
                      <span className="ml-auto text-[11px] text-ink-muted">&times;{item.qty}</span>
                    )
                  )}
                </label>
              ))}
            </div>
          )}

          {/* Manual item entry if no items found */}
          {lookupItems.length === 0 && (
            <div className="mt-2">
              <input
                placeholder="Item code (manual)"
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                    const code = (e.target as HTMLInputElement).value.trim();
                    setSelectedItems(new Set([...selectedItems, code]));
                    setLookupItems([...lookupItems, { item_code: code, item_description: null }]);
                    (e.target as HTMLInputElement).value = "";
                  }
                }}
              />
            </div>
          )}
        </PanelSection>
      )}

      <PanelSection title="Issue Description">
        <textarea
          value={issue}
          onChange={(e) => setIssue(e.target.value)}
          rows={4}
          placeholder="Describe the issue…"
          className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <div className="mt-3">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Issue Category *
          </div>
          <select
            value={issueCategory}
            onChange={(e) => {
              const v = e.target.value;
              setIssueCategory(v);
              if (v !== OTHER_SENTINEL) setCustomCategory("");
            }}
            className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            <option value="">— select —</option>
            {(issueCatOptions.length ? issueCatOptions : [...ASSR_ISSUE_CATEGORIES]).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value={OTHER_SENTINEL}>Other…</option>
          </select>
          {issueCategory === OTHER_SENTINEL && (
            <input
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              placeholder="e.g. transport damage"
              className="mt-1.5 w-full rounded-md border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          )}
        </div>
      </PanelSection>

      {/* Customer & Assignment — intake extras that the redesigned
          detail view collects (Ref No / Email / Product Category /
          Operations PIC). Capturing them here means a case is created
          complete instead of being backfilled after the fact. Ref No
          seeds from the picked SO's own customer reference. */}
      <PanelSection title="Customer & Assignment">
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Ref No
            </div>
            <input
              value={refNo}
              onChange={(e) => setRefNo(e.target.value)}
              placeholder="Customer reference (e.g. HC14032)"
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Customer Email
            </div>
            <input
              type="email"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="customer@example.com"
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Product Category
            </div>
            <CategoryChips
              options={productCategoryOptions}
              value={serviceCategories}
              onChange={setServiceCategories}
            />
          </div>
        </div>
      </PanelSection>

      <PanelSection title={`Defect Photos / Videos (${files.length}/${MAX_FILES})`}>
        <div
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes("Files")) {
              e.preventDefault();
              if (!dragActive) setDragActive(true);
            }
          }}
          onDragLeave={(e) => {
            // Ignore leave events triggered by entering a child node.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDragActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            addFiles(e.dataTransfer.files);
          }}
          className={cn(
            "rounded-md border border-dashed p-2 transition-colors",
            dragActive ? "border-accent bg-accent-soft/30" : "border-border bg-bg/30"
          )}
        >
          {files.length > 0 && (
            <div className="mb-2 grid grid-cols-3 gap-2">
              {files.map((f, i) => (
                <FilePreview key={i} file={f} onRemove={() => removeFile(i)} />
              ))}
            </div>
          )}
          <label className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:border-accent/40",
            files.length >= MAX_FILES && "pointer-events-none opacity-50"
          )}>
            <Upload size={12} />
            Add Photos / Videos
            <input
              type="file"
              accept="image/*,video/mp4,video/quicktime,video/webm,.pdf"
              multiple
              className="hidden"
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
              disabled={files.length >= MAX_FILES}
            />
          </label>
          <div className="mt-1.5 text-[10px] text-ink-muted">
            JPG / PNG / WEBP / MP4 / PDF · 5MB each · up to {MAX_FILES} files · drag, drop, or paste
          </div>
        </div>
      </PanelSection>

      <div className="border-t border-border px-5 py-4">
        {/* Issue Category is REQUIRED (owner ruling 2026-07-19, matches mobile
            #842): block Create until a category resolves — the disabled gate
            below mirrors submit()'s resolve logic, so "Other…" also requires
            the custom label. FE gate; server still accepts a null category. */}
        <Button
          variant="primary"
          onClick={submit}
          disabled={
            submitting ||
            !docNo.trim() ||
            !issue.trim() ||
            !issueCategory ||
            (issueCategory === OTHER_SENTINEL && !customCategory.trim())
          }
        >
          {uploadProgress
            ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
            : submitting
            ? "Creating…"
            : "Create Case"}
        </Button>
      </div>
    </Panel>
  );
}

// ── Detail Panel ──────────────────────────────────────────────

function DetailContent({
  id,
  onUpdated,
  toast,
}: {
  id: number;
  onUpdated: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const dialog = useDialog();
  const detail = useQuery<AssrDetail>("/api/assr/:",
    () => api.get(`/api/assr/${id}`),
    [id]
  );

  // PR 4 — the active-stage set collapses to 7 when the resolution
  // method is internal (own team / return-to-store). Compute once
  // per render and thread through the workflow card, summary bar,
  // and stage accordion.
  const activeStages = useMemo(
    () => getActiveStages(detail.data?.case?.resolution_method, detail.data?.case?.stage ?? "pending_review"),
    [detail.data?.case?.resolution_method, detail.data?.case?.stage],
  );

  // PR 3 — snap the accordion's open row to the case's current stage
  // any time the case's stage changes. A hooks ref remembers the last
  // stage we snapped to so the user can still hand-collapse or open a
  // different row without us fighting them on every render.
  useEffect(() => {
    const s = detail.data?.case?.stage;
    if (!s) return;
    if (stageSetByHookRef.current === s) return;
    stageSetByHookRef.current = s;
    setOpenStage(s);
  }, [detail.data?.case?.stage]);

  // Mig 106 — Service Admin opening a case that's still on
  // pending_review auto-advances it to under_verification. The server
  // gates on write permission so read-only viewers don't kick the
  // stage. Fire once per case after the detail loads; if the case
  // actually advanced, reload the detail so the panel reflects the
  // new stage without a manual refresh.
  const openedRef = useRef<number | null>(null);
  useEffect(() => {
    const c = detail.data?.case;
    if (!c || c.stage !== "pending_review") return;
    if (openedRef.current === c.id) return;
    openedRef.current = c.id;
    (async () => {
      try {
        const res = await api.post<{ advanced: boolean }>(`/api/assr/${c.id}/mark-opened`);
        if (res.advanced) {
          detail.reload();
          onUpdated();
        }
      } catch {
        // silent-write-ok: this also fires for callers WITHOUT the permission,
      // where a 403 is the expected answer and nothing on screen depends on it.
      }
    })();
  }, [detail.data]);
  const users = useQuery<{ id: number; name: string; department_name?: string }[]>("/api/users#unwrapped",
    () => api.get<any>("/api/users").then((r: any) => r.users ?? r.data ?? r ?? []),
    []
  );
  // Mig 065 — picker values come from the lookup endpoints maintained
  // in Service Maintenance. Each query is small; the four together
  // are still cheap. Fall back to the legacy hardcoded constants when
  // the API hasn't returned yet so the form stays usable.
  type LookupOpt = { slug: string; name: string };
  const issueCategoriesQ = useQuery<{ data: LookupOpt[] }>("/api/assr/lookups/issue-categories",
    () => api.get("/api/assr/lookups/issue-categories"),
    [],
    LOOKUP_CACHE,
  );
  const resolutionMethodsQ = useQuery<{ data: LookupOpt[] }>("/api/assr/lookups/resolution-methods",
    () => api.get("/api/assr/lookups/resolution-methods"),
    [],
    LOOKUP_CACHE,
  );
  const detailProductCategoriesQ = useQuery<{ data: LookupOpt[] }>(ASSR_PRODUCT_CATEGORIES_ENDPOINT,
    () => api.get(ASSR_PRODUCT_CATEGORIES_ENDPOINT),
    [],
    LOOKUP_CACHE,
  );
  const detailProductCategoryOptions =
    detailProductCategoriesQ.data?.data.map((r) => r.name) ?? [];
  const prioritiesQ = useQuery<{ data: LookupOpt[] }>("/api/assr/lookups/priorities",
    () => api.get("/api/assr/lookups/priorities"),
    [],
    LOOKUP_CACHE,
  );
  const ncrCategoriesQ = useQuery<{ data: LookupOpt[] }>("/api/assr/lookups/ncr-categories",
    () => api.get("/api/assr/lookups/ncr-categories"),
    [],
    LOOKUP_CACHE,
  );
  const issueOptions = (issueCategoriesQ.data?.data ?? []).map((r) => r.name);
  const resolutionOptions = (resolutionMethodsQ.data?.data ?? []).map((r) => r.slug);
  const priorityOptions = (prioritiesQ.data?.data ?? []).map((r) => r.slug);
  // Map slug → display name so the Lead Time pill can render "Urgent"
  // instead of the raw "urgent" slug. Recomputes only when the
  // priorities lookup changes.
  const priorityMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of prioritiesQ.data?.data ?? []) m[p.slug] = p.name;
    return m;
  }, [prioritiesQ.data]);
  const ncrOptions = (ncrCategoriesQ.data?.data ?? []).map((r) => r.slug);
  const [note, setNote] = useState("");
  const [noteFormOpen, setNoteFormOpen] = useState(false);
  // Mig 064 / 0108 — note posting picks an audience bucket. Default
  // 'service' (internal); only 'customer' is portal-visible.
  // (internal team comms) since most notes are operational. Switch to
  // 'customer' to make the entry visible on the customer portal.
  // Customer card starts read-only (Nick 2026-07-14: "don't keep the
  // inputs open — add an Edit button"); toggling exposes the InlineEdit
  // fields, incl. the SO-No mirror re-match.
  const [custEditing, setCustEditing] = useState(false);
  const [noteCategory, setNoteCategory] = useState<AssrNoteAudience>("service");
  // Activity timeline filter. 'all' = show everything; the others
  // narrow to one stored category (four buckets + system since mig
  // 0108): service / customer / supplier / sales cover authored notes
  // and portal activity; auto-emitted events (stage_change,
  // assignment, escalation, …) live under 'system'. Channel inference
  // only backstops legacy rows that predate the category backfill.
  const [activityFilter, setActivityFilter] = useState<
    "all" | "service" | "customer" | "supplier" | "sales" | "system"
  >("all");
  const [transitioning, setTransitioning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showClosePrompt, setShowClosePrompt] = useState(false);
  const [showVoidPrompt, setShowVoidPrompt] = useState(false);
  // PR 3 — stage accordion open row. Defaults to the case's current
  // stage so ops lands on the row they need to work; changing the
  // stage from the Workflow card also snaps this to the new stage.
  const [openStage, setOpenStage] = useState<AssrStage | null>(null);
  const stageSetByHookRef = useRef<AssrStage | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showAddItem, setShowAddItem] = useState(false);
  const [showAddLogistics, setShowAddLogistics] = useState(false);
  // SO-based item picker for the Add Item panel — mirrors the
  // intake form's `lookup-items` flow so ops adds items by checkbox
  // instead of re-typing them. Manual fallback covers ad-hoc entries
  // that aren't on the original SO.
  type LookupItem = { item_code: string; item_description: string | null; qty?: number };
  const [lookupItems, setLookupItems] = useState<LookupItem[] | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [pickedCodes, setPickedCodes] = useState<Set<string>>(new Set());
  const [manualCode, setManualCode] = useState("");
  const [manualDesc, setManualDesc] = useState("");

  const c = detail.data?.case;
  const items = detail.data?.items ?? [];
  const attachments = detail.data?.attachments ?? [];
  const activity = detail.data?.activity ?? [];
  const logistics = detail.data?.logistics ?? [];
  const relatedPOs = detail.data?.related_pos ?? [];

  async function patch(body: Record<string, any>) {
    await api.patch(`/api/assr/${id}`, body);
    detail.reload();
    onUpdated();
  }

  async function transition(stage: AssrStage) {
    setTransitioning(true);
    try {
      await api.post(`/api/assr/${id}/transition`, { stage });
      detail.reload();
      onUpdated();
    } catch (e: any) {
      toast.error(e?.message || "Transition failed");
    } finally {
      setTransitioning(false);
    }
  }

  // Auto-stage-transition watcher (TODO item 5). When the predicate
  // for the current stage flips from unsatisfied → satisfied, prompt
  // the user to advance. Row 2 (Under Verification → Pending Solution)
  // is owned by VerificationCard so it can use the richer outcome
  // semantics; the other six rows route through here.
  useStageAutoAdvance({ c, logistics, transition, dialog });

  async function addNote() {
    if (!note.trim()) return;
    await api.post(`/api/assr/${id}/notes`, {
      note: note.trim(),
      category: noteCategory,
    });
    setNote("");
    setNoteFormOpen(false);
    detail.reload();
  }

  // Keep a mistargeted drop from navigating the SPA to the file, and
  // teach the paste affordance: a file paste that lands while no upload
  // zone is hovered would otherwise vanish silently.
  useStrayFileDropGuard();
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || hoveredUploadZones.size > 0) return;
      if (clipboardFiles(e).length === 0) return;
      toast.info("To paste files, hover over an upload area first (Photos card or a stage's upload slot).");
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // toast methods are stable under the hood.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadFiles(files: File[], category: string) {
    const accepted = acceptedUploadFiles(files, toast);
    if (accepted.length === 0) return;
    setUploading(true);
    try {
      // WO-7: shared pipeline — compresses photos + uploads their thumbs.
      for (const f of accepted) await uploadAssrAttachment(id, f, category);
      toast.success(accepted.length > 1 ? `${accepted.length} files uploaded` : "File uploaded");
    } catch (err: any) {
      toast.error(`Upload failed: ${err?.message || err}`);
    } finally {
      setUploading(false);
      // Reload even on failure — earlier files of a batch may have saved.
      detail.reload();
    }
  }

  // Open the Add Item panel and lazily fetch the case's SO items —
  // same `/api/assr/lookup-items/:doc_no` endpoint used by the
  // intake form. Cached after the first open; user can re-fetch via
  // the Refresh button if the SO has changed since.
  async function openAddItem() {
    setShowAddItem(true);
    setPickedCodes(new Set());
    if (!c?.doc_no) return;
    if (lookupItems !== null) return; // already loaded
    setLookupLoading(true);
    try {
      const res = await api.get<{ items: LookupItem[] }>(
        `/api/assr/lookup-items/${encodeURIComponent(c.doc_no)}`,
      );
      setLookupItems(res.items);
    } catch (e: any) {
      toast.error(`Lookup failed: ${e?.message || e}`);
      setLookupItems([]);
    } finally {
      setLookupLoading(false);
    }
  }

  async function reloadLookup() {
    if (!c?.doc_no) return;
    setLookupLoading(true);
    setLookupItems(null);
    try {
      const res = await api.get<{ items: LookupItem[] }>(
        `/api/assr/lookup-items/${encodeURIComponent(c.doc_no)}`,
      );
      setLookupItems(res.items);
    } catch (e: any) {
      toast.error(`Lookup failed: ${e?.message || e}`);
      setLookupItems([]);
    } finally {
      setLookupLoading(false);
    }
  }

  function closeAddItem() {
    setShowAddItem(false);
    setPickedCodes(new Set());
    setManualCode("");
    setManualDesc("");
  }

  async function addPickedItems() {
    const fromLookup = (lookupItems ?? [])
      .filter((it) => pickedCodes.has(it.item_code))
      .map((it) => ({
        item_code: it.item_code,
        item_description: it.item_description,
        qty: it.qty && it.qty > 0 ? it.qty : 1,
      }));
    const manualEntry = manualCode.trim()
      ? [{
          item_code: manualCode.trim(),
          item_description: manualDesc.trim() || null,
          qty: 1,
        }]
      : [];
    const payload = [...fromLookup, ...manualEntry];
    if (payload.length === 0) return;
    try {
      await api.post(`/api/assr/${id}/items`, { items: payload });
      closeAddItem();
      detail.reload();
    } catch (e: any) {
      toast.error(`Failed: ${e?.message || e}`);
    }
  }

  async function removeItem(itemId: number) {
    try {
      await api.del(`/api/assr/${id}/items/${itemId}`);
      detail.reload();
    } catch (e: any) {
      toast.error(`Failed: ${e?.message || e}`);
    }
  }

  function handleCloseClick() {
    setShowClosePrompt(true);
  }

  // NEXT_STAGE lookup retired in mig 064 — the header picker now
  // accepts any stage. Kept the constant defined at module scope for
  // any external consumers (tests, etc.); no live UI consumes it.
  const userOptions = Array.isArray(users.data)
    ? users.data.map((u) => ({ id: u.id, name: u.name }))
    : [];
  // PIC picker is a server typeahead now; the dropdown stays restricted to
  // Operations-department members via `filterOption`. The currently-assigned
  // people are resolved from the already-loaded users list so their chips
  // always display (even if outside Operations) and stay removable.
  const assignedItems: UserOptionItem[] = Array.isArray(users.data)
    ? users.data
        .filter((u: any) => u.id === c?.assigned_to || u.id === c?.assigned_to_2)
        .map((u: any) => ({
          id: u.id,
          name: u.name,
          department_name: u.department_name,
        }))
    : [];

  return (
    <DetailLayout
      breadcrumbs={[
        { label: "Service Cases", to: "/assr" },
        { label: c?.assr_no || "Loading…" },
      ]}
      eyebrow="Service Case"
      stickyTitle
      title={c?.assr_no || "Loading…"}
      titleClassName="font-serif text-[26px] font-semibold leading-none tracking-tight text-ink sm:text-[28px] lg:text-[32px]"
      description={
        c ? (
          <span className="text-[13.5px] text-ink-secondary">
            Customer <b className="font-semibold text-ink">{c.customer_name || "—"}</b>
            {/* Sub-status implies its stage (Nick 2026-07-23: supplier
                pending return 应该出现在 stage) — show it when present. */}
            {" · "}Stage <b className="font-semibold text-accent">{caseSubStatus(c)?.label ?? caseStageLabel(c.stage)}</b>
            {c.doc_no ? <> {" · "}<span className="font-mono text-[12.5px] text-ink-secondary">{c.doc_no}</span></> : null}
            {c.ref_no ? <> {" · "}Ref <span className="font-mono text-[12.5px]">{c.ref_no}</span></> : null}
          </span>
        ) : undefined
      }
      backTo="/assr"
      loading={detail.loading && !c}
      error={detail.error}
      actions={
        c ? (
          <>
            {/* PR 1 redesign — Print + Portal Link moved up from the
                pill row. Match the design's title-row action group. */}
            <PrintMenu
              caseId={id}
              assrNo={c.assr_no}
              customer={c.customer_name}
              refNo={c.ref_no}
              stage={c.stage}
              resolutionMethod={c.resolution_method}
              companyCode={c.company_code}
              toast={toast}
            />
            <PortalLinksMenu
              id={id}
              assrNo={c.assr_no}
              existingToken={detail.data?.portal_token ?? null}
              toast={toast}
              onGenerated={() => detail.reload()}
            />
            {c.archived_at ? (
              <HeaderButton
                variant="ghost"
                onClick={async () => {
                  try {
                    await api.post(`/api/assr/${id}/unarchive`);
                    toast.success("Case restored");
                    detail.reload();
                    onUpdated();
                  } catch (e: any) {
                    toast.error(e?.message || "Something went wrong. Please try again.");
                  }
                }}
              >
                Restore
              </HeaderButton>
            ) : (
              <HeaderButton
                variant="ghost"
                onClick={async () => {
                  if (!(await dialog.confirm("Archive this case? It will be hidden from the default list but kept on record."))) return;
                  try {
                    await api.post(`/api/assr/${id}/archive`);
                    toast.success("Case archived");
                    detail.reload();
                    onUpdated();
                  } catch (e: any) {
                    toast.error(e?.message || "Something went wrong. Please try again.");
                  }
                }}
              >
                Archive
              </HeaderButton>
            )}
            {/* Stage picker moved into the Workflow Progress card below
                (rendered as "Change to"), matching the case-detail layout. */}
            {/* Close Case on every open case (Nick 2026-07-21) — not just
                Delivery/Service. The ClosePrompt (satisfaction rating)
                is stage-agnostic and the stage dropdown already allows
                jumping straight to Completed, so early closes (customer
                withdrew, resolved without delivery) go through the same
                rated flow instead of a silent stage jump. */}
            {c.stage !== "completed" && !c.archived_at && (
              <HeaderButton
                variant="primary"
                onClick={handleCloseClick}
                disabled={transitioning}
              >
                {transitioning ? "…" : "Close Case"}
                <ChevronRight size={12} />
              </HeaderButton>
            )}
          </>
        ) : undefined
      }
    >
      {false && <div className="hidden">{/* loading handled by DetailLayout */}</div>}
      {detail.loading && <div className="p-6 text-sm text-ink-muted">Loading...</div>}
      {detail.error && !detail.loading && (
        <div className="m-5 rounded-md border border-err/40 bg-err/5 p-4 text-sm">
          <div className="font-semibold text-err">Failed to load case</div>
          <div className="mt-1 text-[12px] text-ink-secondary break-words">{detail.error}</div>
          <div className="mt-2 text-[11px] text-ink-muted">
            If you just added QMS features, make sure migrations 011–013 have been applied.
          </div>
        </div>
      )}
      {c && (
        <>
          {/* Close Case Prompt — collects final customer satisfaction only. */}
          {showClosePrompt && (
            <ClosePrompt
              onConfirm={async (rating, notes) => {
                if (rating) await patch({ satisfaction_rating: rating, satisfaction_notes: notes || null });
                await transition("completed");
                setShowClosePrompt(false);
              }}
              onCancel={() => setShowClosePrompt(false)}
              transitioning={transitioning}
            />
          )}

          {/* Void Prompt — records WHY the case is not valid before it
              moves to the terminal 'voided' stage (Nico 2026-07-29). */}
          {showVoidPrompt && (
            <VoidPrompt
              onConfirm={async (reason) => {
                await patch({ void_reason: reason || null });
                await transition("voided");
                setShowVoidPrompt(false);
              }}
              onCancel={() => setShowVoidPrompt(false)}
              transitioning={transitioning}
            />
          )}

          {/* Archived banner */}
          {c.archived_at && (
            <div className="border-b border-border bg-ink-muted/5 px-5 py-2 text-[11px] text-ink-muted">
              <span className="font-semibold uppercase tracking-wider text-ink-secondary">Archived</span>
              {" · "}
              {formatDateTime(c.archived_at)} — read-only. Use Restore to reactivate.
            </div>
          )}

          {/* PR 3 redesign hook — accordion open state. Defaults to
              the case's current stage so the row that ops needs is
              already open when the page lands. */}
          {/* Workflow card + Status summary bar sit at the same left/right
              edges as the DetailGrid columns below (no extra padding wrapper
              — matches the design's aligned rounded-card stack). */}
          <div className="mb-3 space-y-3">
            <WorkflowCard
              currentStage={c.stage}
              stages={activeStages}
              transitioning={transitioning}
              onChange={(s) => (s === "voided" ? setShowVoidPrompt(true) : transition(s))}
              disabled={!!c.archived_at}
              subStatus={caseSubStatus(c)}
              onSubChange={(k) => patch({ sub_status: k })}
              voidReason={c.void_reason ?? null}
            />
            <StatusSummaryBar
              c={c}
              stages={activeStages}
              priorityMap={priorityMap}
              subStatus={caseSubStatus(c)}
            />
          </div>
          <DetailGrid>
            <DetailMain>
          {/* ── Issue (captured at intake) ─────────────────────
              Everything in this block was filled in (or auto-derived
              from) the original create form: the customer's reported
              complaint, the issue category, and the priority used for
              SLA calculation. service_category was removed when the
              intake form was simplified — the issue_category taxonomy
              now drives both the dashboard breakdown and triage. */}
          {/* Design overview strip — LEFT rail top: Issue + Product
              side-by-side (2 cols on md+). Customer sits in the RIGHT
              rail per design (1.62fr : 1fr split), not up here. */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <PanelSection title="Issue" icon={<AlertCircle size={13} />}>
            <InlineEdit
              label="Complaint"
              textarea
              value={c.complaint_issue}
              onSave={(v) => patch({ complaint_issue: v })}
              placeholder="What the customer reported"
            />
            <IssueCategoryField
              value={c.issue_category}
              onSave={(v) => patch({ issue_category: v })}
              dialog={dialog}
              categories={
                issueOptions.length ? issueOptions : [...ASSR_ISSUE_CATEGORIES]
              }
            />
            <InlineEdit
              label="Priority"
              value={c.priority}
              options={priorityOptions.length ? priorityOptions : [...PRIORITY_OPTIONS]}
              onSave={(v) => patch({ priority: v })}
            />
            {/* Photos / videos — kept inside the Issue card (intake
                evidence next to the complaint). */}
            <div className="border-t border-border-subtle/50 pt-2.5">
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                Photos / Videos ({attachments.length})
              </div>
            <UploadDropZone
              disabled={uploading}
              onFiles={(files) => uploadFiles(files, c.stage === "completed" ? "completion" : "evidence")}
            >
            {attachments.length > 0 && (() => {
              // Issue evidence (what the service form / staff reported)
              // and QC-result shots read very differently — split the
              // grid by category instead of one mixed wall. Lightbox
              // indices stay against the full attachments array.
              const groupOf = (cat: string): { key: string; label: string; order: number } => {
                if (cat === "complaint" || cat === "evidence")
                  return { key: "issue", label: "Issue photos", order: 0 };
                if (cat === "inspection_report" || cat === "receipt_evidence")
                  return { key: "qc", label: "QC result", order: 1 };
                if (cat === "completion" || cat === "delivery_pod" || cat === "sign_off" || cat === "signature")
                  return { key: "done", label: "Completion & sign-off", order: 2 };
                return { key: "other", label: "Other documents", order: 3 };
              };
              const groups = new Map<string, { label: string; order: number; items: Array<{ att: any; index: number }> }>();
              attachments.forEach((att: any, index: number) => {
                const g = groupOf(String(att.category || ""));
                if (!groups.has(g.key)) groups.set(g.key, { label: g.label, order: g.order, items: [] });
                groups.get(g.key)!.items.push({ att, index });
              });
              return [...groups.values()]
                .sort((x, y) => x.order - y.order)
                .map((g) => (
                  <div key={g.label} className="mb-2">
                    <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-wide text-ink-muted/80">
                      {g.label} ({g.items.length})
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {g.items.map(({ att, index }) => (
                        <AttachmentThumb
                          key={att.id}
                          att={att}
                          onClick={() => {
                            const t = att.content_type || "";
                            if (t.startsWith("image/") || t.startsWith("video/")) {
                              setLightboxIndex(index);
                            }
                          }}
                          onVisibilityChange={async (visible) => {
                            try {
                              await api.patch(`/api/assr/attachments/${att.id}/visibility`, { visible_to_customer: visible });
                              toast.success(visible ? "Now visible to customer" : "Hidden from customer");
                              detail.reload();
                            } catch (e: any) {
                              toast.error(e?.message || "Something went wrong. Please try again.");
                            }
                          }}
                          onArchive={c.archived_at ? undefined : async () => {
                            if (!await dialog.confirm("Archive this attachment? It'll be hidden everywhere.")) return;
                            try {
                              await api.post(`/api/assr/attachments/${att.id}/archive`);
                              toast.success("Archived");
                              detail.reload();
                            } catch (e: any) {
                              toast.error(e?.message || "Something went wrong. Please try again.");
                            }
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ));
            })()}
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:border-accent/40">
              <Upload size={12} />
              {uploading ? "Uploading..." : "Upload"}
              <input
                type="file"
                accept="image/*,video/mp4,video/quicktime,video/webm,.pdf"
                multiple
                className="hidden"
                onChange={(e) => {
                  uploadFiles(Array.from(e.target.files ?? []), c.stage === "completed" ? "completion" : "evidence");
                  e.target.value = "";
                }}
                disabled={uploading}
              />
            </label>
            <div className="mt-1.5 text-[10px] text-ink-muted">
              Drag &amp; drop or paste (Ctrl+V) supported
            </div>
            </UploadDropZone>
            </div>
          </PanelSection>

          {/* Product Info — product attributes + procurement (PO). */}
          <PanelSection title="Product Info" icon={<Package size={13} />}>
            {items.length === 0 ? (
              <div className="text-[12px] text-ink-muted">No items</div>
            ) : (
              <div className="space-y-1">
                {items.map((item) => (
                  <div key={item.id} className="rounded border border-border px-3 py-1.5 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] font-medium">{item.item_code}</span>
                      <span
                        className="flex-1 truncate text-ink-secondary"
                        title={item.item_description || undefined}
                      >
                        {item.item_description || ""}
                      </span>
                      <div className="flex items-center gap-0.5">
                        <span className="mr-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-ink-muted">Set</span>
                        <ItemQtyStepper
                          caseId={id}
                          item={item}
                          disabled={c.stage === "completed" || !!c.archived_at}
                          onSaved={() => detail.reload()}
                          toast={toast}
                        />
                      </div>
                      <div className="flex items-center gap-0.5">
                        <span className="mr-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-ink-muted">Ctn</span>
                        <ItemCartonStepper
                          caseId={id}
                          item={item}
                          disabled={c.stage === "completed" || !!c.archived_at}
                          onSaved={() => detail.reload()}
                          toast={toast}
                        />
                      </div>
                      {c.stage !== "completed" && (
                        <button
                          onClick={() => removeItem(item.id)}
                          className="rounded p-0.5 text-ink-muted hover:text-err"
                          title="Remove item"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                    <ItemRemarkInput
                      caseId={id}
                      item={item}
                      field="remark"
                      label="Customer"
                      placeholder="Customer remark — prints on the customer copy"
                      disabled={c.stage === "completed" || !!c.archived_at}
                      onSaved={() => detail.reload()}
                      toast={toast}
                    />
                    <ItemRemarkInput
                      caseId={id}
                      item={item}
                      field="supplier_remark"
                      label="Supplier"
                      placeholder="Supplier remark — prints on the supplier copy"
                      disabled={c.stage === "completed" || !!c.archived_at}
                      onSaved={() => detail.reload()}
                      toast={toast}
                    />
                  </div>
                ))}
              </div>
            )}
            {c.stage !== "completed" && !showAddItem && (
              <button
                onClick={openAddItem}
                className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
              >
                <Plus size={12} /> Add Item
              </button>
            )}
            {/* Product attributes */}
            <div className="mt-1 space-y-2.5 border-t border-border-subtle/50 pt-2.5">
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Product Category
                </div>
                {/* Multi-select, saved on every toggle. The detail payload
                    carries the list; fall back to splitting the flat string
                    so a case fetched from a cached/older response still
                    shows its chips. */}
                <CategoryChips
                  options={detailProductCategoryOptions}
                  value={
                    detail.data?.service_categories ?? splitCategories(c.service_category)
                  }
                  onChange={(next) => patch({ service_category: next })}
                />
              </div>
            </div>
            {showAddItem && (() => {
              // Hide items already on the case so users only see what's
              // still pickable from the SO. Manual fallback below covers
              // anything not on the original SO.
              const existingCodes = new Set(items.map((it: any) => it.item_code));
              const available = (lookupItems ?? []).filter(
                (it) => !existingCodes.has(it.item_code),
              );
              const canAdd = pickedCodes.size > 0 || manualCode.trim().length > 0;
              return (
                <div className="mt-2 space-y-2 rounded border border-border bg-bg/60 p-3">
                  <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                    <span>
                      Items from SO{" "}
                      <span className="font-mono normal-case text-ink">
                        {c.doc_no || "(none)"}
                      </span>
                    </span>
                    <button
                      onClick={reloadLookup}
                      disabled={lookupLoading || !c.doc_no}
                      title="Refetch items from the SO"
                      className="inline-flex items-center gap-1 rounded p-1 text-ink-muted hover:text-accent disabled:opacity-40"
                    >
                      <RefreshCw size={11} className={cn(lookupLoading && "animate-spin")} />
                    </button>
                  </div>
                  {lookupLoading && lookupItems === null && (
                    <div className="text-[12px] text-ink-muted">Loading SO items…</div>
                  )}
                  {!lookupLoading && lookupItems !== null && available.length === 0 && (
                    <div className="text-[11.5px] text-ink-muted">
                      {(lookupItems?.length ?? 0) === 0
                        ? "No items found on this SO. Use the manual entry below."
                        : "All SO items are already on this case. Use the manual entry below to add anything else."}
                    </div>
                  )}
                  {available.length > 0 && (
                    <div className="space-y-1.5">
                      {available.map((item) => {
                        const checked = pickedCodes.has(item.item_code);
                        return (
                          <label
                            key={item.item_code}
                            className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm hover:bg-accent-soft/20"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                const next = new Set(pickedCodes);
                                if (next.has(item.item_code)) next.delete(item.item_code);
                                else next.add(item.item_code);
                                setPickedCodes(next);
                              }}
                              className="accent-accent"
                            />
                            <span className="font-mono text-[11px] font-medium">
                              {item.item_code}
                            </span>
                            {item.item_description && (
                              <span
                                className="flex-1 truncate text-ink-secondary"
                                title={item.item_description}
                              >
                                {item.item_description}
                              </span>
                            )}
                            {item.qty != null && item.qty > 0 && (
                              <span className="ml-auto text-[11px] text-ink-muted">
                                &times;{item.qty}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {/* Manual fallback for items not on the SO. */}
                  <div className="rounded border border-dashed border-border bg-surface/40 p-2">
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                      Or add manually (not on SO)
                    </div>
                    <div className="space-y-1.5">
                      <input
                        value={manualCode}
                        onChange={(e) => setManualCode(e.target.value)}
                        placeholder="Item code"
                        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
                      />
                      <input
                        value={manualDesc}
                        onChange={(e) => setManualDesc(e.target.value)}
                        placeholder="Description (optional)"
                        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={addPickedItems}
                      disabled={!canAdd}
                      className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                    >
                      Add
                      {pickedCodes.size > 0 && ` (${pickedCodes.size})`}
                      {manualCode.trim() && pickedCodes.size === 0 && " (1)"}
                      {manualCode.trim() && pickedCodes.size > 0 && " + 1"}
                    </button>
                    <button
                      onClick={closeAddItem}
                      className="rounded-md border border-border px-3 py-1.5 text-[11px] text-ink-secondary"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })()}
            {/* Procurement / PO — product-side info (moved out of
                Resolution, which now only holds supplier handling). */}
            <div className="mt-2 border-t border-border-subtle pt-2">
              <InlineEdit
                label="PO No"
                value={c.po_no}
                onSave={(v) => patch({ po_no: v })}
              />
              {!c.po_no && c.creditor_code && c.stage !== "completed" && (
                <button
                  onClick={async () => {
                    try {
                      const res = await api.post<{ po_no: string }>(`/api/assr/${id}/generate-po`);
                      toast.success(`Generated ${res.po_no}`);
                      detail.reload();
                      onUpdated();
                    } catch (e: any) {
                      toast.error(e?.message || "Failed to generate PO");
                    }
                  }}
                  className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
                >
                  <Plus size={12} /> Auto-generate PO number
                </button>
              )}
            </div>
          </PanelSection>

          </div>

          {/* PR 3 redesign — Stage Accordion. Wraps Verification /
              Resolution / QC Inspection / Reference & Logistics as
              accordion rows keyed by workflow stage. The row for the
              current stage auto-opens (see the useEffect on
              detail.data?.case?.stage above); click any header to
              toggle. Later PRs (4) will hide the two supplier-only
              rows for internal resolution methods. */}
          <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
            <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
              <div className="text-[13.5px] font-bold tracking-tight text-ink">Stage actions</div>
              <span className="font-mono text-[10px] text-ink-muted">click any stage to expand</span>
            </div>

            {/* pending_review — the intake gate. Body is a small
                summary; nothing to edit here beyond the initial
                complaint (captured in the Issue card above). */}
            <StageRow
              c={c}
              priorityMap={priorityMap}
              stageId="pending_review"
              title="Review"
              summary={
                c.stage === "pending_review"
                  ? "Case received & logged — awaiting Service Admin"
                  : `Case received & logged · ${
                      (detail.data?.activity ?? []).find(
                        (a: any) => a.action === "created",
                      )?.source_channel === "customer_portal"
                        ? "Customer Portal"
                        : "Service Admin"
                    } · ${formatDate(c.complained_date)}`
              }
              currentStage={c.stage}
              stages={activeStages}
              openStage={openStage}
              setOpenStage={setOpenStage}
            >
              <div className="rounded-md border border-border-subtle bg-surface px-3 py-2.5 text-[12px] text-ink-secondary">
                Case created {formatDate(c.complained_date)}
                {c.created_by_name ? ` by ${c.created_by_name}` : ""}.
                Service Admin advances the case to <b>Under Verification</b>
                {" "}on first open (or use the Workflow "Change to" dropdown above).
              </div>
            </StageRow>

            {/* pending_solution — pick resolution method + set supplier */}
            <StageRow
              c={c}
              priorityMap={priorityMap}
              stageId="pending_solution"
              title="Solution"
              summary={
                c.resolution_method
                  ? `Selected: ${resolutionLabel(c.resolution_method)}${c.creditor_name ? ` · ${c.creditor_name}` : ""}`
                  : "Set resolution method to route the case"
              }
              currentStage={c.stage}
              stages={activeStages}
              openStage={openStage}
              setOpenStage={setOpenStage}
            >
              <PanelSection title="Resolution" icon={<ClipboardCheck size={13} />}>
            <InlineEdit
              label="Resolution Method"
              value={c.resolution_method}
              options={resolutionOptions.length ? resolutionOptions : [...RESOLUTION_OPTIONS]}
              /* The one place the slug used to leak to the operator: the
                 summary above, the status card and the printed document all
                 say "Supplier Service" while this dropdown said
                 "supplier_repair" (owner 2026-08-12). Same map, one wording. */
              optionLabel={resolutionLabel}
              onSave={(v) => patch({ resolution_method: v })}
            />
            {/* Refresh — route tag chip + consequence line right under
                the resolution-method selector. Mirrors the design's
                `_resSelect()` output so ops sees whether picking this
                method routes the case to the supplier flow or keeps
                it internal, plus a one-liner spelling out what that
                means downstream. */}
            {(() => {
              const route = resolutionRoute(c.resolution_method);
              const chipCls =
                route === "supplier"
                  ? "bg-accent-soft/60 text-accent"
                  : route === "internal"
                  ? "bg-synced/15 text-synced"
                  : "bg-bg text-ink-muted";
              const chipLabel =
                route === "supplier" ? "Supplier" : route === "internal" ? "Internal" : "Route TBD";
              const consequence =
                route === "supplier"
                  ? "Supplier flow: assign a supplier · adds Supplier Pickup + Item Ready"
                  : route === "internal"
                  ? "Internal handling: own team, no supplier needed"
                  : "Select a method — it determines the supplier vs internal path";
              return (
                <div className="-mt-1 flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-bg/40 px-3 py-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider",
                      chipCls,
                    )}
                  >
                    {chipLabel}
                  </span>
                  <span className="text-[11.5px] leading-snug text-ink-secondary">
                    {consequence}
                  </span>
                </div>
              );
            })()}
            {/* Creditor — auto-derived from item_code via
                StockItem.MainSupplier, or hand-picked / registered when
                AutoCount has no MainSupplier. Manual picks are shielded
                from auto re-resolution (creditor_source='manual'). */}
            <SupplierField c={c} id={id} detail={detail} toast={toast} onUpdated={onUpdated} />
            <InlineEdit
              label="Supplier status update"
              textarea
              value={c.action_remark}
              onSave={(v) => patch({ action_remark: v })}
            />
            {/* PR 4 — pickup / supplier-handover fields moved to
                their respective stage rows so each stage has one
                canonical place. See Pending Item Pickup + Pending
                Supplier Pickup rows below. */}
            {(c.items_ready_at || attachments.some((a: any) => a?.category === "ready_doc")) && (
              <MilestoneAttachmentSlot
                caseId={id}
                category="ready_doc"
                label="Supplier Work Completion"
                emptyLabel="No completion doc yet."
                uploadLabel="Upload completion doc"
                attachments={attachments}
                archived={!!c.archived_at}
                detail={detail}
                dialog={dialog}
                toast={toast}
              />
            )}
          </PanelSection>
            </StageRow>

            {/* under_verification — QC Issue Inspection on receipt */}
            <StageRow
              c={c}
              priorityMap={priorityMap}
              stageId="under_verification"
              title="Verification"
              summary={
                c.verification_outcome === "accepted"
                  ? "Office confirms the reported issue is valid"
                  : c.verification_outcome === "rejected"
                  ? "Rejected — not our issue"
                  : c.verification_outcome === "needs_more_info"
                  ? "Awaiting more info from the customer"
                  : "Awaiting QC issue inspection"
              }
              currentStage={c.stage}
              stages={activeStages}
              openStage={openStage}
              setOpenStage={setOpenStage}
            >
              {/* Mig 081 — Verification card wraps its own PanelSection so
                  we strip the outer card wrapper by nesting it directly. */}
              <VerificationCard
                c={c}
                patch={patch}
                transition={transition}
                dialog={dialog}
                caseId={id}
                attachments={attachments}
                archived={!!c.archived_at}
                detail={detail}
                toast={toast}
                hideHeader
              />
            </StageRow>

            {/* pending_supplier_pickup — the whole supplier leg since mig
                0110: we collect from the customer, the supplier collects
                from us, and the supplier brings it back. */}
            <StageRow
              c={c}
              priorityMap={priorityMap}
              stageId="pending_supplier_pickup"
              title="Supplier Pickup / Return"
              summary={
                c.supplier_pickup_at
                  ? `Supplier collected ${formatDate(c.supplier_pickup_at)}`
                  : "Awaiting supplier handover"
              }
              currentStage={c.stage}
              stages={activeStages}
              openStage={openStage}
              setOpenStage={setOpenStage}
            >
              <div className="space-y-2.5 rounded-md border border-border-subtle bg-surface px-3 py-2.5">
                {/* Folded in from the retired Item Pickup stage (mig 0110):
                    the date logistics collects the faulty item from the
                    customer's house — precedes the supplier handover. */}
                {/* Pickup by (Nico 2026-08-07) — who collects the faulty
                    item. Customer pickup = our logistics goes to the
                    customer's house (fires the Delivery-sheet PICKUP job);
                    Supplier direct = the supplier collects it themselves. */}
                <div className="flex items-center gap-2">
                  <span className="w-[130px] shrink-0 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                    Pickup by
                  </span>
                  <div className="flex gap-1.5">
                    {([
                      { v: "customer", label: "Customer pickup" },
                      { v: "supplier", label: "Supplier direct" },
                    ] as const).map((o) => (
                      <button
                        key={o.v}
                        type="button"
                        onClick={() => patch({ pickup_by: c.pickup_by === o.v ? null : o.v })}
                        className={cn(
                          "rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                          c.pickup_by === o.v
                            ? "border-primary bg-primary-soft text-primary"
                            : "border-border bg-surface text-ink-secondary hover:border-primary/40",
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
                <InlineEdit
                  label="Customer Pickup Date"
                  type="date"
                  value={c.customer_pickup_at}
                  onSave={(v) => patch({ customer_pickup_at: v || null })}
                />
                <InlineEdit
                  label="Supplier Pickup Date"
                  type="date"
                  value={c.supplier_pickup_at}
                  onSave={(v) => patch({ supplier_pickup_at: v || null })}
                />
                {/* Nick 2026-07-05 — the return leg lives here too:
                    when the supplier brings the item back. Same field
                    the Item Ready QC reads (items_ready_at). */}
                <InlineEdit
                  label="Supplier Return Date"
                  type="date"
                  value={c.items_ready_at}
                  onSave={(v) => patch({ items_ready_at: v || null })}
                />
                {/* Mig 106 — send-out slip that goes with the item
                    when supplier collects. Supplier sees this on
                    their portal (read-only). */}
                <InlineEdit
                  label="Goods Returned Note"
                  textarea
                  value={c.goods_returned_note}
                  onSave={(v) => patch({ goods_returned_note: v })}
                  placeholder="What's leaving with the supplier (contents, condition, expected fix)"
                />
                {(c.supplier_pickup_at || attachments.some((a: any) => a?.category === "pickup_form")) && (
                  <MilestoneAttachmentSlot
                    caseId={id}
                    category="pickup_form"
                    label="Pickup Form / Consignment Note"
                    emptyLabel="No pickup form yet."
                    uploadLabel="Upload pickup form"
                    attachments={attachments}
                    archived={!!c.archived_at}
                    detail={detail}
                    dialog={dialog}
                    toast={toast}
                  />
                )}
              </div>
            </StageRow>

            {/* pending_item_ready — QC Inspection after supplier return */}
            <StageRow
              c={c}
              priorityMap={priorityMap}
              stageId="pending_item_ready"
              title="Pending Item Ready"
              summary={
                c.inspection_result
                  ? `QC: ${c.inspection_result}${c.items_ready_at ? ` · ready ${formatDate(c.items_ready_at)}` : ""}`
                  : "Awaiting supplier return + QC"
              }
              currentStage={c.stage}
              stages={activeStages}
              openStage={openStage}
              setOpenStage={setOpenStage}
            >
              <InspectionCard
                c={c}
                patch={patch}
                caseId={id}
                attachments={attachments}
                archived={!!c.archived_at}
                detail={detail}
                dialog={dialog}
                toast={toast}
                hideHeader
              />
            </StageRow>

            {/* pending_delivery_service — logistics rows + related POs */}
            <StageRow
              c={c}
              priorityMap={priorityMap}
              stageId="pending_delivery_service"
              title="Delivery"
              summary={
                logistics.length
                  ? `${logistics.length} logistics ${logistics.length === 1 ? "trip" : "trips"}`
                  : "Schedule delivery / on-site service"
              }
              currentStage={c.stage}
              stages={activeStages}
              openStage={openStage}
              setOpenStage={setOpenStage}
            >
              <CollapsibleBlock title="Reference & Logistics">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {([
                ["SO", c.doc_no, true],
                // Hand-entered DO wins; do_numbers = the server-resolved
                // AutoCount/SCM linkage (same precedence as the list).
                ["DO", c.delivery_order || c.do_numbers, true],
                ["DO date", formatDate(c.do_date), false],
                ["PO", c.po_no, true],
                ["Location", c.location, false],
                ["Category", c.service_category, false],
              ] as const).map(([label, val, mono]) => (
                <div key={label}>
                  <div className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
                  <div className={cn("text-[12.5px] text-ink", mono && "font-mono text-[11.5px]")}>{val || "—"}</div>
                </div>
              ))}
            </div>

          {/* Logistics */}
          {(c.stage === "pending_supplier_pickup" || c.stage === "pending_item_ready" || c.stage === "pending_delivery_service" || c.stage === "completed" || logistics.length > 0) && (
            <PanelSection title={`Logistics (${logistics.length})`}>
              {logistics.map((l) => (
                <LogisticsRow
                  key={l.id}
                  l={l}
                  caseId={id}
                  archived={!!c.archived_at}
                  users={userOptions}
                  attachments={attachments}
                  detail={detail}
                  dialog={dialog}
                  toast={toast}
                />
              ))}
              {c.stage !== "completed" && !showAddLogistics && (
                <button
                  onClick={() => setShowAddLogistics(true)}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
                >
                  <Plus size={12} /> Schedule Pickup / Delivery
                </button>
              )}
              {showAddLogistics && (
                <LogisticsForm
                  assrId={id}
                  users={userOptions}
                  onCreated={() => { setShowAddLogistics(false); detail.reload(); }}
                  onCancel={() => setShowAddLogistics(false)}
                  toast={toast}
                />
              )}
            </PanelSection>
          )}

          {/* Related POs */}
          {relatedPOs.length > 0 && (
            <PanelSection title={`Related POs (${relatedPOs.length})`}>
              <div className="space-y-1">
                {relatedPOs.map((po) => (
                  <div key={po.id} className="flex items-start gap-2 rounded border border-border px-3 py-2 text-sm">
                    <Package size={12} className="mt-0.5 shrink-0 text-ink-muted" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] font-medium">{po.doc_no}</span>
                        {po.doc_date && (
                          <span className="text-[10px] text-ink-muted">{formatDate(po.doc_date)}</span>
                        )}
                      </div>
                      <div
                        className="truncate text-[11px] text-ink-secondary"
                        title={`${po.item_code}${po.item_description ? ` — ${po.item_description}` : ""}`}
                      >
                        {po.item_code} {po.item_description ? `— ${po.item_description}` : ""}
                      </div>
                      {po.creditor_name && (
                        <div className="text-[10px] text-ink-muted">{po.creditor_name}</div>
                      )}
                      {po.supplier_date1 && (
                        <div className="text-[10px] text-ink-muted">
                          Supplier date: {formatDate(po.supplier_date1)}
                        </div>
                      )}
                    </div>
                    {po.remaining_qty != null && (
                      <span className="shrink-0 text-[10px] text-ink-muted">
                        Rem: {po.remaining_qty}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </PanelSection>
          )}
              </CollapsibleBlock>
            </StageRow>

            {/* completed — closed case summary */}
            <StageRow
              c={c}
              priorityMap={priorityMap}
              stageId="completed"
              title="Completed"
              summary={
                c.stage === "completed"
                  ? c.satisfaction_rating
                    ? `Closed · ${c.satisfaction_rating}/5 CSAT`
                    : "Closed"
                  : "Not closed yet"
              }
              currentStage={c.stage}
              stages={activeStages}
              openStage={openStage}
              setOpenStage={setOpenStage}
            >
              {c.stage === "completed" ? (
                <div className="rounded-md border border-synced/30 bg-synced/5 px-3 py-2.5 text-[12px] text-ink-secondary">
                  Case closed on{" "}
                  <b>{formatDate(c.closed_at || c.completion_date)}</b>.
                  {c.satisfaction_rating != null && (
                    <>
                      {" "}Customer CSAT: <b>{c.satisfaction_rating} / 5</b>.
                    </>
                  )}
                  {c.satisfaction_notes && (
                    <>
                      {" "}"{c.satisfaction_notes}"
                    </>
                  )}
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-border bg-surface px-3 py-2.5 text-[12px] text-ink-muted">
                  Case not closed yet. Use the "Close Case" button
                  in the top-right of the page once delivery is done.
                </div>
              )}
            </StageRow>

          </div>

            </DetailMain>

            <DetailAside>
          {/* Right rail per design: Customer · Assigned to · SLA · Timeline. */}
          <PanelSection
            title="Customer"
            icon={<User size={13} />}
            action={
              <button
                type="button"
                onClick={() => setCustEditing((e) => !e)}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[10.5px] font-semibold transition-colors",
                  custEditing
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-surface text-ink-secondary hover:border-primary/40 hover:text-primary"
                )}
              >
                {custEditing ? "Done" : "Edit"}
              </button>
            }
          >
            {custEditing ? (
            <>
              {/* Edit view — the full InlineEdit set. Correcting the SO No
                  re-matches customer info from the local SO mirror
                  server-side; the address textarea maps line-by-line onto
                  addr1-4. */}
              <InlineEdit
                label="Customer"
                value={c.customer_name}
                onSave={(v) => patch({ customer_name: v })}
                placeholder="Customer name"
              />
              <InlineEdit
                label="Agent"
                value={c.sales_agent}
                onSave={(v) => patch({ sales_agent: v })}
                placeholder="Sales rep"
              />
              {/* SO + Ref side by side — mirrors the read view's twin
                  chips (Nick 2026-07-23). Ref No is a plain editable
                  field (the SO re-match fills it only on SO change). */}
              <div className="grid grid-cols-2 gap-2">
                <SoNoSearchEdit value={c.doc_no} onSave={(v) => patch({ doc_no: v })} />
                <InlineEdit
                  label="Ref No"
                  value={c.ref_no}
                  onSave={(v) => patch({ ref_no: v })}
                  placeholder="e.g. DLPG 0285"
                />
              </div>
              <InlineEdit
                label="Phone"
                value={c.phone}
                onSave={(v) => patch({ phone: v })}
                placeholder="012-345 6789"
              />
              <InlineEdit
                label="Customer address"
                textarea
                value={[c.addr1, c.addr2, c.addr3, c.addr4].filter(Boolean).join("\n")}
                onSave={(v) => {
                  const lines = (v || "")
                    .split(/\r?\n/)
                    .map((t) => t.trim())
                    .filter(Boolean);
                  return patch({
                    addr1: lines[0] ?? null,
                    addr2: lines[1] ?? null,
                    addr3: lines[2] ?? null,
                    addr4: lines.slice(3).join(", ") || null,
                  });
                }}
                placeholder={"Street / unit\nCity - postcode\nState"}
              />
              <InlineEdit
                label="Location"
                value={c.location}
                onSave={(v) => patch({ location: v })}
                placeholder="State / outlet"
              />
              <InlineEdit
                label="Email"
                value={c.customer_email}
                onSave={(v) => patch({ customer_email: v })}
                placeholder="customer@example.com"
              />
              <FieldRow label="Created">
                {formatDate(c.complained_date)}
                {c.created_by_name ? ` · by ${c.created_by_name}` : ""}
              </FieldRow>
            </>
            ) : (
            <>
              {/* Read view — mirrors the .dc.html reference: identity row,
                  SO/Ref chips, phone row with call, address + location chip. */}
              <div className="flex items-center gap-3">
                <span className="flex h-[42px] w-[42px] shrink-0 select-none items-center justify-center rounded-[11px] bg-primary-soft text-[15px] font-bold text-primary-ink">
                  {(c.customer_name || "?")
                  .split(/\s+/)
                  .map((w: string) => w[0])
                  .filter(Boolean)
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[16px] font-bold leading-tight text-ink">
                    {c.customer_name || "—"}
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-muted">
                    Agent · <b className="font-semibold text-ink-secondary">{c.sales_agent || "—"}</b>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border-subtle bg-bg/60 px-2.5 py-2">
                  <div className="font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">SO No</div>
                  <div className="mt-1 truncate font-mono text-[13px] font-semibold text-primary-ink">{c.doc_no || "—"}</div>
                </div>
                <div className="rounded-md border border-border-subtle bg-bg/60 px-2.5 py-2">
                  <div className="font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">Ref No</div>
                  <div className="mt-1 truncate font-mono text-[13px] font-semibold text-ink">{c.ref_no || "—"}</div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-2.5">
                <div className="min-w-0">
                  <div className="font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">Phone</div>
                  <div className="mt-1 font-mono text-[13.5px] font-semibold text-ink">{formatPhone(c.phone) || "—"}</div>
                </div>
                {c.phone && (
                  <a
                    href={`tel:${String(c.phone).replace(/[^+\d]/g, "")}`}
                    className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-ink transition-colors hover:bg-primary hover:text-white"
                    title="Call customer"
                    aria-label="Call customer"
                  >
                    <Phone size={14} />
                  </a>
                )}
              </div>
              <div className="border-t border-border-subtle pt-2.5">
                <div className="font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">Customer address</div>
                <div className="mt-1 text-[13px] font-medium leading-relaxed text-ink">
                  {[c.addr1, c.addr2, c.addr3, c.addr4].filter(Boolean).join(", ") || "—"}
                </div>
                {c.location && (
                  <span className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary-soft px-2.5 py-1 text-[11.5px] font-semibold text-primary-ink">
                    <MapPin size={11} />
                    {c.location}
                  </span>
                )}
              </div>
              {(c.customer_email || c.complained_date || c.created_by_name) && (
                <div className="space-y-1 border-t border-border-subtle pt-2">
                  {c.customer_email && <FieldRow label="Email">{c.customer_email}</FieldRow>}
                  <FieldRow label="Created">
                    {formatDate(c.complained_date)}
                    {c.created_by_name ? ` · by ${c.created_by_name}` : ""}
                  </FieldRow>
                </div>
              )}
            </>
            )}
          </PanelSection>

          {/* Assigned To — Design PR 2. Unassigned uses a dashed
              amber placeholder so it reads as "attention needed" from
              across the page; picking a user snaps to the standard
              filled select. */}
          <PanelSection title="Assigned to" icon={<UserPlus size={13} />}>
            {/* Searchable A→Z multi-select, max 2 — first pick is the
                primary assignee, second the co-assignee. Unassigned
                keeps the amber "attention needed" treatment via the
                warning row below. */}
            <UserMultiSelect
              value={[c.assigned_to, c.assigned_to_2].filter((n): n is number => n != null)}
              selectedItems={assignedItems}
              filterOption={(u) => /operation/i.test(u.department_name || "")}
              onChange={(ids) =>
                patch({ assigned_to: ids[0] ?? null, assigned_to_2: ids[1] ?? null })
              }
              max={2}
              placeholder="Unassigned — search to assign"
            />
            {c.assigned_to == null && (
              <div className="mt-1.5 rounded-md border border-dashed border-amber-500/60 bg-amber-50/60 px-2 py-1 text-[11px] font-semibold text-amber-800">
                Needs an assignee
              </div>
            )}
          </PanelSection>

          {/* SLA — Design PR 2. Full red card + big mono countdown +
              progress bar when overdue. The subtitle keeps the deadline
              date and priority tier for context. */}
          {(() => {
            const closed = c.stage === "completed";
            const breached = !closed && c.is_breached === 1;
            const hasSla = c.deadline_at != null;
            const h = c.hours_to_deadline ?? 0;
            const absH = Math.abs(h);
            const days = Math.floor(absH / 24);
            const hours = Math.round(absH - days * 24);
            const value = closed
              ? "Closed"
              : !hasSla
              ? "No SLA set"
              : `${days > 0 ? `${days}d ` : ""}${hours}h`;
            const label = closed
              ? ""
              : !hasSla
              ? ""
              : breached
              ? "Overdue by"
              : "Time left";
            const slaHours = c.sla_hours ?? 168;
            const fillPct = closed
              ? 0
              : breached
              ? 100
              : hasSla
              ? Math.min(100, Math.max(0, 100 - (h / slaHours) * 100))
              : 0;
            return (
              <div
                className={cn(
                  "mb-3 rounded-lg border px-5 py-4 shadow-stone",
                  breached ? "border-err/40 bg-err/5" : "border-border bg-surface",
                )}
              >
                <div className="mb-3 flex items-center justify-between">
                  <div
                    className={cn(
                      "flex items-center gap-1.5 text-[13px] font-bold",
                      breached ? "text-err" : "text-ink",
                    )}
                  >
                    <Clock size={13} /> SLA
                  </div>
                  {breached && (
                    <span className="rounded bg-err px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-white">
                      Overdue
                    </span>
                  )}
                  {closed && (
                    <span className="rounded bg-synced/15 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-synced">
                      Closed
                    </span>
                  )}
                </div>
                <div className="flex items-baseline justify-between">
                  <span
                    className={cn(
                      "text-[12px]",
                      breached ? "text-err/80" : "text-ink-secondary",
                    )}
                  >
                    {label || "SLA"}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-[20px] font-semibold leading-none",
                      breached ? "text-err" : closed ? "text-synced" : "text-ink",
                    )}
                  >
                    {value}
                  </span>
                </div>
                {hasSla && !closed && (
                  <>
                    <div
                      className={cn(
                        "mt-2.5 h-2 overflow-hidden rounded-full",
                        breached ? "bg-err/15" : "bg-border",
                      )}
                    >
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          breached ? "bg-err" : "bg-synced",
                        )}
                        style={{ width: `${fillPct}%` }}
                      />
                    </div>
                    <div
                      className={cn(
                        "mt-2 text-[11px]",
                        breached ? "text-err/70" : "text-ink-muted",
                      )}
                    >
                      Due {formatDate(c.deadline_at)} ·{" "}
                      <span className="capitalize">{c.priority}</span> tier
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {/* Timeline — chronological log of stage changes, notes,
              customer comments, escalations, etc. Add-note form is
              behind the header button so the timeline reads cleanly. */}
          <section className="mb-3 rounded-lg border border-border bg-surface px-4 py-3.5 shadow-stone">
            <div className="mb-3 flex items-center gap-2">
              <Clock size={13} className="shrink-0 text-ink-muted" />
              <h3 className="flex-1 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
                Timeline
              </h3>
              {!c.archived_at && (
                <button
                  onClick={() => setNoteFormOpen((x) => !x)}
                  className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white shadow-sm hover:bg-accent/90"
                >
                  <Plus size={11} /> Add Note
                </button>
              )}
            </div>

            {/* Add-note form — toggled by the header button. Stays
                compact so it doesn't push the timeline below the fold. */}
            {noteFormOpen && !c.archived_at && (
              <div className="mb-3 rounded-md border border-accent/30 bg-accent-soft/15 p-2">
                <div className="mb-2 flex items-center gap-2">
                  <select
                    value={noteCategory}
                    onChange={(e) => setNoteCategory(e.target.value as AssrNoteAudience)}
                    className="rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] font-semibold outline-none focus:border-primary"
                    title="Where this note is visible"
                  >
                    {/* Shared with mobile (vendor/scm/lib/assr/case-fields). The
                        two lists had already drifted on the one label that
                        matters: this side promised "Customer-visible", the phone
                        said only "Customer". */}
                    {ASSR_NOTE_AUDIENCES.map((a) => (
                      <option key={a.value} value={a.value}>{a.label}</option>
                    ))}
                  </select>
                  <span className="text-[10px] text-ink-muted">
                    {assrNoteIsCustomerVisible(noteCategory)
                      ? "The customer will see this note on the portal."
                      : "Internal only — hidden from the customer."}
                  </span>
                </div>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addNote();
                  }}
                  placeholder={
                    assrNoteIsCustomerVisible(noteCategory)
                      ? "Write a note for the customer…"
                      : "Internal note…"
                  }
                  rows={2}
                  className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] outline-none focus:border-primary"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => {
                      setNote("");
                      setNoteFormOpen(false);
                    }}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink-secondary hover:text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={addNote}
                    disabled={!note.trim()}
                    className="ml-auto rounded-md bg-accent px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-white disabled:opacity-50"
                  >
                    Post note
                  </button>
                </div>
              </div>
            )}

            {/* Filter tabs — Design PR 2. Roles reflect who authored the
                activity (Service = internal, Customer = via customer
                portal, Supplier = via supplier portal, Sales = via the
                sales portal link). */}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {(
                [
                  { value: "all" as const, label: "All" },
                  { value: "system" as const, label: "System" },
                  { value: "service" as const, label: "Service" },
                  { value: "customer" as const, label: "Customer" },
                  { value: "supplier" as const, label: "Supplier" },
                  { value: "sales" as const, label: "Sales" },
                ]
              ).map((opt) => {
                const active = activityFilter === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setActivityFilter(opt.value)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors",
                      active
                        ? "bg-primary text-white"
                        : "border border-border bg-bg text-ink-muted hover:text-ink",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {/* Timeline list. A vertical guide runs down the left edge;
                each row anchors to a small ring marker so the eye can
                trace the case's history at a glance. */}
            {(() => {
              // Design PR 2 — derive an actor role from source_channel /
              // action so the filter tabs and the per-entry pill agree.
              const roleOf = (a: any): "customer" | "supplier" | "service" | "sales" | "system" => {
                // The stored category is authoritative (four buckets +
                // system since mig 0108); the channel inference below
                // only backstops legacy rows without one.
                const cat = String(a.category || "").toLowerCase();
                if (cat === "purchasing") return "service";
                if (
                  cat === "service" ||
                  cat === "customer" ||
                  cat === "supplier" ||
                  cat === "sales" ||
                  cat === "system"
                ) {
                  return cat;
                }
                const ch = a.source_channel;
                if (a.source === "sales" || a.action === "sales_comment" || a.action === "sales_upload") return "sales";
                if (ch === "customer_portal" || a.source === "customer" || a.action === "customer_comment") return "customer";
                if (ch === "supplier_portal") return "supplier";
                return "service";
              };
              const filtered = activity.filter((a: any) => {
                if (activityFilter === "all") return true;
                return roleOf(a) === activityFilter;
              });
              // Service-form photo relay notes carry a long provenance
              // string ending in the [gdrive:...] dedup marker (which
              // must stay in the DB — the relay dedups on it). Collapse
              // consecutive ones into a single compact entry and strip
              // the marker for display.
              // Backend notes embed the R2 storage key — a UUID filename
              // that reads as garbage (Nico 2026-08-01: 乱码). Swap each
              // for a friendly kind derived from the extension.
              const prettifyText = (t: string): string =>
                t.replace(
                  /\(?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.([a-z0-9]+))?\)?/gi,
                  (_m, ext) => {
                    const e = String(ext || "").toLowerCase();
                    if (["mov", "mp4", "webm", "m4v", "avi"].includes(e)) return "(video)";
                    if (["jpg", "jpeg", "png", "webp", "gif", "heic"].includes(e)) return "(photo)";
                    return "(file)";
                  },
                );
              const photoImportFile = (a: any): string | null => {
                const m = /^Photo migrated from Google Form history(?::\s*(.*?))?\s*\[gdrive:[^\]]+\]$/.exec(
                  String(a.note || "").trim()
                );
                return m ? (m[1] || "photo") : null;
              };
              const rows: any[] = [];
              for (const a of filtered) {
                const file = photoImportFile(a);
                const prev = rows[rows.length - 1];
                if (file !== null && prev?.__photoImports) {
                  prev.__photoImports.push(file);
                } else if (file !== null) {
                  rows.push({ ...a, __photoImports: [file] });
                } else {
                  rows.push(a);
                }
              }
              if (rows.length === 0) {
                return (
                  <div className="text-[12px] text-ink-muted">
                    No activity yet
                  </div>
                );
              }
              return (
                // Bounded, self-scrolling timeline — a long history scrolls
                // inside this box instead of stretching the whole page.
                <div className="max-h-[65vh] overflow-y-auto overflow-x-hidden pr-1">
                <ol className="relative space-y-3 pl-5">
                  <span className="pointer-events-none absolute left-[7px] top-1.5 bottom-1.5 w-px bg-border" />
                  {rows.map((a: any) => {
                    const author =
                      a.source === "customer"
                        ? a.customer_name_display || a.customer_email || "Customer"
                        : a.source === "sales"
                          ? c.sales_agent || "Sales"
                          : a.user_name || "System";
                    const isEscalated = a.action === "escalated";
                    const isCustomer = a.source === "customer";
                    const archivable =
                      !c.archived_at &&
                      !a.__photoImports &&
                      (a.action === "note" || a.action === "customer_comment" || a.action === "sales_comment");
                    let title: React.ReactNode = a.action;
                    let body: React.ReactNode = null;
                    if (a.__photoImports) {
                      const n = a.__photoImports.length;
                      title = n > 1 ? `${n} photos imported from service form` : "Photo imported from service form";
                      body = a.__photoImports.join("\n");
                    } else switch (a.action) {
                      case "stage_change":
                        title = (
                          <>
                            Status changed to{" "}
                            <span className="font-bold">
                              {caseStageLabel(a.to_value || "")}
                            </span>
                          </>
                        );
                        if (a.note) body = a.note;
                        break;
                      case "sub_status_change":
                        title = (
                          <>
                            Sub-status changed to{" "}
                            <span className="font-bold">{assrSubStatusLabel(a.to_value)}</span>
                          </>
                        );
                        break;
                      case "note":
                        // Title is redundant — the CUSTOMER/PURCHASING
                        // pill on the "by" row already says which kind.
                        // The note body becomes the prominent line.
                        title = null;
                        body = a.note;
                        break;
                      case "created":
                        title = "Case created";
                        if (a.note) body = a.note;
                        break;
                      case "assignment":
                        title = `Assigned to ${
                          userOptions.find((u) => String(u.id) === a.to_value)
                            ?.name || `user #${a.to_value}`
                        }`;
                        break;
                      case "assignment_2":
                        title = a.to_value
                          ? `Co-assignee set to ${
                              userOptions.find((u) => String(u.id) === a.to_value)
                                ?.name || `user #${a.to_value}`
                            }`
                          : "Co-assignee cleared";
                        break;
                      case "approval":
                        title = (
                          <>
                            Quality review:{" "}
                            <span className="font-bold">
                              {a.to_value === "passed" ? "Passed" : "Reviewed"}
                            </span>
                          </>
                        );
                        break;
                      case "po_generated":
                        title = (
                          <>
                            PO generated:{" "}
                            <span className="font-mono font-bold">
                              {a.to_value}
                            </span>
                          </>
                        );
                        break;
                      case "escalated":
                        title = "Case escalated — SLA breached >24h";
                        break;
                      case "survey_submitted":
                        title = (
                          <>
                            Satisfaction survey ·{" "}
                            <span className="font-bold">{a.to_value}/5</span>
                          </>
                        );
                        if (a.note) body = a.note;
                        break;
                      case "customer_comment":
                        // Same reasoning as 'note' — the customer-coloured
                        // ring marker + author "Customer" already convey
                        // the kind. Comment body becomes the headline.
                        title = null;
                        body = a.note;
                        break;
                      case "customer_upload":
                        title = "Photo uploaded";
                        if (a.note) body = a.note;
                        break;
                      case "sales_comment":
                        // Same reasoning as customer_comment — the pill
                        // already says Sales; the comment is the headline.
                        title = null;
                        body = a.note;
                        break;
                      case "sales_upload":
                        title = "Photo uploaded";
                        if (a.note) body = a.note;
                        break;
                      default:
                        // Backend-logged audit actions we don't special-case
                        // (field_change, item_remark, item_added/removed,
                        // attachment_*, logistics_*, …). Their note is a full
                        // human sentence — show it so the timeline is a
                        // complete, reviewable history of everything done.
                        if (a.note) {
                          title = null;
                          body = a.note;
                        }
                        break;
                    }
                    if (typeof body === "string") body = prettifyText(body);
                    const actorRole = roleOf(a);
                    return (
                      <li key={a.id} className="group relative">
                        <span
                          className={cn(
                            "absolute -left-5 top-1 h-3.5 w-3.5 rounded-full border-2 bg-surface",
                            isEscalated
                              ? "border-err"
                              : actorRole === "customer"
                                ? "border-amber-500"
                                : actorRole === "supplier"
                                  ? "border-primary"
                                  : actorRole === "sales"
                                    ? "border-accent"
                                    : "border-border"
                          )}
                        />
                        <div className="flex items-center gap-2 text-[10.5px] text-ink-muted">
                          <span>{formatDateTime(a.created_at)}</span>
                          {archivable && (
                            <button
                              onClick={async () => {
                                if (!(await dialog.confirm("Archive this entry?")))
                                  return;
                                try {
                                  await api.post(
                                    `/api/assr/activity/${a.id}/archive`
                                  );
                                  toast.success("Archived");
                                  detail.reload();
                                } catch (e: any) {
                                  toast.error(e?.message || "Something went wrong. Please try again.");
                                }
                              }}
                              className="ml-auto rounded p-0.5 text-ink-muted opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
                              title="Archive entry"
                            >
                              <Trash2 size={10} />
                            </button>
                          )}
                        </div>
                        {title && (
                          <div
                            className={cn(
                              "text-[12.5px] font-bold",
                              isEscalated ? "text-err" : "text-ink"
                            )}
                          >
                            {title}
                          </div>
                        )}
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-muted">
                          <span
                            className={cn(
                              "rounded px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider",
                              actorRole === "customer" && "bg-amber-100 text-amber-800",
                              actorRole === "supplier" && "bg-primary/10 text-primary",
                              actorRole === "sales" && "bg-accent-soft text-accent",
                              actorRole === "service" && "bg-bg text-ink-secondary",
                              actorRole === "system" && "border border-border-subtle bg-bg text-ink-muted",
                            )}
                          >
                            {{ service: "Service", customer: "Customer", supplier: "Supplier", sales: "Sales", system: "System" }[actorRole]}
                          </span>
                          <span>by {author}</span>
                        </div>
                        {body && (
                          <div
                            className={cn(
                              "mt-1 whitespace-pre-line",
                              title
                                ? "text-[12px] text-ink-secondary"
                                : "text-[12.5px] text-ink"
                            )}
                          >
                            {body}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
                </div>
              );
            })()}
          </section>

          {/* Cost / Quality / CSAT — folded by default (v2); relevant
              mostly at sign-off / close. */}
          {/* Satisfaction (shown when completed) */}
          {c.stage === "completed" && (
            <PanelSection title="Customer Satisfaction">
              {c.satisfaction_rating ? (
                <>
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star
                        key={n}
                        size={16}
                        className={n <= c.satisfaction_rating! ? "fill-amber-400 text-amber-400" : "text-ink-muted"}
                      />
                    ))}
                    <span className="ml-2 text-sm font-semibold">{c.satisfaction_rating}/5</span>
                  </div>
                  {c.satisfaction_notes && (
                    <div className="mt-2 text-[12px] text-ink-secondary">{c.satisfaction_notes}</div>
                  )}
                </>
              ) : (
                <div className="text-[12px] text-ink-muted">No rating yet. Send the customer a survey link:</div>
              )}
              <SurveyLinkButton id={id} toast={toast} />
            </PanelSection>
          )}
            </DetailAside>
          </DetailGrid>
        </>
      )}

      {lightboxIndex !== null && attachments[lightboxIndex] && (
        <StaffLightbox
          attachments={attachments as any[]}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </DetailLayout>
  );
}

/**
 * Page wrapper — mounted at /assr/:id. Reads the URL, hands the inner
 * content the case id and a no-op `onUpdated` (the page owns its own
 * queries).
 */
export function ServiceCaseDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = idStr ? parseInt(idStr, 10) : NaN;
  const toast = useToast();

  if (isNaN(id)) return <Navigate to="/assr" replace />;

  return <DetailContent id={id} onUpdated={() => {}} toast={toast} />;
}

// ── Customer history ─────────────────────────────────────────
// Surfaces prior cases for the same customer (matched on phone if
// available, else exact name) so staff can spot repeat complaints
// before promising a fix.

type CustomerHistoryRow = {
  id: number;
  assr_no: string;
  doc_no: string;
  stage: AssrStage;
  status: string | null;
  priority: string | null;
  complaint_issue: string | null;
  complained_date: string | null;
  created_at: string | null;
  item_code: string | null;
  resolution_method: string | null;
};

// ── Issue Category picker ────────────────────────────────────
// Five canonical categories + "Other" which prompts for a custom
// label. Stored as plain text on the case so existing free-text
// values still display; selecting "Other" lets ops capture niche
// cases without locking them into the standard set.
//
// The five live in vendor/scm/lib/assr/case-fields — mobile carried an
// identical second copy, which is what the note-audience labels looked like
// the day before THEY drifted.

const OTHER_SENTINEL = "__other__";

// ── Stage auto-advance (TODO item 5) ───────────────────────────
// Each non-completed stage has a "completion predicate" — when it goes
// from unsatisfied to satisfied, prompt the user to advance. They keep
// the existing manual override (Next stage button + stage chip menu).
//
// Row 2 (Under Verification → Pending Solution) is intentionally NOT in
// this table — VerificationCard owns it because the predicate is an
// explicit acceptance decision rather than a field-fill, and it has
// side-paths (rejected/needs_more_info) the other rows don't have.

interface StagePredicate {
  next: AssrStage;
  satisfied: boolean;
  label: string;
}

function getStageAdvancePredicate(
  c: AssrCase,
  logistics: any[]
): StagePredicate | null {
  const activeLog = (logistics ?? []).filter((l) => !l.archived_at);
  switch (c.stage) {
    case "pending_review":
      return {
        next: "under_verification",
        satisfied: !!(c.complaint_issue?.trim() && c.issue_category && c.priority),
        label: "Issue card complete",
      };
    case "pending_solution":
      return {
        next: "pending_supplier_pickup",
        satisfied: !!(c.resolution_method && c.po_no && c.action_remark?.trim()),
        label: "Resolution card complete",
      };
    case "pending_supplier_pickup":
      return {
        next: "pending_item_ready",
        satisfied: !!c.items_ready_at,
        label: "Items ready date set",
      };
    case "pending_item_ready":
      return {
        next: "pending_delivery_service",
        satisfied: activeLog.some((l) => l.scheduled_date),
        label: "Delivery scheduled",
      };
    case "pending_delivery_service":
      return {
        next: "completed",
        satisfied: activeLog.some(
          (l) => l.type === "delivery" && l.status === "completed"
        ),
        label: "Delivery completed",
      };
    default:
      return null;
  }
}

function useStageAutoAdvance({
  c,
  logistics,
  transition,
  dialog,
}: {
  c: AssrCase | undefined;
  logistics: any[];
  transition: (stage: AssrStage) => Promise<void>;
  dialog: ReturnType<typeof useDialog>;
}) {
  const lastRef = useRef<{
    caseId: number;
    stage: string;
    satisfied: boolean;
  } | null>(null);

  // Stable key derived from the fields that any predicate cares about.
  // Limited to those so unrelated patches (e.g. issuing a PO note) don't
  // re-run the effect.
  const key = useMemo(() => {
    if (!c) return "";
    return JSON.stringify({
      id: c.id,
      stage: c.stage,
      complaint: c.complaint_issue ?? "",
      cat: c.issue_category ?? "",
      prio: c.priority ?? "",
      res: c.resolution_method ?? "",
      po: c.po_no ?? "",
      act: c.action_remark ?? "",
      sp: c.supplier_pickup_at ?? "",
      ir: c.items_ready_at ?? "",
      log: (logistics ?? [])
        .filter((l) => !l.archived_at)
        .map(
          (l) =>
            `${l.id}|${l.type}|${l.status}|${l.scheduled_date ?? ""}`
        )
        .join(";"),
    });
  }, [c, logistics]);

  useEffect(() => {
    if (!c) return;
    const p = getStageAdvancePredicate(c, logistics);
    if (!p) {
      lastRef.current = null;
      return;
    }
    const last = lastRef.current;
    const sameCaseAndStage =
      last && last.caseId === c.id && last.stage === c.stage;

    if (!sameCaseAndStage) {
      // First sighting of this case/stage: set baseline silently so we
      // don't pop the modal on initial mount of an already-ready case.
      lastRef.current = {
        caseId: c.id,
        stage: c.stage,
        satisfied: p.satisfied,
      };
      return;
    }

    const wasSatisfied = last!.satisfied;
    lastRef.current = {
      caseId: c.id,
      stage: c.stage,
      satisfied: p.satisfied,
    };

    if (p.satisfied && !wasSatisfied) {
      (async () => {
        const nextName = stageLabel(p.next);
        const ok = await dialog.confirm(
          `${p.label}. Advance the case to ${nextName}?`
        );
        if (ok) {
          await transition(p.next);
        }
      })();
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ── Verification card ──────────────────────────────────────────
// Mig 081. The Under Verification → Pending Solution transition is the
// only stage gate that's a true judgement call (everything else fires
// off a date/text field being filled). Three outcomes:
//
//   accepted        → real defect we'll fix. When root cause is also
//                     filled, prompt to advance the stage.
//   rejected        → not our issue. Prompt to short-circuit to Completed.
//   needs_more_info → wait on the customer; case stays put.
//
// `verified_at` / `verified_by` are server-stamped on PATCH, so the
// timestamp can't drift from the actor.

const VERIFICATION_OPTIONS = [
  { value: "accepted", label: "Accepted", tone: "ok" as const },
  { value: "needs_more_info", label: "Needs more info", tone: "warn" as const },
  { value: "rejected", label: "Rejected", tone: "err" as const },
];

// ── Detail top-of-page redesign (PR 1) ─────────────────────────
// Two card components lifted from `Service Case Detail — Redesign.dc.html`:
// a numbered workflow tracker with an inline "Change to" dropdown, and a
// 5-cell status summary bar. The full accordion + resolution-driven flow
// filtering land in later PRs; this PR only refreshes the header strip.

// READ from the canonical table, never retyped. This WAS a sixth hand-written
// copy of the stage vocabulary and four of its rows had drifted: it printed
// "Review" / "Solution" / "Verification" / "Delivery / Service" where the shared
// table — and therefore the phone, the portal and the printed report — says
// "Pending Review" / "Pending Solution" / "Under Verification" / "Pending
// Delivery / Service". One stage, two names, decided by which device the reader
// picked up. `id` is this page's own name for the stage key; everything else,
// including the funnel-dot caption, now comes from stages.ts.
const DETAIL_STAGES: { id: AssrStage; short: string; long: string; desc: string }[] =
  ASSR_STAGES.map((s) => ({ id: s.key as AssrStage, short: s.short, long: s.long, desc: s.desc }));

// `resolutionRoute` — which side of the flow a resolution method routes to —
// now lives in the shared vendor/scm/lib/assr/stages module (imported above)
// so desktop + mobile can't drift on it. It drives the dot colour + subtitle
// in the Resolution cell of the summary bar and, via `getActiveStages` below,
// whether the two supplier-only workflow stages appear at all.

// PR 4 — filtered stage list. When the case's resolution method is
// on-site (own team) / return to store, the two supplier-only stages
// (Supplier Pickup + Item Ready) drop out. We keep the current stage in
// the list unconditionally as a safety net so a case parked on a
// filtered-out stage still renders (unlikely, but ops can happen). The
// per-stage rule (isStageActive) is shared with mobile.
function getActiveStages(
  method: string | null | undefined,
  currentStage: AssrStage,
): typeof DETAIL_STAGES {
  return DETAIL_STAGES.filter((s) => isStageActive(method, s.id, currentStage));
}

// Design PR 3 — accordion row for a single workflow stage. Shows a
// numbered badge (done ✓ / current N / pending N), title, chip, and
// one-line summary. Clicking the header toggles the body. Current
// stage is auto-opened on mount / on stage change (see the useEffect
// in DetailBody). The current row gets a cream inset + brass left rail
// so ops can spot it from across the page.
function StageRow({
  stageId,
  title,
  summary,
  children,
  currentStage,
  stages,
  openStage,
  setOpenStage,
  c,
  priorityMap,
}: {
  stageId: AssrStage;
  title: string;
  summary: string;
  children: React.ReactNode;
  currentStage: AssrStage;
  // PR 4 — filtered active-stage list. If stageId isn't in it, the
  // row hides itself (internal resolution methods skip Supplier
  // Pickup + Item Ready). Row number + Done/Current/Pending state
  // come from this filtered list too, so the numbering matches the
  // Workflow card above.
  stages: typeof DETAIL_STAGES;
  openStage: AssrStage | null;
  setOpenStage: (s: AssrStage | null) => void;
  /* Nico 2026-07-09 — surface per-stage SLA on the CURRENT row so ops
     can spot an over-budget stage from the Detail. Uses the same
     stage_target_days snapshot LeadTimePill was already computed for
     (mig 082) — target is set at stage entry, elapsed is now vs
     stage_entered_at. Compact pill: green ≤50%, amber 50–100%, red
     >100%. DONE / FUTURE stages don't have this data on the case row
     (would need the audit log) — showing only on CURRENT for now. */
  c?: AssrCase;
  priorityMap?: Record<string, string>;
}) {
  const myIdx = stages.findIndex((s) => s.id === stageId);
  if (myIdx < 0) return null;
  const curIdx = stages.findIndex((s) => s.id === currentStage);
  const state: "done" | "current" | "future" =
    myIdx < curIdx ? "done" : myIdx === curIdx ? "current" : "future";
  const open = openStage === stageId;
  const chip = state === "done" ? "Done" : state === "current" ? "Current" : "Pending";

  return (
    <div
      className={cn(
        "border-b border-border-subtle last:border-b-0",
        // Nico 2026-07-09 — CURRENT stage highlight swapped from amber
        // (bg-amber-50 + accent shadow + accent text) to petrol; matches
        // the Stage funnel dot flip below and the "amber = SLA warning
        // only" convention.
        state === "current" && "bg-primary/5 shadow-[inset_3px_0_0_0_theme(colors.primary.DEFAULT)]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpenStage(open ? null : stageId)}
        className="flex w-full items-center gap-3.5 px-5 py-3.5 text-left hover:bg-bg/40"
      >
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold",
            state === "done" && "bg-primary text-white",
            state === "current" && "bg-primary text-white",
            state === "future" && "border-[1.5px] border-border bg-surface text-ink-muted",
          )}
        >
          {state === "done" ? "✓" : myIdx + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-[13.5px] font-bold",
                state === "current" ? "text-primary" : state === "done" ? "text-ink" : "text-ink-muted",
              )}
            >
              {title}
            </span>
            <span
              className={cn(
                "rounded px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider",
                state === "done" && "bg-synced/15 text-synced",
                state === "current" && "bg-primary/15 text-primary",
                state === "future" && "bg-bg text-ink-muted",
              )}
            >
              {chip}
            </span>
            {/* Per-stage SLA pill — only on the CURRENT row. Reuses
                LeadTimePill's elapsed-vs-target computation so the
                Detail matches the case list's SLA lens. */}
            {state === "current" && c && priorityMap && (
              <LeadTimePill c={c} priorityMap={priorityMap} />
            )}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-ink-muted">{summary}</div>
        </div>
        <span
          className={cn(
            "shrink-0 text-[12px] text-ink-muted transition-transform",
            open && "rotate-180",
          )}
        >
          ▾
        </span>
      </button>
      {open && (
        <div className="border-t border-border-subtle bg-bg/20 px-3 py-2">
          {children}
        </div>
      )}
    </div>
  );
}

// Resolves the case's stored sub-status (小类) — directly switchable
// via the Workflow card's Sub-status select. Shared table lives in
// vendor/scm/lib/assr/stages so mobile can't drift.
function caseSubStatus(c: any): { key: string; label: string } | null {
  return assrSubStatus(c?.stage, c?.sub_status ?? null);
}

function WorkflowCard({
  currentStage,
  stages,
  transitioning,
  onChange,
  disabled,
  subStatus,
  onSubChange,
  voidReason,
}: {
  currentStage: AssrStage;
  // PR 4 — pass the filtered active-stage list. Internal resolution
  // methods drop Supplier Pickup + Item Ready → 5 dots instead of 7.
  stages: typeof DETAIL_STAGES;
  transitioning: boolean;
  onChange: (s: AssrStage) => void;
  disabled?: boolean;
  /** Stored sub-status of the current stage — rendered under its label. */
  subStatus?: { key: string; label: string } | null;
  /** Directly switch the sub-status (PATCH sub_status). */
  onSubChange?: (key: string) => void;
  /** Reason shown on the terminal Voided banner. */
  voidReason?: string | null;
}) {
  const isVoided = currentStage === "voided";
  const curIdx = Math.max(0, stages.findIndex((s) => s.id === currentStage));
  const n = stages.length;
  return (
    <div className="rounded-lg border border-border bg-surface px-6 pb-4 pt-5 shadow-stone">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] font-bold tracking-tight text-ink">Workflow</div>
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[11px] text-ink-muted">
            {isVoided ? "Voided" : `Step ${curIdx + 1} / ${n}`}
          </span>
          {!disabled && (
            <>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Change to
              </span>
              <select
                value={currentStage}
                onChange={(e) => onChange(e.target.value as AssrStage)}
                disabled={transitioning}
                className="h-8 rounded-md border border-border bg-bg px-2.5 text-[12.5px] font-semibold outline-none focus:border-primary disabled:opacity-60"
                title="Move this case to any stage"
              >
                {/* The FILTERED prop, not the module table. This mapped
                    DETAIL_STAGES while the counter two lines up read `stages` —
                    so an internal-resolution case said "Step 2 / 5" and then
                    offered all 7, the two supplier-only stages included. That is
                    the exact drift vendor/scm/lib/assr/stages.ts exists to stop,
                    and mobile (activeAssrStages) never had it. */}
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>{s.long}</option>
                ))}
                {/* Terminal alt-outcome — not a pipeline step, offered as
                    a final option (Nico 2026-07-29). */}
                <option value="voided">{ASSR_STAGE_LABEL.voided}</option>
              </select>
              {onSubChange && ASSR_SUB_STATUSES[currentStage] && (
                <select
                  value={subStatus?.key ?? ASSR_SUB_STATUSES[currentStage][0].key}
                  onChange={(e) => onSubChange(e.target.value)}
                  disabled={transitioning}
                  className="h-8 rounded-md border border-accent/40 bg-accent-soft/20 px-2.5 text-[12.5px] font-semibold text-accent outline-none focus:border-accent disabled:opacity-60"
                  title="Switch the sub-status within this stage"
                >
                  {ASSR_SUB_STATUSES[currentStage].map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>
      </div>
      {isVoided ? (
        <div className="flex items-center gap-3 rounded-lg border border-err/30 bg-err/5 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-err/15 text-[15px] font-bold text-err">
            ✕
          </span>
          <div>
            <div className="text-[13px] font-bold text-err">{ASSR_STAGE_LABEL.voided}</div>
            <div className="text-[11px] text-ink-muted">
              {voidReason
                ? `Reason: ${voidReason}`
                : "Case closed — not valid / not warranty-covered. Pick a stage above to reopen it."}
            </div>
          </div>
        </div>
      ) : (
      <ol className="flex items-start">
        {stages.map((s, i) => {
          const done = i < curIdx;
          const current = i === curIdx;
          const last = i === n - 1;
          return (
            <li key={s.id} className={cn("flex flex-1 items-start", last && "flex-none w-[74px]")}>
              <div className="flex w-[74px] shrink-0 flex-col items-center">
                <span
                  className={cn(
                    "flex h-[30px] w-[30px] items-center justify-center rounded-full text-[13px] font-bold",
                    done && "bg-primary text-white",
                    current && "bg-accent text-white ring-4 ring-accent-soft",
                    !done && !current && "border-[1.5px] border-border bg-surface text-ink-muted",
                  )}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span
                  className={cn(
                    "mt-[9px] text-center font-mono text-[9px] uppercase tracking-brand leading-snug",
                    current ? "font-bold text-accent" : done ? "font-semibold text-ink" : "font-semibold text-ink-muted",
                  )}
                >
                  {s.short}
                </span>
                <span className="mt-0.5 px-0.5 text-center text-[7.5px] leading-tight text-ink-muted/80">
                  {s.desc}
                </span>
                {current && subStatus && (
                  <span className="mt-1 rounded-full bg-accent-soft/60 px-1.5 py-0.5 text-center text-[8.5px] font-semibold uppercase tracking-wide leading-snug text-accent">
                    {subStatus.label}
                  </span>
                )}
              </div>
              {!last && (
                <span
                  className={cn(
                    "mt-[14px] h-0.5 flex-1",
                    i < curIdx ? "bg-primary" : "bg-border",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
      )}
    </div>
  );
}

function StatusSummaryBar({
  c,
  stages,
  priorityMap,
  subStatus,
}: {
  c: AssrCase;
  stages: typeof DETAIL_STAGES;
  priorityMap: Record<string, string>;
  /** Finer state inside the current stage — shown on the Status cell. */
  subStatus?: { key: string; label: string } | null;
}) {
  const curIdx = Math.max(0, stages.findIndex((s) => s.id === c.stage));
  const n = stages.length;
  const route = resolutionRoute(c.resolution_method);
  const priorityName = priorityMap[c.priority] ?? c.priority;
  const slaHours = c.hours_to_deadline ?? null;
  const slaBreached = c.is_breached === 1;
  const slaSoon = !slaBreached && slaHours != null && slaHours < 24;

  const cells: {
    label: string;
    value: string;
    sub: string;
    valColor: string;
    dotColor: string;
  }[] = [
    {
      label: "Status",
      value: caseStageLabel(c.stage),
      sub:
        c.stage === "voided"
          ? "Closed — not valid"
          : subStatus
            ? `Step ${curIdx + 1} / ${n} · ${subStatus.label}`
            : `Step ${curIdx + 1} / ${n}`,
      valColor: c.stage === "voided" ? "text-err" : "text-ink",
      dotColor: c.stage === "voided" ? "bg-err" : "bg-accent",
    },
    {
      label: "Priority",
      value: priorityName || "—",
      sub: `${priorityName || "Standard"} tier`,
      valColor: "text-ink",
      dotColor: priorityColor(c.priority),
    },
    {
      label: "SLA",
      value: slaBreached
        ? `Overdue ${Math.abs(Math.round((slaHours ?? 0) / 24))}d`
        : slaHours != null
        ? `${slaHours}h left`
        : "—",
      sub: c.deadline_at ? `Due ${formatDate(c.deadline_at)}` : `${priorityName || "Normal"} tier`,
      valColor: slaBreached ? "text-err" : slaSoon ? "text-amber-700" : "text-ink",
      dotColor: slaBreached ? "bg-err" : slaSoon ? "bg-amber-500" : "bg-synced",
    },
    {
      label: "Resolution",
      value: c.resolution_method ? resolutionLabel(c.resolution_method) : "TBD",
      sub:
        route === "supplier"
          ? "Supplier flow"
          : route === "internal"
          ? "Internal flow"
          : "Set at Solution",
      valColor: c.resolution_method ? "text-ink" : "text-ink-secondary",
      dotColor: route === "supplier" ? "bg-accent" : route === "internal" ? "bg-synced" : "bg-border",
    },
    {
      label: "Lead Time",
      value:
        c.stage_target_days != null
          ? `${c.stage_target_days} day${c.stage_target_days === 1 ? "" : "s"}`
          : "—",
      sub: `${priorityName || "Normal"} tier`,
      valColor: "text-ink",
      dotColor: "bg-synced",
    },
  ];

  return (
    <div className="flex items-stretch overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
      {cells.map((cell, i) => (
        <div key={cell.label} className={cn("flex-1 px-5 py-3.5", i > 0 && "border-l border-border-subtle")}>
          <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            {cell.label}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", cell.dotColor)} />
            <span className={cn("text-[14px] font-bold leading-tight", cell.valColor)}>
              {cell.value}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-ink-muted">{cell.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ── Inspection card ────────────────────────────────────────────
// Surfaces the v3.1 `inspection_result` field (pass / fail / na) +
// an inspection-report attachment slot. Hidden on early-stage cases
// to keep the page uncluttered; renders once the case has reached
// pending_supplier_pickup or beyond, OR when there's already a result /
// report on file.

const INSPECTION_STAGES_OR_LATER: AssrStage[] = [
  "pending_supplier_pickup",
  "pending_item_ready",
  "pending_delivery_service",
  "completed",
];

const INSPECTION_OPTIONS = ["pass", "fail", "na"] as const;

// Collapsible card — bold header + chevron, body hidden until expanded.
// Used to fold lower-priority detail sections (Reference & Logistics on the
// left; Cost / Quality / CSAT on the right) per the v2 layout.
function CollapsibleBlock({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-3 overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-bg/40"
        aria-expanded={open}
      >
        <span className="flex-1 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
          {title}
        </span>
        <ChevronRight
          size={14}
          className={cn("text-ink-muted transition-transform", open && "rotate-90")}
        />
      </button>
      {open && <div className="space-y-2.5 border-t border-border-subtle px-4 py-3.5">{children}</div>}
    </section>
  );
}

function InspectionCard({
  c,
  patch,
  caseId,
  attachments,
  archived,
  detail,
  dialog,
  toast,
  hideHeader,
}: {
  c: AssrCase;
  patch: (body: Record<string, any>) => Promise<void>;
  caseId: number;
  attachments: any[];
  archived: boolean;
  detail: ReturnType<typeof useQuery>;
  dialog: ReturnType<typeof useDialog>;
  toast: ReturnType<typeof useToast>;
  // Refresh — when rendered inside a StageRow the surrounding
  // accordion already labels the section, so skip the PanelSection
  // wrapper here to avoid double headers.
  hideHeader?: boolean;
}) {
  // Always visible so ops can pre-fill / cross-check even before the
  // item reaches the post-supplier-return checkpoint. Matches the
  // VerificationCard (QC Issue Inspection) which also has no gate.
  const [qcOpen, setQcOpen] = useState(false);
  // Refresh — QC Result dropdown carries a tone chip per option so
  // ops sees the downstream route at a glance. DB values (pass /
  // fail / na) stay unchanged; only the on-screen label + chip are
  // remapped to match the design's language.
  const QC_TAGS: {
    value: "pass" | "fail" | "na";
    slug: string;
    label: string;
    tone: "ok" | "warn" | "muted";
  }[] = [
    { value: "pass", slug: "approved", label: "Approved — to Delivery", tone: "ok" },
    { value: "fail", slug: "need_send_back_supplier", label: "Send back to supplier", tone: "warn" },
    { value: "na", slug: "others", label: "Others", tone: "muted" },
  ];
  const qcSel = QC_TAGS.find((o) => o.value === c.inspection_result);
  const toneChip = (t: "ok" | "warn" | "muted") =>
    t === "ok"
      ? "bg-synced/15 text-synced"
      : t === "warn"
      ? "bg-accent-soft/60 text-accent"
      : "bg-bg text-ink-muted";
  const inner = (
    <>
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          QC Result
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setQcOpen((v) => !v)}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-md border bg-surface px-3 py-2.5 text-left text-[13px] outline-none transition-colors",
              qcOpen ? "border-primary" : "border-border",
            )}
          >
            {qcSel ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11.5px] font-semibold text-primary">
                  {qcSel.slug}
                </span>
                <span className="text-ink-secondary">· {qcSel.label}</span>
                <span
                  className={cn(
                    "rounded px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider",
                    toneChip(qcSel.tone),
                  )}
                >
                  {qcSel.tone === "ok" ? "OK" : qcSel.tone === "warn" ? "Warn" : "Muted"}
                </span>
              </span>
            ) : (
              <span className="text-ink-muted">— select —</span>
            )}
            <span
              className={cn(
                "shrink-0 text-[12px] text-ink-muted transition-transform",
                qcOpen && "rotate-180",
              )}
            >
              ▾
            </span>
          </button>
          {qcOpen && (
            <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-surface shadow-slab">
              {QC_TAGS.map((o) => {
                const active = c.inspection_result === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      patch({ inspection_result: o.value });
                      setQcOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 border-b border-border-subtle px-3 py-2.5 text-left last:border-b-0 hover:bg-accent-soft/20",
                      active && "bg-accent-soft/40",
                    )}
                  >
                    <span className="font-mono text-[11.5px] font-semibold text-primary">
                      {o.slug}
                    </span>
                    <span className="flex-1 text-[12.5px] text-ink-secondary">· {o.label}</span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider",
                        toneChip(o.tone),
                      )}
                    >
                      {o.tone === "ok" ? "OK" : o.tone === "warn" ? "Warn" : "Muted"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <InlineEdit
        label="QC Date after supplier return"
        type="date"
        value={c.items_ready_at}
        onSave={(v) => patch({ items_ready_at: v || null })}
      />
      <p className="-mt-1 text-[10.5px] leading-snug text-ink-muted">
        Pass + date → becomes the Item Ready date. Fail → stays pending supplier item-ready.
      </p>
      {/* Mig 106 — the service note the supplier hands back with the
          item on return. Supplier edits this from their portal;
          shown here read-in-context so QC can cross-check what the
          supplier claims to have done. */}
      <InlineEdit
        label="Supplier Service Note"
        textarea
        value={c.supplier_service_note}
        onSave={(v) => patch({ supplier_service_note: v })}
        placeholder="What the supplier did / findings on the returned item"
      />
      <MilestoneAttachmentSlot
        caseId={caseId}
        category="inspection_report"
        label="QC Inspection Report"
        emptyLabel="No inspection report uploaded yet."
        uploadLabel="Upload inspection report"
        attachments={attachments}
        archived={archived}
        detail={detail}
        dialog={dialog}
        toast={toast}
      />
    </>
  );
  if (hideHeader) {
    return <div className="space-y-2.5">{inner}</div>;
  }
  return (
    <PanelSection
      icon={<ShieldCheck size={13} />}
      accent="bg-synced"
      title={
        <>
          QC Inspection{" "}
          <span className="font-normal normal-case tracking-normal text-ink-muted/70">— after supplier return</span>
        </>
      }
    >
      {inner}
    </PanelSection>
  );
}

function VerificationCard({
  c,
  patch,
  transition,
  dialog,
  caseId,
  attachments,
  archived,
  detail,
  toast,
  hideHeader,
}: {
  c: AssrCase;
  patch: (body: Record<string, any>) => Promise<void>;
  transition: (stage: AssrStage) => Promise<void>;
  dialog: ReturnType<typeof useDialog>;
  caseId: number;
  attachments: any[];
  archived: boolean;
  detail: ReturnType<typeof useQuery>;
  toast: ReturnType<typeof useToast>;
  // Refresh — inside a StageRow the accordion supplies the section
  // title, so skip the PanelSection wrapper here to avoid stacking
  // two headers on top of each other.
  hideHeader?: boolean;
}) {
  const [rootDraft, setRootDraft] = useState(c.verified_root_cause ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRootDraft(c.verified_root_cause ?? "");
  }, [c.verified_root_cause, c.id]);

  const outcome = c.verification_outcome ?? null;
  const rootCause = (c.verified_root_cause ?? "").trim();
  const isUnderVerification = c.stage === "under_verification";

  async function setOutcome(next: string | null) {
    if (next === outcome) return;
    setSaving(true);
    try {
      await patch({ verification_outcome: next });
      // Side-paths off the outcome itself.
      if (next === "rejected" && c.stage !== "completed") {
        if (
          await dialog.confirm(
            "Rejected means this isn't our issue. Close the case as Completed?"
          )
        ) {
          await transition("completed");
        }
      } else if (next === "accepted" && isUnderVerification && rootCause) {
        if (
          await dialog.confirm(
            "Mark verified and advance to Pending Solution?"
          )
        ) {
          await transition("pending_solution");
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveRootCause() {
    const next = rootDraft.trim();
    if (next === (c.verified_root_cause ?? "")) return;
    setSaving(true);
    try {
      await patch({ verified_root_cause: next || null });
      // If outcome was already 'accepted' and we just supplied the
      // missing root cause, prompt the same advance dialog so the user
      // doesn't have to re-tap the outcome chip.
      if (next && outcome === "accepted" && isUnderVerification) {
        if (
          await dialog.confirm(
            "Mark verified and advance to Pending Solution?"
          )
        ) {
          await transition("pending_solution");
        }
      }
    } finally {
      setSaving(false);
    }
  }

  const inner = (
    <>
      {/* Folded in from the retired Pending Inspection stage (mig
          0105) — who inspects the reported issue. Own team routes the
          visit into Delivery Planning via customer_pickup_at; supplier
          handles it on their side via the supplier portal. */}
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Inspect by
        </div>
        <div className="flex gap-1.5">
          {([
            { v: "own", label: "Own team" },
            { v: "supplier", label: "Supplier" },
          ] as const).map((o) => (
            <button
              key={o.v}
              type="button"
              onClick={() =>
                patch({ inspection_by: c.inspection_by === o.v ? null : o.v })
              }
              disabled={archived || saving}
              className={cn(
                "rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                c.inspection_by === o.v
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-surface text-ink-secondary hover:border-primary/40",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {c.inspection_by === "own" && (
        <>
          <InlineEdit
            label="Inspection Visit Date"
            type="date"
            value={c.inspection_visit_at}
            onSave={(v) => patch({ inspection_visit_at: v || null })}
          />
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-bg/60 px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
            {c.inspection_visit_at ? (
              <>
                <span>
                  On the <b>Delivery Planning</b> board as an unscheduled
                  job — assign a driver / lorry there.
                </span>
                <a
                  href="/scm/delivery-planning"
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-primary hover:underline"
                >
                  Open Delivery Planning →
                </a>
              </>
            ) : (
              <span>
                Set the visit date — the case then appears on the
                <b> Delivery Planning</b> board automatically for
                driver / lorry assignment.
              </span>
            )}
          </div>
        </>
      )}
      {c.inspection_by === "supplier" && (
        <div className="rounded-md bg-bg/60 px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
          Supplier performs the inspection — progress lands in the
          supplier portal's service note (see the Supplier Pickup /
          Item Ready rows).
        </div>
      )}
      <InlineEdit
        label="QC Issue Inspection Date"
        type="date"
        value={c.qc_receipt_date}
        onSave={(v) => patch({ qc_receipt_date: v || null })}
      />
      {/* qc_issue_result column exists (mig 0105) but has no UI — Nick
          2026-07-14: the on-receipt check only needs the date + photos;
          the pass/fail verdict lives in Outcome below. */}
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Outcome
        </div>
        <div className="flex flex-wrap gap-1.5">
          {VERIFICATION_OPTIONS.map((opt) => {
            const active = outcome === opt.value;
            const toneClass =
              opt.tone === "ok"
                ? active
                  ? "border-ok bg-ok/15 text-ok"
                  : "border-border text-ink-secondary hover:border-ok/40"
                : opt.tone === "warn"
                ? active
                  ? "border-warn bg-warn/15 text-warn"
                  : "border-border text-ink-secondary hover:border-warn/40"
                : active
                ? "border-err bg-err/15 text-err"
                : "border-border text-ink-secondary hover:border-err/40";
            return (
              <button
                key={opt.value}
                type="button"
                disabled={saving}
                onClick={() => setOutcome(active ? null : opt.value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-[11.5px] font-semibold transition-colors disabled:opacity-50",
                  toneClass
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {outcome && (
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Root cause
          </label>
          <input
            type="text"
            value={rootDraft}
            onChange={(e) => setRootDraft(e.target.value)}
            onBlur={saveRootCause}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            disabled={saving}
            placeholder={
              outcome === "accepted"
                ? "Material defect, transit damage, installation, etc."
                : outcome === "rejected"
                ? "Why this isn't our issue"
                : "What's missing from the customer"
            }
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          {outcome === "accepted" && !rootCause && isUnderVerification && (
            <div className="mt-1.5 text-[11px] text-ink-muted">
              Fill the root cause to advance to Pending Solution.
            </div>
          )}
        </div>
      )}

      {c.verified_at && (
        <div className="rounded-md border border-border bg-bg/40 px-3 py-2 text-[11.5px] text-ink-secondary">
          Verified by {c.verified_by_name || `user #${c.verified_by}`} ·{" "}
          {formatDate(c.verified_at)}
        </div>
      )}

      {/* Photos / videos taken at receipt inspection — evidence of
          what the item looked like BEFORE it went to the supplier.
          Distinct category from the post-return QC report so both
          checkpoints keep their own paper trail. */}
      <MilestoneAttachmentSlot
        caseId={caseId}
        category="receipt_evidence"
        label="QC Issue Inspection Photos / Videos"
        emptyLabel="No inspection photos uploaded yet."
        uploadLabel="Upload photo / video"
        attachments={attachments}
        archived={archived}
        detail={detail}
        dialog={dialog}
        toast={toast}
      />
    </>
  );
  if (hideHeader) {
    return <div className="space-y-2.5">{inner}</div>;
  }
  return (
    <PanelSection
      icon={<ClipboardCheck size={13} />}
      accent="bg-accent"
      title={
        <>
          QC Issue Inspection{" "}
          <span className="font-normal normal-case tracking-normal text-ink-muted/70">— on receipt</span>
        </>
      }
    >
      {inner}
    </PanelSection>
  );
}

// ── Sign-off attachment slot ───────────────────────────────────
// Item 2 of the QMS TODO. Single-file slot inside Quality Review for
// the verification photo / doc the QA wants on record before the case
// flips to Completed. Reuses the existing attachments endpoint with
// category=sign_off so storage + visibility toggles already work.

// ── Milestone attachment slot ──────────────────────────────────
// Generic per-category attachment slot, used at every stage handoff
// where ops needs a paper trail (sign-off, inspection report, pickup
// form, item-ready doc, delivery POD). Filters the case's existing
// attachments by the given category and exposes a small Upload button
// that hits the existing /api/assr/:id/attachments PUT route.

type MilestoneCategory =
  | "sign_off"
  | "inspection_report"
  | "receipt_evidence"
  | "pickup_form"
  | "ready_doc"
  | "delivery_pod";

function MilestoneAttachmentSlot({
  caseId,
  category,
  label,
  emptyLabel,
  uploadLabel,
  attachments,
  archived,
  detail,
  dialog,
  toast,
  compact,
}: {
  caseId: number;
  category: MilestoneCategory;
  label: string;
  emptyLabel?: string;
  uploadLabel?: string;
  attachments: any[];
  archived: boolean;
  detail: ReturnType<typeof useQuery>;
  dialog: ReturnType<typeof useDialog>;
  toast: ReturnType<typeof useToast>;
  /** Slimmer layout for inline use under a date field — drops the
   *  uppercase header label since the surrounding field already
   *  contextualises the slot. */
  compact?: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [lbIndex, setLbIndex] = useState<number | null>(null);
  const matches = (attachments ?? []).filter(
    (a: any) => a?.category === category
  );

  async function uploadFiles(files: File[]) {
    const accepted = acceptedUploadFiles(files, toast);
    if (accepted.length === 0) return;
    setUploading(true);
    try {
      // WO-7: shared pipeline — compresses photos + uploads their thumbs.
      for (const f of accepted) await uploadAssrAttachment(caseId, f, category);
      toast.success(accepted.length > 1 ? `${accepted.length} files uploaded` : `${label} uploaded`);
    } catch (err: any) {
      toast.error(err?.message || "Upload failed");
    } finally {
      setUploading(false);
      // Reload even on failure — earlier files of a batch may have saved.
      detail.reload();
    }
  }

  return (
    <div>
      <UploadDropZone disabled={uploading || archived} onFiles={uploadFiles}>
        {!compact && (
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            {label}
          </div>
        )}
        {matches.length > 0 ? (
          <div className="mb-2 grid grid-cols-3 gap-2">
            {matches.map((att: any, i: number) => (
              <AttachmentThumb
                key={att.id}
                att={att}
                onClick={() => {
                  const t = att.content_type || "";
                  if (t.startsWith("image/") || t.startsWith("video/")) setLbIndex(i);
                }}
                onArchive={archived ? undefined : async () => {
                  if (!await dialog.confirm(`Archive this ${label.toLowerCase()}?`)) return;
                  try {
                    await api.post(`/api/assr/attachments/${att.id}/archive`);
                    toast.success("Archived");
                    detail.reload();
                  } catch (err: any) {
                    toast.error(err?.message || "Something went wrong. Please try again.");
                  }
                }}
              />
            ))}
          </div>
        ) : !compact ? (
          <div className="mb-2 rounded-md border border-dashed border-border bg-bg/30 px-3 py-2 text-[11px] text-ink-muted">
            {emptyLabel || `No ${label.toLowerCase()} yet.`}
          </div>
        ) : null}
        {!archived && (
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink hover:border-accent/40">
            <Upload size={12} />
            {uploading
              ? "Uploading..."
              : matches.length
              ? "Replace / Add"
              : (uploadLabel || `Upload ${label.toLowerCase()}`)}
            <input
              type="file"
              accept="image/*,video/mp4,video/quicktime,video/webm,.pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                uploadFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
              disabled={uploading}
            />
          </label>
        )}
      </UploadDropZone>
      {lbIndex !== null && matches[lbIndex] && (
        <StaffLightbox
          attachments={matches}
          index={lbIndex}
          onChange={setLbIndex}
          onClose={() => setLbIndex(null)}
        />
      )}
    </div>
  );
}

// Thin wrapper preserves the existing Quality Review call site —
// shipped this morning with `category="sign_off"`. Future call sites
// should use MilestoneAttachmentSlot directly.
function SignOffAttachmentSlot(props: {
  caseId: number;
  attachments: any[];
  archived: boolean;
  detail: ReturnType<typeof useQuery>;
  dialog: ReturnType<typeof useDialog>;
  toast: ReturnType<typeof useToast>;
}) {
  return (
    <MilestoneAttachmentSlot
      {...props}
      category="sign_off"
      label="Sign-off Attachment"
      emptyLabel="No sign-off evidence yet."
      uploadLabel="Upload sign-off evidence"
    />
  );
}

// ── Logistics row (view + inline edit) ─────────────────────────
// TODO item 4. Each ASSR logistics row gets an Edit toggle so ops can
// fix the scheduled date / time / assignee / status / remark after
// saving — previously the only way to change one was archive + recreate.
// Uses the existing PATCH /api/assr/:id/logistics/:logId endpoint.

function LogisticsRow({
  l,
  caseId,
  archived,
  users,
  attachments,
  detail,
  dialog,
  toast,
}: {
  l: any;
  caseId: number;
  archived: boolean;
  users: { id: number; name: string | null; email?: string }[];
  attachments: any[];
  detail: ReturnType<typeof useQuery>;
  dialog: ReturnType<typeof useDialog>;
  toast: ReturnType<typeof useToast>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    scheduled_date: l.scheduled_date ?? "",
    scheduled_time_range: l.scheduled_time_range ?? "",
    assigned_to: l.assigned_to ?? "",
    status: l.status ?? "pending",
    notes: l.notes ?? "",
  });

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/api/assr/${caseId}/logistics/${l.id}`, {
        scheduled_date: draft.scheduled_date || null,
        scheduled_time_range: draft.scheduled_time_range || null,
        assigned_to: draft.assigned_to ? Number(draft.assigned_to) : null,
        status: draft.status,
        notes: draft.notes || null,
      });
      toast.success("Logistics updated");
      detail.reload();
      setEditing(false);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="rounded border border-accent/40 bg-accent-soft/20 px-3 py-2.5 text-sm">
        <div className="mb-2 flex items-center gap-2">
          <TruckIcon size={12} className="text-ink-muted" />
          <span className="font-semibold capitalize">{l.type}</span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-accent">Editing</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Date</span>
            <DateField
              fullWidth
              value={draft.scheduled_date}
              onChange={(iso) => setDraft((d) => ({ ...d, scheduled_date: iso }))}
              className="h-8 w-full rounded border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Time</span>
            <input
              type="text"
              placeholder="9:00 – 11:00"
              value={draft.scheduled_time_range}
              onChange={(e) => setDraft((d) => ({ ...d, scheduled_time_range: e.target.value }))}
              className="h-8 w-full rounded border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Assigned</span>
            <select
              value={draft.assigned_to}
              onChange={(e) => setDraft((d) => ({ ...d, assigned_to: e.target.value }))}
              className="h-8 w-full rounded border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary"
            >
              <option value="">— Unassigned —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Status</span>
            <select
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
              className="h-8 w-full rounded border border-border bg-surface px-2 text-[12px] outline-none focus:border-primary"
            >
              <option value="pending">Pending</option>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
        </div>
        <label className="mt-2 block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Remark</span>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
            rows={2}
            placeholder="e.g. driver needs warehouse code; pickup gate B"
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-primary"
          />
        </label>
        <div className="mt-2 flex justify-end gap-2">
          <button
            onClick={() => setEditing(false)}
            disabled={saving}
            className="rounded-md border border-border px-3 py-1 text-[11px] font-semibold text-ink-secondary hover:border-ink-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group rounded border border-border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <TruckIcon size={12} className="text-ink-muted" />
        <span className="font-semibold capitalize">{l.type}</span>
        <span className={cn(
          "ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold",
          l.status === "completed" && "bg-synced/10 text-synced",
          l.status === "scheduled" && "bg-accent/10 text-accent",
          l.status === "pending" && "bg-amber-500/10 text-amber-700",
          l.status === "cancelled" && "bg-ink-muted/10 text-ink-muted"
        )}>
          {l.status}
        </span>
        {!archived && (
          <>
            <button
              onClick={() => setEditing(true)}
              className="rounded p-1 text-ink-muted opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
              title="Edit entry"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={async () => {
                if (!await dialog.confirm("Archive this logistics entry?")) return;
                try {
                  await api.post(`/api/assr/${caseId}/logistics/${l.id}/archive`);
                  toast.success("Archived");
                  detail.reload();
                } catch (e: any) {
                  toast.error(e?.message || "Something went wrong. Please try again.");
                }
              }}
              className="rounded p-1 text-ink-muted opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
              title="Archive entry"
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>
      {l.scheduled_date && (
        <div className="mt-1 text-[11px] text-ink-secondary">
          {formatDate(l.scheduled_date)} {l.scheduled_time_range || ""}
        </div>
      )}
      {l.assigned_to_name && (
        <div className="text-[11px] text-ink-secondary">Assigned: {l.assigned_to_name}</div>
      )}
      {l.notes && (
        <div className="mt-1 whitespace-pre-wrap text-[11px] text-ink-muted">
          <span className="mr-1 font-semibold uppercase tracking-wider text-ink-secondary">Remark:</span>
          {l.notes}
        </div>
      )}
      {/* Delivery POD slot — case-level attachment shown on every
          delivery row so ops can attach the signed POD next to the
          row it belongs to. Single PODs per case in v1 (the
          attachment is keyed by case, not by logistics row). */}
      {l.type === "delivery" && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <MilestoneAttachmentSlot
            caseId={caseId}
            category="delivery_pod"
            label="Proof of Delivery"
            emptyLabel="No POD uploaded yet."
            uploadLabel="Upload POD"
            attachments={attachments}
            archived={archived}
            detail={detail}
            dialog={dialog}
            toast={toast}
            compact
          />
        </div>
      )}
    </div>
  );
}

// ── Print menu (header) ────────────────────────────────────────
// Replaces the single Print button with a 3-variant chooser per the
// proposal §12 print artifacts: Customer / Supplier / Office. Each
// option appends a `?variant=` query param to the existing print
// route — backend defaults to "office" so any legacy bookmark still
// works.

const PRINT_VARIANTS = {
  customer: { label: "Customer Copy", hint: "Tracker + QR to portal" },
  supplier: { label: "Supplier Copy", hint: "PO, deadline, acknowledgement" },
  office: { label: "Office Copy", hint: "Full internal view" },
} as const;
type PrintVariant = keyof typeof PRINT_VARIANTS;

/* Whose paper the copy prints on. The two entities share one service
   operation, so a case raised under one is routinely handed to the customer on
   the other's letterhead; "Both" names them separately (service provider vs
   retail entity) for the cases where the difference matters. Applies to all
   three copies — customer, supplier and office. */
const PRINT_ENTITIES = {
  houzs: "Houzs",
  "2990": "2990",
  both: "Both",
} as const;
type PrintEntity = keyof typeof PRINT_ENTITIES;


function PrintMenu({
  caseId,
  assrNo,
  customer,
  refNo,
  stage,
  resolutionMethod,
  companyCode,
  toast,
}: {
  caseId: number;
  assrNo?: string | null;
  customer?: string | null;
  refNo?: string | null;
  stage?: string | null;
  resolutionMethod?: string | null;
  /** The case's OWN company — not the active workspace's. The two differ
   *  routinely (a 2990 workspace holding a Houzs-owned case), and this is what
   *  the document heads itself with when no entity is picked. */
  companyCode?: string | null;
  toast: ReturnType<typeof useToast>;
}) {
  const [open, setOpen] = useState(false);
  /* Which copy the operator picked.

     HISTORY, because this went back and forth: the card originally said only
     "Copy: Customer Copy / Contains: …" — it restated the menu choice and told
     you nothing about the case, which is why it read as no preview at all. The
     fix attempted next was embedding the real print page in an iframe; the
     owner rejected that on sight (2026-08-11) — it drags the print page's own
     toolbar into the dialog and clips an A4 page into a narrow modal. What was
     actually wanted is the shape every OTHER document already uses: a compact
     summary card with the facts that identify the document, then the exits.
     So: no iframe, real content. */
  const [variant, setVariant] = useState<PrintVariant | null>(null);
  /* Whose letterhead the copy prints on (owner 2026-08-11). Null = the case's
     own company, which is what the document has always used — the backend
     applies that default, so a print with no choice made is byte-identical to
     before. The picker lives in the dialog rather than the copy menu because
     the menu would otherwise become 3 copies × 3 entities = 9 rows. */
  const [entity, setEntity] = useState<PrintEntity | null>(null);
  /* Null means "not touched" — which resolves to the case's OWN company, the
     same thing the backend falls back to. Resolving it here rather than leaving
     it blank is what lets the picker highlight a real choice and the card name
     the company that will actually head the paper. */
  const caseEntity: PrintEntity = companyCode === "2990" ? "2990" : "houzs";
  const chosen: PrintEntity = entity ?? caseEntity;
  /* The band names the entity being printed, not the workspace you happen to be
     in. `both` heads the paper with Houzs (see the route), so it says Houzs. */
  const bandCompany = defaultBrandingForCompany(
    chosen === "2990" ? "2990" : HOUZS_COMPANY_CODE,
  ).companyName;

  const path = (v: PrintVariant, e: PrintEntity) =>
    `/api/assr-print/${caseId}?variant=${v}&entity=${e}`;

  async function openInTab(v: PrintVariant, e: PrintEntity) {
    try {
      await api.openHtml(path(v, e));
    } catch (e2: any) {
      toast.error(e2?.message || "Failed to open print view");
    }
  }

  /* Print without a visible embed and without bouncing through a tab: fetch the
     document, mount it in a HIDDEN iframe, print that, then drop it. Same trick
     the PDF documents use (vendor/scm/lib/pdf-common deliverPdf), and the same
     reason — printing an iframe sidesteps the app's global @media print rules,
     which would otherwise put a blank sheet in the tray. */
  const printNow = async (v: PrintVariant, e: PrintEntity) => {
    let html: string;
    try {
      html = await api.getHtml(path(v, e));
    } catch (err: any) {
      toast.error(err?.message || "Failed to load the print view");
      return;
    }
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.srcdoc = html;
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        /* Some engines throw before the document settles; the tab exit is still
           there and the frame is cleaned up below either way. */
      }
    };
    document.body.appendChild(frame);
    // 60s, same as the PDF path: long enough for the OS print dialog to hold it.
    window.setTimeout(() => { try { document.body.removeChild(frame); } catch { /* gone */ } }, 60_000);
  };

  const print = usePrintPreview(() => (variant ? printNow(variant, chosen) : undefined));
  const pick = (v: PrintVariant) => {
    setOpen(false);
    setVariant(v);
    setEntity(null);
    print.openPreview();
  };

  // Click-outside close — listen on document while open.
  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      const target = ev.target as HTMLElement | null;
      if (target?.closest?.("[data-print-menu]")) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative ml-auto" data-print-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink hover:border-accent/40"
        title="Open print / PDF view"
      >
        <Printer size={11} /> Print
        <ChevronRight
          size={10}
          className={cn("transition-transform", open ? "rotate-90" : "rotate-90")}
          style={{ transform: open ? "rotate(270deg)" : "rotate(90deg)" }}
        />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-md border border-border bg-surface shadow-stone"
          role="menu"
        >
          {(Object.keys(PRINT_VARIANTS) as PrintVariant[]).map((v) => (
            <PrintMenuItem
              key={v}
              label={PRINT_VARIANTS[v].label}
              hint={PRINT_VARIANTS[v].hint}
              onClick={() => pick(v)}
            />
          ))}
        </div>
      )}
      {variant && (
        <PrintPreviewModal
          open={print.open}
          onClose={print.close}
          docTitle="Service Case"
          docNo={assrNo ?? `Case ${caseId}`}
          companyName={bandCompany}
          /* The facts that identify THIS document, in the same shape the DO /
             SO / SI previews use — customer, what is wrong, how it is being
             fixed. "Copy" stays because it is the one thing the menu chose. */
          rows={[
            { label: "Customer", value: customer || "—" },
            ...(refNo ? [{ label: "Ref No", value: refNo }] : []),
            { label: "Stage", value: caseStageLabel(stage ?? "") },
            {
              label: "Service",
              value: resolutionMethod ? resolutionLabel(resolutionMethod) : "Not set yet",
            },
            { label: "Copy", value: `${PRINT_VARIANTS[variant].label} · ${PRINT_VARIANTS[variant].hint}` },
            {
              label: "Letterhead",
              value: (
                <span className="inline-flex overflow-hidden rounded-md border border-border align-middle">
                  {(Object.keys(PRINT_ENTITIES) as PrintEntity[]).map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => setEntity(e)}
                      aria-pressed={chosen === e}
                      className={cn(
                        "px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
                        chosen === e
                          ? "bg-primary text-white"
                          : "bg-surface text-ink-secondary hover:bg-surface-dim"
                      )}
                    >
                      {PRINT_ENTITIES[e]}
                    </button>
                  ))}
                </span>
              ),
            },
          ]}
          onViewPdf={() => openInTab(variant, chosen)}
          viewLabel="View full copy"
          onPrint={print.handlers.onPrint}
        />
      )}
    </div>
  );
}

// Portal-link dropdown — sits next to Print. Lets ops pick which link to
// generate (customer or supplier) instead of two always-visible rows in the
// Customer card.
function PortalLinksMenu({
  id,
  assrNo,
  existingToken,
  onGenerated,
  toast,
}: {
  id: number;
  assrNo: string;
  existingToken: string | null;
  onGenerated: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent) {
      const target = ev.target as HTMLElement | null;
      if (target?.closest?.("[data-portal-menu]")) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative" data-portal-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink hover:border-accent/40"
        title="Generate a customer, supplier or sales portal link"
      >
        Portal Link
        <ChevronRight
          size={10}
          style={{ transform: open ? "rotate(270deg)" : "rotate(90deg)" }}
        />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-border bg-surface p-2 shadow-stone">
          <PortalLinkRow
            id={id}
            assrNo={assrNo}
            existingToken={existingToken}
            toast={toast}
            onGenerated={onGenerated}
          />
          <SupplierPortalLinkRow id={id} toast={toast} />
          <SalesPortalLinkRow id={id} assrNo={assrNo} toast={toast} />
        </div>
      )}
    </div>
  );
}

function PrintMenuItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      role="menuitem"
      className="block w-full border-b border-border px-3 py-2 text-left text-[11.5px] last:border-b-0 hover:bg-bg/60"
    >
      <div className="font-semibold text-ink">{label}</div>
      <div className="text-[10.5px] text-ink-muted">{hint}</div>
    </button>
  );
}

// ── Lead Time pill (header) ────────────────────────────────────
// Glanceable answer to "which priority is driving this case's SLA,
// and what's the target for the current stage?" — reads
// stage_target_days (snapshotted at stage entry per mig 082) and
// tints by elapsed/target ratio so an over-budget stage jumps out.
// Hidden on completed cases and on legacy rows without a snapshot.

function LeadTimePill({
  c,
  priorityMap,
}: {
  c: AssrCase;
  priorityMap: Record<string, string>;
}) {
  if (c.stage === "completed") return null;
  if (c.stage_target_days == null) return null;

  const target = c.stage_target_days;
  // Elapsed days since the case entered the current stage. stage_entered_at
  // is ISO without a Z suffix on some rows — normalise to UTC.
  let elapsed = 0;
  if (c.stage_entered_at) {
    const iso = c.stage_entered_at.endsWith("Z")
      ? c.stage_entered_at
      : c.stage_entered_at + "Z";
    elapsed = (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
  }
  const pct = target > 0 ? elapsed / target : 0;
  const tone =
    pct >= 1
      ? "bg-err/10 text-err"
      : pct >= 0.5
      ? "bg-amber-500/10 text-amber-700"
      : "bg-synced/10 text-synced";

  const priorityName =
    priorityMap[c.priority] ||
    c.priority.charAt(0).toUpperCase() + c.priority.slice(1);
  const snapshotIso = c.stage_entered_at
    ? formatDateTime(c.stage_entered_at)
    : null;
  const title = snapshotIso
    ? `Stage target snapshotted on ${snapshotIso}. Changes to the priority's stage targets only affect future stages.`
    : "Stage target from the case's priority. Changes to the priority's stage targets only affect future stages.";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
        tone
      )}
      title={title}
    >
      <Clock size={10} />
      Lead Time: {target.toFixed(1)}d · {priorityName}
    </span>
  );
}

function IssueCategoryField({
  value,
  onSave,
  dialog,
  categories,
}: {
  value: string | null | undefined;
  onSave: (next: string | null) => Promise<void>;
  dialog: ReturnType<typeof useDialog>;
  // Mig 065 — passed in from the parent so the picker reflects what
  // admins added in Service Maintenance. Falls back to the legacy
  // shared ASSR_ISSUE_CATEGORIES list if the API hasn't
  // returned yet.
  categories: readonly string[];
}) {
  const isCanonical = !!value && categories.includes(value);
  const showsOther = !!value && !isCanonical;

  async function onChange(next: string) {
    if (next === OTHER_SENTINEL) {
      const custom = await dialog.prompt({
        title: "Other issue category",
        message: "Describe the issue category in a few words.",
        placeholder: "e.g. transport damage",
        defaultValue: showsOther ? value || "" : "",
        required: true,
        confirmLabel: "Save",
      });
      if (!custom) return;
      await onSave(custom);
      return;
    }
    await onSave(next || null);
  }

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Issue Category
      </div>
      <select
        value={isCanonical ? (value as string) : showsOther ? OTHER_SENTINEL : ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      >
        <option value="">— select —</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        <option value={OTHER_SENTINEL}>
          Other{showsOther ? ` — ${value}` : "…"}
        </option>
      </select>
      {showsOther && (
        <div className="mt-1 text-[10px] text-ink-muted">
          Custom label.{" "}
          <button
            onClick={() => onChange(OTHER_SENTINEL)}
            className="text-accent hover:underline"
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

// ── Cost tracking panel ──────────────────────────────────────
// The case carries `customer_amount` (revenue side) and `po_amount`
// (supplier cost). Both can be auto-filled from the linked SO + PO via
// /api/assr/:id/cost-suggestion — staff click "Auto-fill" to fetch a
// suggestion, review the values, then Apply (or edit manually).

interface CostSuggestion {
  customer_amount: number | null;
  po_amount: number | null;
  sources: {
    so: { doc_no: string; unit_price: number; qty: number } | null;
    po: { doc_no: string; unit_price: number; qty: number } | null;
  };
  reason?: string;
}

function CostTrackingPanel({
  c,
  patch,
  toast,
  id,
}: {
  c: AssrCase;
  patch: (body: Record<string, any>) => Promise<void>;
  toast: ReturnType<typeof useToast>;
  id: number;
}) {
  const [suggestion, setSuggestion] = useState<CostSuggestion | null>(null);
  const [fetching, setFetching] = useState(false);
  const [applying, setApplying] = useState(false);

  const customer = c.customer_amount ?? null;
  const supplier = c.po_amount ?? null;
  const margin =
    customer != null && supplier != null ? customer - supplier : null;

  async function fetchSuggestion() {
    setFetching(true);
    try {
      const res = await api.get<CostSuggestion>(
        `/api/assr/${id}/cost-suggestion`
      );
      setSuggestion(res);
    } catch (e: any) {
      toast.error(e?.message || "Lookup failed");
    } finally {
      setFetching(false);
    }
  }

  async function applySuggestion(which: "all" | "customer" | "supplier") {
    if (!suggestion) return;
    const body: Record<string, any> = {};
    if (
      (which === "all" || which === "customer") &&
      suggestion.customer_amount != null
    )
      body.customer_amount = suggestion.customer_amount;
    if ((which === "all" || which === "supplier") && suggestion.po_amount != null)
      body.po_amount = suggestion.po_amount;
    if (Object.keys(body).length === 0) return;
    setApplying(true);
    try {
      await patch(body);
      toast.success("Cost updated");
      setSuggestion(null);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] text-ink-muted">
          <DollarSign size={11} />
          Auto-filled from SO + PO; edit anytime
        </div>
        <button
          onClick={fetchSuggestion}
          disabled={fetching}
          className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/40 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-accent hover:bg-accent-soft disabled:opacity-50"
        >
          <RefreshCw
            size={10}
            className={fetching ? "animate-spin" : undefined}
          />
          {fetching ? "Looking up…" : "Auto-fill"}
        </button>
      </div>

      {suggestion && (
        <div className="mb-3 rounded-md border border-accent/30 bg-accent-soft/20 p-3">
          {suggestion.reason && (
            <div className="mb-2 text-[11px] text-warning-text">
              {suggestion.reason}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <div>
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
                Suggested Customer
              </div>
              <div className="font-mono text-[13px] font-bold text-ink">
                {suggestion.customer_amount != null
                  ? formatCurrency(suggestion.customer_amount)
                  : "—"}
              </div>
              {suggestion.sources.so && (
                <div className="text-[10px] text-ink-muted">
                  SO {suggestion.sources.so.doc_no} · qty {suggestion.sources.so.qty} ×{" "}
                  {formatCurrency(suggestion.sources.so.unit_price)}
                </div>
              )}
            </div>
            <div>
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-wider text-ink-muted">
                Suggested Supplier
              </div>
              <div className="font-mono text-[13px] font-bold text-ink">
                {suggestion.po_amount != null
                  ? formatCurrency(suggestion.po_amount)
                  : "—"}
              </div>
              {suggestion.sources.po && (
                <div className="text-[10px] text-ink-muted">
                  PO {suggestion.sources.po.doc_no} · qty {suggestion.sources.po.qty} ×{" "}
                  {formatCurrency(suggestion.sources.po.unit_price)}
                </div>
              )}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              onClick={() => applySuggestion("all")}
              disabled={
                applying ||
                (suggestion.customer_amount == null &&
                  suggestion.po_amount == null)
              }
              className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white disabled:opacity-50"
            >
              {applying ? "Applying…" : "Apply both"}
            </button>
            {suggestion.customer_amount != null && (
              <button
                onClick={() => applySuggestion("customer")}
                disabled={applying}
                className="inline-flex items-center rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
              >
                Customer only
              </button>
            )}
            {suggestion.po_amount != null && (
              <button
                onClick={() => applySuggestion("supplier")}
                disabled={applying}
                className="inline-flex items-center rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-ink-secondary hover:border-accent/40 hover:text-accent disabled:opacity-50"
              >
                Supplier only
              </button>
            )}
            <button
              onClick={() => setSuggestion(null)}
              className="ml-auto inline-flex items-center rounded-md px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <InlineEdit
        label="Customer Amount (revenue)"
        type="number"
        value={c.customer_amount}
        onSave={(v) => patch({ customer_amount: v ? Number(v) : null })}
      />
      <InlineEdit
        label="PO Amount (supplier cost)"
        type="number"
        value={c.po_amount}
        onSave={(v) => patch({ po_amount: v ? Number(v) : null })}
      />
      {margin != null && (
        <div className="mt-1 flex items-baseline justify-between text-[11px]">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Gross margin
          </span>
          <span
            className={cn(
              "font-mono text-[12.5px] font-bold",
              margin >= 0 ? "text-synced" : "text-err"
            )}
          >
            {formatCurrency(margin)}
          </span>
        </div>
      )}
      <InlineEdit
        label="Supplier Invoice Ref"
        value={c.supplier_invoice_ref}
        onSave={(v) => patch({ supplier_invoice_ref: v })}
      />
      <InlineEdit
        label="Cost Notes"
        textarea
        value={c.cost_notes}
        onSave={(v) => patch({ cost_notes: v })}
      />
    </div>
  );
}

function CustomerHistory({ id }: { id: number }) {
  const q = useQuery<{ cases: CustomerHistoryRow[] }>("/api/assr/:/customer-history",
    () => api.get(`/api/assr/${id}/customer-history`),
    [id]
  );
  const cases = q.data?.cases ?? [];

  if (q.loading) {
    return (
      <PanelSection title="Customer History" muted>
        <div className="text-[11px] text-ink-muted">Loading…</div>
      </PanelSection>
    );
  }
  if (q.error) return null;
  if (cases.length === 0) {
    return (
      <PanelSection title="Customer History" muted>
        <div className="text-[11px] text-ink-muted">No prior cases for this customer.</div>
      </PanelSection>
    );
  }

  return (
    <PanelSection title={`Customer History (${cases.length})`} muted>
      <div className="space-y-1.5">
        {cases.map((p) => (
          <div
            key={p.id}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[11px]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono font-semibold">{p.assr_no}</span>
              <StatusDot variant={stageVariant(p.stage)} label={stageLabel(p.stage)} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ink-secondary">
              <span className="font-mono text-ink-muted">SO {p.doc_no}</span>
              {p.item_code && <span className="font-mono text-ink-muted">{p.item_code}</span>}
              <span>{formatDate(p.complained_date || p.created_at)}</span>
              {p.resolution_method && (
                <span className="text-ink-muted">{resolutionLabel(p.resolution_method)}</span>
              )}
            </div>
            {p.complaint_issue && (
              <ExpandableText
                text={p.complaint_issue}
                lines={2}
                className="mt-1 text-ink-secondary"
              />
            )}
          </div>
        ))}
      </div>
    </PanelSection>
  );
}

// URL-safe ASSR slug for readable portal links (ASSR/2607-008 →
// ASSR-2607-008). Cosmetic only — the portal resolves by token.
function assrSlug(assrNo: string): string {
  return assrNo.replace(/[^A-Za-z0-9-]+/g, "-");
}

// ── Portal tracking link generator (shown on every case) ────

function PortalLinkRow({
  id,
  assrNo,
  existingToken,
  onGenerated,
  toast,
}: {
  id: number;
  assrNo: string;
  existingToken: string | null;
  onGenerated: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);
  // Readable link: the ASSR slug rides in the path (cosmetic — the
  // token alone still resolves, old bare links keep working).
  const link = existingToken
    ? `${window.location.origin}/portal/case/${assrSlug(assrNo)}/${existingToken}`
    : null;

  async function generate() {
    setBusy(true);
    try {
      await api.post<{ token: string; path: string }>(`/api/assr/${id}/track-link`);
      // Reload the case detail so existingToken propagates in.
      onGenerated();
      // The parent reload is async — optimistically tell the user it worked.
      toast.success("Portal link generated.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-bg/40 p-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Customer Portal Link
      </div>
      {link ? (
        <>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[11px]"
            />
            <button
              onClick={() => {
                navigator.clipboard?.writeText(link);
                toast.success("Copied");
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] font-semibold"
            >
              Copy
            </button>
          </div>
          <div className="mt-1.5 text-[10px] text-ink-muted">
            Permanent link. Paste into WhatsApp for the customer.
          </div>
        </>
      ) : (
        <>
          <div className="mb-1.5 text-[11px] text-ink-secondary">
            Share with the customer — they can view status, comment, and upload photos without logging in.
          </div>
          <button
            onClick={generate}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent-soft/40 disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate Portal Link"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Supplier portal link (v3.1) ─────────────────────────────────
//
// Mirrors PortalLinkRow but minted via /supplier-link. The endpoint is
// idempotent on (case, creditor_code), so calling it twice returns the
// same active token. The token isn't surfaced in the case detail
// payload (yet) — Generate fetches it lazily.

function SupplierPortalLinkRow({
  id,
  toast,
}: {
  id: number;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    try {
      const r = await api.post<{ token: string; path: string }>(
        `/api/assr/${id}/supplier-link`
      );
      setLink(`${window.location.origin}/portal/supplier/${r.token}`);
      toast.success("Supplier link generated.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-bg/40 p-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Supplier Portal Link
      </div>
      {link ? (
        <>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[11px]"
            />
            <button
              onClick={() => {
                navigator.clipboard?.writeText(link);
                toast.success("Copied");
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] font-semibold"
            >
              Copy
            </button>
          </div>
          <div className="mt-1.5 text-[10px] text-ink-muted">
            30-day link. Supplier can mark pickup / ready / returned.
          </div>
        </>
      ) : (
        <>
          <div className="mb-1.5 text-[11px] text-ink-secondary">
            Share with the supplier — Picked Up → Repair → Ready →
            Returned status updates, plus QC photo uploads.
          </div>
          <button
            onClick={generate}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent-soft/40 disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate Supplier Link"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Sales portal link ────────────────────────────────────────────
//
// Third variant of the per-case portal link: same /portal/case route
// as the customer link but the token is source='sales', so the portal
// shows the salesperson view — full 7-stage progress with dates, and
// comments/uploads attributed to sales. Idempotent per case.

function SalesPortalLinkRow({
  id,
  assrNo,
  toast,
}: {
  id: number;
  assrNo: string;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    try {
      const r = await api.post<{ token: string; path: string }>(
        `/api/assr/${id}/sales-link`
      );
      setLink(`${window.location.origin}/portal/case/${assrSlug(assrNo)}/${r.token}`);
      toast.success("Sales link generated.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-bg/40 p-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Sales Portal Link
      </div>
      {link ? (
        <>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[11px]"
            />
            <button
              onClick={() => {
                navigator.clipboard?.writeText(link);
                toast.success("Copied");
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] font-semibold"
            >
              Copy
            </button>
          </div>
          <div className="mt-1.5 text-[10px] text-ink-muted">
            Permanent link. Paste into WhatsApp for the salesperson.
          </div>
        </>
      ) : (
        <>
          <div className="mb-1.5 text-[11px] text-ink-secondary">
            Share with the salesperson — full stage progress for this case,
            and they can message the team. No costs or internal notes.
          </div>
          <button
            onClick={generate}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent-soft/40 disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate Sales Link"}
          </button>
        </>
      )}
    </div>
  );
}

// ── Survey link generator (shown on closed cases) ─────────────

function SurveyLinkButton({ id, toast }: { id: number; toast: ReturnType<typeof useToast> }) {
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    try {
      const res = await api.post<{ token: string }>(`/api/assr/${id}/survey-token`);
      const url = `${window.location.origin}/survey/${res.token}`;
      setLink(url);
      /* The catch used to swallow the clipboard failure and the success toast
         fired unconditionally — so on Safari, an insecure context, or a denied
         permission the user was told the link was on their clipboard when it
         was not, and pasted whatever was there before. The link is shown on
         screen either way, so the honest fallback is to point at it. */
      let copied = false;
      try {
        await navigator.clipboard?.writeText(url);
        copied = true;
      } catch { /* copied stays false */ }
      if (copied) toast.success("Survey link copied to clipboard");
      else toast.info("Survey link ready — copy it from the box below. Your browser wouldn't let us copy it for you.");
    } catch (e: any) {
      toast.error(e?.message || "We couldn't create the survey link. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      {link ? (
        <div className="rounded-md border border-border bg-bg/60 p-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Share this link with the customer
          </div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] font-mono outline-none"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              onClick={() => {
                navigator.clipboard?.writeText(link);
                toast.success("Copied");
              }}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] font-semibold text-ink hover:border-accent/40"
            >
              Copy
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={generate}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft/20 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent-soft/40 disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate Survey Link"}
        </button>
      )}
    </div>
  );
}

// ── Close Case Prompt (satisfaction rating) ──────────────────

function ClosePrompt({
  onConfirm,
  onCancel,
  transitioning,
}: {
  onConfirm: (rating: number | null, notes: string) => Promise<void>;
  onCancel: () => void;
  transitioning: boolean;
}) {
  const [rating, setRating] = useState<number>(0);
  const [notes, setNotes] = useState("");

  const Stars = ({
    value,
    onChange,
  }: {
    value: number;
    onChange: (v: number) => void;
  }) => (
    <div className="mb-3 flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          onClick={() => onChange(value === n ? 0 : n)}
          className="rounded p-0.5 transition-colors hover:bg-amber-100"
        >
          <Star
            size={20}
            className={n <= value ? "fill-amber-400 text-amber-400" : "text-ink-muted"}
          />
        </button>
      ))}
      {value > 0 && <span className="ml-2 text-sm text-ink-secondary">{value}/5</span>}
    </div>
  );

  return (
    <div className="border-b border-border bg-amber-50/40 px-5 py-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Close Case — Customer Satisfaction
      </div>
      <Stars value={rating} onChange={setRating} />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Satisfaction notes (optional)..."
        rows={2}
        className="mb-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
      />

      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(rating || null, notes)}
          disabled={transitioning}
          className="rounded-md bg-err px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          {transitioning ? "Closing..." : "Confirm Close"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-2 text-[12px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Void Prompt (reason capture) ─────────────────────────────
// Mirrors ClosePrompt: an inline red banner that records WHY the case
// is not valid / not warranty-covered before it moves to 'voided'.
// Reason is required — the terminal state must carry an explanation.
function VoidPrompt({
  onConfirm,
  onCancel,
  transitioning,
}: {
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
  transitioning: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="border-b border-border bg-err/5 px-5 py-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-brand text-err">
        Void Case — Not Valid / Not Warranty-Covered
      </div>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason — why is this case not valid / not warranty-covered? (e.g. out of warranty, customer misuse, not a product defect)"
        rows={2}
        autoFocus
        className="mb-3 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-err"
      />
      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(reason.trim())}
          disabled={transitioning || !reason.trim()}
          className="rounded-md bg-err px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
        >
          {transitioning ? "Voiding..." : "Confirm Void"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-2 text-[12px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Logistics creation form ──────────────────────────────────

function LogisticsForm({
  assrId,
  users,
  onCreated,
  onCancel,
  toast,
}: {
  assrId: number;
  users: { id: number; name: string }[];
  onCreated: () => void;
  onCancel: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [type, setType] = useState<"pickup" | "delivery">("pickup");
  const [date, setDate] = useState("");
  const [timeRange, setTimeRange] = useState("");
  const [assignedTo, setAssignedTo] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    try {
      await api.post(`/api/assr/${assrId}/logistics`, {
        type,
        scheduled_date: date || undefined,
        scheduled_time_range: timeRange || undefined,
        assigned_to: assignedTo ? parseInt(assignedTo, 10) : undefined,
        notes: notes || undefined,
      });
      onCreated();
    } catch (e: any) {
      toast.error(`Failed: ${e?.message || e}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded border border-border bg-bg/60 p-3">
      <div className="flex gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as any)}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
        >
          <option value="pickup">Pickup</option>
          <option value="delivery">Delivery</option>
        </select>
        <DateField
          fullWidth
          value={date}
          onChange={(iso) => setDate(iso)}
          className="flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
        />
      </div>
      <input
        value={timeRange}
        onChange={(e) => setTimeRange(e.target.value)}
        placeholder="Time range (e.g. 9AM-12PM)"
        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
      />
      <select
        value={assignedTo}
        onChange={(e) => setAssignedTo(e.target.value)}
        className="w-full appearance-none rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
      >
        <option value="">Assign to...</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
      </select>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes (optional)"
        rows={2}
        className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
      />
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
        >
          {submitting ? "Scheduling..." : "Schedule"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-[11px] text-ink-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Supplier (creditor) field with manual assignment ──────────
// Auto-resolve from AutoCount stays the default; when the item has no
// MainSupplier (sync gaps), staff search the local creditors mirror or
// register a new supplier on the spot. Manual picks set
// creditor_source='manual' so the auto-resolver / bulk stock refresh
// won't overwrite them; "Resolve now" hands the link back to AutoCount.
function SupplierField({ c, id, detail, toast, onUpdated }: {
  c: any;
  id: number;
  detail: ReturnType<typeof useQuery>;
  toast: ReturnType<typeof useToast>;
  onUpdated: () => void;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<
    { creditor_code: string; company_name: string | null; phone1: string | null }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || adding) return;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await api.get<{ results: typeof results }>(
          `/api/assr/creditors/search?q=${encodeURIComponent(q.trim())}`
        );
        setResults(res.results);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, adding]);

  // Supplier identity is office + supplier-portal only (Nick
  // 2026-07-15) — the server already strips the creditor fields for
  // sales-scoped callers; hiding the card removes the dead controls.
  if (isSalesStaff(user)) return null;

  async function assign(code: string | null) {
    setSaving(true);
    try {
      await api.post(`/api/assr/${id}/set-creditor`, { creditor_code: code });
      toast.success(code ? "Supplier linked" : "Supplier unlinked");
      setOpen(false);
      setAdding(false);
      detail.reload();
      onUpdated();
    } catch (e: any) {
      toast.error(e?.message || "Failed to set supplier");
    } finally {
      setSaving(false);
    }
  }

  async function createAndAssign() {
    if (!newName.trim()) {
      toast.error("Supplier name is required");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ creditor_code: string }>(`/api/assr/creditors/create`, {
        company_name: newName.trim(),
        creditor_code: newCode.trim() || undefined,
        phone: newPhone.trim() || undefined,
      });
      await api.post(`/api/assr/${id}/set-creditor`, { creditor_code: res.creditor_code });
      toast.success(`Supplier ${res.creditor_code} created & linked`);
      setOpen(false);
      setAdding(false);
      setNewName("");
      setNewCode("");
      setNewPhone("");
      detail.reload();
      onUpdated();
    } catch (e: any) {
      toast.error(e?.message || "Failed to create supplier");
    } finally {
      setSaving(false);
    }
  }

  const inputCls =
    "w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-primary";

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
        Supplier
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-[10px] font-semibold normal-case tracking-normal text-accent hover:underline"
        >
          {open ? "Close" : c.creditor_code ? "Change" : "Set manually"}
        </button>
      </div>
      <div className="rounded-md border border-border bg-bg/40 px-3 py-2 text-[12.5px]">
        {c.creditor_code ? (
          <>
            <div className="font-semibold text-ink">
              {c.creditor_name || c.creditor_code}
            </div>
            <div className="font-mono text-[10px] text-ink-muted">
              {c.creditor_code}
              {c.creditor_source === "manual" ? " · manual" : ""}
            </div>
          </>
        ) : c.item_code ? (
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-ink-muted">
              Not resolved yet for{" "}
              <span className="font-mono text-ink">{c.item_code}</span>.
            </div>
            <button
              onClick={async () => {
                try {
                  const res = await api.post<{
                    creditor_code: string | null;
                    message?: string;
                  }>(`/api/assr/${id}/resolve-creditor`);
                  if (res.creditor_code) {
                    toast.success(res.message || "Creditor resolved");
                  } else {
                    toast.error(
                      res.message || "No MainSupplier set on this item in AutoCount"
                    );
                  }
                  detail.reload();
                  onUpdated();
                } catch (e: any) {
                  toast.error(`Resolve failed: ${e?.message || e}`);
                }
              }}
              className="shrink-0 rounded-md border border-accent/40 bg-accent-soft/40 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-accent transition-colors hover:bg-accent-soft/70"
            >
              Resolve now
            </button>
          </div>
        ) : (
          <div className="text-[11px] text-ink-muted">
            Not resolved. Set an item code to auto-link, or set the supplier manually.
          </div>
        )}
      </div>
      {open && (
        <div className="mt-2 rounded-md border border-border bg-surface p-2.5">
          {!adding ? (
            <>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search supplier name or code…"
                className={inputCls}
              />
              <div className="mt-1.5 max-h-44 overflow-auto">
                {searching ? (
                  <div className="px-1 py-2 text-[11px] text-ink-muted">Searching…</div>
                ) : results.length ? (
                  results.map((r) => (
                    <button
                      key={r.creditor_code}
                      type="button"
                      disabled={saving}
                      onClick={() => assign(r.creditor_code)}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent-soft/30 disabled:opacity-50"
                    >
                      <span className="truncate font-medium text-ink">
                        {r.company_name || r.creditor_code}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                        {r.creditor_code}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-1 py-2 text-[11px] text-ink-muted">
                    No suppliers match.
                  </div>
                )}
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t border-border-subtle/60 pt-1.5">
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="text-[11px] font-semibold text-accent hover:underline"
                >
                  + New supplier
                </button>
                {c.creditor_code && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => assign(null)}
                    className="text-[11px] text-ink-muted transition-colors hover:text-err"
                  >
                    Unlink current
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Supplier name *"
                className={inputCls}
              />
              <input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                placeholder="Creditor code (optional, e.g. 400-A0001)"
                className={cn(inputCls, "font-mono")}
              />
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="Phone (optional)"
                className={inputCls}
              />
              <div className="flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={createAndAssign}
                  disabled={saving}
                  className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Create & link"}
                </button>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="text-[11px] text-ink-muted hover:underline"
                >
                  Back to search
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Per-item remark input ──────────────────────────────────────
// Prints in the ITEMS table's REMARK column on both the customer and
// supplier copies (Nick 2026-07-15). Saves on blur / Enter; empty
// clears the remark.
// Per-item quantity stepper (Nick 2026-07-20) — − N + inline in the
// Product Info card; saves immediately, feeds the print QTY column.
function ItemQtyStepper({ caseId, item, disabled, onSaved, toast }: {
  caseId: number;
  item: any;
  disabled?: boolean;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const qty = Math.max(1, Number(item.qty ?? 1));
  const [saving, setSaving] = useState(false);

  async function set(next: number) {
    const clamped = Math.max(1, Math.round(next));
    if (clamped === qty || saving) return;
    setSaving(true);
    try {
      await api.patch(`/api/assr/${caseId}/items/${item.id}`, { qty: clamped });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update quantity");
    } finally {
      setSaving(false);
    }
  }

  if (disabled) {
    return <span className="text-[11px] text-ink-muted">&times;{qty}</span>;
  }
  return (
    <div className="flex items-center gap-0.5 rounded border border-border bg-bg/50">
      <button
        type="button"
        onClick={() => set(qty - 1)}
        disabled={saving || qty <= 1}
        className="px-1.5 py-0.5 text-[12px] font-bold text-ink-muted hover:text-ink disabled:opacity-40"
        title="Decrease quantity"
      >
        −
      </button>
      <input
        type="number"
        min={1}
        value={qty}
        onChange={(e) => set(parseInt(e.target.value, 10) || 1)}
        disabled={saving}
        className="w-8 border-x border-border bg-transparent py-0.5 text-center text-[11px] font-semibold text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        title="Quantity"
      />
      <button
        type="button"
        onClick={() => set(qty + 1)}
        disabled={saving}
        className="px-1.5 py-0.5 text-[12px] font-bold text-ink-muted hover:text-ink disabled:opacity-40"
        title="Increase quantity"
      >
        +
      </button>
    </div>
  );
}

function ItemCartonStepper({ caseId, item, disabled, onSaved, toast }: {
  caseId: number;
  item: any;
  disabled?: boolean;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const qtyCarton = Math.max(1, Number(item.qty_carton ?? 1));
  const [saving, setSaving] = useState(false);

  async function set(next: number) {
    const clamped = Math.max(1, Math.round(next));
    if (clamped === qtyCarton || saving) return;
    setSaving(true);
    try {
      await api.patch(`/api/assr/${caseId}/items/${item.id}`, { qty_carton: clamped });
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update carton quantity");
    } finally {
      setSaving(false);
    }
  }

  if (disabled) {
    return <span className="text-[11px] text-ink-muted">&times;{qtyCarton}</span>;
  }
  return (
    <div className="flex items-center gap-0.5 rounded border border-border bg-bg/50">
      <button
        type="button"
        onClick={() => set(qtyCarton - 1)}
        disabled={saving || qtyCarton <= 1}
        className="px-1.5 py-0.5 text-[12px] font-bold text-ink-muted hover:text-ink disabled:opacity-40"
        title="Decrease cartons"
      >
        −
      </button>
      <input
        type="number"
        min={1}
        value={qtyCarton}
        onChange={(e) => set(parseInt(e.target.value, 10) || 1)}
        disabled={saving}
        className="w-8 border-x border-border bg-transparent py-0.5 text-center text-[11px] font-semibold text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        title="Cartons"
      />
      <button
        type="button"
        onClick={() => set(qtyCarton + 1)}
        disabled={saving}
        className="px-1.5 py-0.5 text-[12px] font-bold text-ink-muted hover:text-ink disabled:opacity-40"
        title="Increase cartons"
      >
        +
      </button>
    </div>
  );
}

// Audience-split since Nick 2026-07-21 (remark 分别给客户和 Supplier):
// field='remark' prints on the customer copy, 'supplier_remark' on the
// Supplier Service Order. A tiny fixed-width label keeps the two rows
// tellable-apart once both carry text.
function ItemRemarkInput({ caseId, item, field, label, placeholder, disabled, onSaved, toast }: {
  caseId: number;
  item: any;
  field: "remark" | "supplier_remark";
  label: string;
  placeholder: string;
  disabled?: boolean;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const current = String(item[field] ?? "");
  const [draft, setDraft] = useState(current);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setDraft(String(item[field] ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item[field]]);
  // Auto-grow so multi-line remarks stay fully visible.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  async function commit() {
    if (draft.trim() === current.trim()) return;
    try {
      await api.patch(`/api/assr/${caseId}/items/${item.id}`, {
        [field]: draft.trim() || null,
      });
      toast.success(`${label} remark saved`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Failed to save remark");
    }
  }

  if (disabled && !current) return null;
  return (
    <div className="mt-1 flex items-start gap-1.5">
      <span className="mt-1 w-[52px] shrink-0 text-[8.5px] font-bold uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <textarea
        ref={taRef}
        rows={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        // Enter saves (blur); Alt+Enter inserts a line break (Nico
        // 2026-07-29). The browser does NOT insert a newline for
        // Alt+Enter on its own (only plain/Shift+Enter do), so the
        // break is spliced in manually at the caret.
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const el = e.currentTarget;
          if (e.altKey) {
            const start = el.selectionStart ?? draft.length;
            const end = el.selectionEnd ?? draft.length;
            setDraft(draft.slice(0, start) + "\n" + draft.slice(end));
            requestAnimationFrame(() => {
              el.selectionStart = el.selectionEnd = start + 1;
            });
          } else {
            el.blur();
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        title="Enter to save · Alt+Enter for a new line"
        className="w-full resize-none overflow-hidden rounded bg-bg/60 px-2 py-1 text-[11.5px] leading-snug text-ink outline-none placeholder:text-ink-muted/60 focus:ring-1 focus:ring-primary/30 disabled:opacity-60"
      />
    </div>
  );
}

// ── Local file preview (before upload) ─────────────────────────

function FilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = file.type.startsWith("image/");
  const isVideo = file.type.startsWith("video/");

  useEffect(() => {
    if (!isImage && !isVideo) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  return (
    <div className="group relative overflow-hidden rounded-md border border-border bg-bg">
      {isImage && url ? (
        <img src={url} alt={file.name} className="h-20 w-full object-cover" />
      ) : isVideo && url ? (
        <video src={url} className="h-20 w-full object-cover" muted />
      ) : (
        <div className="flex h-20 items-center justify-center text-[11px] text-ink-muted">
          PDF
        </div>
      )}
      <button
        onClick={onRemove}
        className="absolute right-0.5 top-0.5 rounded-full bg-ink/70 p-0.5 text-white opacity-0 transition-opacity hover:bg-err group-hover:opacity-100"
        title="Remove"
      >
        <Trash2 size={10} />
      </button>
      <div className="truncate px-1.5 py-1 text-[9px] text-ink-muted">{file.name}</div>
    </div>
  );
}

// ── Attachment thumbnail (loads via auth) ──────────────────────

function AttachmentThumb({ att, onClick, onVisibilityChange, onArchive }: {
  att: AssrAttachment & { source?: string; visible_to_customer?: number };
  onClick?: () => void;
  onVisibilityChange?: (visible: boolean) => void;
  onArchive?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = att.content_type?.startsWith("image/");
  const isVideo = att.content_type?.startsWith("video/");

  useEffect(() => {
    if (!isImage) return;
    let revoked = false;
    // WO-7 — try the light `.thumb` sibling first; photos uploaded before
    // thumbnails shipped have none (404) and fall back to the original.
    // The lightbox click-through still loads the full-size original.
    loadThumbFirst((p) => api.fetchBlobUrl(p), `/api/assr/attachments/${att.r2_key}`)
      .then((u) => {
        if (!revoked) setUrl(u);
      })
      .catch((err) => {
        console.warn("[assr-thumb] attachment load failed:", err);
      });
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [att.r2_key]);

  const isCustomer = att.source === "customer";
  const isVisible = (att.visible_to_customer ?? 1) === 1;

  return (
    <div className={cn(
      "group relative overflow-hidden rounded-md border bg-bg",
      isCustomer ? "border-accent/40" : "border-border",
      !isVisible && "opacity-60"
    )}>
      <button
        type="button"
        onClick={onClick}
        disabled={(!isImage && !isVideo) || !onClick}
        className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        aria-label={isImage ? "View full-size photo" : isVideo ? "Play video" : att.category}
      >
        {isImage && url ? (
          <img
            src={url}
            alt={att.file_name || ""}
            className="h-20 w-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : isVideo ? (
          <div className="flex h-20 w-full flex-col items-center justify-center gap-1 bg-ink/80 text-white transition-colors group-hover:bg-ink/70">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20">
              <Play size={13} className="ml-0.5" />
            </span>
            <span className="text-[9px] font-semibold uppercase tracking-wider">Video</span>
          </div>
        ) : (
          <div className="flex h-20 items-center justify-center text-[11px] text-ink-muted">
            File
          </div>
        )}
      </button>
      <div className="flex items-center justify-between px-1.5 py-1 text-[9px] text-ink-muted">
        <span className="truncate">{att.category}</span>
        {isCustomer && <span className="text-accent font-semibold">CUSTOMER</span>}
      </div>
      <div className="absolute right-0.5 top-0.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {onVisibilityChange && (
          <button
            onClick={(e) => { e.stopPropagation(); onVisibilityChange(!isVisible); }}
            className="rounded-full bg-ink/70 px-1.5 py-0.5 text-[9px] font-semibold text-white hover:bg-accent"
            title={isVisible ? "Hide from customer" : "Show to customer"}
          >
            {isVisible ? "Hide" : "Show"}
          </button>
        )}
        {onArchive && (
          <button
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            className="rounded-full bg-ink/70 p-1 text-white hover:bg-err"
            title="Archive attachment"
          >
            <Trash2 size={9} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Full-screen lightbox for staff-side attachments ──────────
// Mirrors the portal lightbox but fetches via the staff auth path
// (/api/assr/attachments/:r2_key). Images and videos participate in
// prev/next navigation — PDFs/docs stay out.
function StaffLightbox({
  attachments,
  index,
  onChange,
  onClose,
}: {
  attachments: Array<AssrAttachment & { source?: string; visible_to_customer?: number }>;
  index: number;
  onChange: (i: number) => void;
  onClose: () => void;
}) {
  // Images and videos participate in lightbox navigation. The
  // caller's `index` is the index into the full attachments array,
  // but we map it to the media-only list for prev/next.
  const mediaIndices = useMemo(
    () => attachments
      .map((a, i) => {
        const t = a.content_type || "";
        return t.startsWith("image/") || t.startsWith("video/") ? i : -1;
      })
      .filter((i) => i >= 0),
    [attachments]
  );
  const currentMediaPos = mediaIndices.indexOf(index);

  const att = attachments[index];
  const [url, setUrl] = useState<string | null>(null);

  const go = useCallback(
    (delta: number) => {
      if (currentMediaPos < 0 || mediaIndices.length === 0) return;
      const nextPos = (currentMediaPos + delta + mediaIndices.length) % mediaIndices.length;
      onChange(mediaIndices[nextPos]);
    },
    [currentMediaPos, mediaIndices, onChange]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // This is a FULL-SCREEN viewer, not a thumbnail: with `.catch(() => {})` a
  // denied or failed fetch left the "Loading…" placeholder up forever, so a 403
  // was indistinguishable from a slow network and the operator waited on
  // something that was never coming. Keep the reason and render it.
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    setLoadError(null);
    let revoked = false;
    api.fetchBlobUrl(`/api/assr/attachments/${att.r2_key}`)
      .then((u) => { if (!revoked) setUrl(u); })
      .catch((e: unknown) => {
        if (revoked) return;
        setLoadError(
          e instanceof Error && e.message
            ? e.message
            : "We couldn't load this attachment. Please try again.",
        );
      });
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.r2_key]);

  if (typeof document === "undefined") return null;

  const isCustomer = att.source === "customer";
  const isHidden = (att.visible_to_customer ?? 1) === 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 px-4 py-3 text-white sm:px-6 sm:py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[2pt]">
          <span className="rounded-full border border-white/30 px-2 py-0.5 font-semibold">
            {att.category}
          </span>
          {isCustomer && (
            <span className="rounded-full bg-accent/90 px-2 py-0.5 font-semibold">
              Customer
            </span>
          )}
          {isHidden && (
            <span className="rounded-full border border-white/50 bg-white/10 px-2 py-0.5 font-semibold">
              Hidden
            </span>
          )}
          {mediaIndices.length > 1 && (
            <span className="font-mono text-[10px] text-white/60">
              {currentMediaPos + 1} / {mediaIndices.length}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <X size={18} />
        </button>
      </div>

      {mediaIndices.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); go(-1); }}
            aria-label="Previous"
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:left-6"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); go(1); }}
            aria-label="Next"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:right-6"
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}

      <div
        className="relative flex max-h-[90vh] max-w-[92vw] items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {url ? (
          (att.content_type || "").startsWith("video/") ? (
            <video
              src={url}
              controls
              autoPlay
              playsInline
              className="max-h-[88vh] max-w-[92vw] rounded shadow-2xl"
            />
          ) : (
            <img
              src={url}
              alt={att.file_name || att.category}
              className="max-h-[88vh] max-w-[92vw] select-none object-contain shadow-2xl"
              draggable={false}
            />
          )
        ) : loadError ? (
          <div
            role="alert"
            className="flex h-64 w-72 flex-col items-center justify-center gap-2 rounded bg-white/5 px-4 text-center text-[12px] leading-relaxed text-white/80"
          >
            <span className="font-semibold text-white">
              This attachment couldn't be opened
            </span>
            <span>{loadError}</span>
          </div>
        ) : (
          <div className="flex h-64 w-64 items-center justify-center rounded bg-white/5 text-white/60">
            Loading…
          </div>
        )}
      </div>

      {att.file_name && (
        <div
          className="absolute inset-x-0 bottom-0 px-4 py-3 text-center text-[11px] text-white/70 sm:py-4"
          onClick={(e) => e.stopPropagation()}
        >
          {att.file_name}
        </div>
      )}
    </div>,
    document.body
  );
}
