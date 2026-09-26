// ----------------------------------------------------------------------------
// Month-end tab — the stock close's visible half (GL redesign item 4).
// The close runs itself every night at 00:05 MYT; this screen is the owner's
// window into it (他的原话: 我有没有办法可以看到你每天检查的成果): the live
// stock value, every run's outcome — the quiet unchanged ones included — and
// a manual Run for the impatient path.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { fmtSen } from '../../vendor/shared/format';
import { useStockClose, useRunStockClose, type StockCloseRun } from './accounting-phase1-queries';
import { DataTable, type Column } from '../../components/DataTable';

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

const RUN_COLUMNS: Column<StockCloseRun>[] = [
  { key: 'month', label: 'Month', render: (r) => <b>{r.month}</b>, getValue: (r) => r.month },
  {
    key: 'checkedAt', label: 'Checked At',
    render: (r) => String(r.ran_at).replace('T', ' ').slice(0, 16),
    getValue: (r) => String(r.ran_at),
  },
  { key: 'by', label: 'By', render: (r) => r.trigger, getValue: (r) => r.trigger },
  {
    key: 'value', label: 'Stock Value', align: 'right', render: (r) => fmtSen(r.stock_value_sen),
    getValue: (r) => r.stock_value_sen, exportValue: (r) => r.stock_value_sen / 100, exportFormat: 'money',
  },
  {
    key: 'result', label: 'Result',
    render: (r) => { const a = ACTION_LABEL[r.action] ?? { text: r.action }; return <span style={{ color: a.color }}>{a.text}</span>; },
    getValue: (r) => (ACTION_LABEL[r.action] ?? { text: r.action }).text,
  },
  {
    key: 'entries', label: 'Entries', render: (r) => [r.je_no, r.rev_je_no].filter(Boolean).join(' / ') || '—',
    getValue: (r) => [r.je_no, r.rev_je_no].filter(Boolean).join(' / '),
  },
  { key: 'note', label: 'Note', render: (r) => r.note ?? '', getValue: (r) => r.note ?? '' },
];

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

      <DataTable<StockCloseRun>
        tableId="stock-close-runs"
        exportName="stock-close-runs"
        exportXlsx
        columns={RUN_COLUMNS}
        rows={q.data.runs}
        emptyLabel="No runs yet — the first close fires the night this month ends, or press Run now."
        getRowKey={(r) => `${r.month}-${r.ran_at}-${r.action}`}
      />
    </div>
  );
};
