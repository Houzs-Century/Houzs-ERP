/* Opening Balance (owner 2026-10-28: 「然后确定一下我是会有一个opening balance
   maintainence 表是吗？」) — Finance › Setup. Pinned: the check strip (books
   start, the opening difference, creditors, other debtors, stock), the four
   tabs, the accounts edited and saved as whole lines, a party's papers popped
   out, the stock saved per bucket, and the lock: offered only when the opening
   balances, and a locked opening offers no edit at all. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

type Row = Record<string, unknown>;
let data: Row = {};
const saveAccounts = vi.fn();
const saveStock = vi.fn();
const lockMutate = vi.fn();
const idle = { mutate: vi.fn(), isPending: false };
vi.mock('../../vendor/scm/lib/opening-balance-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/opening-balance-queries')>()),
  useOpeningBalance: () => ({ data, isLoading: false, isError: false, error: null }),
  useSaveOpeningAccounts: () => ({ mutate: saveAccounts, isPending: false }),
  useSaveOpeningStock: () => ({ mutate: saveStock, isPending: false }),
  useLockOpening: () => ({ mutate: lockMutate, isPending: false }),
  useCreateOpeningPaper: () => idle,
  useUpdateOpeningPaper: () => idle,
  useCancelOpeningPaper: () => idle,
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({ useSuppliers: () => ({ data: [] }) }));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({ useOtherDebtors: () => ({ data: { debtors: [] } }) }));

import { OpeningBalance } from './OpeningBalance';

const OPENING: Row = {
  booksStart: '2026-09-01', openingDate: '2026-08-31', locked: null, journal: { jeNo: 'JE-2608-0304', date: '2026-08-31' },
  accounts: [
    { code: '310-0010', name: 'CASH AT BANK - MAYBANK', type: 'ASSET', section: 'CURRENT ASSETS', drSen: 131_669_079, crSen: 0 },
    { code: '150-0000', name: 'RETAINED EARNING', type: 'EQUITY', section: 'RETAINED EARNING', drSen: 381_499_329, crSen: 0 },
  ],
  stock: { buckets: { customer: 150_000_000, display: 24_416_468 }, totalSen: 174_416_468, codes: { customer: '600-0001', display: '600-0002', service: '600-0003', showroom: '600-0004', others: '600-0005' } },
  creditors: [{
    partyId: 'sup-d', code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.', control: '400-0000', owingSen: 64_961_140, creditSen: 0, netSen: 64_961_140,
    papers: [{ id: 'api-1', kind: 'API', no: 'HC-API-2608-117', partyId: 'sup-d', date: '2026-08-12', ref: 'DGSIZ26001700', amountSen: 1_153_125, settledSen: 0, status: 'POSTED', note: 'AutoCount PI-007928' }],
  }],
  debtors: [{ partyId: 'deb-t', code: null, name: 'TANGUANYU ENTERPRISE', owingSen: 30_548_314, creditSen: 0, netSen: 30_548_314, papers: [] }],
  check: { clearingCode: '190-0000', clearingSen: 0 },
};
const draw = (search = '') => render(<MemoryRouter initialEntries={[`/scm/opening-balance${search}`]}><OpeningBalance /></MemoryRouter>);

beforeEach(() => {
  data = { ...OPENING };
  saveAccounts.mockReset();
  saveStock.mockReset();
  lockMutate.mockReset();
});

describe('the check strip and the accounts', () => {
  test('books start, a balanced opening, the parties and the stock, each at a glance', () => {
    draw();
    expect(screen.getByText('✓ Balanced — 平')).toBeTruthy();
    expect(screen.getByText('RM 649,611.40')).toBeTruthy();
    expect(screen.getByText('RM 1,744,164.68')).toBeTruthy();
    expect(screen.getByText('CASH AT BANK - MAYBANK')).toBeTruthy();
    expect(screen.getByText('RM 3,814,993.29')).toBeTruthy();
  });

  test('an unbalanced opening says so in the strip, and cannot be locked', () => {
    data = { ...OPENING, check: { clearingCode: '190-0000', clearingSen: 12_500 } };
    draw();
    expect(screen.getByText('✗ 190-0000 must read nil')).toBeTruthy();
    expect((screen.getByText(/Lock · 锁定/).closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  test('accounts are edited as whole lines and saved together', () => {
    draw();
    fireEvent.click(screen.getByText('Edit · 修改'));
    fireEvent.click(screen.getByLabelText('Remove 150-0000'));
    fireEvent.click(screen.getByText('Save · 保存'));
    expect(saveAccounts).toHaveBeenCalledWith([{ code: '310-0010', drSen: 131_669_079, crSen: 0 }], expect.anything());
  });
});

describe('the parties, the stock and the lock', () => {
  test('a supplier\'s papers pop out from its row', () => {
    draw('?tab=creditors');
    fireEvent.click(screen.getByText('DIGLANT MANUFACTURING SDN BHD.'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('HC-API-2608-117')).toBeTruthy();
    expect(within(dialog).getByText('DGSIZ26001700')).toBeTruthy();
  });

  test('the stock per bucket is saved whole', () => {
    draw('?tab=stock');
    fireEvent.click(screen.getByText('Edit · 修改'));
    fireEvent.click(screen.getByText('Save · 保存'));
    expect(saveStock).toHaveBeenCalledWith({ customer: 150_000_000, display: 24_416_468 }, expect.anything());
  });

  test('a locked opening offers no edit, only unlock', () => {
    data = { ...OPENING, locked: { at: '2026-10-30T02:00:00Z', by: 'Chew' } };
    draw();
    expect(screen.queryByText('Edit · 修改')).toBeNull();
    expect(screen.getByText(/Unlock · 解锁/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Unlock · 解锁/));
    fireEvent.click(within(screen.getByRole('dialog')).getAllByText(/Unlock · 解锁/).at(-1)!);
    expect(lockMutate).toHaveBeenCalledWith('unlock', expect.anything());
  });
});
