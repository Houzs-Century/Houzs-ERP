// ----------------------------------------------------------------------------
// CurrencySelect — the reusable multi-currency control for the procure-to-pay
// documents (GRN / Purchase Invoice / Payment Voucher). Phase 1-A FX frontend.
//
// Renders:
//   • a currency <select> driven by the ACTIVE currencies MASTER
//     (GET /api/scm/currencies) — adding a currency there makes it selectable
//     here with NO code change; the currently-selected code is always present
//     even if it has since been deactivated;
//   • an exchange-rate <input> (MYR per 1 unit of the picked currency) shown
//     ONLY for a foreign currency. MYR is the base — rate is pinned at 1 and the
//     field is hidden, so an all-MYR document is byte-for-byte the pre-FX UI
//     (strict no-op).
//
// The auto-fill of the rate from the master's rate_to_myr (and the "manual edit
// wins" tracking) stays in the parent page — mirrors 2990's GrnNew / PI / PV,
// where the effect keys off the page's own currency + rateTouched state. This
// component is presentational: it only draws the select + rate field + an
// optional MYR-equivalent hint. Pass the page's CSS-module `styles` so it wears
// the same field/label/select classes as the rest of the form.
// ----------------------------------------------------------------------------

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
  /** The selected currency code (e.g. 'MYR' / 'RMB'). */
  currency: string;
  /** Called with the newly-picked currency code. */
  onCurrencyChange: (code: string) => void;
  /** The exchange rate as an editable string (MYR per 1 unit of `currency`). */
  exchangeRate: string;
  /** Called with the raw rate string on edit — the parent flags "touched" so
   *  the master auto-fill stops overwriting a manual rate. */
  onRateChange: (rate: string) => void;
  /** Lock the currency picker (e.g. a GRN whose currency is dictated by its
   *  source PO server-side, or a posted document). The rate field follows the
   *  same `disabled`. */
  disabled?: boolean;
  currencyLabel?: string;
  /** Optional MYR-equivalent line rendered under the rate input (only shown for
   *  a foreign currency), e.g. "≈ MYR 620.00 recorded as inventory cost". */
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

      {/* Base-currency no-op: MYR pins rate 1 and the field disappears, so an
          all-MYR document is visually identical to the pre-FX form. */}
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
