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
import { aiReadStageNote } from '../../vendor/scm/lib/ai-read-job';
import { useExtractBills, fileToBase64, PV_FILE_ACCEPT, type BillExtraction, type ExtractedBill, type VendorMemory, type PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { docFileMime } from '../../vendor/scm/lib/doc-file-mime';
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
import { useColumnWidths, type ColumnWidthSpec } from './finance/useColumnWidths';
import styles from './SalesOrderDetail.module.css';
import grid from './ApInvoiceForm.module.css';

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
/** The due date a supplier's terms give a bill (the redesign): "30 Days" or
    "Net 30" → the invoice date + 30; C.O.D., blank or anything unreadable →
    none, and the due date is typed. */
export const dueFromTerms = (terms: string | null | undefined, invoiceDate: string): string | null => {
  const m = /(\d{1,3})\s*days?\b/i.exec(terms ?? '') ?? /\bnet\s*(\d{1,3})\b/i.exec(terms ?? '');
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) return null;
  const d = new Date(`${invoiceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(m[1]));
  return d.toISOString().slice(0, 10);
};

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

export const formFromExtraction = (ex: BillExtraction, match: { id: string } | null, memory: VendorMemory | null): Partial<ApFormValues> => {
  const account = memory?.debitAccountCode ?? '';
  const drafts: ApFormLine[] = ex.lines
    .filter((l): l is { description: string | null; amountSen: number } => l.amountSen != null && l.amountSen > 0)
    .map((l, i) => ({ rid: i + 1, description: upperFill(l.description) ?? '', debitAccountCode: account, amountSen: l.amountSen, projectId: null }));
  if (drafts.length === 0 && ex.totalSen != null && ex.totalSen > 0) {
    drafts.push({ rid: 1, description: upperFill(ex.invoiceNumber ? `Bill ${ex.invoiceNumber}` : 'As per bill') ?? '', debitAccountCode: account, amountSen: ex.totalSen, projectId: null });
  }
  return {
    ...(match ? { supplierId: match.id } : {}),
    ...(ex.invoiceNumber ? { supplierRef: upperFill(ex.invoiceNumber) ?? '' } : {}),
    ...(ex.invoiceDate ? { invoiceDate: ex.invoiceDate } : {}),
    ...(ex.dueDate ? { dueDate: ex.dueDate } : {}),
    ...(drafts.length > 0 ? { lines: drafts } : {}),
    ...(isProvisional(ex) ? { officialDocOwed: true } : {}),
  };
};

/** The reader read PROFORMA or QUOTATION on it (item 3). */
export const isProvisional = (ex: Pick<BillExtraction, 'documentKind'>): boolean => ex.documentKind === 'proforma' || ex.documentKind === 'quotation';

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
const iconBtn: React.CSSProperties = { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--fg-muted)', padding: 2 };

/* The lines' columns in the owner's order, and the tracks they open at (owner
   2026-11-16: 这里的gap 可以给我自己调吗 — the account was wide while the
   description and the event were cut). Account and Description are shares of
   the form so a drag moves only the edge being dragged; the Event takes the
   rest. Each person's drag is kept in this browser (fin-ap-cw) until "Reset
   column widths". The last track is the remove button's. */
const LINE_COLUMNS = ['Account', 'Description', 'Amount (RM)', 'Event'] as const;
const LINE_WIDTHS: ColumnWidthSpec = {
  defaults: ['minmax(160px,24%)', 'minmax(160px,30%)', '130px', 'minmax(160px,1fr)', '24px'],
  min: [120, 120, 100, 120, 24],
  gap: 12,
};

export const ApInvoiceForm = ({
  mode, initial, suppliers, suppliersLoading = false, lineAccounts, posted = false, paidSen = 0, saving, onSubmit, onCancel,
  initialFiles, initialNote, initialEventSuggestions, selfId = null, requestId = null, canPost = false,
}: {
  mode: ApFormMode;
  initial: ApFormValues;
  /** The bill being edited, and the 申请付款 it answers — never their own
      "same bill" (owner 2026-10-05: 提醒也加 — a warning, never a block). */
  selfId?: string | null;
  requestId?: string | null;
  suppliers: Array<{ id: string; code: string; name: string; payment_terms?: string | null }>;
  canPost?: boolean;
  suppliersLoading?: boolean;
  lineAccounts: Account[];
  initialFiles?: PvFilePayload[];
  initialNote?: string | null;
  /** The events the handed-over bill points at (owner 2026-09-30, 6a — suggestions only). */
  initialEventSuggestions?: EventSuggestion[];
  posted?: boolean;
  paidSen?: number;
  saving: boolean;
  onSubmit: (values: ApFormSubmit, pendingFiles: PvFilePayload[], opts?: { post?: boolean }) => void | Promise<void>;
  onCancel: () => void;
}) => {
  const [v, setV] = useState<ApFormValues>(initial);
  const set = (patch: Partial<ApFormValues>) => setV((prev) => ({ ...prev, ...patch }));
  const patchLine = (rid: number, patch: Partial<ApFormLine>) =>
    setV((prev) => ({ ...prev, lines: prev.lines.map((l) => (l.rid === rid ? { ...l, ...patch } : l)) }));
  const nextRid = (lines: ApFormLine[]) => Math.max(0, ...lines.map((x) => x.rid)) + 1;
  const commonEvent = v.lines.length > 0 && v.lines.every((l) => l.projectId === v.lines[0]!.projectId) ? v.lines[0]!.projectId : null;

  /* Insert adds a line and LANDS on it (owner: 按 Ins 直接加然后直接跳到那一行);
     Enter on an amount hops to the next line's account, adding one when
     there is none. The landing happens after React has drawn the row. */
  const linesRef = useRef<HTMLDivElement>(null);
  const cw = useColumnWidths('ap', LINE_WIDTHS);
  const [landOn, setLandOn] = useState<number | null>(null);
  useEffect(() => {
    if (landOn == null) return;
    const el = linesRef.current?.querySelector<HTMLInputElement>(`[data-line="${landOn}"] input[role="combobox"]`);
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

  const sameBill = useBillMatches(v.supplierRef, v.invoiceDate, requestId, selfId);

  const [dueAuto, setDueAuto] = useState(false);
  const terms = suppliers.find((s) => s.id === v.supplierId)?.payment_terms ?? null;
  useEffect(() => {
    if (v.dueDate && !dueAuto) return;
    const due = dueFromTerms(terms, v.invoiceDate);
    if (due && due !== v.dueDate) { setV((prev) => ({ ...prev, dueDate: due })); setDueAuto(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms, v.invoiceDate]);

  const total = v.lines.reduce((s, l) => s + (l.amountSen > 0 ? l.amountSen : 0), 0);
  const belowPaid = posted && total < paidSen;
  const supplierLocked = posted && paidSen > 0;
  const ready = !!v.supplierId && !!v.invoiceDate && total > 0 && !belowPaid
    && v.lines.filter((l) => l.amountSen > 0).every((l) => !!l.debitAccountCode);

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
      const files = await Promise.all([...list].map(async (f) => ({ name: f.name, mime: docFileMime(f), dataBase64: await fileToBase64(f) })));
      const res = await extract.mutateAsync({ bills: [{ files }], onStage: (_i, stage) => { setScanNote(aiReadStageNote(stage, 'the bill')); } });
      const bill = res.bills.at(0);
      if (!bill) { setScanNote('The bill could not be read.'); return; }
      if (!bill.ok) { setScanNote(bill.reason); return; }
      applyExtraction(bill.extraction, bill.supplierMatch, bill.memory);
      setEventSuggestions(bill.eventSuggestions ?? []);
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
            Proforma / quotation — official invoice owed
          </label>
        )}
        {mode !== 'edit' && v.officialDocOwed && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Remark — what to follow up (optional)</span>
            <input data-upper className={styles.fieldInput} value={v.officialDocNote ?? ''} onChange={(e) => set({ officialDocNote: e.target.value })} maxLength={500}
              aria-label="Official invoice remark" placeholder="e.g. Proforma only — ask for the tax invoice" />
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Invoice date *</span>
          <DateField fullWidth className={styles.fieldInput} value={v.invoiceDate} onChange={(iso) => set({ invoiceDate: iso })} aria-label="AP invoice date" />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Due date</span>
          <DateField fullWidth className={styles.fieldInput} value={v.dueDate} onChange={(iso) => { setDueAuto(false); set({ dueDate: iso }); }} aria-label="AP invoice due date" />
          {dueAuto && terms && <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginTop: 2 }}>From the supplier's terms ({terms}).</span>}
        </label>
      </div>
      <BillMatchesNote matches={sameBill.data?.matches} />
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Description</span>
        <input data-upper className={styles.fieldInput} value={v.description} onChange={(e) => set({ description: e.target.value })} aria-label="AP invoice description"
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

      <div className={grid.scroll}>
        <div ref={linesRef} role="table" aria-label="Bill lines" data-cw-root="ap" style={{ minWidth: cw.minWidth }}
          onKeyDown={(e) => { if (e.key === 'Insert') { e.preventDefault(); addLine(true); } }}>
          <div role="row" data-cw-row="" className={`${grid.row} ${grid.head}`} style={{ gridTemplateColumns: cw.template }}>
            {LINE_COLUMNS.map((label, i) => (
              <span key={label} role="columnheader" data-cw-cell={i} className={grid.headCell} style={i === 2 ? { textAlign: 'right' } : undefined}>
                <span data-cw-lbl="" className={grid.headLabel}>{label}</span>
                <span className={grid.resize} {...cw.handle(i)}><span className={grid.resizeLine} /></span>
              </span>
            ))}
            <span role="columnheader" />
          </div>
          {v.lines.map((l) => (
            <div key={l.rid} role="row" data-cw-row="" data-line={l.rid} className={grid.row} style={{ gridTemplateColumns: cw.template }}>
              <div role="cell">
                <AccountSelect accounts={lineAccounts} value={l.debitAccountCode} className={styles.fieldInput}
                  onChange={(code) => patchLine(l.rid, { debitAccountCode: code })} placeholder="— account this line charges —" />
              </div>
              <div role="cell">
                <input data-upper className={styles.fieldInput} style={{ width: '100%' }} placeholder="Description" value={l.description} aria-label={`line ${l.rid} description`}
                  title={l.description ? l.description.toUpperCase() : undefined}
                  onChange={(e) => patchLine(l.rid, { description: e.target.value })} />
              </div>
              <div role="cell">
                <MoneyInput bare valueSen={l.amountSen} inputClassName={styles.fieldInput} selectOnFocus aria-label={`line ${l.rid} amount`}
                  placeholder="0.00" style={{ width: '100%' }} title={l.amountSen > 0 ? fmtSen(l.amountSen) : undefined}
                  onCommit={(sen) => patchLine(l.rid, { amountSen: sen ?? 0 })}
                  onKeyDown={(e) => { if (e.key === 'Enter') hopFrom(l.rid); }} />
              </div>
              <div role="cell">
                <EventSelect value={l.projectId} around={v.invoiceDate || null} className={styles.fieldInput} aria-label={`line ${l.rid} event`}
                  onChange={(id) => patchLine(l.rid, { projectId: id })} />
              </div>
              <div role="cell">
                {v.lines.length > 1 && (
                  <button type="button" aria-label={`remove line ${l.rid}`} onClick={() => removeLine(l.rid)} style={iconBtn}>
                    <X size={14} strokeWidth={1.75} />
                  </button>
                )}
              </div>
            </div>
          ))}
          <div role="row" data-cw-row="" className={`${grid.row} ${grid.foot}`} style={{ gridTemplateColumns: cw.template }}>
            <div role="cell" style={{ gridColumn: 'span 2' }}>
              <AddLineButton variant="ghost" onClick={() => addLine(true)} />
              <span style={{ ...soft, marginLeft: 'var(--space-3)' }}>Insert adds a line · Enter on an amount moves down</span>
            </div>
            <div role="cell" className={grid.total} style={belowPaid ? { color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' } : undefined}>Total {fmtSen(total)}</div>
          </div>
        </div>
      </div>
      {cw.custom && (
        <div className={grid.resetRow}>
          <button type="button" className={grid.resetLink} onClick={cw.reset}>Reset column widths</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', alignItems: 'center' }}>
        {belowPaid && <span style={{ fontSize: 'var(--fs-12)', color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))' }}>The total cannot fall below the {fmtSen(paidSen)} already paid.</span>}
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>{SAVE_HOTKEY_HINT}</span>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant={canPost && mode !== 'edit' ? 'secondary' : 'primary'} size="sm" onClick={() => void onSubmit(toSubmit(v), pendingFiles)} disabled={saving || !ready}>
          {saving ? 'Saving…' : saveLabel}
        </Button>
        {canPost && mode !== 'edit' && (
          <Button variant="primary" size="sm" onClick={() => void onSubmit(toSubmit(v), pendingFiles, { post: true })} disabled={saving || !ready}>
            Save & post
          </Button>
        )}
      </div>
    </div>
  );
};
