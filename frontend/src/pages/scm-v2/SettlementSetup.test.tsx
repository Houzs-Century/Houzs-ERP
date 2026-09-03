// The maintenance screen the owner asked for (2026-08-18): "我会overall 维护，然
// 后在维护那边选这个公司是使用哪里几个 merchant，然后他有什么bank。可能是以勾选
// 的方式选择？"
//
// What is proved here:
//   • a company is CHOSEN on the screen, not by switching the top bar;
//   • ticking a merchant on/off, and pointing it at one of that company's banks;
//   • ticking which banks the company has, and the server's refusal, verbatim,
//     when one of them is still in use;
//   • the report layout is the shared half — reached from here, saved globally.

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
      ready: true, autoMatchable: true,
      /* His own case: the same merchant, two companies, two banks. */
      byCompany: {
        '1': { enabled: true, linked: true, bankAccountCode: '310-0020' },
        '2': { enabled: true, linked: true, bankAccountCode: '310-0010' },
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
};

const merchantMutate = vi.fn();
const bankMutate = vi.fn();
const saveLayout = vi.fn();
let bankError: unknown = null;

/* The default-bank card's hooks (vendor accounting-queries) — stubbed so this
   file stays about the maintenance matrix; the card's own contract is the
   PaymentVoucherNew tests' business. */
/* The recognition-rules card's hooks — stubbed with one live rule so the card
   renders; its write contract is tests/bankRoutes.test.ts. */
const saveRule = vi.fn();
const createRule = vi.fn();
vi.mock('./bank-queries', () => ({
  useBankRules: () => ({ data: { rules: [
    { id: 1, acquirer_code: 'PBB', pattern: 'PBB-PBCS', match_field: 'both', trading_date_pattern: null, merchant_pattern: null, sort_order: 20, is_active: true },
  ] }, isLoading: false }),
  useSaveBankRule: () => ({ mutate: saveRule, isPending: false }),
  useCreateBankRule: () => ({ mutate: createRule, isPending: false }),
}));

const saveBankDefault = vi.fn();
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  isControlSpecial: (s: string | null | undefined) => s === 'SDC' || s === 'SCC' || s === 'SBS',
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0010', account_name: 'Bank — Maybank', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '900-A002', account_name: 'Advertisement', account_type: 'EXPENSE', is_active: true, acc_money: false },
  ] }, isLoading: false }),
  useAccountRoles: () => ({ data: { roles: { BANK_DEFAULT: '310-0010', AP: '400-0000' }, overridden: {} }, isLoading: false }),
  useSaveBankDefault: () => ({ mutate: saveBankDefault, isPending: false }),
}));

vi.mock('./settlement-queries', () => ({
  useSettlementMaintenance: () => ({ data: DATA, isLoading: false }),
  useSaveMaintenanceMerchant: () => ({ mutate: merchantMutate, isPending: false }),
  useSaveMaintenanceBank: () => ({ mutate: bankMutate, isPending: false, isError: bankError != null, error: bankError }),
  useSaveAcquirerSetup: () => ({ mutate: saveLayout, isPending: false }),
}));

import { SettlementSetup } from './SettlementSetup';

const draw = () => render(<MemoryRouter><SettlementSetup /></MemoryRouter>);

/* A merchant code appears in its own row AND in the "used by" of the bank it
   pays into — find the row by its first-column tick, which is unique. */
const merchantRow = (code: string) =>
  screen.getByLabelText(`${code} for Houzs Century`).closest('tr') as HTMLElement;

describe('the maintenance table', () => {
  /* His shape: 左手边是 merchant、bank，上面 header 是公司，这个公司有就 tick. */
  test('companies are the columns, merchants and banks are the rows', () => {
    draw();
    expect(screen.getAllByText('Houzs Century').length).toBeGreaterThan(0);
    expect(screen.getAllByText("2990's Home").length).toBeGreaterThan(0);
    // one tick per merchant per company, named so a cell is never ambiguous
    expect((screen.getByLabelText("PBB for Houzs Century") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("CIMB for Houzs Century") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("CIMB for 2990's Home") as HTMLInputElement).checked).toBe(false);
  });

  test('ticking a cell names the company it is for', () => {
    draw();
    fireEvent.click(screen.getByLabelText("CIMB for 2990's Home"));
    expect(merchantMutate).toHaveBeenCalledWith({ companyId: 2, code: 'CIMB', enabled: true });
  });

  /* The whole reason he wanted a matrix: PBB pays Houzs into Hong Leong and
     2990 into Maybank, and both are on screen at once. */
  test('the same merchant can pay two companies into two different banks', () => {
    draw();
    expect((screen.getByLabelText("PBB bank for Houzs Century") as HTMLSelectElement).value).toBe('310-0020');
    expect((screen.getByLabelText("PBB bank for 2990's Home") as HTMLSelectElement).value).toBe('310-0010');

    fireEvent.change(screen.getByLabelText("PBB bank for Houzs Century"), { target: { value: '310-0010' } });
    expect(merchantMutate).toHaveBeenCalledWith({ companyId: 1, code: 'PBB', bankAccountCode: '310-0010' });
  });

  /* Only banks THAT company has can receive THAT company's money. */
  test('a company is only offered its own banks', () => {
    draw();
    const houzs = screen.getByLabelText("PBB bank for Houzs Century") as HTMLSelectElement;
    const twoNine = screen.getByLabelText("PBB bank for 2990's Home") as HTMLSelectElement;
    expect([...houzs.options].map((o) => o.textContent))
      .toEqual(['money lands in…', 'Bank — Maybank Current', 'Bank — Hong Leong Current']);
    expect([...twoNine.options].map((o) => o.textContent))
      .toEqual(['money lands in…', 'Bank — Maybank Current']);
  });

  test('a merchant this company does not use has no bank to choose', () => {
    draw();
    expect(screen.queryByLabelText("CIMB bank for Houzs Century")).toBeNull();
  });
});

describe('the bank matrix', () => {
  test('ticking a bank names its company, and says who uses it', () => {
    draw();
    fireEvent.click(screen.getByLabelText("310-0010 for Houzs Century"));
    expect(bankMutate).toHaveBeenCalledWith({ companyId: 1, accountCode: '310-0010', enabled: false });
    expect(within(screen.getByLabelText("310-0020 for Houzs Century").closest('td') as HTMLElement).getByText('PBB')).toBeTruthy();
  });

  /* A code a company does not carry is not an unticked box it could tick. */
  test('an account missing from a company chart says so instead of offering a tick', () => {
    draw();
    expect(screen.queryByLabelText("310-0020 for 2990's Home")).toBeNull();
    expect(screen.getByText('not in its chart')).toBeTruthy();
  });

  test("the server refusal reaches the screen word for word", () => {
    bankError = Object.assign(new Error("Some of the details weren't accepted."), {
      body: JSON.stringify({ error: 'bank_in_use', message: 'PBB still pays into this account for this company. Point it somewhere else first.' }),
    });
    draw();
    expect(screen.getByText(/PBB still pays into this account/)).toBeTruthy();
    bankError = null;
  });
});

describe('the report layout — the shared half', () => {
  test('it sits outside every company column, and says it is shared', () => {
    draw();
    /* The shared half is labelled as shared, on the row, outside every company
       column — the pill is that claim in the furniture. */
    expect(screen.getAllByText('shared by every company').length).toBe(2);   // one per merchant row
    fireEvent.click(within(merchantRow('PBB')).getByText('Change'));
    expect(screen.getByText(/Every company reads PBB/)).toBeTruthy();
    expect((screen.getByLabelText('PBB Date heading') as HTMLInputElement).value).toBe('Date');
  });

  test('a required heading left blank is refused here, not at upload time', () => {
    draw();
    fireEvent.click(within(merchantRow('PBB')).getByText('Change'));
    fireEvent.change(screen.getByLabelText('PBB Date heading'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    expect(screen.getByText(/Fill in the Date heading/)).toBeTruthy();
    expect(saveLayout).not.toHaveBeenCalled();
  });
});

describe('the bank recognition rules card', () => {
  test('a rule edits in place and saves only what changed; a new rule needs acquirer + pattern', () => {
    draw();
    /* Edit the live PBB rule's pattern — the row's Save wakes up. */
    const pattern = screen.getByLabelText('Pattern for PBB rule 1') as HTMLInputElement;
    expect(pattern.value).toBe('PBB-PBCS');
    fireEvent.change(pattern, { target: { value: 'PBB-PBCS|PBCS-IBG' } });
    const saves = screen.getAllByText('Save').map((el) => el.closest('button')!).filter((b) => !b.disabled);
    fireEvent.click(saves[saves.length - 1]!);
    expect(saveRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, pattern: 'PBB-PBCS|PBCS-IBG' }),
      expect.anything(),
    );

    /* The add row: acquirer + pattern then Add. */
    fireEvent.change(screen.getByLabelText('New rule acquirer'), { target: { value: 'PBB' } });
    fireEvent.change(screen.getByLabelText('New rule pattern'), { target: { value: 'IBG CREDIT' } });
    fireEvent.click(screen.getByText('Add'));
    expect(createRule).toHaveBeenCalledWith(
      { acquirerCode: 'PBB', pattern: 'IBG CREDIT' },
      expect.anything(),
    );
  });
});
