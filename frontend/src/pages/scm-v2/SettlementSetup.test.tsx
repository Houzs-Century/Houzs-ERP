// The maintenance screen the owner asked for (2026-08-18): "我会overall 维护，然
// 后在维护那边选这个公司是使用哪里几个 merchant，然后他有什么bank。可能是以勾选
// 的方式选择？" — Setup › Recon setup in the redesign (Finance-1a-Setup, batch 6
// §6.3).
//
// What is proved here:
//   • a company is CHOSEN on the screen, not by switching the top bar;
//   • ticking a merchant on/off, and pointing it at one of that company's banks;
//   • ticking which banks the company has, and the server's refusal, verbatim,
//     when one of them is still in use;
//   • the report layout is the shared half — reached from here (a modal),
//     saved globally;
//   • a recognition rule is never deleted: Remove switches it off (g4).

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { MaintenanceData } from './settlement-queries';

const DATA: MaintenanceData = {
  companies: [{ id: 1, code: 'HOUZS', name: 'Houzs Century' }, { id: 2, code: '2990', name: "2990's Home" }],
  merchants: [
    {
      code: 'PBB', display_name: 'PBB', statement_format: 'CSV', has_unique_ref: true,
      fee_method: 'gross-minus-net', date_tolerance_days: 3,
      column_map: { date: 'Date', gross: 'Amount', ref: 'Approval_code', net: 'Net' },
      /* The till calls Public Bank "Public" (owner 2026-10-21: Public=PBB). */
      so_names: ['Public'],
      ready: true, autoMatchable: true,
      /* His own case: the same merchant, two companies, two banks. */
      byCompany: {
        '1': { enabled: true, linked: true, bankAccountCode: '310-0020', feeAccountCode: '900-B001' },
        '2': { enabled: true, linked: true, bankAccountCode: '310-0010', transitAccountCode: '326-0010' },
      },
    },
    {
      code: 'CIMB', display_name: 'CIMB', statement_format: null, has_unique_ref: null,
      fee_method: null, date_tolerance_days: 3, column_map: null,
      ready: false, autoMatchable: false,
      byCompany: {
        '1': { enabled: false, linked: false, bankAccountCode: null },
        '2': { enabled: false, linked: false, bankAccountCode: null },
      },
    },
  ],
  banks: [
    {
      account_code: '310-0010', account_name: 'Bank — Maybank Current',
      byCompany: {
        '1': { inChart: true, enabled: true, usedBy: [] },
        '2': { inChart: true, enabled: true, usedBy: ['PBB'] },
      },
    },
    {
      account_code: '310-0020', account_name: 'Bank — Hong Leong Current',
      byCompany: {
        '1': { inChart: true, enabled: true, usedBy: ['PBB'] },
        /* 2990 does not carry this code at all — not a box it could tick. */
        '2': { inChart: false, enabled: false, usedBy: [] },
      },
    },
  ],
  /* Active EXPENSE leaves, server-filtered to what the posting gate accepts.
     2990's chart carries the account the owner picked on 2026-09-09; HOUZS is
     given a shorter list so a per-company list cannot be faked by a shared one. */
  feeAccounts: {
    '1': [{ account_code: '900-B001', account_name: 'BANK CHARGES' }],
    '2': [
      { account_code: '900-B001', account_name: 'BANK CHARGES' },
      { account_code: '900-T009', account_name: 'TERMINAL INTEREST CHARGES' },
    ],
  },
  /* One clearing account per bank (owner 2026-09-07): 2990 has them, HOUZS
     has only the generic one. */
  clearings: {
    '1': [{ account_code: '326-0000', account_name: 'CARD MACHINE CLEARING (EDC)' }],
    '2': [
      { account_code: '326-0000', account_name: 'CARD MACHINE CLEARING (EDC)' },
      { account_code: '326-0010', account_name: 'CARD MACHINE CLEARING — PBB' },
    ],
  },
};

const merchantMutate = vi.fn();
const bankMutate = vi.fn();
const saveLayout = vi.fn();
const rematchMutateAsync = vi.fn();
let bankError: unknown = null;

/* The recognition-rules card's hooks — stubbed with one live rule so the card
   renders; its write contract is tests/bankRoutes.test.ts. */
const saveRule = vi.fn();
const createRule = vi.fn();
vi.mock('./bank-queries', () => ({
  useBankRules: () => ({ data: { rules: [
    { id: 1, acquirer_code: 'PBB', pattern: 'PBB-PBCS', match_field: 'both', trading_date_pattern: null, merchant_pattern: null, sort_order: 20, is_active: true },
    { id: 2, acquirer_code: 'HLB', pattern: 'HLB MERCH', match_field: 'description', trading_date_pattern: null, merchant_pattern: null, sort_order: 30, is_active: false },
  ] }, isLoading: false }),
  useSaveBankRule: () => ({ mutate: saveRule, isPending: false }),
  useCreateBankRule: () => ({ mutate: createRule, isPending: false }),
  /* The bank-statements card (2026-09-08): one account set up, the reader's
     built-in headings for the placeholders. */
  useBankConfigs: () => ({ data: { configs: [
    { id: 7, account_code: '310-0010', bank_code: 'MBB', account_no: '0000564418610346', statement_format: 'CSV', delimiter: '|', amount_format: 'integer-sen', credit_indicator: 'CR', column_map: { date: ['EFFECT DATE'], description: ['TRX DESCRIPTION'], amount: ['AMOUNT'], indicator: ['AMOUNT IND'] }, is_active: true },
  ], defaultHeadings: { date: ['Date', 'Transaction Date'], description: ['Transaction Description', 'Remarks'], reference: ['Ref. No.'], credit: ['Deposit', 'Credit Amount'], debit: ['Withdrawal', 'Payment Amount'], amount: ['Amount'], indicator: ['Amount Ind'], balance: ['Balance'] } }, isLoading: false }),
  useSaveBankConfig: () => ({ mutate: saveConfig, isPending: false }),
}));
const saveConfig = vi.fn();

const saveNumbering = vi.fn();
vi.mock('./accounting-phase1-queries', () => ({
  useVoucherNumbering: () => ({ isLoading: false, data: { digits: 3, accounts: [
    { accountCode: '310-0010', accountName: 'Bank — Maybank', letter: 'M' },
    { accountCode: '310-0020', accountName: 'Bank — Hong Leong', letter: 'H' },
    { accountCode: '320-0000', accountName: 'Cash in hand', letter: 'C', fixedCash: true },
  ] } }),
  useSaveVoucherNumbering: () => ({ mutate: saveNumbering, isPending: false }),
}));
/* The default-bank card's hooks (vendor accounting-queries) — stubbed so this
   file stays about the maintenance page; the card's own contract is the
   PaymentVoucherNew tests' business. */
const saveBankDefault = vi.fn();
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0010', account_name: 'Bank — Maybank', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '310-0020', account_name: 'Bank — Hong Leong', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '900-A002', account_name: 'Advertisement', account_type: 'EXPENSE', is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useAccountRoles: () => ({ data: { roles: { BANK_DEFAULT: '310-0010', BANK_PAY_DEFAULT: '310-0010', AP: '400-0000' }, overridden: {} }, isLoading: false }),
  useSaveBankDefault: (role: string) => ({ mutate: (code: string, o?: unknown) => saveBankDefault(role, code, o), isPending: false }),
}));
const confirmFn = vi.fn(async (_a: unknown) => true);
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmFn }));

vi.mock('./settlement-queries', () => ({
  useSettlementMaintenance: () => ({ data: DATA, isLoading: false }),
  useSaveMaintenanceMerchant: () => ({ mutate: merchantMutate, isPending: false }),
  useSaveMaintenanceBank: () => ({ mutate: bankMutate, isPending: false, isError: bankError != null, error: bankError }),
  useSaveAcquirerSetup: () => ({ mutate: saveLayout, isPending: false }),
  useRematch: () => ({ mutateAsync: rematchMutateAsync, isPending: false }),
}));

import { SettlementSetup } from './SettlementSetup';

const draw = () => render(<MemoryRouter><SettlementSetup /></MemoryRouter>);

/* A merchant code appears in its own row AND in the "used by" of the bank it
   pays into — find the row by its first-column tick, which is unique. */
const merchantRow = (code: string) =>
  screen.getByLabelText(`${code} for Houzs Century`).closest('tr') as HTMLElement;
const lastBody = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![0] as unknown;

describe('the page in the design’s order and words', () => {
  test('Finance · Setup / Recon setup, and the sections top to bottom', () => {
    draw();
    expect(screen.getByText('Finance · Setup')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recon setup' })).toBeTruthy();
    expect(screen.getByText('Merchants, banks, statements and voucher numbers')).toBeTruthy();
    const order = [...document.querySelectorAll('section[aria-label]')].map((s) => s.getAttribute('aria-label'));
    expect(order).toEqual(['Merchants', 'Banks', 'Voucher numbering', 'Default bank', 'Bank statements', 'Bank recognition rules']);
  });
});

describe('the maintenance table', () => {
  /* His shape: 左手边是 merchant、bank，上面 header 是公司，这个公司有就 tick. */
  test('companies are the columns, merchants and banks are the rows', () => {
    draw();
    expect(screen.getAllByText('Houzs Century').length).toBeGreaterThan(0);
    expect(screen.getAllByText("2990's Home").length).toBeGreaterThan(0);
    // one tick per merchant per company, named so a cell is never ambiguous
    expect((screen.getByLabelText('PBB for Houzs Century') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('CIMB for Houzs Century') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("CIMB for 2990's Home") as HTMLInputElement).checked).toBe(false);
    expect(within(merchantRow('PBB')).getAllByText('Used').length).toBe(2);
    expect(within(merchantRow('CIMB')).getAllByText('Not used').length).toBe(2);
  });

  test('ticking a cell names the company it is for', () => {
    draw();
    fireEvent.click(screen.getByLabelText("CIMB for 2990's Home"));
    expect(lastBody(merchantMutate)).toEqual({ companyId: 2, code: 'CIMB', enabled: true });
  });

  /* The whole reason he wanted a matrix: PBB pays Houzs into Hong Leong and
     2990 into Maybank, and both are on screen at once. */
  test('the same merchant can pay two companies into two different banks', () => {
    draw();
    expect((screen.getByLabelText('PBB bank for Houzs Century') as HTMLSelectElement).value).toBe('310-0020');
    expect((screen.getByLabelText("PBB bank for 2990's Home") as HTMLSelectElement).value).toBe('310-0010');

    fireEvent.change(screen.getByLabelText('PBB bank for Houzs Century'), { target: { value: '310-0010' } });
    expect(lastBody(merchantMutate)).toEqual({ companyId: 1, code: 'PBB', bankAccountCode: '310-0010' });
  });

  /* Only banks THAT company has can receive THAT company's money; none picked
     = the company's default bank. */
  test('a company is only offered its own banks, by name', () => {
    draw();
    const houzs = screen.getByLabelText('PBB bank for Houzs Century') as HTMLSelectElement;
    const twoNine = screen.getByLabelText("PBB bank for 2990's Home") as HTMLSelectElement;
    expect([...houzs.options].map((o) => o.textContent))
      .toEqual(['company default', 'Bank — Maybank Current', 'Bank — Hong Leong Current']);
    expect([...twoNine.options].map((o) => o.textContent))
      .toEqual(['company default', 'Bank — Maybank Current']);
  });

  test('a merchant this company does not use has no bank to choose', () => {
    draw();
    expect(screen.queryByLabelText('CIMB bank for Houzs Century')).toBeNull();
  });
});

describe('the bank matrix', () => {
  test('ticking a bank names its company, and says who uses it', () => {
    draw();
    fireEvent.click(screen.getByLabelText('310-0010 for Houzs Century'));
    expect(bankMutate).toHaveBeenCalledWith({ companyId: 1, accountCode: '310-0010', enabled: false });
    expect(within(screen.getByLabelText('310-0020 for Houzs Century').closest('td') as HTMLElement).getByText('PBB')).toBeTruthy();
  });

  /* A code a company does not carry is not an unticked box it could tick. */
  test('an account missing from a company chart says so instead of offering a tick', () => {
    draw();
    expect(screen.queryByLabelText("310-0020 for 2990's Home")).toBeNull();
    expect(screen.getByText('not in its chart')).toBeTruthy();
  });

  test('the server refusal reaches the screen word for word', () => {
    bankError = Object.assign(new Error("Some of the details weren't accepted."), {
      body: JSON.stringify({ error: 'bank_in_use', message: 'PBB still pays into this account for this company. Point it somewhere else first.' }),
    });
    draw();
    expect(screen.getByText(/PBB still pays into this account/)).toBeTruthy();
    bankError = null;
  });
});

describe('the report layout — the shared half', () => {
  test('it sits outside every company column as the design’s chips, and opens in a modal', () => {
    draw();
    const row = merchantRow('PBB');
    /* File, reference, fee and drift, on the row — no company's. */
    for (const chip of ['CSV', 'Unique ref', 'Gross − net', '±3 days']) expect(within(row).getByText(chip)).toBeTruthy();
    expect(within(merchantRow('CIMB')).getByText('Not taught yet')).toBeTruthy();
    expect(within(merchantRow('CIMB')).getByText('Ref ?')).toBeTruthy();
    expect(within(row).getByText('Edit').getAttribute('title')).toBe('Headings: Date, Amount, Approval_code, Net');
    fireEvent.click(within(row).getByText('Edit'));
    const dialog = screen.getByRole('dialog', { name: 'PBB · how the file reads' });
    expect(within(dialog).getByText(/Every company reads PBB/)).toBeTruthy();
    expect((screen.getByLabelText('PBB Date heading') as HTMLInputElement).value).toBe('Date');
  });

  test('a required heading left blank is refused here, not at upload time', () => {
    saveLayout.mockReset();
    draw();
    fireEvent.click(within(merchantRow('PBB')).getByText('Edit'));
    fireEvent.change(screen.getByLabelText('PBB Date heading'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    expect(screen.getByRole('alert').textContent).toMatch(/Fill in the Date heading/);
    expect(saveLayout).not.toHaveBeenCalled();
  });

  /* Owner 2026-11-09 (0000PP 是 qr direct 去 bank 的，不算卡机的): Hong Leong prints
     its DuitNow QR payments in the card layout, marked in one column. The layout
     names that column and its codes, and saving keeps them. */
  test('the QR column and its codes are part of the layout, and saving keeps them', () => {
    saveLayout.mockReset();
    draw();
    fireEvent.click(within(merchantRow('PBB')).getByText('Edit'));
    fireEvent.change(screen.getByLabelText('PBB QR column heading'), { target: { value: 'TENURE/CASHOUT*' } });
    fireEvent.change(screen.getByLabelText('PBB QR codes in it'), { target: { value: 'DN, WC, WL' } });
    fireEvent.click(screen.getByText('Save'));
    expect(saveLayout).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PBB', columnMap: expect.objectContaining({ date: 'Date', qr: 'TENURE/CASHOUT*', qr_values: 'DN, WC, WL' }) }),
      expect.anything(),
    );
  });

  test('a date tolerance that is not a whole number of days is refused', () => {
    saveLayout.mockReset();
    draw();
    fireEvent.click(within(merchantRow('PBB')).getByText('Edit'));
    fireEvent.change(screen.getByLabelText('PBB date tolerance'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByText('Save'));
    expect(screen.getByRole('alert').textContent).toBe('Date tolerance is a whole number of days.');
    expect(saveLayout).not.toHaveBeenCalled();
  });
});

/* Owner 2026-10-21: 「Pinelabs=AEON，Public=PBB」, and 已经上传的报告也重新对一次. */
describe("a merchant's other names on Sales Orders", () => {
  test('the row says which other names the merchant answers to', () => {
    draw();
    expect(within(merchantRow('PBB')).getByText('also keyed as Public')).toBeTruthy();
  });

  test('saving a new name matches every company that uses the merchant again, and says what changed', async () => {
    saveLayout.mockReset();
    rematchMutateAsync.mockReset();
    saveLayout.mockImplementation((_body: unknown, opts: { onSuccess: () => void }) => opts.onSuccess());
    rematchMutateAsync
      .mockResolvedValueOnce({ ok: true, acquirerCode: 'PBB', reports: 15, lines: 100, matched: 75, newlyMatched: 74, released: 0, failed: [] })
      .mockResolvedValueOnce({ ok: true, acquirerCode: 'PBB', reports: 0, lines: 0, matched: 0, newlyMatched: 0, released: 0, failed: [] });
    draw();
    fireEvent.click(within(merchantRow('PBB')).getByText('Edit'));
    expect((screen.getByLabelText('PBB also keyed as') as HTMLInputElement).value).toBe('Public');
    fireEvent.change(screen.getByLabelText('PBB also keyed as'), { target: { value: 'Public, Public Bank ,' } });
    fireEvent.click(screen.getByText('Save'));

    expect(saveLayout.mock.calls[0]![0]).toMatchObject({ code: 'PBB', soNames: ['Public', 'Public Bank'] });
    expect(await screen.findByText(/PBB saved\. Reports matched again — Houzs Century: 75 lines matched by reference, ready to confirm \(74 new\); 2990's Home: no open lines\./)).toBeTruthy();
    expect(rematchMutateAsync.mock.calls.map((c) => c[0])).toEqual([
      { companyId: 1, acquirerCode: 'PBB' },
      { companyId: 2, acquirerCode: 'PBB' },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    saveLayout.mockReset();
  });

  test('a save that changes nothing a match depends on closes the modal, without matching again', () => {
    saveLayout.mockReset();
    rematchMutateAsync.mockReset();
    saveLayout.mockImplementation((_body: unknown, opts: { onSuccess: () => void }) => opts.onSuccess());
    draw();
    fireEvent.click(within(merchantRow('PBB')).getByText('Edit'));
    fireEvent.change(screen.getByLabelText('PBB statement format'), { target: { value: 'XLSX' } });
    fireEvent.click(screen.getByText('Save'));
    expect(rematchMutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Merchants')).toBeTruthy();
    saveLayout.mockReset();
  });
});

describe('the bank recognition rules card', () => {
  test('a rule edits in place and saves only what changed; a new rule needs acquirer + pattern', () => {
    saveRule.mockClear(); createRule.mockClear();
    draw();
    /* Edit the live PBB rule's pattern — the row's Save wakes up. */
    const pattern = screen.getByLabelText('Pattern for PBB rule 1') as HTMLInputElement;
    expect(pattern.value).toBe('PBB-PBCS');
    fireEvent.change(pattern, { target: { value: 'PBB-PBCS|PBCS-IBG' } });
    fireEvent.click(screen.getByText('Save'));
    expect(saveRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, pattern: 'PBB-PBCS|PBCS-IBG' }),
      expect.anything(),
    );

    /* The add row: acquirer + pattern then Add rule. */
    fireEvent.change(screen.getByLabelText('New rule acquirer'), { target: { value: 'PBB' } });
    fireEvent.change(screen.getByLabelText('New rule pattern'), { target: { value: 'IBG CREDIT' } });
    fireEvent.click(screen.getByText('Add rule'));
    expect(createRule).toHaveBeenCalledWith(
      { acquirerCode: 'PBB', pattern: 'IBG CREDIT' },
      expect.anything(),
    );
  });

  test('a broken pattern is refused on the screen, nothing sent', () => {
    createRule.mockClear();
    draw();
    fireEvent.change(screen.getByLabelText('New rule acquirer'), { target: { value: 'PBB' } });
    fireEvent.change(screen.getByLabelText('New rule pattern'), { target: { value: 'PBB(' } });
    fireEvent.click(screen.getByText('Add rule'));
    expect(screen.getByText('That pattern is not a valid regular expression, so it was not saved.')).toBeTruthy();
    expect(createRule).not.toHaveBeenCalled();
  });

  test('the Order number field keeps no leading zero and commits the right number', () => {
    saveRule.mockClear();
    draw();
    const order = screen.getByLabelText('Order for PBB rule 1') as HTMLInputElement;
    expect(order.value).toBe('20');
    // A leading zero typed in front survives while focused, then normalises on blur …
    fireEvent.focus(order);
    fireEvent.change(order, { target: { value: '0100' } });
    expect(order.value).toBe('0100');
    fireEvent.blur(order);
    expect(order.value).toBe('100');
    // … and the number committed to the draft is never corrupted.
    fireEvent.click(screen.getByText('Save'));
    expect(saveRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, sortOrder: 100 }),
      expect.anything(),
    );
  });

  test('the Active switch saves at once', () => {
    saveRule.mockClear();
    draw();
    fireEvent.click(screen.getByRole('switch', { name: 'HLB rule 2 active' }));
    expect(saveRule.mock.calls[0]![0]).toEqual({ id: 2, isActive: true });
  });

  /* g4: there is no delete — Remove switches the rule off, after asking. */
  test('Remove asks, then switches the rule off; it is never deleted', async () => {
    saveRule.mockClear(); confirmFn.mockClear();
    draw();
    fireEvent.click(screen.getByLabelText('Remove the PBB rule 1'));
    await vi.waitFor(() => expect(saveRule).toHaveBeenCalled());
    const asked = confirmFn.mock.calls[0]![0] as { title: string; body: string; confirmLabel: string; danger?: boolean };
    expect(asked.title).toBe('Remove the PBB rule?');
    expect(asked.body).toMatch(/Statement credits matching “PBB-PBCS” are no longer recognised as PBB payouts\. Every company shares this rule\./);
    expect(asked.body).toMatch(/switched off, not deleted/);
    expect(asked.confirmLabel).toBe('Switch off');
    expect(asked.danger).toBe(true);
    expect(saveRule.mock.calls[0]![0]).toEqual({ id: 1, isActive: false });
    /* An off rule has nothing to remove. */
    expect((screen.getByLabelText('Remove the HLB rule 2') as HTMLButtonElement).disabled).toBe(true);
  });
});

/* One clearing account per bank (owner 2026-09-07: 我想要拆账户). The picker
   sits under the payout bank, shows where the merchant's card money sits
   today, and a change writes transitAccountCode for THAT company. */
describe('the clearing account per merchant', () => {
  test("2990 sees PBB on its own clearing account and can move it; a change names the company", () => {
    merchantMutate.mockClear();
    draw();
    const pick = screen.getByLabelText("PBB clearing for 2990's Home") as HTMLSelectElement;
    expect(pick.value).toBe('326-0010');
    expect([...pick.options].map((o) => o.value)).toEqual(['326-0000', '326-0010']);
    fireEvent.change(pick, { target: { value: '326-0000' } });
    expect(lastBody(merchantMutate)).toEqual({ companyId: 2, code: 'PBB', transitAccountCode: '326-0000' });
    /* HOUZS has only the generic account listed — the picker still shows it,
       reading the generic default. */
    expect((screen.getByLabelText('PBB clearing for Houzs Century') as HTMLSelectElement).value).toBe('326-0000');
  });
});

/* ── Voucher numbering and the default bank ─────────────────────────────── */
describe('voucher numbering', () => {
  test('one letter per money account, the cash drawer fixed at C; Save numbering sends only what changed', () => {
    saveNumbering.mockClear();
    draw();
    expect((screen.getByLabelText('Letter for 320-0000') as HTMLInputElement).readOnly).toBe(true);
    const save = screen.getByText('Save numbering') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Voucher number digits'), { target: { value: '4' } });
    expect(screen.getByText('e.g. MPV-YYMM-0001')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Letter for 310-0020'), { target: { value: 'l' } });
    fireEvent.click(save);
    expect(saveNumbering.mock.calls[0]![0]).toEqual({ digits: 4, letters: [{ accountCode: '310-0020', letter: 'L' }] });
  });

  test('two banks on one letter are refused before anything is sent', () => {
    saveNumbering.mockClear();
    draw();
    fireEvent.change(screen.getByLabelText('Letter for 310-0020'), { target: { value: 'M' } });
    fireEvent.click(screen.getByText('Save numbering'));
    expect(screen.getByText('Each money account needs its own letter.')).toBeTruthy();
    expect(saveNumbering).not.toHaveBeenCalled();
  });

  /* Owner 2026-11-04: 收款和付款的 default bank 要分开 — each its own role. */
  test('the receive and pay-from banks each offer money accounts by name and save on their own', () => {
    saveBankDefault.mockClear();
    draw();
    const pick = screen.getByLabelText('Default bank to receive into') as HTMLSelectElement;
    expect(pick.value).toBe('310-0010');
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Bank — Maybank', 'Bank — Hong Leong']);
    fireEvent.change(pick, { target: { value: '310-0020' } });
    fireEvent.click(within(pick.closest('div') as HTMLElement).getByText('Save'));
    expect(saveBankDefault.mock.calls[0]!.slice(0, 2)).toEqual(['BANK_DEFAULT', '310-0020']);

    const pay = screen.getByLabelText('Default bank to pay from') as HTMLSelectElement;
    expect(pay.value).toBe('310-0010');
    fireEvent.change(pay, { target: { value: '310-0020' } });
    fireEvent.click(within(pay.closest('div') as HTMLElement).getByText('Save'));
    expect(saveBankDefault.mock.calls[1]!.slice(0, 2)).toEqual(['BANK_PAY_DEFAULT', '310-0020']);
  });
});

/* ── The bank-statements card (2026-09-08: 别卡死读 column) ──────────────────── */
describe('the bank statements card', () => {
  test('lists the account already set up in the design’s columns, and saves a new one with several headings per role as lists', () => {
    saveConfig.mockClear();
    draw();
    const card = screen.getByRole('region', { name: 'Bank statements' });
    expect(within(card).getByText('0000564418610346')).toBeTruthy();
    expect(within(card).getByText('CSV · pipe | · integer sen')).toBeTruthy();
    expect(within(card).getByText('EFFECT DATE · AMOUNT')).toBeTruthy();
    fireEvent.click(within(card).getByText('Add account'));
    const dialog = screen.getByRole('dialog', { name: 'Add a statement account' });
    fireEvent.change(screen.getByLabelText('Statement account'), { target: { value: '310-0010' } });
    fireEvent.change(screen.getByLabelText('Bank'), { target: { value: 'HLB' } });
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '23600602788' } });
    fireEvent.change(screen.getByLabelText('Date headings'), { target: { value: 'Date, Transaction Date' } });
    fireEvent.change(screen.getByLabelText('Reference headings (joined)'), { target: { value: 'Ref. No., Sender / Receiver Name' } });
    fireEvent.click(within(dialog).getByText('Save'));
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig.mock.calls[0]![0]).toMatchObject({
      accountCode: '310-0010', bankCode: 'HLB', accountNo: '23600602788', statementFormat: 'CSV', amountFormat: 'decimal',
      columnMap: { date: ['Date', 'Transaction Date'], reference: ['Ref. No.', 'Sender / Receiver Name'] },
    });
    /* Roles left blank are not sent — the reader's built-in names apply. */
    expect((saveConfig.mock.calls[0]![0] as { columnMap: Record<string, unknown> }).columnMap.description).toBeUndefined();
  });

  test('a setup opens for editing from its row ⋯, its account fixed', () => {
    draw();
    fireEvent.click(screen.getByLabelText('More for 310-0010'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Statement · 310-0010' });
    expect((within(dialog).getByLabelText('Statement account') as HTMLSelectElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText('Delimiter') as HTMLSelectElement).value).toBe('|');
  });

  test('without the account and its bank the form says so, nothing sent', () => {
    saveConfig.mockClear();
    draw();
    fireEvent.click(within(screen.getByRole('region', { name: 'Bank statements' })).getByText('Add account'));
    const dialog = screen.getByRole('dialog', { name: 'Add a statement account' });
    fireEvent.click(within(dialog).getByText('Save'));
    expect(within(dialog).getByRole('alert').textContent).toBe('Pick the account and name its bank.');
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

/* ── WHERE THE MERCHANT FEE GOES ──────────────────────────────────────────────
   This had to be a migration once already (docs/bugs/0762): the fee account was
   seeded at 930-0000, the AutoCount chart deactivated that code, and every
   settlement confirm in BOTH companies refused — with nothing on any screen
   able to repoint it. The owner, told that: 这个需要.

   What is pinned here is the shape of the choice. WHICH accounts are offered is
   the server's decision (active EXPENSE leaves — the same properties the
   posting gate checks) and is pinned in tests/settlementRoutes.test.ts. */

describe('the merchant fee account', () => {
  test('is offered per company, from that company own chart', () => {
    draw();
    const row = merchantRow('PBB');
    const houzs = within(row).getByLabelText('PBB fee account for Houzs Century') as HTMLSelectElement;
    const c2990 = within(row).getByLabelText("PBB fee account for 2990's Home") as HTMLSelectElement;
    /* HOUZS's chart offers one, 2990's offers two — a shared list would give
       both the same options. */
    expect([...houzs.options].map((o) => o.value).filter(Boolean)).toEqual(['900-B001']);
    expect([...c2990.options].map((o) => o.value).filter(Boolean)).toEqual(['900-B001', '900-T009']);
  });

  test('shows what is set, and saves the pick against that company alone', () => {
    merchantMutate.mockClear();
    draw();
    const row = merchantRow('PBB');
    const houzs = within(row).getByLabelText('PBB fee account for Houzs Century') as HTMLSelectElement;
    expect(houzs.value).toBe('900-B001');

    fireEvent.change(within(row).getByLabelText("PBB fee account for 2990's Home"), {
      target: { value: '900-T009' },
    });
    expect(lastBody(merchantMutate)).toEqual({ companyId: 2, code: 'PBB', feeAccountCode: '900-T009' });
  });

  /* THE ONE THAT MATTERS. A fee account the chart can no longer post to is
     NAMED, not shown as an empty select — that silence is exactly how 930-0000
     went unnoticed while every confirm in both companies refused. */
  test('names a fee account this chart cannot post to', () => {
    const was = DATA.merchants[0]!.byCompany['1']!;
    DATA.merchants[0]!.byCompany['1'] = { ...was, feeAccountCode: '930-0000' };
    draw();
    const row = merchantRow('PBB');
    expect(within(row).getByText(/930-0000, which this chart cannot post to/)).toBeTruthy();
    DATA.merchants[0]!.byCompany['1'] = was;
  });

  test('says nothing of the sort when the account is one the chart offers', () => {
    draw();
    const row = merchantRow('PBB');
    expect(within(row).queryByText(/cannot post to/)).toBeNull();
  });
});
