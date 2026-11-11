// ----------------------------------------------------------------------------
// SundryReceiptDoc — /scm/receipts/sundry/:id, a sundry-income receipt as a
// page (the owner's Claude Design, batch 5 §8; no page had it before). Who
// paid, into which account, the lines and the accounts they credit, its
// journal — and its steps: Copy as new and Edit (the form in place of the
// page, `?form=copy|edit`), Void… asked inline. Edit re-posts and Void
// reverses through the same routes as the Receipts page; nothing posts
// differently.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  postableAccounts, useAccounts, useCreateReceipt, useReceiptDetail, useUpdateReceipt, useVoidReceipt,
  type ReceiptDetail,
} from '../../../vendor/scm/lib/accounting-queries';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';
import { useToastOptional } from '../../../hooks/useToast';
import { DataTable, type Column } from '../../../components/DataTable';
import { AccountCell } from '../JournalEntryCards';
import { AskBanner, type Ask } from './AskBanner';
import {
  DocBooks, DocFormShell, DocSection, DocState, MoneyInDocPage, byTime, journalTrail,
  type DocAction, type DocFact,
} from './MoneyInDocPage';
import { ReceiptForm, receiptValuesOf, type SundrySubmit } from './ReceiptForm';
import { liveJournal, useDocJournals } from './moneyInDocQueries';
import { generateSundryReceiptPdf } from '../../../vendor/scm/lib/sundry-receipt-pdf';
import { sundryReceiptTag } from './moneyInStatus';
import { moneyInDocHref, moneyInListOf } from './moneyInDocs';
import { useIdempotencyKeyFor } from '../../../lib/idempotency';
import s from './MoneyInDoc.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
type Line = ReceiptDetail['lines'][number];
const fromReceipt = receiptValuesOf;

export const SundryReceiptDoc = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToastOptional();
  const [params, setParams] = useSearchParams();
  const form = params.get('form');
  const q = useReceiptDetail(id || null);
  const d = q.data;
  const r = d?.receipt;
  const journals = useDocJournals('RCT', r?.receipt_number);
  const accountsQ = useAccounts();
  const create = useCreateReceipt();
  /* One key per Copy opened on this receipt; this screen stays mounted when the copy opens, so a later copy gets its own. */
  const copyKey = useIdempotencyKeyFor(`${form ?? ''}:${id}`);
  const update = useUpdateReceipt();
  const voidIt = useVoidReceipt();
  const { can } = useHouzsAuth();
  /* The Receipts page's own keys (Receipts.tsx). */
  const canCreate = can('scm.payment_voucher.create');
  const canEdit = can('scm.payment_voucher.write') || canCreate;
  const canCancel = can('scm.payment_voucher.cancel');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const accounts = useMemo(() => postableAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  const moneyAccounts = useMemo(() => accounts.filter((a) => a.acc_money === true), [accounts]);
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);

  if (!d || !r) return <DocState kind="sundry" loading={q.isLoading} error={q.error} />;

  const no = r.receipt_number;
  const posted = r.status === 'POSTED';
  const live = liveJournal(journals.data);
  const setForm = (mode: 'edit' | 'copy' | null) => {
    setFormError(null);
    setParams((prev) => { const n = new URLSearchParams(prev); if (mode) n.set('form', mode); else n.delete('form'); return n; });
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['journal-entries'] });
    void qc.invalidateQueries({ queryKey: ['receipt-detail'] });
  };

  const submit = (values: SundrySubmit) => {
    setFormError(null);
    if (form === 'edit') {
      update.mutate({ id: r.id, ...values }, {
        onSuccess: (res) => { refresh(); setForm(null); toast?.success(`${res.receipt.receiptNumber} saved and re-posted`); },
        onError: (e) => setFormError(errText(e)),
      });
      return;
    }
    create.mutate({ ...values, idempotencyKey: copyKey }, {
      onSuccess: (res) => {
        toast?.success(`${res.receipt.receiptNumber} posted · ${fmtSen(res.receipt.totalSen)}`);
        navigate(res.receipt.id ? moneyInDocHref('sundry', res.receipt.id) : moneyInListOf('sundry').href);
      },
      onError: (e) => setFormError(errText(e)),
    });
  };

  const formProps = {
    kind: 'sundry' as const, door: 'receipts' as const, accounts, moneyAccounts, accountName,
    onSundry: submit, onDebtor: () => undefined, onCancel: () => setForm(null),
  };
  if (form === 'edit' && canEdit && posted) {
    return (
      <DocFormShell title={`Edit ${no}`} backLabel={no} onBack={() => setForm(null)} bare>
        {formError && <div role="alert" className={`${s.note} ${s.toneLate}`}>{formError}</div>}
        <ReceiptForm key={`edit-${r.id}`} mode="edit" initial={fromReceipt(d, false)} saving={update.isPending} {...formProps} />
      </DocFormShell>
    );
  }
  if (form === 'copy' && canCreate) {
    return (
      <DocFormShell title={`New receipt · copy of ${no}`} backLabel={no} onBack={() => setForm(null)} bare>
        {formError && <div role="alert" className={`${s.note} ${s.toneLate}`}>{formError}</div>}
        <ReceiptForm key={`copy-${r.id}`} mode="copy" initial={fromReceipt(d, true)} saving={create.isPending} {...formProps} />
      </DocFormShell>
    );
  }

  const actions: DocAction[] = [];
  if (canCreate) actions.push({ label: 'Copy as new', onClick: () => setForm('copy') });
  if (posted && canEdit) actions.push({ label: 'Edit', onClick: () => setForm('edit') });
  if (posted && canCancel) actions.push({ label: 'Void…', kind: 'danger', busy: voidIt.isPending, onClick: () => { setAskError(null); setAsking(true); } });
  const ask: Ask = {
    title: `Void ${no}?`,
    body: `Its journal ${live ? `${live.je_no} ` : ''}is reversed by a contra dated today. The receipt stays on file as voided.`,
    tone: 'undo', goLabel: 'Void receipt',
    onGo: () => {
      setAskError(null);
      voidIt.mutate(r.id, {
        onSuccess: () => { refresh(); setAsking(false); toast?.success(`${no} voided · journal reversed`); },
        onError: (e) => setAskError(errText(e)),
      });
    },
  };

  const named = (code: string) => `${code}${accountName(code) ? ` ${accountName(code)}` : ''}`;
  const facts: DocFact[] = [
    { label: 'Date', value: fmtDate(r.receipt_date) },
    { label: 'Received into', value: named(r.bank_account_code) },
    { label: 'Journal', value: live?.je_no ?? (posted ? '—' : 'Reversed') },
  ];
  if (r.notes) facts.push({ label: 'Notes', value: r.notes });
  const lineColumns: Column<Line>[] = [
    { key: 'account', label: 'Account', width: '240px', render: (l) => <AccountCell code={l.credit_account_code} name={accountName(l.credit_account_code)} />, getValue: (l) => l.credit_account_code },
    { key: 'description', label: 'Description', width: '320px', render: (l) => l.description ?? '—', getValue: (l) => l.description ?? '' },
    { key: 'amount', label: 'Amount', align: 'right', render: (l) => fmtSen(l.amount_sen), getValue: (l) => l.amount_sen },
  ];

  return (
    <MoneyInDocPage
      kind="sundry" kindLabel="Receipt · sundry income" number={no} tag={sundryReceiptTag(r.status)}
      taskLink={{ type: 'Receipt', no, name: r.payer_name, to: moneyInDocHref('sundry', r.id) }}
      printJob={{
        title: 'Receipt', docNo: no, papers: ['A4'],
        rows: [{ label: 'Received from', value: r.payer_name }, { label: 'Amount', value: fmtSen(r.total_sen) }],
        deliver: (action) => generateSundryReceiptPdf({ receipt: r, lines: d.lines, accountName, journalNo: live?.je_no ?? null }, { action }),
      }}
      actions={actions}
      ask={asking ? <AskBanner key={ask.title} ask={ask} busy={voidIt.isPending} error={askError} onKeep={() => setAsking(false)} /> : null}
      party={{ label: 'Received from', name: r.payer_name }}
      amount={{ label: 'Amount', value: fmtSen(r.total_sen), sub: fmtDate(r.receipt_date) }}
      facts={facts}
      books={<DocBooks journals={journals.data} loading={journals.isLoading} accountName={accountName} />}
      trail={byTime(journalTrail(journals.data))}
    >
      <DocSection title="Lines">
        <DataTable<Line> tableId="mi-rct-lines" embedded columns={lineColumns} rows={d.lines} getRowKey={(l) => l.id} emptyLabel="No lines on this receipt." />
      </DocSection>
    </MoneyInDocPage>
  );
};
