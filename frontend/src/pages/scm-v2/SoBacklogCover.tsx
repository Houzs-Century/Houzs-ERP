
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { useSoBacklogCover, type Count, type CoverPart, type CoverRow, type SoBacklogCoverData } from '../../vendor/scm/lib/so-backlog-cover-queries';
import { fmtDate, fmtQty, fmtSenPlain } from '../../../../shared/src/vendor/shared/format';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { MonthSelect } from './ProductChanges';
import { monthBounds, periodText, pickableMonths } from './product-changes-view';
import { monthName } from './reports/statementColumns';
import {
  COVER_NOTES, PART_LABEL, averagePeriod, avgFromOf, coverSheet, firstOfText, ordersText, partText, partViewOf, rowsOfPart, shareText,
  type PartView,
} from './so-backlog-cover-view';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, ReportTool, ReportToolbar, useReportSubtitle, type ReportTile,
} from './reports/reportParts';
import { useReportRange } from './reports/useReportRange';
import s from './SoBacklogCover.module.css';

const FIRST_MONTH = '2026-06';

const COLUMNS: Column<CoverRow>[] = [
  {
    key: 'doc_no', label: 'Order', width: '200px', getValue: (r) => r.docNo, searchValue: (r) => `${r.docNo} ${r.customer ?? ''}`,
    exportValue: (r) => r.docNo,
    render: (r) => (
      <span className={s.stack}>
        <FinanceDocLink to={`/scm/sales-orders/${encodeURIComponent(r.docNo)}`}>{r.docNo}</FinanceDocLink>
        {r.customer && <span className={s.muted}>{r.customer}</span>}
      </span>
    ),
  },
  { key: 'so_date', label: 'Order date', getValue: (r) => r.soDate, exportValue: (r) => r.soDate, render: (r) => fmtDate(r.soDate) },
  {
    key: 'processed_on', label: 'Processing date', getValue: (r) => r.processedOn,
    exportValue: (r) => `${r.processedOn}${r.dateFrom === 'first_do' ? ' (first DO)' : ''}`,
    render: (r) => (
      <span className={s.docLine}>
        <span>{fmtDate(r.processedOn)}</span>
        {r.dateFrom === 'first_do' && <span className={s.tag} title="No Processing Date: counted on its first DO date">First DO</span>}
      </span>
    ),
  },
  {
    key: 'part', label: 'Part', getValue: (r) => partText(r), exportValue: (r) => `${partText(r)}${r.imported ? ' (imported)' : ''}`,
    render: (r) => (
      <span className={s.docLine}>
        <span>{partText(r)}</span>
        {r.imported && <span className={s.tag} title="Brought over from AutoCount at the cutover">Imported</span>}
      </span>
    ),
  },
  {
    key: 'amount', label: 'Amount', align: 'right', width: '140px', description: "The order's total",
    getValue: (r) => r.amountSen / 100, exportValue: (r) => r.amountSen / 100, exportFormat: 'money',
    render: (r) => <span className={s.num}>{fmtSenPlain(r.amountSen)}</span>,
  },
];

const avgTile = (key: string, label: string, avg: number | null, period: string): ReportTile => ({ key, label, value: shareText(avg), sub: period });

const Both = ({ c }: { c: Count }) => (
  <span className={s.stack}><span>{fmtSenPlain(c.amountSen)}</span><span className={s.muted}>{ordersText(c.orders)}</span></span>
);

function MonthsTable({ d }: { d: SoBacklogCoverData }) {
  return (
    <section className={s.card} aria-label="Backlog cover by month">
      <table className={s.months}>
        <thead>
          <tr>
            <th>Month</th><th>Backlog at the 1st</th><th>Backlog processed</th><th>Processed in month</th>
            <th>On backlog · amount</th><th>On backlog · orders</th><th>On month · amount</th><th>On month · orders</th>
          </tr>
        </thead>
        <tbody>
          {d.months.map((m) => (
            <tr key={m.month} className={m.month === d.month ? s.current : undefined}>
              <td>{monthName(`${m.month}-01`)}</td>
              <td className={s.num}><Both c={m.backlog} /></td>
              <td className={s.num}><Both c={m.backlogProcessed} /></td>
              <td className={s.num}><Both c={m.processed} /></td>
              <td className={s.num}>{shareText(m.amount.onBacklog)}</td>
              <td className={s.num}>{shareText(m.orders.onBacklog)}</td>
              <td className={s.num}>{shareText(m.amount.onMonth)}</td>
              <td className={s.num}>{shareText(m.orders.onMonth)}</td>
            </tr>
          ))}
          <tr className={s.average}>
            <td>Average</td><td /><td /><td />
            <td className={s.num}>{shareText(d.average.amount.onBacklog)}</td>
            <td className={s.num}>{shareText(d.average.orders.onBacklog)}</td>
            <td className={s.num}>{shareText(d.average.amount.onMonth)}</td>
            <td className={s.num}>{shareText(d.average.orders.onMonth)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

export const SoBacklogCoverTab = () => {
  const r = useReportRange();
  const [params, setParams] = useSearchParams();
  const month = (r.usable ? r.from : r.today).slice(0, 7);
  const view = partViewOf(params.get('part'));
  const avgFrom = avgFromOf(params.get('avg'), month);
  const setParam = (key: string, v: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v === null) next.delete(key); else next.set(key, v);
    return next;
  }, { replace: true });
  const setView = (v: PartView) => setParam('part', v === 'all' ? null : v);
  const pickMonth = (ym: string) => { const m = monthBounds(ym); r.setRange(m.from, m.to); };
  const months = useMemo(() => pickableMonths(r.today, FIRST_MONTH), [r.today]);
  const avgMonths = useMemo(() => pickableMonths(`${month}-01`, FIRST_MONTH), [month]);

  const q = useSoBacklogCover(month, avgFrom);
  const d = q.data;
  const rows = useMemo(() => rowsOfPart(d?.rows ?? [], view), [d, view]);
  const period = periodText(`${month}-01`, monthBounds(month).to);
  useReportSubtitle(`${period} · by Processing Date · RM`);
  const pickAvg = (ym: string) => setParam('avg', d && ym === d.defaultFrom ? null : ym);

  const partTile = (p: CoverPart): ReportTile => ({
    key: p, label: PART_LABEL[p],
    value: <>{fmtSenPlain(d!.parts[p].amountSen)}<span className={s.share} title="Share of the month's processed total">{shareText(d!.parts[p].pct)}</span></>,
    sub: ordersText(d!.parts[p].orders),
    onClick: () => setView(view === p ? 'all' : p), on: view === p,
  });
  const tiles: ReportTile[] = d ? [
    {
      key: 'all', label: 'Processed in month', value: fmtSenPlain(d.total.amountSen), sub: `${ordersText(d.total.orders)} in ${period}`,
      onClick: () => setView('all'), on: view === 'all',
    },
    partTile('this_month'),
    partTile('backlog'),
  ] : [];
  /* The owner wants both rates and their averages by amount and by quantity, a row each, and
     each average as a card of its own beside its rate (owner 2026-11-24). */
  const byAmount: ReportTile[] = d ? [
    { key: 'backlog-start', label: `Backlog at ${firstOfText(d.month)}`, value: fmtSenPlain(d.backlog.amountSen), sub: ordersText(d.backlog.orders) },
    {
      key: 'on-backlog', label: 'Cover rate · on backlog amount', value: shareText(d.cover.amount.onBacklog),
      sub: `${fmtSenPlain(d.parts.backlog.amountSen)} of ${fmtSenPlain(d.backlog.amountSen)}`,
    },
    avgTile('avg-on-backlog', 'Average · on backlog amount', d.average.amount.onBacklog, averagePeriod(d)),
    {
      key: 'on-month', label: 'Cover rate · on month amount', value: shareText(d.cover.amount.onMonth),
      sub: `${fmtSenPlain(d.parts.backlog.amountSen)} of ${fmtSenPlain(d.total.amountSen)}`,
    },
    avgTile('avg-on-month', 'Average · on month amount', d.average.amount.onMonth, averagePeriod(d)),
  ] : [];
  const byOrders: ReportTile[] = d ? [
    { key: 'backlog-start-orders', label: `Backlog orders at ${firstOfText(d.month)}`, value: fmtQty(d.backlog.orders), sub: 'Not processed by the 1st' },
    {
      key: 'on-backlog-orders', label: 'Cover rate · on backlog orders', value: shareText(d.cover.orders.onBacklog),
      sub: `${fmtQty(d.parts.backlog.orders)} of ${ordersText(d.backlog.orders)}`,
    },
    avgTile('avg-on-backlog-orders', 'Average · on backlog orders', d.average.orders.onBacklog, averagePeriod(d)),
    {
      key: 'on-month-orders', label: 'Cover rate · on month orders', value: shareText(d.cover.orders.onMonth),
      sub: `${fmtQty(d.parts.backlog.orders)} of ${ordersText(d.total.orders)}`,
    },
    avgTile('avg-on-month-orders', 'Average · on month orders', d.average.orders.onMonth, averagePeriod(d)),
  ] : [];

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (d ? coverSheet(d, view) : null)} fileBase={`so-conversion-backlog-${month}`} />
      </ReportHeaderActions>
      <ReportToolbar>
        <ReportTool label="Month"><MonthSelect label="Month" value={month} months={months} onChange={pickMonth} /></ReportTool>
        <ReportTool label="Average from">
          <MonthSelect label="Average from" value={d?.average.from ?? avgFrom ?? month} months={avgMonths} onChange={pickAvg} />
        </ReportTool>
      </ReportToolbar>

      {q.isLoading && <div className={`skeleton ${s.skeleton}`} aria-label="Reading the orders" />}
      {q.isError && <ReportMessage tone="error">The report did not load — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</ReportMessage>}
      {d && (
        <>
          <ReportTiles tiles={tiles} label="Processed" />
          <ReportTiles tiles={byAmount} label="Backlog cover by amount" />
          <ReportTiles tiles={byOrders} label="Backlog cover by orders" />
          <MonthsTable d={d} />
          {d.rows.length === 0 ? (
            <ReportMessage>{`No order has a Processing Date in ${period}.`}</ReportMessage>
          ) : rows.length === 0 ? (
            <ReportMessage>{`None of ${period}'s processed orders are ${PART_LABEL[view as CoverPart].toLowerCase()}.`}</ReportMessage>
          ) : (
            <section aria-label="Orders processed">
              <h3 className={s.h3}>Orders processed</h3>
              <DataTable<CoverRow>
                tableId="so-backlog-cover"
                exportName={`so-conversion-backlog-${month}`}
                exportXlsx
                freezeHeight="off"
                columns={COLUMNS}
                rows={rows}
                getRowKey={(x) => x.docNo}
                emptyLabel="No order matches."
              />
            </section>
          )}
          <ul className={s.notes} aria-label="Report notes">{COVER_NOTES.map((n) => <li key={n}>{n}</li>)}</ul>
        </>
      )}
    </>
  );
};
