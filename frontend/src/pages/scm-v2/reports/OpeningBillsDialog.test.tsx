/* Opening bills in the Cash Flow (owner 2026-11-25, 「要，做 A」). Pinned: each
   supplier with what is still owed, what Automatic gives (an account, a
   category, or the creditor control) and its pick; a pick sends one change —
   an account, a category, or Automatic to clear it; a supplier's bills open
   under it, each with its own pick that falls back to the supplier's line;
   without the right the picks only read. The server half is
   backend/tests/cashFlowOpeningBillPlaces.test.ts. Made-up names and figures. */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { OpeningBillRow, OpeningBillsPayload } from '../../../vendor/scm/lib/opening-bill-places-queries';

const DATA: OpeningBillsPayload = {
  suppliers: [
    { id: 'A', code: 'A001', name: 'Alpha Stands', bills: 3, openBills: 1, owingSen: 120_000, paidSen: 50_000, billsSet: 0, set: null, auto: { kind: 'account', code: '900-X001', name: 'STAND BUILD' } },
    { id: 'B', code: 'B001', name: 'Beta Mixed', bills: 2, openBills: 0, owingSen: 0, paidSen: 30_000, billsSet: 1, set: { kind: 'category', id: 'cf:exh', label: 'EXHIBITION' }, auto: null },
    { id: 'C', code: 'C001', name: 'Gamma None', bills: 1, openBills: 1, owingSen: 5_000, paidSen: 0, billsSet: 0, set: null, auto: null },
  ],
  accounts: [{ code: '601-0001', name: 'PURCHASE OF BEDDING' }, { code: '900-X001', name: 'STAND BUILD' }],
  categories: [{ id: 'cf:out', label: 'OUTFLOWS', path: 'OUTFLOWS' }, { id: 'cf:exh', label: 'EXHIBITION', path: 'OUTFLOWS › EXHIBITION' }],
};
const BILLS: OpeningBillRow[] = [
  { id: 'b1', number: 'API-1', date: '2026-08-31', text: 'MARKETING SERVICE', totalSen: 20_000, paidSen: 20_000, status: 'PAID', set: null },
  { id: 'b2', number: 'API-2', date: '2026-08-31', text: 'SALARY', totalSen: 10_000, paidSen: 10_000, status: 'PAID', set: { kind: 'account', code: '601-0001', name: 'PURCHASE OF BEDDING' } },
];
const mutate = vi.fn();
vi.mock('../../../vendor/scm/lib/opening-bill-places-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useOpeningBills: () => ({ data: DATA, isError: false }),
  useOpeningBillRows: (id: string | null) => ({ data: id ? { bills: BILLS } : undefined, isError: false }),
  useSaveOpeningBillPlace: () => ({ mutate, isPending: false }),
}));
const { OpeningBillsDialog, changeOf, valueOf } = await import('./OpeningBillsDialog');

const pick = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;

beforeEach(() => { mutate.mockClear(); });

describe('the picks as values', () => {
  test('an account, a category (an id that holds colons), and none', () => {
    expect(valueOf({ kind: 'account', code: '900-X001', name: 'STAND BUILD' })).toBe('acc:900-X001');
    expect(valueOf({ kind: 'category', id: 'cf:ops:exh', label: 'X' })).toBe('cat:cf:ops:exh');
    expect(valueOf(null)).toBe('');
    expect(changeOf('cat:cf:ops:exh')).toEqual({ account: null, category: 'cf:ops:exh' });
    expect(changeOf('acc:900-X001')).toEqual({ account: '900-X001', category: null });
    expect(changeOf('')).toEqual({ account: null, category: null });
  });
});

describe('Opening bills in the Cash Flow', () => {
  test('each supplier: what is owed, what Automatic gives, its pick', () => {
    render(<OpeningBillsDialog onClose={() => {}} canWrite />);
    const alpha = document.querySelector('[data-row="sup:A"]') as HTMLElement;
    expect(alpha.textContent).toContain('1 open of 3');
    expect(alpha.textContent).toContain('1,200.00');
    expect(alpha.textContent).toContain('900-X001 · STAND BUILD');
    expect(pick('Alpha Stands Cash Flow line').value).toBe('');
    expect(pick('Beta Mixed Cash Flow line').value).toBe('cat:cf:exh');
    expect((document.querySelector('[data-row="sup:C"]') as HTMLElement).textContent).toContain('Creditor control');
    expect((document.querySelector('[data-row="sup:B"]') as HTMLElement).textContent).toContain('1 with their own line');
  });

  test('a pick sends one change: an account, a category, or Automatic to clear it', () => {
    render(<OpeningBillsDialog onClose={() => {}} canWrite />);
    fireEvent.change(pick('Alpha Stands Cash Flow line'), { target: { value: 'acc:601-0001' } });
    expect(mutate.mock.calls[0]![0]).toEqual({ supplierId: 'A', billId: null, account: '601-0001', category: null });
    fireEvent.change(pick('Gamma None Cash Flow line'), { target: { value: 'cat:cf:exh' } });
    expect(mutate.mock.calls[1]![0]).toEqual({ supplierId: 'C', billId: null, account: null, category: 'cf:exh' });
    fireEvent.change(pick('Beta Mixed Cash Flow line'), { target: { value: '' } });
    expect(mutate.mock.calls[2]![0]).toEqual({ supplierId: 'B', billId: null, account: null, category: null });
  });

  test('a supplier\'s bills open under it, each falling back to the supplier\'s line', () => {
    render(<OpeningBillsDialog onClose={() => {}} canWrite />);
    fireEvent.click(screen.getByRole('button', { name: 'Bills (2)' }));
    expect(screen.getByText('MARKETING SERVICE')).toBeTruthy();
    const first = pick('API-1 Cash Flow line');
    expect(first.value).toBe('');
    expect(first.options[0]!.textContent).toBe('Same as the supplier (EXHIBITION (category))');
    expect(pick('API-2 Cash Flow line').value).toBe('acc:601-0001');
    fireEvent.change(first, { target: { value: 'acc:900-X001' } });
    expect(mutate.mock.calls[0]![0]).toEqual({ supplierId: null, billId: 'b1', account: '900-X001', category: null });
  });

  test('without the right, the picks only read', () => {
    render(<OpeningBillsDialog onClose={() => {}} canWrite={false} />);
    expect(pick('Alpha Stands Cash Flow line').disabled).toBe(true);
    expect(screen.getByText(/changing them needs the permission/)).toBeTruthy();
  });
});
