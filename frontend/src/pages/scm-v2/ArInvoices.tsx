// ----------------------------------------------------------------------------
// Invoices — /scm/ar-invoices, the money owed to the company on one page (the
// owner's Claude Design, batch 5 §3; AutoCount's A/R Invoice).
//
// Two pages became one. The SALES INVOICES (a read-only mirror: raised and
// edited on Sales, never here) and the OTHER DEBTOR BILLS raised here (owner
// 2026-09-29: 开 other debtor 的 bill 就直接在 ar invoice 页面) were AR
// invoices; the DEPOSIT INVOICES — one per customer payment before the final
// invoice, born off the payment when the company's switch is on (docs/bugs/
// 0828) — were their own page at /scm/deposit-invoices, which now opens this
// one on their kind. The switch itself moved to Setup › Deposit invoices; its
// two backlogs (payments without a deposit invoice; delivered orders without a
// final invoice) sit at the head of this page with their buttons.
//
// The design's list: kind segments and status chips with counts, the party
// filter (`?debtor=` from the registry), the search, a sand tint on whatever
// is still owed, the row's next step as its button and the rest under ⋯ (or a
// right-click); ticks gather a batch — Post to ledger, Print. The bill form
// opens in place of the list (`?form=new|copy|edit`). Header ⋯ → Print listing
// prints exactly what the table shows.
//
// Nothing posts differently: Post to ledger is POST /deposit-invoices/:id/post
// (one by one for a batch), Cancel the DI's cancel with its reason, Issue them
// now and Invoice them now their own routes; a bill posts through
// /other-debtors as before. Each kind shows to whoever saw its old Sidebar
// entry; the server's checks are unchanged.
//
// `docKind="DN"`: the other debtors' debit notes alone, inside the Credit /
// debit notes page (no header, no backlog) — New debit note raises one.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, MoreHorizontal, Plus, Printer, Send, Truck } from 'lucide-react';
import { useAccounts, useCancelDebtorBill, useOtherDebtors } from '../../vendor/scm/lib/accounting-queries';
import { useArInvoices, type ArListRow } from '../../vendor/scm/lib/ar-invoice-queries';
import {
  fetchDepositInvoiceSheets, useCancelDepositInvoice, useDepositInvoiceSettings, useDepositInvoices, useInvoiceDeliveredOrders,
  useIssueMissingDepositInvoices,
} from '../../vendor/scm/lib/deposit-invoice-queries';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { generateArListingPdf } from '../../vendor/scm/lib/ar-invoice-listing-pdf';
import { deliverPdfBlob, type PdfAction } from '../../vendor/scm/lib/pdf-common';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useToastOptional } from '../../hooks/useToast';
import { fmtDate, fmtSen, todayMY } from '../../vendor/shared/format';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { AskBanner, type Ask } from './money-in/AskBanner';
import { BillFormPage } from './money-in/BillFormPage';
import { BatchBar, Chips, SearchBox, Segments, StatusTag, tidyMenu, useRowMenu, type MenuItem } from './money-in/MoneyInParts';
import { liveJournal, useDocJournals } from './money-in/moneyInDocQueries';
import { openRowStyle } from './money-in/moneyInStatus';
import { useMoneyInGates } from './money-in/moneyInGates';
import { batchTitle, useMoneyInPrint } from './money-in/moneyInPrint';
import {
  arItem, depositItem, inInvoiceChip, inInvoiceKind, invoiceChips, invoiceHref, invoiceKindLabel, invoiceKindTag,
  matchesInvoice, newestInvoiceFirst, readInvoiceChip, readInvoiceKind, type InvoiceItem, type InvoiceKindPick,
} from './money-in/invoicesModel';
import ui from './MoneyIn.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
const DIVIDER: MenuItem = { label: '', onClick: () => undefined, divider: true };
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export const ArInvoices = ({ docKind }: { docKind?: 'DN' } = {}) => {
  const debitNotes = docKind === 'DN';
  const [params, setParams] = useSearchParams();
  const openInTab = useOpenDocInTab();
  const qc = useQueryClient();
  const toast = useToastOptional();
  const { can } = useHouzsAuth();
  const gates = useMoneyInGates();
  const canCreate = can('scm.payment_voucher.create');
  const canWrite = can('scm.payment_voucher.write') || canCreate;
  const canCancel = can('scm.payment_voucher.cancel');
  const canPost = can('scm.payment_voucher.post');
  /* Deposit invoices show to whoever saw their old entry; sales invoices and bills to AR invoices' (batch 5 §1). */
  const showDeposits = gates.paperKeys && !debitNotes;
  const showAr = gates.createKeys;

  const kind = debitNotes ? 'bill' : readInvoiceKind(params.get('kind'));
  const chip = readInvoiceChip(params.get('status'));
  const form = params.get('form');
  const setUrl = (patch: Record<string, string | null>, push = false) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace: !push });

  /* The Deposit invoices page's exact order filter (`?so=`) seeds the search. */
  const [q, setQ] = useState(() => params.get('so') ?? '');
  const [party, setParty] = useState(() => { const d = params.get('debtor'); return d ? `D:${d}` : ''; });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<InvoiceItem[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [headMenu, setHeadMenu] = useState(false);

  const arQ = useArInvoices(debitNotes ? 'ODB' : 'ALL', debitNotes ? 'DN' : undefined);
  const diQ = useDepositInvoices('ALL', '', showDeposits);
  const settingsQ = useDepositInvoiceSettings(showDeposits);
  const debtorsQ = useOtherDebtors();
  const accountsQ = useAccounts();
  const issue = useIssueMissingDepositInvoices();
  const invoiceDelivered = useInvoiceDeliveredOrders();
  const cancelDi = useCancelDepositInvoice();
  const cancelBill = useCancelDebtorBill();

  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);
  const today = todayMY();
  const items = useMemo<InvoiceItem[]>(() => [
    ...(showAr ? (arQ.data?.rows ?? []).filter((r) => !debitNotes || r.docKind === 'DN').map((r) => arItem(r, today)) : []),
    ...(showDeposits ? (diQ.data?.rows ?? []).map(depositItem) : []),
  ], [showAr, arQ.data, debitNotes, today, showDeposits, diQ.data]);

  /* The party filter: the customers and debtors on the list, plus every active
     debtor off the registry, so `?debtor=` always names one. */
  const partyOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of debtorsQ.data?.debtors ?? []) if (d.is_active) seen.set(`D:${d.id}`, d.code ? `${d.code} · ${d.name}` : d.name);
    for (const x of items) if (x.partyKey && x.billTo !== '—') seen.set(x.partyKey, x.ar?.partyCode ? `${x.ar.partyCode} · ${x.billTo}` : x.billTo);
    return [{ value: '', label: 'All customers and debtors' }, ...[...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))];
  }, [debtorsQ.data, items]);
  const partyName = party ? partyOptions.find((o) => o.value === party)?.label ?? null : null;

  /* Counts follow the chip (the design: the kinds count what the chip shows). */
  const base = useMemo(() => items.filter((x) => (!party || x.partyKey === party) && matchesInvoice(x, q)), [items, party, q]);
  const list = useMemo(() => base.filter((x) => inInvoiceKind(x, kind) && inInvoiceChip(x, chip)).sort(newestInvoiceFirst), [base, kind, chip]);

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['ar-invoices'] });
    void qc.invalidateQueries({ queryKey: ['deposit-invoices'] });
    void qc.invalidateQueries({ queryKey: ['journal-entries'] });
  };

  /* Post to ledger (one or a batch): the deposit invoice's own post route, one
     by one; the first refusal stops the run, verbatim. */
  const postDeposits = async (rows: InvoiceItem[]) => {
    const targets = rows.filter((x) => x.kind === 'di' && x.status === 'notposted');
    if (targets.length === 0 || busy) return;
    setBusy('post'); setFailure(null);
    const done: Array<{ key: string; no: string; je: string }> = [];
    try {
      for (const x of targets) {
        const res = await authedFetch<{ ok: boolean; jeNo: string }>(`/deposit-invoices/${encodeURIComponent(x.id)}/post`, { method: 'POST', body: '{}' });
        done.push({ key: x.key, no: x.no, je: res.jeNo });
      }
    } catch (e) {
      setFailure(errText(e));
    } finally {
      setBusy(null);
      refreshAll();
      if (done.length > 0) {
        setTicked((p) => { const n = new Set(p); for (const d of done) n.delete(d.key); return n; });
        toast?.success(done.length === 1 ? `${done[0]!.no} posted · ${done[0]!.je}` : `${done.length} deposit invoices posted`);
      }
    }
  };

  /* Print: each document as it prints — a sales invoice the Sales print (f4),
     a debtor bill its own, a deposit invoice its A4 sheet — ONE document in
     list order, through the print dialog (batch 5 step 10). */
  const deliverPrint = async (rows: InvoiceItem[], action: PdfAction) => {
    if (rows.length === 0 || busy) return;
    setBusy('print'); setFailure(null);
    try {
      const ar = rows.filter((x) => x.ar).map((x) => x.ar as ArListRow);
      const dis = rows.filter((x) => x.di);
      if (ar.length > 0) {
        const { arInvoicesPdfBlob } = await import('../../vendor/scm/lib/ar-invoice-print');
        deliverPdfBlob(await arInvoicesPdfBlob(ar, accountName), `invoices-${myt()}.pdf`, action);
      }
      if (dis.length > 0) {
        const sheets = await fetchDepositInvoiceSheets(dis.map((x) => x.id));
        const { generateDepositInvoicesPdf } = await import('../../vendor/scm/lib/deposit-invoice-pdf');
        await generateDepositInvoicesPdf(sheets, { action });
      }
    } catch (e) {
      setFailure(errText(e));
    } finally { setBusy(null); }
  };

  const printer = useMoneyInPrint((e) => setFailure(errText(e)));
  const print = (rows: InvoiceItem[]) => {
    if (rows.length === 0) return;
    printer.open({
      title: rows.length > 1 ? batchTitle(rows.length, false) : rows[0]!.kind === 'si' ? 'Sales invoice' : rows[0]!.kind === 'di' ? 'Deposit invoice' : rows[0]!.debitNote ? 'Debit note' : 'Debtor bill',
      docNo: rows.length > 1 ? `${rows.length} ticked` : rows[0]!.no,
      papers: ['A4'],
      rows: rows.length === 1 ? [{ label: 'Bill to', value: rows[0]!.billTo }, { label: 'Amount', value: fmtSen(rows[0]!.totalSen) }] : [],
      deliver: (action) => deliverPrint(rows, action),
    });
  };

  /* Ask: cancel a deposit invoice (a reason), or a bill. */
  const [asking, setAsking] = useState<InvoiceItem | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  /* A bill's journal, named in its Cancel ask (a deposit invoice carries its own). */
  const askJournals = useDocJournals('ODB', asking?.kind === 'bill' ? asking.no : null);
  const askLive = liveJournal(askJournals.data);
  const ask: Ask | null = !asking ? null : asking.kind === 'di' ? {
    title: `Cancel ${asking.no}?`,
    body: `${asking.journal ? `Its journal ${asking.journal} is reversed by a contra dated today. ` : ''}It stays on file as cancelled and prints as void with your reason.`,
    tone: 'undo', goLabel: 'Cancel invoice', reason: { placeholder: 'Why? e.g. payment keyed twice' },
    onGo: (reason) => {
      setAskError(null);
      const no = asking.no;
      cancelDi.mutate({ id: asking.id, reason }, {
        onSuccess: () => { refreshAll(); setAsking(null); toast?.success(`${no} cancelled · journal reversed`); },
        onError: (e) => setAskError(errText(e)),
      });
    },
  } : {
    title: `Cancel ${asking.no}?`,
    body: (asking.ar?.paidSen ?? 0) > 0 ? 'This bill has money received on it, so it can’t be cancelled.'
      : `Its journal ${askLive ? `${askLive.je_no} ` : ''}is reversed. It stays on file as cancelled.`,
    tone: 'undo', goLabel: asking.debitNote ? 'Cancel debit note' : 'Cancel bill', canGo: (asking.ar?.paidSen ?? 0) <= 0,
    onGo: () => {
      setAskError(null);
      const no = asking.no;
      cancelBill.mutate(asking.id, {
        onSuccess: () => { refreshAll(); setAsking(null); toast?.success(`${no} cancelled · journal reversed`); },
        onError: (e) => setAskError(errText(e)),
      });
    },
  };

  const openRow = (x: InvoiceItem) => openInTab(invoiceHref(x));
  const openForm = (mode: 'new' | 'copy' | 'edit', id?: string) => setUrl({ form: mode, id: id ?? null }, true);

  const menuOf = (x: InvoiceItem): MenuItem[] => {
    const open: MenuItem = { label: 'Open', onClick: () => openRow(x) };
    const printIt: MenuItem = { label: 'Print', onClick: () => print([x]) };
    const order = x.forHref ? [{ label: `Open ${x.forText}`, onClick: () => openInTab(x.forHref!) }] : [];
    switch (x.kind) {
      case 'si': return tidyMenu([open, ...order, DIVIDER, printIt]);
      case 'di':
        return tidyMenu([
          open,
          ...(x.status === 'notposted' && canPost ? [{ label: 'Post to ledger', onClick: () => { void postDeposits([x]); } }] : []),
          ...order, DIVIDER, printIt, DIVIDER,
          ...(x.status === 'open' || x.status === 'notposted') && canCancel ? [{ label: 'Cancel…', danger: true, onClick: () => { setAskError(null); setAsking(x); } }] : [],
        ]);
      case 'bill':
        return tidyMenu([
          open,
          ...(!x.cancelled && canWrite ? [{ label: 'Edit', onClick: () => openForm('edit', x.id) }] : []),
          ...(canCreate ? [{ label: 'Copy as new', onClick: () => openForm('copy', x.id) }] : []),
          DIVIDER, printIt, DIVIDER,
          ...(!x.cancelled && canCancel && (x.ar?.paidSen ?? 0) <= 0
            ? [{ label: x.debitNote ? 'Cancel debit note…' : 'Cancel bill…', danger: true, onClick: () => { setAskError(null); setAsking(x); } }] : []),
        ]);
    }
  };
  const rowMenu = useRowMenu<InvoiceItem>(menuOf, (x) => x.no);

  const actionsOf = (x: InvoiceItem): ReactNode => {
    const main = x.kind === 'di' && x.status === 'notposted' && canPost
      ? <button type="button" className={ui.act} disabled={busy != null} onClick={(e) => { e.stopPropagation(); void postDeposits([x]); }}>Post to ledger</button>
      : <button type="button" className={ui.actLink} disabled={busy != null} onClick={(e) => { e.stopPropagation(); print([x]); }}>Print</button>;
    return <span className={ui.acts}>{main}{rowMenu.button(x)}</span>;
  };

  const columns: Column<InvoiceItem>[] = [
    { key: 'no', label: 'No.', render: (x) => <FinanceDocLink to={invoiceHref(x)} className={cancelledDocNoClass(x.cancelled ? 'CANCELLED' : x.status)}>{x.no}</FinanceDocLink>, getValue: (x) => x.no },
    { key: 'kind', label: 'Kind', render: (x) => <StatusTag tag={invoiceKindTag(x)} />, getValue: (x) => invoiceKindTag(x).text },
    { key: 'date', label: 'Date', render: (x) => <span className={ui.muted}>{fmtDate(x.date)}</span>, getValue: (x) => x.date, exportFormat: 'date' },
    { key: 'billTo', label: 'Bill to', render: (x) => x.billTo, getValue: (x) => x.billTo },
    {
      key: 'for', label: 'For',
      render: (x) => (x.forHref ? <FinanceDocLink to={x.forHref}>{x.forText}</FinanceDocLink> : <span className={ui.muted}>{x.forText}</span>),
      getValue: (x) => x.forText,
    },
    {
      key: 'total', label: 'Total', align: 'right',
      render: (x) => (x.cancelled ? <span className={ui.muted}>—</span> : <span className={ui.money}>{fmtSen(x.totalSen)}</span>),
      getValue: (x) => x.totalSen, exportValue: (x) => x.totalSen / 100, exportFormat: 'money',
      total: (rows) => fmtSen(rows.filter((x) => !x.cancelled).reduce((s, x) => s + x.totalSen, 0)),
    },
    {
      /* What customers' credit notes knocked off a sales invoice (owner 2026-11-03:
         「要」) — kept apart from what was paid; a bill's own credit notes sit in
         what it received. */
      key: 'creditNotes', label: 'Credit notes', align: 'right',
      render: (x) => (x.kind === 'si' && !x.cancelled && (x.ar?.creditNotesSen ?? 0) > 0
        ? <span className={ui.money}>{fmtSen(x.ar!.creditNotesSen)}</span>
        : <span className={ui.muted}>—</span>),
      getValue: (x) => (x.kind === 'si' ? x.ar?.creditNotesSen ?? 0 : null),
      exportValue: (x) => (x.kind === 'si' ? (x.ar?.creditNotesSen ?? 0) / 100 : null), exportFormat: 'money',
      total: (rows) => fmtSen(rows.reduce((s, x) => s + (x.kind === 'si' && !x.cancelled ? x.ar?.creditNotesSen ?? 0 : 0), 0)),
    },
    {
      key: 'outstanding', label: 'Outstanding', align: 'right',
      /* The SI list's own figure; when the order's deposit settles part of it the cell says so. */
      render: (x) => (x.outstandingSen == null ? <span className={ui.muted}>—</span> : (
        <span className={ui.money} title={(x.ar?.depositAppliedSen ?? 0) > 0 ? `${fmtSen(x.ar!.depositAppliedSen)} was collected on ${x.ar!.ref ?? 'the sales order'} and settles this invoice.` : undefined}>
          {fmtSen(x.outstandingSen)}{(x.ar?.depositAppliedSen ?? 0) > 0 && <span className={ui.under}>deposit applied</span>}
        </span>
      )),
      getValue: (x) => x.outstandingSen, exportValue: (x) => (x.outstandingSen == null ? null : x.outstandingSen / 100), exportFormat: 'money',
      total: (rows) => fmtSen(rows.reduce((s, x) => s + (x.outstandingSen ?? 0), 0)),
    },
    { key: 'status', label: 'Status', render: (x) => <StatusTag tag={x.tag} />, getValue: (x) => x.tag.text },
    { key: 'journal', label: 'Journal', defaultHidden: true, render: (x) => x.journal ?? '—', getValue: (x) => x.journal ?? '' },
    {
      key: 'closedBy', label: 'Closed by', defaultHidden: true,
      render: (x) => (x.kind !== 'di' ? '—' : (
        <span>{x.closedBy ?? '—'}{(x.di?.refunded_sen ?? 0) > 0 && <span className={ui.under}>refunded {fmtSen(x.di!.refunded_sen ?? 0)}</span>}</span>
      )),
      getValue: (x) => x.closedBy ?? '',
    },
    { key: 'actions', label: '', align: 'right', width: '170px', disableSort: true, disableFilter: true, render: actionsOf },
  ];

  if (form === 'new' || form === 'copy' || form === 'edit') {
    return (
      <BillFormPage mode={form} id={params.get('id')} debtorId={party.startsWith('D:') ? party.slice(2) : ''}
        docKind={debitNotes || params.get('docKind') === 'DN' ? 'DN' : undefined}
        backLabel={debitNotes ? 'Credit / debit notes' : 'Invoices'}
        onClose={() => setUrl({ form: null, id: null, docKind: null }, true)}
        openDoc={(href) => openInTab(href)} />
    );
  }

  const kinds: InvoiceKindPick[] = [
    ...(showAr || showDeposits ? ['all' as const] : []),
    ...(showAr ? ['si' as const] : []),
    ...(showDeposits ? ['di' as const] : []),
    ...(showAr ? ['bill' as const] : []),
  ];
  const segments = kinds.map((k) => ({ value: k, label: invoiceKindLabel(k), count: base.filter((x) => inInvoiceKind(x, k) && inInvoiceChip(x, chip)).length }));
  const chips = invoiceChips().map(([c, label]) => ({ value: c, label, count: base.filter((x) => inInvoiceKind(x, kind) && inInvoiceChip(x, c)).length }));

  const onScreen = shown ?? list;
  const tickedShown = onScreen.filter((x) => ticked.has(x.key));
  const hidden = items.filter((x) => ticked.has(x.key)).length - tickedShown.length;
  const tickedUnposted = tickedShown.filter((x) => x.kind === 'di' && x.status === 'notposted');
  const tickedSum = tickedShown.filter((x) => !x.cancelled).reduce((s, x) => s + x.totalSen, 0);

  const settings = settingsQ.data?.settings;
  const missing = settingsQ.data?.missingCount ?? 0;
  const delivered = settingsQ.data?.deliveredUninvoicedCount ?? 0;
  const readFailures = [
    showAr && arQ.isError ? `The sales invoices and bills did not load — ${errText(arQ.error)}` : null,
    showDeposits && diQ.isError ? `The deposit invoices did not load — ${errText(diQ.error)}` : null,
  ].filter((t): t is string => t != null);
  const loading = (showAr && arQ.isLoading) || (showDeposits && diQ.isLoading);
  const printListing = () => {
    const rows = onScreen.filter((x) => x.ar).map((x) => x.ar as ArListRow);
    void generateArListingPdf(rows, { kind: kind === 'si' ? 'SI' : kind === 'bill' ? 'ODB' : 'ALL', partyName }).catch((e: unknown) => setFailure(errText(e)));
  };

  return (
    <div className={ui.page}>
      {!debitNotes && (
        <PageHeader eyebrow="Finance · Money in" title="Invoices"
          actions={(
            <span className={ui.topRow}>
              {canCreate && <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => openForm('new')}><Plus size={14} /> New debtor bill</button>}
              <span style={{ position: 'relative' }}>
                <button type="button" className={ui.more} aria-label="More" title="More" onClick={() => setHeadMenu((v) => !v)}><MoreHorizontal size={14} /></button>
                {headMenu && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 79 }} onClick={() => setHeadMenu(false)} aria-hidden />
                    <div className={ui.menu} role="menu" aria-label="More" style={{ position: 'absolute', right: 0, top: 30 }}>
                      <button type="button" role="menuitem" className={ui.menuItem} onClick={() => { setHeadMenu(false); printListing(); }}
                        disabled={onScreen.every((x) => !x.ar)}>
                        Print listing
                      </button>
                    </div>
                  </>
                )}
              </span>
            </span>
          )} />
      )}

      {/* The switch's backlogs, at the head of the page (the switch is in Setup). */}
      {showDeposits && settings?.enabled && missing > 0 && (
        <div className={ui.backlog}>
          <AlertCircle size={15} className={ui.checkBad} />
          <span className={ui.grow}>{missing} {missing === 1 ? 'payment' : 'payments'} dated from {fmtDate(settings.fromDate)} still without a deposit invoice.</span>
          <button type="button" className={ui.btn} disabled={issue.isPending || !canPost}
            onClick={() => issue.mutate(undefined, {
              onSuccess: (r) => { refreshAll(); toast?.success(`Issued ${r.issued.length}${r.issued.length > 0 ? `: ${r.issued.join(', ')}` : ''}${r.skipped.length > 0 ? ` · ${r.skipped.length} skipped (${r.skipped.map((s) => s.why).join(', ')})` : ''}`); },
              onError: (e) => setFailure(errText(e)),
            })}>
            <Send size={14} /> {issue.isPending ? 'Issuing…' : 'Issue them now'}
          </button>
        </div>
      )}
      {showDeposits && settings?.enabled && delivered > 0 && (
        <div className={ui.backlog}>
          <Truck size={15} />
          <span className={ui.grow}>{delivered} delivered {delivered === 1 ? 'order' : 'orders'} still without a final invoice. Each is invoiced on the day its goods left; its deposit invoices are then closed by a credit note each.</span>
          <button type="button" className={ui.btn} disabled={invoiceDelivered.isPending || !canPost}
            title={missing > 0 ? 'Issue the deposit invoices first' : undefined}
            onClick={() => {
              if (missing > 0) { toast?.info('Issue the deposit invoices first'); return; }
              invoiceDelivered.mutate(undefined, {
                onSuccess: (r) => {
                  refreshAll();
                  toast?.success(`Invoiced ${r.invoiced.length} ${r.invoiced.length === 1 ? 'order' : 'orders'}${r.skipped.length > 0 ? ` · ${r.skipped.length} skipped (${r.skipped.map((s) => `${s.docNo}: ${s.why}`).join(', ')})` : ''}`);
                },
                onError: (e) => setFailure(errText(e)),
              });
            }}
            style={missing > 0 ? { opacity: 0.55 } : undefined}>
            {invoiceDelivered.isPending ? 'Invoicing…' : 'Invoice them now'}
          </button>
        </div>
      )}
      {showDeposits && settingsQ.isError && <div role="alert" className={`${ui.hint} ${ui.checkBad}`}>The deposit invoice switch was not read — {errText(settingsQ.error)}</div>}

      <div className={ui.stack}>
        <div className={ui.toolbar}>
          {segments.length > 2 && (
            <Segments label="Kind of invoice" value={kind} options={segments}
              onChange={(k) => { setUrl({ kind: k === 'all' ? null : k }); setTicked(new Set()); }} />
          )}
          {debitNotes && canCreate && (
            <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => setUrl({ form: 'new', docKind: 'DN' }, true)}><Plus size={14} /> New debit note</button>
          )}
          <span className={ui.grow} />
          <div style={{ width: 260, maxWidth: '100%' }}>
            <SearchCombo options={partyOptions} value={party} onChange={(v) => { setParty(v); setTicked(new Set()); }}
              className={ui.formInput} aria-label="Filter by customer or debtor" placeholder="All customers and debtors" />
          </div>
          <SearchBox value={q} onChange={(v) => { setQ(v); setTicked(new Set()); }} placeholder="Find an invoice · no., customer, debtor, order, amount" />
        </div>
        <Chips label="Status" value={chip} options={chips}
          onChange={(c) => { setUrl({ status: c === 'any' ? null : c }); setTicked(new Set()); }} />
        {ask && <AskBanner key={ask.title} ask={ask} busy={cancelDi.isPending || cancelBill.isPending} error={askError} onKeep={() => setAsking(null)} />}
        {failure && <div role="alert" className={`${ui.hint} ${ui.checkBad}`}>{failure}</div>}
        {readFailures.map((t) => <div key={t} role="alert" className={`${ui.hint} ${ui.checkBad}`}>{t}</div>)}

        <DataTable<InvoiceItem>
          tableId={debitNotes ? 'other-debtor-debit-notes' : 'mi-invoices'}
          exportName={debitNotes ? 'other-debtor-debit-notes' : 'invoices'}
          exportXlsx
          columns={columns}
          rows={loading ? null : list}
          loading={loading}
          error={readFailures.length > 0 && items.length === 0 ? readFailures.join(' ') : null}
          emptyLabel="No invoice matches this filter."
          getRowKey={(x) => x.key}
          getRowClassName={(x) => cancelledRowClass(x.cancelled ? 'CANCELLED' : x.status)}
          getRowStyle={(x) => openRowStyle(x.kind !== 'di' && x.status === 'open')}
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
            {tickedUnposted.length > 0 && canPost && (
              <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={busy != null} onClick={() => { void postDeposits(tickedUnposted); }}>
                {busy === 'post' ? 'Posting…' : `Post to ledger · ${tickedUnposted.length}`}
              </button>
            )}
            <button type="button" className={ui.btn} disabled={busy != null} onClick={() => print(tickedShown)}>
              <Printer size={14} /> {busy === 'print' ? 'Preparing…' : `Print ${tickedShown.length}`}
            </button>
          </BatchBar>
        )}
      </div>
      {rowMenu.popup}
      {printer.modal}
    </div>
  );
};
