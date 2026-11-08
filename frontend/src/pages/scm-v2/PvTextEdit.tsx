// ----------------------------------------------------------------------------
// PvTextEdit — a checked voucher's words alone (owner 2026-11-06: 有时我要改
// description). The first yes locks the voucher; its notes and its lines'
// descriptions move no money, so they may still change until it is approved. The
// voucher stays checked, and the change shows on its trail. The server half is
// PATCH /payment-vouchers/:id/text (pvCanEditText).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Button } from '@2990s/design-system';
import { useUpdatePvText } from '../../vendor/scm/lib/payment-voucher-queries';
import styles from './SalesOrderDetail.module.css';

export type PvTextLine = { id: string; description: string | null };

export const PvTextEdit = ({ pvId, notes, lines, onClose }: {
  pvId: string; notes: string | null; lines: PvTextLine[]; onClose: () => void;
}) => {
  const save = useUpdatePvText();
  const [text, setText] = useState(notes ?? '');
  const [lineText, setLineText] = useState<Record<string, string>>(
    () => Object.fromEntries(lines.map((l) => [l.id, l.description ?? ''])),
  );
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    setFailed(null);
    try {
      await save.mutateAsync({ id: pvId, notes: text, lines: lines.map((l) => ({ id: l.id, description: lineText[l.id] ?? '' })) });
      onClose();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The words were not saved.');
    }
  };

  return (
    <section className={styles.card} aria-label="Edit text">
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Edit text</h2>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>The voucher stays checked</span>
      </div>
      <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <p style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)', margin: 0 }}>
          Only the words change. Amounts, accounts and the payee stay as they are, and the change shows in the voucher&rsquo;s history.
        </p>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Description</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} className={styles.fieldInput} rows={2} style={{ resize: 'vertical' }} aria-label="Description" />
        </label>
        {lines.map((l, i) => (
          <label key={l.id} className={styles.field}>
            <span className={styles.fieldLabel}>{`Line ${i + 1}`}</span>
            <input type="text" value={lineText[l.id] ?? ''} className={styles.fieldInput} aria-label={`Line ${i + 1} description`}
              onChange={(e) => setLineText((was) => ({ ...was, [l.id]: e.target.value }))} />
          </label>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span style={{ flex: 1, fontSize: 'var(--fs-12)', color: 'var(--c-festive-b, #B8331F)' }}>{failed}</span>
          <Button variant="ghost" size="sm" disabled={save.isPending} onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={save.isPending} onClick={() => void submit()}>{save.isPending ? 'Saving…' : 'Save text'}</Button>
        </div>
      </div>
    </section>
  );
};
