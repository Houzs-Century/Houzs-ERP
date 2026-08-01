// ----------------------------------------------------------------------------
// FairReport — exhibition-performance report with three document-stage tabs
// (Sales Orders / Delivery Orders / Invoices), each anchored on the fair (the
// exhibition PROJECT hard-linked to every SO). Confirmed orders only.
//
// Wired to GET /scm/reports/fair-report (per-stage rows + KPI summary) and
// /scm/reports/fair-report/:docNo (the quick-view drawer). The server does all
// the fair-anchoring, the product/service revenue split, the deposit-by-tender
// math and the per-stage summaries — this page only renders + filters.
//
// PERMISSION mirrors the backend fairReportAccess exactly (auth/salesAccess):
//   * ordinary salespeople → no access (nav absent + FairReportGuard 403s)
//   * Sales Director        → SO tab only (DO + Invoice tabs are absent)
//   * management            → all three tabs
// The backend still 403s every refused stage; the FE never shows a tab whose
// query the backend would refuse (a Sales Director never even fires do/invoice).
//
// URL IS STATE: stage + the 7 filters + view mode + the open drawer all live in
// useSearchParams, so a Fair Report view is shareable/bookmarkable.
//
// English · MYR · DD/MM/YYYY · no emoji. Desktop back-office analytics — mobile
// is a separate follow-up (the approved mockup carries its own phone layout).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, Columns3, X, ChevronRight, LayoutList, Table2 } from 'lucide-react';
import { PageHeader } from '../../components/Layout';
import { StatCard } from '../../components/StatCard';
import { formatDate } from '../../lib/utils';
import { buildVariantSummary, orderLineIdentity } from '@2990s/shared';
import { useAuth } from '../../auth/AuthContext';
import { fairAllowedStages } from '../../auth/salesAccess';
import {
  useFairReport,
  useFairReportDetail,
  fairReportErrorInfo,
  type FairStage,
  type FairFilters,
  type FairDims,
  type FairSoRow,
  type FairDoRow,
  type FairInvoiceRow,
  type FairSoResponse,
  type FairDoResponse,
  type FairInvoiceResponse,
  type FairPnlRow,
  type FairPnlResponse,
  type FairCostByCategory,
} from '../../vendor/scm/lib/fair-report-queries';

// ── money / number formatting ────────────────────────────────────────────────
/** Table-cell money — no currency prefix, 2 decimals, zero/null → em dash so a
 *  wide grid reads cleanly (matches the approved mockup's "—" empties). */
const cell = (centi: number | null | undefined): string => {
  const v = Number(centi ?? 0);
  if (!v) return '—';
  return (v / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
/** KPI / drawer money — with the MYR prefix and always-shown 0.00. */
const rm = (centi: number | null | undefined): string =>
  `MYR ${(Number(centi ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (p: number | null | undefined): string => (p == null ? '—' : `${p.toFixed(1)}%`);
/** Signed points for a margin drift (DO vs SO). */
const pts = (a: number | null | undefined, b: number | null | undefined): string => {
  if (a == null || b == null) return '—';
  const d = a - b;
  return `${d > 0 ? '+' : ''}${d.toFixed(1)} pts`;
};
const signedMoney = (centi: number | null | undefined): string => {
  const v = Number(centi ?? 0);
  if (!v) return '—';
  return `${v > 0 ? '+' : '−'}${cell(Math.abs(v))}`;
};

// ── shared table cell classes (adapted from FulfillmentCosting tokens) ───────
const th = 'px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted whitespace-nowrap';
const thR = 'px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-brand text-ink-muted whitespace-nowrap';
const td = 'px-3 py-2.5 text-[12.5px] text-ink whitespace-nowrap';
const tdR = 'px-3 py-2.5 text-right text-[12.5px] text-ink tabular-nums whitespace-nowrap';
const mono = 'font-mono text-[12px] font-semibold';

const inputCls =
  'rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30';
const btnCls =
  'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-secondary transition-colors hover:border-primary/40';

const STAGE_LABELS: Record<FairStage, string> = { so: 'Sales Orders', do: 'Delivery Orders', invoice: 'Invoices', pnl: 'P&L' };

// Optional column groups per stage — the "Columns" control toggles these off.
const OPTIONAL_GROUPS: Record<FairStage, { key: string; label: string }[]> = {
  so: [
    { key: 'catcost', label: 'Cost by category' },
    { key: 'tender', label: 'Deposit by tender' },
  ],
  do: [{ key: 'drift', label: 'Margin drift' }],
  invoice: [{ key: 'progression', label: 'Cost progression (SO / DO)' }],
  pnl: [{ key: 'threeway', label: 'Three-way cost (SO / DO / SI)' }],
};

type OptionMaps = {
  venues: string[];
  projects: Record<string, string>;
  states: string[];
  brandings: string[];
  salespersons: Record<string, string>;
};
const EMPTY_OPTS: OptionMaps = { venues: [], projects: {}, states: [], brandings: [], salespersons: {} };

/** Merge the distinct filter values carried on a batch of rows into the running
 *  option set. Accumulated (never shrinks) so a dropdown stays usable after a
 *  filter narrows the result. Returns `prev` unchanged when nothing is new. */
function accumulate(prev: OptionMaps, rows: FairDims[]): OptionMaps {
  const venues = new Set(prev.venues);
  const projects = { ...prev.projects };
  const states = new Set(prev.states);
  const brandings = new Set(prev.brandings);
  const salespersons = { ...prev.salespersons };
  let changed = false;
  for (const r of rows) {
    // Venue keys on the TEXT (venue_id is a dead scm.venues FK, NULL on modern SOs).
    if (r.venue && !venues.has(r.venue)) { venues.add(r.venue); changed = true; }
    if (r.project_id != null && r.project) {
      const label = r.project_start_date
        ? `${r.project} · ${formatDate(r.project_start_date)}${r.project_end_date ? `–${formatDate(r.project_end_date)}` : ''}`
        : r.project;
      if (projects[String(r.project_id)] !== label) { projects[String(r.project_id)] = label; changed = true; }
    }
    if (r.state && !states.has(r.state)) { states.add(r.state); changed = true; }
    if (r.branding && !brandings.has(r.branding)) { brandings.add(r.branding); changed = true; }
    if (r.salesperson_id && r.salesperson && salespersons[r.salesperson_id] !== r.salesperson) { salespersons[r.salesperson_id] = r.salesperson; changed = true; }
  }
  if (!changed) return prev;
  return {
    projects, salespersons,
    venues: [...venues].sort((a, b) => a.localeCompare(b)),
    states: [...states].sort((a, b) => a.localeCompare(b)),
    brandings: [...brandings].sort((a, b) => a.localeCompare(b)),
  };
}

const catRows = (c: FairCostByCategory): [string, number][] => [
  ['Mattress / Sofa', c.mattress_sofa_cost_centi],
  ['Bedframe', c.bedframe_cost_centi],
  ['Accessories', c.accessories_cost_centi],
  ['Others', c.others_cost_centi],
  ['Service', c.service_cost_centi],
];

// ── CSV export ────────────────────────────────────────────────────────────────
function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}
function download(name: string, csv: string) {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export const FairReport = () => {
  const { user } = useAuth();
  const allowed = useMemo(() => fairAllowedStages(user), [user]);
  const [sp, setSp] = useSearchParams();

  // ── stage (clamped to what this user may see) ──────────────────────────────
  const rawStage = (sp.get('stage') as FairStage) || 'so';
  const stage: FairStage = allowed.includes(rawStage) ? rawStage : (allowed[0] ?? 'so');

  // ── filters from the URL ───────────────────────────────────────────────────
  const filters: FairFilters = useMemo(() => {
    const projectRaw = sp.get('project');
    const project = projectRaw && Number.isFinite(Number(projectRaw)) ? Number(projectRaw) : undefined;
    return {
      venue: sp.get('venue') || undefined,
      state: sp.get('state') || undefined,
      project,
      branding: sp.get('branding') || undefined,
      salesperson: sp.get('salesperson') || undefined,
      month: sp.get('month') || undefined,
      dateFrom: sp.get('date_from') || undefined,
      dateTo: sp.get('date_to') || undefined,
    };
  }, [sp]);

  const view = sp.get('view') === 'cards' ? 'cards' : 'table';
  const hidden = useMemo(() => new Set((sp.get('hide') || '').split(',').filter(Boolean)), [sp]);
  const selectedSo = sp.get('so');

  // setter that preserves the rest of the query string (repo idiom: build a
  // fresh URLSearchParams from the current one and hand it back whole).
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(sp);
    if (value == null || value === '') next.delete(key);
    else next.set(key, value);
    setSp(next);
  };

  const q = useFairReport(stage, filters, allowed.includes(stage));
  const data = q.data;
  // A 403 (not in the report's cohort) must not read as a transient "please
  // retry" — distinguish the permission denial from a load failure.
  const errorInfo = q.isError ? fairReportErrorInfo(q.error) : null;

  // ── accumulate filter options from whatever rows we've loaded ───────────────
  const [opts, setOpts] = useState<OptionMaps>(EMPTY_OPTS);
  useEffect(() => {
    if (!data?.rows?.length) return;
    setOpts((prev) => accumulate(prev, data.rows as FairDims[]));
  }, [data]);

  // Close the Columns popover on an outside click.
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colsOpen]);

  const toggleGroup = (key: string) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key); else next.add(key);
    setParam('hide', [...next].join(','));
  };

  const anyFilter = Object.values(filters).some((v) => v != null && v !== '');
  const clearFilters = () => {
    const next = new URLSearchParams(sp);
    for (const k of ['venue', 'state', 'project', 'branding', 'salesperson', 'month', 'date_from', 'date_to']) next.delete(k);
    setSp(next);
  };

  const activeCount = data?.rows?.length ?? 0;

  const handleExport = () => {
    if (!data) return;
    const { headers, body, name } = buildExport(data);
    download(name, toCsv(headers, body));
  };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Reports"
        title="Sales Report"
        description="Exhibition sales by document stage — Sales Order, Delivery Order, Invoice. Confirmed orders only."
        primaryAction={
          <div className="flex items-center gap-2">
            <button type="button" className={btnCls} onClick={handleExport} disabled={!activeCount}>
              <Download size={14} /> Export
            </button>
            <div className="relative" ref={colsRef}>
              <button type="button" className={btnCls} onClick={() => setColsOpen((o) => !o)}>
                <Columns3 size={14} /> Columns
              </button>
              {colsOpen && (
                <div className="absolute right-0 z-30 mt-1 w-60 rounded-md border border-border bg-surface p-2 shadow-slab">
                  <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                    Show column groups
                  </div>
                  {OPTIONAL_GROUPS[stage].map((g) => (
                    <label key={g.key} className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink hover:bg-primary-soft/40">
                      <input type="checkbox" checked={!hidden.has(g.key)} onChange={() => toggleGroup(g.key)} />
                      {g.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        }
      />

      {/* ── Stage tabs ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface-2 p-1" role="tablist">
        {allowed.map((s) => {
          const on = s === stage;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setParam('stage', s)}
              className={
                'inline-flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition-colors ' +
                (on ? 'bg-surface text-ink shadow-stone' : 'text-ink-muted hover:text-ink')
              }
            >
              {STAGE_LABELS[s]}
              {on && (
                <span className="rounded-full bg-primary-soft px-1.5 text-[11px] font-bold text-primary">{activeCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── KPI cards (per stage) ───────────────────────────────────────────── */}
      <KpiRow data={data} rows={data?.rows} />

      {/* ── Toolbar: Table / Cards ──────────────────────────────────────────── */}
      <div className="flex items-center justify-end">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {(['table', 'cards'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-selected={view === v}
              onClick={() => setParam('view', v === 'table' ? null : v)}
              className={
                'inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium ' +
                (view === v ? 'bg-surface-2 text-ink' : 'bg-surface text-ink-muted hover:text-ink')
              }
            >
              {v === 'table' ? <Table2 size={13} /> : <LayoutList size={13} />} {v === 'table' ? 'Table' : 'Cards'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-surface p-3 shadow-stone">
        <div className="flex flex-wrap items-end gap-3">
          <SelectFilter label="Venue" value={filters.venue ?? ''} onChange={(v) => setParam('venue', v)}
            options={opts.venues.map((v) => ({ value: v, label: v }))} allLabel="All venues" />
          <SelectFilter label="State" value={filters.state ?? ''} onChange={(v) => setParam('state', v)}
            options={opts.states.map((s) => ({ value: s, label: s }))} allLabel="All states" />
          <SelectFilter label="Project / Fair" value={filters.project != null ? String(filters.project) : ''} onChange={(v) => setParam('project', v)}
            options={Object.entries(opts.projects).map(([id, label]) => ({ value: id, label }))} allLabel="All projects" />
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Month</span>
            <input type="month" className={inputCls} value={filters.month ?? ''} onChange={(e) => setParam('month', e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Date from</span>
            <input type="date" className={inputCls} value={filters.dateFrom ?? ''} onChange={(e) => setParam('date_from', e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">Date to</span>
            <input type="date" className={inputCls} value={filters.dateTo ?? ''} onChange={(e) => setParam('date_to', e.target.value)} />
          </label>
          <SelectFilter label="Branding" value={filters.branding ?? ''} onChange={(v) => setParam('branding', v)}
            options={opts.brandings.map((b) => ({ value: b, label: b }))} allLabel="All brands" />
          <SelectFilter label="Salesperson" value={filters.salesperson ?? ''} onChange={(v) => setParam('salesperson', v)}
            options={Object.entries(opts.salespersons).map(([id, label]) => ({ value: id, label }))} allLabel="All salespersons" />
          {anyFilter && (
            <button type="button" className={`${btnCls} mb-[1px]`} onClick={clearFilters}>Clear filters</button>
          )}
        </div>
      </div>

      {errorInfo && (
        <div className="rounded-lg border border-err/40 bg-err/5 px-3 py-2 text-[13px] text-err">
          {errorInfo.message}
        </div>
      )}

      {/* ── The stage panel ─────────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[13px] font-semibold text-ink">
          <span>{STAGE_LABELS[stage]} — {q.isLoading ? 'loading…' : `${activeCount} row${activeCount === 1 ? '' : 's'}`}</span>
        </div>
        {view === 'table' ? (
          <StageTable data={data} stage={stage} hidden={hidden} loading={q.isLoading} onOpen={(so) => setParam('so', so)} />
        ) : (
          <StageCards data={data} stage={stage} loading={q.isLoading} onOpen={(so) => setParam('so', so)} />
        )}
      </div>

      {stage === 'pnl' ? (
        <p className="text-[11px] text-ink-muted">
          P&amp;L per fair: revenue (confirmed SO) − COGS (the most-progressed of the SO / DO / SI cost per order) − overhead (the project cost-rate card: transport + merchandise + commission on revenue) = net profit. Rental / set-up and other manual project-ledger lines are not folded in yet. Initial cut — final layout to be confirmed.
        </p>
      ) : (
        <p className="text-[11px] text-ink-muted">
          SO No = system doc number · Order Form = handwritten reference · Amount = product + service · Selling = product SKU revenue only.
          The P&amp;L tab nets revenue against the three-way fulfillment cost and the project cost-rate overhead per fair.
        </p>
      )}

      {/* ── Quick-view drawer ───────────────────────────────────────────────── */}
      <FairDrawer docNo={selectedSo} onClose={() => setParam('so', null)} />
    </div>
  );
};

// ── select filter ────────────────────────────────────────────────────────────
function SelectFilter({ label, value, onChange, options, allLabel }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; allLabel: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</span>
      <select className={`${inputCls} min-w-[150px]`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

// ── KPI row ───────────────────────────────────────────────────────────────────
function KpiRow({ data, rows }: { data: FairReportData; rows: FairReportRows }) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <StatCard key={i} label="—" value="—" />)}
      </div>
    );
  }
  if (data.stage === 'so') {
    const s = data.summary;
    const paid = ((rows as FairSoRow[]) ?? []).reduce((a, r) => a + Number(r.paid_total_centi ?? 0), 0);
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard rail="bg-primary" label="Total Orders" value={s.orders.toLocaleString('en-MY')} subtitle="Confirmed, matching filter" />
        <StatCard rail="bg-accent-bright" label="Revenue" value={rm(s.total_amount_centi)} subtitle={`${pct(s.margin_pct)} margin`} />
        <StatCard rail="bg-err" label="Outstanding" value={rm(s.total_balance_centi)} tone="error" subtitle={`${s.below_deposit_count} below deposit`} />
        <StatCard rail="bg-synced" label="Paid" value={rm(paid)} tone="success" subtitle="Deposits collected" />
      </div>
    );
  }
  if (data.stage === 'do') {
    const s = data.summary;
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard rail="bg-primary" label="Delivered Orders" value={s.deliveries.toLocaleString('en-MY')} subtitle="DOs in this filter" />
        <StatCard rail="bg-accent-bright" label="SO-time Cost" value={rm(s.total_so_cost_centi)} subtitle="Cost estimated at order" />
        <StatCard rail="bg-err" label="DO Cost (ship-time)" value={rm(s.total_do_cost_centi)} subtitle="Frozen FIFO at delivery" />
        <StatCard rail="bg-synced" label="Cost Drift" value={signedMoney(s.cost_delta_centi)}
          tone={s.cost_delta_centi > 0 ? 'error' : s.cost_delta_centi < 0 ? 'success' : 'default'}
          subtitle={s.legacy_count ? `${s.legacy_count} legacy (pre-FIFO)` : 'Delivery delay impact'} />
      </div>
    );
  }
  if (data.stage === 'pnl') {
    const p = data.summary;
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard rail="bg-primary" label="Fair Revenue" value={rm(p.total_revenue_centi)} subtitle={`${p.orders} confirmed orders`} />
        <StatCard rail="bg-accent-bright" label="Gross Profit" value={rm(p.gross_profit_centi)} subtitle={`${pct(p.gross_margin_pct)} · COGS ${rm(p.total_cogs_centi)}`} />
        <StatCard rail="bg-err" label="Overhead" value={rm(p.overheads.total_overhead_centi)} subtitle={`Transport + merchandise + commission${p.overheads.commission_is_boost ? ' · boost' : ''}`} />
        <StatCard rail="bg-synced" label="Net Profit" value={rm(p.net_profit_centi)} tone={p.net_profit_centi >= 0 ? 'success' : 'error'} subtitle={`${pct(p.net_margin_pct)} net margin`} />
      </div>
    );
  }
  const s = data.summary;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard rail="bg-primary" label="Invoices" value={s.invoices.toLocaleString('en-MY')} subtitle="SIs in this filter" />
      <StatCard rail="bg-accent-bright" label="Invoiced Amount" value={rm(s.total_invoiced_centi)} subtitle="Billed to date" />
      <StatCard rail="bg-err" label="Landed (SI) Cost" value={rm(s.total_si_cost_centi)} subtitle="Store-card after PI lands" />
      <StatCard rail="bg-synced" label="Invoiced Margin" value={pct(s.margin_pct)} tone="success" subtitle="Invoiced − landed" />
    </div>
  );
}

// ── table ─────────────────────────────────────────────────────────────────────
function StageTable({ data, stage, hidden, loading, onOpen }: {
  data: FairReportData; stage: FairStage; hidden: Set<string>; loading: boolean; onOpen: (so: string) => void;
}) {
  const empty = (cols: number) => (
    <tr><td className={`${td} text-ink-muted`} colSpan={cols}>{loading ? 'Loading…' : 'No records match the current filters.'}</td></tr>
  );

  if (stage === 'so') {
    const rows = (data?.stage === 'so' ? data.rows : []) as FairSoRow[];
    const showCat = !hidden.has('catcost');
    const showTender = !hidden.has('tender');
    const cols = 7 + 3 + (showCat ? 5 : 0) + 3 + (showTender ? 4 : 0) + 2;
    const sum = data?.stage === 'so' ? data.summary : null;
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="bg-primary-soft/30">
            <tr>
              <th className={th}>Date</th><th className={th}>Venue</th><th className={th}>Project / Fair</th>
              <th className={th}>SO No</th><th className={th}>Order Form</th><th className={th}>Salesperson</th><th className={th}>Branding</th>
              <th className={thR}>Amount</th><th className={thR}>Selling</th><th className={thR}>Service Rev.</th>
              {showCat && <><th className={thR}>Mattress / Sofa</th><th className={thR}>Bedframe</th><th className={thR}>Accessories</th><th className={thR}>Others</th><th className={thR}>Service</th></>}
              <th className={thR}>Total SO Cost</th><th className={thR}>Margin %</th><th className={thR}>Balance</th>
              <th className={th}>Payment</th>
              {showTender && <><th className={thR}>Cash</th><th className={thR}>Merchant</th><th className={thR}>Installment</th><th className={thR}>Online</th></>}
              <th className={thR}>Pending</th><th className={thR} aria-label="open" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.so_no} className="cursor-pointer border-t border-border/60 even:bg-surface-2 hover:bg-primary-soft/20" onClick={() => onOpen(r.so_no)}>
                <td className={`${td} tabular-nums`}>{formatDate(r.so_date)}</td>
                <td className={td}>{r.venue ?? '—'}</td>
                <td className={td}>{r.project ?? '—'}</td>
                <td className={td}><span className={`${mono} text-primary-ink`}>{r.so_no}</span></td>
                <td className={td}><span className={`${mono} text-ink-secondary`}>{r.order_form ?? '—'}</span></td>
                <td className={td}>{r.salesperson ?? '—'}</td>
                <td className={td}>{r.branding ?? '—'}</td>
                <td className={tdR}>{cell(r.amount_centi)}</td>
                <td className={tdR}>{cell(r.selling_centi)}</td>
                <td className={tdR}>{cell(r.service_rev_centi)}</td>
                {showCat && <>
                  <td className={`${tdR} bg-surface-2`}>{cell(r.cost_by_category.mattress_sofa_cost_centi)}</td>
                  <td className={`${tdR} bg-surface-2`}>{cell(r.cost_by_category.bedframe_cost_centi)}</td>
                  <td className={`${tdR} bg-surface-2`}>{cell(r.cost_by_category.accessories_cost_centi)}</td>
                  <td className={`${tdR} bg-surface-2`}>{cell(r.cost_by_category.others_cost_centi)}</td>
                  <td className={`${tdR} bg-surface-2`}>{cell(r.cost_by_category.service_cost_centi)}</td>
                </>}
                <td className={`${tdR} font-semibold`}>{cell(r.total_so_cost_centi)}</td>
                <td className={`${tdR} ${(r.margin_pct ?? 0) >= 0 ? 'text-synced' : 'text-err'} font-medium`}>{pct(r.margin_pct)}</td>
                <td className={tdR}>{cell(r.balance_centi)}</td>
                <td className={td}><span className="text-[11.5px] text-ink-secondary">{r.payment_methods.join(' + ') || '—'}</span></td>
                {showTender && <>
                  <td className={`${tdR} bg-primary-soft/15`}>{cell(r.deposit_by_tender.Cash)}</td>
                  <td className={`${tdR} bg-primary-soft/15`}>{cell(r.deposit_by_tender.Merchant)}</td>
                  <td className={`${tdR} bg-primary-soft/15`}>{cell(r.deposit_by_tender.Installment)}</td>
                  <td className={`${tdR} bg-primary-soft/15`}>{cell(r.deposit_by_tender.Online)}</td>
                </>}
                <td className={tdR}>{r.below_deposit ? <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-brand text-primary">Yes</span> : '—'}</td>
                <td className={tdR}><ChevronRight size={15} className="text-ink-muted" /></td>
              </tr>
            ))}
            {rows.length === 0 && empty(cols)}
          </tbody>
          {sum && rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border bg-surface-2 font-semibold">
                <td className={`${td} uppercase text-[10px] tracking-brand text-ink-muted`} colSpan={7}>Filtered totals · {sum.orders} orders</td>
                <td className={tdR}>{cell(sum.total_amount_centi)}</td>
                <td className={tdR}>{cell(sum.total_selling_centi)}</td>
                <td className={tdR}>{cell(sum.total_service_rev_centi)}</td>
                {showCat && <><td className={tdR} colSpan={5} /></>}
                <td className={tdR}>{cell(sum.total_so_cost_centi)}</td>
                <td className={`${tdR} ${(sum.margin_pct ?? 0) >= 0 ? 'text-synced' : 'text-err'}`}>{pct(sum.margin_pct)}</td>
                <td className={tdR}>{cell(sum.total_balance_centi)}</td>
                <td className={td} />
                {showTender && <>
                  <td className={tdR}>{cell(sum.tender_totals.Cash)}</td>
                  <td className={tdR}>{cell(sum.tender_totals.Merchant)}</td>
                  <td className={tdR}>{cell(sum.tender_totals.Installment)}</td>
                  <td className={tdR}>{cell(sum.tender_totals.Online)}</td>
                </>}
                <td className={tdR}>{sum.below_deposit_count || '—'}</td>
                <td className={tdR} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    );
  }

  if (stage === 'do') {
    const rows = (data?.stage === 'do' ? data.rows : []) as FairDoRow[];
    const showDrift = !hidden.has('drift');
    const sum = data?.stage === 'do' ? data.summary : null;
    const cols = 7 + 5 + (showDrift ? 1 : 0) + 1;
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="bg-primary-soft/30">
            <tr>
              <th className={th}>Delivery Date</th><th className={th}>Venue</th><th className={th}>Project / Fair</th><th className={th}>Branding</th>
              <th className={th}>DO No</th><th className={th}>Linked SO</th><th className={thR}>Qty</th><th className={thR}>SO Amount</th>
              <th className={thR}>Total SO Cost</th><th className={thR}>Total DO Cost</th><th className={thR}>Cost Δ</th><th className={thR}>DO Margin %</th>
              {showDrift && <th className={thR}>Margin drift</th>}
              <th className={thR} aria-label="open" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.do_no} className="cursor-pointer border-t border-border/60 even:bg-surface-2 hover:bg-primary-soft/20" onClick={() => r.so_no && onOpen(r.so_no)}>
                <td className={`${td} tabular-nums`}>{formatDate(r.delivery_date)}</td>
                <td className={td}>{r.venue ?? '—'}</td>
                <td className={td}>{r.project ?? '—'}</td>
                <td className={td}>{r.branding ?? '—'}</td>
                <td className={td}><span className={`${mono} text-primary-ink`}>{r.do_no}</span>{r.do_cost_is_legacy && <span className="ml-1 rounded bg-ink-muted/15 px-1 py-0.5 text-[9px] font-semibold uppercase text-ink-muted">Legacy</span>}</td>
                <td className={td}><span className={`${mono} text-ink-secondary`}>{r.so_no ?? '—'}</span></td>
                <td className={tdR}>{r.qty}</td>
                <td className={tdR}>{cell(r.so_amount_centi)}</td>
                <td className={tdR}>{cell(r.total_so_cost_centi)}</td>
                <td className={`${tdR} font-semibold`}>{cell(r.total_do_cost_centi)}</td>
                <td className={`${tdR} ${r.cost_delta_centi > 0 ? 'text-err' : r.cost_delta_centi < 0 ? 'text-synced' : ''} font-medium`}>{signedMoney(r.cost_delta_centi)}</td>
                <td className={tdR}>{pct(r.do_margin_pct)}</td>
                {showDrift && <td className={`${tdR} ${(r.do_margin_pct ?? 0) < (r.so_margin_pct ?? 0) ? 'text-err' : 'text-synced'} font-medium`}>{pts(r.do_margin_pct, r.so_margin_pct)}</td>}
                <td className={tdR}><ChevronRight size={15} className="text-ink-muted" /></td>
              </tr>
            ))}
            {rows.length === 0 && empty(cols)}
          </tbody>
          {sum && rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border bg-surface-2 font-semibold">
                <td className={`${td} uppercase text-[10px] tracking-brand text-ink-muted`} colSpan={6}>Delivered · {sum.deliveries} orders</td>
                <td className={tdR} />
                <td className={tdR} />
                <td className={tdR}>{cell(sum.total_so_cost_centi)}</td>
                <td className={tdR}>{cell(sum.total_do_cost_centi)}</td>
                <td className={`${tdR} ${sum.cost_delta_centi > 0 ? 'text-err' : sum.cost_delta_centi < 0 ? 'text-synced' : ''}`}>{signedMoney(sum.cost_delta_centi)}</td>
                <td className={tdR} />
                {showDrift && <td className={tdR} />}
                <td className={tdR} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    );
  }

  if (stage === 'pnl') {
    const pnl = data?.stage === 'pnl' ? data : null;
    if (pnl?.meta.needs_project) {
      return (
        <div className="px-3 py-10 text-center text-[13px] text-ink-muted">
          Select a fair in the <b className="text-ink">Project / Fair</b> filter above to see its P&amp;L — the P&amp;L is computed per exhibition.
        </div>
      );
    }
    const rows = (pnl?.rows ?? []) as FairPnlRow[];
    const sum = pnl?.summary ?? null;
    const showThree = !hidden.has('threeway');
    const cols = 5 + 1 + (showThree ? 3 : 0) + 3;
    return (
      <div className="overflow-x-auto">
        {pnl && !pnl.meta.rate_present && (
          <div className="border-b border-border bg-surface-2 px-3 py-2 text-[11.5px] text-ink-muted">
            No cost-rate card for this fair's brand{pnl.meta.brand ? ` (${pnl.meta.brand})` : ''} — overhead shows as zero, so net profit equals gross profit until a rate card is set.
          </div>
        )}
        <table className="w-full border-collapse">
          <thead className="bg-primary-soft/30">
            <tr>
              <th className={th}>Date</th><th className={th}>Venue</th><th className={th}>SO No</th><th className={th}>Salesperson</th><th className={th}>Branding</th>
              <th className={thR}>Revenue</th>
              {showThree && <><th className={thR}>SO Cost</th><th className={thR}>DO Cost</th><th className={thR}>SI Cost</th></>}
              <th className={thR}>COGS</th><th className={thR}>Gross Profit</th><th className={thR}>Margin %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.so_no} className="cursor-pointer border-t border-border/60 even:bg-surface-2 hover:bg-primary-soft/20" onClick={() => onOpen(r.so_no)}>
                <td className={`${td} tabular-nums`}>{formatDate(r.so_date)}</td>
                <td className={td}>{r.venue ?? '—'}</td>
                <td className={td}><span className={`${mono} text-primary-ink`}>{r.so_no}</span></td>
                <td className={td}>{r.salesperson ?? '—'}</td>
                <td className={td}>{r.branding ?? '—'}</td>
                <td className={tdR}>{cell(r.revenue_centi)}</td>
                {showThree && <>
                  <td className={`${tdR} bg-surface-2`}>{cell(r.so_cost_centi)}</td>
                  <td className={`${tdR} bg-surface-2`}>{r.do_cost_centi == null ? '—' : cell(r.do_cost_centi)}</td>
                  <td className={`${tdR} bg-surface-2`}>{r.si_cost_centi == null ? '—' : cell(r.si_cost_centi)}</td>
                </>}
                <td className={`${tdR} font-semibold`}>{cell(r.effective_cost_centi)}<span className="ml-1 rounded bg-ink-muted/15 px-1 py-0.5 text-[9px] font-semibold uppercase text-ink-muted">{r.effective_cost_stage}</span></td>
                <td className={`${tdR} ${r.gross_profit_centi >= 0 ? 'text-synced' : 'text-err'} font-medium`}>{cell(r.gross_profit_centi)}</td>
                <td className={`${tdR} ${(r.margin_pct ?? 0) >= 0 ? 'text-synced' : 'text-err'} font-medium`}>{pct(r.margin_pct)}</td>
              </tr>
            ))}
            {rows.length === 0 && empty(cols)}
          </tbody>
          {sum && rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border bg-surface-2 font-semibold">
                <td className={`${td} uppercase text-[10px] tracking-brand text-ink-muted`} colSpan={5}>Fair totals · {sum.orders} orders</td>
                <td className={tdR}>{cell(sum.total_revenue_centi)}</td>
                {showThree && <><td className={tdR}>{cell(sum.total_so_cost_centi)}</td><td className={tdR}>{cell(sum.total_do_cost_centi)}</td><td className={tdR}>{cell(sum.total_si_cost_centi)}</td></>}
                <td className={tdR}>{cell(sum.total_cogs_centi)}</td>
                <td className={`${tdR} ${sum.gross_profit_centi >= 0 ? 'text-synced' : 'text-err'}`}>{cell(sum.gross_profit_centi)}</td>
                <td className={`${tdR} ${(sum.gross_margin_pct ?? 0) >= 0 ? 'text-synced' : 'text-err'}`}>{pct(sum.gross_margin_pct)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    );
  }

  // invoice
  const rows = (data?.stage === 'invoice' ? data.rows : []) as FairInvoiceRow[];
  const showProg = !hidden.has('progression');
  const sum = data?.stage === 'invoice' ? data.summary : null;
  const cols = 6 + 1 + (showProg ? 2 : 0) + 1 + 1 + 1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="bg-primary-soft/30">
          <tr>
            <th className={th}>Invoice Date</th><th className={th}>Venue</th><th className={th}>Project / Fair</th><th className={th}>Branding</th>
            <th className={th}>Invoice No</th><th className={th}>Linked SO</th><th className={thR}>Invoiced</th>
            {showProg && <><th className={thR}>SO Cost</th><th className={thR}>DO Cost</th></>}
            <th className={thR}>Landed (SI) Cost</th><th className={thR}>Margin %</th>
            <th className={thR} aria-label="open" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.inv_no} className="cursor-pointer border-t border-border/60 even:bg-surface-2 hover:bg-primary-soft/20" onClick={() => r.so_no && onOpen(r.so_no)}>
              <td className={`${td} tabular-nums`}>{formatDate(r.invoice_date)}</td>
              <td className={td}>{r.venue ?? '—'}</td>
              <td className={td}>{r.project ?? '—'}</td>
              <td className={td}>{r.branding ?? '—'}</td>
              <td className={td}><span className={`${mono} text-primary-ink`}>{r.inv_no}</span></td>
              <td className={td}><span className={`${mono} text-ink-secondary`}>{r.so_no ?? '—'}</span></td>
              <td className={tdR}>{cell(r.invoiced_centi)}</td>
              {showProg && <><td className={tdR}>{cell(r.so_cost_centi)}</td><td className={tdR}>{cell(r.do_cost_centi)}</td></>}
              <td className={`${tdR} font-semibold`}>{cell(r.si_cost_centi)}</td>
              <td className={`${tdR} ${(r.margin_pct ?? 0) >= 0 ? 'text-synced' : 'text-err'} font-medium`}>{pct(r.margin_pct)}</td>
              <td className={tdR}><ChevronRight size={15} className="text-ink-muted" /></td>
            </tr>
          ))}
          {rows.length === 0 && empty(cols)}
        </tbody>
        {sum && rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border bg-surface-2 font-semibold">
              <td className={`${td} uppercase text-[10px] tracking-brand text-ink-muted`} colSpan={6}>Invoiced · {sum.invoices} orders</td>
              <td className={tdR}>{cell(sum.total_invoiced_centi)}</td>
              {showProg && <><td className={tdR}>{cell(sum.total_so_cost_centi)}</td><td className={tdR}>{cell(sum.total_do_cost_centi)}</td></>}
              <td className={tdR}>{cell(sum.total_si_cost_centi)}</td>
              <td className={`${tdR} ${(sum.margin_pct ?? 0) >= 0 ? 'text-synced' : 'text-err'}`}>{pct(sum.margin_pct)}</td>
              <td className={tdR} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ── cards view ────────────────────────────────────────────────────────────────
function StageCards({ data, stage, loading, onOpen }: {
  data: FairReportData; stage: FairStage; loading: boolean; onOpen: (so: string) => void;
}) {
  const wrap = 'grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3';
  const stat = (k: string, v: string) => (
    <div><div className="text-[8.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</div><div className="mt-0.5 text-[13px] font-semibold tabular-nums text-ink">{v}</div></div>
  );
  const card = 'cursor-pointer rounded-xl border border-border bg-surface p-3.5 shadow-stone transition-colors hover:border-primary/40';

  if (!data || data.rows.length === 0) {
    return <div className="px-3 py-6 text-[13px] text-ink-muted">{loading ? 'Loading…' : 'No records match the current filters.'}</div>;
  }
  if (stage === 'so') {
    const rows = data.stage === 'so' ? data.rows : [];
    return (
      <div className={wrap}>
        {rows.map((r) => (
          <div key={r.so_no} className={card} onClick={() => onOpen(r.so_no)}>
            <div className="flex items-center gap-2">
              {r.branding && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-accent">{r.branding}</span>}
              <span className={`${mono} text-primary-ink`}>{r.so_no}</span>
              <span className={`ml-auto text-[13px] font-bold tabular-nums ${(r.margin_pct ?? 0) >= 0 ? 'text-synced' : 'text-err'}`}>{pct(r.margin_pct)}</span>
            </div>
            <div className="mt-1.5 text-[12px] text-ink-secondary">{r.venue ?? '—'} · <span className="tabular-nums">{formatDate(r.so_date)}</span> · {r.salesperson ?? '—'}</div>
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
              {stat('Amount', cell(r.amount_centi))}{stat('Selling', cell(r.selling_centi))}{stat('SO Cost', cell(r.total_so_cost_centi))}
            </div>
            <div className="mt-3 flex items-center gap-2 text-[11.5px]">
              <span className="text-ink-secondary">Balance <b className="tabular-nums">{rm(r.balance_centi)}</b></span>
              {r.below_deposit && <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-primary">Below deposit</span>}
              <span className="ml-auto inline-flex items-center gap-0.5 font-medium text-primary">Open <ChevronRight size={13} /></span>
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (stage === 'do') {
    const rows = data.stage === 'do' ? data.rows : [];
    return (
      <div className={wrap}>
        {rows.map((r) => (
          <div key={r.do_no} className={card} onClick={() => r.so_no && onOpen(r.so_no)}>
            <div className="flex items-center gap-2">
              {r.branding && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-accent">{r.branding}</span>}
              <span className={`${mono} text-primary-ink`}>{r.do_no}</span>
              <span className="ml-auto text-[13px] font-bold tabular-nums text-ink">{pct(r.do_margin_pct)}</span>
            </div>
            <div className="mt-1.5 text-[12px] text-ink-secondary">{r.venue ?? '—'} · <span className="tabular-nums">{formatDate(r.delivery_date)}</span> · SO {r.so_no ?? '—'}</div>
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
              {stat('SO Cost', cell(r.total_so_cost_centi))}{stat('DO Cost', cell(r.total_do_cost_centi))}{stat('Cost Δ', signedMoney(r.cost_delta_centi))}
            </div>
            <div className="mt-3 flex items-center text-[11.5px]"><span className="ml-auto inline-flex items-center gap-0.5 font-medium text-primary">Open <ChevronRight size={13} /></span></div>
          </div>
        ))}
      </div>
    );
  }
  if (stage === 'pnl') {
    if (data.stage === 'pnl' && data.meta.needs_project) {
      return <div className="px-3 py-6 text-[13px] text-ink-muted">Select a fair in the Project / Fair filter to see its P&amp;L.</div>;
    }
    const rows = data.stage === 'pnl' ? data.rows : [];
    return (
      <div className={wrap}>
        {rows.map((r) => (
          <div key={r.so_no} className={card} onClick={() => onOpen(r.so_no)}>
            <div className="flex items-center gap-2">
              {r.branding && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-accent">{r.branding}</span>}
              <span className={`${mono} text-primary-ink`}>{r.so_no}</span>
              <span className={`ml-auto text-[13px] font-bold tabular-nums ${(r.margin_pct ?? 0) >= 0 ? 'text-synced' : 'text-err'}`}>{pct(r.margin_pct)}</span>
            </div>
            <div className="mt-1.5 text-[12px] text-ink-secondary">{r.venue ?? '—'} · <span className="tabular-nums">{formatDate(r.so_date)}</span> · {r.salesperson ?? '—'}</div>
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
              {stat('Revenue', cell(r.revenue_centi))}{stat(`COGS (${r.effective_cost_stage})`, cell(r.effective_cost_centi))}{stat('Gross', cell(r.gross_profit_centi))}
            </div>
            <div className="mt-3 flex items-center text-[11.5px]"><span className="ml-auto inline-flex items-center gap-0.5 font-medium text-primary">Open <ChevronRight size={13} /></span></div>
          </div>
        ))}
      </div>
    );
  }
  const rows = data.stage === 'invoice' ? data.rows : [];
  return (
    <div className={wrap}>
      {rows.map((r) => (
        <div key={r.inv_no} className={card} onClick={() => r.so_no && onOpen(r.so_no)}>
          <div className="flex items-center gap-2">
            {r.branding && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-accent">{r.branding}</span>}
            <span className={`${mono} text-primary-ink`}>{r.inv_no}</span>
            <span className={`ml-auto text-[13px] font-bold tabular-nums ${(r.margin_pct ?? 0) >= 0 ? 'text-synced' : 'text-err'}`}>{pct(r.margin_pct)}</span>
          </div>
          <div className="mt-1.5 text-[12px] text-ink-secondary">{r.venue ?? '—'} · <span className="tabular-nums">{formatDate(r.invoice_date)}</span> · SO {r.so_no ?? '—'}</div>
          <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border/60 pt-3">
            {stat('Invoiced', cell(r.invoiced_centi))}{stat('SO Cost', cell(r.so_cost_centi))}{stat('Landed', cell(r.si_cost_centi))}
          </div>
          <div className="mt-3 flex items-center text-[11.5px]"><span className="ml-auto inline-flex items-center gap-0.5 font-medium text-primary">Open <ChevronRight size={13} /></span></div>
        </div>
      ))}
    </div>
  );
}

// ── quick-view drawer ─────────────────────────────────────────────────────────
function FairDrawer({ docNo, onClose }: { docNo: string | null; onClose: () => void }) {
  const q = useFairReportDetail(docNo);
  const d = q.data;

  useEffect(() => {
    if (!docNo) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [docNo, onClose]);

  const merchantLine = (p: { merchant_provider: string | null; installment_months: number | null }): string => {
    const parts: string[] = [];
    if (p.merchant_provider) parts.push(p.merchant_provider);
    if (p.installment_months) parts.push(`${p.installment_months}-mo plan`);
    return parts.join(' · ') || '—';
  };

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-ink/30 transition-opacity duration-200 ${docNo ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Order quick view"
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-[520px] flex-col border-l border-border bg-surface shadow-slab transition-transform duration-200 ${docNo ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex h-14 shrink-0 items-center gap-3 bg-sidebar px-4 text-sidebar-ink">
          <button onClick={onClose} className="text-sidebar-ink-muted hover:text-sidebar-ink" aria-label="Close"><X size={18} /></button>
          <div className="min-w-0">
            <div className={`${mono} text-[14px]`}>{d?.so_no ?? docNo ?? ''}</div>
            <div className="text-[10.5px] text-sidebar-ink-muted">Sales Order · Confirmed</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {q.isLoading && <div className="text-[13px] text-ink-muted">Loading…</div>}
          {q.isError && <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-[13px] text-err">Could not load this order.</div>}
          {d && (
            <>
              <div className="flex items-center gap-2">
                {d.branding && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-accent">{d.branding}</span>}
                <span className="text-[12px] text-ink-muted">
                  Ordered {formatDate(d.so_date)}{d.venue ? ` · ${d.venue}` : ''}
                </span>
              </div>

              {/* meta grid */}
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-3.5">
                <Meta k="SO No" v={<span className={mono}>{d.so_no}</span>} />
                <Meta k="Order Form" v={<span className={mono}>{d.order_form ?? '—'}</span>} />
                <Meta k="Salesperson" v={d.salesperson ?? '—'} />
                <Meta k="Project / Fair" v={d.project ?? '—'} />
                <Meta k="State" v={d.state ?? '—'} />
                <Meta k="Payment" v={d.payment_methods.join(' + ') || '—'} />
              </dl>

              {/* linkage chain */}
              <SectionH>Document linkage · SO → DO → Invoice</SectionH>
              <div className="flex flex-wrap items-stretch gap-1.5">
                <ChainLink label="Sales Order" nos={[d.linkage.so_no]} sub={`Confirmed ${formatDate(d.so_date)}`} done />
                <ChainArrow />
                <ChainLink label="Delivery Order" nos={d.linkage.do_nos} sub={d.linkage.do_nos.length ? 'Delivered' : 'Not yet delivered'} done={!!d.linkage.do_nos.length} />
                <ChainArrow />
                <ChainLink label="Invoice" nos={d.linkage.invoice_nos} sub={d.linkage.invoice_nos.length ? 'Invoiced' : 'Not invoiced'} done={!!d.linkage.invoice_nos.length} />
              </div>

              {/* order lines */}
              <SectionH>Order lines · selling &amp; cost</SectionH>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead><tr>
                    <th className={th}>Item</th><th className={thR}>Qty</th><th className={thR}>Unit sell</th><th className={thR}>Amount</th><th className={thR}>Unit cost</th><th className={thR}>Line cost</th>
                  </tr></thead>
                  <tbody>
                    {d.lines.map((l, i) => {
                      /* Item CODE + variant, exactly like every other order-line
                         surface (owner 2026-07-24, shared order-line rule). Was
                         "code · description" — which printed the code twice when
                         the description already contained it ("XAMMAR-1A(LHF) ·
                         SOFA XAMMAR 1A(LHF)") and dropped the variant entirely.
                         orderLineIdentity leads with the code and keeps the
                         variant summary (supplier code folded in) as the
                         subtitle; the description is dropped. */
                      const { primary, secondary } = orderLineIdentity({
                        code: l.item_code,
                        description: l.description,
                        variant:
                          buildVariantSummary(l.item_group ?? '', l.variants ?? null) ||
                          (l.description2 ?? ''),
                      });
                      return (
                      <tr key={i} className={`border-t border-border/60 ${l.cancelled ? 'opacity-50 line-through' : ''}`}>
                        <td className={`${td} whitespace-normal`}>
                          <div>{primary || '—'}</div>
                          {secondary && <div className="text-ink-muted">{secondary}</div>}
                        </td>
                        <td className={tdR}>{l.qty ?? '—'}</td>
                        <td className={tdR}>{cell(l.unit_price_centi)}</td>
                        <td className={tdR}>{cell(l.amount_centi)}</td>
                        <td className={`${tdR} text-ink-muted`}>{cell(l.unit_cost_centi)}</td>
                        <td className={`${tdR} text-ink-muted`}>{cell(l.line_cost_centi)}</td>
                      </tr>
                      );
                    })}
                    {d.lines.length === 0 && <tr><td className={`${td} text-ink-muted`} colSpan={6}>No lines.</td></tr>}
                  </tbody>
                </table>
              </div>

              {/* summary grid */}
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                <MiniStat k="Amount" v={rm(d.amount_centi)} />
                <MiniStat k="Selling" v={rm(d.selling_centi)} />
                <MiniStat k="Service Rev." v={rm(d.service_rev_centi)} />
                <MiniStat k="Total Cost" v={rm(d.total_so_cost_centi)} />
                <MiniStat k="Margin" v={pct(d.margin_pct)} tone={(d.margin_pct ?? 0) >= 0 ? 'good' : 'bad'} />
                <MiniStat k="Balance" v={rm(d.balance_centi)} />
              </div>

              {/* cost by category */}
              <SectionH>Cost by category</SectionH>
              <div className="overflow-hidden rounded-lg border border-border">
                {catRows(d.cost_by_category).map(([label, v]) => (
                  <div key={label} className="flex items-center justify-between border-b border-border/60 px-3 py-2 text-[12.5px] last:border-b-0">
                    <span className="text-ink-secondary">{label}</span><span className="tabular-nums">{cell(v)}</span>
                  </div>
                ))}
                <div className="flex items-center justify-between bg-surface-2 px-3 py-2 text-[12.5px] font-semibold">
                  <span>Total SO Cost</span><span className="tabular-nums">{rm(d.total_so_cost_centi)}</span>
                </div>
              </div>

              {/* deposit by tender */}
              <SectionH>Deposit by tender</SectionH>
              <div className="space-y-2">
                {d.payments.length === 0 && <div className="text-[12px] text-ink-muted">No payments recorded.</div>}
                {d.payments.map((p, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
                    <span className="min-w-[74px] text-[12.5px] font-semibold text-ink">{p.tender ?? '—'}</span>
                    <span className="flex-1 text-[11px] text-ink-muted">{merchantLine(p)}</span>
                    <span className="text-[12.5px] font-semibold tabular-nums">{cell(p.amount_centi)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><dt className="text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</dt><dd className="mt-0.5 text-[13px] text-ink">{v}</dd></div>;
}
function SectionH({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 mt-5 text-[10.5px] font-bold uppercase tracking-brand text-ink-muted">{children}</div>;
}
function MiniStat({ k, v, tone }: { k: string; v: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-2.5 py-2">
      <div className="text-[8.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</div>
      <div className={`mt-0.5 text-[13px] font-semibold tabular-nums ${tone === 'good' ? 'text-synced' : tone === 'bad' ? 'text-err' : 'text-ink'}`}>{v}</div>
    </div>
  );
}
/* `nos` is an ARRAY because a Sales Order routinely ships on more than one DO
   and invoices on more than one SI. This card used to render `no={do_nos[0]}`
   and demote the rest to "+1 more" in the caption — so the second document
   number never appeared anywhere on screen, and `sub` was carrying two
   unrelated jobs (the stage's status, and an overflow count). Owner 2026-08-01,
   on the list columns that did the same thing: 需要应用到所有列表. Every number
   renders now, one per line, and `sub` goes back to stating status only. */
function ChainLink({ label, nos, sub, done }: { label: string; nos: string[]; sub: string; done: boolean }) {
  return (
    <div className={`min-w-[118px] flex-1 rounded-lg border px-3 py-2.5 ${done ? 'border-primary/30 bg-primary/5' : 'border-dashed border-border bg-surface-2'}`}>
      <div className="text-[9.5px] font-bold uppercase tracking-brand text-ink-muted">{label}</div>
      <div className={`${mono} mt-0.5 flex flex-col gap-0.5 text-[12.5px] ${done ? 'text-primary-ink' : 'text-ink-muted'}`}>
        {nos.length === 0 ? <span>—</span> : nos.map((n) => <span key={n}>{n}</span>)}
      </div>
      <div className="mt-0.5 text-[10.5px] text-ink-muted">{sub}</div>
    </div>
  );
}
function ChainArrow() {
  return <div className="flex items-center px-0.5 text-ink-muted">→</div>;
}

// ── export builder ────────────────────────────────────────────────────────────
function buildExport(data: NonNullable<FairReportData>): { headers: string[]; body: (string | number | null)[][]; name: string } {
  if (data.stage === 'so') {
    return {
      name: 'fair-report-sales-orders.csv',
      headers: ['Date', 'Venue', 'Project', 'SO No', 'Order Form', 'Salesperson', 'Branding', 'Amount', 'Selling', 'Service Rev', 'Mattress/Sofa Cost', 'Bedframe Cost', 'Accessories Cost', 'Others Cost', 'Service Cost', 'Total SO Cost', 'Margin %', 'Balance', 'Payment', 'Cash', 'Merchant', 'Installment', 'Online', 'Below Deposit'],
      body: data.rows.map((r) => [
        formatDate(r.so_date), r.venue, r.project, r.so_no, r.order_form, r.salesperson, r.branding,
        c(r.amount_centi), c(r.selling_centi), c(r.service_rev_centi),
        c(r.cost_by_category.mattress_sofa_cost_centi), c(r.cost_by_category.bedframe_cost_centi), c(r.cost_by_category.accessories_cost_centi), c(r.cost_by_category.others_cost_centi), c(r.cost_by_category.service_cost_centi),
        c(r.total_so_cost_centi), r.margin_pct == null ? '' : r.margin_pct.toFixed(1), c(r.balance_centi), r.payment_methods.join(' + '),
        c(r.deposit_by_tender.Cash), c(r.deposit_by_tender.Merchant), c(r.deposit_by_tender.Installment), c(r.deposit_by_tender.Online), r.below_deposit ? 'Yes' : '',
      ]),
    };
  }
  if (data.stage === 'do') {
    return {
      name: 'fair-report-delivery-orders.csv',
      headers: ['Delivery Date', 'Venue', 'Project', 'Branding', 'DO No', 'Linked SO', 'Qty', 'SO Amount', 'Total SO Cost', 'Total DO Cost', 'Cost Delta', 'SO Margin %', 'DO Margin %', 'Legacy'],
      body: data.rows.map((r) => [
        formatDate(r.delivery_date), r.venue, r.project, r.branding, r.do_no, r.so_no, r.qty,
        r.so_amount_centi == null ? '' : c(r.so_amount_centi),
        c(r.total_so_cost_centi), c(r.total_do_cost_centi), c(r.cost_delta_centi),
        r.so_margin_pct == null ? '' : r.so_margin_pct.toFixed(1), r.do_margin_pct == null ? '' : r.do_margin_pct.toFixed(1), r.do_cost_is_legacy ? 'Yes' : '',
      ]),
    };
  }
  if (data.stage === 'pnl') {
    return {
      name: 'fair-report-pnl.csv',
      headers: ['Date', 'Venue', 'Project', 'SO No', 'Salesperson', 'Branding', 'Revenue', 'SO Cost', 'DO Cost', 'SI Cost', 'COGS', 'Cost Stage', 'Gross Profit', 'Margin %'],
      body: data.rows.map((r) => [
        formatDate(r.so_date), r.venue, r.project, r.so_no, r.salesperson, r.branding,
        c(r.revenue_centi), c(r.so_cost_centi), r.do_cost_centi == null ? '' : c(r.do_cost_centi), r.si_cost_centi == null ? '' : c(r.si_cost_centi),
        c(r.effective_cost_centi), r.effective_cost_stage, c(r.gross_profit_centi), r.margin_pct == null ? '' : r.margin_pct.toFixed(1),
      ]),
    };
  }
  return {
    name: 'fair-report-invoices.csv',
    headers: ['Invoice Date', 'Venue', 'Project', 'Branding', 'Invoice No', 'Linked SO', 'Invoiced', 'SO Cost', 'DO Cost', 'Landed (SI) Cost', 'Margin %'],
    body: data.rows.map((r) => [
      formatDate(r.invoice_date), r.venue, r.project, r.branding, r.inv_no, r.so_no,
      c(r.invoiced_centi), c(r.so_cost_centi), c(r.do_cost_centi), c(r.si_cost_centi), r.margin_pct == null ? '' : r.margin_pct.toFixed(1),
    ]),
  };
}
/** Plain 2-decimal number for CSV (no dash, no separators that would break CSV). */
const c = (centi: number | null | undefined): string => (Number(centi ?? 0) / 100).toFixed(2);

// Response type aliases used across the subcomponents.
type FairReportData = FairSoResponse | FairDoResponse | FairInvoiceResponse | FairPnlResponse | undefined;
type FairReportRows = FairSoRow[] | FairDoRow[] | FairInvoiceRow[] | FairPnlRow[] | undefined;

export default FairReport;
