// ----------------------------------------------------------------------------
// AccountSelect — the chart-of-accounts picker used by the Payment Voucher
// pages (the "Paid From" credit account on the header + the expense/charge
// debit account per line).
//
// HOUZS VENDOR — began as a verbatim port of 2990's native <select>. Since
// 2026-09-02 it is a SearchCombo underneath (the owner: 我无法快速打关键字眼
// 搜索account): same props, same value-in/value-out contract, but you TYPE to
// find an account instead of scrolling a 40-row dropdown. Options still show
// "<code> · <name>" and still group ASSET / LIABILITY / EQUITY / INCOME /
// EXPENSE, in that order. Pure presentational — the caller passes the
// already-loaded + filtered accounts (see useAccounts) and owns the value.
// ----------------------------------------------------------------------------

import { useMemo } from 'react';
import type { Account } from '../lib/accounting-queries';
import { SearchCombo, type ComboOption } from './SearchCombo';

const TYPE_ORDER: Account['account_type'][] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const TYPE_LABEL: Record<Account['account_type'], string> = {
  ASSET:     'Assets',
  LIABILITY: 'Liabilities',
  EQUITY:    'Equity',
  INCOME:    'Income',
  EXPENSE:   'Expenses',
};

export function AccountSelect({
  accounts,
  value,
  onChange,
  className,
  placeholder = '— Select an account —',
  disabled,
}: {
  accounts: Account[];
  value: string;
  onChange: (accountCode: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const options = useMemo<ComboOption[]>(() => {
    const by = new Map<Account['account_type'], Account[]>();
    for (const a of accounts) {
      const list = by.get(a.account_type) ?? [];
      list.push(a);
      by.set(a.account_type, list);
    }
    for (const list of by.values()) list.sort((x, y) => x.account_code.localeCompare(y.account_code));
    return TYPE_ORDER.flatMap((t) => (by.get(t) ?? []).map((a) => ({
      value: a.account_code,
      label: `${a.account_code} · ${a.account_name}`,
      group: TYPE_LABEL[t],
    })));
  }, [accounts]);

  return (
    <SearchCombo
      options={options}
      value={value}
      onChange={onChange}
      className={className}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}
