// ----------------------------------------------------------------------------
// Month-end tab — the stock close's visible half (GL redesign item 4).
// The close runs itself every night at 00:05 MYT; this screen is the owner's
// window into it (他的原话: 我有没有办法可以看到你每天检查的成果): the live
// stock value, every run's outcome — the quiet unchanged ones included — and
// a manual Run for the impatient path.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { fmtSen } from '../../vendor/shared/format';
import { useStockClose, useRunStockClose } from './accounting-phase1-queries';

const cardStyle: React.CSSProperties = {
  padding: 'var(--space-4)',
  background: 'var(--c-cream)',
  border: '1px solid var(--c-line, rgba(34,31,32,0.12))',
  borderRadius: 'var(--radius-md)',
};
const softText: React.CSSProperties = { fontSize: 'var(--fs-13)', color: 'var(--text-soft, #8a8578)' };
const btnStyle = (primary?: boolean, disabled?: boolean): React.CSSProperties => ({
  padding: '5px 12px',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  borderRadius: 'var(--radius-sm, 6px)',
  background: primary ? 'var(--c-ink)' : 'transparent',
  color: primary ? 'var(--c-cream)' : 'var(--c-ink)',
  fontSize: 'var(--fs-13)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});

const ACTION_LABEL: Record<string, { text: string; color?: string }> = {
  posted: { text: 'posted', color: 'var(--c-good, #2f5d4f)' },
  reposted: { text: 're-posted', color: 'var(--c-good, #2f5d4f)' },
  unchanged: { text: 'no change' },
  failed: { text: 'FAILED', color: 'var(--c-danger, #a33)' },
};

export const StockCloseTab = () => {
  const q = useStockClose();
  const runClose = useRunStockClose();
  const [month, setMonth] = useState('');

  if (q.isLoading) return <div style={softText}>Loading…</div>;
  if (q.isError || !q.data) return <div style={softText}>Month-end status did not load. Refresh to retry.</div>;

  const chosenMonth = month || q.data.defaultMonth;

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ ...cardStyle, minWidth: 220 }}>
          <div style={softText}>Live stock value (now)</div>
          <div style={{ fontSize: 'var(--fs-20, 20px)', fontWeight: 700 }}>{fmtSen(q.data.liveValueSen)}</div>
          <div style={softText}>月底当晚系统自动抓这个数进 ledger;之后每天检查上月有没有补单,有变自动重过。</div>
        </div>
        <div style={{ ...cardStyle, minWidth: 220 }}>
          <div style={softText}>Run a close now</div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginTop: 6 }}>
            <input
              type="month"
              aria-label="Close month"
              value={chosenMonth}
              onChange={(e) => setMonth(e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid var(--c-line, rgba(34,31,32,0.2))', borderRadius: 'var(--radius-sm, 6px)', fontSize: 'var(--fs-13)', background: 'white' }}
            />
            <button
              type="button"
              style={btnStyle(true, runClose.isPending)}
              disabled={runClose.isPending}
              onClick={() => runClose.mutate({ month: chosenMonth })}
            >
              Run now
            </button>
          </div>
          {runClose.isError && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-danger, #a33)', marginTop: 6 }}>
              {String((runClose.error as { message?: string } | null)?.message ?? 'The run failed.')}
            </div>
          )}
        </div>
      </div>

      <div style={{ ...cardStyle, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Month</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Checked at</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>By</th>
              <th style={{ textAlign: 'right', padding: '8px 10px' }}>Stock value</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Result</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Entries</th>
              <th style={{ textAlign: 'left', padding: '8px 10px' }}>Note</th>
            </tr>
          </thead>
          <tbody>
            {q.data.runs.length === 0 && (
              <tr><td colSpan={7} style={{ padding: '10px', ...softText }}>No runs yet — the first close fires the night this month ends, or press Run now.</td></tr>
            )}
            {q.data.runs.map((r, i) => {
              const a = ACTION_LABEL[r.action] ?? { text: r.action };
              return (
                <tr key={`${r.month}-${r.ran_at}-${i}`} style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}><b>{r.month}</b></td>
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{String(r.ran_at).replace('T', ' ').slice(0, 16)}</td>
                  <td style={{ padding: '6px 10px' }}>{r.trigger}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmtSen(r.stock_value_sen)}</td>
                  <td style={{ padding: '6px 10px', color: a.color }}>{a.text}</td>
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{[r.je_no, r.rev_je_no].filter(Boolean).join(' / ') || '—'}</td>
                  <td style={{ padding: '6px 10px' }}>{r.note ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
