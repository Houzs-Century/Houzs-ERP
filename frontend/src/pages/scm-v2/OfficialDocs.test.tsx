/* 欠正式单 (owner 2026-10-01, payment-request item 3) — Finance's list of the
   payments made on a proforma or quotation that still owe the official invoice.
   Pinned: the owed and the to-check rows, who asked and how long it has waited,
   the reader's note, and Finance's marks (checked, clear) — and Finance's
   remark on what to follow up (owner 2026-10-08). */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

type Row = Record<string, unknown>;
let rows: Row[] = [];
const markOfficial = vi.fn();
vi.mock('../../vendor/scm/lib/official-doc-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/official-doc-queries')>()),
  useOfficialDocs: () => ({ data: { rows }, isLoading: false, isError: false, error: null }),
  useMarkOfficialDoc: () => ({ mutate: markOfficial, isPending: false }),
}));
/* The remark is asked in the in-app prompt (the SCM shell's provider in the app). */
const promptFn = vi.fn(async (): Promise<string | null> => 'Ask MITEC for the tax invoice');
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ usePrompt: () => promptFn, useConfirm: () => async () => true }));

import { OfficialDocs } from './OfficialDocs';

const row = (over: Row): Row => ({
  kind: 'PV', id: 'pv-1', number: 'HC-PV-2610-001', payee: 'MLE EVENTS SDN BHD', totalSen: 850_000, status: 'POSTED',
  paidAt: '2026-10-01T02:00:00Z', documentDate: '2026-10-01', state: 'OWED', note: null, since: '2026-09-21T02:00:00Z', by: 'Chew',
  request: { id: 'r1', requestNo: 'HC-PRQ-2610-001', requestedBy: 'James Seow' }, ...over,
});

describe('Official invoices owed', () => {
  test('Finance writes the remark — what to follow up — on an owed payment, and changes it; Cancel leaves it', async () => {
    rows = [row({ request: null })];
    markOfficial.mockClear();
    const { unmount } = render(<MemoryRouter><OfficialDocs /></MemoryRouter>);
    fireEvent.click(screen.getByText('Add a remark'));
    await waitFor(() => expect(markOfficial).toHaveBeenCalledWith({ kind: 'PV', id: 'pv-1', state: 'OWED', note: 'Ask MITEC for the tax invoice' }));
    expect(promptFn).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ label: 'Remark — what to follow up (optional)' }) }));
    unmount();
    /* A remark already there: offered to change, shown in the prompt; Cancel marks nothing. */
    rows = [row({ request: null, note: 'Proforma only' })];
    markOfficial.mockClear();
    promptFn.mockResolvedValueOnce(null);
    render(<MemoryRouter><OfficialDocs /></MemoryRouter>);
    fireEvent.click(screen.getByText('Change the remark'));
    await waitFor(() => expect(promptFn).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Now: Proforma only' })));
    expect(markOfficial).not.toHaveBeenCalled();
  });

  test('owed first; to check with the reader\'s note; Finance checks one off', () => {
    rows = [
      row({}),
      row({ id: 'pv-2', number: 'HC-PV-2610-002', state: 'RECEIVED', note: 'The official invoice reads RM 9,000.00; the proforma read RM 8,500.00 (more by RM 500.00).' }),
      row({ kind: 'API', id: 'api-1', number: 'HC-API-2610-001', payee: 'EASTERN DECORATOR', request: null }),
    ];
    markOfficial.mockClear();
    render(<MemoryRouter><OfficialDocs /></MemoryRouter>);
    expect(screen.getByText('Owed · 欠正式单 (2)')).toBeTruthy();
    expect(screen.getByText('HC-PV-2610-001')).toBeTruthy();
    expect(screen.getByText('HC-API-2610-001')).toBeTruthy();
    expect(screen.queryByText('HC-PV-2610-002')).toBeNull();
    /* Asked by the requester, or by Finance itself. */
    expect(screen.getByText('James Seow')).toBeTruthy();
    expect(screen.getByText('Finance')).toBeTruthy();

    fireEvent.click(screen.getByText('To check · 待核对 (1)'));
    expect(screen.getByText(/the proforma read RM 8,500\.00/)).toBeTruthy();
    fireEvent.click(screen.getByText('Checked ✓ · 核对好了'));
    expect(markOfficial).toHaveBeenCalledWith({ kind: 'PV', id: 'pv-2', state: 'CHECKED' });
  });

  test('an owed mark can be checked straight away or cleared; nothing owed says so', () => {
    rows = [row({ request: null })];
    markOfficial.mockClear();
    const { unmount } = render(<MemoryRouter><OfficialDocs /></MemoryRouter>);
    /* 漏洞 2: a voucher answering no request has nobody to upload — Finance checks it here. */
    fireEvent.click(screen.getByText('Checked ✓ · 核对好了'));
    expect(markOfficial).toHaveBeenCalledWith({ kind: 'PV', id: 'pv-1', state: 'CHECKED' });
    fireEvent.click(screen.getByText('Clear the mark'));
    expect(markOfficial).toHaveBeenCalledWith({ kind: 'PV', id: 'pv-1', state: null });
    unmount();
    rows = [];
    render(<MemoryRouter><OfficialDocs /></MemoryRouter>);
    expect(screen.getByText('No payment owes its official invoice.')).toBeTruthy();
  });
});
