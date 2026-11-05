// ----------------------------------------------------------------------------
// BillFormPage — an other debtor's bill (or debit note) form in place of the
// page it was opened from (the owner's Claude Design, batch 5 §3.1 and §4.1):
// Invoices' New debtor bill / Copy as new / Edit (`?form=new|copy|edit`),
// Debtor maintenance's New bill, and the Credit / debit notes page's other
// debtor debit note. The same doors as before: POST /other-debtors/:id/bills
// (docKind DN for a debit note), PATCH /other-debtors/bills/:id (re-posts) —
// nothing posts differently. A posted bill opens its own page.
// ----------------------------------------------------------------------------

import { useMemo, useState, type ReactNode } from 'react';
import {
  postableAccounts, useAccountRoles, useAccounts, useCreateDebtorBill, useOtherDebtors, useUpdateDebtorBill,
} from '../../../vendor/scm/lib/accounting-queries';
import { useArBillDetail } from '../../../vendor/scm/lib/ar-invoice-queries';
import { useToastOptional } from '../../../hooks/useToast';
import { fmtSen } from '../../../vendor/shared/format';
import { DebtorBillForm, emptyBillForm, type BillFormSubmit, type BillFormValues } from '../DebtorBillForm';
import { DocFormShell } from './MoneyInDocPage';
import { moneyInDocHref } from './moneyInDocs';
import ui from '../MoneyIn.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** A bill's form values from the bill: an edit keeps everything, a copy keeps
 *  the description and lines and starts afresh — today's date, a new number on post. */
export const billValuesOf = (
  b: { bill_date: string; notes: string | null; lines?: Array<{ description: string | null; credit_account_code: string | null; amount_sen: number; project_id?: number | null }> },
  copy: boolean,
): BillFormValues => ({
  billDate: copy ? myt() : b.bill_date,
  notes: b.notes ?? '',
  lines: (b.lines ?? []).map((l, i) => ({ rid: i + 1, description: l.description ?? '', creditAccountCode: l.credit_account_code ?? '', amountSen: l.amount_sen, projectId: l.project_id ?? null })),
});

export function BillFormPage({ mode, id, debtorId, docKind, backLabel, titleExtra, onClose, openDoc }: {
  mode: 'new' | 'copy' | 'edit';
  /** The bill an Edit or a Copy starts from. */
  id: string | null;
  /** The debtor a New bill starts on ('' for none yet). */
  debtorId: string;
  /** 'DN': a debit note to the debtor — a bill of its own kind. */
  docKind?: 'DN';
  backLabel: string;
  titleExtra?: ReactNode;
  onClose: () => void;
  openDoc: (href: string) => void;
}) {
  const toast = useToastOptional();
  const detailQ = useArBillDetail(mode === 'new' ? null : id);
  const accountsQ = useAccounts();
  const rolesQ = useAccountRoles();
  const debtorsQ = useOtherDebtors();
  const create = useCreateDebtorBill();
  const update = useUpdateDebtorBill();
  const [error, setError] = useState<string | null>(null);
  const accounts = useMemo(() => postableAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);
  const d = detailQ.data;
  const bill = d?.bill;
  const dn = docKind === 'DN' || bill?.doc_kind === 'DN';
  const paper = dn ? 'debit note' : 'debtor bill';
  const ownDebtor = d?.debtor?.id ?? null;
  const debtors = useMemo(
    () => (debtorsQ.data?.debtors ?? []).filter((x) => x.is_active || x.id === ownDebtor).map((x) => ({ id: x.id, name: x.name, code: x.code })),
    [debtorsQ.data, ownDebtor],
  );
  const title = mode === 'edit' ? `Edit ${bill?.bill_number ?? ''}` : mode === 'copy' ? `New ${paper} · copy of ${bill?.bill_number ?? ''}` : `New ${paper}`;

  const submit = (values: BillFormSubmit, who: string) => {
    setError(null);
    if (mode === 'edit' && bill) {
      update.mutate({ billId: bill.id, body: values }, {
        onSuccess: (res) => { toast?.success(`${res.bill.billNumber} saved and re-posted`); onClose(); },
        onError: (e) => setError(errText(e)),
      });
      return;
    }
    create.mutate({ debtorId: who, ...values, ...(dn ? { docKind: 'DN' as const } : {}) }, {
      onSuccess: (res) => {
        toast?.success(`${res.bill.billNumber} posted · ${fmtSen(res.bill.totalSen)}`);
        onClose();
        if (res.bill.id) openDoc(moneyInDocHref('debtorBill', res.bill.id));
      },
      onError: (e) => setError(errText(e)),
    });
  };

  const waiting = mode !== 'new' && !d;
  return (
    <DocFormShell title={waiting ? 'Bill' : title.charAt(0).toUpperCase() + title.slice(1)} backLabel={backLabel} onBack={onClose} titleExtra={titleExtra} bare>
      {error && <div role="alert" className={`${ui.hint} ${ui.checkBad}`}>{error}</div>}
      {waiting
        ? <div className={ui.hint} role={detailQ.isError ? 'alert' : undefined}>{detailQ.isError ? `The bill did not load — ${errText(detailQ.error)}` : 'Loading the bill…'}</div>
        : (
          <DebtorBillForm key={`${mode}-${id ?? 'new'}-${dn ? 'dn' : 'inv'}`} mode={mode}
            initial={bill ? billValuesOf(bill, mode === 'copy') : emptyBillForm()}
            debtorId={ownDebtor ?? debtorId} debtors={debtors} controlCode={rolesQ.data?.roles.AR_OTHER ?? '305-0000'}
            accounts={accounts} accountName={accountName} receivedSen={mode === 'edit' ? Number(bill?.received_sen ?? 0) : 0}
            saving={create.isPending || update.isPending} onSubmit={submit} onCancel={onClose} />
        )}
    </DocFormShell>
  );
}
