/* AccountSelect hides what must not be picked: headers with children
   (父户不记账, owner 2026-09-02) and AutoCount CONTROL accounts (SDC/SCC/SBS
   — AR, AP + deposits, stock; owner 2026-09-03: 锁, 由模块自动过账). The
   server refuses both too (requireLeafAccount); the picker does its half by
   not offering them at all. */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { Account } from '../lib/accounting-queries';
import { AccountSelect } from './AccountSelect';

const acct = (over: Partial<Account> & Pick<Account, 'account_code' | 'account_name'>): Account => ({
  account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false, ...over,
});

describe('AccountSelect — headers and control accounts never appear', () => {
  test('a leaf books, its header does not, and SDC/SCC/SBS are hidden even as leaves', () => {
    const accounts: Account[] = [
      acct({ account_code: '310-0000', account_name: 'CASH AT BANK' }),
      acct({ account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', parent_code: '310-0000', acc_money: true, special_type: 'SBK' }),
      acct({ account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', special_type: 'SDC' }),
      acct({ account_code: '400-0000', account_name: 'ACCOUNT PAYABLE', account_type: 'LIABILITY', special_type: 'SCC' }),
      acct({ account_code: '330-0000', account_name: 'STOCK', special_type: 'SBS' }),
      acct({ account_code: '900-A002', account_name: 'ADVERTISEMENT', account_type: 'EXPENSE' }),
    ];
    render(<AccountSelect accounts={accounts} value="" onChange={() => {}} />);
    fireEvent.focus(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option').map((o) => String(o.textContent));
    expect(options.some((t) => t.includes('310-0010'))).toBe(true);   // the bank leaf books
    expect(options.some((t) => t.includes('900-A002'))).toBe(true);   // the expense books
    expect(options.some((t) => t.includes('310-0000'))).toBe(false);  // header hidden
    expect(options.some((t) => t.includes('300-0000'))).toBe(false);  // debtor control hidden
    expect(options.some((t) => t.includes('400-0000'))).toBe(false);  // creditor control hidden
    expect(options.some((t) => t.includes('330-0000'))).toBe(false);  // stock control hidden
  });
});
