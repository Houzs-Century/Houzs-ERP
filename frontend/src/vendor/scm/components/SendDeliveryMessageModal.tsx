// ----------------------------------------------------------------------------
// SendDeliveryMessageModal — confirm + send the WhatsApp delivery message for
// the selected Delivery Planning rows (owner 2026-07-22).
//
// Groups the selected SO rows by customer PHONE — one WhatsApp per phone
// bundling all that customer's orders, exactly like the sheet-era BulkSend —
// and shows the operator what will go out before anything is sent. Rows with
// no usable phone are listed as skipped, never silently dropped. The actual
// grouping/payload is the backend's job (POST /delivery-messages/send); this
// preview mirrors it so what you see is what is sent.
//
// Mirrors ScheduleDpOrderDrawer's chrome + the Suppliers CSS module. In-app
// NotifyDialog only. While Seampify is unconfigured the backend answers 503 —
// surfaced here as the error notify.
// ----------------------------------------------------------------------------

import { X, MessageSquare } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useSendDeliveryMessages,
  useUpdateDeliveryFields,
  type PlanningOrder,
} from '../lib/delivery-planning-queries';
import { useNotify } from './NotifyDialog';
import styles from '../../../pages/scm-v2/Suppliers.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/** Same rule as the backend: digits only, '+' prefix, ≥8 digits or unusable. */
const phoneKey = (raw: string | null | undefined): string | null => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? `+${digits}` : null;
};

const effectiveDate = (o: PlanningOrder): string =>
  (o.amended_delivery_date ?? o.customer_delivery_date ?? '').slice(0, 10) || '—';

/* Which message the header button asked to send (owner 2026-09-22). Only the
   delivery message has a working send path today; amend / one-time messages are
   sent through chat.houzscentury.com, wired in the next phase — so they preview
   here but the send stays disabled until that connection lands. */
export type SendMessageKind = 'delivery' | 'amend' | 'onetime';
const KIND_TITLE: Record<SendMessageKind, string> = {
  delivery: 'Send delivery message',
  amend: 'Send amend / reschedule message',
  onetime: 'Send a one-time message',
};

export const SendDeliveryMessageModal = ({ rows, onClose, kind = 'delivery' }: { rows: PlanningOrder[]; onClose: () => void; kind?: SendMessageKind }) => {
  const send = useSendDeliveryMessages();
  const updateFields = useUpdateDeliveryFields();
  const notify = useNotify();
  const sendEnabled = kind === 'delivery';

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
    if (sendableDocs.length === 0 || send.isPending || !sendEnabled) return;
    send.mutate({ docNos: sendableDocs }, {
      onSuccess: (res) => {
        // Send Now completed → the customer-message workflow advances to
        // "Pending Customer Reply (D)" (owner 2026-09-22: we've sent the delivery
        // date; now we wait for the customer). The SEND status becomes "Done All"
        // separately, derived from the wa_message_log send record. Fire-and-forget
        // per successfully-sent doc; the board re-reads on invalidate.
        // submit() returned early unless sendEnabled (kind === 'delivery'), so
        // every successful send that reaches here is a delivery-date send.
        for (const s of res.sent) {
          for (const id of s.docNos) {
            updateFields.mutate({ type: 'so', id, deliveryMessageStatus: 'Pending Customer Reply (D)' });
          }
        }
        const parts: string[] = [];
        if (res.sent.length) parts.push(`Sent ${res.sent.length} message${res.sent.length === 1 ? '' : 's'} (${res.sent.reduce((n, s) => n + s.docNos.length, 0)} orders).`);
        if (res.failed.length) parts.push(`Failed ${res.failed.length}: ${res.failed.map((f) => `${f.phone} (${f.error})`).join('; ')}.`);
        if (res.skipped.length) parts.push(`Skipped ${res.skipped.length}: ${res.skipped.map((s) => `${s.docNo} (${s.reason})`).join(', ')}.`);
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

          {[...groups.entries()].map(([phone, list]) => (
            <div key={phone} style={{ marginBottom: 'var(--space-3)', padding: 'var(--space-3)', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <MessageSquare size={14} strokeWidth={1.75} aria-hidden style={{ color: 'var(--c-burnt)' }} />
                <strong style={{ fontSize: 'var(--fs-13)' }}>{list[0]?.debtor_name ?? '—'}</strong>
                <span style={{ color: 'var(--c-muted, #767b6e)', fontSize: 'var(--fs-12)' }}>{phone}</span>
              </div>
              {list.map((r) => (
                <div key={r.so_doc_no} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--fs-12)', padding: '2px 0' }}>
                  <span>{r.so_doc_no}{r.branding ? ` · ${r.branding}` : ''}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--c-muted, #767b6e)' }}>{effectiveDate(r)}</span>
                </div>
              ))}
            </div>
          ))}

          {noPhone.length > 0 && (
            <div style={{ padding: 'var(--space-3)', border: '1px dashed var(--line)', borderRadius: 'var(--radius-md)', color: 'var(--c-muted, #767b6e)', fontSize: 'var(--fs-12)' }}>
              Skipped — no usable phone: {noPhone.map((r) => r.so_doc_no).join(', ')}
            </div>
          )}
        </div>

        {!sendEnabled && (
          <div style={{ padding: '0 var(--space-4)', color: 'var(--c-burnt)', fontSize: 'var(--fs-12)' }}>
            This message type is sent through chat.houzscentury.com — connect it to enable sending. Preview only for now.
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
          <Button variant="ghost" size="md" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="md" onClick={submit} disabled={sendableDocs.length === 0 || send.isPending || !sendEnabled}>
            {send.isPending ? 'Sending…' : `Send ${groups.size} message${groups.size === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </div>
  );
};
