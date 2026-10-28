// ----------------------------------------------------------------------------
// ReportLayoutTree — a Finance report's block drawn on its layout (owner
// 2026-09-14, docs/bugs/0911: 我想要有 level，父子 account 分层 … P&L 那边不是每个
// expense 都有 percentage). Category rows carry their subtotal, every row its
// % of the report's base, and the L1..Ln buttons open the tree to a depth —
// L1 is the categories alone, All is every account. Signs follow the four
// reports' one rule (fmtSenPlain — no RM, owner 2026-09-19): plain, parentheses
// only where credits beat debits. Receipts & Payments (docs/bugs/0912) draws the same rows with a
// figure per money column before the total, in its own money dress, and a
// figure that opens the entries behind it.
// ----------------------------------------------------------------------------

import { Fragment, useEffect, useState } from 'react';
import { fmtSenPlain } from '../../vendor/shared/format';
import { fmtPct, pctOf, type LaidNode } from '../../vendor/scm/lib/report-layout';
import { AccountLinesRow } from './AccountLinesRow';

export type Level = number | 'all';

/** What a person has opened by hand on a tree: categories opened or closed
    past the level, accounts whose lines are shown. The level buttons set the
    whole tree at once, so a new level clears both. */
export type ReportTree = {
  open: Record<string, boolean>;
  /** Flip a folder from what it shows now (the level decides that until a hand does). */
  toggle: (id: string, openNow: boolean) => void;
  drilled: Record<string, boolean>;
  toggleDrill: (id: string) => void;
};

export const useReportTree = (level: Level): ReportTree => {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [drilled, setDrilled] = useState<Record<string, boolean>>({});
  useEffect(() => { setOpen({}); setDrilled({}); }, [level]);
  return {
    open,
    toggle: (id, openNow) => setOpen((o) => ({ ...o, [id]: !openNow })),
    drilled,
    toggleDrill: (id) => setDrilled((d) => ({ ...d, [id]: !d[id] })),
  };
};

/** The period an account's lines are read for when its row is opened. */
export type DrillPeriod = { from: string; to: string };

const chevronBtn: React.CSSProperties = { background: 'none', border: 'none', padding: '0 4px 0 0', cursor: 'pointer', font: 'inherit', color: 'var(--text-soft, #8a8578)', width: 18, display: 'inline-block', textAlign: 'left' };

/** A figure clicked: the node (a line or a whole category) and the column, null for the total. */
export type LaidPick = (node: LaidNode, column: string | null) => void;

const soft: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };
const right: React.CSSProperties = { padding: '2px 10px', textAlign: 'right', whiteSpace: 'nowrap' };

/** L1 … Ln + All. Nothing to choose when the tree is one level deep. */
export const LevelButtons = ({ depth, level, onLevel }: { depth: number; level: Level; onLevel: (l: Level) => void }) => {
  if (depth < 2) return null;
  const btn = (active: boolean): React.CSSProperties => ({
    padding: '2px 8px', fontSize: 'var(--fs-12, 12px)', borderRadius: 'var(--radius-sm, 4px)',
    border: '1px solid var(--c-line, rgba(34,31,32,0.2))', background: active ? 'var(--c-ink, #221f20)' : 'transparent',
    color: active ? 'var(--c-cream, #fff)' : 'inherit', cursor: 'pointer',
  });
  return (
    <div role="group" aria-label="Levels" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <span style={soft}>Level</span>
      {Array.from({ length: depth }, (_, i) => i + 1).map((n) => (
        <button key={n} type="button" aria-pressed={level === n} style={btn(level === n)} onClick={() => onLevel(n)}>L{n}</button>
      ))}
      <button type="button" aria-pressed={level === 'all'} style={btn(level === 'all')} onClick={() => onLevel('all')}>All</button>
    </div>
  );
};

const weightOf = (kind: LaidNode['kind']): React.CSSProperties =>
  kind === 'category' ? { fontWeight: 600 } : kind === 'unassigned' ? { fontStyle: 'italic', ...soft } : {};

const pickBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit', textDecoration: 'underline dotted' };

/** The rows of a block, indented by depth; a category's children show while
    the level reaches them, its subtotal stands either way. With `columns`
    every row prints a figure per column before its total; `fmt` is the
    report's own money dress; `onPick` makes a figure open its entries. */
export const LaidRows = ({ nodes, level, depth = 1, columns, fmt = fmtSenPlain, onPick, activeId, tree, drill }: {
  nodes: LaidNode[]; level: Level; depth?: number;
  columns?: string[]; fmt?: (sen: number) => string; onPick?: LaidPick; activeId?: string | null;
  /** Hand-opened categories and accounts; with `drill`, an account's name opens its lines for the period. */
  tree?: ReportTree; drill?: DrillPeriod;
}) => (
  <>
    {nodes.map((n) => {
      const folder = n.children.length > 0;
      const open = folder && (tree?.open[n.id] ?? (level === 'all' || depth < level));
      const drillable = Boolean(tree && drill && n.kind === 'account' && n.code);
      const drilledOpen = drillable && Boolean(tree?.drilled[n.id]);
      const label = folder && tree
        ? <><button type="button" style={chevronBtn} aria-label={`${open ? 'Collapse' : 'Expand'} ${n.label}`} aria-expanded={open} onClick={() => tree.toggle(n.id, open)}>{open ? '▾' : '▸'}</button>{n.label}</>
        : drillable
          ? <button type="button" style={{ ...pickBtn, textDecoration: 'none' }} aria-label={`Lines of ${n.label}`} aria-expanded={drilledOpen} onClick={() => tree!.toggleDrill(n.id)}>{n.label}</button>
          : n.label;
      const figure = (sen: number, column: string | null, strong: boolean): React.ReactNode => {
        if (columns && column !== null && sen === 0) return <span style={soft}>—</span>;
        const text = fmt(sen);
        return onPick
          ? <button type="button" style={{ ...pickBtn, fontWeight: strong ? 600 : undefined }} aria-label={`${n.label}${column ? ` ${column}` : ' total'}`} onClick={() => onPick(n, column)}>{text}</button>
          : text;
      };
      return (
        <Fragment key={n.id}>
          <tr data-kind={n.kind} data-depth={depth} style={activeId && activeId === n.id ? { background: 'var(--c-cream, #faf7f0)' } : undefined}>
            <td style={{ padding: `2px 10px 2px ${10 + 14 * depth}px`, ...weightOf(n.kind) }}>{label}</td>
            {columns?.map((col) => (
              <td key={col} style={{ ...right, ...weightOf(n.kind) }}>{figure(n.cells?.[col] ?? 0, col, n.kind === 'category')}</td>
            ))}
            <td style={{ ...right, ...weightOf(n.kind) }}>{figure(n.amountSen, null, n.kind === 'category')}</td>
            <td style={{ ...right, ...soft }}>{fmtPct(n.pct)}</td>
          </tr>
          {drilledOpen && drill && n.code && <AccountLinesRow code={n.code} from={drill.from} to={drill.to} colSpan={3 + (columns?.length ?? 0)} />}
          {open && <LaidRows nodes={n.children} level={level} depth={depth + 1} columns={columns} fmt={fmt} onPick={onPick} activeId={activeId} tree={tree} drill={drill} />}
        </Fragment>
      );
    })}
  </>
);

/** A titled block with its rows and its total line. */
export const LaidBlock = ({ title, nodes, level, totalLabel, totalSen, baseSen, onPick, tree, drill }: {
  title: string; nodes: LaidNode[]; level: Level; totalLabel: string; totalSen: number; baseSen: number | null;
  /** A figure opens its entries — the general ledger on the node's accounts. */
  onPick?: LaidPick;
  tree?: ReportTree; drill?: DrillPeriod;
}) => (
  <>
    <tr><td colSpan={3} style={{ padding: '10px 10px 4px', fontWeight: 700 }}>{title}</td></tr>
    <LaidRows nodes={nodes} level={level} onPick={onPick} tree={tree} drill={drill} />
    {nodes.length === 0 && <tr><td colSpan={3} style={{ padding: '2px 10px 2px 24px', ...soft }}>—</td></tr>}
    <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
      <td style={{ padding: '4px 10px', fontWeight: 600 }}>{totalLabel}</td>
      <td style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtSenPlain(totalSen)}</td>
      <td style={{ padding: '4px 10px', textAlign: 'right', whiteSpace: 'nowrap', ...soft }}>{fmtPct(pctOf(totalSen, baseSen))}</td>
    </tr>
  </>
);

/** A bold figure line (gross profit, net) with its % of the base. */
export const LaidTotalRow = ({ label, amountSen, baseSen, strong = false }: { label: string; amountSen: number; baseSen: number | null; strong?: boolean }) => (
  <tr style={{ borderTop: '2px solid var(--c-ink, #221f20)' }}>
    <td style={{ padding: strong ? '8px 10px' : '6px 10px', fontWeight: 700 }}>{label}</td>
    <td style={{ padding: strong ? '8px 10px' : '6px 10px', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtSenPlain(amountSen)}</td>
    <td style={{ padding: strong ? '8px 10px' : '6px 10px', textAlign: 'right', whiteSpace: 'nowrap', ...soft }}>{fmtPct(pctOf(amountSen, baseSen))}</td>
  </tr>
);
