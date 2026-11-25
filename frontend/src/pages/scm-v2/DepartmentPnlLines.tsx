// ----------------------------------------------------------------------------
// DepartmentPnlLines — what a figure of the Department P&L opens under its line
// (owner 2026-11-20: 「我希望这里点开也能看」), in the P&L's own lines dress: a head
// with the row, the column and its period, "Open in General ledger ›" (Back
// returns here) and ×, then the lines, totalled — the total IS the figure.
// The Operation sheet's lines come with the report (its rows are them added up);
// a department's own P&L and G&A read theirs when a figure is opened
// (GET /acc-events/departments/lines), split by the rules that made the figure.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BookOpen, ChevronRight, X } from 'lucide-react';
import { DataTable, type Column } from '../../components/DataTable';
import { fmtDate } from '../../vendor/shared/format';
import { ledgerHref } from '../../vendor/scm/lib/report-layout';
import { useDepartmentLines, type DeptEntry, type DeptLinesAsk } from '../../vendor/scm/lib/department-queries';
import { fmtMoney } from './reports/FinanceGrid';
import { monthName } from './reports/statementColumns';
import st from './reports/Statement.module.css';
import s from './DepartmentPnlLines.module.css';

/** One line as the panel prints it. */
export type DrillRow = {
  id: string;
  /** Its date; a figure of the Logistics cost report has its month only. */
  day: string | null;
  month: string;
  /** The sheet's row it is on, where the figure adds several (a block's total). */
  row: string | null;
  region: string | null;
  ref: string | null;
  account: string | null;
  text: string | null;
  /** How the amount was arrived at (a share of a line, a month of a spread bill), under its words. */
  how: string | null;
  sen: number;
};

/** The General ledger the head links to: the accounts the lines are on, over the dates they cover. */
export type DrillLedger = { codes: string[]; from: string; to: string } | null;

const shown = (rows: readonly DrillRow[], k: keyof DrillRow) => rows.some((r) => r[k] != null && r[k] !== '');

/* Narrow enough that a row's lines fit the report's own width, the Amount in sight;
   the table widens with the report. */
function columnsOf(rows: readonly DrillRow[]): Column<DrillRow>[] {
  const cols: Column<DrillRow>[] = [
    { key: 'date', label: 'Date', width: '120px', getValue: (r) => r.day ?? r.month, render: (r) => (r.day ? fmtDate(r.day) : monthName(`${r.month}-01`)) },
  ];
  if (shown(rows, 'row')) cols.push({ key: 'row', label: 'Row', width: '150px', getValue: (r) => r.row ?? '', render: (r) => r.row ?? '—' });
  if (shown(rows, 'region')) cols.push({ key: 'region', label: 'Region', width: '92px', getValue: (r) => r.region ?? '', render: (r) => r.region ?? '—' });
  if (shown(rows, 'ref')) cols.push({ key: 'ref', label: 'Ref.', width: '104px', getValue: (r) => r.ref ?? '', render: (r) => r.ref ?? '—' });
  if (shown(rows, 'account')) cols.push({ key: 'account', label: 'Account', width: '180px', getValue: (r) => r.account ?? '', render: (r) => r.account ?? '—' });
  cols.push({
    key: 'text', label: 'Description', width: '220px', getValue: (r) => [r.text, r.how].filter(Boolean).join(' — '),
    render: (r) => (r.how ? (
      <span title={`${r.text ?? ''}${r.text ? ' — ' : ''}${r.how}`}><span className={s.text}>{r.text ?? '—'}</span><span className={s.how}>{r.how}</span></span>
    ) : r.text ?? '—'),
  });
  cols.push({
    key: 'amount', label: 'Amount', align: 'right', width: '116px', getValue: (r) => r.sen / 100, render: (r) => fmtMoney(r.sen),
    total: (list) => fmtMoney(list.reduce((t, r) => t + r.sen, 0)),
  });
  return cols;
}

function Head({ title, sub, count, ledger, onClose }: { title: string; sub: string; count: number | null; ledger: DrillLedger; onClose: () => void }) {
  const location = useLocation();
  const back = { to: `${location.pathname}${location.search}`, label: 'Department P&L' };
  const lines = count == null ? '' : ` · ${count === 1 ? '1 line' : `${count.toLocaleString('en-US')} lines`}`;
  return (
    <div className={st.linesHead}>
      <BookOpen size={14} strokeWidth={1.75} aria-hidden className={st.linesIcon} />
      <span className={st.linesTitle}>
        <span className={st.linesName}>{title}</span>
        <span className={st.linesSub}> · {sub}{lines}</span>
      </span>
      {ledger && ledger.codes.length > 0 && (
        <Link to={`${ledgerHref(ledger.codes, ledger.from, ledger.to)}&in=reports`} state={{ back }} className={st.linesGl}>
          Open in General ledger<ChevronRight size={13} strokeWidth={2} aria-hidden />
        </Link>
      )}
      <button type="button" className={st.linesClose} title="Close the lines" aria-label="Close the lines" onClick={onClose}>
        <X size={12} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}

function Lines({ rows }: { rows: DrillRow[] }) {
  const columns = useMemo(() => columnsOf(rows), [rows]);
  return <DataTable<DrillRow> tableId="dept-pnl-lines" embedded columns={columns} rows={rows} getRowKey={(r) => r.id} emptyLabel="No line behind this figure." />;
}

/** Lines in hand: the Operation sheet's, filtered to the figure's row, months and regions. */
export function DrillPanel({ title, sub, rows, ledger, onClose }: { title: string; sub: string; rows: DrillRow[]; ledger: DrillLedger; onClose: () => void }) {
  return (
    <div role="region" aria-label={`Lines of ${title}`}>
      <Head title={title} sub={sub} count={rows.length} ledger={ledger} onClose={onClose} />
      <Lines rows={rows} />
    </div>
  );
}

const entryRow = (e: DeptEntry): DrillRow => ({
  id: e.id, day: e.day, month: e.month, row: null, region: null, ref: e.ref,
  account: `${e.accountCode}${e.accountName ? ` · ${e.accountName}` : ''}`, text: e.text,
  how: e.source === 'bill' ? `The commission bill for ${monthName(`${e.month}-01`)}, in place of the monthly release` : null,
  sen: e.sen,
});

/** Lines read when opened: a figure of a department's own P&L or G&A. */
export function DeptLinesPanel({ title, sub, ask, onClose }: { title: string; sub: string; ask: DeptLinesAsk; onClose: () => void }) {
  const q = useDepartmentLines(ask);
  const rows = useMemo(() => (q.data?.lines ?? []).map(entryRow), [q.data]);
  const ledger = useMemo<DrillLedger>(() => {
    const codes = [...new Set((q.data?.lines ?? []).filter((l) => l.source === 'ledger').map((l) => l.accountCode))];
    return codes.length > 0 ? { codes, from: ask.from, to: ask.to } : null;
  }, [q.data, ask.from, ask.to]);
  return (
    <div role="region" aria-label={`Lines of ${title}`}>
      <Head title={title} sub={sub} count={q.data ? rows.length : null} ledger={ledger} onClose={onClose} />
      {q.isLoading && <p className={st.linesState}>Reading the lines…</p>}
      {q.isError && <p className={st.linesError}>The lines did not load — {q.error instanceof Error ? q.error.message : String(q.error)}</p>}
      {q.data && <Lines rows={rows} />}
    </div>
  );
}
