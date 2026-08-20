/* PO confirm gates, extracted from mfg-purchase-orders.ts (owner 2026-08-20).
 *
 * PO variant gate: a supplier cannot make a sofa/bedframe without the spec, so
 * CONFIRMING a PO requires the core variant axes on every such goods line — the
 * SAME shared rule (missingVariantAxes) the SO proceed gate and the PO form use,
 * so the three surfaces can never drift. Special Orders (variants.specials) is not
 * an axis, so it stays optional. This is the BACKEND half: the form already blocks
 * it, but a direct-API confirm bypassed the form. Every incomplete line is
 * collected — never one-at-a-time (owner "一次过全部爆出来").
 *
 * Fails CLOSED: a lines read that ERRORS refuses the confirm rather than confirming
 * on a check that never ran (owner fail-closed ruling). A line-less / variant-less
 * PO returns no gaps. */
import type { Variables } from '../env';
import { missingVariantAxes } from '../shared/so-variant-rule';

export type PoVariantGap = { code: string; miss: string[] };
export type PoVariantGapsResult = { checkFailed: string } | { gaps: PoVariantGap[] };
export type PoWarehouseGap = { missing: true; codes: string[] } | { missing: false };

/* Warehouse gate (owner 2026-08-02) — a warehouse-less PO cannot go live / be
   GRN-receivable: the receive would land its goods in the wrong warehouse. A read
   that ERRORS fails CLOSED (require the warehouse) rather than confirming a PO we
   could not verify — consistent with the confirm gates' fail-closed posture. */
export async function poWarehouseGap(
  sb: Variables['supabase'],
  poId: string,
): Promise<PoWarehouseGap> {
  const { data: hdr, error: hErr } = await sb.from('purchase_orders').select('purchase_location_id').eq('id', poId).maybeSingle();
  if (hErr) return { missing: true, codes: [] };
  const headerWh = (hdr as { purchase_location_id: string | null } | null)?.purchase_location_id ?? null;
  if (headerWh) return { missing: false }; // header default covers every line
  const { data: lines, error: lErr } = await sb.from('purchase_order_items').select('item_code, warehouse_id').eq('purchase_order_id', poId);
  if (lErr) return { missing: true, codes: [] };
  const bad = ((lines ?? []) as Array<{ item_code: string | null; warehouse_id: string | null }>).filter((l) => !l.warehouse_id);
  if (bad.length === 0) return { missing: false };
  return { missing: true, codes: bad.map((l) => l.item_code ?? '?') };
}

export const PO_WAREHOUSE_REQUIRED = (codes: string[]) => ({
  error: 'purchase_location_id_required',
  message:
    'This PO has no ship-to warehouse, so its goods would be received into the wrong place. Set the ship-to warehouse (or each line\'s warehouse) before it can go live.',
  lines: codes.slice(0, 20),
});

export async function poVariantGaps(
  sb: Variables['supabase'],
  poId: string,
): Promise<PoVariantGapsResult> {
  const { data, error } = await sb
    .from('purchase_order_items')
    .select('item_code, item_group, variants')
    .eq('purchase_order_id', poId);
  if (error) return { checkFailed: error.message };
  const gaps = ((data ?? []) as Array<{ item_code: string | null; item_group: string | null; variants: Record<string, unknown> | null }>)
    .map((l) => ({
      code: (l.item_code ?? '').trim(),
      miss: missingVariantAxes(l.item_group, l.variants, l.item_code ?? null).map((a) => a.label),
    }))
    .filter((x) => x.code && x.miss.length > 0);
  return { gaps };
}

/** The 503 body when the variant check itself could not run (fail-closed). */
export function poVariantCheckFailedBody(reason: string) {
  return {
    error: 'variant_check_failed',
    message:
      'Could not check this PO against the product-options rule, so it is left as a draft '
      + `rather than confirmed on a check that never ran — try again (${reason}).`,
  };
}

/** The 422 body listing every incomplete line, and — when the ship-to warehouse
 *  is also missing — that gap too, so both show at once (never fix-one-retry-one). */
export function poVariantConfirmRefusal(gaps: PoVariantGap[], warehouseGap: PoWarehouseGap) {
  const whTail = warehouseGap.missing
    ? `\n\nThe ship-to warehouse is also missing (${warehouseGap.codes.slice(0, 20).join(', ')}) — set it too.`
    : '';
  return {
    error: 'variants_required',
    message:
      'Complete the product options before confirming this PO:\n'
      + gaps.map((x) => `• ${x.code}: ${x.miss.join(', ')}`).join('\n')
      + '\n\nThe supplier needs these to know what to make. (Special Orders stay optional.)'
      + whTail,
    lines: gaps.slice(0, 20),
  };
}
