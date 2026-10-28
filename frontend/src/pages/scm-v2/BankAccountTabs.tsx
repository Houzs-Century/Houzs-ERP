// ----------------------------------------------------------------------------
// ONE BANK ACCOUNT AT A TIME — the sub-tabs the By month list and the Bank
// statement file list share.
//
// Owner, 2026-09-13: by month 这里我无法分辨什么也会，你可能做成两个 tab?
//
// A list that mixes two accounts' months answers no question either account
// asks: Maybank's June and Hong Leong's June are two reconciliations, not one
// with two rows. The tab names the bank and the code, the way the upload box
// does, and falls back to the code alone where the setup has not loaded —
// a tab that says nothing until a second request returns is a tab that
// flickers.
// ----------------------------------------------------------------------------

import { useBankSetup } from './bank-queries';

export const BankAccountTabs = ({ codes, value, onChange, ariaLabel }: {
  codes: string[];
  value: string | null;
  onChange: (code: string) => void;
  ariaLabel: string;
}) => {
  const setup = useBankSetup();
  if (codes.length === 0) return null;
  const labelOf = (code: string): string => {
    const a = setup.data?.accounts.find((x) => x.account_code === code);
    return a ? `${a.bank_code} · ${code}` : code;
  };
  return (
    <div role="tablist" aria-label={ariaLabel}
      style={{ display: 'inline-flex', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, overflow: 'hidden' }}>
      {codes.map((code) => (
        <button key={code} type="button" role="tab" aria-selected={value === code} onClick={() => onChange(code)}
          style={{
            padding: '4px 12px', fontSize: 'var(--fs-12)', border: 'none', cursor: 'pointer',
            background: value === code ? 'var(--c-ink, #221f20)' : 'transparent',
            color: value === code ? '#fff' : 'inherit',
          }}>
          {labelOf(code)}
        </button>
      ))}
    </div>
  );
};

/** The account to show: the one picked, while it is still there; else the
    first. Never none while there is one — an empty list under a tab strip
    reads as "nothing here" when the truth is "look at the other tab". */
export const currentAccount = (codes: string[], picked: string | null): string | null =>
  picked != null && codes.includes(picked) ? picked : (codes.at(0) ?? null);
