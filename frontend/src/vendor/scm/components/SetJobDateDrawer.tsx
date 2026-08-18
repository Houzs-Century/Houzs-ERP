// ----------------------------------------------------------------------------
// SetJobDateDrawer — put a date on ONE service-case (ASSR) job.
//
// WHY IT EXISTS. Owner's 2026-08-04 column pass removed the board's "Sched.
// Date" column but kept scheduling: "删列但保留排期 —— 把排期挪进右键菜单 /
// 展开行,板上不占列". SO rows already had somewhere to go — the row menu opens
// ScheduleTripDrawer, which does date + driver + lorry + trip. ASSR rows had
// nothing: that inline cell was the only way to date a service-case leg, so
// removing it would have taken pickup / inspection / service jobs off the
// planning board entirely.
//
// It is deliberately ONE field. ScheduleTripDrawer is SO-only by construction
// (it keys every order by so_doc_no and applies with type:'so'), and teaching
// it a second identity to gain crew assignment for ASSR would be a large change
// to the drawer the whole bulk-scheduling flow runs through. A service case
// takes its crew from the trip it is wired onto, which the board's own Driver /
// Lorry cells still set.
//
// Chrome mirrors NewDpOrderDrawer (Suppliers CSS module, in-app NotifyDialog).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../../components/Button';
import {
  useScheduleDelivery,
  assrJobKindLabel,
  type PlanningOrder,
} from '../lib/delivery-planning-queries';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';
import { DateField } from "./DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

export function SetJobDateDrawer({ order, onClose }: { order: PlanningOrder; onClose: () => void }) {
  const sched = useScheduleDelivery();
  const notify = useNotify();

  /* The leg's current date. For an ASSR row the board puts the leg's own date on
     amended_delivery_date, whichever leg it is — see the union's leg builder. */
  const current = (order.amended_delivery_date ?? '').slice(0, 10);
  const [date, setDate] = useState(current);

  const legLabel = assrJobKindLabel(order.job_kind);
  const dirty = date !== current;

  const save = (value: string | null) => {
    sched.mutate(
      {
        type: 'assr',
        id: String(order.assr_id ?? ''),
        scheduleDate: value,
        jobKind: order.job_kind,
      },
      {
        onSuccess: () => {
          notify({
            title: value ? 'Date set' : 'Date cleared',
            body: value
              ? `${order.ref ?? 'This job'} — ${legLabel} on ${value}. Assign a lorry and crew on the board.`
              : `${order.ref ?? 'This job'} — ${legLabel} is back to unscheduled.`,
          });
          onClose();
        },
        onError: (err) => notify({
          title: 'Could not save the date',
          body: err instanceof Error ? err.message : 'Something went wrong.',
          tone: 'error',
        }),
      },
    );
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Set job date</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}><X {...ICON} /></button>
        </div>

        <div className={styles.drawerBody}>
          <div style={{ marginBottom: 'var(--space-3)', fontSize: 'var(--fs-12)', lineHeight: 1.6 }}>
            <div><strong>{order.ref ?? '—'}</strong> · {legLabel}</div>
            <div style={{ color: 'var(--c-muted, #767b6e)' }}>{order.debtor_name ?? 'No customer name'}</div>
          </div>

          <label style={{ display: 'block' }}>
            <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-1)' }}>Job date</div>
            <DateField
              fullWidth
              className={styles.searchInput}
              style={{ width: '100%' }}
              value={date}
              disabled={sched.isPending}
              onChange={(iso) => setDate(iso)}
            />
          </label>
          <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--fs-11)', color: 'var(--c-muted, #767b6e)' }}>
            This is the date the fleet is booked for. Clearing it takes the job
            back to Pending Schedule.
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          {/* Clearing is its own action rather than "save an empty field": an
              operator emptying the box and pressing Save should not have to
              wonder whether that meant anything. */}
          <Button variant="ghost" onClick={() => save(null)} disabled={sched.isPending || !current}>
            Clear date
          </Button>
          <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => save(date || null)} disabled={sched.isPending || !dirty}>
              {sched.isPending ? 'Saving…' : 'Save date'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SetJobDateDrawer;
