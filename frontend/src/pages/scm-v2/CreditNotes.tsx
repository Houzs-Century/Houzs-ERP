// ----------------------------------------------------------------------------
// CreditNotes — /scm/credit-notes (owner 2026-09-05: CN/DN approved; 2026-09-12:
// 这个要做). One page for the three notes: CN to a customer (they owe less),
// DN to a customer (they owe more), SCN from a supplier (we owe less). A note
// is raised as a DRAFT — the customer from the sales order or the invoice it
// answers, or the name typed; the supplier picked — with lines that land on
// RETURN INWARDS / PURCHASES RETURN unless the line says otherwise, then
// posted through the one gate, or cancelled (contra). The server refuses
// what it refuses; this page only shows the reason.
//
// Scan supplier CN (owner 2026-10-01: supplier 给我 cn，我要做 ocr for cn；这个 cn
// 可能会 link 去相对应的 supplier invoice): the credit note is read, the New note
// form opens filled — supplier, CN number, date, reason, each line on its account
// (rebate and sponsorship 591-0000, a discount 610-0001) with the printed SST
// spread in, and the purchase invoice it credits — and Finance saves it; the
// scanned pages attach to the saved note.
//
// Knock off (owner 2026-10-02: CN 的方式应该是类似 ap payment 这样 knock off；扣错了
// 就我 untick 会 knock off 的 invoice 就行了): a supplier note picks the invoices its
// credit comes off on the AP Payment's own table (CreditNoteKnockOff.tsx) — on the
// form as the plan the post carries out, on a posted note to change at any time.
// ----------------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import { PageHeader } from '../../components/Layout';
import { DataTable, type Column } from '../../components/DataTable';
import { Modal } from '../../vendor/scm/components/Modal';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { DateField } from '../../vendor/scm/components/DateField';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { useAccounts, leafAccounts } from '../../vendor/scm/lib/accounting-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import {
  useCreditNotes, useCreditNoteDetail, useCreateCreditNote, useUpdateCreditNote, usePostCreditNote, useCancelCreditNote,
  useScanSupplierCreditNote, useCreditNoteFiles, useUploadCreditNoteFile, useDeleteCreditNoteFile, fetchCreditNoteFileBlobUrl,
  type CreditAllocation, type CreditNote, type CreditNoteLine, type CreditNoteLineInput, type KnockOffTarget, type NoteKind, type NoteStatus, type ScnScan,
} from '../../vendor/scm/lib/credit-note-queries';
import { FormKnockOff, NoteKnockOff, pickSen, pickTargets, type KnockOffPick } from './CreditNoteKnockOff';
import { fileToBase64, PV_FILE_ACCEPT, type PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { DocFilesCard } from '../../vendor/scm/components/DocFilesCard';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';

const KIND_WORD: Record<NoteKind, string> = { CN: 'Credit note', DN: 'Debit note', SCN: 'Supplier credit note' };
/* The kind filter's tabs, off the one label map — not a second list of kinds. */
const KIND_TABS: Array<NoteKind | 'ALL'> = ['ALL', ...(Object.keys(KIND_WORD) as NoteKind[])];
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');

/* The chart's names for the print (docs/bugs/0834) — read when a print is
   asked for, not on every page open. */
const accountNamer = async (): Promise<(code: string) => string | null> => {
  const r = await authedFetch<{ accounts: Array<{ account_code: string; account_name: string }> }>('/accounting/accounts');
  const names = new Map(r.accounts.map((a) => [a.account_code, a.account_name]));
  return (code) => names.get(code) ?? null;
};

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const th: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap', textAlign: 'left' };
const td: React.CSSProperties = { padding: '6px 10px', fontSize: 'var(--fs-13)', borderBottom: '1px solid var(--border-weak, #f0eee8)' };
const num: React.CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const danger = 'var(--c-festive-b, #B8331F)';
const good = 'var(--c-secondary-a, #2F5D4F)';
const input: React.CSSProperties = { padding: '5px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, minWidth: 180 };

type FormLine = { rid: number; description: string; accountCode: string; amountRm: string };
type FormValues = {
  kind: NoteKind; noteDate: string; soDocNo: string; partyName: string; supplierId: string;
  sourceDocNo: string; reason: string; lines: FormLine[];
  /** The supplier's invoice a supplier note names (set from a scan) — its reference. */
  creditedDoc?: { kind: 'PI' | 'API'; id: string } | null;
  /** A supplier note's knock-off ticks — the plan the post carries out (2026-10-02). */
  knockOff?: KnockOffPick;
};
const emptyLine = (rid: number): FormLine => ({ rid, description: '', accountCode: '', amountRm: '' });
const emptyForm = (kind: NoteKind = 'CN'): FormValues => ({ kind, noteDate: myt(), soDocNo: '', partyName: '', supplierId: '', sourceDocNo: '', reason: '', lines: [emptyLine(1)], creditedDoc: null, knockOff: {} });

/** The invoice the paper names, ticked — as much of the credit as it owes. */
const scanKnockOff = (r: ScnScan): KnockOffPick => {
  const named = r.suggested ? r.invoices.find((i) => i.id === r.suggested?.id) : undefined;
  const credit = r.lines.reduce((sum, l) => sum + l.amountSen, 0);
  const sen = named ? Math.min(credit, named.outstandingSen) : 0;
  return named && sen > 0 ? { [named.id]: { kind: named.kind, id: named.id, amountSen: sen } } : {};
};

/** The New note form, filled from a scanned supplier credit note. */
export const fromScan = (r: ScnScan): FormValues => ({
  kind: 'SCN',
  noteDate: r.read.cnDate ?? myt(),
  soDocNo: '', partyName: '',
  supplierId: r.supplier?.id ?? '',
  sourceDocNo: r.read.cnNumber ?? '',
  reason: r.read.remark ?? '',
  lines: r.lines.length > 0
    ? r.lines.map((l, i) => ({ rid: i + 1, description: l.description ?? '', accountCode: l.accountCode ?? '', amountRm: (l.amountSen / 100).toFixed(2) }))
    : [emptyLine(1)],
  creditedDoc: r.suggested ? { kind: r.suggested.kind, id: r.suggested.id } : null,
  knockOff: scanKnockOff(r),
});
const toSen = (rm: string): number => Math.round(Number(rm) * 100);

/* The body the server takes, off the form — the lines with a sen amount; an
   account left blank lets the server land it on the kind's default. */
export const bodyOf = (v: FormValues): { kind: NoteKind; noteDate: string; reason: string | null; sourceDocNo: string | null; soDocNo?: string; partyName?: string; supplierId?: string; purchaseInvoiceId?: string; apInvoiceId?: string; allocations?: KnockOffTarget[]; lines: CreditNoteLineInput[] } => ({
  kind: v.kind,
  noteDate: v.noteDate,
  reason: v.reason.trim() || null,
  sourceDocNo: v.sourceDocNo.trim() || null,
  ...(v.kind === 'SCN' ? { supplierId: v.supplierId } : v.soDocNo.trim() ? { soDocNo: v.soDocNo.trim() } : { partyName: v.partyName.trim() }),
  ...(v.kind === 'SCN' && v.creditedDoc ? (v.creditedDoc.kind === 'PI' ? { purchaseInvoiceId: v.creditedDoc.id } : { apInvoiceId: v.creditedDoc.id }) : {}),
  /* A supplier note always says its ticks — none ticked is a plan too. */
  ...(v.kind === 'SCN' ? { allocations: pickTargets(v.knockOff ?? {}) } : {}),
  lines: v.lines
    .filter((l) => l.amountRm.trim() !== '')
    .map((l) => ({ description: l.description.trim() || null, accountCode: l.accountCode || null, amountSen: toSen(l.amountRm) })),
});

const StatusPill = ({ status }: { status: NoteStatus }) => (
  <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', color: status === 'POSTED' ? good : status === 'CANCELLED' ? danger : 'var(--fg-muted)' }}>
    {status}
  </span>
);

export const CreditNotes = () => {
  const [kind, setKind] = useState<NoteKind | 'ALL'>('ALL');
  const [status, setStatus] = useState<NoteStatus | 'ALL'>('ALL');
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: 'new' | 'edit'; id?: string; values: FormValues; scan?: ScnScan; files?: File[] } | null>(null);
  /* Scan supplier CN: the pages of one credit note → the New note form, filled. */
  const scanRef = useRef<HTMLInputElement>(null);
  const scan = useScanSupplierCreditNote();
  const [scanError, setScanError] = useState<string | null>(null);
  const scanFiles = async (picked: File[]) => {
    if (picked.length === 0) return;
    setScanError(null);
    try {
      const pages: PvFilePayload[] = await Promise.all(picked.map(async (f) => ({ name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) })));
      const r = await scan.mutateAsync(pages);
      setForm({ mode: 'new', values: fromScan(r), scan: r, files: picked });
    } catch (e) { setScanError(errText(e)); }
  };
  const listQ = useCreditNotes(kind, status);
  const rows = listQ.data?.rows ?? [];
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const toggle = (id: string) => setTicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /* The ticked notes as ONE document in LIST order, a page each (owner
     2026-09-12: 要批量打印; docs/bugs/0834) — each note's lines and the
     chart's names read for it. */
  const printTicked = async (action: PdfAction) => {
    const targets = rows.filter((n) => ticked.has(n.id));
    if (targets.length === 0 || printing) return;
    setPrinting(true); setPrintError(null);
    try {
      const [{ generateCreditNotesPdf }, nameOf, details] = await Promise.all([
        import('../../vendor/scm/lib/credit-note-pdf'),
        accountNamer(),
        Promise.all(targets.map((n) => authedFetch<{ note: CreditNote; lines: CreditNoteLine[] }>(`/credit-notes/${n.id}`))),
      ]);
      await generateCreditNotesPdf(details.map((d) => ({ header: d.note, lines: d.lines })), nameOf, { action });
    } catch (e) { setPrintError(errText(e)); } finally { setPrinting(false); }
  };

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Finance" title="Credit & Debit Notes"
        description="A credit note to a customer, a debit note to a customer, a credit note from a supplier. Raised as a draft, posted to the ledger, cancelled by contra."
        actions={(
          <>
            <input ref={scanRef} type="file" multiple accept={PV_FILE_ACCEPT} style={{ display: 'none' }} aria-label="Supplier credit note pages"
              onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ''; void scanFiles(picked); }} />
            <Button variant="ghost" size="sm" onClick={() => scanRef.current?.click()} disabled={scan.isPending}>
              <FileText size={16} strokeWidth={1.75} /> {scan.isPending ? 'Reading the credit note…' : 'Scan supplier CN · 扫描 CN'}
            </Button>
          </>
        )}
        primaryAction={<Button size="sm" onClick={() => setForm({ mode: 'new', values: emptyForm() })}><Plus size={16} strokeWidth={1.75} /> New note</Button>} />
      {scanError && <div role="alert" style={{ fontSize: 'var(--fs-13)', color: danger }}>The credit note was not read — {scanError}</div>}
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <div role="tablist" aria-label="Note kind" style={{ display: 'inline-flex', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, overflow: 'hidden' }}>
          {KIND_TABS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
              style={{ padding: '4px 12px', fontSize: 'var(--fs-12)', border: 'none', cursor: 'pointer', background: kind === k ? 'var(--c-ink, #221f20)' : 'transparent', color: kind === k ? '#fff' : 'inherit' }}>
              {k === 'ALL' ? 'All' : k}
            </button>
          ))}
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value as NoteStatus | 'ALL')} aria-label="Note status" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }}>
          <option value="ALL">Any status</option>
          <option value="DRAFT">Draft</option>
          <option value="POSTED">Posted</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <span style={soft}>CN: the customer owes less. DN: the customer owes more. SCN: we owe the supplier less.</span>
      </div>

      {ticked.size > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }} aria-label="Ticked notes">
          <span>{ticked.size} ticked</span>
          <Button size="sm" onClick={() => void printTicked('print')} disabled={printing}>{printing ? 'Preparing…' : `Print ${ticked.size}`}</Button>
          <Button variant="ghost" size="sm" onClick={() => void printTicked('save')} disabled={printing}>Save PDF</Button>
          <Button variant="ghost" size="sm" onClick={() => setTicked(new Set())} disabled={printing}>Clear</Button>
          {printError && <span style={{ color: danger }}>{printError}</span>}
        </div>
      )}
      <DataTable<CreditNote>
        tableId="credit-notes"
        exportName="credit-notes"
        exportXlsx
        columns={NOTE_COLUMNS}
        rows={listQ.data ? rows : null}
        loading={listQ.isLoading}
        error={listQ.isError ? `The list did not load — ${errText(listQ.error)}` : null}
        emptyLabel="No note yet. New note raises one."
        getRowKey={(n) => n.id}
        onRowClick={(n) => setOpenId(n.id)}
        selection={{
          selectedIds: ticked,
          onToggle: toggle,
          onToggleAll: (keys, all) => setTicked(all ? new Set() : new Set(keys)),
          rowLabel: (n) => `Tick ${n.note_number}`,
        }}
      />

      {openId && (
        <NoteDetail id={openId} onClose={() => setOpenId(null)}
          onEdit={(n, lines, allocations) => {
            setForm({
              mode: 'edit', id: n.id,
              values: {
                kind: n.kind, noteDate: n.note_date, soDocNo: n.so_doc_no ?? '', partyName: n.party_name ?? '', supplierId: n.supplier_id ?? '',
                sourceDocNo: n.source_doc_no ?? '', reason: n.reason ?? '',
                lines: lines.length > 0 ? lines.map((l, i) => ({ rid: i + 1, description: l.description ?? '', accountCode: l.account_code, amountRm: (l.amount_sen / 100).toFixed(2) })) : [emptyLine(1)],
                creditedDoc: null,
                knockOff: Object.fromEntries(allocations.map((a) => [a.docId, { kind: a.kind, id: a.docId, amountSen: a.amountSen }])),
              },
            });
            setOpenId(null);
          }} />
      )}
      {form && <NoteForm mode={form.mode} id={form.id} initial={form.values} scan={form.scan} scanFiles={form.files} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); setOpenId(id); }} />}
    </div>
  );
};

const NOTE_COLUMNS: Column<CreditNote>[] = [
  { key: 'number', label: 'Number', render: (n) => <span style={{ fontFamily: 'var(--font-mono)' }}>{n.note_number}</span>, getValue: (n) => n.note_number },
  { key: 'kind', label: 'Kind', render: (n) => n.kind, getValue: (n) => n.kind },
  { key: 'date', label: 'Date', render: (n) => fmtDateOrDash(n.note_date), getValue: (n) => n.note_date, exportFormat: 'date' },
  { key: 'party', label: 'Party', render: (n) => n.party_name ?? n.party_code ?? '—', getValue: (n) => n.party_name ?? n.party_code ?? '' },
  {
    key: 'reference', label: 'Reference',
    render: (n) => [n.so_doc_no, n.source_doc_no, n.purchase_invoice_number ?? n.ap_invoice_number].filter(Boolean).join(' · ') || '—',
    getValue: (n) => [n.so_doc_no, n.source_doc_no, n.purchase_invoice_number ?? n.ap_invoice_number].filter(Boolean).join(' · '),
  },
  {
    key: 'total', label: 'Total', align: 'right', render: (n) => fmtSen(n.total_sen),
    getValue: (n) => n.total_sen, exportValue: (n) => n.total_sen / 100, exportFormat: 'money',
  },
  { key: 'status', label: 'Status', render: (n) => <StatusPill status={n.status} />, getValue: (n) => n.status },
  { key: 'journal', label: 'Journal', render: (n) => <span style={{ fontFamily: 'var(--font-mono)' }}>{n.je_no ?? '—'}</span>, getValue: (n) => n.je_no ?? '' },
];

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
    {label}
    {children}
  </label>
);

const NoteDetail = ({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (n: CreditNote, lines: Array<{ description: string | null; account_code: string; amount_sen: number }>, allocations: CreditAllocation[]) => void }) => {
  const q = useCreditNoteDetail(id);
  const post = usePostCreditNote();
  const cancel = useCancelCreditNote();
  const askConfirm = useConfirm();
  const n = q.data?.note;
  const lines = q.data?.lines ?? [];
  const busy = post.isPending || cancel.isPending;
  const failed = post.isError ? post.error : cancel.isError ? cancel.error : null;
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const printOne = async () => {
    if (!n || printing) return;
    setPrinting(true); setPrintError(null);
    try {
      const [{ generateCreditNotePdf }, nameOf] = await Promise.all([import('../../vendor/scm/lib/credit-note-pdf'), accountNamer()]);
      await generateCreditNotePdf(n, lines, nameOf, { action: 'print' });
    } catch (e) { setPrintError(errText(e)); } finally { setPrinting(false); }
  };
  return (
    <Modal title={n ? `${KIND_WORD[n.kind]} ${n.note_number}` : 'Note'} onClose={onClose} width="min(820px, 100%)" ariaLabel="Credit or debit note"
      actions={n && (
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button variant="ghost" size="sm" onClick={() => void printOne()} disabled={busy || printing}>{printing ? 'Preparing…' : 'Print'}</Button>
          {n.status === 'DRAFT' && <Button variant="ghost" size="sm" onClick={() => onEdit(n, lines, q.data?.allocations ?? [])} disabled={busy}>Edit</Button>}
          {n.status === 'DRAFT' && <Button size="sm" onClick={() => post.mutate(n.id)} disabled={busy}>{post.isPending ? 'Posting…' : 'Post to ledger'}</Button>}
          {n.status !== 'CANCELLED' && (
            <Button variant="ghost" size="sm" disabled={busy}
              onClick={async () => {
                const yes = await askConfirm({
                  title: `Cancel ${n.note_number}?`,
                  body: n.status === 'POSTED' ? 'Its journal is reversed by a contra dated today. The note stays on file as cancelled.' : 'The draft stays on file as cancelled.',
                  confirmLabel: 'Cancel note', danger: true,
                });
                if (yes) cancel.mutate(n.id);
              }}>
              Cancel note
            </Button>
          )}
        </div>
      )}>
      {q.isLoading && <div style={soft}>Loading…</div>}
      {n && (
        <div className="space-y-3">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <div><div style={soft}>Party</div>{n.party_name ?? '—'}{n.party_code ? <span style={soft}> · {n.party_code}</span> : null}</div>
            <div><div style={soft}>Date</div>{fmtDateOrDash(n.note_date)}</div>
            <div><div style={soft}>Reference</div>{[n.so_doc_no, n.source_doc_no].filter(Boolean).join(' · ') || '—'}</div>
            {(n.purchase_invoice_number || n.ap_invoice_number) && <div><div style={soft}>Credits</div>{n.purchase_invoice_number ?? n.ap_invoice_number}</div>}
            <div><div style={soft}>Status</div><StatusPill status={n.status} />{n.je_no ? <span style={soft}> · {n.je_no}</span> : null}</div>
            <div style={{ gridColumn: '1 / -1' }}><div style={soft}>Reason</div>{n.reason ?? '—'}</div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>#</th><th style={th}>Description</th><th style={th}>Account</th><th style={{ ...th, textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}><td style={td}>{l.line_no}</td><td style={td}>{l.description ?? '—'}</td><td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{l.account_code}</td><td style={{ ...td, ...num }}>{fmtSen(l.amount_sen)}</td></tr>
              ))}
              <tr><td colSpan={3} style={{ ...td, fontWeight: 700 }}>Total</td><td style={{ ...td, ...num, fontWeight: 700 }}>{fmtSen(n.total_sen)}</td></tr>
            </tbody>
          </table>
          {n.kind === 'SCN' && n.status !== 'CANCELLED' && <NoteKnockOff noteId={n.id} posted={n.status === 'POSTED'} totalSen={n.total_sen} />}
          <NoteFilesCard noteId={n.id} locked={n.status === 'POSTED'} closed={n.status === 'CANCELLED'} />
          {post.isSuccess && (
            <div style={{ fontSize: 'var(--fs-13)', color: good }}>
              Posted as {post.data.jeNo}.
              {(post.data.applied ?? []).map((a) => ` ${fmtSen(a.appliedSen)} came off ${a.number}.`).join('')}
              {post.data.notApplied ? ` ${post.data.notApplied}` : ''}
            </div>
          )}
          {printError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{printError}</div>}
          {failed != null && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{errText(failed)}</div>}
        </div>
      )}
    </Modal>
  );
};

const NoteForm = ({ mode, id, initial, scan, scanFiles, onClose, onSaved }: { mode: 'new' | 'edit'; id?: string; initial: FormValues; scan?: ScnScan; scanFiles?: File[]; onClose: () => void; onSaved: (id: string) => void }) => {
  const [v, setV] = useState<FormValues>(initial);
  const uploadFile = useUploadCreditNoteFile();
  const [attachError, setAttachError] = useState<string | null>(null);
  const [postAfter, setPostAfter] = useState(false);
  const accountsQ = useAccounts();
  const suppliersQ = useSuppliers();
  const create = useCreateCreditNote();
  const update = useUpdateCreditNote();
  const post = usePostCreditNote();
  const leaves = useMemo(() => leafAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  const supplierOptions = useMemo(() => (suppliersQ.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` })), [suppliersQ.data]);
  const totalSen = v.lines.reduce((s, l) => s + (l.amountRm.trim() ? toSen(l.amountRm) : 0), 0);
  const busy = create.isPending || update.isPending || post.isPending;
  const failed = create.isError ? create.error : update.isError ? update.error : post.isError ? post.error : null;
  const setLine = (rid: number, patch: Partial<FormLine>) => setV((p) => ({ ...p, lines: p.lines.map((l) => (l.rid === rid ? { ...l, ...patch } : l)) }));
  const canSave = totalSen > 0 && v.noteDate !== '' && (v.kind === 'SCN' ? v.supplierId !== '' && pickSen(v.knockOff ?? {}) <= totalSen : v.soDocNo.trim() !== '' || v.partyName.trim() !== '');

  const save = async () => {
    try {
      const body = bodyOf(v);
      let noteId = id ?? '';
      if (mode === 'new') {
        const r = await create.mutateAsync(body);
        noteId = r.note.id;
        /* The scanned pages go with the note they became. */
        for (const f of scanFiles ?? []) {
          try {
            await uploadFile.mutateAsync({ noteId, file: { name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) } });
          } catch (e) { setAttachError(`${f.name} did not attach — ${errText(e)}`); }
        }
      } else if (id) {
        await update.mutateAsync({ id, noteDate: body.noteDate, reason: body.reason, sourceDocNo: body.sourceDocNo, lines: body.lines, ...(body.allocations ? { allocations: body.allocations } : {}) });
      }
      if (postAfter && noteId) await post.mutateAsync(noteId);
      onSaved(noteId);
    } catch { /* the hook holds the error; it is shown below */ }
  };

  return (
    <Modal title={mode === 'new' ? (scan ? 'New note — from the scanned credit note' : 'New note') : `Edit ${initial.kind}`} onClose={onClose} width="min(900px, 100%)" ariaLabel="Note form">
      <div className="space-y-3">
        {scan && <ScanPanel scan={scan} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3)' }}>
          <Field label="Kind">
            <select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as NoteKind })} disabled={mode === 'edit'} aria-label="Kind" style={input}>
              <option value="CN">CN — credit note to a customer</option>
              <option value="DN">DN — debit note to a customer</option>
              <option value="SCN">SCN — credit note from a supplier</option>
            </select>
          </Field>
          <Field label="Date"><DateField value={v.noteDate} onChange={(d) => setV({ ...v, noteDate: d })} aria-label="Note date" /></Field>
          {v.kind === 'SCN' ? (
            <Field label="Supplier">
              <SearchCombo options={supplierOptions} value={v.supplierId} onChange={(s) => setV({ ...v, supplierId: s, knockOff: s === v.supplierId ? v.knockOff : {} })} aria-label="Supplier" placeholder="— type to search suppliers —" />
            </Field>
          ) : (
            <>
              <Field label="Sales order (the customer comes from it)">
                <input value={v.soDocNo} onChange={(e) => setV({ ...v, soDocNo: e.target.value })} placeholder="2990-SO-2607-019" aria-label="Sales order" style={input} disabled={mode === 'edit'} />
              </Field>
              <Field label="or customer name">
                <input value={v.partyName} onChange={(e) => setV({ ...v, partyName: e.target.value })} placeholder="when there is no order" aria-label="Customer name" style={input} disabled={mode === 'edit' || v.soDocNo.trim() !== ''} />
              </Field>
            </>
          )}
          <Field label="Reference (return, invoice, complaint)">
            <input value={v.sourceDocNo} onChange={(e) => setV({ ...v, sourceDocNo: e.target.value })} placeholder="DR-2609-001" aria-label="Reference" style={input} />
          </Field>
          <Field label="Reason">
            <input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="why this note" aria-label="Reason" style={input} />
          </Field>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Description</th><th style={th}>Account (blank = the kind's default)</th><th style={{ ...th, textAlign: 'right' }}>Amount (RM)</th><th style={th} /></tr></thead>
          <tbody>
            {v.lines.map((l) => (
              <tr key={l.rid}>
                <td style={td}><input value={l.description} onChange={(e) => setLine(l.rid, { description: e.target.value })} aria-label={`Line ${l.rid} description`} style={{ ...input, minWidth: 220 }} /></td>
                <td style={td}><AccountSelect accounts={leaves} value={l.accountCode} onChange={(code) => setLine(l.rid, { accountCode: code })} placeholder="— default for this kind —" /></td>
                <td style={{ ...td, ...num }}><input type="number" min={0} step="0.01" value={l.amountRm} onChange={(e) => setLine(l.rid, { amountRm: e.target.value })} aria-label={`Line ${l.rid} amount`} style={{ ...input, minWidth: 120, textAlign: 'right' }} /></td>
                <td style={td}>
                  {v.lines.length > 1 && (
                    <button type="button" onClick={() => setV({ ...v, lines: v.lines.filter((x) => x.rid !== l.rid) })} aria-label={`Remove line ${l.rid}`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)' }}><X size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} style={td}>
                <AddLineButton variant="ghost" onClick={() => setV({ ...v, lines: [...v.lines, emptyLine(Math.max(0, ...v.lines.map((x) => x.rid)) + 1)] })} />
              </td>
              <td style={{ ...td, ...num, fontWeight: 700 }}>{fmtSen(totalSen)}</td>
              <td style={td} />
            </tr>
          </tbody>
        </table>

        {v.kind === 'SCN' && (
          <FormKnockOff supplierId={v.supplierId} noteId={mode === 'edit' ? id : undefined} totalSen={totalSen}
            pick={v.knockOff ?? {}} onChange={(knockOff) => setV((p) => ({ ...p, knockOff }))} />
        )}

        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={postAfter} onChange={(e) => setPostAfter(e.target.checked)} aria-label="Post to the ledger after saving" />
            post to the ledger after saving
          </label>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Close</Button>
          <Button size="sm" onClick={() => void save()} disabled={!canSave || busy}>{busy ? 'Saving…' : mode === 'new' ? 'Save note' : 'Save changes'}</Button>
        </div>
        {failed != null && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{errText(failed)}</div>}
        {attachError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{attachError}</div>}
      </div>
    </Modal>
  );
};

/* What the scan read, said before the form: the issuer and the paper, what to
   check (the server's sentences), and the invoice the paper names — ticked in
   the knock-off table below, still Finance's call. */
const ScanPanel = ({ scan }: { scan: ScnScan }) => (
  <div style={{ border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)', display: 'grid', gap: 8, fontSize: 'var(--fs-13)' }} aria-label="What the credit note reads">
    <div>
      <strong>{scan.read.vendorName ?? 'Issuer not read'}</strong>
      <span style={soft}> · CN {scan.read.cnNumber ?? '—'} · {fmtDateOrDash(scan.read.cnDate)} · total {scan.read.totalSen != null ? fmtSen(scan.read.totalSen) : '—'}</span>
      {scan.supplier && <span style={soft}> · supplier {scan.supplier.code} {scan.supplier.name}</span>}
    </div>
    {scan.notes.map((t) => <div key={t} style={{ color: 'var(--c-orange)' }}>{t}</div>)}
    {scan.read.invoiceNumbers.length > 0 && (
      <div style={soft} aria-label="The invoice the paper names">
        The paper names {scan.read.invoiceNumbers.join(', ')}
        {scan.suggested ? <> — <span style={{ fontFamily: 'var(--font-mono)' }}>{scan.suggested.number}</span> is ticked under Knock off below; untick it to keep the credit with the supplier.</> : ' — none of this supplier\'s invoices matched it; tick below.'}
      </div>
    )}
  </div>
);

/* The note's paper — the AP invoice's files card bound to this document: a
   POSTED note keeps what it has, a CANCELLED one takes no more. */
const NoteFilesCard = ({ noteId, locked, closed }: { noteId: string; locked: boolean; closed: boolean }) => {
  const filesQ = useCreditNoteFiles(noteId);
  const upload = useUploadCreditNoteFile();
  const remove = useDeleteCreditNoteFile();
  return (
    <DocFilesCard
      files={filesQ.data?.files ?? []}
      canWrite locked={locked} closed={closed}
      lockedNote=" · kept with the posted note"
      emptyNote="No files yet. A credit note scanned with Scan supplier CN attaches its pages here by itself; use Attach file for anything else."
      removeBody="The stored file is deleted with its row. A posted note refuses this — evidence locks with the document."
      attachAriaLabel="Attach credit note files"
      uploading={upload.isPending} removing={remove.isPending}
      onUpload={(file) => upload.mutateAsync({ noteId, file })}
      onRemove={(fileId) => remove.mutateAsync({ noteId, fileId })}
      openUrl={(fileId) => fetchCreditNoteFileBlobUrl(noteId, fileId)}
    />
  );
};
