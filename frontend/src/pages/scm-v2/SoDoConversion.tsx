// ----------------------------------------------------------------------------
// SoDoConversion — Finance › Reports › SO to DO conversion (owner 2026-11-24:
// "how much of this month's orders went to DO, everything else counts as
// earlier", with a month to pick and the total amount and percentage). The
// month's shipped delivery orders split by the SO date of the order each came
// from: this month's orders and earlier orders (AutoCount imports included),
// each part's total and share of the month's DO total; a tile narrows the DO
// list below to its part. The rules: so-do-conversion-view.ts and, on the
// server, acc/so-do-conversion.ts.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { useSoDoConversion, type ConversionRow } from '../../vendor/scm/lib/so-do-conversion-queries';
import { fmtDate, fmtSenPlain } from '../../vendor/shared/format';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { MonthSelect } from './ProductChanges';
import { monthBounds, periodText, pickableMonths } from './product-changes-view';
import {
  CONVERSION_NOTES, PART_LABEL, conversionSheet, dosText, fromText, partViewOf, partsShown, rowsOfPart, shareText, type PartView,
} from './so-do-conversion-view';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportTiles, ReportTool, ReportToolbar, useReportSubtitle, type ReportTile,
} from './reports/reportParts';
import { useReportRange } from './reports/useReportRange';
import s from './SoDoConversion.module.css';

/** The first month the picker offers: 2990's first DOs in the ERP. */
const FIRST_MONTH = '2026-06';

const COLUMNS: Column<ConversionRow>[] = [
  {
    key: 'do_number', label: 'DO', width: '200px', getValue: (r) => r.doNumber, searchValue: (r) => r.doNumber,
    /* Its own tab of the strip, so the DO's Back returns to this report as it was. */
    render: (r) => <FinanceDocLink to={`/scm/delivery-orders/${encodeURIComponent(r.id)}`}>{r.doNumber}</FinanceDocLink>,
  },
  { key: 'do_date', label: 'DO date', getValue: (r) => r.doDate, exportValue: (r) => r.doDate, render: (r) => fmtDate(r.doDate) },
  {
    key: 'doc_no', label: 'Order', width: '200px', getValue: (r) => r.docNo ?? '', searchValue: (r) => `${r.docNo ?? ''} ${r.customer ?? ''}`,
    exportValue: (r) => r.docNo ?? '',
    render: (r) => (
      <span className={s.stack}>
        {r.docNo ? <FinanceDocLink to={`/scm/sales-orders/${encodeURIComponent(r.docNo)}`}>{r.docNo}</FinanceDocLink> : <span className={s.muted}>No sales order</span>}
        {r.customer && <span className={s.muted}>{r.customer}</span>}
      </span>
    ),
  },
  { key: 'so_date', label: 'Order date', getValue: (r) => r.soDate ?? '', exportValue: (r) => r.soDate ?? '', render: (r) => (r.soDate ? fmtDate(r.soDate) : '—') },
  {
    key: 'from', label: 'From', getValue: (r) => fromText(r), exportValue: (r) => `${fromText(r)}${r.imported ? ' (imported)' : ''}`,
    render: (r) => (
      <span className={s.docLine}>
        <span>{fromText(r)}</span>
        {r.imported && <span className={s.tag} title="Brought over from AutoCount at the cutover">Imported</span>}
      </span>
    ),
  },
  {
    key: 'amount', label: 'Amount', align: 'right', width: '140px', description: "The DO's total",
    getValue: (r) => r.amountSen / 100, exportValue: (r) => r.amountSen / 100, exportFormat: 'money',
    render: (r) => <span className={s.num}>{fmtSenPlain(r.amountSen)}</span>,
  },
];

export const SoDoConversionTab = () => {
  const r = useReportRange();
  const [params, setParams] = useSearchParams();
  const month = (r.usable ? r.from : r.today).slice(0, 7);
  const view = partViewOf(params.get('part'));
  const setView = (v: PartView) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (v === 'all') next.delete('part'); else next.set('part', v);
    return next;
  }, { replace: true });
  const pickMonth = (ym: string) => { const m = monthBounds(ym); r.setRange(m.from, m.to); };
  const months = useMemo(() => pickableMonths(r.today, FIRST_MONTH), [r.today]);

  const q = useSoDoConversion(month);
  const d = q.data;
  const rows = useMemo(() => rowsOfPart(d?.rows ?? [], view), [d, view]);
  const period = periodText(`${month}-01`, monthBounds(month).to);
  useReportSubtitle(`${period} · by DO date · shipped DOs · RM`);

  const tiles: ReportTile[] = d ? [
    {
      key: 'all', label: 'Total amount', value: fmtSenPlain(d.total.amountSen), sub: `${dosText(d.total.dos)} in ${period}`,
      onClick: () => setView('all'), on: view === 'all',
    },
    ...partsShown(d).map((p): ReportTile => ({
      key: p, label: PART_LABEL[p],
      value: <>{fmtSenPlain(d.parts[p].amountSen)}<span className={s.share} title="Share of the month's DO total">{shareText(d.parts[p].pct)}</span></>,
      sub: dosText(d.parts[p].dos),
      onClick: () => setView(view === p ? 'all' : p), on: view === p,
    })),
  ] : [];

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (d ? conversionSheet(d, view) : null)} fileBase={`so-to-do-conversion-${month}`} />
      </ReportHeaderActions>
      <ReportToolbar>
        <ReportTool label="Month"><MonthSelect label="Month" value={month} months={months} onChange={pickMonth} /></ReportTool>
      </ReportToolbar>

      {q.isLoading && <div className={`skeleton ${s.skeleton}`} aria-label="Reading the delivery orders" />}
      {q.isError && <ReportMessage tone="error">The report did not load — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</ReportMessage>}
      {d && (
        <>
          <ReportTiles tiles={tiles} label="Totals" />
          {d.rows.length === 0 ? (
            <ReportMessage>{`No shipped delivery order is dated in ${period}.`}</ReportMessage>
          ) : rows.length === 0 ? (
            <ReportMessage>{`No delivery order of ${period} is from ${PART_LABEL[view as Exclude<PartView, 'all'>].toLowerCase()}.`}</ReportMessage>
          ) : (
            <section aria-label="Delivery orders">
              <DataTable<ConversionRow>
                tableId="so-do-conversion"
                exportName={`so-to-do-conversion-${month}`}
                exportXlsx
                freezeHeight="off"
                columns={COLUMNS}
                rows={rows}
                getRowKey={(x) => x.id}
                emptyLabel="No delivery order matches."
              />
            </section>
          )}
          <ul className={s.notes} aria-label="Report notes">{CONVERSION_NOTES.map((n) => <li key={n}>{n}</li>)}</ul>
        </>
      )}
    </>
  );
};
