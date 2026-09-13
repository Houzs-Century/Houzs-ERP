/* PoPriceReference — the purchase order's unit price, shown beside a purchase
   invoice line's own price.

   Owner 2026-09-14: 「能直接看到这个 PI 的价钱，以及之前在 PO 里的价钱是多少」, and
   「这只是一个 reference 的 … 我 PI 要填多少钱都是我喜欢的」. So this is plain
   information: no dialog, no block, no approval, and the invoice price stays
   whatever the operator typed.

   Three different facts are kept apart, because each means something different
   to the person checking a bill:
     null  -> "no PO link"      the line has no purchase order behind it
     0     -> "PO had no price" the order never named one (unbound SKU,
                                most AutoCount-migrated Houzs orders)
     > 0   -> "PO RM X", plus "+RM d vs PO" when the invoice price differs.
   When two prices "differ" is decided by the shared rule
   (vendor/scm/lib/pi-po-price-rule.ts, byte-identical with the server's). */

import { comparePiLinePrice } from '../lib/pi-po-price-rule';

export function PoPriceReference({ poUnitPriceSen, piUnitPriceSen, fmt, align = 'left' }: {
  poUnitPriceSen: number | null | undefined;
  piUnitPriceSen: number;
  /* Formats sen in the DOCUMENT's currency — the host page knows which. */
  fmt: (sen: number) => string;
  align?: 'left' | 'right';
}) {
  const box = { display: 'inline-flex', flexDirection: 'column' as const, alignItems: align === 'right' ? 'flex-end' : 'flex-start', gap: 1 };
  const muted = { fontSize: 11.5, color: 'var(--fg-muted, #767b6e)' };
  if (poUnitPriceSen == null) {
    return <span style={muted} title="This line has no purchase order behind it">no PO link</span>;
  }
  if (poUnitPriceSen === 0) {
    return <span style={muted} title="The purchase order did not name a price for this line">PO had no price</span>;
  }
  const cmp = comparePiLinePrice(piUnitPriceSen, poUnitPriceSen);
  return (
    <span style={box}>
      <span style={{ ...muted, fontVariantNumeric: 'tabular-nums' }}>PO {fmt(poUnitPriceSen)}</span>
      {cmp.differs && cmp.diffSen != null && (
        <span
          style={{ fontSize: 11, fontWeight: 600, color: '#a16a2e', fontVariantNumeric: 'tabular-nums' }}
          title="The invoice price is different from the purchase order's price. For reference only."
        >
          {cmp.diffSen > 0 ? '+' : '−'}{fmt(Math.abs(cmp.diffSen))} vs PO
        </span>
      )}
    </span>
  );
}
