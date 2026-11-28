import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { siCreditNotesSen, siDepositAppliedSen, siOutstandingSen, siIsCancelled } from "../vendor/scm/lib/si-outstanding";
import { lineIdentity } from "@2990s/shared";
import { formatPhone } from "@2990s/shared/phone";
import { useAuth } from "../auth/AuthContext";
import { visibleFields } from "../auth/salesAccess";
import { formatDate } from "../lib/utils";
import { deliveryReturnSearchText } from "../lib/so-ref-search";
import { fmtAmt } from "../lib/scm";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMobileListView } from "./useMobileListView";
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
} from "../../../shared/src/vendor/scm/lib/status-pill";
import type { FormSchema } from "./MobileModuleForm";
import { MobileVirtualList } from "./MobileVirtualList";
import { warehouseLabel } from "../vendor/scm/lib/warehouse-label";
import { mfgCategoryLabel } from "../vendor/scm/lib/product-categories-store";
import { supplierEmailList } from "../vendor/shared/supplier-emails";
import { byStr } from "./mobile-list-compare";
import "./mobile.css";


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
  title: string;
  eyebrow?: string;
  endpoint: string;
  core?: boolean;
  listKey?: string;
  primary: (row: any) => string;
  secondary?: (row: any) => string;
  right?: (row: any) => string;
  rightMoney?: boolean;
  search?: (row: any) => string;

  placeholder?: string;
  fields?: FieldDef[];
  pill?: (row: any) => string;
  statusDocType?: StatusDocType;
  badgeText?: (row: any) => string;
  chips?: ChipDef[];
  chips2?: ChipDef[];
  sorts?: SortDef[];

  variant?: "doc" | "product" | "inventory" | "warehouse" | "mrp" | "person";
  subline?: (row: any) => string;
  brand?: (row: any) => string;
  note?: (row: any) => string;
  footL?: (row: any) => [string, string] | null;
  footR?: (row: any) => string;
  footMoney?: boolean;
  kpis?: (row: any) => Array<[string, string]>;
  avatar?: (row: any) => string;
  price?: (row: any) => string;
  priceMoney?: boolean;
  uom?: (row: any) => string;

  form?: FormSchema;
};

const rm = fmtAmt;

const dm = (d: string | null | undefined) => formatDate(d);

const rmField = (centi: number | null | undefined) =>
  centi == null || centi === ("" as unknown) ? "—" : `RM ${rm(centi)}`;

const pick = (row: any, ...keys: string[]) => {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && v !== "") return v;
  }
  return undefined;
};

const eq = (a: unknown, b: string) => String(a ?? "").trim().toLowerCase() === b.toLowerCase();

const humanize = (raw: unknown): string => {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  return t
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
};

const BADGE_CLASS: Record<string, string> = {
  delivered: "b-green", paid: "b-green", posted: "b-green", received: "b-green",
  signed: "b-green", completed: "b-green", refunded: "b-green", instock: "b-green",
  available: "b-green", active: "b-green", inhouse: "b-green",
  dispatched: "b-amber", sent: "b-amber", open: "b-amber", unpaid: "b-amber",
  partiallypaid: "b-amber", partiallyreceived: "b-amber", low: "b-amber",
  onpo: "b-amber", ontrip: "b-amber", intransit: "b-amber", loaded: "b-amber",
  invited: "b-amber", outsource: "b-amber",
  cancelled: "b-red", voided: "b-red", void: "b-red", overdue: "b-red",
  shortage: "b-red", zero: "b-red", negative: "b-red", maintenance: "b-red",
  approved: "b-brand", submitted: "b-brand",
  draft: "b-grey", closed: "b-grey", inactive: "b-grey", off: "b-grey",
  disabled: "b-grey", invoiced: "b-grey",
};

const badgeClass = (label: string): string => {
  const k = String(label ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return BADGE_CLASS[k] ?? "b-grey";
};

const TONE_BADGE_CLASS: Record<StatusTone, string> = {
  neutral: "b-grey",
  info: "b-brand",
  progress: "b-amber",
  success: "b-green",
  danger: "b-red",
  pending: "b-amber",
};

function Badge({ label, tone }: { label: string; tone?: StatusTone }) {
  const clean = (label ?? "").trim();
  if (!clean) return null;
  const cls = tone ? TONE_BADGE_CLASS[tone] : badgeClass(clean);
  return <span className={`badge ${cls}`}>{clean}</span>;
}

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

const mrpState = (r: any): string => {
  const shortage = Number(pick(r, "shortage") ?? 0);
  const incoming = Number(pick(r, "poOutstanding", "po_outstanding") ?? 0);
  if (shortage > 0) return "Shortage";
  if (incoming > 0) return "On PO";
  return "In stock";
};

const balanceSen = (r: any): number => siIsCancelled(pick(r, "status") as string | null) ? 0 : siOutstandingSen(
  Number(pick(r, "totalSen", "total_sen", "localTotalSen", "local_total_sen") ?? 0),
  Number(pick(r, "paidSen", "paid_sen") ?? 0),
  siDepositAppliedSen({ so_deposit_applied_sen: pick(r, "soDepositAppliedSen", "so_deposit_applied_sen") as number | null }), siCreditNotesSen({ credit_notes_sen: pick(r, "creditNotesSen", "credit_notes_sen") as number | null }));

const byNum = (a: unknown, b: unknown) => (Number(b) || 0) - (Number(a) || 0);
const byDate = (a: unknown, b: unknown) => {
  const ta = a ? +new Date(String(a)) : 0;
  const tb = b ? +new Date(String(b)) : 0;
  return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
};
const MEMBER_STATUS_RANK: Record<string, number> = { active: 0, invited: 1, disabled: 2 };
const LAST = "￿";

function pickList(data: unknown, listKey?: string): any[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (listKey) return Array.isArray(obj[listKey]) ? (obj[listKey] as any[]) : [];
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v as any[];
  return [];
}

const PAGE_SIZE = 30;

const SERVER_PAGINATED = new Set<string>([
  "/delivery-orders-mfg",
  "/sales-invoices",
  "/grns",
  "/mfg-purchase-orders",
  "/purchase-invoices",
  "/consignment-orders",
  "/consignment-notes",
  "/consignment-returns",
  "/suppliers",
]);

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
  aboveList,
}: {
  config: ModuleConfig;
  onBack?: () => void;
  onOpen?: (row: any) => void;
  onNew?: () => void;
  aboveList?: ReactNode;
}) {
  const { q, setQ, chip, setChip, chip2, setChip2, sortKey, setSortKey } = useMobileListView(config.endpoint, config.sorts?.[0]?.key ?? "");

  const { requestTerm: debouncedQ } = useDebouncedSearchTerm(q);

  const { base, params: baseParams } = useMemo(() => splitEndpoint(config.endpoint), [config.endpoint]);
  const wantsPagination = !config.core && SERVER_PAGINATED.has(base);
  const endpointLimit = Number(baseParams.get("limit"));

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

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
    fetchNextPage, hasNextPage, isFetchingNextPage, refetch,
  } = useInfiniteQuery({
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
      if (total == null) return undefined;
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

  const all = useMemo(
    () => (data?.pages ?? []).flatMap((pg) => pickList(pg, config.listKey)),
    [data, config.listKey],
  );

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

  const clientFilterActive = chip !== "all" || chip2 !== "all";
  const recordCount = serverPaginated && !clientFilterActive ? (serverTotal ?? rows.length) : rows.length;

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
        <div className="hdr-row">
          <div>
            {config.eyebrow && <div className="eyebrow">{config.eyebrow}</div>}
            <div className="scr-title">{config.title}</div>
          </div>
          {onNew && (
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
        {aboveList}
        {!listLoading && !error && rows.length > 0 && (
          <span className="list-note">
            {recordCount} {recordCount === 1 ? "record" : "records"}
            {(!serverPaginated || clientFilterActive) ? " loaded" : ""}
          </span>
        )}

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

        {!!error && !listLoading && (
          <div className="empty">
            <div className="empty-t">Couldn't load {config.title.toLowerCase()}.</div>
            <button type="button" className="btn-ghost" style={{ marginTop: 14 }} disabled={isFetching} onClick={() => void refetch()}>{isFetching ? "Retrying…" : "Retry"}</button>
          </div>
        )}

        {!listLoading && !error && rows.length > 0 && (
          <MobileVirtualList
            items={rows}
            getKey={(r, i) => (r.id as string) ?? (r.doc_no as string) ?? i}
            renderItem={(r) => <ListCard config={config} row={r} onOpen={onOpen} />}
          />
        )}
        {!listLoading && !error && hasNextPage && (
          <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
        )}
        {isFetchingNextPage && (
          <div style={{ textAlign: "center", padding: "14px 0 2px", fontSize: 11.5, color: "var(--mut)" }}>Loading more…</div>
        )}
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

function ListCard({ config, row, onOpen }: { config: ModuleConfig; row: any; onOpen?: (row: any) => void }) {
  /* Owner 2026-07-17 — cost is director-only, phone and desktop alike. */
  const { user: cardUser } = useAuth();
  const cardFields = visibleFields(config.fields, cardUser);
  const clickable = !!onOpen;
  const open = clickable ? () => onOpen!(row) : undefined;
  const cardStyle: React.CSSProperties = clickable ? { cursor: "pointer" } : { cursor: "default" };
  const pillStatus = config.pill ? safe(config.pill, row) : "";
  const status = config.badgeText ? safe(config.badgeText, row) : pillStatus;
  const statusTone: StatusTone | undefined =
    config.statusDocType && !config.badgeText
      ? resolveStatusPill(config.statusDocType, pick(row, "status")).tone
      : undefined;
  const cancelled = eq(pillStatus, "Cancelled");
  const name = safe(config.primary, row) || "—";
  const sub = config.subline ? safe(config.subline, row) : safe(config.secondary, row);
  const brandText = config.brand ? safe(config.brand, row) : "";
  const noteLine = config.note ? safe(config.note, row) : "";

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

  if (config.variant === "inventory" || config.variant === "mrp" || config.variant === "warehouse") {
    const kpis = config.kpis ? config.kpis(row) : [];
    const isGrid = config.variant === "mrp";
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

  if (config.variant === "doc") {
    const fl = config.footL ? config.footL(row) : null;
    const frRaw = config.footR ? config.footR(row) : "";
    const frText = config.footMoney ? `RM ${rm(frRaw as unknown as number)}` : frRaw;
    const hasFooter = !!(fl || frText);
    return (
      <div className="card" onClick={open} style={{ ...cardStyle, ...(cancelled ? { opacity: 0.6 } : null) }}>
        <div className="card-b" style={{ padding: "12px 13px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)", flex: 1, minWidth: 0, whiteSpace: "normal", ...(cancelled ? { textDecoration: "line-through", textDecorationThickness: 1 } : null) }}>{name}</span>
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

  return (
    <div className="card" onClick={open} style={{ ...cardStyle, padding: "12px 13px", ...(cancelled ? { opacity: 0.6 } : null) }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 800, color: "var(--hz-c-ink)", ...(cancelled ? { textDecoration: "line-through", textDecorationThickness: 1 } : null) }}>{name}</span>
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
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--hz-c-ink-soft)" }}>{label}</div>
              <div className="money" style={{ fontSize: 12, fontWeight: 600, color: "var(--hz-c-ink)" }}>{safe(accessor, row) || "—"}</div>
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


const join = (...parts: Array<string | null | undefined>) =>
  parts.map((p) => (p == null ? "" : String(p)).trim()).filter(Boolean).join(" · ");


export const FORM_SUPPLIERS: FormSchema = {
  title: "Supplier",
  eyebrow: "Procurement",
  base: "scm",
  createPath: "/suppliers",
  updatePath: (id) => `/suppliers/${encodeURIComponent(id)}`,
  idKey: "id",
  responseIdKeys: ["id"],
  fields: [
    { key: "codeKind", label: "Type", type: "select", options: [{ value: "400", label: "Supplier of goods (400)" }, { value: "405", label: "Other creditor (405)" }], placeholder: "Supplier of goods (400)" }, // owner 2026-11-20: Finance picks; a blank code is numbered by the server
    { key: "code", label: "Code", type: "text", placeholder: "Leave blank to number it from the name", hint: "Blank: 400- or 405-, the name's first letter, the next number." },
    { key: "name", label: "Name", type: "text", required: true, placeholder: "Company name" },
    { key: "contactPerson", label: "Contact Person", type: "text" },
    { key: "phone", label: "Phone", type: "tel", placeholder: "01X-XXX XXXX" },
    { key: "mobile", label: "Mobile", type: "tel" },
    { key: "whatsappNumber", label: "WhatsApp", type: "tel" },
    { key: "email", label: "Email", type: "email", placeholder: "supplier@example.com" },
    { key: "email2", label: "Email 2", type: "email" }, { key: "email3", label: "Email 3", type: "email" }, // owner 2026-11-09: PO Cc
    { key: "address", label: "Address", type: "textarea" },
    { key: "postcode", label: "Postcode", type: "postcode" }, // picking fills State + City (owner 2026-11-17)
    { key: "state", label: "State", type: "text" },
    { key: "city", label: "City", type: "text" },
    { key: "area", label: "Area", type: "text" },
    { key: "country", label: "Country", type: "text", placeholder: "Malaysia" },
    { key: "paymentTerms", label: "Payment Terms", type: "pick", pick: "paymentTerms", placeholder: "Pick the term" }, // the desktop forms' list (owner 2026-11-24)
    { key: "status", label: "Status", type: "select", options: [
      { value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }, { value: "BLOCKED", label: "Blocked" },
    ], placeholder: "Active" },
    { key: "currency", label: "Currency", type: "select", placeholder: "MYR",
      optionsSource: { base: "scm", path: "/currencies?active=true", listKey: "currencies", value: (r) => r.code, label: (r) => r.code } },
    { key: "creditLimitSen", label: "Credit Limit (RM)", type: "money", moneyScale: 100 },
    { key: "businessRegNo", label: "Business Reg No", type: "text" },
    { key: "tinNumber", label: "TIN Number", type: "text" },
    { key: "website", label: "Website", type: "text" },
    { key: "notes", label: "Notes", type: "textarea" },
  ],
};

export const FORM_DRIVERS: FormSchema = {
  title: "Driver",
  eyebrow: "Transportation",
  base: "scm",
  createPath: "/drivers",
  updatePath: (id) => `/drivers/${encodeURIComponent(id)}`,
  idKey: "id",
  fields: [
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
    ], placeholder: "No change" },
  ],
};

export const MODULE_CONFIGS: Record<string, ModuleConfig> = {
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
      [(r) => supplierEmailList(r).join(", ") || "—", "Email"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_SUPPLIERS,
  },

  "delivery-orders-mfg": {
    title: "Delivery Orders",
    eyebrow: "Logistics",
    placeholder: "Search DO · customer",
    endpoint: "/delivery-orders-mfg?limit=500",
    listKey: "deliveryOrders",
    primary: (r) => r.debtor_name,
    secondary: (r) => join(r.do_number, r.status, dm(r.do_date)),
    right: (r) => r.local_total_sen,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.do_number, r.so_doc_no, r.ref, r.phone),
    statusDocType: "do",
    pill: (r) => scmStatusLabel("do", pick(r, "status")),
    variant: "doc",
    subline: (r) => {
      const so = pick(r, "soDocNo", "so_doc_no");
      return join(pick(r, "doNumber", "do_number"), dm(pick(r, "doDate", "do_date")), so ? `SO ${so}` : "");
    },
    brand: (r) => pick(r, "branding") ?? "",
    footL: (r) => ["Driver", pick(r, "driverName", "driver_name") ?? "—"],
    footR: (r) => pick(r, "localTotalSen", "local_total_sen"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "doNumber", "do_number") ?? "—", "DO No"],
      [(r) => dm(pick(r, "doDate", "do_date")), "Date"],
      /* Owner 2026-07-24 — Processing (linked SO's processing_date,
         stamped server-side) + Delivery in every quick view; desktop drawer
         parity. */
      [(r) => dm(pick(r, "soProcessingDate", "so_processing_date")), "Processing"],
      [(r) => dm(pick(r, "customerDeliveryDate", "customer_delivery_date")), "Delivery"],
      [(r) => pick(r, "driverName", "driver_name") ?? "—", "Driver"],
      [(r) => { const n = pick(r, "lineCount", "line_count"); return n == null ? "—" : String(n); }, "Items"],
      [(r) => rmField(pick(r, "localTotalSen", "local_total_sen")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "Loaded", label: "Loaded", match: (r) => eq(pick(r, "status"), "dispatched") },
      { key: "Delivered", label: "Delivered", match: (r) => eq(pick(r, "status"), "delivered") },
      { key: "Cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [
      { key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "doDate", "do_date"), pick(b, "doDate", "do_date")) },
      { key: "cust", label: "Customer", cmp: (a, b) => byStr(a.debtor_name, b.debtor_name) },
    ],
  },

  "sales-invoices": {
    title: "Sales Invoices",
    eyebrow: "Finance",
    placeholder: "Search invoice · customer",
    endpoint: "/sales-invoices?limit=500",
    listKey: "salesInvoices",
    primary: (r) => r.debtor_name,
    secondary: (r) => join(r.invoice_number, r.status, dm(r.invoice_date)),
    right: (r) => r.total_sen,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.invoice_number, r.so_doc_no, r.ref, r.phone),
    statusDocType: "si",
    pill: (r) => scmStatusLabel("si", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "invoiceNumber", "invoice_number"), dm(pick(r, "dueDate", "due_date")) !== "—" ? `due ${dm(pick(r, "dueDate", "due_date"))}` : ""),
    brand: (r) => pick(r, "branding") ?? "",
    footL: (r) => ["Balance", rmField(balanceSen(r))],
    footR: (r) => pick(r, "totalSen", "total_sen", "localTotalSen", "local_total_sen"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "invoiceNumber", "invoice_number") ?? "—", "Inv No"],
      [(r) => dm(pick(r, "invoiceDate", "invoice_date")), "Date"],
      [(r) => dm(pick(r, "dueDate", "due_date")), "Due"],
      /* Owner 2026-07-24 — Processing (linked SO's processing_date,
         stamped server-side) + Delivery (SI snapshot, falling back to the
         linked SO's date) in every quick view; desktop drawer parity. */
      [(r) => dm(pick(r, "soProcessingDate", "so_processing_date")), "Processing"],
      [(r) => dm(pick(r, "customerDeliveryDate", "customer_delivery_date") ?? pick(r, "soCustomerDeliveryDate", "so_customer_delivery_date")), "Delivery"],
      [(r) => rmField(pick(r, "totalSen", "total_sen", "localTotalSen", "local_total_sen")), "Amount"],
      [(r) => rmField(balanceSen(r)), "Balance"],
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
      { key: "amount", label: "Amount", cmp: (a, b) => byNum(pick(a, "totalSen", "total_sen"), pick(b, "totalSen", "total_sen")) },
    ],
  },

  grns: {
    title: "Goods Received",
    eyebrow: "Warehouse",
    placeholder: "Search GRN · supplier · PO",
    endpoint: "/grns?limit=500",
    listKey: "grns",
    primary: (r) => r.supplier?.name || r.grn_number,
    secondary: (r) => join(r.grn_number, r.status, dm(r.received_at)),
    right: (r) => r.total_sen,
    rightMoney: true,
    search: (r) => join(r.grn_number, r.supplier?.name, r.supplier?.code, r.delivery_note_ref),
    statusDocType: "grn",
    pill: (r) => scmStatusLabel("grn", pick(r, "status")),
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
      [(r) => rmField(pick(r, "totalSen", "total_sen")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "draft", label: "Draft", match: (r) => eq(pick(r, "status"), "draft") },
      { key: "posted", label: "Submitted", match: (r) => eq(pick(r, "status"), "posted") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "receivedAt", "received_at"), pick(b, "receivedAt", "received_at")) }],
  },

  "mfg-purchase-orders": {
    title: "Purchase Orders",
    eyebrow: "Procurement",
    placeholder: "Search PO · supplier · item code",
    endpoint: "/mfg-purchase-orders?limit=500",
    listKey: "purchaseOrders",
    primary: (r) => r.supplier?.name || r.po_number,
    secondary: (r) => join(r.po_number, r.status, dm(r.po_date)),
    right: (r) => r.total_sen,
    rightMoney: true,
    search: (r) => join(r.po_number, r.supplier?.name, r.supplier?.code),
    statusDocType: "po",
    pill: (r) => scmStatusLabel("po", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "poNumber", "po_number"), dm(pick(r, "expectedAt", "expected_at")) !== "—" ? `exp ${dm(pick(r, "expectedAt", "expected_at"))}` : ""),
    footL: (r) => { const n = pick(r, "lineCount", "line_count"); return ["", n == null ? "" : `${n} lines`]; },
    footR: (r) => pick(r, "totalSen", "total_sen"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "poNumber", "po_number") ?? "—", "PO No"],
      [(r) => dm(pick(r, "poDate", "po_date")), "Date"],
      [(r) => dm(pick(r, "expectedAt", "expected_at")), "Expected"],
      [(r) => rmField(pick(r, "totalSen", "total_sen")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "outstanding", label: "Outstanding", match: (r) => { const st = String(pick(r, "status") ?? "").toUpperCase(); return st === "SUBMITTED" || st === "PARTIALLY_RECEIVED"; } },
      { key: "draft", label: "Draft", match: (r) => eq(pick(r, "status"), "draft") },
    ],
    sorts: [
      { key: "exp", label: "Expected", cmp: (a, b) => byDate(pick(a, "expectedAt", "expected_at"), pick(b, "expectedAt", "expected_at")) },
      { key: "total", label: "Value", cmp: (a, b) => byNum(pick(a, "totalSen", "total_sen"), pick(b, "totalSen", "total_sen")) },
    ],
  },

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

  inventory: {
    title: "Inventory",
    eyebrow: "Stock",
    placeholder: "Search product · SKU",
    endpoint: "/inventory?showAll=true",
    listKey: "balances",
    primary: (r) => lineIdentity({ code: r.item_code, description: r.product_name }).primary,
    secondary: (r) => join(r.item_code, mfgCategoryLabel(r.category), r.warehouse_code ?? r.warehouse_name),
    right: (r) => (r.qty == null ? "" : `${r.qty}`),
    search: (r) => join(r.product_name, r.item_code, r.category, r.warehouse_name),
    pill: (r) => stockLevel(pick(r, "qty")),
    variant: "inventory",
    subline: (r) => join(pick(r, "warehouseCode", "warehouse_code", "warehouseName", "warehouse_name")),
    kpis: (r) => {
      const n = pick(r, "qty");
      return [["On hand", n == null ? "—" : String(n)], ["Reserved", "—"], ["Available", n == null ? "—" : String(n)]];
    },
    fields: [
      [(r) => pick(r, "itemCode", "item_code") ?? "—", "SKU"],
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
    variant: "person",
    avatar: (r) => r.name || r.email || "",
    subline: (r) => join(pick(r, "positionName", "position_name"), pick(r, "departmentName", "department_name")),
    fields: [
      [(r) => pick(r, "email") ?? "—", "Email"],
      [(r) => pick(r, "positionName", "position_name") ?? "—", "Position"],
      [(r) => pick(r, "managerName", "manager_name") ?? "—", "Reports to"],
      [(r) => pick(r, "departmentName", "department_name") ?? "—", "Department"],
      [(r) => pick(r, "roleName", "role_name") ?? "—", "Role"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "active", label: "Active", match: (r) => eq(pick(r, "status"), "active") },
      { key: "invited", label: "Invited", match: (r) => eq(pick(r, "status"), "invited") },
      { key: "disabled", label: "Disabled", match: (r) => eq(pick(r, "status"), "disabled") },
    ],
    // Sort set mirrors the desktop grid (Name / Recently active / Status)
    // plus the card-visible org fields (owner 2026-07-29: "sort功能不完整").
    sorts: [
      { key: "name", label: "Name", cmp: (a, b) => byStr(a.name || a.email, b.name || b.email) },
      {
        key: "recent",
        label: "Recently active",
        cmp: (a, b) => byDate(pick(a, "lastLoginAt", "last_login_at"), pick(b, "lastLoginAt", "last_login_at")),
      },
      {
        key: "status",
        label: "Status",
        cmp: (a, b) =>
          (MEMBER_STATUS_RANK[String(pick(a, "status"))] ?? 9) -
            (MEMBER_STATUS_RANK[String(pick(b, "status"))] ?? 9) ||
          byStr(a.name || a.email, b.name || b.email),
      },
      {
        key: "dept",
        label: "Department",
        cmp: (a, b) =>
          byStr(
            pick(a, "departmentName", "department_name") || LAST,
            pick(b, "departmentName", "department_name") || LAST,
          ) || byStr(a.name || a.email, b.name || b.email),
      },
      {
        key: "position",
        label: "Position",
        cmp: (a, b) =>
          byStr(
            pick(a, "positionName", "position_name") || LAST,
            pick(b, "positionName", "position_name") || LAST,
          ) || byStr(a.name || a.email, b.name || b.email),
      },
      {
        key: "joined",
        label: "Newest joined",
        cmp: (a, b) => byDate(pick(a, "joinedAt", "joined_at"), pick(b, "joinedAt", "joined_at")),
      },
    ],
    form: FORM_MEMBERS,
  },

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
    variant: "doc",
    badgeText: (r) => { const n = pick(r, "memberCount", "member_count"); return n == null ? "" : String(n); },
    subline: (r) => `Head · ${pick(r, "headName", "head_name") ?? "—"}`,
    fields: [
      [(r) => { const n = pick(r, "memberCount", "member_count"); return n == null ? "—" : String(n); }, "Members"],
    ],
    sorts: [{ key: "name", label: "Name", cmp: (a, b) => byStr(a.name, b.name) }],
    form: FORM_DEPARTMENTS,
  },

  "delivery-returns": {
    title: "Delivery Returns",
    eyebrow: "Finance",
    placeholder: "Search return · customer",
    endpoint: "/delivery-returns?limit=500",
    listKey: "deliveryReturns",
    primary: (r) => r.debtor_name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_sen,
    rightMoney: true,
    search: (r) => deliveryReturnSearchText(r),
    statusDocType: "dr",
    pill: (r) => scmStatusLabel("dr", pick(r, "status")),
    variant: "doc",
    subline: (r) => {
      const ref = pick(r, "soDocNo", "so_doc_no", "doDocNo", "do_doc_no");
      return join(pick(r, "returnNumber", "return_number"), dm(pick(r, "returnDate", "return_date")), ref ? `ref ${ref}` : "");
    },
    note: (r) => pick(r, "reason") ?? "",
    footR: (r) => pick(r, "refundSen", "refund_sen"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "returnNumber", "return_number") ?? "—", "Return No"],
      [(r) => dm(pick(r, "returnDate", "return_date")), "Date"],
      [(r) => pick(r, "reason") ?? "—", "Reason"],
      [(r) => rmField(pick(r, "refundSen", "refund_sen")), "Value"],
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

  "purchase-invoices": {
    title: "Purchase Invoices",
    eyebrow: "Procurement",
    placeholder: "Search PI · supplier",
    endpoint: "/purchase-invoices?limit=500",
    listKey: "purchaseInvoices",
    primary: (r) => r.supplier?.name || r.invoice_number,
    secondary: (r) => join(r.invoice_number, r.status, dm(r.invoice_date)),
    right: (r) => r.total_sen,
    rightMoney: true,
    search: (r) => join(r.invoice_number, r.supplier?.name, r.supplier_invoice_ref),
    statusDocType: "pi",
    pill: (r) => scmStatusLabel("pi", pick(r, "status")),
    variant: "doc",
    subline: (r) => {
      const due = dm(pick(r, "dueDate", "due_date"));
      const grn = r.grn?.grn_number ?? r.grn?.grnNumber;
      const po = r.purchase_order?.po_number ?? r.purchaseOrder?.poNumber;
      const src = grn ? `GRN ${grn}` : po ? `PO ${po}` : "";
      return join(pick(r, "invoiceNumber", "invoice_number"), due !== "—" ? `due ${due}` : "", src);
    },
    footL: (r) => ["Balance", rmField(balanceSen(r))],
    footR: (r) => pick(r, "totalSen", "total_sen"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "invoiceNumber", "invoice_number") ?? "—", "PI No"],
      [(r) => dm(pick(r, "invoiceDate", "invoice_date")), "Date"],
      [(r) => dm(pick(r, "dueDate", "due_date")), "Due"],
      [(r) => rmField(pick(r, "totalSen", "total_sen")), "Amount"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "unpaid", label: "Unpaid", match: (r) => eq(pick(r, "status"), "unpaid") },
      { key: "paid", label: "Paid", match: (r) => eq(pick(r, "status"), "paid") },
      { key: "overdue", label: "Overdue", match: (r) => eq(pick(r, "status"), "overdue") },
    ],
    sorts: [
      { key: "due", label: "Due date", cmp: (a, b) => byDate(pick(a, "dueDate", "due_date"), pick(b, "dueDate", "due_date")) },
      { key: "total", label: "Amount", cmp: (a, b) => byNum(pick(a, "totalSen", "total_sen"), pick(b, "totalSen", "total_sen")) },
    ],
  },

  "purchase-returns": {
    title: "Purchase Returns",
    eyebrow: "Procurement",
    placeholder: "Search return · supplier",
    endpoint: "/purchase-returns?limit=300",
    listKey: "purchaseReturns",
    primary: (r) => r.supplier?.name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_sen,
    rightMoney: true,
    search: (r) => join(r.return_number, r.supplier?.name, r.credit_note_ref),
    statusDocType: "pr",
    pill: (r) => scmStatusLabel("pr", pick(r, "status")),
    variant: "doc",
    subline: (r) => {
      const po = pick(r, "poDocNo", "po_doc_no", "sourcePoDocNo", "source_po_doc_no");
      return join(pick(r, "returnNumber", "return_number"), dm(pick(r, "returnDate", "return_date")), po ? `PO ${po}` : "");
    },
    note: (r) => pick(r, "reason") ?? "",
    footR: (r) => pick(r, "refundSen", "refund_sen"),
    footMoney: true,
    fields: [
      [(r) => pick(r, "returnNumber", "return_number") ?? "—", "Return No"],
      [(r) => dm(pick(r, "returnDate", "return_date")), "Date"],
      [(r) => pick(r, "reason") ?? "—", "Reason"],
      [(r) => rmField(pick(r, "refundSen", "refund_sen")), "Value"],
    ],
    chips: [
      { key: "all", label: "All", match: () => true },
      { key: "draft", label: "Draft", match: (r) => eq(pick(r, "status"), "draft") },
      { key: "posted", label: "Confirmed", match: (r) => eq(pick(r, "status"), "posted") },
      { key: "completed", label: "Completed", match: (r) => eq(pick(r, "status"), "completed") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "returnDate", "return_date"), pick(b, "returnDate", "return_date")) }],
  },

  "purchase-consignment-orders": {
    title: "Purchase Consignment Orders",
    eyebrow: "Consignment",
    placeholder: "Search doc · supplier",
    endpoint: "/purchase-consignment-orders",
    listKey: "purchaseOrders",
    primary: (r) => r.supplier?.name || r.pc_number,
    secondary: (r) => join(r.pc_number, r.status, dm(r.po_date)),
    right: (r) => r.total_sen,
    rightMoney: true,
    search: (r) => join(r.pc_number, r.supplier?.name),
    statusDocType: "po",
    pill: (r) => scmStatusLabel("po", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "pcNumber", "pc_number"), dm(pick(r, "poDate", "po_date"))),
    footR: (r) => pick(r, "totalSen", "total_sen"),
    footMoney: true,
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "poDate", "po_date"), pick(b, "poDate", "po_date")) }],
  },

  "purchase-consignment-receives": {
    title: "Purchase Consignment Receives",
    eyebrow: "Consignment",
    placeholder: "Search receive · supplier",
    endpoint: "/purchase-consignment-receives",
    listKey: "grns",
    primary: (r) => r.supplier?.name || r.receive_number,
    secondary: (r) => join(r.receive_number, r.status, dm(r.received_at)),
    right: (r) => r.total_sen,
    rightMoney: true,
    search: (r) => join(r.receive_number, r.supplier?.name, r.pc_order_no),
    statusDocType: "grn",
    pill: (r) => scmStatusLabel("grn", pick(r, "status")),
    variant: "doc",
    subline: (r) => {
      const po = pick(r, "pcOrderNo", "pc_order_no");
      return join(pick(r, "receiveNumber", "receive_number"), dm(pick(r, "receivedAt", "received_at")), po ? `PC ${po}` : "");
    },
    footR: (r) => pick(r, "totalSen", "total_sen"),
    footMoney: true,
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "receivedAt", "received_at"), pick(b, "receivedAt", "received_at")) }],
  },

  "purchase-consignment-returns": {
    title: "Purchase Consignment Returns",
    eyebrow: "Consignment",
    placeholder: "Search return · doc",
    endpoint: "/purchase-consignment-returns",
    listKey: "purchaseReturns",
    primary: (r) => r.supplier?.name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_sen,
    rightMoney: true,
    search: (r) => join(r.return_number, r.supplier?.name),
    statusDocType: "pr",
    pill: (r) => scmStatusLabel("pr", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "returnNumber", "return_number"), dm(pick(r, "returnDate", "return_date"))),
    note: (r) => pick(r, "reason") ?? "",
    footR: (r) => pick(r, "refundSen", "refund_sen"),
    footMoney: true,
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "returnDate", "return_date"), pick(b, "returnDate", "return_date")) }],
  },

  "consignment-orders": {
    title: "Consignment Orders",
    eyebrow: "Consignment",
    placeholder: "Search consignment · customer",
    endpoint: "/consignment-orders?limit=500",
    listKey: "salesOrders",
    primary: (r) => r.debtor_name || r.doc_no,
    secondary: (r) => join(r.doc_no, r.status, dm(r.so_date)),
    right: (r) => r.local_total_sen,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.doc_no, r.ref, r.po_doc_no),
    pill: (r) => humanize(pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "docNo", "doc_no"), dm(pick(r, "soDate", "so_date"))),
    footR: (r) => pick(r, "localTotalSen", "local_total_sen"),
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

  "consignment-returns": {
    title: "Consignment Returns",
    eyebrow: "Consignment",
    placeholder: "Search return · partner",
    endpoint: "/consignment-returns?limit=500",
    listKey: "deliveryReturns",
    primary: (r) => r.debtor_name || r.return_number,
    secondary: (r) => join(r.return_number, r.status, dm(r.return_date)),
    right: (r) => r.refund_sen,
    rightMoney: true,
    search: (r) => join(r.debtor_name, r.return_number, r.do_doc_no),
    statusDocType: "dr",
    pill: (r) => scmStatusLabel("dr", pick(r, "status")),
    variant: "doc",
    subline: (r) => join(pick(r, "returnNumber", "return_number"), dm(pick(r, "returnDate", "return_date"))),
    note: (r) => pick(r, "reason") ?? "",
    footR: (r) => pick(r, "refundSen", "refund_sen"),
    footMoney: true,
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "returnDate", "return_date"), pick(b, "returnDate", "return_date")) }],
  },

  products: {
    title: "Products & Maintenance",
    eyebrow: "Catalogue",
    placeholder: "Search name · SKU",
    endpoint: "/mfg-products",
    listKey: "products",
    primary: (r) => lineIdentity({ code: pick(r, "code", "sku"), description: r.name }).primary,
    secondary: (r) => join(pick(r, "code", "sku"), mfgCategoryLabel(pick(r, "category")), pick(r, "sizeLabel", "size_label")),
    right: (r) => pick(r, "basePriceSen", "base_price_sen") ?? "",
    rightMoney: true,
    search: (r) => join(r.name, pick(r, "code", "sku"), pick(r, "category"), pick(r, "branding"), pick(r, "barcode")),
    pill: (r) => mfgCategoryLabel(pick(r, "category")),
    variant: "product",
    subline: (r) => join(mfgCategoryLabel(pick(r, "category"))),
    price: (r) => pick(r, "basePriceSen", "base_price_sen") ?? "",
    priceMoney: true,
    fields: [
      [(r) => pick(r, "code", "sku") ?? "—", "SKU"],
      [(r) => mfgCategoryLabel(pick(r, "category")) || "—", "Category"],
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
    secondary: (r) => join(pick(r, "itemCode", "item_code"), mfgCategoryLabel(pick(r, "category")), pick(r, "warehouseCode", "warehouse_code", "warehouseName", "warehouse_name")),
    search: (r) => join(pick(r, "description"), pick(r, "itemCode", "item_code"), pick(r, "category")),
    pill: (r) => mrpState(r),
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

  "stock-transfers": {
    title: "Stock Transfers",
    eyebrow: "Warehouse",
    placeholder: "Search transfer · warehouse",
    endpoint: "/stock-transfers",
    listKey: "transfers",
    primary: (r) => {
      const [from, to] = [pick(r, "fromWarehouse", "from_warehouse"), pick(r, "toWarehouse", "to_warehouse")].map(warehouseLabel);
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
      { key: "posted", label: "Confirmed", match: (r) => eq(pick(r, "status"), "posted") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "transferDate", "transfer_date"), pick(b, "transferDate", "transfer_date")) }],
  },

  "stock-takes": {
    title: "Stock Take",
    eyebrow: "Warehouse",
    placeholder: "Search stock take · warehouse",
    endpoint: "/stock-takes",
    listKey: "takes",
    primary: (r) => warehouseLabel(pick(r, "warehouse")) ?? pick(r, "takeNo", "take_no") ?? "—",
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
      { key: "posted", label: "Confirmed", match: (r) => eq(pick(r, "status"), "posted") },
      { key: "cancelled", label: "Cancelled", match: (r) => eq(pick(r, "status"), "cancelled") },
    ],
    sorts: [{ key: "date", label: "Date", cmp: (a, b) => byDate(pick(a, "takeDate", "take_date"), pick(b, "takeDate", "take_date")) }],
  },

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

const capacityLabel = (r: any): string => {
  const kg = pick(r, "capacityKg", "capacity_kg");
  if (kg != null) return `${Number(kg).toLocaleString("en-MY")} kg`;
  const m3 = pick(r, "capacityM3", "capacity_m3");
  if (m3 != null) return `${m3} m3`;
  return "—";
};
