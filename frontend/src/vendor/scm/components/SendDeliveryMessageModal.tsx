// ----------------------------------------------------------------------------
// SendDeliveryMessageModal — confirm + send a WhatsApp message for the selected
// Delivery Planning rows (owner 2026-07-22; message kinds 2026-10-05).
//
// Groups the selected SO rows by customer PHONE — one WhatsApp per phone
// bundling all that customer's orders, exactly like the sheet-era BulkSend —
// and shows the operator what will go out before anything is sent. Rows with
// no usable phone are listed as skipped, never silently dropped. The actual
// grouping/payload is the backend's job (POST /delivery-messages/send); this
// preview mirrors it so what you see is what is sent.
//
// `kind` picks the Connect automation (backend scm/lib/delivery-message-kinds
// .ts is the source of truth). Two kinds need the operator's input because the
// ERP does not hold the data: Driver Info (driver / lorry / time) and Postpone
// (reason / proposed date) — their fields appear here and gate the Send button.
//
// Mirrors ScheduleDpOrderDrawer's chrome + the Suppliers CSS module. In-app
// NotifyDialog only. While Connect is unconfigured the backend answers 503 —
// surfaced here as the error notify.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { X, MessageSquare } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useSendDeliveryMessages,
  useUpdateDeliveryFields,
  type PlanningOrder,
  type SendMessageKind,
} from '../lib/delivery-planning-queries';
import { useDrivers } from '../lib/drivers-queries';
import { useLorries } from '../lib/lorries-queries';
import { useNotify } from './NotifyDialog';
import { DateField } from './DateField';
import styles from '../../../pages/scm-v2/Suppliers.module.css';

export type { SendMessageKind } from '../lib/delivery-planning-queries';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/** Same rule as the backend: digits only, '+' prefix, ≥8 digits or unusable. */
const phoneKey = (raw: string | null | undefined): string | null => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? `+${digits}` : null;
};

const effectiveDate = (o: PlanningOrder): string =>
  (o.amended_delivery_date ?? o.customer_delivery_date ?? '').slice(0, 10) || '—';

const owedSen = (o: PlanningOrder): number => Math.max(0, o.balance_sen_live ?? o.balance_sen);
const rm = (sen: number): string => (sen / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const KIND_TITLE: Record<SendMessageKind, string> = {
  delivery: 'Send delivery message',
  amend: 'Send amend / reschedule message',
  postpone: 'Send postpone notice',
  driver_info: 'Send driver information',
  balance_reminder: 'Send balance reminder',
  reminder_1: 'Send reminder 1',
  reminder_2: 'Send reminder 2',
  reminder_3: 'Send reminder 3',
  postage: 'Send postage confirmation',
  delivery_completed: 'Send delivery-completed thank-you',
};

/* The customer-message workflow status the board shows after a successful send
   of each kind (the sheet-era vocabulary, delivery-planning-queries
   MESSAGE_STATUSES; owner 2026-09-22 for the delivery send). null = the send
   does not move the status. Fire-and-forget per successfully-sent doc. */
const KIND_AFTER_STATUS: Record<SendMessageKind, string | null> = {
  delivery: 'Pending Customer Reply (D)',
  amend: 'Pending Reschedule (A)',
  postpone: 'Done Postpone Reason',
  driver_info: 'Done Driver Information',
  balance_reminder: 'Done Balance Collection',
  reminder_1: 'To Remind Customer Reply (1)',
  reminder_2: 'To Remind Customer Reply (2)',
  reminder_3: 'To Remind Customer Reply (3)',
  postage: null,
  delivery_completed: null,
};

const SKIP_LABEL: Record<string, string> = {
  not_found: 'order not found',
  no_phone: 'no usable phone',
  no_balance: 'nothing owed',
  no_address: 'no address on the order',
  driver_info_required: 'driver details missing',
  postpone_required: 'postpone details missing',
};

const fieldStyle = { display: 'grid', gap: 4, fontSize: 'var(--fs-12)' } as const;
const inputStyle = { padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 8, fontSize: 'var(--fs-13)', background: '#fff' } as const;

export const SendDeliveryMessageModal = ({ rows, onClose, kind = 'delivery' }: { rows: PlanningOrder[]; onClose: () => void; kind?: SendMessageKind }) => {
  const send = useSendDeliveryMessages();
  const updateFields = useUpdateDeliveryFields();
  const notify = useNotify();

  // Operator input for the kinds whose data the ERP does not hold.
  const needsDriver = kind === 'driver_info';
  const needsPostpone = kind === 'postpone';
  const drivers = useDrivers();
  const lorries = useLorries();
  const [driverId, setDriverId] = useState('');
  const [lorryId, setLorryId] = useState('');
  const [deliveryTime, setDeliveryTime] = useState('');
  const [postponeReason, setPostponeReason] = useState('');
  const [postponeDate, setPostponeDate] = useState('');

  const driver = (drivers.data ?? []).find((d) => d.id === driverId) ?? null;
  const lorry = (lorries.data ?? []).find((l) => l.id === lorryId) ?? null;
  const driverInfo = needsDriver && driver && deliveryTime.trim()
    ? {
        driverName: driver.name,
        driverContact: driver.phone,
        driverIc: driver.ic_number ?? '',
        carPlate: lorry?.plate ?? driver.vehicle ?? '',
        deliveryTime: deliveryTime.trim(),
      }
    : null;
  const postpone = needsPostpone && postponeReason.trim() && postponeDate
    ? { reason: postponeReason.trim(), newDate: postponeDate }
    : null;
  const inputReady = (!needsDriver || (!!driverInfo && !!driverInfo.driverContact)) && (!needsPostpone || !!postpone);

  // Preview grouping — mirrors the backend's phone grouping.
  const groups = new Map<string, PlanningOrder[]>();
  const noPhone: PlanningOrder[] = [];
  for (const r of rows) {
    const key = phoneKey(r.phone);
    if (!key) { noPhone.push(r); continue; }
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const sendableDocs = [...groups.values()].flat().map((r) => r.so_doc_no);

  const submit = () => {
    if (sendableDocs.length === 0 || send.isPending || !inputReady) return;
    send.mutate({
      docNos: sendableDocs,
      kind,
      ...(driverInfo ? { driverInfo } : {}),
      ...(postpone ? { postpone } : {}),
    }, {
      onSuccess: (res) => {
        // A successful send advances the customer-message workflow status for
        // that kind (KIND_AFTER_STATUS). The SEND status ("Done All") is derived
        // separately from the wa_message_log record; the board re-reads on
        // invalidate.
        const after = KIND_AFTER_STATUS[kind];
        if (after) {
          for (const s of res.sent) {
            for (const id of s.docNos) {
              updateFields.mutate({ type: 'so', id, deliveryMessageStatus: after });
            }
          }
        }
        const parts: string[] = [];
        if (res.sent.length) parts.push(`Sent ${res.sent.length} message${res.sent.length === 1 ? '' : 's'} (${res.sent.reduce((n, s) => n + s.docNos.length, 0)} orders).`);
        if (res.failed.length) parts.push(`Failed ${res.failed.length}: ${res.failed.map((f) => `${f.phone} (${f.error})`).join('; ')}.`);
        if (res.skipped.length) parts.push(`Skipped ${res.skipped.length}: ${res.skipped.map((s) => `${s.docNo} (${SKIP_LABEL[s.reason] ?? s.reason})`).join(', ')}.`);
        notify({
          title: res.failed.length ? 'Send finished with failures' : 'Messages sent',
          body: parts.join(' ') || 'Nothing to send.',
          tone: res.failed.length ? 'error' : 'info',
        });
        onClose();
      },
      onError: (err) => notify({
        title: 'Send failed',
        body: err instanceof Error ? err.message : 'Something went wrong.',
        tone: 'error',
      }),
    });
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>{KIND_TITLE[kind]}</h2>
          <button type="button" onClick={onClose} className={styles.codeChip}><X {...ICON} /></button>
        </div>

        <div className={styles.drawerBody}>
          <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-3)', color: 'var(--c-burnt)' }}>
            One message per customer phone — {groups.size} message{groups.size === 1 ? '' : 's'}, {sendableDocs.length} order{sendableDocs.length === 1 ? '' : 's'}
          </div>

          {needsDriver && (
            <div style={{ display: 'grid', gap: 'var(--space-3)', marginBottom: 'var(--space-3)', padding: 'var(--space-3)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
              <label style={fieldStyle}>
                <span>Driver</span>
                <select value={driverId} onChange={(e) => setDriverId(e.target.value)} style={inputStyle}>
                  <option value="">Choose a driver…</option>
                  {(drivers.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}{d.phone ? ` · ${d.phone}` : ''}</option>)}
                </select>
              </label>
              <label style={fieldStyle}>
                <span>Lorry (plate)</span>
                <select value={lorryId} onChange={(e) => setLorryId(e.target.value)} style={inputStyle}>
                  <option value="">{driver?.vehicle ? `Driver's own vehicle (${driver.vehicle})` : 'Choose a lorry…'}</option>
                  {(lorries.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.plate}{l.model ? ` · ${l.model}` : ''}</option>)}
                </select>
              </label>
              <label style={fieldStyle}>
                <span>Delivery time (as the customer will read it)</span>
                <input value={deliveryTime} onChange={(e) => setDeliveryTime(e.target.value)} placeholder="e.g. 10am – 1pm" style={inputStyle} />
              </label>
              {driver && !driver.phone && (
                <div style={{ color: 'var(--c-burnt)', fontSize: 'var(--fs-12)' }}>This driver has no phone on file — the message prints the contact, so add it in Fleet first.</div>
              )}
            </div>
          )}

          {needsPostpone && (
            <div style={{ display: 'grid', gap: 'var(--space-3)', marginBottom: 'var(--space-3)', padding: 'var(--space-3)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
              <label style={fieldStyle}>
                <span>Reason (printed after "due to")</span>
                <input value={postponeReason} onChange={(e) => setPostponeReason(e.target.value)} placeholder="e.g. lorry breakdown" maxLength={120} style={inputStyle} />
              </label>
              <label style={fieldStyle}>
                <span>Proposed new date</span>
                <DateField fullWidth value={postponeDate} onChange={(iso) => setPostponeDate(iso)} style={inputStyle} />
              </label>
            </div>
          )}

          {[...groups.entries()].map(([phone, list]) => {
            const groupOwed = list.reduce((n, r) => n + owedSen(r), 0);
            return (
              <div key={phone} style={{ marginBottom: 'var(--space-3)', padding: 'var(--space-3)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <MessageSquare size={14} strokeWidth={1.75} aria-hidden style={{ color: 'var(--c-burnt)' }} />
                  <strong style={{ fontSize: 'var(--fs-13)' }}>{list[0]?.debtor_name ?? '—'}</strong>
                  <span style={{ color: 'var(--c-muted, #767b6e)', fontSize: 'var(--fs-12)' }}>{phone}</span>
                  {kind === 'balance_reminder' && (
                    <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: groupOwed > 0 ? 'var(--ink, #221f20)' : 'var(--c-burnt)' }}>
                      {groupOwed > 0 ? `Owing RM ${rm(groupOwed)}` : 'Nothing owed — will be skipped'}
                    </span>
                  )}
                </div>
                {list.map((r) => (
                  <div key={r.so_doc_no} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--fs-12)', padding: '2px 0' }}>
                    <span>{r.so_doc_no}{r.branding ? ` · ${r.branding}` : ''}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--c-muted, #767b6e)' }}>{effectiveDate(r)}</span>
                  </div>
                ))}
              </div>
            );
          })}

          {noPhone.length > 0 && (
            <div style={{ padding: 'var(--space-3)', border: '1px dashed var(--line)', borderRadius: 'var(--radius-md)', color: 'var(--c-muted, #767b6e)', fontSize: 'var(--fs-12)' }}>
              Skipped — no usable phone: {noPhone.map((r) => r.so_doc_no).join(', ')}
            </div>
          )}
        </div>

        {!inputReady && (
          <div style={{ padding: '0 var(--space-4)', color: 'var(--c-burnt)', fontSize: 'var(--fs-12)' }}>
            {needsDriver ? 'Pick the driver and type the delivery time to enable sending.' : 'Type the reason and pick the proposed date to enable sending.'}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={sendableDocs.length === 0 || send.isPending || !inputReady}>
            {send.isPending ? 'Sending…' : `Send ${groups.size} message${groups.size === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  );
};
