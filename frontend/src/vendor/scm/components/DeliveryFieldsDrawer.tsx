// ----------------------------------------------------------------------------
// DeliveryFieldsDrawer — edit the HC delivery-sheet raw-data fields on one order
// (migration 0197). Opened from the Delivery Planning board's per-row "Edit HC
// fields" action.
//
// Two groups, split by where the data is owned:
//   • SO-context  — possession date, house type (New House / Replacement),
//     replacement disposal, referral. ALWAYS editable (saved on the SO header).
//   • DO-execution — time window + confirmed, arrival/departure clock, shipout
//     date, customer-delivered date, port/shipment ref, and the HC "Remark 4"
//     delivery sub-status. Editable ONLY when the order has a DO; otherwise the
//     group is disabled with a hint (the SO-context group still saves).
//
// Saves via PATCH /delivery-planning/:type/:id/fields (useUpdateDeliveryFields),
// which invalidates the planning board. Mirrors WarehouseFormDrawer's look +
// the Suppliers drawer CSS module (2990 cream brand). In-app NotifyDialog only —
// never a naked alert/confirm.
//
// HOUZS VENDOR NOTE: Suppliers.module.css path rewired from '../pages/...' to
// '../../../pages/scm-v2/Suppliers.module.css' (the vendored components dir is
// two levels deeper than the 2990 source's `apps/backend/src/components/`).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useUpdateDeliveryFields,
  HC_SUBSTATUS_VALUES,
  type PlanningOrder,
} from '../lib/delivery-planning-queries';
import { useCreateAmendment } from '../lib/so-amendment-queries';
import { procLockActive } from '../lib/so-detail-gates';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';
import { DateField } from "./DateField";
import { DateTimeField } from "./DateTimeField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const HOUSE_TYPES = ['New House', 'Replacement'] as const;

/* A TIMESTAMPTZ ISO string → the wall-clock YYYY-MM-DDTHH:mm that DateTimeField
   reads and writes (the same shape a native datetime-local used, unchanged when
   Arrival/Departure moved onto DateTimeField on 2026-08-18).
   Best-effort: slice the ISO; empty when null. */
const toDtLocal = (iso: string | null): string =>
  iso ? String(iso).slice(0, 16) : '';
/* A YYYY-MM-DD date string → the ISO value DateField takes. */
const toDateInput = (d: string | null): string => (d ? String(d).slice(0, 10) : '');

export const DeliveryFieldsDrawer = ({
  order, onClose,
}: {
  order: PlanningOrder;
  onClose: () => void;
}) => {
  const update = useUpdateDeliveryFields();
  const createAmendment = useCreateAmendment();
  const notify = useNotify();

  // The order always carries an SO doc_no; DO-execution fields need a DO.
  const hasDo = order.delivery_orders.length > 0;

  /* Two-lane phase 2 (owner 2026-07-27): Replacement / Disposal is a CONTROLLED
     SO field. On a processing-locked order its change "appears in SO Amendment —
     Logistics reviews → approves" (the owner's ruling), so saving here routes
     that ONE field into an amendment request while everything else still saves
     directly. Same predicate the SO editor uses (procLockActive). */
  const procLocked = procLockActive({
    processing_date: order.processing_date,
    status: order.status,
    /* Owner 2026-08-12 — the board row carries the PO half of the lock (the
       drawer cannot derive it: the payload has no PO linkage). Omitting it here
       would send a disposal change on a PO-locked 2990 SO down the direct-write
       path, straight into the backend guard's 409, with no way to raise the
       amendment the message asks for. */
    po_locked: order.po_locked,
  });

  const [form, setForm] = useState({
    // SO-context
    possessionDate: toDateInput(order.possession_date),
    houseType: order.house_type ?? '',
    replacementDisposal: order.replacement_disposal ?? '',
    referral: order.referral ?? '',
    // DO-execution
    timeRange: order.time_range ?? '',
    timeConfirmed: order.time_confirmed ?? false,
    arrivalAt: toDtLocal(order.arrival_at),
    departureAt: toDtLocal(order.departure_at),
    shipoutDate: toDateInput(order.shipout_date),
    customerDeliveredDate: toDateInput(order.customer_delivered_date),
    etaArrivingPort: order.eta_arriving_port ?? '',
    deliverySubstatus: order.delivery_substatus ?? '',
  });

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  /* Disposal actually changed vs the persisted value ('' and null collapse). */
  const disposalDirty =
    (form.replacementDisposal.trim() || null) !== (order.replacement_disposal ?? null);
  const disposalViaAmendment = procLocked && disposalDirty;

  const submit = () => {
    // Always send SO-context; send DO-execution only when a DO exists (else the
    // API would just hint anyway — keep the request tight).
    const body: Record<string, unknown> = {
      type: 'so' as const,
      id: order.so_doc_no,
      possessionDate: form.possessionDate || null,
      houseType: form.houseType || null,
      referral: form.referral || null,
    };
    /* Locked + changed → the disposal value is EXCLUDED from the direct save
       (the API 409s it anyway) and submitted as a DELIVERY-lane amendment
       below. Unlocked, it saves directly as before. */
    if (!disposalViaAmendment) body.replacementDisposal = form.replacementDisposal || null;
    if (hasDo) {
      Object.assign(body, {
        timeRange: form.timeRange || null,
        timeConfirmed: form.timeConfirmed,
        arrivalAt: form.arrivalAt || null,
        departureAt: form.departureAt || null,
        shipoutDate: form.shipoutDate || null,
        customerDeliveredDate: form.customerDeliveredDate || null,
        etaArrivingPort: form.etaArrivingPort || null,
        deliverySubstatus: form.deliverySubstatus || null,
      });
    }
    update.mutate(body as Parameters<typeof update.mutate>[0], {
      onSuccess: (res) => {
        if (!disposalViaAmendment) {
          if (res?.no_do_hint) notify({ title: 'Saved (partly)', body: res.no_do_hint });
          onClose();
          return;
        }
        createAmendment.mutate({
          docNo: order.so_doc_no,
          reason: 'Replacement / disposal update (Delivery Planning board)',
          lines: [],
          headerChanges: { replacementDisposal: form.replacementDisposal.trim() || null },
        }, {
          onSuccess: () => {
            notify({
              title: 'Saved — disposal change sent for approval',
              body: 'The Replacement / Disposal change was raised as an SO Amendment. Review and approve it in Amendments (Logistics).',
            });
            onClose();
          },
          onError: (err) =>
            notify({
              title: 'Disposal change NOT submitted',
              body: `${err instanceof Error ? err.message : 'Something went wrong.'} The other fields were saved.`,
              tone: 'error',
            }),
        });
      },
      onError: (err) =>
        notify({ title: 'Save failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' }),
    });
  };

  const fieldRow: CSSProperties = { display: 'block', marginBottom: 'var(--space-3)' };
  const inputStyle: CSSProperties = { width: '100%' };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>Edit HC Fields · {order.so_doc_no}</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}>
            <X {...ICON} />
          </button>
        </div>

        <div className={styles.drawerBody}>
          {/* ── SO-context group (always editable) ─────────────────────────── */}
          <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-2)', color: 'var(--c-burnt)' }}>
            Order context
          </div>

          <label style={fieldRow}>
            <div className={styles.eyebrow}>Possession Date</div>
            <DateField
              fullWidth
              className={styles.searchInput}
              style={inputStyle}
              value={form.possessionDate}
              onChange={(iso) => set('possessionDate', iso)}
            />
          </label>

          <label style={fieldRow}>
            <div className={styles.eyebrow}>House Type</div>
            <select className={styles.searchInput} style={inputStyle}
              value={form.houseType}
              onChange={(e) => set('houseType', e.target.value)}>
              <option value="">—</option>
              {HOUSE_TYPES.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>

          <label style={fieldRow}>
            <div className={styles.eyebrow}>Replacement / Disposal</div>
            <input className={styles.searchInput} style={inputStyle}
              value={form.replacementDisposal} placeholder="What's being disposed / how the old set is handled"
              onChange={(e) => set('replacementDisposal', e.target.value)} />
            {procLocked && (
              <div style={{
                marginTop: 4, fontSize: 'var(--fs-11)', color: 'var(--c-burnt)',
              }}>
                Order is locked — saving a change here raises an SO Amendment for
                Logistics to approve.
              </div>
            )}
          </label>

          <label style={fieldRow}>
            <div className={styles.eyebrow}>Referral</div>
            <input className={styles.searchInput} style={inputStyle}
              value={form.referral} placeholder="Referral source / channel"
              onChange={(e) => set('referral', e.target.value)} />
          </label>

          {/* ── DO-execution group (needs a DO) ────────────────────────────── */}
          <div className={styles.eyebrow}
            style={{ margin: 'var(--space-4) 0 var(--space-2)', color: 'var(--c-burnt)' }}>
            Delivery execution {hasDo ? '' : '(needs a DO)'}
          </div>
          {!hasDo && (
            <div style={{
              background: 'rgba(232, 107, 58, 0.06)', border: '1px solid var(--c-orange, #e86b3a)',
              color: 'var(--c-burnt)', padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-11)', marginBottom: 'var(--space-3)',
            }}>
              No delivery order yet — create a DO first to record the time window, shipout, port and delivery status.
            </div>
          )}

          <fieldset disabled={!hasDo} style={{ border: 'none', padding: 0, margin: 0, opacity: hasDo ? 1 : 0.55 }}>
            <label style={fieldRow}>
              <div className={styles.eyebrow}>Time Range</div>
              <input className={styles.searchInput} style={inputStyle}
                value={form.timeRange} placeholder="e.g. 10am-12pm"
                onChange={(e) => set('timeRange', e.target.value)} />
            </label>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 'var(--space-3)' }}>
              <input type="checkbox" checked={form.timeConfirmed}
                onChange={(e) => set('timeConfirmed', e.target.checked)} />
              Time confirmed with customer
            </label>

            <label style={fieldRow}>
              <div className={styles.eyebrow}>Arrival</div>
              <DateTimeField fullWidth className={styles.searchInput} style={inputStyle}
                aria-label="Arrival"
                value={form.arrivalAt}
                onChange={(v) => set('arrivalAt', v)} />
            </label>

            <label style={fieldRow}>
              <div className={styles.eyebrow}>Departure</div>
              <DateTimeField fullWidth className={styles.searchInput} style={inputStyle}
                aria-label="Departure"
                value={form.departureAt}
                onChange={(v) => set('departureAt', v)} />
            </label>

            <label style={fieldRow}>
              <div className={styles.eyebrow}>Shipout Date (EM/SG)</div>
              <DateField
                fullWidth
                className={styles.searchInput}
                style={inputStyle}
                value={form.shipoutDate}
                onChange={(iso) => set('shipoutDate', iso)}
              />
            </label>

            <label style={fieldRow}>
              <div className={styles.eyebrow}>Customer Delivered Date</div>
              <DateField
                fullWidth
                className={styles.searchInput}
                style={inputStyle}
                value={form.customerDeliveredDate}
                onChange={(iso) => set('customerDeliveredDate', iso)}
              />
            </label>

            <label style={fieldRow}>
              <div className={styles.eyebrow}>ETA / Arriving Port (EM/SG)</div>
              <input className={styles.searchInput} style={inputStyle}
                value={form.etaArrivingPort} placeholder="Port / shipment ref e.g. KUC3012008"
                onChange={(e) => set('etaArrivingPort', e.target.value)} />
            </label>

            <label style={fieldRow}>
              <div className={styles.eyebrow}>Delivery Status (Remark 4)</div>
              <select className={styles.searchInput} style={inputStyle}
                value={form.deliverySubstatus}
                onChange={(e) => set('deliverySubstatus', e.target.value)}>
                <option value="">—</option>
                {HC_SUBSTATUS_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </fieldset>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};
