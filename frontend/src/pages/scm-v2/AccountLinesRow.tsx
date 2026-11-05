// ----------------------------------------------------------------------------
// An account's lines for the report's period, opened under its row on the
// statement itself — read from the General Ledger's own endpoint so the two
// never disagree (the owner's Claude Design, batch 6 §4.1): a head with the
// account and the period, "Open in General ledger ›" (the full ledger page,
// with Back to this report) and × to close, then the lines as a Finance-Table
// (rep-lines): Date · Description · Other side · Ref. 1 · Ref. 2 · Debit ·
// Credit, totalled.
// ----------------------------------------------------------------------------

import { Link, useLocation } from 'react-router-dom';
import { BookOpen, ChevronRight, X } from 'lucide-react';
import { DataTable, type Column } from '../../components/DataTable';
import { fmtDate } from '../../vendor/shared/format';
import { ledgerHref } from '../../vendor/scm/lib/report-layout';
import { counterLabel, fmtLedger, fmtSide, useLedger, type LedgerLine } from '../../vendor/scm/lib/ledger-queries';
import { ACCOUNTING_TAB_TITLES, accountingTabFromSearch } from './accounting-tabs';
import s from './reports/Statement.module.css';

const COLUMNS: Column<LedgerLine>[] = [
  { key: 'date', label: 'Date', width: '96px', getValue: (l) => l.date, render: (l) => fmtDate(l.date) },
  { key: 'description', label: 'Description', getValue: (l) => l.description ?? '', render: (l) => l.description ?? '—' },
  { key: 'other', label: 'Other side', getValue: (l) => counterLabel(l.counter), render: (l) => counterLabel(l.counter) || '—' },
  { key: 'ref1', label: 'Ref. 1', getValue: (l) => l.doc ?? '', render: (l) => l.doc ?? '—' },
  { key: 'ref2', label: 'Ref. 2', getValue: (l) => l.doc2 ?? '', render: (l) => l.doc2 ?? '—' },
  {
    key: 'debit', label: 'Debit', align: 'right', width: '120px', getValue: (l) => l.debitSen / 100, render: (l) => fmtSide(l.debitSen),
    total: (rows) => fmtLedger(rows.reduce((t, l) => t + l.debitSen, 0)),
  },
  {
    key: 'credit', label: 'Credit', align: 'right', width: '120px', getValue: (l) => l.creditSen / 100, render: (l) => fmtSide(l.creditSen),
    total: (rows) => fmtLedger(rows.reduce((t, l) => t + l.creditSen, 0)),
  },
];

/** What Back on the General ledger reads: the report this row sits on. */
function reportName(pathname: string, search: string): string {
  const tab = accountingTabFromSearch(new URLSearchParams(search).get('tab'));
  if (pathname === '/scm/accounting' && tab) return ACCOUNTING_TAB_TITLES[tab];
  return 'the report';
}

export const AccountLinesRow = ({ code, from, to, colSpan, title, onClose }: {
  code: string;
  from: string;
  to: string;
  colSpan: number;
  /** The account as the head names it; its code when absent. */
  title?: string;
  /** × closes the lines; without it the row stays until its opener closes it. */
  onClose?: () => void;
}) => {
  const q = useLedger({ from, to, accounts: [code] });
  const location = useLocation();
  const block = q.data?.blocks.find((b) => b.code === code) ?? null;
  const lines = block?.lines ?? [];
  const period = from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
  const back = { to: `${location.pathname}${location.search}`, label: reportName(location.pathname, location.search) };
  return (
    <tr data-lines-of={code} className={s.linesRow}>
      <td colSpan={colSpan}>
        <div className={s.lines} role="region" aria-label={`Lines of ${title ?? code}`}>
          <div className={s.linesHead}>
            <BookOpen size={14} strokeWidth={1.75} aria-hidden className={s.linesIcon} />
            <span className={s.linesTitle}>
              <span className={s.linesName}>{title ?? code}</span>
              <span className={s.linesSub}> · {period}</span>
            </span>
            <Link to={`${ledgerHref([code], from, to)}&in=reports`} state={{ back }} className={s.linesGl}>
              Open in General ledger<ChevronRight size={13} strokeWidth={2} aria-hidden />
            </Link>
            {onClose && (
              <button type="button" className={s.linesClose} title="Close the lines" aria-label="Close the lines" onClick={onClose}>
                <X size={12} strokeWidth={2} aria-hidden />
              </button>
            )}
          </div>
          {q.isLoading && <p className={s.linesState}>Reading the lines…</p>}
          {q.isError && <p className={s.linesError}>The lines did not load.</p>}
          {q.data && lines.length === 0 && <p className={s.linesState}>No line on {code} between {fmtDate(from)} and {fmtDate(to)}.</p>}
          {lines.length > 0 && (
            <DataTable<LedgerLine>
              tableId="rep-lines"
              embedded
              columns={COLUMNS}
              rows={lines}
              getRowKey={(l) => l.lineId}
            />
          )}
        </div>
      </td>
    </tr>
  );
};
