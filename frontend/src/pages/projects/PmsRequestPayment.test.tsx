/* 「Request payment」 on an event's CONTRACT row (owner 2026-10-08: 我的bd 会
   upload rental invoice 在这里 … 就在这里加request payment … 做). Pinned:
     • the CONTRACT section is the payable one; a row's real files exclude the
       merged crew photos; the row's requests group by row;
     • the button with nothing on the row says so instead of opening; with
       files it opens the dialog with the row's files, event and row;
     • under the row: each request's number (linking to it), stage, amount,
       what answered it, the 欠正式单 state with Finance's remark — and
       「补正式单」 for the requester or Finance while the invoice is owed. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { PaymentRequest } from '../../vendor/scm/lib/payment-request-queries';
import type { TaskAttachment } from './types';

/* The dialogs have their own contract (PmsRequestModals.test.tsx); here they only have to open with the right things. */
vi.mock('./PmsRequestModals', () => ({
  default: (p: Record<string, unknown>) => (
    <div role="dialog" aria-label={`modal ${String(p.mode)}`}>
      {JSON.stringify({
        mode: p.mode, itemId: p.itemId ?? null, requestId: p.requestId ?? null, projectId: p.projectId ?? null, eventLabel: p.eventLabel ?? null,
        files: (p.attachments as TaskAttachment[]).map((a) => a.file_name),
      })}
    </div>
  ),
}));

const { RequestPaymentButton, RowRequests, isPayableSectionName, requestsByRow, rowFiles } = await import('./PmsRequestPayment');

const att = (id: number, file_name: string): TaskAttachment => ({
  id, item_id: 5001, r2_key: `projects/348/${id}.pdf`, file_name, content_type: 'application/pdf', size_bytes: 1000,
  uploaded_by: 31, uploader_name: 'Wei Ling', uploaded_at: '2026-10-07T03:00:00Z', caption: null,
});
const req = (over: Partial<PaymentRequest>): PaymentRequest => ({
  id: 'r1', request_no: 'HC-PRQ-2610-002', requested_by: 31, requested_by_name: 'Wei Ling', payee_name: 'MITEC SDN BHD',
  amount_sen: 1_272_000, due_date: '2026-10-10', purpose: 'Booth rental', project_id: 348, bank_name: null, bank_account_no: null,
  bank_account_name: null, status: 'SUBMITTED', pv_id: null, finance_note: null, decided_by: null, decided_at: null,
  created_at: '2026-10-08T02:00:00Z', updated_at: '2026-10-08T02:00:00Z', stage: 'SUBMITTED', voucher: null, checklist_item_id: 5001,
  ...over,
});

describe('the helpers', () => {
  test('CONTRACT is payable; real files only; requests by row', () => {
    expect(isPayableSectionName('CONTRACT')).toBe(true);
    expect(isPayableSectionName(' contract ')).toBe(true);
    expect(isPayableSectionName('BOOTH SETUP')).toBe(false);
    expect(isPayableSectionName(null)).toBe(false);
    expect(rowFiles([att(1, 'a.pdf'), att(-4, 'crew photo.jpg')]).map((a) => a.id)).toEqual([1]);
    const by = requestsByRow([req({ id: 'a' }), req({ id: 'b', checklist_item_id: 5002 }), req({ id: 'c' }), req({ id: 'd', checklist_item_id: null })]);
    expect([...by.entries()].map(([k, v]) => [k, v.map((r) => r.id)])).toEqual([[5001, ['a', 'c']], [5002, ['b']]]);
  });
});

describe('the row\'s 「Request payment」', () => {
  const button = (attachments: TaskAttachment[], onNoFiles = vi.fn()) => {
    render(<RequestPaymentButton itemId={5001} itemTitle="Agreement / Quotation" attachments={attachments} projectId={348}
      eventLabel="Kuala Lumpur [ZANOTTI] REX @ MITEC" className="btn" onNoFiles={onNoFiles} />);
    return onNoFiles;
  };

  test('with nothing on the row it says so and opens nothing', () => {
    const said = button([att(-1, 'crew photo.jpg')]);
    fireEvent.click(screen.getByRole('button', { name: /Request payment/ }));
    expect(said).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('with files it opens the dialog with the row\'s files, its event and the row', async () => {
    const said = button([att(12, 'MITEC rental invoice.pdf'), att(-1, 'crew photo.jpg'), att(9, 'Agreement.pdf')]);
    fireEvent.click(screen.getByRole('button', { name: /Request payment/ }));
    const dialog = await screen.findByRole('dialog', { name: 'modal request' });
    expect(JSON.parse(dialog.textContent)).toEqual({
      mode: 'request', itemId: 5001, requestId: null, projectId: 348, eventLabel: 'Kuala Lumpur [ZANOTTI] REX @ MITEC',
      files: ['MITEC rental invoice.pdf', 'Agreement.pdf'],
    });
    expect(said).not.toHaveBeenCalled();
  });
});

describe('the row\'s requests', () => {
  const owed = req({
    stage: 'PROCESSING', status: 'VOUCHERED', pv_id: 'pv-4',
    voucher: { id: 'pv-4', pvNumber: 'HC-HPV-2610-004', status: 'DRAFT', approvedAt: null, postedAt: null, bankConfirmed: false },
    officialDoc: { state: 'OWED', note: 'Proforma only — follow up the actual invoice' },
  });

  test('number, stage, amount, answer, 欠正式单 with Finance\'s remark; 补正式单 for the requester', async () => {
    render(<MemoryRouter><RowRequests requests={[owed, req({ id: 'r2', request_no: 'HC-PRQ-2610-003', installment_no: 2, amount_sen: 636_000 })]}
      attachments={[att(14, 'MITEC tax invoice.pdf')]} finance={false} meId={31} /></MemoryRouter>);
    const box = screen.getByLabelText('Payment requests from this row');
    const link = within(box).getByRole('link', { name: 'HC-PRQ-2610-002' });
    expect(link.getAttribute('href')).toBe('/scm/payment-requests?open=r1');
    expect(box.textContent).toContain('Finance processing · 处理中');
    expect(box.textContent).toContain('RM 12,720.00');
    expect(box.textContent).toContain('HC-HPV-2610-004');
    expect(box.textContent).toContain('Official invoice owed · 欠正式单');
    expect(box.textContent).toContain('Proforma only — follow up the actual invoice');
    expect(box.textContent).toContain('#2 · balance');
    /* One owed request, one button. */
    const send = within(box).getAllByRole('button', { name: 'Send the actual invoice · 补正式单' });
    expect(send).toHaveLength(1);
    fireEvent.click(send[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'modal official' });
    expect(JSON.parse(dialog.textContent)).toMatchObject({ mode: 'official', requestId: 'r1', files: ['MITEC tax invoice.pdf'] });
  });

  test('another requester\'s owed request: no button for them, the button for Finance; none at all, nothing shows', () => {
    const theirs = { ...owed, requested_by: 32 };
    const { unmount } = render(<MemoryRouter><RowRequests requests={[theirs]} attachments={[]} finance={false} meId={31} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Send the actual invoice · 补正式单' })).toBeNull();
    unmount();
    const again = render(<MemoryRouter><RowRequests requests={[theirs]} attachments={[]} finance meId={9} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Send the actual invoice · 补正式单' })).toBeTruthy();
    again.unmount();
    const { container } = render(<MemoryRouter><RowRequests requests={[]} attachments={[]} finance meId={9} /></MemoryRouter>);
    expect(container.textContent).toBe('');
  });
});
