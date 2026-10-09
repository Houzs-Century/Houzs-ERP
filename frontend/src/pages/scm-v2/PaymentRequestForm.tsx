// ----------------------------------------------------------------------------
// PaymentRequestForm — the payment request form, new or edit (申请付款). Lives
// on the Payment Requests page and, since 2026-10-08, opens from a PMS row
// (owner: 我的bd 会upload rental invoice 在这里 … 就在这里加request payment): the
// row's own files arrive as the bill — read at once, exactly as if attached
// here — the row's event is fixed, and the request remembers the row
// (checklistItemId). A request raised from a row keeps that event when edited.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  NO_EVENT_REASON_MIN, pctOf, useCreatePaymentRequest, useUpdatePaymentRequest, useUploadPaymentRequestFile,
  type PaymentRequest, type PaymentRequestInput,
} from '../../vendor/scm/lib/payment-request-queries';
import { BILL_FILL_LABEL, billFactsOf, billOffer, fillFromBill, filledFromBill, needsEvent, useRequestBillRead, type BillOffer } from '../../vendor/scm/lib/request-bill-read';
import { BillReadPanel } from '../../vendor/scm/components/RequestBill';
import { EventSuggestions } from '../../vendor/scm/components/EventSuggestions';
import { fileToBase64, PV_FILE_ACCEPT, type PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { useEventLabels } from '../../vendor/scm/lib/event-queries';
import { EventSelect, eventCellText } from '../../vendor/scm/components/EventSelect';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';

export const EVENTS_PATH = '/payment-requests/event-options' as const;
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };

/** A request raised from a PMS row (owner 2026-10-08): the row's files as the
    bill, its event fixed, the row remembered. */
export type RequestSeed = { files: File[]; projectId: number; eventLabel: string; checklistItemId: number };

/* One step of the request form — a numbered heading over its fields (owner
   2026-10-02: 看了有点乱，整齐一点 — the mockup he said 做 to). */
function FormSection({ n, title, required = false, first = false, children }: { n: number; title: string; required?: boolean; first?: boolean; children: React.ReactNode }) {
  return (
    <section aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-4, 16px) 0', borderTop: first ? 'none' : '1px solid var(--line, #ece9e2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 'var(--fs-14, 14px)' }}>
        <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--c-secondary-a, #2F5D4F)', color: '#fff', fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>
        <span>{title}{required && <span style={{ color: 'var(--c-festive-b, #B8331F)' }}> *</span>}</span>
      </div>
      {children}
    </section>
  );
}

/* ── New / edit ─────────────────────────────────────────────────────────── */
export function RequestForm({ initial, hasEvents, onDone, onCancel, seed }: {
  initial: PaymentRequest | null;
  hasEvents: boolean;
  onDone: (id: string) => void;
  onCancel: () => void;
  /** Raised from a PMS row (owner 2026-10-08) — a new request only. */
  seed?: RequestSeed;
}) {
  const notify = useNotify();
  const create = useCreatePaymentRequest();
  const update = useUpdatePaymentRequest();
  const upload = useUploadPaymentRequestFile();
  const [v, setV] = useState<PaymentRequestInput>(() => ({
    payeeName: initial?.payee_name ?? '',
    amountSen: initial?.amount_sen ?? 0,
    dueDate: initial?.due_date ?? null,
    purpose: initial?.purpose ?? '',
    projectId: initial?.project_id ?? seed?.projectId ?? null,
    bankName: initial?.bank_name ?? null,
    bankAccountNo: initial?.bank_account_no ?? null,
    bankAccountName: initial?.bank_account_name ?? null,
    note: initial?.note ?? null,
  }));
  /* A PMS row's files are the bill from the start; anything picked here joins them. */
  const [files, setFiles] = useState<File[]>(() => (initial ? [] : seed?.files ?? []));
  /* The bill is READ as it is attached (owner 2026-10-01, item 1): its number,
     date and total, whether it is for an event, the same bill elsewhere. */
  const billRead = useRequestBillRead();
  /* What the last read offered each field — a field still holding it is the
     reader's, not the requester's, and a newer read may replace it. */
  const lastOffer = useRef<BillOffer>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const [noEvent, setNoEvent] = useState(() => !!initial?.no_event_reason);
  const [noEventReason, setNoEventReason] = useState(initial?.no_event_reason ?? '');
  const set = (patch: Partial<PaymentRequestInput>) => setV((prev) => ({ ...prev, ...patch }));
  /* A bill paid in instalments (item 2): its total — read off it, or typed —
     and this payment as an amount OR a percent of it. A balance's total is its
     first request's, not edited here. */
  const isBalance = !!initial?.parent_request_id;
  const [billTotal, setBillTotal] = useState<number | null>(initial?.bill_total_sen ?? null);
  const [pct, setPct] = useState<string>(initial?.pay_pct != null ? String(initial.pay_pct) : '');
  const pctValue = (() => { const n = Number(pct); return pct.trim() !== '' && Number.isFinite(n) && n > 0 && n <= 100 ? n : null; })();
  const applyPct = (raw: string, total: number | null) => {
    setPct(raw);
    const n = Number(raw);
    if (total != null && total > 0 && raw.trim() !== '' && Number.isFinite(n) && n > 0 && n <= 100) set({ amountSen: pctOf(total, n) });
  };
  /* The event is the PMS row's (owner 2026-10-08) — fixed on a request raised
     from a row, new or edited; the server refuses any other. */
  const fromRow = !!seed || initial?.checklist_item_id != null;
  const rowEventQ = useEventLabels(initial?.checklist_item_id != null ? [initial.project_id] : [], EVENTS_PATH);
  const rowEventLabel = seed?.eventLabel ?? eventCellText(rowEventQ.data, initial?.project_id ?? null);

  /* Read the bill and fill what is still empty from the paper (owner
     2026-10-02: upload 后很多资料都没有填); what they typed meanwhile stays, and
     all of it stays editable. */
  const runRead = billRead.run;
  const readBill = useCallback(async (list: File[]) => {
    const read = await runRead(list);
    if (read) {
      const offer = billOffer(read.bill);
      const before = lastOffer.current;
      lastOffer.current = offer;
      setV((prev) => fillFromBill(prev, offer, before));
    }
    const readTotal = read?.bill.totalSen ?? null;
    if (readTotal != null && readTotal > 0) setBillTotal((prev) => prev ?? readTotal);
    /* The event the bill points at most strongly is picked for them — they confirm or change it. */
    const top = read?.eventBill ? read.eventSuggestions[0] : undefined;
    if (top) setV((prev) => (prev.projectId == null ? { ...prev, projectId: top.id } : prev));
  }, [runRead]);
  const pickFiles = (list: File[]) => {
    setFiles(list);
    void readBill(list);
  };
  /* A PMS row's files are read the moment the form opens, as if attached here. */
  useEffect(() => {
    if (!initial && seed && seed.files.length > 0) void readBill(seed.files);
  }, [initial, seed, readBill]);

  /* An event bill goes with its Event — or the reason there is none (找不到这场活动). */
  const eventNeeded = hasEvents && (needsEvent(billRead.state) || !!initial?.event_bill);
  const eventOk = !eventNeeded || v.projectId != null || (noEvent && noEventReason.trim().length >= NO_EVENT_REASON_MIN);
  const reading = billRead.state.status === 'reading';
  const filledFields = filledFromBill(v, billRead.state.status === 'done' ? billOffer(billRead.state.result.bill) : {}).map((k) => BILL_FILL_LABEL[k]);
  const missing = [
    v.payeeName.trim() === '' ? 'who to pay' : null,
    v.amountSen > 0 ? null : 'the amount',
    v.purpose.trim() === '' ? 'what it is for' : null,
    !initial && files.length === 0 ? 'the bill' : null,
    eventOk ? null : 'the event (or why there is none)',
  ].filter(Boolean) as string[];
  const ready = missing.length === 0 && !reading;
  const saving = create.isPending || update.isPending || upload.isPending;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  const save = async () => {
    if (!ready) {
      void notify({ title: 'Not yet complete', body: reading ? 'The bill is still being read — a moment.' : `Still needed: ${missing.join(', ')}.`, tone: 'error' });
      return;
    }
    const body: PaymentRequestInput = {
      ...v,
      ...billFactsOf(billRead.state),
      note: v.note?.trim() || null,
      noEventReason: v.projectId == null && noEvent ? noEventReason.trim() : null,
      /* The total as it stands on the form (read, or typed over), and the percent
         only while the amount is still what it makes. */
      ...(isBalance ? {} : { billTotalSen: billTotal }),
      payPct: pctValue != null && billTotal != null && pctOf(billTotal, pctValue) === v.amountSen ? pctValue : null,
      /* The PMS row it came from (owner 2026-10-08) — a new request only. */
      ...(!initial && seed ? { checklistItemId: seed.checklistItemId } : {}),
    };
    try {
      const res = initial
        ? await update.mutateAsync({ id: initial.id, ...body })
        : await create.mutateAsync(body);
      const id = res.request.id;
      for (const f of files) {
        const payload: PvFilePayload = { name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) };
        try { await upload.mutateAsync({ id, file: payload }); } catch (e) {
          void notify({ title: `${f.name} did not attach`, body: e instanceof Error ? e.message : 'Attach it from the request.', tone: 'error' });
        }
      }
      onDone(id);
    } catch { /* the mutation's own onError told the user */ }
  };

  /* The order it is filled in (owner 2026-10-02: 看了有点乱，整齐一点): ① the bill,
     which fills the rest; ② who is paid, and into which account; ③ how much and
     by when; ④ what for, and the event. An edit has no bill step — its files
     are on the request. */
  const steps = [initial ? null : 'bill', 'payee', 'amount', 'purpose', 'note'].filter((x): x is string => x != null);
  const stepNo = (key: string): number => steps.indexOf(key) + 1;
  const grid = (min: number): React.CSSProperties => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 'var(--space-3)' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {initial?.status === 'REJECTED' && initial.finance_note && (
        <div style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-13)' }}>Finance returned it: {initial.finance_note}</div>
      )}
      {!initial && (
        <FormSection n={stepNo('bill')} title="单据 · The bill" required first>
          {/* A second pick adds to the first (the same file picked again is not
              added twice); the ✕ takes one file off. */}
          <input ref={fileRef} type="file" multiple accept={PV_FILE_ACCEPT} aria-label="Bill files" style={{ display: 'none' }}
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])].filter((p) => !files.some((f) => f.name === p.name && f.size === p.size));
              e.target.value = '';
              if (picked.length > 0) pickFiles([...files, ...picked]);
            }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
              <Paperclip size={16} strokeWidth={1.75} /> Attach the bill
            </Button>
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 8, background: 'var(--c-cream, #f4f3ee)', fontSize: 'var(--fs-13)' }}>
                {f.name}
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => pickFiles(files.filter((_, k) => k !== i))}
                  style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', color: 'var(--fg-muted)' }}>
                  <X size={14} />
                </button>
              </span>
            ))}
            {files.length === 0 && <span style={soft}>Invoice, quotation or proforma — a photo or PDF; several files are one bill's pages.</span>}
          </div>
          {seed && <span style={soft}>From the event's PMS row — the files the BD uploaded there.</span>}
          <BillReadPanel state={billRead.state} filled={filledFields} />
        </FormSection>
      )}

      <FormSection n={stepNo('payee')} title="付给谁 · Pay to" first={!!initial}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Pay to *</span>
          <input className={styles.fieldInput} value={v.payeeName} onChange={(e) => set({ payeeName: e.target.value })} aria-label="Pay to" placeholder="e.g. MLE EVENTS SDN BHD" />
        </label>
        <div style={grid(180)}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Payee's bank</span>
            <input className={styles.fieldInput} value={v.bankName ?? ''} onChange={(e) => set({ bankName: e.target.value || null })} aria-label="Payee's bank" placeholder="e.g. Maybank" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Account no.</span>
            <input className={styles.fieldInput} value={v.bankAccountNo ?? ''} onChange={(e) => set({ bankAccountNo: e.target.value || null })} aria-label="Account no." />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Account name</span>
            <input className={styles.fieldInput} value={v.bankAccountName ?? ''} onChange={(e) => set({ bankAccountName: e.target.value || null })} aria-label="Account name" />
          </label>
        </div>
      </FormSection>

      {/* 一张单付两次 (item 2): the bill's total, and this payment as an amount or a percent of it. */}
      <FormSection n={stepNo('amount')} title="付多少 · Amount">
        <div style={grid(140)}>
          {!isBalance && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Bill total (MYR)</span>
              <MoneyInput bare valueSen={billTotal ?? 0} inputClassName={styles.fieldInput} selectOnFocus aria-label="Bill total"
                onCommit={(sen) => { const t = sen != null && sen > 0 ? sen : null; setBillTotal(t); if (pct) applyPct(pct, t); }} />
            </label>
          )}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Pay now (MYR) *</span>
            <MoneyInput bare valueSen={v.amountSen} onCommit={(sen) => set({ amountSen: sen ?? 0 })} inputClassName={styles.fieldInput} selectOnFocus aria-label="Amount" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>…or %</span>
            <input className={styles.fieldInput} inputMode="decimal" value={pct} aria-label="Percent of the bill" placeholder={billTotal ? 'e.g. 50' : 'bill total first'}
              disabled={!billTotal} onChange={(e) => applyPct(e.target.value, billTotal)} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Pay by</span>
            {/* Dressed like the fields beside it — the date field's own pill stood out in the row. */}
            <DateField fullWidth value={v.dueDate ?? ''} onChange={(iso) => set({ dueDate: iso || null })} className={styles.fieldInput} aria-label="Pay by"
              style={{ background: '#fff', border: '1px solid #d6d9d2', borderRadius: 8 }} />
          </label>
        </div>
      </FormSection>

      <FormSection n={stepNo('purpose')} title="用途 · What for">
        <label className={styles.field}>
          <span className={styles.fieldLabel}>What is it for *</span>
          <textarea className={styles.fieldInput} rows={2} value={v.purpose} onChange={(e) => set({ purpose: e.target.value })} aria-label="What is it for"
            placeholder="e.g. Booth F1 rental, balance 50%" />
        </label>
        {fromRow ? (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Event — the PMS row's own</span>
            <div className={styles.fieldInput} role="note" aria-label="Event" style={{ background: 'var(--c-paper, #f4f6f3)' }}>{rowEventLabel}</div>
          </div>
        ) : hasEvents && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{eventNeeded ? 'Event * — this bill is for an event' : 'Event'}</span>
            <EventSelect value={v.projectId} around={v.dueDate || today} optionsPath={EVENTS_PATH} className={styles.fieldInput} aria-label="Event"
              onChange={(id) => set({ projectId: id })} />
          </label>
        )}
        {!fromRow && eventNeeded && billRead.state.status === 'done' && (
          <EventSuggestions suggestions={billRead.state.result.eventSuggestions} current={v.projectId} onUse={(id) => set({ projectId: id })} />
        )}
        {!fromRow && eventNeeded && v.projectId == null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={noEvent} onChange={(e) => setNoEvent(e.target.checked)} aria-label="I cannot find this event" />
              I cannot find this event · 找不到这场活动
            </label>
            {noEvent && (
              <input className={styles.fieldInput} value={noEventReason} onChange={(e) => setNoEventReason(e.target.value)} aria-label="Why there is no event"
                placeholder="Say why in a line — Finance reads it (e.g. the fair is not in PMS yet)" />
            )}
          </div>
        )}
      </FormSection>

      {/* ⑤ The requester's own words to Finance (owner 2026-10-02: 多一个第五给他们写note). */}
      <FormSection n={stepNo('note')} title="备注 · Note">
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Note to Finance (optional)</span>
          <textarea className={styles.fieldInput} rows={3} value={v.note ?? ''} onChange={(e) => set({ note: e.target.value })} aria-label="Note"
            maxLength={2000} placeholder="e.g. Please pay before the fair starts · 已跟对方讲好分两期付" />
        </label>
      </FormSection>
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--line, #ece9e2)' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        {/* Pressable while incomplete: the press says what is still missing. */}
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || reading}>
          {saving ? 'Sending…' : initial ? (initial.status === 'REJECTED' ? 'Send again' : 'Save') : 'Send to Finance'}
        </Button>
      </div>
    </div>
  );
}
