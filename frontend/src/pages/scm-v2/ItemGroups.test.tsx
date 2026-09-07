// Item Groups tab (GL redesign item 1). What is pinned:
//   • an unbound group arrives PRE-FILLED with the suggested defaults and says
//     so — the sign-off flow: nothing writes until Save;
//   • Save sends exactly the four drafted accounts for the active company;
//   • a bound, untouched group says bound and its Save stays disabled;
//   • the New-group dialog refuses to create until code, name and all four
//     accounts are given (born bound), and upper-cases the code.

import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ItemGroup } from './accounting-phase1-queries';

const bindMutate = vi.fn();
const createMutate = vi.fn();
const patchMutate = vi.fn();

const GROUPS: ItemGroup[] = [
  {
    code: 'SOFA', name: 'Sofa', isActive: true,
    bindings: { '2': { purchase: '601-0003', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' } },
  },
  { code: 'BEDLINES', name: 'Bedlines', isActive: true, bindings: {} },
];

vi.mock('./accounting-phase1-queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useItemGroups: () => ({
    isLoading: false, isError: false,
    data: { companies: [{ id: 1, code: 'HOUZS' }, { id: 2, code: '2990' }], groups: GROUPS },
  }),
  useCreateItemGroup: () => ({ mutate: createMutate, isPending: false, isError: false, error: null }),
  useBindItemGroup: () => ({ mutate: bindMutate, isPending: false, isError: false, error: null }),
  usePatchItemGroup: () => ({ mutate: patchMutate, isPending: false, isError: false, error: null }),
}));

vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  useAccounts: () => ({
    data: {
      sections: [
        { section: 'CAPITAL', type: 'EQUITY' }, { section: 'CURRENT ASSETS', type: 'ASSET' },
        { section: 'SALES', type: 'INCOME' }, { section: 'SALES ADJUSTMENTS', type: 'INCOME' },
        { section: 'COST OF GOODS SOLD', type: 'EXPENSE' }, { section: 'EXPENSES', type: 'EXPENSE' },
      ],
      accounts: [
        { account_code: '601-0003', account_name: 'PURCHASE OF SOFA', account_type: 'EXPENSE', section: 'COST OF GOODS SOLD', is_active: true },
        { account_code: '602-0000', account_name: 'PURCHASES OF BEDLINES', account_type: 'EXPENSE', section: 'COST OF GOODS SOLD', is_active: true },
        { account_code: '501-0000', account_name: 'SALES OF FURNITURE', account_type: 'INCOME', section: 'SALES', is_active: true },
        { account_code: '502-0000', account_name: 'SALES OF BEDLINES', account_type: 'INCOME', section: 'SALES', is_active: true },
        { account_code: '510-0000', account_name: 'RETURN INWARDS', account_type: 'INCOME', section: 'SALES ADJUSTMENTS', is_active: true },
        { account_code: '612-0000', account_name: 'PURCHASES RETURN', account_type: 'EXPENSE', section: 'COST OF GOODS SOLD', is_active: true },
        /* Noise the picker must HIDE: neither side of trading. */
        { account_code: '100-0000', account_name: 'CAPITAL', account_type: 'EQUITY', section: 'CAPITAL', is_active: true },
        { account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', section: 'CURRENT ASSETS', is_active: true },
      ],
    },
  }),
}));

vi.mock('../../lib/activeCompany', () => ({ getActiveCompanyId: () => 2 }));

import { ItemGroupsTab } from './ItemGroups';

beforeEach(() => {
  bindMutate.mockClear();
  createMutate.mockClear();
  patchMutate.mockClear();
});

describe('the sign-off flow', () => {
  test('an unbound group arrives pre-filled with the suggestion, marked unsaved', () => {
    render(<ItemGroupsTab />);
    // BEDLINES has no saved binding for company 2 → suggested defaults shown.
    expect(screen.getByText('建议 · unsaved')).toBeTruthy();
    const purchase = screen.getByLabelText('BEDLINES Purchase account') as HTMLInputElement;
    expect(purchase.value).toContain('602-0000');
  });

  test('Save on the suggested row sends the four drafted accounts for the active company', () => {
    render(<ItemGroupsTab />);
    const row = screen.getByText('BEDLINES').closest('tr') as HTMLElement;
    const save = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    expect(bindMutate).toHaveBeenCalledTimes(1);
    expect(bindMutate.mock.calls[0][0]).toEqual({
      code: 'BEDLINES',
      companyId: 2,
      accounts: { purchase: '602-0000', sales: '502-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
    });
  });

  test('a bound, untouched group says bound and cannot be re-saved', () => {
    render(<ItemGroupsTab />);
    expect(screen.getByText('bound')).toBeTruthy();
    const row = screen.getByText('SOFA').closest('tr') as HTMLElement;
    const save = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    expect(save.hasAttribute('disabled')).toBe(true);
  });

  test('turning a group off goes through the patch, bindings untouched', () => {
    render(<ItemGroupsTab />);
    const row = screen.getByText('SOFA').closest('tr') as HTMLElement;
    const off = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Turn off')!;
    fireEvent.click(off);
    expect(patchMutate).toHaveBeenCalledWith({ code: 'SOFA', isActive: false });
    expect(bindMutate).not.toHaveBeenCalled();
  });

  test('the picker offers only its ledger side, under section headers (owner 2026-09-05)', () => {
    render(<ItemGroupsTab />);
    const purchase = screen.getByLabelText('BEDLINES Purchase account');
    fireEvent.focus(purchase);
    /* EXPENSE list: the chart's cost section heads it (read off the account
       rows, never decided here); equity/bank/income never show. */
    expect(screen.getByText('COST OF GOODS SOLD')).toBeTruthy();
    expect(screen.queryByText(/^CAPITAL/)).toBeNull();
    expect(screen.queryByText(/CASH AT BANK/)).toBeNull();
    expect(screen.queryByText(/SALES OF FURNITURE/)).toBeNull();
    fireEvent.blur(purchase);
    const sales = screen.getByLabelText('BEDLINES Sales Return account');
    fireEvent.focus(sales);
    /* INCOME list: 510 files under SALES ADJUSTMENTS; expense rows stay out. */
    expect(screen.getByText('SALES ADJUSTMENTS')).toBeTruthy();
    expect(screen.queryByText(/PURCHASE OF SOFA/)).toBeNull();
  });
});

describe('new group — born bound', () => {
  test('Create stays disabled until code, name and all four accounts are given, then upper-cases the code', () => {
    render(<ItemGroupsTab />);
    fireEvent.click(screen.getByText('New group'));
    const dialog = screen.getByRole('dialog');
    const createBtn = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Create')!;
    expect(createBtn.hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('Group code'), { target: { value: 'curtain' } });
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Curtain' } });
    expect(createBtn.hasAttribute('disabled')).toBe(true); // accounts still missing

    for (const [slot, code] of [
      ['Purchase', '601-0003'], ['Sales', '501-0000'], ['Sales Return', '510-0000'], ['Purchase Return', '612-0000'],
    ] as const) {
      const input = screen.getByLabelText(`New group ${slot} account`);
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: code } });
      // The combo picks on MOUSEDOWN (click fires after blur closes the list).
      fireEvent.mouseDown(screen.getAllByText(new RegExp(`^${code} — `))[0]);
    }
    expect(createBtn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(createBtn);
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toMatchObject({
      code: 'CURTAIN', name: 'Curtain', companyId: 2,
      accounts: { purchase: '601-0003', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
    });
  });
});
