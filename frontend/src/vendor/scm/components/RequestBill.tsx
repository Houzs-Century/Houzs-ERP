// ----------------------------------------------------------------------------
// RequestBill — what the bill reader read off a payment request's bill, and the
// same bill seen elsewhere (owner 2026-10-01, payment-request item 1:
// 同一张单上传两次 — match on the bill's number and date, warn, never block).
// Style-neutral (inline styles on the design tokens, with fallbacks) so the
// desktop form, the phone sheet and Finance's voucher form say the same words.
// ----------------------------------------------------------------------------

import { STAGE, billMatchText, type BillFamily, type BillMatch } from '../lib/payment-request-queries';
import type { BillReadState } from '../lib/request-bill-read';
import { fmtDateOrDash, fmtSen } from '../../shared/format';

const box = (tone: 'note' | 'warn' | 'read'): React.CSSProperties => ({
  padding: '8px 10px',
  borderRadius: 8,
  fontSize: 'var(--fs-12, 12.5px)',
  lineHeight: 1.6,
  border: tone === 'warn' ? '1px solid var(--c-festive-b, #B8331F)' : tone === 'read' ? 'none' : '1px dashed var(--line, #d8d4cc)',
  color: tone === 'warn' ? 'var(--c-festive-b, #B8331F)' : tone === 'read' ? 'var(--c-secondary-a, #2F5D4F)' : 'inherit',
  background: tone === 'warn' ? 'var(--c-cream, #faf8f3)' : tone === 'read' ? 'var(--c-secondary-a-soft, #EAF3EE)' : 'transparent',
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

/** A bill paid in instalments (owner 2026-10-01, item 2: 一张单付两次): the whole
    bill's figures and each instalment, the one open marked. */
export function BillInstalments({ family, currentId }: { family: BillFamily; currentId: string }) {
  const figures = [
    family.totalSen != null ? `Total ${fmtSen(family.totalSen)}` : 'Total not known',
    `Paid ${fmtSen(family.paidSen)}`,
    family.pendingSen > 0 ? `Waiting ${fmtSen(family.pendingSen)}` : null,
    family.remainingSen != null ? `Left to ask ${fmtSen(family.remainingSen)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div role="group" aria-label="Instalments of this bill" style={box('note')}>
      <div style={{ fontWeight: 600 }}>This bill, in instalments · 分期</div>
      <div>{figures}</div>
      {family.installments.map((m) => (
        <div key={m.id} style={{ fontWeight: m.id === currentId ? 600 : 400 }}>
          #{m.installment_no} · {m.request_no} · {fmtSen(m.amount_sen)}{m.pay_pct != null ? ` (${m.pay_pct}%)` : ''} · {STAGE[m.stage].label}
        </div>
      ))}
    </div>
  );
}

/** The bill read, said once under it (owner 2026-10-02: 整齐一点): while it is
    read; why it could not be; or what it read and the fields it filled in —
    every one still the requester's to change (自动填了资料还能手动改). */
export function BillReadPanel({ state, filled }: { state: BillReadState; filled: string[] }) {
  if (state.status === 'idle') return null;
  if (state.status === 'reading') return <div role="status" style={box('note')}>Reading the bill…</div>;
  if (state.status === 'failed') {
    return <div role="status" style={box('note')}>The bill could not be read ({state.reason}). Send it anyway — Finance reads it again.</div>;
  }
  return (
    <>
      <div role="status" style={box('read')}>
        <div>✓ Read from the bill: {billFactsLine(state.result.bill)}</div>
        {filled.length > 0 && (
          <div aria-label="Filled in from the bill">Filled in below: {filled.join(' · ')} — 都可以自己改</div>
        )}
      </div>
      <BillMatchesNote matches={state.result.matches} />
    </>
  );
}
