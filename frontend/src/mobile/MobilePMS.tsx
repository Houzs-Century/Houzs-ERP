import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatPhone } from "../vendor/shared/phone";
import { MobileVirtualList } from "./MobileVirtualList";
import { MobileGantt } from "./MobileGantt";
import { MediaLightbox, type MediaItem } from "../components/MediaLightbox";
import { SearchProgress } from "../components/SearchProgress";
import { SearchScopeHint } from "../components/SearchScopeHint";
import { useSearchResultTransition } from "../hooks/useServerSearch";
import { useAuth } from "../auth/AuthContext";
import { isSalesNonDirector, isSalesDirectorUser, canLogSalesEntry, canCreateEvent } from "../auth/salesAccess";
import { NewProjectSheet } from "./MobileNewProject";
import { capability } from "../auth/capabilities";
import { readProjectAccess, projectAccessUnresolved, holdsChecklistApproval } from "../auth/projectAccess";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import { formatCurrency, formatDate, todayInAppTz } from "../lib/utils";
import { pmsStageLabel, pmsStageVariant, type PmsStageVariant } from "../vendor/scm/lib/pms-status";
import { ledgerCategoryLabel } from "../vendor/scm/lib/pms-ledger-categories";
import { isReviewableTitle } from "../vendor/scm/lib/pms-reviewable-titles";
import { PROJECT_STATUS_OPTIONS, paymentPillOptions } from "../vendor/scm/lib/pms-project-status";
import "./mobile.css";
import { fmtTime } from "../vendor/shared/format";
import { DateField } from "../vendor/scm/components/DateField";
import { DefectActionsCtx, DefectFileActions, type AttachmentAction } from "./MobilePmsDefectActions";

/* ------------------------------------------------------------------ *
 * Mobile Project (PMS) — list + detail.
 *
 * Presentation ported VERBATIM from the owner's Houzs Mobile.html design
 * (`<section id="project">` + `renderProject`/`projRenderTasks`) onto the
 * .hz-m design classes now in mobile.css (.hdr .ey .pacc .psec-t .pbody
 * .pstage .pdot .docrow .rbadge .tinybtn .pgrid2 .pkv-l .pkv-v .so-row
 * .so-grid .so-k .so-v .spill .sochip). Only the presentation changed —
 * all data-fetching + behaviour is unchanged.
 *
 * Wired to the same /api/projects backend the desktop Projects page uses
 * (row-scoped + page-access-gated server side). The list hits GET
 * /api/projects (returns { data, page, per_page, total }); the detail hits
 * GET /api/projects/:id (returns { project, finance, checklist, sections,
 * section_progress, sales_attendees, _access, ... }).
 *
 * ROLE GATE: the Financial-snapshot section renders ONLY when the user has
 * finance page-access — pageAccess("projects.finances") !== "none". The
 * backend ALSO strips `finance` from the payload for a role whose PMS
 * position lacks FINANCIAL access (defense in depth), so we additionally
 * hide the panel when `finance` came back null.
 * ------------------------------------------------------------------ */

// ── List row (subset of the desktop ProjectRow the list endpoint returns) ──
type ProjectListRow = {
  id: number;
  code: string;
  name: string;
  stage: string | null;
  status: string | null;
  brand: string | null;
  start_date: string | null;
  end_date: string | null;
  state: string | null;
  venue: string | null;
  booth_no: string | null;
  event_type_name: string | null;
  progress_pct?: number | null;
  pic_name: string | null;
  active_section_name?: string | null;
  // Section-driven stage counters (mig 050). Already returned by the
  // /api/projects list SELECT and consumed by the desktop Projects table; typed
  // here so the mobile card can show the current section "done/total" instead of
  // the retired coarse `stage` enum.
  sections_total?: number;
  sections_complete?: number;
  // Sales-only progress (owner 2026-07-21): counts over role_label
  // 'SALES PIC' tasks — done = status done/na OR carries a live attachment.
  // Drives the sales cohort's list pill + % instead of the admin sections.
  sales_tasks_total?: number;
  sales_tasks_done?: number;
};

type ListResponse = {
  data?: ProjectListRow[];
  // Tolerate alternate envelope keys just in case.
  projects?: ProjectListRow[];
  rows?: ProjectListRow[];
  total?: number;
};

// ── Detail (subset — never crash on missing fields) ──
type ChecklistItem = {
  id: number;
  seq: number;
  title: string;
  role_label: string | null;
  due_date: string | null;
  status: string | null; // pending | done | na | blocked | review | rejected | amended
  section_id: number | null;
  owner_name?: string | null;
  required_perm?: string | null;
  // mig 090 — payment / deposit rows render as multi-state pills instead of a
  // done/pending tick. pill_value stored via the standard checklist PATCH.
  pill_kind?: string | null; // "rental_payment" | "security_deposit" | null
  pill_value?: string | null; // none | unpaid | fully_paid | refunded
  review_status?: string | null; // drives the approve/reject gate
  notes?: string | null; // item-level remark (Deco/Coffee Table, Weekend Activity)
};

// Per-task attachment (mig 050). Grouped by item_id.
type TaskAttachment = {
  id: number;
  item_id: number;
  r2_key: string;
  file_name: string | null;
  mime_type: string | null;
  uploader_name?: string | null;
  uploaded_at?: string | null;
  archived_at?: string | null;
  caption?: string | null;
};

type TasklistSection = {
  id: number;
  name: string;
  sort_order: number;
};

type SectionProgress = {
  id: number;
  name: string;
  sort_order: number;
  total: number;
  done: number;
  na: number;
  complete: number;
};

type SalesAttendee = {
  sales_rep_id: number;
  rep_code: string | null;
  rep_name: string | null;
  user_name: string | null;
};

// Setup / dismantle crew + timing (mig 024/083). The detail endpoint
// spreads `p.*` plus JOIN aliases, so these arrive at the top level of
// `project`. setup_start_at / dismantle_start_at are ISO "date T time".
type PhasePhoto = {
  id: number;
  phase: "setup" | "dismantle" | string;
  r2_key: string | null;
  caption: string | null;
  uploaded_by_name?: string | null;
  uploaded_at?: string | null;
};

type ProjectDetail = {
  project: {
    id: number;
    code: string;
    name: string;
    stage: string | null;
    status: string | null;
    brand: string | null;
    start_date: string | null;
    end_date: string | null;
    state: string | null;
    venue: string | null;
    venue_address?: string | null;
    booth_no: string | null;
    organizer?: string | null;
    event_type_name?: string | null;
    duration_days?: number | null;
    pic_id?: number | null;
    pic_name?: string | null;
    pic_phone?: string | null;
    payment_status?: string | null;
    archived_at?: string | null;
    // Setup / dismantle logistics (real columns + JOIN aliases).
    setup_start_at?: string | null;
    dismantle_start_at?: string | null;
    setup_driver_user_id?: number | null;
    dismantle_driver_user_id?: number | null;
    setup_lorry_id?: number | null;
    dismantle_lorry_id?: number | null;
    setup_driver_name?: string | null;
    dismantle_driver_name?: string | null;
    setup_lorry_plate?: string | null;
    dismantle_lorry_plate?: string | null;
    // Phase crew editor JSON (desktop parsePhaseCrew) — the desktop form
    // writes crew here, NOT the FK columns above, so mobile must dual-read.
    setup_crew?: string | null;
    dismantle_crew?: string | null;
  };
  stock_transfers?: StockTransfer[];
  finance: {
    rental: number | null;
    contractor_cost: number | null;
    license_fee: number | null;
    misc_cost: number | null;
    deposit_refund: number | null;
    total_sales: number | null;
  } | null;
  finance_lines?: FinanceLine[];
  checklist?: ChecklistItem[];
  checklist_attachments?: TaskAttachment[];
  sections?: TasklistSection[];
  section_progress?: SectionProgress[];
  sales_attendees?: SalesAttendee[];
  attachments?: ProjectAttachment[];
  _access?: {
    level?: string;
    pms?: { canFinancial?: boolean; canEdit?: boolean; canPayment?: boolean; canSetupDismantle?: boolean; role?: string };
  };
};

// Full stock-transfer row (dual-read camelCase ?? snake_case).
type StockTransfer = {
  id: number;
  direction?: string | null;
  confirmed?: number | boolean | null;
  confirmed_at?: string | null;
  confirmedAt?: string | null;
  created_by_name?: string | null;
  createdByName?: string | null;
  confirmed_by_name?: string | null;
  confirmedByName?: string | null;
  transferred_at?: string | null;
  transferredAt?: string | null;
  record_r2_key?: string | null;
  recordR2Key?: string | null;
  file_name?: string | null;
  fileName?: string | null;
};

// Finance ledger line (income/cost). Synthetic sales rows carry source='sales_entry'.
type FinanceLine = {
  id: number;
  kind: string;
  category: string;
  description?: string | null;
  amount: number;
  occurred_at?: string | null;
  occurredAt?: string | null;
  r2_key?: string | null;
  r2Key?: string | null;
  file_name?: string | null;
  fileName?: string | null;
  created_by_name?: string | null;
  createdByName?: string | null;
  auto_source?: string | null;
  autoSource?: string | null;
  source?: string | null;
  source_id?: number | null;
};

type ProjectAttachment = {
  id: number;
  category?: string | null;
  r2_key?: string | null;
  r2Key?: string | null;
  file_name?: string | null;
  fileName?: string | null;
  mime_type?: string | null;
  mimeType?: string | null;
  uploader_name?: string | null;
  uploaderName?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
};

type Lorry = { id: number; plate: string | null; type?: string | null; is_internal?: boolean | null };

// ── Reference-data list rows (populate the write-form selects) ──
type PicUser = { id: number; name: string | null; email: string };
type SalesRepOption = { id: number; code: string | null; name: string | null };
type FleetStaff = { id: number; name: string | null; role_name: string | null; phone?: string | null; company_phone?: string | null; companyPhone?: string | null };

// ── Shared dialog-hook / setter fn types (props into the write blocks) ──
type NotifyFn = (o: { title: string; body?: ReactNode; tone?: "info" | "error" }) => Promise<void>;
type ConfirmFn = (o: { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;
type PromptFn = (o: { title: string; body?: ReactNode; defaultValue?: string; placeholder?: string; confirmLabel?: string; validate?: (v: string) => string | null }) => Promise<string | null>;
type SetBusy = Dispatch<SetStateAction<boolean>>;

// Dual-read helper — the PG driver camelCases result columns, so a row may
// carry either snake_case (D1 fallback / raw SQL) or camelCase. Always read
// both (project_pg_camelcase_columns memory — #1 recurring bug).
function pick<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v != null) return v;
  return null;
}

// ── Formatters ──
// P&L figures here are plain ringgit numbers (NOT centi) — format via the shared
// ringgit formatter. TZ-aware numeric DD/MM/YYYY date via the shared helper.
const dm = (d: string | null | undefined) => formatDate(d);
// Date-only portion of an ISO "date T time" string (setup_start_at etc).
const dOnly = (d: string | null | undefined) => dm(d);
// Time-only portion ("08:00"). Reads the literal HH:mm off the ISO string so
// it doesn't shift with the device timezone; falls back to "—".
const tOnly = (d: string | null | undefined) => {
  const m = d ? /T(\d{2}:\d{2})/.exec(d) : null;
  return m ? m[1] : fmtTime(d);
};
// Uploader credit line: "Uploaded by {name} · {date time}" or a placeholder.
const uploaderCredit = (photo: PhasePhoto | undefined) => {
  if (!photo) return "Not uploaded yet";
  const who = photo.uploaded_by_name?.trim();
  const when = photo.uploaded_at ? `${dm(photo.uploaded_at)} ${tOnly(photo.uploaded_at)}` : null;
  return ["Uploaded by " + (who || "crew"), when].filter(Boolean).join(" · ");
};

// ── Stage / status vocab ──
// The backend `stage` model (mig 053): draft → setup → live → dismantle →
// completed. The owner's mobile design shows a richer 9-step logistics
// pipeline (Floorplan → Done). We drive the pipeline off the project's
// checklist SECTIONS when present (that is what the desktop tracker uses),
// and fall back to a fixed 9-step reference pipeline keyed off `stage`.
// Designer's 9-step reference pipeline (MobilePMS PIPELINE), VERBATIM.
const FALLBACK_PIPELINE = [
  "Confirmed",
  "Setup",
  "Floorplan",
  "3D",
  "Stocks Transfer",
  "Setup/Dismantle",
  "Filled Floorplan",
  "Event Complete",
  "Done",
];

// Map the coarse backend stage onto an approximate pipeline index so the
// fallback pipeline highlights a plausible "current" step.
const STAGE_TO_INDEX: Record<string, number> = {
  draft: 1,
  setup: 2,
  live: 6,
  dismantle: 5,
  completed: 8,
};

// ── Component ──
export function MobilePMS({ onBack, initialProjectId }: { onBack?: () => void; initialProjectId?: number }) {
  const [openId, setOpenId] = useState<number | null>(initialProjectId ?? null);
  // When entered straight into a detail (e.g. tapped from the Calendar), Back
  // leaves PMS entirely; once the user visits the list, Back returns to it.
  const [direct, setDirect] = useState<boolean>(initialProjectId != null);

  if (openId != null) {
    return <ProjectDetailView id={openId} onBack={() => (direct ? onBack?.() : setOpenId(null))} />;
  }
  return <ProjectListView onOpen={(id) => { setDirect(false); setOpenId(id); }} onBack={onBack} />;
}

// ── List ──
// FOLLOW THE BACKEND: the mobile PMS mirrors the desktop Projects page
// (frontend/src/pages/Projects.tsx) verbatim — the real workflow `stage`
// enum (mig 053) is draft → setup → live → dismantle → completed, with
// `closed`/`cancelled` possible on rows. No invented Planning/Live/Settled
// buckets: the filter chips, list-card badge and detail badge all key off
// the real `stage` value directly.
// Stage label + variant now come from the SHARED vendor/scm/lib/pms-status so
// desktop + mobile can't drift on the stage vocabulary. Mobile keeps its own
// variant→tint palette (STAGE_TINT) below.
type StageVariant = PmsStageVariant;
const stageLabel = pmsStageLabel;
const stageVariant = pmsStageVariant;

// Map the desktop variant onto the mobile badge palette already used across
// the screen (amber = open, green/teal = in-progress, grey = neutral/closed,
// clay-red = error). bg/fg pairs match the ListChip tints.
const STAGE_TINT: Record<StageVariant, { bg: string; fg: string }> = {
  neutral: { bg: "#eef0ec", fg: "#767b6e" },
  open: { bg: "#f6efd9", fg: "#6e4d12" },
  "in-progress": { bg: "#e2f0e9", fg: "#2f8a5b" },
  closed: { bg: "#eef0ec", fg: "#767b6e" },
  error: { bg: "#f7e7e5", fg: "#a13a34" },
};

// Filter chips — the REAL stages, mirroring desktop STAGE_OPTIONS.
const STAGE_FILTERS: [string, string][] = [
  ["all", "All"],
  ["draft", "Draft"],
  ["setup", "Setup"],
  ["live", "Live"],
  ["dismantle", "Dismantle"],
  ["completed", "Completed"],
];

const PMS_PAGE_SIZE = 30;

function ProjectListView({ onOpen, onBack }: { onOpen: (id: number) => void; onBack?: () => void }) {
  const { can, user } = useAuth();
  // Owner 2026-07-21: the sales cohort's list rows show progress over THEIR
  // OWN deliverables (SALES PIC tasks) — the admin section chip ("CONTRACT
  // 2/6") and all-task % meant nothing to a salesperson.
  const salesList = isSalesNonDirector(user);
  const [q, setQ] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("all");
  // "My events" — drivers/helpers (tick-only, no projects.write) land on the
  // events they're crewed on (setup/dismantle assignment, FK or crew JSON;
  // owner 2026-07-16) with "All" one tap away. Everyone else sees the normal
  // full list with no extra chip.
  const tickOnly = can("projects.checklist.tick") && !can("projects.write");
  const [assignedOnly, setAssignedOnly] = useState<boolean | null>(null);
  const showAssigned = tickOnly && (assignedOnly ?? true);
  // Owner 2026-07-23: every role gets My Pending on mobile too — the same
  // server-side role lanes as the desktop checkbox (my_pending=1). Rows come
  // back timeline-ordered (soonest event first) with my_pending_titles chips
  // saying WHY each row is the caller's; a completed/submitted task drops the
  // row server-side.
  const [myPendingOn, setMyPendingOn] = useState(false);
  // New-event sheet (owner 2026-07-31), gated by canCreateEvent below.
  const [creating, setCreating] = useState(false);
  const notify = useNotify();
  // Owner 2026-07-21: field/sales roles (Sales Executive/Manager except Sales
  // Director, plus Driver/Helper/Storekeeper) get a slimmed filter bar — only
  // "My events", "Setup", "Dismantle" (no All / Draft / Live / Completed).
  const _pos = (user?.position_name ?? "").trim();
  const _dept = (user?.department_name ?? "").trim();
  const _isDirector = !!user?.permissions?.includes("*") || /\b(super admin|sales director|finance manager)\b/i.test(_pos);
  const _isCrew = /\b(driver|helper)\b/i.test(_pos) || /storekeeper/i.test(_pos) || /^warehouse crew/i.test(_pos);
  const _isSalesExec = (/sales/i.test(_dept) || /^sales/i.test(_pos)) && !_isDirector;
  const restrictedCohort = _isCrew || _isSalesExec;
  const visibleStageFilters = restrictedCohort
    ? STAGE_FILTERS.filter(([k]) => k === "setup" || k === "dismantle")
    : STAGE_FILTERS;
  const myEventsOn = tickOnly ? showAssigned : true; // sales are already scoped to their events
  /* Debounced search term — the value actually sent to the server (and keyed
     into the infinite query) so a keystroke doesn't fire a request per
     character. 300ms after the operator stops typing the list re-runs from
     page 1. Mirrors the merged MobileSalesOrders pattern. */
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  /* Scroll container + sentinel for the IntersectionObserver infinite-scroll
     trigger (the mobile screens scroll an inner overflow div, not the window). */
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  /* Server-side stage filter + search + infinite scroll. Both the stage chip
     and the search box map to real /api/projects params (stage / search), so
     the server finds matches across the WHOLE table — not just the rows already
     loaded (the old per_page=200 silently truncated past 200). per_page 30;
     default order (start_date DESC, id DESC) is stable → no skipped/dup rows.
     NOTE: the server `search` matches code/name/venue/organizer; the old
     client search also matched brand + PIC name — those two are no longer
     searchable (organizer now is). Stage chips + search cross every page. */
  const buildParams = (page: number): string => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("per_page", String(PMS_PAGE_SIZE));
    if (stageFilter !== "all") {
      // Field/sales cohort's Setup/Dismantle filter on date-derived event PHASE
      // (the `stage` enum is unmaintained — never reaches 'dismantle'). The full
      // stage bar (mgt/admin) keeps the raw stage enum. Mirrors desktop f.phase.
      if (restrictedCohort && (stageFilter === "setup" || stageFilter === "dismantle")) {
        p.set("phase", stageFilter);
      } else {
        p.set("stage", stageFilter);
      }
    }
    if (debouncedQ) p.set("search", debouncedQ);
    if (showAssigned) p.set("assigned_to_me", "1");
    if (myPendingOn) p.set("my_pending", "1");
    return p.toString();
  };
  const {
    data, isLoading, isFetching, isPlaceholderData, error,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    // `showAssigned` is read by buildParams, so it MUST be in the key (main) —
    // and the query's signal is forwarded so a superseded search is cancelled
    // rather than left racing (this branch).
    queryKey: ["mobile-pms-list-paged", stageFilter, debouncedQ, showAssigned, myPendingOn],
    queryFn: ({ pageParam, signal }) => api.get<ListResponse>(`/api/projects?${buildParams(pageParam)}`, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + (p.data?.length ?? p.projects?.length ?? p.rows?.length ?? 0), 0);
      return loaded < (last.total ?? 0) ? pages.length + 1 : undefined;
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const rows = useMemo(
    () => data?.pages.flatMap((p) => p.data ?? p.projects ?? p.rows ?? []) ?? [],
    [data],
  );
  const totalCount = data?.pages[0]?.total ?? 0;
  const searchTransition = useSearchResultTransition({
    inputTerm: q,
    requestTerm: debouncedQ,
    isFetching,
    isPlaceholderData,
    hasData: data !== undefined,
    hasError: Boolean(error),
  });
  const visibleRows = searchTransition.resultsAreStale ? [] : rows;

  /* Infinite-scroll trigger — an IntersectionObserver watches a 1px sentinel at
     the list's bottom and fetches the next page as it nears the viewport
     (rootMargin 600px pre-load). Guarded by hasNextPage && !isFetchingNextPage
     so it can't double-fire; re-observing when those flip re-fires the
     initial-state callback so a first page shorter than the viewport still
     pulls the next until the sentinel scrolls out or the pages run out. */
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { root: scrollRef.current, rootMargin: "0px 0px 600px 0px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, rows.length]);

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {onBack && (
              <span onClick={onBack} role="button" aria-label="Back" style={{ fontSize: 22, lineHeight: 1, color: "var(--brand)", cursor: "pointer" }}>‹</span>
            )}
            <div>
              <div className="eyebrow">PMS</div>
              <div className="scr-title">Projects</div>
            </div>
          </div>
          {/* New event (owner 2026-07-31) — same gate as the desktop button:
              BD / Owner position / weisiang, which the backend re-checks. */}
          {canCreateEvent(user) && (
            <button
              className="tinybtn"
              style={{ marginLeft: "auto", background: "var(--brand)", borderColor: "var(--brand)", color: "#fff", fontWeight: 700 }}
              onClick={() => setCreating(true)}
            >
              + New
            </button>
          )}
        </div>
        <div className="hdr-row" style={{ marginTop: 11 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search project · venue" />
          </div>
          <SearchProgress active={searchTransition.isSearching} label="Searching…" />
        </div>
        <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={totalCount} term={q} className="mt-1 px-1" />
        <div className="chips" style={{ marginTop: 11 }}>
          <button
            onClick={() => setMyPendingOn(!myPendingOn)}
            className={myPendingOn ? "chip on" : "chip"}
          >
            My pending
          </button>
          {(tickOnly || restrictedCohort) && (
            <button
              onClick={() => { if (tickOnly) setAssignedOnly(!showAssigned); }}
              className={myEventsOn ? "chip on" : "chip"}
              style={myEventsOn ? undefined : { borderColor: "#bcdcd7", color: "#16695f" }}
            >
              My events
            </button>
          )}
          {visibleStageFilters.map(([k, label]) => (
            <button key={k} onClick={() => setStageFilter(k)} className={stageFilter === k ? "chip on" : "chip"}>{label}</button>
          ))}
        </div>
      </header>

      <div ref={scrollRef} className="scroll" style={{ padding: 14, paddingBottom: 120 }}>

        {isLoading && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "26px 0" }}>Couldn't load projects. Pull to retry.</div>}
        {!isLoading && !error && myPendingOn && rows.length === 0 && (
          <div style={{ textAlign: "center", padding: "26px 0" }}>
            <div style={{ color: "#9aa093", fontSize: 12 }}>Nothing pending on your side.</div>
            <button className="tinybtn" style={{ marginTop: 10 }} onClick={() => setMyPendingOn(false)}>Show all events</button>
          </div>
        )}
        {!isLoading && !error && !myPendingOn && showAssigned && rows.length === 0 && (
          <div style={{ textAlign: "center", padding: "26px 0" }}>
            <div style={{ color: "#9aa093", fontSize: 12 }}>No events assigned to you{stageFilter !== "all" || debouncedQ ? " match these filters" : " yet"}.</div>
            <button className="tinybtn" style={{ marginTop: 10 }} onClick={() => setAssignedOnly(false)}>Show all events</button>
          </div>
        )}
        {!isLoading && !error && (
          <>
            {visibleRows.length > 0 && (
              <MobileVirtualList
                items={visibleRows}
                getKey={(r) => r.id}
                estimateHeight={108}
                renderItem={(r) => {
              const s = (r.stage ?? "").toLowerCase();
              const dimmed = s === "cancelled" || s === "closed";
              const where = r.venue || r.state || null;
              const dates = [dm(r.start_date), dm(r.end_date)].join(" – ");
              return (
                <div key={r.id} onClick={() => onOpen(r.id)} className="card" style={{ cursor: "pointer", ...(dimmed ? { opacity: 0.55, filter: "grayscale(.5)" } : null) }}>
                  <div className="card-b" style={{ padding: "12px 13px" }}>
                    {/* Build Spec §27: project_title wraps 2 lines (no ellipsis) +
                        stage badge right; branding/venue chips; dates · PIC meta. */}
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)", lineHeight: 1.3 }}>{r.name || "—"}</span>
                      {salesList ? (
                        (r.sales_tasks_total ?? 0) > 0 ? (
                          <span
                            className="spill"
                            style={{ flex: "none", background: STAGE_TINT.open.bg, color: STAGE_TINT.open.fg, border: "none" }}
                            title={`Your tasks · ${r.sales_tasks_done ?? 0}/${r.sales_tasks_total} done`}
                          >
                            MY TASKS <span style={{ opacity: 0.6 }}>{r.sales_tasks_done ?? 0}/{r.sales_tasks_total}</span>
                          </span>
                        ) : (
                          <StageBadge stage={r.stage} />
                        )
                      ) : (
                        <SectionStageBadge row={r} />
                      )}
                    </div>
                    {(r.brand || where) && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                        {r.brand && <ListChip>{r.brand}</ListChip>}
                        {where && <ListChip>{where}</ListChip>}
                      </div>
                    )}
                    {/* Crew cards: the caller's own due pending tasks (owner
                        2026-07-21) — my_pending_titles is attached server-side
                        for driver/helper/storekeeper callers only. */}
                    {!!(r as any).my_pending_titles && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                        {String((r as any).my_pending_titles).split("|").map((t: string) => (
                          <span key={t} className="rbadge" style={{ background: "#fdf1e3", color: "#a16a2e" }}>
                            ⏳ {t}
                          </span>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid #f0f1ed" }}>
                      <span className="tnum" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--mut)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {dates}{r.pic_name ? <> · PIC <b style={{ color: "#414539" }}>{r.pic_name}</b></> : ""}
                      </span>
                      {salesList
                        ? (r.sales_tasks_total ?? 0) > 0 && (
                            <MiniProgress pct={(100 * (r.sales_tasks_done ?? 0)) / (r.sales_tasks_total as number)} />
                          )
                        : typeof r.progress_pct === "number" && <MiniProgress pct={r.progress_pct} />}
                    </div>
                  </div>
                </div>
              );
                }}
              />
            )}
            {/* Infinite-scroll sentinel — the IntersectionObserver watches this
                1px marker at the list's bottom; it enters view (+600px) near the
                end and pulls the next page. Only present while more pages exist. */}
            {visibleRows.length > 0 && hasNextPage && (
              <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
            )}
            {/* "Loading more…" while the next page is in flight; nothing once
                every page is loaded (hasNextPage false). */}
            {visibleRows.length > 0 && isFetchingNextPage && (
              <div style={{ textAlign: "center", padding: "14px 0 2px", fontSize: 11.5, color: "#9aa093" }}>Loading more…</div>
            )}
            {!visibleRows.length && !searchTransition.isSearching && (
              <div className="empty">
                <div className="empty-t">No projects</div>
                <div className="empty-s">No projects match this filter.</div>
              </div>
            )}
          </>
        )}
      </div>
      {creating && (
        <NewProjectSheet
          notify={notify}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); onOpen(id); }}
        />
      )}
    </div>
  );
}

// ── Detail ──
function ProjectDetailView({ id, onBack }: { id: number; onBack: () => void }) {
  const { pageAccess, can, user } = useAuth();
  // NOTE: the old `canSeeFinance = pageAccess("projects.finances") !== "none"`
  // is gone. It was only ever the FALLBACK arm of the finance gate, and it
  // answered a different question (page matrix) than the one being asked (the
  // PMS FINANCIAL section). The gate now reads `access.canFinancial` — the
  // server's own answer — with no second source to drift from. The desktop
  // Projects.tsx finance gate does the same.
  // Sales quick-log gate — ONE helper, shared with desktop, so the two surfaces
  // cannot drift off requirePageAccess("sales") on POST /api/sales/entries.
  const salesAccess = pageAccess("sales");
  const canLogSale = canLogSalesEntry(salesAccess);
  const canWrite = can("projects.write");
  const canManage = can("projects.manage");
  const canTick = canWrite || can("projects.checklist.tick");

  const qc = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);
  // Owner 2026-07-21: the system project code is unreadable at full length —
  // the header meta collapses to one ellipsised line, tap toggles the full string.
  const [metaExpanded, setMetaExpanded] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-pms-detail", id],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${id}`),
    staleTime: 15_000,
  });

  // THE server's decision for this user × project, read fail-closed. One reader,
  // shared with the desktop Projects.tsx (auth/projectAccess) — desktop and
  // mobile are one logic layer. Resolved up here so it can gate the FETCHES
  // below, not just the rendering: "off" means the query never fires.
  //
  // `data == null` (still loading) resolves to all-denied, which is the same
  // answer the old code gave and is what keeps the phase-photos fetch from
  // firing before we know.
  const access = readProjectAccess(data);
  const accessUnresolved = projectAccessUnresolved(data);

  // Setup & Dismantle section (crew editor + phase photos) is section-gated by
  // the PMS role (owner 2026-07-15): hidden from every non-director Sales user,
  // even the project's own PIC — single logic layer with the desktop
  // Projects.tsx gate. The backend strips the crew + document rows either way.
  // Computed up here so it can also gate the phase-photos fetch below (off, not
  // hide — no fetch when the section is hidden).
  //
  // Reads the ONE fail-closed reader (auth/projectAccess) — desktop and mobile
  // share that logic layer. The `(data._access?.level ?? "full") === "full"`
  // fallback is gone: it made a MISSING permission payload mean full access.
  const canSetupDismantle = access.canSetupDismantle;

  // Crew-uploaded setup/dismantle evidence photos (mig 084) live on a
  // separate endpoint. Used only for the uploader credit on the Setup &
  // dismantle block — a 403 (no phase access) just yields no credit.
  const { data: photoData } = useQuery({
    queryKey: ["mobile-pms-phase-photos", id],
    queryFn: () => api.get<{ photos: PhasePhoto[] }>(`/api/projects/${id}/phase-photos`),
    staleTime: 15_000,
    // Owner 2026-07-28: the S&D card is view-for-all — every viewer loads the
    // phase photos (the endpoint admits any projects.read holder).
    retry: false,
  });
  const photos = photoData?.photos ?? [];

  // Reference-data for the write forms. All best-effort (retry:false): a rep
  // whose token lacks the perm gets 403 → empty list → the select just shows
  // the current value with no options, never crashes.
  const picUsersQ = useQuery({
    queryKey: ["mobile-pms-pic-users"],
    queryFn: () => api.get<{ users: PicUser[] }>(`/api/users?department=${encodeURIComponent("Sales")}`),
    staleTime: 5 * 60_000,
    enabled: canWrite,
    retry: false,
  });
  const picUsers = picUsersQ.data?.users ?? [];

  const salesRepsQ = useQuery({
    queryKey: ["mobile-pms-sales-reps"],
    queryFn: () => api.get<{ data: SalesRepOption[] }>(`/api/projects/sales-rep-options`),
    staleTime: 5 * 60_000,
    enabled: canWrite,
    retry: false,
  });
  const salesReps = salesRepsQ.data?.data ?? [];

  const fleetQ = useQuery({
    queryKey: ["mobile-pms-fleet"],
    queryFn: () => api.get<{ data: FleetStaff[] }>(`/api/fleet/staff`),
    staleTime: 5 * 60_000,
    // Only feeds the Setup & Dismantle crew editor — skip the fetch when the
    // section is hidden (off, not hide).
    enabled: canWrite && canSetupDismantle,
    retry: false,
  });
  const drivers = useMemo(
    () => (fleetQ.data?.data ?? []).filter((s) => (s.role_name ?? "").toLowerCase() === "driver"),
    [fleetQ.data],
  );

  // Lorry list (GET /api/scm/lorries → { lorries: [...] }). Best-effort; a
  // reader without scm access gets [] and the picker shows only the current value.
  const lorriesQ = useQuery({
    queryKey: ["mobile-pms-lorries"],
    queryFn: () => api.get<{ lorries: Lorry[] }>(`/api/scm/lorries`),
    staleTime: 5 * 60_000,
    // Only feeds the Setup & Dismantle crew editor — skip when it's hidden.
    enabled: canWrite && canSetupDismantle,
    retry: false,
  });
  const lorries = lorriesQ.data?.lorries ?? [];

  // Mark the project read when the detail opens (drives the unread bell).
  useEffect(() => {
    api.post(`/api/projects/${id}/read`).catch(() => {});
  }, [id]);

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ["mobile-pms-detail", id] });
    // Prefix MUST match the list query (["mobile-pms-list-paged", …]);
    // "mobile-pms-list" is not a prefix of it, so it never invalidated → the
    // project list stayed stale after any detail mutation until staleTime.
    void qc.invalidateQueries({ queryKey: ["mobile-pms-list-paged"] });
  };
  const reloadPhotos = () => qc.invalidateQueries({ queryKey: ["mobile-pms-phase-photos", id] });

  // Defect action timeline (owner 2026-07-29) — who may stamp Ongoing/Done on
  // defect uploads: the purchaser (Sim), BD, and wildcard/manage admins.
  const defectActionsValue = useMemo(
    () => ({
      actions: (((data as any)?.checklist_attachment_actions ?? []) as AttachmentAction[]),
      // Two-stage defect triage (owner 2026-08-07; two-warehouse split
      // 2026-08-11): canReview = the reviewer for THIS project's state — Nancy
      // (Ops Exec role) for the region states, Shukor (Storekeeper Supervisor)
      // for every other state; admin always. canPurchase = purchaser (Sim /
      // Farra) / BD or admin closes an escalated (Replace) defect. Mirrors desktop.
      canReview: (() => {
        if (!user) return false;
        const perms = user.permissions ?? [];
        if (perms.includes("*") || perms.includes("projects.manage")) return true;
        const region = new Set(["pulau pinang", "kelantan", "terengganu", "perak"]);
        const inRegion = region.has(((data as any)?.project?.state ?? "").trim().toLowerCase());
        const isShukor = /^storekeeper supervisor$/i.test((user.position_name ?? "").trim());
        const isNancy = /^ops exec$/i.test((user.role_name ?? "").trim());
        return (isShukor && !inRegion) || (isNancy && inRegion);
      })(),
      canPurchase:
        !!user &&
        (user.permissions?.includes("*") ||
          user.permissions?.includes("projects.manage") ||
          /purchaser|bd/i.test(user.role_name ?? "")),
      reload,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, user],
  );

  // Central PATCH /:id helper (project-detail edits, PIC, status, stage,
  // setup/dismantle logistics). Surfaces the "shifted N tasks" hint the
  // backend returns when a date move re-dates the checklist.
  const patchProject = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await api.patch<{ shifted_tasks?: number; delta_days?: number }>(`/api/projects/${id}`, body);
      reload();
      if (res?.shifted_tasks && res.shifted_tasks > 0) {
        const days = res.delta_days ?? 0;
        await notify({
          title: "Saved",
          body: `Shifted ${res.shifted_tasks} task${res.shifted_tasks === 1 ? "" : "s"} ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ${days > 0 ? "forward" : "back"}.`,
        });
      }
      return true;
    } catch (e) {
      await notify({ title: "Save failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const p = data?.project;
  const archived = !!p?.archived_at;
  // Show finance only when the server says canFinancial AND it actually returned
  // the finance block (it strips it server-side for a role whose PMS position
  // lacks FINANCIAL). Gating follows the real backend permission — no in-screen
  // view-as switcher (removed to match v4).
  //
  // The `pms ? … : canSeeFinance` fallback is gone. `canSeeFinance` is the PAGE
  // matrix level, a different question from the PMS FINANCIAL section, so an
  // unresolved payload used to answer the finance question with the page answer.
  const financeVisible = access.canFinancial && !!data?.finance;
  // ── Mobile role-based checklist visibility (owner 2026-07-16) ──────────────
  // Gate specific items/sections by the viewer's org role. Keyed off stable org
  // fields (position_name / department_name / role_name), mirroring
  // salesAccess.ts. "mgt" = Management department or a director position; "BD" =
  // the BD Exec role; owner = the `*` wildcard.
  const _pos = (user?.position_name ?? "").trim();
  const _dept = (user?.department_name ?? "").trim();
  const _roleName = (user?.role_name ?? "").trim();
  const isOwnerAdmin = !!user?.permissions?.includes("*");
  /* The DIRECTOR term is now the backend's own answer (`org.director` =
     pmsAccess.isDirectorUser, resolved on /auth/me), not a local regex.

     It WAS /\b(Super Admin|Sales Director|Finance Manager)\b/i — the exact
     word-boundary test that pmsAccess.ts and auth/salesAccess.ts both replaced
     with an exact-name Set, and for a documented reason: position names are
     owner-editable free text, so a \b substring match turns a RENAME into a
     privilege grant. "Assistant to Sales Director" or "Deputy Finance Manager"
     inherited management visibility here — the last copy of a hole that had been
     closed everywhere else. `org.director` also folds in the `*` wildcard
     (isDirectorUser checks it), so isOwnerAdmin is subsumed; it is kept in the
     OR below only because `seeAllTasks` reads it separately.

     NO LIVE DELTA: over every position in the prod snapshot the old regex and
     the exact-name set agree, so this narrows nothing that exists today — it
     removes the way a future rename could widen it. */
  const isDirectorPos = capability(user, "org.director");
  const isMgt = isOwnerAdmin || isDirectorPos || /^management$/i.test(_dept);
  const isBD = /bd\s*exec|business\s*develop/i.test(_roleName);
  const isDriverCrew = /\b(Driver|Helper)\b/i.test(_pos);
  // Owner 2026-08-28: the admin-created "Warehouse Crew KL" position (mixed
  // Helper + Storekeeper roles) rides the storekeeper arm of every crew gate.
  const isStorekeeper = /storekeeper/i.test(_pos) || /^warehouse crew/i.test(_pos);
  const isLogistic = /logistic/i.test(_pos);
  // Purchasers are matched by POSITION OR ROLE — the live purchasers (Farra,
  // Sim) hold the Purchaser ROLE on an "Operation Executive" position, so a
  // position-only test missed the actual purchasing staff (owner 2026-07-23).
  const isPurchaser = /purchas|procurement/i.test(_pos) || /purchas/i.test(_roleName);
  const isSalesStaff = /sales/i.test(_dept) || /^sales/i.test(_pos);
  const seeAllTasks = isOwnerAdmin || isMgt || isBD;
  // Field/sales cohort (owner 2026-07-16): driver, helper, storekeeper, sales
  // executive/manager get a SIMPLIFIED mobile view — Project + Team + OPERATION
  // tasks + the Floor Plans & Setup/Dismantle cards; the pipeline bar, payment
  // card, and the payment/closeout/booth/setup-dismantle-docs/expo tasklist
  // sections are hidden.
  const isSalesExecMgr = isSalesStaff && !isMgt;
  const cohort5 = isDriverCrew || isStorekeeper || isSalesExecMgr;
  // Sales-section visibility — mirror the desktop split (Projects.tsx:9914-9918):
  // the Sales panel is gated on sales VIEW access (page-access OR sales-staff OR
  // director), NOT on canFinancial. The desktop renders ProjectSalesEntriesSection
  // outside the finance gate for exactly this reason — a non-financial salesperson
  // (isSalesExecMgr) HOLDS the log-sale action but has canFinancial=false, so
  // nesting it under the finance gate lost the action for the person who owns it.
  const canViewSales = salesAccess !== "none" || isSalesStaff || isDirectorPos;
  // ── Owner 2026-07-23 card respec — the remaining two cohorts go card-based ──
  // cohortMgmt = management dept / directors / owner / BD; cohortOps = the
  // office/ops staff left over (Nancy, Farra, Sim, Syu, Syasya, logistic
  // admins, purchasers…). Field staff (cohort5: sales exec/mgr, driver,
  // helper, storekeeper) keep their existing card views untouched.
  const cohortMgmt = isMgt || isBD;
  // Purchasers (Sim, Farra) get their OWN minimal view (owner 2026-07-23):
  // Team + a three-tile S&D documents card + the floorplan card (display,
  // 3D/2D, stock records with edit). Everything else is removed for them,
  // so they sit outside the generic ops cohort.
  const isPurchaserView = isPurchaser && !cohortMgmt && !cohort5;
  const cohortOps = !cohort5 && !cohortMgmt && !isSalesStaff && !isPurchaserView;
  // Named editors (owner spec): "BD, weisiang, kingsley". Matched by stable
  // user id — names are owner-editable free text (weisiang = id 4 "Lim",
  // kingsley = id 44 "Kingsley"/Sales Director, the Agreement Approver).
  const isWeisiangDev = user?.id === 4;
  const isKingsley = user?.id === 44;
  const isFinanceRole = /finance/i.test(_roleName) || /^finance manager$/i.test(_pos);
  const isSalesDirectorPos = /^sales\s*director$/i.test(_pos);
  // Doc-edit tiers: BD-domain documents (license, weekend, stamp duty, permit,
  // decoration, payment, S&D docs) are editable by owner/BD/weisiang; the
  // Agreement/Quotation contract additionally by Kingsley.
  const canBdEdit = isOwnerAdmin || isBD || isWeisiangDev;
  const canContractEdit = canBdEdit || isKingsley;
  // P&L: edit for owner/BD/weisiang/finance; VIEW-ONLY for sales directors;
  // hidden from everyone else (server already strips finance data for
  // non-director callers via access.canFinancial).
  const financeRoleAllowed = isOwnerAdmin || isBD || isWeisiangDev || isFinanceRole || isSalesDirectorPos;
  const financeCanEdit = isOwnerAdmin || isBD || isWeisiangDev || isFinanceRole;
  const cohortHiddenSection = (name: string) =>
    /payment|closeout|booth layout|setup\s*&?\s*dismantle documents|expo map/i.test(name);
  const sectionNameById = new Map((data?.sections ?? []).map((s) => [s.id, s.name] as const));
  // Section ids for "SETUP & DISMANTLE DOCUMENTS" (used for per-role part filtering).
  const sdSectionIds = new Set(
    (data?.sections ?? []).filter((s) => /setup\s*&?\s*dismantle/i.test(s.name)).map((s) => s.id)
  );
  const itemHidden = (it: ChecklistItem): boolean => {
    const title = (it.title ?? "").trim().toLowerCase();
    const label = (it.role_label ?? "").trim().toUpperCase();
    // Filled Floorplan now lives on the Floor Plans & Layout card (view for all,
    // upload for sales), so its tasklist row is redundant on mobile (owner
    // 2026-07-17).
    if (/^filled\s*floor\s*plan/.test(title)) return true;
    // Field/sales cohort: whole tasklist sections removed (kept: OPERATION etc.).
    // Owner 2026-07-16 (2nd pass): sales executives/managers must still get
    // their OWN deliverables — anything badged SALES PIC (Setup Image, Defect
    // List, Event Complete Image, Filled Floorplan) stays visible for them in
    // every section; the rest of the simplified view is unchanged.
    if (cohort5 && cohortHiddenSection(sectionNameById.get(it.section_id ?? -1) ?? "")) {
      if (!(isSalesExecMgr && label === "SALES PIC")) return true;
    }
    // License / Stamp Duty → only BD, management, owner. (Titles carry suffixes
    // like "License (from Majlis)", so match by prefix.)
    if (title.startsWith("license") || title.startsWith("stamp duty")) return !seeAllTasks;
    // Weekend Activity → hidden from helper, driver, logistic, purchaser.
    if (title.startsWith("weekend")) return isDriverCrew || isLogistic || isPurchaser;
    // Setup & Dismantle documents → each role sees only its own part.
    if (it.section_id != null && sdSectionIds.has(it.section_id)) {
      if (seeAllTasks) return false;
      // includes(): a combined badge ("SALES PIC & DRIVER" — the Defect List
      // Setup/Dismantle pair, owner 2026-07-29) shows to every listed role.
      if (isDriverCrew || isStorekeeper) return !label.includes("DRIVER");
      if (isPurchaser) return label !== "PURCHASER";
      if (isLogistic) return !(label.includes("SALES PIC") || label.includes("DRIVER"));
      if (isSalesStaff) return !label.includes("SALES PIC");
      return false;
    }
    return false;
  };
  const visibleChecklist = (data?.checklist ?? []).filter((it) => !itemHidden(it));
  // Owner 2026-07-21 (re-reversed): the Filled floorplan tile is hidden from
  // crew again — their Floor Plans card keeps Display (tile), Unfilled
  // (view/download) and the stock-transfer records (view/download).
  const hideFilledPlan = isDriverCrew || isStorekeeper;
  // Owner 2026-07-23: the Unfilled/Filled floorplan tiles are for sales,
  // sales director, management and BD only — the ops/office cohort keeps the
  // card (Display tile, 3D/2D design, stock records) without them.
  const hidePlanTiles = cohortOps || isPurchaserView;

  // ── Owner 2026-07-23 card respec — tile sets for the two new cohorts ──
  // Ops/office cohort: view & download only, except purchasers who keep edit
  // on their two deliverables. Contract + Payment cards are NOT rendered for
  // this cohort at all; License / Weekend Activity / Stamp Duty are absent.
  const opsOperationTiles: DocTile[] = [
    { label: "Permit", match: /permit/i, readOnly: true },
    { label: "Decoration", match: /^deco/i, readOnly: true, remarkWithFiles: true },
  ];
  const opsSdTiles: DocTile[] = [
    { label: "Setup Image (Driver)", match: /^setup image/i, driverOnly: true, readOnly: true },
    { label: "Setup Image (Sales PIC)", match: /^setup image/i, salesPicOnly: true, readOnly: true },
    { label: "Defect Item Setup", match: /^defect (list|item) setup/i, readOnly: true },
    { label: "Defect Item Dismantle", match: /^defect (list|item) dismantle/i, readOnly: true },
    { label: "Event Complete Image", match: /^event complete image/i, readOnly: true },
    { label: "Dismantle Image", match: /^dismantle image/i, readOnly: true },
  ];
  // Purchaser view (Sim, Farra): exactly three S&D tiles — Defect List to
  // consult, their own two deliverables to edit.
  const purchaserSdTiles: DocTile[] = [
    { label: "Defect Item Setup", match: /^defect (list|item) setup/i, readOnly: true },
    { label: "Defect Item Dismantle", match: /^defect (list|item) dismantle/i, readOnly: true },
    { label: "Exchange List", match: /^exchange list/i },
    { label: "Stock In Transfer Record", match: /^stock in transfer/i },
  ];
  // Management cohort (mgt / sales director / BD / owner): everything view &
  // download; the BD tier (owner/BD/weisiang) edits, Kingsley additionally
  // edits the contract. License shows only to the BD tier.
  const mgmtContractTiles: DocTile[] = [
    { label: "Agreement / Quotation", match: /^agreement/i, readOnly: !canContractEdit, fullWidth: true },
  ];
  // Arrangement per the owner's 2026-07-23 sketch: License + Stamp Duty row,
  // Permit full-width ("big"), then Weekend Activity + Decoration row.
  const mgmtOperationTiles: DocTile[] = [
    ...(canBdEdit ? [{ label: "License", match: /^license/i }] : []),
    // Owner 2026-07-28: Stamp Duty is hidden from the Sales Director view
    // (sales staff never had it); mgt/BD/owner keep the tile.
    ...(isSalesDirectorPos ? [] : [{ label: "Stamp Duty", match: /^stamp duty/i, readOnly: !canBdEdit }]),
    { label: "Permit", match: /permit/i, readOnly: !canBdEdit, fullWidth: true, mediaH: 108 },
    { label: "Weekend Activity", match: /^weekend/i, remarkTile: true, readOnly: !canBdEdit },
    { label: "Decoration", match: /^deco/i, readOnly: !canBdEdit, remarkWithFiles: true },
  ];
  const mgmtPaymentTiles: DocTile[] = [
    { label: "Rental Payment", match: /^rental payment/i, readOnly: !canBdEdit },
    { label: "Security Deposit", match: /^security deposit/i, readOnly: !canBdEdit },
  ];
  const mgmtSdTiles: DocTile[] = [
    { label: "Setup Image (Driver)", match: /^setup image/i, driverOnly: true, readOnly: !canBdEdit },
    { label: "Setup Image (Sales PIC)", match: /^setup image/i, salesPicOnly: true, readOnly: !canBdEdit },
    { label: "Defect Item Setup", match: /^defect (list|item) setup/i, readOnly: !canBdEdit },
    { label: "Defect Item Dismantle", match: /^defect (list|item) dismantle/i, readOnly: !canBdEdit },
    { label: "Exchange List", match: /^exchange list/i, readOnly: !canBdEdit },
    { label: "Event Complete Image", match: /^event complete image/i, readOnly: !canBdEdit },
    { label: "Dismantle Image", match: /^dismantle image/i, readOnly: !canBdEdit },
    // Owner 2026-07-31: a HALF tile again, so it sits beside Dismantle Image.
    // It was pinned full-width on 2026-07-23 when it was the odd 7th tile;
    // splitting Defect List into Setup + Dismantle made the count even (8), so
    // full-width now strands Dismantle Image alone with a gap next to it.
    { label: "Stock In Transfer Record", match: /^stock in transfer/i, readOnly: !canBdEdit },
  ];
  // Owner 2026-07-18: PIC assignment AND Sales-Attending assignment are open to
  // EVERYONE holding projects.write EXCEPT the Sales Director — same single
  // logic layer as the desktop ProjectTeamSection (canAssignPeople). This
  // SUPERSEDES the old director/logistics (pms.canEdit) + own-PIC gates on these
  // two pickers. Sales Director matched by EXACT normalised name
  // (isSalesDirectorUser), never a \b substring, so a free-text rename can't
  // drift the block. Backend re-enforces the same rule (PATCH pic_id +
  // POST/DELETE sales-attendees); this is UX/defence-in-depth only.
  // Owner 2026-07-21: the Sales-Director assignment block is reversed (backend
  // gates already open) — projects.write is enough to assign PIC + attending.
  const canAssignPeople = canWrite;
  const canEditTeam = canAssignPeople;
  const canEditAttending = canAssignPeople;
  // PIC's phone from the project detail (backend populates pic_phone) — shown
  // on the mobile Team card for everyone, not just editors.
  const picPhone = formatPhone(p?.pic_phone);

  return (
    <DefectActionsCtx.Provider value={defectActionsValue}>
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr" style={{ background: "var(--ink-dark)", borderBottom: "none" }}>
        <div className="hdr-row" style={{ marginBottom: 10, gap: 7 }}>
          <button className="back" onClick={onBack} aria-label="Back to list" style={{ color: "#d8a85a" }}>
            <span className="chev">‹</span> Projects
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {p && canManage && (
              <button
                className="tinybtn"
                disabled={busy}
                style={{ background: "rgba(255,255,255,.08)", borderColor: "rgba(231,234,228,.18)", color: "#e7eae4" }}
                onClick={async () => {
                  if (archived) {
                    setBusy(true);
                    try {
                      await api.post(`/api/projects/${id}/unarchive`);
                      reload();
                    } catch (e) {
                      await notify({ title: "Restore failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
                    } finally { setBusy(false); }
                    return;
                  }
                  if (!(await confirm({ title: "Archive this project?", confirmLabel: "Archive", danger: true }))) return;
                  setBusy(true);
                  try {
                    await api.post(`/api/projects/${id}/archive`);
                    reload();
                  } catch (e) {
                    await notify({ title: "Archive failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
                  } finally { setBusy(false); }
                }}
              >
                {archived ? "Restore" : "Archive"}
              </button>
            )}
            {/* Owner 2026-07-20: project-level edits (status + Edit here)
                require the PMS EDIT section — sales roles (pms.canEdit=false)
                get the read-only badge instead. */}
            {p && canWrite && access.canEdit && !archived && (
              <select
                value={p.status ?? ""}
                disabled={busy}
                onChange={(e) => { void patchProject({ status: e.target.value }); }}
                className="tinybtn"
                style={{ background: "rgba(216,168,90,.16)", borderColor: "rgba(216,168,90,.4)", color: "#d8a85a" }}
                aria-label="Change status"
              >
                {PROJECT_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            )}
            {/* Edit lived on the (removed) Project card's summary — the card
                is gone (owner 2026-07-22: header carries all its info), so the
                sequential-prompt editor moved up here. Same flow, same gate. */}
            {p && canWrite && access.canEdit && !archived && (
              <button
                className="tinybtn"
                disabled={busy}
                aria-label="Edit project"
                style={{ background: "rgba(255,255,255,.08)", borderColor: "rgba(231,234,228,.18)", color: "#e7eae4" }}
                onClick={async () => {
                  if (busy) return;
                  // Sequential single-field prompts (usePrompt returns one
                  // value); each null/cancel ends the flow, blanks are skipped.
                  const fields: Array<[string, string, string | null | undefined]> = [
                    ["name", "Project name", p.name],
                    ["booth_no", "Booth number", p.booth_no],
                    ["venue", "Venue", p.venue],
                    ["organizer", "Organizer", p.organizer],
                    ["start_date", "Start date (YYYY-MM-DD)", p.start_date],
                    ["end_date", "End date (YYYY-MM-DD)", p.end_date],
                  ];
                  const patch: Record<string, unknown> = {};
                  for (const [key, label, cur] of fields) {
                    const val = await prompt({ title: `Edit ${label}`, placeholder: label, defaultValue: (cur ?? "") as string });
                    if (val == null) break; // cancelled — stop the flow
                    const t = val.trim();
                    if (key === "name" && !t) continue; // name can't be blanked
                    if (t !== (cur ?? "")) patch[key] = t || null;
                  }
                  if (Object.keys(patch).length > 0) await patchProject(patch);
                }}
              >
                Edit
              </button>
            )}
          </div>
        </div>
        {/* Title block — owner's 2026-07-22 header mockup, all users: stage
            badge on its own line under the back row (lowercase), then the
            title-cased project name, then a dates | booth line, then the
            system-code line (code only, single-line ellipsis, tap-to-expand).
            This header is the ONLY place for project facts now — the Project
            info card below was removed the same day (its brand/organizer/venue
            rows repeated what the title already says). */}
        {p && (
          <div style={{ marginTop: 8 }}>
            <StageBadge stage={p.stage} lower />
          </div>
        )}
        <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", lineHeight: 1.3, marginTop: 7 }}>{p?.name ? titleCaseName(p.name) : "—"}</div>
        {p && (
          <div className="money" style={{ fontSize: 12.5, fontWeight: 700, color: "#e7eae4", marginTop: 5 }}>
            {dm(p.start_date)} – {dm(p.end_date)}
            {p.booth_no ? (
              <>
                <span style={{ color: "#5c6156", fontWeight: 400, margin: "0 7px" }}>|</span>
                Booth {p.booth_no}
              </>
            ) : null}
          </div>
        )}
        <div
          role="button"
          aria-label="Project code"
          aria-expanded={metaExpanded}
          onClick={() => setMetaExpanded((v) => !v)}
          style={{
            fontSize: 11.5, color: "#8c968a", marginTop: 5,
            ...(metaExpanded
              ? { whiteSpace: "normal" as const, wordBreak: "break-all" as const }
              : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }),
          }}
        >
          {p?.code || "—"}
        </div>
      </header>

      <div className="scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {isLoading && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "#b23a3a", fontSize: 12, padding: "26px 0" }}>Couldn't load this project.</div>}

        {!isLoading && !error && data && p && (
          <>
            {/* The project loaded but carried NO permission payload, so every
                section gate reads false and most of this screen is missing.
                Safe, but say WHICH it is: a system failure sends the operator to
                IT, "no permission" sends them to their manager. Same wording and
                same trigger as the desktop Projects.tsx banner — one logic layer. */}
            {accessUnresolved && (
              <div
                role="alert"
                style={{
                  border: "1px solid #b23a3a", borderRadius: 8, padding: "10px 12px",
                  marginBottom: 12, fontSize: 12, lineHeight: 1.45, color: "#b23a3a",
                  background: "rgba(178,58,58,0.06)",
                }}
              >
                We couldn't load your permissions for this project, so some sections
                are hidden. This is a system problem, not a restriction on your
                account — please reload, and tell IT if it persists.
              </div>
            )}

            {/* stage pipeline (design "Pipeline" card) — owner 2026-07-23:
                removed for the ops/office AND management cohorts too (was
                already hidden from the field/sales cohort and the owner), so
                no mobile cohort renders it any more. */}
            {!cohort5 && !isOwnerAdmin && !cohortMgmt && !cohortOps && !isPurchaserView && <StagePipeline stage={p.stage} sections={data.section_progress} />}

            {/* The Project info card (Venue / Organizer / Branding rows) is
                GONE — owner 2026-07-22: the header already carries all of it
                (title = "State [Brand] Organizer @ Venue", plus the
                dates | booth line), so the card was pure repetition. Its Edit
                button moved into the header controls row. */}

            {/* project team */}
            <details className="pacc" open>
              <summary>
                <span className="psec-t">Team</span>
                <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
              </summary>
              <div className="pbody">
                {canEditTeam && !archived ? (
                  <>
                    <label className="fld" style={{ marginBottom: picPhone ? 4 : 10 }}>
                      <span className="fld-l">PIC</span>
                      <select
                        className="fld-i"
                        style={{ fontWeight: p.pic_id != null ? 700 : 400 }}
                        disabled={busy}
                        value={p.pic_id ?? ""}
                        onChange={(e) => { const v = e.target.value; void patchProject({ pic_id: v ? parseInt(v, 10) : null }); }}
                      >
                        <option value="">— unassigned —</option>
                        {p.pic_id != null && p.pic_name && !picUsers.some((u) => u.id === p.pic_id) && (
                          <option value={p.pic_id}>{p.pic_name} (out of scope)</option>
                        )}
                        {picUsers.map((u) => (
                          <option key={u.id} value={u.id}>{u.name || u.email}</option>
                        ))}
                      </select>
                    </label>
                    {picPhone && (
                      <a href={`tel:${(p.pic_phone || "").replace(/[^\d+]/g, "")}`} style={{ display: "block", marginBottom: 10, fontSize: 13, fontWeight: 600, color: "#6b6f63", textDecoration: "none" }}>
                        📞 {picPhone}
                      </a>
                    )}
                  </>
                ) : (
                  <div className="pgrid2" style={{ marginBottom: 10 }}>
                    <div style={{ gridColumn: "1 / -1" }}>
                      <div className="pkv-l">PIC</div>
                      <div className="pkv-v">
                        {p.pic_name || "—"}
                        {picPhone && <span style={{ color: "#6b6f63", fontWeight: 600 }}> · {picPhone}</span>}
                      </div>
                    </div>
                  </div>
                )}
                <SalesAttending
                  projectId={id}
                  attendees={data.sales_attendees ?? []}
                  options={salesReps}
                  canWrite={canEditAttending && !archived}
                  busy={busy}
                  setBusy={setBusy}
                  notify={notify}
                  confirm={confirm}
                  reload={reload}
                />
              </div>
            </details>

            {/* tasklist — REMOVED for the sales cohort (owner 2026-07-17), for
                crew (owner 2026-07-21), and now for the ops/office AND
                management cohorts too (owner 2026-07-23 card respec): every
                mobile cohort's deliverables live in doc-tile cards. The row
                list only renders for a user matching NO cohort (a safety
                fallback that shouldn't occur in practice). */}
            {!isSalesExecMgr && !(isDriverCrew || isStorekeeper) && !cohortOps && !cohortMgmt && !isPurchaserView && <TasklistSectionView
              sections={data.sections}
              items={visibleChecklist}
              progress={data.section_progress}
              attachments={data.checklist_attachments}
              projectStart={p.start_date}
              projectEnd={p.end_date}
              canTick={canTick && !archived}
              can={can}
              busy={busy}
              setBusy={setBusy}
              notify={notify}
              prompt={prompt}
              projectId={id}
              reload={reload}
            />}

            {/* setup & dismantle (logistic) — FIELD cohort position (sales/
                crew keep it up here, above their doc cards). For the ops +
                management cohorts it renders further down instead, between
                Operation and S&D documents (owner 2026-07-23 order). Owner
                2026-07-17: Sales may VIEW it (crew + dates) but stay
                read-only, since PIC/SALES lack the PMS "EDIT" section. */}
            {cohort5 && !isPurchaserView && (
              <SetupDismantle
                projectId={id}
                project={p}
                photos={photos}
                drivers={drivers}
                lorries={lorries}
                /* `canEdit !== false` treated BOTH an absent pms block and an
                   omitted flag as writable. Now the server's answer, fail-closed. */
                canWrite={canWrite && access.canEdit && !archived}
                /* Crew manage the setup/dismantle photos (owner 2026-07-21);
                   the backend re-gates on being crewed on the phase. */
                canPhoto={(isDriverCrew || isStorekeeper) && !archived}
                /* Schedule reference (owner 2026-07-29): hidden from all —
                   logistic views/downloads, the BD/owner tier (canBdEdit:
                   owner/BD/weisiang) uploads/removes. */
                canScheduleView={isLogistic || canBdEdit}
                canScheduleEdit={canBdEdit && !archived}
                busy={busy}
                setBusy={setBusy}
                patchProject={patchProject}
                notify={notify}
                reloadPhotos={reloadPhotos}
                confirm={confirm}
                prompt={prompt}
              />
            )}

            {/* Setup & Dismantle documents as TILES (owner 2026-07-17) — the
                sales cohort's six deliverables in the Floor-Plans card style.
                The tasklist rows stay; this is the visual hub on top. */}
            {isSalesStaff && !isMgt && (
              <SalesDocsCard
                checklist={data.checklist}
                attachments={data.checklist_attachments}
                canTick={canTick && !archived}
                busy={busy}
                setBusy={setBusy}
                notify={notify}
                prompt={prompt}
                confirm={confirm}
                reload={reload}
              />
            )}

            {/* Crew (driver/helper/storekeeper) doc tiles (owner 2026-07-21 v2)
                — same card style as sales, ALL view/download-only (their photo
                work lives in Setup & Dismantle's phase photos). Replaces their
                tasklist rows (hidden above). */}
            {(isDriverCrew || isStorekeeper) && (
              <SalesDocsCard
                tiles={CREW_DOC_TILES}
                title="Event documents"
                checklist={data.checklist}
                attachments={data.checklist_attachments}
                canTick={canTick && !archived}
                busy={busy}
                setBusy={setBusy}
                notify={notify}
                prompt={prompt}
                confirm={confirm}
                reload={reload}
              />
            )}

            {/* Purchaser view (owner 2026-07-23, Sim & Farra): ONLY Team +
                these three S&D tiles + the floorplan card below. */}
            {isPurchaserView && (
              <SalesDocsCard
                tiles={purchaserSdTiles}
                title="Setup & Dismantle documents"
                checklist={data.checklist}
                attachments={data.checklist_attachments}
                canTick={canTick && !archived}
                busy={busy} setBusy={setBusy} notify={notify} prompt={prompt} confirm={confirm} reload={reload}
              />
            )}

            {/* Owner's 2026-07-23 section order for the office cohorts:
                TEAM → CONTRACT → PAYMENT → OPERATION → S&D LOGISTIC →
                S&D DOCUMENTS → FLOORPLANS → SALES → P&L. */}
            {cohortMgmt && (
              <>
                {canContractEdit && (
                  <SalesDocsCard
                    tiles={mgmtContractTiles}
                    showRoleTags
                    title="Contract"
                    checklist={data.checklist}
                    attachments={data.checklist_attachments}
                    canTick={canTick && !archived}
                    busy={busy} setBusy={setBusy} notify={notify} prompt={prompt} confirm={confirm} reload={reload}
                  />
                )}
                {/* Owner 2026-07-28: the PAYMENT card is hidden from the Sales
                    Director view (sales staff never see it either). */}
                {!isSalesDirectorPos && (
                  <SalesDocsCard
                    tiles={mgmtPaymentTiles}
                    showRoleTags
                    title="Payment"
                    checklist={data.checklist}
                    attachments={data.checklist_attachments}
                    canTick={canTick && !archived}
                    busy={busy} setBusy={setBusy} notify={notify} prompt={prompt} confirm={confirm} reload={reload}
                  />
                )}
                <SalesDocsCard
                  tiles={mgmtOperationTiles}
                  showRoleTags
                  title="Operation"
                  checklist={data.checklist}
                  attachments={data.checklist_attachments}
                  canTick={canTick && !archived}
                  busy={busy} setBusy={setBusy} notify={notify} prompt={prompt} confirm={confirm} reload={reload}
                />
              </>
            )}
            {cohortOps && (
              <SalesDocsCard
                tiles={opsOperationTiles}
                title="Operation"
                showRoleTags={isLogistic}
                checklist={data.checklist}
                attachments={data.checklist_attachments}
                canTick={canTick && !archived}
                busy={busy} setBusy={setBusy} notify={notify} prompt={prompt} confirm={confirm} reload={reload}
              />
            )}

            {/* setup & dismantle (logistic) — office-cohort position, below
                Operation (owner 2026-07-23). Owner 2026-07-28: view-for-ALL
                users (incl. purchasers and PMS tiers lacking SETUP_DISMANTLE)
                — the backend now sends the schedule/crew data to every
                viewer; editing stays tiered as before. */}
            {!cohort5 && (
              <SetupDismantle
                projectId={id}
                project={p}
                photos={photos}
                drivers={drivers}
                lorries={lorries}
                canWrite={canWrite && access.canEdit && !archived}
                canPhoto={(isDriverCrew || isStorekeeper) && !archived}
                /* Schedule reference (owner 2026-07-29): hidden from all —
                   logistic views/downloads, the BD/owner tier (canBdEdit:
                   owner/BD/weisiang) uploads/removes. */
                canScheduleView={isLogistic || canBdEdit}
                canScheduleEdit={canBdEdit && !archived}
                busy={busy}
                setBusy={setBusy}
                patchProject={patchProject}
                notify={notify}
                reloadPhotos={reloadPhotos}
                confirm={confirm}
                prompt={prompt}
              />
            )}

            {cohortOps && (
              <SalesDocsCard
                tiles={opsSdTiles}
                title="Setup & Dismantle documents"
                showRoleTags={isLogistic}
                checklist={data.checklist}
                attachments={data.checklist_attachments}
                canTick={canTick && !archived}
                busy={busy} setBusy={setBusy} notify={notify} prompt={prompt} confirm={confirm} reload={reload}
              />
            )}
            {cohortMgmt && (
              <SalesDocsCard
                tiles={mgmtSdTiles}
                showRoleTags
                title="Setup & Dismantle documents"
                checklist={data.checklist}
                attachments={data.checklist_attachments}
                canTick={canTick && !archived}
                busy={busy} setBusy={setBusy} notify={notify} prompt={prompt} confirm={confirm} reload={reload}
              />
            )}

            {/* floor plans & layout + stock transfers (upload-only) */}
            <FloorPlans
              projectId={id}
              stockTransfers={data.stock_transfers}
              attachments={data.attachments}
              checklist={data.checklist}
              checklistAttachments={data.checklist_attachments}
              canWrite={canWrite && !archived}
              hideFilledPlan={hideFilledPlan}
              hidePlanTiles={hidePlanTiles}
              canStockEdit={isPurchaserView && canTick && !archived}
              confirm={confirm}
              busy={busy}
              setBusy={setBusy}
              notify={notify}
              reload={reload}
            />

            {/* Rental & Payment STATUS card removed on mobile (owner 2026-07-20):
                it duplicated the task list's PAYMENT section (Rental Payment +
                Security Deposit), which owner/directors already see there — and it
                wrote projects.payment_status while that pill writes pill_value
                (desynced). Payment status now flows only through the pill; the
                rental AMOUNT + Total Sales are editable in the snapshot below. */}

            {/* Sales — SALES-gated, split out of the finance snapshot so a
                non-financial salesperson (who HOLDS the log-sale action) can
                reach it. Mirrors desktop ProjectSalesEntriesSection, gated on
                canViewSales (NOT canFinancial). */}
            {canViewSales && !isPurchaserView && (
              <SalesPanel
                projectId={id}
                incomeLines={data.finance_lines}
                canLogSale={canLogSale && !archived}
                busy={busy}
                setBusy={setBusy}
                prompt={prompt}
                notify={notify}
                reload={reload}
              />
            )}

            {/* financial snapshot (finance-gated) — P&L headline + editable
                rental amount + Total Sales lump-sum + cost ledger. Owner
                2026-07-23: view+edit only for owner/BD/weisiang/finance;
                sales directors VIEW only; hidden from everyone else. */}
            {financeVisible && financeRoleAllowed && (
              <FinancialSnapshot
                finance={data.finance!}
                lines={data.finance_lines}
                canWrite={canWrite && !archived && financeCanEdit}
                busy={busy}
                setBusy={setBusy}
                notify={notify}
                projectId={id}
                reload={reload}
              />
            )}
          </>
        )}
      </div>
    </div>
    </DefectActionsCtx.Provider>
  );
}

// ── Sales attending (add via picker + remove) ──
function SalesAttending({
  projectId, attendees, options, canWrite, busy, setBusy, notify, confirm, reload,
}: {
  projectId: number;
  attendees: SalesAttendee[];
  options: SalesRepOption[];
  canWrite: boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  confirm: ConfirmFn;
  reload: () => void;
}) {
  const [adding, setAdding] = useState(false);
  // Multi-select (owner 2026-07-23): tick several reps, add them in one go —
  // mirrors the desktop checkbox list instead of the old one-at-a-time picker.
  const [picks, setPicks] = useState<Set<number>>(new Set());
  const present = new Set(attendees.map((a) => a.sales_rep_id));
  const available = options.filter((o) => !present.has(o.id));

  const toggle = (id: number) =>
    setPicks((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const addSelected = async () => {
    if (!picks.size) return;
    setBusy(true);
    try {
      for (const repId of picks) {
        await api.post(`/api/projects/${projectId}/sales-attendees`, { sales_rep_id: repId });
      }
      setPicks(new Set());
      setAdding(false);
      reload();
    } catch (e) {
      await notify({ title: "Failed to add", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: SalesAttendee) => {
    const label = a.rep_name || a.user_name || `Rep #${a.sales_rep_id}`;
    if (!(await confirm({ title: "Remove from attendance?", body: `${label} will no longer be listed as attending.`, confirmLabel: "Remove", danger: true }))) return;
    setBusy(true);
    try {
      await api.del(`/api/projects/${projectId}/sales-attendees/${a.sales_rep_id}`);
      reload();
    } catch (e) {
      await notify({ title: "Failed to remove", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 6px" }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093" }}>Sales attending</span>
        {canWrite && !adding && available.length > 0 && (
          <button className="tinybtn" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => setAdding(true)}>+ Add</button>
        )}
      </div>
      {adding && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid #e3e6e0", borderRadius: 10 }}>
            {available.length === 0 && (
              <div style={{ fontSize: 12, color: "#9aa093", padding: "9px 11px" }}>Everyone is already attending.</div>
            )}
            {available.map((o, i) => (
              <label
                key={o.id}
                style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderTop: i === 0 ? "none" : "1px solid #eceee9", cursor: busy ? "default" : "pointer" }}
              >
                <input type="checkbox" checked={picks.has(o.id)} disabled={busy} onChange={() => toggle(o.id)} />
                <span className="money" style={{ fontSize: 10, color: "#9aa093" }}>{o.code || "—"}</span>
                <span style={{ fontSize: 13 }}>{o.name || `#${o.id}`}</span>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 7, marginTop: 7 }}>
            <button
              className="tinybtn"
              style={{ background: "#16695f", borderColor: "#16695f", color: "#fff" }}
              disabled={busy || picks.size === 0}
              onClick={addSelected}
            >
              Add selected{picks.size ? ` (${picks.size})` : ""}
            </button>
            <button className="tinybtn" disabled={busy} onClick={() => { setAdding(false); setPicks(new Set()); }}>Cancel</button>
          </div>
        </div>
      )}
      {attendees.length === 0 && <div style={{ fontSize: 12, color: "#9aa093" }}>None assigned.</div>}
      {attendees.length > 0 && (
        <div style={{ border: "1px solid #e3e6e0", borderRadius: 10, overflow: "hidden" }}>
          {attendees.map((s, i) => (
            <div key={s.sales_rep_id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderTop: i === 0 ? "none" : "1px solid #eceee9" }}>
              <span className="money" style={{ fontSize: 10, color: "#9aa093" }}>{s.rep_code || "—"}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "#11140f", flex: 1, minWidth: 0 }}>{s.rep_name || s.user_name || "—"}</span>
              {canWrite && (
                <button aria-label="Remove" className="tinybtn" disabled={busy} style={{ padding: "3px 7px", color: "#a13a34", fontWeight: 700 }} onClick={() => remove(s)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Sales (SALES-gated — split from the finance snapshot) ──
// The quick-log-a-sale action belongs to the salesperson working the project,
// not to finance. Desktop renders ProjectSalesEntriesSection on canViewSales
// (Projects.tsx:9885,9914-9918), NOT canFinancial — so a non-financial sales
// exec keeps the action. POST /api/sales/entries is gated on sales page-access
// (requirePageAccess("sales")), which canLogSale mirrors. The income lines come
// from the finance ledger, which the backend strips for a finance-hidden user;
// a sales-only user therefore sees the log action with an empty list and still
// no P&L.
function SalesPanel({
  projectId, incomeLines, canLogSale, busy, setBusy, prompt, notify, reload,
}: {
  projectId: number;
  incomeLines?: FinanceLine[];
  canLogSale: boolean;
  busy: boolean;
  setBusy: SetBusy;
  prompt: PromptFn;
  notify: NotifyFn;
  reload: () => void;
}) {
  // Quick-log a sale at the project (POST /api/sales/entries { quick_log }).
  // Lands as a draft sales entry; surfaces as a synthetic income line.
  const logSale = async () => {
    const amtStr = await prompt({
      title: "Sale amount (RM)",
      placeholder: "0.00",
      validate: (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? null : "Enter a positive number."; },
    });
    if (amtStr == null) return;
    const ref = await prompt({ title: "Reference no. (optional)", placeholder: "e.g. INV-123" });
    if (ref == null) return;
    const today = todayInAppTz();
    setBusy(true);
    try {
      await api.post(`/api/sales/entries`, {
        project_id: projectId,
        quick_log: true,
        amount: parseFloat(amtStr),
        ref_no: ref.trim() || null,
        occurred_at: today,
      });
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const income = (incomeLines ?? []).filter((l) => (l.kind ?? "").toLowerCase() === "income");

  return (
    <details className="pacc" open>
      <summary>
        <span className="psec-t">Sales</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        <div style={{ display: "flex", alignItems: "center", margin: "0 0 6px" }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093" }}>Sales entries</span>
          {canLogSale && <button className="tinybtn" style={{ marginLeft: "auto", color: "#16695f", borderColor: "#bcdcd7" }} disabled={busy} onClick={logSale}>+ Log sale</button>}
        </div>
        {income.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9aa093" }}>No sales recorded.</div>
        ) : (
          <div style={{ border: "1px solid #eceee9", borderRadius: 10, overflow: "hidden" }}>
            {income.map((line, i) => (
              <div key={`${line.source ?? "l"}-${line.id}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderTop: i === 0 ? "none" : "1px solid #eceee9", flexWrap: "wrap" }}>
                <span style={{ flex: 1, minWidth: 90, fontSize: 12, color: "#414539" }}>{line.description || ledgerCategoryLabel(line.category || "sales")}</span>
                <span className="money" style={{ fontSize: 12, fontWeight: 700, color: "#2f8a5b" }}>{formatCurrency(line.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

// ── Pipeline (prototype #project VERBATIM — numbered-dot stage tracker) ──
// The owner's richest design (prototype `#project`): a Done/Pending/Overdue
// legend row, then a horizontal-scroll strip of numbered `.pstage`/`.pdot`
// steps with a per-step done/total sub-label. Driven off the project's real
// checklist SECTIONS (the desktop tracker's source of truth): each complete
// section reads green, the first still-open section is the current step
// (amber), and the rest are grey outlines. With no sections yet we fall back
// to the 9-step reference pipeline keyed off the coarse backend `stage`.
function StagePipeline({ stage, sections }: { stage: string | null; sections?: SectionProgress[] }) {
  type Step = { label: string; sub: string | null; state: "done" | "current" | "todo" };
  let steps: Step[];

  if (sections && sections.length) {
    const ordered = [...sections].sort((a, b) => a.sort_order - b.sort_order);
    const firstOpen = ordered.findIndex((s) => !s.complete);
    steps = ordered.map((s, i) => ({
      label: s.name,
      sub: s.total > 0 ? `${s.done}/${s.total}` : null,
      state: s.complete ? "done" : i === firstOpen ? "current" : "todo",
    }));
  } else {
    const reached = STAGE_TO_INDEX[(stage ?? "").toLowerCase()] ?? 0;
    steps = FALLBACK_PIPELINE.map((label, i) => ({
      label,
      sub: null,
      state: i < reached ? "done" : i === reached ? "current" : "todo",
    }));
  }

  const dotStyle = (state: Step["state"]): React.CSSProperties =>
    state === "done"
      ? { background: "#2f8a5b", color: "#fff" }
      : state === "current"
        ? { background: "#cf9a2e", color: "#fff" }
        : { background: "#fff", border: "2px solid #d6d9d2", color: "#9aa093" };

  return (
    <div className="card"><div className="card-b">
      <div className="fld-l" style={{ marginBottom: 8 }}>Pipeline</div>
      {/* legend — the colour vocabulary the dots use */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "0 2px 8px" }}>
        {([["#2f8a5b", "Done"], ["#cf9a2e", "Pending"], ["#b23a3a", "Overdue"]] as const).map(([c, t]) => (
          <div key={t} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: c }} />
            <span style={{ fontSize: 10, color: "#414539" }}>{t}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 2, overflowX: "auto", padding: "4px 2px 6px" }}>
        {steps.map((st, i) => (
          <div key={`${st.label}-${i}`} className="pstage">
            <span className="pdot" style={dotStyle(st.state)}>{i + 1}</span>
            <span style={{ fontSize: 9, fontWeight: st.state === "todo" ? 400 : 700, color: st.state === "todo" ? "#767b6e" : "#11140f", lineHeight: 1.1 }}>{st.label}</span>
            {st.sub && <span style={{ fontSize: 8, color: "#9aa093" }}>{st.sub}</span>}
          </div>
        ))}
      </div>
    </div></div>
  );
}

// ── Tasklist ──
// Role-badge colours mirror the design's PROJ_TASKS palette, keyed by the
// checklist item's `role_label` (BD / PURCHASER / DRIVER / SALES PIC …).
const ROLE_COLOR: Record<string, string> = {
  BD: "#7a5c86",
  PURCHASER: "#a16a2e",
  DRIVER: "#2a6f9e",
  "SALES PIC": "#16695f",
  SALES: "#16695f",
  LOGISTIC: "#2f8a5b",
  // Shared sales+driver deliverables (the Defect List pair, owner 2026-07-29).
  "SALES PIC & DRIVER": "#16695f",
};
const roleColor = (label: string) => ROLE_COLOR[label.toUpperCase()] ?? "#767b6e";
// Owner 2026-07-15: badges should read sentence-case ("Purchaser", "Driver",
// "Sales PIC") instead of shouting all-caps — but keep genuine acronyms
// (BD, PIC) uppercase, matching how the app writes them elsewhere.
const ROLE_ACRONYMS = new Set(["BD", "PIC", "PO", "DO", "PPE", "3D", "2D"]);
const formatRoleLabel = (label: string): string =>
  label
    .trim()
    .split(/\s+/)
    .map((w) => (ROLE_ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
// Owner 2026-07-29: a combined role_label ("SALES PIC & DRIVER") renders as
// SEPARATE badges — one per role, each in its own colour — never one merged tag.
const roleLabelParts = (label: string): string[] =>
  label.split("&").map((s) => s.trim()).filter(Boolean);

// Checklist status cycle for the tick control: pending → done → na → pending.
const NEXT_STATUS: Record<string, "pending" | "done" | "na"> = {
  pending: "done",
  done: "na",
  na: "pending",
  blocked: "done",
};

function TasklistSectionView({
  projectId, sections, items, progress, attachments, projectStart, projectEnd, canTick, can, busy, setBusy, notify, prompt, reload,
}: {
  projectId: number;
  sections?: TasklistSection[];
  items?: ChecklistItem[];
  progress?: SectionProgress[];
  attachments?: TaskAttachment[];
  projectStart: string | null;
  projectEnd: string | null;
  canTick: boolean;
  can: (perm: string) => boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  prompt: PromptFn;
  reload: () => void;
}) {
  const list = items ?? [];
  const secs = sections ?? [];

  const attachBySection = useMemo(() => {
    const m = new Map<number, TaskAttachment[]>();
    for (const a of attachments ?? []) {
      if (a.archived_at) continue;
      const arr = m.get(a.item_id) ?? [];
      arr.push(a);
      m.set(a.item_id, arr);
    }
    return m;
  }, [attachments]);
  // Group items by section_id; keep an "Uncategorised" bucket for null.
  const bySection = useMemo(() => {
    const m = new Map<number, ChecklistItem[]>();
    for (const it of list) {
      const key = it.section_id ?? 0;
      const arr = m.get(key) ?? [];
      arr.push(it);
      m.set(key, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.seq - b.seq);
    return m;
  }, [list]);

  const orderedSecs = [...secs].sort((a, b) => a.sort_order - b.sort_order);
  const progressById = new Map((progress ?? []).map((p) => [p.id, p]));

  // List | Gantt toggle. Tapping a Gantt diamond flips back to the list and
  // scrolls the tapped task's row into view with a brief highlight.
  const [view, setView] = useState<"list" | "gantt">("list");
  const [flashId, setFlashId] = useState<number | null>(null);
  useEffect(() => {
    if (flashId == null || view !== "list") return;
    const el = document.getElementById(`pms-task-${flashId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [flashId, view]);
  const openTask = (taskId: number) => { setView("list"); setFlashId(taskId); };

  const renderRows = (rows: ChecklistItem[]) =>
    rows.map((it) => (
      <div
        key={it.id}
        id={`pms-task-${it.id}`}
        style={flashId === it.id ? { outline: "2px solid #16695f", outlineOffset: 2, borderRadius: 8 } : undefined}
      >
        <TaskRow
          item={it}
          attachments={attachBySection.get(it.id) ?? []}
          canTick={canTick}
          can={can}
          busy={busy}
          setBusy={setBusy}
          notify={notify}
          prompt={prompt}
          reload={reload}
        />
      </div>
    ));

  const totalTasks = list.length;

  return (
    <details className="pacc" open>
      <summary>
        <span className="psec-t">{`Tasklist${totalTasks ? ` (${totalTasks})` : ""}`}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#9aa093" }}>{view === "gantt" ? "Timeline" : "List · Section"}</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        <div className="seg" style={{ marginBottom: 12 }}>
          <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>List</button>
          <button className={view === "gantt" ? "on" : ""} onClick={() => setView("gantt")}>Gantt</button>
        </div>
        {view === "gantt" ? (
          <MobileGantt
            projectStart={projectStart}
            projectEnd={projectEnd}
            sections={orderedSecs}
            sectionProgress={progress ?? []}
            tasks={list}
            onTaskClick={openTask}
          />
        ) : (
          <>
            {totalTasks === 0 && !orderedSecs.length && <div style={{ fontSize: 12, color: "#9aa093" }}>No tasks yet.</div>}
            {orderedSecs.map((sec) => {
              const rows = bySection.get(sec.id) ?? [];
              // Owner 2026-07-17: a section with NO visible tasks for this
              // viewer renders nothing at all — previously the bare title +
              // "No tasks in this section" still showed (e.g. PAYMENT / BOOTH
              // LAYOUT headers on the sales simplified view).
              if (rows.length === 0) return null;
              const prog = progressById.get(sec.id);
              return (
                <div key={sec.id} style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0 2px" }}>
                    {/* Owner 2026-07-15: drop the trailing "DOCUMENTS" word — display only, section name in data stays intact (backend gating matches it). */}
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#11140f" }}>{(sec.name || "").replace(/\s+documents$/i, "")}</span>
                    {prog && <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: "#9aa093" }}>{prog.done}/{prog.total}</span>}
                  </div>
                  {renderRows(rows)}
                </div>
              );
            })}
            {/* Uncategorised bucket */}
            {(() => {
              const rows = bySection.get(0) ?? [];
              if (!rows.length) return null;
              return (
                <div style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0 2px" }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: "#11140f" }}>Uncategorised</span>
                  </div>
                  {renderRows(rows)}
                </div>
              );
            })()}
          </>
        )}
      </div>
    </details>
  );
}

// Per-photo remark (owner 2026-07-16): each attachment carries its own caption,
// edited inline under its file chip and saved via PATCH /checklist/attachments/:id.
// Owns its state so a parent re-render doesn't clobber an in-progress edit.
const REMARK_UNSAVED = { fontSize: 11, color: "#B8331F", paddingLeft: 2, paddingTop: 2 } as const;

export function AttachRemark({ att, canEdit }: { att: TaskAttachment; canEdit: boolean }) {
  const [cap, setCap] = useState(att.caption ?? "");
  const [saved, setSaved] = useState(att.caption ?? "");
  const [saving, setSaving] = useState(false);
  /* The typed text stays on screen after a refused PATCH, so the box looks
     exactly like a saved one. Blur has already happened — the person tapped
     away — and leaving the page loses what they wrote. */
  const [failed, setFailed] = useState(false);
  const save = async () => {
    const v = cap.trim();
    if (v === saved.trim()) return;
    setSaving(true); setFailed(false);
    try {
      await api.patch(`/api/projects/checklist/attachments/${att.id}`, { caption: v });
      setSaved(v);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  if (!canEdit) {
    return cap.trim() ? (
      <div style={{ fontSize: 11.5, color: "#6b6f63", paddingLeft: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        <b style={{ color: "#8c968a" }}>Remark:</b> {cap}
      </div>
    ) : null;
  }
  return (
    <>
      <textarea
        className="fld-i"
        value={cap}
        disabled={saving}
        rows={2}
        onChange={(e) => { setCap(e.target.value); setFailed(false); }}
        onBlur={() => void save()}
        placeholder="Add remark…"
        style={{ fontSize: 12, padding: "5px 8px", resize: "vertical", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      />
      {failed && <div style={REMARK_UNSAVED}>Not saved. Tap out of the box to try again.</div>}
    </>
  );
}

// Item-level remark box (owner 2026-07-16, relocated same evening): the sales
// PIC's photo tasks — Setup Image, Defect List, Event Complete Image — carry a
// standalone remark fillable WITHOUT uploading a file. Saved to the item's
// `notes` via PATCH /checklist/:id. (Was on Weekend Activity/Deco earlier that
// day; owner moved it here.)
export function ItemRemark({ it, canEdit }: { it: ChecklistItem; canEdit: boolean }) {
  const [val, setVal] = useState(it.notes ?? "");
  const [saved, setSaved] = useState(it.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false); // see AttachRemark
  const save = async () => {
    const v = val.trim();
    if (v === saved.trim()) return;
    setSaving(true); setFailed(false);
    try {
      await api.patch(`/api/projects/checklist/${it.id}`, { notes: v });
      setSaved(v);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  if (!canEdit) {
    return (it.notes ?? "").trim() ? (
      <div style={{ padding: "0 0 8px 24px", fontSize: 11.5, color: "#6b6f63", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        <b style={{ color: "#8c968a" }}>Remark:</b> {it.notes}
      </div>
    ) : null;
  }
  return (
    <div style={{ padding: "0 0 8px 24px" }}>
      <textarea
        className="fld-i"
        value={val}
        disabled={saving}
        rows={2}
        onChange={(e) => { setVal(e.target.value); setFailed(false); }}
        onBlur={() => void save()}
        placeholder="Add remark…"
        style={{ fontSize: 12, padding: "6px 9px", resize: "vertical", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      />
      {failed && <div style={REMARK_UNSAVED}>Not saved. Tap out of the box to try again.</div>}
    </div>
  );
}

// One checklist row. Tick cycles status (POST /checklist/:id/status); the
// paperclip uploads a per-task attachment (PUT /checklist/:id/attachments) and
// the "…" opens remark / approval. Payment-pill rows (mig 090) render N/A /
// PENDING / PAID buttons instead of the tick, saved via PATCH /checklist/:id.
function TaskRow({
  item: it, attachments, canTick, can, busy, setBusy, notify, prompt, reload,
}: {
  item: ChecklistItem;
  attachments: TaskAttachment[];
  canTick: boolean;
  can: (perm: string) => boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  prompt: PromptFn;
  reload: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const { user } = useAuth();
  const confirm = useConfirm();
  // Attachment viewer — every user (incl. read-only drivers) can open the
  // task's files fullscreen; MediaLightbox fetches with the bearer token,
  // so this also sidesteps mobile popup-blockers that ate window.open.
  const [viewIdx, setViewIdx] = useState<number | null>(null);
  const files = attachments.filter((a) => !a.archived_at);
  const status = (it.status ?? "").toLowerCase();
  const done = status === "done";
  const na = status === "na";
  const c = it.role_label ? roleColor(it.role_label) : null;
  // A row the caller can't tick because it needs a specific permission.
  // Approval keys are EXPLICIT-only (owner matrix 2026-07-21) — `*` holders
  // are not automatically approvers; see auth/projectAccess.ts.
  const permBlocked =
    !!it.required_perm && !holdsChecklistApproval(user?.permissions, it.required_perm);
  // Attach button: full-write users get it on every task; tick-only users
  // (drivers) only on tasks badged for THEIR role — a driver should upload
  // to "Setup Image · DRIVER", not to BD/PURCHASER/SALES PIC tasks
  // (owner 2026-07-09). Helpers/storekeepers work the same field tasks as
  // drivers, so they attach on DRIVER-badged rows too (owner 2026-07-13) —
  // no task is ever badged HELPER/STOREKEEPER.
  const tickOnly = canTick && !can("projects.write");
  const badge = (it.role_label ?? "").trim().toUpperCase();
  const userRole = (user?.role_name ?? "").trim().toUpperCase();
  // A combined badge ("SALES PIC & DRIVER" — the Defect List pair, owner
  // 2026-07-29) admits every listed role; each part keeps the DRIVER →
  // helper/storekeeper extension. Mirrors backend roleLabelAdmits.
  const roleMatchesUser =
    !!badge && !!userRole &&
    badge.split("&").some((part) => {
      const l = part.trim();
      return !!l && (l === userRole ||
        (l === "DRIVER" && (userRole === "HELPER" || userRole === "STOREKEEPER")));
    });
  // Gated row, no approval key, but the row is badged for THIS user's function
  // (the purchaser on her own Exchange List / Stock In / Stock Out): since
  // 2026-08-17 the backend lets the owner function toggle N/A — only
  // 'done' stays key-only. Their tap cycle therefore SKIPS 'done':
  // pending <-> na. Key holders keep the full pending -> done -> na cycle.
  const naOnly = permBlocked && canTick && roleMatchesUser;
  const canRowTick = canTick && (!permBlocked || naOnly);
  const canAttach = canTick && (!tickOnly || roleMatchesUser);
  // Owner 2026-08-05: file DELETE follows the PC rule — managers only
  // (projects.manage: BD / managers / directors). Crew and sales keep upload
  // (canAttach) but no longer see the × on file chips. canAttach folds in the
  // row-edit + !archived gate, so a manager still can't delete a locked row.
  const canRemoveFile = canAttach && can("projects.manage");

  const cycle = async () => {
    if (!canRowTick || busy) return;
    const next = naOnly
      ? (status === "na" ? "pending" : "na")
      : (NEXT_STATUS[status] ?? "done");
    setBusy(true);
    try {
      await api.post(`/api/projects/checklist/${it.id}/status`, { status: next });
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const setPill = async (v: string) => {
    if (v === (it.pill_value || "unpaid") || busy) return;
    setBusy(true);
    try {
      await api.patch(`/api/projects/checklist/${it.id}`, { pill_value: v });
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File, caption?: string) => {
    if (file.size > 10 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 10MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const capParam = caption && caption.trim() ? `&caption=${encodeURIComponent(caption.trim())}` : "";
      await api.putBinary(
        `/api/projects/checklist/${it.id}/attachments?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(file.name)}${capParam}`,
        buf,
        file.type || "application/octet-stream",
      );
      reload();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Approve / reject a task awaiting review (gated by required_perm).
  // reject needs a reason.
  const review = async (action: "approve" | "reject") => {
    const body: Record<string, unknown> = { action };
    if (action === "reject") {
      const reason = await prompt({ title: `Reject "${it.title}"?`, placeholder: "Reason (required)", validate: (v) => (v.trim() ? null : "A reason is required.") });
      if (reason == null || !reason.trim()) return;
      body.reason = reason.trim();
    }
    setBusy(true);
    try {
      await api.post(`/api/projects/checklist/${it.id}/review`, body);
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const removeAttachment = async (attId: number, name: string | null | undefined) => {
    if (!(await confirm({ title: `Remove ${name || "this file"}?`, confirmLabel: "Remove", danger: true }))) return;
    setBusy(true);
    try {
      await api.del(`/api/projects/checklist/attachments/${attId}`);
      reload();
    } catch (e) {
      await notify({ title: "Remove failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  // Tappable file chips + fullscreen viewer, shared by both row variants.
  const fileChips = files.length > 0 && (
    <div style={{ display: "flex", flexDirection: "column", gap: 9, padding: "0 0 8px 24px" }}>
      {files.map((a, i) => (
        <div key={a.id} style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 340 }}>
          <span style={{ display: "inline-flex", alignItems: "stretch", maxWidth: 210 }}>
            <button
              type="button"
              className="tinybtn"
              style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, maxWidth: 190, ...(canRemoveFile ? { borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: "none" } : null) }}
              onClick={() => setViewIdx(i)}
              title={a.file_name ?? undefined}
            >
              {(a.mime_type || "").startsWith("image/") ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M13.2 6.5 7 12.7a4.4 4.4 0 1 0 6.2 6.2l6.5-6.5a2.9 2.9 0 1 0-4.1-4.1l-6.5 6.5a1.5 1.5 0 1 0 2.1 2.1l6.1-6.2" /></svg>
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.file_name || "File"}</span>
            </button>
            {canRemoveFile && (
              <button
                type="button"
                className="tinybtn"
                disabled={busy}
                style={{ flex: "none", padding: "0 7px", borderTopLeftRadius: 0, borderBottomLeftRadius: 0, color: "#a13a34", display: "inline-flex", alignItems: "center" }}
                onClick={() => void removeAttachment(a.id, a.file_name)}
                title="Remove file"
                aria-label="Remove file"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            )}
          </span>
          {/^defect (list|item)/i.test((it.title || "").trim()) && <AttachRemark att={a} canEdit={canAttach} />}
          {/^defect (list|item)/i.test((it.title || "").trim()) && <DefectFileActions att={a} />}
        </div>
      ))}
    </div>
  );
  const fileViewer = viewIdx != null && files[viewIdx] ? (
    <MediaLightbox
      items={files.map((a): MediaItem => ({
        r2_key: a.r2_key,
        content_type: a.mime_type ?? mimeFromKey(a.r2_key),
        caption: a.file_name,
      }))}
      index={viewIdx}
      onChange={setViewIdx}
      onClose={() => setViewIdx(null)}
      baseUrl="/api/projects/attachments"
      badge={it.title}
    />
  ) : null;

  // Defect List (owner 2026-07-16): a remark is COMPULSORY before each photo —
  // tapping Attach prompts for it, then opens the picker. HOOKS ALL SIT ABOVE THE
  // PILL-ROW RETURN: below it, a tick row called one hook more (React #310).
  const isDefectList = (it.title || "").trim().toLowerCase().startsWith("defect list");
  const pendingCaptionRef = useRef<string | undefined>(undefined);
  const startAttach = async () => {
    if (isDefectList) {
      const remark = await prompt({
        title: "Remark for this photo",
        placeholder: "Describe the defect (required)",
        validate: (v) => (v.trim() ? null : "Please write a remark before uploading."),
      });
      if (remark == null || !remark.trim()) return;
      pendingCaptionRef.current = remark.trim();
    }
    fileRef.current?.click();
  };
  // Payment / deposit pill rows: N/A / PENDING / PAID instead of the tick.
  if (it.pill_kind) {
    const opts = paymentPillOptions(it.pill_kind);
    const cur = it.pill_value || "unpaid";
    return (
      <>
      <div className="docrow" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
        <span style={{ width: 15, height: 15, flex: "none" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#11140f" }}>{it.title}</div>
          {it.role_label && c && roleLabelParts(it.role_label).map((part) => (
            <span key={part} className="rbadge" style={{ background: `${roleColor(part)}1f`, color: roleColor(part), marginTop: 4, marginRight: 4, display: "inline-flex" }}>{formatRoleLabel(part)}</span>
          ))}
        </div>
        {opts.map(([v, label]) => {
          const on = v === cur;
          return (
            <button
              key={v}
              className="tinybtn"
              disabled={!canTick || busy || on}
              style={{ background: on ? (v === "none" ? "#f4f6f3" : v === "unpaid" ? "#f6efd9" : "#e2f0e9") : "#fff", color: v === "none" ? "#767b6e" : v === "unpaid" ? "#6e4d12" : "#2f8a5b", fontWeight: on ? 800 : 700 }}
              onClick={() => setPill(v)}
            >
              {label}
            </button>
          );
        })}
        {canAttach && (
          <>
            <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={async (e) => { const files = Array.from(e.target.files || []); for (const f of files) await upload(f); if (fileRef.current) fileRef.current.value = ""; }} />
            <button className="tinybtn" style={{ minWidth: 60, display: "inline-flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, lineHeight: 1, boxSizing: "border-box", border: "none", background: "transparent", color: "#767b6e", padding: "4px 6px" }} disabled={busy} onClick={() => fileRef.current?.click()} title={attachments.length ? `${attachments.length} file(s)` : "Attach"}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M13.2 6.5 7 12.7a4.4 4.4 0 1 0 6.2 6.2l6.5-6.5a2.9 2.9 0 1 0-4.1-4.1l-6.5 6.5a1.5 1.5 0 1 0 2.1 2.1l6.1-6.2" /></svg>
              <span style={{ fontSize: 9, fontWeight: 700 }}>{attachments.length ? `Attach (${attachments.length})` : "Attach"}</span>
            </button>
          </>
        )}
      </div>
      {fileChips}
      {fileViewer}
      </>
    );
  }

  const reviewStatus = (it.review_status ?? "").toLowerCase();
  const awaitingReview = reviewStatus === "pending_review" || reviewStatus === "amended";
  return (
    <div style={{ borderTop: "1px solid #eceee9" }}>
    <div className="docrow" style={{ flexWrap: "wrap", borderTop: "none", alignItems: "flex-start" }}>
      <span
        role={canRowTick ? "button" : undefined}
        onClick={cycle}
        title={naOnly ? "Toggle N/A" : permBlocked ? `Requires ${it.required_perm}` : canRowTick ? "Cycle status" : undefined}
        style={{ flex: "none", display: "flex", cursor: canRowTick ? "pointer" : "default", opacity: busy ? 0.6 : 1 }}
      >
        {done ? (
          <span style={{ width: 15, height: 15, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: "#2f8a5b" }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
        ) : na ? (
          <span style={{ width: 15, height: 15, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", border: "2px solid #d6d9d2", fontSize: 8, fontWeight: 800, color: "#9aa093" }}>N</span>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /></svg>
        )}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: na ? "#9aa093" : "#11140f", textDecoration: na ? "line-through" : "none" }}>{it.title}</div>
        {it.role_label && c && roleLabelParts(it.role_label).map((part) => (
          <span key={part} className="rbadge" style={{ background: `${roleColor(part)}1f`, color: roleColor(part), marginTop: 4, marginRight: 4, display: "inline-flex" }}>{formatRoleLabel(part)}</span>
        ))}
      </div>
      {it.due_date && <span style={{ fontSize: 9.5, color: "#9aa093", whiteSpace: "nowrap" }}>{dm(it.due_date)}</span>}
      {canAttach && (
        <>
          <input ref={fileRef} type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; const cap = pendingCaptionRef.current; pendingCaptionRef.current = undefined; if (f) void upload(f, cap); }} />
          <button className="tinybtn" style={{ minWidth: 60, display: "inline-flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, lineHeight: 1, boxSizing: "border-box", border: "none", background: "transparent", color: "#767b6e", padding: "4px 6px" }} disabled={busy} onClick={() => void startAttach()} title={isDefectList ? "Write a remark, then upload" : attachments.length ? `${attachments.length} file(s)` : "Attach"}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M13.2 6.5 7 12.7a4.4 4.4 0 1 0 6.2 6.2l6.5-6.5a2.9 2.9 0 1 0-4.1-4.1l-6.5 6.5a1.5 1.5 0 1 0 2.1 2.1l6.1-6.2" /></svg>
            <span style={{ fontSize: 9, fontWeight: 700 }}>{attachments.length ? `Attach (${attachments.length})` : isDefectList ? "Add photo" : "Attach"}</span>
          </button>
        </>
      )}
      {/* Approve / Reject offered on an approval-gated task (required_perm) to
          a user HOLDING that permission until the task is approved/done (owner
          2026-07-21); non-gated tasks show them only while a submission awaits
          review. BUT only once a file is uploaded (owner 2026-07-29): there is
          nothing to approve before the document exists. */}
      {canTick && !done && files.length > 0 &&
        (it.required_perm ? holdsChecklistApproval(user?.permissions, it.required_perm) : awaitingReview) && (
        <>
          {/* Toggle (owner 2026-08-10): show only the reversing action — Approve
              hidden once approved, Reject hidden once rejected. */}
          {reviewStatus !== "approved" && (
            <button className="tinybtn" style={{ background: "#e2f0e9", borderColor: "#bcdcd7", color: "#2f8a5b" }} disabled={busy} onClick={() => review("approve")}>Approve</button>
          )}
          {reviewStatus !== "rejected" && (
            <button className="tinybtn" style={{ background: "#f7e7e5", borderColor: "#e6c9c6", color: "#a13a34" }} disabled={busy} onClick={() => review("reject")}>Reject</button>
          )}
        </>
      )}
    </div>
    {fileChips}
    {/* Sales PIC photo tasks: standalone remark box (no file needed). Only the
        SALES PIC-badged variants — "Setup Image" also exists DRIVER-badged.
        startsWith: the Defect List pair is badged "SALES PIC & DRIVER". */}
    {(it.role_label ?? "").trim().toUpperCase().startsWith("SALES PIC") &&
      /^(setup image|defect list|event complete image)/i.test((it.title || "").trim()) &&
      <ItemRemark it={it} canEdit={canTick} />}
    {reviewStatus && reviewStatus !== "approved" && (
      <div style={{ padding: "0 0 6px 24px" }}>
        <span className="rbadge" style={{ background: reviewStatus === "rejected" ? "#f7e7e5" : "#f6efd9", color: reviewStatus === "rejected" ? "#a13a34" : "#6e4d12" }}>{humanize(reviewStatus).toUpperCase()}</span>
      </div>
    )}
    {fileViewer}
    </div>
  );
}

// The desktop Setup & Dismantle crew editor stores crew as JSON on
// projects.setup_crew / dismantle_crew ({drivers:[{name,phone}], helpers,
// lorries:["PLATE"], outsourced:{enabled,entries}}) and leaves the FK
// columns (setup_driver_user_id / setup_lorry_id) untouched. Mobile shows
// the FK-joined names when present and falls back to this JSON otherwise.
type CrewPerson = { name: string; phone?: string | null };
type LorryCrew = { plate: string; drivers: CrewPerson[]; helpers: CrewPerson[] };
type PhaseCrew = { lorryCrew: LorryCrew[]; outsourced: CrewPerson[]; drivers: CrewPerson[]; helpers: CrewPerson[]; lorries: string[] };
const parseCrewJson = (raw: string | null | undefined): PhaseCrew => {
  const out: PhaseCrew = { lorryCrew: [], outsourced: [], drivers: [], helpers: [], lorries: [] };
  if (!raw || raw === "{}") return out;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const people = (v: unknown): CrewPerson[] =>
      (Array.isArray(v) ? v : [])
        .filter((p): p is { name?: unknown; phone?: unknown } => !!p && typeof p === "object")
        .filter((p) => typeof p.name === "string" && p.name.trim() !== "")
        .map((p) => ({ name: String(p.name), phone: typeof p.phone === "string" && p.phone ? p.phone : null }));
    // Per-lorry structure (new, desktop writes it). Flat arrays are kept for
    // legacy data + the FK-fallback display.
    if (Array.isArray(j.lorry_crew) && j.lorry_crew.length) {
      out.lorryCrew = (j.lorry_crew as any[]).map((l) => ({
        plate: typeof l?.plate === "string" ? l.plate : "",
        drivers: people(l?.drivers),
        helpers: people(l?.helpers),
      }));
    }
    out.drivers = people(j.drivers);
    out.helpers = people(j.helpers);
    out.lorries = (Array.isArray(j.lorries) ? j.lorries : []).filter((l): l is string => typeof l === "string" && l.trim() !== "");
    const oc = j.outsourced as { enabled?: unknown; entries?: unknown } | undefined;
    if (oc?.enabled && Array.isArray(oc.entries)) {
      for (const e of oc.entries as Array<{ name?: unknown; phone?: unknown; plate?: unknown }>) {
        if (typeof e?.name === "string" && e.name.trim()) {
          const plate = typeof e.plate === "string" && e.plate.trim() ? ` · ${e.plate}` : "";
          out.outsourced.push({ name: `${e.name}${plate}`, phone: typeof e.phone === "string" && e.phone ? e.phone : null });
        }
      }
    }
    // Legacy flat crew with no per-lorry array → synthesize one lorry per plate.
    if (out.lorryCrew.length === 0 && (out.drivers.length || out.helpers.length || out.lorries.length)) {
      out.lorryCrew = out.lorries.length
        ? out.lorries.map((plate, i) => (i === 0 ? { plate, drivers: out.drivers, helpers: out.helpers } : { plate, drivers: [], helpers: [] }))
        : [{ plate: "", drivers: out.drivers, helpers: out.helpers }];
    }
  } catch {
    // Legacy plain-text crew — nothing structured to show.
  }
  return out;
};
const crewLabel = (p: CrewPerson): string => (p.phone ? `${p.name} (${formatPhone(p.phone)})` : p.name);
const crewIsEmpty = (c: PhaseCrew): boolean =>
  c.lorryCrew.length === 0 && c.outsourced.length === 0 && c.drivers.length === 0 && c.helpers.length === 0 && c.lorries.length === 0;
// One crew member on its own line: fixed-width role label + name · formatted phone.
function CrewLine({ role, person }: { role: string; person: CrewPerson }) {
  return (
    <div style={{ display: "flex", gap: 7, fontSize: 10.5, lineHeight: 1.45, marginBottom: 3 }}>
      <span style={{ flex: "none", width: 44, color: "#9aa093", fontWeight: 600 }}>{role}</span>
      <span style={{ flex: 1, minWidth: 0, color: "#414539" }}>
        {person.name}
        {person.phone ? <span style={{ color: "#8a8f82" }}> · {formatPhone(person.phone)}</span> : null}
      </span>
    </div>
  );
}

// Best-effort content type from an R2 key's extension — some payloads
// (finance lines, phase photos) don't carry a stored mime type, and the
// lightbox needs one to decide between inline <img>/<video> and a
// download tile.
const mimeFromKey = (key: string): string | null => {
  const m = /\.([a-z0-9]+)$/i.exec(key);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif", "heic"].includes(ext)) return `image/${ext === "jpg" ? "jpeg" : ext}`;
  if (["mp4", "webm"].includes(ext)) return `video/${ext}`;
  if (ext === "mov") return "video/quicktime";
  if (ext === "pdf") return "application/pdf";
  return null;
};

// Split an ISO "date T time" into the parts an <input type=date/time> wants.
const isoDatePart = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : "";
};
const isoTimePart = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : "";
};

// ── Setup & dismantle (logistic) ──
// Editable per-phase schedule (date + start time), driver picker + lorry
// picker (GET /api/scm/lorries), plus a real photo upload (two-step:
// PUT /:id/phase-photos/upload → POST /:id/phase-photos). Schedule/driver/
// lorry all persist via PATCH /:id.
function SetupDismantle({
  projectId, project, photos, drivers, lorries, canWrite, canPhoto, canScheduleView, canScheduleEdit, busy, setBusy, patchProject, notify, reloadPhotos, confirm,
}: {
  projectId: number;
  project: ProjectDetail["project"];
  photos: PhasePhoto[];
  drivers: FleetStaff[];
  lorries: Lorry[];
  canWrite: boolean;
  /** Owner 2026-07-21: crew (driver/helper/storekeeper) manage the phase
   *  photos (upload / replace / remove / view) without canWrite — the
   *  backend gates on being crewed on that phase. */
  canPhoto?: boolean;
  /** Owner 2026-07-23: the mall-handbook Schedule reference block (desktop's
   *  ScheduleRef, phase="schedule") now renders on mobile too. Owner
   *  2026-07-29: HIDDEN unless canScheduleView — logistic views/downloads,
   *  the BD/owner tier (canScheduleEdit) uploads/removes. */
  canScheduleView?: boolean;
  canScheduleEdit?: boolean;
  busy: boolean;
  setBusy: SetBusy;
  patchProject: (body: Record<string, unknown>) => Promise<boolean>;
  notify: NotifyFn;
  reloadPhotos: () => void;
  confirm: ConfirmFn;
  prompt: PromptFn;
}) {
  const setupPhoto = photos.find((ph) => ph.phase === "setup");
  const dismantlePhoto = photos.find((ph) => ph.phase === "dismantle");
  // r2_key is nullable on PhasePhoto (legacy rows) — only keyed shots render.
  const scheduleShots = photos.filter((ph): ph is PhasePhoto & { r2_key: string } => ph.phase === "schedule" && !!ph.r2_key);
  const schedRef = useRef<HTMLInputElement | null>(null);
  const [schedView, setSchedView] = useState<{ items: MediaItem[]; idx: number } | null>(null);
  // Owner 2026-08-03: NO remark step before upload — tapping Upload opens the
  // file picker straight away (the earlier prompt, even optional, was an unwanted
  // extra tap). Setup/dismantle times go in the standalone Remark box below.
  const startScheduleUpload = () => schedRef.current?.click();
  const uploadSchedule = async (file: File, caption?: string) => {
    if (file.size > 50 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 50MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
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
      await api.post(`/api/projects/${projectId}/phase-photos`, { phase: "schedule", r2_key: up.key, content_type: up.mime_type, caption: caption ?? null });
      reloadPhotos();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (schedRef.current) schedRef.current.value = "";
    }
  };
  const removeSchedule = async (ph: PhasePhoto) => {
    if (!(await confirm({ title: "Remove this schedule screenshot?", confirmLabel: "Remove", danger: true }))) return;
    setBusy(true);
    try {
      await api.del(`/api/projects/phase-photos/${ph.id}`);
      reloadPhotos();
    } catch (e) {
      await notify({ title: "Remove failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally { setBusy(false); }
  };

  // Service / Exchange photos (owner 2026-07-29): the mid-fair service/exchange
  // photos are now captured on MOBILE only — the desktop keeps a read-only
  // gallery. phase="service", same endpoints + owner/BD/logistic gate as the
  // schedule block. No required remark (matches the old desktop upload).
  const serviceShots = photos.filter((ph): ph is PhasePhoto & { r2_key: string } => ph.phase === "service" && !!ph.r2_key);
  const serviceRef = useRef<HTMLInputElement | null>(null);
  const [serviceView, setServiceView] = useState<{ items: MediaItem[]; idx: number } | null>(null);
  const uploadService = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 50MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
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
      await api.post(`/api/projects/${projectId}/phase-photos`, { phase: "service", r2_key: up.key, content_type: up.mime_type });
      reloadPhotos();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (serviceRef.current) serviceRef.current.value = "";
    }
  };
  const removeService = async (ph: PhasePhoto) => {
    if (!(await confirm({ title: "Remove this service photo?", confirmLabel: "Remove", danger: true }))) return;
    setBusy(true);
    try {
      await api.del(`/api/projects/phase-photos/${ph.id}`);
      reloadPhotos();
    } catch (e) {
      await notify({ title: "Remove failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally { setBusy(false); }
  };

  const anyData =
    project.setup_start_at || project.dismantle_start_at ||
    project.setup_driver_name || project.dismantle_driver_name ||
    project.setup_lorry_plate || project.dismantle_lorry_plate || photos.length > 0 ||
    !crewIsEmpty(parseCrewJson(project.setup_crew)) || !crewIsEmpty(parseCrewJson(project.dismantle_crew));

  return (
    <details className="pacc">
      <summary>
        <span className="psec-t">Setup &amp; dismantle</span>
        <span className="rbadge" style={{ marginLeft: "auto", background: "#e2f0e9", color: "#2f8a5b" }}>LOGISTIC</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        {!anyData && !canWrite && <div style={{ fontSize: 12, color: "#9aa093", marginBottom: 12 }}>No setup or dismantle logistics assigned yet.</div>}

        {/* Schedule reference (owner 2026-07-23, mobile port of the desktop
            block): the mall handbook's official schedule screenshot. Owner
            2026-07-29: hidden from everyone except logistic (view/download)
            and the BD/owner edit tier. */}
        {canScheduleView && (
        <div style={{ border: "1px dashed #d6d9d2", borderRadius: 10, padding: "9px 11px", marginBottom: 14 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#767b6e", marginBottom: 6 }}>Schedule reference</div>
          {scheduleShots.length === 0 && <div style={{ fontSize: 12, color: "#9aa093", marginBottom: canScheduleEdit ? 8 : 0 }}>No schedule screenshot uploaded yet.</div>}
          {scheduleShots.length > 0 && (
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: canScheduleEdit ? 8 : 0 }}>
              {scheduleShots.map((ph, i) => (
                <div key={ph.id} style={{ position: "relative" }}>
                  <div
                    role="button"
                    onClick={() => setSchedView({
                      items: scheduleShots.map((s): MediaItem => ({ r2_key: s.r2_key, content_type: mimeFromKey(s.r2_key), caption: s.caption ?? "Schedule reference" })),
                      idx: i,
                    })}
                    style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #e3e6e0", cursor: "pointer" }}
                  >
                    <R2Thumb r2Key={ph.r2_key} style={{ width: 84, height: 64 }} />
                  </div>
                  {canScheduleEdit && (
                    <button
                      aria-label="Remove schedule screenshot"
                      disabled={busy}
                      onClick={() => void removeSchedule(ph)}
                      style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", border: "1px solid #d6d9d2", background: "#fff", color: "#a13a34", fontSize: 12, lineHeight: 1, cursor: "pointer" }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {scheduleShots.some((s) => s.caption) && (
            <div style={{ marginBottom: canScheduleEdit ? 8 : 0, display: "flex", flexDirection: "column", gap: 2 }}>
              {scheduleShots.filter((s) => s.caption).map((s) => (
                <div key={s.id} style={{ fontSize: 11.5, color: "#6b6f63", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  <b style={{ color: "#8c968a" }}>Remark:</b> {s.caption}
                </div>
              ))}
            </div>
          )}
          {canScheduleEdit && (
            <>
              <button className="tinybtn" style={{ width: "100%" }} disabled={busy} onClick={() => void startScheduleUpload()}>
                {scheduleShots.length ? "+ Add / replace screenshot" : "Upload handbook schedule screenshot"}
              </button>
              <input ref={schedRef} type="file" accept="image/*,application/pdf,.heic" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadSchedule(f); }} />
            </>
          )}
          {schedView && (
            <MediaLightbox
              items={schedView.items}
              index={schedView.idx}
              onChange={(i) => setSchedView((v) => (v ? { ...v, idx: i } : v))}
              onClose={() => setSchedView(null)}
              baseUrl="/api/projects/attachments"
              badge="Schedule"
            />
          )}
        </div>
        )}

        {/* Service / Exchange photos (owner 2026-07-29): mobile-only capture of
            the mid-fair service/exchange trip; desktop keeps a read-only gallery. */}
        <div style={{ border: "1px dashed #d6d9d2", borderRadius: 10, padding: "9px 11px", marginBottom: 14 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#767b6e", marginBottom: 6 }}>Service / Exchange photos</div>
          {serviceShots.length === 0 && <div style={{ fontSize: 12, color: "#9aa093", marginBottom: canScheduleEdit ? 8 : 0 }}>No service photo yet.</div>}
          {serviceShots.length > 0 && (
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: canScheduleEdit ? 8 : 0 }}>
              {serviceShots.map((ph, i) => (
                <div key={ph.id} style={{ position: "relative" }}>
                  <div
                    role="button"
                    onClick={() => setServiceView({
                      items: serviceShots.map((s): MediaItem => ({ r2_key: s.r2_key, content_type: mimeFromKey(s.r2_key), caption: s.caption ?? "Service photo" })),
                      idx: i,
                    })}
                    style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #e3e6e0", cursor: "pointer" }}
                  >
                    <R2Thumb r2Key={ph.r2_key} style={{ width: 84, height: 64 }} />
                  </div>
                  {canScheduleEdit && (
                    <button
                      aria-label="Remove service photo"
                      disabled={busy}
                      onClick={() => void removeService(ph)}
                      style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", border: "1px solid #d6d9d2", background: "#fff", color: "#a13a34", fontSize: 12, lineHeight: 1, cursor: "pointer" }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {canScheduleEdit && (
            <>
              <button className="tinybtn" style={{ width: "100%" }} disabled={busy} onClick={() => serviceRef.current?.click()}>
                Add service photo
              </button>
              <input ref={serviceRef} type="file" accept="image/*,video/*,application/pdf,.heic" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadService(f); }} />
            </>
          )}
          {serviceView && (
            <MediaLightbox
              items={serviceView.items}
              index={serviceView.idx}
              onChange={(i) => setServiceView((v) => (v ? { ...v, idx: i } : v))}
              onClose={() => setServiceView(null)}
              baseUrl="/api/projects/attachments"
              badge="Service"
            />
          )}
        </div>

        <PhaseBlock
          kind="Setup"
          projectId={projectId}
          project={project}
          photo={setupPhoto}
          drivers={drivers}
          lorries={lorries}
          canWrite={canWrite}
          canPhoto={canPhoto}
          busy={busy}
          setBusy={setBusy}
          patchProject={patchProject}
          notify={notify}
          reloadPhotos={reloadPhotos}
          confirm={confirm}
        />
        <div style={{ height: 1, background: "#e3e6e0", margin: "14px 0" }} />
        <PhaseBlock
          kind="Dismantle"
          projectId={projectId}
          project={project}
          photo={dismantlePhoto}
          drivers={drivers}
          lorries={lorries}
          canWrite={canWrite}
          canPhoto={canPhoto}
          busy={busy}
          setBusy={setBusy}
          patchProject={patchProject}
          notify={notify}
          reloadPhotos={reloadPhotos}
          confirm={confirm}
        />
      </div>
    </details>
  );
}

// Staff name with phone in parens when available (mirrors the prototype's
// "Faiz Rahman (012-880 5567)" driver option). Dual-reads phone / company_phone.
function staffLabel(o: FleetStaff): string {
  const name = o.name || `#${o.id}`;
  const ph = o.phone ?? o.company_phone ?? o.companyPhone ?? null;
  return ph ? `${name} (${ph})` : name;
}

// A driver/helper picker that always renders the current out-of-scope value
// (so a rep who can't list fleet still sees who's assigned). When
// `withContact` is set, options show the staff phone alongside the name.
function StaffSelect({
  label, value, currentName, options, disabled, onChange, withContact,
}: {
  label: string;
  value: number | null | undefined;
  currentName: string | null | undefined;
  options: FleetStaff[];
  disabled: boolean;
  onChange: (id: number | null) => void;
  withContact?: boolean;
}) {
  return (
    <label className="fld" style={{ marginBottom: 6 }}>
      <span className="fld-l">{label}</span>
      <select className="fld-i" value={value ?? ""} disabled={disabled} onChange={(e) => { const v = e.target.value; onChange(v ? parseInt(v, 10) : null); }}>
        <option value="">— unassigned —</option>
        {value != null && currentName && !options.some((o) => o.id === value) && (
          <option value={value}>{currentName}</option>
        )}
        {options.map((o) => <option key={o.id} value={o.id}>{withContact ? staffLabel(o) : (o.name || `#${o.id}`)}</option>)}
      </select>
    </label>
  );
}

function PhaseBlock({
  kind, projectId, project, photo, drivers, lorries, canWrite, canPhoto: canPhotoProp, busy, setBusy, patchProject, notify, reloadPhotos, confirm,
}: {
  kind: "Setup" | "Dismantle";
  projectId: number;
  project: ProjectDetail["project"];
  photo: PhasePhoto | undefined;
  drivers: FleetStaff[];
  lorries: Lorry[];
  canWrite: boolean;
  canPhoto?: boolean;
  busy: boolean;
  setBusy: SetBusy;
  patchProject: (body: Record<string, unknown>) => Promise<boolean>;
  notify: NotifyFn;
  reloadPhotos: () => void;
  confirm: ConfirmFn;
}) {
  // Photo controls open to crew as well as writers (owner 2026-07-21); the
  // schedule/crew fields stay canWrite-only.
  const canPhoto = canWrite || !!canPhotoProp;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const accent = kind === "Setup" ? "#16695f" : "#a16a2e";
  const phase = kind.toLowerCase() as "setup" | "dismantle";
  const isSetup = kind === "Setup";
  const startAt = isSetup ? project.setup_start_at : project.dismantle_start_at;
  const driverId = isSetup ? project.setup_driver_user_id : project.dismantle_driver_user_id;
  const driverName = isSetup ? project.setup_driver_name : project.dismantle_driver_name;
  const lorryId = isSetup ? project.setup_lorry_id : project.dismantle_lorry_id;
  const lorryPlate = isSetup ? project.setup_lorry_plate : project.dismantle_lorry_plate;
  const startCol = isSetup ? "setup_start_at" : "dismantle_start_at";
  const driverCol = isSetup ? "setup_driver_user_id" : "dismantle_driver_user_id";
  const lorryCol = isSetup ? "setup_lorry_id" : "dismantle_lorry_id";

  const [date, setDate] = useState(isoDatePart(startAt));
  const [time, setTime] = useState(isoTimePart(startAt));
  // Existing phase photo — thumbnail + tap-to-view for everyone (drivers
  // included); upload/replace stays gated on canWrite.
  const photoKey = photo?.r2_key ?? null;
  const [photoOpen, setPhotoOpen] = useState(false);
  // Crew fallback: FK-joined name wins, else the crew-editor JSON.
  const crew = parseCrewJson(isSetup ? project.setup_crew : project.dismantle_crew);
  const driverDisplay = driverName || crew.drivers.map(crewLabel).join(", ") || "—";
  const lorryDisplay = lorryPlate || crew.lorries.join(", ") || "—";

  // Compose date + time → the ISO the backend stores. Only PATCHes when a date
  // is present (time-only is meaningless without a day).
  const saveStart = async (d: string, t: string) => {
    if (!d) return;
    await patchProject({ [startCol]: `${d}T${t || "00:00"}:00` });
  };

  const uploadPhoto = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 50MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const up = await api.putBinary<{ key: string; mime_type: string }>(
        `/api/projects/${projectId}/phase-photos/upload?phase=${phase}&ext=${encodeURIComponent(ext)}`,
        buf,
        file.type || "application/octet-stream",
      );
      await api.post(`/api/projects/${projectId}/phase-photos`, {
        phase,
        r2_key: up.key,
        content_type: up.mime_type,
      });
      void reloadPhotos();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: accent, margin: "0 0 10px" }}>
        {kind}
      </div>
      {canWrite ? (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <label className="fld" style={{ flex: 1.4 }}>
              <span className="fld-l">{kind} date</span>
              <DateField fullWidth className="fld-i" value={date} disabled={busy} onChange={(iso) => { setDate(iso); void saveStart(iso, time); }}/>
            </label>
            <label className="fld" style={{ flex: 1 }}>
              <span className="fld-l">Start time</span>
              <input className="fld-i" type="time" value={time} disabled={busy} onChange={(e) => { setTime(e.target.value); void saveStart(date, e.target.value); }} />
            </label>
          </div>
          {/* Single driver/lorry quick-assign — only as a fallback when NO
              per-lorry crew is set (owner: hide once crew details exist). */}
          {crewIsEmpty(crew) && (
            <>
              <StaffSelect label={`${kind} driver & contact`} value={driverId} currentName={driverName} options={drivers} disabled={busy} onChange={(v) => { void patchProject({ [driverCol]: v }); }} withContact />
              <label className="fld" style={{ marginBottom: 6 }}>
                <span className="fld-l">Lorry / vehicle</span>
                <select className="fld-i" value={lorryId ?? ""} disabled={busy} onChange={(e) => { const v = e.target.value; void patchProject({ [lorryCol]: v ? parseInt(v, 10) : null }); }}>
                  <option value="">— unassigned —</option>
                  {lorryId != null && lorryPlate && !lorries.some((l) => l.id === lorryId) && (
                    <option value={lorryId}>{lorryPlate}</option>
                  )}
                  {lorries.map((l) => <option key={l.id} value={l.id}>{l.plate || `#${l.id}`}{l.is_internal === false ? " (outsource)" : ""}</option>)}
                </select>
              </label>
            </>
          )}
          {!crewIsEmpty(crew) && (
            <div style={{ margin: "0 0 10px" }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#9aa093", marginBottom: 7 }}>Planned crew</div>
              {crew.lorryCrew.map((l, i) => (
                <div key={i} style={{ marginBottom: 9, paddingLeft: 9, borderLeft: "2px solid #cfd4c9" }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#2f3329", marginBottom: 4 }}>{l.plate || `Lorry ${i + 1}`}</div>
                  {l.drivers.map((p, j) => <CrewLine key={`d${j}`} role="Driver" person={p} />)}
                  {l.helpers.map((p, j) => <CrewLine key={`h${j}`} role="Helper" person={p} />)}
                </div>
              ))}
              {crew.outsourced.length > 0 && (
                <div style={{ paddingLeft: 9 }}>
                  {crew.outsourced.map((p, j) => <CrewLine key={`o${j}`} role="Outsrc." person={p} />)}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="pgrid2" style={{ marginBottom: 6 }}>
          <div><div className="pkv-l">{kind} date</div><div className="pkv-v">{dOnly(startAt)}</div></div>
          <div><div className="pkv-l">Start time</div><div className="pkv-v">{tOnly(startAt)}</div></div>
          {crewIsEmpty(crew) && <div><div className="pkv-l">{kind} driver</div><div className="pkv-v">{driverDisplay}</div></div>}
          {crewIsEmpty(crew) && <div><div className="pkv-l">Lorry / vehicle</div><div className="pkv-v">{lorryDisplay}</div></div>}
          {/* Read-only crew: same structured "Planned crew" layout as the
              editable view (owner 2026-07-16) — per-lorry plate header with
              Driver / Helper rows, so the helper portal matches the owner's. */}
          {!crewIsEmpty(crew) && (
            <div style={{ gridColumn: "1 / -1", marginTop: 2 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#9aa093", marginBottom: 7 }}>Planned crew</div>
              {crew.lorryCrew.map((l, i) => (
                <div key={i} style={{ marginBottom: 9, paddingLeft: 9, borderLeft: "2px solid #cfd4c9" }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#2f3329", marginBottom: 4 }}>{l.plate || `Lorry ${i + 1}`}</div>
                  {l.drivers.map((p, j) => <CrewLine key={`d${j}`} role="Driver" person={p} />)}
                  {l.helpers.map((p, j) => <CrewLine key={`h${j}`} role="Helper" person={p} />)}
                </div>
              ))}
              {crew.outsourced.length > 0 && (
                <div style={{ paddingLeft: 9 }}>
                  {crew.outsourced.map((p, j) => <CrewLine key={`o${j}`} role="Outsrc." person={p} />)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* Owner 2026-07-23: the "Replace photo" text button is gone (remove the
          photo, then tap-to-upload again) and Remove is the same floating ×
          every other file row uses. */}
      <div style={{ position: "relative" }}>
        <button
          type="button"
          disabled={busy || (!photoKey && !canPhoto)}
          onClick={() => { if (photoKey) setPhotoOpen(true); else if (canPhoto) fileRef.current?.click(); }}
          style={{ width: "100%", border: "1px solid #d6d9d2", borderRadius: 11, background: "#fff", display: "flex", alignItems: "center", gap: 10, marginTop: 0, overflow: "hidden", cursor: photoKey || canPhoto ? "pointer" : "default", fontFamily: "inherit", padding: 0, textAlign: "left" }}
        >
          {photoKey ? (
            <R2Thumb r2Key={photoKey} style={{ width: 64, height: 54, flex: "none" }} />
          ) : (
            <div className="ph" style={{ width: 64, height: 54, flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7.5 6.5H4A2 2 0 0 0 2 8.5v9A2 2 0 0 0 4 19.5h16a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-3.5L14.5 4Z" /><circle cx="12" cy="13" r="3.2" /></svg>
            </div>
          )}
          <div style={{ padding: "7px 0", minWidth: 0 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#11140f" }}>{kind} photo{photoKey ? " · tap to view" : canPhoto ? " · tap to upload" : ""}</div>
            <div style={{ fontSize: 9.5, color: "#9aa093", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{uploaderCredit(photo)}</div>
          </div>
        </button>
        {photoKey && canPhoto && (
          <button
            aria-label={`Remove ${kind.toLowerCase()} photo`}
            disabled={busy}
            onClick={async () => {
              if (!photo) return;
              if (!(await confirm({ title: `Remove the ${kind.toLowerCase()} photo?`, confirmLabel: "Remove", danger: true }))) return;
              setBusy(true);
              try {
                await api.del(`/api/projects/phase-photos/${photo.id}`);
                void reloadPhotos();
              } catch (e) {
                await notify({ title: "Remove failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
              } finally {
                setBusy(false);
              }
            }}
            style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", border: "1px solid #d6d9d2", background: "#fff", color: "#a13a34", fontSize: 12, lineHeight: 1, cursor: "pointer" }}
          >
            ×
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept="image/*,.pdf,.mp4,.mov,.webm" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadPhoto(f); }} />
      {photoOpen && photoKey && (
        <MediaLightbox
          items={[{ r2_key: photoKey, content_type: mimeFromKey(photoKey), caption: photo?.caption ?? `${kind} photo` }]}
          index={0}
          onChange={() => {}}
          onClose={() => setPhotoOpen(false)}
          baseUrl="/api/projects/attachments"
          badge={kind}
        />
      )}
    </>
  );
}

// ── Setup & Dismantle documents — sales tile card (owner 2026-07-17) ──
// The sales cohort's six deliverables rendered as Floor-Plans-style tiles:
// Weekend Activity is a REMARK tile (tap to edit the item's `notes`); the
// other five are FILE tiles (thumbnail of the latest upload, tap to view,
// "+ Add" to upload — Defect List keeps its compulsory per-photo remark).
// Tiles map to checklist items by title prefix; "Setup Image" exists twice,
// so that tile pins to the SALES PIC-badged variant.
// Arrangement per the owner's Card-Editor screenshot (2026-07-17): Weekend
// full-width on top, Permit+Deco side by side, Setup Image+Defect List side
// by side, Event Complete Image full-width at the bottom.
type DocTile = {
  label: string;
  match: RegExp;
  salesPicOnly?: boolean;
  /** Pin to the DRIVER-badged variant when a title exists in two roles. */
  driverOnly?: boolean;
  remarkTile?: boolean;
  /** Owner 2026-07-21 (crew Decoration): media area shows the item's remark
   *  AND the files are listed below, view/download-only. */
  remarkWithFiles?: boolean;
  requirePhotoRemark?: boolean;
  /** Full-width tile (spans both grid columns). */
  fullWidth?: boolean;
  /** Media area height in px (default 80). */
  mediaH?: number;
  /** Owner 2026-07-17: BD-owned items — sales VIEW + DOWNLOAD only, no
   *  edit/upload/remove from this card. */
  readOnly?: boolean;
};

const SALES_DOC_TILES: ReadonlyArray<DocTile> = [
  { label: "Weekend Activity", match: /^weekend/i, remarkTile: true, fullWidth: true, readOnly: true },
  { label: "Permit", match: /permit/i, readOnly: true },
  { label: "Decoration", match: /^deco/i, readOnly: true },
  { label: "Setup Image", match: /^setup image/i, salesPicOnly: true },
  // Defect List split (owner 2026-07-29): Setup + Dismantle variants, both
  // shared with the driver crew ("SALES PIC & DRIVER") and both keeping the
  // compulsory per-photo remark.
  { label: "Defect Item Setup", match: /^defect (list|item) setup/i, requirePhotoRemark: true },
  { label: "Defect Item Dismantle", match: /^defect (list|item) dismantle/i, requirePhotoRemark: true },
  { label: "Event Complete Image", match: /^event complete image/i, fullWidth: true, mediaH: 108 },
];

// ── Crew (driver/helper/storekeeper) tile set (owner 2026-07-21 v2) ──
// Same card style as sales, ALL view/download-only — crew's own photo work
// (setup/dismantle) moved to the Setup & Dismantle section's phase photos.
// Decoration shows its remark AND its files (view remark + download).
// Defect tiles carry the per-file Ongoing/Done timeline + the N/A button
// (owner 2026-07-29). Matched off the resolved checklist item title.
// Live task titles are "Defect Item Setup/Dismantle" (there are no "Defect
// List" rows in prod), so the old /^defect list/i matched nothing here and the
// tile path never showed the action buttons or the no-defect N/A control
// (BUG-HISTORY 2026-08-07). Widen to match both families, like every other
// defect matcher and the backend.
const isDefectTile = (t: { item?: ChecklistItem | null }): boolean =>
  /^defect (list|item)/i.test((t.item?.title ?? "").trim());

const CREW_DOC_TILES: ReadonlyArray<DocTile> = [
  // Owner 2026-07-22: Stock Out Transfer Record + Blank Floorplan tiles
  // removed from the crew card — the floorplan already lives in the
  // Floor plans & layout card below, so the Event documents card carries
  // just the permit + decoration brief.
  { label: "Permit", match: /permit/i, readOnly: true },
  { label: "Decoration", match: /^deco/i, readOnly: true, remarkWithFiles: true },
  // Defect List pair (owner 2026-07-29): shared sales+driver deliverables
  // ("SALES PIC & DRIVER") — crew EDIT them here, compulsory remark per photo.
  { label: "Defect Item Setup", match: /^defect (list|item) setup/i, requirePhotoRemark: true },
  { label: "Defect Item Dismantle", match: /^defect (list|item) dismantle/i, requirePhotoRemark: true },
];

// ── Document review (Approve / Reject) — shared by the doc cards ──
// The rule now lives in pms-reviewable-titles.ts, shared with desktop, which
// used to test a Set of EXACT titles — so a suffixed row got this workflow here
// and no review controls at all on the PC.

// After uploading to a reviewable doc, auto-submit it so the approver's
// Approve/Reject (re)appear — desktop does exactly this (Projects.tsx upload →
// onReview("submit")). Non-perm reviewables (3D/2D/Display/Exchange) depend on
// this: their gate needs review_status=pending_review, which nothing else sets.
// Non-fatal: a failed submit only delays the amber PENDING badge.
async function autoSubmitReviewable(itemId: number, title: string | null | undefined): Promise<void> {
  if (!isReviewableTitle(title)) return;
  try {
    await api.post(`/api/projects/checklist/${itemId}/review`, { action: "submit" });
  } catch {
    /* silent-write-ok: the UPLOAD already succeeded and is on screen. This
       only delays the amber PENDING badge, and the approver can still submit
       via re-upload, so there is nothing for the uploader to act on. */
  }
}

// Whether to show Approve/Reject on a document tile — desktop-parity gate
// (pages/Projects.tsx DocRow): once a file exists, a holder of the item's
// approval permission decides a still-open gated doc; an un-permed reviewable
// keeps the submit-then-review flow (any viewer, while a review is pending).
// canApprove = wildcard-free: an explicit approval key is required for the four
// EXPLICIT_APPROVAL_KEYS, but a non-perm reviewable is open to any viewer.
function checklistReviewVisible(
  permissions: readonly string[] | null | undefined,
  item: ChecklistItem | undefined,
  hasFiles: boolean,
): boolean {
  if (!item || !hasFiles) return false;
  const reviewStatus = (item.review_status ?? "").toLowerCase();
  const canApprove = !item.required_perm || holdsChecklistApproval(permissions, item.required_perm);
  const awaitingReview = reviewStatus === "pending_review" || reviewStatus === "amended";
  // Owner 2026-07-31 (final): on a gated document the approver ALWAYS keeps
  // Approve / Reject once a file exists — including one already approved — so a
  // decision can be reviewed or reversed at any time. (Previously the buttons
  // vanished the moment it was approved, which read as "the feature is
  // missing": on prod all 248 3D Designs were approved, so no event showed
  // them.) The current decision still rides the tile as its APPROVED /
  // REJECTED / PENDING badge, and every click is logged to the comment
  // history, so reversals stay auditable. `status`/`awaitingReview` are no
  // longer part of this arm — the permission alone decides.
  if (item.required_perm) return canApprove;
  const reviewable = isReviewableTitle(item.title);
  return reviewable && awaitingReview && canApprove;
}

// The Approve / Reject button pair + review handler, shared by the doc cards.
// Reject requires a reason (prompt); both POST /checklist/:id/review (the
// endpoint re-checks the approval permission server-side → 403s a non-holder).
function ReviewButtons({
  item, busy, setBusy, prompt, notify, reload,
}: {
  item: ChecklistItem;
  busy: boolean;
  setBusy: SetBusy;
  prompt: PromptFn;
  notify: NotifyFn;
  reload: () => void;
}) {
  const review = async (action: "approve" | "reject") => {
    const body: Record<string, unknown> = { action };
    if (action === "reject") {
      const reason = await prompt({ title: `Reject "${item.title}"?`, placeholder: "Reason (required)", validate: (v) => (v.trim() ? null : "A reason is required.") });
      if (reason == null || !reason.trim()) return;
      body.reason = reason.trim();
    }
    setBusy(true);
    try {
      await api.post(`/api/projects/checklist/${item.id}/review`, body);
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  // Toggle (owner 2026-08-10): show only the button that REVERSES the current
  // decision. Approve hidden once approved (Reject stays, to re-open); Reject
  // hidden once rejected (Approve stays, to approve the fix). The status itself
  // stays visible via the ReviewBadge next to these buttons.
  const rs = (item.review_status ?? "").toLowerCase();
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
      {rs !== "approved" && (
        <button className="tinybtn" style={{ flex: 1, background: "#e2f0e9", borderColor: "#bcdcd7", color: "#2f8a5b" }} disabled={busy} onClick={(e) => { e.stopPropagation(); void review("approve"); }}>Approve</button>
      )}
      {rs !== "rejected" && (
        <button className="tinybtn" style={{ flex: 1, background: "#f7e7e5", borderColor: "#e6c9c6", color: "#a13a34" }} disabled={busy} onClick={(e) => { e.stopPropagation(); void review("reject"); }}>Reject</button>
      )}
    </div>
  );
}

// Small review-decision badge (green approved / red rejected / amber pending),
// shared by the doc cards. Renders nothing when there's no decision yet.
// Owner 2026-07-31: "cant see which one not approve yet". A reviewable doc that
// carries a file but has NO decision yet (review_status NULL — uploaded before
// auto-submit existed, or never submitted) used to render NO badge at all, so
// approved and un-approved documents looked identical on the tile. Pass
// `item`+`hasFiles` and it now says NOT APPROVED instead of staying blank.
// Nothing shows on an empty document — there is nothing to approve yet.
function ReviewBadge({
  reviewStatus, item, hasFiles,
}: {
  reviewStatus: string | null | undefined;
  item?: ChecklistItem;
  hasFiles?: boolean;
}) {
  const rs = (reviewStatus ?? "").toLowerCase();
  if (!rs) {
    const reviewable = !!item && (!!item.required_perm || isReviewableTitle(item.title));
    const approvedByStatus = (item?.status ?? "").toLowerCase() === "done";
    if (!reviewable || !hasFiles || approvedByStatus) return null;
    return <span className="rbadge" style={{ background: "#f6efd9", color: "#6e4d12" }}>NOT APPROVED</span>;
  }
  return (
    <span className="rbadge" style={{
      background: rs === "approved" ? "#e2f0e9" : rs === "rejected" ? "#f7e7e5" : "#f6efd9",
      color: rs === "approved" ? "#2f8a5b" : rs === "rejected" ? "#a13a34" : "#6e4d12",
    }}>{humanize(rs).toUpperCase()}</span>
  );
}

function SalesDocsCard({
  checklist, attachments, canTick, busy, setBusy, notify, prompt, confirm, reload,
  tiles: tileDefs = SALES_DOC_TILES,
  title = "Setup & Dismantle documents",
  showRoleTags = false,
}: {
  checklist?: ChecklistItem[];
  attachments?: TaskAttachment[];
  canTick: boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  prompt: PromptFn;
  confirm: ConfirmFn;
  reload: () => void;
  /** Tile set — defaults to the sales six; crew pass CREW_DOC_TILES. */
  tiles?: ReadonlyArray<DocTile>;
  title?: string;
  /** Owner 2026-07-23: show each task's role chip (DRIVER / SALES PIC / …) on
   *  the tile — for oversight viewers (mgt, BD, owner, SD, logistic). */
  showRoleTags?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pendingRef = useRef<{ itemId: number; title: string | null; caption?: string } | null>(null);
  const [view, setView] = useState<{ items: MediaItem[]; idx: number } | null>(null);
  // Approve/Reject on the doc tiles (owner 2026-07-29). The tasklist that used
  // to carry these is gone on mobile, so a reviewable doc (Agreement/Quotation,
  // Stock Out/In, 3D/2D Design, Display Floorplan, Exchange List) had no way to
  // be approved on a phone. Gate + endpoint match the desktop DocRow exactly
  // (shared checklistReviewVisible / ReviewButtons); user drives the perm check.
  const { user, can } = useAuth();
  // Owner 2026-08-05: file DELETE follows the PC rule — managers only
  // (projects.manage). canTick already folds in !archived, so a manager still
  // can't delete on an archived project; upload/remark stay on canTick.
  const canDeleteFiles = can("projects.manage") && canTick;

  const tiles = tileDefs.map((t) => {
    const item = (checklist ?? []).find(
      (it) =>
        t.match.test((it.title || "").trim()) &&
        (!t.salesPicOnly || (it.role_label ?? "").trim().toUpperCase() === "SALES PIC") &&
        (!t.driverOnly || (it.role_label ?? "").trim().toUpperCase() === "DRIVER")
    );
    const atts = item
      ? (attachments ?? []).filter((a) => !a.archived_at && a.item_id === item.id)
      : [];
    const files = atts.map((a): MediaItem => ({
      r2_key: a.r2_key,
      content_type: a.mime_type ?? mimeFromKey(a.r2_key),
      caption: a.file_name,
    }));
    return { ...t, item, atts, files };
  }).filter((t) => t.item);

  if (tiles.length === 0) return null;

  const doneCount = tiles.filter((t) =>
    t.remarkTile ? !!(t.item?.notes ?? "").trim()
    : t.remarkWithFiles ? (t.files.length > 0 || !!(t.item?.notes ?? "").trim())
    : t.files.length > 0
  ).length;

  const startUpload = async (t: (typeof tiles)[number]) => {
    if (!t.item || t.readOnly) return;
    let caption: string | undefined;
    if (t.requirePhotoRemark) {
      const remark = await prompt({
        title: "Remark for this photo",
        placeholder: "e.g. scratch on left armrest",
        validate: (v) => (v.trim() ? null : "Please write a remark before uploading."),
      });
      if (remark == null || !remark.trim()) return;
      caption = remark.trim();
    }
    pendingRef.current = { itemId: t.item.id, title: t.item.title, caption };
    fileRef.current?.click();
  };

  const upload = async (file: File) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    if (file.size > 10 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 10MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const capParam = pending.caption ? `&caption=${encodeURIComponent(pending.caption)}` : "";
      await api.putBinary(
        `/api/projects/checklist/${pending.itemId}/attachments?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(file.name)}${capParam}`,
        buf,
        file.type || "application/octet-stream",
      );
      // Reviewable docs auto-submit so the approver's Approve/Reject appear (desktop parity).
      await autoSubmitReviewable(pending.itemId, pending.title);
      reload();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeFile = async (t: (typeof tiles)[number], att: TaskAttachment) => {
    if (t.readOnly || !canDeleteFiles) return;
    if (!(await confirm({ title: `Remove ${att.file_name || "this file"}?`, confirmLabel: "Remove", danger: true }))) return;
    setBusy(true);
    try {
      await api.del(`/api/projects/checklist/attachments/${att.id}`);
      reload();
    } catch (e) {
      await notify({ title: "Remove failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const editRemark = async (t: (typeof tiles)[number]) => {
    if (!t.item || !canTick) return;
    const val = await prompt({
      title: `Remark — ${t.label}`,
      placeholder: "Write the remark…",
      defaultValue: t.item.notes ?? "",
    });
    if (val == null) return;
    setBusy(true);
    try {
      await api.patch(`/api/projects/checklist/${t.item.id}`, { notes: val.trim() });
      reload();
    } catch (e) {
      await notify({ title: "Save failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const openTile = async (t: (typeof tiles)[number]) => {
    if (t.remarkWithFiles) {
      // Files win the tap (they carry the download); the remark is already
      // visible on the tile face, and surfaces in full when there's no file.
      if (t.files.length > 0) { setView({ items: t.files, idx: t.files.length - 1 }); return; }
      const txt = (t.item?.notes ?? "").trim();
      await notify(txt
        ? { title: t.label, body: txt }
        : { title: t.label, body: "No remark or file here yet.", tone: "info" });
      return;
    }
    if (t.remarkTile) {
      if (t.readOnly) {
        // View-only: surface the full remark (the tile truncates long text).
        const txt = (t.item?.notes ?? "").trim();
        await notify(txt
          ? { title: t.label, body: txt }
          : { title: t.label, body: "No remark has been written yet.", tone: "info" });
        return;
      }
      await editRemark(t);
      return;
    }
    if (t.files.length > 0) { setView({ items: t.files, idx: t.files.length - 1 }); return; }
    if (canTick && !t.readOnly) { await startUpload(t); return; }
    await notify({ title: `${t.label} not uploaded`, body: "Nothing has been uploaded here yet.", tone: "info" });
  };

  return (
    <details className="pacc" open>
      <summary>
        <span className="psec-t">{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: "#9aa093" }}>{doneCount}/{tiles.length}</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
          {tiles.map((t) => {
            // Tile cover (owner 2026-08-28): prefer the newest IMAGE so a PDF
            // uploaded after the photos doesn't blank the thumbnail — users
            // read the hatched placeholder as "nothing here".
            const latest =
              [...t.files].reverse().find((f) => /^image\//.test(f.content_type ?? "")) ??
              t.files[t.files.length - 1];
            const hasContent = t.remarkTile ? !!(t.item?.notes ?? "").trim()
              : t.remarkWithFiles ? (t.files.length > 0 || !!(t.item?.notes ?? "").trim())
              : t.files.length > 0;
            const mediaH = t.mediaH ?? 80;
            // Review state (desktop parity) — shared gate + badge + buttons.
            const rItem = t.item!;
            const canReview = checklistReviewVisible(user?.permissions, rItem, t.files.length > 0);
            return (
              <div key={t.label} style={{ border: "1px solid #d6d9d2", borderRadius: 11, overflow: "hidden", background: "#fff", ...(t.fullWidth ? { gridColumn: "1 / -1" } : {}) }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (!busy) void openTile(t); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!busy) void openTile(t); } }}
                  style={{ cursor: "pointer" }}
                >
                  {t.remarkTile || t.remarkWithFiles ? (
                    <div style={{ height: mediaH, padding: "8px 10px", fontSize: 11, lineHeight: 1.45, color: (t.item?.notes ?? "").trim() ? "#414539" : "#9aa093", overflow: "hidden", background: "#faf9f5" }}>
                      {(t.item?.notes ?? "").trim() || (canTick && !t.readOnly && !t.remarkWithFiles ? "Tap to write the remark…" : "No remark yet.")}
                    </div>
                  ) : latest && /^image\//.test(latest.content_type ?? "") ? (
                    <R2Thumb r2Key={latest.r2_key} style={{ width: "100%", height: mediaH }} />
                  ) : (
                    <div className="ph" style={{ height: mediaH }} />
                  )}
                  <div style={{ padding: "7px 9px 4px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#11140f" }}>{t.label}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                      <span className="rbadge" style={{ background: hasContent ? "#e2f0e9" : "#f0f1ed", color: hasContent ? "#2f8a5b" : "#9aa093" }}>
                        {t.remarkTile || (t.remarkWithFiles && t.files.length === 0)
                          ? (hasContent ? "DONE" : "NONE")
                          : (hasContent ? `${t.files.length} FILE${t.files.length === 1 ? "" : "S"}` : "NONE")}
                      </span>
                      {/* Owner 2026-07-23: oversight viewers (mgt/BD/owner/SD/
                          logistic) see WHO owns each deliverable — the task's
                          role chip, same colours as the old tasklist rows. */}
                      {showRoleTags && (t.item?.role_label ?? "").trim() && roleLabelParts(t.item!.role_label!).map((part) => (
                        <span key={part} className="rbadge" style={{ background: `${roleColor(part)}1f`, color: roleColor(part), marginRight: 4 }}>
                          {formatRoleLabel(part)}
                        </span>
                      ))}
                      {/* Review decision (owner 2026-07-29): green approved ·
                          red rejected · amber pending — travels with the tile. */}
                      <ReviewBadge reviewStatus={rItem.review_status} item={rItem} hasFiles={t.files.length > 0} />
                    </div>
                  </div>
                </div>
                {/* Owner 2026-07-17: the editable photo tiles list every uploaded
                    file by name — tap the name to VIEW it first; × removes it
                    (confirm-guarded). Upload stays its own button below. */}
                {/* remarkWithFiles (crew Decoration): the files listed by name,
                    view/download-only — tap opens the lightbox. */}
                {t.remarkWithFiles && t.atts.length > 0 && (
                  <div style={{ padding: "0 9px 8px", display: "flex", flexDirection: "column", gap: 5 }}>
                    {t.atts.map((a, i) => (
                      <button
                        key={a.id}
                        type="button"
                        className="tinybtn"
                        style={{ minWidth: 0, display: "inline-flex", alignItems: "center", gap: 5 }}
                        onClick={() => setView({ items: t.files, idx: i })}
                        title={a.file_name ?? undefined}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.file_name || "File"}</span>
                      </button>
                    ))}
                  </div>
                )}
                {/* Defect tiles ALSO list files when read-only (owner 2026-07-29):
                    the purchaser's view tile carries the per-file Ongoing/Done
                    timeline, so Sim can action defects from her card. */}
                {!t.remarkTile && !t.remarkWithFiles && (!t.readOnly || isDefectTile(t)) && t.atts.length > 0 && (
                  <div style={{ padding: "0 9px 6px", display: "flex", flexDirection: "column", gap: 5 }}>
                    {t.atts.map((a, i) => (
                      <div key={a.id}>
                        <span style={{ display: "inline-flex", alignItems: "stretch", width: "100%" }}>
                          <button
                            type="button"
                            className="tinybtn"
                            style={{ flex: 1, minWidth: 0, display: "inline-flex", alignItems: "center", gap: 5, ...(canDeleteFiles && !t.readOnly ? { borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: "none" } : {}) }}
                            onClick={() => setView({ items: t.files, idx: i })}
                            title={a.file_name ?? undefined}
                          >
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.file_name || "File"}</span>
                          </button>
                          {canDeleteFiles && !t.readOnly && (
                            <button
                              type="button"
                              className="tinybtn"
                              disabled={busy}
                              style={{ flex: "none", padding: "0 8px", borderTopLeftRadius: 0, borderBottomLeftRadius: 0, color: "#a13a34", display: "inline-flex", alignItems: "center" }}
                              onClick={() => void removeFile(t, a)}
                              title="Remove file"
                              aria-label="Remove file"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                            </button>
                          )}
                        </span>
                        {isDefectTile(t) && <DefectFileActions att={a} />}
                      </div>
                    ))}
                  </div>
                )}
                {!t.remarkTile && canTick && !t.readOnly && (
                  <div style={{ padding: "0 9px 8px" }}>
                    <button className="tinybtn" style={{ width: "100%" }} disabled={busy} onClick={() => void startUpload(t)}>
                      {t.files.length ? "+ Add more" : "Upload"}
                    </button>
                  </div>
                )}
                {/* N/A — no defect (owner 2026-07-29): sales PIC + driver mark a
                    defect list N/A when nothing is defective. Tap again undoes. */}
                {isDefectTile(t) && t.item && canTick && !t.readOnly && (
                  <div style={{ padding: "0 9px 8px" }}>
                    <button
                      className="tinybtn"
                      style={{ width: "100%", background: t.item.status === "na" ? "#f4f6f3" : "#fff", color: "#767b6e" }}
                      disabled={busy}
                      onClick={async () => {
                        const next = t.item!.status === "na" ? "pending" : "na";
                        setBusy(true);
                        try {
                          await api.post(`/api/projects/checklist/${t.item!.id}/status`, { status: next });
                          reload();
                        } catch (e) {
                          await notify({ title: "Failed to update", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {t.item.status === "na" ? "Marked N/A — tap to undo" : "N/A — no defect"}
                    </button>
                  </div>
                )}
                {/* Approve / Reject — shown to a holder of this doc's approval
                    permission (server re-checks). Renders even on a read-only
                    tile: the approver often isn't the uploader. */}
                {canReview && (
                  <div style={{ padding: "0 9px 8px" }}>
                    <ReviewButtons item={rItem} busy={busy} setBusy={setBusy} prompt={prompt} notify={notify} reload={reload} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <input ref={fileRef} type="file" accept="image/*,.pdf,.mp4,.mov,.webm" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        {view && (
          <MediaLightbox
            items={view.items}
            index={view.idx}
            onChange={(i) => setView((v) => (v ? { ...v, idx: i } : v))}
            onClose={() => setView(null)}
            baseUrl="/api/projects/attachments"
            badge="Document"
          />
        )}
      </div>
    </details>
  );
}

// ── Floor plans & layout + stock transfers ──
// The 3D viewer stays a design placeholder (no plan-image payload). The
// Unfilled / Filled plan tiles are wired to the project's floorplan-category
// attachments: tap opens the plan when one exists, or prompts an upload.
// The Stock Transfer Record is upload-only (matches the design): a stock-out
// record is uploaded via PUT /:id/stock-transfers/upload → POST
// /:id/stock-transfers. Existing rows are listed read-only.
function FloorPlans({
  projectId, stockTransfers, attachments, checklist, checklistAttachments, canWrite, hideFilledPlan, hidePlanTiles, canStockEdit, confirm, busy, setBusy, notify, reload,
}: {
  projectId: number;
  stockTransfers?: StockTransfer[];
  attachments?: ProjectAttachment[];
  checklist?: ChecklistItem[];
  checklistAttachments?: TaskAttachment[];
  canWrite: boolean;
  hideFilledPlan?: boolean;
  /** Owner 2026-07-23: hide the Unfilled+Filled plan tiles (ops/office cohort
   *  — floorplans are for sales/SD/mgt/BD only); 3D/2D/banner/stock stay. */
  hidePlanTiles?: boolean;
  /** Owner 2026-07-23 purchaser view: upload/remove on the Stock Out Transfer
   *  Record straight from this card (attaches to the checklist task). */
  canStockEdit?: boolean;
  confirm?: ConfirmFn;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  reload: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const transfers = stockTransfers ?? [];
  // Approve/Reject on the reviewable Floor-Plans docs (owner 2026-07-29): Stock
  // Out Transfer Record (stock_transfer.approve), 3D / 2D Design + Display Floor
  // Plan (no perm → submit-then-review). Shared gate/buttons with the doc cards.
  const { user } = useAuth();
  const prompt = usePrompt();
  const itemByPrefix = (prefix: RegExp): ChecklistItem | undefined =>
    (checklist ?? []).find((it) => prefix.test((it.title || "").trim()));
  const threeDItem = itemByPrefix(/^3d\s*(design|render)/i);
  const twoDItem = itemByPrefix(/^2d\s*design/i);
  const displayItem = itemByPrefix(/^display\s*floor\s*plan/i);
  const stockOutItem = itemByPrefix(/^stock\s*out\s*transfer/i);

  // The tiles mirror the "Blank Floorplan" / "Filled Floorplan" CHECKLIST
  // task attachments (mig 050 moved uploads per-task — files attached in the
  // tasklist must surface here). The legacy project-level floorplan-category
  // attachments remain as a fallback for pre-050 projects.
  // Viewing goes through MediaLightbox rather than window.open(blobUrl):
  // mobile browsers popup-block window.open once an await has broken the
  // user-gesture chain, which made these tiles dead on phones.
  const plans = (attachments ?? []).filter((a) => (a.category || "").toLowerCase() === "floorplan");
  const taskPlanFiles = (prefix: RegExp): MediaItem[] => {
    const ids = new Set(
      (checklist ?? []).filter((it) => prefix.test((it.title || "").trim())).map((it) => it.id)
    );
    return (checklistAttachments ?? [])
      .filter((a) => !a.archived_at && ids.has(a.item_id))
      .map((a): MediaItem => ({
        r2_key: a.r2_key,
        content_type: a.mime_type ?? mimeFromKey(a.r2_key),
        caption: a.file_name,
      }));
  };
  const legacyItem = (a: ProjectAttachment | undefined): MediaItem[] => {
    const k = a ? pick(a.r2_key, a.r2Key) : undefined;
    return a && k
      ? [{ r2_key: k, content_type: pick(a.mime_type, a.mimeType) ?? mimeFromKey(k), caption: pick(a.file_name, a.fileName) }]
      : [];
  };
  const unfilledFiles = (() => { const t = taskPlanFiles(/^blank\s*floor\s*plan/i); return t.length ? t : legacyItem(plans[0]); })();
  const filledFiles = (() => { const t = taskPlanFiles(/^filled\s*floor\s*plan/i); return t.length ? t : legacyItem(plans[1]); })();
  // Owner 2026-07-23: 3D + 2D design tiles join this card (view/download via
  // the lightbox) — their booth-layout tasklist rows are gone on mobile.
  const threeDFiles = taskPlanFiles(/^3d\s*(design|render)/i);
  const twoDFiles = taskPlanFiles(/^2d\s*design/i);
  // Black banner (owner 2026-07-17 v2): shows the "Display Floor Plan" task
  // attachments in the lightbox (which carries a Download button). Was the 3D
  // placeholder, then briefly wired to 3D Design; the owner wants the booth's
  // display floorplan here instead.
  const displayPlanFiles = taskPlanFiles(/^display\s*floor\s*plan/i);
  // Checklist task ids by title prefix — used to attach uploads to the right task.
  const taskIdByPrefix = (prefix: RegExp): number | null =>
    (checklist ?? []).find((it) => prefix.test((it.title || "").trim()))?.id ?? null;
  const filledPlanTaskId = taskIdByPrefix(/^filled\s*floor\s*plan/i);
  // Purchaser stock-out edit (owner 2026-07-23) — uploads land on the Stock
  // Out Transfer Record task.
  const stockOutUploadTaskId = taskIdByPrefix(/^stock\s*out\s*transfer/i);
  const stockRef = useRef<HTMLInputElement | null>(null);
  const uploadStockOut = async (file: File) => {
    if (stockOutUploadTaskId == null) return;
    if (file.size > 10 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 10MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      await api.putBinary(
        `/api/projects/checklist/${stockOutUploadTaskId}/attachments?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(file.name)}`,
        buf,
        file.type || "application/octet-stream",
      );
      // Auto-submit so the approver's Approve/Reject appear (desktop parity).
      await autoSubmitReviewable(stockOutUploadTaskId, stockOutItem?.title ?? "Stock Out Transfer Record");
      reload();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (stockRef.current) stockRef.current.value = "";
    }
  };
  // Stock out transfer — mirrors the "Stock Out Transfer Record" CHECKLIST task
  // attachments. (The legacy project-level stock_transfers store is unused: every
  // stock-out record is attached to the task, which is why this read empty.)
  const stockOutAtts = (() => {
    const ids = new Set(
      (checklist ?? []).filter((it) => /^stock\s*(out|in)\s*transfer/i.test((it.title || "").trim())).map((it) => it.id)
    );
    return (checklistAttachments ?? []).filter((a) => !a.archived_at && ids.has(a.item_id));
  })();
  // Sales upload the Filled Floorplan straight from this card (owner 2026-07-17)
  // — it attaches to the "Filled Floorplan" checklist task, so the tasklist row
  // and this card stay one and the same file.
  const filledRef = useRef<HTMLInputElement | null>(null);
  const uploadFilledPlan = async (file: File) => {
    if (!filledPlanTaskId) {
      await notify({ title: "No Filled Floorplan task", body: "This event has no Filled Floorplan task to attach to.", tone: "error" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      await notify({ title: "File too large", body: "Max 10MB.", tone: "error" });
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ext) {
      await notify({ title: "Missing extension", body: "The file needs an extension.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      await api.putBinary(
        `/api/projects/checklist/${filledPlanTaskId}/attachments?ext=${encodeURIComponent(ext)}&name=${encodeURIComponent(file.name)}`,
        buf,
        file.type || "application/octet-stream",
      );
      reload();
    } catch (e) {
      await notify({ title: "Upload failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
      if (filledRef.current) filledRef.current.value = "";
    }
  };
  const [planView, setPlanView] = useState<{ items: MediaItem[]; idx: number } | null>(null);
  const [docView, setDocView] = useState<MediaItem | null>(null);
  const openPlan = async (files: MediaItem[], which: string) => {
    if (files.length === 0) {
      await notify({ title: `${which} plan not uploaded`, body: "No floor plan has been uploaded for this project yet.", tone: "info" });
      return;
    }
    setPlanView({ items: files, idx: files.length - 1 });
  };

  return (
    <details className="pacc">
      <summary>
        <span className="psec-t">Floor plans &amp; layout</span>
        {transfers.length > 0 && <span style={{ marginLeft: "auto", fontSize: 10, color: "#9aa093" }}>{transfers.length} transfer{transfers.length === 1 ? "" : "s"}</span>}
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        {/* Owner 2026-07-31: the Display floor plan is a NORMAL tile now — the
            black banner is gone and it shows its own preview like every other
            tile. Order is Display → 3D + 2D → Unfilled + Filled; Display spans
            the full width so the two design tiles stay paired on their own row.
            Filled plan is hidden from driver/helper/storekeeper (owner
            2026-07-16); BOTH plan tiles are hidden from the ops/office cohort
            (owner 2026-07-23: sales/SD/mgt/BD only). */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
          {([
            { key: "Display", label: "Display floor plan", files: displayPlanFiles, badge: "PLAN", bg: "#f3ece0", col: "#a16a2e", item: displayItem, full: true, mediaH: 140 },
            { key: "3D Design", label: "3D Design", files: threeDFiles, badge: "3D", bg: "#e9e6f4", col: "#5b4b8a", item: threeDItem, full: false, mediaH: 80 },
            { key: "2D Design", label: "2D Design", files: twoDFiles, badge: "2D", bg: "#e2ecf5", col: "#2f5c8a", item: twoDItem, full: false, mediaH: 80 },
            { key: "Unfilled", label: "Unfilled plan", files: unfilledFiles, badge: "DRAFT", bg: "#f6efd9", col: "#6e4d12", item: undefined, full: false, mediaH: 80 },
            { key: "Filled", label: "Filled plan", files: filledFiles, badge: "PLACED", bg: "#e2f0e9", col: "#2f8a5b", item: undefined, full: false, mediaH: 80 },
          ] as const).filter((t) =>
            !(hideFilledPlan && t.key === "Filled") &&
            !(hidePlanTiles && (t.key === "Unfilled" || t.key === "Filled"))
          ).map((t) => {
            const files = t.files;
            // Cover = newest IMAGE (owner 2026-08-28): a PDF uploaded after the
            // photos must not blank the thumbnail into the hatched placeholder.
            const latest =
              [...files].reverse().find((f) => /^image\//.test(f.content_type ?? "")) ??
              files[files.length - 1];
            // Display / 3D / 2D are reviewable (owner 2026-07-29); the
            // Unfilled / Filled plan tiles are not.
            const tileItem = t.item;
            const tileCanReview = checklistReviewVisible(user?.permissions, tileItem, files.length > 0);
            return (
              <div
                key={t.key}
                role="button"
                tabIndex={0}
                onClick={() => void openPlan(files, t.label)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openPlan(files, t.label); } }}
                style={{ border: "1px solid #d6d9d2", borderRadius: 11, overflow: "hidden", cursor: "pointer", background: "#fff", ...(t.full ? { gridColumn: "1 / -1" } : {}) }}
              >
                {latest && /^image\//.test(latest.content_type ?? "")
                  ? <R2Thumb r2Key={latest.r2_key} style={{ width: "100%", height: t.mediaH }} />
                  : <div className="ph" style={{ height: t.mediaH }} />}
                <div style={{ padding: "7px 9px" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#11140f" }}>{t.label}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                    <span className="rbadge" style={{ background: latest ? t.bg : "#f0f1ed", color: latest ? t.col : "#9aa093" }}>
                      {latest ? `${t.badge}${files.length > 1 ? ` · ${files.length}` : ""}` : "NONE"}
                    </span>
                    {tileItem && <ReviewBadge reviewStatus={tileItem.review_status} item={tileItem} hasFiles={files.length > 0} />}
                  </div>
                  {t.key === "Filled" && canWrite && filledPlanTaskId != null && (
                    <button
                      className="tinybtn"
                      style={{ marginTop: 6, width: "100%" }}
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); filledRef.current?.click(); }}
                    >
                      {files.length ? "+ Add / replace" : "Upload"}
                    </button>
                  )}
                  {tileCanReview && tileItem && (
                    <ReviewButtons item={tileItem} busy={busy} setBusy={setBusy} prompt={prompt} notify={notify} reload={reload} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <input ref={filledRef} type="file" accept="image/*,.pdf" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFilledPlan(f); }} />

        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093", margin: "10px 0 6px" }}>Stock transfer record</div>
        {stockOutAtts.length === 0 && <div style={{ fontSize: 12, color: "#9aa093", marginBottom: 8 }}>No stock transfer recorded yet.</div>}
        {stockOutAtts.length > 0 && (
          <div style={{ border: "1px solid #e3e6e0", borderRadius: 10, overflow: "hidden", marginBottom: 8 }}>
            {stockOutAtts.map((a, i) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", borderTop: i === 0 ? "none" : "1px solid #eceee9", flexWrap: "wrap" }}>
                {/* Owner 2026-07-31: show the record itself, not just its file
                    name — a tappable thumbnail opens the same viewer as View.
                    Non-images (PDFs) keep the hatched placeholder. */}
                <span
                  role="button"
                  onClick={() => setDocView({ r2_key: a.r2_key, content_type: a.mime_type ?? mimeFromKey(a.r2_key), caption: a.file_name ?? "Stock transfer record" })}
                  style={{ flex: "none", width: 54, height: 44, borderRadius: 7, overflow: "hidden", border: "1px solid #e3e6e0", cursor: "pointer", display: "block" }}
                >
                  {/^image\//.test(a.mime_type ?? mimeFromKey(a.r2_key) ?? "")
                    ? <R2Thumb r2Key={a.r2_key} style={{ width: 54, height: 44 }} />
                    : <span className="ph" style={{ display: "block", width: 54, height: 44 }} />}
                </span>
                <span className="rbadge" style={{ background: "#e2f0e9", color: "#2f8a5b" }}>OUT</span>
                <span style={{ flex: 1, minWidth: 80, fontSize: 11, color: "#414539" }}>
                  {[a.file_name || "Record", a.uploader_name || null, a.uploaded_at ? dm(a.uploaded_at) : null].filter(Boolean).join(" · ")}
                </span>
                <button
                  className="tinybtn"
                  onClick={() => setDocView({ r2_key: a.r2_key, content_type: a.mime_type ?? mimeFromKey(a.r2_key), caption: a.file_name ?? "Stock transfer record" })}
                >
                  View
                </button>
                {canStockEdit && (
                  <button
                    className="tinybtn"
                    disabled={busy}
                    aria-label={`Remove ${a.file_name || "record"}`}
                    style={{ color: "#a13a34" }}
                    onClick={async () => {
                      if (confirm && !(await confirm({ title: `Remove ${a.file_name || "this record"}?`, confirmLabel: "Remove", danger: true }))) return;
                      setBusy(true);
                      try {
                        await api.del(`/api/projects/checklist/attachments/${a.id}`);
                        reload();
                      } catch (e) {
                        await notify({ title: "Remove failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
                      } finally { setBusy(false); }
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {/* Stock Out Transfer Record review (owner 2026-07-29) — approve/reject
            for a stock_transfer.approve holder once a record is uploaded. */}
        {stockOutItem && (() => {
          const stockOutHasFiles = (checklistAttachments ?? []).some((a) => !a.archived_at && a.item_id === stockOutItem.id);
          // Owner 2026-07-31: the STATE is shown to every viewer (approved /
          // pending / not approved) — only the buttons stay approver-gated. An
          // empty record still renders nothing.
          if (!stockOutHasFiles && !stockOutItem.review_status) return null;
          return (
            <div style={{ marginBottom: 8 }}>
              <div style={{ marginBottom: 4 }}><ReviewBadge reviewStatus={stockOutItem.review_status} item={stockOutItem} hasFiles={stockOutHasFiles} /></div>
              {checklistReviewVisible(user?.permissions, stockOutItem, stockOutHasFiles) && (
                <ReviewButtons item={stockOutItem} busy={busy} setBusy={setBusy} prompt={prompt} notify={notify} reload={reload} />
              )}
            </div>
          );
        })()}
        {/* Purchaser stock-out upload (owner 2026-07-23) — attaches to the
            Stock Out Transfer Record checklist task, same store the tasklist
            row used, so desktop and mobile stay one file set. */}
        {canStockEdit && stockOutUploadTaskId != null && (
          <>
            <button className="tinybtn" style={{ width: "100%", marginBottom: 8 }} disabled={busy} onClick={() => stockRef.current?.click()}>
              + Upload stock out transfer record
            </button>
            <input
              ref={stockRef}
              type="file"
              accept="image/*,.pdf"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadStockOut(f); }}
            />
          </>
        )}
        {planView && (
          <MediaLightbox
            items={planView.items}
            index={planView.idx}
            onChange={(i) => setPlanView((pv) => (pv ? { ...pv, idx: i } : pv))}
            onClose={() => setPlanView(null)}
            baseUrl="/api/projects/attachments"
            badge="Floor plan"
          />
        )}
        {docView && (
          <MediaLightbox
            items={[docView]}
            index={0}
            onChange={() => {}}
            onClose={() => setDocView(null)}
            baseUrl="/api/projects/attachments"
            badge="Stock transfer"
          />
        )}
      </div>
    </details>
  );
}

// ── Finance snapshot ──
// Quick Total Sales — set project_finance.total_sales directly (mirror desktop
// saveQuickTotal, Projects.tsx:9937-9954). PATCH /:id/finance requires
// projects.write + finance visibility (denyFinance); the caller only mounts this
// inside the finance-gated snapshot for a writer. Saves on blur / Enter.
function QuickTotalSalesField({
  projectId, current, busy, setBusy, notify, reload,
}: {
  projectId: number;
  current: number | null;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  reload: () => void;
}) {
  const [val, setVal] = useState(current != null ? String(current) : "");
  useEffect(() => {
    setVal(current != null ? String(current) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const save = async () => {
    const trimmed = val.trim();
    if (trimmed === "") return; // leave unset rather than forcing 0
    const n = parseFloat(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      await notify({ title: "Invalid amount", body: "Enter a valid total sales amount.", tone: "error" });
      return;
    }
    if (current != null && Math.abs(n - current) < 0.005) return; // unchanged
    setBusy(true);
    try {
      await api.patch(`/api/projects/${projectId}/finance`, { total_sales: n });
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <label style={{ background: "#f4f6f3", borderRadius: 10, padding: 11, display: "block" }}>
      <span className="pkv-l">Total sales (RM)</span>
      <input
        className="fld-i money"
        type="number"
        inputMode="decimal"
        value={val}
        placeholder="—"
        disabled={busy}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        style={{ marginTop: 4, width: "100%", boxSizing: "border-box" }}
      />
    </label>
  );
}

// Quick Rental (RM) — writes a single `rental` cost line to the finance ledger
// (mirror desktop QuickRentalField, Projects.tsx:5323-5392): keying rental here
// syncs the Rental row, Total Cost, Net Profit + the Project List column.
// POST/PATCH/DELETE /projects/finance/lines require projects.write + finance
// visibility (denyFinance); the caller only mounts this inside the finance-gated
// snapshot for a writer. Saves on blur / Enter.
function QuickRentalField({
  projectId, lines, busy, setBusy, notify, reload,
}: {
  projectId: number;
  lines: FinanceLine[];
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  reload: () => void;
}) {
  const existing = lines.filter(
    (l) => (l.kind ?? "").toLowerCase() === "cost"
      && (l.category ?? "").trim() === "rental"
      && !pick(l.auto_source, l.autoSource),
  );
  const current = existing.reduce((s, l) => s + (l.amount || 0), 0);
  const [val, setVal] = useState(current ? String(current) : "");
  useEffect(() => {
    setVal(current ? String(current) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const save = async () => {
    const trimmed = val.trim();
    const n = trimmed === "" ? 0 : parseFloat(trimmed);
    if (isNaN(n) || n < 0) {
      await notify({ title: "Invalid amount", body: "Enter a valid rental amount.", tone: "error" });
      return;
    }
    if (Math.abs(n - current) < 0.005) return; // unchanged
    setBusy(true);
    try {
      if (n <= 0) {
        for (const l of existing) await api.del(`/api/projects/finance/lines/${l.id}`);
      } else if (existing.length === 1) {
        await api.patch(`/api/projects/finance/lines/${existing[0].id}`, { amount: n });
      } else {
        // 0 existing → create; >1 → consolidate the duplicates into one.
        for (const l of existing) await api.del(`/api/projects/finance/lines/${l.id}`);
        await api.post(`/api/projects/${projectId}/finance/lines`, {
          kind: "cost", category: "rental", amount: n, description: "Rental",
        });
      }
      reload();
    } catch (e) {
      await notify({ title: "Failed", body: e instanceof Error ? e.message : "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <label style={{ background: "#f4f6f3", borderRadius: 10, padding: 11, display: "block" }}>
      <span className="pkv-l">Rental (RM)</span>
      <input
        className="fld-i money"
        type="number"
        inputMode="decimal"
        value={val}
        placeholder="—"
        disabled={busy}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        style={{ marginTop: 4, width: "100%", boxSizing: "border-box" }}
      />
    </label>
  );
}

function FinancialSnapshot({
  projectId, finance, lines, canWrite, busy, setBusy, notify, reload,
}: {
  projectId: number;
  finance: NonNullable<ProjectDetail["finance"]>;
  lines?: FinanceLine[];
  canWrite: boolean;
  busy: boolean;
  setBusy: SetBusy;
  notify: NotifyFn;
  reload: () => void;
}) {
  // Receipts open in the lightbox — window.open(blobUrl) after an await is
  // popup-blocked on mobile browsers.
  const [receipt, setReceipt] = useState<MediaItem | null>(null);
  const openReceipt = (line: FinanceLine) => {
    const key = pick(line.r2_key, line.r2Key);
    if (!key) return;
    setReceipt({ r2_key: key, content_type: mimeFromKey(key), caption: pick(line.file_name, line.fileName) ?? "Receipt" });
  };

  const allLines = lines ?? [];
  const costLines = allLines.filter((l) => (l.kind ?? "").toLowerCase() === "cost");
  const sales = finance.total_sales ?? 0;
  const cost =
    (finance.rental ?? 0) +
    (finance.contractor_cost ?? 0) +
    (finance.license_fee ?? 0) +
    (finance.misc_cost ?? 0) -
    (finance.deposit_refund ?? 0);
  const net = sales - cost;
  const marginPct = sales > 0 ? (net / sales) * 100 : null;
  const netColor = net >= 0 ? "#2f8a5b" : "#b23a3a";

  return (
    <details className="pacc fin-only" open>
      <summary>
        {/* Title + the live net so the collapsed header still carries the
            headline number. The old "Owner / Director only" badge is gone
            (owner 2026-07-23): visibility is role-gated in code now
            (owner/BD/weisiang/finance edit, sales directors view), so the
            label was stale and read as noise to the people allowed in. */}
        <span className="psec-t" style={{ color: "#8a4b12" }}>P&amp;L (finance)</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: netColor, marginLeft: "auto" }}>Net {formatCurrency(net)}</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div style={{ background: "#f4f6f3", borderRadius: 10, padding: 11 }}>
            <div className="pkv-l">Total sales</div>
            <div className="money" style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 3 }}>{formatCurrency(sales)}</div>
          </div>
          <div style={{ background: "#f4f6f3", borderRadius: 10, padding: 11 }}>
            <div className="pkv-l">Total cost</div>
            <div className="money" style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 3 }}>{formatCurrency(cost)}</div>
          </div>
          <div style={{ background: "#f4f6f3", borderRadius: 10, padding: 11 }}>
            <div className="pkv-l">Net profit</div>
            <div className="money" style={{ fontSize: 16, fontWeight: 800, color: netColor, marginTop: 3 }}>{formatCurrency(net)}</div>
          </div>
          <div style={{ background: "#f4f6f3", borderRadius: 10, padding: 11 }}>
            <div className="pkv-l">Margin</div>
            <div className="money" style={{ fontSize: 16, fontWeight: 800, color: netColor, marginTop: 3 }}>{marginPct == null ? "—" : `${marginPct.toFixed(1)}%`}</div>
          </div>
        </div>
        {/* Quick edit (finance write) — Total Sales PATCHes
            project_finance.total_sales (mirror desktop saveQuickTotal:9937-9954);
            Rental writes a `rental` cost line (mirror desktop
            QuickRentalField:5323-5392). Both endpoints require projects.write +
            finance visibility, which financeVisible + canWrite already satisfy,
            so the control never 403s. */}
        {canWrite && (
          <>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093", margin: "12px 0 6px" }}>Quick edit</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <QuickTotalSalesField projectId={projectId} current={finance.total_sales ?? null} busy={busy} setBusy={setBusy} notify={notify} reload={reload} />
              <QuickRentalField projectId={projectId} lines={allLines} busy={busy} setBusy={setBusy} notify={notify} reload={reload} />
            </div>
          </>
        )}

        {/* Cost ledger — read-only snapshot. A stored receipt opens in the lightbox. */}
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#9aa093", margin: "12px 0 6px" }}>Cost lines</div>
        {costLines.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9aa093" }}>No cost lines yet.</div>
        ) : (
          <div style={{ border: "1px solid #eceee9", borderRadius: 10, overflow: "hidden" }}>
            {costLines.map((line, i) => {
              const auto = !!pick(line.auto_source, line.autoSource);
              const receiptKey = pick(line.r2_key, line.r2Key);
              return (
                <div key={line.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderTop: i === 0 ? "none" : "1px solid #eceee9", flexWrap: "wrap" }}>
                  <span style={{ flex: 1, minWidth: 90, fontSize: 12, color: "#414539" }}>
                    {line.description || ledgerCategoryLabel(line.category)}
                    {auto && <span style={{ marginLeft: 5, fontSize: 9, color: "#9aa093" }}>auto</span>}
                  </span>
                  <span className="money" style={{ fontSize: 12, fontWeight: 700 }}>{formatCurrency(line.amount)}</span>
                  {receiptKey && <button className="tinybtn" disabled={busy} onClick={() => openReceipt(line)}>Receipt</button>}
                </div>
              );
            })}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 12px", borderTop: "1px solid #eceee9", fontSize: 12, fontWeight: 700, color: "#11140f", background: "#f4f6f3" }}>
              <span>Net profit{marginPct != null ? ` (${marginPct.toFixed(1)}%)` : ""}</span>
              <span className="money" style={{ color: netColor }}>{formatCurrency(net)}</span>
            </div>
          </div>
        )}
        {receipt && (
          <MediaLightbox
            items={[receipt]}
            index={0}
            onChange={() => {}}
            onClose={() => setReceipt(null)}
            baseUrl="/api/projects/attachments"
            badge="Receipt"
          />
        )}
      </div>
    </details>
  );
}

// R2-backed thumbnail. <img src> can't carry the bearer, so fetch as a blob
// URL (api.fetchBlobUrl) and revoke on unmount. r2Key is streamed from the
// project attachments endpoint (/api/projects/attachments/:key).
function R2Thumb({ r2Key, style }: { r2Key: string; style?: React.CSSProperties }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    api.fetchBlobUrl(`/api/projects/attachments/${r2Key}`)
      .then((u) => { if (live) { made = u; setUrl(u); } else URL.revokeObjectURL(u); })
      .catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [r2Key]);
  if (!url) return <div className="ph" style={style} />;
  return <img src={url} alt="" style={{ ...style, objectFit: "cover", display: "block" }} />;
}

// ── Small building blocks ──
// List meta pill (spec project-list: branding / venue chips under the title).
function ListChip({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: "#5c6156", background: "#f0f1ed", border: "1px solid var(--line)", padding: "3px 8px", borderRadius: 7 }}>
      {children}
    </span>
  );
}

// Stage badge — shows the REAL backend stage (STAGE_LABEL[stage]) with a
// colour matching the desktop stageVariant, mapped onto the mobile badge
// palette (STAGE_TINT). draft=neutral/grey · setup=open/amber ·
// live+dismantle=in-progress/green · completed+closed=closed/grey ·
// cancelled=error/clay-red. Owner 2026-07-21: ONE standard badge everywhere
// (auto width, .spill padding, stage tint) — the detail header's bespoke gold
// "dark" variant is gone; the solid tinted pill is legible on the dark header.
// `lower` = the detail-header instance, which the owner's 2026-07-22 mockup
// shows lowercase ("setup"); same tint + shape, only the casing differs.
function StageBadge({ stage, lower }: { stage: string | null | undefined; lower?: boolean }) {
  const tint = STAGE_TINT[stageVariant(stage)];
  const label = stageLabel(stage);
  return (
    <span
      className="spill"
      style={{ flex: "none", background: tint.bg, color: tint.fg, border: "none", ...(lower ? { textTransform: "none" as const } : null) }}
    >
      {lower ? label.toLowerCase() : label}
    </span>
  );
}

// Owner's 2026-07-22 header mockup shows "Penang [Zanotti] MLE @ Pisa Spice
// Arena Convention Centre", not the ALL-CAPS string the DB stores — a
// display-only transform. Tokens whose letters run ≤3 chars stay verbatim
// (MLE, SD, C&C — the acronyms the mockup keeps uppercase); longer tokens are
// title-cased at their first letter so wrappers survive ([ZANOTTI] →
// [Zanotti], PISA → Pisa).
function titleCaseName(name: string): string {
  return name
    .split(" ")
    .map((word) => {
      const letters = word.replace(/[^A-Za-z]/g, "");
      if (letters.length <= 3) return word;
      const lower = word.toLowerCase();
      const i = lower.search(/[a-z]/);
      return i === -1 ? word : lower.slice(0, i) + lower[i].toUpperCase() + lower.slice(i + 1);
    })
    .join(" ");
}

// Section-driven stage badge — the project's CURRENT active section
// (active_section_name + done/total, mig 050), matching the desktop Projects
// table's stage column, which retired the coarse legacy `stage` enum. Reuses the
// StageBadge .spill shape; the active stage takes the "open" tint (in progress).
// Falls back to the legacy StageBadge when the row has no open section (all done
// or none defined) so the pill is never blank.
function SectionStageBadge({ row }: { row: ProjectListRow }) {
  const active = row.active_section_name?.trim() || null;
  if (!active) return <StageBadge stage={row.stage} />;
  const total = row.sections_total ?? 0;
  const done = row.sections_complete ?? 0;
  const tint = STAGE_TINT.open;
  return (
    <span
      className="spill"
      style={{ flex: "none", background: tint.bg, color: tint.fg, border: "none" }}
      title={total > 0 ? `Current stage · ${done}/${total} sections complete` : "Current stage"}
    >
      {active}
      {total > 0 ? <span style={{ opacity: 0.6 }}> {done}/{total}</span> : null}
    </span>
  );
}

// Thin inline progress rail + % for the list card footer — mirrors the desktop
// Projects ProgressBar (green at 100%, brand otherwise) using the mobile tokens
// and the same 4px-radius rail treatment as the Delivery header bar. Sized to
// sit inline on the meta row, never a tall block.
function MiniProgress({ pct }: { pct: number }) {
  const c = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
      <span style={{ display: "block", width: 44, height: 5, borderRadius: 4, background: "var(--line)", overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${c}%`, background: c >= 100 ? "var(--green)" : "var(--brand)", borderRadius: 4 }} />
      </span>
      <span className="tnum" style={{ fontSize: 11, fontWeight: 700, color: "var(--brand-d)" }}>{c}%</span>
    </span>
  );
}

function humanize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
