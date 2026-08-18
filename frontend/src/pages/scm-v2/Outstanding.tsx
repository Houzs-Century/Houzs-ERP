// ----------------------------------------------------------------------------
// Outstanding — cross-module Outstanding dashboard (PR #45).
//
// Commander 2026-05-26: "8 个 module 全部都要能 filter 出来 Outstanding
// 跟非 Outstanding 的部分. by date".
//
// One page with 8 tabs, each shows the outstanding (or completed) rows for
// that module. Date range filter applies across all tabs. Top stat strip
// shows counts + value per module from the /outstanding/summary endpoint.
// ----------------------------------------------------------------------------

import { todayMyt } from '../../vendor/scm/lib/dates';
import { fmtCenti } from '../../vendor/shared/format';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, FileText, Receipt, Truck, Undo2, ScrollText, PackagePlus } from 'lucide-react';
import {
  useOutstanding,
  useOutstandingSummary,
  type OutstandingModule,
  type OutstandingFilterMode,
} from '../../vendor/scm/lib/outstanding-queries';
import { DataTable, type Column } from '../../components/DataTable';
import styles from './Suppliers.module.css';
import { PageHeader } from '../../components/Layout';
import { DateField } from "../../vendor/scm/components/DateField";

const MODULES: { value: OutstandingModule; label: string; icon: React.ReactNode; route: (row: Record<string, unknown>) => string }[] = [
  // HOUZS VENDOR — "Open →" deep-links repointed onto Houzs's /scm/* routes
  // (same /api/scm backend). PO points at the vendored  detail; the other
  // modules use their native Houzs SCM detail pages.
  { value: 'po',          label: 'PO',          icon: <ScrollText size={14} strokeWidth={1.75} />,    route: (r) => `/scm/purchase-orders/${r.id}` },
  { value: 'grn',         label: 'GRN',         icon: <PackagePlus size={14} strokeWidth={1.75} />,   route: (r) => `/scm/grns/${r.id}` },
  { value: 'pi',          label: 'PI',          icon: <Receipt size={14} strokeWidth={1.75} />,       route: (r) => `/scm/purchase-invoices/${r.id}` },
  { value: 'pr',          label: 'PR',          icon: <Undo2 size={14} strokeWidth={1.75} />,         route: (r) => `/scm/purchase-returns/${r.id}` },
  { value: 'so',          label: 'SO',          icon: <ClipboardList size={14} strokeWidth={1.75} />, route: (r) => `/scm/sales-orders/${r.doc_no}` },
  { value: 'do',          label: 'DO',          icon: <Truck size={14} strokeWidth={1.75} />,         route: (r) => `/scm/delivery-orders/${r.id}` },
  { value: 'si',          label: 'SI',          icon: <FileText size={14} strokeWidth={1.75} />,      route: (r) => `/scm/sales-invoices/${r.id}` },
];

// Guarded centi→"RM …" — "—" for an absent/non-finite amount, never "RM NaN".
const fmtRm = (centi: number | null | undefined): string => fmtCenti(centi);

export const Outstanding = () => {
  const today = todayMyt();
  const yearAgo = todayMyt(-365);

  const [mode, setMode] = useState<OutstandingFilterMode>('outstanding');
  const [from, setFrom] = useState(yearAgo);
  const [to, setTo] = useState(today);
  const [activeModule, setActiveModule] = useState<OutstandingModule>('so');

  const summary = useOutstandingSummary({ from, to });
  const rowsQ = useOutstanding(activeModule, { mode, from, to });
  const rows = rowsQ.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="Outstanding"
        actions={
          <div className={styles.actionsRow}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-13)' }}>
              <span style={{ color: 'var(--fg-muted)' }}>From</span>
              <DateField fullWidth className={styles.searchInput} value={from} onChange={(iso) => setFrom(iso)} style={{ width: 150 }}/>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-13)' }}>
              <span style={{ color: 'var(--fg-muted)' }}>To</span>
              <DateField fullWidth className={styles.searchInput} value={to} onChange={(iso) => setTo(iso)} style={{ width: 150 }}/>
            </label>
            <div className={styles.statusChips}>
              <FilterChip label="Outstanding" active={mode === 'outstanding'} onClick={() => setMode('outstanding')} />
              <FilterChip label="Completed"   active={mode === 'completed'}   onClick={() => setMode('completed')} />
              <FilterChip label="All"         active={mode === 'all'}         onClick={() => setMode('all')} />
            </div>
          </div>
        }
      />

      {/* Summary tiles — count + outstanding value per module, in selected date range */}
      <section style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 'var(--space-3)', marginTop: 'var(--space-3)',
      }}>
        {MODULES.map((m) => {
          const s = summary.data?.summary?.[m.value];
          const active = activeModule === m.value;
          return (
            <button key={m.value} type="button"
              onClick={() => setActiveModule(m.value)}
              /* Theme C selected-tile (owner 2026-07-25): like the SO page's
                 active StatCard - white with a petrol border - instead of the
                 2990 ink-filled block. */
              style={{
                padding: 'var(--space-3) var(--space-4)',
                background: '#ffffff',
                color: 'var(--c-ink)',
                border: `1px solid ${active ? '#16695f' : 'var(--c-line, rgba(34,31,32,0.12))'}`,
                boxShadow: active ? 'inset 0 0 0 1px #16695f' : 'none',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                textAlign: 'left',
              }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', opacity: 0.8 }}>
                {m.icon}
                <span>{m.label}</span>
              </div>
              <div style={{ fontSize: 'var(--fs-22)', fontWeight: 900, marginTop: 4 }}>
                {s?.count ?? 0}
              </div>
              {!!s?.total_outstanding_centi && s.total_outstanding_centi > 0 && (
                <div style={{ fontSize: 'var(--fs-11)', opacity: 0.7, marginTop: 2 }}>
                  {fmtRm(s.total_outstanding_centi)} outstanding
                </div>
              )}
            </button>
          );
        })}
      </section>

      <p className={styles.eyebrow} style={{ marginTop: 'var(--space-3)' }}>
        {rowsQ.isLoading
          ? `Loading ${activeModule}…`
          : `${rows.length} ${activeModule.toUpperCase()} rows (${mode})`}
      </p>

      {/* key= remounts the table per module — columns AND search reset with
          the tab, so a PI search never filters the SO list. */}
      <ModuleTable
        key={activeModule}
        module={activeModule}
        rows={rows}
        isLoading={rowsQ.isLoading}
      />
    </div>
  );
};

const FilterChip = ({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) => (
  <button type="button" onClick={onClick}
    style={{
      padding: '4px 12px',
      border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
      borderRadius: 'var(--radius-pill)',
      background: active ? 'var(--c-orange)' : 'transparent',
      color: active ? 'var(--c-cream)' : 'var(--c-ink)',
      fontSize: 'var(--fs-13)',
      cursor: 'pointer',
      fontWeight: 600,
    }}>{label}</button>
);

/* ── Batch 2: shared DataTable ───────────────────────────────────────────
   Per-module column specs ported 1:1. Each module keeps its own tableId
   (columns differ per module, so a shared layout would corrupt across
   tabs). Money (centi) + qty columns sort numerically on the raw value via
   getValue; date columns sort on the raw ISO string. */
type OutRow = Record<string, unknown>;

type ColSpec = {
  key: string;
  label: string;
  kind?: 'date' | 'money' | 'qty';
};

const MODULE_COLUMNS: Record<OutstandingModule, ColSpec[]> = {
  po: [
    { key: 'po_number', label: 'PO No' },
    { key: 'po_date',   label: 'Date', kind: 'date' },
    { key: 'expected_at', label: 'Expected', kind: 'date' },
    { key: 'status',    label: 'Status' },
    { key: 'qty_outstanding', label: 'Qty Outstanding', kind: 'qty' },
    { key: 'total_centi', label: 'Total', kind: 'money' },
  ],
  grn: [
    { key: 'grn_number', label: 'GRN No' },
    { key: 'received_at', label: 'Date', kind: 'date' },
    { key: 'status',    label: 'Status' },
  ],
  pi: [
    { key: 'invoice_number', label: 'Invoice No' },
    { key: 'invoice_date',   label: 'Date', kind: 'date' },
    { key: 'due_date',       label: 'Due', kind: 'date' },
    { key: 'total_centi',    label: 'Total', kind: 'money' },
    { key: 'paid_centi',     label: 'Paid', kind: 'money' },
    { key: 'outstanding_centi', label: 'Outstanding', kind: 'money' },
    { key: 'status',         label: 'Status' },
  ],
  pr: [
    { key: 'return_number', label: 'PR No' },
    { key: 'return_date',   label: 'Date', kind: 'date' },
    { key: 'status',        label: 'Status' },
    { key: 'refund_centi',  label: 'Refund', kind: 'money' },
  ],
  so: [
    { key: 'doc_no',     label: 'SO No' },
    { key: 'so_date',    label: 'Date', kind: 'date' },
    { key: 'debtor_name', label: 'Customer' },
    { key: 'status',     label: 'Status' },
    { key: 'total_revenue_centi', label: 'Total', kind: 'money' },
  ],
  do: [
    { key: 'do_number',  label: 'DO No' },
    { key: 'do_date',    label: 'Date', kind: 'date' },
    { key: 'so_doc_no',  label: 'SO Ref' },
    { key: 'debtor_name', label: 'Customer' },
    { key: 'status',     label: 'Status' },
  ],
  si: [
    { key: 'invoice_number', label: 'Invoice No' },
    { key: 'invoice_date',   label: 'Date', kind: 'date' },
    { key: 'due_date',       label: 'Due', kind: 'date' },
    { key: 'debtor_name',    label: 'Customer' },
    { key: 'total_centi',    label: 'Total', kind: 'money' },
    { key: 'paid_centi',     label: 'Paid', kind: 'money' },
    { key: 'outstanding_centi', label: 'Outstanding', kind: 'money' },
    { key: 'status',         label: 'Status' },
  ],
};

const cellText = (spec: ColSpec, r: OutRow): string => {
  const v = r[spec.key];
  if (spec.kind === 'money') return fmtRm(Number(v) || 0);
  if (spec.kind === 'qty')   return Number(v).toLocaleString();
  if (spec.kind === 'date')  return v ? String(v) : '—';
  return String(v ?? '—');
};

const ModuleTable = ({
  module, rows, isLoading,
}: {
  module: OutstandingModule;
  rows: OutRow[];
  isLoading: boolean;
}) => {
  const config = useMemo(() => MODULES.find((m) => m.value === module)!, [module]);

  type KeyedRow = OutRow & { __rk: string };
  const columns = useMemo<Column<KeyedRow>[]>(() => {
    const cols: Column<KeyedRow>[] = MODULE_COLUMNS[module].map((spec) => ({
      key: spec.key,
      label: spec.label,
      width: spec.kind === 'money' || spec.kind === 'qty' ? '120px' : '140px',
      align: spec.kind === 'money' || spec.kind === 'qty' ? ('right' as const) : undefined,
      getValue: (r: KeyedRow) =>
        spec.kind === 'money' || spec.kind === 'qty'
          ? Number(r[spec.key]) || 0
          : String(r[spec.key] ?? ''),
      render: (r: KeyedRow) => cellText(spec, r),
    }));
    cols.push({
      key: '__open__',
      label: '',
      width: '80px',
      disableSort: true,
      getValue: () => '',
      render: (r) => (
        <Link to={config.route(r)} className={styles.docLink ?? ''}>
          Open →
        </Link>
      ),
    });
    return cols;
  }, [module, config]);

  /* Rows can lack a stable id for some modules — pre-compute a row key that
     falls back to doc_no then the index (matches the legacy <tr key>). */
  const keyedRows: KeyedRow[] = useMemo(
    () => rows.map((r, i) => ({ ...r, __rk: String(r.id ?? r.doc_no ?? i) })),
    [rows],
  );

  /* Loaded-only search across the module's visible columns — the page
     filters (DataTable renders box + hint), same fields the old DataGrid's
     built-in search matched. Component remounts per module (key= above), so
     the term never leaks across tabs. */
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return keyedRows;
    const specs = MODULE_COLUMNS[module];
    return keyedRows.filter((r) =>
      specs.some((spec) => cellText(spec, r).toLowerCase().includes(term)),
    );
  }, [keyedRows, search, module]);

  return (
    <DataTable<KeyedRow>
      tableId={`outstanding-${module}`}
      layoutFamily={`outstanding-${module}`}
      exportName={`outstanding-${module}`}
      rows={isLoading ? null : visible}
      loading={isLoading}
      emptyLabel="No rows match the filters."
      getRowKey={(r) => r.__rk}
      columns={columns}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: `Search ${module.toUpperCase()} rows…`,
      }}
    />
  );
};
