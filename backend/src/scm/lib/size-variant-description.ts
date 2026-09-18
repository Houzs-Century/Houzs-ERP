// ----------------------------------------------------------------------------
// size-variant-description — server-side guard against a size-variant SO line
// describing a DIFFERENT size than the SKU it books.
//
// The failure it exists for (owner spotted it 2026-08-03 on 2990-PO-2608-005):
// the POS catalog card is ONE lead SKU per Model — a K row for the mattress
// models — so the cart snapshots the LEAD SKU's name while `sizeId` carries the
// size the customer actually bought. POS re-resolved `itemCode` per size but not
// the description, so a Queen line booked "…MATT (Q)" and described it as
// "…MATTRESS (183X190X30CM)" — the KING dimensions. That snapshot then rode SO →
// PO (`material_name: it.description`) onto the supplier's printed copy. Five
// prod SO lines across five orders; only King lines came out right.
//
// The POS side is fixed at source (2990s pos-handover-so `pickSoSkuName`). This
// is the seam guard so ANY client — the POS, the ERP forms, a future one — can't
// re-introduce it.
//
// DELIBERATELY NARROW. It corrects a line only when the description is provably
// another SIZE of the same product: the booked SKU carries a `size_code`, and
// the description is EXACTLY the name of a sibling SKU under the same Model
// (or, for pre-`product_models` rows, the same base_model + category). Nothing
// else is touched — hand-written descriptions ("Delivery fee (special model)"),
// legacy prefix drift, blank descriptions and non-sized SKUs all pass through
// unchanged. A guard that rewrites descriptions it can't PROVE are wrong would
// silently undo what sales typed, which is worse than the bug.
// ----------------------------------------------------------------------------

import { scopeToCompany } from './companyScope';
import { pgrestIn } from './pgrest-in-list';

/** The mfg_products columns the correction needs. */
export type SizeSkuRow = {
  code: string;
  name: string | null;
  model_id: string | null;
  base_model: string | null;
  category: string | null;
  size_code: string | null;
};

/** Group key for "SKUs that are the same product in another size". Mirrors the
 *  POS resolver's two paths: model_id first, base_model+category for rows minted
 *  before the product_models layer. Null = this row can't be sibling-matched. */
const siblingKey = (r: SizeSkuRow): string | null => {
  if (r.model_id) return `m:${r.model_id}`;
  if (r.base_model && r.category) return `b:${r.base_model}\0${r.category}`;
  return null;
};

/**
 * The description a line should carry, or `null` when it must be left alone.
 *
 * @param itemCode    the SKU the line actually books
 * @param description the client-supplied description
 * @param byCode      every candidate SKU row, keyed by code (own + siblings)
 */
export const correctedSizeDescription = (
  itemCode: string,
  description: string | null | undefined,
  byCode: Map<string, SizeSkuRow>,
): string | null => {
  const own = byCode.get(itemCode.trim());
  const correct = (own?.name ?? '').trim();
  // Only sized SKUs with a real master name can be adjudicated.
  if (!own || !(own.size_code ?? '').trim() || !correct) return null;

  const given = (description ?? '').trim();
  if (!given || given === correct) return null;

  const key = siblingKey(own);
  if (!key) return null;

  // Wrong ONLY if the description is verbatim another size's official name.
  for (const row of byCode.values()) {
    if (row.code === own.code || siblingKey(row) !== key) continue;
    if ((row.name ?? '').trim() === given) return correct;
  }
  return null;
};

const SIZE_SKU_COLS = 'code, name, model_id, base_model, category, size_code';

/** Load the booked SKUs plus every sibling size they could be confused with,
 *  keyed by code. Two company-scoped reads (the SKUs, then their Models /
 *  base_models); empty map when nothing resolves, so the caller simply leaves
 *  every description untouched. Fail-soft — a lookup hiccup must never block an
 *  order from being placed over a cosmetic description. */
export const loadSizeSkuMap = async (
  sb: any,
  itemCodes: string[],
  c: any,
): Promise<Map<string, SizeSkuRow>> => {
  const codes = [...new Set(itemCodes.map((s) => (s ?? '').trim()).filter(Boolean))];
  const byCode = new Map<string, SizeSkuRow>();
  if (codes.length === 0) return byCode;
  try {
    const { data: own, error: ownErr } = await scopeToCompany(
      pgrestIn(sb.from('mfg_products').select(SIZE_SKU_COLS), 'code', codes),
      c,
    );
    if (ownErr) {
      // eslint-disable-next-line no-console
      console.error('[loadSizeSkuMap] mfg_products by-code read failed:', (ownErr as { message?: unknown }).message ?? ownErr);
    }
    const ownRows = (own ?? []) as SizeSkuRow[];
    for (const r of ownRows) byCode.set(r.code, r);

    // Siblings only matter for the sized rows — an accessory can't be confused
    // with another size of itself.
    const sized = ownRows.filter((r) => (r.size_code ?? '').trim());
    const modelIds = [...new Set(sized.map((r) => r.model_id).filter((m): m is string => Boolean(m)))];
    const baseModels = [...new Set(
      sized.filter((r) => !r.model_id).map((r) => r.base_model).filter((b): b is string => Boolean(b)),
    )];
    const reads = [
      modelIds.length > 0
        ? scopeToCompany(sb.from('mfg_products').select(SIZE_SKU_COLS).in('model_id', modelIds), c)
        : null,
      baseModels.length > 0
        ? scopeToCompany(sb.from('mfg_products').select(SIZE_SKU_COLS).in('base_model', baseModels), c)
        : null,
    ].filter(Boolean);
    for (const res of await Promise.all(reads)) {
      for (const r of ((res as { data?: SizeSkuRow[] } | null)?.data ?? [])) {
        if (!byCode.has(r.code)) byCode.set(r.code, r);
      }
    }
  } catch {
    return byCode; // never block a create over a description
  }
  return byCode;
};
