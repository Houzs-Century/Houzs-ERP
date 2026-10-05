// ----------------------------------------------------------------------------
// ProductProfit — Finance › Reports › Product Profit, the monthly product
// profit ranking (owner 2026-10-05: 「我每个月什么产品最好卖，同时要兼顾售价和成
// 本，不能只单单看销量」). As he settled it: one row per model, a sofa in sets
// (「按套」); the month by SO date (「按开单月」); the gifts in or out by a switch
// on the table; any number of categories at once (「别限制两个」), so mattresses
// and bedframes read together (「床架和床垫一起」) with each mattress showing
// the bedframes it gave away; the charts he kept — the ranking, a donut and
// the waterfall. Every word on the screen is English (字体要英文). Excel and
// PDF draw the table as shown; "Charts PNG" draws the three charts.
// ----------------------------------------------------------------------------

import { Fragment, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Image as ImageIcon, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useProductProfit, type ProductCategory } from '../../vendor/scm/lib/product-profit-queries';
import { downloadReportXlsx } from '../../vendor/scm/lib/report-sheet-xlsx';
import { generateReportPdf } from '../../vendor/scm/lib/report-sheet-pdf';
import { todayMyt } from '../../vendor/scm/lib/dates';
import { fmtSen, fmtSenPlain } from '../../vendor/shared/format';
import {
  CATEGORY_LABEL, CATEGORY_ORDER, donutOf, freeBedframesText, giftsLabel, gpOf, gpPctOf, productProfitSheet, profitNotes,
  showsFreeBedframes, totalsOf, unitsText, viewLabel, viewRows, waterfallOf, type ProfitView, type SortKey,
} from './product-profit-view';
import { ProfitWaterfall, RankingChart, ShareDonut, chartsPng, compact } from './ProductProfitCharts';

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const th: React.CSSProperties = {
  padding: '6px 8px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em',
  color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left',
};
const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--border-weak, #efede6)', verticalAlign: 'top' };
const chip = (on: boolean): React.CSSProperties => ({
  padding: '4px 12px', borderRadius: 999, fontSize: 'var(--fs-12)', cursor: 'pointer',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  background: on ? 'var(--c-ink)' : 'transparent', color: on ? 'var(--c-cream)' : 'var(--c-ink)',
});
const tile: React.CSSProperties = {
  border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 'var(--radius-md, 8px)', padding: '10px 12px', minWidth: 0,
};
const tileLabel: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const tileValue: React.CSSProperties = { fontSize: 'var(--fs-18, 18px)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' };
const money = (sen: number): string => (sen === 0 ? '—' : fmtSenPlain(sen));
const pctText = (p: number | null): string => (p == null ? '—' : `${p.toFixed(1)}%`);
const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'gp', label: 'Gross profit' },
  { key: 'units', label: 'Units sold' },
  { key: 'sales', label: 'Sales' },
  { key: 'gpPct', label: 'Margin' },
];

export const ProductProfitTab = () => {
  const [month, setMonth] = useState(() => todayMyt().slice(0, 7));
  const [cats, setCats] = useState<Set<ProductCategory>>(new Set());
  const [gifts, setGifts] = useState(true);
  const [sort, setSort] = useState<SortKey>('gp');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = useProductProfit(month);
  const d = q.data;
  const v: ProfitView = useMemo(() => ({ cats, gifts, sort }), [cats, gifts, sort]);
  const rows = useMemo(() => (d ? viewRows(d, v) : []), [d, v]);
  const totals = useMemo(() => totalsOf(rows, gifts), [rows, gifts]);
  const donut = useMemo(() => donutOf(rows, v), [rows, v]);
  const rankRef = useRef<SVGSVGElement>(null);
  const donutRef = useRef<SVGSVGElement>(null);
  const fallRef = useRef<SVGSVGElement>(null);

  const toggleCat = (c: ProductCategory) => setCats((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c); else next.add(c);
    return next;
  });
  const toggleRow = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const top = useMemo(() => [...rows].sort((a, b) => gpOf(b, gifts) - gpOf(a, gifts)).slice(0, 10), [rows, gifts]);
  const shownMonth = d?.month ?? month;
  const fileBase = `product-profit-${shownMonth}`;
  const title = `Product Profit · ${shownMonth} · ${viewLabel(v)} · ${giftsLabel(gifts)}`;
  const donutNote = donut.losers.count > 0
    ? `${donut.losers.count} ${donut.byCategory ? (donut.losers.count === 1 ? 'category' : 'categories') : (donut.losers.count === 1 ? 'model' : 'models')} lost money (${compact(donut.losers.sen)}) — not in the donut`
    : undefined;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
        <span style={soft}>Month</span>
        <input type="month" value={month} onChange={(e) => { if (e.target.value) setMonth(e.target.value); }} aria-label="Month" style={{ padding: '4px 6px', fontSize: 'var(--fs-13)' }} />
        <button type="button" style={chip(cats.size === 0)} aria-pressed={cats.size === 0} onClick={() => setCats(new Set())}>All</button>
        {CATEGORY_ORDER.map((c) => (
          <button key={c} type="button" style={chip(cats.has(c))} aria-pressed={cats.has(c)} onClick={() => toggleCat(c)}>{CATEGORY_LABEL[c]}</button>
        ))}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-13)' }}>
          <input type="checkbox" checked={gifts} onChange={(e) => setGifts(e.target.checked)} />
          Include gifts
        </label>
        <span style={soft}>Rank by</span>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Rank by" style={{ fontSize: 'var(--fs-13)' }}>
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" disabled={!d} onClick={() => { if (d) void downloadReportXlsx(productProfitSheet(d, v, rows), `${fileBase}.xlsx`); }}>
          <Download size={16} strokeWidth={1.75} /> Excel
        </Button>
        <Button variant="ghost" size="sm" disabled={!d} onClick={() => { if (d) void generateReportPdf(productProfitSheet(d, v, rows), { fileName: `${fileBase}.pdf` }); }}>
          <Printer size={16} strokeWidth={1.75} /> PDF
        </Button>
        <Button variant="ghost" size="sm" disabled={!d || rows.length === 0} onClick={() => { void chartsPng([rankRef.current, donutRef.current, fallRef.current], title, `${fileBase}-charts.png`); }}>
          <ImageIcon size={16} strokeWidth={1.75} /> Charts PNG
        </Button>
      </div>

      {q.isLoading && <div style={soft} role="status">Working the products out…</div>}
      {q.isError && <div role="alert" style={{ color: 'var(--c-festive-b, #B8331F)' }}>The report did not load — {q.error instanceof Error ? q.error.message : 'something went wrong.'}</div>}

      {d && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-2)' }} aria-label="Totals">
            <div style={tile}><div style={tileLabel}>Sales</div><div style={tileValue}>{fmtSen(totals.salesSen)}</div></div>
            <div style={tile}><div style={tileLabel}>Gross profit</div><div style={tileValue}>{fmtSen(totals.gpSen)}</div></div>
            <div style={tile}><div style={tileLabel}>Margin</div><div style={tileValue}>{pctText(totals.gpPct)}</div></div>
            <div style={tile}>
              <div style={tileLabel}>{gifts ? 'Gifts' : 'Gifts (not counted)'}</div>
              <div style={{ ...tileValue, color: gifts ? undefined : 'var(--fg-muted)' }}>{fmtSen(totals.giftSen)}</div>
            </div>
            {showsFreeBedframes(v) && (
              <div style={tile}>
                <div style={tileLabel}>Free bedframes</div>
                <div style={tileValue}>{d.freeBedframes.pieces} {d.freeBedframes.pieces === 1 ? 'pc' : 'pcs'} · {fmtSen(d.freeBedframes.sen)}</div>
              </div>
            )}
          </div>

          {rows.length === 0 ? (
            <div style={soft}>{`Nothing sold in ${shownMonth}${cats.size === 0 ? '' : ` (${viewLabel(v)})`}.`}</div>
          ) : (
            <>
              <div>
                <div style={{ ...soft, marginBottom: 6 }}>Gross profit ranking · top {top.length} (bar end: gross profit · margin)</div>
                <RankingChart ref={rankRef} bars={top.map((r) => ({ label: r.model, valueSen: gpOf(r, gifts), note: `${compact(gpOf(r, gifts))} · ${r.noCostLines > 0 && r.costSen === 0 ? 'no cost' : pctText(gpPctOf(r, gpOf(r, gifts)))}` }))} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-3)' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...soft, marginBottom: 6 }}>{donut.byCategory ? 'Share of gross profit · by category' : `Share of gross profit · top 6 ${viewLabel(v)}`}</div>
                  <ShareDonut ref={donutRef} slices={donut.slices} footnote={donutNote} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...soft, marginBottom: 6 }}>From sales to gross profit</div>
                  <ProfitWaterfall ref={fallRef} steps={waterfallOf(totals, gifts)} />
                </div>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }} aria-label="Product profit">
                  <thead>
                    <tr>
                      <th style={th}>#</th>
                      <th style={th}>Model</th>
                      <th style={th}>Category</th>
                      <th style={{ ...th, ...num }}>Sold</th>
                      <th style={{ ...th, ...num }}>Avg price</th>
                      <th style={{ ...th, ...num }}>Sales</th>
                      <th style={{ ...th, ...num }}>Product cost</th>
                      {gifts && <th style={{ ...th, ...num }} title="Its share of the gifts on the orders that bought it">Gifts</th>}
                      <th style={{ ...th, ...num }}>Gross profit</th>
                      <th style={{ ...th, ...num }}>Margin</th>
                      <th style={{ ...th, ...num }} title="Bedframes given free on the orders that bought it">Free bedframes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const gp = gpOf(r, gifts);
                      const isOpen = open.has(r.key);
                      return (
                        <Fragment key={r.key}>
                          <tr>
                            <td style={{ ...td, ...soft }}>{i + 1}</td>
                            <td style={td}>
                              <button type="button" onClick={() => toggleRow(r.key)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} ${r.model}'s sizes`}
                                style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'inherit', font: 'inherit', textAlign: 'left' }}>
                                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <span style={{ fontWeight: 600 }}>{r.model}</span>
                                {r.brand ? <span style={soft}> · {r.brand}</span> : null}
                              </button>
                              {r.noCostLines > 0 && <div style={{ fontSize: 'var(--fs-11)', color: 'var(--c-festive-b, #B8331F)' }}>Cost incomplete · {r.noCostLines} {r.noCostLines === 1 ? 'line has' : 'lines have'} no cost</div>}
                            </td>
                            <td style={td}>{CATEGORY_LABEL[r.category]}</td>
                            <td style={{ ...td, ...num }}>{unitsText(r)}</td>
                            <td style={{ ...td, ...num }}>{r.units > 0 ? fmtSenPlain(Math.round(r.salesSen / r.units)) : '—'}</td>
                            <td style={{ ...td, ...num }}>{money(r.salesSen)}</td>
                            <td style={{ ...td, ...num }}>{money(r.costSen)}</td>
                            {gifts && <td style={{ ...td, ...num }}>{money(r.giftSen)}</td>}
                            <td style={{ ...td, ...num, fontWeight: 600, color: gp < 0 ? 'var(--c-festive-b, #B8331F)' : undefined }}>{money(gp)}</td>
                            <td style={{ ...td, ...num }}>{pctText(gpPctOf(r, gp))}</td>
                            <td style={{ ...td, ...num, ...soft }}>{freeBedframesText(r) || '—'}</td>
                          </tr>
                          {isOpen && r.items.map((it) => (
                            <tr key={`${r.key}-${it.code}`} style={{ background: 'var(--c-cream, #f7f5ef)' }}>
                              <td style={td} />
                              <td style={{ ...td, paddingLeft: 28 }} colSpan={2}>
                                <span style={{ fontFamily: 'var(--font-mono)' }}>{it.code}</span>
                                {it.size ? <span style={soft}> · {it.size}</span> : null}
                              </td>
                              <td style={{ ...td, ...num, ...soft }}>{it.units > 0 ? it.units : '—'}</td>
                              <td style={td} />
                              <td style={{ ...td, ...num, ...soft }}>{money(it.salesSen)}</td>
                              <td style={{ ...td, ...num, ...soft }}>{money(it.costSen)}</td>
                              {gifts && <td style={td} />}
                              <td style={{ ...td, ...num, ...soft }}>{money(it.salesSen - it.costSen)}</td>
                              <td style={td} />
                              <td style={td} />
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                    <tr style={{ fontWeight: 700, borderTop: '2px solid var(--c-ink, #221f20)' }}>
                      <td style={td} />
                      <td style={td} colSpan={4}>Total · {rows.length} {rows.length === 1 ? 'model' : 'models'}</td>
                      <td style={{ ...td, ...num }}>{money(totals.salesSen)}</td>
                      <td style={{ ...td, ...num }}>{money(totals.costSen)}</td>
                      {gifts && <td style={{ ...td, ...num }}>{money(totals.giftSen)}</td>}
                      <td style={{ ...td, ...num }}>{money(totals.gpSen)}</td>
                      <td style={{ ...td, ...num }}>{pctText(totals.gpPct)}</td>
                      <td style={td} />
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}

          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }} aria-label="Report notes">
            {profitNotes(d, v, rows).map((n) => <li key={n} style={soft}>{n}</li>)}
          </ul>
        </>
      )}
    </section>
  );
};
