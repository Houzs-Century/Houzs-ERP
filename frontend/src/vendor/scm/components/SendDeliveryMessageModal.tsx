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
// .ts is the source of truth). Driver Info reads the driver (name / IC / contact
// / plate) off each order's own crew — the board's Driver / Lorry columns — so
// the operator does not pick it again; the one thing the ERP does not hold is the
// delivery-time window, and it differs per customer, so EACH customer carries its
// own time field. Ready customers send one Connect call each (owner 2026-10-27).
// Postpone likewise reads the row's Amend Reason + Delivery Date.
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
import { phoneKey, planDriverInfoGroup, type DriverGroupPlan } from '../lib/driver-info-send';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';

export type { SendMessageKind } from '../lib/delivery-planning-queries';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

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
   MESSAGE_STATUSES). Owner 2026-10-21: every send lands the row on its "Done X".
   Fire-and-forget per successfully-sent doc. */
export const KIND_AFTER_STATUS: Record<SendMessageKind, string | null> = {
  delivery: 'Done Send',
  amend: 'Done Amend',
  postpone: 'Done Postpone Reason',
  driver_info: 'Done Driver Information',
  balance_reminder: 'Done Balance Collection',
  reminder_1: 'Done Remind (1)',
  reminder_2: 'Done Remind (2)',
  reminder_3: 'Done Remind (3)',
  postage: 'Done Postage',
  delivery_completed: 'Done Delivered',
};

export const SKIP_LABEL: Record<string, string> = {
  not_found: 'order not found',
  no_phone: 'no usable phone',
  no_balance: 'nothing owed',
  no_address: 'no address on the order',
  driver_info_required: 'driver details missing',
  postpone_needs_reason_date: 'set Amend Reason + Delivery Date on the row first',
};

/** The per-customer block reasons, phrased for the operator. */
const DRIVER_BLOCK_HINT: Record<NonNullable<DriverGroupPlan['block']>, string> = {
  no_driver: 'No driver on these orders — set the Driver column on the row first.',
  no_contact: 'This driver has no contact on file — add it in Fleet first.',
  no_time: 'Type a delivery time to send this customer.',
};

const fieldStyle = { display: 'grid', gap: 4, fontSize: 'var(--fs-12)' } as const;
const inputStyle = { padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 8, fontSize: 'var(--fs-13)', background: '#fff' } as const;
const noteStyle = { marginBottom: 'var(--space-3)', padding: 'var(--space-3)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-12)', color: 'var(--c-muted, #767b6e)' } as const;

export const SendDeliveryMessageModal = ({ rows, onClose, kind = 'delivery' }: { rows: PlanningOrder[]; onClose: () => void; kind?: SendMessageKind }) => {
  const send = useSendDeliveryMessages();
  const updateFields = useUpdateDeliveryFields();
  const notify = useNotify();

  const needsDriver = kind === 'driver_info';
  // Postpone takes no input here: it reads each order's Amend Reason and
  // Delivery Date straight off the board (set those columns on the row first).
  const isPostpone = kind === 'postpone';

  // Driver Info only: the per-customer delivery-time window, keyed by phone.
  const [timeByPhone, setTimeByPhone] = useState<Record<string, string>>({});
  // Sequential per-customer sends run across several awaits, so a local flag
  // keeps the button disabled for the whole run (send.isPending toggles per call).
  const [busy, setBusy] = useState(false);

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

  // Driver Info: one plan per customer (driver pulled from the orders' crew +
  // this customer's typed time). A customer is ready only when its plan has no
  // block; ready customers each send their own Connect call.
  const driverGroups = needsDriver
    ? [...groups.entries()].map(([phone, list]) => ({
        phone,
        docNos: list.map((r) => r.so_doc_no),
        plan: planDriverInfoGroup(list, timeByPhone[phone] ?? ''),
      }))
    : [];
  const planByPhone = new Map(driverGroups.map((g) => [g.phone, g.plan]));
  const readyDriverGroups = driverGroups.filter((g) => g.plan.block === null);

  const messageCount = needsDriver ? readyDriverGroups.length : groups.size;
  const canSend = !busy && !send.isPending && messageCount > 0;

  type SendResult = Awaited<ReturnType<typeof send.mutateAsync>>;

  /* Post-send: advance the customer-message workflow status (KIND_AFTER_STATUS)
     per sent doc, summarise, and close. The SEND status is derived separately
     from the wa_message_log record; the board re-reads on invalidate. */
  const finish = (res: SendResult) => {
    const after = KIND_AFTER_STATUS[kind];
    if (after) {
      for (const s of res.sent) {
        for (const id of s.docNos) updateFields.mutate({ type: 'so', id, deliveryMessageStatus: after });
      }
    }
    const parts: string[] = [];
    if (res.sent.length) parts.push(`Sent ${res.sent.length} message${res.sent.length === 1 ? '' : 's'} (${res.sent.reduce((n, s) => n + s.docNos.length, 0)} orders).`);
    if (res.failed.length) parts.push(`Failed ${res.failed.length}: ${res.failed.map((f) => `${f.phone} (${f.error})`).join('; ')}.`);
    if (res.skipped.length) parts.push(`Skipped ${res.skipped.length}: ${res.skipped.map((s) => `${s.docNo} (${SKIP_LABEL[s.reason] ?? s.reason})`).join(', ')}.`);
    void notify({
      title: res.failed.length ? 'Send finished with failures' : 'Messages sent',
      body: parts.join(' ') || 'Nothing to send.',
      tone: res.failed.length ? 'error' : 'info',
    });
    onClose();
  };

  const submit = async () => {
    if (!canSend) return;

    if (needsDriver) {
      // One Connect call per ready customer, each with its own driver + time.
      setBusy(true);
      const agg: SendResult = { sent: [], failed: [], skipped: [] };
      for (const g of readyDriverGroups) {
        try {
          const res = await send.mutateAsync({ docNos: g.docNos, kind, driverInfo: g.plan.payload! });
          agg.sent.push(...res.sent);
          agg.failed.push(...res.failed);
          agg.skipped.push(...res.skipped);
        } catch (err) {
          agg.failed.push({ phone: g.phone, docNos: g.docNos, error: err instanceof Error ? err.message : 'send failed' });
        }
      }
      setBusy(false);
      finish(agg);
      return;
    }

    // Every other kind: one call for the whole selection (postpone / balance /
    // postage read what they need off each order server-side).
    try {
      const res = await send.mutateAsync({ docNos: sendableDocs, kind });
      finish(res);
    } catch (err) {
      void notify({ title: 'Send failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    }
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
            <div style={noteStyle}>
              Each customer's message uses the <strong>driver set on the row</strong> (the Driver / Lorry columns) — no need to pick it again. Type the <strong>delivery-time window</strong> for each customer below; a customer with no driver on the row is skipped.
            </div>
          )}

          {isPostpone && (
            <div style={noteStyle}>
              The notice uses each order's own <strong>Amend Reason</strong> (printed after "due to") and <strong>Delivery Date</strong> (the proposed new date) from the board. Set those two columns on the row first; an order missing either is skipped.
            </div>
          )}

          {[...groups.entries()].map(([phone, list]) => {
            const groupOwed = list.reduce((n, r) => n + owedSen(r), 0);
            const plan = planByPhone.get(phone) ?? null;
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

                {needsDriver && plan && (
                  <div style={{ display: 'grid', gap: 6, margin: '2px 0 8px' }}>
                    {plan.driver ? (
                      <div style={{ fontSize: 'var(--fs-12)' }}>
                        Driver: <strong>{plan.driver.driverName}</strong>
                        {plan.driver.carPlate ? ` · ${plan.driver.carPlate}` : ''}
                        {plan.driver.driverIc ? ` · IC ${plan.driver.driverIc}` : ''}
                        {plan.driver.driverContact ? ` · ${plan.driver.driverContact}` : ''}
                      </div>
                    ) : (
                      <div style={{ color: 'var(--c-burnt)', fontSize: 'var(--fs-12)' }}>{DRIVER_BLOCK_HINT.no_driver}</div>
                    )}
                    {plan.mixedDrivers && plan.driver && (
                      <div style={{ color: 'var(--c-burnt)', fontSize: 'var(--fs-12)' }}>These orders name more than one driver — the message will use {plan.driver.driverName}.</div>
                    )}
                    {plan.driver && (
                      <label style={fieldStyle}>
                        <span>Delivery time (as the customer will read it)</span>
                        <input
                          value={timeByPhone[phone] ?? ''}
                          onChange={(e) => setTimeByPhone((m) => ({ ...m, [phone]: e.target.value }))}
                          placeholder="e.g. 10am – 1pm"
                          style={inputStyle}
                        />
                      </label>
                    )}
                    {plan.block && plan.block !== 'no_driver' && (
                      <div style={{ color: 'var(--c-burnt)', fontSize: 'var(--fs-12)' }}>{DRIVER_BLOCK_HINT[plan.block]}</div>
                    )}
                  </div>
                )}

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

        {needsDriver && messageCount === 0 && (
          <div style={{ padding: '0 var(--space-4)', color: 'var(--c-burnt)', fontSize: 'var(--fs-12)' }}>
            Type a delivery time for at least one customer to enable sending.
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={!canSend}>
            {busy || send.isPending ? 'Sending…' : `Send ${messageCount} message${messageCount === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  );
};
