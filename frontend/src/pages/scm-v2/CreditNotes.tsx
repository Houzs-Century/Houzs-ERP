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
//
// Two pages (owner 2026-10-28: 我想把 supplier & other creditor cn / dn 和 customer &
// other debtor cn / dn 分出来 —「可以」): Money in › Customer & Other Debtor CN / DN
// (/scm/credit-notes — CN, DN, and OCN: a credit note to an other debtor, every
// line on its account, knocking off the debtor's bills on the same table) and
// Money out › Supplier & Other Creditor CN / DN (/scm/supplier-notes — SCN, its
// scan and knock-off). One component; `side` says which page it is.
//
// The owner's Claude Design, batch 5 step 7: Money in's notes have their own
// list (money-in/MoneyInNotes.tsx at /scm/credit-notes); it reuses this file's
// note parts — the form (NoteForm, in place of the list with `inline`), the
// note's reads and writes (useNoteDoc) and the note page (NotePage.tsx). A
// customer note's blank account says the account it lands on (f1: the
// SALES_RETURNS role, 510-0000 Return inwards).
//
// A customer's credit note knocks off the customer's sales invoices (owner
// 2026-11-03: 「要」, "like AutoCount"): the form's ticks are the draft's plan
// (the customer from the sales order typed, else the name), the note's page
// shows what it knocked off with Knock off to change it — Money in's knock
// form (money-in/NoteKnockOffPage.tsx). It posts nothing.
// ----------------------------------------------------------------------------

import { lazy, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Plus, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { AddLineButton } from '../../vendor/scm/components/AddLineButton';
import { PageHeader } from '../../components/Layout';
import { LazySlot } from '../../components/LazySlot';
import { DataTable, type Column } from '../../components/DataTable';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import { Modal } from '../../vendor/scm/components/Modal';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { DateField } from '../../vendor/scm/components/DateField';
import { AccountSelect } from '../../vendor/scm/components/AccountSelect';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { EventSelect, eventCellText } from '../../vendor/scm/components/EventSelect';
import { useEventLabels } from '../../vendor/scm/lib/event-queries';
import { useAccountRoles, useAccounts, leafAccounts, useOtherDebtors } from '../../vendor/scm/lib/accounting-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import {
  useCreditNotes, useCreditNoteDetail, useCreateCreditNote, useUpdateCreditNote, usePostCreditNote, useCancelCreditNote,
  useScanSupplierCreditNote, useCreditNoteFiles, useUploadCreditNoteFile, useDeleteCreditNoteFile, fetchCreditNoteFileBlobUrl,
  type CreditAllocation, type CreditNote, type CreditNoteLine, type CreditNoteLineInput, type KnockOffTarget, type NoteKind, type NoteSide, type NoteStatus, type OpeningFilter, type ScnScan,
} from '../../vendor/scm/lib/credit-note-queries';
import {
  CustomerKnockOffSection, FormKnockOff, NoteKnockOff, depositPaperLine, pickSen, pickTargets, type KnockOffPick, type KnockOffWho,
} from './CreditNoteKnockOff';
import { fileToBase64, PV_FILE_ACCEPT, type PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { docFileMime } from '../../vendor/scm/lib/doc-file-mime';
import { DocFilesCard } from '../../vendor/scm/components/DocFilesCard';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';
import { parseMoneyToSen } from '../../lib/money';

export const KIND_WORD: Record<NoteKind, string> = { CN: 'Credit note', DN: 'Debit note', SCN: 'Supplier credit note', OCN: 'Other debtor credit note' };
/* The kind as the tab and the form's picker say it. */
const KIND_TAB: Record<NoteKind, string> = { CN: 'CN', DN: 'DN', SCN: 'SCN', OCN: 'Other debtor CN' };
const KIND_OPTION: Record<NoteKind, string> = {
  CN: 'CN — credit note to a customer',
  DN: 'DN — debit note to a customer',
  OCN: 'Other debtor CN — credit note to an other debtor',
  SCN: 'SCN — credit note from a supplier',
};

/* The two pages (owner 2026-10-28): which kinds each holds — the list asks the
   server for the side's kinds, the tabs and the New note picker offer them. */
const SIDES: Record<NoteSide, { title: string; description?: string; kinds: NoteKind[]; hint: string; tableId: string }> = {
  /* Money in's page by the redesign's name, no description (owner's Claude Design, batch 5). */
  AR: {
    title: 'Credit / debit notes',
    kinds: ['CN', 'DN', 'OCN'],
    hint: 'CN: the customer owes less. DN: the customer owes more. Other debtor CN: the debtor owes less — it knocks off their bills.',
    tableId: 'credit-notes',
  },
  AP: {
    title: 'Supplier & other creditor CN / DN',
    description: 'A credit note from a supplier or an other creditor — we owe them less; a debit note — we owe them more. A note is raised as a draft, posted to the ledger, cancelled by contra; a debit note is a bill of its own kind.',
    kinds: ['SCN'],
    hint: 'SCN: we owe the supplier less — it knocks off their invoices.',
    tableId: 'supplier-notes',
  },
};
const OPENING_HINT = 'AutoCount\'s supplier payments not knocked off at 31/08 — open one and tick the supplier\'s bills to knock it off. Amounts change on Finance › Opening Balance.';

/* The debit notes (owner 2026-10-28: 再加 supplier DN; Customer & Other Debtor CN / DN):
   each is a BILL of its own kind — a supplier's on the AP invoices (HC-SDN-), paid by an
   AP Payment; an other debtor's on the debtor bills (HC-ODN-), received on Receipts — so
   its tab shows that bills page narrowed to them, loaded only when the tab is opened. */
const ApInvoicesPage = lazy(() => import('./ApInvoices').then((m) => ({ default: m.ApInvoices })));
const ArInvoicesPage = lazy(() => import('./ArInvoices').then((m) => ({ default: m.ArInvoices })));
type View = 'notes' | 'debit' | 'opening';
const VIEW_TABS: Record<NoteSide, Array<{ key: View; text: string }>> = {
  AR: [{ key: 'notes', text: 'Credit & debit notes' }, { key: 'debit', text: 'Other debtor DN' }],
  AP: [{ key: 'notes', text: 'Credit notes' }, { key: 'debit', text: 'Debit notes' }, { key: 'opening', text: 'Opening 31/08' }],
};
const DEBIT_HINT: Record<NoteSide, string> = {
  AR: 'Other debtor DN: the debtor owes more — a bill of its own kind, received on the Receipts page.',
  AP: 'Supplier DN: we owe the supplier more — a bill of its own kind, paid through an AP Payment.',
};

/* The page's tab strip — the kind filter, and Money out's Credit notes / Opening 31/08. */
function SegTabs<T extends string>({ label, tabs, value, onChange }: { label: string; tabs: Array<{ key: T; text: string }>; value: T; onChange: (key: T) => void }) {
  return (
    <div role="tablist" aria-label={label} style={{ display: 'inline-flex', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, overflow: 'hidden' }}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}
          style={{ padding: '4px 12px', fontSize: 'var(--fs-12)', border: 'none', cursor: 'pointer', background: value === t.key ? 'var(--c-ink, #221f20)' : 'transparent', color: value === t.key ? '#fff' : 'inherit' }}>
          {t.text}
        </button>
      ))}
    </div>
  );
}

/** The kinds whose credit knocks off documents, and whose: a supplier's invoices, an other debtor's bills. */
const knocksOff = (k: NoteKind): boolean => k === 'SCN' || k === 'OCN';
const whoOf = (k: NoteKind): KnockOffWho => (k === 'OCN' ? 'debtor' : 'supplier');
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
const num: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const danger = 'var(--c-festive-b, #B8331F)';
const good = 'var(--c-secondary-a, #2F5D4F)';
const input: React.CSSProperties = { padding: '5px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, minWidth: 180 };

/** projectId: a supplier note line's event (owner 2026-10-22) — null = none, or the AP invoice's at save. */
type FormLine = {
  rid: number; description: string; accountCode: string; amountRm: string; projectId: number | null;
  /** A line of a note raised from a delivery return (backlog A1): the return line, its units, how many may
      still be credited and the invoiced unit price — the last two null on a draft opened for edit. */
  ret?: { itemId: string; qty: number; maxQty: number | null; unitSen: number | null };
};
/** The note form's values — Supplier bills raises and edits a supplier's note with the same form. */
export type FormValues = {
  kind: NoteKind; noteDate: string; soDocNo: string; partyName: string; supplierId: string;
  /** An other-debtor note's debtor (2026-10-28). */
  debtorId?: string;
  sourceDocNo: string; reason: string; lines: FormLine[];
  /** The supplier's invoice a supplier note names (set from a scan) — its reference. */
  creditedDoc?: { kind: 'PI' | 'API'; id: string } | null;
  /** A supplier, other-debtor or customer note's knock-off ticks — the plan the post carries out (2026-10-02). */
  knockOff?: KnockOffPick;
  /** The delivery return this customer note answers (backlog A1), its number and the invoice its prices came from. */
  deliveryReturnId?: string | null;
  returnNumber?: string | null;
  invoiceNumber?: string | null;
};
const emptyLine = (rid: number): FormLine => ({ rid, description: '', accountCode: '', amountRm: '', projectId: null });
export const emptyForm = (kind: NoteKind = 'CN'): FormValues => ({ kind, noteDate: myt(), soDocNo: '', partyName: '', supplierId: '', debtorId: '', sourceDocNo: '', reason: '', lines: [emptyLine(1)], creditedDoc: null, knockOff: {} });

/** A draft note's form, filled from the note, its lines and its knock-off ticks (its pop-out's Edit). */
export const noteEditValues = (n: CreditNote, lines: CreditNoteLine[], allocations: CreditAllocation[]): FormValues => ({
  kind: n.kind, noteDate: n.note_date, soDocNo: n.so_doc_no ?? '', partyName: n.party_name ?? '', supplierId: n.supplier_id ?? '', debtorId: n.debtor_id ?? '',
  sourceDocNo: n.source_doc_no ?? '', reason: n.reason ?? '',
  lines: lines.length > 0 ? lines.map((l, i) => ({
    rid: i + 1, description: l.description ?? '', accountCode: l.account_code, amountRm: (l.amount_sen / 100).toFixed(2), projectId: l.project_id ?? null,
    ...(l.delivery_return_item_id ? { ret: { itemId: l.delivery_return_item_id, qty: Number(l.qty ?? 0), maxQty: null, unitSen: null } } : {}),
  })) : [emptyLine(1)],
  creditedDoc: null,
  deliveryReturnId: n.delivery_return_id ?? null,
  returnNumber: n.delivery_return_id ? n.source_doc_no : null,
  knockOff: Object.fromEntries(allocations.map((a) => [a.docId, { kind: a.kind, id: a.docId, amountSen: a.amountSen }])),
});

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
    ? r.lines.map((l, i) => ({ rid: i + 1, description: l.description ?? '', accountCode: l.accountCode ?? '', amountRm: (l.amountSen / 100).toFixed(2), projectId: null }))
    : [emptyLine(1)],
  creditedDoc: r.suggested ? { kind: r.suggested.kind, id: r.suggested.id } : null,
  knockOff: scanKnockOff(r),
});
/* The repo's money parser, never Number(): Number("3,500.00") is NaN, which
   JSON sends as null. A line whose amount cannot be read is refused with its
   sentence, never treated as blank (a blank line is dropped). */
const lineSen = (l: FormLine) => parseMoneyToSen(l.amountRm, `Line ${l.rid}'s amount`);
export const amountProblem = (lines: FormLine[]): string | null => {
  for (const l of lines) { const p = lineSen(l); if (!p.ok) return p.message; }
  return null;
};

/* The body the server takes, off the form — the lines with a sen amount; an
   account left blank lets the server land it on the kind's default. */
export const bodyOf = (v: FormValues): { kind: NoteKind; noteDate: string; reason: string | null; sourceDocNo: string | null; soDocNo?: string; partyName?: string; supplierId?: string; debtorId?: string; purchaseInvoiceId?: string; apInvoiceId?: string; allocations?: KnockOffTarget[]; deliveryReturnId?: string; lines: CreditNoteLineInput[] } => ({
  kind: v.kind,
  noteDate: v.noteDate,
  reason: v.reason.trim() || null,
  sourceDocNo: v.sourceDocNo.trim() || null,
  ...(v.kind === 'SCN' ? { supplierId: v.supplierId }
    : v.kind === 'OCN' ? { debtorId: v.debtorId ?? '' }
      : v.soDocNo.trim() ? { soDocNo: v.soDocNo.trim() } : { partyName: v.partyName.trim() }),
  ...(v.kind === 'SCN' && v.creditedDoc ? (v.creditedDoc.kind === 'PI' ? { purchaseInvoiceId: v.creditedDoc.id } : { apInvoiceId: v.creditedDoc.id }) : {}),
  /* A supplier, other-debtor or customer credit note always says its ticks — none ticked is a plan too. */
  ...(knocksOff(v.kind) || v.kind === 'CN' ? { allocations: pickTargets(v.knockOff ?? {}) } : {}),
  ...(v.kind === 'CN' && v.deliveryReturnId ? { deliveryReturnId: v.deliveryReturnId } : {}),
  lines: v.lines.flatMap((l) => {
    const p = lineSen(l);
    if (!p.ok) throw new Error(p.message);
    return p.empty ? [] : [{
      description: l.description.trim() || null, accountCode: l.accountCode || null, amountSen: p.sen, ...(l.projectId != null ? { projectId: l.projectId } : {}),
      ...(l.ret ? { deliveryReturnItemId: l.ret.itemId, qty: l.ret.qty } : {}),
    }];
  }),
});

const StatusPill = ({ status }: { status: NoteStatus }) => (
  <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em', color: status === 'POSTED' ? good : status === 'CANCELLED' ? danger : 'var(--fg-muted)' }}>
    {status}
  </span>
);

export const CreditNotes = ({ side = 'AR' }: { side?: NoteSide }) => {
  const page = SIDES[side];
  /* The kind filter's tabs, off the side's kinds — a page of one kind needs none. */
  const kindTabs: Array<NoteKind | 'ALL'> = ['ALL', ...page.kinds];
  const [kind, setKind] = useState<NoteKind | 'ALL'>('ALL');
  const [status, setStatus] = useState<NoteStatus | 'ALL'>('ALL');
  /* Money out's opening credits apart (owner 2026-10-29: 期初那 85 张放在 "Opening
     31/08" 分页) — AutoCount's supplier payments not knocked off at 31/08 on their
     own tab, the real notes by default. */
  const [view, setView] = useState<View>('notes');
  const opening: OpeningFilter = side === 'AP' ? (view === 'opening' ? 'only' : 'exclude') : 'all';
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
      const pages: PvFilePayload[] = await Promise.all(picked.map(async (f) => ({ name: f.name, mime: docFileMime(f), dataBase64: await fileToBase64(f) })));
      const r = await scan.mutateAsync(pages);
      setForm({ mode: 'new', values: fromScan(r), scan: r, files: picked });
    } catch (e) { setScanError(errText(e)); }
  };
  const listQ = useCreditNotes(side, kind, status, opening);
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
      <PageHeader eyebrow={side === 'AP' ? 'Finance · Money out' : 'Finance · Money in'} title={page.title}
        description={page.description}
        actions={side === 'AP' && view !== 'debit' ? (
          <>
            <input ref={scanRef} type="file" multiple accept={PV_FILE_ACCEPT} style={{ display: 'none' }} aria-label="Supplier credit note pages"
              onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ''; void scanFiles(picked); }} />
            <Button variant="ghost" size="sm" onClick={() => scanRef.current?.click()} disabled={scan.isPending}>
              <FileText size={16} strokeWidth={1.75} /> {scan.isPending ? 'Reading the credit note…' : 'Scan supplier CN · 扫描 CN'}
            </Button>
          </>
        ) : undefined}
        primaryAction={view === 'debit' ? undefined : <Button size="sm" onClick={() => setForm({ mode: 'new', values: emptyForm(page.kinds[0]) })}><Plus size={16} strokeWidth={1.75} /> New note</Button>} />
      {scanError && <div role="alert" style={{ fontSize: 'var(--fs-13)', color: danger }}>The credit note was not read — {scanError}</div>}
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <SegTabs label="Notes, debit notes or opening credits" value={view} onChange={(v) => { setView(v); setTicked(new Set()); }} tabs={VIEW_TABS[side]} />
        {view !== 'debit' && page.kinds.length > 1 && (
          <SegTabs label="Note kind" value={kind} onChange={setKind} tabs={kindTabs.map((k) => ({ key: k, text: k === 'ALL' ? 'All' : KIND_TAB[k] }))} />
        )}
        {view !== 'debit' && (
          <select value={status} onChange={(e) => setStatus(e.target.value as NoteStatus | 'ALL')} aria-label="Note status" style={{ padding: '4px 6px', fontSize: 'var(--fs-12)' }}>
            <option value="ALL">Any status</option>
            <option value="DRAFT">Draft</option>
            <option value="POSTED">Posted</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        )}
        <span style={soft}>{view === 'debit' ? DEBIT_HINT[side] : view === 'opening' ? OPENING_HINT : page.hint}</span>
      </div>

      {view === 'debit' && (
        <LazySlot resetKey={`credit-notes-${side}-${view}`} fallback={<div style={soft}>Loading the debit notes…</div>}>
          {side === 'AP' ? <ApInvoicesPage docKind="DN" /> : <ArInvoicesPage docKind="DN" />}
        </LazySlot>
      )}
      {view !== 'debit' && ticked.size > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }} aria-label="Ticked notes">
          <span>{ticked.size} ticked</span>
          <Button size="sm" onClick={() => void printTicked('print')} disabled={printing}>{printing ? 'Preparing…' : `Print ${ticked.size}`}</Button>
          <Button variant="ghost" size="sm" onClick={() => void printTicked('save')} disabled={printing}>Save PDF</Button>
          <Button variant="ghost" size="sm" onClick={() => setTicked(new Set())} disabled={printing}>Clear</Button>
          {printError && <span style={{ color: danger }}>{printError}</span>}
        </div>
      )}
      {view !== 'debit' && (
        <DataTable<CreditNote>
          tableId={page.tableId}
          exportName={page.tableId}
          exportXlsx
          columns={NOTE_COLUMNS}
          rows={listQ.data ? rows : null}
          loading={listQ.isLoading}
          error={listQ.isError ? `The list did not load — ${errText(listQ.error)}` : null}
          emptyLabel={opening === 'only' ? 'No opening credit.' : 'No note yet. New note raises one.'}
          getRowKey={(n) => n.id}
          getRowClassName={(n) => cancelledRowClass(n.status)}
          onRowClick={(n) => setOpenId(n.id)}
          selection={{
            selectedIds: ticked,
            onToggle: toggle,
            onToggleAll: (keys, all) => setTicked(all ? new Set() : new Set(keys)),
            rowLabel: (n) => `Tick ${n.note_number}`,
          }}
        />
      )}

      {openId && (
        <NoteDetail id={openId} onClose={() => setOpenId(null)}
          onEdit={(n, lines, allocations) => {
            setForm({ mode: 'edit', id: n.id, values: noteEditValues(n, lines, allocations) });
            setOpenId(null);
          }} />
      )}
      {form && <NoteForm mode={form.mode} id={form.id} kinds={page.kinds} initial={form.values} scan={form.scan} scanFiles={form.files} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); setOpenId(id); }} />}
    </div>
  );
};

const NOTE_COLUMNS: Column<CreditNote>[] = [
  { key: 'number', label: 'Number', render: (n) => <span className={cancelledDocNoClass(n.status)} style={{ fontVariantNumeric: 'tabular-nums' }}>{n.note_number}</span>, getValue: (n) => n.note_number },
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
  { key: 'journal', label: 'Journal', render: (n) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{n.je_no ?? '—'}</span>, getValue: (n) => n.je_no ?? '' },
];

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
    {label}
    {children}
  </label>
);

/** One note's reads and its two writes — the pop-out and the page share them. */
export function useNoteDoc(id: string) {
  const q = useCreditNoteDetail(id);
  const navigate = useNavigate();
  const post = usePostCreditNote();
  const cancel = useCancelCreditNote();
  const askConfirm = useConfirm();
  const n = q.data?.note;
  const lines = q.data?.lines ?? [];
  /* A supplier or other-debtor note shows each line's event (owner 2026-10-22); any note that carries one does. */
  const eventLabelsQ = useEventLabels(lines.map((l) => l.project_id ?? null));
  const withEvents = (n != null && knocksOff(n.kind)) || lines.some((l) => l.project_id != null);
  const busy = post.isPending || cancel.isPending;
  const failed = post.isError ? post.error : cancel.isError ? cancel.error : null;
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const printOne = async () => {
    if (!n || printing) return;
    setPrinting(true); setPrintError(null);
    try {
      const [{ generateCreditNotePdf, knockedOffOf }, nameOf] = await Promise.all([import('../../vendor/scm/lib/credit-note-pdf'), accountNamer()]);
      await generateCreditNotePdf(n, lines, nameOf, { action: 'print', knockedOff: q.data ? knockedOffOf(q.data) : null });
    } catch (e) { setPrintError(errText(e)); } finally { setPrinting(false); }
  };
  /* What a customer note knocked off, named in its cancel ask (the design's words). */
  const knockedSis = (q.data?.allocations ?? []).filter((a) => a.kind === 'SI' && a.appliedSen > 0).map((a) => a.number ?? 'an invoice');
  const cancelNote = async () => {
    if (!n) return;
    const yes = await askConfirm({
      title: `Cancel ${n.note_number}?`,
      body: n.status === 'POSTED'
        ? `Its journal is reversed by a contra dated today. The note stays on file as cancelled.${knockedSis.length > 0 ? ` Its knock-off against ${knockedSis.join(', ')} is undone.` : ''}`
        : 'The draft stays on file as cancelled.',
      confirmLabel: 'Cancel note', danger: true,
    });
    if (yes) cancel.mutate(n.id);
  };
  /* A posted customer note's Knock off — its own form on Money in's notes, back to this page. A
     note answering a deposit invoice has none. */
  const knockOff = n && n.kind === 'CN' && n.status === 'POSTED' && !q.data?.depositPaper
    ? () => navigate(`/scm/credit-notes?form=knock&id=${encodeURIComponent(n.id)}&back=note`) : null;
  return { q, n, lines, allocations: q.data?.allocations ?? [], post, cancel, eventLabelsQ, withEvents, busy, failed, printing, printError, printOne, cancelNote, knockOff };
}
export type NoteDoc = ReturnType<typeof useNoteDoc>;

/** The note's buttons: Print, Edit (draft), Post to ledger (draft), Cancel note. */
export function NoteActions({ doc, onEdit }: { doc: NoteDoc; onEdit: (n: CreditNote, lines: CreditNoteLine[], allocations: CreditAllocation[]) => void }) {
  const { n, busy } = doc;
  if (!n) return null;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => void doc.printOne()} disabled={busy || doc.printing}>{doc.printing ? 'Preparing…' : 'Print'}</Button>
      {n.status === 'DRAFT' && <Button variant="ghost" size="sm" onClick={() => onEdit(n, doc.lines, doc.allocations)} disabled={busy}>Edit</Button>}
      {n.status === 'DRAFT' && <Button size="sm" onClick={() => doc.post.mutate(n.id)} disabled={busy}>{doc.post.isPending ? 'Posting…' : 'Post to ledger'}</Button>}
      {/* An opening paper is changed on Opening Balance — the server refuses a cancel here. */}
      {n.status !== 'CANCELLED' && !n.opening && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void doc.cancelNote()}>
          Cancel note
        </Button>
      )}
    </>
  );
}

/** The note itself: party, dates, reference, status, reason, lines, its knock-off, files, and what the last write said. */
export function NoteBody({ doc }: { doc: NoteDoc }) {
  const { n, lines, withEvents, eventLabelsQ, post, failed } = doc;
  if (!n) return null;
  return (
    <div className="space-y-3">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
        <div><div style={soft}>Party</div>{n.party_name ?? '—'}{(n.party_code ?? n.debtor_code) ? <span style={soft}> · {n.party_code ?? n.debtor_code}</span> : null}</div>
        <div><div style={soft}>Date</div>{fmtDateOrDash(n.note_date)}</div>
        <div><div style={soft}>Reference</div>{[n.so_doc_no, n.source_doc_no].filter(Boolean).join(' · ') || '—'}</div>
        {(n.purchase_invoice_number || n.ap_invoice_number) && <div><div style={soft}>Credits</div>{n.purchase_invoice_number ?? n.ap_invoice_number}</div>}
        <div><div style={soft}>Status</div><StatusPill status={n.status} />{n.je_no ? <span style={soft}> · {n.je_no}</span> : null}</div>
        <div style={{ gridColumn: '1 / -1' }}><div style={soft}>Reason</div>{n.reason ?? '—'}</div>
      </div>
      {n.opening && (
        <div style={soft} aria-label="Opening balance">
          Opening balance 31/08, from AutoCount — its amount is changed on Finance › Opening Balance. Tick the supplier&apos;s bills under Knock off to use it.
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>#</th><th style={th}>Description</th><th style={th}>Account</th>{withEvents && <th style={th}>Event</th>}<th style={{ ...th, textAlign: 'right' }}>Amount</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}><td style={td}>{l.line_no}</td><td style={td}>{l.description ?? '—'}</td><td style={td}>{l.account_code}</td>
              {withEvents && <td style={{ ...td, ...(l.project_id == null ? soft : {}) }}>{eventCellText(eventLabelsQ.data, l.project_id)}</td>}
              <td style={{ ...td, ...num }}>{fmtSen(l.amount_sen)}</td></tr>
          ))}
          <tr><td colSpan={withEvents ? 4 : 3} style={{ ...td, fontWeight: 700 }}>Total</td><td style={{ ...td, ...num, fontWeight: 700 }}>{fmtSen(n.total_sen)}</td></tr>
        </tbody>
      </table>
      {knocksOff(n.kind) && n.status !== 'CANCELLED' && <NoteKnockOff noteId={n.id} posted={n.status === 'POSTED'} totalSen={n.total_sen} who={whoOf(n.kind)} />}
      {n.kind === 'CN' && (
        <CustomerKnockOffSection note={n} allocations={doc.allocations}
          depositLine={depositPaperLine(doc.q.data?.depositPaper ?? null, doc.q.data?.closedInvoice ?? null)} onKnockOff={doc.knockOff} />
      )}
      <NoteFilesCard noteId={n.id} locked={n.status === 'POSTED'} closed={n.status === 'CANCELLED'} />
      {post.isSuccess && (
        <div style={{ fontSize: 'var(--fs-13)', color: good }}>
          Posted as {post.data.jeNo}.
          {(post.data.applied ?? []).map((a) => ` ${fmtSen(a.appliedSen)} came off ${a.number}.`).join('')}
          {post.data.notApplied ? ` ${post.data.notApplied}` : ''}
        </div>
      )}
      {doc.printError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{doc.printError}</div>}
      {failed != null && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{errText(failed)}</div>}
    </div>
  );
}

/** A note in its pop-out — Print, Edit, Post, Cancel, Knock off, files. The note page (NotePage.tsx) shows the same parts. */
export const NoteDetail = ({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (n: CreditNote, lines: CreditNoteLine[], allocations: CreditAllocation[]) => void }) => {
  const doc = useNoteDoc(id);
  const n = doc.n;
  return (
    <Modal title={n ? `${KIND_WORD[n.kind]} ${n.note_number}` : 'Note'} onClose={onClose} width="min(820px, 100%)" ariaLabel="Credit or debit note"
      actions={n && (
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <NoteActions doc={doc} onEdit={onEdit} />
        </div>
      )}>
      {doc.q.isLoading && <div style={soft}>Loading…</div>}
      <NoteBody doc={doc} />
    </Modal>
  );
};

/* The party pickers, each reading its own list only when its kind is on the form. */
const SupplierField = ({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled: boolean }) => {
  const suppliersQ = useSuppliers();
  const options = useMemo(() => (suppliersQ.data ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` })), [suppliersQ.data]);
  return (
    <Field label="Supplier">
      <SearchCombo options={options} value={value} onChange={onChange} disabled={disabled} aria-label="Supplier" placeholder="— type to search suppliers —" />
    </Field>
  );
};
/* The Other Debtors registry's active debtors; the one a draft was raised to stays shown on its edit. */
const DebtorField = ({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled: boolean }) => {
  const debtorsQ = useOtherDebtors();
  const options = useMemo(
    () => (debtorsQ.data?.debtors ?? []).filter((d) => d.is_active || d.id === value).map((d) => ({ value: d.id, label: d.code ? `${d.name} · ${d.code}` : d.name })),
    [debtorsQ.data, value],
  );
  return (
    <Field label="Other debtor">
      <SearchCombo options={options} value={value} onChange={onChange} disabled={disabled} aria-label="Other debtor" placeholder="— type to search other debtors —" />
    </Field>
  );
};

/** The note form — the pop-out by default; `inline` renders it in place of a
 *  page (Money in's Credit / debit notes, batch 5 step 7), where the page's own
 *  switch picks the kind. `onSaved` hears the note's id, its number when it
 *  was raised here, and whether it was posted. */
export const NoteForm = ({ mode, id, kinds, initial, scan, scanFiles, inline = false, onClose, onSaved }: {
  mode: 'new' | 'edit'; id?: string; kinds: NoteKind[]; initial: FormValues; scan?: ScnScan; scanFiles?: File[]; inline?: boolean;
  onClose: () => void; onSaved: (id: string, done?: { number: string | null; posted: boolean }) => void;
}) => {
  const [v, setV] = useState<FormValues>(initial);
  const uploadFile = useUploadCreditNoteFile();
  const [attachError, setAttachError] = useState<string | null>(null);
  const accountsQ = useAccounts();
  const rolesQ = useAccountRoles();
  const create = useCreateCreditNote();
  const update = useUpdateCreditNote();
  const post = usePostCreditNote();
  const leaves = useMemo(() => leafAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  const totalSen = v.lines.reduce((s, l) => { const p = lineSen(l); return s + (p.ok ? p.sen : 0); }, 0);
  const badAmount = amountProblem(v.lines);
  const busy = create.isPending || update.isPending || post.isPending;
  const failed = create.isError ? create.error : update.isError ? update.error : post.isError ? post.error : null;
  const setLine = (rid: number, patch: Partial<FormLine>) => setV((p) => ({ ...p, lines: p.lines.map((l) => (l.rid === rid ? { ...l, ...patch } : l)) }));
  const fromReturn = v.kind === 'CN' && !!v.deliveryReturnId;
  /* A returned line's units: the amount follows the invoiced unit price when it is known. */
  const setReturnQty = (l: FormLine, qty: number) => {
    if (!l.ret) return;
    setLine(l.rid, { ret: { ...l.ret, qty }, ...(l.ret.unitSen != null ? { amountRm: (Math.round(l.ret.unitSen * qty) / 100).toFixed(2) } : {}) });
  };
  /* An other debtor's credit has no default account — each money line names its own (the server refuses one without). */
  const accountsNamed = v.kind !== 'OCN' || v.lines.every((l) => l.amountRm.trim() === '' || l.accountCode !== '');
  const partyId = v.kind === 'OCN' ? v.debtorId ?? '' : v.supplierId;
  const canSave = badAmount === null && totalSen > 0 && v.noteDate !== '' && accountsNamed && (knocksOff(v.kind)
    ? partyId !== '' && pickSen(v.knockOff ?? {}) <= totalSen
    : (v.soDocNo.trim() !== '' || v.partyName.trim() !== '') && pickSen(v.knockOff ?? {}) <= totalSen);
  const withEvents = knocksOff(v.kind);
  /* What a blank account means (f1): a customer's note lands on the SALES_RETURNS
     role (510-0000 Return inwards); a supplier's on its kind's default; an other
     debtor's has none. */
  const blankAccount = (() => {
    if (v.kind === 'OCN') return '— pick the account —';
    if (v.kind === 'SCN') return '— default for this kind —';
    const code = rolesQ.data?.roles.SALES_RETURNS ?? '510-0000';
    const name = (accountsQ.data?.accounts ?? []).find((a) => a.account_code === code)?.account_name;
    return `— Default · ${code}${name ? ` ${name}` : ''} —`;
  })();

  /* Save as draft, or Save & post (the redesign): the same save, then the post. */
  const save = async (postAfter = false) => {
    try {
      const body = bodyOf(v);
      let noteId = id ?? '';
      let number: string | null = null;
      if (mode === 'new') {
        const r = await create.mutateAsync(body);
        noteId = r.note.id;
        number = r.note.note_number;
        /* The scanned pages go with the note they became. */
        for (const f of scanFiles ?? []) {
          try {
            await uploadFile.mutateAsync({ noteId, file: { name: f.name, mime: docFileMime(f), dataBase64: await fileToBase64(f) } });
          } catch (e) { setAttachError(`${f.name} did not attach — ${errText(e)}`); }
        }
      } else if (id) {
        await update.mutateAsync({ id, noteDate: body.noteDate, reason: body.reason, sourceDocNo: body.sourceDocNo, lines: body.lines, ...(body.allocations ? { allocations: body.allocations } : {}) });
      }
      if (postAfter && noteId) await post.mutateAsync(noteId);
      onSaved(noteId, { number, posted: postAfter });
    } catch { /* the hook holds the error; it is shown below */ }
  };

  const body = (
      <div className="space-y-3" aria-label={inline ? 'Note form' : undefined}>
        {scan && <ScanPanel scan={scan} />}
        {fromReturn && (
          <div role="note" aria-label="From a delivery return" style={{ border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            From delivery return <strong>{v.returnNumber ?? ''}</strong>
            {v.invoiceNumber ? <> — each line credits returned units at what invoice <strong>{v.invoiceNumber}</strong> charged for them</> : ' — each line credits returned units at the invoiced price'}.
            {' '}A line cannot credit more units than came back, or more than the invoice charged. Tick the invoice under Knock off to take the credit off what the customer still owes.
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3)' }}>
          {/* In place of a page, the page's own switch picks the kind. */}
          {!inline && (
            <Field label="Kind">
              {/* Switching kind drops the ticks — they were another party's documents. */}
              <select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as NoteKind, knockOff: {} })} disabled={mode === 'edit'} aria-label="Kind" style={input}>
                {(kinds.includes(v.kind) ? kinds : [v.kind, ...kinds]).map((k) => <option key={k} value={k}>{KIND_OPTION[k]}</option>)}
              </select>
            </Field>
          )}
          <Field label="Date"><DateField value={v.noteDate} onChange={(d) => setV({ ...v, noteDate: d })} aria-label="Note date" /></Field>
          {v.kind === 'SCN' ? (
            <SupplierField value={v.supplierId} disabled={mode === 'edit'} onChange={(s) => setV({ ...v, supplierId: s, knockOff: s === v.supplierId ? v.knockOff : {} })} />
          ) : v.kind === 'OCN' ? (
            <DebtorField value={v.debtorId ?? ''} disabled={mode === 'edit'} onChange={(d) => setV({ ...v, debtorId: d, knockOff: d === v.debtorId ? v.knockOff : {} })} />
          ) : (
            <>
              <Field label="Sales order (the customer comes from it)">
                <input value={v.soDocNo} onChange={(e) => setV({ ...v, soDocNo: e.target.value, knockOff: {} })} placeholder="2990-SO-2607-019" aria-label="Sales order" style={input} disabled={mode === 'edit' || fromReturn} />
              </Field>
              <Field label="or customer name">
                <input data-upper value={v.partyName} onChange={(e) => setV({ ...v, partyName: e.target.value, knockOff: {} })} placeholder="when there is no order" aria-label="Customer name" style={input} disabled={mode === 'edit' || fromReturn || v.soDocNo.trim() !== ''} />
              </Field>
            </>
          )}
          <Field label="Reference (return, invoice, complaint)">
            <input value={v.sourceDocNo} onChange={(e) => setV({ ...v, sourceDocNo: e.target.value })} placeholder="DR-2609-001" aria-label="Reference" style={input} />
          </Field>
          <Field label="Reason">
            <input data-upper value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="why this note" aria-label="Reason" style={input} />
          </Field>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Description</th><th style={th}>{v.kind === 'OCN' ? 'Account (each line names one)' : 'Account (blank = the kind\'s default)'}</th>{withEvents && <th style={th}>Event</th>}{fromReturn && <th style={{ ...th, textAlign: 'right' }}>Units</th>}<th style={{ ...th, textAlign: 'right' }}>Amount (RM)</th><th style={th} /></tr></thead>
          <tbody>
            {v.lines.map((l) => (
              <tr key={l.rid}>
                <td style={td}><input data-upper value={l.description} onChange={(e) => setLine(l.rid, { description: e.target.value })} aria-label={`Line ${l.rid} description`} style={{ ...input, minWidth: 220 }} /></td>
                <td style={td}><AccountSelect accounts={leaves} value={l.accountCode} onChange={(code) => setLine(l.rid, { accountCode: code })} placeholder={blankAccount} /></td>
                {/* The event the line's money is for (owner 2026-10-22). Credited
                    against an AP invoice, a blank line takes the invoice's. */}
                {withEvents && (
                  <td style={{ ...td, minWidth: 220 }}>
                    <EventSelect value={l.projectId} around={v.noteDate || null} onChange={(id) => setLine(l.rid, { projectId: id })}
                      placeholder={v.creditedDoc?.kind === 'API' ? '— the AP invoice’s event —' : '— No event —'} aria-label={`Line ${l.rid} event`} />
                  </td>
                )}
                {fromReturn && (
                  <td style={{ ...td, ...num }}>
                    {l.ret ? (
                      <input type="number" min={1} max={l.ret.maxQty ?? undefined} step={1} value={l.ret.qty} disabled={l.ret.maxQty == null}
                        onChange={(e) => setReturnQty(l, Math.max(1, Math.min(l.ret?.maxQty ?? Infinity, Math.floor(Number(e.target.value) || 1))))}
                        aria-label={`Line ${l.rid} units`} style={{ ...input, minWidth: 70, width: 70, textAlign: 'right' }} />
                    ) : '—'}
                    {l.ret?.maxQty != null && <div style={soft}>of {l.ret.maxQty}</div>}
                  </td>
                )}
                <td style={{ ...td, ...num }}><input type="text" inputMode="decimal" value={l.amountRm} onChange={(e) => setLine(l.rid, { amountRm: e.target.value })} aria-label={`Line ${l.rid} amount`} style={{ ...input, minWidth: 120, textAlign: 'right' }} /></td>
                <td style={td}>
                  {v.lines.length > 1 && (
                    <button type="button" onClick={() => setV({ ...v, lines: v.lines.filter((x) => x.rid !== l.rid) })} aria-label={`Remove line ${l.rid}`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-muted)' }}><X size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={(withEvents ? 3 : 2) + (fromReturn ? 1 : 0)} style={td}>
                {/* A note from a return credits the return's lines only. */}
                {!fromReturn && <AddLineButton variant="ghost" onClick={() => setV({ ...v, lines: [...v.lines, emptyLine(Math.max(0, ...v.lines.map((x) => x.rid)) + 1)] })} />}
              </td>
              <td style={{ ...td, ...num, fontWeight: 700 }}>{fmtSen(totalSen)}</td>
              <td style={td} />
            </tr>
          </tbody>
        </table>
        {badAmount && <div role="alert" style={{ color: danger, fontSize: 'var(--fs-13)' }}>{badAmount}</div>}

        {knocksOff(v.kind) && (
          <FormKnockOff who={whoOf(v.kind)} partyId={partyId} noteId={mode === 'edit' ? id : undefined} totalSen={totalSen}
            pick={v.knockOff ?? {}} onChange={(knockOff) => setV((p) => ({ ...p, knockOff }))} />
        )}
        {/* A customer's credit knocks off the customer's sales invoices — the sales order's customer, else the name. */}
        {v.kind === 'CN' && (
          <FormKnockOff who="customer" partyId={v.soDocNo.trim() || v.partyName.trim()} by={v.soDocNo.trim() ? 'so' : 'name'}
            partyName={v.soDocNo.trim() && mode !== 'edit' ? null : v.partyName} noteId={mode === 'edit' ? id : undefined} totalSen={totalSen}
            pick={v.knockOff ?? {}} onChange={(knockOff) => setV((p) => ({ ...p, knockOff }))} />
        )}
        {v.kind === 'OCN' && !accountsNamed && <div style={soft}>Pick an account on every line — an other debtor's credit note has no default account.</div>}

        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{inline ? 'Cancel' : 'Close'}</Button>
          <Button variant="secondary" size="sm" onClick={() => void save()} disabled={!canSave || busy}>{busy ? 'Saving…' : mode === 'new' ? 'Save as draft' : 'Save changes'}</Button>
          <Button size="sm" onClick={() => void save(true)} disabled={!canSave || busy}>Save & post</Button>
        </div>
        {failed != null && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{errText(failed)}</div>}
        {attachError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>{attachError}</div>}
      </div>
  );
  if (inline) return body;
  return (
    <Modal title={mode === 'new' ? (scan ? 'New note — from the scanned credit note' : 'New note') : `Edit ${initial.kind}`} onClose={onClose} width="min(900px, 100%)" ariaLabel="Note form">
      {body}
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
