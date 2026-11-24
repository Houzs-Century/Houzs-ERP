// ----------------------------------------------------------------------------
// SoBacklogCover — Finance › Reports › SO conversion & backlog (owner
// 2026-11-24). The month's orders by the Processing Date written on them:
// this month's orders and the backlog orders, each with its amount and share
// of the month's processed total; the backlog at the 1st; the two backlog
// cover rates (on the backlog amount, on the month's processed amount) with
// their average from a month the reader may pick, by default the company's
// first month with a backlog; each month's figures; and the orders, which a
// tile narrows to its part. The rules: so-backlog-cover-view.ts and, on the
// server, acc/so-backlog-cover.ts.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { useSoBacklogCover, type CoverPart, type CoverRow, type SoBacklogCoverData } from '../../vendor/scm/lib/so-backlog-cover-queries';
import { fmtDate, fmtSenPlain } from '../../vendor/shared/format';
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

/** The first month the pickers offer: 2990's first orders in the ERP. */
const FIRST_MONTH = '2026-06';

const COLUMNS: Column<CoverRow>[] = [
  {
    key: 'doc_no', label: 'Order', width: '200px', getValue: (r) => r.docNo, searchValue: (r) => `${r.docNo} ${r.customer ?? ''}`,
    exportValue: (r) => r.docNo,
    /* Its own tab of the strip, so the order's Back returns to this report as it was. */
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

/** A rate tile's line under the figure: what it is of, then the average. */
const RateSub = ({ part, whole, avg, period }: { part: number; whole: number; avg: number | null; period: string }) => (
  <span className={s.stack}>
    <span>{`${fmtSenPlain(part)} of ${fmtSenPlain(whole)}`}</span>
    <span>{`Average ${shareText(avg)} · ${period}`}</span>
  </span>
);

function MonthsTable({ d }: { d: SoBacklogCoverData }) {
  return (
    <section className={s.card} aria-label="Backlog cover by month">
      <table className={s.months}>
        <thead>
          <tr>
            <th>Month</th><th>Backlog at the 1st</th><th>Backlog processed</th><th>Processed in month</th>
            <th>On backlog amount</th><th>On month amount</th>
          </tr>
        </thead>
        <tbody>
          {d.months.map((m) => (
            <tr key={m.month} className={m.month === d.month ? s.current : undefined}>
              <td>{monthName(`${m.month}-01`)}</td>
              <td className={s.num}>{fmtSenPlain(m.backlog.amountSen)}</td>
              <td className={s.num}>{fmtSenPlain(m.backlogProcessed.amountSen)}</td>
              <td className={s.num}>{fmtSenPlain(m.processed.amountSen)}</td>
              <td className={s.num}>{shareText(m.onBacklog)}</td>
              <td className={s.num}>{shareText(m.onMonth)}</td>
            </tr>
          ))}
          <tr className={s.average}>
            <td>Average</td><td /><td /><td />
            <td className={s.num}>{shareText(d.average.onBacklog)}</td>
            <td className={s.num}>{shareText(d.average.onMonth)}</td>
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
  /* The default start leaves the URL, so a link without ?avg follows the company's default. */
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
  const coverTiles: ReportTile[] = d ? [
    { key: 'backlog-start', label: `Backlog at ${firstOfText(d.month)}`, value: fmtSenPlain(d.backlog.amountSen), sub: ordersText(d.backlog.orders) },
    {
      key: 'on-backlog', label: 'Cover rate · on backlog amount', value: shareText(d.cover.onBacklog),
      sub: <RateSub part={d.parts.backlog.amountSen} whole={d.backlog.amountSen} avg={d.average.onBacklog} period={averagePeriod(d)} />,
    },
    {
      key: 'on-month', label: 'Cover rate · on month amount', value: shareText(d.cover.onMonth),
      sub: <RateSub part={d.parts.backlog.amountSen} whole={d.total.amountSen} avg={d.average.onMonth} period={averagePeriod(d)} />,
    },
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
          <ReportTiles tiles={coverTiles} label="Backlog cover" />
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
