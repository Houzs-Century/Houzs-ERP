import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, formatDateTime } from "../lib/utils";
import { createPortal } from "react-dom";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatPhone } from "../vendor/shared/phone";
import { uploadAssrAttachment } from "../lib/assrAttachmentUpload";
import { UploadDropZone, clipboardFiles, useStrayFileDropGuard } from "../lib/uploadDropZone";
import { loadThumbFirst } from "../lib/imagePipeline";
import { useAuth } from "../auth/AuthContext";
import { isSalesStaff } from "../auth/salesAccess";
import { capability } from "../auth/capabilities";
import { MobileVirtualList } from "./MobileVirtualList";
import { SearchProgress } from "../components/SearchProgress";
import { SearchScopeHint } from "../components/SearchScopeHint";
import { useSearchResultTransition } from "../hooks/useServerSearch";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useChoice } from "../vendor/scm/components/ChoiceDialog";
import { todayMyt } from "../vendor/scm/lib/dates";
import { DateField } from "../vendor/scm/components/DateField";
import {
  ASSR_STAGES,
  ASSR_STAGE_INDEX,
  activeAssrStages,
  type AssrStageDef,
  assrSubStatus,
  ASSR_SUB_STATUSES,
} from "../vendor/scm/lib/assr/stages";
import "./mobile.css";

// The core /api/assr route (NOT scm). The list returns
// { data, page, per_page, total } with assr_cases.* columns; the detail
// returns { case, items, attachments, activity, logistics, related_pos,
// stage_history, portal_token }.
//
// The Postgres driver camelCases every result column, so the same field
// can arrive as camelCase or snake_case depending on the path — we always
// dual-read `r.camelCase ?? r.snake_case` and never crash on a missing one.
//
// 2026-07-14 redesign (service-case-mobile handoff): the list is "Status
// Cards" (priority stripe + SLA pill + mini 8-step progress) and the
// detail is TABBED — Overview / Stage / Info / Timeline. "Stage" shows
// the 8-stage workflow grouped into Intake / Repair / Return phases;
// tapping a stage chip jumps to Info with that stage's accordion open.
// Inspection is no longer a stage (mig 0105): Inspect by + the QC-issue
// fields live inside Under Verification.

type Any = Record<string, any>;

// ── Theme C colour tokens (design SC_T) ───────────────────────────
const INK = "#11140f";
const INK_SEC = "#3f463a";
const MUTED = "#767b6e";
const TEAL = "#16695f";
const TEAL_DK = "#0c3f39";
const BROWN = "#a16a2e";
const BROWN_SOFT = "#f6efd9";
const BROWN_FG = "#8a6a2e";
const GREEN = "#2f8a5b";
const OK_BG = "#e2f0e9";
const WARN = "#B76B00";
const WARN_BG = "rgba(183,107,0,0.12)";
const RED = "#b23a3a";
const ERR_BG = "rgba(178,58,58,0.08)";
const GREY = "#9aa093";
const BLUE = "#1F3A8A";
const LINE = "#d6d9d2";
const LINE_SOFT = "rgba(34,31,32,0.10)";
const DIM = "#e3e6e0";
const FIELD_BG = "#f4f6f3";

// Ordered stage pipeline + the resolution-routing rule now live in the SHARED
// vendor/scm/lib/assr/stages module so desktop + mobile can't drift on them
// (previously mobile ignored the internal-resolution skip and mis-routed cases
// into the two supplier-only stages). `MStage` is the mobile view-model shape;
// `label` is the chip-short form the mobile UI reads. `toMStage` adapts a
// canonical AssrStageDef (which uses `short`) to it.
type MStage = { key: string; label: string; long: string; owner: string };
const toMStage = (s: AssrStageDef): MStage => ({ key: s.key, label: s.short, long: s.long, owner: s.owner });
const STAGES: MStage[] = ASSR_STAGES.map(toMStage);
const STAGE_INDEX: Record<string, number> = ASSR_STAGE_INDEX;
// Active (resolution-filtered) canonical stages for a case, in the mobile
// view-model shape. Internal resolution → Supplier Pickup + Item Ready drop.
const activeMStages = (method: string | null | undefined, currentStage: string): MStage[] =>
  activeAssrStages(method, currentStage).map(toMStage);
// Stage-tab grouping (design StagePhases): Intake / Repair / Return — keyed by
// stage so it survives the resolution filter (a phase whose stages all drop is
// simply not rendered for that case).
const PHASE_DEFS: { name: string; keys: string[] }[] = [
  { name: "Intake", keys: ["pending_review", "pending_solution", "under_verification"] },
  { name: "Repair", keys: ["pending_supplier_pickup", "pending_item_ready"] },
  { name: "Return", keys: ["pending_delivery_service", "completed"] },
];

// ── Enum option lists (mirrors desktop ServiceCases.tsx) ──────────
// PATCH /:id accepts these column values; the mobile edit controls write
// the same field names + values the desktop InlineEdit controls do.
const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"] as const;
const ISSUE_CATEGORY_OPTIONS = [
  "Product defect",
  "Incorrect item delivered",
  "Missing / short item",
  "Warranty / service request",
  "Installation / assembly issue",
] as const;
const RESOLUTION_OPTIONS = [
  "replace_unit",
  "supplier_repair",
  "field_service_own",
  "field_service_supplier",
  "return_visit",
] as const;
// Under-Verification outcome (mig 081 verification_outcome column).
const VERIFICATION_OPTIONS = [
  { value: "accepted", label: "Accepted" },
  { value: "needs_more_info", label: "Needs more info" },
  { value: "rejected", label: "Rejected" },
] as const;
// QC result values shared by qc_issue_result (on receipt, mig 0105) and
// inspection_result (after repair, v3.1).
const QC_RESULT_OPTIONS = [
  { value: "pass", label: "Pass" },
  { value: "fail", label: "Fail" },
  { value: "na", label: "N/A" },
] as const;
// Timeline note audience buckets (mig 0108) — the /:id/notes endpoint
// accepts these four; "system" is reserved for auto events and rejected
// server-side. Only "customer" is visible outside the team (portal).
const NOTE_AUDIENCE_OPTIONS = [
  { value: "service", label: "Service" },
  { value: "customer", label: "Customer" },
  { value: "supplier", label: "Supplier" },
  { value: "sales", label: "Sales" },
] as const;
type NoteAudience = (typeof NOTE_AUDIENCE_OPTIONS)[number]["value"];
// Print copy variants — desktop opens /api/assr-print/:id?variant=…
const PRINT_VARIANTS = [
  { value: "customer", label: "Customer copy" },
  { value: "supplier", label: "Supplier copy" },
  { value: "office", label: "Office copy" },
] as const;
// Upload constraints mirror the PUT /:id/attachments backend guard.
const ATTACH_EXTS = new Set(["jpg", "jpeg", "png", "webp", "mp4", "mov", "webm", "pdf"]);
const ATTACH_ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,application/pdf";

// Priority meta — design SC_PRIORITY (Theme C hues).
const PRIORITY_META: Record<string, { label: string; color: string }> = {
  low: { label: "Low", color: GREY },
  normal: { label: "Normal", color: TEAL },
  high: { label: "High", color: WARN },
  urgent: { label: "Urgent", color: "#B71C1C" },
};

// ── field readers (dual-read camelCase / snake_case) ──────────────
const get = (r: Any, ...keys: string[]) => {
  for (const k of keys) {
    const v = r?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
const caseNo = (r: Any) => get(r, "assrNo", "assr_no", "docNo", "doc_no") ?? "—";
const customer = (r: Any) => get(r, "customerName", "customer_name") ?? "—";
const stageOf = (r: Any) => String(get(r, "stage") ?? "");
const priorityOf = (r: Any) => String(get(r, "priority") ?? "normal").toLowerCase();
const statusOf = (r: Any) => String(get(r, "status") ?? "");
const issueOf = (r: Any) => get(r, "complaintIssue", "complaint_issue");
const hoursToDeadline = (r: Any): number | null => {
  const v = get(r, "hoursToDeadline", "hours_to_deadline");
  return v == null ? null : Number(v);
};

// SLA state for the list pills / detail banner (design SC_slaState).
type SlaTone = "breach" | "risk" | "ok" | "done";
const SLA_TONE: Record<SlaTone, { fg: string; bg: string }> = {
  breach: { fg: RED, bg: "#f8eaea" },
  risk: { fg: WARN, bg: WARN_BG },
  ok: { fg: GREEN, bg: OK_BG },
  done: { fg: GREY, bg: FIELD_BG },
};
const slaStateOf = (r: Any): { tone: SlaTone; label: string } => {
  if (stageOf(r) === "completed") return { tone: "done", label: "Closed" };
  const h = hoursToDeadline(r);
  if (h == null || !isFinite(h)) return { tone: "ok", label: "No SLA" };
  if (h < 0) {
    const days = Math.floor(-h / 24);
    return { tone: "breach", label: days >= 1 ? `${days}d overdue` : `${Math.abs(Math.round(h))}h overdue` };
  }
  if (h < 24) return { tone: "risk", label: `Due in ${Math.round(h)}h` };
  return { tone: "ok", label: `Due in ${Math.floor(h / 24)}d` };
};

// Dwell / staleness tier for the list card — desktop ServiceCases "Priority ·
// Dwell" parity (thresholds/colours at ServiceCases.tsx:666-672): On track <7d
// (green), Slow 7-29d (amber), Stuck >=30d (red, heavier). Skipped when the case
// is completed / cancelled or days_in_stage is absent, so a closed row carries no
// staleness marker. days_in_stage is computed by the shared /api/assr query and
// can arrive camel- or snake-cased, so we dual-read.
type DwellTier = { label: string; days: number; color: string; stuck: boolean };
const dwellOf = (r: Any): DwellTier | null => {
  if (stageOf(r) === "completed") return null;
  if (statusOf(r).toLowerCase() === "cancelled") return null;
  const v = get(r, "daysInStage", "days_in_stage");
  if (v == null) return null;
  const d = Number(v);
  if (!isFinite(d)) return null;
  if (d < 7) return { label: "On track", days: d, color: GREEN, stuck: false };
  if (d < 30) return { label: "Slow", days: d, color: WARN, stuck: false };
  return { label: "Stuck", days: d, color: RED, stuck: true };
};

// ── Lookup option hooks (mirror desktop) ──────────────────────────
// The assr pickers live behind /api/assr/lookups/:kind, which returns
// { data: [{ id, slug, name, sort_order, active }] }. Desktop reads
// issue-categories by `name` and resolution-methods / priorities by
// `slug`. We do the same, falling back to the hardcoded constant until
// the (cheap, cached) call returns so the form stays usable.
type LookupOpt = { slug: string; name: string };
function useLookupRows(kind: string): LookupOpt[] {
  const { data } = useQuery({
    queryKey: ["mobile-assr-lookup", kind],
    queryFn: () => api.get<{ data?: LookupOpt[] }>(`/api/assr/lookups/${kind}`),
    staleTime: 5 * 60_000,
  });
  return data?.data ?? [];
}
function useLookupNames(kind: string, fallback: readonly string[]): string[] {
  const rows = useLookupRows(kind);
  return rows.length ? rows.map((r) => r.name) : [...fallback];
}
function useLookupSlugs(kind: string, fallback: readonly string[]): string[] {
  const rows = useLookupRows(kind);
  return rows.length ? rows.map((r) => r.slug) : [...fallback];
}

// Assignable users for the PIC picker — mirrors desktop DetailContent, which
// pulls /api/users (shape { users } | { data } | array) and narrows the picker
// to Operations-department members (plus whoever is currently assigned so an
// out-of-Operations assignment never silently vanishes from the list).
type PicUser = { id: number; name: string; department_name?: string };
function useAssignableUsers(): PicUser[] {
  const { data } = useQuery({
    queryKey: ["mobile-assr-users"],
    queryFn: () =>
      api
        .get<any>("/api/users")
        .then((r: any) => (r?.users ?? r?.data ?? r ?? []) as PicUser[]),
    staleTime: 5 * 60_000,
  });
  return Array.isArray(data) ? data : [];
}

// SO typeahead — mirrors desktop CreatePanel: GET /api/assr/search-so?q=…
// returns { results: [{ doc_no, ref, debtor_name, phone, doc_date,
// sales_agent }] } (min 2 chars server-side). Debounced client-side.
type SoHit = Any;
function useSoSearch(q: string): { results: SoHit[]; loading: boolean } {
  const needle = q.trim();
  const { data, isFetching } = useQuery({
    queryKey: ["mobile-assr-so-search", needle],
    enabled: needle.length >= 2,
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      api.get<{ results?: SoHit[] }>(`/api/assr/search-so?q=${encodeURIComponent(needle)}`, { signal }),
  });
  return { results: data?.results ?? [], loading: isFetching };
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// Human labels for the resolution_method slugs (mirrors desktop).
const RESOLUTION_LABELS: Record<string, string> = {
  replace_unit: "Replace Unit",
  supplier_repair: "Supplier Service",
  field_service_own: "On Site Service (Own Team)",
  field_service_supplier: "On Site Service (Supplier)",
  return_visit: "2nd Services",
};
const resolutionLabel = (v: string) => RESOLUTION_LABELS[v] ?? cap(v.replace(/_/g, " "));
const prettyStage = (stage: string) => {
  if (stage === "voided") return "Voided — Not Valid";
  const idx = STAGE_INDEX[stage];
  return idx != null ? STAGES[idx].long : cap(stage.replace(/_/g, " ")) || "—";
};
// Numeric DD/MM/YYYY (+ HH:mm) via the shared formatter — house rule, and it
// UTC-tags bare SQLite timestamps so they don't shift by the device timezone.
const dm = (d: string | null | undefined) => formatDate(d);
const dtm = (d: string | null | undefined) => formatDateTime(d);
// Human overdue / due-in from hours-to-deadline (drives the SLA banner).
const slaText = (h: number | null): { label: string; overdue: boolean } | null => {
  if (h == null || !isFinite(h)) return null;
  if (h < 0) {
    const days = Math.floor(-h / 24);
    return { label: days >= 1 ? `${days} days overdue` : `Overdue ${Math.abs(Math.round(h))}h`, overdue: true };
  }
  const days = Math.floor(h / 24);
  return { label: days >= 1 ? `Due in ${days} days` : `Due in ${Math.round(h)}h`, overdue: false };
};

/** Mobile Service Case (ASSR) — Status Cards list + tabbed detail
 *  (Overview / Stage / Info / Timeline) + new-case sheet, all wired to
 *  the core /api/assr backend. */
export function MobileServiceCase({ onBack, startNew = false }: { onBack?: () => void; startNew?: boolean }) {
  const [openId, setOpenId] = useState<number | null>(null);
  // `startNew` (from the Orders FAB "+ New Service Case") opens the create sheet
  // straight away.
  const [showNew, setShowNew] = useState(startNew);

  if (openId != null) {
    return <CaseDetail id={openId} onBack={() => setOpenId(null)} />;
  }
  return (
    <>
      <CaseList onBack={onBack} onOpen={setOpenId} onNew={() => setShowNew(true)} />
      {showNew && <NewCaseSheet onClose={() => setShowNew(false)} onOpen={setOpenId} />}
    </>
  );
}

// Sort menu (owner 2026-07-23: default = Case newest-first, everything else
// is auxiliary; Stuck/Updated/Priority/Customer added same day, all four
// picked). Every `by` is a key of the backend ASSR_SORT_MAP whitelist —
// unknown keys are silently ignored server-side (falls back to id DESC), so
// keep the two lists in sync. Priority relies on the map's CASE expression
// for semantic order (urgent→low when asc), not the raw text column.
const SORT_MENU = [
  { key: "no", label: "Newest", by: "assr_no", dir: "desc" },
  { key: "old", label: "Oldest", by: "assr_no", dir: "asc" },
  { key: "sla", label: "SLA", by: "hours_to_deadline", dir: "asc" },
  { key: "stuck", label: "Stuck", by: "days_in_stage", dir: "desc" },
  { key: "updated", label: "Updated", by: "updated_at", dir: "desc" },
  { key: "priority", label: "Priority", by: "priority", dir: "asc" },
  { key: "customer", label: "Customer", by: "customer_name", dir: "asc" },
] as const;
type SortKey = (typeof SORT_MENU)[number]["key"];

// ── LIST — "Status Cards" (design ListA) ──────────────────────────
function CaseList({
  onBack,
  onOpen,
  onNew,
}: {
  onBack?: () => void;
  onOpen: (id: number) => void;
  onNew: () => void;
}) {
  const { user, can } = useAuth();
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("all");
  const [sort, setSort] = useState<SortKey>("no");
  /* Debounced search term — the value keyed into (and sent to) the server so a
     keystroke doesn't fire a request per character. Mirrors MobileSalesOrders. */
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  /* The THREE terms `requireServiceCaseAccess` admits on, read from the server's
     answer set rather than re-derived here. Backend gate
     (`routes/assr.ts:66-74`): the flat permission OR `isSalesUser` OR
     `isDirectorUser`. This site carried only the first two, so a DIRECTOR with no
     `service_cases.read` grant and no Sales department — a Finance Manager, a
     Super Admin — got `enabled: false` and an empty mobile list over an API that
     would have returned every case (`assrUnrestricted`, `routes/assr.ts:139-146`).
     Desktop never had the hole: the board's nav entry carries `showForDirector`
     (`Sidebar.tsx:263-268`) and the route's `<PageGuard allowSales>` reads
     `org.sales.staff` off the same capability set (`PageGuard.tsx:70`).

     `org.sales.staff` / `org.director` ARE the backend gates (capabilities.ts
     names `pmsAccess.isSalesUser` / `isDirectorUser`), so no director check is
     hand-written on this side and the two cannot drift. Both fail CLOSED when
     /auth/me carried no capability set. Gate the /api/assr read so it never fires
     a 403 for a user without access (OFF, not hide) — defence-in-depth on top of
     the shell's tab gating. Applied to the infinite query's `enabled` below. */
  const canViewCases =
    can("service_cases.read") ||
    capability(user, "org.sales.staff") ||
    capability(user, "org.director");

  const isMine = (r: Any) => {
    const uid = user?.id;
    if (!uid) return false;
    return Number(get(r, "assignedTo", "assigned_to") ?? 0) === uid
      || Number(get(r, "assignedTo2", "assigned_to_2") ?? 0) === uid;
  };

  // Role-aware chip row (owner 2026-07-23: "不同user show不同的chips") —
  // three cuts derived from the SAME capability signals that gate the list
  // (canViewCases below), so visibility and chip set can't drift apart:
  //   · ops/service (service_cases.read) get the desktop-equivalent FULL
  //     stage cut (owner: "operation 的话…跟 desktop 一样有 full staging 的")
  //     — one chip per pipeline stage, plus All and Archived;
  //   · sales (org.sales.staff) follow their own cases → Mine/Open/Completed,
  //     no queue noise;
  //   · directors/others get the overview cut with Archived.
  // Every chip filters SERVER-SIDE (cross-page correct): stage chips →
  // stage=<key>; open → exclude_stage=completed; completed → stage=completed;
  // mine → assigned_to (matches assigned_to OR assigned_to_2, like isMine);
  // archived → archived_only=1, a separate list rather than archived rows
  // interleaved with live work (desktop #1023 parity — its match is a no-op
  // because the server already returns only archived rows).
  type ChipDef = { key: string; label: string; match: (r: Any) => boolean; params?: Record<string, string> };
  const CHIP_DEFS: Record<string, ChipDef> = {
    all: { key: "all", label: "All", match: () => true },
    open: { key: "open", label: "Open", match: (r) => stageOf(r) !== "completed", params: { exclude_stage: "completed" } },
    completed: { key: "completed", label: "Completed", match: (r) => stageOf(r) === "completed", params: { stage: "completed" } },
    mine: { key: "mine", label: "Mine", match: isMine, params: { ...(user?.id ? { assigned_to: String(user.id) } : {}) } },
    archived: { key: "archived", label: "Archived", match: () => true, params: { archived_only: "1" } },
  };
  const stageChips: ChipDef[] = STAGES.map((s) => ({
    key: `stage:${s.key}`,
    label: s.label,
    match: (r) => stageOf(r) === s.key,
    params: { stage: s.key },
  }));
  const CHIPS: ChipDef[] = can("service_cases.read")
    ? [CHIP_DEFS.all, ...stageChips, CHIP_DEFS.archived]
    : capability(user, "org.sales.staff")
      ? [CHIP_DEFS.all, CHIP_DEFS.mine, CHIP_DEFS.open, CHIP_DEFS.completed]
      : [CHIP_DEFS.all, CHIP_DEFS.open, CHIP_DEFS.completed, CHIP_DEFS.archived];

  /* Server-side search + sort + Mine + infinite scroll. `search` covers
     case no / SO doc / Ref / customer server-side (cross-page); the sort
     selector maps to the endpoint's sort_by via SORT_MENU (newest case
     first is the default). Changing search / sort /
     Mine swaps the query key so the list restarts from page 1. per_page 30;
     default id-desc tiebreak → no skipped/dup rows.
     NOTE: the server `search` does NOT cover the complaint issue text or the
     item code/description that the old client search also matched — those two
     fields are no longer searchable (cross-page correctness is the trade). */
  const activeChip = CHIPS.find((c) => c.key === chip) ?? CHIPS[0];
  const buildParams = (page: number): string => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("per_page", "30");
    if (debouncedQ) p.set("search", debouncedQ);
    const s = SORT_MENU.find((o) => o.key === sort) ?? SORT_MENU[0];
    p.set("sort_by", s.by);
    p.set("sort_dir", s.dir);
    // The active chip's server-side filter (archived_only NOT
    // include_archived, which would interleave — the pre-#1023 bug).
    for (const [k, v] of Object.entries(activeChip.params ?? {})) p.set(k, v);
    return p.toString();
  };
  type AssrListPage = { data?: Any[]; total?: number; page?: number; per_page?: number };
  const {
    data, isLoading, isFetching, isPlaceholderData, error,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["mobile-assr-list-paged", debouncedQ, sort, activeChip.key, user?.id],
    queryFn: ({ pageParam, signal }) => api.get<AssrListPage>(`/api/assr?${buildParams(pageParam)}`, { signal }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + (p.data?.length ?? 0), 0);
      return loaded < (last.total ?? 0) ? pages.length + 1 : undefined;
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    enabled: canViewCases,
  });
  const all = useMemo(() => data?.pages.flatMap((p) => p.data ?? []) ?? [], [data]);

  /* Chip count badges — computed over the rows LOADED SO FAR (they grow as the
     operator scrolls); the "All" total from the server envelope is shown in the
     header note instead. Honest: with server pagination the full set isn't in
     memory, so these badges reflect loaded rows, not the whole table. */
  const totalCount = data?.pages[0]?.total ?? 0;
  const searchTransition = useSearchResultTransition({
    inputTerm: q,
    requestTerm: debouncedQ,
    isFetching,
    isPlaceholderData,
    hasData: data !== undefined,
    hasError: Boolean(error),
  });
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const ch of CHIPS) c[ch.key] = all.filter(ch.match).length;
    return c;
  }, [all, user?.id]);

  /* Rows = accumulated pages, with the active chip's client-side predicate
     applied. Search + sort + Mine already ran server-side; re-applying the
     Mine predicate is a harmless no-op, while risk / urgent do their real
     (loaded-rows) filtering here. */
  const rows = useMemo(() => {
    const active = CHIPS.find((c) => c.key === chip) ?? CHIPS[0];
    return all.filter((r) => active.match(r));
  }, [all, chip, user?.id]);
  const visibleRows = searchTransition.resultsAreStale ? [] : rows;

  /* Infinite-scroll trigger — IntersectionObserver on a 1px sentinel at the
     list's bottom; fetches the next page as it nears the viewport (rootMargin
     600px). Guarded by hasNextPage && !isFetchingNextPage. */
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
      {/* header (.hdr) — eyebrow + title + new-case iconbtn */}
      <header className="hdr">
        <div className="hdr-row">
          <div>
            {onBack ? (
              <button className="back" onClick={onBack} style={{ marginBottom: 4 }}>
                <span className="chev">‹</span> Menu
              </button>
            ) : null}
            <div className="eyebrow">After-sales</div>
            <div className="scr-title">Service Cases</div>
          </div>
          <button onClick={onNew} className="iconbtn" aria-label="New service case">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={TEAL} strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
        <div className="hdr-row" style={{ marginTop: 11 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={GREY} strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search case · SO · Ref · customer · phone" />
          </div>
          <SearchProgress active={searchTransition.isSearching} label="Searching…" />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={{ flex: "none", fontFamily: "inherit", fontSize: 12, color: "var(--mut)", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "0 8px", height: 38, appearance: "none", WebkitAppearance: "none" }}>
            {SORT_MENU.map((o) => (
              <option key={o.key} value={o.key}>Sort: {o.label}</option>
            ))}
          </select>
        </div>
        <SearchScopeHint scope="server" searching={searchTransition.isSearching} countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale} resultCount={totalCount} term={q} className="mt-1 px-1" />
        {/* status chips — petrol active pill with count badge (design SegChips).
            Ops' full stage cut renders as TWO rows (owner 2026-07-23:
            "Operation view的 chips 要做成2 row") — deterministic halves so the
            pipeline still reads left-to-right within each row; both rows share
            one horizontal scroll. Short cuts (sales/director) stay one line. */}
        <div className="hz-scroll" style={{ overflowX: "auto", marginTop: 11, paddingBottom: 2 }}>
          {(CHIPS.length > 6
            ? [CHIPS.slice(0, Math.ceil(CHIPS.length / 2)), CHIPS.slice(Math.ceil(CHIPS.length / 2))]
            : [CHIPS]
          ).map((rowChips, ri) => (
          <div key={ri} style={{ display: "flex", gap: 8, width: "max-content", marginTop: ri ? 8 : 0 }}>
          {rowChips.map((c) => {
            const on = chip === c.key;
            // Active chip → the envelope total (true cross-page count for the
            // server-filtered list). Inactive → loaded-rows estimate, except
            // All and Archived: All's "estimate" would just echo whatever list
            // is currently loaded, and Archived's rows aren't in the active
            // dataset at all — both hide their badge until selected.
            const badge = on ? totalCount : c.key === "archived" || c.key === "all" ? null : counts[c.key] ?? 0;
            return (
              <button
                key={c.key}
                onClick={() => setChip(c.key)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, flex: "none",
                  padding: "7px 13px", borderRadius: 999, cursor: "pointer",
                  border: `1px solid ${on ? TEAL : LINE_SOFT}`,
                  background: on ? TEAL : "#fff", color: on ? "#fff" : INK_SEC,
                  fontSize: 12.5, fontWeight: 600, fontFamily: "inherit",
                }}
              >
                {c.label}
                {badge != null && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "0 6px", borderRadius: 999, background: on ? "rgba(255,255,255,0.22)" : FIELD_BG, color: on ? "#fff" : MUTED }}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
          </div>
          ))}
        </div>
      </header>

      <div ref={scrollRef} className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {isLoading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load service cases. Pull to retry.</div>}
        {!isLoading && !error && (
          <>
            {/* Count note — every chip filters server-side now, so the
                envelope total is the true cross-page count for all of them. */}
            {!searchTransition.resultsAreStale && (
              <div style={{ fontSize: 11, color: MUTED, margin: "0 2px 10px" }}>
                {`${totalCount} case${totalCount === 1 ? "" : "s"}`}
              </div>
            )}
            {visibleRows.length > 0 && (
              <MobileVirtualList
                items={visibleRows}
                getKey={(r) => Number(get(r, "id"))}
                estimateHeight={132}
                renderItem={(r) => {
              const id = Number(get(r, "id"));
              const cancelled = statusOf(r).toLowerCase() === "cancelled";
              const pr = PRIORITY_META[priorityOf(r)] ?? PRIORITY_META.normal;
              const sla = slaStateOf(r);
              const tone = SLA_TONE[sla.tone];
              const item = get(r, "itemDescription", "item_description", "itemCode", "item_code");
              // Resolution-filtered pipeline for THIS row so an internal case
              // shows N/5 (not N/7) and skips the supplier-only bars.
              const rowStages = activeMStages(get(r, "resolutionMethod", "resolution_method"), stageOf(r));
              const idx = rowStages.findIndex((s) => s.key === stageOf(r));
              const dwell = dwellOf(r);
              // Auto-escalated marker (desktop ServiceCases.tsx:577-590) — shown
              // only while the case is open (sla.tone "done" === completed).
              const escalated = !!get(r, "escalatedAt", "escalated_at") && sla.tone !== "done";
              // Both responsible people, primary first (desktop join "Farra · Nancy").
              const pic = [get(r, "assignedToName", "assigned_to_name"), get(r, "assignedTo2Name", "assigned_to_2_name")]
                .filter(Boolean)
                .join(" · ");
              return (
                <div
                  key={id}
                  onClick={() => onOpen(id)}
                  style={{
                    background: "#fff", borderRadius: 16, border: `1px solid ${LINE_SOFT}`,
                    overflow: "hidden", cursor: "pointer", position: "relative",
                    boxShadow: "0 1px 2px rgba(17,20,15,0.03)", opacity: cancelled ? 0.55 : 1,
                  }}
                >
                  {/* priority stripe */}
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, background: pr.color }} />
                  <div style={{ padding: "13px 15px 13px 17px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span className="money" style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>{String(caseNo(r))}</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: pr.color, flex: "none" }} />
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: pr.color }}>{pr.label}</span>
                      </span>
                      <div style={{ flex: 1 }} />
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        {escalated && (
                          <span style={{ padding: "2px 7px", borderRadius: 999, border: `1px solid ${RED}`, color: RED, fontSize: 10, fontWeight: 700, whiteSpace: "nowrap", letterSpacing: 0.2 }}>
                            Esc
                          </span>
                        )}
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 999, background: tone.bg, color: tone.fg, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                          {sla.label}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
                      <Avatar name={String(customer(r))} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>{customer(r)}</div>
                        <div style={{ fontSize: 12.5, color: INK_SEC, marginTop: 1, ...cellEllipsis }}>{item ? String(item) : "—"}</div>
                        {pic && (
                          <div style={{ fontSize: 11, color: MUTED, marginTop: 3, ...cellEllipsis }}>PIC: {pic}</div>
                        )}
                      </div>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 5 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <span style={{ fontSize: 11.5, fontWeight: 600, color: TEAL_DK, ...cellEllipsis }}>{(() => {
                            const sub = assrSubStatus(stageOf(r), String(get(r, "subStatus", "sub_status") ?? "") || null);
                            return sub ? sub.label : prettyStage(stageOf(r));
                          })()}</span>
                          {dwell && (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "none" }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: dwell.color, flex: "none" }} />
                              <span style={{ fontSize: 10.5, fontWeight: dwell.stuck ? 700 : 600, color: dwell.color, whiteSpace: "nowrap" }}>{dwell.label} {dwell.days}d</span>
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: 11, color: GREY, flex: "none" }}>{Math.max(idx, 0) + 1}/{rowStages.length}</span>
                      </div>
                      {/* mini progress bars (active pipeline for this case) */}
                      <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                        {rowStages.map((s, i) => {
                          const done = idx >= 0 && i < idx;
                          const cur = i === idx;
                          return (
                            <div key={s.key} style={{ flex: 1, height: cur ? 5 : 4, borderRadius: 999, background: done || cur ? TEAL : DIM, opacity: done ? 0.55 : 1 }} />
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
                }}
              />
            )}
            {/* Infinite-scroll sentinel — watched by the IntersectionObserver;
                enters view (+600px) near the end and pulls the next page. */}
            {!searchTransition.isSearching && hasNextPage && (
              <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
            )}
            {/* "Loading more…" while the next page is in flight. */}
            {!searchTransition.isSearching && isFetchingNextPage && (
              <div style={{ textAlign: "center", padding: "14px 0 2px", fontSize: 11.5, color: MUTED }}>Loading more…</div>
            )}
            {/* Empty only once loading has truly settled — otherwise a
                risk/urgent chip mid-load would flash "Nothing matches". */}
            {!visibleRows.length && !searchTransition.isSearching && !hasNextPage && !isFetchingNextPage && (
              <div className="empty">
                <div className="empty-t">Nothing matches</div>
                <div className="empty-s">Try a different filter or search.</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// initials avatar (design SC_Avatar) — hue derived from the name.
function Avatar({ name, size = 38 }: { name: string; size?: number }) {
  const init = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "—";
  const hue = [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flex: "none",
      background: `oklch(0.62 0.09 ${hue})`, color: "#fff",
      display: "grid", placeItems: "center", fontSize: size * 0.36, fontWeight: 600, letterSpacing: 0.2,
    }}>{init}</div>
  );
}

// ── DETAIL — tabbed (Overview / Stage / Info / Timeline) ──────────
type DetailTab = "overview" | "stage" | "info" | "timeline";

function CaseDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const notify = useNotify();
  const choose = useChoice();
  const [tab, setTab] = useState<DetailTab>("overview");
  const [openStage, setOpenStage] = useState<string | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteAudience, setNoteAudience] = useState<NoteAudience>("service");
  const [tlFilter, setTlFilter] = useState("all");
  const [busy, setBusy] = useState(false);

  // Picker option lists sourced from /api/assr/lookups/* exactly as the
  // desktop DetailContent does (issue categories by NAME; resolution +
  // priority by SLUG). Hardcoded constants stay as the pre-load fallback.
  const issueCatOptions = useLookupNames("issue-categories", ISSUE_CATEGORY_OPTIONS as readonly string[]);
  const resolutionOptions = useLookupSlugs("resolution-methods", RESOLUTION_OPTIONS as readonly string[]);
  const priorityOptions = useLookupSlugs("priorities", PRIORITY_OPTIONS as readonly string[]);
  const assignableUsers = useAssignableUsers();

  const { data, isLoading, error } = useQuery({
    queryKey: ["mobile-assr-detail", id],
    queryFn: () => api.get<Any>(`/api/assr/${id}`),
    staleTime: 15_000,
  });

  const refetch = () => qc.invalidateQueries({ queryKey: ["mobile-assr-detail", id] });
  // A single mutual-exclusion guard keeps every write serial: no double
  // submits while a PATCH / transition / upload is in flight.
  const runWrite = async (fn: () => Promise<void>, failTitle: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      refetch();
      // Prefix key MUST match the list query (["mobile-assr-list-paged", …]);
      // "mobile-assr-list" is not a prefix of it, so it never invalidated.
      qc.invalidateQueries({ queryKey: ["mobile-assr-list-paged"] });
    } catch (e: any) {
      await notify({ title: failTitle, body: e?.message || "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  // Section edit — patches only the fields the PATCH /:id endpoint accepts.
  const patchCase = (body: Record<string, any>, failTitle = "Couldn't save") =>
    runWrite(async () => {
      await api.patch(`/api/assr/${id}`, body);
    }, failTitle);

  const addNote = useMutation({
    mutationFn: (payload: { note: string; category: NoteAudience }) =>
      api.post<Any>(`/api/assr/${id}/notes`, payload),
    onSuccess: () => {
      setNoteDraft("");
      refetch();
    },
  });

  const c: Any = data?.case ?? {};
  const items: Any[] = data?.items ?? [];
  const activity: Any[] = data?.activity ?? [];
  const attachments: Any[] = data?.attachments ?? [];
  const relatedPOs: Any[] = data?.related_pos ?? data?.relatedPos ?? [];
  const stageHistory: Any[] = data?.stage_history ?? data?.stageHistory ?? [];
  const portalToken = get(data ?? {}, "portal_token", "portalToken");

  const sla = slaText(hoursToDeadline(c));
  const leadDays = get(c, "stageTargetDays", "stage_target_days");
  const resolutionMethod = get(c, "resolutionMethod", "resolution_method");
  // Resolution-filtered pipeline (shared rule): internal-resolution cases drop
  // the two supplier-only stages, so the progress bar, phase tiles, Change-to
  // select, Info accordion and Advance button all walk the SHORT pipeline —
  // no more mis-routing an own-team case into Supplier Pickup / Item Ready.
  const activeStages = activeMStages(resolutionMethod, stageOf(c));
  const curStageIdx = activeStages.findIndex((s) => s.key === stageOf(c));
  const nextStage = curStageIdx >= 0 ? activeStages[curStageIdx + 1] : undefined;
  const isCompleted = stageOf(c) === "completed";

  // Latest history row per stage (drives done-times in the Info accordion).
  const historyByStage = useMemo(() => {
    const m: Record<string, Any> = {};
    for (const h of stageHistory) m[String(get(h, "stage") ?? "")] = h;
    return m;
  }, [stageHistory]);

  // Timeline audience categories present on activity rows.
  const timelineCats = useMemo(() => {
    const set = new Set<string>();
    for (const a of activity) {
      const cat = String(get(a, "category") ?? "").toUpperCase();
      if (cat) set.add(cat);
    }
    // Canonical chip order (matches desktop): the four audience
    // buckets, then SYSTEM; anything unexpected trails.
    const ORDER = ["SYSTEM", "SERVICE", "CUSTOMER", "SUPPLIER", "SALES"];
    const known = ORDER.filter((k) => set.has(k));
    const rest = Array.from(set).filter((k) => !ORDER.includes(k));
    return ["ALL", ...known, ...rest];
  }, [activity]);
  const shownActivity = useMemo(() => {
    if (tlFilter === "all") return activity;
    return activity.filter((a) => String(get(a, "category") ?? "").toUpperCase() === tlFilter);
  }, [activity, tlFilter]);

  const assignedTo = get(c, "assignedToName", "assigned_to_name");
  const assignedTo2 = get(c, "assignedTo2Name", "assigned_to_2_name");

  // ── Add-item picker source — the case's SO line items (desktop parity) ──
  // Mirrors desktop openAddItem(): GET /api/assr/lookup-items/:doc_no returns
  // { items: [{ item_code, item_description, qty? }] }. We only offer items
  // that aren't already on the case; when nothing is pickable the "+ Add item"
  // action is hidden entirely (see the Product info section below).
  type LookupItem = { item_code: string; item_description: string | null; qty?: number };
  const caseDocNo = String(get(c, "docNo", "doc_no") ?? "").trim();
  const { data: lookupData } = useQuery({
    queryKey: ["mobile-assr-lookup-items", caseDocNo],
    enabled: !!caseDocNo,
    staleTime: 60_000,
    queryFn: () => api.get<{ items?: LookupItem[] }>(`/api/assr/lookup-items/${encodeURIComponent(caseDocNo)}`),
  });
  const availableItems: LookupItem[] = useMemo(() => {
    const existing = new Set(items.map((it) => String(get(it, "itemCode", "item_code") ?? "")));
    return (lookupData?.items ?? []).filter((it) => !existing.has(it.item_code));
  }, [lookupData, items]);

  // ── Print copy → 3 variants via /api/assr-print/:id?variant= ────
  const printCopy = async () => {
    const variant = await choose({
      title: "Print copy",
      options: PRINT_VARIANTS.map((v) => ({ value: v.value, label: v.label })),
    });
    if (!variant) return;
    try {
      await api.openHtml(`/api/assr-print/${id}?variant=${variant}`);
    } catch (e: any) {
      await notify({ title: "Couldn't open print view", body: e?.message || "Please try again.", tone: "error" });
    }
  };

  // ── Add product item → POST /:id/items ──────────────────────────
  // Desktop parity: pick from the case's SO line items (availableItems,
  // already filtered to what's not on the case yet) via the in-app single-
  // select ChoiceDialog. The "+ Add item" affordance is hidden when nothing
  // is available, so this only fires with a non-empty list. Qty carries the
  // SO qty (or 1), matching the endpoint's `qty ?? 1`. No naked window.prompt.
  const addItem = async () => {
    if (busy || !availableItems.length) return;
    const picked = await choose({
      title: "Add product item",
      body: `From SO ${caseDocNo || "—"}`,
      options: availableItems.map((it) => ({
        value: it.item_code,
        label: it.item_code,
        detail: it.item_description || undefined,
      })),
    });
    if (picked == null) return;
    const chosen = availableItems.find((it) => it.item_code === picked);
    if (!chosen) return;
    await runWrite(async () => {
      await api.post(`/api/assr/${id}/items`, {
        items: [{
          item_code: chosen.item_code,
          item_description: chosen.item_description,
          qty: chosen.qty && chosen.qty > 0 ? chosen.qty : 1,
        }],
      });
    }, "Couldn't add item");
  };

  // ── Remove product item → DELETE /:id/items/:itemId (desktop parity) ──
  const removeItem = async (it: Any) => {
    if (busy) return;
    const itemId = Number(get(it, "id"));
    if (!itemId) return;
    const label = String(get(it, "itemCode", "item_code") ?? get(it, "itemDescription", "item_description") ?? "this item");
    if (!(await confirm({ title: `Remove ${label}?`, confirmLabel: "Remove", danger: true }))) return;
    await runWrite(async () => {
      await api.del(`/api/assr/${id}/items/${itemId}`);
    }, "Couldn't remove item");
  };

  // ── Assign PIC → PATCH /:id { assigned_to } (desktop parity) ─────
  // The picker is narrowed to Operations-department members, keeping the
  // current assignee selectable, exactly as the desktop PIC select does.
  const assignPic = async () => {
    if (busy) return;
    const curId = Number(get(c, "assignedTo", "assigned_to") ?? 0) || null;
    const ops = assignableUsers.filter(
      (u) => /operation/i.test(u.department_name || "") || u.id === curId,
    );
    if (!ops.length) {
      await notify({ title: "No assignable users", body: "No Operations members are available to assign." });
      return;
    }
    const picked = await choose({
      title: "Assign to",
      body: assignedTo ? `Currently ${String(assignedTo)}.` : "Currently unassigned.",
      options: [
        { value: "", label: "— Unassigned —" },
        ...ops.map((u) => ({ value: String(u.id), label: u.name })),
      ],
    });
    if (picked == null) return;
    const nextId = picked === "" ? null : Number(picked);
    if (nextId === curId) return;
    await patchCase({ assigned_to: nextId }, "Couldn't reassign");
  };

  // Co-assignee — same picker, writes assigned_to_2 (desktop parity).
  const assignCoPic = async () => {
    if (busy) return;
    const curId = Number(get(c, "assignedTo2", "assigned_to_2") ?? 0) || null;
    const ops = assignableUsers.filter(
      (u) => /operation/i.test(u.department_name || "") || u.id === curId,
    );
    if (!ops.length) {
      await notify({ title: "No assignable users", body: "No Operations members are available to assign." });
      return;
    }
    const picked = await choose({
      title: "Co-assignee",
      body: assignedTo2 ? `Currently ${String(assignedTo2)}.` : "Currently none.",
      options: [
        { value: "", label: "— None —" },
        ...ops.map((u) => ({ value: String(u.id), label: u.name })),
      ],
    });
    if (picked == null) return;
    const nextId = picked === "" ? null : Number(picked);
    if (nextId === curId) return;
    await patchCase({ assigned_to_2: nextId }, "Couldn't set co-assignee");
  };

  // ── Case-level values ──
  const poNo = get(c, "poNo", "po_no");
  const creditorCode = get(c, "creditorCode", "creditor_code");
  const archivedAt = get(c, "archivedAt", "archived_at");
  const isArchived = !!archivedAt;

  // ── Case archive → POST /:id/archive ────────────────────────────
  const archiveCase = async () => {
    if (busy || isArchived) return;
    if (
      !(await confirm({
        title: "Archive this case?",
        body: "It is hidden from the active list.",
        confirmLabel: "Archive",
        danger: true,
      }))
    )
      return;
    await runWrite(async () => {
      await api.post(`/api/assr/${id}/archive`);
    }, "Couldn't archive");
  };

  // ── Close case (desktop #1008 parity) — optional CSAT rating + notes,
  // then transition straight to completed from ANY open stage, so early
  // closes (customer withdrew, resolved without delivery) go through the
  // same rated flow instead of a silent stage jump. The PATCH only fires
  // when a rating was given (desktop ClosePrompt semantics).
  const closeCase = (rating: number | null, notes: string) =>
    runWrite(async () => {
      if (rating) await api.patch(`/api/assr/${id}`, { satisfaction_rating: rating, satisfaction_notes: notes || null });
      await api.post(`/api/assr/${id}/transition`, { stage: "completed" });
    }, "Couldn't close case");

  // Stage transition (used by the Stage tab select + the Advance sheet).
  const transitionTo = async (target: string, withConfirm = true) => {
    if (!target || target === stageOf(c)) return;
    if (withConfirm) {
      const label = STAGES[STAGE_INDEX[target]]?.long ?? target;
      if (!(await confirm({ title: `Move to ${label}?`, confirmLabel: "Change stage" }))) return;
    }
    await runWrite(async () => {
      await api.post(`/api/assr/${id}/transition`, { stage: target });
    }, "Stage change failed");
  };

  // Stage-chip tap (Stage tab) → jump to Info with that stage expanded.
  const jumpToStage = (key: string) => {
    setOpenStage(key);
    setTab("info");
  };

  const openStageEffective = openStage ?? (curStageIdx >= 0 ? activeStages[curStageIdx].key : null);

  const TABS: { k: DetailTab; label: string }[] = [
    { k: "overview", label: "Overview" },
    { k: "stage", label: "Stage" },
    { k: "info", label: "Info" },
    { k: "timeline", label: "Timeline" },
  ];

  // ── Per-stage Info panels (handoff STAGE_FIELDS map) ─────────────
  function stagePanel(key: string, state: "done" | "current" | "future") {
    const dis = busy || isArchived;
    switch (key) {
      case "pending_review":
        return (
          <>
            <KV label="Complaint" value={issueOf(c) ? String(issueOf(c)) : "—"} multiline />
            <KV label="Issue category" value={String(get(c, "issueCategory", "issue_category") ?? "—")} />
            <KV label="Complained date" value={dm(get(c, "complainedDate", "complained_date"))} />
            <div style={{ fontSize: 10.5, color: GREY, marginTop: 6 }}>Edit the complaint under Overview → Issue.</div>
          </>
        );
      case "under_verification":
        return (
          <>
            <StageSubChip c={c} stage="under_verification" busy={busy} disabled={dis} patchCase={patchCase} />
            <div className="fld-l">Outcome</div>
            <div style={{ display: "flex", gap: 7, margin: "6px 0 10px", flexWrap: "wrap" }}>
              {VERIFICATION_OPTIONS.map((o) => {
                const active = String(get(c, "verificationOutcome", "verification_outcome") ?? "") === o.value;
                return (
                  <button
                    key={o.value}
                    onClick={() => { if (!dis && !active) patchCase({ verification_outcome: o.value }, "Couldn't save verification"); }}
                    disabled={dis}
                    className="tinybtn"
                    style={active ? { background: TEAL, borderColor: TEAL, color: "#fff" } : undefined}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <RootCauseField
              value={get(c, "verifiedRootCause", "verified_root_cause")}
              busy={busy}
              onSave={(v) => patchCase({ verified_root_cause: v || null }, "Couldn't save verification")}
            />
            {/* QC issue inspection — on receipt (mig 0105: folded in from
                the retired Pending Inspection stage). The qc_issue_result
                column exists but ships no UI — Nick 2026-07-14: date +
                photos suffice; the verdict is the Outcome above. */}
            <EditRow label="QC issue date" type="date" value={get(c, "qcReceiptDate", "qc_receipt_date")} busy={busy} disabled={dis} onSave={(v) => patchCase({ qc_receipt_date: v }, "Couldn't save QC issue date")} />
            {/* Inspect by — own team or supplier (inspection_by, mig 0073). */}
            <div className="fld-l" style={{ marginTop: 10, marginBottom: 8 }}>Inspect by</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
              {([{ v: "own", label: "Own team" }, { v: "supplier", label: "Supplier" }] as const).map((o) => {
                const on = String(get(c, "inspectionBy", "inspection_by") ?? "") === o.v;
                return (
                  <button
                    key={o.v}
                    onClick={() => { if (!dis) patchCase({ inspection_by: on ? null : o.v }, "Couldn't save inspect-by"); }}
                    disabled={dis}
                    style={{
                      flex: 1, height: 40, borderRadius: 10, cursor: dis ? "default" : "pointer", fontFamily: "inherit",
                      fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                      border: `1px solid ${on ? BROWN : LINE}`, background: on ? BROWN_SOFT : "#fff", color: on ? BROWN_FG : INK_SEC,
                      opacity: dis ? 0.6 : 1,
                    }}
                  >
                    {on && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={BROWN_FG} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
                    )}
                    {o.label}
                  </button>
                );
              })}
            </div>
            {/* QC issue photos — on-receipt evidence, same category as the
                desktop Verification card (receipt_evidence). */}
            <PhotoGrid
              caseId={id}
              attachments={attachments.filter((a) => String(get(a, "category") ?? "") === "receipt_evidence")}
              category="receipt_evidence"
              label="QC issue photos"
              hint="Tap to capture or upload · on receipt"
              accent={BROWN}
              onChanged={refetch}
              notify={notify}
              confirm={confirm}
            />
            {get(c, "verifiedByName", "verified_by_name") && (
              <div style={{ fontSize: 10.5, color: MUTED, background: FIELD_BG, borderRadius: 9, padding: "8px 10px", marginTop: 10 }}>
                Verified by {String(get(c, "verifiedByName", "verified_by_name"))} · {dm(get(c, "verifiedAt", "verified_at"))}
              </div>
            )}
          </>
        );
      case "pending_solution":
        return (
          <>
            <EditRow
              label="Resolution method"
              type="select"
              value={resolutionMethod}
              options={[{ value: "", label: "—" }, ...resolutionOptions.map((o) => ({ value: o, label: resolutionLabel(o) }))]}
              busy={busy}
              disabled={dis}
              onSave={(v) => patchCase({ resolution_method: v }, "Couldn't save resolution")}
            />
            <MobileSupplierPick c={c} onChanged={refetch} notify={notify} disabled={dis} />
          </>
        );
      case "pending_supplier_pickup":
        return (
          <>
            <StageSubChip c={c} stage="pending_supplier_pickup" busy={busy} disabled={dis} patchCase={patchCase} />
            <KV label="Supplier" value={String(get(c, "creditorName", "creditor_name") ?? creditorCode ?? "—")} />
            <KV label="Supplier code" value={creditorCode ? String(creditorCode) : "—"} mono />
            {/* Folded in from the retired Item Pickup stage (mig 0110). */}
            <EditRow label="Customer pickup date" type="date" value={get(c, "customerPickupAt", "customer_pickup_at")} busy={busy} disabled={dis} onSave={(v) => patchCase({ customer_pickup_at: v }, "Couldn't save pickup date")} />
            <EditRow label="Supplier pickup date" type="date" value={get(c, "supplierPickupAt", "supplier_pickup_at")} busy={busy} disabled={dis} onSave={(v) => patchCase({ supplier_pickup_at: v }, "Couldn't save pickup date")} />
            <EditRow label="Supplier return date" type="date" value={get(c, "itemsReadyAt", "items_ready_at")} busy={busy} disabled={dis} onSave={(v) => patchCase({ items_ready_at: v }, "Couldn't save return date")} />
            <EditRow label="Supplier status update" type="textarea" value={get(c, "actionRemark", "action_remark")} busy={busy} disabled={dis} onSave={(v) => patchCase({ action_remark: v }, "Couldn't save status update")} />
          </>
        );
      case "pending_item_ready":
        return (
          <>
            <div className="fld-l">QC result (after repair)</div>
            <div style={{ display: "flex", gap: 7, margin: "6px 0 4px" }}>
              {QC_RESULT_OPTIONS.map((o) => {
                const active = String(get(c, "inspectionResult", "inspection_result") ?? "") === o.value;
                return (
                  <button
                    key={o.value}
                    onClick={() => { if (!dis) patchCase({ inspection_result: active ? null : o.value }, "Couldn't save QC result"); }}
                    disabled={dis}
                    className="tinybtn"
                    style={active ? { background: GREEN, borderColor: GREEN, color: "#fff" } : undefined}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <EditRow label="QC inspection date" type="date" value={get(c, "itemsReadyAt", "items_ready_at")} busy={busy} disabled={dis} onSave={(v) => patchCase({ items_ready_at: v }, "Couldn't save QC date")} />
            <div style={{ fontSize: 10, color: GREY, marginTop: 2 }}>Pass + date → becomes the Item Ready date. Fail → stays pending.</div>
            {/* After-repair QC photos / report — same category the old
                "Upload inspection report" button used (qc). */}
            <PhotoGrid
              caseId={id}
              attachments={attachments.filter((a) => ["qc", "inspection_report"].includes(String(get(a, "category") ?? "")))}
              category="qc"
              label="QC photos"
              hint="After-repair QC evidence / report"
              accent={GREEN}
              onChanged={refetch}
              notify={notify}
              confirm={confirm}
            />
          </>
        );
      case "pending_delivery_service":
        return (
          <>
            <EditRow label="Delivery order" value={get(c, "deliveryOrder", "delivery_order")} mono busy={busy} disabled={dis} onSave={(v) => patchCase({ delivery_order: v }, "Couldn't save delivery order")} />
            <EditRow label="DO date" type="date" value={get(c, "doDate", "do_date")} busy={busy} disabled={dis} onSave={(v) => patchCase({ do_date: v }, "Couldn't save DO date")} />
            <EditRow label="Ref No" value={get(c, "refNo", "ref_no")} mono busy={busy} disabled={dis} onSave={(v) => patchCase({ ref_no: v }, "Couldn't save Ref No")} />
          </>
        );
      case "completed":
        return (
          <>
            <KV label="Status" value={statusOf(c) ? cap(statusOf(c).replace(/_/g, " ")) : "—"} />
            <KV label="Completed" value={dm(get(c, "completionDate", "completion_date", "closedAt", "closed_at"))} />
            {state !== "current" && state !== "done" && (
              <div style={{ fontSize: 10.5, color: GREY, marginTop: 6 }}>Sign-off lands here when the case closes.</div>
            )}
          </>
        );
      default:
        return <div style={{ fontSize: 12, color: GREY, padding: "6px 0" }}>No fields for this stage.</div>;
    }
  }

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)", position: "relative" }}>
      {/* header (.hdr) — back + Archive · stage badge · case no + priority · customer · tabs */}
      <header className="hdr" style={{ paddingBottom: 0 }}>
        <div className="hdr-row">
          <button className="back" onClick={onBack}>
            <span className="chev">‹</span> Cases
          </button>
          {!isLoading && !error && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flex: "none" }}>
              {isArchived ? (
                <span className="badge b-grey">Archived</span>
              ) : (
                <button onClick={archiveCase} disabled={busy} className="tinybtn" style={{ opacity: busy ? 0.5 : 1 }}>Archive</button>
              )}
              <span style={{ padding: "3px 10px", borderRadius: 999, background: BROWN_SOFT, color: BROWN_FG, fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>
                {prettyStage(stageOf(c))}
              </span>
            </span>
          )}
        </div>
        <div className="money" style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginTop: 8 }}>
          {String(caseNo(c))} · {(PRIORITY_META[priorityOf(c)] ?? PRIORITY_META.normal).label}
        </div>
        <div className="scr-title" style={{ marginTop: 2 }}>{customer(c)}</div>
        {assignedTo ? (
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
            Assigned {[assignedTo, assignedTo2].filter(Boolean).map(String).join(" · ")}
          </div>
        ) : null}
        {/* tab row */}
        <div style={{ display: "flex", gap: 2, marginTop: 8 }}>
          {TABS.map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              style={{
                flex: 1, padding: "10px 2px", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit",
                borderBottom: tab === t.k ? `2.5px solid ${TEAL}` : "2.5px solid transparent",
                fontSize: 12.5, fontWeight: tab === t.k ? 700 : 600, color: tab === t.k ? TEAL : MUTED,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 170 }}>
        {isLoading && <div style={{ textAlign: "center", color: "var(--mut2)", fontSize: 12, padding: "26px 0" }}>Loading…</div>}
        {error && <div style={{ textAlign: "center", color: "var(--red)", fontSize: 12, padding: "26px 0" }}>Couldn't load this case.</div>}
        {!isLoading && !error && (
          <>
            {/* ══ OVERVIEW ══ */}
            {tab === "overview" && (
              <>
                {/* SLA banner */}
                <div style={{ background: sla?.overdue ? ERR_BG : "#fff", border: `1px solid ${sla?.overdue ? "rgba(178,58,58,0.25)" : LINE_SOFT}`, borderRadius: 13, padding: "12px 14px", marginBottom: 10 }}>
                  <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: sla?.overdue ? RED : MUTED }}>SLA</div>
                  <div style={{ fontSize: 12, color: sla?.overdue ? "#7a2222" : INK_SEC, marginTop: 5 }}>
                    Deadline {dm(get(c, "deadlineAt", "deadline_at"))} · {(PRIORITY_META[priorityOf(c)] ?? PRIORITY_META.normal).label}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: sla?.overdue ? RED : isCompleted ? GREY : GREEN, marginTop: 2 }}>
                    {isCompleted ? "Closed" : sla ? sla.label : "No SLA deadline"}
                  </div>
                </div>

                {/* meta line — Priority / Lead time / Resolution */}
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11, color: MUTED, marginBottom: 13 }}>
                  <span>Priority <b style={{ color: INK }}>{cap(priorityOf(c))}</b></span>
                  {leadDays != null && <span>Lead time <b style={{ color: INK }}>{Number(leadDays).toFixed(1)}d</b></span>}
                  {resolutionMethod && <span>Resolution <b style={{ color: INK }}>{resolutionLabel(String(resolutionMethod))}</b></span>}
                </div>

                {/* Issue (Edit → Save) — Complaint / Issue category / Priority,
                    with the defect photo grid inside (design keeps it here). */}
                <EditableAcc
                  title="Issue"
                  open
                  busy={busy}
                  fields={[
                    { key: "complaint_issue", label: "Complaint", value: issueOf(c), type: "textarea" },
                    { key: "issue_category", label: "Issue category", value: get(c, "issueCategory", "issue_category"), type: "select", options: issueCatOptions.map((o) => ({ value: o, label: o })) },
                    { key: "priority", label: "Priority", value: priorityOf(c), type: "select", options: priorityOptions.map((o) => ({ value: o, label: cap(o) })) },
                  ]}
                  onSave={(body) => patchCase(body, "Couldn't save issue")}
                >
                  <KV label="Status" value={statusOf(c) ? cap(statusOf(c).replace(/_/g, " ")) : "—"} />
                  <PhotoGrid
                    caseId={id}
                    attachments={attachments.filter((a) => !["receipt_evidence", "qc", "inspection_report"].includes(String(get(a, "category") ?? "")))}
                    category="complaint"
                    label="Photos / videos"
                    onChanged={refetch}
                    notify={notify}
                    confirm={confirm}
                  />
                </EditableAcc>

                {/* Product info — items + "+ Add item" + Product category. */}
                <EditableAcc
                  title="Product info"
                  open
                  busy={busy}
                  fields={[
                    // Prototype's "Product category" field → the REAL, whitelisted
                    // assr_cases.service_category column (desktop ServiceCases.tsx
                    // edits this same key). There is NO product_category column
                    // server-side, so writing that key would silently no-op and
                    // never read back — we bind to service_category instead.
                    { key: "service_category", label: "Product category", value: get(c, "serviceCategory", "service_category"), type: "text" },
                  ]}
                  onSave={(body) => patchCase(body, "Couldn't save product info")}
                  headSlot={
                    availableItems.length ? (
                      <span
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) addItem(); }}
                        className="tinybtn"
                        style={{ color: BROWN, opacity: busy ? 0.5 : 1 }}
                      >
                        + Add item
                      </span>
                    ) : undefined
                  }
                >
                  {items.length ? items.map((it, i) => (
                    <div key={get(it, "id") ?? i} style={{ border: `1px solid ${DIM}`, borderRadius: 10, padding: "10px 11px", marginBottom: 7 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="money" style={{ fontSize: 10, fontWeight: 700, color: BROWN }}>{String(get(it, "itemCode", "item_code") ?? "—")}</div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: INK, marginTop: 2 }}>{String(get(it, "itemDescription", "item_description") ?? "—")}</div>
                        </div>
                        <button
                          onClick={() => removeItem(it)}
                          disabled={busy}
                          aria-label="Remove item"
                          style={{ flex: "none", width: 26, height: 26, borderRadius: 8, border: `1px solid ${DIM}`, background: "#fff", color: RED, fontSize: 15, lineHeight: 1, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
                        >
                          ×
                        </button>
                      </div>
                      {/* Set + Ctn steppers on their own labelled row — the
                          375px header row can't fit two steppers beside the
                          description (desktop c505d19f puts them inline). */}
                      <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 9 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span className="fld-l">Set</span>
                          <MobileItemQty c={c} it={it} busy={busy} onChanged={refetch} notify={notify} />
                        </span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <span className="fld-l">Ctn</span>
                          <MobileItemCarton c={c} it={it} busy={busy} onChanged={refetch} notify={notify} />
                        </span>
                      </div>
                      <MobileItemRemark c={c} it={it} busy={busy} onChanged={refetch} notify={notify} field="remark" placeholder="Customer remark — prints on customer copy" />
                      <MobileItemRemark c={c} it={it} busy={busy} onChanged={refetch} notify={notify} field="supplier_remark" placeholder="Supplier remark — prints on supplier copy" />
                    </div>
                  )) : (
                    <div style={{ fontSize: 12, color: GREY, padding: "2px 0" }}>No items recorded.</div>
                  )}
                  <KV label="PO No" value={(poNo ? [String(poNo)] : []).concat(relatedPOs.map((p) => String(get(p, "docNo", "doc_no") ?? "")).filter(Boolean)).join(", ") || "—"} mono />
                </EditableAcc>
              </>
            )}

            {/* ══ STAGE — grouped phases (Intake / Repair / Return) ══ */}
            {tab === "stage" && (
              <div style={{ background: "#fff", borderRadius: 14, border: `1px solid ${LINE_SOFT}`, padding: 14 }}>
                <div className="fld-l">Stage</div>
                <div style={{ marginTop: 12 }}>
                  {/* progress bar + n/N (N = active-pipeline length) */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                    <div style={{ flex: 1, height: 6, borderRadius: 999, background: DIM, overflow: "hidden" }}>
                      <div style={{ width: `${Math.round((Math.max(curStageIdx, 0) / Math.max(activeStages.length - 1, 1)) * 100)}%`, height: "100%", background: `linear-gradient(90deg, ${GREEN}, ${BROWN})`, borderRadius: 999 }} />
                    </div>
                    <span className="money" style={{ fontSize: 11.5, fontWeight: 700, color: INK_SEC }}>{Math.max(curStageIdx, 0) + 1}/{activeStages.length}</span>
                  </div>
                  {PHASE_DEFS.map((p) => {
                    // A phase's members are its stages that survive the
                    // resolution filter (Repair drops out entirely for an
                    // internal-resolution case). Indices are into activeStages.
                    const members = p.keys
                      .map((k) => activeStages.findIndex((s) => s.key === k))
                      .filter((ai) => ai >= 0);
                    if (members.length === 0) return null;
                    const allDone = members.every((ai) => ai < curStageIdx);
                    const active = members.some((ai) => ai === curStageIdx);
                    const d = members.filter((ai) => ai < curStageIdx).length;
                    return (
                      <div key={p.name} style={{
                        border: `1px solid ${active ? BROWN : allDone ? "transparent" : LINE_SOFT}`,
                        background: allDone ? OK_BG : active ? BROWN_SOFT : "#fff",
                        borderRadius: 11, padding: "11px 12px", marginBottom: 8,
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <span style={{ width: 9, height: 9, borderRadius: "50%", flex: "none", background: allDone ? GREEN : active ? BROWN : DIM }} />
                          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: allDone ? GREEN : active ? BROWN_FG : INK }}>{p.name}</span>
                          <span className="money" style={{ fontSize: 10.5, color: MUTED }}>{allDone ? "Done" : `${d}/${members.length}`}</span>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
                          {members.map((ai) => {
                            const on = ai < curStageIdx;
                            const isc = ai === curStageIdx;
                            return (
                              <button
                                key={activeStages[ai].key}
                                onClick={() => jumpToStage(activeStages[ai].key)}
                                style={{
                                  fontSize: 10, fontWeight: 600, padding: "4px 9px", borderRadius: 999, fontFamily: "inherit",
                                  border: "none", cursor: "pointer",
                                  background: on ? "rgba(47,138,91,0.14)" : isc ? BROWN : FIELD_BG,
                                  color: on ? GREEN : isc ? "#fff" : GREY,
                                }}
                              >
                                {activeStages[ai].label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ fontSize: 11, color: GREY, marginTop: 10, textAlign: "center" }}>Tap a stage to see its details</div>

                  {/* Change to — any active stage (incl. backward) so ops can
                      correct mistakes; supplier-only stages are hidden for
                      internal-resolution cases. */}
                  <label className="fld" style={{ marginTop: 12, marginBottom: 0 }}>
                    <span className="fld-l">Change stage to</span>
                    <select
                      value={stageOf(c)}
                      disabled={busy || isArchived}
                      onChange={(e) => transitionTo(e.target.value)}
                      className="fld-i"
                    >
                      {activeStages.map((s) => (
                        <option key={s.key} value={s.key}>{s.long}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            )}

            {/* ══ INFO — per-stage accordion + case details ══ */}
            {tab === "info" && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: MUTED, margin: "2px 2px 10px" }}>Stage details</div>
                {activeStages.map((s, si) => {
                  const st: "done" | "current" | "future" = si < curStageIdx ? "done" : si === curStageIdx ? "current" : "future";
                  const h = historyByStage[s.key];
                  const open = openStageEffective === s.key;
                  const dot = st === "done" ? GREEN : st === "current" ? BROWN : DIM;
                  return (
                    <div key={s.key} style={{ background: "#fff", borderRadius: 12, border: `1px solid ${open ? (st === "current" ? BROWN : "rgba(34,31,32,0.20)") : LINE_SOFT}`, marginBottom: 8, overflow: "hidden" }}>
                      <button
                        onClick={() => setOpenStage(open ? "" : s.key)}
                        style={{
                          width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "12px 13px",
                          background: open && st === "current" ? BROWN_SOFT : "transparent", border: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                        }}
                      >
                        <span style={{ width: 20, height: 20, borderRadius: "50%", flex: "none", background: st === "future" ? "#fff" : dot, border: st === "future" ? `2px solid ${DIM}` : "none", display: "grid", placeItems: "center" }}>
                          {st === "done" && (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 6" /></svg>
                          )}
                          {st === "current" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#fff" }} />}
                        </span>
                        <span style={{ flex: 1, fontSize: 13, fontWeight: st === "future" ? 600 : 700, color: st === "future" ? GREY : INK }}>{s.long}</span>
                        {st === "done" && (
                          <span style={{ fontSize: 10.5, color: GREEN, fontWeight: 600 }}>{h?.skipped ? "Skipped" : dm(get(h ?? {}, "exitedAt", "exited_at", "enteredAt", "entered_at"))}</span>
                        )}
                        {st === "current" && <span style={{ fontSize: 9.5, fontWeight: 700, color: "#fff", background: BROWN, padding: "2px 7px", borderRadius: 999 }}>CURRENT</span>}
                        {st === "future" && <span style={{ fontSize: 10.5, color: GREY }}>Not started</span>}
                        <span style={{ color: "#c2c6bd", fontSize: 15, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>
                      </button>
                      {open && (
                        <div style={{ padding: "0 13px 12px" }}>
                          <div style={{ fontSize: 11, color: GREY, padding: "0 0 6px" }}>
                            Owner: {s.owner}
                            {h ? ` · ${dm(get(h, "enteredAt", "entered_at"))}` : ""}
                          </div>
                          {stagePanel(s.key, st)}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: MUTED, margin: "16px 2px 10px" }}>Case details</div>

                {/* Customer (Edit → Save + read-only .pgrid2 references). */}
                <EditableAcc
                  title="Customer"
                  open
                  busy={busy}
                  fields={[
                    // Editable SO No (2026-07-14) — fixing a fat-fingered
                    // SO re-matches customer info from the SO mirror
                    // server-side.
                    { key: "doc_no", label: "SO No", value: get(c, "docNo", "doc_no"), type: "so" },
                    { key: "ref_no", label: "Ref No", value: get(c, "refNo", "ref_no"), type: "text" },
                    { key: "customer_name", label: "Customer", value: customer(c) === "—" ? "" : customer(c), type: "text" },
                    { key: "phone", label: "Phone", value: get(c, "phone", "customerPhone", "customer_phone"), type: "text" },
                    { key: "customer_email", label: "Email", value: get(c, "customerEmail", "customer_email"), type: "text" },
                    { key: "location", label: "Location", value: get(c, "location", "customerState", "customer_state"), type: "text" },
                    { key: "sales_agent", label: "Agent", value: get(c, "salesAgent", "sales_agent", "agent"), type: "text" },
                  ]}
                  onSave={(body) => patchCase(body, "Couldn't save customer")}
                  readView={
                    <>
                      {/* Read view mirrors the desktop Customer card
                          (avatar + name, SO/Ref chips, phone + call,
                          address + location chip); Edit swaps in the
                          fields above. */}
                      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                        <Avatar name={String(customer(c))} size={42} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 15.5, fontWeight: 700, color: INK, ...cellEllipsis }}>{customer(c)}</div>
                          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>
                            Agent · <b style={{ color: INK_SEC }}>{String(get(c, "salesAgent", "sales_agent", "agent") ?? "—")}</b>
                          </div>
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 11 }}>
                        <div style={{ background: FIELD_BG, border: `1px solid ${DIM}`, borderRadius: 9, padding: "7px 10px" }}>
                          <div className="money" style={{ fontSize: 8.5, letterSpacing: ".1em", textTransform: "uppercase", color: GREY, fontWeight: 600 }}>SO No</div>
                          <div className="money" style={{ fontSize: 12.5, fontWeight: 600, color: TEAL_DK, marginTop: 3, ...cellEllipsis }}>{String(get(c, "docNo", "doc_no") ?? "—")}</div>
                        </div>
                        <div style={{ background: FIELD_BG, border: `1px solid ${DIM}`, borderRadius: 9, padding: "7px 10px" }}>
                          <div className="money" style={{ fontSize: 8.5, letterSpacing: ".1em", textTransform: "uppercase", color: GREY, fontWeight: 600 }}>Ref No</div>
                          <div className="money" style={{ fontSize: 12.5, fontWeight: 600, color: INK, marginTop: 3, ...cellEllipsis }}>{String(get(c, "refNo", "ref_no") ?? "—")}</div>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 0 9px", borderBottom: "1px solid #f1f0ea", marginTop: 4 }}>
                        <div style={{ minWidth: 0 }}>
                          <div className="money" style={{ fontSize: 8.5, letterSpacing: ".1em", textTransform: "uppercase", color: GREY, fontWeight: 600 }}>Phone</div>
                          <div className="money" style={{ fontSize: 13, fontWeight: 600, color: INK, marginTop: 3 }}>{formatPhone(get(c, "phone", "customerPhone", "customer_phone")) || "—"}</div>
                        </div>
                        {get(c, "phone", "customerPhone", "customer_phone") && (
                          <a
                            href={`tel:${String(get(c, "phone", "customerPhone", "customer_phone")).replace(/[^+\d]/g, "")}`}
                            aria-label="Call customer"
                            style={{ width: 34, height: 34, flex: "none", borderRadius: 9, background: "#e1efed", color: TEAL_DK, display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24 11 11 0 0 0 3.4.55 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11 11 0 0 0 .55 3.4 1 1 0 0 1-.24 1Z" /></svg>
                          </a>
                        )}
                      </div>
                      <div style={{ paddingTop: 9 }}>
                        <div className="money" style={{ fontSize: 8.5, letterSpacing: ".1em", textTransform: "uppercase", color: GREY, fontWeight: 600 }}>Customer address</div>
                        <div style={{ fontSize: 12.5, fontWeight: 500, color: INK, lineHeight: 1.5, marginTop: 3 }}>
                          {[get(c, "addr1"), get(c, "addr2"), get(c, "addr3"), get(c, "addr4")].filter(Boolean).join(", ") || "—"}
                        </div>
                        {get(c, "location", "customerState", "customer_state") && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 11, fontWeight: 600, color: TEAL_DK, background: "#e1efed", borderRadius: 7, padding: "4px 10px" }}>
                            {String(get(c, "location", "customerState", "customer_state"))}
                          </span>
                        )}
                      </div>
                      <KV label="Email" value={String(get(c, "customerEmail", "customer_email") ?? "—")} />
                      <KV label="Date" value={dm(get(c, "complainedDate", "complained_date", "createdAt", "created_at"))} />
                    </>
                  }
                />

                {/* PIC — right-header = current assignee; Assign reassigns via PATCH */}
                <Acc
                  title="PIC"
                  open
                  headRight={[assignedTo, assignedTo2].filter(Boolean).map(String).join(" · ") || "Unassigned"}
                  headSlot={
                    <>
                      <span
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) assignPic(); }}
                        className="tinybtn"
                        style={{ color: BROWN, opacity: busy ? 0.5 : 1 }}
                      >
                        Assign
                      </span>
                      <span
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) assignCoPic(); }}
                        className="tinybtn"
                        style={{ color: BROWN, opacity: busy ? 0.5 : 1, marginLeft: 6 }}
                      >
                        Co-assign
                      </span>
                    </>
                  }
                >
                  <KV label="Assigned to" value={assignedTo ? String(assignedTo) : "Unassigned"} />
                  <KV label="Co-assignee" value={assignedTo2 ? String(assignedTo2) : "None"} />
                  <KV label="Created by" value={String(get(c, "createdByName", "created_by_name") ?? "—")} />
                </Acc>

                {/* Print copy + Portal link + Sales link. Links carry the
                    ASSR slug for readability; tokens are permanent. */}
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  <button onClick={printCopy} className="tinybtn" style={{ flex: 1, padding: 9 }}>Print copy</button>
                  <button
                    onClick={async () => {
                      if (!portalToken) return;
                      const slug = String(caseNo(c)).replace(/[^A-Za-z0-9-]+/g, "-");
                      const url = `${window.location.origin}/portal/case/${slug}/${portalToken}`;
                      try {
                        if (navigator.clipboard) await navigator.clipboard.writeText(url);
                        await notify({ title: "Portal link copied", body: url });
                      } catch {
                        await notify({ title: "Portal link", body: url });
                      }
                    }}
                    disabled={!portalToken}
                    className="tinybtn"
                    style={{ flex: 1, padding: 9, opacity: portalToken ? 1 : 0.5 }}
                  >
                    Portal link
                  </button>
                  <button
                    onClick={async () => {
                      if (busy) return;
                      try {
                        const r = await api.post<{ token: string }>(`/api/assr/${id}/sales-link`);
                        const slug = String(caseNo(c)).replace(/[^A-Za-z0-9-]+/g, "-");
                        const url = `${window.location.origin}/portal/case/${slug}/${r.token}`;
                        if (navigator.clipboard) await navigator.clipboard.writeText(url);
                        await notify({ title: "Sales link copied", body: url });
                      } catch (e: any) {
                        await notify({ title: "Sales link failed", body: e?.message || "Try again." });
                      }
                    }}
                    className="tinybtn"
                    style={{ flex: 1, padding: 9 }}
                  >
                    Sales link
                  </button>
                </div>
              </>
            )}

            {/* ══ TIMELINE ══ */}
            {tab === "timeline" && (
              <Acc
                title="Timeline"
                open
                headSlot={
                  <span
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); const el = document.getElementById(`svc-note-${id}`); el?.focus(); }}
                    className="tinybtn"
                    style={{ background: BROWN, borderColor: BROWN, color: "#fff" }}
                  >
                    + Add note
                  </span>
                }
              >
                {timelineCats.length > 1 && (
                  <div className="hz-scroll" style={{ display: "flex", gap: 6, overflowX: "auto", marginBottom: 6, paddingBottom: 2 }}>
                    {timelineCats.map((cat) => {
                      const key = cat === "ALL" ? "all" : cat;
                      return (
                        <button key={cat} className={`sochip${tlFilter === key ? " on" : ""}`} onClick={() => setTlFilter(key)}>
                          {cat === "ALL" ? "All" : cap(cat.toLowerCase())}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* audience picker — service / customer / supplier / sales (mig 0108) */}
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  {NOTE_AUDIENCE_OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => setNoteAudience(o.value)}
                      className={`sochip${noteAudience === o.value ? " on" : ""}`}
                      style={{ flex: 1 }}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                {/* add note input */}
                <div style={{ display: "flex", gap: 7, marginBottom: 4 }}>
                  <input
                    id={`svc-note-${id}`}
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder={noteAudience === "customer" ? "Add a customer-visible note" : "Add an internal note"}
                    className="fld-i"
                    style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}
                  />
                  <button
                    onClick={() => noteDraft.trim() && addNote.mutate({ note: noteDraft.trim(), category: noteAudience })}
                    disabled={!noteDraft.trim() || addNote.isPending}
                    style={{ flex: "none", padding: "0 14px", borderRadius: 9, border: "none", background: noteDraft.trim() ? BROWN : "#c9c1b4", color: "#fff", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: noteDraft.trim() ? "pointer" : "default" }}
                  >
                    {addNote.isPending ? "…" : "Add"}
                  </button>
                </div>
                <div style={{ fontSize: 10, color: GREY, marginBottom: 10 }}>
                  {noteAudience === "customer" ? "Visible to the customer on the portal." : "Internal only — hidden from the customer."}
                </div>
                {addNote.isError && <div style={{ fontSize: 11, color: RED, marginBottom: 8 }}>Couldn't add the note. Try again.</div>}
                {shownActivity.length ? shownActivity.map((a, i) => {
                  const cat = String(get(a, "category") ?? "").toUpperCase();
                  const act = String(get(a, "action") ?? "");
                  let label = get(a, "note", "toValue", "to_value", "action") ?? "Update";
                  // Raw enum keys + UUID storage filenames read as garbage
                  // (Nico 2026-08-01) — prettify both.
                  if (act === "stage_change") label = `Status changed to ${prettyStage(String(get(a, "toValue", "to_value") ?? ""))}`;
                  label = String(label).replace(
                    /\(?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.([a-z0-9]+))?\)?/gi,
                    (_m, ext) => {
                      const e = String(ext || "").toLowerCase();
                      if (["mov", "mp4", "webm", "m4v", "avi"].includes(e)) return "(video)";
                      if (["jpg", "jpeg", "png", "webp", "gif", "heic"].includes(e)) return "(photo)";
                      return "(file)";
                    },
                  );
                  const who = get(a, "userName", "user_name") ?? "System";
                  const badge = catBadge(cat);
                  return (
                    <div key={get(a, "id") ?? i} style={{ display: "flex", gap: 10, padding: "10px 0", borderTop: `1px solid #eceee9` }}>
                      <span style={{ width: 9, height: 9, flex: "none", borderRadius: "50%", border: "2px solid #c2c6bd", marginTop: 3 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10, color: GREY }}>{dtm(get(a, "createdAt", "created_at"))}</div>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginTop: 1 }}>{String(label)}</div>
                        <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 3 }}>
                          <span>by {String(who)}</span>
                          {cat && (
                            <span className="rbadge" style={{ background: badge[0], color: badge[1], marginLeft: 3 }}>{cat}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                }) : (
                  <div style={{ fontSize: 12, color: GREY, padding: "8px 0" }}>No timeline entries.</div>
                )}
              </Acc>
            )}
          </>
        )}
      </div>

      {/* floating action bar — Note + Advance / Mark complete / Print.
          Floats above the app's bottom tab bar (navwrap, z30) which sits
          ~74px + safe-area tall; the sheets below use fixed z40 instead. */}
      {!isLoading && !error && (
        <div style={{
          position: "absolute", left: 12, right: 12, bottom: "calc(env(safe-area-inset-bottom) + 86px)", zIndex: 20,
          display: "flex", gap: 9, alignItems: "stretch",
          background: "rgba(255,255,255,0.94)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)",
          border: `1px solid ${LINE}`, borderRadius: 16, padding: 9,
          boxShadow: "0 14px 34px -14px rgba(17,24,16,0.4)",
        }}>
          <button
            onClick={() => setNoteOpen(true)}
            className="tinybtn"
            style={{ flex: "none", padding: "0 18px", height: 42, fontSize: 13 }}
          >
            Note
          </button>
          {isCompleted ? (
            <button onClick={printCopy} className="tinybtn" style={{ flex: 1, height: 42, fontSize: 13.5, fontWeight: 700 }}>
              Print
            </button>
          ) : (
            <>
              {/* Close on every open case (Nick 2026-07-21, desktop #1008) —
                  hidden at the final step, where "Mark complete" IS the same
                  rated close. Archived cases keep the read-only bar. */}
              {!isArchived && nextStage?.key !== "completed" && (
                <button
                  onClick={() => setCloseOpen(true)}
                  disabled={busy}
                  className="tinybtn"
                  style={{ flex: "none", padding: "0 14px", height: 42, fontSize: 13, color: RED, opacity: busy ? 0.5 : 1 }}
                >
                  Close
                </button>
              )}
              <button
                onClick={() => (nextStage?.key === "completed" ? setCloseOpen(true) : setAdvOpen(true))}
                disabled={busy || isArchived || !nextStage}
                style={{
                  flex: 1, height: 42, borderRadius: 11, border: "none", background: TEAL, color: "#fff",
                  fontFamily: "inherit", fontWeight: 700, fontSize: 14, cursor: "pointer",
                  opacity: busy || isArchived || !nextStage ? 0.55 : 1,
                }}
              >
                {nextStage?.key === "completed" ? "Mark complete" : "Advance stage →"}
              </button>
            </>
          )}
        </div>
      )}

      {/* Advance sheet — current → next chips + confirm. */}
      {advOpen && nextStage && (
        <SheetShell title="Advance stage" onClose={() => setAdvOpen(false)}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0 14px", flexWrap: "wrap" }}>
            <span style={{ padding: "7px 13px", borderRadius: 10, fontSize: 13, fontWeight: 700, background: FIELD_BG, color: INK_SEC }}>{prettyStage(stageOf(c))}</span>
            <span style={{ color: GREY, fontSize: 15 }}>›</span>
            <span style={{ padding: "7px 13px", borderRadius: 10, fontSize: 13, fontWeight: 700, background: TEAL, color: "#fff" }}>{nextStage.long}</span>
          </div>
          <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 16 }}>
            Next-stage owner: <b style={{ color: INK_SEC }}>{nextStage.owner}</b>. The customer portal reflects the change immediately.
          </div>
          <button
            className="btn"
            disabled={busy}
            style={{ opacity: busy ? 0.6 : 1 }}
            onClick={async () => {
              setAdvOpen(false);
              await transitionTo(nextStage.key, false);
            }}
          >
            {nextStage.key === "completed" ? "Confirm — mark complete" : "Confirm advance"}
          </button>
        </SheetShell>
      )}

      {/* Close-case sheet — CSAT stars + notes → completed (#1008 parity).
          Reached from the bar's Close button (any open stage) AND from the
          final step's "Mark complete", so no close path skips the rating. */}
      {closeOpen && (
        <CloseCaseSheet
          busy={busy}
          onClose={() => setCloseOpen(false)}
          onConfirm={async (rating, notes) => {
            setCloseOpen(false);
            await closeCase(rating, notes);
          }}
        />
      )}

      {/* Note sheet — audience + textarea, posts to /:id/notes. */}
      {noteOpen && (
        <NoteSheet
          onClose={() => setNoteOpen(false)}
          saving={addNote.isPending}
          onSave={(text, audience) => {
            addNote.mutate({ note: text, category: audience });
            setNoteOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ── bottom sheet shell (fixed z40 — same pattern as NewCaseSheet, which
// must sit ABOVE the floating tab bar at z30) ───────────────────────
function SheetShell({ title, onClose, children }: { title?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(17,20,15,.4)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: "10px 18px", paddingBottom: "calc(env(safe-area-inset-bottom) + 24px)", maxHeight: "80%", overflowY: "auto" }}>
        <div style={{ width: 38, height: 4, borderRadius: 999, background: DIM, margin: "4px auto 14px" }} />
        {title && <div style={{ fontSize: 17, fontWeight: 700, color: INK, marginBottom: 14 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

// Note entry sheet — own local draft (the Timeline tab keeps its inline
// input too; both post through the same mutation).
function NoteSheet({ onClose, onSave, saving }: {
  onClose: () => void;
  onSave: (note: string, audience: NoteAudience) => void;
  saving: boolean;
}) {
  const [text, setText] = useState("");
  const [audience, setAudience] = useState<NoteAudience>("service");
  return (
    <SheetShell title="Add note" onClose={onClose}>
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {NOTE_AUDIENCE_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => setAudience(o.value)}
            className={`sochip${audience === o.value ? " on" : ""}`}
            style={{ flex: 1 }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Findings, next steps…"
        className="fld-i"
        style={{ resize: "none", width: "100%", boxSizing: "border-box" }}
      />
      <div style={{ fontSize: 10, color: GREY, margin: "6px 0 12px" }}>
        {audience === "customer" ? "Visible to the customer on the portal." : "Internal only — hidden from the customer."}
      </div>
      <button
        className="btn"
        disabled={!text.trim() || saving}
        style={{ opacity: !text.trim() || saving ? 0.6 : 1 }}
        onClick={() => text.trim() && onSave(text.trim(), audience)}
      >
        {saving ? "Saving…" : "Save note"}
      </button>
    </SheetShell>
  );
}

// ── CLOSE-CASE SHEET (desktop ClosePrompt parity, #1008) ──────────
// Optional 1–5 star customer-satisfaction rating + notes; Confirm
// transitions the case to completed. Tapping the active star clears it
// (the rating stays optional), matching the desktop stars exactly.
function CloseCaseSheet({ busy, onClose, onConfirm }: {
  busy: boolean;
  onClose: () => void;
  onConfirm: (rating: number | null, notes: string) => void;
}) {
  const [rating, setRating] = useState(0);
  const [notes, setNotes] = useState("");
  return (
    <SheetShell title="Close case" onClose={onClose}>
      <div className="fld-l">Customer satisfaction</div>
      <div style={{ display: "flex", alignItems: "center", gap: 2, margin: "8px 0 12px" }}>
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = n <= rating;
          return (
            <button
              key={n}
              onClick={() => setRating(rating === n ? 0 : n)}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
              style={{ border: "none", background: "none", padding: 5, cursor: "pointer", lineHeight: 0 }}
            >
              <svg width="26" height="26" viewBox="0 0 24 24" fill={filled ? "#fbbf24" : "none"} stroke={filled ? "#fbbf24" : GREY} strokeWidth="1.6" strokeLinejoin="round">
                <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
              </svg>
            </button>
          );
        })}
        {rating > 0 && <span style={{ fontSize: 13, fontWeight: 700, color: INK_SEC, marginLeft: 8 }}>{rating}/5</span>}
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        placeholder="Satisfaction notes (optional)…"
        className="fld-i"
        style={{ resize: "none", width: "100%", boxSizing: "border-box", marginBottom: 14 }}
      />
      <button
        className="btn"
        disabled={busy}
        style={{ background: RED, opacity: busy ? 0.6 : 1 }}
        onClick={() => onConfirm(rating || null, notes.trim())}
      >
        Confirm close
      </button>
      <div style={{ fontSize: 11, color: MUTED, textAlign: "center", marginTop: 10 }}>
        Closes the case as Completed. The customer portal updates immediately.
      </div>
    </SheetShell>
  );
}

// ── NEW CASE SHEET (#service-new) ─────────────────────────────────
// The backend requires doc_no (SO), at least one item (item_code), and
// complaint_issue; issue_category is required at intake (owner ruling
// 2026-07-19, enforced in the submit gate below), priority is optional. Customer +
// supplier are resolved server-side from the SO. The design shows a
// "SO # / reference / customer" lookup + item; we keep both fields wired.
function NewCaseSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (id: number) => void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  // Lookups sourced the SAME way desktop CreatePanel does — from
  // /api/assr/lookups/*, which returns { data: [{ slug, name, ... }] }.
  // Issue categories render by NAME; priority by SLUG. Fall back to the
  // hardcoded constants until the call returns so the form stays usable.
  const issueCatOptions = useLookupNames("issue-categories", ISSUE_CATEGORY_OPTIONS as readonly string[]);
  const [docNo, setDocNo] = useState("");
  // SO picker (real search-so lookup, replacing free-text). `soQuery` is
  // what the user types; once they pick a hit we lock `docNo` and show the
  // chosen SO. `soPicked` guards the dropdown so it hides after selection.
  const [soQuery, setSoQuery] = useState("");
  const [soPicked, setSoPicked] = useState<SoHit | null>(null);
  const { results: soResults, loading: soLoading } = useSoSearch(soPicked ? "" : soQuery);
  // Affected products — MULTISELECT with per-product qty (owner 2026-07:
  // sometimes 1 product, sometimes several). The backend create endpoint
  // already accepts an `items` array of { item_code, item_description, qty }
  // (assr_items rows, same as desktop CreatePanel) — no schema change.
  type SelItem = { item_code: string; item_description: string | null; qty: number };
  const [selItems, setSelItems] = useState<SelItem[]>([]);
  // Free-text adder draft (used when the SO has no lookup items).
  const [manualCode, setManualCode] = useState("");
  const [complaint, setComplaint] = useState("");
  const [category, setCategory] = useState("");
  // Optional "Issue number" (handoff §5) — the customer's own complaint /
  // ticket ref. Maps to assr_cases.ref_no; when left blank the create
  // endpoint falls back to the SO's pre-printed Ref (input.ref_no ?? ctx.Ref).
  const [issueNo, setIssueNo] = useState("");
  // Complaint date (assr_cases.complained_date) — owner ruling (2026-07):
  // it is stamped automatically to today (MYT) and is NOT user-editable.
  // Fixed value, no setter — kept as YYYY-MM-DD (the format the backend's
  // todayMyt() default also produces) so it flows straight into the payload.
  const [complainedDate] = useState<string>(() => todayMyt());
  // SO line-item lookup — once an SO is chosen, offer its items so the
  // Product field is a picker (GET /api/assr/lookup-items/:docNo), not free
  // text. Staff can still type a custom code if the item isn't listed.
  const { data: soItemsData } = useQuery({
    queryKey: ["mobile-assr-so-items", docNo],
    enabled: !!docNo,
    staleTime: 60_000,
    queryFn: () => api.get<{ items?: Any[] }>(`/api/assr/lookup-items/${encodeURIComponent(docNo)}`),
  });
  const soItems: Any[] = soItemsData?.items ?? [];

  // Existing-case duplicate warning (owner 2026-07-27) — same source as
  // desktop CreatePanel: once an SO is chosen, list its non-archived
  // cases so intake adds to one of those instead of raising a duplicate.
  const { data: soCasesData } = useQuery({
    queryKey: ["mobile-assr-so-cases", docNo],
    enabled: !!docNo,
    staleTime: 30_000,
    queryFn: () => api.get<{ cases?: Any[] }>(`/api/assr/so-cases/${encodeURIComponent(docNo)}`),
  });
  const existingSoCases: Any[] = soCasesData?.cases ?? [];

  const pickSo = (hit: SoHit) => {
    setSoPicked(hit);
    setDocNo(String(get(hit, "docNo", "doc_no") ?? "").trim());
    setSoQuery("");
    // Different SO → its items no longer apply; start the pick list fresh.
    setSelItems([]);
    setManualCode("");
  };
  const clearSo = () => { setSoPicked(null); setDocNo(""); setSoQuery(""); setSelItems([]); setManualCode(""); };

  // ── multi-item helpers ──
  const addSelItem = (item: SelItem) => {
    setSelItems((prev) =>
      prev.some((it) => it.item_code === item.item_code) ? prev : [...prev, item],
    );
  };
  const removeSelItem = (code: string) =>
    setSelItems((prev) => prev.filter((it) => it.item_code !== code));
  const setSelQty = (code: string, qty: number) =>
    setSelItems((prev) => prev.map((it) => (it.item_code === code ? { ...it, qty: Math.max(1, qty) } : it)));
  // SO items not yet on the pick list (dropdown adder source).
  const remainingSoItems = soItems.filter(
    (it) => !selItems.some((s) => s.item_code === String(get(it, "itemCode", "item_code") ?? "")),
  );
  // Defect photos/videos staged locally, uploaded after the case is
  // created (attachments require the case id). Up to 5, matching the design.
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

  const addPicked = (picked: File[]) => {
    const ok = picked.filter((f) =>
      ATTACH_EXTS.has((f.name.split(".").pop() || "").toLowerCase()),
    );
    setFiles((prev) => [...prev, ...ok].slice(0, 5));
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    addPicked(Array.from(e.target.files ?? []));
    e.target.value = "";
  };

  // Drop / paste to attach — the sheet's card already advertises
  // "drag, drop, or paste"; the sheet is the only mounted upload target,
  // so a file paste anywhere routes into the defect-photos list. A drop
  // that misses the card must not navigate the SPA away.
  useStrayFileDropGuard();
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const blobs = clipboardFiles(e);
      if (blobs.length === 0) return;
      e.preventDefault();
      addPicked(blobs);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // addPicked is stable enough — functional setFiles + module consts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = useMutation({
    mutationFn: async () => {
      // Match desktop CreatePanel EXACTLY: POST /api/assr (NO trailing
      // slash — the slash 404s) with an `items` array of
      // { item_code, item_description, qty }, NOT a singular `item_code`
      // string. Backend accepts both, but keeping the shape identical to
      // desktop guarantees a mobile-created case lands the same rows and
      // shows up on desktop (owner's acceptance test).
      const res = await api.post<{ id: number; assr_no?: string }>("/api/assr", {
        doc_no: docNo.trim(),
        // Multi-item: every picked row lands as its own assr_items row with
        // its chosen qty — identical shape to desktop CreatePanel's submit.
        items: selItems.map((it) => ({
          item_code: it.item_code,
          item_description: it.item_description,
          qty: it.qty > 0 ? it.qty : 1,
        })),
        complaint_issue: complaint.trim(),
        issue_category: category.trim() || null,
        // Priority is no longer picked at intake (Nick 2026-07-14) —
        // the backend defaults to "normal"; adjust on the case page.
        // Empty string must NOT reach the server — it would beat the
        // `?? context.Ref` SO-reference fallback.
        ref_no: issueNo.trim() || null,
        // Complaint date — the backend defaults this to today (MYT) when
        // omitted; we always send the (defaulted-to-today, user-editable)
        // value so the intake date is honoured. Sent as YYYY-MM-DD.
        complained_date: complainedDate || null,
      });
      const id = Number(get(res ?? {}, "id"));
      // Upload staged defect photos/videos as "complaint" attachments.
      // WO-7: uploadAssrAttachment compresses photos + uploads their thumbs.
      if (id && files.length) {
        setUploadProgress({ done: 0, total: files.length });
        let failed = 0;
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          try {
            await uploadAssrAttachment(id, file, "complaint");
          } catch {
            failed++;
          }
          setUploadProgress({ done: i + 1, total: files.length });
        }
        setUploadProgress(null);
        if (failed) await notify({ title: "Case created", body: `${failed} of ${files.length} files failed to upload.`, tone: "error" });
      }
      return res;
    },
    onSuccess: (res) => {
      // Refresh the cases list so the just-created case shows immediately.
      // `refetchType: "all"` forces even the (about-to-unmount) list query
      // to refetch, so a fresh row is present whether the user lands on the
      // detail page and taps back, or returns to the list directly.
      qc.invalidateQueries({ queryKey: ["mobile-assr-list-paged"], refetchType: "all" });
      const id = Number(get(res ?? {}, "id"));
      onClose();
      if (id) onOpen(id);
    },
    onError: async (e: any) => {
      // Duplicate-open-case guard (owner 2026-07-22) — the server returns 409
      // with { error: 'duplicate_open_case', message, existing:[...] } when
      // any picked item is already attached to an open case on this SO.
      const errCode = e?.response?.body?.error ?? e?.body?.error;
      const errMsg  = e?.response?.body?.message ?? e?.body?.message;
      if (errCode === 'duplicate_open_case' && typeof errMsg === 'string') {
        await notify({ title: "Duplicate case", body: errMsg, tone: "error" });
      }
    },
  });

  // Issue category is REQUIRED (owner ruling 2026-07-19): the field already
  // carries a "*" marker, so the submit gate must actually block on it — same
  // greyed-out disabled Create button the other required fields use.
  //
  // Items MAY be empty (owner 2026-07-22) — driver-damaged floor, lorry
  // problem etc. don't tie to a specific product. Dropped from the gate.
  const valid = docNo.trim() && complaint.trim() && complainedDate.trim() && category.trim();

  // FIXED + z-index 40 (the .sheet-bd pattern) — NOT absolute/z20. When
  // Service is the active TAB this sheet renders inside the tab-content
  // div, and the floating tab bar (.navwrap, absolute bottom, z-index 30)
  // would otherwise sit ON TOP of the sheet's bottom actbar, hiding the
  // Create button entirely (owner: "no way to create"). Fixed + 40 lifts
  // the whole sheet above the tab bar, exactly like the Menu sheet.
  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(17,20,15,.4)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--app-bg)", borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: "92%", display: "flex", flexDirection: "column", paddingBottom: "env(safe-area-inset-bottom)" }}>
        {/* header (.hdr) — design: eyebrow "Document" + title, top-right × close */}
        <header className="hdr" style={{ borderTopLeftRadius: 18, borderTopRightRadius: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div className="eyebrow">Document</div>
              <div className="scr-title" style={{ marginTop: 2 }}>New Service Case</div>
            </div>
            <span onClick={onClose} role="button" aria-label="Close" style={{ fontSize: 24, color: MUTED, cursor: "pointer", lineHeight: 1 }}>×</span>
          </div>
        </header>

        <div className="scroll hz-scroll" style={{ padding: 14 }}>
          {/* ── Sales Order card (.so-card) — SO lookup + affected product ── */}
          <div className="so-card">
            <div className="so-hd"><h2 className="so-ti">Sales Order</h2></div>
            <div className="so-bd">
              {/* SO picker — real search-so lookup, presented as the design's
                  "SO # / reference / customer" field + Lookup affordance. */}
              <div className="fld" style={{ position: "relative" }}>
                <span className="fld-l">SO # / reference / customer *</span>
                {soPicked ? (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, border: `1px solid ${TEAL}`, borderRadius: 10, padding: "9px 11px", background: FIELD_BG }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="money" style={{ fontSize: 12, fontWeight: 700, color: INK }}>{String(get(soPicked, "docNo", "doc_no"))}</div>
                        <div style={{ fontSize: 11, color: MUTED, ...cellEllipsis }}>{String(get(soPicked, "debtorName", "debtor_name") ?? "—")}</div>
                      </div>
                      <button onClick={clearSo} aria-label="Change SO" className="tinybtn" style={{ flex: "none", padding: "3px 9px" }}>Change</button>
                    </div>
                    {/* Existing-case warning — tap a row to jump to that case
                        (closes this sheet) instead of raising a duplicate. */}
                    {existingSoCases.length > 0 && (
                      <div style={{ marginTop: 7, border: `1px solid ${WARN}`, background: WARN_BG, borderRadius: 10, padding: "8px 10px" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: WARN }}>
                          ⚠ This order already has {existingSoCases.length} service case{existingSoCases.length > 1 ? "s" : ""}
                        </div>
                        {existingSoCases.map((ec) => (
                          <button
                            key={Number(get(ec, "id"))}
                            onClick={() => { onClose(); onOpen(Number(get(ec, "id"))); }}
                            style={{ display: "block", width: "100%", textAlign: "left", border: `1px solid ${DIM}`, borderRadius: 8, background: "#fff", padding: "7px 9px", marginTop: 6, cursor: "pointer" }}
                          >
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                              <span className="money" style={{ fontSize: 11, fontWeight: 700, color: INK }}>{String(get(ec, "assrNo", "assr_no"))}</span>
                              <span style={{ flex: "none", fontSize: 10, fontWeight: 600, color: MUTED }}>{prettyStage(String(get(ec, "stage") ?? ""))}</span>
                            </div>
                            <div style={{ fontSize: 10.5, color: MUTED, marginTop: 2, ...cellEllipsis }}>
                              {dm(get(ec, "complainedDate", "complained_date") ?? get(ec, "createdAt", "created_at"))}
                              {get(ec, "createdByName", "created_by_name") ? ` · by ${String(get(ec, "createdByName", "created_by_name"))}` : ""}
                              {get(ec, "complaintIssue", "complaint_issue") ? ` · ${String(get(ec, "complaintIssue", "complaint_issue"))}` : ""}
                            </div>
                          </button>
                        ))}
                        <div style={{ fontSize: 10, color: MUTED, marginTop: 6 }}>
                          Add to the existing case instead of creating a duplicate — only continue for a genuinely new issue.
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <input value={soQuery} onChange={(e) => setSoQuery(e.target.value)} placeholder="SO #, reference, or customer name…" className="fld-i money" />
                    {soQuery.trim().length >= 2 && (
                      <div style={{ marginTop: 5, border: `1px solid ${DIM}`, borderRadius: 10, overflow: "hidden", maxHeight: 190, overflowY: "auto" }} className="hz-scroll">
                        {soLoading && <div style={{ fontSize: 11, color: GREY, padding: "9px 11px" }}>Searching…</div>}
                        {!soLoading && !soResults.length && <div style={{ fontSize: 11, color: GREY, padding: "9px 11px" }}>No matching sales orders.</div>}
                        {soResults.map((hit, i) => (
                          <button
                            key={String(get(hit, "docNo", "doc_no")) + i}
                            onClick={() => pickSo(hit)}
                            style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderTop: i ? "1px solid #eceee9" : "none", background: "#fff", padding: "9px 11px", cursor: "pointer" }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span className="money" style={{ fontSize: 12, fontWeight: 700, color: INK }}>{String(get(hit, "docNo", "doc_no"))}</span>
                              {Number(get(hit, "caseCount", "case_count") ?? 0) > 0 && (
                                <span style={{ flex: "none", fontSize: 10, fontWeight: 700, color: WARN, background: WARN_BG, borderRadius: 6, padding: "1px 6px" }}>
                                  {Number(get(hit, "caseCount", "case_count"))} case{Number(get(hit, "caseCount", "case_count")) > 1 ? "s" : ""}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: MUTED, ...cellEllipsis }}>{String(get(hit, "debtorName", "debtor_name") ?? "—")}{get(hit, "phone") ? ` · ${formatPhone(get(hit, "phone"))}` : ""}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
              {/* Affected products — MULTISELECT rows with a per-product qty
                  stepper (owner: sometimes 1 product, sometimes several).
                  Backend requires at least one item; each row posts as its
                  own assr_items entry, same as desktop CreatePanel. */}
              <div className="fld">
                <span className="fld-l">Affected products * ({selItems.length})</span>
                {selItems.map((it) => (
                  <div key={it.item_code} style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${DIM}`, borderRadius: 10, padding: "8px 10px", marginBottom: 6, background: "#fff" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="money" style={{ fontSize: 11, fontWeight: 700, color: BROWN, wordBreak: "break-word" }}>{it.item_code}</div>
                      {it.item_description && <div style={{ fontSize: 11, color: MUTED, marginTop: 1, ...cellEllipsis }}>{it.item_description}</div>}
                    </div>
                    {/* qty stepper — min 1 */}
                    <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 0, border: `1px solid ${DIM}`, borderRadius: 8, overflow: "hidden" }}>
                      <button
                        onClick={() => setSelQty(it.item_code, it.qty - 1)}
                        disabled={it.qty <= 1}
                        aria-label="Decrease quantity"
                        style={{ width: 26, height: 28, border: "none", background: FIELD_BG, color: it.qty <= 1 ? GREY : INK, fontSize: 15, lineHeight: 1, cursor: it.qty <= 1 ? "default" : "pointer" }}
                      >
                        −
                      </button>
                      <span className="money" style={{ minWidth: 24, textAlign: "center", fontSize: 12, fontWeight: 700, color: INK }}>{it.qty}</span>
                      <button
                        onClick={() => setSelQty(it.item_code, it.qty + 1)}
                        aria-label="Increase quantity"
                        style={{ width: 26, height: 28, border: "none", background: FIELD_BG, color: INK, fontSize: 15, lineHeight: 1, cursor: "pointer" }}
                      >
                        +
                      </button>
                    </div>
                    <button
                      onClick={() => removeSelItem(it.item_code)}
                      aria-label="Remove product"
                      style={{ flex: "none", width: 26, height: 26, borderRadius: 8, border: `1px solid ${DIM}`, background: "#fff", color: RED, fontSize: 15, lineHeight: 1, cursor: "pointer" }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {/* Adder — SO line-item picker when the SO has items left to
                    add; a select that appends a row on choose. */}
                {remainingSoItems.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const code = e.target.value;
                      if (!code) return;
                      const hit = soItems.find((it) => String(get(it, "itemCode", "item_code") ?? "") === code);
                      const soQty = Number(get(hit ?? {}, "qty") ?? 0);
                      addSelItem({
                        item_code: code,
                        item_description: hit ? (get(hit, "itemDescription", "item_description") as string | undefined) ?? null : null,
                        qty: soQty > 0 ? soQty : 1,
                      });
                    }}
                    className="fld-i money"
                  >
                    <option value="">+ Add product from this SO…</option>
                    {remainingSoItems.map((it, i) => {
                      const code = String(get(it, "itemCode", "item_code") ?? "");
                      const desc = get(it, "itemDescription", "item_description");
                      return <option key={code + i} value={code}>{code}{desc ? ` — ${String(desc)}` : ""}</option>;
                    })}
                  </select>
                )}
                {/* Free-text adder — kept for SOs whose lookup returns no
                    items: type a code, tap Add (qty starts at 1). */}
                {!soItems.length && (
                  <div style={{ display: "flex", gap: 7 }}>
                    <input
                      value={manualCode}
                      onChange={(e) => setManualCode(e.target.value)}
                      placeholder="Affected item code — e.g. AK-GUARDIAN MATT (K)"
                      className="fld-i money"
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button
                      onClick={() => {
                        const code = manualCode.trim();
                        if (!code) return;
                        addSelItem({ item_code: code, item_description: null, qty: 1 });
                        setManualCode("");
                      }}
                      disabled={!manualCode.trim()}
                      className="tinybtn"
                      style={{ flex: "none", padding: "0 14px", opacity: manualCode.trim() ? 1 : 0.5 }}
                    >
                      Add
                    </button>
                  </div>
                )}
                {!selItems.length && (
                  <div style={{ fontSize: 10, color: GREY, marginTop: 4 }}>Add at least one affected product. Adjust the quantity per product with − / +.</div>
                )}
              </div>
            </div>
          </div>

          {/* ── Issue card (.so-card) — description, category, priority ── */}
          <div className="so-card">
            <div className="so-hd"><h2 className="so-ti">Issue</h2></div>
            <div className="so-bd">
              <label className="fld">
                <span className="fld-l">Issue description *</span>
                <textarea value={complaint} onChange={(e) => setComplaint(e.target.value)} rows={3} placeholder="Describe the issue…" className="fld-i" style={{ resize: "none" }} />
              </label>
              <label className="fld">
                <span className="fld-l">Issue category *</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="fld-i">
                  <option value="">— select —</option>
                  {issueCatOptions.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </label>
              <label className="fld">
                <span className="fld-l">Issue number</span>
                <input
                  value={issueNo}
                  onChange={(e) => setIssueNo(e.target.value)}
                  placeholder="Customer complaint / ticket ref"
                  className="fld-i money"
                />
              </label>
              {/* Complaint date — assr_cases.complained_date. Owner ruling:
                  automatic + read-only, always today (MYT). Rendered as a
                  disabled field so the user cannot change it; the fixed
                  today value still flows into the payload below. */}
              <label className="fld">
                <span className="fld-l">Complaint date</span>
                <input
                  type="text"
                  value={dm(complainedDate)}
                  readOnly
                  disabled
                  className="fld-i money"
                />
              </label>
            </div>
          </div>

          {/* ── Defect photos / videos card (.so-card) — up to 5, uploaded after create ── */}
          <div className="so-card">
            <div className="so-hd"><h2 className="so-ti">Defect photos / videos</h2><span className="so-sub">{files.length} / 5</span></div>
            <div className="so-bd">
              <UploadDropZone disabled={files.length >= 5} onFiles={addPicked}>
              {files.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7 }}>
                  {files.map((f, i) => (
                    <div key={i} style={{ position: "relative", aspectRatio: "1", borderRadius: 9, overflow: "hidden", background: FIELD_BG, border: `1px solid ${DIM}`, display: "flex", alignItems: "center", justifyContent: "center", padding: 4 }}>
                      <span style={{ fontSize: 9, color: MUTED, textAlign: "center", wordBreak: "break-word", lineHeight: 1.2 }}>{f.name}</span>
                      <button
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        aria-label="Remove file"
                        style={{ position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(17,20,15,.55)", color: "#fff", fontSize: 13, lineHeight: 1, cursor: "pointer" }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {files.length < 5 && (
                <label style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, border: "1px dashed #c2c6bd", borderRadius: 11, padding: 18, background: FIELD_BG, cursor: "pointer" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={TEAL} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4M7 9l5-5 5 5" /><path d="M5 20h14" /></svg>
                  <span style={{ fontSize: 13, fontWeight: 700, color: TEAL }}>Add Photos / Videos</span>
                  <input type="file" accept={ATTACH_ACCEPT} multiple style={{ display: "none" }} onChange={onPickFiles} />
                </label>
              )}
              <div style={{ fontSize: 10, color: GREY, marginTop: 7, textAlign: "center" }}>JPG / PNG / WEBP / MP4 / PDF · 5MB each · up to 5 files · drag, drop, or paste</div>
              </UploadDropZone>
            </div>
          </div>

          {create.isError && <div style={{ fontSize: 12, color: "var(--red)" }}>Couldn't create the case. Check the SO number and try again.</div>}
        </div>

        {/* actbar (.actbar / .btn) */}
        <footer className="actbar">
          <button
            onClick={() => valid && create.mutate()}
            disabled={!valid || create.isPending}
            className="btn"
            style={{ background: valid ? TEAL : "#c9c1b4", cursor: valid ? "pointer" : "default" }}
          >
            {create.isPending
              ? uploadProgress
                ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                : "Creating…"
              : "Create Service Case"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── shared inline helpers ─────────────────────────────────────────
const cellEllipsis: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

// ── small building blocks ─────────────────────────────────────────

// .pacc accordion (native <details>) — brown uppercase .psec-t title, chevron,
// optional left accent border, optional right note / slot.
function Acc({
  title,
  children,
  open,
  accent,
  note,
  headRight,
  headSlot,
}: {
  title: string;
  children: React.ReactNode;
  open?: boolean;
  accent?: string;
  note?: string;
  headRight?: string;
  headSlot?: React.ReactNode;
}) {
  return (
    <details className="pacc" open={open} style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <summary>
        <span className="psec-t">{title}</span>
        {/* first right-side element gets the auto margin so it hugs the right */}
        {note && <span style={{ marginLeft: "auto", fontSize: 10, color: GREY }}>{note}</span>}
        {headRight && <span style={{ marginLeft: note ? 0 : "auto", fontSize: 11, fontWeight: 600, color: INK }}>{headRight}</span>}
        {headSlot && <span style={{ marginLeft: note || headRight ? 8 : "auto", display: "inline-flex" }}>{headSlot}</span>}
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: note || headRight || headSlot ? 0 : "auto" }}><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">{children}</div>
    </details>
  );
}

// key/value row inside an accordion.
function KV({ label, value, multiline, mono }: { label: string; value: string; multiline?: boolean; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderTop: `1px solid #f4f5f2` }}>
      <span style={{ fontSize: 11, color: MUTED, flex: "none" }}>{label}</span>
      <span className={mono ? "money" : undefined} style={{ fontSize: 12.5, fontWeight: 600, color: INK, textAlign: multiline ? "left" : "right", whiteSpace: multiline ? "pre-line" : "nowrap", overflow: "hidden", textOverflow: multiline ? undefined : "ellipsis", lineHeight: multiline ? 1.45 : undefined }}>{value}</span>
    </div>
  );
}

// .pgrid2 cell (.pkv-l label above .pkv-v value).
function PGrid({ label, value, mono, span, multiline }: { label: string; value: string; mono?: boolean; span?: boolean; multiline?: boolean }) {
  return (
    <div style={span ? { gridColumn: "1 / -1" } : undefined}>
      <div className="pkv-l">{label}</div>
      <div className={`pkv-v${mono ? " money" : ""}`} style={{ lineHeight: multiline ? 1.4 : undefined, fontSize: multiline ? 12 : undefined, fontWeight: multiline ? 600 : undefined, wordBreak: "break-word", whiteSpace: multiline ? "pre-line" : undefined }}>{value}</div>
    </div>
  );
}

// Sub-status switcher (小类, Nick 2026-07-15) — directly switchable
// toggle inside the case's CURRENT stage card; PATCHes sub_status.
function StageSubChip({ c, stage, busy, disabled, patchCase }: {
  c: Any;
  stage: string;
  busy: boolean;
  disabled?: boolean;
  patchCase: (body: Record<string, unknown>, err: string) => void;
}) {
  if (stageOf(c) !== stage) return null;
  const opts = ASSR_SUB_STATUSES[stage];
  if (!opts) return null;
  const cur = assrSubStatus(stage, String(get(c, "subStatus", "sub_status") ?? "") || null);
  return (
    <>
      <div className="fld-l">Sub-status</div>
      <div style={{ display: "flex", gap: 7, margin: "6px 0 10px", flexWrap: "wrap" }}>
        {opts.map((o) => {
          const active = cur?.key === o.key;
          return (
            <button
              key={o.key}
              onClick={() => { if (!disabled && !active) patchCase({ sub_status: o.key }, "Couldn't switch sub-status"); }}
              disabled={disabled || busy}
              className="tinybtn"
              style={active ? { background: BROWN, borderColor: BROWN, color: "#fff" } : undefined}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

// timeline audience badge colour (rbadge — 12% tint of the category hue).
function catBadge(cat: string): [string, string] {
  switch (cat) {
    case "SERVICE": return ["#16695f1f", TEAL];
    case "CUSTOMER": return ["#2f8a5b1f", GREEN];
    case "SUPPLIER": return ["#a16a2e1f", BROWN];
    case "SALES": return ["#1f3a8a1f", BLUE];
    // Legacy rows from before mig 0108 (all migrated, but a cached
    // payload may still carry it briefly).
    case "PURCHASING": return ["#16695f1f", TEAL];
    case "SYSTEM": return ["#5c61661f", GREY];
    default: return ["#16695f1f", TEAL];
  }
}

// ── Editable accordion (Edit → Save) ──────────────────────────────
// Read view mirrors the design's KV rows; tapping "Edit" swaps in the
// field inputs + a Save/Cancel actbar. Save posts ONLY the changed
// fields (dropping unchanged ones) so PATCH /:id never rewrites a
// column the user didn't touch. All values are strings; "" is sent as
// null-equivalent (the endpoint stores `?? null`).
type EditField = {
  key: string;
  label: string;
  value: any;
  type: "text" | "textarea" | "date" | "select" | "so";
  options?: { value: string; label: string }[];
};

// SO input with the create-sheet's typeahead (Nick 2026-07-14 — editing
// the SO must search like the create form). Picking a hit fills the
// draft; EditableAcc's Save then PATCHes doc_no and the backend
// re-matches customer info. Unknown values (post-disconnect SOs) still
// save as typed.
function SoSearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false);
  const { results, loading } = useSoSearch(focused ? value : "");
  const open = focused && value.trim().length >= 2 && (loading || results.length > 0);
  return (
    <div style={{ position: "relative" }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="SO #, reference, or customer name…"
        className="fld-i money"
        style={{ width: "100%", boxSizing: "border-box" }}
      />
      {open && (
        <div className="hz-scroll" style={{ position: "absolute", left: 0, right: 0, top: "100%", marginTop: 4, zIndex: 30, border: `1px solid ${DIM}`, borderRadius: 10, background: "#fff", maxHeight: 190, overflowY: "auto", boxShadow: "0 10px 24px -10px rgba(17,24,16,.35)" }}>
          {loading && <div style={{ fontSize: 11, color: GREY, padding: "9px 11px" }}>Searching…</div>}
          {!loading && !results.length && <div style={{ fontSize: 11, color: GREY, padding: "9px 11px" }}>No matching sales orders.</div>}
          {results.map((hit, i) => (
            <button
              key={String(get(hit, "docNo", "doc_no")) + i}
              onMouseDown={(e) => { e.preventDefault(); onChange(String(get(hit, "docNo", "doc_no") ?? "")); setFocused(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderTop: i ? "1px solid #eceee9" : "none", background: "#fff", padding: "9px 11px", cursor: "pointer" }}
            >
              <div className="money" style={{ fontSize: 12, fontWeight: 700, color: INK }}>{String(get(hit, "docNo", "doc_no"))}</div>
              <div style={{ fontSize: 11, color: MUTED, ...cellEllipsis }}>{String(get(hit, "debtorName", "debtor_name") ?? "—")}{get(hit, "phone") ? ` · ${formatPhone(get(hit, "phone"))}` : ""}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EditableAcc({
  title,
  fields,
  onSave,
  busy,
  open,
  accent,
  note,
  headSlot,
  readView,
  children,
}: {
  title: string;
  fields: EditField[];
  onSave: (body: Record<string, any>) => Promise<void>;
  busy: boolean;
  open?: boolean;
  accent?: string;
  note?: string;
  headSlot?: React.ReactNode;
  /** Replaces the default read view (KV rows + children) — the fields
   *  still drive the edit view. Used by the Customer card so its read
   *  state matches the desktop design (avatar, chips, call button). */
  readView?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of fields) {
      const v = f.type === "date" ? isoDateOnly(f.value) : f.value;
      m[f.key] = v == null ? "" : String(v);
    }
    return m;
  }, [fields]);
  const [draft, setDraft] = useState<Record<string, string>>(initial);

  const startEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraft(initial);
    setEditing(true);
  };
  const cancel = () => setEditing(false);
  const save = async () => {
    const body: Record<string, any> = {};
    for (const f of fields) {
      const next = (draft[f.key] ?? "").trim();
      if (next !== (initial[f.key] ?? "")) body[f.key] = next === "" ? null : next;
    }
    if (Object.keys(body).length === 0) { setEditing(false); return; }
    await onSave(body);
    setEditing(false);
  };

  return (
    <details className="pacc" open={open || editing} style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}>
      <summary>
        <span className="psec-t">{title}</span>
        {note && !editing && <span style={{ marginLeft: "auto", fontSize: 10, color: GREY, marginRight: 8 }}>{note}</span>}
        {headSlot && !editing && <span style={{ marginLeft: note ? 0 : "auto", marginRight: 8, display: "inline-flex" }}>{headSlot}</span>}
        {!editing && (
          <span onClick={startEdit} className="tinybtn" style={{ marginLeft: note || headSlot ? 0 : "auto" }}>Edit</span>
        )}
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </summary>
      <div className="pbody">
        {editing ? (
          <>
            {fields.map((f) => (
              <label key={f.key} className="fld">
                <span className="fld-l">{f.label}</span>
                {f.type === "textarea" ? (
                  <textarea
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    rows={3}
                    className="fld-i"
                    style={{ resize: "none" }}
                  />
                ) : f.type === "select" ? (
                  <select
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="fld-i"
                  >
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : f.type === "so" ? (
                  <SoSearchField
                    value={draft[f.key] ?? ""}
                    onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                  />
                ) : (
                  <input
                    type={f.type === "date" ? "date" : "text"}
                    value={draft[f.key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    className="fld-i"
                  />
                )}
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button onClick={cancel} disabled={busy} className="tinybtn" style={{ flex: 1, padding: 9 }}>Cancel</button>
              <button
                onClick={save}
                disabled={busy}
                className="tinybtn"
                style={{ flex: 1, padding: 9, background: TEAL, borderColor: TEAL, color: "#fff", opacity: busy ? 0.6 : 1 }}
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        ) : readView ? (
          readView
        ) : (
          <>
            {fields.map((f) => (
              <KV key={f.key} label={f.label} value={fieldDisplay(f)} multiline={f.type === "textarea"} />
            ))}
            {children}
          </>
        )}
      </div>
    </details>
  );
}

// Read-view rendering for an EditField (date formatting, select label,
// dash for empty).
function fieldDisplay(f: EditField): string {
  const raw = f.value;
  if (raw == null || raw === "") return "—";
  if (f.type === "date") return dm(raw);
  if (f.type === "select") {
    const opt = (f.options ?? []).find((o) => o.value === String(raw));
    return opt ? opt.label : String(raw);
  }
  return String(raw);
}

// The ISO YYYY-MM-DD DateField's `value` takes; display is DateField's job.
function isoDateOnly(v: any): string {
  const s = String(v ?? "");
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const dt = new Date(s);
  return s && !isNaN(+dt) ? dt.toISOString().slice(0, 10) : "";
}

// ── Single-field inline edit row (Info stage panels) ──────────────
// Read view is a KV row; tapping it swaps in the input + Save/Cancel.
// Saves null for a cleared value (PATCH stores `?? null`).
function EditRow({
  label,
  value,
  type = "text",
  options,
  mono,
  busy,
  disabled,
  onSave,
}: {
  label: string;
  value: any;
  type?: "text" | "date" | "textarea" | "select";
  options?: { value: string; label: string }[];
  mono?: boolean;
  busy: boolean;
  disabled?: boolean;
  onSave: (v: string | null) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const start = () => {
    if (disabled) return;
    setDraft(type === "date" ? isoDateOnly(value) : value == null ? "" : String(value));
    setEditing(true);
  };
  const save = async () => {
    const v = draft.trim();
    await onSave(v === "" ? null : v);
    setEditing(false);
  };
  if (!editing) {
    const display =
      value == null || value === ""
        ? "—"
        : type === "date"
        ? dm(value)
        : type === "select"
        ? options?.find((o) => o.value === String(value))?.label ?? String(value)
        : String(value);
    return (
      <div
        onClick={start}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "6px 0", borderTop: `1px solid #f4f5f2`, cursor: disabled ? "default" : "pointer" }}
      >
        <span style={{ fontSize: 11, color: MUTED, flex: "none" }}>{label}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span className={mono ? "money" : undefined} style={{ fontSize: 12.5, fontWeight: 600, color: INK, textAlign: "right", whiteSpace: type === "textarea" ? "normal" : "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{display}</span>
          {!disabled && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={GREY} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4Z" /></svg>
          )}
        </span>
      </div>
    );
  }
  return (
    <div style={{ padding: "6px 0", borderTop: `1px solid #f4f5f2` }}>
      <div className="fld-l" style={{ marginBottom: 4 }}>{label}</div>
      {type === "textarea" ? (
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="fld-i" style={{ resize: "none", width: "100%", boxSizing: "border-box" }} />
      ) : type === "select" ? (
        <select value={draft} onChange={(e) => setDraft(e.target.value)} className="fld-i" style={{ width: "100%" }}>
          {(options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : type === "date" ? (<DateField value={draft} onChange={setDraft} className={`fld-i${mono ? " money" : ""}`} fullWidth />
      ) : (
        <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} className={`fld-i${mono ? " money" : ""}`} style={{ width: "100%", boxSizing: "border-box" }} />
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button onClick={() => setEditing(false)} disabled={busy} className="tinybtn" style={{ flex: 1 }}>Cancel</button>
        <button onClick={save} disabled={busy} className="tinybtn" style={{ flex: 1, background: TEAL, borderColor: TEAL, color: "#fff", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Root cause inline field (Verification panel) — text input with a
// Save affordance that patches verified_root_cause. Kept separate from
// EditRow because the design renders it under the Outcome buttons.
function RootCauseField({ value, busy, onSave }: { value: any; busy: boolean; onSave: (v: string) => Promise<void> }) {
  const initial = value == null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  const [lastInitial, setLastInitial] = useState(initial);
  // Re-sync the draft when the underlying value changes (after a refetch)
  // and the user hasn't diverged from the previously-seen value.
  if (initial !== lastInitial) {
    setLastInitial(initial);
    setDraft(initial);
  }
  const dirty = draft.trim() !== initial.trim();
  return (
    <label className="fld">
      <span className="fld-l">Root cause</span>
      <div style={{ display: "flex", gap: 7 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="fld-i"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="Verified root cause"
        />
        {dirty && (
          <button
            onClick={() => onSave(draft.trim())}
            disabled={busy}
            className="tinybtn"
            style={{ flex: "none", background: TEAL, borderColor: TEAL, color: "#fff", opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "…" : "Save"}
          </button>
        )}
      </div>
    </label>
  );
}

// ── Attachment grid → PUT /:id/attachments?category=… ─────────────
// Shows the passed (pre-filtered) attachments as auth-fetched thumbnails
// (blob URLs) and lets staff capture / pick up to 5 more per batch, all
// tagged with `category`. Used for Issue photos (complaint), QC-issue
// photos (receipt_evidence) and after-repair QC photos (qc). Archive
// routes through the in-app confirm dialog (no naked delete).
function PhotoGrid({
  caseId,
  attachments,
  category,
  label,
  hint,
  accent = TEAL,
  onChanged,
  notify,
  confirm,
}: {
  caseId: number;
  attachments: Any[];
  category: string;
  label: string;
  hint?: string;
  accent?: string;
  onChanged: () => void;
  notify: ReturnType<typeof useNotify>;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadMany(picked);
  };

  const uploadMany = async (picked: File[]) => {
    if (!picked.length || uploading) return;
    const files = picked.slice(0, 5);
    // Guard extensions client-side to match the server allow-list.
    const rejected = files.filter((f) => !ATTACH_EXTS.has((f.name.split(".").pop() || "").toLowerCase()));
    const accepted = files.filter((f) => ATTACH_EXTS.has((f.name.split(".").pop() || "").toLowerCase()));
    if (!accepted.length) {
      await notify({ title: "Unsupported file", body: "Allowed: JPG, PNG, WEBP, MP4, MOV, WEBM, PDF.", tone: "error" });
      return;
    }
    setUploading({ done: 0, total: accepted.length });
    let failed = 0;
    for (let i = 0; i < accepted.length; i++) {
      const file = accepted[i];
      try {
        // WO-7: shared pipeline — compresses photos + uploads their thumbs.
        await uploadAssrAttachment(caseId, file, category);
      } catch {
        failed++;
      }
      setUploading({ done: i + 1, total: accepted.length });
    }
    setUploading(null);
    onChanged();
    if (failed || rejected.length) {
      await notify({
        title: failed ? "Some uploads failed" : "Some files skipped",
        body: `${accepted.length - failed} uploaded${failed ? `, ${failed} failed` : ""}${rejected.length ? `, ${rejected.length} unsupported skipped` : ""}.`,
        tone: failed ? "error" : "info",
      });
    }
  };

  const archive = async (att: Any) => {
    const attId = Number(get(att, "id"));
    if (!attId) return;
    if (!(await confirm({ title: "Remove this file?", confirmLabel: "Remove", danger: true }))) return;
    try {
      await api.post(`/api/assr/attachments/${attId}/archive`);
      onChanged();
    } catch (e: any) {
      await notify({ title: "Couldn't remove file", body: e?.message || "Please try again.", tone: "error" });
    }
  };

  // Toggle customer-portal visibility (mirror desktop ServiceCases:3406-3414).
  // A photo uploaded from the phone defaults to visible_to_customer=1, so
  // without this the case's evidence photos leak to the customer portal.
  const toggleVisibility = async (att: Any, visible: boolean) => {
    const attId = Number(get(att, "id"));
    if (!attId) return;
    try {
      await api.patch(`/api/assr/attachments/${attId}/visibility`, { visible_to_customer: visible });
      onChanged();
    } catch (e: any) {
      await notify({ title: "Couldn't update visibility", body: e?.message || "Please try again.", tone: "error" });
    }
  };

  return (
    <UploadDropZone disabled={!!uploading} onFiles={(files) => void uploadMany(files)}>
      <div className="fld-l" style={{ marginTop: 8 }}>{label} ({attachments.length})</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 6 }}>
        {attachments.map((att, i) => (
          <AttachThumb key={get(att, "id") ?? i} att={att} onArchive={() => archive(att)} onVisibility={(v) => toggleVisibility(att, v)} />
        ))}
        <label style={{ border: `1px dashed ${accent}`, borderRadius: 11, aspectRatio: "1", background: FIELD_BG, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.6 : 1 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
            <circle cx="12" cy="13" r="3" />
          </svg>
          <span style={{ fontSize: 9, fontWeight: 700, color: accent }}>{uploading ? `${uploading.done}/${uploading.total}` : "Add"}</span>
          <input
            ref={inputRef}
            type="file"
            accept={ATTACH_ACCEPT}
            multiple
            style={{ display: "none" }}
            disabled={!!uploading}
            onChange={onPick}
          />
        </label>
      </div>
      {hint && <div style={{ fontSize: 10.5, color: GREY, marginTop: 6 }}>{hint}</div>}
    </UploadDropZone>
  );
}

// Per-item remark — prints in the ITEMS table's REMARK column on both
// print copies (Nick 2026-07-15). Saves on blur; empty clears it.
// Per-item quantity stepper (Nick 2026-07-20) — − N + inline in the
// Product info card; saves immediately, feeds the print QTY column.
function MobileItemQty({ c, it, busy, onChanged, notify }: { c: Any; it: Any; busy: boolean; onChanged: () => void; notify: ReturnType<typeof useNotify> }) {
  const caseId = Number(get(c, "id"));
  const itemId = Number(get(it, "id"));
  const qty = Math.max(1, Number(get(it, "qty") ?? 1));
  const [saving, setSaving] = useState(false);
  const dis = busy || saving;
  const set = async (next: number) => {
    const clamped = Math.max(1, Math.round(next));
    if (clamped === qty || dis) return;
    setSaving(true);
    try {
      await api.patch(`/api/assr/${caseId}/items/${itemId}`, { qty: clamped });
      onChanged();
    } catch (e: any) {
      await notify({ title: "Couldn't update quantity", body: e?.message || "Please try again.", tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  const btn: React.CSSProperties = { flex: "none", width: 24, height: 26, border: "none", background: "transparent", color: INK, fontSize: 15, fontWeight: 700, lineHeight: 1, cursor: dis ? "default" : "pointer" };
  return (
    <div style={{ flex: "none", display: "flex", alignItems: "center", border: `1px solid ${DIM}`, borderRadius: 8, background: FIELD_BG }}>
      <button onClick={() => set(qty - 1)} disabled={dis || qty <= 1} aria-label="Decrease quantity" style={{ ...btn, opacity: dis || qty <= 1 ? 0.4 : 1 }}>−</button>
      <span className="money" style={{ minWidth: 20, textAlign: "center", fontSize: 12, fontWeight: 700, color: INK }}>{qty}</span>
      <button onClick={() => set(qty + 1)} disabled={dis} aria-label="Increase quantity" style={{ ...btn, opacity: dis ? 0.4 : 1 }}>+</button>
    </div>
  );
}

// Per-carton quantity (owner 2026-07-21, desktop c505d19f parity) — the
// second, user-selected "Ctn" count beside the per-set qty. PATCHes
// qty_carton and feeds the CTN column on both printed items tables
// (customer/office + supplier). Not logged to the timeline.
function MobileItemCarton({ c, it, busy, onChanged, notify }: { c: Any; it: Any; busy: boolean; onChanged: () => void; notify: ReturnType<typeof useNotify> }) {
  const caseId = Number(get(c, "id"));
  const itemId = Number(get(it, "id"));
  const qty = Math.max(1, Number(get(it, "qtyCarton", "qty_carton") ?? 1));
  const [saving, setSaving] = useState(false);
  const dis = busy || saving;
  const set = async (next: number) => {
    const clamped = Math.max(1, Math.round(next));
    if (clamped === qty || dis) return;
    setSaving(true);
    try {
      await api.patch(`/api/assr/${caseId}/items/${itemId}`, { qty_carton: clamped });
      onChanged();
    } catch (e: any) {
      await notify({ title: "Couldn't update carton quantity", body: e?.message || "Please try again.", tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  const btn: React.CSSProperties = { flex: "none", width: 24, height: 26, border: "none", background: "transparent", color: INK, fontSize: 15, fontWeight: 700, lineHeight: 1, cursor: dis ? "default" : "pointer" };
  return (
    <div style={{ flex: "none", display: "flex", alignItems: "center", border: `1px solid ${DIM}`, borderRadius: 8, background: FIELD_BG }}>
      <button onClick={() => set(qty - 1)} disabled={dis || qty <= 1} aria-label="Decrease cartons" style={{ ...btn, opacity: dis || qty <= 1 ? 0.4 : 1 }}>−</button>
      <span className="money" style={{ minWidth: 20, textAlign: "center", fontSize: 12, fontWeight: 700, color: INK }}>{qty}</span>
      <button onClick={() => set(qty + 1)} disabled={dis} aria-label="Increase cartons" style={{ ...btn, opacity: dis ? 0.4 : 1 }}>+</button>
    </div>
  );
}

// Audience-split (Nick 2026-07-21): field='remark' prints on the
// customer copy, 'supplier_remark' on the Supplier Service Order.
function MobileItemRemark({ c, it, busy, onChanged, notify, field, placeholder }: { c: Any; it: Any; busy: boolean; onChanged: () => void; notify: ReturnType<typeof useNotify>; field: "remark" | "supplier_remark"; placeholder: string }) {
  const caseId = Number(get(c, "id"));
  const itemId = Number(get(it, "id"));
  const camel = field === "supplier_remark" ? "supplierRemark" : "remark";
  const current = String(get(it, camel, field) ?? "");
  const [draft, setDraft] = useState(current);
  useEffect(() => {
    setDraft(String(get(it, camel, field) ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, field]);
  const commit = async () => {
    if (draft.trim() === current.trim()) return;
    try {
      await api.patch(`/api/assr/${caseId}/items/${itemId}`, { [field]: draft.trim() || null });
      onChanged();
    } catch (e: any) {
      await notify({ title: "Couldn't save remark", body: e?.message || "Please try again.", tone: "error" });
    }
  };
  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      disabled={busy}
      placeholder={placeholder}
      rows={2}
      className="fld-i"
      style={{ width: "100%", boxSizing: "border-box", marginTop: 8, fontSize: 11.5, resize: "vertical", lineHeight: 1.35 }}
    />
  );
}

// Supplier (creditor) picker — search the local creditors mirror and
// hand-link a supplier when AutoCount has no MainSupplier, or register
// a new one. Manual picks set creditor_source='manual' so the
// auto-resolver won't overwrite them.
function MobileSupplierPick({ c, onChanged, notify, disabled }: { c: Any; onChanged: () => void; notify: ReturnType<typeof useNotify>; disabled?: boolean }) {
  const { user } = useAuth();
  const caseId = Number(get(c, "id"));
  const code = get(c, "creditorCode", "creditor_code");
  const name = get(c, "creditorName", "creditor_name");
  const manual = String(get(c, "creditorSource", "creditor_source") ?? "") === "manual";
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Any[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");

  useEffect(() => {
    if (!open || adding) return;
    const h = setTimeout(async () => {
      try {
        const res = await api.get<{ results: Any[] }>(`/api/assr/creditors/search?q=${encodeURIComponent(q.trim())}`);
        setResults(res.results ?? []);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [q, open, adding]);

  // Supplier identity is office + supplier-portal only — the server
  // strips creditor fields for sales-scoped callers; hide the card.
  if (isSalesStaff(user)) return null;

  const assign = async (v: string | null) => {
    setBusy(true);
    try {
      await api.post(`/api/assr/${caseId}/set-creditor`, { creditor_code: v });
      setOpen(false);
      setAdding(false);
      onChanged();
    } catch (e: any) {
      await notify({ title: "Couldn't set supplier", body: e?.message || "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const createAndAssign = async () => {
    if (!newName.trim()) {
      await notify({ title: "Supplier name is required", body: "Enter a name before creating.", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ creditor_code: string }>(`/api/assr/creditors/create`, {
        company_name: newName.trim(),
        creditor_code: newCode.trim() || undefined,
      });
      await api.post(`/api/assr/${caseId}/set-creditor`, { creditor_code: res.creditor_code });
      setOpen(false);
      setAdding(false);
      setNewName("");
      setNewCode("");
      onChanged();
    } catch (e: any) {
      await notify({ title: "Couldn't create supplier", body: e?.message || "Please try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fld-l" style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Supplier</span>
        {!disabled && (
          <button onClick={() => setOpen((v) => !v)} style={{ border: "none", background: "none", color: TEAL, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 }}>
            {open ? "Close" : code ? "Change" : "Set supplier"}
          </button>
        )}
      </div>
      {code ? (
        <div style={{ display: "flex", alignItems: "center", gap: 9, border: `1px solid ${DIM}`, borderRadius: 10, padding: "10px 11px", marginTop: 5 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>{String(name ?? code)}</div>
            <div className="money" style={{ fontSize: 10, color: GREY }}>{String(code)}{manual ? " · manual" : ""}</div>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: GREY, marginTop: 5 }}>No supplier linked.</div>
      )}
      {open && (
        <div style={{ border: `1px solid ${DIM}`, borderRadius: 10, padding: 10, marginTop: 6, background: FIELD_BG }}>
          {!adding ? (
            <>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search supplier name or code…" className="fld-i" style={{ width: "100%", boxSizing: "border-box" }} />
              <div className="hz-scroll" style={{ maxHeight: 170, overflowY: "auto", marginTop: 6 }}>
                {results.map((r, i) => (
                  <button key={String(get(r, "creditor_code")) + i} disabled={busy} onClick={() => assign(String(get(r, "creditor_code")))} style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderTop: i ? `1px solid ${DIM}` : "none", background: "none", padding: "8px 2px", cursor: "pointer" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: INK }}>{String(get(r, "company_name") ?? get(r, "creditor_code"))}</div>
                    <div className="money" style={{ fontSize: 10, color: GREY }}>{String(get(r, "creditor_code"))}</div>
                  </button>
                ))}
                {!results.length && <div style={{ fontSize: 11, color: GREY, padding: "8px 2px" }}>No suppliers match.</div>}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                <button onClick={() => setAdding(true)} style={{ border: "none", background: "none", color: TEAL, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 }}>+ New supplier</button>
                {code ? <button disabled={busy} onClick={() => assign(null)} style={{ border: "none", background: "none", color: GREY, fontSize: 11, cursor: "pointer", padding: 0 }}>Unlink</button> : null}
              </div>
            </>
          ) : (
            <>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Supplier name *" className="fld-i" style={{ width: "100%", boxSizing: "border-box" }} />
              <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="Creditor code (optional)" className="fld-i money" style={{ width: "100%", boxSizing: "border-box", marginTop: 6 }} />
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
                <button disabled={busy} onClick={createAndAssign} style={{ border: "none", borderRadius: 9, background: TEAL, color: "#fff", fontSize: 12, fontWeight: 700, padding: "8px 12px", cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Saving…" : "Create & link"}
                </button>
                <button onClick={() => setAdding(false)} style={{ border: "none", background: "none", color: GREY, fontSize: 11, cursor: "pointer", padding: 0 }}>Back to search</button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// Auth-fetched attachment thumbnail (blob URL) with a remove affordance.
// Tapping an image or video opens the fullscreen viewer; videos defer
// the blob fetch until then so lists don't pull whole files.
function AttachThumb({ att, onArchive, onVisibility }: { att: Any; onArchive: () => void; onVisibility?: (visible: boolean) => void }) {
  const key = get(att, "r2Key", "r2_key");
  const contentType = String(get(att, "contentType", "content_type") ?? "");
  const isVideo = contentType.startsWith("video");
  const isPdf = contentType.includes("pdf");
  const [viewing, setViewing] = useState(false);
  // Customer-portal visibility (mirror desktop ServiceCases AttachmentThumb):
  // visible_to_customer defaults to 1, so a photo shot from the phone is
  // customer-visible unless explicitly hidden. Without this toggle the mobile
  // could only archive, never hide — a customer-facing data leak.
  const visible = Number(get(att, "visibleToCustomer", "visible_to_customer") ?? 1) === 1;

  /* WO-7 — the GRID tile loads the light `.thumb` sibling; attachments
     uploaded before thumbnails shipped have none (404) and fall back to
     the original in the same fetch. The fullscreen viewer loads the
     full-size original only when opened (and shows the thumb meanwhile). */
  const thumbQ = useQuery({
    queryKey: ["mobile-assr-att-thumb", key],
    enabled: !!key && !isPdf && !isVideo,
    staleTime: 5 * 60_000,
    queryFn: () => loadThumbFirst((p) => api.fetchBlobUrl(p), `/api/assr/attachments/${key}`),
  });
  const fullQ = useQuery({
    queryKey: ["mobile-assr-att", key],
    enabled: !!key && !isPdf && viewing,
    staleTime: 5 * 60_000,
    queryFn: () => api.fetchBlobUrl(`/api/assr/attachments/${key}`),
  });
  const url = thumbQ.data !== undefined ? thumbQ.data : null;
  const viewerUrl = fullQ.data !== undefined ? fullQ.data : (isVideo ? null : url);

  return (
    <div
      onClick={() => { if (!isPdf) setViewing(true); }}
      style={{ position: "relative", aspectRatio: "1", borderRadius: 9, overflow: "hidden", background: FIELD_BG, border: `1px solid ${DIM}`, cursor: isPdf ? "default" : "pointer", opacity: visible ? 1 : 0.55 }}
    >
      {isVideo || isPdf ? (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 3 }}>
          {isVideo && (
            <span style={{ width: 24, height: 24, borderRadius: "50%", background: "rgba(17,20,15,.12)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: INK, paddingLeft: 2 }}>▶</span>
          )}
          <span style={{ fontSize: 9, fontWeight: 700, color: MUTED }}>{isVideo ? "VIDEO" : "PDF"}</span>
        </div>
      ) : url ? (
        <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 9, color: GREY }}>…</span>
        </div>
      )}
      {onVisibility && (
        <button
          onClick={(e) => { e.stopPropagation(); onVisibility(!visible); }}
          aria-label={visible ? "Hide from customer" : "Show to customer"}
          title={visible ? "Hide from customer" : "Show to customer"}
          style={{ position: "absolute", top: 3, left: 3, height: 20, padding: "0 7px", borderRadius: 10, border: "none", background: visible ? "rgba(17,20,15,.55)" : TEAL, color: "#fff", fontSize: 9, fontWeight: 800, lineHeight: "20px", cursor: "pointer" }}
        >
          {visible ? "Hide" : "Show"}
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onArchive(); }}
        aria-label="Remove file"
        style={{ position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: "50%", border: "none", background: "rgba(17,20,15,.55)", color: "#fff", fontSize: 13, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        ×
      </button>
      {viewing && !isPdf && (
        <AttachViewer
          url={viewerUrl}
          isVideo={isVideo}
          name={String(get(att, "fileName", "file_name") ?? "")}
          onClose={() => setViewing(false)}
        />
      )}
    </div>
  );
}

// Fullscreen media viewer (single attachment). Blob URLs carry the
// auth, so <img>/<video> render directly; backdrop tap or × closes.
function AttachViewer({ url, isVideo, name, onClose }: { url: string | null; isVideo: boolean; name: string; onClose: () => void }) {
  return createPortal(
    <div
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(10,12,9,.92)", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, padding: 14 }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close"
        style={{ position: "absolute", top: 12, right: 12, width: 34, height: 34, borderRadius: "50%", border: "none", background: "rgba(255,255,255,.14)", color: "#fff", fontSize: 17, lineHeight: 1, cursor: "pointer" }}
      >
        ×
      </button>
      {!url ? (
        <span style={{ color: "rgba(255,255,255,.75)", fontSize: 12 }}>Loading…</span>
      ) : isVideo ? (
        <video src={url} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "82vh", borderRadius: 10 }} />
      ) : (
        <img src={url} alt="" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "82vh", objectFit: "contain", borderRadius: 10 }} />
      )}
      {name ? <span style={{ color: "rgba(255,255,255,.6)", fontSize: 10.5, maxWidth: "90%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span> : null}
    </div>,
    document.body,
  );
}
