// ----------------------------------------------------------------------------
// DebtorBillDoc — /scm/ar-invoices/bills/:id, an other debtor's bill (or debit
// note) as a page (the owner's Claude Design, batch 5 §8; it was a pop-out
// over AR invoices). Who owes it, its lines, what was received and is still
// owed, its journal — and its steps: Print, Copy and Edit (the bill form in
// place of the page, `?form=copy|edit`, so reload and Back work) and Cancel
// (refused once money is received on it). Edit re-posts and Cancel reverses
// through the same routes as before; nothing posts differently.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  postableAccounts, useAccounts, useCancelDebtorBill, useCreateDebtorBill, useOtherDebtors, useUpdateDebtorBill,
  type DebtorBill, type DebtorBillLine,
} from '../../../vendor/scm/lib/accounting-queries';
import { useArBillDetail } from '../../../vendor/scm/lib/ar-invoice-queries';
import { generateDebtorBillPdf } from '../../../vendor/scm/lib/debtor-bill-pdf';
import { partyAddressLines } from '../../../vendor/scm/lib/debtor-party';
import { SearchCombo } from '../../../vendor/scm/components/SearchCombo';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';
import { useToastOptional } from '../../../hooks/useToast';
import { DataTable, type Column } from '../../../components/DataTable';
import { AccountCell } from '../JournalEntryCards';
import { DebtorBillForm, type BillFormSubmit, type BillFormValues } from '../DebtorBillForm';
import formStyles from '../SalesOrderDetail.module.css';
import { AskBanner, type Ask } from './AskBanner';
import {
  DocBooks, DocFormShell, DocSection, DocState, MoneyInDocPage, byTime, journalTrail,
  type DocAction, type DocFact,
} from './MoneyInDocPage';
import { liveJournal, useDocJournals } from './moneyInDocQueries';
import { debtorBillTag } from './moneyInStatus';
import { moneyInDocHref, moneyInListOf } from './moneyInDocs';
import s from './MoneyInDoc.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** The form's values from a bill: an edit keeps everything, a copy keeps the
 *  description and lines and starts afresh — today's date, a new number on post. */
const fromBill = (b: DebtorBill, copy: boolean): BillFormValues => ({
  billDate: copy ? myt() : b.bill_date,
  notes: b.notes ?? '',
  lines: (b.lines ?? []).map((l, i) => ({ rid: i + 1, description: l.description ?? '', creditAccountCode: l.credit_account_code ?? '', amountSen: l.amount_sen, projectId: l.project_id ?? null })),
});

/** Money already received is why a bill can't be cancelled (the server's rule, in the redesign's words). */
const RECEIVED_REFUSAL = 'This bill has money received on it, so it can’t be cancelled.';

export const DebtorBillDoc = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToastOptional();
  const [params, setParams] = useSearchParams();
  const form = params.get('form');
  const q = useArBillDetail(id || null);
  const d = q.data;
  const journals = useDocJournals('ODB', d?.bill.bill_number);
  const accountsQ = useAccounts();
  const debtorsQ = useOtherDebtors();
  const createBill = useCreateDebtorBill();
  const updateBill = useUpdateDebtorBill();
  const cancelBill = useCancelDebtorBill();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create');
  const canWrite = can('scm.payment_voucher.write') || canCreate;
  const canCancel = can('scm.payment_voucher.cancel');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [copyDebtor, setCopyDebtor] = useState<string | null>(null);

  /* A line credits an ordinary leaf (postableAccounts, docs/bugs/0693); names
     come off the whole chart so a since-inactive account still reads. */
  const lineAccounts = useMemo(() => postableAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);
  const debtorOptions = useMemo(
    () => (debtorsQ.data?.debtors ?? []).filter((x) => x.is_active).map((x) => ({ value: x.id, label: x.name })),
    [debtorsQ.data],
  );

  if (!d) return <DocState kind="debtorBill" loading={q.isLoading} error={q.error} />;

  const bill = d.bill;
  const debtor = d.debtor;
  const isDn = bill.doc_kind === 'DN';
  const paper = isDn ? 'Debit note' : 'Debtor bill';
  const cancelled = bill.status === 'CANCELLED';
  const received = Number(bill.received_sen);
  const outstanding = Math.max(0, Number(bill.total_sen) - received);
  const live = liveJournal(journals.data);
  const setForm = (mode: 'edit' | 'copy' | null) => {
    setFormError(null);
    setParams((prev) => { const n = new URLSearchParams(prev); if (mode) n.set('form', mode); else n.delete('form'); return n; });
  };
  const refreshJournal = () => { void qc.invalidateQueries({ queryKey: ['journal-entries'] }); };

  const submit = async (values: BillFormSubmit) => {
    setFormError(null);
    try {
      if (form === 'edit') {
        const res = await updateBill.mutateAsync({ billId: bill.id, body: values });
        refreshJournal();
        setForm(null);
        toast?.success(`${res.bill.billNumber} saved and re-posted`);
        return;
      }
      const debtorId = copyDebtor ?? debtor?.id ?? '';
      if (!debtorId) { setFormError('Pick the debtor.'); return; }
      const res = await createBill.mutateAsync({ debtorId, ...values, ...(isDn ? { docKind: 'DN' as const } : {}) });
      toast?.success(`${res.bill.billNumber} posted · ${fmtSen(res.bill.totalSen)}`);
      navigate(res.bill.id ? moneyInDocHref('debtorBill', res.bill.id) : moneyInListOf('debtorBill').href);
    } catch (e) {
      setFormError(errText(e));
    }
  };

  if (form === 'edit' && canWrite && !cancelled) {
    return (
      <DocFormShell title={`Edit ${bill.bill_number}`} backLabel={bill.bill_number} onBack={() => setForm(null)}>
        {formError && <div role="alert" className={`${s.note} ${s.toneLate}`} style={{ marginBottom: 12 }}>{formError}</div>}
        <div className={s.note} style={{ marginBottom: 12 }}>{debtor?.name ?? '—'} · the debtor stays: a bill belongs to its debtor.</div>
        <DebtorBillForm key={`edit-${bill.id}`} mode="edit" initial={fromBill(bill, false)} accounts={lineAccounts} receivedSen={received}
          saving={updateBill.isPending} onSubmit={submit} onCancel={() => setForm(null)} />
      </DocFormShell>
    );
  }
  if (form === 'copy' && canCreate) {
    return (
      <DocFormShell title={`New ${paper.toLowerCase()} · copy of ${bill.bill_number}`} backLabel={bill.bill_number} onBack={() => setForm(null)}>
        {formError && <div role="alert" className={`${s.note} ${s.toneLate}`} style={{ marginBottom: 12 }}>{formError}</div>}
        <label className={s.formField}>
          Debtor
          <SearchCombo options={debtorOptions} value={copyDebtor ?? debtor?.id ?? ''} onChange={setCopyDebtor}
            className={formStyles.fieldInput} aria-label="Bill debtor" placeholder="— Pick the debtor —" />
        </label>
        <DebtorBillForm key={`copy-${bill.id}`} mode="copy" initial={fromBill(bill, true)} accounts={lineAccounts}
          saving={createBill.isPending} onSubmit={submit} onCancel={() => setForm(null)} />
      </DocFormShell>
    );
  }

  const actions: DocAction[] = [];
  if (canCreate) actions.push({ label: 'Copy', onClick: () => setForm('copy') });
  if (canWrite && !cancelled) actions.push({ label: 'Edit', onClick: () => setForm('edit') });
  if (canCancel && !cancelled) {
    actions.push({
      label: isDn ? 'Cancel debit note…' : 'Cancel bill…', kind: 'danger', busy: cancelBill.isPending,
      refused: received > 0 ? RECEIVED_REFUSAL : null, onClick: () => { setAskError(null); setAsking(true); },
    });
  }
  const ask: Ask = {
    title: `Cancel ${bill.bill_number}?`,
    body: `${live ? `Its journal ${live.je_no} is reversed. ` : ''}It stays on file as cancelled.`,
    tone: 'undo', goLabel: isDn ? 'Cancel debit note' : 'Cancel bill',
    onGo: () => {
      setAskError(null);
      cancelBill.mutate(bill.id, {
        onSuccess: () => { setAsking(false); refreshJournal(); toast?.success(`${bill.bill_number} cancelled · journal reversed`); },
        onError: (e) => setAskError(errText(e)),
      });
    },
  };

  const print = () => {
    void generateDebtorBillPdf({ bill, debtor: debtor ?? { name: '(debtor)', phone: null }, accountName }, { action: 'print' })
      .catch((e: unknown) => toast?.error(`${bill.bill_number} was not printed — ${errText(e)}`));
  };

  const facts: DocFact[] = [
    { label: 'Bill date', value: fmtDate(bill.bill_date) },
    { label: 'Description', value: bill.notes ?? '—' },
    { label: 'Debtor', value: debtor?.name ?? '—', to: debtor ? `/scm/ar-invoices?debtor=${encodeURIComponent(debtor.id)}` : null, title: 'Every bill of this debtor' },
    { label: 'Received', value: fmtSen(received) },
    { label: 'Outstanding', value: fmtSen(cancelled ? 0 : outstanding), tone: !cancelled && outstanding > 0 ? 'brass' : null },
    { label: 'Journal', value: live?.je_no ?? (cancelled ? 'Reversed' : '—') },
  ];
  const lineColumns: Column<DebtorBillLine>[] = [
    { key: 'no', label: '#', width: '44px', render: (l) => l.line_no, getValue: (l) => l.line_no },
    {
      key: 'account', label: 'Account', width: '220px',
      render: (l) => (l.credit_account_code ? <AccountCell code={l.credit_account_code} name={accountName(l.credit_account_code)} /> : <span className={s.empty}>Text line</span>),
      getValue: (l) => l.credit_account_code ?? '',
    },
    { key: 'description', label: 'Description', width: '320px', render: (l) => l.description ?? '—', getValue: (l) => l.description ?? '' },
    { key: 'amount', label: 'Amount', align: 'right', render: (l) => (l.credit_account_code ? fmtSen(l.amount_sen) : ''), getValue: (l) => l.amount_sen },
  ];

  return (
    <MoneyInDocPage
      kind="debtorBill" kindLabel={paper} number={bill.bill_number} tag={debtorBillTag(bill)}
      taskLink={{ type: paper, no: bill.bill_number, name: debtor?.name ?? '', to: moneyInDocHref('debtorBill', bill.id) }}
      onPrint={print}
      actions={actions}
      ask={asking ? <AskBanner key={ask.title} ask={ask} busy={cancelBill.isPending} error={askError} onKeep={() => setAsking(false)} /> : null}
      party={{
        label: 'Bill to', name: debtor?.name ?? '—',
        lines: [...(debtor ? partyAddressLines(debtor) : []), debtor ? [debtor.phone, debtor.email].filter(Boolean).join(' · ') : null],
      }}
      amount={{ label: 'Amount', value: fmtSen(bill.total_sen), sub: !cancelled && outstanding > 0 && received > 0 ? `${fmtSen(outstanding)} outstanding` : null }}
      facts={facts}
      books={<DocBooks journals={journals.data} loading={journals.isLoading} accountName={accountName} />}
      trail={byTime([
        { key: 'raised', act: isDn ? 'Debit note raised' : 'Bill raised', when: bill.created_at ?? null },
        ...journalTrail(journals.data),
      ])}
    >
      <DocSection title="Lines">
        <DataTable<DebtorBillLine> tableId="mi-bill-lines" embedded columns={lineColumns} rows={bill.lines ?? []} getRowKey={(l) => l.id}
          emptyLabel="No lines on this bill." />
      </DocSection>
    </MoneyInDocPage>
  );
};
