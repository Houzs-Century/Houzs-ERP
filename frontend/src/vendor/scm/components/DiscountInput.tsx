// ----------------------------------------------------------------------------
// DiscountInput — ONE field. Type an amount, or type a percentage.
//
// Owner 2026-09-12: 「它的 percentage 不应该是用打的吗？为什么是选的… 就是1000
// 25% 这样不需要特别去选」 and 「我要的是可以直接 typing by amount 或者 by
// percentage」. The RM/% toggle button shipped on 2026-09-11 (docs/bugs/0803)
// answered the same need with a mode switch; he read the extra click as the
// problem, not the solution. So the mode is GONE: what the operator typed
// decides which one it was.
//
//   1000      -> RM 1,000.00 off this line
//   25%       -> 25% of qty x unit price, resolved to sen at commit
//   RM 1,000  -> the same as the first (a pasted amount keeps working)
//   (blank)   -> no discount
//
// The hint under the field always shows the OTHER unit — type an amount and it
// reads "= 25% of RM 4,000.00"; type a percentage and it reads "= RM 1,000.00".
// A person negotiating on the phone is told both without doing arithmetic, and
// that is the whole reason the percentage was asked for.
//
// STILL NOT PERSISTED (owner ruling 2026-09-11, unchanged): the canonical field
// on every discount table is `discount_sen`, an integer sen amount, and none of
// the 11 line tables carries a `_pct` companion. `onCommit` therefore still
// hands back sen and every call site is untouched by this change. From the next
// open the field reads back as an amount with the percentage in the hint.
//
// Six call sites, all "bare" mode inside a `styles.field` label:
//   • PoLineCard.tsx           (PO / PI / GRN via SalesOrder-shaped card)
//   • PcLineCard.tsx           (Purchase Consignment card)
//   • PurchaseOrderNew.tsx     (inline)
//   • PurchaseConsignmentOrderNew.tsx (inline)
//   • GoodsReceivedDetail.tsx  (inline; disabled when line locked)
//   • PurchaseConsignmentReceiveDetail.tsx (inline; ditto)
// ----------------------------------------------------------------------------
import { useEffect, useRef, useState, type CSSProperties } from 'react';

/** At-rest display for the amount half: "1000.00", "" when there is none. */
const amountAtRest = (sen: number | null | undefined): string =>
  sen == null || sen === 0 ? '' : (sen / 100).toFixed(2);

/** "25", "12.5", "8.33" — trailing zeros dropped so a round number reads round. */
export const pctAtRest = (pct: number): string => {
  if (!Number.isFinite(pct) || pct <= 0) return '';
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/\.?0+$/, '');
};

export type DiscountEntry =
  | { kind: 'blank' }
  | { kind: 'amount'; sen: number }
  | { kind: 'percent'; pct: number; sen: number }
  | { kind: 'invalid' };

/**
 * What did the operator mean by what they typed?
 *
 * PURE, exported and tested directly: the decision "amount or percentage" is
 * the whole feature, and a decision that can only be reached through a rendered
 * input is a decision nobody can enumerate the cases of.
 *
 * `baseSen` is qty x unit price — the amount a percentage is taken FROM. A
 * percentage with no base cannot be resolved, so it comes back `invalid`
 * rather than silently committing 0.
 */
export const readDiscountEntry = (raw: string, baseSen: number): DiscountEntry => {
  const t = raw.trim().replace(/,/g, '');
  if (t === '') return { kind: 'blank' };
  const pctMatch = /^(\d+(?:\.\d+)?)\s*%$/.exec(t);
  if (pctMatch) {
    if (!(baseSen > 0)) return { kind: 'invalid' };
    // Clamp to 100: a discount cannot exceed the line. Mirrors the
    // workshop-repair rule (mig 0241 CHECK 0..100) so both surfaces agree.
    const pct = Math.min(100, Number(pctMatch[1]));
    return { kind: 'percent', pct, sen: Math.round((baseSen * pct) / 100) };
  }
  // An amount. A leading currency word or symbol is accepted because a pasted
  // quote carries one; anything else is a typo and must not commit a number.
  const amtMatch = /^(?:rm|myr|\$)?\s*(\d+(?:\.\d{1,2})?)$/i.exec(t);
  if (!amtMatch) return { kind: 'invalid' };
  return { kind: 'amount', sen: Math.round(Number(amtMatch[1]) * 100) };
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
  /** qty x unitPriceSen, the amount a percentage is taken FROM. Required — a
      percentage with no base is undefined, and the field says so instead of
      committing a zero. */
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
  const [draft, setDraft] = useState(amountAtRest(valueSen));
  const focused = useRef(false);
  /* The hint is SHOWN only while the field has focus, and it FLOATS. Both
     halves were bought by the owner, 2026-09-13, looking at a sales-order line:
     「怎么不是整齐一点呢？」 — the hint rendered as a block under every discount
     cell, on every row, at rest. It made that one column ~14px taller than
     Unit Price and Delivery Date beside it, so the whole line read ragged, and
     it spent a permanent strip of a phone-width row on a sentence nobody is
     reading while they scan a list. A reading you need WHILE TYPING does not
     belong in the resting layout. At rest the same text is still on the input's
     `title`, and it is still announced to a screen reader below. */
  const [showHint, setShowHint] = useState(false);

  // Re-seed from the stored value whenever it changes under us (a qty edit
  // recomputes the line), but never while the operator is typing into it.
  useEffect(() => {
    if (!focused.current) setDraft(amountAtRest(valueSen));
  }, [valueSen]);

  /* The live reading of what is in the box. While focused it follows the
     draft, so "25%" shows its ringgit before the operator lets go; at rest it
     describes the stored amount as a percentage. */
  const live = readDiscountEntry(draft, baseSen);
  const hint = (() => {
    if (baseSen <= 0) return 'Set a unit price first';
    if (live.kind === 'percent') return `= ${currency} ${(live.sen / 100).toFixed(2)}`;
    if (live.kind === 'amount' && live.sen > 0) {
      const pct = Math.round((live.sen / baseSen) * 10000) / 100;
      return `= ${pctAtRest(Math.min(100, pct)) || '0'}% of ${currency} ${(baseSen / 100).toFixed(2)}`;
    }
    if (live.kind === 'invalid') return 'Type an amount (1000) or a percentage (25%)';
    return `${currency} ${(baseSen / 100).toFixed(2)} before discount`;
  })();

  const commit = () => {
    const entry = readDiscountEntry(draft, baseSen);
    if (entry.kind === 'invalid') { setDraft(amountAtRest(valueSen)); return; }
    if (entry.kind === 'blank') {
      if (valueSen !== 0 && valueSen != null) onCommit(0);
      setDraft('');
      return;
    }
    if (entry.sen !== valueSen) onCommit(entry.sen);
    setDraft(amountAtRest(entry.sen));
  };

  return (
    <span
      className={className}
      style={{ display: 'block', position: 'relative', width: '100%' }}
    >
      <input
        type="text"
        inputMode="decimal"
        className={bare ? (inputClassName ?? '') : undefined}
        style={bare ? { textAlign: align, ...style } : style}
        value={draft}
        placeholder="0.00 or 25%"
        disabled={disabled}
        aria-label="Discount — type an amount or a percentage"
        title={`${hint} · Enter to save · Esc to cancel`}
        onFocus={(e) => {
          focused.current = true;
          setShowHint(true);
          if (selectOnFocus) {
            const el = e.currentTarget;
            window.setTimeout(() => { el.select(); }, 0);
          }
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { focused.current = false; setShowHint(false); commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') {
            setDraft(amountAtRest(valueSen));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {/* ABSOLUTE so it cannot change the row's height: the cell keeps the
          input's height at rest AND while typing, and the reading appears over
          whatever is below rather than pushing it down. Opacity rather than
          unmounting, so `aria-live` still announces the reading to a screen
          reader on a field that never receives visible focus. */}
      <span
        aria-live="polite"
        style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          marginTop: 1,
          zIndex: 2,
          pointerEvents: 'none',
          opacity: showHint && !disabled ? 1 : 0,
          transition: 'opacity 80ms linear',
          fontSize: 10.5,
          lineHeight: 1.3,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: live.kind === 'invalid' ? 'var(--c-danger, #b3321f)' : 'var(--c-muted, #6b7580)',
          background: 'var(--c-surface, #fff)',
          textAlign: align,
        }}
      >
        {disabled ? '' : hint}
      </span>
    </span>
  );
};
