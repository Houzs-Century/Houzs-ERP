// ----------------------------------------------------------------------------
// DiscountInput — a MoneyInput with a "%" ↔ "RM" toggle.
//
// Kathy 2026-09-11 (owner-relayed): "我可以打 by amount，也可以打 by percentage
// … 就是 25%". Suppliers quote discounts as percentages; typing an RM amount
// forces mental arithmetic and drifts by a sen or two round-trip.
//
// Owner ruling: do NOT persist the percentage. The canonical field on every
// discount table is `discount_sen` (an integer sen amount); we already store
// no `_pct` companion on any of the 11 line tables it lives in. The toggle
// is UI only. Type 25 in % mode and the field commits `Math.round(baseSen *
// 25 / 100)` sen — from the user's next open, the field reads back as RM.
// The audit that measured this is at docs/bugs/0803-*.md (this PR).
//
// Six call sites today, all "bare" mode inside a `styles.field` label:
//   • PoLineCard.tsx           (PO / PI / GRN via SalesOrder-shaped card)
//   • PcLineCard.tsx           (Purchase Consignment card)
//   • PurchaseOrderNew.tsx     (inline)
//   • PurchaseConsignmentOrderNew.tsx (inline)
//   • GoodsReceivedDetail.tsx  (inline; disabled when line locked)
//   • PurchaseConsignmentReceiveDetail.tsx (inline; ditto)
//
// SoLineCard.tsx has NO editable discount input for regular lines (the only
// place discountSen is written is the delivery-fee "type the amount to
// charge" path, which is a semantic-specific setter, not a discount UI).
// So sales-side surfaces are not part of this change.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MoneyInput } from './MoneyInput';

type Mode = 'rm' | 'pct';

/** For at-rest display in % mode: "25", "12.5", "8.33". */
const pctAtRest = (pct: number): string => {
  if (!Number.isFinite(pct) || pct <= 0) return '';
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/\.?0+$/, '');
};

export const DiscountInput = ({
  valueSen,
  onCommit,
  baseSen,
  bare = false,
  inputClassName,
  selectOnFocus = false,
  disabled = false,
  currency = 'RM',
  className,
  style,
  align = 'right',
}: {
  valueSen: number | null;
  onCommit: (sen: number | null) => void;
  /** qty × unitPriceSen, the amount the % is taken FROM. Required — a % with
      no base is undefined. When baseSen is 0 the % control is disabled. */
  baseSen: number;
  bare?: boolean;
  inputClassName?: string;
  selectOnFocus?: boolean;
  disabled?: boolean;
  currency?: string;
  className?: string;
  style?: CSSProperties;
  align?: 'left' | 'right';
}) => {
  const [mode, setMode] = useState<Mode>('rm');
  const [pctDraft, setPctDraft] = useState('');
  const pctFocused = useRef(false);

  // Derive the current % from the stored sen so a fresh mode-switch shows
  // "the current value expressed as %", not blank. Rounded to 2 dp for a
  // clean read (25.00 → "25", 12.345 → "12.35").
  const currentPct = baseSen > 0 && valueSen != null && valueSen > 0
    ? Math.round((valueSen / baseSen) * 10000) / 100
    : 0;

  useEffect(() => {
    if (!pctFocused.current) setPctDraft(pctAtRest(currentPct));
  }, [currentPct]);

  const commitPct = () => {
    const t = pctDraft.trim().replace(/,/g, '');
    if (t === '') { if (valueSen !== 0 && valueSen != null) onCommit(0); return; }
    const p = Number(t);
    if (!Number.isFinite(p) || p < 0) { setPctDraft(pctAtRest(currentPct)); return; }
    // Clamp above 100 to 100 — a discount cannot exceed the line total. This
    // matches the workshop-repair rule (mig 0241: CHECK 0..100) so the two
    // discount surfaces answer the same shape.
    const clamped = Math.min(100, p);
    const nextSen = Math.round((baseSen * clamped) / 100);
    if (nextSen !== valueSen) onCommit(nextSen);
    setPctDraft(pctAtRest(clamped));
  };

  const toggleMode = () => {
    if (disabled) return;
    if (mode === 'pct' && pctFocused.current) commitPct();
    setMode((m) => (m === 'rm' ? 'pct' : 'rm'));
  };

  // In % mode baseSen == 0 means "nothing to take a % from" — the field is
  // effectively frozen (no computation is meaningful). Keep the toggle usable
  // so the user can flip back to RM.
  const pctDisabled = disabled || baseSen === 0;

  const toggleBtn = (
    <button
      type="button"
      onClick={toggleMode}
      disabled={disabled}
      aria-label={`Discount unit: ${mode === 'rm' ? 'RM' : '%'} — click to switch`}
      title={mode === 'rm' ? 'Switch to percentage' : 'Switch to amount'}
      style={{
        minWidth: 36,
        padding: '0 8px',
        height: 32,
        border: '1px solid var(--c-line, #d0d0d0)',
        background: 'var(--c-cream, #faf8f4)',
        color: 'var(--c-ink, #1a1a1a)',
        fontSize: 12,
        fontWeight: 600,
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        flex: 'none',
      }}
    >
      {mode === 'rm' ? 'RM' : '%'}
    </button>
  );

  const pctField = (
    <input
      type="text"
      inputMode="decimal"
      className={bare ? (inputClassName ?? '') : undefined}
      style={bare ? { textAlign: align, ...style } : style}
      value={pctDraft}
      placeholder="—"
      disabled={pctDisabled}
      aria-label="Discount percentage"
      title={
        baseSen === 0
          ? 'Set a unit price first before typing a percentage'
          : `${pctAtRest(currentPct) || '0'}% of ${currency} ${(baseSen / 100).toFixed(2)}`
      }
      onFocus={(e) => {
        pctFocused.current = true;
        if (selectOnFocus) {
          const el = e.currentTarget;
          window.setTimeout(() => { el.select(); }, 0);
        }
      }}
      onChange={(e) => {
        const v = e.target.value.replace(/,/g, '');
        if (v === '' || /^\d*\.?\d{0,2}$/.test(v)) setPctDraft(v);
      }}
      onBlur={() => { pctFocused.current = false; commitPct(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setPctDraft(pctAtRest(currentPct)); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );

  const inner = mode === 'rm'
    ? (
      <MoneyInput
        bare={bare}
        valueSen={valueSen}
        onCommit={onCommit}
        currency={currency}
        className={className}
        style={style}
        inputClassName={inputClassName}
        selectOnFocus={selectOnFocus}
        disabled={disabled}
        align={align}
      />
    )
    : pctField;

  return (
    <span
      className={className}
      style={{ display: 'flex', gap: 4, alignItems: 'stretch', width: '100%' }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{inner}</span>
      {toggleBtn}
    </span>
  );
};
