// Item Groups tab (GL redesign item 1), in the redesign (Finance-1a-Setup,
// batch 6 §6.2). What is pinned:
//   • an unbound group arrives PRE-FILLED with the suggested defaults and says
//     so — the sign-off flow: nothing writes until Save;
//   • Save sends exactly the four drafted accounts for the active company;
//   • a bound, untouched group says Bound and offers no Save; a change to it
//     says so and Undo brings it back;
//   • Turn off / Turn on sit in the row's ⋯ and its right-click menu;
//   • the New item group modal refuses until code, name and all four accounts
//     are given (born bound), and upper-cases the code.

import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
  { code: 'LAMP', name: 'Lamp', isActive: false, bindings: {} },
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

vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
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
        /* Conts #338: a header (its only child retired) and a control special never offered. */
        { account_code: '600-0000', account_name: 'PURCHASES HEADER', account_type: 'EXPENSE', section: 'COST OF GOODS SOLD', is_active: true },
        { account_code: '600-0001', account_name: 'OLD PURCHASES', account_type: 'EXPENSE', section: 'COST OF GOODS SOLD', is_active: false, parent_code: '600-0000' },
        { account_code: '630-0000', account_name: 'STOCK CONTROL', account_type: 'EXPENSE', section: 'COST OF GOODS SOLD', is_active: true, special_type: 'SBS' },
      ],
    },
  }),
}));

vi.mock('../../lib/activeCompany', () => ({ getActiveCompanyId: () => 2 }));
/* The backfill card below the groups has its own test (PiBackfill.test.tsx). */
vi.mock('./PiBackfill', () => ({ PiBackfillCard: () => null }));

import { ItemGroupsTab } from './ItemGroups';

const rowOf = (code: string) => document.querySelector(`tr[data-group="${code}"]`) as HTMLElement;
const saveIn = (row: HTMLElement) => within(row).queryByRole('button', { name: /^Save/ });

beforeEach(() => {
  bindMutate.mockClear();
  createMutate.mockClear();
  patchMutate.mockClear();
});

describe('the sign-off flow', () => {
  test('the design’s line and the company the bindings are for', () => {
    render(<ItemGroupsTab />);
    expect(screen.getByText('Each product group’s ledger accounts · nothing is written until a row is saved')).toBeTruthy();
    expect(screen.getByText(/^For 2990\. Purchase and purchase-return slots take cost and expense accounts/)).toBeTruthy();
  });

  test('an unbound group arrives pre-filled with the suggestion, marked not saved', () => {
    render(<ItemGroupsTab />);
    // BEDLINES has no saved binding for company 2 → suggested defaults shown.
    expect(within(rowOf('BEDLINES')).getByText('Suggested · not saved')).toBeTruthy();
    const purchase = screen.getByLabelText('BEDLINES Purchase account') as HTMLInputElement;
    expect(purchase.value).toContain('602-0000');
    /* A group with no suggestion and no binding is plainly unbound. */
    expect(within(rowOf('LAMP')).getByText('Unbound')).toBeTruthy();
  });

  test('Save on the suggested row sends the four drafted accounts for the active company', () => {
    render(<ItemGroupsTab />);
    const save = saveIn(rowOf('BEDLINES'))!;
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    expect(bindMutate).toHaveBeenCalledTimes(1);
    expect(bindMutate.mock.calls[0][0]).toEqual({
      code: 'BEDLINES',
      companyId: 2,
      accounts: { purchase: '602-0000', sales: '502-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
    });
  });

  test('a bound, untouched group says Bound and offers no Save', () => {
    render(<ItemGroupsTab />);
    expect(within(rowOf('SOFA')).getByText('Bound')).toBeTruthy();
    expect(saveIn(rowOf('SOFA'))).toBeNull();
  });

  test('a change to a bound group says so, Save appears, Undo brings it back', () => {
    render(<ItemGroupsTab />);
    const input = screen.getByLabelText('SOFA Purchase account');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '602-0000' } });
    fireEvent.mouseDown(screen.getAllByText(/^602-0000 — /)[0]!);
    expect(within(rowOf('SOFA')).getByText('Changed · not saved')).toBeTruthy();
    expect(saveIn(rowOf('SOFA'))).not.toBeNull();
    fireEvent.click(within(rowOf('SOFA')).getByText('Undo'));
    expect(within(rowOf('SOFA')).getByText('Bound')).toBeTruthy();
    expect(bindMutate).not.toHaveBeenCalled();
  });

  test('turning a group off goes through the patch from the row’s ⋯, bindings untouched', () => {
    render(<ItemGroupsTab />);
    fireEvent.click(screen.getByLabelText('More for SOFA'));
    const off = screen.getByRole('menuitem', { name: 'Turn off' });
    expect(off.getAttribute('title')).toBe('Hide from new products (bindings stay)');
    fireEvent.click(off);
    expect(patchMutate.mock.calls[0][0]).toEqual({ code: 'SOFA', isActive: false });
    expect(bindMutate).not.toHaveBeenCalled();
  });

  test('right-click on an off group offers Turn on', () => {
    render(<ItemGroupsTab />);
    fireEvent.contextMenu(rowOf('LAMP'));
    const on = screen.getByRole('menuitem', { name: 'Turn on' });
    expect(on.getAttribute('title')).toBe('Offer to new products again');
    fireEvent.click(on);
    expect(patchMutate.mock.calls[0][0]).toEqual({ code: 'LAMP', isActive: true });
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
    expect(screen.queryByText(/PURCHASES HEADER/)).toBeNull();
    expect(screen.queryByText(/STOCK CONTROL/)).toBeNull();
    expect(screen.getAllByText(/PURCHASE OF SOFA/).length).toBeGreaterThan(0);
    fireEvent.blur(purchase);
    const sales = screen.getByLabelText('BEDLINES Sales return account');
    fireEvent.focus(sales);
    /* INCOME list: 510 files under SALES ADJUSTMENTS; expense rows stay out. */
    expect(screen.getByText('SALES ADJUSTMENTS')).toBeTruthy();
    expect(screen.queryByText(/PURCHASE OF SOFA/)).toBeNull();
  });
});

describe('new item group — born bound', () => {
  test('the modal names what is missing until code, name and all four accounts are given, then upper-cases the code', () => {
    render(<ItemGroupsTab />);
    fireEvent.click(screen.getByText('New group'));
    const dialog = screen.getByRole('dialog', { name: 'New item group' });
    const create = within(dialog).getByText('Create group');
    fireEvent.click(create);
    expect(within(dialog).getByRole('alert').textContent).toBe('The code is letters, digits or _, starting with a letter, e.g. CURTAIN.');

    fireEvent.change(screen.getByLabelText('Group code'), { target: { value: 'sofa' } });
    fireEvent.click(create);
    expect(within(dialog).getByRole('alert').textContent).toBe('SOFA already exists.');

    fireEvent.change(screen.getByLabelText('Group code'), { target: { value: 'curtain' } });
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Curtain' } });
    fireEvent.click(create);
    expect(within(dialog).getByRole('alert').textContent).toBe('A new group needs all four accounts.');
    expect(createMutate).not.toHaveBeenCalled();

    for (const [slot, code] of [
      ['Purchase', '601-0003'], ['Sales', '501-0000'], ['Sales return', '510-0000'], ['Purchase return', '612-0000'],
    ] as const) {
      const input = screen.getByLabelText(`New group ${slot} account`);
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: code } });
      // The combo picks on MOUSEDOWN (click fires after blur closes the list).
      fireEvent.mouseDown(screen.getAllByText(new RegExp(`^${code} — `))[0]!);
    }
    fireEvent.click(create);
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toMatchObject({
      code: 'CURTAIN', name: 'Curtain', companyId: 2,
      accounts: { purchase: '601-0003', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000' },
    });
  });
});
