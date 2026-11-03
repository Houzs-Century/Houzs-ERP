// ----------------------------------------------------------------------------
// One scanned delivery order in the check step (owner 2026-11-03, after
// Hookka's scan modal): collapsed, a summary line with its flags; open, the
// fields and the lines to edit before it becomes a draft goods receipt.
// ----------------------------------------------------------------------------
import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Loader2, Plus, X } from 'lucide-react';
import { DateField } from './DateField';
import { fetchDocFileBlobUrl } from '../lib/payment-voucher-queries';
import { writeFailedAs } from '../lib/mutation-error';
import { newLineKey, type CheckDoc, type CheckPoLine, type CheckSupplier, type GrnReview } from '../lib/scan-gr-check';
import styles from './ScanOrderModal.module.css';

type Props = {
  doc: CheckDoc;
  review: GrnReview | null;
  suppliers: CheckSupplier[];
  poLines: CheckPoLine[];
  checked: boolean;
  block: string | null;
  onToggle: () => void;
  onChange: (review: GrnReview) => void;
  onDelete: () => void;
};

const label = (l: CheckPoLine) => `${l.poNumber} · ${l.itemCode}${l.name ? ` · ${l.name}` : ''} · owed ${l.remaining}${l.warehouse ? ` · ${l.warehouse}` : ''}`;

export function ScanGrnCheckCard({ doc, review, suppliers, poLines, checked, block, onToggle, onChange, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const supplier = suppliers.find((s) => s.id === review?.supplierId);
  const mine = poLines.filter((l) => l.supplierId === review?.supplierId);
  const byId = new Map(poLines.map((l) => [l.poItemId, l]));
  const warehouses = [...new Set((review?.lines ?? []).map((l) => (l.poItemId ? byId.get(l.poItemId)?.warehouse : null)).filter(Boolean))];
  const pos = [...new Set((review?.lines ?? []).map((l) => (l.poItemId ? byId.get(l.poItemId)?.poNumber : null)).filter(Boolean))];
  const pages = doc.pages ? ` · pages ${doc.pages[0]}–${doc.pages[1]}` : '';

  const viewFile = async () => {
    try {
      const { url } = await fetchDocFileBlobUrl(`/scan-gr/check/${doc.id}/file`);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { writeFailedAs('Could not open the file')(e); }
  };

  if (doc.state !== 'pending' || !review) {
    return (
      <div className={styles.orderCard} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {doc.state === 'reading' ? <Loader2 size={15} className={styles.spin} /> : <X size={15} color="var(--err, #b23a3a)" />}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.fileName ?? 'Document'}{pages}</span>
        <span className={`${styles.chip} ${doc.state === 'reading' ? styles.chipYellow : styles.chipGrey}`}>{doc.state === 'reading' ? 'Reading…' : 'Could not read'}</span>
        {doc.state === 'failed' && doc.note && <span className={styles.resultSub} style={{ maxWidth: 360 }}>{doc.note}</span>}
        <button type="button" className={styles.removeBtn} onClick={onDelete} aria-label="Delete this scan"><X size={14} /></button>
      </div>
    );
  }

  const set = (patch: Partial<GrnReview>) => onChange({ ...review, ...patch });
  const setLine = (key: string, patch: Partial<GrnReview['lines'][number]>) => set({ lines: review.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  return (
    <div className={styles.orderCard} style={{ borderColor: checked ? 'var(--accent, #6b5a2e)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label="Include this delivery order" />
        <button type="button" className={styles.removeBtn} onClick={() => setOpen((v) => !v)} aria-label={open ? 'Collapse' : 'Open to edit'}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <span style={{ fontWeight: 600 }}>{supplier?.name ?? review.supplierRead ?? 'Supplier not recognised'}</span>
        <span style={{ color: 'var(--fg-muted)' }}>· D.O. {review.doNo ?? '—'} · {review.deliveryDate ?? 'no date'}{warehouses.length ? ` · ${warehouses.join(', ')}` : ''}{pos.length ? ` · ${pos.join(', ')}` : ''}</span>
        {doc.duplicateOf && <span className={`${styles.chip} ${styles.chipYellow}`}>Already {doc.duplicateOf}</span>}
        {block && <span className={`${styles.chip} ${styles.chipGrey}`} title={block}>Needs a fix</span>}
        <span style={{ flex: 1 }} />
        {doc.hasFile && (
          <button type="button" className={styles.docLink} onClick={() => void viewFile()}>
            <FileText size={13} style={{ verticalAlign: '-2px' }} /> {doc.fileName ?? 'File'}{pages}
          </button>
        )}
        <button type="button" className={styles.removeBtn} onClick={onDelete} aria-label="Delete this scan"><X size={14} /></button>
      </div>
      {block && open && <div className={styles.orderError} style={{ marginTop: 8 }}>{block}</div>}
      {doc.note && open && <div className={styles.resultSub} style={{ marginTop: 6 }}>{doc.note}</div>}

      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Supplier{review.supplierRead ? ` · read: ${review.supplierRead}` : ''}</span>
              <select className={styles.input} value={review.supplierId ?? ''} onChange={(e) => set({ supplierId: e.target.value || null, lines: review.lines.map((l) => ({ ...l, poItemId: null })) })}>
                <option value="">Choose the supplier…</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.code}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery order no</span>
              <input className={styles.input} value={review.doNo ?? ''} onChange={(e) => set({ doNo: e.target.value || null })} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Received date</span>
              <DateField value={review.deliveryDate ?? ''} onChange={(v) => set({ deliveryDate: v || null })} aria-label="Received date" fullWidth />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Note</span>
              <input className={styles.input} value={review.notes ?? ''} onChange={(e) => set({ notes: e.target.value || null })} />
            </label>
          </div>

          <div style={{ marginTop: 10, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
                  <th style={{ padding: '4px 6px', width: 28 }}>#</th>
                  <th style={{ padding: '4px 6px' }}>Receive into PO line (item)</th>
                  <th style={{ padding: '4px 6px', width: 90 }}>Qty</th>
                  <th style={{ padding: '4px 6px' }}>Printed on the delivery order</th>
                  <th style={{ width: 28 }} />
                </tr>
              </thead>
              <tbody>
                {review.lines.map((l, i) => (
                  <tr key={l.key} style={{ borderTop: '1px solid var(--border, #e3e6e0)' }}>
                    <td style={{ padding: '4px 6px', color: 'var(--fg-muted)' }}>{i + 1}</td>
                    <td style={{ padding: '4px 6px', minWidth: 280 }}>
                      <select className={styles.input} value={l.poItemId ?? ''} onChange={(e) => setLine(l.key, { poItemId: e.target.value || null })} aria-label={`PO line for row ${i + 1}`}>
                        <option value="">{review.supplierId ? 'Choose the PO line…' : 'Choose the supplier first'}</option>
                        {l.poItemId && !mine.some((m) => m.poItemId === l.poItemId) && byId.get(l.poItemId) && <option value={l.poItemId}>{label(byId.get(l.poItemId) as CheckPoLine)}</option>}
                        {mine.map((m) => <option key={m.poItemId} value={m.poItemId}>{label(m)}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <input className={styles.input} type="number" min={0} step="1" value={l.qty} onChange={(e) => setLine(l.key, { qty: Math.max(0, Number(e.target.value) || 0) })} aria-label={`Qty for row ${i + 1}`} />
                    </td>
                    <td style={{ padding: '4px 6px', color: 'var(--fg-muted)' }}>
                      {l.read ? [l.read.itemCode, l.read.description, `qty ${l.read.qty}`, l.read.poNo ? `PO ${l.read.poNo}` : null].filter(Boolean).join(' · ') : '—'}
                    </td>
                    <td>
                      <button type="button" className={styles.removeBtn} onClick={() => set({ lines: review.lines.filter((x) => x.key !== l.key) })} aria-label={`Remove row ${i + 1}`}><X size={13} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className={styles.docLink} style={{ marginTop: 6 }} onClick={() => set({ lines: [...review.lines, { key: newLineKey(), poItemId: null, qty: 1, read: null }] })}>
              <Plus size={13} style={{ verticalAlign: '-2px' }} /> Add line
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
