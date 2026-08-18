// UnbilledDeliveriesV2 — goods that left the warehouse and were never charged
// for, aged. Read-only; no writes, no drawer. Same PageHeader + StatCard +
// FilterPills + Table/Cards template as StockTakesListV2 (see the DO V2 file for
// the deep dive on primitives + Theme C conventions).
//
// Route: /scm/unbilled-deliveries. Reads GET /api/scm/unbilled-deliveries —
// see the header note in backend/src/scm/routes/unbilled-deliveries.ts for why
// this is line-level and why the Outstanding page's DO tab (a header-status flag
// with no money column) cannot answer this question.
//
// FRAMING: money that should have come IN and never did — so the chrome leans on
// the error tone, like the Delivery Returns V2 refund framing rather than the
// DO/SI green-when-good idiom.
//
// THE AGE IS THE POINT. Steady-state un-invoiced runs 1–3%/month, but the
// CURRENT month legitimately runs ~2/3 un-invoiced — that is billing lag, not
// leakage, and a report that opens on it is a report nobody reads twice. So the
// default pill is "Aged 31+", NOT "All": the page opens past the noise. The
// endpoint stays honest (it returns every age; `minAgeDays` is its param) and
// the opinion about where to look lives here, in the view.
//
// The query is declared inline (useQuery + authedFetch — the Categories.tsx /
// ConsignmentOrders.tsx idiom) rather than as a vendor/scm/lib/*-queries slice:
// this report is Houzs-native, not vendored from 2990, so it adds nothing to the
// vendored tree.

import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Phone, LayoutGrid, Table as TableIcon } from "lucide-react";
import { PageHeader } from "../../components/Layout";
import { StatCard } from "../../components/StatCard";
import { FilterPills } from "../../components/FilterPills";
import { DataTable, type Column } from "../../components/DataTable";
import { Badge } from "../../components/Badge";
import { PullToRefresh } from "../../components/PullToRefresh";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { cn } from "../../lib/utils";
import { fmtCenti } from "../../vendor/shared/format";
import { formatPhone } from "../../vendor/shared/phone";
import { retryUnlessClientError } from '../../lib/retryPolicy';
import { fmtDate } from "@2990s/shared";

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
  delivered_centi: number;
  invoiced_centi: number;
  returned_centi: number;
  unbilled_centi: number;
  lines_total: number;
  lines_pending: number;
  partly_invoiced: boolean;
};

type UnbilledResponse = {
  as_of: string;
  rows: UnbilledRow[];
  buckets: Array<{ key: string; label: string; rows: number; unbilled_centi: number }>;
  totals: {
    rows: number;
    unbilled_centi: number;
    over_365: { rows: number; unbilled_centi: number };
    partly_invoiced: { rows: number; unbilled_centi: number };
  };
};

// Guarded centi→"RM …" — "—" for an absent/non-finite amount, never "RM NaN".
const fmtRm = (centi: number | null | undefined): string => fmtCenti(centi);

/* Age → tone. Nothing under 3 months is coloured: it is not yet a finding, and
   colouring it would spend the reader's alarm on normal billing lag. */
const ageTone = (days: number): "error" | "warning" | "neutral" =>
  days > 365 ? "error" : days > 90 ? "warning" : "neutral";

/* Ageing THRESHOLDS, not the endpoint's disjoint buckets. The owner's question
   is "how far back does this go" ("111 DOs older than 12 months"), so the pills
   are cumulative severity steps he can think in, and each row still carries its
   exact bucket badge. `minAge` is INCLUSIVE. */
type AgeTab = "all" | "aged" | "over90" | "over365";
const AGE_TABS: Array<{ value: AgeTab; label: string; minAge: number }> = [
  { value: "all",     label: "All ages",       minAge: 0 },
  { value: "aged",    label: "Aged 31+",       minAge: 31 },
  { value: "over90",  label: "Over 90 days",   minAge: 91 },
  { value: "over365", label: "Over 12 months", minAge: 366 },
];
const DEFAULT_AGE_TAB: AgeTab = "aged";
const minAgeOf = (t: AgeTab): number => AGE_TABS.find((x) => x.value === t)?.minAge ?? 0;

function ViewToggle({ value, onChange }: { value: "table" | "cards"; onChange: (v: "table" | "cards") => void }) {
  const btn = (which: "table" | "cards", label: string, Icon: typeof TableIcon) => {
    const active = value === which;
    return (
      <button
        type="button"
        onClick={() => onChange(which)}
        aria-pressed={active}
        className={cn(
          "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
          active ? "bg-primary text-white shadow-sm" : "text-ink-secondary hover:bg-primary-soft hover:text-primary"
        )}
      >
        <Icon size={13} />
        {label}
      </button>
    );
  };
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-surface p-1 shadow-stone">
      {btn("table", "Table", TableIcon)}
      {btn("cards", "Cards", LayoutGrid)}
    </div>
  );
}

/* Plain language, no jargon — the reader is the business owner, not an
   engineer. "Un-invoiced", "outstanding", "DO" and "ageing bucket" are all
   words this empty state deliberately does not use. */
function EmptyBlock({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface px-6 py-16 text-center shadow-stone">
      <div className="text-[13px] font-semibold text-ink">
        {filtered ? "Nothing this old is waiting to be billed" : "Everything delivered has been billed"}
      </div>
      <div className="mx-auto mt-1 max-w-md text-[12px] text-ink-muted">
        {filtered
          ? "Try a shorter time range to see deliveries that are still waiting."
          : "Every delivery that has left the warehouse has an invoice against it."}
      </div>
    </div>
  );
}

function CardsGrid({ rows, onOpen }: { rows: UnbilledRow[]; onOpen: (r: UnbilledRow) => void }) {
  if (rows.length === 0) return <EmptyBlock filtered />;
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
            <span className="font-mono text-[12.5px] font-semibold text-ink">{r.do_number}</span>
            <Badge tone={ageTone(r.age_days)} size="xs">{r.age_days} days</Badge>
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
              {r.partly_invoiced && <Badge tone="warning" size="xs">Partly billed</Badge>}
            </div>
            <div className="text-right">
              <div className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Not billed</div>
              <div className="mt-0.5 font-money text-[15px] font-bold text-err">{fmtRm(r.unbilled_centi)}</div>
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

  const age = (params.get("age") ?? DEFAULT_AGE_TAB) as AgeTab;
  const view = (params.get("view") ?? "table") as "table" | "cards";
  const search = params.get("q") ?? "";

  /* Fetch EVERY age once (minAgeDays defaults to 0 server-side) and threshold on
     the client. The pills then need no refetch, and the "All ages" count stays
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

  const scopedByAge = useMemo(() => {
    const min = minAgeOf(age);
    return min <= 0 ? allRows : allRows.filter((r) => r.age_days >= min);
  }, [allRows, age]);

  const filtered = useMemo(() => {
    if (!search.trim()) return scopedByAge;
    const q = search.toLowerCase();
    return scopedByAge.filter((r) =>
      [r.do_number, r.debtor_name, r.debtor_code, r.so_doc_no, r.salesperson, r.phone]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [scopedByAge, search]);

  /* Stat cards follow the ROWS ON SCREEN, so the headline can never disagree
     with the list under it — except "Over 12 months", which is deliberately
     absolute (it is THE number, and it should not move when he filters). */
  const stats = useMemo(() => {
    const unbilled = filtered.reduce((s, r) => s + r.unbilled_centi, 0);
    const oldest = filtered.reduce((m, r) => Math.max(m, r.age_days), 0);
    const partly = filtered.filter((r) => r.partly_invoiced);
    return {
      count: filtered.length,
      unbilled,
      oldest,
      partlyCount: partly.length,
      partlyValue: partly.reduce((s, r) => s + r.unbilled_centi, 0),
      over365Count: data?.totals.over_365.rows ?? 0,
      over365Value: data?.totals.over_365.unbilled_centi ?? 0,
    };
  }, [filtered, data]);

  const ageCounts = useMemo(() => {
    const acc: Record<AgeTab, number> = { all: 0, aged: 0, over90: 0, over365: 0 };
    for (const t of AGE_TABS) acc[t.value] = allRows.filter((r) => r.age_days >= t.minAge).length;
    return acc;
  }, [allRows]);

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

  const columns: Column<UnbilledRow>[] = [
    {
      key: "do_number",
      label: "DO No.",
      width: "150px",
      alwaysVisible: true,
      getValue: (r) => r.do_number,
      render: (r) => <span className="font-mono text-[12.5px] font-semibold text-ink">{r.do_number}</span>,
    },
    {
      key: "do_date",
      label: "Delivered",
      width: "108px",
      getValue: (r) => r.do_date,
      render: (r) => <span className="text-[12.5px] text-ink-secondary">{fmtDate(r.do_date)}</span>,
    },
    {
      key: "age_days",
      label: "Age",
      width: "132px",
      // Sort + CSV export on the NUMBER, so "Over 12 months" never sorts as text.
      getValue: (r) => r.age_days,
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <Badge tone={ageTone(r.age_days)} size="xs">{r.age_days.toLocaleString("en-MY")} days</Badge>
        </div>
      ),
    },
    {
      key: "debtor_name",
      label: "Customer",
      getValue: (r) => r.debtor_name ?? "",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">{r.debtor_name ?? "—"}</div>
          {r.debtor_code && <div className="truncate font-mono text-[11px] text-ink-muted">{r.debtor_code}</div>}
        </div>
      ),
    },
    {
      key: "phone",
      label: "Phone",
      width: "130px",
      getValue: (r) => r.phone ?? "",
      render: (r) =>
        r.phone ? (
          <div className="flex items-center gap-1.5">
            <Phone size={11} className="shrink-0 text-ink-muted" />
            <span className="truncate text-[12.5px] text-ink-secondary">{formatPhone(r.phone)}</span>
          </div>
        ) : (
          <span className="text-[12.5px] text-ink-muted">—</span>
        ),
    },
    {
      key: "salesperson",
      label: "Salesperson",
      width: "150px",
      getValue: (r) => r.salesperson ?? "",
      render: (r) => <span className="truncate text-[12.5px] text-ink-secondary">{r.salesperson ?? "—"}</span>,
    },
    {
      key: "so_doc_no",
      label: "SO No.",
      width: "150px",
      getValue: (r) => r.so_doc_no ?? "",
      render: (r) => <span className="font-mono text-[12px] text-ink-secondary">{r.so_doc_no ?? "—"}</span>,
    },
    {
      key: "unbilled_centi",
      label: "Not billed",
      width: "158px",
      align: "right",
      getValue: (r) => r.unbilled_centi,
      render: (r) => (
        <div className="flex flex-col items-end gap-1">
          <span className="font-money text-[13px] font-bold text-err">{fmtRm(r.unbilled_centi)}</span>
          {/* The expensive case, and the one a header-status report cannot see:
              part of this DO was billed and the rest was quietly left behind. */}
          {r.partly_invoiced && <Badge tone="warning" size="xs">{r.lines_pending} of {r.lines_total} lines</Badge>}
        </div>
      ),
    },
    {
      key: "delivered_centi",
      label: "Delivered value",
      width: "140px",
      align: "right",
      defaultHidden: true,
      getValue: (r) => r.delivered_centi,
      render: (r) => <span className="font-money text-[12.5px] text-ink-secondary">{fmtRm(r.delivered_centi)}</span>,
    },
    {
      key: "invoiced_centi",
      label: "Already billed",
      width: "140px",
      align: "right",
      defaultHidden: true,
      getValue: (r) => r.invoiced_centi,
      render: (r) => <span className="font-money text-[12.5px] text-ink-secondary">{fmtRm(r.invoiced_centi)}</span>,
    },
    {
      key: "status",
      label: "DO Status",
      width: "120px",
      defaultHidden: true,
      getValue: (r) => r.status,
      render: (r) => <Badge tone="neutral" size="xs">{r.status}</Badge>,
    },
  ];

  const agePillOptions = AGE_TABS.map((t) => ({ value: t.value, label: t.label, count: ageCounts[t.value] }));

  /* Every tile below is a reduce over `filtered`, which is [] until the query
     lands and stays [] when it fails. On this page that renders as "Not billed
     RM 0.00" — read on a finance screen as "nobody is owed anything", which is
     the opposite of what an unloaded list means. Unknown until it is known. */
  const statsPending = isLoading || Boolean(error);

  return (
    <PullToRefresh onRefresh={onPullToRefresh}>
      <div className="mb-3 flex items-start justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-tight text-ink">Not Yet Billed</h1>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">
            {statsPending ? (
              "Loading…"
            ) : (
              <>
                {stats.count} deliver{stats.count === 1 ? "y" : "ies"} · {fmtRm(stats.unbilled)}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="hidden md:block">
        <PageHeader
          eyebrow="Finance"
          title="Delivered, Not Yet Billed"
          description="Goods that have left the warehouse with no invoice against them. Counted line by line, so a delivery that was only partly invoiced still shows the part nobody charged for. The newest month is normal billing lag — the money is in the old rows."
        />
      </div>

      <div className="mb-5 hidden grid-cols-2 gap-3 md:grid lg:grid-cols-4">
        {/* THE headline — absolute, not filter-scoped (see stats memo). */}
        <StatCard
          label="Over 12 months"
          value={fmtRm(stats.over365Value)}
          subtitle={`${stats.over365Count.toLocaleString("en-MY")} deliveries never billed`}
          tone={stats.over365Value > 0 ? "error" : undefined}
          rail="bg-err"
          active
          pending={statsPending}
        />
        <StatCard
          label="Not billed"
          value={fmtRm(stats.unbilled)}
          subtitle="Scoped to current filter"
          rail="bg-primary"
          pending={statsPending}
        />
        <StatCard
          label="Partly billed"
          value={fmtRm(stats.partlyValue)}
          subtitle={`${stats.partlyCount.toLocaleString("en-MY")} part-invoiced deliveries`}
          tone={stats.partlyValue > 0 ? "warning" : undefined}
          rail="bg-accent-bright"
          pending={statsPending}
        />
        <StatCard
          label="Oldest"
          value={stats.oldest > 0 ? `${stats.oldest.toLocaleString("en-MY")} days` : "—"}
          subtitle={data?.as_of ? `As at ${fmtDate(data.as_of)}` : "Scoped to current filter"}
          rail="bg-accent"
          pending={statsPending}
        />
      </div>

      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-bg/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search DO, customer, salesperson…"
          className="h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterPills options={agePillOptions} value={age} onChange={(v) => setAgeChip(v)} />
        <div className="flex-1" />
        <div className="hidden md:block"><ViewToggle value={view} onChange={setView} /></div>
      </div>

      <div className="md:hidden">
        <CardsGrid rows={filtered} onOpen={goDetail} />
      </div>

      <div className="hidden md:block">
        {view === "table" ? (
          <DataTable<UnbilledRow>
            tableId="unbilled-deliveries-v2"
            rows={filtered}
            loading={isLoading}
            error={error ? (error as Error).message ?? "Could not load this report" : null}
            columns={columns}
            getRowKey={(r) => r.delivery_order_id}
            onRowClick={goDetail}
            exportName="delivered-not-billed"
            emptyLabel={
              filtersActive
                ? "Nothing this old is waiting to be billed — try a shorter time range."
                : "Every delivery that has left the warehouse has an invoice against it."
            }
            search={{ value: search, onChange: setSearch, placeholder: "Search DO, customer, salesperson, phone…", scope: "server", totalRecords: filtered.length }}
            resetFilters={{ active: filtersActive, onReset: resetLayout, label: "Reset layout" }}
          />
        ) : (
          <CardsGrid rows={filtered} onOpen={goDetail} />
        )}
      </div>
    </PullToRefresh>
  );
}

export default UnbilledDeliveriesV2;
