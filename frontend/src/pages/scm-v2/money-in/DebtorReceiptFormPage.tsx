
import { useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import {
  postableAccounts, useAccounts, useCreateDebtorReceipt, useDebtorReceiptAction, useUpdateDebtorReceipt,
} from '../../../vendor/scm/lib/accounting-queries';
import { useToastOptional } from '../../../hooks/useToast';
import { todayMY } from '../../../../../shared/src/vendor/shared/format';
import { pvStage } from '../PvDocParts';
import { DocFormShell } from './MoneyInDocPage';
import { ReceiptForm, blankReceipt, type DebtorSave, type DebtorSubmit } from './ReceiptForm';
import { useDebtorReceipt } from './moneyInDocQueries';
import { moneyInDocHref } from './moneyInDocs';
import { useIdempotencyKey } from '../../../lib/idempotency';
import ui from '../MoneyIn.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

export function DebtorReceiptFormPage({ id, debtorId, alloc, backLabel, onClose, openDoc }: {
  id: string | null;
  debtorId: string;
  alloc?: Record<string, number>;
  backLabel: string;
  onClose: () => void;
  openDoc: (href: string) => void;
}) {
  const toast = useToastOptional();
  const accountsQ = useAccounts();
  const detailQ = useDebtorReceipt(id);
  const create = useCreateDebtorReceipt();
  const idemKey = useIdempotencyKey();
  const update = useUpdateDebtorReceipt();
  const step = useDebtorReceiptAction();
  const [error, setError] = useState<string | null>(null);
  const accounts = useMemo(() => postableAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  const moneyAccounts = useMemo(() => accounts.filter((a) => a.acc_money === true), [accounts]);
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);
  const d = detailQ.data;
  const r = d?.receipt;
  const [today] = useState(todayMY);
  const initial = useMemo(() => (d
    ? {
      ...blankReceipt(String(d.receipt.receipt_date).slice(0, 10), d.receipt.debtor_id),
      bankAccountCode: d.receipt.bank_account_code,
      alloc: Object.fromEntries(d.allocations.map((a) => [a.billId, a.amountSen])),
    }
    : { ...blankReceipt(today, debtorId), alloc: alloc ?? {} }), [d, today, debtorId, alloc]);

  if (id && !r) {
    return (
      <DocFormShell title="Receipt" backLabel={backLabel} onBack={onClose}>
        <div className={ui.hint} role={detailQ.isError ? 'alert' : undefined}>
          {detailQ.isError ? `The receipt did not load — ${errText(detailQ.error)}` : 'Loading the receipt…'}
        </div>
      </DocFormShell>
    );
  }
  const stage = r ? pvStage(r) : null;
  if (r && stage && stage !== 'Draft' && stage !== 'Prepared') {
    const why = stage === 'Checked' ? 'has been checked — it is locked. Reject it back to Draft to change it.'
      : stage === 'Approved' ? 'is on the books — void it and raise it again to change it.'
        : 'is cancelled.';
    return (
      <DocFormShell title={`Edit ${r.receipt_number}`} backLabel={backLabel} onBack={onClose}>
        <div className={ui.hint} role="alert">{r.receipt_number} {why}</div>
      </DocFormShell>
    );
  }

  const onDebtor = (v: DebtorSubmit, how: DebtorSave) => {
    setError(null);
    if (r) {
      update.mutate({ receiptId: r.id, receiptDate: v.receiptDate, bankAccountCode: v.bankAccountCode, allocations: v.allocations }, {
        onSuccess: () => { toast?.success(`${r.receipt_number} saved`); onClose(); },
        onError: (e) => setError(errText(e)),
      });
      return;
    }
    create.mutate({ ...v, idempotencyKey: idemKey }, {
      onSuccess: (res) => {
        const no = res.receipt.receiptNumber;
        const made = res.receipt.id;
        const opened = () => { onClose(); if (made) openDoc(moneyInDocHref('debtorReceipt', made)); };
        if (how === 'prepare' && made) {
          step.mutate({ receiptId: made, action: 'submit' }, {
            onSuccess: () => { toast?.success(`${no} prepared · checked next`); opened(); },
            onError: (e) => { toast?.error(`${no} saved as Draft — not prepared: ${errText(e)}`); opened(); },
          });
          return;
        }
        toast?.success(`${no} saved as Draft`);
        opened();
      },
      onError: (e) => setError(errText(e)),
    });
  };

  return (
    <DocFormShell title={r ? `Edit ${r.receipt_number}` : 'New receipt · Other debtor'} backLabel={backLabel} onBack={onClose} bare>
      {error && <div role="alert" className={`${ui.hint} ${ui.checkBad}`}>{error}</div>}
      {r && (
        <div className={ui.formNote}><Info size={14} /><span>Saving keeps it {stage === 'Prepared' ? 'Prepared' : 'a Draft'} — nothing posts until it is approved.</span></div>
      )}
      <ReceiptForm key={r?.id ?? 'new'} kind="debtor" mode={r ? 'edit' : 'new'} door="debtors" initial={initial} debtorLocked={Boolean(r)}
        accounts={accounts} moneyAccounts={moneyAccounts} accountName={accountName}
        saving={create.isPending || update.isPending || step.isPending}
        onSundry={() => undefined} onDebtor={onDebtor} onCancel={onClose} />
    </DocFormShell>
  );
}
