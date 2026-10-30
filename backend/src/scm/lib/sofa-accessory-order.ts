import type { SofaPricedAccessory } from '../shared/sofa-combo-pricing';
import type { ProductRowLite, RecomputedLine } from './mfg-pricing-recompute';

type Item = Record<string, unknown>;
type Piece = { id: string; modelId: string; cellId: string };
type Child = { parentIndex: number; pieceIds: string[] };
export type SofaAccessoryOrderContext = {
  parents: Map<number, SofaPricedAccessory[]>;
  children: Map<number, Child>;
};
type Result = { ok: true; context: SofaAccessoryOrderContext } | { ok: false; reason: string };
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const key = (v: unknown): string => typeof v === 'string' ? v.trim() : '';

/** Coverage is derived from actual child SKU lines, never a tablet's price/flag. */
export function validateSofaAccessoryOrder(items: Item[], products: Array<ProductRowLite | null>): Result {
  const parents = new Map<number, SofaPricedAccessory[]>();
  const children = new Map<number, Child>();
  const parentByKey = new Map<string, number>();
  const piecesByParent = new Map<number, Map<string, Piece>>();
  const used = new Map<number, Set<string>>();
  const fail = (reason: string): Result => ({ ok: false, reason });

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const v = record(it.variants);
    if (v.sofaComboIncluded !== undefined || v.sofaAccessoryGroupKey !== undefined) return fail('A saved combo inclusion cannot be supplied on a new order.');
    if (v.sofaAccessories === undefined) continue;
    if (products[i]?.category !== 'SOFA' || !Array.isArray(v.sofaAccessories) || v.sofaAccessories.length > 200)
      return fail('The sofa accessory list is invalid.');
    const parentKey = key(it.cartLineKey);
    if (!parentKey || parentByKey.has(parentKey) || !Number.isSafeInteger(it.qty) || Number(it.qty) < 1)
      return fail('The sofa needs a unique cart key and a whole quantity.');
    if (!Array.isArray(v.cells)) return fail('A sofa with accessories needs its module layout.');
    const cellIds = new Set(v.cells.map((c) => key(record(c).id)).filter(Boolean));
    if (cellIds.size !== v.cells.length) return fail('The sofa module ids must be unique.');
    const pieces = new Map<string, Piece>();
    for (const raw of v.sofaAccessories) {
      const p = record(raw);
      const piece = { id: key(p.id), modelId: key(p.modelId), cellId: key(p.cellId) };
      if (!piece.id || !piece.modelId || !cellIds.has(piece.cellId) || pieces.has(piece.id))
        return fail('An accessory is missing its module or has a duplicate id.');
      pieces.set(piece.id, piece);
    }
    parentByKey.set(parentKey, i);
    piecesByParent.set(i, pieces);
    used.set(i, new Set());
    parents.set(i, []);
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const v = record(it.variants);
    if (v.sofaAccessoryOfKey === undefined && v.sofaAccessoryPieceIds === undefined) continue;
    const parentIndex = parentByKey.get(key(v.sofaAccessoryOfKey));
    const product = products[i];
    if (parentIndex === undefined || product?.category !== 'FABRIC_ACCESSORY')
      return fail('A sofa accessory must reference its sofa and its own accessory SKU.');
    const rawIds = v.sofaAccessoryPieceIds;
    if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 200 || rawIds.some((x) => !key(x)))
      return fail('A sofa accessory line needs its piece ids.');
    const pieceIds = rawIds.map(key);
    if (!Number.isSafeInteger(it.qty) || Number(it.qty) !== Number(items[parentIndex]!.qty) * pieceIds.length)
      return fail('The accessory quantity must equal its pieces multiplied by the sofa quantity.');
    const priceSen = product.sell_price_sen;
    if (typeof priceSen !== 'number' || !Number.isSafeInteger(priceSen) || priceSen < 0)
      return fail('The accessory needs a selling price in the catalogue.');
    for (const pieceId of pieceIds) {
      const piece = piecesByParent.get(parentIndex)!.get(pieceId);
      if (!piece || used.get(parentIndex)!.has(pieceId) || piece.modelId !== product.model_id)
        return fail('Each sofa accessory must occur once and match the submitted SKU Model.');
      used.get(parentIndex)!.add(pieceId);
      parents.get(parentIndex)!.push({ ...piece, priceSen });
    }
    children.set(i, { parentIndex, pieceIds });
  }
  for (const [parentIndex, pieces] of piecesByParent) {
    if (used.get(parentIndex)!.size !== pieces.size) return fail('Every accessory on the sofa must have a matching order line.');
    // The engine's deterministic selection follows the canvas order, not item ordering.
    parents.set(parentIndex, [...pieces.keys()].map((id) => parents.get(parentIndex)!.find((p) => p.id === id)!));
  }
  return { ok: true, context: { parents, children } };
}

/** Parent price includes the package; covered children retain their real cost. */
export function applySofaAccessoryInclusions(
  items: Item[],
  recomputes: Array<RecomputedLine | null>,
  context: SofaAccessoryOrderContext,
): string | null {
  for (const [childIndex, child] of context.children) {
    const parent = recomputes[child.parentIndex];
    const included = new Set(parent?.sofaComboMatchedAccessoryIds ?? []);
    const count = child.pieceIds.filter((id) => included.has(id)).length;
    if (count === 0) {
      if (Number(items[childIndex]!.unitPriceSen ?? 0) === 0 && (recomputes[childIndex]?.unit_price_sen ?? 0) > 0)
        return 'The current sofa combo no longer includes this accessory. Refresh the prices before confirming.';
      continue;
    }
    if (count !== child.pieceIds.length) return 'Included accessories and extra pieces must be separate order lines.';
    const rec = recomputes[childIndex];
    if (!rec) return 'The included accessory could not be priced.';
    if (rec.breakdown.unitPriceSen - rec.breakdown.basePriceSen > 0
      || Number(record(items[childIndex]!.variants).extraAddonAmountRM ?? 0) > 0)
      return 'Add special charges to the sofa line; an accessory included in a combo cannot carry a separate charge.';
    rec.unit_price_sen = 0;
    rec.total_sen = 0;
    rec.drift = Number(items[childIndex]!.unitPriceSen ?? 0) !== 0;
    rec.breakdown = { ...rec.breakdown, basePriceSen: 0, unitPriceSen: 0, lineTotalSen: 0 };
    const groupKey = `build-${child.parentIndex + 1}`;
    const parentItem = items[child.parentIndex]!;
    parentItem.variants = { ...record(parentItem.variants), sofaAccessoryGroupKey: groupKey };
    const childItem = items[childIndex]!;
    childItem.variants = {
      ...record(childItem.variants),
      sofaComboIncluded: { buildKey: groupKey, pieceIds: child.pieceIds },
    };
  }
  return null;
}

/** Read only from a stored line, never from request variants. */
export function isStoredIncludedSofaAccessory(item: { item_group?: unknown; variants?: unknown }): boolean {
  const marker = record(record(item.variants).sofaComboIncluded);
  return String(item.item_group).toLowerCase() === 'fabric_accessory'
    && !!key(marker.buildKey) && Array.isArray(marker.pieceIds) && marker.pieceIds.length > 0;
}

/** JSON object key order cannot make an unchanged package look edited. */
export function sameSofaComboVariants(before: unknown, after: unknown): boolean {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
      : value;
  return JSON.stringify(stable(before)) === JSON.stringify(stable(after));
}
