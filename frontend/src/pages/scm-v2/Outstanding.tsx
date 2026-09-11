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
import { fmtSen } from '../../vendor/shared/format';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, FileText, Receipt, Truck, Undo2, ScrollText, PackagePlus, PackageSearch } from 'lucide-react';
import {
  useOutstanding,
  useOutstandingSummary,
  useOutstandingPoLines,
  type OutstandingModule,
  type OutstandingFilterMode,
} from '../../vendor/scm/lib/outstanding-queries';
import {
  rollUpToSets,
  companyCodesPresent,
  type PoOutstandingLineRow,
  type PoOutstandingSetRow,
} from '../../vendor/scm/lib/po-outstanding-rollup';
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
const fmtRm = (centi: number | null | undefined): string => fmtSen(centi);

/* The tab bar carries the seven money modules plus one extra: 'po-lines', the
   line-level PO chasing list. It is NOT an OutstandingModule (no summary money
   tile, cross-company, its own endpoint), so it rides a wider union here. */
type OutstandingTab = OutstandingModule | 'po-lines';

export const Outstanding = () => {
  const today = todayMyt();
  const yearAgo = todayMyt(-365);

  const [mode, setMode] = useState<OutstandingFilterMode>('outstanding');
  const [from, setFrom] = useState(yearAgo);
  const [to, setTo] = useState(today);
  const [activeModule, setActiveModule] = useState<OutstandingTab>('so');

  const summary = useOutstandingSummary({ from, to });
  // The generic per-module hook only knows the seven money modules; when the
  // chasing tab is active fall it back to 'po' (cached, cheap) and read the
  // dedicated cross-company hook below instead.
  const genericModule: OutstandingModule = activeModule === 'po-lines' ? 'po' : activeModule;
  const rowsQ = useOutstanding(genericModule, { mode, from, to });
  const rows = rowsQ.data?.rows ?? [];

  const poLinesQ = useOutstandingPoLines({ mode, from, to });
  const poLinesRows = poLinesQ.data?.rows ?? [];
  const isPoLines = activeModule === 'po-lines';

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
                {s?.unavailable ? '—' : (s?.count ?? 0)}
              </div>
              {s?.unavailable ? (
                <div style={{ fontSize: 'var(--fs-11)', opacity: 0.85, marginTop: 2, color: 'var(--c-err, #b4453a)' }}
                     title={s.deposit_note ?? undefined}>
                  Could not read
                </div>
              ) : (
                !!s?.total_outstanding_sen && s.total_outstanding_sen > 0 && (
                  <div style={{ fontSize: 'var(--fs-11)', opacity: 0.7, marginTop: 2 }}
                       title={s.deposit_note ?? undefined}>
                    {/* "at most" is not hedging — when deposit_applied is false the
                        figure counts every invoice but subtracts no order deposit,
                        so it is a ceiling and the reader is entitled to know. */}
                    {s.deposit_applied === false ? 'at most ' : ''}{fmtRm(s.total_outstanding_sen)} outstanding
                  </div>
                )
              )}
            </button>
          );
        })}

        {/* PO Chasing — line-level, cross-company (HOUZS + 2990). Not a money
            module, so it carries a line count, not an outstanding value. */}
        <button type="button"
          onClick={() => setActiveModule('po-lines')}
          style={{
            padding: 'var(--space-3) var(--space-4)',
            background: '#ffffff',
            color: 'var(--c-ink)',
            border: `1px solid ${isPoLines ? '#16695f' : 'var(--c-line, rgba(34,31,32,0.12))'}`,
            boxShadow: isPoLines ? 'inset 0 0 0 1px #16695f' : 'none',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            textAlign: 'left',
          }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', opacity: 0.8 }}>
            <PackageSearch size={14} strokeWidth={1.75} />
            <span>PO Chasing</span>
          </div>
          <div style={{ fontSize: 'var(--fs-22)', fontWeight: 900, marginTop: 4 }}>
            {poLinesQ.isLoading ? '—' : poLinesRows.length}
          </div>
          <div style={{ fontSize: 'var(--fs-11)', opacity: 0.7, marginTop: 2 }}>
            outstanding lines
          </div>
        </button>
      </section>

      <p className={styles.eyebrow} style={{ marginTop: 'var(--space-3)' }}>
        {isPoLines
          ? (poLinesQ.isLoading ? 'Loading PO chasing…' : `${poLinesRows.length} PO lines (${mode})`)
          : rowsQ.isLoading
            ? `Loading ${activeModule}…`
            : `${rows.length} ${activeModule.toUpperCase()} rows (${mode})`}
      </p>

      {/* key= remounts the table per module — columns AND search reset with
          the tab, so a PI search never filters the SO list. */}
      {isPoLines ? (
        <PoChasingView rows={poLinesRows} isLoading={poLinesQ.isLoading} />
      ) : (
        <ModuleTable
          key={activeModule}
          module={genericModule}
          rows={rows}
          isLoading={rowsQ.isLoading}
        />
      )}
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
    { key: 'total_sen', label: 'Total', kind: 'money' },
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
    { key: 'total_sen',    label: 'Total', kind: 'money' },
    { key: 'paid_sen',     label: 'Paid', kind: 'money' },
    { key: 'outstanding_sen', label: 'Outstanding', kind: 'money' },
    { key: 'status',         label: 'Status' },
  ],
  pr: [
    { key: 'return_number', label: 'PR No' },
    { key: 'return_date',   label: 'Date', kind: 'date' },
    { key: 'status',        label: 'Status' },
    { key: 'refund_sen',  label: 'Refund', kind: 'money' },
  ],
  so: [
    { key: 'doc_no',     label: 'SO No' },
    { key: 'so_date',    label: 'Date', kind: 'date' },
    { key: 'debtor_name', label: 'Customer' },
    { key: 'status',     label: 'Status' },
    { key: 'total_revenue_sen', label: 'Total', kind: 'money' },
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
    { key: 'total_sen',    label: 'Total', kind: 'money' },
    { key: 'paid_sen',     label: 'Paid', kind: 'money' },
    /* The deposit taken on the source Sales Order. `outstanding_sen` on these
       rows is ALREADY net of it (the /outstanding/si handler subtracts it —
       the view scm.v_si_outstanding cannot, the split is a per-order rule), so
       this column is what makes the smaller Outstanding readable instead of
       mysterious. */
    { key: 'so_deposit_applied_sen', label: 'SO deposit', kind: 'money' },
    { key: 'outstanding_sen', label: 'Outstanding', kind: 'money' },
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

/* ── PO Chasing — line-level, cross-company outstanding PO list ───────────────
   The AutoCount "PO chasing list" shape: one row per outstanding PO line,
   grouped by supplier, with a Detail (component lines) / By set toggle and an
   Excel export. Reads the cross-company /outstanding/po-lines (HOUZS + 2990),
   so it carries a Company column and an optional company filter the money tabs
   don't have. Rolling sofa components into one "set" row is a heuristic — see
   po-outstanding-rollup.ts. */
type ChaseSpec = {
  key: string;
  label: string;
  width?: string;
  align?: 'right';
  kind?: 'date' | 'qty';
  get: (r: PoOutstandingLineRow) => string | number;
};

const chaseText = (spec: ChaseSpec, r: PoOutstandingLineRow): string => {
  const v = spec.get(r);
  if (spec.kind === 'qty') return (Number(v) || 0).toLocaleString();
  if (spec.kind === 'date') return v ? String(v) : '—';
  const s = String(v).trim();
  return s === '' ? '—' : s;
};

const PoChasingView = ({ rows, isLoading }: { rows: PoOutstandingLineRow[]; isLoading: boolean }) => {
  const [granularity, setGranularity] = useState<'detail' | 'set'>('detail');
  const [companyFilter, setCompanyFilter] = useState('');
  const [search, setSearch] = useState('');

  const companyCodes = useMemo(() => companyCodesPresent(rows), [rows]);

  const scoped = useMemo(
    () => (companyFilter ? rows.filter((r) => String(r.company_code ?? '') === companyFilter) : rows),
    [rows, companyFilter],
  );

  const display = useMemo<PoOutstandingLineRow[]>(
    () => (granularity === 'set' ? rollUpToSets(scoped) : scoped),
    [scoped, granularity],
  );

  const specs = useMemo<ChaseSpec[]>(() => [
    { key: 'company_code',  label: 'Company',        get: (r) => String(r.company_code ?? '') },
    { key: 'po_number',     label: 'PO No',          get: (r) => String(r.po_number ?? '') },
    { key: 'ac_po_no',      label: 'AC PO No',       get: (r) => String(r.ac_po_no ?? '') },
    { key: 'so_doc_no',     label: 'SO Doc No',      get: (r) => String(r.so_doc_no ?? '') },
    { key: 'creditor_code', label: 'Creditor Code',  get: (r) => String(r.creditor_code ?? '') },
    { key: 'creditor_name', label: 'Creditor', width: '200px', get: (r) => String(r.creditor_name ?? '') },
    {
      key: 'item_code',
      label: granularity === 'set' ? 'Set / Item Code' : 'Item Code',
      width: '160px',
      get: (r) => String((granularity === 'set' ? (r as PoOutstandingSetRow).set_code : r.item_code) ?? ''),
    },
    ...(granularity === 'set'
      ? [{
          key: 'component_count', label: 'Components', align: 'right' as const, kind: 'qty' as const,
          get: (r: PoOutstandingLineRow) => Number((r as PoOutstandingSetRow).component_count),
        }]
      : []),
    { key: 'item_desc',  label: 'Item Description',   width: '220px', get: (r) => String(r.item_desc ?? '') },
    { key: 'item_desc2', label: 'Item Description 2', width: '240px', get: (r) => String(r.item_desc2 ?? '') },
    { key: 'location_code', label: 'Location',        get: (r) => String(r.location_code ?? '') },
    { key: 'item_group', label: 'Item Group',         get: (r) => String(r.item_group ?? '') },
    { key: 'po_date',    label: 'Doc Date', kind: 'date', get: (r) => String(r.po_date ?? '') },
    { key: 'remaining_qty', label: 'Remaining Qty', align: 'right', kind: 'qty', get: (r) => Number(r.remaining_qty ?? 0) },
    { key: 'delivery_date', label: 'Delivery Date', kind: 'date', get: (r) => String(r.delivery_date ?? '') },
    // The AutoCount UDF dates — kept as columns per owner (2026-09-12) though
    // the ERP does not sync them yet, so they read blank for now.
    { key: 'est_delivery_date',        label: 'Estimate Delivery Date', kind: 'date', get: () => '' },
    { key: 'supplier_delivery_date_2', label: 'Supplier Delivery Date 2', kind: 'date', get: (r) => String(r.supplier_delivery_date_2 ?? '') },
    { key: 'supplier_delivery_date_3', label: 'Supplier Delivery Date 3', kind: 'date', get: (r) => String(r.supplier_delivery_date_3 ?? '') },
  ], [granularity]);

  type KeyedRow = PoOutstandingLineRow & { __rk: string };
  const keyed: KeyedRow[] = useMemo(
    () => display.map((r, i) => ({
      ...r,
      __rk: `${r.company_id ?? ''}:${r.po_number ?? ''}:${(granularity === 'set' ? (r as PoOutstandingSetRow).set_code : r.po_item_id) ?? i}:${i}`,
    })),
    [display, granularity],
  );

  const columns = useMemo<Column<KeyedRow>[]>(
    () => specs.map((spec) => ({
      key: spec.key,
      label: spec.label,
      width: spec.width ?? (spec.kind === 'qty' ? '110px' : spec.kind === 'date' ? '150px' : '130px'),
      align: spec.align,
      getValue: (r: KeyedRow) => (spec.kind === 'qty' ? Number(spec.get(r)) || 0 : String(spec.get(r))),
      render: (r: KeyedRow) => chaseText(spec, r),
    })),
    [specs],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return keyed;
    return keyed.filter((r) => specs.some((s) => chaseText(s, r).toLowerCase().includes(term)));
  }, [keyed, specs, search]);

  const onExport = async () => {
    const XLSX = await import('../../lib/xlsx-runtime');
    const header = specs.map((s) => s.label);
    const aoa: (string | number)[][] = [header, ...visible.map((r) => specs.map((s) => chaseText(s, r)))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = specs.map((s) => ({ wch: Math.min(42, Math.max(10, s.label.length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PO Chasing');
    XLSX.writeFileXLSX(wb, `PO-Chasing-${granularity}-${todayMyt()}.xlsx`);
  };

  return (
    <div className="space-y-2">
      <div className={styles.actionsRow} style={{ marginBottom: 'var(--space-2)' }}>
        <div className={styles.statusChips}>
          <FilterChip label="Detail (lines)" active={granularity === 'detail'} onClick={() => setGranularity('detail')} />
          <FilterChip label="By set" active={granularity === 'set'} onClick={() => setGranularity('set')} />
        </div>
        {companyCodes.length > 1 && (
          <div className={styles.statusChips}>
            <FilterChip label="All companies" active={companyFilter === ''} onClick={() => setCompanyFilter('')} />
            {companyCodes.map((code) => (
              <FilterChip key={code} label={code} active={companyFilter === code} onClick={() => setCompanyFilter(code)} />
            ))}
          </div>
        )}
      </div>
      <DataTable<KeyedRow>
        tableId="outstanding-po-lines"
        layoutFamily="outstanding-po-lines"
        exportName={`PO-Chasing-${granularity}`}
        rows={isLoading ? null : visible}
        loading={isLoading}
        emptyLabel="No outstanding PO lines match the filters."
        getRowKey={(r) => r.__rk}
        columns={columns}
        groupBy={{ key: 'creditor_name', label: (v) => v || '—' }}
        onExport={onExport}
        search={{ value: search, onChange: setSearch, placeholder: 'Search PO / item / supplier…' }}
      />
    </div>
  );
};
