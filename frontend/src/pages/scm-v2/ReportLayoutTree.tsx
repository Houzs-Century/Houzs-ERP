// ----------------------------------------------------------------------------
// ReportLayoutTree — a Finance report's block drawn on its layout (owner
// 2026-09-14, docs/bugs/0911: 我想要有 level，父子 account 分层 … P&L 那边不是每个
// expense 都有 percentage). Category rows carry their subtotal, every row its
// % of the report's base, and the L1..Ln buttons open the tree to a depth —
// L1 is the categories alone, All is every account. Signs follow the four
// reports' one rule (fmtSenParen): plain, parentheses only where credits beat
// debits.
// ----------------------------------------------------------------------------

import { Fragment } from 'react';
import { fmtSenParen } from '../../vendor/shared/format';
import { fmtPct, pctOf, type LaidNode } from '../../vendor/scm/lib/report-layout';

export type Level = number | 'all';

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

/** The rows of a block, indented by depth; a category's children show while
    the level reaches them, its subtotal stands either way. */
export const LaidRows = ({ nodes, level, depth = 1 }: { nodes: LaidNode[]; level: Level; depth?: number }) => (
  <>
    {nodes.map((n) => {
      const open = n.children.length > 0 && (level === 'all' || depth < level);
      return (
        <Fragment key={n.id}>
          <tr data-kind={n.kind} data-depth={depth}>
            <td style={{ padding: `2px 10px 2px ${10 + 14 * depth}px`, ...weightOf(n.kind) }}>{n.label}</td>
            <td style={{ ...right, ...weightOf(n.kind) }}>{fmtSenParen(n.amountSen)}</td>
            <td style={{ ...right, ...soft }}>{fmtPct(n.pct)}</td>
          </tr>
          {open && <LaidRows nodes={n.children} level={level} depth={depth + 1} />}
        </Fragment>
      );
    })}
  </>
);

/** A titled block with its rows and its total line. */
export const LaidBlock = ({ title, nodes, level, totalLabel, totalSen, baseSen }: {
  title: string; nodes: LaidNode[]; level: Level; totalLabel: string; totalSen: number; baseSen: number | null;
}) => (
  <>
    <tr><td colSpan={3} style={{ padding: '10px 10px 4px', fontWeight: 700 }}>{title}</td></tr>
    <LaidRows nodes={nodes} level={level} />
    {nodes.length === 0 && <tr><td colSpan={3} style={{ padding: '2px 10px 2px 24px', ...soft }}>—</td></tr>}
    <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
      <td style={{ padding: '4px 10px', fontWeight: 600 }}>{totalLabel}</td>
      <td style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtSenParen(totalSen)}</td>
      <td style={{ padding: '4px 10px', textAlign: 'right', whiteSpace: 'nowrap', ...soft }}>{fmtPct(pctOf(totalSen, baseSen))}</td>
    </tr>
  </>
);

/** A bold figure line (gross profit, net) with its % of the base. */
export const LaidTotalRow = ({ label, amountSen, baseSen, strong = false }: { label: string; amountSen: number; baseSen: number | null; strong?: boolean }) => (
  <tr style={{ borderTop: '2px solid var(--c-ink, #221f20)' }}>
    <td style={{ padding: strong ? '8px 10px' : '6px 10px', fontWeight: 700 }}>{label}</td>
    <td style={{ padding: strong ? '8px 10px' : '6px 10px', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{fmtSenParen(amountSen)}</td>
    <td style={{ padding: strong ? '8px 10px' : '6px 10px', textAlign: 'right', whiteSpace: 'nowrap', ...soft }}>{fmtPct(pctOf(amountSen, baseSen))}</td>
  </tr>
);
