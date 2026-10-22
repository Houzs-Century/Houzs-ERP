/* The dialogs behind a CONTRACT row's 「Request payment」 and 「补正式单」 (owner
   2026-10-08). Pinned:
     • only a PDF or an image can be the bill — anything else shows, greyed,
       with why; the newest usable file starts ticked;
     • Next fetches the ticked files off the row (the PMS file route, typed by
       their extension) and opens the request form with them, the row's event
       and the row; sent, it says so and closes;
     • 补正式单 uploads the ticked file on the request as its official invoice;
       a difference the reader saw is said as a warning;
     • a file that cannot be fetched is said, and nothing opens. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { TaskAttachment } from './types';

const fetchBlob = vi.fn(async (_path: string, _type?: string | null) => new Blob(['%PDF-1.4 bytes'], { type: 'application/octet-stream' }));
vi.mock('../../api/client', () => ({ api: { fetchBlob: (p: string, t?: string | null) => fetchBlob(p, t) } }));
/* The shell's providers stand in the app; the dialogs only need the notifier, stubbed below. */
vi.mock('../scm-v2/Scm2990Shell', () => ({ Scm2990Shell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
type Seed = { files: File[]; projectId: number; checklistItemId: number; eventLabel: string };
vi.mock('../scm-v2/PaymentRequestForm', () => ({
  RequestForm: (p: { seed: Seed; onDone: (id: string) => void; onCancel: () => void }) => (
    <div aria-label="request form">
      {p.seed.files.map((f) => `${f.name}|${f.type}`).join(',')} · {p.seed.projectId} · {p.seed.checklistItemId} · {p.seed.eventLabel}
      <button type="button" onClick={() => p.onDone('r-new')}>sent</button>
    </div>
  ),
}));
const notifyFn = vi.fn();
vi.mock('../../vendor/scm/components/NotifyDialog', () => ({ useNotify: () => notifyFn }));
const uploadOfficial = vi.fn(async (_b: unknown) => ({ ok: true, received: [{ kind: 'PV', number: 'HC-HPV-2610-004' }], note: null as string | null }));
vi.mock('../../vendor/scm/lib/official-doc-queries', () => ({ useUploadOfficialDoc: () => ({ mutateAsync: uploadOfficial, isPending: false }) }));
vi.mock('../../vendor/scm/lib/payment-voucher-queries', () => ({ fileToBase64: async (f: File) => `b64:${f.name}` }));

const { default: PmsRequestModals, billMimeOf } = await import('./PmsRequestModals');

const att = (id: number, file_name: string, content_type: string | null): TaskAttachment => ({
  id, item_id: 5001, r2_key: `projects/348/checklist/${id}`, file_name, content_type, size_bytes: 1000,
  uploaded_by: 31, uploader_name: 'Wei Ling', uploaded_at: '2026-10-07T03:00:00Z', caption: null,
});
const ROW = [
  att(11, 'MITEC rental invoice.pdf', null),
  att(10, 'Agreement.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  att(9, 'Quotation.JPG', 'application/octet-stream'),
];

beforeEach(() => {
  fetchBlob.mockClear();
  notifyFn.mockClear();
  uploadOfficial.mockClear();
});

describe('which files can be a bill', () => {
  test('a PDF or an image, by its type or else its extension', () => {
    expect(billMimeOf({ file_name: 'a.pdf', content_type: null })).toBe('application/pdf');
    expect(billMimeOf({ file_name: 'a.JPG', content_type: 'application/octet-stream' })).toBe('image/jpeg');
    expect(billMimeOf({ file_name: 'scan', content_type: 'image/png' })).toBe('image/png');
    expect(billMimeOf({ file_name: 'a.xlsx', content_type: null })).toBeNull();
  });
});

describe('Request payment', () => {
  test('the newest usable file starts ticked; Next fetches the ticked ones and opens the form with the row\'s event and the row; sent, it says so', async () => {
    const onClose = vi.fn();
    render(<PmsRequestModals mode="request" itemId={5001} itemTitle="Agreement / Quotation" attachments={ROW} projectId={348} eventLabel="Kuala Lumpur [ZANOTTI] REX @ MITEC" onClose={onClose} />);
    expect((screen.getByRole('checkbox', { name: 'MITEC rental invoice.pdf' }) as HTMLInputElement).checked).toBe(true);
    const sheet = screen.getByRole('checkbox', { name: 'Agreement.xlsx' }) as HTMLInputElement;
    expect(sheet.disabled).toBe(true);
    expect(screen.getByText(/not a PDF or an image/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Quotation.JPG' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next — fill the request' }));
    const form = await screen.findByLabelText('request form');
    expect(fetchBlob.mock.calls).toEqual([
      ['/api/projects/attachments/projects/348/checklist/11', 'application/pdf'],
      ['/api/projects/attachments/projects/348/checklist/9', 'image/jpeg'],
    ]);
    expect(form.textContent).toContain('MITEC rental invoice.pdf|application/pdf,Quotation.JPG|image/jpeg · 348 · 5001 · Kuala Lumpur [ZANOTTI] REX @ MITEC');
    fireEvent.click(screen.getByRole('button', { name: 'sent' }));
    expect(notifyFn).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sent to Finance · 已提交' }));
    expect(onClose).toHaveBeenCalled();
  });

  test('a file that cannot be fetched is said, and the form does not open', async () => {
    fetchBlob.mockRejectedValueOnce(new Error('403 Forbidden'));
    render(<PmsRequestModals mode="request" itemId={5001} itemTitle="Agreement / Quotation" attachments={ROW} projectId={348} eventLabel="E" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next — fill the request' }));
    expect((await screen.findByRole('alert')).textContent).toContain("The row's file could not be fetched — 403 Forbidden");
    expect(screen.queryByLabelText('request form')).toBeNull();
  });
});

describe('补正式单 from the row', () => {
  test('the ticked file goes on the request as its official invoice; Finance checks it', async () => {
    const onClose = vi.fn();
    render(<PmsRequestModals mode="official" requestId="r1" requestNo="HC-PRQ-2610-002" attachments={[att(14, 'MITEC tax invoice.pdf', 'application/pdf')]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send as the official invoice' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(uploadOfficial).toHaveBeenCalledWith({ requestId: 'r1', file: { name: 'MITEC tax invoice.pdf', mime: 'application/pdf', dataBase64: 'b64:MITEC tax invoice.pdf' } });
    expect(notifyFn).toHaveBeenCalledWith({ title: 'Official invoice sent · 已补正式单', body: 'Finance checks it on HC-HPV-2610-004.', tone: 'info' });
  });

  test('a difference the reader saw is said as a warning', async () => {
    uploadOfficial.mockResolvedValueOnce({ ok: true, received: [{ kind: 'PV', number: 'HC-HPV-2610-004' }], note: 'The official invoice reads RM 13,000.00; the proforma read RM 12,720.00 (more by RM 280.00).' });
    render(<PmsRequestModals mode="official" requestId="r1" requestNo="HC-PRQ-2610-002" attachments={[att(14, 'MITEC tax invoice.pdf', 'application/pdf')]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send as the official invoice' }));
    await waitFor(() => expect(notifyFn).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', body: expect.stringContaining('more by RM 280.00') })));
  });
});
