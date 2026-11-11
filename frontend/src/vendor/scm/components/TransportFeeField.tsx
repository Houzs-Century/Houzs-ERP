// ----------------------------------------------------------------------------
// TransportFeeField — the Transport fee box on the phone and desktop New SO
// (owner 2026-11-11). A scanned slip writes the transport fee into its total, so
// OCR never reads it as a line; typed here, it becomes (or re-prices) the
// TRANSPORTATION CHARGES line. Shown only for a Houzs order to Sabah, Sarawak,
// Labuan, Kelantan, Terengganu, Perlis or Singapore. The server refuses RM 0.
// ----------------------------------------------------------------------------
import { useState, type Dispatch, type SetStateAction } from 'react';
import {
  companyNeedsTransportFee, isTransportFeeLine, TRANSPORT_FEE_ITEM_CODE, transportFeeRegion,
} from '../../shared/so-transport-fee';

export interface TransportFeeFieldProps<L> {
  companyCode: string | null;
  state: string;
  country: string | null;
  lines: L[];
  setLines: Dispatch<SetStateAction<L[]>>;
  /** The line's identity and amount in sen. */
  read: (l: L) => { itemCode: string; description: string; itemGroup: string; amountSen: number };
  /** The line re-priced to what was typed. */
  priced: (l: L, sen: number, text: string) => L;
  /** A new TRANSPORTATION CHARGES line at what was typed (code, group and name are set here). */
  make: (sen: number, text: string) => L;
  /** Each form's own field styling. */
  classes: { field?: string; label?: string; input?: string };
  style?: React.CSSProperties;
}

const toSen = (text: string): number => Math.round((parseFloat(text.replace(/,/g, '')) || 0) * 100);

export function TransportFeeField<L>(p: TransportFeeFieldProps<L>) {
  const [text, setText] = useState('');
  const region = companyNeedsTransportFee(p.companyCode) ? transportFeeRegion(p.state || null, p.country) : null;
  if (!region) return null;
  const isFee = (l: L) => {
    const r = p.read(l);
    return r.itemCode.trim() !== '' && isTransportFeeLine(r);
  };
  const current = p.lines.find(isFee);
  const shown = text !== '' || !current ? text : (p.read(current).amountSen / 100).toFixed(2);
  const onChange = (next: string) => {
    setText(next);
    const sen = toSen(next);
    p.setLines((prev) => {
      const at = prev.findIndex(isFee);
      if (at >= 0) return prev.map((l, k) => (k === at ? p.priced(l, sen, next) : l));
      const made = p.make(sen, next);
      return [...prev, { ...made, itemCode: TRANSPORT_FEE_ITEM_CODE, itemGroup: 'service' }];
    });
  };
  return (
    <label className={p.classes.field} style={p.style}>
      <span className={p.classes.label}>Transport fee to {region} (RM) *</span>
      <input
        className={p.classes.input}
        inputMode="decimal"
        placeholder="0.00"
        value={shown}
        onChange={(e) => onChange(e.target.value)}
        style={toSen(shown) > 0 ? undefined : { borderColor: 'var(--hz-c-err)' }}
      />
    </label>
  );
}
