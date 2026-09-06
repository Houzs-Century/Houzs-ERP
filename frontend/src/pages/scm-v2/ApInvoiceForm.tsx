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
import { Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import type { Account } from '../../vendor/scm/lib/accounting-queries';
import {
  useExtractBills, fileToBase64, PV_FILE_ACCEPT, type BillExtraction, type VendorMemory, type PvFilePayload,
} from '../../vendor/scm/lib/payment-voucher-queries';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { DateField } from '../../vendor/scm/components/DateField';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { sortByText } from '../../vendor/scm/lib/sort-options';
import { fmtSen } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';

export type ApFormLine = { rid: number; description: string; debitAccountCode: string; amountSen: number };
export type ApFormValues = { supplierId: string; supplierRef: string; invoiceDate: string; dueDate: string; description: string; lines: ApFormLine[] };
export type ApFormMode = 'new' | 'edit' | 'copy';
/** What the routes take — POST / for new and copy, PATCH /:id for edit. */
export type ApFormSubmit = {
  supplierId: string; supplierInvoiceRef?: string; invoiceDate: string; dueDate: string | null; notes?: string;
  lines: Array<{ description?: string; debitAccountCode: string; amountSen: number }>;
};

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
export const emptyLine = (rid: number): ApFormLine => ({ rid, description: '', debitAccountCode: '', amountSen: 0 });
export const emptyApForm = (): ApFormValues => ({ supplierId: '', supplierRef: '', invoiceDate: myt(), dueDate: '', description: '', lines: [emptyLine(1)] });

export const toSubmit = (v: ApFormValues): ApFormSubmit => ({
  supplierId: v.supplierId,
  ...(v.supplierRef.trim() ? { supplierInvoiceRef: v.supplierRef.trim() } : {}),
  invoiceDate: v.invoiceDate,
  dueDate: v.dueDate || null,
  ...(v.description.trim() ? { notes: v.description.trim() } : {}),
  lines: v.lines
    .filter((l) => l.debitAccountCode && l.amountSen > 0)
    .map((l) => ({ ...(l.description.trim() ? { description: l.description.trim() } : {}), debitAccountCode: l.debitAccountCode, amountSen: l.amountSen })),
});

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
}: {
  mode: ApFormMode;
  initial: ApFormValues;
  suppliers: Array<{ id: string; code: string; name: string }>;
  suppliersLoading?: boolean;
  lineAccounts: Account[];
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
      return { ...prev, lines: [...prev.lines, emptyLine(rid)] };
    });
  };
  const removeLine = (rid: number) => setV((prev) => (prev.lines.length > 1 ? { ...prev, lines: prev.lines.filter((l) => l.rid !== rid) } : prev));
  const hopFrom = (rid: number) => {
    const i = v.lines.findIndex((l) => l.rid === rid);
    const next = v.lines.at(i + 1);
    if (next) setLandOn(next.rid); else addLine(true);
  };

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
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PvFilePayload[]>([]);
  const applyExtraction = (ex: BillExtraction, match: { id: string } | null, memory: VendorMemory | null) => {
    const account = memory?.debitAccountCode ?? '';
    const drafts: ApFormLine[] = ex.lines
      .filter((l): l is { description: string | null; amountSen: number } => l.amountSen != null && l.amountSen > 0)
      .map((l, i) => ({ rid: i + 1, description: l.description ?? '', debitAccountCode: account, amountSen: l.amountSen }));
    /* A bill with no readable lines still carries its total — one line. */
    if (drafts.length === 0 && ex.totalSen != null && ex.totalSen > 0) {
      drafts.push({ rid: 1, description: ex.invoiceNumber ? `Bill ${ex.invoiceNumber}` : 'As per bill', debitAccountCode: account, amountSen: ex.totalSen });
    }
    setV((prev) => ({
      ...prev,
      ...(match ? { supplierId: match.id } : {}),
      ...(ex.invoiceNumber ? { supplierRef: ex.invoiceNumber } : {}),
      ...(ex.invoiceDate ? { invoiceDate: ex.invoiceDate } : {}),
      ...(ex.dueDate ? { dueDate: ex.dueDate } : {}),
      ...(drafts.length > 0 ? { lines: drafts } : {}),
    }));
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
      /* The LAST successful read wins, matching applyExtraction overwriting
         the lines — this form reads ONE bill at a time. */
      setPendingFiles(files);
      setScanNote([
        'Read — check every figure before saving.',
        bill.supplierMatch ? `Looks like supplier ${bill.supplierMatch.name}.` : 'No supplier matched the printed name — pick it yourself.',
        bill.memory?.debitAccountCode
          ? `Account ${bill.memory.debitAccountCode} filled from your last ${bill.memory.payeeName ?? 'same-vendor'} bill — check it.`
          : null,
        bill.extraction.totalSen == null ? 'The TOTAL was not readable — enter it yourself.' : null,
        bill.extraction.currency !== 'MYR' ? `The bill reads as ${bill.extraction.currency}; AP invoices are MYR — a foreign bill goes through a purchase invoice.` : null,
      ].filter(Boolean).join(' '));
    } catch (e) {
      setScanNote(e instanceof Error ? e.message : 'The bill could not be read.');
    }
  };

  const saveLabel = mode === 'edit' ? (posted ? 'Save & re-post' : 'Save changes') : 'Save as draft';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
      {mode !== 'edit' && (
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Scan bill — pick the bill's page(s); MULTI-SELECT = ONE BILL. */}
          <label style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)', cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
            📷 {extract.isPending ? 'Reading…' : 'Scan bill (OCR)'}
            <input type="file" multiple accept={PV_FILE_ACCEPT} aria-label="Scan bill files" style={{ display: 'none' }}
              disabled={extract.isPending}
              onChange={(e) => { void onScanFiles(e.target.files); e.target.value = ''; }} />
          </label>
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
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Supplier's invoice no.</span>
          <input className={styles.fieldInput} value={v.supplierRef} onChange={(e) => set({ supplierRef: e.target.value })} aria-label="Supplier invoice ref" placeholder="As printed on the bill" />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Invoice date *</span>
          <DateField fullWidth className={styles.fieldInput} value={v.invoiceDate} onChange={(iso) => set({ invoiceDate: iso })} aria-label="AP invoice date" />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Due date</span>
          <DateField fullWidth className={styles.fieldInput} value={v.dueDate} onChange={(iso) => set({ dueDate: iso })} aria-label="AP invoice due date" />
        </label>
      </div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Description</span>
        <input className={styles.fieldInput} value={v.description} onChange={(e) => set({ description: e.target.value })} aria-label="AP invoice description"
          placeholder="What this bill is for — shows on the list and prints on the listing" />
      </label>

      {/* The lines, in the owner's order: account number, description, amount.
          Insert anywhere in the table adds a line and lands on it. */}
      <table ref={tableRef} style={{ width: '100%', borderCollapse: 'collapse' }}
        onKeyDown={(e) => { if (e.key === 'Insert') { e.preventDefault(); addLine(true); } }}>
        <thead>
          <tr>
            <th style={{ ...th, width: '34%' }}>Account</th>
            <th style={th}>Description</th>
            <th style={{ ...th, textAlign: 'right', width: 150 }}>Amount (RM)</th>
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
              <Button variant="ghost" size="sm" onClick={() => addLine(true)}><Plus {...ICON} /> Line</Button>
              <span style={{ ...soft, marginLeft: 'var(--space-3)' }}>Insert adds a line · Enter on an amount moves down</span>
            </td>
            <td style={{ ...td, ...right, fontWeight: 700, color: belowPaid ? 'var(--c-festive-b, #B8331F)' : undefined }}>Total {fmtSen(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>

      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', alignItems: 'center' }}>
        {belowPaid && <span style={{ fontSize: 'var(--fs-12)', color: 'var(--c-festive-b, #B8331F)' }}>The total cannot fall below the {fmtSen(paidSen)} already paid.</span>}
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void onSubmit(toSubmit(v), pendingFiles)} disabled={saving || !ready}>
          {saving ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </div>
  );
};
