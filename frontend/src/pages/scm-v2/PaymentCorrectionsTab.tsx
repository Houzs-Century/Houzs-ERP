/* Payment corrections — the Finance report of every customer-payment correction
   made on the amend right (owner 2026-09-10, docs/bugs/0785).

   A filtered read of the SO audit log, one row per correction: who, when, which
   order, what moved from → to, the reason typed at the time, and the two JE
   numbers — the contra that voided the old entry and the entry booked in its
   place. Same-day fixes by whoever keyed the payment are not here on purpose
   (owner: 靠权限改的来决定); the SO's own audit history still shows those.

   Prints the way the bank reconciliation does: the document is built by
   `correctionsDocument` from exactly what is on the screen. */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';
import { PrintPreviewModal, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import { usePaymentCorrections, type PaymentCorrectionRow } from './accounting-phase1-queries';
import { ledgerText, monthText, whatChanged } from '../../vendor/scm/lib/payment-corrections-pdf';

const cardStyle = {
  background: 'var(--c-paper, #fff)', border: '1px solid var(--c-line, rgba(34,31,32,0.18))',
  borderRadius: 10, padding: 'var(--space-4, 16px)',
} as const;

/** The last twelve months, this one first, as YYYY-MM. */
export const recentMonths = (today: Date = new Date(), count = 12): string[] => {
  const out: string[] = [];
  let y = today.getFullYear();
  let m = today.getMonth() + 1;
  for (let i = 0; i < count; i += 1) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
};

const fmt = (sen: number | null | undefined) => fmtSen(sen);
const signed = (sen: number) => (sen < 0 ? `−${fmt(-sen)}` : sen > 0 ? `+${fmt(sen)}` : fmt(0));

export const PaymentCorrectionsTab = () => {
  const months = useMemo(() => recentMonths(), []);
  const [month, setMonth] = useState(months[0]);
  const [who, setWho] = useState<string>('');
  const q = usePaymentCorrections(month);

  const rows = q.data?.rows ?? [];
  const people = useMemo(() => [...new Set(rows.map((r) => r.by))].sort(), [rows]);
  const shown = who ? rows.filter((r) => r.by === who) : rows;
  const summary = q.data?.summary;

  const print = usePrintPreview(async (action) => {
    if (!q.data) return;
    const { generatePaymentCorrectionsPdf } = await import('../../vendor/scm/lib/payment-corrections-pdf');
    await generatePaymentCorrectionsPdf({ month: q.data.month, rows: shown, summary: q.data.summary }, { action });
  });

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <b>Payment corrections</b>
        <select value={month} onChange={(e) => { setMonth(e.target.value); setWho(''); }} aria-label="Month">
          {months.map((m) => <option key={m} value={m}>{monthText(m)}</option>)}
        </select>
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Corrected by">
          <option value="">Everyone</option>
          {people.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        {q.data && (
          <button type="button" onClick={print.openPreview}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--c-line, rgba(34,31,32,0.3))', background: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 'var(--fs-12)', fontWeight: 600 }}>
            <Printer size={14} /> Print
          </button>
        )}
      </div>

      {q.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Reading the month…</div>}
      {q.isError && (
        <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-festive-b, #B8331F)' }}>
          The report could not be read: {q.error instanceof Error ? q.error.message : String(q.error)}
        </div>
      )}

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          <div style={cardStyle}>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)' }}>Corrections in {monthText(month)}</div>
            <div style={{ fontSize: 'var(--fs-22, 22px)', fontWeight: 700 }}>{summary.corrections}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)' }}>Money received, net effect</div>
            <div style={{ fontSize: 'var(--fs-22, 22px)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{signed(summary.netMovedSen)}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-soft, #777)' }}>Deleted</div>
            <div style={{ fontSize: 'var(--fs-22, 22px)', fontWeight: 700 }}>{summary.deleted}{summary.deleted > 0 ? ` · ${fmt(summary.deletedSen)}` : ''}</div>
          </div>
        </div>
      )}

      {q.data && rows.length === 0 && (
        <div style={{ ...cardStyle, fontSize: 'var(--fs-13)', color: 'var(--c-ink-soft, #777)' }}>
          No payment correction on the amend right was recorded for {monthText(month)}.
          Same-day fixes by the person who keyed a payment are on that order's audit history, not here.
        </div>
      )}

      {shown.length > 0 && (
        <div style={{ ...cardStyle, padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.18))' }}>
                <th style={{ padding: '8px 12px' }}>Corrected</th>
                <th style={{ padding: '8px 12px' }}>Sales order</th>
                <th style={{ padding: '8px 12px' }}>What changed</th>
                <th style={{ padding: '8px 12px' }}>Reason</th>
                <th style={{ padding: '8px 12px' }}>Ledger</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => <CorrectionLine key={r.id} r={r} />)}
            </tbody>
          </table>
        </div>
      )}

      {q.data && print.open && (
        <PrintPreviewModal
          open={print.open}
          onClose={print.close}
          docTitle="Payment Corrections"
          docNo={monthText(month)}
          rows={[
            { label: 'Corrections', value: String(shown.length) },
            { label: 'Corrected by', value: who || 'Everyone' },
            { label: 'Money received, net effect', value: signed(summary?.netMovedSen ?? 0) },
          ]}
          {...print.handlers}
        />
      )}
    </div>
  );
};

const CorrectionLine = ({ r }: { r: PaymentCorrectionRow }) => {
  const soft = 'var(--c-ink-soft, #777)';
  const deleted = r.kind === 'deleted';
  return (
    <tr style={{ borderBottom: '1px solid var(--c-line, rgba(34,31,32,0.10))', verticalAlign: 'top' }}>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
        {fmtDateOrDash(r.at.slice(0, 10))}
        <div style={{ color: soft, fontSize: 'var(--fs-12)' }}>{r.by}</div>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <Link to={`/scm/sales-orders/${encodeURIComponent(r.docNo)}`}>{r.docNo}</Link>
        {r.customer && <div style={{ color: soft, fontSize: 'var(--fs-12)' }}>{r.customer}</div>}
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{
          padding: '1px 8px', borderRadius: 999, fontSize: 'var(--fs-12)', fontWeight: 600,
          background: deleted ? 'rgba(184, 51, 31, 0.12)' : 'rgba(47, 93, 79, 0.12)',
          color: deleted ? 'var(--c-festive-b, #B8331F)' : 'var(--c-secondary-a, #2F5D4F)',
        }}>
          {deleted ? 'Deleted' : 'Edited'}
        </span>
        <div style={{ marginTop: 4 }}>{whatChanged(r)}</div>
      </td>
      <td style={{ padding: '8px 12px' }}>{r.reason || '—'}</td>
      <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--fs-12)', whiteSpace: 'nowrap' }}>
        {ledgerText(r)}
      </td>
    </tr>
  );
};
