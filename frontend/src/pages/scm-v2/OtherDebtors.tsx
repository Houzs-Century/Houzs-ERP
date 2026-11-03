// ----------------------------------------------------------------------------
// OtherDebtors — Money in › Debtor maintenance, /scm/other-debtors (owner
// 2026-09-03, confirmed line by line; the owner's Claude Design, batch 5 §4).
//
// other debtor 主要就是我会开 bill 其他和生意性质没有关系的人或公司收回钱: a
// REGISTRY (资料 lives here — the GL keeps one 305-0000 control, never per-party
// sub-accounts; owner 2026-09-21: 他要填的资料就和 supplier 的一样), and since the
// redesign the debtors' receipts beside it again. Two segments:
//   · Debtors — name, registration, phone, the bills still open, what they owe
//     (sand while they owe), Active / Inactive; New bill on the row, the rest
//     under ⋯ (Open, Edit debtor, Deactivate / Reactivate, New bill, New
//     receipt, Open bills in Invoices).
//   · Receipts — every other-debtor receipt, the bills it knocks off and its
//     stage, its next step as its button: the payment voucher's four layers
//     (Prepare → Check (or Withdraw) → Approve & post, Reject… back to Draft,
//     Void… once on the books) — the same doors as the receipt's own page.
//
// The forms open in place of the list (`?form=debtor|receipt|bill`, `id=` to
// edit, `debtor=` to start on one): the debtor's data (DebtorForm), a debtor
// receipt saved as a Draft or prepared, or a Draft / Prepared one changed
// (DebtorReceiptFormPage — PATCH /other-debtors/receipts/:id, c5, posts
// nothing), and Invoices' bill form. Bills are still listed, edited and
// cancelled on Invoices (owner 2026-09-29); the money from Receipts' Other
// debtor door still posts at once. Nothing posts differently.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  useAccounts, useOtherDebtors, useReceipts, useUpdateDebtor, type OtherDebtor, type ReceiptRow,
} from '../../vendor/scm/lib/accounting-queries';
import { useArInvoices } from '../../vendor/scm/lib/ar-invoice-queries';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useToastOptional } from '../../hooks/useToast';
import { fmtDate, fmtSen } from '../../vendor/shared/format';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { BillFormPage } from './money-in/BillFormPage';
import { DebtorFormPage } from './money-in/DebtorForm';
import { DebtorReceiptFormPage } from './money-in/DebtorReceiptFormPage';
import { DocFormShell } from './money-in/MoneyInDocPage';
import { SearchBox, Segments, StatusTag, tidyMenu, useRowMenu, type MenuItem } from './money-in/MoneyInParts';
import { debtorReceiptTag, debtorTag, openRowStyle } from './money-in/moneyInStatus';
import { moneyInDocHref } from './money-in/moneyInDocs';
import { debtorStageOf } from './money-in/receiptsModel';
import { useDebtorReceiptSteps, type DebtorStepRow } from './money-in/useDebtorReceiptSteps';
import ui from './MoneyIn.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
const DIVIDER: MenuItem = { label: '', onClick: () => undefined, divider: true };
type Segment = 'debtors' | 'receipts';
type DebtorRow = OtherDebtor & { openBills: number };
const BACK = 'Debtor maintenance';

export const OtherDebtors = () => {
  const [params, setParams] = useSearchParams();
  const openInTab = useOpenDocInTab();
  const toast = useToastOptional();
  const { can } = useHouzsAuth();
  /* The registry's and the receipt's own keys (other-debtors.ts). */
  const canCreate = can('scm.payment_voucher.create');
  const canWrite = can('scm.payment_voucher.write');
  const segment: Segment = params.get('seg') === 'receipts' ? 'receipts' : 'debtors';
  const form = params.get('form');
  const setUrl = (patch: Record<string, string | null>, push = false) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace: !push });
  const [q, setQ] = useState('');

  const debtorsQ = useOtherDebtors();
  const billsQ = useArInvoices('ODB');
  const receiptsQ = useReceipts(undefined, 'DEBTOR');
  const accountsQ = useAccounts();
  const updateDebtor = useUpdateDebtor();
  const steps = useDebtorReceiptSteps();
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);

  /* Open bills: a debtor's bills with money still owed — the Invoices list's own figure. */
  const openBillsOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of billsQ.data?.rows ?? []) {
      if (!b.debtorId || b.status.toUpperCase() === 'CANCELLED' || b.outstandingSen <= 0) continue;
      m.set(b.debtorId, (m.get(b.debtorId) ?? 0) + 1);
    }
    return m;
  }, [billsQ.data]);
  const debtors = useMemo<DebtorRow[]>(
    () => (debtorsQ.data?.debtors ?? []).map((d) => ({ ...d, openBills: openBillsOf.get(d.id) ?? 0 })),
    [debtorsQ.data, openBillsOf],
  );
  const receipts = useMemo(
    () => (receiptsQ.data?.receipts ?? []).filter((r) => r.kind === 'DEBTOR'),
    [receiptsQ.data],
  );

  const needle = q.trim().toLowerCase();
  const shownDebtors = debtors.filter((d) => !needle
    || [d.name, d.phone, d.mobile, d.business_reg_no, d.email].some((v) => String(v ?? '').toLowerCase().includes(needle)));
  const shownReceipts = receipts.filter((r) => !needle
    || [r.number, r.payer, fmtSen(r.totalSen), (r.totalSen / 100).toFixed(2), ...(r.bills ?? []).map((b) => b.no)]
      .some((v) => String(v ?? '').toLowerCase().includes(needle)));

  const openForm = (kind: 'debtor' | 'receipt' | 'bill', patch: Record<string, string | null> = {}) =>
    setUrl({ form: kind, id: null, debtor: null, ...patch }, true);
  const closeForm = () => setUrl({ form: null, id: null, debtor: null }, true);

  /* ── Debtors ── */
  const setActive = (d: DebtorRow) => updateDebtor.mutate({ id: d.id, isActive: !d.is_active }, {
    onSuccess: () => toast?.success(`${d.name} ${d.is_active ? 'deactivated' : 'reactivated'}`),
    onError: (e) => toast?.error(errText(e)),
  });
  const debtorMenu = (d: DebtorRow): MenuItem[] => tidyMenu([
    { label: 'Open', onClick: () => openInTab(moneyInDocHref('debtor', d.id)) },
    ...(canWrite ? [{ label: 'Edit debtor', onClick: () => openForm('debtor', { id: d.id }) }] : []),
    DIVIDER,
    /* An inactive debtor takes no new document until it is reactivated (the forms list active debtors only). */
    ...(canCreate && d.is_active ? [
      { label: 'New bill', onClick: () => openForm('bill', { debtor: d.id }) },
      { label: 'New receipt', onClick: () => openForm('receipt', { debtor: d.id }) },
    ] : []),
    { label: 'Open bills in Invoices', onClick: () => openInTab(`/scm/ar-invoices?debtor=${encodeURIComponent(d.id)}`) },
    ...(canWrite ? [DIVIDER, { label: d.is_active ? 'Deactivate' : 'Reactivate', danger: d.is_active, onClick: () => setActive(d) }] : []),
  ]);
  const debtorRowMenu = useRowMenu<DebtorRow>(debtorMenu, (d) => d.name);
  const debtorColumns: Column<DebtorRow>[] = [
    {
      key: 'name', label: 'Name', getValue: (d) => d.name,
      render: (d) => <FinanceDocLink to={moneyInDocHref('debtor', d.id)}>{d.name}</FinanceDocLink>,
    },
    { key: 'reg', label: 'Registration', render: (d) => <span className={ui.muted}>{d.business_reg_no || '—'}</span>, getValue: (d) => d.business_reg_no ?? '' },
    { key: 'phone', label: 'Phone', render: (d) => <span className={ui.muted}>{d.phone || d.mobile || '—'}</span>, getValue: (d) => d.phone ?? d.mobile ?? '' },
    { key: 'openBills', label: 'Open bills', align: 'right', render: (d) => (d.openBills > 0 ? d.openBills : <span className={ui.muted}>0</span>), getValue: (d) => d.openBills },
    {
      key: 'outstanding', label: 'Outstanding', align: 'right', render: (d) => <span className={ui.money}>{fmtSen(d.outstanding_sen)}</span>,
      getValue: (d) => d.outstanding_sen, exportValue: (d) => d.outstanding_sen / 100, exportFormat: 'money',
      total: (rows) => fmtSen(rows.reduce((s, d) => s + d.outstanding_sen, 0)),
    },
    { key: 'status', label: 'Status', render: (d) => <StatusTag tag={debtorTag(d.is_active)} />, getValue: (d) => (d.is_active ? 'Active' : 'Inactive') },
    {
      key: 'actions', label: '', align: 'right', width: '130px', disableSort: true, disableFilter: true,
      render: (d) => (
        <span className={ui.acts}>
          {canCreate && d.is_active && (
            <button type="button" className={ui.actLink} onClick={(e) => { e.stopPropagation(); openForm('bill', { debtor: d.id }); }}
              onDoubleClick={(e) => e.stopPropagation()}>New bill</button>
          )}
          {debtorRowMenu.button(d)}
        </span>
      ),
    },
  ];

  /* ── Receipts ── */
  const stepRowOf = (r: ReceiptRow): DebtorStepRow => ({
    id: r.id, no: r.number, stage: debtorStageOf(r), totalSen: r.totalSen, bankCode: r.moneyAccount, bankName: accountName(r.moneyAccount),
    bills: (r.bills ?? []).map((b) => b.no ?? '').filter(Boolean),
  });
  const receiptMenu = (r: ReceiptRow): MenuItem[] => {
    const stage = debtorStageOf(r);
    const m = steps.menuOf(stepRowOf(r));
    return tidyMenu([
      { label: 'Open', onClick: () => openInTab(moneyInDocHref('debtorReceipt', r.id)) },
      /* c5: a Draft or a Prepared receipt changes in place and keeps its stage. */
      ...((stage === 'Draft' || stage === 'Prepared') && (canWrite || canCreate) ? [{ label: 'Edit', onClick: () => openForm('receipt', { id: r.id }) }] : []),
      ...m.steps, DIVIDER, ...m.undo,
    ]);
  };
  const receiptRowMenu = useRowMenu<ReceiptRow>(receiptMenu, (r) => r.number);
  const receiptActions = (r: ReceiptRow): ReactNode => {
    const next = steps.nextOf(stepRowOf(r));
    const b = next.button;
    return (
      <span className={ui.acts}>
        {b && (
          <button type="button" className={ui.act} disabled={steps.busy}
            onClick={(e) => { e.stopPropagation(); b.onClick(); }} onDoubleClick={(e) => e.stopPropagation()}>{b.label}</button>
        )}
        {!b && next.waiting && <span className={ui.waiting}>Waiting for approval</span>}
        {receiptRowMenu.button(r)}
      </span>
    );
  };
  const receiptColumns: Column<ReceiptRow>[] = [
    {
      key: 'receipt_no', label: 'Receipt', getValue: (r) => r.number,
      render: (r) => <FinanceDocLink to={moneyInDocHref('debtorReceipt', r.id)} className={cancelledDocNoClass(r.status)}>{r.number}</FinanceDocLink>,
    },
    { key: 'date', label: 'Date', render: (r) => <span className={ui.muted}>{fmtDate(r.date)}</span>, getValue: (r) => r.date, exportFormat: 'date' },
    { key: 'debtor', label: 'Debtor', render: (r) => r.payer, getValue: (r) => r.payer },
    { key: 'into_account', label: 'Into', render: (r) => <span className={ui.muted}>{accountName(r.moneyAccount) ?? r.moneyAccount}</span>, getValue: (r) => r.moneyAccount },
    {
      key: 'bill_ref', label: 'Knocks off', getValue: (r) => (r.bills ?? []).map((b) => b.no ?? '').join(', '),
      render: (r) => <span className={ui.muted}>{(r.bills ?? []).map((b) => b.no).filter(Boolean).join(', ') || '—'}</span>,
    },
    {
      key: 'amount', label: 'Amount', align: 'right',
      render: (r) => (r.status.toUpperCase() === 'CANCELLED' ? <span className={ui.muted}>—</span> : <span className={ui.money}>{fmtSen(r.totalSen)}</span>),
      getValue: (r) => r.totalSen, exportValue: (r) => r.totalSen / 100, exportFormat: 'money',
      total: (rows) => fmtSen(rows.filter((r) => r.status.toUpperCase() !== 'CANCELLED').reduce((s, r) => s + r.totalSen, 0)),
    },
    { key: 'stage', label: 'Stage', render: (r) => <StatusTag tag={debtorReceiptTag(debtorStageOf(r))} />, getValue: (r) => debtorStageOf(r) },
    { key: 'actions', label: '', align: 'right', width: '190px', disableSort: true, disableFilter: true, render: receiptActions },
  ];

  if (form === 'debtor') {
    const id = params.get('id');
    const editing = id ? debtors.find((d) => d.id === id) ?? null : null;
    if (id && !editing) {
      return (
        <DocFormShell title="Debtor" backLabel={BACK} onBack={closeForm}>
          <div className={ui.hint} role={debtorsQ.isError ? 'alert' : undefined}>
            {debtorsQ.isError ? `The debtor did not load — ${errText(debtorsQ.error)}` : debtorsQ.isLoading ? 'Loading the debtor…' : 'No debtor here.'}
          </div>
        </DocFormShell>
      );
    }
    return <DebtorFormPage key={id ?? 'new'} debtor={editing} backLabel={BACK} onClose={closeForm} onAdded={(newId) => openInTab(moneyInDocHref('debtor', newId))} />;
  }
  if (form === 'receipt') {
    return <DebtorReceiptFormPage id={params.get('id')} debtorId={params.get('debtor') ?? ''} backLabel={BACK} onClose={closeForm} openDoc={openInTab} />;
  }
  if (form === 'bill') {
    return <BillFormPage mode="new" id={null} debtorId={params.get('debtor') ?? ''} backLabel={BACK} onClose={closeForm} openDoc={openInTab} />;
  }

  return (
    <div className={ui.page}>
      <PageHeader eyebrow="Finance · Money in" title="Debtor maintenance"
        actions={canCreate ? (
          <span className={ui.topRow}>
            <button type="button" className={ui.btn} onClick={() => openForm('debtor')}><Plus size={14} /> New debtor</button>
            <button type="button" className={ui.btn} onClick={() => openForm('receipt')}><Plus size={14} /> New receipt</button>
            <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => openForm('bill')}><Plus size={14} /> New bill</button>
          </span>
        ) : undefined} />
      <div className={ui.stack}>
        <div className={ui.toolbar}>
          <Segments label="Debtors or their receipts" value={segment} onChange={(s) => { setQ(''); setUrl({ seg: s === 'debtors' ? null : s }); }}
            options={[
              { value: 'debtors' as const, label: 'Debtors', count: debtors.length },
              { value: 'receipts' as const, label: 'Receipts', count: receipts.length },
            ]} />
          <span className={ui.grow} />
          <SearchBox value={q} onChange={setQ} placeholder={segment === 'debtors' ? 'Find a debtor' : 'Find a receipt · no., debtor, amount'} />
        </div>
        {steps.banner}
        {segment === 'debtors' ? (
          <DataTable<DebtorRow>
            tableId="mi-debtors" exportName="other-debtors" exportXlsx columns={debtorColumns}
            rows={debtorsQ.data ? shownDebtors : null} loading={debtorsQ.isLoading}
            error={debtorsQ.isError ? `The debtors did not load — ${errText(debtorsQ.error)}` : null}
            emptyLabel="Nothing here."
            getRowKey={(d) => d.id}
            getRowStyle={(d) => openRowStyle(d.outstanding_sen > 0)}
            onRowDoubleClick={(d) => openInTab(moneyInDocHref('debtor', d.id))}
            contextMenu={debtorMenu}
          />
        ) : (
          <DataTable<ReceiptRow>
            tableId="mi-debtor-receipts" exportName="other-debtor-receipts" exportXlsx columns={receiptColumns}
            rows={receiptsQ.data ? shownReceipts : null} loading={receiptsQ.isLoading}
            error={receiptsQ.isError ? `The receipts did not load — ${errText(receiptsQ.error)}` : null}
            emptyLabel="Nothing here."
            getRowKey={(r) => r.id}
            getRowClassName={(r) => cancelledRowClass(r.status)}
            onRowDoubleClick={(r) => openInTab(moneyInDocHref('debtorReceipt', r.id))}
            contextMenu={receiptMenu}
          />
        )}
      </div>
      {debtorRowMenu.popup}
      {receiptRowMenu.popup}
    </div>
  );
};
