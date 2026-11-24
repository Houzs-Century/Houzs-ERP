// A rate card's charge on each delivery order (DO_CHARGE; owner 2026-11-24 on
// the Singapore carriers: 「based on good」, and a permit per order): a name, an
// amount per DO and/or a % of the DO's goods value. How it reads on the card,
// and the boxes read into a rule. Pure.
import type { RateRule } from '../../../vendor/scm/lib/delivery-rate-card-queries';
import { centiToRM, rmToSen } from './cardSettings';

/** A share as typed: 500 basis points → "5", 250 → "2.5". */
export const bpsToPct = (bps: number | null | undefined): string => (bps ? String(bps / 100) : '');

/** A typed % (up to two decimals, 0 to 100) as basis points; blank is 0; null when unreadable. */
export function pctToBps(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps <= 10_000 ? bps : null;
}

/** What the charge takes, as the card shows it: "5% of goods", "RM 25.00 per DO", or both. */
export function chargeText(rule: Pick<RateRule, 'bps' | 'amountSen'>): string {
  const parts = [
    rule.bps ? `${bpsToPct(rule.bps)}% of goods` : null,
    rule.amountSen > 0 ? `RM ${centiToRM(rule.amountSen)} per DO` : null,
  ].filter(Boolean);
  return parts.join(' + ') || 'Nothing';
}

export type DoChargeBoxes = { name: string; pct: string; rm: string };
export type DoChargeRead = { ok: true; rule: { label: string; bps: number; amountSen: number } } | { ok: false; error: string };

/** The boxes read into a charge, or what is wrong with them. */
export function readDoCharge(b: DoChargeBoxes): DoChargeRead {
  const label = b.name.trim();
  if (!label) return { ok: false, error: 'Name the charge, for example SST or Permit.' };
  if (label.length > 40) return { ok: false, error: 'Keep the name to 40 characters.' };
  const bps = pctToBps(b.pct);
  if (bps == null) return { ok: false, error: 'Enter the % of the goods value as a number from 0 to 100, like 9 or 6.5.' };
  const amountSen = b.rm.trim() === '' ? 0 : rmToSen(b.rm);
  if (amountSen == null) return { ok: false, error: 'Enter an amount in RM, 0 or more.' };
  if (bps === 0 && amountSen === 0) return { ok: false, error: 'Give the charge a % of the goods value, an amount per DO, or both.' };
  return { ok: true, rule: { label, bps, amountSen } };
}
