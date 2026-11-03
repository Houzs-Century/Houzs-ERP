// ----------------------------------------------------------------------------
// ProductProfit — Finance › Reports › Product profit, the monthly product
// profit ranking (owner 2026-10-05: 「我每个月什么产品最好卖，同时要兼顾售价和成
// 本，不能只单单看销量」). As he settled it: one row per model, a sofa in sets
// (「按套」); the month by SO date (「按开单月」); the gifts in or out by a switch;
// any number of categories at once (「别限制两个」), so mattresses and
// bedframes read together (「床架和床垫一起」) with each mattress showing the
// bedframes it gave away; the charts he kept — the ranking, a donut and the
// waterfall. Every word on the screen is English (字体要英文).
//
// The owner's redesign (batch 6 §5.11): inside the report shell — the months
// in the subtitle, Excel · PDF · Print in the header and Charts PNG under its
// ⋯; one toolbar row (the shared dates, Category, Rank by, Include gifts); four
// tiles; the charts in petrol / gold / warm grey; the table on the
// Finance-Table.
// Several months (the redesign's c8; owner 2026-11-03 「要」, question g2): the
// report follows the shell's shared range like the other month-based reports,
// in WHOLE months — a part month widens to its first and last days and the
// subtitle says so. One month is the monthly report it always was; several add
// up, each order in the month of its SO date (按开单月).
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import { DataTable, type Column } from '../../components/DataTable';
import { monthEnd, monthStart } from '../../lib/dateRangePresets';
import { useProductProfit, type ProductCategory, type ProductProfitRow } from '../../vendor/scm/lib/product-profit-queries';
import { fmtSenPlain } from '../../vendor/shared/format';
import {
  CATEGORY_LABEL, CATEGORY_ORDER, compact, donutOf, rankingOf, freeBedframesText, giftsLabel, gpOf, gpPctOf, productProfitSheet, profitNotes,
  profitPeriod, showsFreeBedframes, totalsOf, unitsText, viewLabel, viewRows, waterfallOf, type ProfitView, type SortKey,
} from './product-profit-view';
import { ProfitWaterfall, RankingChart, ShareDonut, chartsPng } from './ProductProfitCharts';
import { FinanceDateRange } from './reports/FinanceDateRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportMore, ReportSwitch, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { useReportRange } from './reports/useReportRange';
import s from './ProductProfit.module.css';

const money = (sen: number): string => (sen === 0 ? '—' : fmtSenPlain(sen));
const pctText = (p: number | null): string => (p == null ? '—' : `${p.toFixed(1)}%`);
const SORTS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'gp', label: 'Gross profit' },
  { value: 'units', label: 'Units sold' },
  { value: 'sales', label: 'Sales' },
  { value: 'gpPct', label: 'Margin' },
];
/** A row as the table ranks it: its place, and its gross profit with the gifts in or out. */
type Ranked = ProductProfitRow & { rank: number; gp: number };

export const ProductProfitTab = () => {
  const r = useReportRange();
  /* Whole months of the shared range: a part month widens to its first and last days. */
  const from = r.usable ? monthStart(r.from) : monthStart(r.today);
  const to = r.usable ? monthEnd(r.to) : monthEnd(r.today);
  const partMonths = r.usable && (r.from !== from || r.to !== to);
  const [cats, setCats] = useState<Set<ProductCategory>>(new Set());
  const [gifts, setGifts] = useState(true);
  const [sort, setSort] = useState<SortKey>('gp');
  const q = useProductProfit({ from: from.slice(0, 7), to: to.slice(0, 7) });
  const d = q.data;
  const v: ProfitView = useMemo(() => ({ cats, gifts, sort }), [cats, gifts, sort]);
  const rows = useMemo(() => (d ? viewRows(d, v) : []), [d, v]);
  const ranked = useMemo<Ranked[]>(() => rows.map((x, i) => ({ ...x, rank: i + 1, gp: gpOf(x, gifts) })), [rows, gifts]);
  const totals = useMemo(() => totalsOf(rows, gifts), [rows, gifts]);
  const donut = useMemo(() => donutOf(rows, v), [rows, v]);
  const ranking = useMemo(() => rankingOf(rows, v), [rows, v]);
  const rankRef = useRef<SVGSVGElement>(null);
  const donutRef = useRef<SVGSVGElement>(null);
  const fallRef = useRef<SVGSVGElement>(null);

  const toggleCat = (c: ProductCategory) => setCats((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c); else next.add(c);
    return next;
  });
  /* What is on screen: the months the report read, else the months asked for. */
  const shownFrom = d?.from ?? from;
  const shownTo = d?.to ?? to;
  const monthText = profitPeriod(shownFrom, shownTo);
  useReportSubtitle(`${monthText}${partMonths ? ' · whole months' : ''} · by SO date · ${viewLabel(v)} · ${giftsLabel(gifts)}`);
  const fileBase = shownFrom.slice(0, 7) === shownTo.slice(0, 7)
    ? `product-profit-${shownFrom.slice(0, 7)}`
    : `product-profit-${shownFrom.slice(0, 7)}-${shownTo.slice(0, 7)}`;
  const pngTitle = `Product profit · ${monthText} · ${viewLabel(v)} · ${giftsLabel(gifts)} · ${ranking.title.toLowerCase()}`;
  const donutNote = donut.losers.count > 0
    ? `${donut.losers.count} ${donut.byCategory ? (donut.losers.count === 1 ? 'category' : 'categories') : (donut.losers.count === 1 ? 'model' : 'models')} lost money (${compact(donut.losers.sen)}) — not in the donut`
    : undefined;

  const tiles: ReportTile[] = d ? [
    { key: 'sales', label: 'Sales', value: fmtSenPlain(totals.salesSen), sub: `${rows.length} ${rows.length === 1 ? 'model' : 'models'} · ${d.orders} ${d.orders === 1 ? 'order' : 'orders'}` },
    { key: 'gp', label: 'Gross profit', value: fmtSenPlain(totals.gpSen), tone: totals.gpSen < 0 ? 'late' : 'good', sub: `after product cost${gifts ? ' and gifts' : ''}` },
    { key: 'margin', label: 'Margin', value: pctText(totals.gpPct), sub: 'gross profit, % of sales' },
    { key: 'gifts', label: gifts ? 'Gifts' : 'Gifts (not counted)', value: fmtSenPlain(totals.giftSen), sub: gifts ? 'shared among the paid products' : 'left out of gross profit' },
    ...(showsFreeBedframes(v) ? [{
      key: 'free', label: 'Free bedframes',
      value: `${d.freeBedframes.pieces} ${d.freeBedframes.pieces === 1 ? 'pc' : 'pcs'}`, sub: fmtSenPlain(d.freeBedframes.sen),
    }] : []),
  ] : [];

  const columns: Column<Ranked>[] = [
    { key: 'rank_no', label: '#', align: 'right', getValue: (x) => x.rank, render: (x) => <span className={s.muted}>{x.rank}</span> },
    {
      key: 'model', label: 'Model', getValue: (x) => x.model, searchValue: (x) => `${x.model} ${x.brand ?? ''}`,
      exportValue: (x) => `${x.model}${x.brand ? ` · ${x.brand}` : ''}`,
      render: (x) => (
        <span>
          <span className={s.model}><span className={s.modelName}>{x.model}</span>{x.brand && <span className={s.brand}>{x.brand}</span>}</span>
          {x.noCostLines > 0 && <span className={s.noCost}>Cost incomplete · {x.noCostLines} {x.noCostLines === 1 ? 'line has' : 'lines have'} no cost</span>}
        </span>
      ),
    },
    { key: 'category', label: 'Category', getValue: (x) => CATEGORY_LABEL[x.category], render: (x) => CATEGORY_LABEL[x.category] },
    { key: 'units', label: 'Sold', align: 'right', getValue: (x) => x.units, exportValue: (x) => unitsText(x), render: (x) => unitsText(x) },
    {
      key: 'avg_price', label: 'Avg price', align: 'right', getValue: (x) => (x.units > 0 ? x.salesSen / x.units / 100 : null),
      exportValue: (x) => (x.units > 0 ? Math.round(x.salesSen / x.units) / 100 : null), exportFormat: 'money',
      render: (x) => (x.units > 0 ? fmtSenPlain(Math.round(x.salesSen / x.units)) : '—'),
    },
    {
      key: 'sales_amount', label: 'Sales', align: 'right', getValue: (x) => x.salesSen / 100, exportValue: (x) => x.salesSen / 100, exportFormat: 'money',
      render: (x) => money(x.salesSen), total: () => <span className={s.strong}>{money(totals.salesSen)}</span>,
    },
    {
      key: 'cost_amount', label: 'Product cost', align: 'right', getValue: (x) => x.costSen / 100, exportValue: (x) => x.costSen / 100, exportFormat: 'money',
      render: (x) => money(x.costSen), total: () => <span className={s.strong}>{money(totals.costSen)}</span>,
    },
    ...(gifts ? [{
      key: 'gift_amount', label: 'Gifts', align: 'right' as const, description: 'Its share of the gifts on the orders that bought it',
      getValue: (x: Ranked) => x.giftSen / 100, exportValue: (x: Ranked) => x.giftSen / 100, exportFormat: 'money' as const,
      render: (x: Ranked) => money(x.giftSen), total: () => <span className={s.strong}>{money(totals.giftSen)}</span>,
    }] : []),
    {
      key: 'gp_amount', label: 'Gross profit', align: 'right', getValue: (x) => x.gp / 100, exportValue: (x) => x.gp / 100, exportFormat: 'money',
      render: (x) => <span className={`${s.strong} ${x.gp < 0 ? s.loss : ''}`}>{money(x.gp)}</span>,
      total: () => <span className={`${s.strong} ${totals.gpSen < 0 ? s.loss : ''}`}>{money(totals.gpSen)}</span>,
    },
    {
      key: 'margin_pct', label: 'Margin · % of sales', align: 'right', getValue: (x) => gpPctOf(x, x.gp),
      render: (x) => pctText(gpPctOf(x, x.gp)), total: () => <span className={s.strong}>{pctText(totals.gpPct)}</span>,
    },
    {
      key: 'free_bedframe_qty', label: 'Free bedframes', align: 'right', description: 'Bedframes given free on the orders that bought it',
      getValue: (x) => x.freeBedframeSen / 100, exportValue: (x) => freeBedframesText(x),
      render: (x) => <span className={s.muted}>{freeBedframesText(x) || '—'}</span>,
    },
  ];

  const sizes = (x: Ranked) => (x.items.length === 0 ? <span className={s.muted}>No sizes on this model.</span> : (
    <table className={s.sizes} aria-label={`${x.model}'s sizes`}>
      <thead>
        <tr><th>Item</th><th>Size</th><th className={s.num}>Sold</th><th className={s.num}>Sales</th><th className={s.num}>Product cost</th><th className={s.num}>Sales less cost</th></tr>
      </thead>
      <tbody>
        {x.items.map((it) => (
          <tr key={it.code}>
            <td>{it.code}</td>
            <td>{it.size ?? '—'}</td>
            <td className={s.num}>{it.units > 0 ? it.units : '—'}</td>
            <td className={s.num}>{money(it.salesSen)}</td>
            <td className={s.num}>{money(it.costSen)}</td>
            <td className={s.num}>{money(it.salesSen - it.costSen)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ));

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (d ? productProfitSheet(d, v, rows) : null)} fileBase={fileBase} />
        <ReportMore items={[{
          label: 'Charts PNG', disabled: !d || rows.length === 0,
          onClick: () => { void chartsPng([rankRef.current, donutRef.current, fallRef.current], pngTitle, `${fileBase}-charts.png`); },
        }]} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange label="SO dates" />
        <ReportTool label="Category">
          <span className={s.chips} role="group" aria-label="Category">
            <button type="button" className={`${s.chip} ${cats.size === 0 ? s.chipOn : ''}`} aria-pressed={cats.size === 0} onClick={() => setCats(new Set())}>All</button>
            {CATEGORY_ORDER.map((c) => (
              <button key={c} type="button" className={`${s.chip} ${cats.has(c) ? s.chipOn : ''}`} aria-pressed={cats.has(c)} onClick={() => toggleCat(c)}>{CATEGORY_LABEL[c]}</button>
            ))}
          </span>
        </ReportTool>
        <ReportTool label="Rank by"><Segmented options={SORTS} value={sort} onChange={setSort} label="Rank by" /></ReportTool>
        <ReportSwitch on={gifts} onChange={setGifts}>Include gifts</ReportSwitch>
      </ReportToolbar>
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}

      {q.isLoading && (
        <div className={s.skeleton} aria-label="Working the products out">
          {[0, 1, 2, 3].map((i) => <div key={i} className={`skeleton ${s.skeletonBar}`} style={{ width: `${92 - i * 12}%` }} />)}
        </div>
      )}
      {q.isError && <ReportMessage tone="error">The report did not load — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</ReportMessage>}

      {d && (
        <>
          <ReportTiles tiles={tiles} label="Totals" />
          {rows.length === 0 ? (
            <ReportMessage>{`Nothing sold in ${monthText}${cats.size === 0 ? '' : ` (${viewLabel(v)})`}.`}</ReportMessage>
          ) : (
            <>
              {/* One block: the ranking on the left fills the height of the two cards on the right. */}
              <div className={s.charts} role="group" aria-label="Charts">
                <section className={`${s.card} ${s.rankCard}`}>
                  <h3 className={s.cardTitle}>{ranking.title} · top {ranking.bars.length} <span className={s.cardSub}>(bar end: {ranking.end})</span></h3>
                  <RankingChart ref={rankRef} bars={ranking.bars} />
                </section>
                <div className={s.side}>
                  <section className={s.card}>
                    <h3 className={s.cardTitle}>{donut.byCategory ? 'Share of gross profit · by category' : `Share of gross profit · top 6 ${viewLabel(v)}`}</h3>
                    <ShareDonut ref={donutRef} slices={donut.slices} footnote={donutNote} />
                  </section>
                  <section className={s.card}>
                    <h3 className={s.cardTitle}>From sales to gross profit</h3>
                    <ProfitWaterfall ref={fallRef} steps={waterfallOf(totals, gifts)} />
                  </section>
                </div>
              </div>

              <section aria-label="Product profit">
              <DataTable<Ranked>
                tableId="product-profit"
                exportName={fileBase}
                exportXlsx
                freezeHeight="off"
                columns={columns}
                rows={ranked}
                getRowKey={(x) => x.key}
                expandable={{ render: sizes }}
                emptyLabel="No model matches."
              />
              </section>
            </>
          )}
          <ul className={s.notes} aria-label="Report notes">
            {profitNotes(d, v, rows).map((n) => <li key={n}>{n}</li>)}
          </ul>
        </>
      )}
    </>
  );
};
