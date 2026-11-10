// ----------------------------------------------------------------------------
// Receipts — /scm/receipts, every ringgit that came in, on one page (owner
// 2026-09-03: 这个月收了什么钱; the owner's Claude Design, batch 5 §2).
//
// Two pages became one. The OFFICIAL RECEIPTS — the paper a customer holds for
// one payment, born with the payment, a draft until the money is confirmed,
// numbered in its channel's series then (acc/receipts.ts) — were their own
// page at /scm/official-receipts, which now opens this one on their kind. The
// MONEY-IN list — sundry income (raised here, posts on save, 错就 void), an
// other debtor's receipts (the four layers; posted at once from here) and a
// read-only mirror of the customer payments — was this page.
//
// The design's list: kind segments with counts (the customer payments after a
// divider, never in All — they are the same money as the official receipts),
// status chips per kind, the month nav (the page opens on this month; Any
// month is one click), the search; above the table, while a month is picked,
// the month's CHECK of payments against official receipts with each row
// behind a difference and its step. The row's next step is its button and the
// rest sits under ⋯ (or a right-click); ticks gather a batch — Confirm money
// in payment-date order, Print. The receipt form opens in place of the list
// (`?form=new|copy|edit`), Back and reload included.
//
// Nothing posts differently: Confirm money is the formalise door (no journal),
// Issue receipt the ensure door, the forms POST /receipts, PATCH /receipts/:id
// and POST /other-debtors/:id/receipts {postNow} as before, Void the RCT and
// ODR contras, the four layers their own routes. Each kind shows to whoever
// saw its old Sidebar entry; the server's checks are unchanged.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Plus, Printer } from 'lucide-react';
import {
  postableAccounts, useAccounts, useCreateDebtorReceipt, useCreateReceipt, useReceiptDetail, useReceipts,
  useUpdateReceipt, useVoidReceipt, type ReceiptDetail,
} from '../../vendor/scm/lib/accounting-queries';
import { generateReceiptsPdf } from '../../vendor/scm/lib/receipt-pdf';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { generateA4ReceiptsPdf, type A4ReceiptPaper } from '../../vendor/scm/lib/receipt-a4-pdf';
import { sundryReceiptPaper } from '../../vendor/scm/lib/sundry-receipt-pdf';
import { debtorReceiptPaper } from '../../vendor/scm/lib/debtor-receipt-pdf';
import { batchTitle, useMoneyInPrint, type Paper } from './money-in/moneyInPrint';
import type { DebtorReceiptDetail } from './money-in/moneyInDocQueries';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useToastOptional } from '../../hooks/useToast';
import { fmtDate, fmtSen, todayMY } from '../../vendor/shared/format';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { AskBanner, type Ask } from './money-in/AskBanner';
import { DebtorReceiptFormPage } from './money-in/DebtorReceiptFormPage';
import { DocFormShell } from './money-in/MoneyInDocPage';
import { BatchBar, Chips, MonthNav, SearchBox, Segments, StatusTag, tidyMenu, useRowMenu, type MenuItem } from './money-in/MoneyInParts';
import { ReceiptForm, blankReceipt, receiptValuesOf, type DebtorSubmit, type SundrySubmit } from './money-in/ReceiptForm';
import { ReceiptsCheck } from './money-in/ReceiptsCheck';
import { formaliseReceiptRequest, liveJournal, useDocJournals, useEnsureReceipt, useOfficialReceipts, useReceiptsCheck } from './money-in/moneyInDocQueries';
import { moneyInDocHref } from './money-in/moneyInDocs';
import {
  chipsOf, inChip, inKind, inMonth, kindLabel, kindTag, matchesReceipt, newestFirst, officialItem, readChip, readKind,
  receiptHref, receiptItem, shiftMonth, thisMonth, type KindPick, type OfficialListRow, type ReceiptItem,
} from './money-in/receiptsModel';
import { useDebtorReceiptSteps, type DebtorStepRow } from './money-in/useDebtorReceiptSteps';
import { useMoneyInGates } from './money-in/moneyInGates';
import ui from './MoneyIn.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
const DIVIDER: MenuItem = { label: '', onClick: () => undefined, divider: true };
const isCard = (method: string | null | undefined): boolean => method === 'merchant' || method === 'installment';

export const Receipts = () => {
  const [params, setParams] = useSearchParams();
  const openInTab = useOpenDocInTab();
  const qc = useQueryClient();
  const toast = useToastOptional();
  const { can } = useHouzsAuth();
  /* Each kind shows to whoever saw its old Sidebar entry (batch 5 §1): the
     official receipts to Official receipts' keys, the rest to Receipts'. */
  const { paperKeys, createKeys } = useMoneyInGates();
  const gates = { official: paperKeys, others: createKeys };
  const canCreate = can('scm.payment_voucher.create');
  const canEdit = can('scm.payment_voucher.write') || canCreate;
  const canCancel = can('scm.payment_voucher.cancel');

  const now = thisMonth();
  const kind = readKind(params.get('kind'));
  const chip = readChip(kind, params.get('status'));
  const rawMonth = params.get('month');
  /* f6: the page opens on this month; `month=all` is Any month. */
  const month = rawMonth === 'all' ? '' : rawMonth && /^\d{4}-\d{2}$/.test(rawMonth) ? rawMonth : now;
  const form = params.get('form');
  const setUrl = (patch: Record<string, string | null>, push = false) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace: !push });

  const [q, setQ] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<ReceiptItem[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [issuing, setIssuing] = useState<string | null>(null);

  const officialQ = useOfficialReceipts<OfficialListRow>(month, gates.official);
  const checkQ = useReceiptsCheck(month, gates.official);
  const listQ = useReceipts(month || undefined);
  const accountsQ = useAccounts();
  const ensure = useEnsureReceipt();
  const steps = useDebtorReceiptSteps();
  const voidIt = useVoidReceipt();
  const [voiding, setVoiding] = useState<ReceiptItem | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);
  const voidJournals = useDocJournals('RCT', voiding?.no);

  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);

  const officialRows = useMemo(() => (gates.official ? officialQ.data?.receipts ?? [] : []), [gates.official, officialQ.data]);
  const items = useMemo<ReceiptItem[]>(() => [
    ...officialRows.map(officialItem),
    ...(gates.others ? (listQ.data?.receipts ?? []).map((r) => receiptItem(r, (code) => accountName(code) ?? code)) : []),
  ], [officialRows, gates.others, listQ.data, accountName]);

  /* Counts follow the month and the search, not the chip (the design). */
  const pool = useMemo(() => items.filter((x) => inMonth(x, month) && matchesReceipt(x, q)), [items, month, q]);
  const list = useMemo(() => pool.filter((x) => inKind(x, kind) && inChip(x, kind, chip)).sort(newestFirst), [pool, kind, chip]);

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['receipts'] });
    void qc.invalidateQueries({ queryKey: ['official-receipts'] });
    void qc.invalidateQueries({ queryKey: ['official-receipts-check'] });
    void qc.invalidateQueries({ queryKey: ['finance-todo'] });
  };

  /* Confirm money (one or a batch): each draft turns formal and takes its
     official number — the formalise door, one by one in payment-date order so
     the numbers follow the days; the first refusal stops the run, verbatim. */
  const confirmMoney = async (rows: OfficialListRow[]) => {
    const drafts = rows.filter((r) => String(r.status).toUpperCase() === 'DRAFT')
      .sort((a, b) => String(a.paid_at ?? '').localeCompare(String(b.paid_at ?? '')) || a.or_number.localeCompare(b.or_number));
    if (drafts.length === 0 || confirming) return;
    setConfirming(true); setFailure(null);
    const done: Array<{ key: string; from: string; to: string }> = [];
    try {
      for (const r of drafts) {
        const res = await formaliseReceiptRequest(r.id);
        done.push({ key: `official:${r.id}`, from: r.or_number, to: res.orNumber });
      }
    } catch (e) {
      setFailure(errText(e));
    } finally {
      setConfirming(false);
      refreshAll();
      if (done.length > 0) {
        setTicked((p) => { const n = new Set(p); for (const d of done) n.delete(d.key); return n; });
        toast?.success(done.length === 1 ? `${done[0]!.from} is formal · ${done[0]!.to}` : `${done.length} receipts formal · ${done[0]!.to} – ${done.at(-1)!.to}`);
      }
    }
  };

  /* Print (batch 5 §9.3): through the print dialog — the official receipts as
     ONE A5 file, a receipt a page; the sundry and other-debtor receipts as ONE
     A4 file after it, each read whole for its lines; list order kept. */
  const printer = useMoneyInPrint((e) => setFailure(errText(e)));
  const paperOf = async (x: ReceiptItem): Promise<A4ReceiptPaper> => {
    if (x.kind === 'sundry') {
      const d = await authedFetch<ReceiptDetail>(`/receipts/${encodeURIComponent(x.id)}`);
      return sundryReceiptPaper({ receipt: d.receipt, lines: d.lines, accountName });
    }
    const d = await authedFetch<DebtorReceiptDetail>(`/other-debtors/receipts/${encodeURIComponent(x.id)}`);
    return debtorReceiptPaper({
      receipt: d.receipt, debtor: d.debtor, accountName,
      bills: d.allocations.map((a) => ({ billNumber: a.billNumber, description: a.description, amountSen: a.amountSen })),
    });
  };
  const printReceipts = (items: ReceiptItem[]) => {
    const officials = items.flatMap((x) => (x.kind === 'official' && x.official ? [x.official] : []));
    const others = items.filter((x) => x.kind === 'sundry' || x.kind === 'debtor');
    const n = officials.length + others.length;
    if (n === 0) return;
    setFailure(null);
    const papers: Paper[] = [...(officials.length > 0 ? ['A5' as const] : []), ...(others.length > 0 ? ['A4' as const] : [])];
    printer.open({
      title: n > 1 ? batchTitle(n, true) : officials.length > 0 ? 'Official receipt' : 'Receipt',
      /* One receipt names itself; a batch says how many. */
      docNo: n > 1 ? `${n} ticked` : [...officials.map((o) => o.or_number), ...others.map((x) => x.no)].join(''),
      papers,
      rows: [
        ...(officials.length > 0 ? [{ label: 'Official receipts', value: String(officials.length) }] : []),
        ...(others.length > 0 ? [{ label: 'Other receipts', value: String(others.length) }] : []),
      ],
      deliver: async (action) => {
        setPrinting(true);
        try {
          if (officials.length > 0) await generateReceiptsPdf(officials, { action });
          if (others.length > 0) await generateA4ReceiptsPdf(await Promise.all(others.map(paperOf)), { action });
        } finally { setPrinting(false); }
      },
    });
  };

  const issue = (p: { source: string; paymentId: string; docNo: string | null; amountSen: number }) => {
    setIssuing(`${p.source}:${p.paymentId}`); setFailure(null);
    ensure.mutate({ source: p.source, paymentId: p.paymentId }, {
      onSuccess: (res) => {
        const r = res.receipt;
        toast?.success(`${r.or_number} issued for ${p.docNo ?? 'the payment'} · ${fmtSen(p.amountSen)}${String(r.status).toUpperCase() === 'FORMAL' ? ' · formal at once' : ''}`);
      },
      onError: (e) => setFailure(errText(e)),
      onSettled: () => setIssuing(null),
    });
  };

  const openRow = (x: ReceiptItem) => { const href = receiptHref(x); if (href) openInTab(href); };
  const stepRowOf = (x: ReceiptItem): DebtorStepRow => ({
    id: x.id, no: x.no, stage: x.stage ?? 'Draft', totalSen: x.amountSen,
    bankCode: x.receipt?.moneyAccount ?? '', bankName: accountName(x.receipt?.moneyAccount ?? ''),
    bills: (x.receipt?.bills ?? []).map((b) => b.no ?? '').filter(Boolean),
  });
  const openForm = (mode: 'new' | 'copy' | 'edit', id?: string) => setUrl({ form: mode, id: id ?? null, type: mode === 'new' ? 'sundry' : null }, true);
  const askVoid = (x: ReceiptItem) => { setVoidError(null); setVoiding(x); };

  const menuOf = (x: ReceiptItem): MenuItem[] => {
    const open: MenuItem = { label: 'Open', onClick: () => openRow(x) };
    switch (x.kind) {
      case 'official': {
        const r = x.official!;
        return tidyMenu([
          open,
          ...(x.status === 'draft' ? [{ label: 'Confirm money', onClick: () => { void confirmMoney([r]); } }] : []),
          ...(x.forHref ? [{ label: `Open ${x.forText}`, onClick: () => openInTab(x.forHref!) }] : []),
          DIVIDER,
          { label: 'Print', onClick: () => printReceipts([x]) },
        ]);
      }
      case 'sundry':
        return tidyMenu([
          open,
          ...(x.status === 'posted' && canEdit ? [{ label: 'Edit', onClick: () => openForm('edit', x.id) }] : []),
          ...(canCreate ? [{ label: 'Copy as new', onClick: () => openForm('copy', x.id) }] : []),
          DIVIDER,
          { label: 'Print', onClick: () => printReceipts([x]) },
          DIVIDER,
          ...(x.status === 'posted' && canCancel ? [{ label: 'Void…', danger: true, onClick: () => askVoid(x) }] : []),
        ]);
      case 'debtor': {
        const m = steps.menuOf(stepRowOf(x));
        /* A Draft or a Prepared one changes in place and keeps its stage (batch 5 step 6, c5). */
        const edit: MenuItem[] = (x.stage === 'Draft' || x.stage === 'Prepared') && canEdit
          ? [{ label: 'Edit', onClick: () => setUrl({ form: 'edit', id: x.id, type: 'debtor' }, true) }] : [];
        return tidyMenu([open, ...edit, ...m.steps, DIVIDER, { label: 'Print', onClick: () => printReceipts([x]) }, DIVIDER, ...m.undo]);
      }
      case 'customer':
        return x.forHref ? [{ label: `Open ${x.no}`, onClick: () => openInTab(x.forHref!) }] : [];
    }
  };
  const rowMenu = useRowMenu<ReceiptItem>(menuOf, (x) => x.no);

  /* The row's next step (the design's rowAct), ⋯ last. */
  const actionsOf = (x: ReceiptItem): ReactNode => {
    let main: ReactNode = null;
    if (x.kind === 'official') {
      main = x.status === 'draft'
        ? (
          <button type="button" className={ui.act} disabled={confirming} onClick={(e) => { e.stopPropagation(); void confirmMoney([x.official!]); }}
            title={isCard(x.official?.method) ? 'Card money usually turns formal when its merchant report is confirmed' : 'You have seen the money arrive'}>
            Confirm money
          </button>
        )
        : <button type="button" className={ui.actLink} disabled={printing} onClick={(e) => { e.stopPropagation(); printReceipts([x]); }}>Print</button>;
    } else if (x.kind === 'sundry') {
      main = <button type="button" className={ui.actLink} disabled={printing} onClick={(e) => { e.stopPropagation(); printReceipts([x]); }}>Print</button>;
    } else if (x.kind === 'debtor') {
      const next = steps.nextOf(stepRowOf(x));
      if (next.button) {
        const b = next.button;
        main = <button type="button" className={ui.act} disabled={steps.busy} onClick={(e) => { e.stopPropagation(); b.onClick(); }}>{b.label}</button>;
      } else if (next.waiting) {
        main = <span className={ui.waiting}>Waiting for approval</span>;
      }
    }
    return <span className={ui.acts}>{main}{rowMenu.button(x)}</span>;
  };

  const columns: Column<ReceiptItem>[] = [
    { key: 'kind', label: 'Kind', render: (x) => <StatusTag tag={kindTag(x.kind)} />, getValue: (x) => kindTag(x.kind).text },
    {
      key: 'no', label: 'No.',
      render: (x) => <FinanceDocLink to={receiptHref(x)} className={cancelledDocNoClass(x.cancelled ? 'CANCELLED' : x.status)}>{x.no}</FinanceDocLink>,
      getValue: (x) => x.no,
    },
    { key: 'date', label: 'Date', render: (x) => <span className={ui.muted}>{fmtDate(x.date)}</span>, getValue: (x) => x.date, exportFormat: 'date' },
    { key: 'from', label: 'From', render: (x) => x.from, getValue: (x) => x.from },
    {
      key: 'for', label: 'For',
      render: (x) => (x.forHref && x.forText !== '—' ? <FinanceDocLink to={x.forHref}>{x.forText}</FinanceDocLink> : <span className={ui.muted}>{x.forText}</span>),
      getValue: (x) => x.forText,
    },
    { key: 'via', label: 'Method / into', render: (x) => <span className={ui.muted}>{x.via}</span>, getValue: (x) => x.via },
    {
      key: 'amount', label: 'Amount', align: 'right',
      render: (x) => (x.cancelled ? <span className={ui.muted}>—</span> : <span className={ui.money}>{fmtSen(x.amountSen)}</span>),
      getValue: (x) => (x.cancelled ? null : x.amountSen), exportValue: (x) => (x.cancelled ? null : x.amountSen / 100), exportFormat: 'money',
      total: (rows) => fmtSen(rows.filter((x) => !x.cancelled).reduce((s, x) => s + x.amountSen, 0)),
    },
    {
      key: 'status', label: 'Status',
      render: (x) => (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
          <StatusTag tag={x.tag} />
          {x.note && <span className={ui.under}>{x.note}</span>}
        </span>
      ),
      getValue: (x) => x.tag.text,
    },
    { key: 'actions', label: '', align: 'right', width: '190px', disableSort: true, disableFilter: true, render: actionsOf },
  ];

  /* An other debtor's receipt not yet checked, changed in place (c5): the
     Debtor maintenance form — it keeps its stage; nothing posts. */
  if (form === 'edit' && params.get('type') === 'debtor') {
    return (
      <DebtorReceiptFormPage id={params.get('id')} debtorId="" backLabel="Receipts"
        onClose={() => setUrl({ form: null, id: null, type: null }, true)} openDoc={(href) => openInTab(href)} />
    );
  }
  if (form === 'new' || form === 'copy' || form === 'edit') {
    return (
      <ReceiptFormPage
        mode={form} id={params.get('id')} type={params.get('type') === 'debtor' ? 'debtor' : 'sundry'}
        onType={(t) => setUrl({ type: t })}
        onClose={() => setUrl({ form: null, id: null, type: null }, true)}
        onSaved={() => refreshAll()}
        openDoc={(href) => openInTab(href)}
      />
    );
  }

  /* The kinds this person may see, with their counts. */
  const kinds: KindPick[] = [
    ...(gates.official || gates.others ? ['all' as const] : []),
    ...(gates.official ? ['official' as const] : []),
    ...(gates.others ? ['sundry' as const, 'debtor' as const, 'customer' as const] : []),
  ];
  const segments = kinds.map((k) => ({ value: k, label: kindLabel(k), count: pool.filter((x) => inKind(x, k)).length, ruleBefore: k === 'customer' }));
  const chips = chipsOf(kind).map(([key, label]) => ({ value: key, label, count: pool.filter((x) => inKind(x, kind) && inChip(x, kind, key)).length }));

  const onScreen = shown ?? list;
  const tickedShown = onScreen.filter((x) => ticked.has(x.key));
  const hidden = items.filter((x) => ticked.has(x.key)).length - tickedShown.length;
  const tickedDrafts = tickedShown.filter((x) => x.kind === 'official' && x.status === 'draft').map((x) => x.official!);
  /* What a batch Print takes: the receipts — a customer payment is not one. */
  const tickedPrintable = tickedShown.filter((x) => x.kind !== 'customer');
  const tickedSum = tickedShown.filter((x) => !x.cancelled).reduce((s, x) => s + x.amountSen, 0);
  const cancelledShown = onScreen.filter((x) => x.cancelled).length;

  const readFailures = [
    gates.official && officialQ.isError ? `The official receipts did not load — ${errText(officialQ.error)}` : null,
    gates.others && listQ.isError ? `The receipts did not load — ${errText(listQ.error)}` : null,
  ].filter((t): t is string => t != null);
  const loading = (gates.official && officialQ.isLoading) || (gates.others && listQ.isLoading);
  const live = liveJournal(voidJournals.data);
  const voidAsk: Ask | null = voiding ? {
    title: `Void ${voiding.no}?`,
    body: `Its journal ${live ? `${live.je_no} ` : ''}is reversed by a contra dated today. The receipt stays on file as voided.`,
    tone: 'undo', goLabel: 'Void receipt',
    onGo: () => {
      setVoidError(null);
      const no = voiding.no;
      voidIt.mutate(voiding.id, {
        onSuccess: () => { refreshAll(); void qc.invalidateQueries({ queryKey: ['journal-entries'] }); setVoiding(null); toast?.success(`${no} voided · journal reversed`); },
        onError: (e) => setVoidError(errText(e)),
      });
    },
  } : null;

  return (
    <div className={ui.page}>
      <PageHeader eyebrow="Finance · Money in" title="Receipts"
        actions={canCreate ? (
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => openForm('new')}><Plus size={14} /> New receipt</button>
        ) : undefined} />

      {gates.official && month && (
        <ReceiptsCheck month={month} check={checkQ.data} loading={checkQ.isLoading} error={checkQ.isError ? errText(checkQ.error) : null}
          issuing={issuing} onIssue={issue}
          openOf={(no) => { const r = officialRows.find((x) => x.or_number === no); return r ? String(r.id) : null; }}
          onOpen={(id) => openInTab(moneyInDocHref('official', id))} />
      )}
      {gates.official && (kind === 'all' || kind === 'official') && (
        <span className={ui.hint}>Cash turns formal at the counter; card when its merchant line is confirmed; a transfer when Bank recon matches its bank line, or when you confirm the money.</span>
      )}

      <div className={ui.stack}>
        <div className={ui.toolbar}>
          {segments.length > 1 && (
            <Segments label="Kind of receipt" value={kind} options={segments}
              onChange={(k) => { setUrl({ kind: k === 'all' ? null : k, status: null }); setTicked(new Set()); }} />
          )}
          <span className={ui.grow} />
          <MonthNav month={month} thisMonth={now} shift={shiftMonth}
            onChange={(m) => { setUrl({ month: m || 'all' }); setTicked(new Set()); }} />
          <SearchBox value={q} onChange={(v) => { setQ(v); setTicked(new Set()); }} placeholder="Find a receipt · no., payer, order, amount" />
        </div>
        {chips.length > 0 && (
          <Chips label="Status" value={chip} options={chips}
            onChange={(c) => { setUrl({ status: c === 'all' ? null : c }); setTicked(new Set()); }} />
        )}
        {voidAsk && <AskBanner key={voidAsk.title} ask={voidAsk} busy={voidIt.isPending} error={voidError} onKeep={() => setVoiding(null)} />}
        {steps.banner}
        {failure && <div role="alert" className={`${ui.hint} ${ui.checkBad}`}>{failure}</div>}
        {readFailures.map((t) => <div key={t} role="alert" className={`${ui.hint} ${ui.checkBad}`}>{t}</div>)}

        <DataTable<ReceiptItem>
          tableId="mi-receipts-all"
          exportName="receipts"
          exportXlsx
          columns={columns}
          rows={loading ? null : list}
          loading={loading}
          error={readFailures.length > 0 && items.length === 0 ? readFailures.join(' ') : null}
          emptyLabel="No receipt here."
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
        {cancelledShown > 0 && <span className={ui.hint}>{cancelledShown} cancelled, not counted</span>}

        {tickedShown.length > 0 && (
          <BatchBar count={tickedShown.length} sum={fmtSen(tickedSum)} hidden={hidden} onClear={() => setTicked(new Set())}
            notes={tickedDrafts.length > 0 ? ['Confirming turns each draft formal and gives it its official number, in payment-date order.'] : []}>
            {tickedDrafts.length > 0 && (
              <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={confirming} onClick={() => { void confirmMoney(tickedDrafts); }}>
                <CheckCheck size={14} /> {confirming ? 'Confirming…' : `Confirm money · ${tickedDrafts.length}`}
              </button>
            )}
            {tickedPrintable.length > 0 && (
              <button type="button" className={ui.btn} disabled={printing} onClick={() => printReceipts(tickedPrintable)}>
                <Printer size={14} /> {printing ? 'Preparing…' : `Print ${tickedPrintable.length}`}
              </button>
            )}
          </BatchBar>
        )}
      </div>
      {rowMenu.popup}
      {printer.modal}
    </div>
  );
};

/* ── The receipt form, in place of the list (`?form=new|copy|edit`) ─────────
   New receipt picks Sundry income or Other debtor; Copy as new and Edit start
   from a sundry receipt. The same doors as before: POST /receipts, PATCH
   /receipts/:id (re-posts), POST /other-debtors/:id/receipts {postNow} — an
   other debtor's money from this page posts at once and knocks the bills off. */
function ReceiptFormPage({ mode, id, type, onType, onClose, onSaved, openDoc }: {
  mode: 'new' | 'copy' | 'edit';
  id: string | null;
  type: 'sundry' | 'debtor';
  onType: (t: 'sundry' | 'debtor') => void;
  onClose: () => void;
  onSaved: () => void;
  openDoc: (href: string) => void;
}) {
  const toast = useToastOptional();
  const accountsQ = useAccounts();
  const detailQ = useReceiptDetail(mode === 'new' ? null : id);
  const create = useCreateReceipt();
  const update = useUpdateReceipt();
  const createDebtor = useCreateDebtorReceipt();
  /* One key per opened form: a double press books one receipt (lib/idempotency.ts). */
  const idemKey = useIdempotencyKey();
  const [error, setError] = useState<string | null>(null);
  const accounts = useMemo(() => postableAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  const moneyAccounts = useMemo(() => accounts.filter((a) => a.acc_money === true), [accounts]);
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);

  const d = detailQ.data;
  const no = d?.receipt.receipt_number ?? '';
  const kind = mode === 'new' ? type : 'sundry';
  const title = mode === 'edit' ? `Edit ${no}` : mode === 'copy' ? `New receipt · copy of ${no}` : kind === 'debtor' ? 'New receipt · Other debtor' : 'New receipt';
  const typeSwitch = mode === 'new' ? (
    <Segments label="Kind of receipt" value={type} onChange={onType}
      options={[{ value: 'sundry' as const, label: 'Sundry income' }, { value: 'debtor' as const, label: 'Other debtor' }]} />
  ) : null;

  const onSundry = (v: SundrySubmit) => {
    setError(null);
    if (mode === 'edit' && d) {
      update.mutate({ id: d.receipt.id, ...v }, {
        onSuccess: (res) => { onSaved(); toast?.success(`${res.receipt.receiptNumber} saved and re-posted`); onClose(); },
        onError: (e) => setError(errText(e)),
      });
      return;
    }
    create.mutate({ ...v, idempotencyKey: idemKey }, {
      onSuccess: (res) => {
        onSaved();
        toast?.success(`${res.receipt.receiptNumber} posted · ${fmtSen(res.receipt.totalSen)}`);
        onClose();
        if (res.receipt.id) openDoc(moneyInDocHref('sundry', res.receipt.id));
      },
      onError: (e) => setError(errText(e)),
    });
  };
  const onDebtor = (v: DebtorSubmit) => {
    setError(null);
    createDebtor.mutate({ ...v, postNow: true, idempotencyKey: idemKey }, {
      onSuccess: (res) => { onSaved(); toast?.success(`${res.receipt.receiptNumber} posted · bills knocked off`); onClose(); },
      onError: (e) => setError(errText(e)),
    });
  };

  const waiting = mode !== 'new' && !d;
  return (
    <DocFormShell title={waiting ? 'Receipt' : title} backLabel="Receipts" onBack={onClose} titleExtra={typeSwitch} bare>
      {error && <div role="alert" className={`${ui.hint} ${ui.checkBad}`}>{error}</div>}
      {waiting
        ? <div className={ui.hint} role={detailQ.isError ? 'alert' : undefined}>{detailQ.isError ? `The receipt did not load — ${errText(detailQ.error)}` : 'Loading the receipt…'}</div>
        : (
          <ReceiptForm key={`${mode}-${kind}-${id ?? ''}`} kind={kind} mode={mode} door="receipts"
            initial={d ? receiptValuesOf(d, mode === 'copy') : blankReceipt(todayMY())}
            accounts={accounts} moneyAccounts={moneyAccounts} accountName={accountName}
            saving={create.isPending || update.isPending || createDebtor.isPending}
            onSundry={onSundry} onDebtor={(v) => onDebtor(v)} onCancel={onClose} />
        )}
    </DocFormShell>
  );
}
