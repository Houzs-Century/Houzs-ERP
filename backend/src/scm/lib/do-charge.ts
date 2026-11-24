// ----------------------------------------------------------------------------
// do-charge — a rate card's named charge on each delivery order (DO_CHARGE,
// mig 20261124T2100). Owner 2026-11-24, the Singapore carriers: 「EU Logistics
// 和 hao hua 的算法应该就是Singapore transport的算法」 and 「haohua应该也是 9% +6%，
// based on good」 — SST 9% and cost 6% of the goods value, and Hao Hua's RM 30
// permit per order. The amount per DO is the rule's amount_sen; its name and
// its share of the goods value (basis points) sit in params as { label, bps }.
// The calculator prices it (delivery-rate-card.ts); this reads, writes and
// checks the params. PURE.
// ----------------------------------------------------------------------------

export const DO_CHARGE = 'DO_CHARGE';

/** A DO_CHARGE rule's name and share of the goods value; nulls on any other rule. */
export function doChargeOf(ruleType: string, params: unknown): { label: string | null; bps: number | null } {
  if (ruleType !== DO_CHARGE) return { label: null, bps: null };
  const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const bps = Number(p.bps);
  const label = typeof p.label === 'string' && p.label.trim() !== '' ? p.label.trim() : null;
  return { label, bps: Number.isInteger(bps) && bps > 0 ? bps : 0 };
}

/** The params with the charge's name and share set; any other keys kept. */
export function withDoCharge(params: Record<string, unknown> | null, label: string, bps: number): Record<string, unknown> {
  return { ...(params ?? {}), label: label.trim(), bps };
}

/** Why a DO_CHARGE cannot be kept as it stands, or null. */
export function doChargeProblem(c: { label: string | null; bps: number; amountSen: number }): string | null {
  if (!c.label?.trim()) return 'Name the charge, for example SST or Permit.';
  if (c.amountSen <= 0 && c.bps <= 0) return 'Give the charge an amount per DO, a % of the goods value, or both.';
  return null;
}
