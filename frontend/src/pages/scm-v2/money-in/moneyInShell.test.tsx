// Money in's shell (the owner's Claude Design, batch 5 step 0): the ask banner
// that replaces the modal confirms, where each document opens, and the words
// and tones each document's status reads in.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../hooks/useToast';
import { AskBanner, type Ask } from './AskBanner';
import { moneyInDocHref, moneyInListOf } from './moneyInDocs';
import {
  debtorBillTag, debtorTag, depositInvoiceTag, noteTag, officialReceiptTag, openRowStyle, salesInvoiceTag, sundryReceiptTag,
} from './moneyInStatus';

const voidAsk = (onGo = vi.fn()): Ask => ({
  title: 'Void HC-RCT-2610-004?',
  body: 'Its journal HC-JE-2610-0912 is reversed by a contra dated today. The receipt stays on file as voided.',
  tone: 'undo', goLabel: 'Void receipt', onGo,
});

describe('the ask banner', () => {
  it('asks inline: Keep it leaves, the go button runs the step', () => {
    const onGo = vi.fn();
    const onKeep = vi.fn();
    render(<AskBanner ask={voidAsk(onGo)} onKeep={onKeep} />);
    expect(screen.getByRole('region', { name: 'Void HC-RCT-2610-004?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Void receipt' }));
    expect(onGo).toHaveBeenCalledWith('');
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onKeep).toHaveBeenCalled();
  });

  it('waits for a required reason, and says so when pressed early', () => {
    const onGo = vi.fn();
    render(
      <ToastProvider>
        <AskBanner onKeep={() => undefined} ask={{
          title: 'Cancel HC-DI-2610-003?', body: 'It stays on file as cancelled and prints as void with your reason.',
          tone: 'undo', goLabel: 'Cancel invoice', reason: { placeholder: 'Why? e.g. payment keyed twice' }, onGo,
        }} />
      </ToastProvider>,
    );
    const go = screen.getByRole('button', { name: 'Cancel invoice' });
    expect(go.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(go);
    expect(onGo).not.toHaveBeenCalled();
    expect(screen.getByText('Type the reason first')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Why? e.g. payment keyed twice'), { target: { value: '  payment keyed twice ' } });
    fireEvent.click(go);
    expect(onGo).toHaveBeenCalledWith('payment keyed twice');
  });

  it('reads Not now on a step that moves the document on, and shows a refusal verbatim', () => {
    render(<AskBanner onKeep={() => undefined} error="A credit note stands against this invoice, so it can’t be cancelled or re-issued."
      ask={{ title: 'Approve HC-ODR-2610-002?', body: 'RM 1,200.00 books into Hong Leong Bank (310-0001).', tone: 'go', goLabel: 'Approve & post', onGo: vi.fn() }} />);
    expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('A credit note stands against this invoice');
  });

  it('shows only Keep it when the step is refused', () => {
    render(<AskBanner onKeep={() => undefined} ask={{ ...voidAsk(), canGo: false }} />);
    expect(screen.queryByRole('button', { name: 'Void receipt' })).toBeNull();
  });
});

describe('where a Money-in document opens', () => {
  it('each kind has its own page', () => {
    expect(moneyInDocHref('official', 12)).toBe('/scm/receipts/official/12');
    expect(moneyInDocHref('sundry', 'a b')).toBe('/scm/receipts/sundry/a%20b');
    expect(moneyInDocHref('debtorReceipt', 'r1')).toBe('/scm/receipts/debtor/r1');
    expect(moneyInDocHref('salesInvoice', 's1')).toBe('/scm/ar-invoices/sales/s1');
    expect(moneyInDocHref('depositInvoice', 'd1')).toBe('/scm/ar-invoices/deposit/d1');
    expect(moneyInDocHref('debtorBill', 'b1')).toBe('/scm/ar-invoices/bills/b1');
    expect(moneyInDocHref('note', 'n1')).toBe('/scm/credit-notes/n1');
    expect(moneyInDocHref('debtor', 'o1')).toBe('/scm/other-debtors/o1');
  });

  it('Back falls to the list the document lives on', () => {
    expect(moneyInListOf('sundry')).toEqual({ href: '/scm/receipts', label: 'Receipts' });
    expect(moneyInListOf('debtor')).toEqual({ href: '/scm/other-debtors', label: 'Debtor maintenance' });
    expect(moneyInListOf('note').label).toBe('Credit / debit notes');
  });
});

describe('the status words and tones', () => {
  it('official and sundry receipts', () => {
    expect(officialReceiptTag('DRAFT')).toEqual({ text: 'Draft', tone: 'warn' });
    expect(officialReceiptTag('FORMAL')).toEqual({ text: 'Formal', tone: 'calm' });
    expect(officialReceiptTag('CANCELLED')).toEqual({ text: 'Cancelled', tone: 'late' });
    expect(sundryReceiptTag('POSTED')).toEqual({ text: 'Posted', tone: 'calm' });
    expect(sundryReceiptTag('CANCELLED')).toEqual({ text: 'Voided', tone: 'late' });
  });

  it('deposit invoices: not posted, issued, closed, cancelled', () => {
    expect(depositInvoiceTag({ status: 'ISSUED', je_no: null, credit_note_id: null }).text).toBe('Not posted');
    expect(depositInvoiceTag({ status: 'ISSUED', je_no: 'JE-1', credit_note_id: null })).toEqual({ text: 'Issued', tone: 'info' });
    expect(depositInvoiceTag({ status: 'ISSUED', je_no: 'JE-1', credit_note_id: 'cn' })).toEqual({ text: 'Closed', tone: 'calm' });
    expect(depositInvoiceTag({ status: 'CANCELLED', je_no: 'JE-1', credit_note_id: null }).tone).toBe('late');
  });

  it('debtor bills and sales invoices by their money', () => {
    expect(debtorBillTag({ status: 'POSTED', total_sen: 100, received_sen: 0 })).toEqual({ text: 'Unpaid', tone: 'warn' });
    expect(debtorBillTag({ status: 'POSTED', total_sen: 100, received_sen: 40 })).toEqual({ text: 'Partly paid', tone: 'info' });
    expect(debtorBillTag({ status: 'PAID', total_sen: 100, received_sen: 100 })).toEqual({ text: 'Paid', tone: 'calm' });
    expect(salesInvoiceTag({ outstandingSen: 500, paidSen: 0, dueDate: '2026-10-01' }, '2026-10-29')).toEqual({ text: 'Overdue 28d', tone: 'late' });
    expect(salesInvoiceTag({ outstandingSen: 500, paidSen: 100, dueDate: '2026-11-30' }, '2026-10-29')).toEqual({ text: 'Partly paid', tone: 'info' });
    expect(salesInvoiceTag({ outstandingSen: 0, paidSen: 600, dueDate: '2026-10-01' }, '2026-10-29')).toEqual({ text: 'Paid', tone: 'calm' });
  });

  it('notes, debtors and the sand tint of an open document', () => {
    expect(noteTag('DRAFT')).toEqual({ text: 'Draft', tone: 'warn' });
    expect(noteTag('POSTED')).toEqual({ text: 'Posted', tone: 'calm' });
    expect(debtorTag(false)).toEqual({ text: 'Inactive', tone: 'late' });
    // The sand hex in light mode; a dark-only variable carries the dark tint.
    expect(openRowStyle(true)).toEqual({ background: 'var(--hz-dk-warning-bg, #fcf7ec)' });
    expect(openRowStyle(false)).toBeUndefined();
  });
});
