import { useEffect, useMemo, useRef, useState } from "react";
import { lineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import { useAuth } from "../auth/AuthContext";
import { visibleFields } from "../auth/salesAccess";
import { formatDate } from "../lib/utils";
import { fmtAmt } from "../lib/scm";
import { useInfiniteQuery } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { api } from "../api/client";
import { SearchProgress } from "../components/SearchProgress";
import { SearchScopeHint } from "../components/SearchScopeHint";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../hooks/useServerSearch";
import {
  resolveStatusPill,
  statusLabel as scmStatusLabel,
  type StatusDocType,
  type StatusTone,
} from "../vendor/scm/lib/status-pill";
import type { FormSchema } from "./MobileModuleForm";
import { MobileVirtualList } from "./MobileVirtualList";
import "./mobile.css";

// ---------------------------------------------------------------------------
// MobileModuleList — ONE generic, config-driven mobile list screen that backs
// the many simple SCM modules (Suppliers, Delivery Orders, Sales Invoices,
// GRN, Purchase Orders, Warehouse, Inventory, Drivers, Helpers, …). It is a
// deliberate 1:1 visual match of MobileSalesOrders (same header eyebrow + big
// title + optional action button, same search bar, same card list, same
// .hz-m scoping / tokens / .money / dm() date helper / loading-error-empty
// states / bottom-safe scroll). A parent renders any module by passing a
// ModuleConfig (see MODULE_CONFIGS below for ready-made ones).
// ---------------------------------------------------------------------------

/** A shorthand hint the caller can use to build `secondary`/`right` — kept for
 *  documentation; configs below use the function forms directly. */
export type Column = { key: string; label?: string };

/** A labelled row shown in the design-style card grid: [accessor, label].
 *  The accessor returns the already-formatted value string (money via rm(),
 *  dates via dm()); a blank/"—" result renders as an em-dash. */
/** A labelled read-only field on a card.
 *
 *  The optional third slot marks the value CONFIDENTIAL. Owner 2026-07-17:
 *  "全部對sales person 除了sales director 關閉 就是直接看不到這個portion" —
 *  cost is director-only, on phone and desktop alike. Marked structurally
 *  rather than matched by label: MobileModuleDetail.tsx already gates its stat
 *  tiles with `st[0] === "Cost"`, which silently stops working the day someone
 *  writes "Unit Cost". A tuple slot cannot drift out of sync with its label.
 *  Filter through {@link visibleFields} — never map over `config.fields` raw. */
export type FieldDef = [accessor: (row: any) => string, label: string, confidential?: "cost"];

/** A chip filter: a labelled button that filters rows via `match` and shows a
 *  live count. `key` is a stable id (also the "all"-sentinel when key === "all",
 *  which the render treats as "no filter"). */
export type ChipDef = { key: string; label: string; match: (row: any) => boolean };

/** A sort option for the sort control. */
export type SortDef = { key: string; label: string; cmp: (a: any, b: any) => number };

export type ModuleConfig = {
  /** Big title, e.g. "Suppliers". */
  title: string;
  /** Small uppercase eyebrow above the title, e.g. "Supply chain". */
  eyebrow?: string;
  /** Path relative to /api/scm, e.g. "/suppliers?limit=200". When `core` is
   *  true the path is relative to the core "/api" instead (e.g. "/api/users"). */
  endpoint: string;
  /** Hit the core /api client instead of the SCM authedFetch base. */
  core?: boolean;
  /** Key in the response object holding the array. Auto-detected if omitted. */
  listKey?: string;
  /** Main (bold) line, e.g. row => row.name. */
  primary: (row: any) => string;
  /** Muted sub line, e.g. row => `${row.code} · ${row.phone}`. */
  secondary?: (row: any) => string;
  /** Right-aligned value (money total or status). */
  right?: (row: any) => string;
  /** When true, `right` returns a *_centi value → rendered as RM x/100. */
  rightMoney?: boolean;
  /** Haystack for the search box; falls back to primary + secondary. */
  search?: (row: any) => string;

  // ── Design-style config (optional, backward compatible) ────────────────────
  /** Search box placeholder; falls back to `Search <title>`. */
  placeholder?: string;
  /** When present, each card renders the design template: title (primary) +
   *  status pill (pill) + a compact grid of these labelled field rows (so-k /
   *  so-v pairs). When absent, the card falls back to primary/secondary/right. */
  fields?: FieldDef[];
  /** The row's status/category text → the pill above the card grid. Also drives
   *  the detail-header status, so keep it stable even when the list badge differs
   *  (override the list-only badge via `badgeText`). */
  pill?: (row: any) => string;
  /** Canonical document type for the shared status map (vendor/scm/lib/status-
   *  pill.ts). When set, the list card resolves the pill's TONE (and thus badge
   *  colour) from `resolveStatusPill(statusDocType, row.status)` so a document's
   *  status colour matches its desktop scm-v2 list. The `pill` accessor should
   *  return the matching canonical label via `scmStatusLabel(statusDocType, …)`
   *  so list + detail read identically. Leave unset for non-document pills
   *  (category / code / role) that have no canonical status map. */
  statusDocType?: StatusDocType;
  /** List-card badge override. When set, the list card's status badge uses this
   *  instead of `pill` (e.g. Positions shows "N members" while `pill` stays the
   *  department for the detail header). */
  badgeText?: (row: any) => string;
  /** Primary chip filter row (status/level/category) with live counts. */
  chips?: ChipDef[];
  /** Optional secondary chip filter (supplier / warehouse). */
  chips2?: ChipDef[];
  /** Sort options; the first is the default. */
  sorts?: SortDef[];

  // ── Build-spec card layout (docs/mobile-build-spec.html) ────────────────────
  /** Which spec card template the list renders. When omitted the module falls
   *  back to the generic `fields[]` grid. Each variant mirrors one spec screen:
   *   • "doc"       — name + status badge, doc_no·date sub-line, optional note
   *                    line, top-bordered footer (left meta + right money).
   *   • "product"   — .ph thumbnail + name/SKU·category + right price/uom.
   *   • "inventory" — name + stock badge, SKU·warehouse sub-line, 3-KPI footer.
   *   • "warehouse" — name + code grey badge, address line, SKU/Units footer.
   *   • "mrp"       — name + state badge, SKU sub-line, 4-col KPI grid.
   *   • "person"    — avatar initials + name/sub + status badge (row layout). */
  variant?: "doc" | "product" | "inventory" | "warehouse" | "mrp" | "person";
  /** Muted `.tnum` sub-line under the card name (spec: "{{doc_no}} · {{date}}"). */
  subline?: (row: any) => string;
  /** Optional brand chip trailing the doc sub-line. Reuses the neutral status
   *  pill (`.badge .b-grey`) and sits flex:none so the sub-line text truncates
   *  before the brand does — the brand stays readable at phone width. Blank →
   *  no chip. */
  brand?: (row: any) => string;
  /** Optional third line in --ink2 (items summary / reason). Hidden when blank. */
  note?: (row: any) => string;
  /** Footer-row left meta as [label, value] — value bolded. Hidden when blank. */
  footL?: (row: any) => [string, string] | null;
  /** Footer-row right value. When `footMoney`, it's a *_centi total → RM x/100. */
  footR?: (row: any) => string;
  footMoney?: boolean;
  /** KPI cells for the inventory / mrp footers: [label, value] pairs. */
  kpis?: (row: any) => Array<[string, string]>;
  /** Avatar seed for the "person" variant — initials come from this string. */
  avatar?: (row: any) => string;
  /** Right price (product variant) → *_centi rendered RM x/100 when priceMoney. */
  price?: (row: any) => string;
  priceMoney?: boolean;
  /** Unit-of-measure caption under a product price (spec: "/{{uom}}"). */
  uom?: (row: any) => string;

  /** When present, this module supports CREATE (+ New button) and — when the
   *  schema declares an updatePath — EDIT (from the detail screen). The parent
   *  (MobileApp) wires onNew/onEdit → MobileModuleForm with this schema. See
   *  FORM_SCHEMAS below for the ready-made ones. */
  form?: FormSchema;
};

// Bare 2dp amount; callers print their own "RM " prefix. The shared fmtAmt
// keeps a non-finite from reaching the user as "RM NaN".
const rm = fmtAmt;

// Numeric DD/MM/YYYY via the shared formatter (house rule — no month names).
const dm = (d: string | null | undefined) => formatDate(d);

/** Format a *_centi/_sen value as `RM x,xxx.00` for a field cell. Blank input
 *  (null / undefined / "") → "—" so an absent amount is not shown as RM 0.00. */
const rmField = (centi: number | null | undefined) =>
  centi == null || centi === ("" as unknown) ? "—" : `RM ${rm(centi)}`;

/** Read a value that may arrive camelCase (PostgREST driver / computed JS) or
 *  snake_case (raw). Returns the first defined of the candidates. */
const pick = (row: any, ...keys: string[]) => {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
};

/** Case-insensitive equality against a value that may be null. */
const eq = (a: unknown, b: string) => String(a ?? "").trim().toLowerCase() === b.toLowerCase();

/** Generic Title-Case humanizer for a raw enum ("partially_received",
 *  "IN_STOCK") — used ONLY for non-document fields that have no canonical status
 *  map: product category, account type, user account status. Document statuses
 *  go through the shared `scmStatusLabel(docType, status)` instead so a doc reads
 *  identically on phone and desktop. */
const humanize = (raw: unknown): string => {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  return t
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
};

// ── Build-spec status → badge class (docs/mobile-build-spec.html per-screen
// STATES map). Resolves a humanized/raw status label to one of the canonical
// .b-* palette classes; unknown → neutral grey. Keys are matched case-
// insensitively against the label's collapsed form (spaces & underscores gone).
const BADGE_CLASS: Record<string, string> = {
  // greens (confirmed / paid / delivered / received / in-stock / active)
  delivered: "b-green", paid: "b-green", posted: "b-green", received: "b-green",
  signed: "b-green", completed: "b-green", refunded: "b-green", instock: "b-green",
  available: "b-green", active: "b-green", inhouse: "b-green",
  // ambers (pending / partial / open / sent / dispatched / low / on-po)
  dispatched: "b-amber", sent: "b-amber", open: "b-amber", unpaid: "b-amber",
  partiallypaid: "b-amber", partiallyreceived: "b-amber", low: "b-amber",
  onpo: "b-amber", ontrip: "b-amber", intransit: "b-amber", loaded: "b-amber",
  invited: "b-amber", outsource: "b-amber",
  // reds (cancelled / overdue / shortage / zero / maintenance)
  cancelled: "b-red", voided: "b-red", void: "b-red", overdue: "b-red",
  shortage: "b-red", zero: "b-red", negative: "b-red", maintenance: "b-red",
  // brand (approved / submitted)
  approved: "b-brand", submitted: "b-brand",
  // greys (draft / closed / inactive / off)
  draft: "b-grey", closed: "b-grey", inactive: "b-grey", off: "b-grey",
  disabled: "b-grey", invoiced: "b-grey",
};

/** Collapse a status label to its BADGE_CLASS lookup key. */
const badgeClass = (label: string): string => {
  const k = String(label ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return BADGE_CLASS[k] ?? "b-grey";
};

// Canonical status TONE (vendor/scm/lib/status-pill.ts) → mobile .b-* badge
// class, so a document badge's colour is driven by the SAME tone the desktop
// scm-v2 pill uses instead of a label-keyed guess. info/progress map to the
// brand/amber accents; pending (draft) reads amber like the desktop gold pill.
const TONE_BADGE_CLASS: Record<StatusTone, string> = {
  neutral: "b-grey",
  info: "b-brand",
  progress: "b-amber",
  success: "b-green",
  danger: "b-red",
  pending: "b-amber",
};

/** Canonical spec status badge (`.badge .b-*`). Empty label → nothing. When a
 *  `tone` is given (document pills), the colour comes from the shared status
 *  map; otherwise it falls back to the label-keyed BADGE_CLASS. */
function Badge({ label, tone }: { label: string; tone?: StatusTone }) {
  const clean = (label ?? "").trim();
  if (!clean) return null;
  const cls = tone ? TONE_BADGE_CLASS[tone] : badgeClass(clean);
  return <span className={`badge ${cls}`}>{clean}</span>;
}

/** Circle avatar with initials on #15161a / gold (spec drivers/members). */
function Avatar({ seed, size = 40 }: { seed: string; size?: number }) {
  const initials = String(seed ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "?";
  return (
    <span
      style={{
        width: size, height: size, flex: "none", borderRadius: "50%",
        background: "#15161a", color: "#d8a85a", fontSize: 13, fontWeight: 800,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {initials}
    </span>
  );
}

/** Stock-level pill label from on-hand qty — matches desktop Inventory's
 *  positive / zero / negative classification. NO arbitrary "<5 = Low" threshold
 *  (that was a mobile-only invented rule with no data source; owner 2026-07-14). */
const stockLevel = (qty: unknown): string => {
  const q = Number(qty ?? 0);
  if (!Number.isFinite(q) || q === 0) return "Zero";
  if (q < 0) return "Negative";
  return "In stock";
};

/** MRP row state pill (design: In stock / Shortage / On PO), derived from the
 *  computed shortage / poOutstanding fields. Shortage wins, then incoming PO. */
const mrpState = (r: any): string => {
  const shortage = Number(pick(r, "shortage") ?? 0);
  const incoming = Number(pick(r, "poOutstanding", "po_outstanding") ?? 0);
  if (shortage > 0) return "Shortage";
  if (incoming > 0) return "On PO";
  return "In stock";
};

/** Invoice balance = total − paid, floored at 0, in centi. */
const balanceCenti = (r: any): number => {
  const total = Number(pick(r, "totalCenti", "total_centi", "localTotalCenti", "local_total_centi") ?? 0);
  const paid = Number(pick(r, "paidCenti", "paid_centi") ?? 0);
  return Math.max(0, (Number.isFinite(total) ? total : 0) - (Number.isFinite(paid) ? paid : 0));
};

/** Numeric-aware locale compare, mirroring the prototype's localeCompare with
 *  { numeric: true }. Used to keep sort keys terse in the configs. */
const byStr = (a: unknown, b: unknown) => String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
const byNum = (a: unknown, b: unknown) => (Number(b) || 0) - (Number(a) || 0);
const byDate = (a: unknown, b: unknown) => {
  const ta = a ? +new Date(String(a)) : 0;
  const tb = b ? +new Date(String(b)) : 0;
  return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
};

/** Pick the array out of a keyed response, or return it if already an array.
 *  With no listKey, take the first array-valued property of the object. */
function pickList(data: unknown, listKey?: string): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (listKey) return Array.isArray(obj[listKey]) ? (obj[listKey] as any[]) : [];
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v as any[];
  return [];
}

const PAGE_SIZE = 30;

/** SCM list endpoints whose backend handler supports server-side pagination +
 *  search (accepts `page`/`pageSize`/`q`, returns `{ <key>, total, page,
 *  pageSize, statusCounts }`). Matched on the endpoint's base path (query
 *  string stripped). Everything NOT in here — the core `/api` lists and the
 *  SCM lists without a paged handler — loads as a single page and filters
 *  client-side, exactly as before. The runtime `total`-absent guard below is a
 *  second safety net: even a listed endpoint that returns no `total` (e.g. an
 *  older deploy) degrades to single-page behaviour instead of looping. */
const SERVER_PAGINATED = new Set<string>([
  "/delivery-orders-mfg",
  "/sales-invoices",
  "/grns",
  "/mfg-purchase-orders",
  "/purchase-invoices",
  // Backends return { <key>, total, page, pageSize } (page-param opt-in) — same
  // as the five above, so mobile can drop the limit=500 fetch-then-slice and
  // truly server-window. delivery-returns / purchase-returns are intentionally
  // absent: their list handlers are NOT paginated (no `total`), and opting them
  // in would collapse each to a single 30-row page.
  "/consignment-orders",
  "/consignment-notes",
  "/consignment-returns",
  "/suppliers",
]);

/** Split an endpoint string into its base path + parsed query params. */
function splitEndpoint(endpoint: string): { base: string; params: URLSearchParams } {
  const qi = endpoint.indexOf("?");
  if (qi === -1) return { base: endpoint, params: new URLSearchParams() };
  return { base: endpoint.slice(0, qi), params: new URLSearchParams(endpoint.slice(qi + 1)) };
}

const safe = (fn: ((row: any) => string) | undefined, row: any): string => {
  if (!fn) return "";
  try {
    return fn(row) ?? "";
  } catch {
    return "";
  }
};

/** Generic list screen. Cards call onOpen(row) when provided; the header shows
 *  a back button when onBack is provided. */
export function MobileModuleList({
  config,
  onBack,
  onOpen,
  onNew,
}: {
  config: ModuleConfig;
  onBack?: () => void;
  onOpen?: (row: any) => void;
  /** Wired by the parent when config.form is present — opens MobileModuleForm
   *  in create mode. The "+ New" header button calls this. */
  onNew?: () => void;
}) {
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("all");
  const [chip2, setChip2] = useState("all");
  const [sortKey, setSortKey] = useState(config.sorts?.[0]?.key ?? "");

  /* Debounced search term — the value actually sent to the server (and keyed
     into the infinite query) so a keystroke doesn't fire a request per
     character. 300ms after typing stops the paged query re-runs from page 0 and
     the server searches the WHOLE table, not just the rows already loaded. */
  const { requestTerm: debouncedQ } = useDebouncedSearchTerm(q);

  /* Whether THIS config's endpoint has a server-paginated handler. Core /api
     lists and un-paged SCM lists fall back to a single page + client-side
     filtering (the pre-pagination behaviour). */
  const { base, params: baseParams } = useMemo(() => splitEndpoint(config.endpoint), [config.endpoint]);
  const wantsPagination = !config.core && SERVER_PAGINATED.has(base);
  const endpointLimit = Number(baseParams.get("limit"));

  /* Scroll container + sentinel for the IntersectionObserver infinite scroll. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  /* Paged URL for a given page index: keep the endpoint's own params (e.g.
     fields=minimal) but drop `limit` (the server windows via page/pageSize) and
     fold in the debounced search. Sort is left to the server default (each
     handler already orders newest-first) — the configs don't expose the server
     column name, so we omit `sort` rather than send a wrong one. */
  const buildUrl = (page: number): string => {
    const p = new URLSearchParams(baseParams);
    p.delete("limit");
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    if (debouncedQ) p.set("q", debouncedQ);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  const {
    data, isLoading, isFetching, isPlaceholderData, error,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    // Paged lists key on the debounced search so changing it restarts at page 0
    // and the server re-searches the whole table. Un-paged lists keep the old
    // single-fetch key (search/chip/sort stay client-side).
    queryKey: wantsPagination
      ? ["mobile-module-paged", base, debouncedQ]
      : ["mobile-module", config.core ? "core" : "scm", config.endpoint],
    queryFn: ({ pageParam, signal }) =>
      wantsPagination
        ? authedFetch<unknown>(buildUrl(pageParam as number), { signal })
        : config.core
          ? api.get<unknown>(config.endpoint)
          : authedFetch<unknown>(config.endpoint, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last: any, pages) => {
      if (!wantsPagination) return undefined;
      const total = typeof last?.total === "number" ? last.total : null;
      if (total == null) return undefined; // un-paged / stale backend → one page
      const loaded = pages.reduce((n, pg) => n + pickList(pg, config.listKey).length, 0);
      return loaded < total ? pages.length : undefined;
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const searchTransition = useSearchResultTransition({
    inputTerm: wantsPagination ? q : debouncedQ,
    requestTerm: debouncedQ,
    isFetching,
    isPlaceholderData: wantsPagination ? isPlaceholderData : false,
    hasData: data !== undefined,
    hasError: Boolean(error),
  });
  const listLoading = isLoading || searchTransition.isSearching;

  // All rows loaded so far, flat-mapped through the config's listKey extractor.
  const all = useMemo(
    () => (data?.pages ?? []).flatMap((pg) => pickList(pg, config.listKey)),
    [data, config.listKey],
  );

  // Did the server actually paginate? (first page carries a numeric `total`).
  // Drives whether search is server-side and how the record count is shown.
  const serverTotal = typeof (data?.pages?.[0] as any)?.total === "number"
    ? ((data!.pages[0] as any).total as number)
    : undefined;
  const serverPaginated = wantsPagination && serverTotal != null;
  const loadedSearchLimit = serverPaginated
    ? undefined
    : wantsPagination
      ? undefined
      : Number.isFinite(endpointLimit) && endpointLimit > 0
        ? endpointLimit
        : undefined;

  // Chip / chip2 / sort stay client-side over the LOADED rows (see report note).
  // Search: server-side for paginated lists (already applied via the `q` param),
  // client-side otherwise — never both, so the loaded set is not re-filtered for
  // a search the server already ran.
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const chipDef = chip !== "all" ? config.chips?.find((c) => c.key === chip) : undefined;
    const chip2Def = chip2 !== "all" ? config.chips2?.find((c) => c.key === chip2) : undefined;
    let out = all.filter((r) => {
      if (chipDef && !safeMatch(chipDef.match, r)) return false;
      if (chip2Def && !safeMatch(chip2Def.match, r)) return false;
      if (!serverPaginated && needle) {
        const hay = config.search ? safe(config.search, r) : `${safe(config.primary, r)} ${safe(config.secondary, r)}`;
        if (!hay.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
    const sortDef = config.sorts?.find((s) => s.key === sortKey);
    if (sortDef) out = out.slice().sort((a, b) => { try { return sortDef.cmp(a, b); } catch { return 0; } });
    return out;
  }, [all, q, chip, chip2, sortKey, config, serverPaginated]);

  // Record-count note: the server's real total for a paginated list (when no
  // client-only chip is narrowing it), otherwise the count actually shown.
  const clientFilterActive = chip !== "all" || chip2 !== "all";
  const recordCount = serverPaginated && !clientFilterActive ? (serverTotal ?? rows.length) : rows.length;

  /* Infinite-scroll trigger — an IntersectionObserver watches a 1px sentinel
     near the list bottom and pulls the next page when it nears the viewport
     (rootMargin 600px pre-load). Observer callbacks run on the event loop, not
     rAF, so this fires reliably even under rAF throttling (mirrors the merged,
     prod-verified MobileSalesOrders). Guarded by hasNextPage && !isFetchingNextPage
     so it can't double-fire; re-observing when those flip re-pulls until the
     sentinel scrolls out or the pages are exhausted. */
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
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, all.length]);

  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        {onBack && (
          <div style={{ marginBottom: 8 }}>
            <button className="back" onClick={onBack}>
              <span className="chev">{"‹"}</span> Menu
            </button>
          </div>
        )}
        {/* header lockup: gold eyebrow + big title (spec T3 + T1), + New action */}
        <div className="hdr-row">
          <div>
            {config.eyebrow && <div className="eyebrow">{config.eyebrow}</div>}
            <div className="scr-title">{config.title}</div>
          </div>
          {onNew && (
            // Render whenever the parent wires onNew — a module with a `form`
            // opens MobileModuleForm; a doc module (DO/SI/GRN/PO) opens the
            // convert wizard. Both go through the same "+ New" affordance.
            <button onClick={onNew} className="iconbtn" aria-label={`New ${config.title}`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            </button>
          )}
        </div>

        <div className="hdr-row" style={{ marginTop: 11 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={config.placeholder ?? `Search ${config.title.toLowerCase()}`} />
          </div>
          <SearchProgress active={searchTransition.isSearching} label="Searching…" />
          {config.sorts && config.sorts.length > 0 && (
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              aria-label="Sort"
              className="cal-sel"
              style={{ flex: "none", width: "auto", fontSize: 12, borderRadius: 10, padding: "0 8px", height: 38 }}
            >
              {config.sorts.map((sdef) => (
                <option key={sdef.key} value={sdef.key}>Sort: {sdef.label}</option>
              ))}
            </select>
          )}
        </div>
        <SearchScopeHint
          scope={serverPaginated ? "server" : "loaded"}
          loadedLimit={loadedSearchLimit}
          searching={searchTransition.isSearching}
          countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale}
          resultCount={serverPaginated ? serverTotal : undefined}
          term={q}
          className="mt-1 px-1"
        />
        {serverPaginated && (
          (config.chips?.length ?? 0) > 0 ||
          (config.chips2?.length ?? 0) > 0 ||
          (config.sorts?.length ?? 0) > 0
        ) && (
          <div className="mt-1 px-1 text-[10px] text-ink-muted">
            Search uses all pages; chips and sorting use loaded rows.
          </div>
        )}

        {config.chips && config.chips.length > 0 && (
          <div className="chips" style={{ marginTop: 11 }}>
            {config.chips.map((c) => {
              const on = chip === c.key;
              const count = c.key === "all" ? all.length : all.filter((r) => safeMatch(c.match, r)).length;
              return (
                <button key={c.key} onClick={() => setChip(c.key)} className={on ? "chip on" : "chip"}>
                  {c.label} ({count} loaded)
                </button>
              );
            })}
          </div>
        )}
        {config.chips2 && config.chips2.length > 0 && (
          <div className="chips" style={{ marginTop: 8 }}>
            {config.chips2.map((c) => (
              <button key={c.key} onClick={() => setChip2(c.key)} className={chip2 === c.key ? "chip on" : "chip"}>{c.label}</button>
            ))}
          </div>
        )}
      </header>

      <div ref={scrollRef} className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 120 }}>
        {/* Variable-count note pill (spec § list-note): server total for a
            paginated list, else the count of shown records. */}
        {!listLoading && !error && rows.length > 0 && (
          <span className="list-note">
            {recordCount} {recordCount === 1 ? "record" : "records"}
            {(!serverPaginated || clientFilterActive) ? " loaded" : ""}
          </span>
        )}

        {/* LOADING: skeleton cards (spec § Foundations — 3 skeletons). */}
        {listLoading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card"><div className="card-b" style={{ padding: "12px 13px" }}>
                <div className="ph" style={{ height: 14, width: "55%", borderRadius: 5 }} />
                <div className="ph" style={{ height: 11, width: "38%", borderRadius: 5, marginTop: 8 }} />
              </div></div>
            ))}
          </div>
        )}

        {/* ERROR: retry strip (spec § Foundations). */}
        {!!error && !listLoading && (
          <div className="empty">
            <div className="empty-t">Couldn't load {config.title.toLowerCase()}.</div>
            <div className="empty-s">Pull to refresh to try again.</div>
          </div>
        )}

        {!listLoading && !error && rows.length > 0 && (
          <MobileVirtualList
            items={rows}
            getKey={(r, i) => (r.id as string) ?? (r.doc_no as string) ?? i}
            renderItem={(r) => <ListCard config={config} row={r} onOpen={onOpen} />}
          />
        )}
        {/* Infinite-scroll sentinel — the IntersectionObserver watches this 1px
            marker and pulls the next page as it nears view. Rendered whenever
            more pages exist (even if a client chip filtered the loaded rows to
            zero, so the loader keeps pulling until a match appears or pages run
            out). Absent for un-paged lists (hasNextPage is always false). */}
        {!listLoading && !error && hasNextPage && (
          <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
        )}
        {/* "Loading more…" while the next page is in flight; nothing once every
            page is loaded. */}
        {isFetchingNextPage && (
          <div style={{ textAlign: "center", padding: "14px 0 2px", fontSize: 11.5, color: "var(--mut)" }}>Loading more…</div>
        )}
        {/* EMPTY state (spec § Foundations — empty block). Held back while more
            pages are still loading so a client-filtered-to-zero page doesn't
            flash "No records" before the next page arrives. */}
        {!listLoading && !error && !rows.length && !hasNextPage && !isFetchingNextPage && (
          <div className="empty">
            <div className="empty-t">No {config.title.toLowerCase()}</div>
            <div className="empty-s">{q.trim() ? "Try a different search." : "Nothing to show yet."}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ListCard — renders ONE spec-aligned list card, routed on config.variant. Each
// branch mirrors the corresponding Build-Spec screen markup (docs/mobile-build-
// spec.html), using the canonical .card / .card-b / .badge classes. When no
// variant is set, falls back to the generic fields[] grid so untouched modules
// keep working. All accessors are read through safe()/pick — a missing value is
// an em-dash, never undefined.
// ---------------------------------------------------------------------------
function ListCard({ config, row, onOpen }: { config: ModuleConfig; row: any; onOpen?: (row: any) => void }) {
  /* Owner 2026-07-17 — cost is director-only, phone and desktop alike. */
  const { user: cardUser } = useAuth();
  const cardFields = visibleFields(config.fields, cardUser);
  const clickable = !!onOpen;
  const open = clickable ? () => onOpen!(row) : undefined;
  const cardStyle: React.CSSProperties = clickable ? { cursor: "pointer" } : { cursor: "default" };
  const pillStatus = config.pill ? safe(config.pill, row) : "";
  const status = config.badgeText ? safe(config.badgeText, row) : pillStatus;
  // Document modules carry a canonical docType → the badge colour comes from the
  // shared status map's tone (same as desktop), not a label-keyed guess. The
  // badgeText override (positions / departments / accounting) is never a status,
  // so it keeps the label-keyed colour.
  const statusTone: StatusTone | undefined =
    config.statusDocType && !config.badgeText
      ? resolveStatusPill(config.statusDocType, pick(row, "status")).tone
      : undefined;
  const cancelled = eq(pillStatus, "Cancelled");
  const name = safe(config.primary, row) || "—";
  const sub = config.subline ? safe(config.subline, row) : safe(config.secondary, row);
  const brandText = config.brand ? safe(config.brand, row) : "";
  const noteLine = config.note ? safe(config.note, row) : "";

  // ── person: avatar + name/sub + status badge (drivers / members) ────────────
  if (config.variant === "person") {
    return (
      <div className="card" onClick={open} style={cardStyle}>
        <div className="card-b" style={{ padding: "12px 13px", display: "flex", alignItems: "center", gap: 11 }}>
          <Avatar seed={config.avatar ? safe(config.avatar, row) : name} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
            {sub && <div className="tnum" style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>{sub}</div>}
          </div>
          {status ? <Badge label={status} tone={statusTone} /> : null}
        </div>
      </div>
    );
  }

  // ── product: thumbnail + name/SKU + right price / uom ────────────────────────
  if (config.variant === "product") {
    const priceRaw = config.price ? config.price(row) : "";
    const priceText = config.priceMoney ? `RM ${rm(priceRaw as unknown as number)}` : priceRaw;
    const uomText = config.uom ? safe(config.uom, row) : "";
    return (
      <div className="card" onClick={open} style={cardStyle}>
        <div className="card-b" style={{ padding: "11px 13px", display: "flex", gap: 11, alignItems: "center" }}>
          <div className="ph" style={{ width: 46, height: 46, flex: "none", borderRadius: 8 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
            {sub && <div className="tnum" style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>{sub}</div>}
          </div>
          <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            {priceText && <div className="money-row">{priceText}</div>}
            {uomText && <div className="tnum" style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 2 }}>/{uomText}</div>}
          </div>
        </div>
      </div>
    );
  }

  // ── inventory / mrp / warehouse: name + badge, sub-line, KPI footer ──────────
  if (config.variant === "inventory" || config.variant === "mrp" || config.variant === "warehouse") {
    const kpis = config.kpis ? config.kpis(row) : [];
    const isGrid = config.variant === "mrp"; // 4-col centred grid vs inline row
    return (
      <div className="card" onClick={open} style={cardStyle}>
        <div className="card-b" style={{ padding: "12px 13px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: config.variant === "warehouse" ? 14 : 13.5, fontWeight: config.variant === "warehouse" ? 800 : 700, color: "var(--ink)" }}>{name}</span>
            {status ? <Badge label={status} tone={statusTone} /> : null}
          </div>
          {sub && <div className="tnum" style={{ fontSize: 11, color: "var(--mut)", marginTop: 3 }}>{sub}</div>}
          {noteLine && <div style={{ fontSize: 11.5, color: "var(--ink2)", marginTop: 6, lineHeight: 1.4 }}>{noteLine}</div>}
          {kpis.length > 0 && (
            <div
              style={
                isGrid
                  ? { display: "grid", gridTemplateColumns: `repeat(${kpis.length},1fr)`, gap: 6, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line2)", textAlign: "center" }
                  : { display: "flex", gap: 14, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line2)", fontSize: 11 }
              }
            >
              {kpis.map(([label, value], k) =>
                isGrid ? (
                  <div key={label}>
                    <div style={{ color: "var(--mut2)", fontSize: 10.5 }}>{label}</div>
                    <div className="tnum" style={{ fontWeight: 700, fontSize: 10.5, color: label === "Shortage" ? "var(--red)" : "var(--ink)" }}>{value}</div>
                  </div>
                ) : (
                  <span key={label} style={{ color: "var(--mut)" }}>{label} <b className="tnum" style={{ color: k === kpis.length - 1 && config.variant === "inventory" ? "var(--brand-d)" : "var(--ink)" }}>{value}</b></span>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── doc: name + status badge, doc_no·date sub-line, optional note, footer ─────
  if (config.variant === "doc") {
    const fl = config.footL ? config.footL(row) : null;
    const frRaw = config.footR ? config.footR(row) : "";
    const frText = config.footMoney ? `RM ${rm(frRaw as unknown as number)}` : frRaw;
    const hasFooter = !!(fl || frText);
    return (
      <div className="card" onClick={open} style={{ ...cardStyle, ...(cancelled ? { opacity: 0.6 } : null) }}>
        <div className="card-b" style={{ padding: "12px 13px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)", flex: 1, minWidth: 0, whiteSpace: "normal" }}>{name}</span>
            {status ? <span style={{ flex: "none" }}><Badge label={status} tone={statusTone} /></span> : null}
          </div>
          {(sub || brandText) && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
              {sub && (
                <span className="tnum" style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5, color: "var(--mut)" }}>{sub}</span>
              )}
              {brandText && <span style={{ flex: "none" }}><Badge label={brandText} tone="neutral" /></span>}
            </div>
          )}
          {noteLine && <div style={{ fontSize: 11.5, color: "var(--ink2)", marginTop: 6, lineHeight: 1.4 }}>{noteLine}</div>}
          {hasFooter && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: fl ? "space-between" : "flex-end", marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
              {fl && <span style={{ fontSize: 11, color: "var(--mut)" }}>{fl[0] ? <>{fl[0]} </> : null}<b style={{ color: "var(--ink)" }}>{fl[1] || "—"}</b></span>}
              {frText && <span className="money-row">{frText}</span>}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── fallback: generic list card — LAYOUT ported VERBATIM from the owner's
  //    MobileList.tsx: clickable .card (padding 12px 13px), a header row with the
  //    bold title + status Badge, then a two-column grid of stacked labelled
  //    fields (uppercase mut label over the value). Data still comes from our
  //    ModuleConfig (primary / pill / fields), so all wiring is preserved.
  return (
    <div className="card" onClick={open} style={{ ...cardStyle, padding: "12px 13px", ...(cancelled ? { opacity: 0.6 } : null) }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 800, color: "#11140f" }}>{name}</span>
        {status ? <span style={{ flex: "none" }}><Badge label={status} tone={statusTone} /></span> : (() => {
          const rightRaw = config.right ? config.right(row) : "";
          const rightText = config.rightMoney ? `RM ${rm(rightRaw as unknown as number)}` : rightRaw;
          return rightText ? <span className="money-row">{rightText}</span> : null;
        })()}
      </div>
      {cardFields.length ? (
        <div className="so-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px", marginTop: 8 }}>
          {cardFields.map(([accessor, label]) => (
            <div key={label} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: "#9aa093" }}>{label}</div>
              <div className="money" style={{ fontSize: 12, fontWeight: 600, color: "#11140f" }}>{safe(accessor, row) || "—"}</div>
            </div>
          ))}
        </div>
      ) : sub ? (
        <div className="tnum" style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 5 }}>{sub}</div>
      ) : null}
    </div>
  );
}

const safeMatch = (fn: ((row: any) => boolean) | undefined, row: any): boolean => {
  if (!fn) return true;
  try { return !!fn(row); } catch { return false; }
};

// ---------------------------------------------------------------------------
// MODULE_CONFIGS — ready-made configs for the simple SCM modules. Field names +
// response array keys were read from backend/src/scm/routes/*.ts (the SELECT
// column lists and the c.json({ … }) response wrappers), not guessed.
// ---------------------------------------------------------------------------

const join = (...parts: Array<string | null | undefined>) =>
  parts.map((p) => (p == null ? "" : String(p)).trim()).filter(Boolean).join(" · ");

// ---------------------------------------------------------------------------
// FORM_SCHEMAS — CREATE / EDIT form definitions, one per module that supports
// writes. Field keys are the camelCase body keys the backend routes accept
// (read from backend/src/scm/routes/*.ts + backend/src/routes/*.ts), NOT the
// snake_case DB columns. Money fields carry a moneyScale (100 = sen). Only
// fields the endpoints actually accept are exposed. Exported so MobileApp can
// reference a schema directly when wiring onNew/onEdit.
// ---------------------------------------------------------------------------

/* suppliers — POST /suppliers (code+name required), PATCH /suppliers/:id.
   Response wraps the record as { supplier: {...} }; id = supplier.id. Rich
   AutoCount master; the mobile form exposes the everyday subset. credit_limit
   is stored in SEN (credit_limit_sen) → money scale 100. Bindings (assigned
   SKUs + per-category price matrix) are a separate endpoint → not in this
   flat form. */
export const FORM_SUPPLIERS: FormSchema = {
  title: "Supplier",
  eyebrow: "Procurement",
  base: "scm",
  createPath: "/suppliers",
  updatePath: (id) => `/suppliers/${encodeURIComponent(id)}`,
  idKey: "id",
  responseIdKeys: ["id"],
  fields: [
    { key: "code", label: "Code", type: "text", required: true, placeholder: "e.g. SUP-001" },
    { key: "name", label: "Name", type: "text", required: true, placeholder: "Company name" },
    { key: "contactPerson", label: "Contact Person", type: "text" },
    { key: "phone", label: "Phone", type: "tel", placeholder: "01X-XXX XXXX" },
    { key: "mobile", label: "Mobile", type: "tel" },
    { key: "whatsappNumber", label: "WhatsApp", type: "tel" },
    { key: "email", label: "Email", type: "email", placeholder: "supplier@example.com" },
    { key: "address", label: "Address", type: "textarea" },
    { key: "state", label: "State", type: "text" },
    { key: "postcode", label: "Postcode", type: "text" },
    { key: "area", label: "Area", type: "text" },
    { key: "country", label: "Country", type: "text", placeholder: "Malaysia" },
    { key: "paymentTerms", label: "Payment Terms", type: "text", placeholder: "e.g. Net 30" },
    { key: "status", label: "Status", type: "select", options: [
      { value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }, { value: "BLOCKED", label: "Blocked" },
    ], placeholder: "Active" },
    // Currency options come from the live currency MASTER (migration 0193 —
    // /api/scm/currencies, the same source useActiveCurrencies reads and every
    // desktop currency <select> uses), NOT a hardcoded list, so adding a
    // currency is fully UI. Loaded via the form's async optionsSource (same
    // mechanism as roles/departments). Falls back to the placeholder if the
    // master hasn't loaded.
    { key: "currency", label: "Currency", type: "select", placeholder: "MYR",
      optionsSource: { base: "scm", path: "/currencies?active=true", listKey: "currencies", value: (r) => r.code, label: (r) => r.code } },
    { key: "creditLimitSen", label: "Credit Limit (RM)", type: "money", moneyScale: 100 },
    { key: "businessRegNo", label: "Business Reg No", type: "text" },
    { key: "tinNumber", label: "TIN Number", type: "text" },
    { key: "website", label: "Website", type: "text" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
};

/* drivers — POST /drivers (driverCode+name+phone required), PATCH /drivers/:id.
   Response wraps as { driver: {...} }; id = driver.id. */
export const FORM_DRIVERS: FormSchema = {
  title: "Driver",
  eyebrow: "Transportation",
  base: "scm",
  createPath: "/drivers",
  updatePath: (id) => `/drivers/${encodeURIComponent(id)}`,
  idKey: "id",
  fields: [
    { key: "driverCode", label: "Driver Code", type: "text", required: true, placeholder: "e.g. DRV-01" },
    { key: "name", label: "Name", type: "text", required: true },
    { key: "phone", label: "Phone", type: "tel", required: true, placeholder: "01X-XXX XXXX" },
    { key: "icNumber", label: "IC Number", type: "text" },
    { key: "vehicle", label: "Vehicle", type: "text", placeholder: "e.g. Lorry 3-tonne" },
    { key: "inHouse", label: "Fleet", type: "select", options: [
      { value: "true", label: "In-house" }, { value: "false", label: "Outsource" },
    ], placeholder: "In-house" },
    { key: "active", label: "Active", type: "select", options: [
      { value: "true", label: "Active" }, { value: "false", label: "Inactive" },
    ], placeholder: "Active" },
  ],
};

/* fleet — POST /lorries (plate required, type enum), PATCH /lorries/:id.
   Response wraps as { lorry: {...} }; id = lorry.id. capacityM3 / capacityKg
   are numeric(.,.) → plain numbers (NOT money). */
export const FORM_FLEET: FormSchema = {
  title: "Lorry",
  eyebrow: "Transportation",
  base: "scm",
  createPath: "/lorries",
  updatePath: (id) => `/lorries/${encodeURIComponent(id)}`,
  idKey: "id",
  fields: [
    { key: "plate", label: "Plate", type: "text", required: true, placeholder: "e.g. VBA 1234" },
    { key: "type", label: "Type", type: "select", options: [
      { value: "LORRY_10FT", label: "Lorry 10ft" }, { value: "LORRY_14FT", label: "Lorry 14ft" },
      { value: "LORRY_17FT", label: "Lorry 17ft" }, { value: "LORRY_21FT", label: "Lorry 21ft" },
      { value: "VAN", label: "Van" }, { value: "OUTSOURCE", label: "Outsource" }, { value: "OTHER", label: "Other" },
    ], placeholder: "Other" },
    { key: "isInternal", label: "Fleet", type: "select", options: [
      { value: "true", label: "In-house" }, { value: "false", label: "Outsource" },
    ], placeholder: "In-house" },
    { key: "capacityM3", label: "Capacity (m3)", type: "number" },
    { key: "capacityKg", label: "Capacity (kg)", type: "number" },
    { key: "notes", label: "Notes", type: "textarea" },
    { key: "active", label: "Active", type: "select", options: [
      { value: "true", label: "Active" }, { value: "false", label: "Inactive" },
    ], placeholder: "Active" },
  ],
};

/* warehouse — CREATE ONLY. There is no base POST /warehouse; a warehouse row
   has no per-record edit route. The write surface is racks: POST
   /warehouse/racks (warehouseId + rack label required). We pre-fill warehouseId
   from the tapped warehouse row when the parent seeds `initial`, else the
   operator types it. No updatePath → the detail screen shows no Edit button. */
export const FORM_WAREHOUSE: FormSchema = {
  title: "Rack",
  eyebrow: "Storage",
  base: "scm",
  createPath: "/warehouse/racks",
  idKey: "id",
  responseIdKeys: ["id"],
  fields: [
    { key: "warehouseId", label: "Warehouse ID", type: "text", required: true, hint: "The warehouse this rack belongs to." },
    { key: "rack", label: "Rack Label", type: "text", required: true, placeholder: "e.g. Rack A1" },
    { key: "position", label: "Position", type: "text" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
};

/* departments — CORE. POST /api/departments (name required), PATCH
   /api/departments/:id. Create returns the record flat ({ id, name, ... });
   PATCH returns { ok:true } so edit keeps the row's own id. color = 6-char hex
   (no '#'); sort_order = integer. */
export const FORM_DEPARTMENTS: FormSchema = {
  title: "Department",
  eyebrow: "Team",
  base: "core",
  createPath: "/api/departments",
  updatePath: (id) => `/api/departments/${encodeURIComponent(id)}`,
  idKey: "id",
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "description", label: "Description", type: "textarea" },
    { key: "color", label: "Color (hex)", type: "text", placeholder: "64748b", hint: "6-character hex, no #." },
    { key: "sort_order", label: "Sort Order", type: "number", integer: true },
  ],
};

/* positions — CORE. POST /api/positions (name required), PATCH
   /api/positions/:id. Create returns { id, slug, name }; PATCH returns
   { ok:true }. department_id is a real record → runtime select from
   GET /api/departments. level / sort_order = integers. */
export const FORM_POSITIONS: FormSchema = {
  title: "Position",
  eyebrow: "Team",
  base: "core",
  createPath: "/api/positions",
  updatePath: (id) => `/api/positions/${encodeURIComponent(id)}`,
  idKey: "id",
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "department_id", label: "Department", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/departments", listKey: "departments", value: (r) => r.id, label: (r) => r.name } },
    { key: "level", label: "Level", type: "number", integer: true, hint: "Lower = more senior. Default 100." },
    { key: "sort_order", label: "Sort Order", type: "number", integer: true },
  ],
};

/* members — CORE. CREATE = INVITE: POST /api/users/invite (email + role_id
   required; optional name / department_id / position_id / phone). Returns
   { token, ... } or { active, email } — no user id, so onSaved gets "".
   EDIT: PATCH /api/users/:id (role_id / status / name / phone / department_id /
   position_id / email). role_id, department_id, position_id are real records →
   runtime selects. status enum on the routes is active|disabled. Note: invite
   requires users.manage (permission-gated — a 403 surfaces inline). */
export const FORM_MEMBERS: FormSchema = {
  title: "Member",
  eyebrow: "Team",
  base: "core",
  createPath: "/api/users/invite",
  updatePath: (id) => `/api/users/${encodeURIComponent(id)}`,
  idKey: "id",
  responseIdKeys: ["id"],
  fields: [
    { key: "email", label: "Email", type: "email", required: true, placeholder: "member@example.com" },
    { key: "name", label: "Name", type: "text" },
    { key: "role_id", label: "Role", type: "select", required: true, placeholder: "Select role…",
      optionsSource: { base: "core", path: "/api/roles", listKey: "roles", value: (r) => r.id, label: (r) => r.name } },
    { key: "department_id", label: "Department", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/departments", listKey: "departments", value: (r) => r.id, label: (r) => r.name } },
    { key: "position_id", label: "Position", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/positions", listKey: "positions", value: (r) => r.id, label: (r) => `${r.name}${r.department_name ? ` (${r.department_name})` : ""}` } },
    { key: "phone", label: "Phone", type: "tel" },
  ],
};

/* members EDIT — PATCH /api/users/:id. The invite create-form above can't carry
   `status` (invite has no status field), so edit mode swaps in a status select.
   MobileApp uses FORM_MEMBERS_EDIT for the Edit button and FORM_MEMBERS for
   + New. Shares the same base/paths/idKey. */
export const FORM_MEMBERS_EDIT: FormSchema = {
  ...FORM_MEMBERS,
  fields: [
    { key: "name", label: "Name", type: "text" },
    { key: "email", label: "Email", type: "email" },
    { key: "role_id", label: "Role", type: "select", placeholder: "Select role…",
      optionsSource: { base: "core", path: "/api/roles", listKey: "roles", value: (r) => r.id, label: (r) => r.name } },
    { key: "department_id", label: "Department", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/departments", listKey: "departments", value: (r) => r.id, label: (r) => r.name } },
    { key: "position_id", label: "Position", type: "select", placeholder: "Unassigned",
      optionsSource: { base: "core", path: "/api/positions", listKey: "positions", value: (r) => r.id, label: (r) => `${r.name}${r.department_name ? ` (${r.department_name})` : ""}` } },
    { key: "phone", label: "Phone", type: "tel" },
    { key: "status", label: "Status", type: "select", options: [
      { value: "active", label: "Active" }, { value: "disabled", label: "Disabled" },
    ], placeholder: "Active" },
  ],
};

export const MODULE_CONFIGS: Record<string, ModuleConfig> = {
  // suppliers.get('/') → { suppliers: [...] }; cols: code, name, contact_person,
  // phone, mobile, whatsapp_number, derived_category, status…
  // Design m-suppliers: Code/Contact/Phone/Supplies + category pill. "Supplies"
  // has NO column (it's a bindings join) → OMITTED.
  suppliers: {
    title: "Suppliers",
    eyebrow: "Procurement",
    placeholder: "Search name · code · contact",
    endpoint: "/suppliers?limit=200",
    listKey: "suppliers",
    primary: (r) => r.name,
    secondary: (r) => join(r.code, formatPhone(r.phone || r.mobile)),
    right: (r) => r.status ?? "",
    search: (r) => join(r.name, r.code, r.phone, r.contact_person, r.email),
    pill: (r) => pick(r, "derivedCategory", "derived_category", "category") ?? "",
    fields: [
      [(r) => pick(r, "code") ?? "—", "Code"],
      [(r) => pick(r, "contactPerson", "contact_person", "attention") ?? "—", "Contact"],
      [(r) => formatPhone(pick(r, "phone", "mobile", "whatsappNumber", "whatsapp_number")) || "—", "Phone"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_SUPPLIERS,
  },

  // delivery-orders-mfg.get('/') → { deliveryOrders: [...] }; header cols:
  // do_number, debtor_name, status, do_date, local_total_centi…
  // Design m-do: Customer/DO No/Date/Driver/Items/Value + status pill. Real cols:
  // debtor_name, do_number, do_date, driver_name, line_count, local_total_centi,
  // status. All present → all fields bound.
  "delivery-orders-mfg": {
    title: "Delivery Orders",
    eyebrow: "Logistics",
    placeholder: "Search DO · customer",
    endpoint: "/delivery-orders-mfg?limit=500&fields=minimal",
    listKey: "deliveryOrders",
    primary: (r) => r.debtor_name,
    secondary: (r) => join(r.do_number, r.status, dm(r.do_date)),
    right: (r) => r.local_total_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.do_number, r.so_doc_no, r.ref, r.phone),
    statusDocType: "do",
    pill: (r) => scmStatusLabel("do", pick(r, "status")),
    // Spec #do-list: name + status badge, "{{doc_no}} · {{delivery_date}}" sub-
    // line, footer "Driver {{name}}" + RM {{total_centi}}. items_summary has no
    // list column → line-count shown in the footer left instead.
    variant: "doc",
    subline: (r) => {
      const so = pick(r, "soDocNo", "so_doc_no");
      return join(pick(r, "doNumber", "do_number"), dm(pick(r, "doDate", "do_date")), so ? `SO ${so}` : "");
    },
    brand: (r) => pick(r, "branding") ?? "",
    footL: (r) => ["Driver", pick(r, "driverName", "driver_name") ?? "—"],
    footR: (r) => pick(r, "localTotalCenti", "local_total_centi"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "doNumber", "do_number") ?? "—", "DO No"],
      [(r) => dm(pick(r, "doDate", "do_date")), "Date"],
      /* Owner 2026-07-24 — Processing (linked SO's internal_expected_dd,
         stamped server-side) + Delivery in every quick view; desktop drawer
         parity. */
      [(r) => dm(pick(r, "soInternalExpectedDd", "so_internal_expected_dd")), "Processing"],
      [(r) => dm(pick(r, "customerDeliveryDate", "customer_delivery_date")), "Delivery"],
      [(r) => pick(r, "driverName", "driver_name") ?? "—", "Driver"],
      [(r) => { const n = pick(r, "lineCount", "line_count"); return n == null ? "—" : String(n); }, "Items"],
      [(r) => rmField(pick(r, "localTotalCenti", "local_total_centi")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "Dispatched", label: "Dispatched", match: (r) => eq(pick(r, "status"), "dispatched") },
      { key: "Delivered", label: "Delivered", match: (r) => eq(pick(r, "status"), "delivered") },
      { key: "Cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [
      { key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "doDate", "do_date"), pick(b, "doDate", "do_date")) },
      { key: "cust", label: "Customer", cmp: (a, b) => byStr(a.debtor_name, b.debtor_name) },
    ],
  },

  // sales-invoices.get('/') → { salesInvoices: [...] }; header cols:
  // invoice_number, debtor_name, invoice_date, total_centi, status…
  // Design m-si: Inv No/Date/Due/Amount/Balance + status pill. Real cols:
  // invoice_number, invoice_date, due_date, total_centi, paid_centi, status.
  // Balance is computed total − paid.
  "sales-invoices": {
    title: "Sales Invoices",
    eyebrow: "Finance",
    placeholder: "Search invoice · customer",
    endpoint: "/sales-invoices?limit=500&fields=minimal",
    listKey: "salesInvoices",
    primary: (r) => r.debtor_name,
    secondary: (r) => join(r.invoice_number, r.status, dm(r.invoice_date)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.invoice_number, r.so_doc_no, r.ref, r.phone),
    statusDocType: "si",
    pill: (r) => scmStatusLabel("si", pick(r, "status")),
    // Spec #si-list: "{{doc_no}} · due {{due_date}}" sub-line, footer
    // "Balance RM {{balance_centi}}" + RM {{total_centi}} (balance computed).
    variant: "doc",
    subline: (r) => join(pick(r, "invoiceNumber", "invoice_number"), dm(pick(r, "dueDate", "due_date")) !== "—" ? `due ${dm(pick(r, "dueDate", "due_date"))}` : ""),
    brand: (r) => pick(r, "branding") ?? "",
    footL: (r) => ["Balance", rmField(balanceCenti(r))],
    footR: (r) => pick(r, "totalCenti", "total_centi", "localTotalCenti", "local_total_centi"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "invoiceNumber", "invoice_number") ?? "—", "Inv No"],
      [(r) => dm(pick(r, "invoiceDate", "invoice_date")), "Date"],
      [(r) => dm(pick(r, "dueDate", "due_date")), "Due"],
      /* Owner 2026-07-24 — Processing (linked SO's internal_expected_dd,
         stamped server-side) + Delivery (SI snapshot, falling back to the
         linked SO's date) in every quick view; desktop drawer parity. */
      [(r) => dm(pick(r, "soInternalExpectedDd", "so_internal_expected_dd")), "Processing"],
      [(r) => dm(pick(r, "customerDeliveryDate", "customer_delivery_date") ?? pick(r, "soCustomerDeliveryDate", "so_customer_delivery_date")), "Delivery"],
      [(r) => rmField(pick(r, "totalCenti", "total_centi", "localTotalCenti", "local_total_centi")), "Amount"],
      [(r) => rmField(balanceCenti(r)), "Balance"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "sent", label: "Sent", match: (r) => eq(pick(r, "status"), "sent") },
      { key: "partial", label: "Part. paid", match: (r) => /partial/i.test(String(pick(r, "status") ?? "")) },
      { key: "paid", label: "Paid", match: (r) => eq(pick(r, "status"), "paid") },
      { key: "overdue", label: "Overdue", match: (r) => eq(pick(r, "status"), "overdue") },
    ],
    sorts: [
      { key: "due", label: "Due date", cmp: (a, b) => byDate(pick(a, "dueDate", "due_date"), pick(b, "dueDate", "due_date")) },
      { key: "amount", label: "Amount", cmp: (a, b) => byNum(pick(a, "totalCenti", "total_centi"), pick(b, "totalCenti", "total_centi")) },
    ],
  },

  // grns.get('/') → { grns: [...] }; header cols: grn_number, received_at,
  // status, total_centi + nested supplier:{code,name}.
  // Design m-gr: GR No/PO/Date/Items + status pill. Real cols: grn_number,
  // nested purchase_order.po_number, received_at, status. Items count has NO
  // column on the list row (items are a separate table) → OMITTED.
  grns: {
    title: "Goods Received",
    eyebrow: "Warehouse",
    placeholder: "Search GRN · supplier · PO",
    endpoint: "/grns?limit=500&fields=minimal",
    listKey: "grns",
    primary: (r) => r.supplier?.name || r.grn_number,
    secondary: (r) => join(r.grn_number, r.status, dm(r.received_at)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.grn_number, r.supplier?.name, r.supplier?.code, r.delivery_note_ref),
    statusDocType: "grn",
    pill: (r) => scmStatusLabel("grn", pick(r, "status")),
    // Spec #grn-list: name + status, "{{doc_no}} · {{received_date}} · PO
    // {{po_doc_no}}" sub-line, no money footer. items_summary has no list column.
    variant: "doc",
    subline: (r) => {
      const po = r.purchase_order?.po_number ?? r.purchaseOrder?.poNumber;
      const dn = pick(r, "deliveryNoteRef", "delivery_note_ref");
      return join(pick(r, "grnNumber", "grn_number"), dm(pick(r, "receivedAt", "received_at")), po ? `PO ${po}` : "", dn ? `DN ${dn}` : "");
    },
    fields: [
      [(r) => pick(r, "grnNumber", "grn_number") ?? "—", "GR No"],
      [(r) => r.purchase_order?.po_number ?? r.purchaseOrder?.poNumber ?? "—", "PO"],
      [(r) => dm(pick(r, "receivedAt", "received_at")), "Date"],
      [(r) => rmField(pick(r, "totalCenti", "total_centi")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "draft", label: "Draft", match: (r) => eq(pick(r, "status"), "draft") },
      { key: "posted", label: "Posted", match: (r) => eq(pick(r, "status"), "posted") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "receivedAt", "received_at"), pick(b, "receivedAt", "received_at")) }],
  },

  // mfg-purchase-orders.get('/') → { purchaseOrders: [...] }; header cols:
  // po_number, status, po_date, total_centi + nested supplier:{code,name}.
  // Design m-po: Supplier/PO No/Date/Expected/Value + status pill. Real cols:
  // po_number, po_date, expected_at, total_centi, status, nested supplier.name.
  "mfg-purchase-orders": {
    title: "Purchase Orders",
    eyebrow: "Procurement",
    placeholder: "Search PO · supplier",
    endpoint: "/mfg-purchase-orders?limit=500&fields=minimal",
    listKey: "purchaseOrders",
    primary: (r) => r.supplier?.name || r.po_number,
    secondary: (r) => join(r.po_number, r.status, dm(r.po_date)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.po_number, r.supplier?.name, r.supplier?.code),
    statusDocType: "po",
    pill: (r) => scmStatusLabel("po", pick(r, "status")),
    // Spec #po-list: name + status, "{{doc_no}} · exp {{expected_date}}" sub-line,
    // footer "{{line_count}} lines" + RM {{total_centi}}.
    variant: "doc",
    subline: (r) => join(pick(r, "poNumber", "po_number"), dm(pick(r, "expectedAt", "expected_at")) !== "—" ? `exp ${dm(pick(r, "expectedAt", "expected_at"))}` : ""),
    footL: (r) => { const n = pick(r, "lineCount", "line_count"); return ["", n == null ? "" : `${n} lines`]; },
    footR: (r) => pick(r, "totalCenti", "total_centi"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "poNumber", "po_number") ?? "—", "PO No"],
      [(r) => dm(pick(r, "poDate", "po_date")), "Date"],
      [(r) => dm(pick(r, "expectedAt", "expected_at")), "Expected"],
      [(r) => rmField(pick(r, "totalCenti", "total_centi")), "Value"],
    ],
    // Mirrors the desktop PO list (PurchaseOrders.tsx): the buyer's 95% view is
    // "Outstanding" = SUBMITTED ∪ PARTIALLY_RECEIVED (still inbound), plus a
    // Draft review queue; All is the escape hatch for closed/cancelled history.
    // PoStatus has no "open" — the old chip never matched (audit #2).
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "outstanding", label: "Outstanding", match: (r) => { const st = String(pick(r, "status") ?? "").toUpperCase(); return st === "SUBMITTED" || st === "PARTIALLY_RECEIVED"; } },
      { key: "draft", label: "Draft", match: (r) => eq(pick(r, "status"), "draft") },
    ],
    sorts: [
      { key: "exp", label: "Expected", cmp: (a, b) => byDate(pick(a, "expectedAt", "expected_at"), pick(b, "expectedAt", "expected_at")) },
      { key: "total", label: "Value", cmp: (a, b) => byNum(pick(a, "totalCenti", "total_centi"), pick(b, "totalCenti", "total_centi")) },
    ],
  },

  // warehouse.get('/') → { racks, warehouses }; warehouses row = {id,code,name}
  // ONLY. Design m-warehouse wants Code/State/Items/Utilisation — State, Items
  // and Utilisation have NO per-warehouse column → OMITTED; only Code is bound.
  // Pill = the warehouse code (design pillKey:'code').
  warehouse: {
    title: "Warehouses",
    eyebrow: "Network",
    placeholder: "Search name · code",
    endpoint: "/warehouse",
    listKey: "warehouses",
    primary: (r) => r.name,
    secondary: (r) => join(r.code),
    search: (r) => join(r.name, r.code),
    pill: (r) => pick(r, "code") ?? "",
    // Spec #warehouse: name + grey code badge, "{{address}}, {{state}}" line,
    // "SKUs {{sku_count}} · Units {{unit_count}}" footer. warehouses row is
    // {id,code,name} ONLY → address / state / counts have no column (line hidden,
    // KPI values em-dash).
    variant: "warehouse",
    subline: () => "",
    note: (r) => join(pick(r, "address"), pick(r, "state")),
    kpis: (r) => {
      const skus = pick(r, "skuCount", "sku_count");
      const units = pick(r, "unitCount", "unit_count");
      return [["SKUs", skus == null ? "—" : String(skus)], ["Units", units == null ? "—" : String(units)]];
    },
    fields: [
      [(r) => pick(r, "code") ?? "—", "Code"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_WAREHOUSE,
  },

  // inventory.get('/')?showAll=true → { balances, warehouses }; balances cols
  // (v_inventory_all_skus): product_code, product_name, category, qty,
  // warehouse_name, value_sen…
  // Design m-inventory: SKU/Warehouse/On hand/Reserved + stock-level pill. Real
  // v_inventory_all_skus cols: product_code, product_name, warehouse_code/_name,
  // qty, category. Reserved has NO column on this view → OMITTED. Level pill
  // (In stock / Low / Zero) is computed client-side from qty.
  inventory: {
    title: "Inventory",
    eyebrow: "Stock",
    placeholder: "Search product · SKU",
    endpoint: "/inventory?showAll=true",
    listKey: "balances",
    primary: (r) => lineIdentity({ code: r.product_code, description: r.product_name }).primary,
    secondary: (r) => join(r.product_code, r.category, r.warehouse_code ?? r.warehouse_name),
    right: (r) => (r.qty == null ? "" : `${r.qty}`),
    search: (r) => join(r.product_name, r.product_code, r.category, r.warehouse_name),
    pill: (r) => stockLevel(pick(r, "qty")),
    // Spec #inventory: name + stock badge, "{{warehouse_name}}" sub-line, 3-KPI
    // footer (On hand / Reserved / Available). v_inventory_all_skus has only qty
    // → Reserved / Available have no column and render em-dash.
    // Description ONCE, code NOT displayed — the shared rule
    // (vendor/shared/line-identity.ts): the sub-line's "SKU {{sku}}" repeated the
    // identity `primary` already names. WAREHOUSE is not a duplicate and stays.
    // The code still BINDS — `search` above still matches on product_code, so a
    // rep can still find a row by typing its SKU.
    variant: "inventory",
    subline: (r) => join(pick(r, "warehouseCode", "warehouse_code", "warehouseName", "warehouse_name")),
    kpis: (r) => {
      const n = pick(r, "qty");
      return [["On hand", n == null ? "—" : String(n)], ["Reserved", "—"], ["Available", n == null ? "—" : String(n)]];
    },
    fields: [
      [(r) => pick(r, "productCode", "product_code") ?? "—", "SKU"],
      [(r) => pick(r, "warehouseCode", "warehouse_code", "warehouseName", "warehouse_name") ?? "—", "Warehouse"],
      [(r) => { const n = pick(r, "qty"); return n == null ? "—" : String(n); }, "On hand"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "in", label: "In stock", match: (r) => Number(pick(r, "qty") ?? 0) > 0 },
      { key: "zero", label: "Zero", match: (r) => Number(pick(r, "qty") ?? 0) === 0 },
      { key: "neg", label: "Negative", match: (r) => Number(pick(r, "qty") ?? 0) < 0 },
    ],
    sorts: [
      { key: "name", label: "Name", cmp: (a, b) => byStr(a.product_name, b.product_name) },
      { key: "onhand", label: "On hand", cmp: (a, b) => byNum(pick(a, "qty"), pick(b, "qty")) },
    ],
  },

  // drivers.get('/') → { drivers: [...] }; cols: driver_code, name, phone,
  // vehicle, in_house, active…
  // Design m-drivers: Phone/Lorry/Trips/Zone + status. Real cols: driver_code,
  // name, phone, vehicle, in_house, active. Lorry, Trips-today and Zone have NO
  // column (drivers are not linked to lorries/trips) → OMITTED; Phone + Vehicle
  // bound. Pill = In-house / Outsource (design "status").
  drivers: {
    title: "Drivers",
    eyebrow: "Fleet",
    placeholder: "Search driver · phone",
    endpoint: "/drivers",
    listKey: "drivers",
    primary: (r) => r.name,
    secondary: (r) => join(r.driver_code, formatPhone(r.phone), r.vehicle),
    right: (r) => (r.in_house ? "In-house" : "Outsource"),
    search: (r) => join(r.name, r.driver_code, r.phone, r.vehicle),
    pill: (r) => (pick(r, "inHouse", "in_house") ? "In-house" : "Outsource"),
    // Spec #drivers: avatar initials + name + "{{phone}} · {{today_stops}} stops"
    // + status badge. today_stops / AVAILABLE-ON_TRIP-OFF status have no column →
    // sub-line shows phone · code; badge keeps the In-house/Outsource fleet flag.
    variant: "person",
    avatar: (r) => r.name ?? "",
    subline: (r) => join(formatPhone(pick(r, "phone")), pick(r, "driverCode", "driver_code")),
    fields: [
      [(r) => formatPhone(pick(r, "phone")) || "—", "Phone"],
      [(r) => pick(r, "driverCode", "driver_code") ?? "—", "Code"],
      [(r) => pick(r, "vehicle") ?? "—", "Vehicle"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_DRIVERS,
  },

  // helpers.get('/') → { helpers: [...] }; cols: helper_code, name, contact,
  // in_house, active… (note: `contact`, not `phone`).
  // Not in the design module map; mirror the drivers template. Real cols:
  // helper_code, name, contact (note: `contact`, not `phone`), in_house.
  helpers: {
    title: "Helpers",
    eyebrow: "Transportation",
    placeholder: "Search helper · contact",
    endpoint: "/helpers",
    listKey: "helpers",
    primary: (r) => r.name,
    secondary: (r) => join(r.helper_code, r.contact),
    right: (r) => (r.in_house ? "In-house" : "Outsource"),
    search: (r) => join(r.name, r.helper_code, r.contact),
    pill: (r) => (pick(r, "inHouse", "in_house") ? "In-house" : "Outsource"),
    fields: [
      [(r) => pick(r, "contact") ?? "—", "Contact"],
      [(r) => pick(r, "helperCode", "helper_code") ?? "—", "Code"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
  },

  // CORE api (not SCM): GET /api/users → { users: [...] }; cols name, email,
  // phone, role_name, department_name, position_name, status.
  // Design m-members: Email/Position/Department/Role + status pill. Real cols:
  // name, email, position_name, department_name, role_name, status.
  members: {
    title: "Members",
    eyebrow: "Organisation",
    placeholder: "Search name · position",
    core: true,
    endpoint: "/api/users",
    listKey: "users",
    primary: (r) => r.name || r.email,
    secondary: (r) => join(r.position_name, r.department_name, r.email),
    right: (r) => r.status ?? "",
    search: (r) => join(r.name, r.email, r.phone, r.position_name, r.department_name, r.role_name),
    pill: (r) => humanize(pick(r, "status")),
    // Spec #members: avatar initials + name + "{{position}} · {{department}}"
    // sub-line + status badge (ACTIVE=green / INACTIVE=grey; Invited=amber here).
    variant: "person",
    avatar: (r) => r.name || r.email || "",
    subline: (r) => join(pick(r, "positionName", "position_name"), pick(r, "departmentName", "department_name")),
    fields: [
      [(r) => pick(r, "email") ?? "—", "Email"],
      [(r) => pick(r, "positionName", "position_name") ?? "—", "Position"],
      // Reporting line (Upline). /api/users returns manager_name; it was never
      // surfaced on the member card, so a member's upline read as blank.
      [(r) => pick(r, "managerName", "manager_name") ?? "—", "Reports to"],
      [(r) => pick(r, "departmentName", "department_name") ?? "—", "Department"],
      [(r) => pick(r, "roleName", "role_name") ?? "—", "Role"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "active", label: "Active", match: (r) => eq(pick(r, "status"), "active") },
      { key: "invited", label: "Invited", match: (r) => eq(pick(r, "status"), "invited") },
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_MEMBERS,
  },

  // CORE api: GET /api/positions → { positions: [...] }; cols id, name,
  // department_id (+ department name where joined).
  // Design m-positions: Department/Members/Key access + department pill. Real
  // cols: name, department_name, member_count. "Key access" lives in a separate
  // /positions/:id/page-access endpoint → OMITTED. Pill = department name.
  positions: {
    title: "Positions",
    eyebrow: "Organisation",
    placeholder: "Search position · department",
    core: true,
    endpoint: "/api/positions",
    listKey: "positions",
    primary: (r) => r.name,
    secondary: (r) => join(r.department_name, r.division),
    search: (r) => join(r.name, r.department_name),
    pill: (r) => pick(r, "departmentName", "department_name") ?? "",
    // Spec #positions: title + "{{member_count}} members" grey badge,
    // "{{department_name}}" sub-line, "{{permission_summary}}" note (no column →
    // hidden). badgeText overrides the list badge; pill stays the dept for detail.
    variant: "doc",
    badgeText: (r) => { const n = pick(r, "memberCount", "member_count"); return n == null ? "" : `${n} members`; },
    subline: (r) => pick(r, "departmentName", "department_name") ?? "",
    fields: [
      [(r) => pick(r, "departmentName", "department_name") ?? "—", "Department"],
      [(r) => { const n = pick(r, "memberCount", "member_count"); return n == null ? "—" : String(n); }, "Members"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_POSITIONS,
  },

  // CORE api: GET /api/departments → { departments: [...] }; cols id, name, color.
  // Design m-departments: Head/Members/Positions (no pill). Real cols: name,
  // member_count, color. Head and Positions count have NO column → OMITTED;
  // only Members bound.
  departments: {
    title: "Departments",
    eyebrow: "Organisation",
    placeholder: "Search department",
    core: true,
    endpoint: "/api/departments",
    listKey: "departments",
    primary: (r) => r.name,
    secondary: (r) => join(r.division),
    search: (r) => join(r.name),
    // Spec #departments: name + "{{member_count}}" grey badge, "Head ·
    // {{head_name}}" sub-line (head has no column → em-dash).
    variant: "doc",
    badgeText: (r) => { const n = pick(r, "memberCount", "member_count"); return n == null ? "" : String(n); },
    subline: (r) => `Head · ${pick(r, "headName", "head_name") ?? "—"}`,
    fields: [
      [(r) => { const n = pick(r, "memberCount", "member_count"); return n == null ? "—" : String(n); }, "Members"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_DEPARTMENTS,
  },

  // delivery-returns.get('/') → { deliveryReturns: [...] }; cols return_number,
  // do_doc_no, debtor_name, return_date, status, refund_centi.
  // Design m-pr (Sales Returns): Return No/Date/Reason/Value + status pill. Real
  // cols: return_number, return_date, reason, refund_centi, status. All present.
  "delivery-returns": {
    title: "Delivery Returns",
    eyebrow: "Finance",
    placeholder: "Search return · customer",
    endpoint: "/delivery-returns?limit=500&fields=minimal",
    listKey: "deliveryReturns",
    primary: (r) => r.debtor_name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.return_number, r.do_doc_no),
    statusDocType: "dr",
    pill: (r) => scmStatusLabel("dr", pick(r, "status")),
    // Spec #sr-list: name + status, "{{doc_no}} · {{return_date}} · ref
    // {{so_doc_no}}" sub-line, "{{reason}}" note (hidden when blank), right-only
    // RM {{refund_centi}} footer.
    variant: "doc",
    subline: (r) => {
      const ref = pick(r, "soDocNo", "so_doc_no", "doDocNo", "do_doc_no");
      return join(pick(r, "returnNumber", "return_number"), dm(pick(r, "returnDate", "return_date")), ref ? `ref ${ref}` : "");
    },
    note: (r) => pick(r, "reason") ?? "",
    footR: (r) => pick(r, "refundCenti", "refund_centi"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "returnNumber", "return_number") ?? "—", "Return No"],
      [(r) => dm(pick(r, "returnDate", "return_date")), "Date"],
      [(r) => pick(r, "reason") ?? "—", "Reason"],
      [(r) => rmField(pick(r, "refundCenti", "refund_centi")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "received", label: "Received", match: (r) => eq(pick(r, "status"), "received") },
      { key: "inspected", label: "Inspected", match: (r) => eq(pick(r, "status"), "inspected") },
      { key: "refunded", label: "Refunded", match: (r) => eq(pick(r, "status"), "refunded") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "returnDate", "return_date"), pick(b, "returnDate", "return_date")) }],
  },

  // purchase-invoices.get('/') → { purchaseInvoices: [...] }; cols invoice_number,
  // invoice_date, status, total_centi + nested supplier:{code,name}.
  // Design m-pi: PI No/Date/Due/Amount + status pill. Real cols: invoice_number,
  // invoice_date, due_date, total_centi, status, nested supplier.name.
  "purchase-invoices": {
    title: "Purchase Invoices",
    eyebrow: "Procurement",
    placeholder: "Search PI · supplier",
    endpoint: "/purchase-invoices?limit=500&fields=minimal",
    listKey: "purchaseInvoices",
    primary: (r) => r.supplier?.name || r.invoice_number,
    secondary: (r) => join(r.invoice_number, r.status, dm(r.invoice_date)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.invoice_number, r.supplier?.name, r.supplier_invoice_ref),
    statusDocType: "pi",
    pill: (r) => scmStatusLabel("pi", pick(r, "status")),
    // Spec #pi-list: name + status, "{{doc_no}} · due {{due_date}}" sub-line,
    // footer "Balance RM {{balance_centi}}" + RM {{total_centi}}.
    variant: "doc",
    // PI can carry due + a GRN + a PO — showing all three crams the sub-line at
    // phone width, so surface the single most-useful source: the GRN it invoices
    // (the direct 3-way-match basis) when present, else the PO. Both remain on
    // the detail screen.
    subline: (r) => {
      const due = dm(pick(r, "dueDate", "due_date"));
      const grn = r.grn?.grn_number ?? r.grn?.grnNumber;
      const po = r.purchase_order?.po_number ?? r.purchaseOrder?.poNumber;
      const src = grn ? `GRN ${grn}` : po ? `PO ${po}` : "";
      return join(pick(r, "invoiceNumber", "invoice_number"), due !== "—" ? `due ${due}` : "", src);
    },
    footL: (r) => ["Balance", rmField(balanceCenti(r))],
    footR: (r) => pick(r, "totalCenti", "total_centi"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "invoiceNumber", "invoice_number") ?? "—", "PI No"],
      [(r) => dm(pick(r, "invoiceDate", "invoice_date")), "Date"],
      [(r) => dm(pick(r, "dueDate", "due_date")), "Due"],
      [(r) => rmField(pick(r, "totalCenti", "total_centi")), "Amount"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "unpaid", label: "Unpaid", match: (r) => eq(pick(r, "status"), "unpaid") },
      { key: "paid", label: "Paid", match: (r) => eq(pick(r, "status"), "paid") },
      { key: "overdue", label: "Overdue", match: (r) => eq(pick(r, "status"), "overdue") },
    ],
    sorts: [
      { key: "due", label: "Due date", cmp: (a, b) => byDate(pick(a, "dueDate", "due_date"), pick(b, "dueDate", "due_date")) },
      { key: "total", label: "Amount", cmp: (a, b) => byNum(pick(a, "totalCenti", "total_centi"), pick(b, "totalCenti", "total_centi")) },
    ],
  },

  // purchase-returns.get('/') → { purchaseReturns: [...] }; cols return_number,
  // return_date, status, refund_centi + nested supplier:{code,name}.
  // Design m-preturn: Return No/Date/Reason/Value + status pill. Real cols:
  // return_number, return_date, reason, refund_centi, status, nested supplier.
  "purchase-returns": {
    title: "Purchase Returns",
    eyebrow: "Procurement",
    placeholder: "Search return · supplier",
    endpoint: "/purchase-returns?limit=300&fields=minimal",
    listKey: "purchaseReturns",
    primary: (r) => r.supplier?.name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_centi,
    rightMoney: true,
    search: (r) => join(r.return_number, r.supplier?.name, r.credit_note_ref),
    statusDocType: "pr",
    pill: (r) => scmStatusLabel("pr", pick(r, "status")),
    // Spec #preturn-list: name + status, "{{doc_no}} · {{return_date}} · PO
    // {{po_doc_no}}" sub-line, "{{reason}}" note (hidden when blank), right-only
    // RM {{refund_centi}} footer.
    variant: "doc",
    subline: (r) => {
      const po = pick(r, "poDocNo", "po_doc_no", "sourcePoDocNo", "source_po_doc_no");
      return join(pick(r, "returnNumber", "return_number"), dm(pick(r, "returnDate", "return_date")), po ? `PO ${po}` : "");
    },
    note: (r) => pick(r, "reason") ?? "",
    footR: (r) => pick(r, "refundCenti", "refund_centi"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "returnNumber", "return_number") ?? "—", "Return No"],
      [(r) => dm(pick(r, "returnDate", "return_date")), "Date"],
      [(r) => pick(r, "reason") ?? "—", "Reason"],
      [(r) => rmField(pick(r, "refundCenti", "refund_centi")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "draft", label: "Draft", match: (r) => eq(pick(r, "status"), "draft") },
      { key: "posted", label: "Posted", match: (r) => eq(pick(r, "status"), "posted") },
      { key: "completed", label: "Completed", match: (r) => eq(pick(r, "status"), "completed") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "returnDate", "return_date"), pick(b, "returnDate", "return_date")) }],
  },

  // purchase-consignment-orders.get('/') → { purchaseOrders: [...] }; cols
  // pc_number, po_date, status, total_centi + nested supplier:{code,name}.
  "purchase-consignment-orders": {
    title: "Purchase Consignment Orders",
    eyebrow: "Consignment",
    placeholder: "Search doc · supplier",
    endpoint: "/purchase-consignment-orders",
    listKey: "purchaseOrders",
    primary: (r) => r.supplier?.name || r.pc_number,
    secondary: (r) => join(r.pc_number, r.status, dm(r.po_date)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.pc_number, r.supplier?.name),
    statusDocType: "po",
    pill: (r) => scmStatusLabel("po", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "pcNumber", "pc_number"), dm(pick(r, "poDate", "po_date"))),
    footR: (r) => pick(r, "totalCenti", "total_centi"),
    footMoney: true,
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "poDate", "po_date"), pick(b, "poDate", "po_date")) }],
  },

  // purchase-consignment-receives.get('/') → { grns: [...] }; cols
  // receive_number, received_at, status, total_centi + nested supplier + pc_order_no.
  "purchase-consignment-receives": {
    title: "Purchase Consignment Receives",
    eyebrow: "Consignment",
    placeholder: "Search receive · supplier",
    endpoint: "/purchase-consignment-receives",
    listKey: "grns",
    primary: (r) => r.supplier?.name || r.receive_number,
    secondary: (r) => join(r.receive_number, r.status, dm(r.received_at)),
    right: (r) => r.total_centi,
    rightMoney: true,
    search: (r) => join(r.receive_number, r.supplier?.name, r.pc_order_no),
    statusDocType: "grn",
    pill: (r) => scmStatusLabel("grn", pick(r, "status")),
    variant: "doc",
    subline: (r) => {
      const po = pick(r, "pcOrderNo", "pc_order_no");
      return join(pick(r, "receiveNumber", "receive_number"), dm(pick(r, "receivedAt", "received_at")), po ? `PC ${po}` : "");
    },
    footR: (r) => pick(r, "totalCenti", "total_centi"),
    footMoney: true,
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "receivedAt", "received_at"), pick(b, "receivedAt", "received_at")) }],
  },

  // purchase-consignment-returns.get('/') → { purchaseReturns: [...] }; cols
  // return_number, return_date, status, refund_centi.
  "purchase-consignment-returns": {
    title: "Purchase Consignment Returns",
    eyebrow: "Consignment",
    placeholder: "Search return · doc",
    endpoint: "/purchase-consignment-returns",
    listKey: "purchaseReturns",
    primary: (r) => r.supplier?.name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_centi,
    rightMoney: true,
    search: (r) => join(r.return_number, r.supplier?.name),
    statusDocType: "pr",
    pill: (r) => scmStatusLabel("pr", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "returnNumber", "return_number"), dm(pick(r, "returnDate", "return_date"))),
    note: (r) => pick(r, "reason") ?? "",
    footR: (r) => pick(r, "refundCenti", "refund_centi"),
    footMoney: true,
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "returnDate", "return_date"), pick(b, "returnDate", "return_date")) }],
  },

  // consignment-orders.get('/') → { salesOrders: [...] }; cols doc_no,
  // debtor_name, so_date, status, local_total_centi.
  "consignment-orders": {
    title: "Consignment Orders",
    eyebrow: "Consignment",
    placeholder: "Search consignment · customer",
    endpoint: "/consignment-orders?limit=500",
    listKey: "salesOrders",
    primary: (r) => r.debtor_name || r.doc_no,
    secondary: (r) => join(r.doc_no, r.status, dm(r.so_date)),
    right: (r) => r.local_total_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.doc_no, r.ref, r.po_doc_no),
    pill: (r) => humanize(pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "docNo", "doc_no"), dm(pick(r, "soDate", "so_date"))),
    footR: (r) => pick(r, "localTotalCenti", "local_total_centi"),
    footMoney: true,
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "open", label: "Open", match: (r) => eq(pick(r, "status"), "open") },
      { key: "partial", label: "Part. ret", match: (r) => /partial/i.test(String(pick(r, "status") ?? "")) },
      { key: "closed", label: "Closed", match: (r) => eq(pick(r, "status"), "closed") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "soDate", "so_date"), pick(b, "soDate", "so_date")) }],
  },

  // consignment-notes.get('/') → { deliveryOrders: [...] } (consignment note
  // headers). §38 Consignment Notes (doc card): partner + status, doc_no · date.
  "consignment-notes": {
    title: "Consignment Notes",
    eyebrow: "Consignment",
    placeholder: "Search note · partner",
    endpoint: "/consignment-notes?limit=500",
    listKey: "deliveryOrders",
    primary: (r) => pick(r, "debtorName", "debtor_name") ?? pick(r, "docNo", "doc_no", "doNumber", "do_number") ?? "—",
    secondary: (r) => join(pick(r, "docNo", "doc_no", "doNumber", "do_number"), pick(r, "status"), dm(pick(r, "noteDate", "note_date", "doDate", "do_date"))),
    search: (r) => join(pick(r, "debtorName", "debtor_name"), pick(r, "docNo", "doc_no", "doNumber", "do_number")),
    statusDocType: "do",
    pill: (r) => scmStatusLabel("do", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "docNo", "doc_no", "doNumber", "do_number"), dm(pick(r, "noteDate", "note_date", "doDate", "do_date"))),
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "noteDate", "note_date", "doDate", "do_date"), pick(b, "noteDate", "note_date", "doDate", "do_date")) }],
  },

  // consignment-returns.get('/') → { deliveryReturns: [...] }; cols
  // return_number, debtor_name, return_date, status, refund_centi.
  "consignment-returns": {
    title: "Consignment Returns",
    eyebrow: "Consignment",
    placeholder: "Search return · partner",
    endpoint: "/consignment-returns?limit=500",
    listKey: "deliveryReturns",
    primary: (r) => r.debtor_name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_centi,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.return_number, r.do_doc_no),
    statusDocType: "dr",
    pill: (r) => scmStatusLabel("dr", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "returnNumber", "return_number"), dm(pick(r, "returnDate", "return_date"))),
    note: (r) => pick(r, "reason") ?? "",
    footR: (r) => pick(r, "refundCenti", "refund_centi"),
    footMoney: true,
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "returnDate", "return_date"), pick(b, "returnDate", "return_date")) }],
  },

  // mfg-products.get('/') → { products: [...] }; the SKU MASTER (mfg_products),
  // NOT the retail /products view. Repointed here (from /products) so the mobile
  // list, detail, CREATE and EDIT all share ONE surface whose row id is the
  // mfg_products text PK the PATCH /mfg-products/:id keys on. Cols: id, code,
  // name, category (string enum), base_price_sen, sell_price_sen, status,
  // size_label, branding, barcode.
  // Design m-products: SKU/Brand/Price + category pill. Prices are SEN.
  products: {
    title: "Products & Maintenance",
    eyebrow: "Catalogue",
    placeholder: "Search name · SKU",
    endpoint: "/mfg-products",
    listKey: "products",
    primary: (r) => lineIdentity({ code: pick(r, "code", "sku"), description: r.name }).primary,
    secondary: (r) => join(pick(r, "code", "sku"), pick(r, "category"), pick(r, "sizeLabel", "size_label")),
    right: (r) => pick(r, "basePriceSen", "base_price_sen") ?? "",
    rightMoney: true,
    search: (r) => join(r.name, pick(r, "code", "sku"), pick(r, "category"), pick(r, "branding"), pick(r, "barcode")),
    pill: (r) => humanize(pick(r, "category")),
    // Spec #products: .ph thumbnail + name + "{{category}}" sub-line + right
    // "RM {{price_centi}}". base_price_sen is the base selling price (SEN); uom
    // has no mfg column → omitted.
    // Description ONCE, code NOT displayed — the shared rule
    // (vendor/shared/line-identity.ts). This is the browse twin of the
    // MobileSkuPicker rows converged in #626 ("description only — one scannable
    // line per SKU"), so it reads the same way. CATEGORY is not a duplicate and
    // stays. The code still BINDS — `search` still matches code / sku / barcode.
    variant: "product",
    subline: (r) => join(pick(r, "category")),
    price: (r) => pick(r, "basePriceSen", "base_price_sen") ?? "",
    priceMoney: true,
    fields: [
      [(r) => pick(r, "code", "sku") ?? "—", "SKU"],
      [(r) => pick(r, "category") ?? "—", "Category"],
      [(r) => rmField(pick(r, "basePriceSen", "base_price_sen")), "Base Price"],
      [(r) => rmField(pick(r, "sellPriceSen", "sell_price_sen")), "Selling Price"],
      [(r) => rmField(pick(r, "costPriceSen", "cost_price_sen")), "Cost Price", "cost"],
      [(r) => humanize(pick(r, "status")) || "—", "Status"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "sofa", label: "Sofa", match: (r) => /sofa/i.test(String(pick(r, "category") ?? "")) },
      { key: "bedframe", label: "Bedframe", match: (r) => /bed\s*frame|bedframe/i.test(String(pick(r, "category") ?? "")) },
      { key: "mattress", label: "Mattress", match: (r) => /mattress/i.test(String(pick(r, "category") ?? "")) },
      { key: "parts", label: "Parts", match: (r) => /part|accessor/i.test(String(pick(r, "category") ?? "")) },
    ],
    sorts: [
      { key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) },
      { key: "price", label: "Price", cmp: (a, b) => byNum(pick(a, "basePriceSen", "base_price_sen"), pick(b, "basePriceSen", "base_price_sen")) },
    ],
  },

  // Design m-mrp: SKU/Required/On hand/Shortage/Incoming + state pill. MrpSku
  // is a COMPUTED type (camelCase keys): itemCode, description, qtyNeeded,
  // stock, shortage, poOutstanding, category, warehouseCode/Name. State pill
  // (In stock / Shortage / On PO) is derived from shortage/poOutstanding.
  mrp: {
    title: "MRP · Stock Status",
    eyebrow: "Planning",
    placeholder: "Search product · SKU",
    endpoint: "/mrp",
    listKey: "skus",
    primary: (r) =>
      lineIdentity({
        code: pick(r, "itemCode", "item_code"),
        description: pick(r, "description"),
      }).primary || "—",
    secondary: (r) => join(pick(r, "itemCode", "item_code"), pick(r, "category"), pick(r, "warehouseCode", "warehouse_code", "warehouseName", "warehouse_name")),
    search: (r) => join(pick(r, "description"), pick(r, "itemCode", "item_code"), pick(r, "category")),
    pill: (r) => mrpState(r),
    // Spec #mrp: name + state badge, 4-col KPI grid (Demand / On hand /
    // Incoming / Shortage). Maps to qtyNeeded / stock / poOutstanding /
    // shortage on the computed MrpSku row.
    // Description ONCE, code NOT displayed — the shared rule
    // (vendor/shared/line-identity.ts). The sub-line was ONLY "SKU {{sku}}", the
    // identity `primary` already names, so it now renders nothing rather than a
    // duplicate; a row whose description is missing still shows its code,
    // because `primary` falls back to it. The code still BINDS — `search` above
    // still matches item_code.
    variant: "mrp",
    subline: () => "",
    kpis: (r) => {
      const g = (...k: string[]) => { const n = pick(r, ...k); return n == null ? "—" : String(n); };
      return [["Demand", g("qtyNeeded", "qty_needed")], ["On hand", g("stock")], ["Incoming", g("poOutstanding", "po_outstanding")], ["Shortage", g("shortage")]];
    },
    fields: [
      [(r) => pick(r, "itemCode", "item_code") ?? "—", "SKU"],
      [(r) => { const n = pick(r, "qtyNeeded", "qty_needed"); return n == null ? "—" : String(n); }, "Required"],
      [(r) => { const n = pick(r, "stock"); return n == null ? "—" : String(n); }, "On hand"],
      [(r) => { const n = pick(r, "shortage"); return n == null ? "—" : String(n); }, "Shortage"],
      [(r) => { const n = pick(r, "poOutstanding", "po_outstanding"); return n == null ? "—" : String(n); }, "Incoming"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "in", label: "In stock", match: (r) => mrpState(r) === "In stock" },
      { key: "short", label: "Shortage", match: (r) => mrpState(r) === "Shortage" },
      { key: "po", label: "On PO", match: (r) => mrpState(r) === "On PO" },
    ],
    sorts: [
      { key: "short", label: "Shortage", cmp: (a, b) => byNum(pick(a, "shortage"), pick(b, "shortage")) },
      { key: "name", label: "Name", cmp: (a, b) => byStr(pick(a, "description", "itemCode"), pick(b, "description", "itemCode")) },
    ],
  },

  // Design m-fleet: Type/Capacity/Driver/Region + status pill. Real cols: plate,
  // type, is_internal, capacity_m3, capacity_kg, active. Driver and Region have
  // NO column on a lorry (lorries aren't linked to drivers) → OMITTED. Status
  // pill: Off (inactive) / In-house / Outsource.
  fleet: {
    title: "Lorries",
    eyebrow: "Fleet",
    placeholder: "Search lorry · type",
    endpoint: "/lorries",
    listKey: "lorries",
    primary: (r) => r.plate,
    secondary: (r) => join(r.type, r.capacity_kg ? `${r.capacity_kg} kg` : r.capacity_m3 ? `${r.capacity_m3} m3` : null),
    right: (r) => (r.active === false ? "Off" : r.is_internal ? "In-house" : "Outsource"),
    search: (r) => join(r.plate, r.type),
    pill: (r) => (pick(r, "active") === false ? "Off" : pick(r, "isInternal", "is_internal") ? "In-house" : "Outsource"),
    // Spec #lorries: plate + status badge, "{{lorry_type}} · {{capacity}}" sub-
    // line, "Assigned {{driver}}" footer. Lorries aren't linked to drivers →
    // Unassigned; AVAILABLE/ON_TRIP/MAINTENANCE has no column → keep fleet flag.
    variant: "doc",
    subline: (r) => join(pick(r, "type"), capacityLabel(r) !== "—" ? capacityLabel(r) : ""),
    footL: () => ["Assigned", "Unassigned"],
    fields: [
      [(r) => pick(r, "type") ?? "—", "Type"],
      [(r) => capacityLabel(r), "Capacity"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "inhouse", label: "In-house", match: (r) => pick(r, "active") !== false && !!pick(r, "isInternal", "is_internal") },
      { key: "outsource", label: "Outsource", match: (r) => pick(r, "active") !== false && !pick(r, "isInternal", "is_internal") },
      { key: "off", label: "Off", match: (r) => pick(r, "active") === false },
    ],
    sorts: [{ key: "plate", label: "Lorry", cmp: (a, b) => byStr(a.plate, b.plate) }],
    form: FORM_FLEET,
  },

  // ── §38 generic read-only SCM modules (2990-verbatim rules) ────────────────
  // stock-transfers.get('/') → { transfers: [...] }; HEADER: id, transfer_no,
  // status, from_warehouse_id, to_warehouse_id, transfer_date, notes,
  // posted_at, cancelled_at + nested from_warehouse/to_warehouse:{code,name} +
  // computed line_count. Design "Stock Transfers": route (From → To) + status,
  // "{{doc_no}} · {{date}}" sub-line, "{{line_count}} lines" footer. No money.
  // NOTE: header has no per-row sku/qty (those are lines) → not shown on card.
  "stock-transfers": {
    title: "Stock Transfers",
    eyebrow: "Warehouse",
    placeholder: "Search transfer · warehouse",
    endpoint: "/stock-transfers",
    listKey: "transfers",
    primary: (r) => {
      const from = pick(r, "fromWarehouse", "from_warehouse")?.name ?? pick(r, "fromWarehouse", "from_warehouse")?.code;
      const to = pick(r, "toWarehouse", "to_warehouse")?.name ?? pick(r, "toWarehouse", "to_warehouse")?.code;
      return from && to ? `${from} → ${to}` : pick(r, "transferNo", "transfer_no") ?? "—";
    },
    secondary: (r) => join(pick(r, "transferNo", "transfer_no"), pick(r, "status"), dm(pick(r, "transferDate", "transfer_date"))),
    search: (r) => join(pick(r, "transferNo", "transfer_no"), pick(r, "fromWarehouse", "from_warehouse")?.name, pick(r, "toWarehouse", "to_warehouse")?.name),
    statusDocType: "stockTransfer",
    pill: (r) => scmStatusLabel("stockTransfer", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "transferNo", "transfer_no"), dm(pick(r, "transferDate", "transfer_date"))),
    footL: (r) => { const n = pick(r, "lineCount", "line_count"); return ["", n == null ? "" : `${n} lines`]; },
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "posted", label: "Posted", match: (r) => eq(pick(r, "status"), "posted") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "transferDate", "transfer_date"), pick(b, "transferDate", "transfer_date")) }],
  },

  // stock-takes.get('/') → { takes: [...] }; HEADER: id, take_no, status,
  // warehouse_id, scope_type, scope_value, take_date, notes, posted_at,
  // cancelled_at + nested warehouse:{code,name} + computed line_count,
  // variance_total. Design "Stock Take": warehouse + status, "{{doc_no}} ·
  // {{date}}" sub-line, "{{line_count}} counted / {{variance_total}}" footer.
  "stock-takes": {
    title: "Stock Take",
    eyebrow: "Warehouse",
    placeholder: "Search stock take · warehouse",
    endpoint: "/stock-takes",
    listKey: "takes",
    primary: (r) => pick(r, "warehouse")?.name ?? pick(r, "warehouse")?.code ?? pick(r, "takeNo", "take_no") ?? "—",
    secondary: (r) => join(pick(r, "takeNo", "take_no"), pick(r, "status"), dm(pick(r, "takeDate", "take_date"))),
    search: (r) => join(pick(r, "takeNo", "take_no"), pick(r, "warehouse")?.name, pick(r, "scopeValue", "scope_value")),
    statusDocType: "stockTake",
    pill: (r) => scmStatusLabel("stockTake", pick(r, "status")),
    variant: "inventory",
    subline: (r) => join(pick(r, "takeNo", "take_no"), dm(pick(r, "takeDate", "take_date"))),
    kpis: (r) => {
      const counted = pick(r, "lineCount", "line_count");
      const variance = pick(r, "varianceTotal", "variance_total");
      return [["Counted", counted == null ? "—" : String(counted)], ["Variance", variance == null ? "—" : String(variance)]];
    },
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "posted", label: "Posted", match: (r) => eq(pick(r, "status"), "posted") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "takeDate", "take_date"), pick(b, "takeDate", "take_date")) }],
  },

  // delivery-planning-regions.get('/') → { regions: [...] }; shaped rows:
  // id, code, name, sortOrder, active, createdAt. Design "Regions": region name
  // + code (grey badge), Zone/Postcodes/Drivers footer — none of Zone /
  // postcode_range / driver_count exist on the region master → OMITTED; only
  // name + code bound. Pill = the region code.
  "delivery-planning-regions": {
    title: "Regions",
    eyebrow: "Transportation",
    placeholder: "Search region · code",
    endpoint: "/delivery-planning-regions",
    listKey: "regions",
    primary: (r) => pick(r, "name") ?? pick(r, "code") ?? "—",
    secondary: (r) => join(pick(r, "code")),
    search: (r) => join(pick(r, "name"), pick(r, "code")),
    pill: (r) => pick(r, "code") ?? "",
    variant: "warehouse",
    subline: () => "",
    note: (r) => (pick(r, "active") === false ? "Inactive" : ""),
    kpis: () => [],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(pick(a, "name"), pick(b, "name")) }],
  },

  // accounting.get('/accounts') → { accounts: [...] }; cols account_code,
  // account_name, account_type, parent_code, is_active. Design "Accounting":
  // Chart of Accounts list — account name + type badge, "{{account_code}} ·
  // {{parent_code}}" sub-line. Journal entries are a separate endpoint
  // (/accounting/journal-entries) not surfaced in this flat list.
  accounting: {
    title: "Accounting",
    eyebrow: "Finance",
    placeholder: "Search account · code",
    endpoint: "/accounting/accounts",
    listKey: "accounts",
    primary: (r) => pick(r, "accountName", "account_name") ?? pick(r, "accountCode", "account_code") ?? "—",
    secondary: (r) => join(pick(r, "accountCode", "account_code"), pick(r, "accountType", "account_type")),
    search: (r) => join(pick(r, "accountName", "account_name"), pick(r, "accountCode", "account_code"), pick(r, "accountType", "account_type")),
    badgeText: (r) => humanize(pick(r, "accountType", "account_type")),
    variant: "doc",
    subline: (r) => { const parent = pick(r, "parentCode", "parent_code"); return join(pick(r, "accountCode", "account_code"), parent ? `under ${parent}` : ""); },
    sorts: [{ key: "code", label: "Code", cmp: (a, b) => byStr(pick(a, "accountCode", "account_code"), pick(b, "accountCode", "account_code")) }],
  },
};

/** Lorry capacity display — prefer kg, fall back to m3, else em-dash. */
const capacityLabel = (r: any): string => {
  const kg = pick(r, "capacityKg", "capacity_kg");
  if (kg != null) return `${Number(kg).toLocaleString("en-MY")} kg`;
  const m3 = pick(r, "capacityM3", "capacity_m3");
  if (m3 != null) return `${m3} m3`;
  return "—";
};
