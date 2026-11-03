// ----------------------------------------------------------------------------
// MoneyInNotes — Money in › Credit / debit notes, /scm/credit-notes (owner
// 2026-09-12: 这个要做; the two pages split 2026-10-28; the owner's Claude
// Design, batch 5 §5). A customer's credit and debit notes, an other debtor's
// credit note (it knocks off the debtor's bills) and an other debtor's debit
// note (a bill of its own kind, received like a bill) on ONE list: All · Credit
// notes · Debit notes, status chips with counts, the search, what an other
// debtor's credit knocks off, the row's next step as its button and the rest
// under ⋯ (or a right-click); ticks gather a batch — Post to ledger, Print.
// A row opens the note's page (NotePage) or the debit note's bill page.
//
// The form opens in place of the list (`?form=new|copy|edit`): the note form
// Money out and the note page use (CreditNotes.tsx NoteForm, `inline`), the
// kind picked by the page's switch — Credit note / Debit note, Customer /
// Other debtor; an other debtor's debit note is Invoices' bill form (DN).
//
// Nothing posts differently: Save is POST / PATCH /credit-notes and Post to
// ledger POST /credit-notes/:id/post (one by one for a batch, the first
// refusal stops it); Cancel is the note's cancel (a contra once posted, its
// knock-off given back first) or the bill's; an other debtor's debit note is
// POST /other-debtors/:id/bills {docKind: 'DN'}. The supplier's notes stay on
// Money out (/scm/supplier-notes, CreditNotes.tsx side AP).
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileDown, Plus, Printer } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useArInvoices } from '../../../vendor/scm/lib/ar-invoice-queries';
import {
  useCancelCreditNote, useCreditNoteDetail, useCreditNotes, type CreditNote, type CreditNoteLine, type NoteKind,
} from '../../../vendor/scm/lib/credit-note-queries';
import { useCancelDebtorBill } from '../../../vendor/scm/lib/accounting-queries';
import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import type { PdfAction } from '../../../vendor/scm/lib/pdf-common';
import { DataTable, type Column } from '../../../components/DataTable';
import { PageHeader } from '../../../components/Layout';
import { cancelledDocNoClass, cancelledRowClass } from '../../../lib/scm';
import { useOpenDocInTab } from '../../../lib/openDocInTab';
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';
import { useToastOptional } from '../../../hooks/useToast';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import { FinanceDocLink } from '../finance/FinanceDocLink';
import { NoteForm, emptyForm, noteEditValues } from '../CreditNotes';
import { AskBanner, type Ask } from './AskBanner';
import { BillFormPage } from './BillFormPage';
import { DocFormShell } from './MoneyInDocPage';
import { BatchBar, Chips, SearchBox, Segments, StatusTag, tidyMenu, useRowMenu, type MenuItem } from './MoneyInParts';
import {
  debitBillItem, inNoteChip, inNoteSegment, matchesNote, newestNoteFirst, noteChips, noteHref, noteItem, noteSegments,
  readNoteChip, readNoteSegment, type NoteItem,
} from './notesModel';
import ui from '../MoneyIn.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
const DIVIDER: MenuItem = { label: '', onClick: () => undefined, divider: true };
const BACK = 'Credit / debit notes';
type NoteType = 'credit' | 'debit';
type NoteParty = 'customer' | 'debtor';

/* The chart's names for the print (docs/bugs/0834) — read when a print is asked for. */
const accountNamer = async (): Promise<(code: string) => string | null> => {
  const r = await authedFetch<{ accounts: Array<{ account_code: string; account_name: string }> }>('/accounting/accounts');
  const names = new Map(r.accounts.map((a) => [a.account_code, a.account_name]));
  return (code) => names.get(code) ?? null;
};

/** The note kind a new note's switch names (an other debtor's debit note is a bill, not a note). */
const kindOf = (type: NoteType, party: NoteParty): NoteKind => (type === 'debit' ? 'DN' : party === 'debtor' ? 'OCN' : 'CN');

export function MoneyInNotes() {
  const [params, setParams] = useSearchParams();
  const openInTab = useOpenDocInTab();
  const qc = useQueryClient();
  const toast = useToastOptional();
  const { can } = useHouzsAuth();
  /* The server's keys (credit-notes.ts; a debit note to an other debtor is a bill — other-debtors.ts). */
  const canCreate = can('scm.payment_voucher.create');
  const canWrite = can('scm.payment_voucher.write') || canCreate;
  const canPost = can('scm.payment_voucher.post');
  const canCancel = can('scm.payment_voucher.cancel');

  const segment = readNoteSegment(params.get('kind'));
  const chip = readNoteChip(params.get('status'));
  const form = params.get('form');
  const setUrl = (patch: Record<string, string | null>, push = false) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace: !push });

  const [q, setQ] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<NoteItem[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<'post' | 'print' | null>(null);

  const notesQ = useCreditNotes('AR', 'ALL', 'ALL');
  const odnQ = useArInvoices('ODB', 'DN');
  const cancelNote = useCancelCreditNote();
  const cancelBill = useCancelDebtorBill();
  const items = useMemo<NoteItem[]>(() => [
    ...(notesQ.data?.rows ?? []).map(noteItem),
    ...(odnQ.data?.rows ?? []).filter((r) => r.docKind === 'DN').map(debitBillItem),
  ], [notesQ.data, odnQ.data]);
  const base = useMemo(() => items.filter((x) => matchesNote(x, q)), [items, q]);
  const list = useMemo(() => base.filter((x) => inNoteSegment(x, segment) && inNoteChip(x, chip)).sort(newestNoteFirst), [base, segment, chip]);

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['credit-notes'] });
    void qc.invalidateQueries({ queryKey: ['ar-invoices'] });
    void qc.invalidateQueries({ queryKey: ['journal-entries'] });
  };

  /* Post to ledger (one or a batch): the note's own post route, one by one;
     the first refusal stops the run, verbatim. */
  const postNotes = async (rows: NoteItem[]) => {
    const drafts = rows.filter((x) => x.source === 'note' && x.status === 'draft');
    if (drafts.length === 0 || busy) return;
    setBusy('post'); setFailure(null);
    const done: Array<{ key: string; no: string; je: string }> = [];
    try {
      for (const x of drafts) {
        const res = await authedFetch<{ ok: boolean; jeNo: string }>(`/credit-notes/${encodeURIComponent(x.id)}/post`, { method: 'POST', body: '{}' });
        done.push({ key: x.key, no: x.no, je: res.jeNo });
      }
    } catch (e) {
      setFailure(errText(e));
    } finally {
      setBusy(null);
      refreshAll();
      if (done.length > 0) {
        setTicked((p) => { const n = new Set(p); for (const d of done) n.delete(d.key); return n; });
        toast?.success(done.length === 1 ? `${done[0]!.no} posted · ${done[0]!.je}` : `${done.length} notes posted`);
      }
    }
  };

  /* Print: the notes as ONE document in list order (credit-note-pdf); an other
     debtor's debit note prints as the bill it is (ar-invoice-print). */
  const print = async (rows: NoteItem[], action: PdfAction = 'print') => {
    if (rows.length === 0 || busy) return;
    setBusy('print'); setFailure(null);
    try {
      const notes = rows.filter((x) => x.note);
      const bills = rows.flatMap((x) => (x.bill ? [x.bill] : []));
      const nameOf = await accountNamer();
      if (notes.length > 0) {
        const [{ generateCreditNotesPdf }, details] = await Promise.all([
          import('../../../vendor/scm/lib/credit-note-pdf'),
          Promise.all(notes.map((x) => authedFetch<{ note: CreditNote; lines: CreditNoteLine[] }>(`/credit-notes/${encodeURIComponent(x.id)}`))),
        ]);
        await generateCreditNotesPdf(details.map((d) => ({ header: d.note, lines: d.lines })), nameOf, { action });
      }
      if (bills.length > 0) {
        const [{ arInvoicesPdfBlob }, { deliverPdfBlob }] = await Promise.all([
          import('../../../vendor/scm/lib/ar-invoice-print'), import('../../../vendor/scm/lib/pdf-common'),
        ]);
        deliverPdfBlob(await arInvoicesPdfBlob(bills, nameOf), 'debit-notes.pdf', action);
      }
    } catch (e) {
      setFailure(errText(e));
    } finally { setBusy(null); }
  };

  /* Cancel, asked inline: a note's (a contra once posted, its knock-off given
     back first), or an other debtor's debit note — a bill, refused once money came in. */
  const [asking, setAsking] = useState<NoteItem | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const askCancel = (x: NoteItem) => { setAskError(null); setAsking(x); };
  const ask: Ask | null = !asking ? null : asking.source === 'bill' ? {
    title: `Cancel ${asking.no}?`,
    body: 'Its journal is reversed by a contra dated today. The debit note stays on file as cancelled.',
    tone: 'undo', goLabel: 'Cancel note',
    onGo: () => {
      setAskError(null);
      const no = asking.no;
      cancelBill.mutate(asking.id, {
        onSuccess: () => { refreshAll(); setAsking(null); toast?.success(`${no} cancelled · journal reversed`); },
        onError: (e) => setAskError(errText(e)),
      });
    },
  } : {
    title: `Cancel ${asking.no}?`,
    body: asking.status === 'posted'
      ? `Its journal is reversed by a contra dated today. The note stays on file as cancelled.${asking.knocks && asking.knocks.appliedSen > 0 ? ' Its knock-off against the bills is undone.' : ''}`
      : 'The draft stays on file as cancelled.',
    tone: 'undo', goLabel: 'Cancel note',
    onGo: () => {
      setAskError(null);
      const no = asking.no;
      const posted = asking.status === 'posted';
      cancelNote.mutate(asking.id, {
        onSuccess: () => { refreshAll(); setAsking(null); toast?.success(posted ? `${no} cancelled · journal reversed` : `${no} cancelled`); },
        onError: (e) => setAskError(errText(e)),
      });
    },
  };

  const openRow = (x: NoteItem) => openInTab(noteHref(x));
  const openForm = (mode: 'new' | 'copy' | 'edit', x?: NoteItem) =>
    setUrl({ form: mode, id: x?.id ?? null, src: x?.source === 'bill' ? 'bill' : null, type: null, party: null }, true);
  const closeForm = () => setUrl({ form: null, id: null, src: null, type: null, party: null }, true);

  const menuOf = (x: NoteItem): MenuItem[] => {
    const open: MenuItem = { label: 'Open', onClick: () => openRow(x) };
    const printIt: MenuItem = { label: 'Print', onClick: () => { void print([x]); } };
    if (x.source === 'bill') {
      const received = (x.bill?.paidSen ?? 0) > 0;
      return tidyMenu([
        open,
        ...(!x.cancelled && canWrite ? [{ label: 'Edit', onClick: () => openForm('edit', x) }] : []),
        ...(canCreate ? [{ label: 'Copy as new', onClick: () => openForm('copy', x) }] : []),
        DIVIDER, printIt, DIVIDER,
        /* Money received on it keeps it (the bill's own rule, said on its page). */
        ...(!x.cancelled && !received && canCancel ? [{ label: 'Cancel note…', danger: true, onClick: () => askCancel(x) }] : []),
      ]);
    }
    const kind = x.note?.kind;
    return tidyMenu([
      open,
      ...(x.status === 'draft' && canWrite ? [{ label: 'Edit', onClick: () => openForm('edit', x) }] : []),
      ...(x.status === 'draft' && canPost ? [{ label: 'Post to ledger', onClick: () => { void postNotes([x]); } }] : []),
      /* An other debtor's credit comes off their bills on the note's page (its knock-off). */
      ...(x.status === 'posted' && kind === 'OCN' ? [{ label: 'Knock off', onClick: () => openRow(x) }] : []),
      ...(canCreate ? [{ label: 'Copy as new', onClick: () => openForm('copy', x) }] : []),
      DIVIDER, printIt, DIVIDER,
      /* An opening paper is changed on Opening Balance — the server refuses a cancel here. */
      ...(!x.cancelled && !x.note?.opening && canCancel ? [{ label: 'Cancel note…', danger: true, onClick: () => askCancel(x) }] : []),
    ]);
  };
  const rowMenu = useRowMenu<NoteItem>(menuOf, (x) => x.no);

  const actionsOf = (x: NoteItem): ReactNode => {
    const main = x.source === 'note' && x.status === 'draft' && canPost
      ? <button type="button" className={ui.act} disabled={busy != null} onClick={(e) => { e.stopPropagation(); void postNotes([x]); }}>Post</button>
      : <button type="button" className={ui.actLink} disabled={busy != null} onClick={(e) => { e.stopPropagation(); void print([x]); }}>Print</button>;
    return <span className={ui.acts}>{main}{rowMenu.button(x)}</span>;
  };

  const columns: Column<NoteItem>[] = [
    {
      key: 'number', label: 'Number', getValue: (x) => x.no,
      render: (x) => <FinanceDocLink to={noteHref(x)} className={cancelledDocNoClass(x.cancelled ? 'CANCELLED' : x.status)}>{x.no}</FinanceDocLink>,
    },
    {
      key: 'kind', label: 'Kind', getValue: (x) => `${x.kindWord}${x.otherDebtor ? ' · other debtor' : ''}`,
      render: (x) => <span>{x.kindWord}{x.otherDebtor && <span className={ui.muted}> · other debtor</span>}</span>,
    },
    { key: 'date', label: 'Date', render: (x) => <span className={ui.muted}>{fmtDate(x.date)}</span>, getValue: (x) => x.date, exportFormat: 'date' },
    { key: 'party', label: 'Party', render: (x) => x.party, getValue: (x) => x.party },
    { key: 'reference', label: 'Reference', render: (x) => <span className={ui.muted}>{x.reference}</span>, getValue: (x) => x.reference },
    {
      key: 'total', label: 'Total', align: 'right',
      render: (x) => (x.cancelled ? <span className={ui.muted}>—</span> : <span className={ui.money}>{fmtSen(x.totalSen)}</span>),
      getValue: (x) => x.totalSen, exportValue: (x) => x.totalSen / 100, exportFormat: 'money',
      total: (rows) => fmtSen(rows.filter((x) => !x.cancelled).reduce((s, x) => s + x.totalSen, 0)),
    },
    {
      /* What an other debtor's posted credit came off; a customer's note knocks
         off nothing yet (the sales-invoice knock-off waits for the owner, f2). */
      key: 'knock_off_amount', label: 'Knocks off',
      render: (x) => (!x.knocks ? <span className={ui.muted}>—</span>
        : x.knocks.appliedSen > 0
          ? <span>{fmtSen(x.knocks.appliedSen)}{x.knocks.leftSen > 0 && <span className={ui.under}>{fmtSen(x.knocks.leftSen)} not knocked off</span>}</span>
          : <span className={ui.muted}>Not applied</span>),
      getValue: (x) => (x.knocks ? x.knocks.appliedSen : 0),
    },
    { key: 'status', label: 'Status', render: (x) => <StatusTag tag={x.tag} />, getValue: (x) => x.tag.text },
    { key: 'journal', label: 'Journal', defaultHidden: true, render: (x) => x.journal ?? '—', getValue: (x) => x.journal ?? '' },
    { key: 'actions', label: '', align: 'right', width: '150px', disableSort: true, disableFilter: true, render: actionsOf },
  ];

  if (form === 'new' || form === 'copy' || form === 'edit') {
    const id = params.get('id');
    /* An other debtor's debit note is a bill: Invoices' bill form, its debit-note kind. */
    if (params.get('src') === 'bill' && id) {
      return <BillFormPage mode={form === 'edit' ? 'edit' : 'copy'} id={id} debtorId="" docKind="DN" backLabel={BACK} onClose={closeForm} openDoc={openInTab} />;
    }
    const type: NoteType = params.get('type') === 'debit' ? 'debit' : 'credit';
    const party: NoteParty = params.get('party') === 'debtor' ? 'debtor' : 'customer';
    const switches = form === 'new'
      ? <NoteTypeSwitch type={type} party={party} onChange={(t, p) => setUrl({ type: t === 'credit' ? null : t, party: p === 'customer' ? null : p })} />
      : null;
    if (form === 'new' && type === 'debit' && party === 'debtor') {
      return <BillFormPage mode="new" id={null} debtorId="" docKind="DN" backLabel={BACK} titleExtra={switches} onClose={closeForm} openDoc={openInTab} />;
    }
    return (
      <NoteFormPage mode={form} id={id} kind={kindOf(type, party)} switches={switches}
        onClose={closeForm} onSaved={refreshAll} openDoc={openInTab} />
    );
  }

  const segments = noteSegments().map(([s, label]) => ({
    value: s, label, count: base.filter((x) => inNoteSegment(x, s) && inNoteChip(x, chip)).length,
  }));
  const chips = noteChips().map(([c, label]) => ({ value: c, label, count: base.filter((x) => inNoteSegment(x, segment) && inNoteChip(x, c)).length }));
  const onScreen = shown ?? list;
  const tickedShown = onScreen.filter((x) => ticked.has(x.key));
  const hidden = items.filter((x) => ticked.has(x.key)).length - tickedShown.length;
  const tickedDrafts = tickedShown.filter((x) => x.source === 'note' && x.status === 'draft');
  const tickedSum = tickedShown.filter((x) => !x.cancelled).reduce((s, x) => s + x.totalSen, 0);
  const readFailures = [
    notesQ.isError ? `The notes did not load — ${errText(notesQ.error)}` : null,
    odnQ.isError ? `The other debtors' debit notes did not load — ${errText(odnQ.error)}` : null,
  ].filter((t): t is string => t != null);
  const loading = notesQ.isLoading || odnQ.isLoading;

  return (
    <div className={ui.page}>
      <PageHeader eyebrow="Finance · Money in" title="Credit / debit notes"
        actions={canCreate ? <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => openForm('new')}><Plus size={14} /> New note</button> : undefined} />
      <div className={ui.stack}>
        <div className={ui.toolbar}>
          <Segments label="Kind of note" value={segment} options={segments}
            onChange={(s) => { setUrl({ kind: s === 'all' ? null : s }); setTicked(new Set()); }} />
          <span className={ui.grow} />
          <SearchBox value={q} onChange={(v) => { setQ(v); setTicked(new Set()); }} placeholder="Find a note · no., order, customer, reference" />
        </div>
        <Chips label="Status" value={chip} options={chips}
          onChange={(c) => { setUrl({ status: c === 'any' ? null : c }); setTicked(new Set()); }} />
        {ask && <AskBanner key={ask.title} ask={ask} busy={cancelNote.isPending || cancelBill.isPending} error={askError} onKeep={() => setAsking(null)} />}
        {failure && <div role="alert" className={`${ui.hint} ${ui.checkBad}`}>{failure}</div>}
        {readFailures.length > 0 && items.length > 0 && readFailures.map((t) => <div key={t} role="alert" className={`${ui.hint} ${ui.checkBad}`}>{t}</div>)}
        <DataTable<NoteItem>
          tableId="mi-notes"
          exportName="credit-debit-notes"
          exportXlsx
          columns={columns}
          rows={loading ? null : list}
          loading={loading}
          error={readFailures.length > 0 && items.length === 0 ? readFailures.join(' ') : null}
          emptyLabel="No notes here."
          getRowKey={(x) => x.key}
          getRowClassName={(x) => cancelledRowClass(x.cancelled ? 'CANCELLED' : x.status)}
          onRowDoubleClick={openRow}
          contextMenu={menuOf}
          onFilteredRowsChange={setShown}
          selection={{
            selectedIds: ticked,
            onToggle: (k) => setTicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
            onToggleAll: (keys, all) => setTicked((p) => { const n = new Set(p); for (const k of keys) { if (all) n.delete(k); else n.add(k); } return n; }),
            rowLabel: (x) => `Tick ${x.no}`,
          }}
        />
        {tickedShown.length > 0 && (
          <BatchBar count={tickedShown.length} sum={fmtSen(tickedSum)} hidden={hidden} onClear={() => setTicked(new Set())}>
            {tickedDrafts.length > 0 && canPost && (
              <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={busy != null} onClick={() => { void postNotes(tickedDrafts); }}>
                {busy === 'post' ? 'Posting…' : `Post to ledger · ${tickedDrafts.length}`}
              </button>
            )}
            <button type="button" className={ui.btn} disabled={busy != null} onClick={() => { void print(tickedShown); }}>
              <Printer size={14} /> {busy === 'print' ? 'Preparing…' : `Print ${tickedShown.length}`}
            </button>
            <button type="button" className={ui.btn} disabled={busy != null} onClick={() => { void print(tickedShown, 'save'); }}>
              <FileDown size={14} /> Save as PDF
            </button>
          </BatchBar>
        )}
      </div>
      {rowMenu.popup}
    </div>
  );
}

/** A new note's two switches: Credit note / Debit note, and Customer / Other debtor. */
function NoteTypeSwitch({ type, party, onChange }: { type: NoteType; party: NoteParty; onChange: (type: NoteType, party: NoteParty) => void }) {
  return (
    <span className={ui.topRow}>
      <Segments label="Credit or debit" value={type} onChange={(t) => onChange(t, party)}
        options={[{ value: 'credit' as const, label: 'Credit note' }, { value: 'debit' as const, label: 'Debit note' }]} />
      <Segments label="Who the note is to" value={party} onChange={(p) => onChange(type, p)}
        options={[{ value: 'customer' as const, label: 'Customer' }, { value: 'debtor' as const, label: 'Other debtor' }]} />
    </span>
  );
}

/* ── The note form, in place of the list (`?form=new|copy|edit`) ────────────
   CreditNotes.tsx's NoteForm, inline: POST /credit-notes (a draft) or PATCH
   /credit-notes/:id, then POST /credit-notes/:id/post on Save & post. Copy as
   new starts from the note's party and lines, dated today, nothing knocked off. */
function NoteFormPage({ mode, id, kind, switches, onClose, onSaved, openDoc }: {
  mode: 'new' | 'copy' | 'edit';
  id: string | null;
  kind: NoteKind;
  switches: ReactNode;
  onClose: () => void;
  onSaved: () => void;
  openDoc: (href: string) => void;
}) {
  const toast = useToastOptional();
  const detailQ = useCreditNoteDetail(mode === 'new' ? null : id);
  const d = detailQ.data;
  const n = d?.note;
  const initial = useMemo(() => {
    if (mode === 'new') return emptyForm(kind);
    if (!d) return null;
    const values = noteEditValues(d.note, d.lines, mode === 'copy' ? [] : d.allocations ?? []);
    return mode === 'copy' ? { ...values, noteDate: emptyForm(d.note.kind).noteDate, knockOff: {} } : values;
  }, [mode, kind, d]);
  const title = mode === 'edit' ? `Edit ${n?.note_number ?? ''}` : mode === 'copy' ? `New note · copy of ${n?.note_number ?? ''}` : 'New note';
  /* A posted or cancelled note is not edited here (the server refuses it too). */
  const locked = mode === 'edit' && n != null && n.status !== 'DRAFT';

  return (
    <DocFormShell title={mode !== 'new' && !n ? 'Note' : title} backLabel={BACK} onBack={onClose} titleExtra={switches} bare>
      {!initial || locked
        ? (
          <div className={ui.hint} role={detailQ.isError || locked ? 'alert' : undefined}>
            {locked ? `${n.note_number} is ${n.status === 'POSTED' ? 'posted' : 'cancelled'} — only a draft changes.`
              : detailQ.isError ? `The note did not load — ${errText(detailQ.error)}` : 'Loading the note…'}
          </div>
        )
        : (
          <div className={ui.formCard}>
            <NoteForm key={`${mode}-${initial.kind}-${id ?? ''}`} inline mode={mode === 'edit' ? 'edit' : 'new'} id={mode === 'edit' ? n?.id : undefined}
              kinds={[initial.kind]} initial={initial} onClose={onClose}
              onSaved={(noteId, done) => {
                onSaved();
                const no = done?.number ?? n?.note_number ?? '';
                toast?.success(done?.posted ? `${no} saved and posted` : mode === 'edit' ? `${no} saved` : `${no} saved as Draft`);
                onClose();
                if (mode !== 'edit' && noteId) openDoc(`/scm/credit-notes/${encodeURIComponent(noteId)}`);
              }} />
          </div>
        )}
    </DocFormShell>
  );
}
