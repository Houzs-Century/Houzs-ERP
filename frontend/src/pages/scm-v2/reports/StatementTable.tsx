
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { fmtSenPlain } from '../../../../../shared/src/vendor/shared/format';
import { fmtPct, folderOpen, foldsChildren, totalsBelow } from '../../../vendor/scm/lib/report-layout';
import { AccountLinesRow } from '../AccountLinesRow';
import { AccountCell } from '../JournalEntryCards';
import type { Level, ReportTree } from '../ReportLayoutTree';
import { columnsSpan, type StatementColumn, type StatementLine } from './statementColumns';
import { useStatementWidths, type WidthGroup } from './statementWidths';
import s from './Statement.module.css';

const DASH = '-';
const ALL = '*';

/** An account line's name without the code printed before it. */
export const nameOf = (l: Pick<StatementLine, 'label' | 'code'>): string =>
  l.code && l.label.startsWith(`${l.code} · `) ? l.label.slice(l.code.length + 3) : l.label;

/** The columns a line's running cells cover — every column after a cell's first, by index. */
export function coveredBy(columns: StatementColumn[], spans: StatementLine['spans']): Set<number> {
  const out = new Set<number>();
  if (!spans) return out;
  columns.forEach((c, ci) => {
    for (let k = 1; k < (spans[c.key] ?? 1); k += 1) out.add(ci + k);
  });
  return out;
}

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
  widthsKey: string;
  head: string;
  columns: StatementColumn[];
  lines: StatementLine[];
  shown: StatementLine[];
  level: Level;
  tree: ReportTree;
  showPct: boolean;
  fmt?: (sen: number) => string;
  finalId?: string;
  strongIds?: ReadonlySet<string>;
  onCategoryFigure?: (codes: string[], column: StatementColumn) => void;
  noteAfter?: (line: StatementLine) => ReactNode;
  note?: ReactNode;
  drillKey: string;
  ariaLabel: string;
  drillRows?: 'accounts' | 'figures';
  renderLines?: (line: StatementLine, column: StatementColumn | null, close: () => void, colSpan: number) => ReactNode;
  figureOpens?: (line: StatementLine, column: StatementColumn, across: boolean) => boolean;
  onOpenRow?: (line: StatementLine) => void;
  accountCell?: boolean;
};

export function StatementTable({
  widthsKey, head, columns, lines, shown, level, tree, showPct, fmt = fmtSenPlain,
  finalId, strongIds, onCategoryFigure, noteAfter, note, drillKey, ariaLabel, drillRows = 'accounts', renderLines,
  figureOpens, onOpenRow, accountCell = false,
}: StatementTableProps) {
  const w = useStatementWidths(widthsKey);
  const [drill, setDrill] = useState<Record<string, string>>({});
  useEffect(() => { setDrill({}); }, [drillKey]);
  const toggleDrill = (id: string, key: string) => setDrill((d) => {
    const next = { ...d };
    if (next[id] === key) delete next[id]; else next[id] = key;
    return next;
  });

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
  const grouped = columns.some((c) => c.group);
  const sameGroup = (a: StatementColumn | undefined, b: StatementColumn | undefined): boolean =>
    Boolean(a?.group && b?.group && a.group.key === b.group.key);
  const ruleAfter = (ci: number): boolean => ci < lastPeriod && !sameGroup(columns[ci], columns[ci + 1]);
  /* The Settlement / Deposit look (owner 2026-11-10: 做好看一点, on the mock): every other
     heading on a faint band, the newest first, so a figure reads against its own month; a
     faint dashed rule inside a heading, a firm one where it ends. */
  const bandOf = new Map<string, boolean>();
  for (const c of columns) if (c.group && !bandOf.has(c.group.key)) bandOf.set(c.group.key, bandOf.size % 2 === 0);
  const banded = (c: StatementColumn): boolean => Boolean(c.group && bandOf.get(c.group.key));
  const rules = (ci: number): string => {
    if (ruleAfter(ci)) return columns[ci]?.group ? `${s.colRule} ${s.groupRule}` : s.colRule;
    return sameGroup(columns[ci], columns[ci + 1]) ? s.partRule : '';
  };
  const runOf = (ci: number): number => {
    let n = 1;
    while (sameGroup(columns[ci], columns[ci + n])) n += 1;
    return n;
  };
  const columnName = (c: StatementColumn, across: boolean): string =>
    (c.group ? (across ? c.group.label : `${c.group.label} ${c.label}`) : c.label);

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
        <table className={[s.table, grouped ? s.tableGrouped : '', w.widths.acc ? s.tableWrapNames : ''].join(' ')} aria-label={ariaLabel}>
          <colgroup>
            <col style={widthOf('acc')} />
            {columns.map((c) => <col key={c.key} style={widthOf(groupOf(c))} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={s.headName} rowSpan={grouped ? 2 : undefined}>
                <span className={s.headNameText}>{head}</span>
                {handle('acc')}
              </th>
              {columns.map((c, i) => {
                if (c.group) {
                  if (sameGroup(columns[i - 1], c)) return null;
                  const n = runOf(i);
                  return (
                    <th key={`group:${c.group.key}`} scope="colgroup" colSpan={n} data-group={c.group.key}
                      className={[s.headCell, s.headGroup, rules(i + n - 1), banded(c) ? s.band : ''].join(' ')}>
                      <span className={s.headInner}>
                        <span className={s.headLabel}>
                          {c.group.label}
                          <span className={s.headSub}>{c.group.sub ?? ''}</span>
                        </span>
                      </span>
                    </th>
                  );
                }
                return (
                  <th
                    key={c.key}
                    scope="col"
                    data-column={c.key}
                    rowSpan={grouped ? 2 : undefined}
                    className={[s.headCell, c.kind === 'total' ? s.colTotal : '', rules(i)].join(' ')}
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
                );
              })}
            </tr>
            {grouped && (
              <tr>
                {columns.map((c, i) => c.group && (
                  <th key={c.key} scope="col" data-column={c.key} className={[s.headCell, s.headPart, rules(i), banded(c) ? s.band : ''].join(' ')}>
                    <span className={s.headInner}>
                      <span className={s.headLabel}>
                        {c.mark && <span className={s.mark} data-mark={c.mark} aria-hidden />}
                        {c.label}
                      </span>
                      {c.pct && showPct && <span className={s.headPct}>%</span>}
                    </span>
                    {handle(groupOf(c))}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {totalsBelow(shown, lines, level, tree.open).map((l) => {
              const i = l.totalOf || l.bare ? lines.findIndex((x) => x.id === (l.totalOf ?? l.id)) : lines.indexOf(l);
              const sub = Boolean(l.totalOf);
              const own = sub ? lines[i]! : l;
              const folder = !sub && (l.kind === 'category' || l.kind === 'unassigned') && foldsChildren(lines, i);
              const open = folder && folderOpen(l, level, tree.open);
              const account = l.kind === 'row' && (drillRows === 'figures' || Boolean(l.code));
              const opensElsewhere = Boolean(onOpenRow) && account;
              const drillable = !onOpenRow && !l.bare && (account || (drillRows === 'figures' && (sub || l.kind === 'category' || l.kind === 'unassigned' || l.drill === true)));
              const drilled = drillable ? drill[own.id] : undefined;
              const drillCol = drilled && drilled !== ALL ? columns.find((c) => c.key === drilled) : undefined;
              const depthPad = 12 + 16 * Math.max(0, l.depth - 1);
              const name = nameOf(l);
              const spans = l.kind === 'block' || l.bare ? undefined : l.spans;
              const covered = coveredBy(columns, spans);
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
                        {l.caption && <span className={s.caption}>{l.caption}</span>}
                      </span>
                    </th>
                    {columns.map((c, ci) => {
                      if (covered.has(ci)) return null;
                      const across = Math.min(Math.max(1, spans?.[c.key] ?? 1), columns.length - ci);
                      const cls = [
                        s.cell, c.kind === 'total' ? s.colTotal : '', rules(ci + across - 1), across > 1 ? s.cellAcross : '',
                        c.group ? s.cellPart : '', banded(c) && l.kind !== 'block' ? s.band : '',
                      ].join(' ');
                      if (l.kind === 'block' || l.bare) return <td key={c.key} className={cls} />;
                      const cell = l.cells[c.key];
                      /* Under a heading a nil share stays blank (owner 2026-11-10: the dashes made the
                         Settlement / Deposit view busy); a column of its own keeps its dash. */
                      const text = cell ? fmt(cell.amountSen) : c.group ? '' : DASH;
                      const pct = c.pct && showPct ? (cell ? fmtPct(cell.pct) : DASH) : null;
                      const opens = Boolean(cell) && c.kind !== 'change' && c.noDrill !== true && (drillable || ((folder || sub) && onCategoryFigure))
                        && (figureOpens?.(own, c, across > 1) ?? true);
                      return (
                        <td key={c.key} className={cls} colSpan={across > 1 ? across : undefined}>
                          <span className={s.cellInner}>
                            {opens ? (
                              <button
                                type="button"
                                className={s.figure}
                                aria-label={`${l.label} · ${columnName(c, across > 1)}`}
                                aria-pressed={drillable ? drilled === c.key : undefined}
                                onClick={() => (drillable ? toggleDrill(own.id, c.key) : onCategoryFigure?.(codesUnder(lines, i), c))}
                              >
                                {text}
                              </button>
                            ) : text !== '' && <span className={cell ? undefined : s.dash}>{text}</span>}
                            {pct !== null && <span className={s.pct} data-pct>{pct}</span>}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                  {drilled && renderLines && renderLines(own, drillCol ?? null, () => toggleDrill(own.id, drilled), columns.length + 1)}
                  {drilled && !renderLines && l.code && (
                    <AccountLinesRow
                      code={l.code}
                      title={`${l.code} ${name}`}
                      from={drillCol ? drillCol.from : span.from}
                      to={drillCol ? drillCol.to : span.to}
                      colSpan={columns.length + 1}
                      onClose={() => toggleDrill(own.id, drilled)}
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
