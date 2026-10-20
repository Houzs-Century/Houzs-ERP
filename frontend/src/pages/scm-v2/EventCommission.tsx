// ----------------------------------------------------------------------------
// EventCommission — the Event Commission tab (owner 2026-10-20). For any range:
// the fairs that START in it, each with the event page's Total Sales and
// Commission (the estimate) and what its orders have actually earned — goods ×
// the fair's brand rate, once 30% of the order is paid — opening to each order
// with its upsales / drop sales; then what happened in the range to orders of
// EARLIER fairs (30% reached late, upsales / drops after it, cancellations).
// The rules are the server's (backend/src/scm/lib/event-commission.ts). Export
// writes both parts as CSV.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useEventCommission,
  type CommissionAdjustment, type CommissionChange, type CommissionFairRow, type EventCommission,
} from '../../vendor/scm/lib/event-queries';
import { fmtDateOrDash, fmtDayMonthRange } from '../../vendor/shared/format';

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthOf = (day: string, shift = 0): { from: string; to: string } => {
  const [y, m] = day.split('-').map(Number);
  const first = new Date(Date.UTC(y!, m! - 1 + shift, 1));
  const last = new Date(Date.UTC(y!, m! + shift, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const card: React.CSSProperties = { background: 'var(--c-paper, #fff)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left' };
const td: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'top' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const right: React.CSSProperties = { ...th, textAlign: 'right' };

const fmtRm = (sen: number): string => {
  const text = (Math.abs(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${text})` : text;
};
const fmtRmWhole = (rm: number | null): string => (rm == null ? '—' : fmtRm(Math.round(rm * 100)));

export const KIND_LABEL: Record<CommissionAdjustment['kind'], string> = {
  reached: 'Reached 30%', upsale: 'Upsale', drop: 'Drop sale', cancelled: 'Cancelled',
};
const NOT_COUNTED: Record<NonNullable<CommissionChange['notCounted']>, string> = {
  opening_day: 'opening-day fix, not counted', first_price: 'priced after opening, not counted',
};

/* Both parts as CSV: each fair, its orders beneath it; then the earlier fairs' lines. */
export const eventCommissionCsv = (r: EventCommission): string => {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const row = (cells: Array<string | number | null>) => cells.map(esc).join(',');
  const lines = [row(['Fair', 'Dates', 'Rate %', 'Total Sales', 'Estimate', 'Order', 'Salesperson', 'Goods', 'Paid %', '30% reached', 'Commission'])];
  for (const f of r.fairs) {
    lines.push(row([f.name, fmtDayMonthRange(f.startDate, f.endDate), f.ratePct, fmtRmWhole(f.totalSalesRm), fmtRmWhole(f.estimateRm), '', '', '', '', '', fmtRm(f.payableSen)]));
    for (const s of f.sos) lines.push(row(['', '', '', '', '', s.docNo, s.salesperson, fmtRm(s.goodsSen), s.paidPct, s.reachedOn ?? 'not yet', fmtRm(s.commissionSen)]));
  }
  lines.push('', row(['Earlier fairs', 'Date', 'What', 'Order', 'Salesperson', 'Goods', 'Commission']));
  for (const a of r.adjustments) lines.push(row([a.fairName, a.date, KIND_LABEL[a.kind], a.docNo, a.salesperson, fmtRm(a.goodsSen), fmtRm(a.commissionSen)]));
  lines.push('', row(['Total', '', '', '', '', '', fmtRm(r.totals.totalSen)]));
  return `${lines.join('\n')}\n`;
};

const downloadText = (name: string, text: string) => {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

export const EventCommissionTab = () => {
  const [range, setRange] = useState(() => monthOf(myt()));
  const [open, setOpen] = useState<Set<number>>(new Set());
  const q = useEventCommission(range.from, range.to);
  const r = q.data;
  const toggle = (id: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={soft}>From</span>
        <input type="date" value={range.from} aria-label="From date" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }}
          onChange={(e) => { if (e.target.value) setRange((x) => ({ ...x, from: e.target.value })); }} />
        <span style={soft}>to</span>
        <input type="date" value={range.to} aria-label="To date" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }}
          onChange={(e) => { if (e.target.value) setRange((x) => ({ ...x, to: e.target.value })); }} />
        <Button variant="ghost" size="sm" onClick={() => setRange(monthOf(myt()))}>This month</Button>
        <Button variant="ghost" size="sm" onClick={() => setRange(monthOf(myt(), -1))}>Last month</Button>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" disabled={!r} onClick={() => { if (r) downloadText(`event-commission-${range.from}-${range.to}.csv`, eventCommissionCsv(r)); }}>
          <Download size={16} strokeWidth={1.75} /> Export
        </Button>
      </div>

      {r && (
        <div style={{ ...card, display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
          <span>Fairs <b>{r.fairs.length}</b></span>
          <span>Fairs in the range <b style={num}>RM {fmtRm(r.totals.payableSen)}</b></span>
          <span>Earlier fairs <b style={num}>RM {fmtRm(r.totals.adjustmentsSen)}</b></span>
          <span>Total commission <b style={num}>RM {fmtRm(r.totals.totalSen)}</b></span>
        </div>
      )}
      <div style={soft}>
        An order earns its goods (no delivery or service) × the fair&apos;s brand rate once 30% of the order is paid.
        Upsales and drop sales are recorded from 20/10/2026.
      </div>

      {q.isLoading && <div style={soft}>Reading the orders…</div>}
      {q.isError && <div style={{ ...soft, color: 'var(--c-festive-b, #B8331F)' }}>The report could not be read — {q.error instanceof Error ? q.error.message : String(q.error)}</div>}

      {r && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <div style={{ padding: 'var(--space-2) var(--space-3)', fontWeight: 600 }}>Fairs starting in the range <span style={soft}>(as at {fmtDateOrDash(r.to)})</span></div>
          {r.fairs.length === 0 ? <div style={{ ...soft, padding: 'var(--space-3)' }}>No fair starts in this range.</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr>
                  <th style={th}>Fair</th>
                  <th style={th}>Dates</th>
                  <th style={right}>Rate</th>
                  <th style={right}>Total Sales (RM)</th>
                  <th style={right}>Estimate (RM)</th>
                  <th style={right}>Orders</th>
                  <th style={right}>Commission (RM)</th>
                </tr>
              </thead>
              <tbody>
                {r.fairs.map((f) => <FairRows key={f.id} fair={f} open={open.has(f.id)} onToggle={() => toggle(f.id)} />)}
                <tr style={{ borderTop: '2px solid var(--border-weak, #e3e1da)', fontWeight: 700 }}>
                  <td style={td} colSpan={6}>Total</td>
                  <td style={{ ...td, ...num }}>{fmtRm(r.totals.payableSen)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}

      {r && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <div style={{ padding: 'var(--space-2) var(--space-3)', fontWeight: 600 }}>Earlier fairs — what happened in the range</div>
          {r.adjustments.length === 0 ? <div style={{ ...soft, padding: 'var(--space-3)' }}>Nothing on earlier fairs in this range.</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr>
                  <th style={th}>Date</th>
                  <th style={th}>What</th>
                  <th style={th}>Order</th>
                  <th style={th}>Fair</th>
                  <th style={th}>Salesperson</th>
                  <th style={right}>Goods (RM)</th>
                  <th style={right}>Commission (RM)</th>
                </tr>
              </thead>
              <tbody>
                {r.adjustments.map((a, i) => (
                  <tr key={`${a.docNo}-${a.kind}-${i}`} style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDateOrDash(a.date)}</td>
                    <td style={td}>{KIND_LABEL[a.kind]}{a.beforeReach ? <span style={soft}> · before 30% — counted when reached</span> : null}</td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{a.docNo}</td>
                    <td style={td}>{a.fairName}</td>
                    <td style={td}>{a.salesperson ?? '—'}</td>
                    <td style={{ ...td, ...num }}>{fmtRm(a.goodsSen)}</td>
                    <td style={{ ...td, ...num }}>{fmtRm(a.commissionSen)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid var(--border-weak, #e3e1da)', fontWeight: 700 }}>
                  <td style={td} colSpan={6}>Total</td>
                  <td style={{ ...td, ...num }}>{fmtRm(r.totals.adjustmentsSen)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};

function FairRows({ fair, open, onToggle }: { fair: CommissionFairRow; open: boolean; onToggle: () => void }) {
  const has = fair.sos.length > 0;
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)', cursor: has ? 'pointer' : 'default' }}
        onClick={has ? onToggle : undefined} aria-expanded={has ? open : undefined}>
        <td style={td}>{has ? (open ? '▾ ' : '▸ ') : ''}{fair.name}</td>
        <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDayMonthRange(fair.startDate, fair.endDate)}</td>
        <td style={{ ...td, ...num }}>{fair.ratePct == null ? <span style={soft}>no rate card</span> : `${fair.ratePct}%`}</td>
        <td style={{ ...td, ...num }}>{fmtRmWhole(fair.totalSalesRm)}</td>
        <td style={{ ...td, ...num }}>{fmtRmWhole(fair.estimateRm)}</td>
        <td style={{ ...td, ...num }}>{fair.sos.length}</td>
        <td style={{ ...td, ...num }}>{fmtRm(fair.payableSen)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ ...td, background: 'var(--c-cream, #faf8f3)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-12)' }}>
              <thead>
                <tr>
                  <th style={th}>Order</th>
                  <th style={th}>Salesperson</th>
                  <th style={th}>Customer</th>
                  <th style={right}>Goods (RM)</th>
                  <th style={right}>Paid</th>
                  <th style={th}>30% reached</th>
                  <th style={right}>Commission (RM)</th>
                  <th style={th}>Upsales / drop sales</th>
                </tr>
              </thead>
              <tbody>
                {fair.sos.map((s) => (
                  <tr key={s.docNo} style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{s.docNo}</td>
                    <td style={td}>{s.salesperson ?? '—'}</td>
                    <td style={td}>{s.customer ?? '—'}</td>
                    <td style={{ ...td, ...num }}>{fmtRm(s.goodsSen)}</td>
                    <td style={{ ...td, ...num }}>{fmtRm(s.paidSen)} <span style={soft}>({s.paidPct}%)</span></td>
                    <td style={td}>{s.reachedOn ? fmtDateOrDash(s.reachedOn) : <span style={soft}>not yet</span>}</td>
                    <td style={{ ...td, ...num }}>{fmtRm(s.commissionSen)}</td>
                    <td style={td}>
                      {s.changes.length === 0 ? <span style={soft}>—</span> : s.changes.map((ch, i) => (
                        <div key={`${ch.date}-${i}`} style={ch.notCounted ? soft : undefined}>
                          {ch.kind === 'upsale' ? '+' : '−'}RM {fmtRm(Math.abs(ch.deltaGoodsSen))} · {fmtDateOrDash(ch.date)}
                          {ch.source === 'amendment' ? ' · amendment' : ''}
                          {ch.notCounted ? ` · ${NOT_COUNTED[ch.notCounted]}` : ''}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
