// ----------------------------------------------------------------------------
// StatementTable — a Finance statement drawn the owner's way (Claude Design,
// batch 6 §4.1): the account column frozen while the figures scroll sideways
// and as wide as its longest name on one line; each period column sized to its
// figures with its % right beside the amount under one header (a small "%"
// caption); a thin rule between periods; the Total column tinted with a
// stronger rule after it. A header edge drags to resize — the account column
// alone, Total alone, every period column together — and a double-click puts
// it back; the widths are remembered per view, and "Reset column widths" under
// the table puts them all back. Exports keep their own widths.
//
// Rows wear their kind: a category 600, an account 400, a subtotal with a rule,
// a calculated row shaded, a strong row (gross profit, total assets) shaded
// darker and bold, the final total petrol-pale with a rule above and a double
// rule below. An account's name opens its lines for the whole period right
// under its row, a figure opens that column's; again closes them; several rows
// may be open. The lines carry "Open in General ledger ›".
// ----------------------------------------------------------------------------

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fmtSenPlain } from '../../../vendor/shared/format';
import { fmtPct, folderOpen, foldsChildren } from '../../../vendor/scm/lib/report-layout';
import { AccountLinesRow } from '../AccountLinesRow';
import { AccountCell } from '../JournalEntryCards';
import type { Level, ReportTree } from '../ReportLayoutTree';
import { columnsSpan, type StatementColumn, type StatementLine } from './statementColumns';
import { useStatementWidths, type WidthGroup } from './statementWidths';
import s from './Statement.module.css';

const DASH = '-';
/** The whole span, as a drill target: an account's name. */
const ALL = '*';

/** An account line's name without the code printed before it. */
export const nameOf = (l: Pick<StatementLine, 'label' | 'code'>): string =>
  l.code && l.label.startsWith(`${l.code} · `) ? l.label.slice(l.code.length + 3) : l.label;

/** The accounts a category stands for: every account line under it. */
export function codesUnder(lines: StatementLine[], i: number): string[] {
  const out: string[] = [];
  const depth = lines[i]!.depth;
  for (let j = i + 1; j < lines.length && lines[j]!.depth > depth; j += 1) {
    const l = lines[j]!;
    if (l.kind === 'row' && l.code) out.push(l.code);
  }
  return out;
}

export type StatementTableProps = {
  /** Whose widths these are: 'single', 'compare', 'month', 'cf-total', 'cf-month', 'tb'. */
  widthsKey: string;
  /** The first header cell. */
  head: string;
  columns: StatementColumn[];
  /** Every line (the fold rule reads them) and the ones shown at the level. */
  lines: StatementLine[];
  shown: StatementLine[];
  level: Level;
  tree: ReportTree;
  showPct: boolean;
  fmt?: (sen: number) => string;
  /** The line the statement ends on — the final total's dress. */
  finalId?: string;
  /** Lines in the strong dress (gross profit, total assets). */
  strongIds?: ReadonlySet<string>;
  /** A category's figure: where its accounts open (the General ledger). */
  onCategoryFigure?: (codes: string[], column: StatementColumn) => void;
  /** A note row under a line (the closing stock under cost of sales). */
  noteAfter?: (line: StatementLine) => ReactNode;
  /** The grey line under the table. */
  note?: ReactNode;
  /** Open lines close when this changes (the dates, the view). */
  drillKey: string;
  ariaLabel: string;
  /** Which rows open lines under them: an account's (its ledger lines, by
   *  default), or every row with figures — a category too (the Cash flow's
   *  entries behind a figure). */
  drillRows?: 'accounts' | 'figures';
  /** What opens under a row instead of an account's ledger lines: the column
   *  pressed (null = the whole span), the close, and the width to span. */
  renderLines?: (line: StatementLine, column: StatementColumn | null, close: () => void, colSpan: number) => ReactNode;
  /** An account row opens elsewhere (the Trial balance's drawer): its name and a
   *  double-click on the row call this; nothing opens under the row. */
  onOpenRow?: (line: StatementLine) => void;
  /** Accounts print as the owner's AccountCell — the code on one line, the name
   *  below (the Trial balance) — instead of the code before the name. */
  accountCell?: boolean;
};

export function StatementTable({
  widthsKey, head, columns, lines, shown, level, tree, showPct, fmt = fmtSenPlain,
  finalId, strongIds, onCategoryFigure, noteAfter, note, drillKey, ariaLabel, drillRows = 'accounts', renderLines,
  onOpenRow, accountCell = false,
}: StatementTableProps) {
  const w = useStatementWidths(widthsKey);
  /* Which rows have their lines open, and on which column (ALL = the whole span). */
  const [drill, setDrill] = useState<Record<string, string>>({});
  useEffect(() => { setDrill({}); }, [drillKey]);
  const toggleDrill = (id: string, key: string) => setDrill((d) => {
    const next = { ...d };
    if (next[id] === key) delete next[id]; else next[id] = key;
    return next;
  });

  /* The lines open under a row as wide as the box shows, wherever it is scrolled. */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<number | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setVisible(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const span = columnsSpan(columns);
  const groupOf = (c: StatementColumn): WidthGroup => (c.kind === 'total' ? 'total' : 'period');
  const widthOf = (g: WidthGroup) => (w.widths[g] ? { width: `${w.widths[g]}px` } : undefined);
  const lastPeriod = columns.length - 1;

  const rowClass = (l: StatementLine): string => {
    if (l.id === finalId) return s.rowFinal;
    if (strongIds?.has(l.id)) return s.rowStrong;
    switch (l.kind) {
      case 'block': return s.rowBlock;
      case 'category': return s.rowCategory;
      case 'total': return s.rowSubtotal;
      case 'net': return s.rowStrong;
      case 'unassigned':
      case 'memo': return s.rowMuted;
      default: return s.rowAccount;
    }
  };

  const handle = (group: WidthGroup) => (
    <span
      className={s.handle}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize · double-click to reset"
      onMouseDown={(e) => w.startResize(group, e)}
      onDoubleClick={() => w.reset(group)}
    />
  );

  return (
    <div className={s.card}>
      <div
        className={s.scroll}
        ref={wrapRef}
        style={visible ? ({ '--st-visible': `${visible}px` } as React.CSSProperties) : undefined}
      >
        <table className={`${s.table} ${w.widths.acc ? s.tableWrapNames : ''}`} aria-label={ariaLabel}>
          <colgroup>
            <col style={widthOf('acc')} />
            {columns.map((c) => <col key={c.key} style={widthOf(groupOf(c))} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={s.headName}>
                <span className={s.headNameText}>{head}</span>
                {handle('acc')}
              </th>
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  scope="col"
                  data-column={c.key}
                  className={[s.headCell, c.kind === 'total' ? s.colTotal : '', i < lastPeriod ? s.colRule : ''].join(' ')}
                >
                  <span className={s.headInner}>
                    <span className={s.headLabel}>
                      {c.label}
                      <span className={s.headSub}>{c.sub ?? ''}</span>
                    </span>
                    {c.pct && showPct && <span className={s.headPct}>%</span>}
                  </span>
                  {handle(groupOf(c))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => {
              const i = lines.indexOf(l);
              const folder = (l.kind === 'category' || l.kind === 'unassigned') && foldsChildren(lines, i);
              const open = folder && folderOpen(l, level, tree.open);
              /* An account row opens its lines by its name; in 'figures' mode any row
                 with figures opens what is behind a figure (a category's: every row under it). */
              const account = l.kind === 'row' && (drillRows === 'figures' || Boolean(l.code));
              const opensElsewhere = Boolean(onOpenRow) && account;
              const drillable = !onOpenRow && (account || (drillRows === 'figures' && (l.kind === 'category' || l.kind === 'unassigned')));
              const drilled = drillable ? drill[l.id] : undefined;
              const drillCol = drilled && drilled !== ALL ? columns.find((c) => c.key === drilled) : undefined;
              const depthPad = 12 + 16 * Math.max(0, l.depth - 1);
              const name = nameOf(l);
              return (
                <Fragment key={l.id}>
                  <tr data-kind={l.kind} data-depth={l.depth} className={rowClass(l)} onDoubleClick={opensElsewhere ? () => onOpenRow?.(l) : undefined}>
                    <th scope="row" className={s.name} style={{ paddingLeft: depthPad }}>
                      <span className={s.nameInner}>
                        {folder ? (
                          <button type="button" className={s.chev} aria-label={`${open ? 'Collapse' : 'Expand'} ${l.label}`} aria-expanded={open}
                            onClick={() => tree.toggle(l.id, open)}>
                            {open ? <ChevronDown size={12} strokeWidth={2} aria-hidden /> : <ChevronRight size={12} strokeWidth={2} aria-hidden />}
                          </button>
                        ) : l.depth > 0 ? <span className={s.leaf} aria-hidden /> : null}
                        {l.code && l.kind !== 'block' && !accountCell && <span className={s.code}>{l.code}</span>}
                        {opensElsewhere ? (
                          <button type="button" className={s.nameBtn} title="Open its lines" onClick={() => onOpenRow?.(l)}>
                            {accountCell && l.code ? <AccountCell code={l.code} name={name} /> : name}
                          </button>
                        ) : account ? (
                          <button type="button" className={s.nameBtn} title="Its lines over the whole period"
                            aria-label={`Lines of ${l.label}`} aria-expanded={drilled === ALL} onClick={() => toggleDrill(l.id, ALL)}>
                            {name}
                          </button>
                        ) : folder ? (
                          <button type="button" className={s.nameBtn} aria-expanded={open} onClick={() => tree.toggle(l.id, open)}>{name}</button>
                        ) : <span className={s.nameText}>{name}</span>}
                      </span>
                    </th>
                    {columns.map((c, ci) => {
                      const cls = [s.cell, c.kind === 'total' ? s.colTotal : '', ci < lastPeriod ? s.colRule : ''].join(' ');
                      if (l.kind === 'block') return <td key={c.key} className={cls} />;
                      const cell = l.cells[c.key];
                      const text = cell ? fmt(cell.amountSen) : DASH;
                      const pct = c.pct && showPct ? (cell ? fmtPct(cell.pct) : DASH) : null;
                      const opens = Boolean(cell) && c.kind !== 'change' && (drillable || (folder && onCategoryFigure));
                      return (
                        <td key={c.key} className={cls}>
                          <span className={s.cellInner}>
                            {opens ? (
                              <button
                                type="button"
                                className={s.figure}
                                aria-label={`${l.label} · ${c.label}`}
                                aria-pressed={drillable ? drilled === c.key : undefined}
                                onClick={() => (drillable ? toggleDrill(l.id, c.key) : onCategoryFigure?.(codesUnder(lines, i), c))}
                              >
                                {text}
                              </button>
                            ) : <span className={cell ? undefined : s.dash}>{text}</span>}
                            {pct !== null && <span className={s.pct} data-pct>{pct}</span>}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                  {drilled && renderLines && renderLines(l, drillCol ?? null, () => toggleDrill(l.id, drilled), columns.length + 1)}
                  {drilled && !renderLines && l.code && (
                    <AccountLinesRow
                      code={l.code}
                      title={`${l.code} ${name}`}
                      from={drillCol ? drillCol.from : span.from}
                      to={drillCol ? drillCol.to : span.to}
                      colSpan={columns.length + 1}
                      onClose={() => toggleDrill(l.id, drilled)}
                    />
                  )}
                  {noteAfter?.(l)}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {(note || w.custom) && (
        <div className={s.foot}>
          <span className={s.footNote}>{note}</span>
          {w.custom && <button type="button" className={s.resetLink} onClick={w.resetAll}>Reset column widths</button>}
        </div>
      )}
    </div>
  );
}

/** The table's shape while the statement loads: a header and rows the size of a statement. */
export function StatementSkeleton({ rows = 12, label = 'Loading the statement' }: { rows?: number; label?: string }) {
  return (
    <div className={s.card} aria-busy="true" aria-label={label}>
      <div className={s.skelHead}><span className={`skeleton ${s.skelBar}`} style={{ width: '22%' }} /></div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.skelRow}>
          <span className={`skeleton ${s.skelBar}`} style={{ width: `${30 + ((i * 17) % 28)}%` }} />
          <span className={`skeleton ${s.skelBar}`} style={{ width: '14%' }} />
        </div>
      ))}
    </div>
  );
}
