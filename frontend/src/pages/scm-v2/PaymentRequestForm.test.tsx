/* The payment request form opened from a PMS row (owner 2026-10-08: 我的bd 会
   upload rental invoice 在这里 … 就在这里加request payment). Pinned:
     • the row's files are the bill from the start and are read the moment the
       form opens — the reader fills what it printed;
     • the event is the row's own, shown and not changeable — no Event picker,
       no other event suggested, even when the bill reads as another fair's;
     • sending raises the request with the row (checklistItemId) and its event,
       then attaches the row's files;
     • a request raised from a row keeps its event when edited. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

type Body = Record<string, unknown>;
const readAsync = vi.fn(async (_b: Body) => ({
  ok: true,
  bill: { billNo: 'INV-8812', billDate: '2026-10-01', totalSen: 1_272_000, vendorName: 'MITEC SDN BHD', dueDate: '2026-10-10' },
  hasEvents: true, eventBill: true,
  /* The reader's own guess is another fair — the row's event still stands. */
  eventSuggestions: [{ id: 349, code: 'E-349', name: 'Putrajaya [AKEMI] @ IOI CITY MALL', startDate: '2026-10-20', endDate: '2026-10-26', status: 'confirmed', archived: false, venue: null, brand: 'AKEMI', organizer: null, boothNo: null, score: 0.9, reasons: [] }],
  matches: [],
}));
const createAsync = vi.fn(async (_b: Body) => ({ ok: true, request: { id: 'r-new' } }));
const updateAsync = vi.fn(async (_b: Body) => ({ ok: true, request: { id: 'r1' } }));
const uploadAsync = vi.fn(async (_b: Body) => ({ ok: true }));
vi.mock('../../vendor/scm/lib/payment-request-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/payment-request-queries')>()),
  useReadRequestBill: () => ({ mutateAsync: readAsync, isPending: false }),
  useCreatePaymentRequest: () => ({ mutateAsync: createAsync, isPending: false }),
  useUpdatePaymentRequest: () => ({ mutateAsync: updateAsync, isPending: false }),
  useUploadPaymentRequestFile: () => ({ mutateAsync: uploadAsync, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => ({ data: [], isLoading: false }),
  useEventLabels: () => ({ data: undefined }),
}));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/payment-voucher-queries')>()),
  fileToBase64: async (f: File) => `b64:${f.name}`,
}));
const notifyFn = vi.fn();
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => notifyFn }));

const { RequestForm } = await import('./PaymentRequestForm');

const SEED = {
  files: [new File(['%PDF-1.4'], 'MITEC rental invoice.pdf', { type: 'application/pdf' })],
  projectId: 348, eventLabel: 'Kuala Lumpur [ZANOTTI] REX @ MITEC', checklistItemId: 5001,
};

describe('the request form from a PMS row', () => {
  test('reads the row\'s files at once, keeps the row\'s event, and sends with the row', async () => {
    const onDone = vi.fn();
    render(<RequestForm initial={null} hasEvents seed={SEED} onDone={onDone} onCancel={vi.fn()} />);
    expect(screen.getByText('MITEC rental invoice.pdf')).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('Pay to') as HTMLInputElement).value).toBe('MITEC SDN BHD'));
    expect(readAsync).toHaveBeenCalledTimes(1);
    expect(readAsync).toHaveBeenCalledWith({ files: [{ name: 'MITEC rental invoice.pdf', mime: 'application/pdf', dataBase64: 'b64:MITEC rental invoice.pdf' }] });
    /* The event: the row's, shown — no picker, no other fair suggested. */
    expect(screen.getByRole('note', { name: 'Event' }).textContent).toBe('Kuala Lumpur [ZANOTTI] REX @ MITEC');
    expect(screen.queryByRole('combobox', { name: 'Event' })).toBeNull();
    expect(screen.queryByText(/IOI CITY MALL/)).toBeNull();
    expect(screen.queryByLabelText('I cannot find this event')).toBeNull();

    fireEvent.change(screen.getByLabelText('What is it for'), { target: { value: 'Booth rental — ZANOTTI REX' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Finance' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('r-new'));
    expect(createAsync).toHaveBeenCalledWith(expect.objectContaining({
      checklistItemId: 5001, projectId: 348, payeeName: 'MITEC SDN BHD', amountSen: 1_272_000, billNo: 'INV-8812', eventBill: true, purpose: 'Booth rental — ZANOTTI REX',
    }));
    expect(uploadAsync).toHaveBeenCalledWith({ id: 'r-new', file: { name: 'MITEC rental invoice.pdf', mime: 'application/pdf', dataBase64: 'b64:MITEC rental invoice.pdf' } });
  });

  test('a request raised from a row keeps its event when edited — shown, not picked, and not sent as a change', async () => {
    const initial = {
      id: 'r1', request_no: 'HC-PRQ-2610-002', requested_by: 31, requested_by_name: 'Wei Ling', payee_name: 'MITEC SDN BHD', amount_sen: 1_272_000,
      due_date: null, purpose: 'Booth rental', project_id: 348, bank_name: null, bank_account_no: null, bank_account_name: null, status: 'SUBMITTED' as const,
      pv_id: null, finance_note: null, decided_by: null, decided_at: null, created_at: '2026-10-08T02:00:00Z', updated_at: '2026-10-08T02:00:00Z',
      stage: 'SUBMITTED' as const, voucher: null, checklist_item_id: 5001,
    };
    render(<RequestForm initial={initial} hasEvents onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('note', { name: 'Event' }).textContent).toBe('Event #348');
    expect(screen.queryByRole('combobox', { name: 'Event' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateAsync).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', projectId: 348 })));
    expect(updateAsync.mock.calls[0]![0]).not.toHaveProperty('checklistItemId');
  });
});
