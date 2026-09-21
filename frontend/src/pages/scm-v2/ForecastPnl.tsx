// ----------------------------------------------------------------------------
// ForecastPnl — /scm/forecast (owner 2026-09-21: 照 P&L 现在那棵树一行一个户口填
// … 按采购户口填 % … 我可以填 percentage 反推 amount, 也可以填 amount 反推
// percentage 是吗 — 两个都可以，做). A planning grid: months across, the P&L's
// own accounts down, laid on the P&L's layout tree the way the statement
// prints. A sales line takes an amount (the month's forecast sales are their
// sum); every other line a % of that sales figure OR an amount — key one and
// the other box shows what it implies, in grey. Category subtotals, block
// totals, gross profit, profit before tax and net profit follow the
// statement's own arithmetic (vendor/shared/forecast-pnl.ts — the server's
// copy byte for byte, so the Dashboard reads what this page shows). A new
// month inherits the previous month's percentages and starts its amounts
// blank. Save is the whole grid in ONE PUT: a refused save names the cell
// and scrolls to it, and nothing is kept. Nothing here touches the books.
// ----------------------------------------------------------------------------
import { Fragment, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Button } from '@2990s/design-system';
import { PageHeader } from '../../components/Layout';
import { getActiveCompanyId } from '../../lib/activeCompany';
import { fmtMoneyAtRest } from '../../vendor/scm/components/MoneyInput';
import { fmtSenPlain } from '../../vendor/shared/format';
import {
  FORECAST_BLOCKS, blockOfSection, inheritMonth, isAmountCell, isSalesAccount, monthFigures, nextMonth, sortedMonths,
  type ForecastAccount, type ForecastBlockKey, type ForecastCell, type ForecastFigures, type ForecastGrid, type ForecastLines,
} from '../../vendor/shared/forecast-pnl';
import type { LayoutItem } from '../../vendor/scm/lib/report-layout';
import { useForecast, useSaveForecast } from '../../vendor/scm/lib/forecast-queries';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 0, overflowX: 'auto' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'right' };
const td: React.CSSProperties = { padding: '3px 8px', fontSize: 'var(--fs-13)', borderBottom: '1px dashed var(--border-weak, #f0eee8)', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' };
const shaded: React.CSSProperties = { background: 'var(--c-surface-2, #f6f5f0)', fontWeight: 600 };
const danger = 'var(--c-festive-b, #B8331F)';
const input: React.CSSProperties = { padding: '3px 6px', fontSize: 'var(--fs-13)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 4, width: 108, textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', background: 'transparent' };
const pctInput: React.CSSProperties = { ...input, width: 64 };
const chevron: React.CSSProperties = { background: 'none', border: 'none', padding: '0 4px 0 0', cursor: 'pointer', font: 'inherit', color: 'var(--text-soft, #8a8578)', width: 18, display: 'inline-block', textAlign: 'left' };
const nameCol: React.CSSProperties = { position: 'sticky', left: 0, background: 'var(--c-paper, #fff)', zIndex: 1, minWidth: 260 };

/** The month a column names: 09/2026 (the house spelling). */
const monthLabel = (m: string): string => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
/** Basis points as the box shows them: 15, 15.4, 0.25. */
const fmtBp = (bp: number): string => (bp / 100).toFixed(2).replace(/\.?0+$/, '');
/** % of sales for a total line, one decimal; nothing when there are no sales. */
const pctOfSales = (sen: number, salesSen: number): string => (salesSen !== 0 ? `${((sen / salesSen) * 100).toFixed(1)}%` : '—');
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const mytMonth = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);

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
      type="text" inputMode="decimal" style={input} value={draft} data-cell={cellKey} aria-label={label}
      placeholder={impliedSen == null ? '' : fmtMoneyAtRest(impliedSen)}
      onFocus={() => { setFocused(true); setDraft(valueSen == null ? '' : (valueSen / 100).toFixed(2)); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } else if (e.key === 'Escape') { setDraft(fmtMoneyAtRest(valueSen)); e.currentTarget.blur(); } }}
    />
  );
};

/** A share of the month's forecast sales, typed as 15 or 15.4, stored in basis
    points; Esc reverts; a blank clears the cell. Shows the implied share in
    grey while an amount is keyed. */
const PercentBox = ({ bp, impliedBp, onCommit, label, cellKey }: { bp: number | null; impliedBp: number | null; onCommit: (bp: number | null) => void; label: string; cellKey: string }) => {
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
      type="text" inputMode="decimal" style={pctInput} value={draft} data-cell={cellKey} aria-label={label}
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

export const ForecastPnl = () => {
  const q = useForecast();
  const save = useSaveForecast();
  const companyId = getActiveCompanyId();
  const [grid, setGrid] = useState<ForecastGrid | null>(null);
  const [saved, setSaved] = useState<ForecastGrid | null>(null);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [addMonth, setAddMonth] = useState('');
  const [refusal, setRefusal] = useState<{ cell: string | null; message: string } | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

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
  /* The month box shows the next month by default; Add month takes what the box shows, typed or not. */
  const addTarget = addMonth || nextMonth(lastMonth ?? mytMonth());
  /* Index reads typed as possibly absent on purpose: a month the grid does not carry has no figures. */
  const figures = useMemo<Record<string, ForecastFigures | undefined>>(() => Object.fromEntries(months.map((m) => [m, monthFigures(grid?.[m] ?? {}, accounts)])), [months, grid, accounts]);
  const lineOf = (m: string, code: string) => figures[m]?.lines.find((l) => l.code === code);
  const amountOf = (m: string, codes: string[]): number => codes.reduce((s, c) => s + (lineOf(m, c)?.amountSen ?? 0), 0);
  const cellOf = (m: string, code: string): ForecastCell | null => {
    const lines: ForecastLines | undefined = grid?.[m];
    return lines && Object.prototype.hasOwnProperty.call(lines, code) ? lines[code]! : null;
  };
  const keyed = (code: string): boolean => months.some((m) => cellOf(m, code) != null);

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
    setSavedNote(null);
  };
  const removeMonth = (m: string) => {
    setGrid((g) => { if (!g) return g; const next = { ...g }; delete next[m]; return next; });
    setSavedNote(null);
  };
  const add = () => {
    const m = addTarget.trim();
    if (!MONTH_RE.test(m) || !grid) return;
    if (Object.prototype.hasOwnProperty.call(grid, m)) { setRefusal({ cell: null, message: `${monthLabel(m)} is already on the grid.` }); return; }
    const before = months.filter((x) => x < m);
    const prev = before.length > 0 ? before[before.length - 1] : lastMonth;
    setGrid({ ...grid, [m]: inheritMonth(prev ? grid[prev] : undefined) });
    setRefusal(null);
    setSavedNote(null);
    setAddMonth(nextMonth(m));
  };
  const doSave = () => {
    if (!grid) return;
    setRefusal(null);
    save.mutate(grid, {
      onSuccess: () => { setSaved(grid); setSavedNote(`Saved ${sortedMonths(grid).length} month${sortedMonths(grid).length === 1 ? '' : 's'}.`); },
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

  if (q.isError) return <div style={{ color: danger }}>{errText(q.error)}</div>;
  if (!grid || !q.data) return <div style={soft}>Loading…</div>;

  const colSpan = 1 + months.length * 2;
  const TotalRow = ({ label, sen, strong = false, id }: { label: string; sen: (m: string) => number; strong?: boolean; id: string }) => (
    <tr data-row={id} style={shaded}>
      <td style={{ ...td, ...nameCol, ...shaded, fontWeight: strong ? 700 : 600 }}>{label}</td>
      {months.map((m) => {
        const v = sen(m);
        return (
          <Fragment key={m}>
            <td style={{ ...td, ...num, fontWeight: strong ? 700 : 600, color: v < 0 && strong ? danger : undefined }}>{fmtSenPlain(v)}</td>
            <td style={{ ...td, ...num, ...soft }}>{pctOfSales(v, figures[m]?.salesSen ?? 0)}</td>
          </Fragment>
        );
      })}
    </tr>
  );
  const after = (key: ForecastBlockKey): ReactElement | null => {
    if (key === 'costOfSales') return <TotalRow id="gross-profit" label="GROSS PROFIT" strong sen={(m) => figures[m]?.totals.grossProfitSen ?? 0} />;
    if (key === 'expenses') return <TotalRow id="profit-before-tax" label="PROFIT BEFORE TAX" strong sen={(m) => figures[m]?.totals.profitBeforeTaxSen ?? 0} />;
    if (key === 'taxation') return <TotalRow id="net-profit" label="NET PROFIT" strong sen={(m) => figures[m]?.totals.netProfitSen ?? 0} />;
    return null;
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

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance · Forecasting" title="Forecast P&L"
        description="Targets on the P&L's own tree, a column per month. A sales line takes an amount — the month's forecast sales are their sum. Every other line takes a % of those sales or an amount; key one and the other shows what it implies. A new month inherits the percentages. Nothing here touches the books." />
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="month" value={addTarget} onChange={(e) => setAddMonth(e.target.value)} aria-label="Month to add" style={{ ...input, width: 150, textAlign: 'left', fontFamily: 'inherit' }} />
        <Button variant="secondary" size="sm" onClick={add}>Add month</Button>
        <Button variant="ghost" size="sm" onClick={() => setHideEmpty((h) => !h)}>{hideEmpty ? 'Show empty lines' : 'Hide empty lines'}</Button>
        <span style={{ flex: 1 }} />
        {dirty && <span style={{ ...soft, color: danger, fontWeight: 600 }}>Not saved</span>}
        {!dirty && savedNote && <span style={soft}>{savedNote}</span>}
        <Button variant="primary" size="sm" onClick={doSave} disabled={!dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </div>
      {refusal && <div role="alert" style={{ color: danger, fontSize: 'var(--fs-13)' }}>{refusal.message}</div>}
      {months.length === 0 && <div style={soft}>No month yet — pick one above and press Add month.</div>}
      {months.length > 0 && (
        <div style={card}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...th, ...nameCol, textAlign: 'left' }}>Account</th>
                {months.map((m) => (
                  <th key={m} colSpan={2} style={{ ...th, textAlign: 'center' }}>
                    <span>{monthLabel(m)}</span>
                    <button type="button" onClick={() => removeMonth(m)} aria-label={`Remove ${monthLabel(m)}`} title="Remove this month (on Save)" style={{ ...chevron, width: 'auto', marginLeft: 6 }}>×</button>
                  </th>
                ))}
              </tr>
              <tr>
                <th style={{ ...th, ...nameCol }} />
                {months.map((m) => (
                  <Fragment key={m}>
                    <th style={th}>RM</th>
                    <th style={th}>% sales</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <Fragment key={b.key}>
                  <tr data-row={`block:${b.key}`}><td colSpan={colSpan} style={{ ...td, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', paddingTop: 10, ...nameCol, background: 'var(--c-paper, #fff)' }}>{b.title}</td></tr>
                  {visibleRows(b).map((r) => r.kind === 'category' ? (
                    <tr key={r.id} data-row={r.id}>
                      <td style={{ ...td, ...nameCol, paddingLeft: 8 + (r.depth - 1) * 16, fontWeight: 600 }}>
                        <button type="button" onClick={() => setClosed((c) => ({ ...c, [r.id]: !c[r.id] }))} aria-label={`${closed[r.id] ? 'Open' : 'Close'} ${r.label}`} style={chevron}>{closed[r.id] ? '▸' : '▾'}</button>
                        {r.label}
                      </td>
                      {months.map((m) => {
                        const v = amountOf(m, r.codes);
                        return (
                          <Fragment key={m}>
                            <td style={{ ...td, ...num, fontWeight: 600 }}>{fmtSenPlain(v)}</td>
                            <td style={{ ...td, ...num, ...soft }}>{pctOfSales(v, figures[m]?.salesSen ?? 0)}</td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  ) : (
                    <tr key={r.id} data-row={r.id}>
                      <td style={{ ...td, ...nameCol, paddingLeft: 8 + (r.depth - 1) * 16 + 18, lineHeight: 1.25 }}>
                        <span>{r.account.code}</span><br /><span style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #555)' }}>{r.account.name}</span>
                      </td>
                      {months.map((m) => {
                        const cell = cellOf(m, r.account.code);
                        const line = lineOf(m, r.account.code);
                        const sales = isSalesAccount(r.account);
                        const amount = cell && isAmountCell(cell) ? cell.amtSen : null;
                        const bp = cell && !isAmountCell(cell) ? cell.bp : null;
                        return (
                          <Fragment key={m}>
                            <td style={{ ...td, ...num }}>
                              <AmountBox valueSen={amount} impliedSen={bp != null ? (line?.amountSen ?? 0) : null} label={`${m} ${r.account.code} amount`} cellKey={`${m} ${r.account.code} amount`}
                                onCommit={(sen) => setCell(m, r.account.code, sen == null ? null : { amtSen: sen })} />
                            </td>
                            <td style={{ ...td, ...num }}>
                              {sales
                                ? <span style={soft}>{cell ? pctOfSales(line?.amountSen ?? 0, figures[m]?.salesSen ?? 0) : ''}</span>
                                : <PercentBox bp={bp} impliedBp={amount != null ? line?.bp ?? null : null} label={`${m} ${r.account.code} percent`} cellKey={`${m} ${r.account.code} percent`}
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
      )}
    </div>
  );
};
