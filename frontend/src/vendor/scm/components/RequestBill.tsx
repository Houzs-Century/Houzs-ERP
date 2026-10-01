// ----------------------------------------------------------------------------
// RequestBill — what the bill reader read off a payment request's bill, and the
// same bill seen elsewhere (owner 2026-10-01, payment-request item 1:
// 同一张单上传两次 — match on the bill's number and date, warn, never block).
// Style-neutral (inline styles on the design tokens, with fallbacks) so the
// desktop form, the phone sheet and Finance's voucher form say the same words.
// ----------------------------------------------------------------------------

import { billMatchText, type BillMatch } from '../lib/payment-request-queries';
import type { BillReadState } from '../lib/request-bill-read';
import { fmtDateOrDash, fmtSen } from '../../shared/format';

const box = (tone: 'note' | 'warn'): React.CSSProperties => ({
  padding: '8px 10px',
  borderRadius: 8,
  fontSize: 'var(--fs-12, 12.5px)',
  border: tone === 'warn' ? '1px solid var(--c-festive-b, #B8331F)' : '1px dashed var(--line, #d8d4cc)',
  color: tone === 'warn' ? 'var(--c-festive-b, #B8331F)' : 'inherit',
  background: tone === 'warn' ? 'var(--c-cream, #faf8f3)' : 'transparent',
});

/** "No. MLE-0925 · 2026/09/01 · total RM 8,500.00" — a dash where nothing was read. */
export const billFactsLine = (f: { billNo: string | null | undefined; billDate: string | null | undefined; totalSen: number | null | undefined }): string =>
  [`No. ${f.billNo || '—'}`, fmtDateOrDash(f.billDate ?? null), f.totalSen != null ? `total ${fmtSen(f.totalSen)}` : null].filter(Boolean).join(' · ');

/** The same bill on other live documents — said out loud, never refused. */
export function BillMatchesNote({ matches }: { matches: BillMatch[] | undefined }) {
  if (!matches || matches.length === 0) return null;
  return (
    <div role="alert" aria-label="Same bill elsewhere" style={box('warn')}>
      <div style={{ fontWeight: 600 }}>Same bill already asked for or paid · 这张单已经有了</div>
      {matches.map((m) => <div key={`${m.kind}-${m.id}`}>{billMatchText(m)}</div>)}
      <div style={{ marginTop: 2, color: 'var(--fg-muted, #666)' }}>A balance on the same bill is fine — otherwise check it is not paid twice.</div>
    </div>
  );
}

/** While the bill is read; what was read; or why it could not be. */
export function BillReadNote({ state }: { state: BillReadState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'reading') return <div role="status" style={box('note')}>Reading the bill…</div>;
  if (state.status === 'failed') {
    return <div role="status" style={box('note')}>The bill could not be read ({state.reason}). Send it anyway — Finance reads it again.</div>;
  }
  return (
    <>
      <div role="status" style={box('note')}>Read from the bill: {billFactsLine(state.result.bill)}</div>
      <BillMatchesNote matches={state.result.matches} />
    </>
  );
}
