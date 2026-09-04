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
import { isControlSpecial, type Account } from '../lib/accounting-queries';
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
    /* 父户不记账 (the owner, 2026-09-02): a header with children in this list
       is a grouping, not a bookable account — it does not appear here at all.
       And a CONTROL account (AutoCount SDC/SCC/SBS — AR, AP + deposits,
       stock; the owner 2026-09-03: 锁) posts only through its module, never
       by hand — hidden too. The server refuses both (requireLeafAccount + the
       GL gate); hiding is the picker doing its half. The full tree lives on
       the Chart page. */
    const parents = new Set(accounts.map((a) => a.parent_code).filter(Boolean));
    const leaves = accounts.filter((a) => !parents.has(a.account_code)
      && !isControlSpecial(a.special_type));
    const by = new Map<Account['account_type'], Account[]>();
    for (const a of leaves) {
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
