import { useEffect, useMemo, useRef, useState } from "react";
import { brandingToneForCategory, type BrandTone } from "../lib/brandingTone";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useAuth } from "../auth/AuthContext";
import { quickActionAccess } from "../auth/salesAccess";
import { normalizeJobs, type ScanJobsResp } from "./MobileScan";
import { MobileVirtualList } from "./MobileVirtualList";
import { invalidateSoShared } from "./sharedInvalidate";
import { confirmSoWithFreshVersion } from "./mobile-so-concurrency";
import { fmtSen } from "../lib/scm";
import { brandingLabel, isPlaceholderBrandText } from "../vendor/shared/so-branding-label";
import { getBrandingCompanyCode } from "../lib/branding";
import { resolveSoLocation } from "../lib/soLocation";
import { formatDate } from "../lib/utils";
import { SearchProgress } from "../components/SearchProgress";
import { SearchScopeHint } from "../components/SearchScopeHint";
import { SourcePosRowMobile } from "./source-chips";
import { poCellChips } from "../lib/soPoChips";
import { useEnrichedSoListRows } from "../vendor/scm/lib/sales-order-queries";
import { identityStorageKey } from "../lib/storageIdentity";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../hooks/useServerSearch";
import "./mobile.css";

type SoRow = {
  doc_no: string; debtor_name: string | null; status: string | null;
  sales_location: string | null; warehouse_name: string | null;
  customer_state: string | null; ref: string | null; po_doc_no: string | null;
  customer_so_no: string | null;
  /* Branding — header `branding`, falling back to the derived label built from
     `first_item_category` + `first_item_branding`. All three are already in the
     list payload (backend mfg-sales-orders.ts:1782/1793); drives the card brand
     pill (desktop parity). */
  branding: string | null; first_item_branding: string | null;
  first_item_category: string | null;
  customer_delivery_date: string | null; processing_date: string | null;
  so_date: string | null; created_at: string | null;
  local_total_sen: number | null; total_revenue_sen: number | null; paid_total_sen: number | null;
  balance_sen: number | null; balance_sen_live: number | null;
  /* Fulfilment status the list endpoint derives per SO (only rendered when the
     row actually carries it — a Draft/Cancelled SO has none). */
  planning_state: string | null;
  is_fully_ready: boolean | null; is_main_ready: boolean | null; ready_categories: string[] | null;
  /* Union of per-line source-PO chips (owner 2026-08-02) — the mobile twin of
     the desktop list's PO No. column: shipped consumed batches ∪ READY
     projections, from the ONE shared resolver. `converted_po_nos` (the POs
     this SO's lines were raised INTO) rides alongside since 2026-08-11 and
     renders as muted provenance chips — without it the card showed nothing at
     all for a CONFIRMED, not-yet-shipped order that HAS a purchase order.
     Both surfaces derive the split from lib/soPoChips. */
  source_po_union?: string[] | null;
  converted_po_nos?: string[] | null;
  source_po_adj?: boolean;
};

/* Numeric DD/MM/YYYY, TZ-aware (owner-locked desktop/mobile date format — never
   month names). Delegates to the shared helper so YYYY-MM-DD strings render in
   Asia/Kuala_Lumpur and never drift a day on an off-zone device. */
const dm = (d: string | null | undefined) => formatDate(d);
const total = (r: SoRow) => r.local_total_sen ?? r.total_revenue_sen ?? 0;
const paid = (r: SoRow) => r.paid_total_sen ?? 0;
const balance = (r: SoRow) => r.balance_sen_live ?? r.balance_sen ?? (total(r) - paid(r));
const isCancelled = (r: SoRow) => (r.status ?? "").toLowerCase() === "cancelled";
const isDraft = (r: SoRow) => (r.status ?? "").toLowerCase() === "draft";
const soDate = (r: SoRow) => r.so_date ?? r.created_at ?? null;

/* Brand + tone — copied verbatim from the desktop list (MfgSalesOrdersListV2:
   brandOf/brandTone) so both surfaces resolve the same tone from the same
   payload. 2990/SOFA = success, BEDFRAME = accent, AKEMI/blank = neutral, any
   other brand = warning. Mirrored, not paraphrased. */
/* Desktop parity, and the same fix: the trailing `|| "—"` printed a dash on
   every order whose first line carries no brand TEXT — which is every sofa —
   while the rule that turns a category into a label lived on other pages. One
   shared rule now, and it cannot return blank (owner 2026-08-17). */
const brandOf = (r: SoRow): string =>
  (isPlaceholderBrandText(r.branding) ? "" : (r.branding ?? "").trim()) ||
  brandingLabel(r.first_item_category, r.first_item_branding, getBrandingCompanyCode());
/* This surface carries the line's CATEGORY, so it uses the accurate entry
   point: colour and label then share one bucket rule and cannot disagree.
   ../../lib/brandingTone has the whole story. */
const brandTone = (r: SoRow): BrandTone => brandingToneForCategory(r.first_item_category);

/* ── Draft-created notifier — localStorage ack set ─────────────────────────
   Owner 2026-07-04: "after a scan creates a draft, next time I open the app tell
   me 'SO xxx created as draft'." On the Orders screen mount we read the recent
   done scan jobs (GET /scan-so/jobs) and toast the ones we haven't yet
   acknowledged. Acknowledged job ids live in localStorage so the toast fires
   ONCE per new draft, never re-fires on every navigation back to Orders.
   Bounded to the last N ids so the set can't grow forever. */
const SCAN_ACK_KEY = "houzs:scan-draft-acked";
const SCAN_ACK_MAX = 200;
/* Only consider jobs finished within this window — an old done job the operator
   has long since seen must not toast just because the ack set was cleared. */
const SCAN_ACK_WINDOW_MS = 30 * 60 * 1000; // 30 min

function readAckedJobIds(): Set<string> {
  try {
    const key = identityStorageKey(SCAN_ACK_KEY);
    if (!key) return new Set();
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
  } catch {
    return new Set();
  }
}
function writeAckedJobIds(ids: Set<string>): void {
  try {
    // Keep only the most recent SCAN_ACK_MAX ids (insertion order preserved).
    const arr = Array.from(ids);
    const trimmed = arr.length > SCAN_ACK_MAX ? arr.slice(arr.length - SCAN_ACK_MAX) : arr;
    const key = identityStorageKey(SCAN_ACK_KEY);
    if (key) localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    /* private-mode / quota — the toast just re-fires next open, harmless */
  }
}
const jobTsMs = (s: string | null | undefined): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/* Period chips → SERVER-SIDE so_date window. The chips no longer bucket the
   loaded rows client-side (that only ever matched the ≤500 already fetched);
   each chip maps to an inclusive [from,to] ISO yyyy-mm-dd window sent to the
   list endpoint, so the filter runs across the WHOLE table. Buckets are
   identical to the old `inRange`: this-month = first→last of the current month,
   last/next-month the adjacent months, this-year = Jan 1 → Dec 31. */
type Range = "all" | "this-month" | "last-month" | "next-month" | "this-year";
const RANGES: [Range, string][] = [
  ["all", "All"], ["this-month", "This month"], ["last-month", "Last month"],
  ["next-month", "Next month"], ["this-year", "This year"],
];
const PAGE_SIZE = 30;
/* Local yyyy-mm-dd (never UTC-shifted — the so_date column is a plain date). */
const ymd = (d: Date) =>
  `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`;
function rangeToDates(range: Range): { from?: string; to?: string } {
  if (range === "all") return {};
  const now = new Date(); const y = now.getFullYear(); const m = now.getMonth();
  if (range === "this-year") return { from: ymd(new Date(y, 0, 1)), to: ymd(new Date(y, 11, 31)) };
  const base = range === "this-month" ? m : range === "last-month" ? m - 1 : m + 1; // next-month
  // Day 0 of the following month = last day of `base` (year-wrap safe).
  return { from: ymd(new Date(y, base, 1)), to: ymd(new Date(y, base + 1, 0)) };
}

/* Status filter → the endpoint's exact `status` value. One entry per backend
   vocabulary status (mfg-sales-orders.ts SO_STATUSES) in lifecycle order —
   desktop parity (MfgSalesOrdersListV2 SO_STATUS_TABS). Every status is listed
   with its live server count so the buckets always sum to All and no order can
   hide inside an unlisted status (the old three-bucket sheet hid
   READY_TO_SHIP / DELIVERED / ... exactly like the desktop strip did). The old
   "Submitted" entry is gone: it was a legacy spelling no live row carries and
   both chips resolved to CONFIRMED anyway. "other" (the server's catch-all for
   legacy/unknown spellings) is only offered when its count is non-zero. */
type StatusFilter =
  | "all" | "draft" | "confirmed" | "in_production" | "ready_to_ship"
  | "shipped" | "delivered" | "invoiced" | "closed" | "on_hold"
  | "cancelled" | "other";
const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "confirmed", label: "Confirmed" },
  { key: "in_production", label: "In Production" },
  { key: "ready_to_ship", label: "Ready to Ship" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "invoiced", label: "Invoiced" },
  { key: "closed", label: "Closed" },
  { key: "on_hold", label: "On Hold" },
  { key: "cancelled", label: "Cancelled" },
];
/* Status key → the endpoint's exact `status` param (uppercase vocabulary
   value, incl. the OTHER catch-all the backend filters as not-in-vocabulary),
   or null for All. */
function statusToParam(s: StatusFilter): string | null {
  return s === "all" ? null : s.toUpperCase();
}

/** Sales Orders list — 1:1 with the owner's mobile prototype (`#so-list`), wired
 *  to the same /api/scm/mfg-sales-orders the desktop uses (row-scoped +
 *  permission-gated by the backend). Summary bar + period chips + card + FAB. */
export function MobileSalesOrders({ onScan, onOpen, onNew, onNewCase }: { onScan: () => void; onOpen: (docNo: string) => void; onNew: () => void; onNewCase?: () => void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const { user, can, pageAccess } = useAuth();
  const [q, setQ] = useState("");
  /* Debounced search term — the actual value sent to the server (and keyed into
     the infinite query) so a keystroke doesn't fire a request per character.
     300ms after the operator stops typing the query re-runs from page 0. */
  const { requestTerm: debouncedQ } = useDebouncedSearchTerm(q);
  // FAB "+" speed-dial — offers New Sales Order + New Service Case (parity with
  // the desktop QuickActionsFAB two-choice). A Sales user always gets the case
  // option (owner rule 2026-07); others get it only if their matrix grants it.
  const [fabOpen, setFabOpen] = useState(false);
  // Shared rule with the desktop QuickActionsFAB (auth/salesAccess) — a Sales
  // user always gets the case option; others only with the matrix grant.
  const canNewCase = !!onNewCase && quickActionAccess(user, can, pageAccess).canNewCase;
  const [status, setStatus] = useState<StatusFilter>("all");
  const [range, setRange] = useState<Range>("all");
  const [filterOpen, setFilterOpen] = useState(false);

  /* Item 3 — bulk confirm. selectMode toggles the tick UI; `selected` is the set
     of picked DRAFT doc_nos; `confirming` runs the sequential PATCH pass. */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [confirmProgress, setConfirmProgress] = useState(0);
  /* Long-press to ENTER select mode (and pre-tick the pressed DRAFT row). The
     timer fires after 450ms; a tap that releases sooner opens the SO as usual.
     `longPressFired` suppresses the click that follows the long-press release. */
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);
  /* Scroll container — the infinite-scroll trigger listens on this element (the
     mobile screens scroll an inner overflow div, not the window). */
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  /* Server-side search + status + period + infinite scroll. Each filter is a
     query param; changing status/range/debouncedQ swaps the query key so the
     list restarts from page 0 and the server finds matches across the WHOLE
     table (not just the rows already loaded). pageSize 30, sort so_date:desc
     with a doc_no tiebreaker on the backend → no skipped/duplicated rows. */
  const buildParams = (page: number): string => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    p.set("sort", "so_date:desc");
    const st = statusToParam(status); if (st) p.set("status", st);
    const { from, to } = rangeToDates(range);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (debouncedQ) p.set("q", debouncedQ);
    return p.toString();
  };
  type SoListPage = { salesOrders?: SoRow[]; total?: number; page?: number; pageSize?: number; statusCounts?: Record<string, number>; aggregates?: { revenueSen: number; outstandingSen: number; paidSen: number } };
  const {
    data, isLoading, isFetching, isPlaceholderData, error, refetch,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["mobile-so-list-paged", status, range, debouncedQ],
    queryFn: ({ pageParam, signal }) => authedFetch<SoListPage>(`/mfg-sales-orders?${buildParams(pageParam)}`, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + (p.salesOrders?.length ?? 0), 0);
      return loaded < (last.total ?? 0) ? pages.length : undefined;
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const searchTransition = useSearchResultTransition({
    inputTerm: q,
    requestTerm: debouncedQ,
    isFetching,
    isPlaceholderData,
    hasData: data !== undefined,
    hasError: Boolean(error),
  });
  const listLoading = isLoading || searchTransition.isSearching;
  const rows = useMemo(() => data?.pages.flatMap((p) => p.salesOrders ?? []) ?? [], [data]);
  // Deferred MRP enrichment for every loaded card (READY chips + readiness /
  // planning badges), healed a beat later. Shared with desktop; the hook chunks
  // the doc set at 100 so infinite scroll stays bounded (soListEnrichment.ts).
  const enrichedRows = useEnrichedSoListRows(rows, !listLoading);
  const totalCount = data?.pages[0]?.total ?? 0;

  /* Summary bar totals — full-set rev/out from the server `aggregates` (page-0
     response), computed over the SAME filters (status/period/search) across the
     WHOLE table, byte-identical to the desktop KPI. `fullSet` drops the old
     "(loaded)" caveat. Defensive fallback if `aggregates` is absent (old backend
     / mid-deploy): sum the rows LOADED SO FAR, excluding cancelled and clamping
     balance to positive (the historical prototype behaviour), and keep "(loaded)". */
  const aggregates = data?.pages[0]?.aggregates;
  /* Full-set per-status counts (page-0 response) — computed server-side over
     the WHOLE scope+company set, ignoring the status/period/search filters,
     exactly like the desktop pills. Absent on an old backend → the sheet
     simply omits the numbers instead of showing fake zeros. */
  const statusCounts = data?.pages[0]?.statusCounts;
  const summary = useMemo(() => {
    if (aggregates) return { rev: aggregates.revenueSen, out: aggregates.outstandingSen, fullSet: true };
    let rev = 0, out = 0;
    for (const r of rows) {
      if (isCancelled(r)) continue;
      rev += total(r);
      /* Signed, matching the server's `aggregates.outstandingSen` (which sums
         balance_sen_live straight). Dropping negatives here made the fallback
         path disagree with the primary one the moment over-collection became
         possible — the same figure reading differently depending on whether the
         backend answered with aggregates. */
      out += balance(r);
    }
    return { rev, out, fullSet: false };
  }, [aggregates, rows]);

  /* Infinite-scroll trigger — an IntersectionObserver watches a 1px sentinel at
     the bottom of the list and fetches the next page when it nears the viewport
     (rootMargin 600px pre-load). Observer callbacks run on the event loop, NOT
     rAF, so this fires reliably even when the tab throttles rAF (a scroll+rAF
     version silently stopped loading under throttling). Guarded by hasNextPage
     && !isFetchingNextPage so it can't double-fire; re-observing when those flip
     re-fires the initial-state callback, so a first page shorter than the
     viewport (sentinel already visible) still pulls the next until the sentinel
     scrolls out or there are no more pages. */
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

  const filterActive = status !== "all" || range !== "all";

  /* ── Item 2 — "SO xxx created as draft" notification ──────────────────────
     On mount, pull this rep's recent scan jobs and toast any DONE job (with a
     soDocNo, finished in the last 30 min) we haven't acknowledged yet. One
     toast per new draft, or a combined "N drafts saved" when several land at
     once. Tapping a single-draft toast opens that SO. Acked ids are persisted
     so the toast never re-fires on a later Orders visit. Fail-soft: any jobs
     hiccup silently skips the notification (retry:false, no dialog). */
  const salesperson = (user?.name || user?.email || "").trim();
  const notifiedRef = useRef(false);
  const { data: jobsData } = useQuery({
    queryKey: ["mobile-so-scan-jobs", salesperson],
    queryFn: () =>
      authedFetch<ScanJobsResp>(
        salesperson ? `/scan-so/jobs?salesperson=${encodeURIComponent(salesperson)}` : "/scan-so/jobs",
      ),
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (notifiedRef.current || !jobsData) return;
    const now = Date.now();
    const acked = readAckedJobIds();
    const fresh = (j: { id: string; updatedAt: string | null; createdAt: string | null }) =>
      now - jobTsMs(j.updatedAt ?? j.createdAt) < SCAN_ACK_WINDOW_MS && !acked.has(j.id);
    const all = normalizeJobs(jobsData);
    // Owner 2026-07-04: EVERY scan lands a draft, so the toast announces them all
    // — a clean draft, a possible-duplicate draft, and a blank "please complete"
    // draft (the case that used to just error) all open the same way. Genuine
    // SYSTEM failures (status 'error' — no draft was created) are surfaced too,
    // so the rep knows to scan again. Newest first.
    const drafts = all
      .filter((j) => j.status === "done" && j.soDocNo && fresh(j))
      .sort((a, b) => jobTsMs(b.updatedAt ?? b.createdAt) - jobTsMs(a.updatedAt ?? a.createdAt));
    const failures = all.filter((j) => j.status === "error" && fresh(j));
    if (drafts.length === 0 && failures.length === 0) return;
    notifiedRef.current = true; // once per screen mount — never double-fire on navigation

    // Ack everything we're about to surface, so re-mounts don't repeat it.
    for (const j of [...drafts, ...failures]) acked.add(j.id);
    writeAckedJobIds(acked);

    // Single draft, nothing else → open it straight after the toast.
    if (drafts.length === 1 && failures.length === 0) {
      const j = drafts[0];
      const doc = j.soDocNo!;
      // A shell/blank or payment-warning draft carries a plain note in `error`;
      // a possible-duplicate carries the earlier doc no. Either rides in the body.
      const extra = j.duplicateOf
        ? ` This looks like a possible duplicate of ${j.duplicateOf}.`
        : j.error
          ? ` ${j.error}`
          : "";
      void notify({
        title: "Scan complete",
        body: `${doc} was saved as a draft.${extra} Tap OK, then open it from your Orders to review.`,
      }).then(() => {
        // Nudge the list so the new draft is visible before the operator taps in.
        void refetch();
        onOpen(doc);
      });
      return;
    }

    // Several drafts and/or a system failure → one combined summary, no auto-open.
    const parts: string[] = [];
    if (drafts.length > 0) {
      parts.push(
        drafts.length === 1
          ? `${drafts[0].soDocNo} was saved as a draft`
          : `${drafts.length} scanned orders were saved as drafts`,
      );
    }
    if (failures.length > 0) {
      parts.push(
        `${failures.length} ${failures.length === 1 ? "scan" : "scans"} could not be read — please scan again`,
      );
    }
    void notify({
      title: "Scan update",
      body: `${parts.join(". ")}. Review them in your Orders list.`,
    }).then(() => void refetch());
  }, [jobsData, notify, onOpen, refetch]);

  /* ── Item 3 — bulk confirm helpers ──────────────────────────────────────
     Only DRAFT rows are selectable. exitSelect resets the whole selection UI. */
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
    setConfirmProgress(0);
  };
  const toggleSelect = (docNo: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(docNo)) next.delete(docNo);
      else next.add(docNo);
      return next;
    });
  };
  const clearLongPress = () => {
    if (lpTimer.current !== null) { window.clearTimeout(lpTimer.current); lpTimer.current = null; }
  };
  /* A row tap: in select mode a DRAFT row toggles its tick (non-draft rows are
     inert); otherwise it opens the SO. A long-press that already fired swallows
     this click. */
  const onCardTap = (r: SoRow) => {
    if (lpFired.current) { lpFired.current = false; return; }
    if (selectMode) { if (isDraft(r)) toggleSelect(r.doc_no); return; }
    onOpen(r.doc_no);
  };
  /* Long-press on a DRAFT row enters select mode and pre-ticks it. Ignored while
     already selecting or confirming, and on non-draft rows. */
  const onCardPressStart = (r: SoRow) => {
    if (selectMode || confirming || !isDraft(r)) return;
    lpFired.current = false;
    clearLongPress();
    lpTimer.current = window.setTimeout(() => {
      lpFired.current = true;
      setSelectMode(true);
      setSelected(new Set([r.doc_no]));
    }, 450);
  };
  /* Sequentially PATCH each selected DRAFT → CONFIRMED via the SAME status
     endpoint the single-confirm path uses (MobileSODetail.setStatus):
     PATCH /mfg-sales-orders/:docNo/status {status:'CONFIRMED'}. One at a time so
     a mid-batch failure is contained; tallies N confirmed / M failed and toasts
     a summary, then refetches the list. */
  const bulkConfirm = async () => {
    if (confirming || selected.size === 0) return;
    const docs = Array.from(selected);
    setConfirming(true);
    setConfirmProgress(0);
    let ok = 0;
    const failures: string[] = [];
    for (const docNo of docs) {
      try {
        await confirmSoWithFreshVersion(docNo);
        ok += 1;
      } catch {
        failures.push(docNo);
      }
      setConfirmProgress((p) => p + 1);
    }
    /* Refresh the list + any open detail caches so statuses reflect the change.
       The single-confirm twin (MobileSODetail) goes through the vendored status
       hook, which invalidates the shared SO lists; this loop PATCHes raw, so it
       owes them the same invalidation — once, after the whole batch. */
    invalidateSoShared(qc);
    await Promise.all([
      refetch(),
      qc.invalidateQueries({ queryKey: ["mfg-sales-order-detail"] }),
    ]);
    setConfirming(false);
    exitSelect();
    const m = failures.length;
    void notify({
      title: m === 0 ? "Orders confirmed" : "Some orders couldn't be confirmed",
      body:
        m === 0
          ? `${ok} order${ok === 1 ? "" : "s"} confirmed.`
          : `${ok} confirmed, ${m} failed. The failed order${m === 1 ? "" : "s"} stayed as draft${m === 1 ? "" : "s"} — try again.`,
      tone: m === 0 ? "info" : "error",
    });
  };

  return (
    <div className="hz-m" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <div>
            <div className="eyebrow">Supply chain</div>
            <div className="scr-title">Sales Orders</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Item 3 — Select toggle: enters/exits DRAFT multiselect. In select
                mode it reads "Done" and clears the picks. */}
            {selectMode ? (
              <button onClick={exitSelect} className="iconbtn" aria-label="Exit selection" style={{ width: "auto", padding: "0 12px", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: "#16695f" }}>
                Done
              </button>
            ) : (
              <button onClick={() => setSelectMode(true)} className="iconbtn" aria-label="Select orders" title="Select drafts to confirm">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
              </button>
            )}
            {!selectMode && (
              <button onClick={onScan} aria-label="Scan slip" className="iconbtn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" /><circle cx="12" cy="13" r="3" /></svg>
              </button>
            )}
          </div>
        </div>
        <div className="hdr-row" style={{ marginTop: 11 }}>
          <div className="searchbar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9aa093" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer · phone · SO · reference" />
          </div>
          <SearchProgress active={searchTransition.isSearching} label="Searching…" />
          <button onClick={() => setFilterOpen(true)} className="iconbtn" style={{ position: "relative" }} aria-label="Filter by status">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#414539" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
            {filterActive && <span style={{ position: "absolute", top: -3, right: -3, width: 9, height: 9, borderRadius: "50%", background: "var(--gold)", border: "1.5px solid #fff" }} />}
          </button>
        </div>
        <SearchScopeHint
          scope="server"
          searching={searchTransition.isSearching}
          countPending={isLoading || isPlaceholderData || Boolean(error) || searchTransition.resultsAreStale}
          resultCount={totalCount}
          term={q}
          className="mt-1 px-1"
        />
      </header>

      <div ref={scrollRef} className="scroll hz-scroll" style={{ padding: 14, paddingBottom: 120 }}>
        {/* Summary bar — N orders (server total for the filter) · RM rev · RM
            outstanding. When the server supplies full-set `aggregates` the money
            totals are the whole filtered set (no caveat). The "(loaded)" suffix
            only appears in the defensive fallback, where rev/out reflect just the
            rows scrolled in so far. */}
        {!listLoading && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 11.5, color: "var(--mut)", margin: "0 2px 11px" }}>
            <span><b style={{ color: "var(--ink)" }}>{totalCount}</b> orders</span>
            <span style={{ opacity: .4 }}>·</span>
            <span className="money">{fmtSen(summary.rev)} rev{summary.fullSet ? "" : " (loaded)"}</span>
            {/* Non-zero either way — a net over-collection is not "nothing to
                show", and it is red for the same reason a debt is. */}
            {summary.out !== 0 && <>
              <span style={{ opacity: .4 }}>·</span>
              <span className="money" style={{ color: "var(--red)" }}>
                {fmtSen(summary.out)} {summary.out < 0 ? "over-collected" : "outstanding"}{summary.fullSet ? "" : " (loaded)"}
              </span>
            </>}
          </div>
        )}

        {/* Period filter chips (h-scroll). */}
        <div className="chips" style={{ marginBottom: 11 }}>
          {RANGES.map(([key, label]) => (
            <button key={key} onClick={() => setRange(key)} className={range === key ? "chip on" : "chip"}>{label}</button>
          ))}
        </div>

        {listLoading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="card"><div className="card-b ph" style={{ height: 92, borderRadius: 14 }} /></div>
            ))}
          </div>
        )}
        {error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--red-bg)", border: "1px solid #e6cccc", borderRadius: 12, padding: "11px 13px" }}>
            <span style={{ fontSize: 12, color: "var(--red)", fontWeight: 600 }}>Couldn't load orders</span>
            <button onClick={() => refetch()} style={{ border: "none", background: "transparent", color: "var(--red)", fontFamily: "inherit", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Retry</button>
          </div>
        )}
        {!listLoading && !error && (
          <>
            {rows.length > 0 && (
              <MobileVirtualList
                items={enrichedRows}
                getKey={(r) => r.doc_no}
                estimateHeight={140}
                renderItem={(r) => {
              const cancelled = isCancelled(r);
              const warehouse = resolveSoLocation(r).label;
              const brand = brandOf(r);
              return (
                /* Owner-locked SO card (prototype `soRowCard`):
                   L1  {customer name}                          ·  {status badge}
                   L2  {doc_no} · {customer_so_no}     |  {warehouse}
                   L3  Processing {date}  ->  Delivery {date}
                   L4  (Stock chip · Planning chip — only when the row carries them)
                   L5  {created_at} · created                   ·  {total} (bold) */
                <div key={r.doc_no} onClick={() => onOpen(r.doc_no)} className={cancelled ? "card cancelled" : "card"} style={{ cursor: "pointer", padding: "12px 13px", ...(cancelled ? { opacity: .55, filter: "grayscale(.5)" } : null) }}>
                  {/* Line 1 — customer name / status */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ minWidth: 0, fontSize: 14, fontWeight: 800, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.debtor_name || "—"}</span>
                    <StatusPill status={r.status} />
                  </div>
                  {/* Line 2 — doc_no · brand pill · customer_so_no on their OWN
                      full-width row (owner: the SO number + reference were
                      squeezed to "SO-260… · HC 1…" by the warehouse sharing the
                      line). doc_no + brand pill stay whole (flex:none); only the
                      ref ellipsises if truly long, so the pill never crams it. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, marginTop: 5, fontSize: 11.5, color: "var(--mut)" }}>
                    {/* Struck through when cancelled — same doc-number-only strike as
                        the desktop lists' dt-cancel-strike (owner 2026-08-02). */}
                    <span className="money" style={{ fontWeight: 700, color: "var(--brand-d)", flex: "none", ...(cancelled ? { textDecoration: "line-through", textDecorationThickness: 1 } : null) }}>{r.doc_no}</span>
                    {brand !== "—" && <BrandPill brand={brand} row={r} />}
                    {r.customer_so_no && <><span style={{ opacity: .4, flex: "none" }}>·</span><span className="money" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.customer_so_no}</span></>}
                  </div>
                  {/* Line 2b — warehouse on its own line so it never crowds the ids */}
                  {warehouse && (
                    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, marginTop: 4, fontSize: 11.5, fontWeight: 600, color: "var(--ink2)" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M3 21V8l9-5 9 5v13" /><path d="M7 21v-8h10v8" /></svg>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{warehouse}</span>
                    </div>
                  )}
                  {/* Line 3 — Processing -> Delivery */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 11, color: "var(--ink2)" }}>
                    <span style={{ color: "var(--mut2)", fontWeight: 600 }}>Processing</span>
                    <span className="money" style={{ fontWeight: 600 }}>{dm(r.processing_date)}</span>
                    <span style={{ color: "#c2c6bd" }}>&rarr;</span>
                    <span style={{ color: "var(--mut2)", fontWeight: 600 }}>Delivery</span>
                    <span className="money" style={{ fontWeight: 600 }}>{dm(r.customer_delivery_date)}</span>
                  </div>
                  {/* Line 4 — fulfilment chips (only when live + present) */}
                  <FulfilChips row={r} />
                  {/* Line 4b — source PO union + raised POs (desktop PO No.
                      column's mobile twin; owner 2026-08-02, raised arm added
                      2026-08-11). Rendered only when non-empty — card idiom,
                      the desktop column shows the dash instead. The phone card
                      wraps the full list; the "+N" cap is a LIST-cell rule. */}
                  {(() => {
                    const { source, raised } = poCellChips(r);
                    if (source.length === 0 && raised.length === 0 && !r.source_po_adj) return null;
                    return <SourcePosRowMobile pos={source} raised={raised} adj={r.source_po_adj} />;
                  })()}
                  {/* Line 5 — created / total */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
                    <span style={{ fontSize: 10, color: "var(--mut2)" }}>{dm(soDate(r))} · created</span>
                    <span className="money" style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>{fmtSen(total(r))}</span>
                  </div>
                </div>
              );
                }}
              />
            )}
            {/* Infinite-scroll sentinel — the IntersectionObserver watches this
                1px marker at the list's bottom; it enters view (+600px) near the
                end and pulls the next page. Only present while more pages exist. */}
            {rows.length > 0 && hasNextPage && (
              <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
            )}
            {/* Infinite-scroll footer — "Loading more…" while the next page is in
                flight; nothing once every page is loaded (hasNextPage false). */}
            {rows.length > 0 && isFetchingNextPage && (
              <div style={{ textAlign: "center", padding: "14px 0 2px", fontSize: 11.5, color: "var(--mut)" }}>Loading more…</div>
            )}
            {!rows.length && (
              <div className="empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#c2c6bd" strokeWidth="1.6"><path d="M4 4h16v4H4zM4 10h16v10H4z" /></svg>
                <div className="empty-t">No sales orders</div>
                <div className="empty-s">No orders in this range. Tap + to create one.</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Status filter bottom-sheet — replaces the old blind status-cycle. Lists
          the real SO status options; the selected one shows a check + highlight,
          and a non-"All" pick keeps the funnel's gold dot lit. */}
      {filterOpen && (
        <div className="sheet-bd" onClick={() => setFilterOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxHeight: "70%" }}>
            <div className="grab" />
            <div className="sheet-head">
              <div>
                <div className="eyebrow">Filter</div>
                <div className="scr-title" style={{ fontSize: 17 }}>Order status</div>
              </div>
              <button className="sheet-x" onClick={() => setFilterOpen(false)} aria-label="Close">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div className="sheet-scroll" style={{ gap: 8 }}>
              {/* Full vocabulary + live counts (desktop-pill parity). The
                  "Other" catch-all row appears only when the server counts
                  rows outside the vocabulary — or while it is the active
                  filter, so the selection can never vanish from the sheet. */}
              {[
                ...STATUS_FILTERS,
                ...((statusCounts?.other ?? 0) > 0 || status === "other"
                  ? [{ key: "other" as StatusFilter, label: "Other" }]
                  : []),
              ].map(({ key, label }) => {
                const on = status === key;
                return (
                  <button
                    key={key}
                    onClick={() => { setStatus(key); setFilterOpen(false); }}
                    className="mcard"
                    style={{ justifyContent: "space-between", ...(on ? { borderColor: "var(--brand)", background: "var(--brand-bg)" } : null) }}
                  >
                    <span className="ml" style={on ? { color: "var(--brand-d)" } : undefined}>{label}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
                      {statusCounts && (
                        <span className="money" style={{ fontSize: 12, fontWeight: 700, color: on ? "var(--brand-d)" : "var(--mut)" }}>
                          {statusCounts[key] ?? 0}
                        </span>
                      )}
                      {on && (
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--brand-d)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Floating green "+" FAB. When a Service Case can also be created it opens
          a two-choice sheet (New Sales Order / New Service Case), matching the
          desktop QuickActionsFAB; otherwise it opens New Sales Order directly. */}
      <button
        onClick={() => { if (canNewCase) setFabOpen(true); else onNew(); }}
        aria-label={canNewCase ? "Create" : "New sales order"}
        className="fab"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>

      {/* FAB "+" action sheet — New Sales Order / New Service Case. Reuses the
          same bottom-sheet chrome as the status filter above. */}
      {fabOpen && (
        <div className="sheet-bd" onClick={() => setFabOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ maxHeight: "60%" }}>
            <div className="grab" />
            <div className="sheet-head">
              <div>
                <div className="eyebrow">Create</div>
                <div className="scr-title" style={{ fontSize: 17 }}>What would you like to add?</div>
              </div>
              <button className="sheet-x" onClick={() => setFabOpen(false)} aria-label="Close">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div className="sheet-scroll" style={{ gap: 8 }}>
              <button
                className="mcard"
                onClick={() => { setFabOpen(false); onNew(); }}
                style={{ justifyContent: "flex-start", gap: 10 }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" /></svg>
                <span className="ml">New Sales Order</span>
              </button>
              <button
                className="mcard"
                onClick={() => { setFabOpen(false); onNewCase?.(); }}
                style={{ justifyContent: "flex-start", gap: 10 }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" /></svg>
                <span className="ml">New Service Case</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* status → spec badge tone: DRAFT=b-amber · SUBMITTED=b-brand ·
   CONFIRMED=b-green · CANCELLED=b-red. Any other live status reads as b-brand.
   Draft is the amber "pending" pill (+ hairline border), identical to the detail
   StatusPill (MobileSODetail) and the desktop warning tone — it used to be grey,
   which read as an ordinary neutral state rather than "not confirmed yet". */
function StatusPill({ status }: { status: string | null }) {
  const s = (status ?? "").toUpperCase();
  const cls =
    s === "DRAFT" ? "b-amber" :
    s === "CANCELLED" ? "b-red" :
    s === "CONFIRMED" ? "b-green" :
    "b-brand";
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : "—";
  return <span className={`badge ${cls}`} style={{ flex: "none", ...(s === "DRAFT" ? { border: "1px solid #e0cf9e" } : null) }}>{label}</span>;
}

/* Brand pill — desktop list parity (brandOf/brandTone), rendered in the card's
   OWN .badge family so it matches StatusPill exactly (same 9px uppercase pill,
   same radius/tokens — no new colour, shape, or size). Tone → existing badge
   class: 2990/SOFA green, AKEMI/blank grey, everything else (incl. bedframe)
   the amber "pending"-family pill; the brand TEXT carries the identity, the
   colour is the secondary cue. Sits inline on the doc_no row: flex:none so it
   never shrinks, and a maxWidth+ellipsis so a long brand truncates itself
   instead of crowding the customer ref beside it. */
function BrandPill({ brand, row }: { brand: string; row: SoRow }) {
  const tone = brandTone(row);
  /* Four tones, four classes. This map had only three, so a BEDFRAME chip
     (accent) fell through to the mattress amber — the desktop and the phone
     showed the same order in two different colours. `b-brand` is the fourth
     colour mobile.css already ships; no new class was needed. */
  const cls = tone === "success" ? "b-green" : tone === "neutral" ? "b-grey"
    : tone === "accent" ? "b-brand" : "b-amber";
  return (
    <span className={`badge ${cls}`} style={{ flex: "none", maxWidth: 96, overflow: "hidden", textOverflow: "ellipsis" }}>{brand}</span>
  );
}

/* Stock + Delivery-Planning chips (prototype `soFulfilChips`). Rendered ONLY
   when the SO is live (not Draft/Cancelled) AND the row actually carries the
   derived status — never faked. Stock reads the readiness booleans the list
   endpoint emits; planning reads the derived `planning_state`. */
function FulfilChips({ row }: { row: SoRow }) {
  const s = (row.status ?? "").toLowerCase();
  if (s === "draft" || s === "cancelled") return null;

  const stock: [string, string, string] | null =
    row.is_fully_ready ? ["Ready", "var(--green-bg)", "var(--green)"] :
    (row.is_main_ready || (row.ready_categories?.length ?? 0) > 0) ? ["Partial", "var(--amber-bg)", "var(--amber)"] :
    null;

  const ps = (row.planning_state ?? "").toUpperCase();
  const plan: [string, string, string] | null =
    ps === "DELIVERED" ? ["Delivered", "var(--green-bg)", "var(--green)"] :
    ps === "PENDING_SCHEDULE" ? ["Pending schedule", "var(--amber-bg)", "var(--amber)"] :
    ps === "OVERDUE" ? ["Overdue", "var(--red-bg)", "var(--red)"] :
    null;

  if (!stock && !plan) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
      {stock && <Chip label={stock[0]} bg={stock[1]} fg={stock[2]} />}
      {plan && <Chip label={plan[0]} bg={plan[1]} fg={plan[2]} />}
    </div>
  );
}

function Chip({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", fontSize: 10.5, fontWeight: 700, padding: "4px 10px", borderRadius: 20, background: bg, color: fg, whiteSpace: "nowrap" }}>{label}</span>
  );
}
