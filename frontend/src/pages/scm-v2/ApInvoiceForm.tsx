// ----------------------------------------------------------------------------
// ApInvoiceForm — the one form behind New, Edit and Copy of an AP invoice
// (owner 2026-09-06, round 3: 都可以 — Insert adds a line and lands on it,
// amounts read 1,800.00, a bill can be copied, and everything can be edited).
//
// It knows nothing about routes or modals: it takes initial values, hands
// back the payload the routes want plus the scanned pages waiting to attach,
// and the page decides whether that is a POST, a PATCH, or a re-post. The
// scan (the voucher's own OCR) is offered on New and Copy — an edit of a
// bill that exists keeps the bill's own paper.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import type { Account } from '../../vendor/scm/lib/accounting-queries';
import {
  useExtractBills, fileToBase64, PV_FILE_ACCEPT, type BillExtraction, type ExtractedBill, type VendorMemory, type PvFilePayload,
} from '../../vendor/scm/lib/payment-voucher-queries';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { BillMatchesNote } from '../../vendor/scm/components/RequestBill';
import { useBillMatches } from '../../vendor/scm/lib/payment-request-queries';
import { SupplierFinanceReminder } from '../../vendor/scm/components/SupplierFinanceReminder';
import { EventSelect } from '../../vendor/scm/components/EventSelect';
import { EventSuggestions } from '../../vendor/scm/components/EventSuggestions';
import type { EventSuggestion } from '../../vendor/scm/lib/event-queries';
import { useSaveHotkey, SAVE_HOTKEY_HINT } from '../../vendor/scm/lib/use-save-hotkey';
import { upperFill } from '../../vendor/scm/lib/ocr-fill';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { DateField } from '../../vendor/scm/components/DateField';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { fmtSen } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';

/** projectId: the event the line's money is for (owner 2026-09-30, 5a) — null = none. */
export type ApFormLine = { rid: number; description: string; debitAccountCode: string; amountSen: number; projectId: number | null };
/** officialDocOwed: booked on a proforma or quotation — the official invoice is still owed (欠正式单, item 3). */
export type ApFormValues = { supplierId: string; supplierRef: string; invoiceDate: string; dueDate: string; description: string; lines: ApFormLine[]; officialDocOwed?: boolean; officialDocNote?: string };
export type ApFormMode = 'new' | 'edit' | 'copy';
/** What the routes take — POST / for new and copy, PATCH /:id for edit. */
export type ApFormSubmit = {
  supplierId: string; supplierInvoiceRef?: string; invoiceDate: string; dueDate: string | null; notes?: string;
  lines: Array<{ description?: string; debitAccountCode: string; amountSen: number; projectId?: number }>;
  /** The 申请付款 this bill answers — set by the page, never by the form. */
  paymentRequestId?: string;
  /** 欠正式单 (item 3): sent only when ticked. */
  officialDocOwed?: boolean;
  /** Finance's remark on what to follow up (owner 2026-10-08) — with the tick only. */
  officialDocNote?: string;
};

const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
export const emptyLine = (rid: number, projectId: number | null = null): ApFormLine => ({ rid, description: '', debitAccountCode: '', amountSen: 0, projectId });
export const emptyApForm = (): ApFormValues => ({ supplierId: '', supplierRef: '', invoiceDate: myt(), dueDate: '', description: '', lines: [emptyLine(1)] });

export const toSubmit = (v: ApFormValues): ApFormSubmit => ({
  supplierId: v.supplierId,
  ...(v.supplierRef.trim() ? { supplierInvoiceRef: v.supplierRef.trim() } : {}),
  invoiceDate: v.invoiceDate,
  dueDate: v.dueDate || null,
  ...(v.description.trim() ? { notes: v.description.trim() } : {}),
  ...(v.officialDocOwed ? { officialDocOwed: true, ...(v.officialDocNote?.trim() ? { officialDocNote: v.officialDocNote.trim() } : {}) } : {}),
  lines: v.lines
    .filter((l) => l.debitAccountCode && l.amountSen > 0)
    .map((l) => ({
      ...(l.description.trim() ? { description: l.description.trim() } : {}),
      debitAccountCode: l.debitAccountCode, amountSen: l.amountSen,
      ...(l.projectId != null ? { projectId: l.projectId } : {}),
    })),
});

/* The reader's answer as form values — the supplier from the server's match,
   the bill's number and dates, its lines under the REMEMBERED account only
   (never a model guess); text the reader fills goes upper case (owner
   2026-09-08). One home: the form's own Scan bill and the pile page's
   hand-off (ApInvoices.tsx) both fill through here. */
export const formFromExtraction = (ex: BillExtraction, match: { id: string } | null, memory: VendorMemory | null): Partial<ApFormValues> => {
  const account = memory?.debitAccountCode ?? '';
  const drafts: ApFormLine[] = ex.lines
    .filter((l): l is { description: string | null; amountSen: number } => l.amountSen != null && l.amountSen > 0)
    .map((l, i) => ({ rid: i + 1, description: upperFill(l.description) ?? '', debitAccountCode: account, amountSen: l.amountSen, projectId: null }));
  /* A bill with no readable lines still carries its total — one line. */
  if (drafts.length === 0 && ex.totalSen != null && ex.totalSen > 0) {
    drafts.push({ rid: 1, description: upperFill(ex.invoiceNumber ? `Bill ${ex.invoiceNumber}` : 'As per bill') ?? '', debitAccountCode: account, amountSen: ex.totalSen, projectId: null });
  }
  return {
    ...(match ? { supplierId: match.id } : {}),
    ...(ex.invoiceNumber ? { supplierRef: upperFill(ex.invoiceNumber) ?? '' } : {}),
    ...(ex.invoiceDate ? { invoiceDate: ex.invoiceDate } : {}),
    ...(ex.dueDate ? { dueDate: ex.dueDate } : {}),
    ...(drafts.length > 0 ? { lines: drafts } : {}),
    /* A proforma or quotation owes its official invoice — pre-ticked; Finance decides. */
    ...(isProvisional(ex) ? { officialDocOwed: true } : {}),
  };
};

/** The reader read PROFORMA or QUOTATION on it (item 3). */
export const isProvisional = (ex: Pick<BillExtraction, 'documentKind'>): boolean => ex.documentKind === 'proforma' || ex.documentKind === 'quotation';

/* What the form says after a read — the same sentences whether the bill was
   picked here or handed over from the pile. */
export const scanNoteFor = (bill: { extraction: BillExtraction; supplierMatch: { name: string } | null; memory: VendorMemory | null }): string => [
  'Read — check every figure before saving.',
  bill.supplierMatch ? `Looks like supplier ${bill.supplierMatch.name}.` : 'No supplier matched the printed name — pick it yourself.',
  bill.memory?.debitAccountCode
    ? `Account ${bill.memory.debitAccountCode} filled from your last ${bill.memory.payeeName ?? 'same-vendor'} bill — check it.`
    : null,
  bill.extraction.totalSen == null ? 'The TOTAL was not readable — enter it yourself.' : null,
  bill.extraction.currency !== 'MYR' ? `The bill reads as ${bill.extraction.currency}; AP invoices are MYR — a foreign bill goes through a purchase invoice.` : null,
].filter(Boolean).join(' ');

/** A payment request answered by a bill (owner 2026-09-30, 6.1–6.2): what was
    asked — the amount, what for, the event, the pay-by date — overlaid by what
    its bill reads (the supplier, number, date and lines), every line on the
    request's event. The note says where each came from, and a bill total that
    differs from the amount asked. */
export const formFromRequest = (
  r: { request_no: string; requested_by_name: string | null; purpose: string; amount_sen: number; due_date: string | null; project_id: number | null; note?: string | null },
  bill: ExtractedBill | undefined,
  readError: string | null,
): { initial: ApFormValues; note: string; eventSuggestions: EventSuggestion[] } => {
  const who = r.requested_by_name ?? 'the requester';
  const read = bill?.ok ? formFromExtraction(bill.extraction, bill.supplierMatch, bill.memory) : {};
  const lines = (read.lines ?? [{ rid: 1, description: r.purpose.slice(0, 200), debitAccountCode: '', amountSen: r.amount_sen, projectId: null }])
    .map((l) => ({ ...l, projectId: r.project_id }));
  const initial: ApFormValues = {
    ...emptyApForm(), ...read,
    dueDate: read.dueDate ?? r.due_date ?? '',
    /* The requester's note comes along (owner 2026-10-02). */
    description: `Payment request ${r.request_no} — ${r.purpose}${r.note ? ` · Note: ${r.note}` : ''}`,
    lines,
  };
  const total = bill?.ok ? bill.extraction.totalSen : null;
  const note = [
    `Answering ${r.request_no} from ${who} — its bill is copied onto this invoice when you save.`,
    bill?.ok ? scanNoteFor(bill)
      : readError ? `Its bill could not be read (${readError}) — fill the bill in yourself.`
        : bill ? `Its bill could not be read (${bill.reason}) — fill the bill in yourself.`
          : 'It carries no bill to read — fill the bill in yourself.',
    total != null && total !== r.amount_sen ? `The bill reads ${fmtSen(total)} but ${who} asked for ${fmtSen(r.amount_sen)} — check which is right.` : null,
  ].filter(Boolean).join(' ');
  return { initial, note, eventSuggestions: r.project_id == null && bill?.ok ? (bill.eventSuggestions ?? []) : [] };
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const th: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em',
  textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle' };
const right: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)' };
const iconBtn: React.CSSProperties = { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2 };

export const ApInvoiceForm = ({
  mode, initial, suppliers, suppliersLoading = false, lineAccounts, posted = false, paidSen = 0, saving, onSubmit, onCancel,
  initialFiles, initialNote, initialEventSuggestions, selfId = null, requestId = null,
}: {
  mode: ApFormMode;
  initial: ApFormValues;
  /** The bill being edited, and the 申请付款 it answers — never their own
      "same bill" (owner 2026-10-05: 提醒也加 — a warning, never a block). */
  selfId?: string | null;
  requestId?: string | null;
  suppliers: Array<{ id: string; code: string; name: string }>;
  suppliersLoading?: boolean;
  lineAccounts: Account[];
  /** A bill handed over from the pile page: its read pages, waiting to attach
      on save, and the reader's sentence about it. */
  initialFiles?: PvFilePayload[];
  initialNote?: string | null;
  /** The events the handed-over bill points at (owner 2026-09-30, 6a — suggestions only). */
  initialEventSuggestions?: EventSuggestion[];
  /** Editing a bill already on the books: saving re-posts, and money paid
      caps the total and pins the supplier — the same rules the route holds. */
  posted?: boolean;
  paidSen?: number;
  saving: boolean;
  onSubmit: (values: ApFormSubmit, pendingFiles: PvFilePayload[]) => void | Promise<void>;
  onCancel: () => void;
}) => {
  const [v, setV] = useState<ApFormValues>(initial);
  const set = (patch: Partial<ApFormValues>) => setV((prev) => ({ ...prev, ...patch }));
  const patchLine = (rid: number, patch: Partial<ApFormLine>) =>
    setV((prev) => ({ ...prev, lines: prev.lines.map((l) => (l.rid === rid ? { ...l, ...patch } : l)) }));
  const nextRid = (lines: ApFormLine[]) => Math.max(0, ...lines.map((x) => x.rid)) + 1;
  /* 5a's header default: the lines' shared event, when they all name one — the
     "all lines" picker shows it, and a line added takes it. */
  const commonEvent = v.lines.length > 0 && v.lines.every((l) => l.projectId === v.lines[0]!.projectId) ? v.lines[0]!.projectId : null;

  /* Insert adds a line and LANDS on it (owner: 按 Ins 直接加然后直接跳到那一行);
     Enter on an amount hops to the next line's account, adding one when
     there is none. The landing happens after React has drawn the row. */
  const tableRef = useRef<HTMLTableElement>(null);
  const [landOn, setLandOn] = useState<number | null>(null);
  useEffect(() => {
    if (landOn == null) return;
    const el = tableRef.current?.querySelector<HTMLInputElement>(`tr[data-line="${landOn}"] input[role="combobox"]`);
    el?.focus();
    setLandOn(null);
  }, [landOn, v.lines]);
  const addLine = (land: boolean) => {
    setV((prev) => {
      const rid = nextRid(prev.lines);
      if (land) setLandOn(rid);
      const shared = prev.lines.length > 0 && prev.lines.every((l) => l.projectId === prev.lines[0]!.projectId) ? prev.lines[0]!.projectId : null;
      return { ...prev, lines: [...prev.lines, emptyLine(rid, shared)] };
    });
  };
  const removeLine = (rid: number) => setV((prev) => (prev.lines.length > 1 ? { ...prev, lines: prev.lines.filter((l) => l.rid !== rid) } : prev));
  const hopFrom = (rid: number) => {
    const i = v.lines.findIndex((l) => l.rid === rid);
    const next = v.lines.at(i + 1);
    if (next) setLandOn(next.rid); else addLine(true);
  };

  /* The same bill — its printed number AND date — already asked for, vouchered
     or entered (lib/bill-matches.ts). Said under the bill's own fields. */
  const sameBill = useBillMatches(v.supplierRef, v.invoiceDate, requestId, selfId);

  const total = v.lines.reduce((s, l) => s + (l.amountSen > 0 ? l.amountSen : 0), 0);
  const belowPaid = posted && total < paidSen;
  const supplierLocked = posted && paidSen > 0;
  const ready = !!v.supplierId && !!v.invoiceDate && total > 0 && !belowPaid
    && v.lines.filter((l) => l.amountSen > 0).every((l) => !!l.debitAccountCode);

  /* ── Scan bill (OCR) — the voucher's reader fills THIS form: the supplier
     from the server's match, the bill's own number, its dates and lines; the
     account ONLY from vendor memory, never a model guess. MULTI-SELECT MEANS
     ONE BILL (its pages); the read pages attach after save. */
  const extract = useExtractBills();
  const [scanNote, setScanNote] = useState<string | null>(initialNote ?? null);
  const [pendingFiles, setPendingFiles] = useState<PvFilePayload[]>(initialFiles ?? []);
  const [eventSuggestions, setEventSuggestions] = useState<EventSuggestion[]>(initialEventSuggestions ?? []);
  /* 拖进来 upload (owner 2026-09-08): the scan row takes a dropped bill too. */
  const [dragOver, setDragOver] = useState(false);
  /* F3 / Ctrl+S = the save button (owner 2026-09-08: 像 autocount 按 f3);
     a form that is not ready ignores it, as the button would. */
  useSaveHotkey(() => { if (ready) void onSubmit(toSubmit(v), pendingFiles); }, !saving);
  const applyExtraction = (ex: BillExtraction, match: { id: string } | null, memory: VendorMemory | null) => {
    setV((prev) => ({ ...prev, ...formFromExtraction(ex, match, memory) }));
  };
  const onScanFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setScanNote('Reading the bill…');
    try {
      const files = await Promise.all([...list].map(async (f) => ({ name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) })));
      const res = await extract.mutateAsync([{ files }]);
      const bill = res.bills.at(0);
      if (!bill) { setScanNote('The bill could not be read.'); return; }
      if (!bill.ok) { setScanNote(bill.reason); return; }
      applyExtraction(bill.extraction, bill.supplierMatch, bill.memory);
      setEventSuggestions(bill.eventSuggestions ?? []);
      /* The LAST successful read wins, matching applyExtraction overwriting
         the lines — this form reads ONE bill at a time. */
      setPendingFiles(files);
      setScanNote(scanNoteFor(bill));
    } catch (e) {
      setScanNote(e instanceof Error ? e.message : 'The bill could not be read.');
    }
  };

  const saveLabel = mode === 'edit' ? (posted ? 'Save & re-post' : 'Save changes') : 'Save as draft';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
      {mode !== 'edit' && (
        <div
          aria-label="Drop the bill here"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => { setDragOver(false); }}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!extract.isPending) void onScanFiles(e.dataTransfer.files); }}
          style={{
            display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap',
            padding: '6px 8px', borderRadius: 6, border: `1px dashed ${dragOver ? 'var(--c-orange)' : 'var(--border-weak, #e3e1da)'}`,
          }}>
          {/* Scan bill — pick the bill's page(s); MULTI-SELECT = ONE BILL. A
              pile of bills goes through the pile page ("Scan bills" on the
              list), one AP invoice each. */}
          <label style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
            📷 {extract.isPending ? 'Reading…' : 'Scan bill (OCR)'}
            <input type="file" multiple accept={PV_FILE_ACCEPT} aria-label="Scan bill files" style={{ display: 'none' }}
              disabled={extract.isPending}
              onChange={(e) => { void onScanFiles(e.target.files); e.target.value = ''; }} />
          </label>
          <span style={soft}>or drag the bill here</span>
          {scanNote && (
            <span style={{ fontSize: 'var(--fs-12)', color: extract.isPending ? 'var(--fg-muted)' : 'var(--c-orange)' }}>{scanNote}</span>
          )}
          {pendingFiles.length > 0 && (
            <span style={soft}>📎 {pendingFiles.length} scanned file(s) will be attached to this bill on save: {pendingFiles.map((f) => f.name).join(', ')}</span>
          )}
        </div>
      )}
      {posted && (
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)' }}>
          This bill is on the books — saving re-posts it: the old journal gets a contra, a fresh one books what you save.
          {paidSen > 0 ? ` ${fmtSen(paidSen)} is already paid against it, so the total cannot fall below that and the supplier stays.` : ''}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 2fr) minmax(170px, 1fr) minmax(150px, 1fr) minmax(150px, 1fr)', gap: 'var(--space-3)' }}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Supplier *</span>
          <SearchCombo
            options={sortByText(suppliers).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))}
            value={v.supplierId} onChange={(id) => set({ supplierId: id })} aria-label="AP invoice supplier" className={styles.fieldInput}
            disabled={supplierLocked}
            placeholder={suppliersLoading ? 'Loading suppliers…' : 'Type to find the supplier'} />
          <SupplierFinanceReminder supplierId={v.supplierId} />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Supplier's invoice no.</span>
          <input className={styles.fieldInput} value={v.supplierRef} onChange={(e) => set({ supplierRef: e.target.value })} aria-label="Supplier invoice ref" placeholder="As printed on the bill" />
        </label>
        {/* 欠正式单 (item 3): a new bill booked on a proforma; an existing one is marked from its detail. */}
        {mode !== 'edit' && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', alignSelf: 'end' }}>
            <input type="checkbox" checked={!!v.officialDocOwed} onChange={(e) => set({ officialDocOwed: e.target.checked })} aria-label="Official invoice owed" />
            Proforma / quotation — official invoice owed · 欠正式单
          </label>
        )}
        {mode !== 'edit' && v.officialDocOwed && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Remark — what to follow up (optional)</span>
            <input className={styles.fieldInput} value={v.officialDocNote ?? ''} onChange={(e) => set({ officialDocNote: e.target.value })} maxLength={500}
              aria-label="Official invoice remark" placeholder="e.g. Proforma only — ask for the tax invoice" />
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Invoice date *</span>
          <DateField fullWidth className={styles.fieldInput} value={v.invoiceDate} onChange={(iso) => set({ invoiceDate: iso })} aria-label="AP invoice date" />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Due date</span>
          <DateField fullWidth className={styles.fieldInput} value={v.dueDate} onChange={(iso) => set({ dueDate: iso })} aria-label="AP invoice due date" />
        </label>
      </div>
      <BillMatchesNote matches={sameBill.data?.matches} />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Description</span>
        <input className={styles.fieldInput} value={v.description} onChange={(e) => set({ description: e.target.value })} aria-label="AP invoice description"
          placeholder="What this bill is for — shows on the list and prints on the listing" />
      </label>

      {/* The event this bill is for (owner 2026-09-30, 5a) — sets every line; a
          line can still name its own in the table. */}
      <label className={styles.field} style={{ maxWidth: 640 }}>
        <span className={styles.fieldLabel}>Event (all lines)</span>
        <EventSelect value={commonEvent} around={v.invoiceDate || null} className={styles.fieldInput} aria-label="Event for all lines"
          onChange={(id) => setV((prev) => ({ ...prev, lines: prev.lines.map((l) => ({ ...l, projectId: id })) }))} />
      </label>
      <EventSuggestions suggestions={eventSuggestions} current={commonEvent}
        onUse={(id) => setV((prev) => ({ ...prev, lines: prev.lines.map((l) => ({ ...l, projectId: id })) }))} />

      {/* The lines, in the owner's order: account number, description, amount.
          Insert anywhere in the table adds a line and lands on it. */}
      <table ref={tableRef} style={{ width: '100%', borderCollapse: 'collapse' }}
        onKeyDown={(e) => { if (e.key === 'Insert') { e.preventDefault(); addLine(true); } }}>
        <thead>
          <tr>
            <th style={{ ...th, width: '34%' }}>Account</th>
            <th style={th}>Description</th>
            <th style={{ ...th, textAlign: 'right', width: 150 }}>Amount (RM)</th>
            <th style={{ ...th, width: '24%' }}>Event</th>
            <th style={{ ...th, width: 36 }} />
          </tr>
        </thead>
        <tbody>
          {v.lines.map((l) => (
            <tr key={l.rid} data-line={l.rid}>
              <td style={td}>
                <AccountSelect accounts={lineAccounts} value={l.debitAccountCode} className={styles.fieldInput}
                  onChange={(code) => patchLine(l.rid, { debitAccountCode: code })} placeholder="— account this line charges —" />
              </td>
              <td style={td}>
                <input className={styles.fieldInput} style={{ width: '100%' }} placeholder="Description" value={l.description} aria-label={`line ${l.rid} description`}
                  onChange={(e) => patchLine(l.rid, { description: e.target.value })} />
              </td>
              <td style={td}>
                <MoneyInput bare valueSen={l.amountSen} inputClassName={styles.fieldInput} selectOnFocus aria-label={`line ${l.rid} amount`}
                  placeholder="0.00" style={{ width: '100%' }}
                  onCommit={(sen) => patchLine(l.rid, { amountSen: sen ?? 0 })}
                  onKeyDown={(e) => { if (e.key === 'Enter') hopFrom(l.rid); }} />
              </td>
              {/* The event last: the owner's typing order (account, description,
                  amount) stays unbroken; the header's picker usually sets it. */}
              <td style={td}>
                <EventSelect value={l.projectId} around={v.invoiceDate || null} className={styles.fieldInput} aria-label={`line ${l.rid} event`}
                  onChange={(id) => patchLine(l.rid, { projectId: id })} />
              </td>
              <td style={td}>
                {v.lines.length > 1 && (
                  <button type="button" aria-label={`remove line ${l.rid}`} onClick={() => removeLine(l.rid)} style={iconBtn}>
                    <X size={14} strokeWidth={1.75} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
            <td colSpan={2} style={td}>
              <AddLineButton variant="ghost" onClick={() => addLine(true)} />
              <span style={{ ...soft, marginLeft: 'var(--space-3)' }}>Insert adds a line · Enter on an amount moves down</span>
            </td>
            <td style={{ ...td, ...right, fontWeight: 700, color: belowPaid ? 'var(--c-festive-b, #B8331F)' : undefined }}>Total {fmtSen(total)}</td>
            <td />
            <td />
          </tr>
        </tfoot>
      </table>

      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', alignItems: 'center' }}>
        {belowPaid && <span style={{ fontSize: 'var(--fs-12)', color: 'var(--c-festive-b, #B8331F)' }}>The total cannot fall below the {fmtSen(paidSen)} already paid.</span>}
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{SAVE_HOTKEY_HINT}</span>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void onSubmit(toSubmit(v), pendingFiles)} disabled={saving || !ready}>
          {saving ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </div>
  );
};
