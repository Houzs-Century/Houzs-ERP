// ----------------------------------------------------------------------------
// OfficialDoc — 欠正式单 (owner 2026-10-01, payment-request item 3) where a
// payment is read: the state of its official invoice, and Finance's own marks —
// owed (paid on a proforma or quotation), checked (the official invoice came and
// is right), or clear. RECEIVED is never marked here: it is the requester's
// upload (POST /payment-requests/:id/official-doc). Checked is offered on OWED
// too (owner 2026-10-01, 漏洞 2): the official invoice may reach Finance another
// way, and a payment that answers no request has nobody to upload it.
// ----------------------------------------------------------------------------

import { OFFICIAL_LABEL, isOfficialState, useMarkOfficialDoc } from '../lib/official-doc-queries';

const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--c-orange)', textDecoration: 'underline', fontSize: 'var(--fs-12, 12px)',
};

/** The state in the owner's words — nothing when nothing is owed. */
export function OfficialDocChip({ state, note }: { state: string | null | undefined; note?: string | null }) {
  if (!isOfficialState(state)) return null;
  return (
    <span title={note ?? undefined} style={{ fontSize: 'var(--fs-11, 11px)', fontWeight: 600, color: OFFICIAL_LABEL[state].tone, whiteSpace: 'nowrap' }}>
      {OFFICIAL_LABEL[state].label}
    </span>
  );
}

/** Finance's marks on one payment — a voucher (PV) or an AP invoice (API). */
export function OfficialDocActions({ kind, id, state, note }: { kind: 'PV' | 'API'; id: string; state: string | null | undefined; note?: string | null }) {
  const mark = useMarkOfficialDoc();
  return (
    <span style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <OfficialDocChip state={state} note={note} />
      {!state && (
        <button type="button" style={linkBtn} disabled={mark.isPending} onClick={() => mark.mutate({ kind, id, state: 'OWED' })}>
          Mark: official invoice owed · 欠正式单
        </button>
      )}
      {(state === 'RECEIVED' || state === 'OWED') && (
        <button type="button" style={linkBtn} disabled={mark.isPending} onClick={() => mark.mutate({ kind, id, state: 'CHECKED' })}>
          Checked ✓ · 核对好了
        </button>
      )}
      {state === 'OWED' && (
        <button type="button" style={linkBtn} disabled={mark.isPending} onClick={() => mark.mutate({ kind, id, state: null })}>
          Clear the mark
        </button>
      )}
      {note && <span style={{ fontSize: 'var(--fs-12, 12px)', color: 'var(--fg-muted)' }}>{note}</span>}
    </span>
  );
}
