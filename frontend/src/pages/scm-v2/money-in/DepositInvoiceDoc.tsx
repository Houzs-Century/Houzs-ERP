// ----------------------------------------------------------------------------
// DepositInvoiceDoc — /scm/ar-invoices/deposit/:id, one deposit invoice as a
// page (the owner's Claude Design, batch 5 §8; it was a pop-out over the
// Deposit invoices list). The invoice, its customer and order, the payment it
// was born from, its journal, what closed it or refunded it, the page as it
// prints — and the two steps it had: Post to ledger (a journal refused at
// birth) and Cancel with a reason (refused while a credit note stands against
// it). The same hooks and endpoints the pop-out used; nothing posts
// differently.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCancelDepositInvoice, useDepositInvoiceDetail, useDepositInvoiceSheet, usePostDepositInvoice,
  type DepositInvoice,
} from '../../../vendor/scm/lib/deposit-invoice-queries';
import { useAccountRoles, useAccounts } from '../../../vendor/scm/lib/accounting-queries';
import { orderAddressLines } from '../../../vendor/scm/lib/order-address';
import type { PdfAction } from '../../../vendor/scm/lib/pdf-common';
import { fmtDate, fmtSen } from '../../../vendor/shared/format';
import { useToastOptional } from '../../../hooks/useToast';
import { DataTable, type Column } from '../../../components/DataTable';
import { AskBanner, type Ask } from './AskBanner';
import {
  DocBooks, DocSection, DocState, MoneyInDocPage, PaperPreview, byTime, journalTrail, personOf,
  type DocAction, type DocFact, type TrailStep,
} from './MoneyInDocPage';
import { useDocJournals } from './moneyInDocQueries';
import { depositInvoiceTag, methodWord } from './moneyInStatus';
import { moneyInDocHref } from './moneyInDocs';
import ui from '../MoneyIn.module.css';
import s from './MoneyInDoc.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'That was not accepted.');

type RefundNote = NonNullable<DepositInvoice['refund_notes']>[number];
const REFUND_COLUMNS: Column<RefundNote>[] = [
  { key: 'note', label: 'Credit note', render: (n) => n.note_number, getValue: (n) => n.note_number },
  { key: 'date', label: 'Date', render: (n) => fmtDate(n.note_date), getValue: (n) => n.note_date },
  { key: 'status', label: 'Status', render: (n) => n.status, getValue: (n) => n.status },
  { key: 'pv', label: 'Refund voucher', render: (n) => n.pv_number ?? '—', getValue: (n) => n.pv_number ?? '' },
  { key: 'amount', label: 'Amount', align: 'right', render: (n) => fmtSen(n.total_sen), getValue: (n) => n.total_sen },
];

/** A credit note against the invoice — the final invoice's close-out, a refund's
 *  or a conversion's — means it is never cancelled or re-issued (the server
 *  refuses invoice_noted; the closed-DI guard, owner 2026-09-21). */
const NOTED = 'A credit note stands against this invoice, so it can’t be cancelled or re-issued.';

export const DepositInvoiceDoc = () => {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToastOptional();
  const q = useDepositInvoiceDetail(id || null);
  const sheetQ = useDepositInvoiceSheet(id || null);
  const inv = q.data?.invoice;
  const pay = q.data?.payment ?? null;
  const sheet = sheetQ.data ?? null;
  const journals = useDocJournals('DI', inv?.di_number);
  const accountsQ = useAccounts();
  const rolesQ = useAccountRoles();
  const post = usePostDepositInvoice();
  const cancel = useCancelDepositInvoice();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);
  /* The page as it prints: the sheet (the row with its order's address and figures). */
  const draw = useMemo(() => (sheet
    ? () => import('../../../vendor/scm/lib/deposit-invoice-pdf').then(({ depositInvoicePdfBlob }) => depositInvoicePdfBlob(sheet))
    : null), [sheet]);

  if (!inv) return <DocState kind="depositInvoice" loading={q.isLoading} error={q.error} />;

  const refunds = inv.refund_notes ?? [];
  const noted = Boolean(inv.credit_note_id) || refunds.some((n) => n.status !== 'CANCELLED');
  const issued = inv.status === 'ISSUED';
  const refreshJournal = () => { void qc.invalidateQueries({ queryKey: ['journal-entries'] }); };

  /* A cancelled invoice prints too — as void, with its reason (docs/bugs/0834). */
  const printOne = async (action: PdfAction) => {
    if (printing) return;
    setPrinting(true); setFailure(null);
    try {
      const { generateDepositInvoicePdf } = await import('../../../vendor/scm/lib/deposit-invoice-pdf');
      await generateDepositInvoicePdf(sheet ?? inv, { action });
    } catch (e) { setFailure(errText(e)); } finally { setPrinting(false); }
  };

  const actions: DocAction[] = [];
  if (issued) {
    actions.push({ label: 'Cancel…', kind: 'danger', refused: noted ? NOTED : null, busy: cancel.isPending, onClick: () => { setAskError(null); setAsking(true); } });
  }
  if (issued && !inv.je_no) {
    actions.push({
      label: 'Post to ledger', kind: 'primary', busy: post.isPending,
      onClick: () => {
        setFailure(null);
        post.mutate(inv.id, {
          onSuccess: (r) => { refreshJournal(); toast?.success(`${inv.di_number} posted · ${r.jeNo}`); },
          onError: (e) => setFailure(errText(e)),
        });
      },
    });
  }

  const ask: Ask = {
    title: `Cancel ${inv.di_number}?`,
    body: `${inv.je_no ? `Its journal ${inv.je_no} is reversed by a contra dated today. ` : ''}It stays on file as cancelled and prints as void with your reason.`,
    tone: 'undo', goLabel: 'Cancel invoice', reason: { placeholder: 'Why? e.g. payment keyed twice' },
    onGo: (reason) => {
      setAskError(null);
      cancel.mutate({ id: inv.id, reason }, {
        onSuccess: (r) => { setAsking(false); refreshJournal(); toast?.success(`${inv.di_number} cancelled${r.contraJeNo ? ' · journal reversed' : ''}`); },
        onError: (e) => setAskError(errText(e)),
      });
    },
  };

  const roles = rolesQ.data?.roles ?? {};
  const named = (code: string | undefined) => (code ? `${code}${accountName(code) ? ` ${accountName(code)}` : ''}` : '—');
  const party = inv.party_name ?? inv.party_code ?? '—';
  const facts: DocFact[] = [
    { label: 'Invoice date', value: fmtDate(inv.invoice_date) },
    { label: 'Sales order', value: inv.so_doc_no, to: `/scm/sales-orders/${encodeURIComponent(inv.so_doc_no)}` },
    {
      label: 'Payment',
      value: pay
        ? `${methodWord(pay.method)}${pay.merchant_provider ? ` · ${pay.merchant_provider}` : ''}${pay.online_type ? ` · ${pay.online_type}` : ''} · ${fmtDate(pay.paid_at)} · ${fmtSen(pay.amount_sen)}`
        : 'The payment row is gone',
      tone: pay ? null : 'late',
    },
    { label: 'Journal', value: inv.je_no ?? 'Not posted', tone: inv.je_no ? null : 'late' },
    { label: 'Closed by', value: inv.credit_note_number ?? (inv.credit_note_id ? 'A credit note' : 'Open until the final invoice') },
  ];
  if (inv.status === 'CANCELLED') {
    facts.push({ label: 'Cancelled', value: [personOf(inv.cancelled_by), fmtDate(inv.cancelled_at)].filter(Boolean).join(' · ') || '—', tone: 'late' });
  }
  if ((inv.refunded_sen ?? 0) > 0) facts.push({ label: 'Refunded', value: fmtSen(inv.refunded_sen ?? 0) });

  const trail: TrailStep[] = byTime([
    { key: 'issued', act: 'Issued', who: personOf(inv.created_by), when: inv.created_at },
    ...journalTrail(journals.data),
    ...refunds.map((n): TrailStep => ({ key: `refund-${n.note_number}`, act: `Refunded · ${n.note_number}`, when: n.note_date, note: n.pv_number ? `Refund voucher ${n.pv_number}` : null })),
    ...(inv.status === 'CANCELLED'
      ? [{ key: 'cancelled', act: 'Cancelled', who: personOf(inv.cancelled_by), when: inv.cancelled_at, note: inv.cancel_reason, undo: true }]
      : []),
  ]);

  return (
    <MoneyInDocPage
      kind="depositInvoice" kindLabel="Deposit invoice" number={inv.di_number} tag={depositInvoiceTag(inv)}
      sub={inv.status === 'CANCELLED' ? `void · ${inv.cancel_reason ?? 'no reason given'}` : null}
      taskLink={{ type: 'Deposit invoice', no: inv.di_number, name: party, to: moneyInDocHref('depositInvoice', inv.id) }}
      onPrint={() => void printOne('print')} printing={printing}
      actions={actions}
      ask={asking ? <AskBanner key={ask.title} ask={ask} busy={cancel.isPending} error={askError} onKeep={() => setAsking(false)} /> : null}
      notice={(
        <>
          {issued && noted && <div className={s.note}>{NOTED} Cancelling the final invoice or the refund voucher takes the note back first.</div>}
          {failure && <div role="alert" className={`${s.note} ${s.toneLate}`}>{failure}</div>}
        </>
      )}
      party={{
        label: 'Customer', name: party,
        lines: [
          inv.party_name && inv.party_code ? inv.party_code : null,
          ...(sheet?.order ? orderAddressLines(sheet.order) : []),
          sheet?.order ? [sheet.order.phone, sheet.order.email].filter(Boolean).join(' · ') : null,
        ],
      }}
      amount={{ label: 'Amount', value: fmtSen(inv.amount_sen), sub: `${methodWord(inv.method)} · ${fmtDate(inv.invoice_date)}` }}
      facts={facts}
      books={(
        <DocBooks journals={journals.data} loading={journals.isLoading} accountName={accountName}
          preview={<><b>Not posted</b> · Dr {named(roles.AR)} ({party}) · Cr {named(roles.DEPOSIT_INCOME)} · {fmtSen(inv.amount_sen)}</>} />
      )}
      trail={trail}
    >
      {refunds.length > 0 && (
        <DocSection title="Refunds">
          <div className={s.note} style={{ marginBottom: 8 }}>
            Refunded {fmtSen(inv.refunded_sen ?? 0)} — the sale this invoice booked is taken back by credit note, one per refund voucher.
          </div>
          <DataTable<RefundNote> tableId="mi-di-refunds" embedded columns={REFUND_COLUMNS} rows={refunds} getRowKey={(n) => n.note_number} />
        </DocSection>
      )}
      <DocSection title="As printed" buttons={(
        <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={() => void printOne('save')} disabled={printing}>Save PDF</button>
      )}>
        {sheetQ.isError
          ? <div role="alert" className={`${s.empty} ${s.toneLate}`}>The invoice page did not load — {errText(sheetQ.error)}</div>
          : <PaperPreview title={`Deposit invoice ${inv.di_number} as printed`} draw={draw} />}
      </DocSection>
    </MoneyInDocPage>
  );
};
