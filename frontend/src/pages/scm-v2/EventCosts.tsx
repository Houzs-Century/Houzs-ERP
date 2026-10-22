// ----------------------------------------------------------------------------
// EventCosts — the Event costs tab (owner 2026-09-29/30: 我的 payment 可能需要
// 绑定 event). Every event starting in the chosen months, with what was booked
// against it: the journal legs voucher and AP invoice lines tagged with the
// event wrote, posted, a cancelled or edited document's pair left out — the
// ledger's own answer, so it agrees with the P&L it is a slice of. Cost is the
// expense accounts; Other is everything else tagged (a rental deposit is an
// asset, not a cost). An event opens to its accounts and the entries behind
// them. Export writes the table as CSV.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { eventLabel, useEventCosts, type EventCostRow, type EventCosts } from '../../vendor/scm/lib/event-queries';
import { fmtDateOrDash, fmtDayMonthRange } from '../../vendor/shared/format';
import { AccountCell } from './JournalEntryCards';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const firstDay = (month: string): string => `${month}-01`;
const lastDay = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left' };
const td: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'top' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

const fmtRm = (sen: number): string => {
  const abs = Math.abs(sen) / 100;
  const text = abs.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};

/* The table as CSV: one row per event, then its entries beneath it. */
export const eventCostsCsv = (r: EventCosts): string => {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines: string[] = [['Event', 'Dates', 'Status', 'Entry', 'Date', 'Document', 'Account', 'Notes', 'Cost', 'Other'].map(esc).join(',')];
  for (const e of r.events) {
    lines.push([e.event.name, fmtDayMonthRange(e.event.startDate, e.event.endDate), e.event.status ?? '', '', '', '', '', '', fmtRm(e.costSen), fmtRm(e.otherSen)].map(esc).join(','));
    for (const l of e.lines) {
      const isCost = e.accounts.find((a) => a.accountCode === l.accountCode)?.accountType === 'EXPENSE';
      lines.push(['', '', '', l.jeNo, fmtDateOrDash(l.entryDate), l.sourceDocNo ?? '', l.accountCode, l.notes ?? '', isCost ? fmtRm(l.amountSen) : '', isCost ? '' : fmtRm(l.amountSen)].map(esc).join(','));
    }
  }
  lines.push(['Total', '', '', '', '', '', '', '', fmtRm(r.totals.costSen), fmtRm(r.totals.otherSen)].map(esc).join(','));
  return `${lines.join('\n')}\n`;
};

const downloadText = (name: string, text: string) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

export const EventCostsTab = () => {
  const [fromMonth, setFromMonth] = useState(myt().slice(0, 7));
  const [toMonth, setToMonth] = useState(myt().slice(0, 7));
  const [withMoneyOnly, setWithMoneyOnly] = useState(false);
  const [find, setFind] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const q = useEventCosts(firstDay(fromMonth), lastDay(toMonth));
  const r = q.data;

  const rows = useMemo<EventCostRow[]>(() => {
    const needle = find.trim().toLowerCase();
    return (r?.events ?? []).filter((e) => (!withMoneyOnly || e.lines.length > 0)
      && (!needle || `${e.event.name} ${e.event.code ?? ''} ${e.event.boothNo ?? ''}`.toLowerCase().includes(needle)));
  }, [r, withMoneyOnly, find]);
  const shown = useMemo(() => ({
    costSen: rows.reduce((s, e) => s + e.costSen, 0),
    otherSen: rows.reduce((s, e) => s + e.otherSen, 0),
    booked: rows.filter((e) => e.lines.length > 0).length,
  }), [rows]);

  const toggle = (id: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>Events starting from</span>
        <input type="month" value={fromMonth} onChange={(e) => { if (e.target.value) setFromMonth(e.target.value); }} aria-label="Events from month" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }} />
        <span style={soft}>to</span>
        <input type="month" value={toMonth} onChange={(e) => { if (e.target.value) setToMonth(e.target.value); }} aria-label="Events to month" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }} />
        <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find an event, venue or booth" aria-label="Find an event"
          style={{ padding: '4px 8px', fontSize: 'var(--fs-12)', minWidth: 220 }} />
        <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={withMoneyOnly} onChange={(e) => setWithMoneyOnly(e.target.checked)} aria-label="Only events with money booked" />
          only events with money booked
        </label>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={() => { if (r) downloadText(`event-costs-${fromMonth}-${toMonth}.csv`, eventCostsCsv({ ...r, events: rows, totals: { costSen: shown.costSen, otherSen: shown.otherSen } })); }} disabled={!r}>
          <Download size={16} strokeWidth={1.75} /> Export
        </Button>
      </div>

      <div style={{ ...card, display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
        <span>Events <b>{rows.length}</b> <span style={soft}>({shown.booked} with money booked)</span></span>
        <span>Cost <b style={num}>RM {fmtRm(shown.costSen)}</b></span>
        <span>Other tagged <b style={num}>RM {fmtRm(shown.otherSen)}</b> <span style={soft}>(deposits and other non-expense accounts)</span></span>
      </div>

      {q.isLoading && <div style={soft}>Reading the ledger…</div>}
      {q.isError && <div style={{ ...soft, color: 'var(--c-festive-b, #B8331F)' }}>The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</div>}
      {r && rows.length === 0 && (
        <div style={soft}>{(r.events.length === 0) ? 'No event starts in these months.' : 'No event here matches the filter.'}</div>
      )}
      {rows.length > 0 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr>
                <th style={th}>Event</th>
                <th style={th}>Dates</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}>Entries</th>
                <th style={{ ...th, textAlign: 'right' }}>Cost (RM)</th>
                <th style={{ ...th, textAlign: 'right' }}>Other (RM)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <EventRows key={e.event.id} row={e} open={open.has(e.event.id)} onToggle={() => toggle(e.event.id)} />
              ))}
              <tr style={{ borderTop: '2px solid var(--border-weak, #e3e1da)', fontWeight: 700 }}>
                <td style={td} colSpan={4}>Total</td>
                <td style={{ ...td, ...num }}>{fmtRm(shown.costSen)}</td>
                <td style={{ ...td, ...num }}>{fmtRm(shown.otherSen)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

function EventRows({ row, open, onToggle }: { row: EventCostRow; open: boolean; onToggle: () => void }) {
  const e = row.event;
  const cancelled = String(e.status ?? '').toLowerCase() === 'cancelled';
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)', cursor: row.lines.length > 0 ? 'pointer' : 'default' }}
        onClick={row.lines.length > 0 ? onToggle : undefined} aria-expanded={row.lines.length > 0 ? open : undefined}>
        <td style={td}>
          {row.lines.length > 0 ? (open ? '▾ ' : '▸ ') : ''}{e.name}
          {e.boothNo ? <span style={soft}> · booth {e.boothNo}</span> : null}
          {e.archived ? <span style={soft}> · archived</span> : null}
        </td>
        <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDayMonthRange(e.startDate, e.endDate)}</td>
        <td style={{ ...td, ...(cancelled ? { color: 'var(--c-festive-b, #B8331F)' } : {}) }}>{e.status ?? '—'}</td>
        <td style={{ ...td, ...num }}>{row.lines.length}</td>
        <td style={{ ...td, ...num }}>{row.lines.length > 0 ? fmtRm(row.costSen) : <span style={soft}>—</span>}</td>
        <td style={{ ...td, ...num }}>{row.otherSen !== 0 ? fmtRm(row.otherSen) : <span style={soft}>—</span>}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} style={{ ...td, background: 'var(--c-cream, #faf8f3)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
              {row.accounts.map((a) => (
                <div key={a.accountCode} style={{ fontSize: 'var(--fs-12)' }}>
                  <AccountCell code={a.accountCode} name={a.accountName} />
                  <div style={num}>{fmtRm(a.amountSen)}</div>
                </div>
              ))}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-12)' }}>
              <thead>
                <tr>
                  <th style={th}>Date</th>
                  <th style={th}>Entry</th>
                  <th style={th}>Document</th>
                  <th style={th}>Account</th>
                  <th style={th}>Notes</th>
                  <th style={{ ...th, textAlign: 'right' }}>Amount (RM)</th>
                </tr>
              </thead>
              <tbody>
                {row.lines.map((l, i) => (
                  <tr key={`${l.jeNo}-${i}`}>
                    <td style={td}>{fmtDateOrDash(l.entryDate)}</td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{l.jeNo}</td>
                    <td style={td}>{l.sourceDocNo ?? '—'}</td>
                    <td style={td}><AccountCell code={l.accountCode} name={row.accounts.find((a) => a.accountCode === l.accountCode)?.accountName} /></td>
                    <td style={td}>{l.notes ?? ''}</td>
                    <td style={{ ...td, ...num }}>{fmtRm(l.amountSen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ ...soft, marginTop: 'var(--space-2)' }}>{eventLabel(e)}</div>
          </td>
        </tr>
      )}
    </>
  );
}
