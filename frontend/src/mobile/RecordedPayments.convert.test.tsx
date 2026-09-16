// Money moved from a cancelled order, on the phone's ledger (docs/bugs/0933):
// the Add payment sheet offers "Convert from cancelled SO" only while the
// customer has a cancelled order with money and never on an edit; its pick is
// the cancelled order, which fills an empty amount with what is left; a
// converted row is recorded with its source and amount alone; a stored
// converted row reads its source and has no pencil (the trash stays — deleting
// it is how the money goes back).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConvertSource } from '../vendor/scm/lib/so-money-queries';

const { addMutate, editMutate, useMobileConvertSources } = vi.hoisted(() => ({ addMutate: vi.fn(), editMutate: vi.fn(), useMobileConvertSources: vi.fn() }));
vi.mock('../vendor/scm/lib/sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAddSalesOrderPayment: () => ({ mutateAsync: addMutate }),
  useEditSalesOrderPayment: () => ({ mutateAsync: editMutate }),
  useAttachSalesOrderPaymentSlip: () => ({ mutateAsync: vi.fn() }),
  useDeleteSalesOrderPayment: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../vendor/scm/lib/so-dropdown-options-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), useSoDropdownOptions: () => ({ data: undefined }),
}));
vi.mock('./MobileOrderMoney', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useMobileConvertSources }));
vi.mock('../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => vi.fn() }));
vi.mock('../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => vi.fn(), usePrompt: () => vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => false, user: null }) }));

import { AddPaymentSheet, RecordedPaymentsList, type RecordedPayment } from './RecordedPayments';
import { PaymentInfoBlock } from './PaymentInfoBlock';
import { CONVERT_LABEL } from '../vendor/scm/lib/so-money-queries';

const DOC = '2990-SO-2609-050';
const SOURCES: ConvertSource[] = [{ docNo: '2990-SO-2607-024', customer: 'Yap Kah Heng', status: 'CANCELLED', cancelledOn: '2026-08-01', remainingSen: 336_500, bookedSen: 336_500, movableSen: 336_500, keepSen: 0 }];
const STAFF = [{ id: 'st-1', name: 'Aina' }];
const converted: RecordedPayment = {
  id: 'pay-c', version: 1, amount_sen: 336_500, method: 'converted', paid_at: '2026-07-03', account_sheet: 'Converted from 2990-SO-2607-024',
  collected_by_name: 'Aina', converted_from_so_doc_no: '2990-SO-2607-024', created_at: new Date().toISOString(),
};

beforeEach(() => {
  addMutate.mockReset(); editMutate.mockReset();
  useMobileConvertSources.mockImplementation((p: { docNo?: string | null }) => (p.docNo ? SOURCES : []));
});
afterEach(cleanup);

const methodOptions = () => Array.from((screen.getByText('Method').parentElement!.querySelector('select') as HTMLSelectElement).options).map((o) => o.value);

describe('AddPaymentSheet', () => {
  it('offers the method while the customer has a cancelled order with money, its pick fills the amount, and records source + amount alone', async () => {
    addMutate.mockResolvedValue({});
    const onSaved = vi.fn();
    render(<AddPaymentSheet docNo={DOC} staff={STAFF} onClose={() => {}} onSaved={onSaved} />);
    expect(methodOptions()).toContain(CONVERT_LABEL);
    const method = screen.getByText('Method').parentElement!.querySelector('select') as HTMLSelectElement;
    fireEvent.change(method, { target: { value: CONVERT_LABEL } });
    const record = screen.getByRole('button', { name: 'Record Payment' }) as HTMLButtonElement;
    /* An amount alone is not enough: the order it comes from is owed. */
    fireEvent.change(screen.getByText('Amount').parentElement!.querySelector('input')!, { target: { value: '100.00' } });
    expect(record.disabled).toBe(true);
    expect(screen.getByText('Pick the order the money comes from.')).toBeTruthy();
    fireEvent.change(screen.getByText('Amount').parentElement!.querySelector('input')!, { target: { value: '0.00' } });
    fireEvent.change(screen.getByLabelText('Cancelled order'), { target: { value: '2990-SO-2607-024' } });
    expect((screen.getByText('Amount').parentElement!.querySelector('input') as HTMLInputElement).value).toBe('3365.00');
    expect(record.disabled).toBe(false);
    fireEvent.click(record);
    await waitFor(() => expect(addMutate).toHaveBeenCalledTimes(1));
    const body = addMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({ docNo: DOC, method: 'converted', convertedFromDocNo: '2990-SO-2607-024', amountSen: 336_500 });
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body).not.toHaveProperty('paidAt');
    expect(body).not.toHaveProperty('collectedBy');
    expect(body).not.toHaveProperty('uploadSessionId');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('is not offered without a source, nor on an edit', () => {
    useMobileConvertSources.mockReturnValue([]);
    render(<AddPaymentSheet docNo={DOC} staff={STAFF} onClose={() => {}} onSaved={() => {}} />);
    expect(methodOptions()).not.toContain(CONVERT_LABEL);
    cleanup();
    useMobileConvertSources.mockImplementation((p: { docNo?: string | null }) => (p.docNo ? SOURCES : []));
    const cash: RecordedPayment = { ...converted, id: 'pay-1', method: 'cash', converted_from_so_doc_no: null, account_sheet: 'Cash' };
    render(<AddPaymentSheet docNo={DOC} staff={STAFF} editPayment={cash} onClose={() => {}} onSaved={() => {}} />);
    expect(useMobileConvertSources).toHaveBeenLastCalledWith({ docNo: null });
    expect(methodOptions()).not.toContain(CONVERT_LABEL);
  });
});

describe('a stored converted row', () => {
  it('reads its method and the order it came from', () => {
    render(<PaymentInfoBlock payment={converted} />);
    expect(screen.getByText('Convert from another SO')).toBeTruthy();
    expect(screen.getByText('from 2990-SO-2607-024')).toBeTruthy();
  });

  it('has no pencil, keeps the trash', () => {
    render(<RecordedPaymentsList docNo={DOC} payments={[converted]} staff={STAFF} canEdit draftUnlocked onChanged={() => {}} />);
    expect(screen.queryByLabelText('Edit payment')).toBeNull();
    expect(screen.getByLabelText('Delete payment')).toBeTruthy();
  });

  /* Money that LEFT an order (owner 2026-09-16): a negative converted row
     following the converted row it became, or the refund voucher. */
  it('a mirror reads as Moved out / Refund with where it went, and has neither pencil nor trash', () => {
    const movedOut: RecordedPayment = { ...converted, id: 'pay-m', amount_sen: -25_000, account_sheet: 'Moved to 2990-SO-2609-051', converted_from_so_doc_no: null, converted_to_so_doc_no: '2990-SO-2609-051' };
    render(<PaymentInfoBlock payment={movedOut} />);
    expect(screen.getByText('Moved out')).toBeTruthy();
    expect(screen.getByText('to 2990-SO-2609-051')).toBeTruthy();
    cleanup();
    const refunded: RecordedPayment = { ...converted, id: 'pay-r', amount_sen: -40_000, account_sheet: 'Refund 2990HPV-2609-012', converted_from_so_doc_no: null, refund_pv_id: 'pv-1' };
    render(<PaymentInfoBlock payment={refunded} />);
    expect(screen.getByText('Refund')).toBeTruthy();
    expect(screen.getByText(/Refund 2990HPV-2609-012/)).toBeTruthy();
    cleanup();
    render(<RecordedPaymentsList docNo={DOC} payments={[movedOut]} staff={STAFF} canEdit draftUnlocked onChanged={() => {}} />);
    expect(screen.queryByLabelText('Edit payment')).toBeNull();
    expect(screen.queryByLabelText('Delete payment')).toBeNull();
  });
});
