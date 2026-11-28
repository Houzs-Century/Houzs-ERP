import type { CompanyScopeCtx } from './companyScope';
import { companyScope, type ScopedDb } from './scopedDb';

/** Lets the holder post a stock transfer that takes more than the source warehouse holds (owner decision 2026-11-27: warn, allow override). */
export const STOCK_TRANSFER_ALLOW_SHORT = 'scm.stock_transfer.allow_short';

export type TransferShortage = { itemCode: string; variantKey: string; requested: number; available: number };

type BucketLine = { item_code: string; variant_key: string | null; qty: number };

/** Total qty per (item, variant) bucket. */
export function sumByBucket(lines: ReadonlyArray<BucketLine>): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const k = `${l.item_code}::${l.variant_key ?? ''}`;
    out.set(k, (out.get(k) ?? 0) + Number(l.qty));
  }
  return out;
}

/**
 * Buckets whose requested qty exceeds what the source warehouse holds.
 * `alreadyTaken` is what this same transfer already moved out of each bucket
 * (an edit reverses it first, so it counts as available); a new transfer passes an empty map.
 */
export async function findTransferShortages(
  db: ScopedDb,
  c: CompanyScopeCtx,
  fromWarehouseId: string,
  requested: ReadonlyMap<string, number>,
  alreadyTaken: ReadonlyMap<string, number>,
): Promise<{ ok: true; shortages: TransferShortage[] } | { ok: false; reason: string }> {
  const shortages: TransferShortage[] = [];
  for (const [k, qty] of requested.entries()) {
    const [itemCode = '', variantKey = ''] = k.split('::');
    const { data: lots, error } = await db
      .from('v_inventory_lots_open', companyScope(c))
      .select('qty_remaining')
      .eq('warehouse_id', fromWarehouseId)
      .eq('item_code', itemCode)
      .eq('variant_key', variantKey);
    if (error) return { ok: false, reason: error.message };
    const open = lots.reduce((s: number, r: { qty_remaining: number | null }) => s + Number(r.qty_remaining ?? 0), 0);
    const available = open + (alreadyTaken.get(k) ?? 0);
    if (qty > available) shortages.push({ itemCode, variantKey, requested: qty, available });
  }
  return { ok: true, shortages };
}

/** One line per short bucket, for the refusal and the audit note. */
export function shortageMessage(shortages: ReadonlyArray<TransferShortage>): string {
  return shortages
    .map((s) => `${s.itemCode}${s.variantKey ? ` (${s.variantKey})` : ''}: requested ${s.requested}, only ${s.available} available at the source warehouse`)
    .join('; ');
}
