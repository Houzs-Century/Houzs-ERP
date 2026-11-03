// ----------------------------------------------------------------------------
// useDebtorReceiptSteps — an other debtor's receipt walked through the payment
// voucher's four layers from a LIST row (the owner's Claude Design, batch 5
// §2.1 and §4.1, the design's odrActs): Draft → Prepare → Prepared → Check (or
// Withdraw) → Checked → Approve & post (the approver; the others see it
// waiting), Reject… back to Draft with a reason, and Void… once it is on the
// books. Receipts and Debtor maintenance share it; the receipt's own page
// (DebtorReceiptDoc) walks the same doors.
//
// Every step is a route that already exists (other-debtors.ts): Approve posts
// exactly what the Receipts page's post-now door posts. Who may press what is
// the server's — the buttons follow the same keys.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDebtorReceiptAction, useVoidDebtorReceipt } from '../../../vendor/scm/lib/accounting-queries';
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';
import { useToastOptional } from '../../../hooks/useToast';
import { fmtSen } from '../../../vendor/shared/format';
import { AskBanner, type Ask } from './AskBanner';
import type { MenuItem } from './MoneyInParts';
import type { DebtorStage } from './receiptsModel';

/** A debtor receipt as a list row knows it. */
export type DebtorStepRow = {
  id: string;
  no: string;
  stage: DebtorStage;
  totalSen: number;
  /** The money account, "310-0001 Hong Leong Bank". */
  bankCode: string;
  bankName: string | null;
  /** The bills it knocks off, by number. */
  bills: string[];
};

/** The row's next step as its button (the design's rowAct). */
export type StepButton = { label: string; primary: boolean; onClick: () => void; title?: string };

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
type Action = 'submit' | 'withdraw' | 'check' | 'reject' | 'approve';

export function useDebtorReceiptSteps() {
  const qc = useQueryClient();
  const toast = useToastOptional();
  const step = useDebtorReceiptAction();
  const voidIt = useVoidDebtorReceipt();
  const { can } = useHouzsAuth();
  /* The server's keys, step by step (other-debtors.ts). */
  const canWrite = can('scm.payment_voucher.write');
  const canCheck = can('scm.payment_voucher.check');
  const canApprove = can('scm.payment_voucher.approve');
  const canCancel = can('scm.payment_voucher.cancel');
  const [asking, setAsking] = useState<{ what: 'reject' | 'approve' | 'void'; row: DebtorStepRow } | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const busy = step.isPending || voidIt.isPending;

  /* The list it sits on, and Receipts' other kinds (batch 5 §1: ['receipts'] ⇄ the rest). */
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['receipts'] });
    void qc.invalidateQueries({ queryKey: ['journal-entries'] });
  };
  const run = (row: DebtorStepRow, action: Action, done: string, note?: string) => {
    setAskError(null);
    step.mutate({ receiptId: row.id, action, ...(note ? { note } : {}) }, {
      onSuccess: () => { refresh(); setAsking(null); toast?.success(done); },
      onError: (e) => { if (asking) setAskError(errText(e)); else toast?.error(errText(e)); },
    });
  };
  const ask = (what: 'reject' | 'approve' | 'void', row: DebtorStepRow) => { setAskError(null); setAsking({ what, row }); };

  /** The row's next step as its button: Prepare, Check, Approve & post — or
   *  null when it is not this person's to take (`waiting` says so). */
  const nextOf = (row: DebtorStepRow): { button: StepButton | null; waiting: boolean } => {
    switch (row.stage) {
      case 'Draft':
        return { button: canWrite ? { label: 'Prepare', primary: true, onClick: () => run(row, 'submit', `${row.no} prepared · checked next`) } : null, waiting: false };
      case 'Prepared':
        return { button: canCheck ? { label: 'Check', primary: true, onClick: () => run(row, 'check', `Checked · ${row.no} · approved next`) } : null, waiting: false };
      case 'Checked':
        /* f5 (no reminder yet): whoever cannot approve sees it waiting. */
        return canApprove
          ? { button: { label: 'Approve & post', primary: true, onClick: () => ask('approve', row) }, waiting: false }
          : { button: null, waiting: true };
      default:
        return { button: null, waiting: false };
    }
  };

  /** Every step the row offers, for its ⋯ menu: the moving ones, then the red ones. */
  const menuOf = (row: DebtorStepRow): { steps: MenuItem[]; undo: MenuItem[] } => {
    const steps: MenuItem[] = [];
    const undo: MenuItem[] = [];
    if (row.stage === 'Draft' && canWrite) steps.push({ label: 'Prepare', onClick: () => run(row, 'submit', `${row.no} prepared · checked next`) });
    if (row.stage === 'Prepared' && canCheck) steps.push({ label: 'Check', onClick: () => run(row, 'check', `Checked · ${row.no} · approved next`) });
    if (row.stage === 'Prepared' && canWrite) steps.push({ label: 'Withdraw', onClick: () => run(row, 'withdraw', `${row.no} withdrawn · back to Draft`) });
    if (row.stage === 'Checked' && canApprove) steps.push({ label: 'Approve & post', onClick: () => ask('approve', row) });
    if ((row.stage === 'Prepared' || row.stage === 'Checked') && (canCheck || canApprove)) undo.push({ label: 'Reject…', danger: true, onClick: () => ask('reject', row) });
    if (row.stage === 'Approved' && canCancel) undo.push({ label: 'Void…', danger: true, onClick: () => ask('void', row) });
    return { steps, undo };
  };

  const asks = (row: DebtorStepRow): Record<'reject' | 'approve' | 'void', Ask> => ({
    reject: {
      title: `Reject ${row.no}?`, body: 'It goes back to Draft. Every mark clears and it starts again.',
      tone: 'undo', goLabel: 'Reject', reason: { placeholder: 'Why? The preparer sees this' },
      onGo: (reason) => run(row, 'reject', `${row.no} · rejected · back to draft`, reason),
    },
    approve: {
      title: `Approve ${row.no}?`,
      body: `${fmtSen(row.totalSen)} books into ${row.bankName ?? row.bankCode} (${row.bankCode}) and ${row.bills.join(', ') || 'its bills'} ${row.bills.length > 1 ? 'are' : 'is'} knocked off.`,
      tone: 'go', goLabel: 'Approve & post',
      onGo: () => run(row, 'approve', `${row.no} approved & posted · ${fmtSen(row.totalSen)}`),
    },
    void: {
      title: `Void ${row.no}?`,
      body: 'Its journal is reversed by a contra dated today and the bills it knocked off owe that money again.',
      tone: 'undo', goLabel: 'Void receipt',
      onGo: () => {
        setAskError(null);
        voidIt.mutate(row.id, {
          onSuccess: () => { refresh(); setAsking(null); toast?.success(`${row.no} voided · journal reversed`); },
          onError: (e) => setAskError(errText(e)),
        });
      },
    },
  });

  const current = asking ? asks(asking.row)[asking.what] : null;
  const banner = current
    ? <AskBanner key={current.title} ask={current} busy={busy} error={askError} onKeep={() => setAsking(null)} />
    : null;
  return { nextOf, menuOf, banner, asking: asking != null, busy };
}
