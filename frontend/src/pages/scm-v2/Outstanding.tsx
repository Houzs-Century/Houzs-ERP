// ----------------------------------------------------------------------------
// Outstanding — cross-module Outstanding dashboard (PR #45), in the owner's
// Claude Design redesign (Finance › Money in, batch 5).
//
// Commander 2026-05-26: "8 个 module 全部都要能 filter 出来 Outstanding
// 跟非 Outstanding 的部分. by date".
//
// A card per module — its outstanding count and money in the chosen dates,
// from /outstanding/summary — plus the line-level PO chasing list. The card
// picked lists its documents below, Outstanding / Completed / All, in the date
// range. What the reader sets lives in the URL (?mod=&mode=&from=&to=), so a
// link such as To do's "SI outstanding" (?mod=si&mode=outstanding) opens the
// same view and a reload keeps it.
// ----------------------------------------------------------------------------

import { todayMyt } from '../../vendor/scm/lib/dates';
import { PO_ESTIMATE_DELIVERY_DATE_LABELS } from '../../vendor/scm/lib/po-line-export-columns';
import { fmtDate, fmtSen } from '../../vendor/shared/format';
import { soRefOfStamp, type SoRefStamp } from '../../lib/so-ref-search';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, FileText, Package, PackageSearch, Receipt, Truck, Undo2 } from 'lucide-react';
import {
  useOutstanding,
  useOutstandingSummary,
  useOutstandingPoLines,
  type OutstandingModule,
  type OutstandingFilterMode,
  type OutstandingSummary,
} from '../../vendor/scm/lib/outstanding-queries';
import {
  rollUpToSets,
  companyCodesPresent,
  type PoOutstandingLineRow,
  type PoOutstandingSetRow,
} from '../../vendor/scm/lib/po-outstanding-rollup';
import { DataTable, type Column } from '../../components/DataTable';
import { DateRangeButton } from '../../components/DateRangeButton';
import { OVERDUE_CLASS, isPastDue } from '../../lib/tableHighlight';
import { cancelledDocNoClass, cancelledRowClass, isCancelledDocStatus } from '../../lib/scm';
import { OUTSTANDING_DEFAULT_PRESET, OUTSTANDING_RANGE_PRESETS, isIsoDay, presetRange } from '../../lib/dateRangePresets';
import { PageHeader } from '../../components/Layout';
import { Chips, DocLink, FigureCard, Segments, StatusTag, type ChipOption } from './money-in/MoneyInParts';
import { dueDateTag, outstandingStatusTag } from './money-in/moneyInStatus';
import s from './MoneyIn.module.css';

type OutRow = Record<string, unknown>;
type SummaryEntry = OutstandingSummary[OutstandingModule];

const ICON = { size: 14, strokeWidth: 1.75 } as const;

const MODULES: {
  value: OutstandingModule;
  /** The card's label and the list's title (the design's words). */
  card: string;
  title: string;
  icon: ReactNode;
  /** The card's money line, read off the summary; null for a module the
   *  summary sums no money for, whose card counts documents instead. */
  money: ((e: SummaryEntry) => number) | null;
  route: (row: OutRow) => string;
}[] = [
  // HOUZS VENDOR — the numbers open Houzs's own /scm/* detail pages (same
  // /api/scm backend).
  { value: 'si',  card: 'SI · Sales invoices',    title: 'Sales invoices',    icon: <FileText {...ICON} />,       money: (e) => e.total_outstanding_sen ?? 0, route: (r) => `/scm/sales-invoices/${String(r.id)}` },
  { value: 'so',  card: 'SO · Sales orders',      title: 'Sales orders',      icon: <ClipboardCheck {...ICON} />, money: (e) => e.total_sen ?? 0,             route: (r) => `/scm/sales-orders/${String(r.doc_no)}` },
  { value: 'do',  card: 'DO · Deliveries',        title: 'Delivery orders',   icon: <Truck {...ICON} />,          money: null,                                route: (r) => `/scm/delivery-orders/${String(r.id)}` },
  { value: 'po',  card: 'PO · Purchase orders',   title: 'Purchase orders',   icon: <FileText {...ICON} />,       money: (e) => e.total_sen ?? 0,             route: (r) => `/scm/purchase-orders/${String(r.id)}` },
  { value: 'grn', card: 'GRN · Goods received',   title: 'Goods received',    icon: <Package {...ICON} />,        money: null,                                route: (r) => `/scm/grns/${String(r.id)}` },
  { value: 'pi',  card: 'PI · Purchase invoices', title: 'Purchase invoices', icon: <Receipt {...ICON} />,        money: (e) => e.total_outstanding_sen ?? 0, route: (r) => `/scm/purchase-invoices/${String(r.id)}` },
  /* The design counts PR refunds as money, but the summary sums no refund, so
     the card counts documents rather than print a total it cannot know. */
  { value: 'pr',  card: 'PR · Purchase returns',  title: 'Purchase returns',  icon: <Undo2 {...ICON} />,          money: null,                                route: (r) => `/scm/purchase-returns/${String(r.id)}` },
];

/* The cards carry the seven modules plus one extra: 'po-lines', the line-level
   PO chasing list. It is NOT an OutstandingModule (no summary money, cross-
   company, its own endpoint), so it rides a wider union here. */
type OutstandingTab = OutstandingModule | 'po-lines';
const PO_LINES_TITLE = 'PO chasing';
const DEFAULT_TAB: OutstandingTab = 'si';
const DEFAULT_MODE: OutstandingFilterMode = 'outstanding';

const MODE_OPTIONS: ChipOption<OutstandingFilterMode>[] = [
  { value: 'outstanding', label: 'Outstanding' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

const isTab = (v: string | null): v is OutstandingTab => v === 'po-lines' || MODULES.some((m) => m.value === v);
const isMode = (v: string | null): v is OutstandingFilterMode => MODE_OPTIONS.some((o) => o.value === v);
/** A date from the URL, or '' (an open end) when it is not a real day. */
const urlDay = (v: string | null): string => (v && isIsoDay(v) ? v : '');

const docWord = (n: number): string => (n === 1 ? '1 document' : `${n.toLocaleString('en-MY')} documents`);
const lineWord = (n: number, mode: OutstandingFilterMode): string => {
  const what = mode === 'outstanding' ? 'outstanding ' : mode === 'completed' ? 'completed ' : '';
  return `${n.toLocaleString('en-MY')} ${what}${n === 1 ? 'line' : 'lines'}`;
};

export const Outstanding = () => {
  const today = todayMyt();
  const [params, setParams] = useSearchParams();

  const rawTab = params.get('mod');
  const activeModule: OutstandingTab = isTab(rawTab) ? rawTab : DEFAULT_TAB;
  const rawMode = params.get('mode');
  const mode: OutstandingFilterMode = isMode(rawMode) ? rawMode : DEFAULT_MODE;
  /* No dates in the URL = the default window, counted from today (the last 12
     months until the owner answers f7). An empty value is an open end: "All
     dates" writes `from=&to=`, and the hooks then send neither. */
  const fallback = presetRange(OUTSTANDING_DEFAULT_PRESET, today);
  const hasRange = params.has('from') || params.has('to');
  const from = hasRange ? urlDay(params.get('from')) : fallback.from;
  const to = hasRange ? urlDay(params.get('to')) : fallback.to;

  const setParam = (patch: Record<string, string | null>) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) next.delete(k); else next.set(k, v);
    }
    return next;
  }, { replace: true });
  const setModule = (m: OutstandingTab) => setParam({ mod: m === DEFAULT_TAB ? null : m });
  const setMode = (m: OutstandingFilterMode) => setParam({ mode: m === DEFAULT_MODE ? null : m });
  const setRange = (f: string, t: string) =>
    setParam(f === fallback.from && t === fallback.to ? { from: null, to: null } : { from: f, to: t });

  const summary = useOutstandingSummary({ from, to });
  // The generic per-module hook only knows the seven money modules; when the
  // chasing card is picked fall it back to 'po' (cached, cheap) and read the
  // dedicated cross-company hook below instead.
  const genericModule: OutstandingModule = activeModule === 'po-lines' ? 'po' : activeModule;
  const rowsQ = useOutstanding(genericModule, { mode, from, to });
  const rows = rowsQ.data?.rows ?? [];

  const poLinesQ = useOutstandingPoLines({ mode, from, to });
  const poLinesRows = poLinesQ.data?.rows ?? [];
  const isPoLines = activeModule === 'po-lines';
  const config = MODULES.find((m) => m.value === genericModule) ?? MODULES[0];
  const pending = summary.isLoading;
  const summaryFailed = Boolean(summary.error);

  return (
    <div className={s.page}>
      <PageHeader eyebrow="Finance · Money in" title="Outstanding" />

      {/* A card per module — its outstanding documents and money in these
          dates — then PO chasing. */}
      <div className={s.cardsWrap}>
        <div className={`${s.cards} ${s.cardsEight}`}>
          {MODULES.map((m) => {
            const e: SummaryEntry | undefined = summary.data?.summary[m.value];
            const unread = summaryFailed || e?.unavailable === true;
            const count = e?.count ?? 0;
            /* "at most" is not hedging — when deposit_applied is false the SI
               figure counts every invoice but subtracts no order deposit, so it
               is a ceiling and the reader is entitled to know. */
            const sub = pending ? 'Loading…'
              : unread ? 'Could not read'
              : m.money && e ? `${e.deposit_applied === false ? 'at most ' : ''}${fmtSen(m.money(e))}`
              : docWord(count);
            return (
              <FigureCard
                key={m.value}
                icon={m.icon}
                label={m.card}
                value={count.toLocaleString('en-MY')}
                zero={count === 0}
                pending={pending || unread}
                sub={sub}
                subBad={!pending && unread}
                title={e?.deposit_note ?? undefined}
                on={activeModule === m.value}
                onClick={() => setModule(m.value)}
              />
            );
          })}
          {/* PO chasing — line-level, cross-company (HOUZS + 2990). Not a money
              module, so it counts lines, in the mode picked below. */}
          <FigureCard
            icon={<PackageSearch {...ICON} />}
            label={PO_LINES_TITLE}
            value={poLinesRows.length.toLocaleString('en-MY')}
            zero={poLinesRows.length === 0}
            pending={poLinesQ.isLoading || Boolean(poLinesQ.error)}
            sub={poLinesQ.isLoading ? 'Loading…' : poLinesQ.error ? 'Could not read' : lineWord(poLinesRows.length, mode)}
            subBad={!poLinesQ.isLoading && Boolean(poLinesQ.error)}
            on={isPoLines}
            onClick={() => setModule('po-lines')}
          />
        </div>
      </div>

      <div className={s.toolbar}>
        <Chips label="Show" options={MODE_OPTIONS} value={mode} onChange={setMode} />
        <span className={s.listTitle}>{isPoLines ? PO_LINES_TITLE : config.title}</span>
        <span className={s.grow} />
        <DateRangeButton
          from={from}
          to={to}
          onChange={setRange}
          presets={OUTSTANDING_RANGE_PRESETS}
          today={today}
          label="Document dates"
        />
      </div>

      {/* key= remounts the table per module — columns AND search reset with
          the card, so a PI search never filters the SO list. */}
      {isPoLines ? (
        <PoChasingView rows={poLinesRows} isLoading={poLinesQ.isLoading} error={poLinesQ.error} />
      ) : (
        <ModuleTable
          key={activeModule}
          module={genericModule}
          rows={rows}
          isLoading={rowsQ.isLoading}
          error={rowsQ.error}
          mode={mode}
          today={today}
        />
      )}
    </div>
  );
};

const errorText = (e: unknown): string | null =>
  e ? (e instanceof Error && e.message ? e.message : 'Could not load this list') : null;

/* ── One module's documents ──────────────────────────────────────────────
   Column specs per module, in the design's order. Keys are the ones the list
   had before the redesign, so a saved layout carries over. Money (sen) and
   qty sort on the raw number via getValue; dates on the raw ISO string. */
type ColSpec = {
  key: string;
  label: string;
  /** doc: the row's own number · so: its sales order · date · due: a date
   *  tagged late while open · money · qty · status: the status tag. */
  kind?: 'doc' | 'so' | 'date' | 'due' | 'money' | 'qty' | 'status';
  muted?: boolean;
  /** The cell's value when it is not the row's own field. */
  value?: (r: OutRow) => unknown;
  /** For `due`: whether the document is still open (the date then turns red
   *  once passed; the Completed / All filters show closed rows too). */
  open?: (r: OutRow) => boolean;
  /** Off until the reader turns it on in Columns. */
  hidden?: boolean;
};

/* Still open by the view's own rule (a paid or cancelled document never is),
   and something left on it — the date only turns late then. */
const owes = (r: OutRow): boolean => r.is_outstanding === true && Number(r.outstanding_sen) > 0;

const MODULE_COLUMNS: Record<OutstandingModule, ColSpec[]> = {
  si: [
    { key: 'invoice_number', label: 'Invoice No', kind: 'doc' },
    { key: 'invoice_date',   label: 'Date', kind: 'date', muted: true },
    { key: 'due_date',       label: 'Due', kind: 'due', open: owes },
    { key: 'debtor_name',    label: 'Customer' },
    { key: 'total_sen',      label: 'Total', kind: 'money' },
    { key: 'paid_sen',       label: 'Paid', kind: 'money', muted: true },
    /* The deposit taken on the source Sales Order. `outstanding_sen` on these
       rows is ALREADY net of it (the /outstanding/si handler subtracts it —
       the view scm.v_si_outstanding cannot, the split is a per-order rule), so
       this column is what makes the smaller Outstanding readable instead of
       mysterious. */
    { key: 'so_deposit_applied_sen', label: 'SO deposit', kind: 'money', muted: true },
    /* The customers' credit notes knocked off it (owner 2026-11-03: 「要」), served
       beside the deposit and, like it, already out of outstanding_sen. */
    { key: 'credit_notes_sen', label: 'Credit notes', kind: 'money', muted: true },
    { key: 'outstanding_sen', label: 'Outstanding', kind: 'money' },
    { key: 'status',         label: 'Status', kind: 'status' },
  ],
  so: [
    { key: 'doc_no',      label: 'SO No', kind: 'doc' },
    { key: 'so_date',     label: 'Date', kind: 'date', muted: true },
    { key: 'debtor_name', label: 'Customer' },
    { key: 'status',      label: 'Status', kind: 'status' },
    { key: 'total_revenue_sen', label: 'Total', kind: 'money' },
  ],
  do: [
    { key: 'do_number',   label: 'DO No', kind: 'doc' },
    { key: 'do_date',     label: 'Date', kind: 'date', muted: true },
    { key: 'so_doc_no',   label: 'SO No.', kind: 'so' },
    { key: 'debtor_name', label: 'Customer' },
    { key: 'status',      label: 'Status', kind: 'status' },
  ],
  po: [
    { key: 'po_number',   label: 'PO No', kind: 'doc' },
    { key: 'po_date',     label: 'Date', kind: 'date', muted: true },
    { key: 'expected_at', label: 'Expected', kind: 'due', open: (r) => r.is_outstanding === true && Number(r.qty_outstanding) > 0 },
    { key: 'status',      label: 'Status', kind: 'status' },
    { key: 'qty_outstanding', label: 'Qty outstanding', kind: 'qty' },
    { key: 'total_sen',   label: 'Total', kind: 'money' },
  ],
  grn: [
    { key: 'grn_number',  label: 'GRN No', kind: 'doc' },
    { key: 'received_at', label: 'Date', kind: 'date', muted: true },
    { key: 'status',      label: 'Status', kind: 'status' },
  ],
  pi: [
    { key: 'invoice_number', label: 'Invoice No', kind: 'doc' },
    { key: 'invoice_date',   label: 'Date', kind: 'date', muted: true },
    { key: 'due_date',       label: 'Due', kind: 'due', open: owes },
    { key: 'total_sen',      label: 'Total', kind: 'money' },
    { key: 'paid_sen',       label: 'Paid', kind: 'money', muted: true },
    { key: 'outstanding_sen', label: 'Outstanding', kind: 'money' },
    { key: 'status',         label: 'Status', kind: 'status' },
  ],
  pr: [
    { key: 'return_number', label: 'PR No', kind: 'doc' },
    { key: 'return_date',   label: 'Date', kind: 'date', muted: true },
    { key: 'status',        label: 'Status', kind: 'status' },
    { key: 'refund_sen',    label: 'Refund', kind: 'money' },
  ],
};

/* Near the design's proportions, so the ten sales-invoice columns open without
   squeezing a date or an amount on a laptop; the customer takes what is left. */
const widthOf = (spec: ColSpec): string | undefined => {
  switch (spec.kind) {
    case 'money':
    case 'qty': return '110px';
    case 'due': return '150px';
    case 'date': return '104px';
    case 'status': return '124px';
    case 'doc':
    case 'so': return '132px';
    default: return undefined;
  }
};

const rawOf = (spec: ColSpec, r: OutRow): unknown => (spec.value ? spec.value(r) : r[spec.key]);
const senOf = (spec: ColSpec, r: OutRow): number => Number(rawOf(spec, r)) || 0;
const textOf = (v: unknown): string => (v == null ? '' : String(v));
/* A cancelled document's amounts read "—" and stay out of the totals (the
   Completed / All lists carry them); its number is struck, its row faded. */
const isDead = (r: OutRow): boolean => isCancelledDocStatus(textOf(r.status));

/** A sales invoice counts as part-paid once money, its order's deposit or a
 *  credit note has gone against it (the design's Partly paid). */
const partlyPaid = (r: OutRow): boolean =>
  Number(r.paid_sen ?? 0) + Number(r.so_deposit_applied_sen ?? 0) + Number(r.credit_notes_sen ?? 0) > 0;

const statusTagOf = (module: OutstandingModule, r: OutRow) =>
  outstandingStatusTag(module, textOf(r.status), r.is_outstanding === true, module === 'si' && partlyPaid(r));

/** What a cell reads as text — the search matches it, alongside the raw date. */
const cellText = (module: OutstandingModule, spec: ColSpec, r: OutRow, today: string): string => {
  const v = rawOf(spec, r);
  switch (spec.kind) {
    case 'money': return isDead(r) ? '—' : fmtSen(senOf(spec, r));
    case 'qty': return (Number(v) || 0).toLocaleString('en-MY');
    case 'date': return fmtDate(textOf(v) || null);
    case 'due': return dueDateTag(textOf(v), spec.open?.(r) ?? false, today)?.text ?? '—';
    case 'status': return statusTagOf(module, r).text;
    default: return textOf(v) || '—';
  }
};

const ModuleTable = ({
  module, rows, isLoading, error, mode, today,
}: {
  module: OutstandingModule;
  rows: OutRow[];
  isLoading: boolean;
  error: unknown;
  mode: OutstandingFilterMode;
  today: string;
}) => {
  const navigate = useNavigate();
  const config = MODULES.find((m) => m.value === module) ?? MODULES[0];

  type KeyedRow = OutRow & { __rk: string };
  const columns = useMemo<Column<KeyedRow>[]>(() => MODULE_COLUMNS[module].map((spec) => {
    const numeric = spec.kind === 'money' || spec.kind === 'qty';
    const col: Column<KeyedRow> = {
      key: spec.key,
      label: spec.label,
      width: widthOf(spec),
      align: numeric ? 'right' : undefined,
      defaultHidden: spec.hidden,
      /* Sort, funnel and export read what the cell shows: the number, the raw
         ISO date, the status's word (never its stored key). */
      getValue: (r) => (numeric ? Number(rawOf(spec, r)) || 0
        : spec.kind === 'status' ? statusTagOf(module, r).text
        : textOf(rawOf(spec, r))),
      render: (r) => {
        const v = rawOf(spec, r);
        switch (spec.kind) {
          case 'doc':
            return (
              <DocLink to={config.route(r)} className={cancelledDocNoClass(textOf(r.status))}>
                {textOf(v) || '—'}
              </DocLink>
            );
          case 'so':
            return textOf(v) ? <DocLink to={`/scm/sales-orders/${textOf(v)}`}>{textOf(v)}</DocLink> : '—';
          case 'due': {
            const tag = dueDateTag(textOf(v), spec.open?.(r) ?? false, today);
            return tag ? <StatusTag tag={tag} /> : '—';
          }
          case 'status':
            return <StatusTag tag={statusTagOf(module, r)} />;
          default: {
            const text = cellText(module, spec, r, today);
            return spec.muted ? <span className={s.muted}>{text}</span> : text;
          }
        }
      },
    };
    if (spec.kind === 'money') {
      // Ringgit, not sen, in the file; a cancelled document's amount blank as on screen.
      col.exportValue = (r) => (isDead(r) ? null : senOf(spec, r) / 100);
      col.exportFormat = 'money';
      col.total = (list) => fmtSen(list.reduce((sum, r) => sum + (isDead(r) ? 0 : senOf(spec, r)), 0));
    }
    return col;
  }), [module, config, today]);

  /* Rows can lack a stable id for some modules — pre-compute a row key that
     falls back to doc_no then the index (matches the legacy <tr key>). */
  const keyedRows: KeyedRow[] = useMemo(
    () => rows.map((r, i) => ({ ...r, __rk: textOf(r.id ?? r.doc_no ?? i) })),
    [rows],
  );

  /* Loaded-only search across the module's columns as they read on screen
     (and the raw ISO dates), the page filtering and DataTable rendering the box
     and its hint. The table remounts per module (key= above), so the term never
     leaks across cards. The SO / DO / SI rows also carry their order's customer
     reference (stamped server-side), which the search matches without a
     column. */
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return keyedRows;
    const specs = MODULE_COLUMNS[module];
    return keyedRows.filter((r) =>
      specs.some((spec) =>
        cellText(module, spec, r, today).toLowerCase().includes(term)
        || ((spec.kind === 'date' || spec.kind === 'due') && textOf(rawOf(spec, r)).includes(term)))
      || soRefOfStamp(r as SoRefStamp).toLowerCase().includes(term),
    );
  }, [keyedRows, search, module, today]);

  return (
    <DataTable<KeyedRow>
      tableId={`outstanding-${module}`}
      layoutFamily={`outstanding-${module}`}
      exportName={`outstanding-${module}`}
      rows={isLoading ? null : visible}
      loading={isLoading}
      error={errorText(error)}
      emptyLabel={search.trim()
        ? 'Nothing matches this search.'
        : mode === 'completed' ? 'Nothing completed in these dates.' : 'Nothing outstanding in these dates.'}
      getRowKey={(r) => r.__rk}
      columns={columns}
      onRowDoubleClick={(r) => navigate(config.route(r))}
      getRowClassName={(r) => cancelledRowClass(textOf(r.status))}
      /* The design's sand tint: a sales invoice still owed. */
      getRowStyle={(r) => (module === 'si' && r.is_outstanding === true ? { background: 'var(--open-bg)' } : undefined)}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: `Search ${config.title.toLowerCase()}…`,
      }}
    />
  );
};

/* ── PO chasing — line-level, cross-company outstanding PO list ───────────────
   The AutoCount "PO chasing list" shape: one row per outstanding PO line,
   grouped by supplier, with a Detail (component lines) / By set switch and an
   Excel export. Reads the cross-company /outstanding/po-lines (HOUZS + 2990),
   so it carries a Company column and an optional company filter the module
   lists don't have. Rolling sofa components into one "set" row is a heuristic
   — see po-outstanding-rollup.ts. */
type ChaseSpec = {
  key: string;
  label: string;
  width?: string;
  align?: 'right';
  kind?: 'date' | 'qty';
  overdue?: (r: PoOutstandingLineRow) => boolean;
  get: (r: PoOutstandingLineRow) => string | number;
};

/** A cell as the reader sees it (dates through fmtDate); `forExport` keeps the
 *  raw ISO date the Excel file has always carried. */
const chaseText = (spec: ChaseSpec, r: PoOutstandingLineRow, forExport = false): string => {
  const v = spec.get(r);
  if (spec.kind === 'qty') return (Number(v) || 0).toLocaleString();
  if (spec.kind === 'date') return v ? (forExport ? String(v) : fmtDate(String(v))) : '—';
  const text = String(v).trim();
  return text === '' ? '—' : text;
};

const GRANULARITY_OPTIONS: { value: 'detail' | 'set'; label: string }[] = [
  { value: 'detail', label: 'Detail (lines)' },
  { value: 'set', label: 'By set' },
];

const PoChasingView = ({ rows, isLoading, error }: { rows: PoOutstandingLineRow[]; isLoading: boolean; error: unknown }) => {
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
    { key: 'delivery_date', label: 'Delivery Date', kind: 'date', overdue: (r) => Number(r.remaining_qty ?? 0) > 0, get: (r) => String(r.delivery_date ?? '') },
    // AutoCount's three supplier dates (UDF_EDate/2/3), in the positions the
    // owner kept on 2026-09-12. The server resolves each one (line, else PO
    // header) through the same rule as the PO line export; the names come from
    // that rule too (po-line-export-columns.ts).
    ...PO_ESTIMATE_DELIVERY_DATE_LABELS.map((label, i) => {
      const key = `estimate_delivery_date_${i + 1}` as const;
      return { key, label, kind: 'date' as const, get: (r: PoOutstandingLineRow) => String(r[key] ?? '') };
    }),
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
      render: (r: KeyedRow) =>
        spec.overdue && isPastDue(String(spec.get(r)), spec.overdue(r))
          ? <span className={OVERDUE_CLASS} title="Delivery date passed, still outstanding">{chaseText(spec, r)}</span>
          : chaseText(spec, r),
    })),
    [specs],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return keyed;
    return keyed.filter((r) => specs.some((sp) =>
      chaseText(sp, r).toLowerCase().includes(term) || (sp.kind === 'date' && chaseText(sp, r, true).includes(term))));
  }, [keyed, specs, search]);

  const onExport = async () => {
    const XLSX = await import('../../lib/xlsx-runtime');
    const header = specs.map((sp) => sp.label);
    const aoa: (string | number)[][] = [header, ...visible.map((r) => specs.map((sp) => chaseText(sp, r, true)))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = specs.map((sp) => ({ wch: Math.min(42, Math.max(10, sp.label.length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PO Chasing');
    XLSX.writeFileXLSX(wb, `PO-Chasing-${granularity}-${todayMyt()}.xlsx`);
  };

  const companyOptions: ChipOption<string>[] = [
    { value: '', label: 'All companies' },
    ...companyCodes.map((code) => ({ value: code, label: code })),
  ];

  return (
    <div className={s.stack}>
      <div className={s.toolbar}>
        <Segments label="Rows" options={GRANULARITY_OPTIONS} value={granularity} onChange={setGranularity} />
        {companyCodes.length > 1 && (
          <Chips label="Company" options={companyOptions} value={companyFilter} onChange={setCompanyFilter} />
        )}
      </div>
      <DataTable<KeyedRow>
        tableId="outstanding-po-lines"
        layoutFamily="outstanding-po-lines"
        exportName={`PO-Chasing-${granularity}`}
        rows={isLoading ? null : visible}
        loading={isLoading}
        error={errorText(error)}
        emptyLabel={search.trim() ? 'Nothing matches this search.' : 'No outstanding PO lines match the filters.'}
        getRowKey={(r) => r.__rk}
        columns={columns}
        groupBy={{ key: 'creditor_name', label: (v) => v || '—' }}
        onExport={onExport}
        search={{ value: search, onChange: setSearch, placeholder: 'Search PO / item / supplier…' }}
      />
    </div>
  );
};
