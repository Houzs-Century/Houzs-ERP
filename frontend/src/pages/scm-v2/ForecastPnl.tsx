// ----------------------------------------------------------------------------
// ForecastPnl — /scm/forecast (owner 2026-09-21: 照 P&L 现在那棵树一行一个户口填
// … 按采购户口填 % … 我可以填 percentage 反推 amount, 也可以填 amount 反推
// percentage 是吗 — 两个都可以，做). A planning grid: months across, the P&L's
// own accounts down, laid on the P&L's layout tree the way the statement
// prints. A sales line takes an amount (the month's forecast sales are their
// sum); every other line a % OR an amount — key one and the other box shows
// what it implies, in grey. A % is of the month's sales, except on a purchase
// line, whose % is of its OWN group's sales (owner 2026-09-29: purchase of
// bedding 应该是根据回他的 sales 的 amount 算，而不是 total sales — the item-group
// bindings say which; the box's tooltip names them). Category subtotals, block
// totals, gross profit, profit before tax and net profit follow the
// statement's own arithmetic (vendor/shared/forecast-pnl.ts — the server's
// copy byte for byte, so the Dashboard reads what this page shows). A new
// month inherits the previous month's percentages and starts its amounts
// blank. Save is the whole grid in ONE PUT: a refused save names the cell
// and scrolls to it, and nothing is kept. Nothing here touches the books.
//
// In the owner's Claude Design (batch 6 §5.10, step 15), inside the report
// shell: the months it covers as the grey line; the bar — Add month (the six
// after the last, or Other…), "A new month inherits the % of the month
// before.", Show / Hide empty lines, Unsaved changes, Save; the grid in the
// Finance dress with each month's RM and % sales; toasts for an added month
// and a save; Excel / PDF / Print of the grid as shown.
// ----------------------------------------------------------------------------
import { Fragment, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Plus, X } from 'lucide-react';
import { ReportShell } from './reports/ReportShell';
import { getActiveCompanyId } from '../../lib/activeCompany';
import { fmtMoneyAtRest } from '../../vendor/scm/components/MoneyInput';
import { fmtSenPlain } from '../../vendor/shared/format';
import {
  FORECAST_BLOCKS, blockOfSection, inheritMonth, isAmountCell, isSalesAccount, monthFigures, nextMonth, sortedMonths,
  type ForecastAccount, type ForecastBlockKey, type ForecastCell, type ForecastFigures, type ForecastGrid, type ForecastLines,
} from '../../vendor/shared/forecast-pnl';
import type { LayoutItem } from '../../vendor/scm/lib/report-layout';
import { AMOUNT_COLUMN, type ReportSheet, type SheetRow } from '../../vendor/scm/lib/report-sheet';
import { useForecast, useSaveForecast } from '../../vendor/scm/lib/forecast-queries';
import { useBooksToast } from './books/BooksToast';
import { ReportExports, ReportHeaderActions, ReportMessage, useReportSubtitle } from './reports/reportParts';
import { monthName } from './reports/statementColumns';
import f from './reports/Forecast.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');

/** The month a column names: "Sep 2026" (as the statements' month columns). */
const monthLabel = (m: string): string => monthName(m);
/** "September 2026" — a month in the Add month list and the toast. */
const monthFull = (m: string): string =>
  new Date(`${m}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** Basis points as the box shows them: 15, 15.4, 0.25. */
const fmtBp = (bp: number): string => (bp / 100).toFixed(2).replace(/\.?0+$/, '');
/** % of sales for a total line, one decimal; nothing when there are no sales. */
const pctOfSales = (sen: number, salesSen: number): string => (salesSen !== 0 ? `${((sen / salesSen) * 100).toFixed(1)}%` : '—');
/** What a line's % box is a share of — the tooltip on the box. */
const basisTitle = (a: ForecastAccount): string =>
  (a.basis && a.basis.length > 0 ? `% of this line's own sales: ${a.basis.join(' + ')}` : "% of the month's sales");
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const mytMonth = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
/** The six months a new one is picked from: those after the last on the grid (or from this month). */
export const monthsToAdd = (last: string | undefined, today: string): string[] => {
  const out: string[] = [];
  let m = last ? nextMonth(last) : today;
  for (let i = 0; i < 6; i += 1) { out.push(m); m = nextMonth(m); }
  return out;
};
const OTHER = 'other';

/* ── The rows: the P&L's tree over the forecast's accounts ──────────────── */

type Row =
  | { kind: 'category'; id: string; depth: number; label: string; codes: string[] }
  | { kind: 'account'; id: string; depth: number; account: ForecastAccount };
type Block = { key: ForecastBlockKey; title: string; rows: Row[]; codes: string[] };

/** One block's rows: the layout's categories (a company's unticked ones
    skipped) holding the accounts they place, then whatever the tree did not
    place under Unassigned — every account of the block prints somewhere. */
function layBlock(items: LayoutItem[], accounts: ForecastAccount[], companyId: number | null): { rows: Row[]; codes: string[] } {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const placed = new Set<string>();
  const take = (code: string | undefined, depth: number): Row[] => {
    const a = code ? byCode.get(code) : undefined;
    if (!a || placed.has(a.code)) return [];
    placed.add(a.code);
    return [{ kind: 'account', id: `acc:${a.code}`, depth, account: a }];
  };
  const walk = (list: LayoutItem[], depth: number): Row[] => {
    const out: Row[] = [];
    for (const it of list) {
      if (it.kind === 'account') { out.push(...take(it.code, depth)); continue; }
      if (it.kind === 'subtotal') continue;
      if (companyId != null && it.hiddenFor?.includes(companyId)) continue;
      const kids: Row[] = [...take(it.code, depth + 1), ...walk(it.children, depth + 1)];
      if (kids.length === 0) continue;
      const codes = kids.flatMap((r) => (r.kind === 'account' ? [r.account.code] : []));
      out.push({ kind: 'category', id: it.id, depth, label: it.label, codes }, ...kids);
    }
    return out;
  };
  const rows = walk(items, 1);
  const rest = accounts.filter((a) => !placed.has(a.code)).sort((a, b) => a.code.localeCompare(b.code));
  if (rest.length > 0) {
    rows.push({ kind: 'category', id: 'unassigned', depth: 1, label: 'Unassigned', codes: rest.map((a) => a.code) });
    for (const a of rest) rows.push({ kind: 'account', id: `acc:${a.code}`, depth: 2, account: a });
  }
  return { rows, codes: accounts.map((a) => a.code) };
}

/* ── The two boxes of a cell ─────────────────────────────────────────────── */

/** An amount in RM, typed free, parsed on blur or Enter (a discount on a sales
    line may be negative — it reduces the month's sales); Esc reverts; a blank
    clears the cell. Shows the implied amount in grey while a % is keyed. */
const AmountBox = ({ valueSen, impliedSen, onCommit, label, cellKey }: { valueSen: number | null; impliedSen: number | null; onCommit: (sen: number | null) => void; label: string; cellKey: string }) => {
  const [draft, setDraft] = useState(fmtMoneyAtRest(valueSen));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(fmtMoneyAtRest(valueSen)); }, [valueSen, focused]);
  const commit = () => {
    const t = draft.trim().replace(/[,\s]/g, '');
    if (t === '' || t === '-') { if (valueSen != null) onCommit(null); setDraft(''); return; }
    const n = Number(t);
    if (!/^-?\d+(\.\d{1,2})?$/.test(t) || !Number.isFinite(n)) { setDraft(fmtMoneyAtRest(valueSen)); return; }
    const sen = Math.round(n * 100);
    if (sen !== valueSen) onCommit(sen);
    setDraft(fmtMoneyAtRest(sen));
  };
  return (
    <input
      type="text" inputMode="decimal" className={`${f.box} ${valueSen != null ? f.boxTyped : ''}`} value={draft} data-cell={cellKey} aria-label={label}
      placeholder={impliedSen == null ? '' : fmtMoneyAtRest(impliedSen)}
      onFocus={() => { setFocused(true); setDraft(valueSen == null ? '' : (valueSen / 100).toFixed(2)); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } else if (e.key === 'Escape') { setDraft(fmtMoneyAtRest(valueSen)); e.currentTarget.blur(); } }}
    />
  );
};

/** A share of the line's basis (the month's sales, or a purchase line's own
    group's sales), typed as 15 or 15.4, stored in basis points; Esc reverts; a
    blank clears the cell. Shows the implied share in grey while an amount is
    keyed; the tooltip says what the share is of. */
const PercentBox = ({ bp, impliedBp, onCommit, label, cellKey, title }: { bp: number | null; impliedBp: number | null; onCommit: (bp: number | null) => void; label: string; cellKey: string; title?: string }) => {
  const [draft, setDraft] = useState(bp == null ? '' : fmtBp(bp));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(bp == null ? '' : fmtBp(bp)); }, [bp, focused]);
  const commit = () => {
    const t = draft.trim().replace(/%/g, '');
    if (t === '') { if (bp != null) onCommit(null); return; }
    const n = Number(t);
    if (!/^\d+(\.\d{1,2})?$/.test(t) || !Number.isFinite(n)) { setDraft(bp == null ? '' : fmtBp(bp)); return; }
    const next = Math.round(n * 100);
    if (next !== bp) onCommit(next);
    setDraft(fmtBp(next));
  };
  return (
    <input
      type="text" inputMode="decimal" className={`${f.box} ${f.pctBox} ${bp != null ? f.boxTyped : ''}`} value={draft} data-cell={cellKey} aria-label={label} title={title}
      placeholder={impliedBp == null ? '' : fmtBp(impliedBp)}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } else if (e.key === 'Escape') { setDraft(bp == null ? '' : fmtBp(bp)); e.currentTarget.blur(); } }}
    />
  );
};

/* ── What a refused save says ────────────────────────────────────────────── */

const CELL_RE = /^(\d{4}-\d{2}(?: [^\s:]+)?(?: amount| percent)?)/;
/** The server names the cell ("2026-10 900-T003 amount") and says why; the
    page shows the sentence and scrolls to the cell it names. */
export function refusalOf(e: unknown): { cell: string | null; message: string } {
  const o = (e ?? {}) as { cell?: unknown; body?: unknown };
  let message = errText(e);
  let named: string | null = typeof o.cell === 'string' ? o.cell : null;
  /* The raw body rides the error (authed-fetch): the server's own cell and
     sentence, when they are there, beat the client's rewording. */
  if (typeof o.body === 'string') {
    try {
      const b = JSON.parse(o.body) as { cell?: unknown; message?: unknown };
      if (typeof b.cell === 'string') named = b.cell;
      if (typeof b.message === 'string' && b.message) message = b.message;
    } catch { /* not JSON — the sentence stands */ }
  }
  if (named) return { cell: named, message };
  const m = CELL_RE.exec(message);
  return { cell: m ? m[1]! : null, message };
}

const sameGrid = (a: ForecastGrid, b: ForecastGrid): boolean => JSON.stringify(a) === JSON.stringify(b);
const hasAnyCell = (g: ForecastGrid): boolean => Object.values(g).some((lines) => Object.keys(lines).length > 0);

/* ── The page ────────────────────────────────────────────────────────────── */

/** In the Finance report shell (batch 6 §4.3), under Reports › Plan. */
export const ForecastPnl = () => (
  <ReportShell report="forecast">
    <ForecastGridPage />
  </ReportShell>
);

const NOTE = 'Sales lines take an amount; every other line takes a % of that month’s sales — a purchase line, of its own group’s sales — or an amount. '
  + 'Type in either box: the one you typed is kept and the other shows what it implies, in grey. Subtotals, gross profit, profit before tax and net profit follow the P&L’s layout. '
  + 'Nothing here posts to the books.';

function ForecastGridPage() {
  const q = useForecast();
  const save = useSaveForecast();
  const toast = useBooksToast();
  const companyId = getActiveCompanyId();
  const [grid, setGrid] = useState<ForecastGrid | null>(null);
  const [saved, setSaved] = useState<ForecastGrid | null>(null);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [pick, setPick] = useState('');
  const [otherMonth, setOtherMonth] = useState('');
  const [refusal, setRefusal] = useState<{ cell: string | null; message: string } | null>(null);

  /* The server's grid becomes the page's the first time, and again whenever
     nothing typed would be lost by it. */
  useEffect(() => {
    if (!q.data) return;
    if (grid && saved && !sameGrid(grid, saved)) return;
    setGrid(q.data.months);
    setSaved(q.data.months);
    setHideEmpty(hasAnyCell(q.data.months));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the server's grid is adopted only when nothing typed stands in the way; grid/saved are the guard, not a trigger
  }, [q.data]);

  const accounts = useMemo(() => q.data?.accounts ?? [], [q.data]);
  const blocks = useMemo<Block[]>(() => FORECAST_BLOCKS.map((b) => {
    const own = accounts.filter((a) => blockOfSection(a.section) === b.key);
    const laid = layBlock(q.data?.layout.blocks[b.key] ?? [], own, companyId);
    return { key: b.key, title: b.title, rows: laid.rows, codes: laid.codes };
  }), [accounts, q.data, companyId]);

  const months = useMemo(() => (grid ? sortedMonths(grid) : []), [grid]);
  const lastMonth = months.length > 0 ? months[months.length - 1] : undefined;
  const firstMonth = months.length > 0 ? months[0] : undefined;
  /* Add month offers the six months after the last on the grid; Other… takes any month. */
  const choices = monthsToAdd(lastMonth, mytMonth());
  const picked = pick && (pick === OTHER || choices.includes(pick)) ? pick : (choices[0] ?? '');
  const addTarget = picked === OTHER ? otherMonth : picked;
  /* Index reads typed as possibly absent on purpose: a month the grid does not carry has no figures. */
  const figures = useMemo<Record<string, ForecastFigures | undefined>>(() => Object.fromEntries(months.map((m) => [m, monthFigures(grid?.[m] ?? {}, accounts)])), [months, grid, accounts]);
  const lineOf = (m: string, code: string) => figures[m]?.lines.find((l) => l.code === code);
  const amountOf = (m: string, codes: string[]): number => codes.reduce((s, c) => s + (lineOf(m, c)?.amountSen ?? 0), 0);
  const cellOf = (m: string, code: string): ForecastCell | null => {
    const lines: ForecastLines | undefined = grid?.[m];
    return lines && Object.prototype.hasOwnProperty.call(lines, code) ? lines[code]! : null;
  };
  const keyed = (code: string): boolean => months.some((m) => cellOf(m, code) != null);

  useReportSubtitle(firstMonth && lastMonth
    ? `${monthLabel(firstMonth)} – ${monthLabel(lastMonth)} · ${months.length} ${months.length === 1 ? 'month' : 'months'} · targets per account on the P&L’s layout`
    : 'No month yet');

  const dirty = grid != null && saved != null && !sameGrid(grid, saved);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const setCell = (m: string, code: string, cell: ForecastCell | null) => {
    setGrid((g) => {
      if (!g) return g;
      const lines: ForecastLines = { ...(g[m] ?? {}) };
      if (cell) lines[code] = cell; else delete lines[code];
      return { ...g, [m]: lines };
    });
  };
  const removeMonth = (m: string) => {
    setGrid((g) => { if (!g) return g; const next = { ...g }; delete next[m]; return next; });
  };
  const add = () => {
    const m = addTarget.trim();
    if (!MONTH_RE.test(m) || !grid) return;
    if (Object.prototype.hasOwnProperty.call(grid, m)) { setRefusal({ cell: null, message: `${monthFull(m)} is already on the grid.` }); return; }
    const before = months.filter((x) => x < m);
    const prev = before.length > 0 ? before[before.length - 1] : lastMonth;
    setGrid({ ...grid, [m]: inheritMonth(prev ? grid[prev] : undefined) });
    setRefusal(null);
    setPick('');
    toast.say(`${monthFull(m)} added · type its sales; every other line kept its %`);
  };
  const doSave = () => {
    if (!grid) return;
    if (!dirty) { toast.say('Nothing to save'); return; }
    setRefusal(null);
    save.mutate(grid, {
      onSuccess: () => {
        const n = sortedMonths(grid).length;
        setSaved(grid);
        toast.say(`Forecast saved · ${n} ${n === 1 ? 'month' : 'months'}`);
      },
      onError: (e) => {
        const r = refusalOf(e);
        setRefusal(r);
        if (r.cell) {
          const el = document.querySelector<HTMLInputElement>(`[data-cell="${r.cell}"]`);
          if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
          el?.focus();
        }
      },
    });
  };

  /* Rows fold under a closed category; empty accounts hide when asked. */
  const visibleRows = (block: Block): Row[] => {
    const out: Row[] = [];
    let closedAt: number | null = null;
    for (const r of block.rows) {
      if (closedAt != null && r.depth > closedAt) continue;
      closedAt = null;
      if (r.kind === 'account') {
        if (hideEmpty && !keyed(r.account.code)) continue;
        out.push(r);
      } else {
        if (hideEmpty && !r.codes.some(keyed)) continue;
        out.push(r);
        if (closed[r.id]) closedAt = r.depth;
      }
    }
    return out;
  };
  const blockTotal = (key: ForecastBlockKey, m: string): number => {
    const t = figures[m]?.totals;
    if (!t) return 0;
    switch (key) {
      case 'tradingIncome': return t.tradingIncomeSen;
      case 'costOfSales': return t.costOfSalesSen;
      case 'otherIncome': return t.otherIncomeSen;
      case 'expenses': return t.expensesSen;
      default: return t.taxationSen;
    }
  };
  /* The statement's lines after a block: gross profit, profit before tax, net profit. */
  const afterOf = (key: ForecastBlockKey): { id: string; label: string; sen: (m: string) => number } | null => {
    if (key === 'costOfSales') return { id: 'gross-profit', label: 'GROSS PROFIT', sen: (m) => figures[m]?.totals.grossProfitSen ?? 0 };
    if (key === 'expenses') return { id: 'profit-before-tax', label: 'PROFIT BEFORE TAX', sen: (m) => figures[m]?.totals.profitBeforeTaxSen ?? 0 };
    if (key === 'taxation') return { id: 'net-profit', label: 'NET PROFIT', sen: (m) => figures[m]?.totals.netProfitSen ?? 0 };
    return null;
  };

  /* The grid as shown — the lines open, the empty ones as the switch has them — for Excel / PDF / Print. */
  const sheet = (): ReportSheet | null => {
    if (!grid || !firstMonth || !lastMonth) return null;
    const rows: SheetRow[] = [];
    for (const b of blocks) {
      rows.push({ kind: 'block', depth: 0, label: b.title, cells: [] });
      for (const r of visibleRows(b)) {
        rows.push(r.kind === 'category'
          ? { kind: 'category', depth: r.depth, label: r.label, cells: months.map((m) => amountOf(m, r.codes)) }
          : { kind: 'row', depth: r.depth, label: `${r.account.code} · ${r.account.name}`, cells: months.map((m) => lineOf(m, r.account.code)?.amountSen ?? 0) });
      }
      rows.push({ kind: 'total', depth: 0, label: `TOTAL ${b.title.toUpperCase()}`, cells: months.map((m) => blockTotal(b.key, m)) });
      const after = afterOf(b.key);
      if (after) rows.push({ kind: 'net', depth: 0, label: after.label, cells: months.map(after.sen) });
    }
    return {
      title: 'Forecast P&L',
      subtitle: `${monthLabel(firstMonth)} – ${monthLabel(lastMonth)} · targets per account on the P&L’s layout`,
      meta: [{ label: 'Period', value: `${monthLabel(firstMonth)} – ${monthLabel(lastMonth)}` }, { label: 'Rows', value: 'Targets per account · amounts' }],
      tables: [{ columns: months.map((m) => AMOUNT_COLUMN(monthLabel(m))), rows }],
      notes: [NOTE],
    };
  };

  if (q.isError) return <ReportMessage tone="error">{errText(q.error)}</ReportMessage>;
  if (!grid || !q.data) return <ReportMessage>Loading…</ReportMessage>;

  const colSpan = 1 + months.length * 2;
  const TotalRow = ({ label, sen, strong = false, id }: { label: string; sen: (m: string) => number; strong?: boolean; id: string }) => (
    <tr data-row={id} className={strong ? f.strongRow : f.totalRow}>
      <td className={f.name}>{label}</td>
      {months.map((m) => {
        const v = sen(m);
        return (
          <Fragment key={m}>
            <td className={`${f.cell} ${v < 0 && strong ? f.loss : ''}`}>{fmtSenPlain(v)}</td>
            <td className={f.pctCell}>{pctOfSales(v, figures[m]?.salesSen ?? 0)}</td>
          </Fragment>
        );
      })}
    </tr>
  );
  const after = (key: ForecastBlockKey): ReactElement | null => {
    const a = afterOf(key);
    return a ? <TotalRow id={a.id} label={a.label} strong sen={a.sen} /> : null;
  };

  return (
    <>
      <ReportHeaderActions>
        <ReportExports sheet={sheet} fileBase={firstMonth && lastMonth ? `forecast-pnl-${firstMonth}-to-${lastMonth}` : 'forecast-pnl'} />
      </ReportHeaderActions>
      {toast.node}
      <div className={f.bar} role="toolbar" aria-label="Forecast tools">
        <span className={f.barLabel}>Add month</span>
        <select className={f.select} value={picked} onChange={(e) => setPick(e.target.value)} aria-label="Month to add">
          {choices.map((m) => <option key={m} value={m}>{monthFull(m)}</option>)}
          <option value={OTHER}>Other…</option>
        </select>
        {picked === OTHER && (
          <input type="month" className={f.monthInput} value={otherMonth} onChange={(e) => setOtherMonth(e.target.value)} aria-label="Other month to add" />
        )}
        <button type="button" className={f.btn} onClick={add}><Plus size={13} strokeWidth={2.5} aria-hidden />Add month</button>
        <span className={f.hint}>A new month inherits the % of the month before.</span>
        <span className={f.grow} />
        <button type="button" className={f.toggle} onClick={() => setHideEmpty((h) => !h)}>{hideEmpty ? 'Show empty lines' : 'Hide empty lines'}</button>
        {dirty && <span className={f.unsaved}>Unsaved changes</span>}
        <button type="button" className={`${f.save} ${dirty ? '' : f.saveIdle}`} onClick={doSave} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </div>
      {refusal && <p role="alert" className={f.alert}>{refusal.message}</p>}
      {months.length === 0 && <p className={f.empty}>No month yet — pick one above and press Add month.</p>}
      {months.length > 0 && (
        <div className={f.card}>
          <div className={f.scroll}>
            <table className={f.table}>
              <thead>
                <tr>
                  <th className={`${f.name} ${f.nameHead}`} rowSpan={2}>Account</th>
                  {months.map((m) => (
                    <th key={m} colSpan={2} className={f.th}>
                      <span className={f.monthHead}>
                        <span>{monthLabel(m)}</span>
                        <button type="button" className={f.remove} onClick={() => removeMonth(m)} aria-label={`Remove ${monthLabel(m)}`} title="Remove this month (on Save)">
                          <X size={10} strokeWidth={2.5} aria-hidden />
                        </button>
                      </span>
                    </th>
                  ))}
                </tr>
                <tr>
                  {months.map((m) => (
                    <Fragment key={m}>
                      <th className={f.sub}>RM</th>
                      <th className={f.sub}>% sales</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {blocks.map((b) => (
                  <Fragment key={b.key}>
                    <tr data-row={`block:${b.key}`} className={f.blockRow}><td colSpan={colSpan} className={f.name}>{b.title}</td></tr>
                    {visibleRows(b).map((r) => r.kind === 'category' ? (
                      <tr key={r.id} data-row={r.id} className={f.catRow}>
                        <td className={f.name} style={{ paddingLeft: 12 + (r.depth - 1) * 18 }}>
                          <button type="button" onClick={() => setClosed((c) => ({ ...c, [r.id]: !c[r.id] }))} aria-label={`${closed[r.id] ? 'Open' : 'Close'} ${r.label}`} className={f.chevron}>{closed[r.id] ? '▸' : '▾'}</button>
                          {r.label}
                        </td>
                        {months.map((m) => {
                          const v = amountOf(m, r.codes);
                          return (
                            <Fragment key={m}>
                              <td className={f.cell}>{fmtSenPlain(v)}</td>
                              <td className={f.pctCell}>{pctOfSales(v, figures[m]?.salesSen ?? 0)}</td>
                            </Fragment>
                          );
                        })}
                      </tr>
                    ) : (
                      <tr key={r.id} data-row={r.id} className={f.row}>
                        {/* One line, `code · name`, the report trees' own label (owner 2026-09-22:
                            the two-line shape belongs to the journal and GL line tables). */}
                        <td className={f.name} style={{ paddingLeft: 12 + (r.depth - 1) * 18 + 18 }}>{r.account.code} · {r.account.name}</td>
                        {months.map((m) => {
                          const cell = cellOf(m, r.account.code);
                          const line = lineOf(m, r.account.code);
                          const sales = isSalesAccount(r.account);
                          const amount = cell && isAmountCell(cell) ? cell.amtSen : null;
                          const bp = cell && !isAmountCell(cell) ? cell.bp : null;
                          return (
                            <Fragment key={m}>
                              <td className={f.cell}>
                                <AmountBox valueSen={amount} impliedSen={bp != null ? (line?.amountSen ?? 0) : null} label={`${m} ${r.account.code} amount`} cellKey={`${m} ${r.account.code} amount`}
                                  onCommit={(sen) => setCell(m, r.account.code, sen == null ? null : { amtSen: sen })} />
                              </td>
                              <td className={f.pctCell}>
                                {sales
                                  ? <span>{cell ? pctOfSales(line?.amountSen ?? 0, figures[m]?.salesSen ?? 0) : ''}</span>
                                  : <PercentBox bp={bp} impliedBp={amount != null ? line?.bp ?? null : null} label={`${m} ${r.account.code} percent`} cellKey={`${m} ${r.account.code} percent`}
                                      title={basisTitle(r.account)}
                                      onCommit={(next) => setCell(m, r.account.code, next == null ? null : { bp: next })} />}
                              </td>
                            </Fragment>
                          );
                        })}
                      </tr>
                    ))}
                    <TotalRow id={`total:${b.key}`} label={`TOTAL ${b.title.toUpperCase()}`} sen={(m) => blockTotal(b.key, m)} />
                    {after(b.key)}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className={f.note}>{NOTE}</div>
        </div>
      )}
    </>
  );
}
