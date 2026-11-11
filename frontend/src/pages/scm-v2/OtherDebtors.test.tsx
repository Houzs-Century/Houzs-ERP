/* Debtor maintenance — the page contract (owner 2026-09-03: the registry, 资料
   lives here; 2026-09-21: the party's own data, as the supplier master carries
   it; the owner's Claude Design, batch 5 step 6): two segments — the debtors
   (registration, phone, open bills, what they owe on the sand tint, Active /
   Inactive) and their receipts walking the payment voucher's four layers from
   the row; the debtor form (the design's fields first, every other party
   field under More details), a debtor receipt saved as a Draft or prepared,
   and Edit on a Draft or Prepared receipt — each in place of the list. The
   server half is backend/tests/otherDebtors.test.ts (c5: PATCH
   /other-debtors/receipts/:id) and receipts.test.ts (?kind=). */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const NOW = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/* ── What the server answers (ONE stable object per read, as react-query hands back) ── */
const DEBTORS = { data: { debtors: [
  { id: 'd1', name: 'AHMAD BIN ALI', code: '305-A001', phone: '012-345', notes: null, is_active: true, outstanding_sen: 45_000, business_reg_no: '202001012345', tin_number: 'IG123', email: 'ahmad@example.com', country: 'Malaysia' },
  { id: 'd2', name: 'OLD DEBTOR', code: null, phone: null, notes: null, is_active: false, outstanding_sen: 0, business_reg_no: null },
] }, isLoading: false, isError: false, error: null };
const bill = (over: Record<string, unknown>) => ({
  kind: 'ODB', docKind: 'INV', id: 'b1', invoiceNumber: 'HC-ODB-2611-001', partyKey: 'D:d1', partyCode: null, partyName: 'AHMAD BIN ALI', debtorId: 'd1',
  ref: null, description: 'Booth rental', invoiceDate: `${NOW}-01`, dueDate: null, currency: 'MYR', totalSen: 50_000, paidSen: 20_000,
  depositAppliedSen: 0, outstandingSen: 30_000, status: 'POSTED', ...over,
});
const AR = { data: { rows: [
  bill({}),
  bill({ id: 'b2', invoiceNumber: 'HC-ODB-2611-002', totalSen: 20_000, paidSen: 5_000, outstandingSen: 15_000 }),
  bill({ id: 'b8', invoiceNumber: 'HC-ODB-2610-008', status: 'CANCELLED', paidSen: 0, outstandingSen: 50_000 }),
  bill({ id: 'b9', invoiceNumber: 'HC-ODB-2610-009', debtorId: 'd2', partyKey: 'D:d2', partyName: 'OLD DEBTOR', paidSen: 50_000, outstandingSen: 0, status: 'PAID' }),
] }, isLoading: false, isError: false, error: null };
const odr = (over: Record<string, unknown>) => ({
  kind: 'DEBTOR', id: 'dr1', number: 'HC-ODR-2611-001', date: `${NOW}-06`, payer: 'AHMAD BIN ALI', payerCode: '305-A001', moneyAccount: '310-0010', totalSen: 20_000,
  status: 'DRAFT', debtorId: 'd1', submittedAt: null, checkedAt: null, approvedAt: null,
  bills: [{ billId: 'b1', no: 'HC-ODB-2611-001', amountSen: 20_000 }], ...over,
});
const RECEIPTS = { data: { month: null, receipts: [
  odr({}),
  odr({ id: 'dr2', payerCode: null, number: 'HC-ODR-2611-002', totalSen: 30_000, submittedAt: `${NOW}-06T01:00:00Z`, bills: [{ billId: 'b1', no: 'HC-ODB-2611-001', amountSen: 30_000 }] }),
  odr({ id: 'dr3', number: 'HC-ODR-2611-003', totalSen: 10_000, submittedAt: 'x', checkedAt: 'y', bills: [{ billId: 'b2', no: 'HC-ODB-2611-002', amountSen: 10_000 }] }),
  odr({ id: 'dr4', number: 'HC-ODR-2611-004', totalSen: 5_000, status: 'POSTED', submittedAt: 'x', checkedAt: 'y', approvedAt: 'z', bills: [{ billId: 'b2', no: 'HC-ODB-2611-002', amountSen: 5_000 }] }),
  odr({ id: 'dr5', number: 'HC-ODR-2610-005', totalSen: 7_000, status: 'CANCELLED', bills: [] }),
] }, isLoading: false, isError: false, error: null };
const DEBTOR_D1 = {
  debtor: DEBTORS.data.debtors[0],
  bills: [
    { id: 'b1', bill_number: 'HC-ODB-2611-001', bill_date: `${NOW}-01`, total_sen: 50_000, received_sen: 20_000, status: 'POSTED', notes: 'Booth rental' },
    { id: 'b2', bill_number: 'HC-ODB-2611-002', bill_date: `${NOW}-02`, total_sen: 20_000, received_sen: 5_000, status: 'POSTED', notes: 'Electricity' },
  ],
  receipts: [],
};
const DETAIL_D1 = { data: DEBTOR_D1, isLoading: false, isError: false, error: null };
const NO_DETAIL = { data: undefined, isLoading: false, isError: false, error: null };
const DR2 = {
  receipt: {
    id: 'dr2', receipt_number: 'HC-ODR-2611-002', debtor_id: 'd1', receipt_date: `${NOW}-06`, bank_account_code: '310-0010', total_sen: 30_000,
    status: 'DRAFT', submitted_at: `${NOW}-06T01:00:00Z`, submitted_by: null, checked_at: null, checked_by: null, approved_at: null, approved_by: null, posted_at: null, notes: null,
  },
  debtor: DEBTORS.data.debtors[0],
  allocations: [{ billId: 'b1', amountSen: 30_000, billNumber: 'HC-ODB-2611-001', billDate: `${NOW}-01`, description: 'Booth rental', totalSen: 50_000, receivedSen: 20_000, status: 'POSTED', docKind: 'INV' }],
};
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: vi.fn(async (path: string) => {
    if (path === '/other-debtors/receipts/dr2') return DR2;
    throw new Error(`unexpected read ${path}`);
  }),
}));

const ACCOUNTS = { data: { accounts: [
  { account_code: '310-0010', account_name: 'MAYBANK', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
  { account_code: '305-0000', account_name: 'Other Debtors', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
] }, isLoading: false };
const ROLES = { data: { roles: { AR_OTHER: '305-0000' }, overridden: {} } };
const receiptsAsked: string[] = [];
const createDebtor = vi.fn();
const updateDebtor = vi.fn();
const createDebtorReceipt = vi.fn();
const updateDebtorReceipt = vi.fn();
const stepMutate = vi.fn();
vi.mock('../../vendor/scm/lib/accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/accounting-queries')>()),
  useAccounts: () => ACCOUNTS,
  useAccountRoles: () => ROLES,
  useOtherDebtors: () => DEBTORS,
  useDebtorDetail: (id: string | null) => (id === 'd1' ? DETAIL_D1 : NO_DETAIL),
  useReceipts: (month?: string, kind?: string) => { receiptsAsked.push(`${month ?? ''}|${kind ?? ''}`); return RECEIPTS; },
  useCreateDebtor: () => ({ mutate: createDebtor, isPending: false }),
  useUpdateDebtor: () => ({ mutate: updateDebtor, isPending: false }),
  useCreateDebtorReceipt: () => ({ mutate: createDebtorReceipt, isPending: false }),
  useUpdateDebtorReceipt: () => ({ mutate: updateDebtorReceipt, isPending: false }),
  useDebtorReceiptAction: () => ({ mutate: stepMutate, isPending: false }),
  useVoidDebtorReceipt: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateDebtorBill: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateDebtorBill: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../vendor/scm/lib/ar-invoice-queries', () => ({
  useArInvoices: () => AR,
  useArBillDetail: () => NO_DETAIL,
}));
const EVENTS = { data: [], isLoading: false };
vi.mock('../../vendor/scm/lib/event-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/event-queries')>()),
  useEventOptions: () => EVENTS,
  useEventLabels: () => ({ data: new Map() }),
}));
const PERMS = { value: new Set<string>(['*']) };
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: (p: string) => PERMS.value.has('*') || PERMS.value.has(p) }) }));

const { OtherDebtors } = await import('./OtherDebtors');
const { ToastProvider } = await import('../../hooks/useToast');

function Where() { const l = useLocation(); return <output data-testid="where">{`${l.pathname}${l.search}`}</output>; }
const draw = (search = '') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>
      <MemoryRouter initialEntries={[`/scm/other-debtors${search}`]}>
        <Routes><Route path="*" element={<><OtherDebtors /><Where /></>} /></Routes>
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
const where = () => screen.getByTestId('where').textContent;
const row = (text: string) => screen.getByText(text, { selector: 'a' }).closest('tr') as HTMLElement;
const menuOf = (name: string) => { fireEvent.click(within(row(name)).getByRole('button', { name: `${name} menu` })); return screen.getByRole('menu'); };
const items = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((m) => m.textContent);
/** Run the options a mutate call was handed (react-query calls them after the server answers). */
const answer = async (fn: ReturnType<typeof vi.fn>, call: number, what: 'onSuccess' | 'onError', value: unknown) => {
  const opts = fn.mock.calls[call]![1] as Record<string, (v: unknown) => void>;
  await act(async () => { opts[what]!(value); });
};

beforeEach(() => {
  vi.clearAllMocks();
  receiptsAsked.length = 0;
  PERMS.value = new Set(['*']);
});

describe('the debtors', () => {
  test('registration, phone, the bills still open, what they owe on the sand tint, Active / Inactive; the name opens the page', () => {
    draw();
    expect(screen.getByRole('heading', { name: 'Debtor maintenance' })).toBeTruthy();
    const segs = screen.getByRole('group', { name: 'Debtors or their receipts' });
    expect(within(segs).getByRole('button', { name: /Debtors\s*2/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(segs).getByRole('button', { name: /Receipts\s*5/ })).toBeTruthy();
    expect(screen.getByText('Account Code')).toBeTruthy();
    const ahmad = row('AHMAD BIN ALI');
    expect(within(ahmad).getByText('AHMAD BIN ALI').getAttribute('href')).toBe('/scm/other-debtors/d1');
    expect(within(ahmad).getByText('305-A001')).toBeTruthy();
    expect(within(ahmad).getByText('202001012345')).toBeTruthy();
    expect(within(ahmad).getByText('012-345')).toBeTruthy();
    /* b1 and b2 still owe; the cancelled one does not count. */
    expect(within(ahmad).getAllByRole('cell').map((c) => c.textContent)).toContain('2');
    expect(within(ahmad).getByText('RM 450.00')).toBeTruthy();
    expect(within(ahmad).getByText('Active')).toBeTruthy();
    expect(ahmad.getAttribute('style') ?? '').toMatch(/#fcf7ec|252, 247, 236/);
    const old = row('OLD DEBTOR');
    expect(within(old).getByText('Inactive')).toBeTruthy();
    expect(old.getAttribute('style') ?? '').not.toMatch(/#fcf7ec|252, 247, 236/);
    /* No code, no registration, no phone: a dash each. */
    expect(within(old).getAllByText('—')).toHaveLength(3);
  });

  test('the search finds a debtor by account code, in any case; a receipt by its debtor’s', () => {
    draw();
    fireEvent.change(screen.getByPlaceholderText('Find a debtor'), { target: { value: '305-a001' } });
    expect(row('AHMAD BIN ALI')).toBeTruthy();
    expect(screen.queryByText('OLD DEBTOR', { selector: 'a' })).toBeNull();
    fireEvent.click(within(screen.getByRole('group', { name: 'Debtors or their receipts' })).getByRole('button', { name: /Receipts/ }));
    fireEvent.change(screen.getByPlaceholderText('Find a receipt · no., debtor, amount'), { target: { value: '305-a001' } });
    expect(screen.getByText('HC-ODR-2611-001', { selector: 'a' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Find a receipt · no., debtor, amount'), { target: { value: '305-z' } });
    expect(screen.queryByText('HC-ODR-2611-001', { selector: 'a' })).toBeNull();
  });

  test('the debtor pickers name each debtor with its code', () => {
    const bill = draw('?form=bill');
    expect([...(screen.getByLabelText('Bill debtor') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['— Pick the debtor —', 'AHMAD BIN ALI · 305-A001']);
    bill.unmount();
    draw('?form=receipt');
    expect([...(screen.getByLabelText('Debtor') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['— Pick the debtor —', 'AHMAD BIN ALI · 305-A001 · owes RM 450.00']);
  });

  test('the row: New bill opens the bill form on that debtor; ⋯ has Open, Edit debtor, New bill, New receipt, Open bills in Invoices and Deactivate', () => {
    draw();
    fireEvent.click(within(row('AHMAD BIN ALI')).getByRole('button', { name: 'New bill' }));
    expect(where()).toBe('/scm/other-debtors?form=bill&debtor=d1');
    expect(screen.getByRole('heading', { name: 'New debtor bill' })).toBeTruthy();
    expect((screen.getByLabelText('Bill debtor') as HTMLSelectElement).value).toBe('d1');
    fireEvent.click(screen.getByText('Back to Debtor maintenance'));
    expect(items(menuOf('AHMAD BIN ALI'))).toEqual(['Open', 'Edit debtor', 'New bill', 'New receipt', 'Open bills in Invoices', 'Deactivate']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open bills in Invoices' }));
    expect(where()).toBe('/scm/ar-invoices?debtor=d1');
  });

  test('an inactive debtor takes no new bill or receipt until reactivated', () => {
    draw();
    expect(within(row('OLD DEBTOR')).queryByRole('button', { name: 'New bill' })).toBeNull();
    expect(items(menuOf('OLD DEBTOR'))).toEqual(['Open', 'Edit debtor', 'Open bills in Invoices', 'Reactivate']);
  });

  test('Reactivate sends the flag; the toast says so', async () => {
    draw();
    menuOf('OLD DEBTOR');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate' }));
    expect(updateDebtor.mock.calls[0]![0]).toEqual({ id: 'd2', isActive: true });
    await answer(updateDebtor, 0, 'onSuccess', { ok: true });
    expect(await screen.findByText('OLD DEBTOR reactivated')).toBeTruthy();
  });

  test('without the raise key nothing is raised here; without the write key nothing is edited', () => {
    PERMS.value = new Set(['scm.access']);
    draw();
    expect(screen.queryByRole('button', { name: /New debtor/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New receipt/ })).toBeNull();
    expect(within(row('AHMAD BIN ALI')).queryByRole('button', { name: 'New bill' })).toBeNull();
    expect(items(menuOf('AHMAD BIN ALI'))).toEqual(['Open', 'Open bills in Invoices']);
  });
});

describe('the debtor form, in place of the list', () => {
  test('New debtor: the design’s fields first, the rest under More details; Save debtor sends every box and opens the new debtor', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /New debtor/ }));
    expect(where()).toBe('/scm/other-debtors?form=debtor');
    expect(screen.getByRole('heading', { name: 'New debtor' })).toBeTruthy();
    expect(screen.getByText('Type the debtor’s name.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save debtor' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Account code — · bills and receipts post to the 305-0000 Other Debtors control')).toBeTruthy();
    expect(screen.getByPlaceholderText('As it prints on the invoice')).toBeTruthy();
    for (const [label, value] of [['Name', 'LIM AH KOW'], ['Registration no.', '850101-14-5678'], ['Phone', '012-777'], ['Address line 1', '12, JALAN SATU'], ['Postcode', '47810'], ['City', 'PETALING JAYA'], ['State', 'Selangor']]) {
      fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    }
    expect(screen.queryByLabelText('TIN Number')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /More details/ }));
    fireEvent.change(screen.getByLabelText('TIN Number'), { target: { value: 'IG999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save debtor' }));
    expect(createDebtor.mock.calls[0]![0]).toMatchObject({
      name: 'LIM AH KOW', code: '305-L001', businessRegNo: '850101-14-5678', phone: '012-777', address1: '12, JALAN SATU', postcode: '47810',
      city: 'PETALING JAYA', state: 'Selangor', country: 'Malaysia', tinNumber: 'IG999', email: '', notes: '',
    });
    await answer(createDebtor, 0, 'onSuccess', { ok: true, debtor: { id: 'd9' } });
    expect(await screen.findByText('LIM AH KOW added to Debtor maintenance')).toBeTruthy();
    expect(where()).toBe('/scm/other-debtors/d9');
  });

  test('Edit debtor opens filled, says how much More details holds, and saves Inactive with the data', async () => {
    draw();
    menuOf('AHMAD BIN ALI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit debtor' }));
    expect(where()).toBe('/scm/other-debtors?form=debtor&id=d1');
    expect(screen.getByRole('heading', { name: 'Edit AHMAD BIN ALI' })).toBeTruthy();
    expect((screen.getByLabelText('Registration no.') as HTMLInputElement).value).toBe('202001012345');
    expect(screen.getByRole('button', { name: /More details/ }).textContent).toContain('1 filled');
    fireEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Inactive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateDebtor.mock.calls[0]![0]).toMatchObject({
      id: 'd1', name: 'AHMAD BIN ALI', code: '305-A001', businessRegNo: '202001012345', tinNumber: 'IG123', email: 'ahmad@example.com', isActive: false,
    });
    await answer(updateDebtor, 0, 'onSuccess', { ok: true });
    expect(await screen.findByText('AHMAD BIN ALI saved')).toBeTruthy();
    expect(where()).toBe('/scm/other-debtors');
  });

  describe('the account code', () => {
    const code = () => screen.getByLabelText('Account code') as HTMLInputElement;
    const name = (value: string) => fireEvent.change(screen.getByLabelText('Name'), { target: { value } });

    test('a new debtor’s is suggested from the name, the next number among that letter’s; typing over it keeps what was typed', () => {
      draw('?form=debtor');
      expect(code().value).toBe('');
      expect(code().placeholder).toBe('305-A001');
      name('Alpha Sdn Bhd');
      expect(code().value).toBe('305-A002'); // AHMAD holds 305-A001
      expect(screen.getByText('Suggested from the name · type to change')).toBeTruthy();
      expect(screen.getByText('Account code 305-A002 · bills and receipts post to the 305-0000 Other Debtors control')).toBeTruthy();
      name('Beng Hoe');
      expect(code().value).toBe('305-B001');
      fireEvent.change(code(), { target: { value: '305-b777' } });
      expect(code().value).toBe('305-B777');
      expect(screen.getByText('The debtor’s own code')).toBeTruthy();
      name('Chong Trading');
      expect(code().value).toBe('305-B777');
      fireEvent.click(screen.getByRole('button', { name: 'Save debtor' }));
      expect(createDebtor.mock.calls[0]![0]).toMatchObject({ name: 'Chong Trading', code: '305-B777' });
    });

    test('a name with no letter or digit suggests nothing; a debtor may still be saved with no code', () => {
      draw('?form=debtor');
      name('陈先生');
      expect(code().value).toBe('');
      expect(screen.getByText('Type the debtor’s own code')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Save debtor' }));
      expect(createDebtor.mock.calls[0]![0]).toMatchObject({ name: '陈先生', code: '' });
    });

    test('a code another debtor holds blocks the save, in words', () => {
      draw('?form=debtor');
      name('Zed');
      fireEvent.change(code(), { target: { value: '305-a001' } });
      expect(screen.getByText('Another debtor already has this code.')).toBeTruthy();
      expect(screen.getByText('Another debtor already has 305-A001.')).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Save debtor' }) as HTMLButtonElement).disabled).toBe(true);
    });

    test('editing keeps the code it has, whatever the name becomes; its own code is no clash; a blank clears it', () => {
      draw('?form=debtor&id=d1');
      expect(code().value).toBe('305-A001');
      expect(screen.getByText('The debtor’s own code')).toBeTruthy();
      expect(screen.queryByText('Another debtor already has this code.')).toBeNull();
      name('BAKAR BIN ALI');
      expect(code().value).toBe('305-A001');
      fireEvent.change(code(), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(updateDebtor.mock.calls[0]![0]).toMatchObject({ id: 'd1', name: 'BAKAR BIN ALI', code: '' });
    });

    test('editing a debtor with no code does not hand it one', () => {
      draw('?form=debtor&id=d2');
      expect(code().value).toBe('');
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(updateDebtor.mock.calls[0]![0]).toMatchObject({ id: 'd2', code: '' });
    });
  });

  test('a refusal is said on the form, which stays open', async () => {
    draw('?form=debtor&id=d1');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await answer(updateDebtor, 0, 'onError', new Error("You don't have permission to do that."));
    expect(screen.getByRole('alert').textContent).toBe("You don't have permission to do that.");
    expect(screen.getByRole('heading', { name: 'Edit AHMAD BIN ALI' })).toBeTruthy();
  });
});

describe('the receipts — the four layers from the row', () => {
  test('every other-debtor receipt, the bills it knocks off and its stage; the next step is the row’s button', () => {
    draw('?seg=receipts');
    expect(receiptsAsked).toContain('|DEBTOR');
    expect(within(row('HC-ODR-2611-001')).getByText('HC-ODB-2611-001')).toBeTruthy();
    expect(within(row('HC-ODR-2611-001')).getByText('Draft')).toBeTruthy();
    expect(within(row('HC-ODR-2611-002')).getByText('Prepared')).toBeTruthy();
    expect(within(row('HC-ODR-2611-003')).getByText('Checked')).toBeTruthy();
    expect(within(row('HC-ODR-2611-004')).getByText('Approved')).toBeTruthy();
    expect(within(row('HC-ODR-2610-005')).getByText('Cancelled')).toBeTruthy();
    expect(within(row('HC-ODR-2611-002')).getByRole('button', { name: 'Check' })).toBeTruthy();
    expect(within(row('HC-ODR-2611-003')).getByRole('button', { name: 'Approve & post' })).toBeTruthy();
    expect(within(row('HC-ODR-2611-004')).queryByRole('button', { name: /Prepare|Check|Approve/ })).toBeNull();
    fireEvent.click(within(row('HC-ODR-2611-001')).getByRole('button', { name: 'Prepare' }));
    expect(stepMutate.mock.calls[0]![0]).toEqual({ receiptId: 'dr1', action: 'submit' });
    fireEvent.change(screen.getByPlaceholderText('Find a receipt · no., debtor, amount'), { target: { value: 'ODB-2611-002' } });
    expect(screen.queryByText('HC-ODR-2611-001', { selector: 'a' })).toBeNull();
    expect(screen.getByText('HC-ODR-2611-003', { selector: 'a' })).toBeTruthy();
  });

  test('a checked receipt has no Edit — it is locked until rejected back to Draft', () => {
    draw('?seg=receipts');
    expect(items(menuOf('HC-ODR-2611-003'))).toEqual(['Open', 'Approve & post', 'Reject…']);
  });

  test('Edit on a Prepared receipt changes it in place and keeps its stage', async () => {
    draw('?seg=receipts&form=receipt&id=dr2');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Edit HC-ODR-2611-002' })).toBeTruthy());
    expect(screen.getByText('Saving keeps it Prepared — nothing posts until it is approved.')).toBeTruthy();
    expect((screen.getByLabelText('Debtor') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Collect HC-ODB-2611-002 in full'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateDebtorReceipt.mock.calls[0]![0]).toEqual({
      receiptId: 'dr2', receiptDate: `${NOW}-06`, bankAccountCode: '310-0010',
      allocations: [{ billId: 'b1', amountSen: 30_000 }, { billId: 'b2', amountSen: 15_000 }],
    });
    await answer(updateDebtorReceipt, 0, 'onSuccess', { ok: true });
    expect(await screen.findByText('HC-ODR-2611-002 saved')).toBeTruthy();
  });

  test('the menu’s Edit opens that form on a Draft', () => {
    draw('?seg=receipts');
    expect(items(menuOf('HC-ODR-2611-001'))).toEqual(['Open', 'Edit', 'Prepare']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(where()).toBe('/scm/other-debtors?seg=receipts&form=receipt&id=dr1');
  });

  test('New receipt from a debtor: what they still owe; Save & prepare saves, prepares, and opens the receipt', async () => {
    draw();
    menuOf('AHMAD BIN ALI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'New receipt' }));
    expect(where()).toBe('/scm/other-debtors?form=receipt&debtor=d1');
    expect(screen.getByRole('heading', { name: 'New receipt · Other debtor' })).toBeTruthy();
    expect((screen.getByLabelText('Debtor') as HTMLSelectElement).value).toBe('d1');
    expect(screen.getByText('What AHMAD BIN ALI still owes')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Collect HC-ODB-2611-002 in full'));
    fireEvent.focus(screen.getByLabelText('Received into'));
    fireEvent.mouseDown(screen.getByText('310-0010 · MAYBANK'));
    expect(screen.getByText(/Books: Dr 310-0010 MAYBANK · Cr 305-0000 Other Debtors \(AHMAD BIN ALI\) · RM 150\.00 · posts at approval/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save & prepare' }));
    const sent = createDebtorReceipt.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toEqual({ debtorId: 'd1', receiptDate: TODAY, bankAccountCode: '310-0010', allocations: [{ billId: 'b2', amountSen: 15_000 }], idempotencyKey: expect.any(String) });
    await answer(createDebtorReceipt, 0, 'onSuccess', { ok: true, receipt: { id: 'dr9', receiptNumber: 'HC-ODR-2611-009' } });
    expect(stepMutate.mock.calls[0]![0]).toEqual({ receiptId: 'dr9', action: 'submit' });
    await answer(stepMutate, 0, 'onSuccess', { ok: true });
    expect(await screen.findByText('HC-ODR-2611-009 prepared · checked next')).toBeTruthy();
    expect(where()).toBe('/scm/receipts/debtor/dr9');
  });

  test('Save draft keeps it a Draft — nothing prepared', async () => {
    draw('?form=receipt&debtor=d1');
    fireEvent.click(screen.getByLabelText('Collect HC-ODB-2611-001 in full'));
    fireEvent.focus(screen.getByLabelText('Received into'));
    fireEvent.mouseDown(screen.getByText('310-0010 · MAYBANK'));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await answer(createDebtorReceipt, 0, 'onSuccess', { ok: true, receipt: { id: 'dr9', receiptNumber: 'HC-ODR-2611-009' } });
    expect(stepMutate).not.toHaveBeenCalled();
    expect(await screen.findByText('HC-ODR-2611-009 saved as Draft')).toBeTruthy();
  });
});
