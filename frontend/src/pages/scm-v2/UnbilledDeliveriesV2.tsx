// UnbilledDeliveriesV2 — goods that left the warehouse and were never charged
// for, aged. Read-only; no writes, no drawer. In the owner's Claude Design
// redesign (Finance › Money in › Not yet billed, batch 5): four cards, age
// chips with their counts, then the deliveries as a table or as cards.
//
// Route: /scm/unbilled-deliveries. Reads GET /api/scm/unbilled-deliveries —
// see the header note in backend/src/scm/routes/unbilled-deliveries.ts for why
// this is line-level and why the Outstanding page's DO list (a header-status
// flag with no money column) cannot answer this question.
//
// THE AGE IS THE POINT. Steady-state un-invoiced runs 1–3%/month, but the
// CURRENT month legitimately runs ~2/3 un-invoiced — that is billing lag, not
// leakage, and a report that opens on it is a report nobody reads twice. So the
// default chip is "Aged 31+", NOT "All": the page opens past the noise. The
// endpoint stays honest (it returns every age; `minAgeDays` is its param) and
// the opinion about where to look lives here, in the view.
//
// The query is declared inline (useQuery + authedFetch — the Categories.tsx /
// ConsignmentOrders.tsx idiom) rather than as a vendor/scm/lib/*-queries slice:
// this report is Houzs-native, not vendored from 2990, so it adds nothing to the
// vendored tree.

import { useMemo, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Hourglass, Layers, LayoutGrid, Phone, Table as TableIcon, Truck } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { DataTable, type Column } from "../../components/DataTable";
import { PullToRefresh } from "../../components/PullToRefresh";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { fmtDate, fmtSen } from "../../vendor/shared/format";
import { formatPhone } from "../../vendor/shared/phone";
import { retryUnlessClientError } from '../../lib/retryPolicy';
import { statusLabel } from "../../vendor/scm/lib/status-pill";
import { matchesSearch, soRefOfStamp, type SoRefStamp } from "../../lib/so-ref-search";
import { Chips, DocLink, FigureCard, Segments, StatusTag } from "./money-in/MoneyInParts";
import { unbilledAgeTone } from "./money-in/moneyInStatus";
import s from "./MoneyIn.module.css";

// ─── Types — mirrors the endpoint's Row / buckets / totals ──────────────────

type UnbilledRow = {
  delivery_order_id: string;
  do_number: string;
  do_date: string;
  age_days: number;
  bucket: string;
  bucket_label: string;
  status: string;
  so_doc_no: string | null;
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  salesperson: string | null;
  delivered_sen: number;
  invoiced_sen: number;
  returned_sen: number;
  unbilled_sen: number;
  lines_total: number;
  lines_pending: number;
  partly_invoiced: boolean;
} & SoRefStamp;

type UnbilledResponse = {
  as_of: string;
  rows: UnbilledRow[];
  buckets: Array<{ key: string; label: string; rows: number; unbilled_sen: number }>;
  totals: {
    rows: number;
    unbilled_sen: number;
    over_365: { rows: number; unbilled_sen: number };
    partly_invoiced: { rows: number; unbilled_sen: number };
  };
};

const ICON = { size: 14, strokeWidth: 1.75 } as const;

const ageTag = (days: number) => ({ text: `${days.toLocaleString("en-MY")} days`, tone: unbilledAgeTone(days) });
const deliveriesWord = (n: number): string => (n === 1 ? "1 delivery" : `${n.toLocaleString("en-MY")} deliveries`);

/* Ageing THRESHOLDS, not the endpoint's disjoint buckets. The owner's question
   is "how far back does this go" ("111 DOs older than 12 months"), so the chips
   are cumulative severity steps he can think in, and each row still carries its
   exact age tag. `minAge` is INCLUSIVE. */
type AgeTab = "all" | "aged" | "over90" | "over365";
const AGE_TABS: Array<{ value: AgeTab; label: string; minAge: number }> = [
  { value: "all",     label: "All ages",       minAge: 0 },
  { value: "aged",    label: "Aged 31+",       minAge: 31 },
  { value: "over90",  label: "Over 90 days",   minAge: 91 },
  { value: "over365", label: "Over 12 months", minAge: 366 },
];
const DEFAULT_AGE_TAB: AgeTab = "aged";
const minAgeOf = (t: AgeTab): number => AGE_TABS.find((x) => x.value === t)?.minAge ?? 0;

const VIEW_OPTIONS: Array<{ value: "table" | "cards"; label: string; icon: ReactNode }> = [
  { value: "table", label: "Table", icon: <TableIcon size={13} aria-hidden /> },
  { value: "cards", label: "Cards", icon: <LayoutGrid size={13} aria-hidden /> },
];

const EMPTY_TEXT = "Nothing delivered and unbilled in this filter.";

function CardsGrid({ rows, onOpen, loading, failed }: {
  rows: UnbilledRow[];
  onOpen: (r: UnbilledRow) => void;
  loading: boolean;
  failed: boolean;
}) {
  if (loading || failed || rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center text-[13px] text-ink-muted shadow-stone">
        {loading ? "Loading…" : failed ? "Could not load this report" : EMPTY_TEXT}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => (
        <button
          key={r.delivery_order_id}
          type="button"
          onClick={() => onOpen(r)}
          className="group relative overflow-hidden rounded-lg border border-border bg-surface px-4 py-4 text-left shadow-stone transition-all duration-200 hover:-translate-y-px hover:border-primary/40 hover:shadow-slab focus:outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold tabular-nums text-ink">{r.do_number}</span>
            <StatusTag tag={ageTag(r.age_days)} />
          </div>
          <div className="mt-2 truncate text-[13.5px] font-semibold text-ink">{r.debtor_name ?? "—"}</div>
          <div className="mt-0.5 text-[11.5px] text-ink-muted">
            {fmtDate(r.do_date)}
            {r.salesperson ? ` · ${r.salesperson}` : ""}
          </div>
          {r.phone && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
              <Phone size={11} className="text-ink-muted" />
              <span className="truncate">{formatPhone(r.phone)}</span>
            </div>
          )}
          <div className="mt-3.5 flex items-end justify-between border-t border-border-subtle pt-3">
            <div>
              {r.partly_invoiced && <StatusTag tag={{ text: "Partly billed", tone: "warn" }} />}
            </div>
            <div className="text-right">
              <div className="text-[11px] font-semibold text-ink-muted">Not billed</div>
              <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink">{fmtSen(r.unbilled_sen)}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function UnbilledDeliveriesV2() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();

  const ageParam = params.get("age");
  const age: AgeTab = AGE_TABS.find((t) => t.value === ageParam)?.value ?? DEFAULT_AGE_TAB;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";

  /* Fetch EVERY age once (minAgeDays defaults to 0 server-side) and threshold on
     the client. The chips then need no refetch, and the "All ages" count stays
     honest — the current-month lag is present in the data, just not on screen by
     default. The list is a tail of stale documents, so 30s staleTime + the
     shared 1-retry idiom (vendor/scm/lib/outstanding-queries baseQuery) is
     plenty; nothing here is real-time. */
  const { data, isLoading, error } = useQuery({
    queryKey: ["unbilled-deliveries"],
    queryFn: () => authedFetch<UnbilledResponse>("/unbilled-deliveries"),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

  const allRows = useMemo<UnbilledRow[]>(() => data?.rows ?? [], [data]);

  /* The search first, then the age: each chip then counts what it would show
     under the search typed (the design's counts). */
  const searched = useMemo(() => {
    if (!search.trim()) return allRows;
    return allRows.filter((r) =>
      matchesSearch([r.do_number, r.debtor_name, r.debtor_code, r.so_doc_no, soRefOfStamp(r), r.salesperson, r.phone], search)
    );
  }, [allRows, search]);

  const filtered = useMemo(() => {
    const min = minAgeOf(age);
    return min <= 0 ? searched : searched.filter((r) => r.age_days >= min);
  }, [searched, age]);

  /* The cards follow the ROWS ON SCREEN, so the headline can never disagree
     with the list under it — except "Over 12 months", which is deliberately
     absolute (it is THE number, and it should not move when he filters; owner
     spec A3 keeps it so). */
  const stats = useMemo(() => {
    const oldestRow = filtered.reduce<UnbilledRow | null>((m, r) => (m == null || r.age_days > m.age_days ? r : m), null);
    const partly = filtered.filter((r) => r.partly_invoiced);
    return {
      count: filtered.length,
      unbilled: filtered.reduce((sum, r) => sum + r.unbilled_sen, 0),
      oldest: oldestRow?.age_days ?? 0,
      oldestDate: oldestRow?.do_date ?? null,
      partlyCount: partly.length,
      partlyValue: partly.reduce((sum, r) => sum + r.unbilled_sen, 0),
      over365Count: data?.totals.over_365.rows ?? 0,
      over365Value: data?.totals.over_365.unbilled_sen ?? 0,
    };
  }, [filtered, data]);

  const ageCounts = useMemo(() => {
    const acc: Record<AgeTab, number> = { all: 0, aged: 0, over90: 0, over365: 0 };
    for (const t of AGE_TABS) acc[t.value] = searched.filter((r) => r.age_days >= t.minAge).length;
    return acc;
  }, [searched]);

  const setAgeChip = (a: AgeTab) => {
    const next = new URLSearchParams(params);
    if (a === DEFAULT_AGE_TAB) next.delete("age"); else next.set("age", a);
    setParams(next, { replace: true });
  };
  const setView = (v: "table" | "cards") => {
    const next = new URLSearchParams(params);
    if (v === "table") next.delete("view"); else next.set("view", v);
    setParams(next, { replace: true });
  };
  const setSearch = (q: string) => {
    const next = new URLSearchParams(params);
    if (!q.trim()) next.delete("q"); else next.set("q", q);
    setParams(next, { replace: true });
  };
  const resetLayout = () => setParams(new URLSearchParams(), { replace: true });
  const filtersActive = age !== DEFAULT_AGE_TAB || view !== "table" || search.trim().length > 0;

  const onPullToRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["unbilled-deliveries"] });
  };

  // Every row is a document he can open and act on — the DO detail is where the
  // "convert to invoice" path starts.
  const goDetail = (r: UnbilledRow) => navigate(`/scm/delivery-orders/${r.delivery_order_id}`);

  const moneyColumn = (key: "unbilled_sen" | "delivered_sen" | "invoiced_sen", label: string, muted: boolean): Column<UnbilledRow> => ({
    key,
    label,
    width: key === "unbilled_sen" ? "120px" : key === "delivered_sen" ? "132px" : "124px",
    align: "right",
    getValue: (r) => r[key],
    exportValue: (r) => r[key] / 100,
    exportFormat: "money",
    total: (rows) => fmtSen(rows.reduce((sum, r) => sum + r[key], 0)),
    render: (r) => (key === "unbilled_sen" ? (
      <div className="flex flex-col items-end gap-1">
        <span className={s.strong}>{fmtSen(r.unbilled_sen)}</span>
        {/* The expensive case, and the one a header-status report cannot see:
            part of this DO was billed and the rest was quietly left behind. */}
        {r.partly_invoiced && <StatusTag tag={{ text: `${r.lines_pending} of ${r.lines_total} lines`, tone: "warn" }} />}
      </div>
    ) : (
      <span className={muted ? s.muted : undefined}>{fmtSen(r[key])}</span>
    )),
  });

  const columns: Column<UnbilledRow>[] = [
    {
      key: "do_number",
      label: "DO No.",
      width: "132px",
      alwaysVisible: true,
      getValue: (r) => r.do_number,
      render: (r) => <DocLink to={`/scm/delivery-orders/${r.delivery_order_id}`}>{r.do_number}</DocLink>,
    },
    {
      key: "do_date",
      label: "Delivered",
      width: "100px",
      getValue: (r) => r.do_date,
      render: (r) => <span className={s.muted}>{fmtDate(r.do_date)}</span>,
    },
    {
      key: "age_days",
      label: "Age",
      width: "100px",
      // Sort + CSV export on the NUMBER, so "Over 12 months" never sorts as text.
      getValue: (r) => r.age_days,
      render: (r) => <StatusTag tag={ageTag(r.age_days)} />,
    },
    {
      key: "debtor_name",
      label: "Customer",
      getValue: (r) => r.debtor_name ?? "",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate">{r.debtor_name ?? "—"}</div>
          {r.debtor_code && <span className={`${s.under} truncate`}>{r.debtor_code}</span>}
        </div>
      ),
    },
    {
      key: "phone",
      label: "Phone",
      width: "130px",
      defaultHidden: true,
      getValue: (r) => r.phone ?? "",
      render: (r) =>
        r.phone ? (
          <div className="flex items-center gap-1.5">
            <Phone size={11} className="shrink-0 text-ink-muted" />
            <span className={`${s.muted} truncate`}>{formatPhone(r.phone)}</span>
          </div>
        ) : (
          <span className={s.muted}>—</span>
        ),
    },
    {
      key: "salesperson",
      label: "Salesperson",
      width: "110px",
      getValue: (r) => r.salesperson ?? "",
      render: (r) => <span className={`${s.muted} truncate`}>{r.salesperson ?? "—"}</span>,
    },
    {
      key: "so_doc_no",
      label: "SO No.",
      width: "128px",
      getValue: (r) => r.so_doc_no ?? "",
      render: (r) => (r.so_doc_no ? <DocLink to={`/scm/sales-orders/${r.so_doc_no}`}>{r.so_doc_no}</DocLink> : "—"),
    },
    moneyColumn("unbilled_sen", "Not billed", false),
    moneyColumn("delivered_sen", "Delivered value", true),
    moneyColumn("invoiced_sen", "Already billed", true),
    {
      key: "status",
      label: "DO Status",
      width: "100px",
      /* Off by default, as before the redesign (Columns turns it on): with it
         the design's columns overflow a laptop screen and squeeze the ages. */
      defaultHidden: true,
      getValue: (r) => statusLabel("do", r.status),
      render: (r) => <span className={s.muted}>{statusLabel("do", r.status)}</span>,
    },
  ];

  /* Every card below is a reduce over `filtered`, which is [] until the query
     lands and stays [] when it fails. On this page that renders as "Not billed
     RM 0.00" — read on a finance screen as "nobody is owed anything", which is
     the opposite of what an unloaded list means. Unknown until it is known. */
  const statsPending = isLoading || Boolean(error);
  const pendingSub = error ? "Could not read" : "Loading…";
  const subOf = (text: string) => (statsPending ? pendingSub : text);
  const loadError = error ? (error instanceof Error && error.message ? error.message : "Could not load this report") : null;

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      <div className={s.page}>
        <div className="flex items-start justify-between gap-3 md:hidden">
          <div className="min-w-0">
            <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">Not yet billed</h1>
            <div className="mt-0.5 text-[12.5px] text-ink-muted">
              {statsPending ? pendingSub : `${deliveriesWord(stats.count)} · ${fmtSen(stats.unbilled)}`}
            </div>
          </div>
        </div>

        <div className="hidden md:block">
          <PageHeader eyebrow="Finance · Money in" title="Not yet billed" />
        </div>

        <div className={`${s.cardsWrap} hidden md:block`}>
          <div className={s.cards}>
            {/* THE headline — absolute, not filter-scoped (see stats memo). */}
            <FigureCard
              icon={<Clock {...ICON} />}
              label="Over 12 months"
              value={stats.over365Count.toLocaleString("en-MY")}
              zero={stats.over365Count === 0}
              sub={subOf(`${fmtSen(stats.over365Value)} not billed`)}
              subBad={Boolean(error)}
              pending={statsPending}
            />
            <FigureCard
              icon={<Truck {...ICON} />}
              label="Not billed"
              value={fmtSen(stats.unbilled)}
              sub={subOf(`Scoped to the filter · ${deliveriesWord(stats.count)}`)}
              subBad={Boolean(error)}
              pending={statsPending}
            />
            <FigureCard
              icon={<Layers {...ICON} />}
              label="Partly billed"
              value={stats.partlyCount.toLocaleString("en-MY")}
              zero={stats.partlyCount === 0}
              sub={subOf("Invoiced in part, the rest not")}
              subBad={Boolean(error)}
              title={statsPending ? undefined : `${fmtSen(stats.partlyValue)} not billed on these`}
              pending={statsPending}
            />
            <FigureCard
              icon={<Hourglass {...ICON} />}
              label="Oldest"
              value={stats.oldest > 0 ? `${stats.oldest.toLocaleString("en-MY")} days` : "—"}
              sub={subOf(stats.oldestDate ? `Delivered ${fmtDate(stats.oldestDate)}` : "Nothing in this filter")}
              subBad={Boolean(error)}
              pending={statsPending}
            />
          </div>
        </div>

        <div className="sticky top-0 z-10 -mx-4 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search DO, customer, salesperson…"
            className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>

        <div className={s.toolbar}>
          <Chips
            label="Age"
            options={AGE_TABS.map((t) => ({ value: t.value, label: t.label, count: statsPending ? undefined : ageCounts[t.value] }))}
            value={age}
            onChange={setAgeChip}
          />
          <span className={s.grow} />
          <div className="hidden md:block">
            <Segments label="View" options={VIEW_OPTIONS} value={view} onChange={setView} />
          </div>
        </div>

        <div className="md:hidden">
          <CardsGrid rows={filtered} onOpen={goDetail} loading={isLoading} failed={Boolean(error)} />
        </div>

        <div className="hidden md:block">
          {view === "table" ? (
            <DataTable<UnbilledRow>
              tableId="unbilled-deliveries-v2"
              rows={filtered}
              loading={isLoading}
              error={loadError}
              columns={columns}
              getRowKey={(r) => r.delivery_order_id}
              onRowDoubleClick={goDetail}
              exportName="delivered-not-billed"
              emptyLabel={EMPTY_TEXT}
              search={{ value: search, onChange: setSearch, placeholder: "Search DO, customer, salesperson…", scope: "server", totalRecords: filtered.length }}
              resetFilters={{ active: filtersActive, onReset: resetLayout, label: "Reset layout" }}
            />
          ) : (
            <CardsGrid rows={filtered} onOpen={goDetail} loading={isLoading} failed={Boolean(error)} />
          )}
        </div>
      </div>
    </PullToRefresh>
  );
}

export default UnbilledDeliveriesV2;
