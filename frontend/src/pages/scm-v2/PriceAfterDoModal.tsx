import { useState } from 'react';
import { DollarSign, X } from 'lucide-react';
import { fmtMoneySen } from '@2990s/shared';
import { Button } from '../../components/Button';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useMfgSoLinePriceAfterDo } from '../../vendor/scm/lib/sales-order-queries';
import { afterDoCopyProblem } from '../../vendor/scm/lib/so-after-do-client';
import styles from './SalesOrderDetail.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const fmtRm = (centi: number, currency = 'MYR'): string => fmtMoneySen(centi, currency);

type PricedLine = {
  id: string; item_code: string; description: string | null;
  qty: number; unit_price_sen: number; discount_sen: number; total_sen: number;
};

/* DEV-70 — PriceAfterDoModal: unit price + discount of a line a Delivery Order
   already carries (`scm.so.edit_price_after_do`). The server copies both onto
   the DO line(s) and any invoice billing them; qty, product and spec stay as delivered. */
export const PriceAfterDoModal = ({
  item,
  docNo,
  currency,
  onClose,
}: {
  item: PricedLine;
  docNo: string;
  currency: string;
  onClose: () => void;
}) => {
  const save = useMfgSoLinePriceAfterDo();
  const notify = useNotify();
  const [unitRm, setUnitRm] = useState((item.unit_price_sen / 100).toFixed(2));
  const [discRm, setDiscRm] = useState((item.discount_sen / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const unitSen = Math.round(Number(unitRm) * 100), discSen = Math.round(Number(discRm || 0) * 100);
  const valid = Number.isFinite(unitSen) && unitSen >= 0 && Number.isFinite(discSen) && discSen >= 0 && discSen <= item.qty * unitSen;
  const totalSen = valid ? item.qty * unitSen - discSen : null;

  const submit = () => {
    if (!valid) {
      void notify({ title: 'Unit price and discount must be zero or more, and the discount cannot be more than qty x unit price.', tone: 'error' });
      return;
    }
    save.mutate(
      { docNo, itemId: item.id, unitPriceSen: unitSen, discountSen: discSen, reason: reason.trim() || undefined },
      {
        onSuccess: (r) => {
          const msg = afterDoCopyProblem(r);
          if (msg) void notify({ title: 'Delivery Order not updated', body: msg, tone: 'error' });
          if (r.siCopyFailed?.length) void notify({ title: 'Invoice not updated', body: `The Sales Order saved, but ${r.siCopyFailed.join(', ')} was not updated. Open the invoice and check its amount.`, tone: 'error' });
          onClose();
        },
      },
    );
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Change price after DO">
        <header className={styles.modalHeader}>
          <h3 className={styles.modalTitle}>
            <DollarSign {...ICON} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Change Price After DO
          </h3>
          <button type="button" className={styles.iconBtn} onClick={onClose} title="Close">
            <X {...ICON} />
          </button>
        </header>

        <div className={styles.modalBody}>
          <p className={styles.muted}>
            Item <strong>{item.item_code}</strong>{item.description ? ` — ${item.description}` : ''} · Qty {item.qty}<br />
            Now: {fmtRm(item.unit_price_sen, currency)} each, discount {fmtRm(item.discount_sen, currency)}, amount {fmtRm(item.total_sen, currency)}<br />
            The Delivery Order line and its invoice change too. Qty and product stay as delivered.
          </p>

          <div className={styles.formGrid4}>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Unit Price (RM) *</span>
              <input type="number" step="0.01" min="0" aria-label="Unit Price (RM)"
                className={styles.fieldInput}
                value={unitRm}
                onChange={(e) => setUnitRm(e.target.value)} />
            </label>
            <label className={styles.field} style={{ gridColumn: 'span 2' }}>
              <span className={styles.fieldLabel}>Discount (RM)</span>
              <input type="number" step="0.01" min="0" aria-label="Discount (RM)"
                className={styles.fieldInput}
                value={discRm}
                onChange={(e) => setDiscRm(e.target.value)} />
            </label>
          </div>
          <p className={styles.muted}>New amount: <strong>{totalSen == null ? '—' : fmtRm(totalSen, currency)}</strong></p>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Reason (shown in History)</span>
            <textarea className={styles.fieldInput} rows={2}
              placeholder="e.g. Price was not keyed in when the order was imported."
              value={reason}
              onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>

        <footer className={styles.modalFooter}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending || !valid}>
            {save.isPending ? 'Saving…' : 'Save price'}
          </Button>
        </footer>
      </div>
    </div>
  );
};
