// An account's lines for the report's period, opened under its row on the
// statement itself — read from the General Ledger's own endpoint so the two
// never disagree; a link opens the full ledger page.

import { Link } from 'react-router-dom';
import { fmtDate } from '../../vendor/shared/format';
import { ledgerHref } from '../../vendor/scm/lib/report-layout';
import { counterLabel, fmtLedger, fmtSide, useLedger } from '../../vendor/scm/lib/ledger-queries';

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--text-soft, #8a8578)' };
const th: React.CSSProperties = { padding: '3px 8px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border-weak, #e3e1da)' };
const td: React.CSSProperties = { padding: '2px 8px', verticalAlign: 'top', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.06))' };
const num: React.CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };

export const AccountLinesRow = ({ code, from, to, colSpan }: { code: string; from: string; to: string; colSpan: number }) => {
  const q = useLedger({ from, to, accounts: [code] });
  const block = q.data?.blocks.find((b) => b.code === code) ?? null;
  const lines = block?.lines ?? [];
  return (
    <tr data-lines-of={code}>
      <td colSpan={colSpan} style={{ padding: '4px 10px 10px 34px', background: 'var(--c-cream-2, rgba(34,31,32,0.03))' }}>
        {q.isLoading && <span style={soft}>Reading the lines…</span>}
        {q.isError && <span style={{ fontSize: 'var(--fs-12)', color: 'var(--c-danger, #a33)' }}>The lines did not load.</span>}
        {q.data && lines.length === 0 && <span style={soft}>No line on {code} between {fmtDate(from)} and {fmtDate(to)}.</span>}
        {lines.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-12)' }}>
            <thead>
              <tr>
                <th style={th}>Date</th><th style={th}>Description</th><th style={th}>Other side</th><th style={th}>Ref. 1</th><th style={th}>Ref. 2</th>
                <th style={{ ...th, textAlign: 'right' }}>Debit</th><th style={{ ...th, textAlign: 'right' }}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.lineId}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(l.date)}</td>
                  <td style={td}>{l.description ?? '—'}</td>
                  <td style={td}>{counterLabel(l.counter) || '—'}</td>
                  <td style={td}>{l.doc ?? '—'}</td>
                  <td style={td}>{l.doc2 ?? '—'}</td>
                  <td style={num}>{fmtSide(l.debitSen)}</td>
                  <td style={num}>{fmtSide(l.creditSen)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} style={{ ...td, borderBottom: 0, fontWeight: 600 }}>
                  共 {lines.length} 笔
                  <Link to={ledgerHref([code], from, to)} style={{ marginLeft: 12, fontWeight: 400, color: 'var(--c-orange)' }}>在 GL 打开</Link>
                </td>
                <td style={{ ...num, borderBottom: 0, fontWeight: 700 }}>{fmtLedger(block?.debitSen ?? 0)}</td>
                <td style={{ ...num, borderBottom: 0, fontWeight: 700 }}>{fmtLedger(block?.creditSen ?? 0)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </td>
    </tr>
  );
};
