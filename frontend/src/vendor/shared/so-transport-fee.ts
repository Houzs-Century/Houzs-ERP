// ----------------------------------------------------------------------------
// so-transport-fee — an order delivered to Sabah, Sarawak, Labuan, Kelantan,
// Terengganu, Perlis or Singapore must carry a transport fee line with an amount above RM 0
// before it may be confirmed (owner 2026-11-11). These go out by freight or on a
// trip of their own, so an order with no fee, or a fee at RM 0, loses money.
//
// A transport line is matched the way the DO list's Transport column matches it
// (lib/do-list-lines.ts doChargeKind): the code or description says TRANSPORT or
// SHIPPING, or it is an SVC-DELIVERY fee. Goods lines never count.
// ----------------------------------------------------------------------------
import { isDeliveryFeeServiceCode } from './service-sku';

/** The same shape as SaveProblem (shared/so-save-problems.ts), which has no
 *  frontend copy; this file is byte-mirrored to frontend/src/vendor/shared. */
export type TransportFeeProblem = { code: string; message: string; field: string };

/** The catalog service code the Transport fee box writes its line under. */
export const TRANSPORT_FEE_ITEM_CODE = 'TRANSPORTATION CHARGES';

/** States whose orders need a transport fee. Matched on the upper-cased,
 *  space-collapsed name, so the AutoCount spellings pass too. */
const FEE_STATES: ReadonlySet<string> = new Set([
  'SABAH', 'SARAWAK', 'LABUAN', 'KELANTAN', 'TERENGGANU', 'TRENGGANU', 'PERLIS', 'SINGAPORE',
]);

const norm = (s: string | null | undefined): string =>
  String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** The place name when this delivery needs a transport fee, else null. */
export function transportFeeRegion(state: string | null, country: string | null): string | null {
  if (norm(country) === 'SINGAPORE') return 'Singapore';
  const s = norm(state);
  if (!FEE_STATES.has(s)) return null;
  return s === 'TRENGGANU' ? 'Terengganu' : s.charAt(0) + s.slice(1).toLowerCase();
}

export type TransportFeeLine = {
  itemCode: string | null;
  description: string | null;
  itemGroup: string | null;
  /** The line's amount after discount, in sen; null when the caller cannot
   *  know it (a live-check payload without prices), which is not judged. */
  amountSen: number | null;
};

export function isTransportFeeLine(l: Pick<TransportFeeLine, 'itemCode' | 'description' | 'itemGroup'>): boolean {
  if (/mattress|sofa|bedframe|accessor/i.test(l.itemGroup ?? '')) return false;
  const s = `${l.itemCode ?? ''} ${l.description ?? ''}`.toUpperCase();
  return s.includes('TRANSPORT') || s.includes('SHIPPING') || isDeliveryFeeServiceCode(l.itemCode);
}

/** The refusal for an order to these places with no priced transport line, else null. */
export function transportFeeProblem(state: string | null, country: string | null, lines: readonly TransportFeeLine[]): TransportFeeProblem | null {
  const region = transportFeeRegion(state, country);
  if (!region) return null;
  const fees = lines.filter(isTransportFeeLine);
  if (fees.some((l) => l.amountSen == null || l.amountSen > 0)) return null;
  return {
    code: 'transport_fee_required',
    message: fees.length === 0
      ? `Delivery to ${region} needs a transport fee: add the TRANSPORTATION CHARGES line with its amount.`
      : `Delivery to ${region} needs a transport fee above RM 0: put the amount on the transport line.`,
    field: 'Transport fee',
  };
}
