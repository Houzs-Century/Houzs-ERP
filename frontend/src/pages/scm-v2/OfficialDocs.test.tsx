/* 欠正式单 (owner 2026-10-01, payment-request item 3) — Finance's list of the
   payments made on a proforma or quotation that still owe the official invoice.
   Pinned: the owed and the to-check rows, who asked and how long it has waited,
   the reader's note, and Finance's marks (checked, clear). */

import { fireEvent, render, screen } from '@testing-library/react';
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

import { OfficialDocs } from './OfficialDocs';

const row = (over: Row): Row => ({
  kind: 'PV', id: 'pv-1', number: 'HC-PV-2610-001', payee: 'MLE EVENTS SDN BHD', totalSen: 850_000, status: 'POSTED',
  paidAt: '2026-10-01T02:00:00Z', documentDate: '2026-10-01', state: 'OWED', note: null, since: '2026-09-21T02:00:00Z', by: 'Chew',
  request: { id: 'r1', requestNo: 'HC-PRQ-2610-001', requestedBy: 'James Seow' }, ...over,
});

describe('Official invoices owed', () => {
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
