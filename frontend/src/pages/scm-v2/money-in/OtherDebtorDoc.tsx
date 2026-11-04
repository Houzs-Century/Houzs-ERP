// ----------------------------------------------------------------------------
// OtherDebtorDoc — /scm/other-debtors/:id, an other debtor as a page (the
// owner's Claude Design, batch 5 §8; it was a card under the registry list).
// Who they are and where the paper goes, what they owe, their bills and the
// receipts that came in — each opening its own page — and the registry's
// steps: Edit debtor (the debtor form in place of the page, `?form=edit`) and
// Deactivate / Reactivate. New bill and New receipt (batch 5 step 6) open their
// forms in place too (`?form=bill|receipt`): the bill posts as it does from
// Invoices, the receipt waits for its four layers. Bills and receipts post to
// the one other-debtors control; nothing on this page itself posts.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  useAccountRoles, useAccounts, useDebtorDetail, useUpdateDebtor,
  type DebtorBill, type DebtorReceipt,
} from '../../../vendor/scm/lib/accounting-queries';
import { partyAddressLines } from '../../../vendor/scm/lib/debtor-party';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';
import { useToastOptional } from '../../../hooks/useToast';
import { DataTable, type Column } from '../../../components/DataTable';
import { cancelledRowClass } from '../../../lib/scm';
import { FinanceDocLink } from '../finance/FinanceDocLink';
import { pvStage } from '../PvDocParts';
import { BillFormPage } from './BillFormPage';
import { DebtorFormPage } from './DebtorForm';
import { DebtorReceiptFormPage } from './DebtorReceiptFormPage';
import { StatusTag } from './MoneyInParts';
import {
  DocSection, DocState, MoneyInDocPage, byTime,
  type DocAction, type DocFact, type TrailStep,
} from './MoneyInDocPage';
import { debtorBillTag, debtorReceiptTag, debtorTag } from './moneyInStatus';
import { moneyInDocHref } from './moneyInDocs';
import ui from '../MoneyIn.module.css';
import s from './MoneyInDoc.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
type Bill = DebtorBill & { created_at?: string | null };
/** A receipt names the bills it knocks off (GET /other-debtors/:id, read c4). */
type Receipt = DebtorReceipt & { created_at?: string | null; bills?: Array<{ billId: string; no: string | null; amountSen: number }> };

const owing = (b: Bill): number => (b.status === 'CANCELLED' ? 0 : Math.max(0, Number(b.total_sen) - Number(b.received_sen)));

const BILL_COLUMNS: Column<Bill>[] = [
  { key: 'bill_no', label: 'Bill', getValue: (b) => b.bill_number, render: (b) => <FinanceDocLink to={moneyInDocHref('debtorBill', b.id)}>{b.bill_number}</FinanceDocLink> },
  { key: 'date', label: 'Date', render: (b) => fmtDate(b.bill_date), getValue: (b) => b.bill_date },
  { key: 'description', label: 'Description', width: '240px', render: (b) => b.notes ?? '—', getValue: (b) => b.notes ?? '' },
  { key: 'total', label: 'Total', align: 'right', render: (b) => fmtSen(b.total_sen), getValue: (b) => b.total_sen },
  { key: 'received', label: 'Received', align: 'right', render: (b) => fmtSen(b.received_sen), getValue: (b) => b.received_sen },
  { key: 'outstanding', label: 'Outstanding', align: 'right', render: (b) => (b.status === 'CANCELLED' ? '—' : fmtSen(owing(b))), getValue: (b) => owing(b) },
  { key: 'status', label: 'Status', render: (b) => <StatusTag tag={debtorBillTag(b)} />, getValue: (b) => b.status },
];

export const OtherDebtorDoc = () => {
  const { id = '' } = useParams();
  const toast = useToastOptional();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = useDebtorDetail(id || null);
  const d = q.data;
  const accountsQ = useAccounts();
  const rolesQ = useAccountRoles();
  const update = useUpdateDebtor();
  const { can } = useHouzsAuth();
  /* The registry's own keys (OtherDebtors.tsx; PATCH /other-debtors/:id); a bill or a receipt is raised with
     .create — and only on an active debtor (the forms list active debtors alone). */
  const canWrite = can('scm.payment_voucher.write');
  const canCreate = can('scm.payment_voucher.create');
  const [failure, setFailure] = useState<string | null>(null);
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);

  if (!d) return <DocState kind="debtor" loading={q.isLoading} error={q.error} />;

  const debtor = d.debtor;
  const bills = d.bills as Bill[];
  const receipts = d.receipts as Receipt[];
  const outstanding = bills.reduce((sum, b) => sum + owing(b), 0);
  const openBills = bills.filter((b) => owing(b) > 0).length;
  const received = bills.filter((b) => b.status !== 'CANCELLED').reduce((sum, b) => sum + Number(b.received_sen), 0);
  const billNo = new Map(bills.map((b) => [b.id, b.bill_number]));
  const setForm = (mode: 'edit' | 'bill' | 'receipt' | null) => {
    setFailure(null);
    setParams((prev) => { const n = new URLSearchParams(prev); if (mode) n.set('form', mode); else n.delete('form'); return n; });
  };

  const form = params.get('form');
  if (form === 'edit' && canWrite) {
    return <DebtorFormPage key={`edit-${debtor.id}`} debtor={debtor} backLabel={debtor.name} onClose={() => setForm(null)} />;
  }
  if (form === 'bill' && canCreate && debtor.is_active) {
    return <BillFormPage mode="new" id={null} debtorId={debtor.id} backLabel={debtor.name} onClose={() => setForm(null)} openDoc={(href) => navigate(href)} />;
  }
  if (form === 'receipt' && canCreate && debtor.is_active) {
    return <DebtorReceiptFormPage id={null} debtorId={debtor.id} backLabel={debtor.name} onClose={() => setForm(null)} openDoc={(href) => navigate(href)} />;
  }

  const actions: DocAction[] = [];
  if (canWrite) {
    actions.push({ label: 'Edit debtor', onClick: () => setForm('edit') });
    actions.push({
      label: debtor.is_active ? 'Deactivate' : 'Reactivate', busy: update.isPending,
      onClick: () => {
        setFailure(null);
        update.mutate({ id: debtor.id, isActive: !debtor.is_active }, {
          onSuccess: () => toast?.success(`${debtor.name} ${debtor.is_active ? 'deactivated' : 'reactivated'}`),
          onError: (e) => setFailure(errText(e)),
        });
      },
    });
  }

  const contact = [debtor.attention || debtor.contact_person, debtor.phone, debtor.mobile, debtor.email].filter(Boolean).join(' · ');
  const facts: DocFact[] = [
    { label: 'Registration no.', value: debtor.business_reg_no || '—' },
    { label: 'Phone', value: debtor.phone || debtor.mobile || '—' },
    { label: 'Email', value: debtor.email || '—' },
    { label: 'Open bills', value: String(openBills) },
    { label: 'Received', value: fmtSen(received) },
  ];
  if (debtor.tin_number) facts.push({ label: 'TIN', value: debtor.tin_number });
  if (debtor.attention || debtor.contact_person) facts.push({ label: 'Contact', value: String(debtor.attention || debtor.contact_person) });

  const control = rolesQ.data?.roles.AR_OTHER;
  const receiptColumns: Column<Receipt>[] = [
    { key: 'receipt_no', label: 'Receipt', getValue: (r) => r.receipt_number, render: (r) => <FinanceDocLink to={moneyInDocHref('debtorReceipt', r.id)}>{r.receipt_number}</FinanceDocLink> },
    { key: 'date', label: 'Date', render: (r) => fmtDate(r.receipt_date), getValue: (r) => r.receipt_date },
    { key: 'into_account', label: 'Into', render: (r) => `${r.bank_account_code}${accountName(r.bank_account_code) ? ` ${accountName(r.bank_account_code)}` : ''}`, getValue: (r) => r.bank_account_code },
    {
      key: 'bill_ref', label: 'Knocks off', width: '220px', getValue: (r) => (r.bills ?? []).map((b) => b.no ?? '').join(' '),
      render: (r) => ((r.bills ?? []).length > 0 ? (r.bills ?? []).map((b) => b.no ?? billNo.get(b.billId) ?? '—').join(', ') : '—'),
    },
    { key: 'amount', label: 'Amount', align: 'right', render: (r) => fmtSen(r.total_sen), getValue: (r) => r.total_sen },
    { key: 'stage', label: 'Stage', render: (r) => <StatusTag tag={debtorReceiptTag(pvStage(r))} />, getValue: (r) => r.status },
  ];
  /* The debtor's own trail is its documents': each bill raised, each receipt that came in. */
  const trail: TrailStep[] = byTime([
    ...bills.filter((b) => b.created_at).map((b): TrailStep => ({ key: `bill-${b.id}`, act: `Bill raised · ${b.bill_number}`, when: b.created_at, note: fmtSen(b.total_sen), undo: b.status === 'CANCELLED' })),
    ...receipts.filter((r) => r.approved_at).map((r): TrailStep => ({ key: `odr-${r.id}`, act: `Received · ${r.receipt_number}`, when: r.approved_at, note: fmtSen(r.total_sen), undo: r.status === 'CANCELLED' })),
  ]).slice(-10);

  return (
    <MoneyInDocPage
      kind="debtor" kindLabel="Other debtor" number={debtor.name} tag={debtorTag(debtor.is_active)} sub={debtor.notes}
      taskLink={{ type: 'Other debtor', no: debtor.name, name: contact, to: moneyInDocHref('debtor', debtor.id) }}
      actions={actions}
      notice={failure ? <div role="alert" className={`${s.note} ${s.toneLate}`}>{failure}</div> : null}
      party={{ label: 'Bill to', name: debtor.name, lines: [...partyAddressLines(debtor), contact] }}
      amount={{ label: 'Outstanding', value: fmtSen(outstanding), sub: `${openBills} open bill${openBills === 1 ? '' : 's'}` }}
      facts={facts}
      books={<>Bills and receipts post to the {control ? `${control}${accountName(control) ? ` ${accountName(control)}` : ''}` : 'other debtors'} control</>}
      trail={trail}
    >
      <DocSection title="Bills" buttons={(
        <span className={ui.acts} style={{ width: 'auto' }}>
          {canCreate && debtor.is_active && <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={() => setForm('bill')}><Plus size={13} /> New bill</button>}
          <Link to={`/scm/ar-invoices?debtor=${encodeURIComponent(debtor.id)}`} className={`${ui.btn} ${ui.btnSmall}`} style={{ textDecoration: 'none' }}>Open bills in Invoices</Link>
        </span>
      )}>
        {bills.length === 0
          ? <div className={s.empty}>No bills yet.</div>
          : <DataTable<Bill> tableId="mi-debtor-bills" embedded columns={BILL_COLUMNS} rows={bills} getRowKey={(b) => b.id} getRowClassName={(b) => cancelledRowClass(b.status)} />}
      </DocSection>
      <DocSection title="Receipts" buttons={canCreate && debtor.is_active ? (
        <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={() => setForm('receipt')}><Plus size={13} /> New receipt</button>
      ) : undefined}>
        {receipts.length === 0
          ? <div className={s.empty}>No receipts yet.</div>
          : <DataTable<Receipt> tableId="mi-debtor-receipts" embedded columns={receiptColumns} rows={receipts} getRowKey={(r) => r.id} />}
      </DocSection>
    </MoneyInDocPage>
  );
};
