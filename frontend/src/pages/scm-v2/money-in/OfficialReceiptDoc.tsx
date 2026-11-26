
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAccounts } from '../../../vendor/scm/lib/accounting-queries';
import { generateReceiptPdf } from '../../../vendor/scm/lib/receipt-pdf';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import { useToastOptional } from '../../../hooks/useToast';
import {
  DocBooks, DocState, MoneyInDocPage, byTime, journalTrail, personOf,
  type DocAction, type DocFact, type TrailStep,
} from './MoneyInDocPage';
import { useDocJournals, useFormaliseReceipt, useOfficialReceipt } from './moneyInDocQueries';
import { methodWord, officialReceiptTag } from './moneyInStatus';
import { moneyInDocHref } from './moneyInDocs';
import s from './MoneyInDoc.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

const MONEY_SEEN = 'Confirmed';

const isCard = (method: string | null): boolean => method === 'merchant' || method === 'installment';

export const OfficialReceiptDoc = () => {
  const { id = '' } = useParams();
  const toast = useToastOptional();
  const q = useOfficialReceipt(id || null);
  const d = q.data;
  const r = d?.receipt;
  const journals = useDocJournals(r?.payment_source ?? 'SOPAY', r?.payment_id);
  const accountsQ = useAccounts();
  const formalise = useFormaliseReceipt();
  const [failure, setFailure] = useState<string | null>(null);
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);

  if (!d || !r) return <DocState kind="official" loading={q.isLoading} error={q.error} />;

  const status = r.status.toUpperCase();
  const draft = status === 'DRAFT';
  const cancelled = status === 'CANCELLED';
  const cash = r.method === 'cash';

  const actions: DocAction[] = draft ? [{
    label: 'Confirm money', kind: 'primary', busy: formalise.isPending,
    hint: isCard(r.method) ? 'Card money usually turns formal when its merchant report is confirmed' : 'You have seen the money arrive',
    onClick: () => {
      setFailure(null);
      formalise.mutate(r.id, {
        onSuccess: (res) => toast?.success(`${r.or_number} is formal · ${res.orNumber}`),
        onError: (e) => setFailure(errText(e)),
      });
    },
  }] : [];

  const facts: DocFact[] = [
    d.salesInvoice
      ? { label: 'Sales invoice', value: d.salesInvoice.number, to: moneyInDocHref('salesInvoice', d.salesInvoice.id) }
      : { label: 'Sales order', value: d.salesOrder ?? (r.payment_source === 'SOPAY' ? r.doc_no : null) ?? '—', to: d.salesOrder ? `/scm/sales-orders/${encodeURIComponent(d.salesOrder)}` : null },
    ...(d.salesInvoice && d.salesOrder ? [{ label: 'Sales order', value: d.salesOrder, to: `/scm/sales-orders/${encodeURIComponent(d.salesOrder)}` }] : []),
    { label: 'Paid on', value: fmtDate(r.paid_at) },
    { label: 'Method', value: methodWord(r.method) },
    { label: 'Salesperson', value: d.salesperson ?? '—' },
    { label: 'Payment journal', value: d.paymentJournal?.jeNo ?? '—', tone: d.paymentJournal?.reversed ? 'late' : null },
    {
      label: MONEY_SEEN,
      value: draft ? 'Not yet · money not confirmed'
        : r.issued_at ? `${cash ? 'Cash at the counter' : (personOf(r.issued_by) ?? '—')} · ${fmtDate(r.issued_at)}` : '—',
      tone: draft ? 'brass' : null,
    },
  ];
  if (d.payment === null) facts.push({ label: 'Payment', value: 'The payment row is gone', tone: 'late' });
  else if (d.payment.amountSen !== Number(r.amount_sen)) facts.push({ label: 'Payment keyed', value: fmtSen(d.payment.amountSen), tone: 'late' });
  if (cancelled) facts.push({ label: 'Cancelled', value: [personOf(r.cancelled_by), fmtDate(r.cancelled_at)].filter(Boolean).join(' · ') || '—', tone: 'late' });
  if (d.replacedBy) facts.push({ label: 'Replaced by', value: d.replacedBy.orNumber, to: moneyInDocHref('official', d.replacedBy.id) });
  if (d.replaces) facts.push({ label: 'Replaces', value: d.replaces.orNumber, to: moneyInDocHref('official', d.replaces.id) });

  const trail: TrailStep[] = byTime([
    { key: 'drafted', act: cash && !draft ? 'Receipt issued' : 'Receipt drafted', who: personOf(r.created_by), when: r.created_at },
    ...(r.issued_at && !draft ? [{ key: 'formal', act: cash ? 'Formal at once · cash in hand' : 'Money confirmed', who: personOf(r.issued_by), when: r.issued_at }] : []),
    ...journalTrail(journals.data).map((t) => ({ ...t, act: t.undo ? 'Payment journal reversed' : `Payment ${t.act.toLowerCase()}` })),
    ...(cancelled ? [{ key: 'cancelled', act: 'Cancelled', who: personOf(r.cancelled_by), when: r.cancelled_at, note: r.cancel_reason, undo: true }] : []),
  ]);

  return (
    <MoneyInDocPage
      kind="official" kindLabel="Official receipt" number={r.or_number} tag={officialReceiptTag(r.status)}
      sub={draft ? 'money not confirmed yet' : cancelled ? `cancelled · ${r.cancel_reason ?? 'its payment changed'}` : null}
      taskLink={{ type: 'Official receipt', no: r.or_number, name: r.customer_name ?? '', to: moneyInDocHref('official', r.id) }}
      printJob={{
        title: 'Official receipt', docNo: r.or_number, papers: ['A5'],
        rows: [{ label: 'Received from', value: r.customer_name ?? '—' }, { label: 'Amount', value: fmtSen(r.amount_sen) }],
        deliver: (action) => generateReceiptPdf({ ...r, sales_order: d.salesOrder, payment_source: r.payment_source }, { action }),
      }}
      actions={actions}
      notice={failure ? <div role="alert" className={`${s.note} ${s.toneLate}`}>{failure}</div> : null}
      party={{ label: 'Received from', name: r.customer_name ?? '—' }}
      amount={{ label: 'Amount received', value: fmtSen(r.amount_sen), sub: `${methodWord(r.method)} · ${fmtDate(r.paid_at)}` }}
      facts={facts}
      books={(
        <DocBooks journals={journals.data} loading={journals.isLoading} accountName={accountName} prefix="Posted with the payment"
          preview="The payment's journal is not on file" />
      )}
      trail={trail}
    />
  );
};
