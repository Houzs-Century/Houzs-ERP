// ----------------------------------------------------------------------------
// AP Invoices — /scm/ap-invoices, the Finance side's supplier bills.
//
// The owner's design (2026-09-06, AutoCount in hand), confirmed line by line:
// 可以不可以像 autocount 这样 purchase invoice 一边,然后再多一个 AP invoice …
// 我想要两个都看到, 现有的 purchase invoice remain. So: ONE table, a Kind
// column — the operational purchase invoices as a read-only mirror (they are
// raised and edited on Procurement → Purchase Invoices, which this page never
// touches; a row links there) beside the AP INVOICES raised HERE (rent, a
// service, an other creditor's bill — Draft → Post → paid down by the same AP
// Payment → Paid, or Cancelled). Lines pick their own accounts; posting books
// Dr each line / Cr the supplier's AP control by its code.
//
// The bill's paper (owner 2026-09-06: 做,附件也一起做,bundle 也带上): the form
// READS a bill with the voucher's own OCR (supplier match, number, dates,
// lines; the account from vendor memory only) and attaches the read pages on
// save; the detail shows the shared Files card; the AP Payment's print bundle
// carries these files after the voucher's own.
//
// Round 2 (same evening, screenshots in hand): the supplier box wears the
// form's own input dress, the lines are a table in HIS order — account
// number, description, amount — the bill carries an overall Description that
// the list shows, the list filters by supplier, and Print listing prints what
// the list shows.
//
// Round 3 (same night): a bill OPENS OVER the list (我点开时他是跑上去,我希望是
// pop out 出来) instead of pushing a card in above it; every field can be
// EDITED, a posted bill re-posting; a bill can be COPIED; the one form behind
// New / Edit / Copy lives in ApInvoiceForm.tsx (Insert adds a line, amounts
// read 1,800.00).
//
// Supplier debit notes (owner 2026-10-28: Supplier & Other Creditor CN / DN — 再加
// supplier DN): a DN is an AP invoice of its own kind (series {co}SDN-), listed
// here as "Supplier DN" beside the bills it is paid with; `docKind="DN"` is this
// same page narrowed to them, shown on the CN / DN page's Debit notes tab.
//
// The redesign (owner's Claude Design, batch 4 step 5): Money out › Supplier
// bills — the list is SupplierBillsList.tsx (kind tabs incl. the suppliers'
// credit notes, Trade / Other filter, status chips, ticks, row buttons).
// Step 6: a bill opens as its own page (ApBillPage.tsx, /scm/ap-invoices/:id)
// and a note as its own (NotePage.tsx, /scm/supplier-notes/:id); `?open=`
// lands there. New / Edit / Copy from the list keep the form over the list.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, Copy, FileText, Plus, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useAccounts, postableAccounts, type Account } from '../../vendor/scm/lib/accounting-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import {
  useApInvoices, useApInvoiceDetail, useCreateApInvoice, useUpdateApInvoice, usePostApInvoice, useCancelApInvoice,
  useApInvoiceFiles, useUploadApInvoiceFile, useDeleteApInvoiceFile, fetchApInvoiceFileBlobUrl,
  type ApListRow, type ApInvoiceHeader, type ApInvoiceLine,
} from '../../vendor/scm/lib/ap-invoice-queries';
import { fileToBase64, PV_FILE_ACCEPT, useExtractRequestBill, type PvFilePayload, type BillExtraction, type ExtractedBill, type VendorMemory } from '../../vendor/scm/lib/payment-voucher-queries';
import { useCancelCreditNote, usePostCreditNote, useScanSupplierCreditNote, type ScnScan } from '../../vendor/scm/lib/credit-note-queries';
import { docFileMime } from '../../vendor/scm/lib/doc-file-mime';
import { NoteForm, emptyForm as emptyNoteForm, fromScan, type FormValues as NoteFormValues } from './CreditNotes';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import mo from './MoneyOut.module.css';
import { SupplierBillsList, type BillAction } from './SupplierBillsList';
import { BillPlanDialog } from './BillPlanDialog';
import { listingRowOf, type BillRow } from './supplier-bills';
import { usePaymentRequest } from '../../vendor/scm/lib/payment-request-queries';
import { takePvFiles } from '../../vendor/scm/lib/pv-file-handoff';
import { generateApListingPdf, listingRowOfAp } from '../../vendor/scm/lib/ap-invoice-listing-pdf';
import { DocFilesCard } from '../../vendor/scm/components/DocFilesCard';
import { Modal } from '../../vendor/scm/components/Modal';
import { BackToPile } from '../../vendor/scm/components/BackToPile';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fmtSen, fmtDateOrDash, todayMY } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { humaniseStatusKey } from '../../vendor/scm/lib/status-pill';
import { DataTable, type Column } from '../../components/DataTable';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import { ApInvoiceForm, emptyApForm, formFromExtraction, formFromRequest, scanNoteFor, type ApFormMode, type ApFormSubmit, type ApFormValues } from './ApInvoiceForm';
import type { EventSuggestion } from '../../vendor/scm/lib/event-queries';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

const KIND_LABEL: Record<ApListRow['kind'], string> = { API: 'AP Invoice', PI: 'Purchase Invoice' };
/* A supplier's debit note is an AP invoice of its own kind — it says so. */
const kindLabelOf = (r: ApListRow): string => (r.kind === 'API' && r.docKind === 'DN' ? 'Supplier DN' : KIND_LABEL[r.kind]);
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const linkBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 };

type Detail = { invoice: ApInvoiceHeader; lines: ApInvoiceLine[]; supplier: { id: string; code: string; name: string } | null };
/** The form's values from a bill: an EDIT keeps everything, a COPY keeps the
    supplier, description and lines and starts the paper afresh — no supplier
    number, today's date, no due date, a new number on save. */
export const fromDetail = (d: Detail, copy: boolean): ApFormValues => ({
  supplierId: d.invoice.supplier_id,
  supplierRef: copy ? '' : (d.invoice.supplier_invoice_ref ?? ''),
  invoiceDate: copy ? myt() : d.invoice.invoice_date,
  dueDate: copy ? '' : (d.invoice.due_date ?? ''),
  description: d.invoice.notes ?? '',
  lines: d.lines.map((l, i) => ({ rid: i + 1, description: l.description ?? '', debitAccountCode: l.debit_account_code, amountSen: l.amount_sen, projectId: l.project_id ?? null })),
});

type FormState = {
  mode: ApFormMode; initial: ApFormValues; invoiceId?: string; invoiceNumber?: string; posted?: boolean; paidSen?: number;
  /** A new paper raised as a supplier's debit note — on the Debit notes tab, or copied from one. */
  docKind?: 'DN';
  /** A bill handed over from the pile page: its read pages and the reader's sentence. */
  scan?: { files: PvFilePayload[]; note: string; eventSuggestions?: EventSuggestion[] };
  /** The 申请付款 this new bill answers (owner 2026-09-30, 6.1). */
  request?: { id: string; no: string };
};

/** docKind="DN": the supplier debit notes alone, inside the CN / DN page (no page header of its own). */
export const ApInvoices = ({ docKind }: { docKind?: 'DN' } = {}) => {
  const debitNotes = docKind === 'DN';
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create') || can('scm.payment_voucher.write');
  const canPost = can('scm.payment_voucher.post');
  const canCancel = can('scm.payment_voucher.cancel');

  /* Supplier bills reads every kind (its own tabs narrow it); the DN view its notes. */
  const listQ = useApInvoices(debitNotes ? 'API' : 'ALL', debitNotes ? 'DN' : undefined);
  const rows = listQ.data?.rows ?? [];
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailQ = useApInvoiceDetail(detailId);
  const detail = detailQ.data;
  /* A bill, a note or a new paper opens as its own page, in a workspace tab. */
  const openInTab = useOpenDocInTab();

  /* The supplier filter (owner: supplier 筛选) — the suppliers ON the list,
     never the whole registry, so every choice shows something. */
  const [supplierFilter, setSupplierFilter] = useState('');
  const supplierOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (r.supplierId && r.supplierName) seen.set(r.supplierId, `${r.supplierCode ? `${r.supplierCode} · ` : ''}${r.supplierName}`);
    const named = [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: '', label: 'All suppliers' }, ...named];
  }, [rows]);
  const visibleRows = useMemo(() => (supplierFilter ? rows.filter((r) => r.supplierId === supplierFilter) : rows), [rows, supplierFilter]);
  /* What the table shows after its own funnels: the listing prints exactly that. */
  const [shownRows, setShownRows] = useState<ApListRow[] | null>(null);
  const filteredSupplierName = supplierFilter ? (rows.find((r) => r.supplierId === supplierFilter)?.supplierName ?? null) : null;

  const suppliersQ = useSuppliers({ status: 'ACTIVE' });
  const accountsQ = useAccounts();
  /* A line debits an ordinary LEAF: active, not a control (由模块过账) and
     not a header (父户不记账) — the same door the PV's lines walk, from the
     one home (postableAccounts, docs/bugs/0693). */
  const lineAccounts = useMemo<Account[]>(() => postableAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);

  const create = useCreateApInvoice();
  const update = useUpdateApInvoice();
  const post = usePostApInvoice();
  const cancel = useCancelApInvoice();
  const uploadFile = useUploadApInvoiceFile();

  /* The one form — New, Edit, Copy — in its own pop-out over the list. */
  const [form, setForm] = useState<FormState | null>(null);
  const openNew = () => setForm({ mode: 'new', initial: emptyApForm(), ...(debitNotes ? { docKind: 'DN' as const } : {}) });

  /* A supplier's credit note raised on Supplier bills (the redesign): the CN /
     DN page's own form, here; Scan credit note reads the pages into it. Saved,
     the note opens on its own page. */
  const [noteForm, setNoteForm] = useState<{ mode: 'new' | 'edit'; id?: string; values: NoteFormValues; scan?: ScnScan; files?: File[] } | null>(null);
  const postNote = usePostCreditNote();
  const cancelNote = useCancelCreditNote();
  const scnScan = useScanSupplierCreditNote();
  const scnInput = useRef<HTMLInputElement>(null);
  const scanCreditNote = async (picked: File[]) => {
    if (picked.length === 0) return;
    try {
      const pages: PvFilePayload[] = await Promise.all(picked.map(async (f) => ({ name: f.name, mime: docFileMime(f), dataBase64: await fileToBase64(f) })));
      const read = await scnScan.mutateAsync(pages);
      setNoteForm({ mode: 'new', values: fromScan(read), scan: read, files: picked });
    } catch (e) {
      void notify({ title: 'The credit note was not read', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* The pile page's hand-off (/scm/ap-invoices/scan → here): ONE BILL = ONE AP
     INVOICE (owner 2026-09-08: 每张单一张 ap invoice … 分出来一张一张). The
     bill's bytes ride the module stash, not location.state (pv-file-handoff.ts);
     the state is consumed once and cleared, so a refresh does not re-open it. */
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const st = location.state as { apPrefill?: { extraction: BillExtraction; supplierMatch: { id: string; name: string } | null; memory: VendorMemory | null; eventSuggestions?: EventSuggestion[] } } | null;
    if (!st?.apPrefill) return;
    const { extraction, supplierMatch, memory, eventSuggestions } = st.apPrefill;
    setForm({
      mode: 'new',
      initial: { ...emptyApForm(), ...formFromExtraction(extraction, supplierMatch, memory) },
      scan: { files: takePvFiles(), note: scanNoteFor({ extraction, supplierMatch, memory }), eventSuggestions: eventSuggestions ?? [] },
    });
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);
  /* 申请付款 answered by a bill (owner 2026-09-30, 6.1–6.2): ?fromRequest=<id>
     reads the request's own bill first, then opens the New form with what was
     asked overlaid by what the bill reads (formFromRequest). The server claims
     the request and copies its files onto the invoice on save. ?open=<id>
     opens a bill's detail — the request's link to its invoice. */
  const [searchParams, setSearchParams] = useSearchParams();
  const fromRequest = searchParams.get('fromRequest');
  const requestQ = usePaymentRequest(fromRequest);
  const extractRequest = useExtractRequestBill();
  const requestTaken = useRef<string | null>(null);
  const [readingRequest, setReadingRequest] = useState<string | null>(null);
  useEffect(() => {
    const r = requestQ.data?.request;
    if (!fromRequest || !r || requestTaken.current === fromRequest) return;
    requestTaken.current = fromRequest;
    setReadingRequest(r.request_no);
    void (async () => {
      let bill: ExtractedBill | undefined;
      let readError: string | null = null;
      try {
        bill = (await extractRequest.mutateAsync(fromRequest)).bills.at(0);
      } catch (e) {
        readError = e instanceof Error ? e.message : 'the reader failed';
      }
      const built = formFromRequest(r, bill, readError);
      setReadingRequest(null);
      setForm({ mode: 'new', initial: built.initial, request: { id: r.id, no: r.request_no }, scan: { files: [], note: built.note, eventSuggestions: built.eventSuggestions } });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromRequest, requestQ.data]);
  const openParam = searchParams.get('open');
  /* ?open=<id> (task links, the calendar, official docs, requests): the bill's own page. */
  useEffect(() => { if (openParam) navigate(`/scm/ap-invoices/${encodeURIComponent(openParam)}`, { replace: true }); }, [openParam, navigate]);
  /* Edit / Copy picked on a row: the bill's own read first, then its form —
     the pop-out stays shut in between. */
  const [pendingForm, setPendingForm] = useState<'edit' | 'copy' | null>(null);
  /* Plan date (step 7): the bill whose planned payment date is being set. */
  const [planning, setPlanning] = useState<BillRow | null>(null);
  const openEdit = (d: Detail) => setForm({
    mode: 'edit', initial: fromDetail(d, false), invoiceId: d.invoice.id, invoiceNumber: d.invoice.invoice_number,
    posted: d.invoice.status !== 'DRAFT', paidSen: Number(d.invoice.paid_sen),
  });
  /* A copy of a debit note is a debit note. */
  const openCopy = (d: Detail) => setForm({ mode: 'copy', initial: fromDetail(d, true), invoiceNumber: d.invoice.invoice_number, ...(d.invoice.doc_kind === 'DN' ? { docKind: 'DN' as const } : {}) });
  useEffect(() => {
    if (!pendingForm || !detail || detail.invoice.id !== detailId) return;
    if (pendingForm === 'edit') openEdit(detail); else openCopy(detail);
    setPendingForm(null);
    setDetailId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingForm, detail, detailId]);

  const submitForm = async (values: ApFormSubmit, pendingFiles: PvFilePayload[], opts?: { post?: boolean }) => {
    if (!form) return;
    /* Save & post: today's confirm first, so a "no" saves nothing. */
    if (opts?.post && !(await askConfirm({
      title: 'Save and post this bill?',
      body: 'Books Dr each line\'s account / Cr the supplier\'s AP control, dated by the invoice. From then on it is paid through an AP Payment.',
      confirmLabel: 'Save & post',
    }))) return;
    try {
      if (form.mode === 'edit' && form.invoiceId) {
        const res = await update.mutateAsync({ id: form.invoiceId, body: values });
        setForm(null);
        void notify({
          title: `${res.invoice.invoice_number} saved`,
          body: res.reposted ? `The bill was re-posted — the old journal got its contra and ${res.jeNo ?? 'a fresh entry'} books it as saved.` : 'The draft is updated.',
          tone: 'info',
        });
        return;
      }
      const body = form.request ? { ...values, paymentRequestId: form.request.id } : values;
      const res = await create.mutateAsync(form.docKind === 'DN' ? { ...body, docKind: 'DN' } : body);
      if (form.request) {
        setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('fromRequest'); return next; }, { replace: true });
      }
      /* Attach the scanned bill AFTER the invoice exists — sequentially, so
         sort_no (= print order) is the scan order. A failed upload never
         un-saves the bill: the notice says what still needs adding, and the
         detail's Files card takes it; nothing stays pending for the NEXT
         bill this form raises. */
      let attached = 0;
      let attachErr: string | null = null;
      for (const f of pendingFiles) {
        try {
          await uploadFile.mutateAsync({ invoiceId: res.invoice.id, file: f });
          attached += 1;
        } catch (e) {
          attachErr = e instanceof Error ? e.message : 'The file could not be uploaded.';
          break;
        }
      }
      /* Then the post, when asked: a refused post leaves the bill a draft and says why. */
      let posted: string | null = null;
      let postErr: string | null = null;
      if (opts?.post) {
        try { posted = (await post.mutateAsync(res.invoice.id)).jeNo; } catch (e) { postErr = e instanceof Error ? e.message : 'Something went wrong.'; }
      }
      setForm(null);
      openInTab(`/scm/ap-invoices/${res.invoice.id}`);
      void notify({
        title: `${res.invoice.invoice_number} ${posted ? 'posted' : 'raised'}`,
        body: [
          posted ? `${fmtSen(res.invoice.total_sen)} on the books as ${posted}.` : `${fmtSen(res.invoice.total_sen)} as a draft — post it to put it on the books.`,
          postErr ? `It was saved but not posted: ${postErr}` : null,
          form.mode === 'copy' && form.invoiceNumber ? `Copied from ${form.invoiceNumber}.` : null,
          form.request ? `It answers ${form.request.no}${res.requestFilesCopied ? ` — ${res.requestFilesCopied} file(s) from the request attached` : ''}.` : null,
          attached > 0 ? `${attached} scanned file(s) attached.` : null,
          attachErr ? `${pendingFiles.length - attached} file(s) did not attach (${attachErr}) — add them from the bill's Files card.` : null,
        ].filter(Boolean).join(' '),
        tone: attachErr || postErr ? 'error' : 'info',
      });
    } catch (e) {
      void notify({ title: 'Bill not saved', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const onPost = async (id: string, no: string) => {
    const ok = await askConfirm({
      title: `Post ${no}?`,
      body: 'Books Dr each line\'s account / Cr the supplier\'s AP control, dated by the invoice. From then on it is paid through an AP Payment.',
      confirmLabel: 'Post',
    });
    if (!ok) return;
    try {
      await post.mutateAsync(id);
    } catch (e) {
      void notify({ title: 'Post failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const onCancel = async (id: string, no: string, posted: boolean) => {
    const ok = await askConfirm({
      title: `Cancel ${no}?`,
      body: posted ? 'The journal is reversed with a contra — the ledger keeps both sides. A bill with a payment on it refuses.' : 'The draft is closed; nothing was ever posted.',
      confirmLabel: 'Cancel bill', danger: true,
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync(id);
    } catch (e) {
      void notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* Print listing (owner: print listing 功能我也想要) — exactly the rows on
     screen, kind and supplier filters applied, totalled. */
  const listingFailed = (e: unknown) => {
    void notify({ title: 'Listing not printed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
  };
  const printListing = () => {
    void generateApListingPdf((shownRows ?? visibleRows).map(listingRowOfAp), { showing: `Supplier debit notes · ${filteredSupplierName ?? 'All suppliers'}` }).catch(listingFailed);
  };
  const printBills = (bills: BillRow[], showing: string) => {
    const today = todayMY();
    void generateApListingPdf(bills.map((b) => listingRowOf(b, today)), { showing }).catch(listingFailed);
  };

  /* A supplier note posted or cancelled from its row — the same calls its pop-out makes. */
  const onPostNote = async (r: BillRow) => {
    const ok = await askConfirm({
      title: `Post ${r.number}?`,
      body: 'Books Dr the supplier\'s AP control / Cr each line\'s account, dated by the note. The bills ticked under its Knock off take the credit.',
      confirmLabel: 'Post to ledger',
    });
    if (!ok) return;
    try {
      const res = await postNote.mutateAsync(r.id);
      void notify({ title: `${r.number} posted`, body: [`Posted as ${res.jeNo}.`, ...(res.applied ?? []).map((a) => `${fmtSen(a.appliedSen)} came off ${a.number}.`), res.notApplied ?? ''].filter(Boolean).join(' '), tone: 'info' });
    } catch (e) {
      void notify({ title: 'Post failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const onCancelNote = async (r: BillRow) => {
    const ok = await askConfirm({
      title: `Cancel ${r.number}?`,
      body: r.status === 'POSTED' ? 'Its journal is reversed by a contra dated today. The note stays on file as cancelled.' : 'The draft stays on file as cancelled.',
      confirmLabel: 'Cancel note', danger: true,
    });
    if (!ok) return;
    try {
      await cancelNote.mutateAsync(r.id);
    } catch (e) {
      void notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* What a Supplier bills row asks for. A purchase invoice lives in
     Procurement; a credit note in its pop-out; an AP bill here. */
  const voucherFor = (r: BillRow) => navigate(`/scm/payment-vouchers/new?type=ap&supplier=${encodeURIComponent(r.supplierId ?? '')}&pi=${encodeURIComponent(r.id)}`);
  const onBillAct = (action: BillAction, r: BillRow) => {
    if (r.kind === 'SCN') {
      if (action === 'post') void onPostNote(r);
      else if (action === 'cancel') void onCancelNote(r);
      else openInTab(`/scm/supplier-notes/${r.id}`);
      return;
    }
    if (action === 'makeVoucher') { voucherFor(r); return; }
    if (action === 'plan') { setPlanning(r); return; }
    if (r.kind === 'PI') { navigate(`/scm/purchase-invoices/${r.id}`); return; }
    if (action === 'post') void onPost(r.id, r.number);
    else if (action === 'cancel') void onCancel(r.id, r.number, r.status !== 'DRAFT');
    else if (action === 'edit' || action === 'copy') { setPendingForm(action); setDetailId(r.id); }
    else openInTab(`/scm/ap-invoices/${r.id}`);
  };

  const apColumns = useMemo<Column<ApListRow>[]>(() => [
    { key: 'kind', label: 'Kind', render: (r) => <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600 }}>{kindLabelOf(r)}</span>, getValue: (r) => kindLabelOf(r) },
    {
      key: 'number', label: 'No.',
      render: (r) => r.kind === 'PI'
        ? <Link to={`/scm/purchase-invoices/${r.id}`} className={`${mo.docLink} ${cancelledDocNoClass(r.status)}`}>{r.invoiceNumber}</Link>
        : <button type="button" onClick={() => openInTab(`/scm/ap-invoices/${r.id}`)} className={`${mo.docLink} ${cancelledDocNoClass(r.status)}`}>{r.invoiceNumber}</button>,
      getValue: (r) => r.invoiceNumber,
    },
    {
      key: 'supplier', label: 'Supplier',
      render: (r) => <>{r.supplierName ?? '—'}{r.supplierCode ? <span style={soft}> · {r.supplierCode}</span> : null}</>,
      getValue: (r) => r.supplierName ?? '',
    },
    { key: 'ref', label: 'Ref', render: (r) => r.supplierInvoiceRef ?? '—', getValue: (r) => r.supplierInvoiceRef ?? '' },
    { key: 'description', label: 'Description', width: '260px', render: (r) => r.description ?? '—', getValue: (r) => r.description ?? '' },
    { key: 'date', label: 'Date', render: (r) => fmtDateOrDash(r.invoiceDate), getValue: (r) => r.invoiceDate, exportFormat: 'date' },
    { key: 'due', label: 'Due', render: (r) => fmtDateOrDash(r.dueDate), getValue: (r) => r.dueDate, exportFormat: 'date' },
    {
      key: 'total', label: 'Total', align: 'right', render: (r) => fmtSen(r.totalSen),
      getValue: (r) => r.totalSen, exportValue: (r) => r.totalSen / 100, exportFormat: 'money',
    },
    {
      key: 'outstanding', label: 'Outstanding', align: 'right',
      render: (r) => <span style={{ fontWeight: r.outstandingSen > 0 ? 700 : 400 }}>{fmtSen(r.outstandingSen)}</span>,
      getValue: (r) => r.outstandingSen, exportValue: (r) => r.outstandingSen / 100, exportFormat: 'money',
    },
    { key: 'status', label: 'Status', render: (r) => <span style={{ fontSize: 'var(--fs-11)' }}>{humaniseStatusKey(r.status)}</span>, getValue: (r) => r.status },
  ], []);

  const paperName = form?.docKind === 'DN' ? 'supplier debit note' : 'AP bill';
  const formTitle = form?.mode === 'edit'
    ? `Edit ${form.invoiceNumber ?? 'AP bill'}`
    : form?.mode === 'copy' ? `New ${paperName} — copied from ${form.invoiceNumber ?? 'a bill'}`
      : form?.docKind === 'DN' ? 'New supplier debit note' : 'New AP bill';

  return (
    <div className="space-y-4">
      {!debitNotes && <PageHeader
        eyebrow="Finance · Money out"
        title="Supplier bills"
        actions={canCreate || canPost || canCancel ? (
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* The bills booked twice before the server refused it: whoever can
                cancel a bill reviews them, not only whoever can raise one. */}
            <Button variant="secondary" size="sm" onClick={() => navigate('/scm/ap-invoices/duplicates')}>
              <Copy {...ICON} /> Duplicate supplier bills
            </Button>
            {canCreate && <>
            {/* The pile: many supplier bills at once, read and split one AP
                invoice each (owner 2026-09-08: scan bill 的按钮可以直接做在
                + new ap invoice 附近吗). */}
            {/* The pile kept while this tab lives (owner 2026-10-06): the bills not yet opened. */}
            <BackToPile target="ap" />
            <Button variant="secondary" size="sm" onClick={() => navigate('/scm/ap-invoices/scan')}>
              <Camera {...ICON} /> Scan bills
            </Button>
            {/* A supplier's credit note read from its pages into the New note form (the CN / DN page's scan). */}
            <input ref={scnInput} type="file" multiple accept={PV_FILE_ACCEPT} style={{ display: 'none' }} aria-label="Supplier credit note pages"
              onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ''; void scanCreditNote(picked); }} />
            <Button variant="secondary" size="sm" onClick={() => scnInput.current?.click()} disabled={scnScan.isPending}>
              <FileText {...ICON} /> {scnScan.isPending ? 'Reading the credit note…' : 'Scan credit note'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setNoteForm({ mode: 'new', values: emptyNoteForm('SCN') })}>
              <Plus {...ICON} /> New credit note
            </Button>
            <Button variant="primary" size="sm" onClick={openNew}>
              <Plus {...ICON} /> New AP bill
            </Button>
            </>}
          </span>
        ) : undefined}
      />}

      {readingRequest && <div style={soft} role="status">Reading the bill on {readingRequest}…</div>}
      {!debitNotes && (
        <SupplierBillsList
          apRows={listQ.data?.rows ?? null}
          apLoading={listQ.isLoading}
          apError={listQ.isError ? `The list could not be loaded — ${listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}` : null}
          can={{ create: canCreate, post: canPost, cancel: canCancel }}
          onAct={onBillAct}
          onPrintListing={printBills}
        />
      )}
      {debitNotes && <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Supplier debit notes — we owe the supplier more</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {canCreate && (
              <button type="button" onClick={openNew} style={linkBtn}>
                <Plus {...ICON} /> New debit note
              </button>
            )}
            <div style={{ minWidth: 260 }}>
              <SearchCombo options={supplierOptions} value={supplierFilter} onChange={setSupplierFilter}
                className={styles.fieldInput} aria-label="Filter by supplier" placeholder="All suppliers" />
            </div>
            <Button variant="secondary" size="sm" onClick={printListing} disabled={(shownRows ?? visibleRows).length === 0}>
              <Printer {...ICON} /> Print listing
            </Button>
          </div>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          {/* A refused or failed read says so — an empty sentence over a 403 hid
             docs/bugs/0648 for an afternoon. */}
          <DataTable<ApListRow>
            tableId="supplier-debit-notes"
            exportName="supplier-debit-notes"
            exportXlsx
            columns={apColumns}
            rows={listQ.data ? visibleRows : null}
            loading={listQ.isLoading}
            error={listQ.isError ? `The list could not be loaded — ${listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}` : null}
            emptyLabel={rows.length > 0
              ? 'No supplier debit note matches this supplier — pick another.'
              : 'No supplier debit note yet — New debit note raises one; it is paid through an AP Payment like a bill.'}
            getRowKey={(r) => `${r.kind}-${r.id}`}
            getRowClassName={(r) => cancelledRowClass(r.status)}
            getRowStyle={(r) => (r.status === 'CANCELLED' ? { opacity: 0.55 } : undefined)}
            onFilteredRowsChange={setShownRows}
          />
        </div>
      </section>}

      {planning && planning.kind !== 'SCN' && (
        <BillPlanDialog onClose={() => setPlanning(null)}
          bill={{ kind: planning.kind, id: planning.id, number: planning.number, supplierName: planning.supplierName, outstandingSen: planning.outstandingSen, due: planning.due, planned: planning.planned }} />
      )}
      {noteForm && (
        <NoteForm mode={noteForm.mode} id={noteForm.id} kinds={['SCN']} initial={noteForm.values} scan={noteForm.scan} scanFiles={noteForm.files}
          onClose={() => setNoteForm(null)} onSaved={(id) => { setNoteForm(null); openInTab(`/scm/supplier-notes/${id}`); }} />
      )}

      {form && (
        <Modal title={formTitle} onClose={() => setForm(null)} ariaLabel={formTitle}>
          <ApInvoiceForm
            key={`${form.mode}-${form.invoiceId ?? 'new'}${form.scan ? '-scan' : ''}`}
            mode={form.mode}
            initial={form.initial}
            initialFiles={form.scan?.files}
            initialNote={form.scan?.note}
            initialEventSuggestions={form.scan?.eventSuggestions}
            suppliers={suppliersQ.data ?? []}
            suppliersLoading={suppliersQ.isLoading}
            lineAccounts={lineAccounts}
            posted={form.posted}
            paidSen={form.paidSen}
            selfId={form.mode === 'edit' ? (form.invoiceId ?? null) : null}
            requestId={form.request?.id ?? null}
            saving={create.isPending || update.isPending || uploadFile.isPending || post.isPending}
            canPost={canPost}
            onSubmit={submitForm}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}
    </div>
  );
};

/* ── Files card — the supplier's bill behind this AP invoice (mig
   20260906T2100): the voucher's DocFilesCard bound to this document's hooks
   and rule — a bill keeps its files once an AP Payment holds it (paid, or a
   checked voucher ticks it; the server says which in `locked`), a posted
   unpaid bill may still swap a wrong file (HC-0181), a CANCELLED one takes
   no more. */
export const ApInvoiceFilesCard = ({ invoiceId, canWrite, locked, closed }: { invoiceId: string; canWrite: boolean; locked: boolean; closed: boolean }) => {
  const filesQ = useApInvoiceFiles(invoiceId);
  const upload = useUploadApInvoiceFile();
  const remove = useDeleteApInvoiceFile();
  return (
    <DocFilesCard
      files={filesQ.data?.files ?? []}
      canWrite={canWrite} locked={filesQ.data?.locked ?? locked} closed={closed}
      lockedNote=" · locked with the AP Payment that holds this bill"
      emptyNote="No files yet. A bill scanned on the New form attaches its pages here by itself; use Attach file for anything else."
      removeBody="The stored file is deleted with its row. The bill itself and its posting stay as they are."
      attachAriaLabel="Attach bill files"
      uploading={upload.isPending} removing={remove.isPending}
      onUpload={(file) => upload.mutateAsync({ invoiceId, file })}
      onRemove={(fileId) => remove.mutateAsync({ invoiceId, fileId })}
      openUrl={(fileId) => fetchApInvoiceFileBlobUrl(invoiceId, fileId)}
    />
  );
};
