// ----------------------------------------------------------------------------
// ProductChanges — Finance › Reports › Product changes and Product changes P&L
// (owner 2026-11-23: 「我主要是看销售价和成本的变动，因为我要确定这些改动销售价是足够
// cover成本的变动」). Every product change on a sales order — another product,
// seat height or option, sofa pieces, a line added or removed, a quantity that
// moved the selling amount — with the selling and cost of the order's product
// lines before and after, and whether the selling change covered the cost change.
//   • Product changes: one month (「我要可以选择月份去看」), one row per change, by
//     bucket — the selling changed, or it did not and only the cost did
//     (「要列出来」) — and a switch for the ones not covered.
//   • Product changes P&L (「类似 p&L」): a month or a range, the changes added
//     up per month, then by salesperson.
// The rows and their rules: product-changes-view.ts; the server records each
// change when it is saved or approved.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { DataTable, type Column } from '../../components/DataTable';
import { monthEnd } from '../../lib/dateRangePresets';
import { useProductChanges, type ProductChangeRow } from '../../vendor/scm/lib/product-change-queries';
import { fmtDate, fmtSenPlain } from '../../vendor/shared/format';
import {
  BUCKET_LABEL, CHANGE_NOTES, SUMMARY_LINES, bySalesperson, detailSheet, filterRows, fmtDelta, lineText, monthBounds, monthsBetween,
  ordersScope, ordersShown, periodText, pickableMonths, routeShort, routeText, summaryColumns, summaryRed, summarySheet, totalsOf, typesText, whoText, type BucketView, type SalespersonRow,
} from './product-changes-view';
import { monthName } from './reports/statementColumns';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportSwitch, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { useReportRange } from './reports/useReportRange';
import b from './books/Books.module.css';
import s from './ProductChanges.module.css';

const BUCKETS: ReadonlyArray<{ value: BucketView; label: string }> = [
  { value: 'all', label: 'All changes' },
  { value: 'SELLING', label: BUCKET_LABEL.SELLING },
  { value: 'COST_ONLY', label: BUCKET_LABEL.COST_ONLY },
];
const bucketOf = (v: string | null): BucketView => (v === 'SELLING' || v === 'COST_ONLY' ? v : 'all');

/** A month from a list, with the month before and after one press away. The
 *  SO conversion & backlog report picks its months with it too. */
export function MonthSelect({ label, value, months, onChange }: { label: string; value: string; months: readonly string[]; onChange: (ym: string) => void }) {
  const options = months.includes(value) ? months : [value, ...months];
  const i = options.indexOf(value);
  return (
    <span className={s.monthPick}>
      <button type="button" className={s.step} aria-label={`${label}: the month before`} disabled={i >= options.length - 1}
        onClick={() => onChange(options[i + 1]!)}>
        <ChevronLeft size={14} aria-hidden />
      </button>
      <span className={b.selectWrap}>
        <select className={b.select} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((m) => <option key={m} value={m}>{monthName(`${m}-01`)}</option>)}
        </select>
        <ChevronDown size={12} className={b.selectChevron} aria-hidden />
      </span>
      <button type="button" className={s.step} aria-label={`${label}: the month after`} disabled={i <= 0}
        onClick={() => onChange(options[i - 1]!)}>
        <ChevronRight size={14} aria-hidden />
      </button>
    </span>
  );
}

/* Owner 2026-11-23: 「默认只看新单」. Orders brought over from AutoCount stay out
   of both reports until the reader turns this on; it lives in the URL. */
function useImportedSwitch(): [boolean, (on: boolean) => void] {
  const [params, setParams] = useSearchParams();
  const set = (on: boolean) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (on) next.set('imported', '1'); else next.delete('imported');
    return next;
  }, { replace: true });
  return [params.get('imported') === '1', set];
}

const ImportedSwitch = ({ on, onChange, count }: { on: boolean; onChange: (on: boolean) => void; count: number }) => (
  <ReportSwitch on={on} onChange={onChange}>{`Include imported orders${count > 0 ? ` (${count})` : ''}`}</ReportSwitch>
);

const Money = ({ sen, delta = false, bad = false }: { sen: number; delta?: boolean; bad?: boolean }) => (
  <span className={`${s.num} ${bad && sen < 0 ? s.bad : ''}`}>{delta ? fmtDelta(sen) : fmtSenPlain(sen)}</span>
);

const BeforeAfter = ({ before, after, delta, bad = false }: { before: number; after: number; delta: number; bad?: boolean }) => (
  <span className={s.ba}>
    <span className={s.num}>{fmtSenPlain(before)} → {fmtSenPlain(after)}</span>
    <span className={`${s.num} ${s.delta} ${bad && delta < 0 ? s.bad : ''}`}>{fmtDelta(delta)}</span>
  </span>
);

const linesTable = (r: ProductChangeRow) => (
  <table className={s.lines} aria-label={`${r.docNo}'s changed lines`}>
    <thead>
      <tr><th>Line</th><th>Change</th><th className={s.right}>Selling before</th><th className={s.right}>Selling after</th><th className={s.right}>Cost before</th><th className={s.right}>Cost after</th></tr>
    </thead>
    <tbody>
      {r.lines.map((l) => (
        <tr key={l.id}>
          <td>{lineText(l)}</td>
          <td>{l.types.length > 0 ? typesText(l) : <span className={s.muted}>moved with it</span>}</td>
          <td className={s.right}>{l.before ? fmtSenPlain(l.before.sellingSen) : '—'}</td>
          <td className={s.right}>{l.after ? fmtSenPlain(l.after.sellingSen) : '—'}</td>
          <td className={s.right}>{l.before ? fmtSenPlain(l.before.costSen) : '—'}</td>
          <td className={s.right}>{l.after ? fmtSenPlain(l.after.costSen) : '—'}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const DETAIL_COLUMNS: Column<ProductChangeRow>[] = [
  { key: 'change_day', label: 'Date', getValue: (r) => r.changeDay, exportValue: (r) => r.changeDay, render: (r) => fmtDate(r.changeDay) },
  {
    key: 'doc_no', label: 'Order', width: '180px', getValue: (r) => r.docNo, searchValue: (r) => `${r.docNo} ${r.customer ?? ''}`,
    exportValue: (r) => (r.imported ? `${r.docNo} (imported)` : r.docNo),
    render: (r) => (
      <span className={s.stack}>
        <span className={s.docLine}>
          {/* Its own tab of the strip: the order's Back returns to this report as it was (owner 2026-11-23: 「我点开so后要返回这里」). */}
          <FinanceDocLink to={`/scm/sales-orders/${encodeURIComponent(r.docNo)}`}>{r.docNo}</FinanceDocLink>
          {r.imported && <span className={s.tag} title="Brought over from AutoCount at the cutover">Imported</span>}
        </span>
        {r.customer && <span className={s.muted}>{r.customer}</span>}
      </span>
    ),
  },
  {
    key: 'salesperson', label: 'Salesperson', getValue: (r) => r.salesperson, searchValue: (r) => `${r.salesperson} ${whoText(r)}`,
    exportValue: (r) => `${r.salesperson} · changed by ${whoText(r)}`,
    render: (r) => <span className={s.stack}><span>{r.salesperson}</span>{r.changedBy.length > 0 && <span className={s.muted}>by {whoText(r)}</span>}</span>,
  },
  {
    key: 'what', label: 'What changed', getValue: (r) => typesText(r), exportValue: (r) => `${typesText(r)} · ${routeText(r)}`,
    render: (r) => <span className={s.stack}><span>{typesText(r)}</span><span className={s.muted}>{routeShort(r)}</span></span>,
  },
  {
    key: 'selling_amount', label: 'Selling', align: 'right', width: '200px', description: 'The order’s product lines, before → after, and the change',
    getValue: (r) => r.sellingDeltaSen / 100, exportValue: (r) => r.sellingDeltaSen / 100, exportFormat: 'money',
    render: (r) => <BeforeAfter before={r.sellingBeforeSen} after={r.sellingAfterSen} delta={r.sellingDeltaSen} />,
  },
  {
    key: 'cost', label: 'Cost', align: 'right', width: '200px', description: 'The order’s product lines, before → after, and the change',
    getValue: (r) => r.costDeltaSen / 100, exportValue: (r) => r.costDeltaSen / 100, exportFormat: 'money',
    render: (r) => <BeforeAfter before={r.costBeforeSen} after={r.costAfterSen} delta={r.costDeltaSen} />,
  },
  {
    key: 'margin', label: 'Margin', align: 'right', width: '200px', description: 'Selling less cost, before → after, and the change',
    getValue: (r) => r.marginDeltaSen / 100, exportValue: (r) => r.marginDeltaSen / 100, exportFormat: 'money',
    render: (r) => <BeforeAfter before={r.sellingBeforeSen - r.costBeforeSen} after={r.sellingAfterSen - r.costAfterSen} delta={r.marginDeltaSen} bad />,
  },
  {
    key: 'margin_covered', label: 'Covered', getValue: (r) => (r.covered ? 1 : 0),
    exportValue: (r) => `${r.covered ? 'Covered' : `Not covered · ${fmtSenPlain(r.shortfallSen)}`}${r.costEstimated ? ' · estimated cost' : ''}`,
    render: (r) => (
      <span className={s.docLine}>
        {r.covered
          ? <span className={s.ok}>Covered</span>
          : <span className={s.flag} title={`Short by ${fmtSenPlain(r.shortfallSen)}`}>Not covered</span>}
        {r.costEstimated && <span className={s.tag} title="A cost the order's history did not hold, taken from the product's own cost">Estimated</span>}
      </span>
    ),
  },
];

export const ProductChangesTab = () => {
  const r = useReportRange();
  const [params, setParams] = useSearchParams();
  const month = (r.usable ? r.from : r.today).slice(0, 7);
  const bucket = bucketOf(params.get('kind'));
  const notCoveredOnly = params.get('uncovered') === '1';
  const setParam = (key: string, value: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value == null) next.delete(key); else next.set(key, value);
    return next;
  }, { replace: true });
  const pickMonth = (ym: string) => { const m = monthBounds(ym); r.setRange(m.from, m.to); };
  const [includeImported, setIncludeImported] = useImportedSwitch();

  const q = useProductChanges({ from: month, to: month });
  const all = useMemo(() => q.data?.rows ?? [], [q.data]);
  const shown = useMemo(() => ordersShown(all, includeImported), [all, includeImported]);
  const importedCount = all.length - ordersShown(all, false).length;
  const rows = useMemo(() => filterRows(shown, bucket, notCoveredOnly), [shown, bucket, notCoveredOnly]);
  const t = totalsOf(rows);
  const period = periodText(`${month}-01`, monthEnd(`${month}-01`));
  useReportSubtitle(`${period} · by change date · ${ordersScope(includeImported)} · product lines`);
  const months = useMemo(() => pickableMonths(r.today), [r.today]);

  const tiles: ReportTile[] = [
    { key: 'events', label: 'Changes', value: String(t.events), sub: bucket === 'all' ? 'all kinds' : BUCKET_LABEL[bucket].toLowerCase() },
    { key: 'selling', label: 'Selling change', value: fmtDelta(t.sellingDeltaSen), sub: 'product lines' },
    { key: 'cost', label: 'Cost change', value: fmtDelta(t.costDeltaSen), sub: 'product lines' },
    { key: 'margin', label: 'Margin change', value: fmtDelta(t.marginDeltaSen), tone: t.marginDeltaSen < 0 ? 'late' : 'good', sub: 'selling change less cost change' },
    { key: 'short', label: 'Not covered', value: String(t.notCovered), tone: t.notCovered > 0 ? 'late' : 'plain', sub: `shortfall ${fmtSenPlain(t.shortfallSen)}` },
  ];

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (q.data ? detailSheet(rows, `${month}-01`, monthEnd(`${month}-01`), bucket, notCoveredOnly, includeImported) : null)} fileBase={`product-changes-${month}`} />
      </ReportHeaderActions>
      <ReportToolbar>
        <ReportTool label="Month"><MonthSelect label="Month" value={month} months={months} onChange={pickMonth} /></ReportTool>
        <ReportTool label="Show"><Segmented options={BUCKETS} value={bucket} onChange={(v) => setParam('kind', v === 'all' ? null : v)} label="Show" /></ReportTool>
        <ReportSwitch on={notCoveredOnly} onChange={(on) => setParam('uncovered', on ? '1' : null)}>Not covered only</ReportSwitch>
        <ImportedSwitch on={includeImported} onChange={setIncludeImported} count={importedCount} />
      </ReportToolbar>

      {q.isLoading && <div className={`skeleton ${s.skeleton}`} aria-label="Reading the changes" />}
      {q.isError && <ReportMessage tone="error">The report did not load — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</ReportMessage>}
      {q.data && (
        <>
          <ReportTiles tiles={tiles} label="Totals" />
          {rows.length === 0 ? (
            <ReportMessage>{all.length === 0 ? `No product change in ${period}.`
              : shown.length === 0 ? `No change on a new order in ${period}. ${importedCount} on imported orders: turn on Include imported orders to see them.`
                : 'No change matches the filter.'}</ReportMessage>
          ) : (
            <section aria-label="Product changes">
              <DataTable<ProductChangeRow>
                tableId="product-changes"
                exportName={`product-changes-${month}`}
                exportXlsx
                freezeHeight="off"
                columns={DETAIL_COLUMNS}
                rows={rows}
                getRowKey={(x) => x.id}
                expandable={{ render: linesTable }}
                emptyLabel="No change matches."
              />
            </section>
          )}
          <ul className={s.notes} aria-label="Report notes">{CHANGE_NOTES.map((n) => <li key={n}>{n}</li>)}</ul>
        </>
      )}
    </>
  );
};

const PERSON_COLUMNS: Column<SalespersonRow>[] = [
  { key: 'salesperson', label: 'Salesperson', getValue: (p) => p.salesperson, render: (p) => <span className={s.strong}>{p.salesperson}</span> },
  { key: 'margin_changes', label: 'Changes', align: 'right', getValue: (p) => p.events, render: (p) => p.events },
  { key: 'selling_amount', label: 'Selling change', align: 'right', getValue: (p) => p.sellingDeltaSen / 100, exportFormat: 'money', render: (p) => <Money sen={p.sellingDeltaSen} delta /> },
  { key: 'cost', label: 'Cost change', align: 'right', getValue: (p) => p.costDeltaSen / 100, exportFormat: 'money', render: (p) => <Money sen={p.costDeltaSen} delta /> },
  { key: 'margin', label: 'Margin change', align: 'right', getValue: (p) => p.marginDeltaSen / 100, exportFormat: 'money', render: (p) => <Money sen={p.marginDeltaSen} delta bad /> },
  { key: 'margin_not_covered', label: 'Not covered', align: 'right', getValue: (p) => p.notCovered, render: (p) => (p.notCovered > 0 ? <span className={s.flagText}>{p.notCovered}</span> : '0') },
  { key: 'margin_shortfall_sen', label: 'Shortfall', align: 'right', getValue: (p) => p.shortfallSen / 100, exportFormat: 'money', render: (p) => (p.shortfallSen > 0 ? <span className={s.flagText}>{fmtSenPlain(p.shortfallSen)}</span> : '—') },
];

export const ProductChangesSummaryTab = () => {
  const r = useReportRange();
  const fromYm = (r.usable ? r.from : r.today).slice(0, 7);
  const toYm = (r.usable ? r.to : r.today).slice(0, 7);
  const months = useMemo(() => pickableMonths(r.today), [r.today]);
  const setMonths = (a: string, z: string) => {
    const [lo, hi] = a <= z ? [a, z] : [z, a];
    r.setRange(monthBounds(lo).from, monthBounds(hi).to);
  };
  const [includeImported, setIncludeImported] = useImportedSwitch();
  const q = useProductChanges({ from: fromYm, to: toYm });
  const all = useMemo(() => q.data?.rows ?? [], [q.data]);
  const rows = useMemo(() => ordersShown(all, includeImported), [all, includeImported]);
  const importedCount = all.length - ordersShown(all, false).length;
  const from = `${fromYm}-01`;
  const to = monthEnd(`${toYm}-01`);
  const cols = useMemo(() => summaryColumns(rows, from, to), [rows, from, to]);
  const people = useMemo(() => bySalesperson(rows), [rows]);
  const span = monthsBetween(from, to).length;
  const period = periodText(from, to);
  useReportSubtitle(`${period}${span > 1 ? ` · ${span} months` : ''} · by change date · ${ordersScope(includeImported)} · product lines`);
  const fileBase = fromYm === toYm ? `product-changes-pnl-${fromYm}` : `product-changes-pnl-${fromYm}-${toYm}`;

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (q.data ? summarySheet(rows, from, to, includeImported) : null)} fileBase={fileBase} />
      </ReportHeaderActions>
      <ReportToolbar>
        <ReportTool label="From"><MonthSelect label="From month" value={fromYm} months={months} onChange={(m) => setMonths(m, toYm)} /></ReportTool>
        <ReportTool label="To"><MonthSelect label="To month" value={toYm} months={months} onChange={(m) => setMonths(fromYm, m)} /></ReportTool>
        <ImportedSwitch on={includeImported} onChange={setIncludeImported} count={importedCount} />
      </ReportToolbar>

      {q.isLoading && <div className={`skeleton ${s.skeleton}`} aria-label="Reading the changes" />}
      {q.isError && <ReportMessage tone="error">The report did not load — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</ReportMessage>}
      {q.data && (
        <>
          <section className={s.card} aria-label="Product changes by month">
            <table className={s.pnl}>
              <thead>
                <tr><th className={s.pnlName}>{period}</th>{cols.map((c) => <th key={c.key} className={`${s.right} ${c.key === 'total' ? s.totalCol : ''}`}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {SUMMARY_LINES.map((l, i) => (l.kind === 'section'
                  ? <tr key={`s${i}`} className={s.section}><td colSpan={cols.length + 1}>{l.label}</td></tr>
                  : (
                    <tr key={`l${i}`} className={l.total ? s.totalRow : undefined}>
                      <td className={s.pnlName}>{l.label}</td>
                      {cols.map((c) => {
                        const v = l.value(c);
                        const cls = `${s.right} ${s.num} ${c.key === 'total' ? s.totalCol : ''} ${summaryRed(l, v) ? s.bad : ''}`;
                        return <td key={c.key} className={cls}>{l.kind === 'count' ? v : (v === 0 ? '—' : fmtSenPlain(v))}</td>;
                      })}
                    </tr>
                  )))}
              </tbody>
            </table>
          </section>

          <section aria-label="By salesperson">
            <h3 className={s.h3}>By salesperson</h3>
            {people.length === 0 ? <ReportMessage>{`No product change in ${period}.`}</ReportMessage> : (
              <DataTable<SalespersonRow>
                tableId="product-changes-by-salesperson"
                exportName={`${fileBase}-salespeople`}
                exportXlsx
                freezeHeight="off"
                columns={PERSON_COLUMNS}
                rows={people}
                getRowKey={(p) => p.salesperson}
                emptyLabel="No salesperson."
              />
            )}
          </section>
          <ul className={s.notes} aria-label="Report notes">{CHANGE_NOTES.map((n) => <li key={n}>{n}</li>)}</ul>
        </>
      )}
    </>
  );
};
