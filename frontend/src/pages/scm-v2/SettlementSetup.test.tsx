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
  companyId: 1,
  companies: [{ id: 1, code: 'HOUZS', name: 'Houzs Century' }, { id: 2, code: '2990', name: "2990's Home" }],
  merchants: [
    {
      code: 'PBB', display_name: 'PBB', statement_format: 'CSV', has_unique_ref: true,
      fee_method: 'gross-minus-net', date_tolerance_days: 3,
      column_map: { date: 'Date', gross: 'Amount', ref: 'Approval_code', net: 'Net' },
      enabled: true, linked: true, bank_account_code: '331-0000',
      transit_account_code: '320-0000', fee_account_code: '930-0000',
      ready: true, autoMatchable: true,
    },
    {
      code: 'CIMB', display_name: 'CIMB', statement_format: null, has_unique_ref: null,
      fee_method: null, date_tolerance_days: 3, column_map: null,
      enabled: false, linked: false, bank_account_code: null,
      transit_account_code: '320-0000', fee_account_code: '930-0000',
      ready: false, autoMatchable: false,
    },
  ],
  bankAccounts: [
    { account_code: '330-0000', account_name: 'Bank — Maybank Current', enabled: true, usedBy: [] },
    { account_code: '331-0000', account_name: 'Bank — Hong Leong Current', enabled: true, usedBy: ['PBB'] },
  ],
};

const merchantMutate = vi.fn();
const bankMutate = vi.fn();
const saveLayout = vi.fn();
let bankError: unknown = null;

vi.mock('./settlement-queries', () => ({
  useSettlementMaintenance: () => ({ data: DATA, isLoading: false }),
  useSaveMaintenanceMerchant: () => ({ mutate: merchantMutate, isPending: false }),
  useSaveMaintenanceBank: () => ({ mutate: bankMutate, isPending: false, isError: bankError != null, error: bankError }),
  useSaveAcquirerSetup: () => ({ mutate: saveLayout, isPending: false }),
}));

import { SettlementSetup } from './SettlementSetup';

const draw = () => render(<MemoryRouter><SettlementSetup /></MemoryRouter>);
/* A merchant code appears twice on this screen — its own row, and the "used
   by" column of the bank it pays into. Find rows by their tick, which is unique. */
const merchantRow = (code: string) => screen.getByLabelText(`Use ${code}`).closest('tr') as HTMLElement;
const bankRow = (code: string) => screen.getByLabelText(`Has ${code}`).closest('tr') as HTMLElement;

describe('choosing the company', () => {
  test('every company he may maintain is on the screen — no switching required', () => {
    draw();
    const picker = screen.getByLabelText('Company') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['Houzs Century', "2990's Home"]);
    expect(picker.value).toBe('1');
  });
});

describe('which merchants this company uses', () => {
  test('a merchant is ticked on, and a company that never set one up sees it unticked', () => {
    draw();
    expect((screen.getByLabelText('Use PBB') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Use CIMB') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByLabelText('Use CIMB'));
    expect(merchantMutate).toHaveBeenCalledWith({ companyId: 1, code: 'CIMB', enabled: true });
  });

  /* The owner's case: PBB pays Houzs into Maybank and 2990 into Hong Leong. */
  test('each merchant points at one of THIS company bank accounts', () => {
    draw();
    const bank = within(merchantRow('PBB')).getByLabelText('PBB bank account') as HTMLSelectElement;
    expect(bank.value).toBe('331-0000');
    expect([...bank.options].map((o) => o.textContent))
      .toEqual(['not set', 'Bank — Maybank Current', 'Bank — Hong Leong Current']);

    fireEvent.change(bank, { target: { value: '330-0000' } });
    expect(merchantMutate).toHaveBeenCalledWith({ companyId: 1, code: 'PBB', bankAccountCode: '330-0000' });
  });

  test('a merchant this company does not use has no bank to choose', () => {
    draw();
    expect((screen.getByLabelText('CIMB bank account') as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('which banks this company has', () => {
  test('ticking a bank off is sent for THIS company', () => {
    draw();
    fireEvent.click(screen.getByLabelText('Has 330-0000'));
    expect(bankMutate).toHaveBeenCalledWith({ companyId: 1, accountCode: '330-0000', enabled: false });
  });

  test('a bank a merchant still pays into names who is using it', () => {
    draw();
    expect(within(bankRow('331-0000')).getByText('PBB')).toBeTruthy();
  });

  /* The server refuses it; the screen must show the server's own sentence, not
     "some details weren't accepted". */
  test("the server's refusal reaches the screen word for word", () => {
    bankError = Object.assign(new Error("Some of the details weren't accepted."), {
      body: JSON.stringify({ error: 'bank_in_use', message: 'PBB still pays into this account for this company. Point it somewhere else first.' }),
    });
    draw();
    expect(screen.getByText(/PBB still pays into this account/)).toBeTruthy();
    bankError = null;
  });
});

describe('the report layout — the shared half', () => {
  test('it is reached from the merchant, and says it is shared', () => {
    draw();
    fireEvent.click(within(merchantRow('PBB')).getByText('Report layout'));
    expect(screen.getByText(/Every company reads PBB/)).toBeTruthy();
    expect((screen.getByLabelText('PBB Date heading') as HTMLInputElement).value).toBe('Date');
  });

  test('a required heading left blank is refused here, not at upload time', () => {
    draw();
    fireEvent.click(within(merchantRow('PBB')).getByText('Report layout'));
    fireEvent.change(screen.getByLabelText('PBB Date heading'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    expect(screen.getByText(/Fill in the Date heading/)).toBeTruthy();
    expect(saveLayout).not.toHaveBeenCalled();
  });
});
