
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useActiveCurrencies, currencyCodesWith } from '../lib/currencies-queries';

type FieldStyles = {
  field?: string;
  fieldLabel?: string;
  fieldInput?: string;
  fieldSelect?: string;
  selectWrap?: string;
  selectChevron?: string;
};

export function CurrencySelect({
  currency,
  onCurrencyChange,
  exchangeRate,
  onRateChange,
  disabled = false,
  currencyLabel = 'Currency',
  rateHint,
  styles,
}: {
  currency: string;
  onCurrencyChange: (code: string) => void;
  exchangeRate: string;
  onRateChange: (rate: string) => void;
  disabled?: boolean;
  currencyLabel?: string;
  rateHint?: ReactNode;
  styles: FieldStyles;
}) {
  const currenciesQ = useActiveCurrencies();
  const codes = currencyCodesWith(currenciesQ.data, currency);
  const isForeign = String(currency).toUpperCase() !== 'MYR';

  return (
    <>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{currencyLabel}</span>
        <span className={styles.selectWrap}>
          <select
            className={styles.fieldSelect}
            value={currency}
            disabled={disabled}
            onChange={(e) => onCurrencyChange(e.target.value)}
          >
            {codes.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <ChevronDown size={14} strokeWidth={1.75} className={styles.selectChevron} />
        </span>
      </label>

      {isForeign && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Exchange rate (MYR per 1 {currency})</span>
          <input
            type="number" min={0} step="0.000001" inputMode="decimal"
            value={exchangeRate}
            disabled={disabled}
            onChange={(e) => onRateChange(e.target.value)}
            placeholder="e.g. 0.62"
            className={styles.fieldInput}
            style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}
          />
          {rateHint != null && (
            <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)', marginTop: 2 }}>
              {rateHint}
            </span>
          )}
        </label>
      )}
    </>
  );
}

export default CurrencySelect;
