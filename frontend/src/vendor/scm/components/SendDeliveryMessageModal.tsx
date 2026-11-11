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
// the operator does not pick it again. The delivery-time window differs per
// customer, so EACH customer carries its own time field, pre-filled from the
// row's Time Slot so it is not keyed twice. Ready customers send one Connect call
// each (owner 2026-10-27).
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
  assrJobKindLabel,
  useSendDeliveryMessages,
  type PlanningOrder,
  type SendDeliveryMessagesBody,
  type SendDeliveryMessagesResult,
  type SendMessageKind,
} from '../lib/delivery-planning-queries';
import { groupTimeSlot, phoneKey, planDriverInfoGroup, type DriverGroupPlan } from '../lib/driver-info-send';
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
  overdue_order: 'Send overdue-order notice',
  driver_info: 'Send driver information',
  balance_reminder: 'Send balance reminder',
  reminder_1: 'Send reminder 1',
  reminder_2: 'Send reminder 2',
  reminder_3: 'Send reminder 3',
  postage: 'Send postage confirmation',
  delivery_completed: 'Send delivery-completed thank-you',
  assr_arrangement: 'Send service arrangement',
};

/* The send itself moves each sent order to its "Done X" (backend
   delivery-message-kinds.ts KIND_AFTER_STATUS, HC-0164); this names the orders
   it could not move so the operator sets them by hand. */
const NOT_MOVED_LABEL: Record<string, string> = {
  lease: 'open in the SO editor',
  conflict: 'changed by someone else meanwhile',
  not_found: 'order not found',
  read_failed: 'could not be read',
};
export const statusNotMovedNote = (list: SendDeliveryMessagesResult['statusNotMoved']): string | null =>
  list && list.length > 0
    ? `Delivery Message Status NOT updated for ${list.map((n) => `${n.docNo} (${NOT_MOVED_LABEL[n.reason] ?? n.reason})`).join(', ')} - set it on the row.`
    : null;

/** "Failed N: phone, phone (reason)." — one reason printed once, not per customer. */
export const failedNote = (list: SendDeliveryMessagesResult['failed']): string | null => {
  if (list.length === 0) return null;
  const byError = new Map<string, string[]>();
  for (const f of list) byError.set(f.error, [...(byError.get(f.error) ?? []), f.phone]);
  return `Failed ${list.length}: ${[...byError].map(([error, phones]) => `${phones.join(', ')} (${error})`).join('; ')}.`;
};

/* HC-0197: the Worker messages one customer after another, so 64 customers in
   one request ran past the 30 s request deadline and the board never heard
   which ones went. A request now carries at most SEND_CHUNK customers. */
export const SEND_CHUNK = 10;

/** Send each customer's orders, SEND_CHUNK customers per request, one request
 *  after another. A request that fails marks only its own customers failed. */
export async function sendInChunks(
  sendOne: (body: SendDeliveryMessagesBody) => Promise<SendDeliveryMessagesResult>,
  kind: SendMessageKind,
  customers: Array<{ phone: string; docNos: string[] }>,
  onProgress?: (customersDone: number) => void,
): Promise<Required<SendDeliveryMessagesResult>> {
  const agg: Required<SendDeliveryMessagesResult> = { sent: [], failed: [], skipped: [], statusNotMoved: [] };
  for (let i = 0; i < customers.length; i += SEND_CHUNK) {
    const chunk = customers.slice(i, i + SEND_CHUNK);
    try {
      const res = await sendOne({ docNos: chunk.flatMap((g) => g.docNos), kind });
      agg.sent.push(...res.sent);
      agg.failed.push(...res.failed);
      agg.skipped.push(...res.skipped);
      agg.statusNotMoved.push(...(res.statusNotMoved ?? []));
    } catch (err) {
      const error = err instanceof Error ? err.message : 'send failed';
      for (const g of chunk) agg.failed.push({ phone: g.phone, docNos: g.docNos, error });
    }
    onProgress?.(Math.min(i + SEND_CHUNK, customers.length));
  }
  return agg;
}

export const SKIP_LABEL: Record<string, string> = {
  not_found: 'order not found',
  no_phone: 'no usable phone',
  no_balance: 'nothing owed',
  no_address: 'no address on the order',
  driver_info_required: 'driver details missing',
  postpone_needs_reason_date: 'set Amend Reason + Delivery Date on the row first',
  no_job_date: 'no job date on the case',
  case_closed: 'case is closed',
  not_assr: 'not a Service Case job',
  assr_only: 'Service Case jobs only',
};

/** The per-customer block reasons, phrased for the operator. */
const DRIVER_BLOCK_HINT: Record<NonNullable<DriverGroupPlan['block']>, string> = {
  no_driver: 'No driver on these orders — set the Driver column on the row first.',
  not_linked: 'This driver was typed on the delivery order, not picked from Fleet, so there is no IC or phone. Pick the driver in the Driver column first.',
  no_contact: 'This driver has no contact on file — add it in Fleet first.',
  no_time: 'No Time Slot on the row — type a delivery time to send this customer.',
};

const fieldStyle = { display: 'grid', gap: 4, fontSize: 'var(--fs-12)' } as const;
const inputStyle = { padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 8, fontSize: 'var(--fs-13)', background: 'var(--hz-c-surface)' } as const;
const noteStyle = { marginBottom: 'var(--space-3)', padding: 'var(--space-3)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-12)', color: 'var(--c-muted, #767b6e)' } as const;

export const SendDeliveryMessageModal = ({ rows, onClose, onSent, kind = 'delivery' }: {
  rows: PlanningOrder[];
  onClose: () => void;
  /** The rows whose message went out — the board unticks them (HC-0197). */
  onSent?: (rows: PlanningOrder[]) => void;
  kind?: SendMessageKind;
}) => {
  const send = useSendDeliveryMessages();
  const notify = useNotify();

  const needsDriver = kind === 'driver_info';
  // Postpone takes no input here: it reads each order's Amend Reason and
  // Delivery Date straight off the board (set those columns on the row first).
  const isPostpone = kind === 'postpone';
  // One Service Case job per message: the template names one case and one date.
  const isAssrSend = kind === 'assr_arrangement';

  // Driver Info only: the operator's per-customer edits of the delivery time,
  // keyed by phone. A customer not edited here sends its rows' Time Slot.
  const [timeByPhone, setTimeByPhone] = useState<Record<string, string>>({});
  // Sequential per-customer sends run across several awaits, so a local flag
  // keeps the button disabled for the whole run (send.isPending toggles per call).
  const [busy, setBusy] = useState(false);
  const [customersDone, setCustomersDone] = useState(0);

  // Preview grouping — mirrors the backend's phone grouping.
  const groups = new Map<string, PlanningOrder[]>();
  const noPhone: PlanningOrder[] = [];
  for (const r of rows) {
    // A Service Case job sends alone (its template names one date), never
    // bundled with another job or an SO on the same phone.
    const key = phoneKey(r.phone) && (r.row_type === 'assr' ? r.so_doc_no : phoneKey(r.phone));
    if (!key) { noPhone.push(r); continue; }
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const sendableDocs = [...groups.values()].flat().map((r) => r.so_doc_no);
  const customers = [...groups.entries()].map(([phone, list]) => ({ phone, docNos: list.map((r) => r.so_doc_no) }));

  // Driver Info: one plan per customer (driver pulled from the orders' crew +
  // this customer's typed time). A customer is ready only when its plan has no
  // block; ready customers each send their own Connect call.
  const timeFor = (phone: string, list: PlanningOrder[]): string => timeByPhone[phone] ?? groupTimeSlot(list);
  const driverGroups = needsDriver
    ? [...groups.entries()].map(([phone, list]) => ({
        phone,
        docNos: list.map((r) => r.so_doc_no),
        plan: planDriverInfoGroup(list, timeFor(phone, list)),
      }))
    : [];
  const planByPhone = new Map(driverGroups.map((g) => [g.phone, g.plan]));
  const readyDriverGroups = driverGroups.filter((g) => g.plan.block === null);

  const messageCount = needsDriver ? readyDriverGroups.length : groups.size;
  const canSend = !busy && !send.isPending && messageCount > 0;

  type SendResult = Awaited<ReturnType<typeof send.mutateAsync>>;

  /* Post-send: summarise and close. The server already moved each sent order's
     Delivery Message Status; only the ones it could not move are listed. */
  const finish = (res: SendResult) => {
    const sentDocs = new Set(res.sent.flatMap((s) => s.docNos));
    onSent?.(rows.filter((r) => sentDocs.has(r.so_doc_no)));
    const notMoved = statusNotMovedNote(res.statusNotMoved);
    const failed = failedNote(res.failed);
    const parts: string[] = [];
    if (res.sent.length) parts.push(`Sent ${res.sent.length} message${res.sent.length === 1 ? '' : 's'}${isAssrSend ? '.' : ` (${res.sent.reduce((n, s) => n + s.docNos.length, 0)} orders).`}`);
    if (failed) parts.push(failed);
    if (res.skipped.length) parts.push(`Skipped ${res.skipped.length}: ${res.skipped.map((s) => `${s.docNo} (${SKIP_LABEL[s.reason] ?? s.reason})`).join(', ')}.`);
    if (notMoved) parts.push(notMoved);
    void notify({
      title: res.failed.length ? 'Send finished with failures' : 'Messages sent',
      body: parts.join(' ') || 'Nothing to send.',
      tone: res.failed.length || notMoved ? 'error' : 'info',
    });
    onClose();
  };

  const submit = async () => {
    if (!canSend) return;

    if (needsDriver) {
      // One Connect call per ready customer, each with its own driver + time.
      setBusy(true);
      const agg: Required<SendDeliveryMessagesResult> = { sent: [], failed: [], skipped: [], statusNotMoved: [] };
      for (const g of readyDriverGroups) {
        try {
          const res = await send.mutateAsync({ docNos: g.docNos, kind, driverInfo: g.plan.payload! });
          agg.sent.push(...res.sent);
          agg.failed.push(...res.failed);
          agg.skipped.push(...res.skipped);
          agg.statusNotMoved.push(...(res.statusNotMoved ?? []));
        } catch (err) {
          agg.failed.push({ phone: g.phone, docNos: g.docNos, error: err instanceof Error ? err.message : 'send failed' });
        }
      }
      setBusy(false);
      finish(agg);
      return;
    }

    // Every other kind (postpone / balance / postage read what they need off
    // each order server-side), a few customers per request.
    setBusy(true);
    setCustomersDone(0);
    const res = await sendInChunks(send.mutateAsync, kind, customers, setCustomersDone);
    setBusy(false);
    finish(res);
  };

  // A send in progress keeps the drawer open: closing it would hide which customers went.
  const close = busy ? undefined : onClose;

  return (
    <div className={styles.backdrop} onClick={close}>
      <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
        <div className={styles.drawerHeader}>
          <h2 className={styles.drawerTitle}>{KIND_TITLE[kind]}</h2>
          <button type="button" onClick={close} disabled={busy} className={styles.codeChip}><X {...ICON} /></button>
        </div>

        <div className={styles.drawerBody}>
          <div className={styles.eyebrow} style={{ marginBottom: 'var(--space-3)', color: 'var(--c-burnt)' }}>
            One message per {isAssrSend ? 'Service Case job' : 'customer phone'} — {groups.size} message{groups.size === 1 ? '' : 's'}{isAssrSend ? '' : `, ${sendableDocs.length} order${sendableDocs.length === 1 ? '' : 's'}`}
          </div>

          {needsDriver && (
            <div style={noteStyle}>
              Each customer's message uses the <strong>driver set on the row</strong> (the Driver / Lorry columns) — no need to pick it again. The <strong>delivery time</strong> is taken from the row's <strong>Time Slot</strong>; change it below only if the customer should read something else. A customer with no driver on the row is skipped. A Service Case job sends on its own, with its job date.
            </div>
          )}

          {isAssrSend && (
            <div style={noteStyle}>
              The customer gets the case number, the job and its date (the <strong>Delivery Date</strong> Logistics set, else Service's requested date), with <strong>Confirm Date / Amend Date</strong> buttons. Their answer shows in Customer Request Date and on the case timeline.
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
                  <span style={{ color: 'var(--c-muted, var(--hz-c-ink-muted))', fontSize: 'var(--fs-12)' }}>{phoneKey(list[0]?.phone)}</span>
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
                        <span>Delivery time (as the customer will read it){!(phone in timeByPhone) && groupTimeSlot(list) ? ' — from Time Slot' : ''}</span>
                        <input
                          value={timeFor(phone, list)}
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
                    <span>{r.row_type === 'assr' ? `${r.ref} · ${assrJobKindLabel(r.job_kind)}` : r.so_doc_no}{r.branding ? ` · ${r.branding}` : ''}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--c-muted, var(--hz-c-ink-muted))' }}>{effectiveDate(r)}</span>
                  </div>
                ))}
              </div>
            );
          })}

          {noPhone.length > 0 && (
            <div style={{ padding: 'var(--space-3)', border: '1px dashed var(--line)', borderRadius: 'var(--radius-md)', color: 'var(--c-muted, var(--hz-c-ink-muted))', fontSize: 'var(--fs-12)' }}>
              Skipped — no usable phone: {noPhone.map((r) => (r.row_type === 'assr' ? r.ref : r.so_doc_no)).join(', ')}
            </div>
          )}
        </div>

        {needsDriver && messageCount === 0 && (
          <div style={{ padding: '0 var(--space-4)', color: 'var(--c-burnt)', fontSize: 'var(--fs-12)' }}>
            Set the Time Slot on the row (or type a delivery time here) for at least one customer to enable sending.
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={close} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={!canSend}>
            {busy && !needsDriver
              ? `Sending ${customersDone} / ${messageCount}…`
              : busy || send.isPending ? 'Sending…' : `Send ${messageCount} message${messageCount === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  );
};
