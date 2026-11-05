// ----------------------------------------------------------------------------
// DebtorReceiptDoc — /scm/receipts/debtor/:id, an other debtor's receipt as a
// page (the owner's Claude Design, batch 5 §8; no page had it before). Who
// paid, into which account, the bills it knocks off, its journal — and the
// payment voucher's four layers, walked here again: Prepare → Check (or
// Withdraw) → Approve & post, Reject… back to Draft with a reason, and Void…
// once it is on the books. Every step is a route that already exists
// (other-debtors.ts); Approve posts exactly what the Receipts page's post-now
// door posts. Edit (batch 5 step 6, `?form=edit`) changes a Draft or a
// Prepared receipt in place — PATCH /other-debtors/receipts/:id (c5), which
// posts nothing and keeps the stage. Who may press what is the server's — the
// buttons follow the same keys.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  useAccountRoles, useAccounts, useDebtorReceiptAction, useVoidDebtorReceipt,
} from '../../../vendor/scm/lib/accounting-queries';
import { partyAddressLines } from '../../../vendor/scm/lib/debtor-party';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';
import { useToastOptional } from '../../../hooks/useToast';
import { DataTable, type Column } from '../../../components/DataTable';
import { FinanceDocLink } from '../finance/FinanceDocLink';
import { pvStage } from '../PvDocParts';
import { AskBanner, type Ask } from './AskBanner';
import { DebtorReceiptFormPage } from './DebtorReceiptFormPage';
import {
  DocBooks, DocSection, DocState, MoneyInDocPage, byTime, journalTrail, personOf,
  type DocAction, type DocFact, type TrailStep,
} from './MoneyInDocPage';
import { liveJournal, useDebtorReceipt, useDocJournals, type DebtorReceiptAllocation } from './moneyInDocQueries';
import { generateDebtorReceiptPdf } from '../../../vendor/scm/lib/debtor-receipt-pdf';
import { debtorReceiptTag } from './moneyInStatus';
import { moneyInDocHref } from './moneyInDocs';
import s from './MoneyInDoc.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
type Step = 'submit' | 'withdraw' | 'check' | 'reject' | 'approve';

const KNOCK_COLUMNS: Column<DebtorReceiptAllocation>[] = [
  {
    key: 'bill_no', label: 'Bill', getValue: (a) => a.billNumber ?? '',
    render: (a) => (a.billNumber ? <FinanceDocLink to={moneyInDocHref('debtorBill', a.billId)}>{a.billNumber}</FinanceDocLink> : '—'),
  },
  { key: 'date', label: 'Date', render: (a) => fmtDate(a.billDate), getValue: (a) => a.billDate ?? '' },
  { key: 'description', label: 'Description', width: '280px', render: (a) => a.description ?? '—', getValue: (a) => a.description ?? '' },
  { key: 'amount', label: 'Receive', align: 'right', render: (a) => fmtSen(a.amountSen), getValue: (a) => a.amountSen },
];

export const DebtorReceiptDoc = () => {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToastOptional();
  const q = useDebtorReceipt(id || null);
  const d = q.data;
  const r = d?.receipt;
  const journals = useDocJournals('ODR', r?.receipt_number);
  const accountsQ = useAccounts();
  const rolesQ = useAccountRoles();
  const step = useDebtorReceiptAction();
  const voidIt = useVoidDebtorReceipt();
  const { can } = useHouzsAuth();
  /* The server's keys, step by step (other-debtors.ts); an edit takes .write or .create, as raising it did. */
  const canWrite = can('scm.payment_voucher.write');
  const canEdit = canWrite || can('scm.payment_voucher.create');
  const canCheck = can('scm.payment_voucher.check');
  const canApprove = can('scm.payment_voucher.approve');
  const canCancel = can('scm.payment_voucher.cancel');
  const [asking, setAsking] = useState<'reject' | 'approve' | 'void' | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);

  if (!d || !r) return <DocState kind="debtorReceipt" loading={q.isLoading} error={q.error} />;

  const no = r.receipt_number;
  const stage = pvStage(r);
  const editable = (stage === 'Draft' || stage === 'Prepared') && canEdit;
  const setForm = (form: 'edit' | null) => setParams((prev) => {
    const n = new URLSearchParams(prev);
    if (form) n.set('form', form); else n.delete('form');
    return n;
  });
  if (params.get('form') === 'edit' && editable) {
    return <DebtorReceiptFormPage key={r.id} id={r.id} debtorId={r.debtor_id} backLabel={no} onClose={() => setForm(null)} openDoc={() => undefined} />;
  }
  const live = liveJournal(journals.data);
  const debtorName = d.debtor?.name ?? '—';
  const bills = d.allocations.map((a) => a.billNumber ?? '—');
  const named = (code: string | undefined) => (code ? `${code}${accountName(code) ? ` ${accountName(code)}` : ''}` : '—');
  const busy = step.isPending || voidIt.isPending;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['journal-entries'] });
    void qc.invalidateQueries({ queryKey: ['receipts'] });
  };
  const run = (action: Step, done: string, note?: string) => {
    setFailure(null); setAskError(null);
    step.mutate({ receiptId: r.id, action, ...(note ? { note } : {}) }, {
      onSuccess: () => { refresh(); setAsking(null); toast?.success(done); },
      onError: (e) => (asking ? setAskError(errText(e)) : setFailure(errText(e))),
    });
  };

  const actions: DocAction[] = [];
  if (editable) actions.push({ label: 'Edit', busy, onClick: () => { setFailure(null); setForm('edit'); } });
  if (stage === 'Draft' && canWrite) actions.push({ label: 'Prepare', kind: 'primary', busy, onClick: () => run('submit', `${no} prepared · checked next`) });
  if (stage === 'Prepared' && canWrite) actions.push({ label: 'Withdraw', busy, hint: 'Back out of the cycle — it will need preparing again', onClick: () => run('withdraw', `${no} withdrawn · back to Draft`) });
  if (stage === 'Prepared' && canCheck) actions.push({ label: 'Check', kind: 'primary', busy, onClick: () => run('check', `Checked · ${no} · approved next`) });
  if (stage === 'Checked' && canApprove) actions.push({ label: 'Approve & post', kind: 'primary', busy, onClick: () => { setAskError(null); setAsking('approve'); } });
  if ((stage === 'Prepared' || stage === 'Checked') && (canCheck || canApprove)) {
    actions.push({ label: 'Reject…', kind: 'danger', busy, onClick: () => { setAskError(null); setAsking('reject'); } });
  }
  if (stage === 'Approved' && canCancel) actions.push({ label: 'Void…', kind: 'danger', busy, onClick: () => { setAskError(null); setAsking('void'); } });

  const asks: Record<'reject' | 'approve' | 'void', Ask> = {
    reject: {
      title: `Reject ${no}?`, body: 'It goes back to Draft. Every mark clears and it starts again.',
      tone: 'undo', goLabel: 'Reject', reason: { placeholder: 'Why? The preparer sees this' },
      onGo: (reason) => run('reject', `${no} · rejected · back to draft`, reason),
    },
    approve: {
      title: `Approve ${no}?`,
      body: `${fmtSen(r.total_sen)} books into ${accountName(r.bank_account_code) ?? r.bank_account_code} (${r.bank_account_code}) and ${bills.join(', ')} ${bills.length > 1 ? 'are' : 'is'} knocked off.`,
      tone: 'go', goLabel: 'Approve & post',
      onGo: () => run('approve', `${no} approved & posted · ${fmtSen(r.total_sen)}`),
    },
    void: {
      title: `Void ${no}?`,
      body: `Its journal ${live?.je_no ?? ''}${live ? ' ' : ''}is reversed by a contra dated today and the bills it knocked off owe that money again.`,
      tone: 'undo', goLabel: 'Void receipt',
      onGo: () => {
        setAskError(null);
        voidIt.mutate(r.id, {
          onSuccess: () => { refresh(); setAsking(null); toast?.success(`${no} voided · journal reversed`); },
          onError: (e) => setAskError(errText(e)),
        });
      },
    },
  };
  const ask = asking ? asks[asking] : null;

  /* A rejection is kept on the receipt's notes, `[rejected] <why>` — the preparer reads it here. */
  const noteLines = String(r.notes ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const rejections = noteLines.filter((l) => l.startsWith('[rejected]')).map((l) => l.replace(/^\[rejected\]\s*/, ''));
  const otherNotes = noteLines.filter((l) => !l.startsWith('[rejected]')).join(' · ');

  const facts: DocFact[] = [
    { label: 'Date', value: fmtDate(r.receipt_date) },
    { label: 'Received into', value: named(r.bank_account_code) },
    { label: 'Debtor', value: debtorName, to: d.debtor ? moneyInDocHref('debtor', d.debtor.id) : null },
    { label: 'Journal', value: live?.je_no ?? (stage === 'Approved' ? '—' : 'Written at approval'), tone: live ? null : 'brass' },
    { label: 'Stage', value: stage },
  ];
  if (otherNotes) facts.push({ label: 'Notes', value: otherNotes });

  const trail: TrailStep[] = [
    ...byTime([
      { key: 'raised', act: 'Raised', who: personOf(r.created_by), when: r.created_at ?? null },
      ...(r.submitted_at ? [{ key: 'prepared', act: 'Prepared', who: personOf(r.submitted_by), when: r.submitted_at }] : []),
      ...(r.checked_at ? [{ key: 'checked', act: 'Checked', who: personOf(r.checked_by), when: r.checked_at }] : []),
      ...(r.approved_at ? [{ key: 'approved', act: 'Approved', who: personOf(r.approved_by), when: r.approved_at }] : []),
      ...journalTrail(journals.data),
    ]),
    ...rejections.map((why, i): TrailStep => ({ key: `rejected-${i}`, act: 'Rejected · back to Draft', note: why, undo: true })),
  ];

  return (
    <MoneyInDocPage
      kind="debtorReceipt" kindLabel="Other debtor receipt" number={no} tag={debtorReceiptTag(stage)}
      sub={stage === 'Checked' && !canApprove ? 'Waiting for approval' : null}
      taskLink={{ type: 'Other debtor receipt', no, name: debtorName, to: moneyInDocHref('debtorReceipt', r.id) }}
      printJob={{
        title: 'Receipt', docNo: no, papers: ['A4'],
        rows: [{ label: 'Received from', value: debtorName }, { label: 'Amount', value: fmtSen(r.total_sen) }],
        deliver: (action) => generateDebtorReceiptPdf({
          receipt: r, debtor: d.debtor,
          bills: d.allocations.map((a) => ({ billNumber: a.billNumber, description: a.description, amountSen: a.amountSen })),
          accountName, journalNo: live?.je_no ?? null,
        }, { action }),
      }}
      actions={actions}
      ask={ask ? <AskBanner key={ask.title} ask={ask} busy={busy} error={askError} onKeep={() => setAsking(null)} /> : null}
      notice={failure ? <div role="alert" className={`${s.note} ${s.toneLate}`}>{failure}</div> : null}
      party={{
        label: 'Received from', name: debtorName,
        lines: [d.debtor?.code ? `Account ${d.debtor.code}` : null, ...(d.debtor ? partyAddressLines(d.debtor) : []), d.debtor ? [d.debtor.phone, d.debtor.email].filter(Boolean).join(' · ') : null],
      }}
      amount={{ label: 'Amount', value: fmtSen(r.total_sen), sub: fmtDate(r.receipt_date) }}
      facts={facts}
      books={(
        <DocBooks journals={journals.data} loading={journals.isLoading} accountName={accountName} tail="knocks off the bills below"
          preview={<><b>Posts at approval</b> · Dr {named(r.bank_account_code)} · Cr {named(rolesQ.data?.roles.AR_OTHER)} ({debtorName}) · {fmtSen(r.total_sen)} · knocks off the bills below</>} />
      )}
      trail={trail}
    >
      <DocSection title="Knocks off">
        <DataTable<DebtorReceiptAllocation> tableId="mi-odr-knocks" embedded columns={KNOCK_COLUMNS} rows={d.allocations}
          getRowKey={(a) => a.billId} emptyLabel="No bill on this receipt." />
      </DocSection>
    </MoneyInDocPage>
  );
};
