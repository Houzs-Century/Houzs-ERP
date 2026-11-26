
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtMoneySen } from '../../vendor/shared/format';
import { ArrowLeft, ClipboardList, Printer, Eye, Filter, X, SlidersHorizontal, FileSearch } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { DataGridCompat, type GridColumn } from '../../components/DataGridCompat';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import type { UseQueryResult } from '@tanstack/react-query';
import type { DetailListingFilters, DetailListingRow } from '../../vendor/scm/lib/reports-queries';
import styles from './DetailListingShell.module.css';
import { PrintPreviewModal, usePrintPreview } from './PrintPreviewModal';
import { fmtDate, fmtDateTime } from '../../vendor/shared/format';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { DateField } from "../../vendor/scm/components/DateField";
import { printPageAs } from '../../lib/printFrame';

const SM_ICON = { size: 14, strokeWidth: 1.75 } as const;
const ICON = { size: 16, strokeWidth: 1.75 } as const;

const fmtDocStamp = (d: Date = new Date()): string => fmtDateTime(d);

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
  storageKey: string;
  docNoPlaceholder?: string;
  kpiLabels?: Partial<{
    totalLines: string;
    uniqueDocs: string;
    revenue: string;
    cost: string;
    margin: string;
    outstanding: string;
  }>;
  hideKpis?: Partial<{
    cost: boolean;
    margin: boolean;
  }>;
  useDetailQuery: (filters: DetailListingFilters) => UseQueryResult<{ rows: R[] }>;
  buildColumns: (state: { checked: Record<string, boolean>; onToggle: (id: string) => void }) => GridColumn<R>[];
  computeKpis?: (rows: R[]) => DetailListingKpis;
}

const fmtRm = (centi: number | null | undefined, currency = 'MYR'): string =>
  fmtMoneySen(centi, currency);

const defaultComputeKpis = <R extends DetailListingRow>(rows: R[]): DetailListingKpis => {
  const totalLines = rows.length;
  const uniqueDocs = new Set<string>();
  let revenue = 0;
  const outstandingByDoc = new Map<string, number>();
  for (const r of rows) {
    uniqueDocs.add(r.doc_no);
    revenue += Number(r.total_sen ?? 0);
    if (!outstandingByDoc.has(r.doc_no)) {
      outstandingByDoc.set(r.doc_no, Number(r.balance_sen ?? 0));
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

  const rows = useMemo<R[]>(() => {
    if (!outstandingOnly) return rawRows;
    return rawRows.filter((r) => Number(r.balance_sen ?? 0) > 0);
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

  const [pendingOutput, setPendingOutput] = useState<'print' | 'preview' | null>(null);
  const queryReady = hasRunQuery && !query.isFetching;

  const runPrint = () => {
    if (!hasRunQuery) runInquiry();
    setPendingOutput('print');
  };
  const print = usePrintPreview(runPrint);

  const generatePreviewPdf = async (data: R[]) => {
    void data; void fmtDocStamp;
    notify({ title: PDF_UNAVAILABLE, tone: 'error' });
  };

  const runPreview = () => {
    if (!hasRunQuery) runInquiry();
    setPendingOutput('preview');
  };

  useEffect(() => {
    if (!pendingOutput || !queryReady) return;
    setPendingOutput(null);
    if (query.isError) {
      void notify({ title: 'The listing could not be loaded, so there is nothing to print.', tone: 'error' });
      return;
    }
    if (pendingOutput === 'print') printPageAs(title);
    else void generatePreviewPdf(rows);
  });

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
                color: accent === 'good' ? 'var(--c-secondary-a, var(--hz-dk-secondary-a, #2F5D4F))'
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
                    <DateField
                      fullWidth
                      className={styles.fieldInput}
                      value={dateFrom}
                      onChange={(iso) => setDateFrom(iso)}
                      disabled={docDateMode !== 'range'}
                    />
                    <DateField
                      fullWidth
                      className={styles.fieldInput}
                      value={dateTo}
                      onChange={(iso) => setDateTo(iso)}
                      disabled={docDateMode !== 'range'}
                    />
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Document No</label>
                  <input type="text" className={styles.fieldInput} value={docNo}
                    onChange={(e) => setDocNo(e.target.value)} placeholder={docNoPlaceholder} />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Customer</label>
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
            <div className={styles.criteriaKey}>Customer</div>
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

        <DataGridCompat<R>
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
