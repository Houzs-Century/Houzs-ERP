// ----------------------------------------------------------------------------
// BillPlanDialog — Plan date on a supplier bill (the owner's Claude Design,
// Money out batch 4 step 7): when Finance plans to pay it, beside the
// supplier's due date — never instead of it, so Overdue still counts by the
// due date. Opened from Supplier bills' ⋯ and the bill's page; the To do
// calendar moves the same date by dragging the bill. Posts nothing.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Button } from '@2990s/design-system';
import { Modal } from '../../vendor/scm/components/Modal';
import { DateField } from '../../vendor/scm/components/DateField';
import { useToastOptional } from '../../hooks/useToast';
import { usePlanBill } from '../../vendor/scm/lib/ap-invoice-queries';
import { fmtDate, fmtSen, todayMY } from '../../vendor/shared/format';
import mo from './MoneyOut.module.css';

export type PlannableBill = {
  kind: 'API' | 'PI'; id: string; number: string; supplierName: string | null;
  outstandingSen: number | null; due: string | null; planned: string | null;
};

const weekday = (ymd: string): string => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

/** The design's toast for a planned date moved — the same words from the dialog and the calendar. */
export const planMovedText = (no: string, day: string, due: string | null): string =>
  `Planned payment for ${no} moved to ${weekday(day)} ${fmtDate(day)} · supplier due stays ${due ? fmtDate(due) : '—'}`;

export function BillPlanDialog({ bill, onClose }: { bill: PlannableBill; onClose: () => void }) {
  const plan = usePlanBill();
  const toast = useToastOptional();
  const today = todayMY();
  const [day, setDay] = useState(bill.planned ?? '');
  const [error, setError] = useState<string | null>(null);
  const past = !!day && day < today;

  const save = async (plannedOn: string | null) => {
    setError(null);
    try {
      await plan.mutateAsync({ kind: bill.kind, id: bill.id, plannedOn });
      toast?.success(plannedOn ? planMovedText(bill.number, plannedOn, bill.due) : `${bill.number} has no plan now — it is paid by its due date`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The planned date was not saved.');
    }
  };

  const title = `Plan the payment of ${bill.number}${bill.supplierName ? ` · ${bill.supplierName}` : ''}${bill.outstandingSen != null ? ` · ${fmtSen(bill.outstandingSen)}` : ''}`;
  return (
    <Modal title={title} onClose={onClose} ariaLabel={`Plan the payment of ${bill.number}`} width="min(480px, 100%)">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
          Planned payment
          <DateField fullWidth value={day} onChange={(iso) => setDay(iso)} aria-label="Planned payment date" />
        </label>
        <div className={mo.hint}>When we plan to pay. Blank means the due date{bill.due ? ` (${fmtDate(bill.due)})` : ''}. Overdue still counts by the due date.</div>
        {past && <div className={mo.hint} role="alert">A bill cannot be planned on a past day.</div>}
        {error && <div className={mo.hint} role="alert">{error}</div>}
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={plan.isPending}>Cancel</Button>
          {bill.planned && <Button variant="secondary" size="sm" onClick={() => void save(null)} disabled={plan.isPending}>Clear plan</Button>}
          <Button variant="primary" size="sm" onClick={() => void save(day)} disabled={plan.isPending || !day || past}>
            {plan.isPending ? 'Saving…' : 'Save planned date'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
