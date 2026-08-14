// ----------------------------------------------------------------------------
// DetailListingShell — Task #120 shared L2 (Detail Listing) layout.
//
// Used by the module-specific L2 pages (DO / SI / DR).
// Mirrors the SalesOrderDetailListing structure but extracted as a reusable
// shell so each module-specific page is mostly column definitions + a hook
// call, not a 500-line copy-paste.
//
// Each module owns:
//   - Columns (DataGridColumn<row>[])
//   - The TanStack Query hook that fetches the rows
//   - Module-specific KPI tile labels (defaults sensible)
//   - Identity strings (title, route, storage key)
//
// Outstanding filter is wired here: when ?outstanding=1 is in the URL, we
// filter rows where (balance_centi ?? 0) > 0. Module endpoints compute
// balance_centi server-side so each module decides what "outstanding"
// means for its doc type.
//
// ── HOUZS VENDOR ADAPTATIONS ───────────────────────────────────────────────
//   • react-router → react-router-dom.
//   • flow-queries types → the vendored reports-queries slice.
//   • pdf-common's fmtDocStamp is inlined (the PDF chain isn't vendored).
//   • The Preview button's `import('jspdf')` PDF render is REPLACED with the
//     established jspdf STUB throw — jspdf/jspdf-autotable aren't installed and
//     the vendoring effort can't `npm install`. The button still renders;
//     clicking it surfaces the friendly "PDF export not enabled" message via
//     the page's existing notify() catch. Re-enable by `npm i jspdf
//     jspdf-autotable` and restoring the source render body.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtMoneyCenti } from '../../vendor/shared/format';
import { ArrowLeft, ClipboardList, Printer, Eye, Filter, X, SlidersHorizontal, FileSearch } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import type { UseQueryResult } from '@tanstack/react-query';
import type { DetailListingFilters, DetailListingRow } from '../../vendor/scm/lib/reports-queries';
import styles from '../../pages/scm-v2/SalesOrderDetailListing.module.css';
import { PrintPreviewModal, usePrintPreview } from './PrintPreviewModal';
import { fmtDate } from '@2990s/shared';
import { todayMyt } from '../../vendor/scm/lib/dates';

const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;
const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* Inlined from pdf-common.fmtDocStamp — the PDF chain isn't vendored. */
const fmtDocStamp = (d: Date = new Date()): string => {
  const time = d.toLocaleTimeString('en-MY', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${fmtDate(d)}, ${time}`;
};

const PDF_UNAVAILABLE =
  'PDF export is not enabled in this build yet. (jspdf is not installed for the SCM module.)';

type DateMode = 'range' | 'none';

export type DetailListingKpis = {
  totalLines: number;
  uniqueDocs: number;
  revenue: number;
  cost: number;
  margin: number;
  marginPct: number;
  outstanding: number;
};

export interface DetailListingShellProps<R extends DetailListingRow> {
  title: string;
  /** Stable localStorage key for the DataGrid layout. */
  storageKey: string;
  /** Static placeholder for the doc number filter input ("DO-2605-001" etc.) */
  docNoPlaceholder?: string;
  /** Module-specific KPI tile labels (default: "Total Lines / Unique Docs / Revenue / Cost / Margin / Outstanding"). */
  kpiLabels?: Partial<{
    totalLines: string;
    uniqueDocs: string;
    revenue: string;
    cost: string;
    margin: string;
    outstanding: string;
  }>;
  /** Hide tiles that don't apply (e.g. a return has no margin). */
  hideKpis?: Partial<{
    cost: boolean;
    margin: boolean;
  }>;
  /** TanStack Query hook for this module's detail listing. */
  useDetailQuery: (filters: DetailListingFilters) => UseQueryResult<{ rows: R[] }>;
  /** Columns built per module — passed as a factory so the page can inject
   *  selection state if needed (mirrors the SO L2 pattern). */
  buildColumns: (state: { checked: Record<string, boolean>; onToggle: (id: string) => void }) => DataGridColumn<R>[];
  /** Compute KPI values from the (already outstanding-filtered) row set.
   *  Default: revenue = sum(total_centi), outstanding = sum(balance_centi)
   *  deduped by doc_no, no cost/margin. */
  computeKpis?: (rows: R[]) => DetailListingKpis;
}

// The ONE guarded centi→"<currency> …" formatter — returns "—" for an absent/
// non-finite amount, never "MYR NaN". Kept under the local name so the shell's
// callsites are unchanged.
const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string =>
  fmtMoneyCenti(centi, currency);

const defaultComputeKpis = <R extends DetailListingRow>(rows: R[]): DetailListingKpis => {
  const totalLines = rows.length;
  const uniqueDocs = new Set<string>();
  let revenue = 0;
  const outstandingByDoc = new Map<string, number>();
  for (const r of rows) {
    uniqueDocs.add(r.doc_no);
    revenue += Number(r.total_centi ?? 0);
    if (!outstandingByDoc.has(r.doc_no)) {
      outstandingByDoc.set(r.doc_no, Number(r.balance_centi ?? 0));
    }
  }
  const outstanding = [...outstandingByDoc.values()].reduce((s, v) => s + v, 0);
  return {
    totalLines, uniqueDocs: uniqueDocs.size,
    revenue, cost: 0, margin: 0, marginPct: 0, outstanding,
  };
};

export function DetailListingShell<R extends DetailListingRow>({
  title, storageKey, docNoPlaceholder,
  kpiLabels, hideKpis,
  useDetailQuery, buildColumns, computeKpis,
}: DetailListingShellProps<R>) {
  const notify = useNotify();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const outstandingOnly = searchParams.get('outstanding') === '1';

  const today = todayMyt();
  const yearAgo = todayMyt(-365);
  const [docDateMode, setDocDateMode] = useState<DateMode>('range');
  const [dateFrom, setDateFrom] = useState(yearAgo);
  const [dateTo,   setDateTo]   = useState(today);
  const [docNo,       setDocNo]       = useState('');
  const [debtorCode,  setDebtorCode]  = useState('');
  const [itemCode,    setItemCode]    = useState('');
  const [optionsVisible, setOptionsVisible] = useState(true);
  const [hasRunQuery,    setHasRunQuery]    = useState(false);
  const [criteriaPanel,  setCriteriaPanel]  = useState(false);
  const [showCriteria,   setShowCriteria]   = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [findNonce, setFindNonce] = useState(0);
  const [committed, setCommitted] = useState<DetailListingFilters>({});

  const query = useDetailQuery(hasRunQuery ? committed : {});
  const rawRows = useMemo<R[]>(
    () => (hasRunQuery ? (query.data?.rows ?? []) : []),
    [hasRunQuery, query.data],
  );

  // Outstanding overlay: keep only rows whose document has balance > 0.
  const rows = useMemo<R[]>(() => {
    if (!outstandingOnly) return rawRows;
    return rawRows.filter((r) => Number(r.balance_centi ?? 0) > 0);
  }, [rawRows, outstandingOnly]);

  const kpis = useMemo(
    () => (computeKpis ?? defaultComputeKpis)(rows),
    [rows, computeKpis],
  );

  const onToggle = (id: string) => setChecked((p) => ({ ...p, [id]: !p[id] }));
  const columns = useMemo(() => buildColumns({ checked, onToggle }), [buildColumns, checked]);

  const runInquiry = () => {
    setCommitted({
      dateFrom:   docDateMode === 'range' ? dateFrom : undefined,
      dateTo:     docDateMode === 'range' ? dateTo   : undefined,
      docNo:      docNo.trim()      || undefined,
      debtorCode: debtorCode.trim() || undefined,
      itemCode:   itemCode.trim()   || undefined,
    });
    setHasRunQuery(true);
  };

  /* Print now, from the preview. The inquiry has to have run first or there is
     nothing on the page to print — the 60 ms lets the freshly-set rows paint. */
  const runPrint = () => {
    if (!hasRunQuery) runInquiry();
    setTimeout(() => window.print(), 60);
  };
  const print = usePrintPreview(runPrint);

  // HOUZS VENDOR STUB — the source renders the listing to a PDF via
  // `import('jspdf')` + `import('jspdf-autotable')`. Neither is installed and
  // the vendoring effort can't `npm install`, so Preview surfaces the friendly
  // "not enabled" message through the same notify() the source error path uses.
  // The `fmtDocStamp` helper above is kept (it's cheap + used in the real body
  // when PDFs are re-enabled).
  const generatePreviewPdf = async (data: R[]) => {
    void data; void fmtDocStamp;
    notify({ title: PDF_UNAVAILABLE, tone: 'error' });
  };

  const runPreview = async () => {
    if (!hasRunQuery) {
      runInquiry();
      setTimeout(() => { void generatePreviewPdf(rows); }, 250);
      return;
    }
    await generatePreviewPdf(rows);
  };

  const clearOutstanding = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('outstanding');
    setSearchParams(next, { replace: true });
  };

  const labels = {
    totalLines: kpiLabels?.totalLines ?? 'Total Lines',
    uniqueDocs: kpiLabels?.uniqueDocs ?? 'Unique Docs',
    revenue:    kpiLabels?.revenue    ?? 'Revenue',
    cost:       kpiLabels?.cost       ?? 'Cost',
    margin:     kpiLabels?.margin     ?? 'Margin',
    outstanding: kpiLabels?.outstanding ?? 'Outstanding',
  };

  return (
    /* `print-area` is the app's print opt-in (index.css) — without it the
       global `body * { visibility: hidden }` swallowed this page and Print
       produced a blank sheet. The action bar carries `no-print` so the
       toolbar doesn't land on the paper with the rows. */
    <div className={`${styles.page} print-area ${optionsVisible ? '' : styles.optionsHidden}`}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <button type="button" className={styles.backBtn} onClick={() => navigate(-1)}>
            <ArrowLeft {...ICON} />
            <span>Back</span>
          </button>
          <div>
            <h1 className={styles.title}>
              <ClipboardList size={20} strokeWidth={1.75} style={{ color: 'var(--c-burnt)' }} />
              {title}
              {outstandingOnly && <span style={{ color: 'var(--c-burnt)', marginLeft: 8 }}>· Outstanding only</span>}
            </h1>
            {outstandingOnly && (
              <p className={styles.subtitle}>
                <button type="button" onClick={clearOutstanding}
                  style={{ background: 'transparent', border: 'none', color: 'var(--c-burnt)',
                    cursor: 'pointer', textDecoration: 'underline', font: 'inherit', padding: 0 }}>
                  Clear outstanding filter
                </button>
              </p>
            )}
          </div>
        </div>
      </div>

      {hasRunQuery && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${6 - (hideKpis?.cost ? 1 : 0) - (hideKpis?.margin ? 1 : 0)}, 1fr)`,
          gap: 'var(--space-2)',
        }}>
          {([
            { label: labels.totalLines, value: kpis.totalLines.toString() },
            { label: labels.uniqueDocs, value: kpis.uniqueDocs.toString() },
            { label: labels.revenue,    value: fmtRm(kpis.revenue) },
            !hideKpis?.cost && { label: labels.cost, value: fmtRm(kpis.cost) },
            !hideKpis?.margin && { label: labels.margin,
              value: `${fmtRm(kpis.margin)}${kpis.revenue > 0 ? ` (${kpis.marginPct.toFixed(1)}%)` : ''}`,
              accent: kpis.margin > 0 ? ('good' as const) : kpis.margin < 0 ? ('bad' as const) : null },
            { label: labels.outstanding, value: fmtRm(kpis.outstanding),
              accent: kpis.outstanding > 0 ? ('bad' as const) : null },
          ].filter(Boolean) as Array<{ label: string; value: string; accent?: 'good' | 'bad' | null }>).map(({ label, value, accent }) => (
            <div key={label} className={styles.card} style={{ padding: 'var(--space-2) var(--space-3)' }}>
              <div className={styles.cardTitle} style={{ borderBottom: 'none', padding: 0, fontSize: 'var(--fs-10)' }}>
                {label}
              </div>
              <div style={{
                fontFamily: 'var(--font-sans)',
                fontWeight: 700,
                fontSize: 'var(--fs-14)',
                fontVariantNumeric: 'tabular-nums',
                color: accent === 'good' ? 'var(--c-secondary-a, #2F5D4F)'
                  : accent === 'bad' ? 'var(--c-festive-b, #B8331F)'
                  : 'var(--c-ink)',
              }}>
                {value}
              </div>
            </div>
          ))}
        </div>
      )}

      {optionsVisible && (
        <div className={styles.filterRow}>
          <section className={styles.card}>
            <header className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Basic Filter</h2>
            </header>
            <div className={styles.cardBody}>
              <div className={styles.filterGrid}>
                <div className={`${styles.field} ${styles.filterGridSpan2}`}>
                  <label className={styles.fieldLabel}>Document Date</label>
                  <div className={styles.dateRangeRow}>
                    <select
                      className={styles.fieldSelect}
                      value={docDateMode}
                      onChange={(e) => setDocDateMode(e.target.value as DateMode)}
                    >
                      <option value="range">Filter by range</option>
                      <option value="none">No filter</option>
                    </select>
                    <input type="date" className={styles.fieldInput} value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)} disabled={docDateMode !== 'range'} />
                    <input type="date" className={styles.fieldInput} value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)} disabled={docDateMode !== 'range'} />
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Document No</label>
                  <input type="text" className={styles.fieldInput} value={docNo}
                    onChange={(e) => setDocNo(e.target.value)} placeholder={docNoPlaceholder} />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Debtor Code</label>
                  <input type="text" className={styles.fieldInput} value={debtorCode}
                    onChange={(e) => setDebtorCode(e.target.value)} />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Item Code</label>
                  <input type="text" className={styles.fieldInput} value={itemCode}
                    onChange={(e) => setItemCode(e.target.value)} />
                </div>
              </div>
            </div>
          </section>

          <section className={styles.card}>
            <header className={styles.cardHeader}>
              <h2 className={styles.cardTitle}>Report Options</h2>
            </header>
            <div className={`${styles.cardBody} ${styles.optionsBody}`}>
              <label className={styles.checkboxRow}>
                <input type="checkbox" checked={showCriteria}
                  onChange={(e) => setShowCriteria(e.target.checked)} />
                <span>Show Criteria In Report</span>
              </label>
              <div className={styles.optionsButtonRow}>
                <Button variant="ghost" size="sm" onClick={() => notify({ title: 'More Options — coming soon' })}>
                  <SlidersHorizontal {...SM_ICON} />
                  <span>More Options</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={() => notify({ title: 'Advanced Filter — coming soon' })}>
                  <Filter {...SM_ICON} />
                  <span>Advanced Filter</span>
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}

      <div className={`${styles.actionBar} no-print`}>
        <Button variant="primary" size="sm" onClick={runInquiry}>
          <FileSearch {...SM_ICON} />
          <span>Inquiry</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={runPreview}>
          <Eye {...SM_ICON} />
          <span>Preview</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={print.openPreview}>
          <Printer {...SM_ICON} />
          <span>Print</span>
        </Button>
        {/* The listing prints the page itself (the source's jspdf export is a
            vendor stub here), so Print is the dialog's only exit. */}
        <PrintPreviewModal
          open={print.open}
          onClose={print.close}
          docTitle="Detail Listing"
          docNo={title}
          rows={[
            {
              label: 'Rows',
              value: hasRunQuery
                ? `${rows.length}${outstandingOnly ? ` of ${rawRows.length}` : ''} line items`
                : 'Inquiry has not run yet — it will run first',
            },
            ...(outstandingOnly ? [{ label: 'Filter', value: 'Outstanding only' }] : []),
          ]}
          onPrint={print.handlers.onPrint}
        />
        <Button variant="ghost" size="sm" onClick={() => setOptionsVisible((v) => !v)}>
          <span>{optionsVisible ? 'Hide Options' : 'Show Options'}</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setCriteriaPanel((p) => !p)}>
          <span>Criteria</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <X {...SM_ICON} />
          <span>Close</span>
        </Button>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          {query.isFetching ? 'Loading…' : hasRunQuery ? `${rows.length}${outstandingOnly ? ` of ${rawRows.length}` : ''} line items` : 'Set filters and press Inquiry'}
        </span>
      </div>

      {(criteriaPanel || showCriteria) && (
        <div className={styles.criteriaBox}>
          <div>
            <div className={styles.criteriaKey}>Document Date</div>
            <div>{docDateMode === 'range' ? `${dateFrom} → ${dateTo}` : 'No filter'}</div>
          </div>
          <div>
            <div className={styles.criteriaKey}>Doc No</div>
            <div>{docNo || '—'}</div>
          </div>
          <div>
            <div className={styles.criteriaKey}>Debtor Code</div>
            <div>{debtorCode || '—'}</div>
          </div>
          <div>
            <div className={styles.criteriaKey}>Item Code</div>
            <div>{itemCode || '—'}</div>
          </div>
          {outstandingOnly && (
            <div>
              <div className={styles.criteriaKey}>Outstanding</div>
              <div>Balance &gt; 0 only</div>
            </div>
          )}
        </div>
      )}

      <section className={styles.resultCard}>
        <header className={styles.resultHeader}>
          <h2 className={styles.resultTitle}>
            <ClipboardList size={14} strokeWidth={1.75} />
            Search Result
          </h2>
          <div className={styles.checkboxButtonRow}>
            <Button variant="ghost" size="sm" onClick={() => setFindNonce((n) => n + 1)}>Find</Button>
          </div>
        </header>

        <DataGrid<R>
          rows={rows}
          columns={columns}
          storageKey={storageKey}
          exportName={title}
          rowKey={(r) => r.id}
          searchPlaceholder="Search rows…"
          focusSearchNonce={findNonce}
          isLoading={hasRunQuery && query.isFetching && rawRows.length === 0}
          emptyMessage={
            !hasRunQuery
              ? 'Press Inquiry to run the report.'
              : outstandingOnly
                ? 'No outstanding rows match the current filters.'
                : 'No rows match the current filters.'
          }
        />
      </section>
    </div>
  );
}
