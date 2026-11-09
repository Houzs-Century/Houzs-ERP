// ----------------------------------------------------------------------------
// MerchantChargesReport — the Merchant charges tab (owner 2026-09-12: 我需要知道
// merchant charge 多少%，就是 charge / received amount，每个月的然后每个 merchant
// … 每个不同 merchant 都要能看到，我指的是 gross … 每个月全部 merchant 加起来的%).
// A month is a block: its line across every merchant first, then a line per
// merchant; a merchant opens to the reports (files) behind it. The fee % is
// the merchant's fee against the gross; the bank's own payout charge sits
// beside it and the two together are the total charge %.
//
// Cash and Online are rows too (owner 2026-09-14, docs/bugs/0900: 这个 merchant
// charge 其实会包括 cash online，只是 % 是 0 percent): the payments keyed on
// sales orders that no merchant carried, at 0%, opening to the payments
// themselves; they count in the month's line and the total.
//
// In the owner's Claude Design (batch 6 step 12, §5.6): the report shell, the
// shared range in whole months, Merchant and Lines in the toolbar, the tiles
// (worked once from the same read), the chart of fee % by merchant over the
// chart's months (the same read for those months), the grid with resizable
// columns (fin-mc-cw), Excel / PDF / Print as shown, the CSV under ⋯.
// ----------------------------------------------------------------------------

import { guardFormula } from '../../lib/csv';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  CASH_CHANNEL, ONLINE_CHANNEL, channelLabel, channelOrder, paymentFigures, useMerchantChargesReport,
  type ChargeAcquirer, type ChargeFigures, type MerchantChargesReport,
} from '../../vendor/scm/lib/merchant-charges-queries';
import { AMOUNT_COLUMN, PCT_COLUMN, type ReportSheet, type SheetColumn, type SheetRow } from '../../vendor/scm/lib/report-sheet';
import { fmtDate, fmtDateOrDash, fmtSenPlain } from '../../vendor/shared/format';
import { useColumnWidths, type ColumnWidthSpec } from './finance/useColumnWidths';
import { FinanceDateRange } from './reports/FinanceDateRange';
import { useReportRange } from './reports/useReportRange';
import {
  ReportExports, ReportHeaderActions, ReportMessage, ReportMore, ReportTiles, ReportTool, ReportToolbar, Segmented, useReportSubtitle,
  type ReportTile,
} from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import { REPORT_CHART_COLORS, ReportBarChart, useChartMonths, type ChartBarSeries, type ChartMonth } from './reports/ReportBarChart';
import { windowMonths, type ChartWindow } from './reports/chartWindow';
import mc from './reports/MerchantCharges.module.css';

const fmtRm = (sen: number): string => fmtSenPlain(sen);
const fmtPct = (pct: number): string => `${pct.toFixed(1)}%`;
const monthOf = (ym: string): string => monthName(`${ym}-01`);
const isCard = (acquirer: string): boolean => acquirer !== CASH_CHANNEL && acquirer !== ONLINE_CHANNEL;

const COLUMNS = ['Month / merchant', 'Lines', 'Gross', 'Merchant fee', 'Fee %', 'Bank charge', 'Total charge', 'Charge %', 'Net'] as const;
const WIDTHS: ColumnWidthSpec = {
  defaults: ['minmax(220px,1fr)', '64px', '120px', '112px', '72px', '112px', '112px', '80px', '120px'],
  min: [160, 48, 90, 80, 56, 80, 80, 60, 90],
  fit: [false, true, true, true, true, true, true, true, true],
};

/* The table as CSV: a month line, its merchants, their reports — or, under
   Cash and Online, the payments. */
export const merchantChargesCsv = (r: MerchantChargesReport): string => {
  const esc = (v: string | number | null) => `"${guardFormula(String(v ?? '')).replace(/"/g, '""')}"`;
  const figures = (f: ChargeFigures) => [f.lines, fmtRm(f.grossSen), fmtRm(f.feeSen), fmtPct(f.feePct), fmtRm(f.bankChargeSen), fmtRm(f.chargeSen), fmtPct(f.chargePct), fmtRm(f.netSen)];
  const lines: string[] = [COLUMNS.map(esc).join(',')];
  for (const m of r.months) {
    lines.push([`${m.month} · all merchants`, ...figures(m)].map(esc).join(','));
    for (const a of m.acquirers) {
      const label = channelLabel(a.acquirer);
      lines.push([`${m.month} · ${label}`, ...figures(a)].map(esc).join(','));
      for (const rep of a.reports) lines.push([`${m.month} · ${label} · ${rep.fileName ?? `batch ${rep.batchId}`}`, ...figures(rep)].map(esc).join(','));
      for (const p of a.payments ?? []) {
        lines.push([`${m.month} · ${label} · ${p.docNo} ${p.paidOn}${p.subType ? ` ${p.subType}` : ''}`, ...figures(paymentFigures(p))].map(esc).join(','));
      }
    }
  }
  lines.push(['Total', ...figures(r.totals)].map(esc).join(','));
  return `${lines.join('\n')}\n`;
};

const downloadText = (name: string, text: string) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

/** The tiles' figures, worked once from the read: the totals, and the cards' share apart from cash and online. */
export function chargeTileFigures(r: MerchantChargesReport) {
  let cardGrossSen = 0;
  for (const m of r.months) for (const a of m.acquirers) if (isCard(a.acquirer)) cardGrossSen += a.grossSen;
  const ofCards = (sen: number) => (cardGrossSen > 0 ? (sen / cardGrossSen) * 100 : null);
  return {
    grossSen: r.totals.grossSen,
    cashOnlineSen: r.totals.grossSen - cardGrossSen,
    feeSen: r.totals.feeSen,
    feePctCards: ofCards(r.totals.feeSen),
    bankChargeSen: r.totals.bankChargeSen,
    chargePct: r.totals.chargePct,
    chargePctCards: ofCards(r.totals.chargeSen),
  };
}

const merchantSub = (a: ChargeAcquirer): string => {
  const n = a.payments ? a.payments.length : a.reports.length;
  const what = a.payments ? 'payment' : 'report';
  return `· ${n} ${what}${n === 1 ? '' : 's'}`;
};

/** The grid as the screen shows it — the opened merchants' files or payments
 *  included — for Excel and PDF. */
export function merchantChargesSheet(r: MerchantChargesReport, open: ReadonlySet<string>, subtitle: string): ReportSheet {
  const cols: SheetColumn[] = [
    { label: 'Lines', kind: 'text' }, AMOUNT_COLUMN('Gross'), AMOUNT_COLUMN('Merchant fee'), PCT_COLUMN('Fee %'),
    AMOUNT_COLUMN('Bank charge'), AMOUNT_COLUMN('Total charge'), PCT_COLUMN('Charge %'), AMOUNT_COLUMN('Net'),
  ];
  const cells = (f: ChargeFigures) => [String(f.lines), f.grossSen, f.feeSen, f.feePct, f.bankChargeSen || null, f.chargeSen, f.chargePct, f.netSen];
  const rows: SheetRow[] = [];
  for (const m of r.months) {
    rows.push({ kind: 'category', depth: 0, label: `${monthOf(m.month)} · all merchants`, cells: cells(m) });
    for (const a of m.acquirers) {
      rows.push({ kind: 'row', depth: 1, label: `${channelLabel(a.acquirer)} ${merchantSub(a)}`, cells: cells(a) });
      if (!open.has(`${m.month}|${a.acquirer}`)) continue;
      for (const rep of a.reports) rows.push({ kind: 'memo', depth: 2, label: `${rep.fileName ?? `batch ${rep.batchId}`} · swiped ${swiped(rep.periodFrom, rep.periodTo)}`, cells: cells(rep) });
      for (const p of a.payments ?? []) rows.push({ kind: 'memo', depth: 2, label: `${p.docNo} · ${fmtDateOrDash(p.paidOn)}${p.subType ? ` · ${p.subType}` : ''}`, cells: cells(paymentFigures(p)) });
    }
  }
  rows.push({ kind: 'total', depth: 0, label: `Total · ${r.months.length} month${r.months.length === 1 ? '' : 's'}`, cells: cells(r.totals) });
  return {
    title: 'Merchant charges',
    subtitle,
    meta: [{ label: 'Months', value: `${monthOf(r.from)} – ${monthOf(r.to)}` }, { label: 'Lines', value: r.confirmedOnly ? 'Confirmed only' : 'All lines' }],
    tables: [{ columns: cols, rows }],
    notes: [NOTE_FEES, NOTE_CASH],
  };
}

const swiped = (from: string | null, to: string | null): string =>
  `${fmtDateOrDash(from)}${to && to !== from ? ` – ${fmtDate(to)}` : ''}`;

const NOTE_FEES = 'Fee % is the merchant’s fee against the gross they reported. Bank charge is what the bank took on the payout day (booked on Payment advice); Charge % is fee and bank charge together against the gross. A merchant opens to its reports.';
const NOTE_CASH = 'Cash and Online are the payments keyed on sales orders, by payment date, with no fee; they count in the month and the total, and open to the payments.';

/* ── The chart (batch 6 §5.6): fee % by merchant, month by month, the charge %
   under each month — the same read over the chart's months. ── */
const MERCHANT_COLORS = [REPORT_CHART_COLORS.petrol, REPORT_CHART_COLORS.gold, REPORT_CHART_COLORS.grey, '#0c3f39', '#a16a2e', '#5f6459'];

export function chargeChartMonths(win: ChartWindow | null, r: MerchantChargesReport | undefined): { series: ChartBarSeries[]; months: ChartMonth[] } {
  if (!win) return { series: [], months: [] };
  const acquirers = [...new Set((r?.months ?? []).flatMap((m) => m.acquirers.map((a) => a.acquirer)).filter(isCard))].sort(channelOrder);
  const series = acquirers.map((a, i) => ({ key: a, label: channelLabel(a), color: MERCHANT_COLORS[i % MERCHANT_COLORS.length]! }));
  const byMonth = new Map((r?.months ?? []).map((m) => [`${m.month}-01`, m]));
  const months = windowMonths(win).map((month): ChartMonth => {
    const m = byMonth.get(month);
    if (!m) return { month, values: {}, bottom: [], under: null };
    return {
      month,
      values: Object.fromEntries(m.acquirers.filter((a) => isCard(a.acquirer)).map((a) => [a.acquirer, a.feePct])),
      bottom: [{ label: 'Charge %', value: fmtPct(m.chargePct) }, { label: 'Gross', value: fmtRm(m.grossSen) }],
      under: { text: fmtPct(m.chargePct), loss: false },
    };
  });
  return { series, months };
}

function ChargesChart({ win, acquirer, confirmedOnly }: { win: ChartWindow; acquirer: string | null; confirmedOnly: boolean }) {
  const q = useMerchantChargesReport(win.from.slice(0, 7), win.to.slice(0, 7), acquirer, confirmedOnly);
  const { series, months } = chargeChartMonths(win, q.data);
  return (
    <ReportBarChart
      title="Fee % by merchant, month by month"
      series={series}
      months={months}
      win={win}
      loading={q.isLoading}
      failed={q.isError}
      unit="pct"
      fmtValue={fmtPct}
      note={`Under each month: charge % across ${acquirer ? 'the merchant chosen' : 'every merchant, cash and online included'}. Shaded months are in the period; click a month to show it alone.`}
    />
  );
}

type Lines = 'all' | 'confirmed';
const LINES: ReadonlyArray<{ value: Lines; label: string }> = [{ value: 'all', label: 'All lines' }, { value: 'confirmed', label: 'Confirmed only' }];

export const MerchantChargesTab = () => {
  const r = useReportRange();
  const from = r.usable ? r.from.slice(0, 7) : '';
  const to = r.usable ? r.to.slice(0, 7) : '';
  const [acquirer, setAcquirer] = useState<string | null>(null);
  const [lines, setLines] = useState<Lines>('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const q = useMerchantChargesReport(from, to, acquirer, lines === 'confirmed');
  const d = q.data;
  const cw = useColumnWidths('mc', WIDTHS);
  const chartWin = useChartMonths(r.from, r.to, r.usable);

  /* The merchants the range had, for the filter — remembered off an
     unfiltered answer so picking one does not empty the list. Acquirers
     first, then Cash and Online, as the table lists them. */
  const [merchants, setMerchants] = useState<string[]>([]);
  useEffect(() => {
    if (d && acquirer == null) setMerchants([...new Set(d.months.flatMap((m) => m.acquirers.map((a) => a.acquirer)))].sort(channelOrder));
  }, [d, acquirer]);

  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const subtitle = r.usable
    ? `${monthOf(from)} – ${monthOf(to)} · cards by swipe date, cash and online by payment date · ${lines === 'confirmed' ? 'confirmed lines only' : 'every line'}`
    : 'Pick dates.';
  useReportSubtitle(subtitle);

  const t = useMemo(() => (d ? chargeTileFigures(d) : null), [d]);
  const tiles: ReportTile[] = [
    { key: 'gross', label: 'Gross received', value: t ? fmtRm(t.grossSen) : '', sub: t ? `Cash and online ${fmtRm(t.cashOnlineSen)}` : '' },
    { key: 'fees', label: 'Merchant fees', value: t ? fmtRm(t.feeSen) : '', sub: t ? `${t.feePctCards == null ? '—' : fmtPct(t.feePctCards)} of card sales` : '' },
    { key: 'bank', label: 'Bank charges', value: t ? fmtRm(t.bankChargeSen) : '', sub: 'Taken on payout days' },
    { key: 'charge', label: 'Charge %', value: t ? fmtPct(t.chargePct) : '', sub: t ? `Cards only ${t.chargePctCards == null ? '—' : fmtPct(t.chargePctCards)}` : '' },
  ];

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={() => (d ? merchantChargesSheet(d, open, subtitle) : null)} fileBase={`merchant-charges-${from}-${to}`} />
        <ReportMore items={[{ label: 'CSV', disabled: !d, onClick: () => { if (d) downloadText(`merchant-charges-${from}-${to}.csv`, merchantChargesCsv(d)); } }]} />
      </ReportHeaderActions>
      <ReportToolbar>
        <FinanceDateRange />
        <ReportTool label="Merchant">
          <select className={mc.select} value={acquirer ?? ''} onChange={(e) => setAcquirer(e.target.value || null)} aria-label="Merchant">
            <option value="">Every merchant</option>
            {merchants.map((m) => <option key={m} value={m}>{channelLabel(m)}</option>)}
          </select>
        </ReportTool>
        <ReportTool label="Lines"><Segmented options={LINES} value={lines} onChange={setLines} label="Lines" /></ReportTool>
      </ReportToolbar>
      {!r.usable && <ReportMessage>Pick dates.</ReportMessage>}
      {r.usable && q.isError && <ReportMessage tone="error">The report did not load — adjust the months to retry.</ReportMessage>}
      {r.usable && !q.isError && <ReportTiles label="Merchant charges figures" tiles={tiles} pending={!d} />}
      {chartWin && r.usable && <ChargesChart win={chartWin} acquirer={acquirer} confirmedOnly={lines === 'confirmed'} />}
      {r.usable && q.isLoading && <div className={`skeleton ${mc.card}`} style={{ height: 240 }} aria-busy="true" aria-label="Working the months out" />}
      {d && (
        <>
          <div className={mc.card}>
            <div data-cw-root="mc" className={mc.grid} style={{ minWidth: cw.minWidth }} role="table" aria-label="Merchant charges">
              <div data-cw-row="" className={`${mc.row} ${mc.head}`} style={{ gridTemplateColumns: cw.template }} role="row">
                {COLUMNS.map((c, i) => (
                  <div key={c} data-cw-cell={i} role="columnheader" className={`${mc.headCell} ${i > 0 ? mc.num : ''}`}>
                    <span data-cw-lbl="">{c}</span>
                    <span className={mc.resize} {...cw.handle(i)}><span className={mc.resizeLine} /></span>
                  </div>
                ))}
              </div>
              {d.months.length === 0 && <p className={mc.empty}>No merchant report and no keyed payment in these months.</p>}
              {d.months.map((m) => (
                <Fragment key={m.month}>
                  <FigureRow template={cw.template} className={mc.month} label={<>{monthOf(m.month)} <span className={mc.sub}>· all merchants</span></>} f={m} />
                  {m.acquirers.map((a) => {
                    const key = `${m.month}|${a.acquirer}`;
                    const isOpen = open.has(key);
                    const what = a.payments ? 'payments' : 'reports';
                    return (
                      <Fragment key={key}>
                        <FigureRow template={cw.template} className={`${mc.merchant} ${isOpen ? mc.merchantOpen : ''}`} f={a} label={(
                          <button type="button" className={`${mc.toggle} ${mc.indent}`} onClick={() => toggle(key)} aria-expanded={isOpen}
                            aria-label={`${isOpen ? 'Hide' : 'Show'} the ${what} of ${channelLabel(a.acquirer)} for ${m.month}`}>
                            {isOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                            <span>{channelLabel(a.acquirer)}</span> <span className={mc.sub}>{merchantSub(a)}</span>
                          </button>
                        )} />
                        {isOpen && !a.payments && a.reports.map((rep) => (
                          <FigureRow key={rep.batchId} template={cw.template} className={mc.detail} f={rep} data={{ 'data-report': String(rep.batchId) }} label={(
                            <span className={mc.detailName}><span>{rep.fileName ?? `batch ${rep.batchId}`}</span> <span className={mc.sub}>· swiped {swiped(rep.periodFrom, rep.periodTo)}</span></span>
                          )} />
                        ))}
                        {isOpen && a.payments?.map((p) => (
                          <FigureRow key={p.id} template={cw.template} className={mc.detail} f={paymentFigures(p)} data={{ 'data-payment': p.id }} label={(
                            <span className={mc.detailName}><span>{p.docNo}</span> <span className={mc.sub}>· {fmtDateOrDash(p.paidOn)}{p.subType ? ` · ${p.subType}` : ''}</span></span>
                          )} />
                        ))}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
              {d.months.length > 0 && (
                <FigureRow template={cw.template} className={mc.total} f={d.totals} label={`Total · ${d.months.length} month${d.months.length === 1 ? '' : 's'}`} />
              )}
            </div>
          </div>
          <div className={mc.foot}>
            <p className={mc.note}>{NOTE_FEES} {NOTE_CASH}</p>
            {cw.custom && <button type="button" className={mc.reset} onClick={cw.reset}>Reset column widths</button>}
          </div>
        </>
      )}
    </>
  );
};

/** One line of the grid: its name, then the eight figures. */
function FigureRow({ template, className, label, f, data }: {
  template: string; className: string; label: React.ReactNode; f: ChargeFigures; data?: Record<string, string>;
}) {
  return (
    <div data-cw-row="" className={`${mc.row} ${className}`} style={{ gridTemplateColumns: template }} role="row" {...data}>
      <div role="cell" className={mc.cell}>{label}</div>
      <div role="cell" className={`${mc.cell} ${mc.num}`}><span data-cw-lbl="">{f.lines}</span></div>
      <div role="cell" className={`${mc.cell} ${mc.num}`}><span data-cw-lbl="">{fmtRm(f.grossSen)}</span></div>
      <div role="cell" className={`${mc.cell} ${mc.num}`}><span data-cw-lbl="">{fmtRm(f.feeSen)}</span></div>
      <div role="cell" className={`${mc.cell} ${mc.num}`}><span data-cw-lbl="">{fmtPct(f.feePct)}</span></div>
      <div role="cell" className={`${mc.cell} ${mc.num} ${f.bankChargeSen > 0 ? mc.charge : ''}`}><span data-cw-lbl="">{f.bankChargeSen > 0 ? fmtRm(f.bankChargeSen) : '—'}</span></div>
      <div role="cell" className={`${mc.cell} ${mc.num}`}><span data-cw-lbl="">{fmtRm(f.chargeSen)}</span></div>
      <div role="cell" className={`${mc.cell} ${mc.num}`}><span data-cw-lbl="">{fmtPct(f.chargePct)}</span></div>
      <div role="cell" className={`${mc.cell} ${mc.num}`}><span data-cw-lbl="">{fmtRm(f.netSen)}</span></div>
    </div>
  );
}
