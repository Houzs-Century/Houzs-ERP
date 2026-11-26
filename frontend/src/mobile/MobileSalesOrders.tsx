import { useEffect, useMemo, useRef, useState } from "react";
import { brandingToneForCategory, type BrandTone } from "../lib/brandingTone";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { fetchSoItemCodes, passesSoffioReminder } from "../vendor/scm/lib/soffio-reminder";
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
import { MrpAsOf } from "../components/MrpAsOf";
import { identityStorageKey } from "../lib/storageIdentity";
import { useDebouncedSearchTerm, useSearchResultTransition } from "../hooks/useServerSearch";
import { appendSoListFilterParams, useSoListFilters } from "../vendor/scm/lib/so-list-filter-state";
import { soDatePresetRange, soTodayYmd } from "../vendor/shared/so-list-filter-model";
import { MobileSoFilterSheet } from "./MobileSoFilterSheet";
import "./mobile.css";

type SoRow = {
  doc_no: string; debtor_name: string | null; status: string | null;
  sales_location: string | null; warehouse_name: string | null;
  customer_state: string | null; ref: string | null; po_doc_no: string | null;
  customer_so_no: string | null;
  branding: string | null; first_item_branding: string | null;
  first_item_category: string | null;
  customer_delivery_date: string | null; processing_date: string | null;
  so_date: string | null; created_at: string | null;
  local_total_sen: number | null; total_revenue_sen: number | null; paid_total_sen: number | null;
  balance_sen: number | null; balance_sen_live: number | null;
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

const dm = (d: string | null | undefined) => formatDate(d);
const total = (r: SoRow) => r.local_total_sen ?? r.total_revenue_sen ?? 0;
const paid = (r: SoRow) => r.paid_total_sen ?? 0;
const balance = (r: SoRow) => r.balance_sen_live ?? (total(r) - paid(r));
const isCancelled = (r: SoRow) => (r.status ?? "").toLowerCase() === "cancelled";
const isDraft = (r: SoRow) => (r.status ?? "").toLowerCase() === "draft";
const soDate = (r: SoRow) => r.so_date ?? r.created_at ?? null;

/* Desktop parity, and the same fix: the trailing `|| "—"` printed a dash on
   every order whose first line carries no brand TEXT — which is every sofa —
   while the rule that turns a category into a label lived on other pages. One
   shared rule now, and it cannot return blank (owner 2026-08-17). */
const brandOf = (r: SoRow): string =>
  (isPlaceholderBrandText(r.branding) ? "" : (r.branding ?? "").trim()) ||
  brandingLabel(r.first_item_category, r.first_item_branding, getBrandingCompanyCode());
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
const SCAN_ACK_WINDOW_MS = 30 * 60 * 1000;

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
    const arr = Array.from(ids);
    const trimmed = arr.length > SCAN_ACK_MAX ? arr.slice(arr.length - SCAN_ACK_MAX) : arr;
    const key = identityStorageKey(SCAN_ACK_KEY);
    if (key) localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
  }
}
const jobTsMs = (s: string | null | undefined): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

type Range = "all" | "this-month" | "last-month" | "next-month" | "this-year";
const RANGES: [Range, string][] = [
  ["all", "All"], ["this-month", "This month"], ["last-month", "Last month"],
  ["next-month", "Next month"], ["this-year", "This year"],
];
const PAGE_SIZE = 30;
/* The same windows the desktop SO filter uses, counted from today in Malaysia —
   not the phone's own clock and zone (owner 2026-11-09). */
function rangeToDates(range: Range): { from?: string; to?: string } {
  if (range === "all") return {};
  const today = soTodayYmd(new Date());
  if (range === "this-year") return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
  return soDatePresetRange(range === "this-month" ? "this_month" : range === "last-month" ? "last_month" : "next_month", today);
}

type StatusFilter =
  | "all" | "draft" | "confirmed" | "in_production" | "ready_to_ship"
  | "shipped" | "delivered" | "invoiced" | "closed" | "on_hold"
  | "cancelled" | "other";
const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "confirmed", label: "Submitted" },
  { key: "in_production", label: "In Production" },
  { key: "ready_to_ship", label: "Ready to Ship" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
  { key: "invoiced", label: "Invoiced" },
  { key: "closed", label: "Closed" },
  { key: "on_hold", label: "On Hold" },
  { key: "cancelled", label: "Cancelled" },
];
function statusToParam(s: StatusFilter): string | null {
  return s === "all" ? null : s.toUpperCase();
}

/** Sales Orders list — 1:1 with the owner's mobile prototype (`#so-list`), wired
 *  to the same /api/scm/mfg-sales-orders the desktop uses (row-scoped +
 *  permission-gated by the backend). Summary bar + period chips + card + FAB. */
export function MobileSalesOrders({ onScan, onOpen, onNew, onNewCase }: { onScan: () => void; onOpen: (docNo: string) => void; onNew: () => void; onNewCase?: () => void }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const confirm = useConfirm();
  const { user, can, pageAccess } = useAuth();
  const [q, setQ] = useState("");
  const { requestTerm: debouncedQ } = useDebouncedSearchTerm(q);
  const [fabOpen, setFabOpen] = useState(false);
  const canNewCase = !!onNewCase && quickActionAccess(user, can, pageAccess).canNewCase;
  const soFilters = useSoListFilters();
  const status = soFilters.status as StatusFilter;
  const filterKey = soFilters.filters.map((r) => `${r.field}:${r.op}:${r.value}`).join("|");
  const [range, setRange] = useState<Range>("all");
  const [filterOpen, setFilterOpen] = useState(false);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [confirmProgress, setConfirmProgress] = useState(0);
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

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
    appendSoListFilterParams(p, soFilters.filters);
    return p.toString();
  };
  type SoListPage = { salesOrders?: SoRow[]; total?: number; page?: number; pageSize?: number; statusCounts?: Record<string, number>; aggregates?: { revenueSen: number; outstandingSen: number; paidSen: number } };
  const {
    data, isLoading, isFetching, isPlaceholderData, error, refetch,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["mobile-so-list-paged", status, range, debouncedQ, filterKey],
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
  const { rows: enrichedRows, mrp: mrpStatus } = useEnrichedSoListRows(rows, !listLoading);
  const totalCount = data?.pages[0]?.total ?? 0;

  const aggregates = data?.pages[0]?.aggregates;
  const statusCounts = data?.pages[0]?.statusCounts;
  const summary = useMemo(() => {
    if (aggregates) return { rev: aggregates.revenueSen, out: aggregates.outstandingSen, fullSet: true };
    let rev = 0, out = 0;
    for (const r of rows) {
      if (isCancelled(r)) continue;
      rev += total(r);
      out += balance(r);
    }
    return { rev, out, fullSet: false };
  }, [aggregates, rows]);

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

  const filterActive = status !== "all" || range !== "all" || soFilters.filters.length > 0;

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
    notifiedRef.current = true;

    for (const j of [...drafts, ...failures]) acked.add(j.id);
    writeAckedJobIds(acked);

    if (drafts.length === 1 && failures.length === 0) {
      const j = drafts[0];
      const doc = j.soDocNo!;
      const extra = j.duplicateOf
        ? ` This looks like a possible duplicate of ${j.duplicateOf}.`
        : j.error
          ? ` ${j.error}`
          : "";
      void notify({
        title: "Scan complete",
        body: `${doc} was saved as a draft.${extra} Tap OK, then open it from your Orders to review.`,
      }).then(() => {
        void refetch();
        onOpen(doc);
      });
      return;
    }

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
  const onCardTap = (r: SoRow) => {
    if (lpFired.current) { lpFired.current = false; return; }
    if (selectMode) { if (isDraft(r)) toggleSelect(r.doc_no); return; }
    onOpen(r.doc_no);
  };
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
  const bulkConfirm = async () => {
    if (confirming || selected.size === 0) return;
    const docs = Array.from(selected);
    let codes: string[];
    try {
      codes = (await Promise.all(docs.map((d) => fetchSoItemCodes(d)))).flat();
    } catch (e) {
      void notify({ title: "Could not load the order lines", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" });
      return;
    }
    if (!(await passesSoffioReminder(confirm, codes))) return;
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
            {selectMode ? (
              <button onClick={exitSelect} className="iconbtn" aria-label="Exit selection" style={{ width: "auto", padding: "0 12px", fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, color: "var(--hz-c-primary)" }}>
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
            {filterActive && <span style={{ position: "absolute", top: -3, right: -3, width: 9, height: 9, borderRadius: "50%", background: "var(--gold)", border: "1.5px solid var(--hz-c-surface)" }} />}
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
        {!listLoading && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 11.5, color: "var(--mut)", margin: "0 2px 11px" }}>
            <span><b style={{ color: "var(--ink)" }}>{totalCount}</b> orders</span>
            <span style={{ opacity: .4 }}>·</span>
            <span className="money">{fmtSen(summary.rev)} rev{summary.fullSet ? "" : " (loaded)"}</span>
            {summary.out !== 0 && <>
              <span style={{ opacity: .4 }}>·</span>
              <span className="money" style={{ color: "var(--red)" }}>
                {fmtSen(summary.out)} {summary.out < 0 ? "over-collected" : "outstanding"}{summary.fullSet ? "" : " (loaded)"}
              </span>
            </>}
          </div>
        )}
        <MrpAsOf status={mrpStatus} className="mx-0.5 mb-2.5" />

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
                <div key={r.doc_no} onClick={() => onOpen(r.doc_no)} className={cancelled ? "card cancelled" : "card"} style={{ cursor: "pointer", padding: "12px 13px", ...(cancelled ? { opacity: .55, filter: "grayscale(.5)" } : null) }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ minWidth: 0, fontSize: 14, fontWeight: 800, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.debtor_name || "—"}</span>
                    <StatusPill status={r.status} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, marginTop: 5, fontSize: 11.5, color: "var(--mut)" }}>
                    {/* Struck through when cancelled — same doc-number-only strike as
                        the desktop lists' dt-cancel-strike (owner 2026-08-02). */}
                    <span className="money" style={{ fontWeight: 700, color: "var(--brand-d)", flex: "none", ...(cancelled ? { textDecoration: "line-through", textDecorationThickness: 1 } : null) }}>{r.doc_no}</span>
                    {brand !== "—" && <BrandPill brand={brand} row={r} />}
                    {r.customer_so_no && <><span style={{ opacity: .4, flex: "none" }}>·</span><span className="money" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.customer_so_no}</span></>}
                  </div>
                  {warehouse && (
                    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, marginTop: 4, fontSize: 11.5, fontWeight: 600, color: "var(--ink2)" }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a16a2e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M3 21V8l9-5 9 5v13" /><path d="M7 21v-8h10v8" /></svg>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{warehouse}</span>
                    </div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 11, color: "var(--ink2)" }}>
                    <span style={{ color: "var(--mut2)", fontWeight: 600 }}>Processing</span>
                    <span className="money" style={{ fontWeight: 600 }}>{dm(r.processing_date)}</span>
                    <span style={{ color: "#c2c6bd" }}>&rarr;</span>
                    <span style={{ color: "var(--mut2)", fontWeight: 600 }}>Delivery</span>
                    <span className="money" style={{ fontWeight: 600 }}>{dm(r.customer_delivery_date)}</span>
                  </div>
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
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9, paddingTop: 9, borderTop: "1px solid var(--line2)" }}>
                    <span style={{ fontSize: 10, color: "var(--mut2)" }}>{dm(soDate(r))} · created</span>
                    <span className="money" style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>{fmtSen(total(r))}</span>
                  </div>
                </div>
              );
                }}
              />
            )}
            {rows.length > 0 && hasNextPage && (
              <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
            )}
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

      {filterOpen && (
        <MobileSoFilterSheet
          appliedStatus={status}
          appliedFilters={soFilters.filters}
          statusOptions={[
            ...STATUS_FILTERS,
            ...((statusCounts?.other ?? 0) > 0 || status === "other" ? [{ key: "other" as StatusFilter, label: "Other" }] : []),
          ]}
          statusCounts={statusCounts}
          q={debouncedQ}
          onApply={(next) => { soFilters.apply(next); setFilterOpen(false); }}
          onClear={() => { soFilters.clear(); setFilterOpen(false); }}
          onClose={() => setFilterOpen(false)}
        />
      )}

      <button
        onClick={() => { if (canNewCase) setFabOpen(true); else onNew(); }}
        aria-label={canNewCase ? "Create" : "New sales order"}
        className="fab"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>

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

function BrandPill({ brand, row }: { brand: string; row: SoRow }) {
  const tone = brandTone(row);
  const cls = tone === "success" ? "b-green" : tone === "neutral" ? "b-grey"
    : tone === "accent" ? "b-brand" : "b-amber";
  return (
    <span className={`badge ${cls}`} style={{ flex: "none", maxWidth: 96, overflow: "hidden", textOverflow: "ellipsis" }}>{brand}</span>
  );
}

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
