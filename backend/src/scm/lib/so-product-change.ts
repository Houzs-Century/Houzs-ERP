/* A product change on a sales order, as Finance reads it.

   Owner 2026-11-23: 「我主要是看销售价和成本的变动，因为我要确定这些改动销售价是足够
   cover成本的变动」. One event compares the order's PRODUCT lines before and after
   a change (service lines - delivery, disposal, storage, transport, SVC-* - never
   count) and says what changed and whether the selling change covered the cost
   change.

   What counts, per line (after the order's opening day; the caller decides that):
     - a new product line (`new_line`), or a removed one (`removed_line`); a sofa
       piece added to, or taken from, a set of the same model is `pieces`;
     - another SKU or model (`sku`; LHF / RHF is the same piece);
     - a seat height (`height`) or another paid option (`option`) that moved the
       line's cost: a height change whose two heights cost the same is not one;
     - a quantity change that moved the line's selling amount (`qty`): one that
       did not is a typo fix and does not count.
   Not a product change: colour, fabric, side, price or discount alone, a remark,
   a delivery date. A price change still moves the selling amount of an event it
   happens in.

   The bucket (owner: 「要列出来」 for the second):
     SELLING    the selling amount of the product lines changed;
     COST_ONLY  it did not, but the cost did.
   Neither, or no product change at all: not an event (null). */

import { isServiceLine } from '../shared/service-sku';
import { splitSofaCode } from '../shared/sofa-combo-pricing';
import { canonicalizeVariants } from '../shared/so-variant-rule';
import { changedSpecKeys, isCostNeutralVariantKey, sidelessCode } from './so-line-cost-edit';

export const PRODUCT_CHANGE_TYPES = ['sku', 'height', 'option', 'pieces', 'qty', 'new_line', 'removed_line'] as const;
export type ProductChangeType = typeof PRODUCT_CHANGE_TYPES[number];
export type ProductChangeBucket = 'SELLING' | 'COST_ONLY';

/** A sales-order line as the record reads it. */
export interface SoLineForChange {
  id: string;
  item_code: string | null;
  item_group: string | null;
  variants: Record<string, unknown> | null;
  qty: number | null;
  total_sen: number | null;
  line_cost_sen: number | null;
  cancelled: boolean | null;
}

/** One product line in a snapshot. `spec` holds the variants that can move a
 *  cost (colour, labels and remarks left out). */
export interface ChangeLineSnap {
  id: string;
  code: string;
  group: string;
  qty: number;
  sellingSen: number;
  costSen: number;
  spec: Record<string, unknown>;
}

export interface ChangedLineSide { code: string; qty: number; sellingSen: number; costSen: number }

export interface ChangedLine {
  id: string;
  types: ProductChangeType[];
  before: ChangedLineSide | null;
  after: ChangedLineSide | null;
}

export interface ProductChangeEvent {
  types: ProductChangeType[];
  lines: ChangedLine[];
  sellingBeforeSen: number;
  sellingAfterSen: number;
  costBeforeSen: number;
  costAfterSen: number;
  bucket: ProductChangeBucket | null;
}

const num = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? Math.round(x) : 0;
};

/** A product line: not a service line by its group, its code or its catalogue
 *  category. Houzs keeps TRANSPORTATION CHARGES, DISPOSE*, STORAGE, MISC, RC-*,
 *  BEDFRAME SL and SOFA SL as SERVICE products, some on lines grouped `others`
 *  or `sofa`, so the catalogue category is the signal that catches them. */
export function isProductLine(row: Pick<SoLineForChange, 'item_code' | 'item_group'>, category: string | null): boolean {
  return !isServiceLine({ itemGroup: row.item_group, itemCode: row.item_code, category });
}

/** The live product lines of an order, in id order. */
export function changeSnapshot(
  rows: readonly SoLineForChange[],
  categoryOf: (code: string) => string | null,
): ChangeLineSnap[] {
  return rows
    .filter((r) => r.cancelled !== true)
    .filter((r) => isProductLine(r, categoryOf(String(r.item_code ?? '').trim())))
    .map((r) => {
      const group = String(r.item_group ?? '').toLowerCase();
      const canonical = canonicalizeVariants(group, r.variants ?? null);
      const spec: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(canonical)) if (!isCostNeutralVariantKey(k)) spec[k] = v;
      return {
        id: String(r.id),
        code: String(r.item_code ?? '').trim(),
        group,
        qty: num(r.qty),
        sellingSen: num(r.total_sen),
        costSen: num(r.line_cost_sen),
        spec,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const isSofa = (l: ChangeLineSnap): boolean => l.group === 'sofa';
const modelOf = (l: ChangeLineSnap): string => splitSofaCode(l.code).baseModel.toUpperCase();
const side = (l: ChangeLineSnap): ChangedLineSide => ({ code: l.code, qty: l.qty, sellingSen: l.sellingSen, costSen: l.costSen });

/** The change between two snapshots of one order's product lines. */
export function productChangeEvent(before: readonly ChangeLineSnap[], after: readonly ChangeLineSnap[]): ProductChangeEvent {
  const byIdBefore = new Map(before.map((l) => [l.id, l]));
  const byIdAfter = new Map(after.map((l) => [l.id, l]));
  const modelsBefore = new Set(before.filter(isSofa).map(modelOf));
  const modelsAfter = new Set(after.filter(isSofa).map(modelOf));
  const ids = [...new Set([...byIdBefore.keys(), ...byIdAfter.keys()])].sort();
  const lines: ChangedLine[] = [];
  const seen = new Set<ProductChangeType>();
  for (const id of ids) {
    const b = byIdBefore.get(id) ?? null;
    const a = byIdAfter.get(id) ?? null;
    const types: ProductChangeType[] = [];
    if (!b && a) {
      types.push(isSofa(a) && modelsBefore.has(modelOf(a)) ? 'pieces' : 'new_line');
    } else if (b && !a) {
      types.push(isSofa(b) && modelsAfter.has(modelOf(b)) ? 'pieces' : 'removed_line');
    } else if (b && a) {
      const costMoved = a.costSen !== b.costSen;
      if (sidelessCode(b.code) !== sidelessCode(a.code)) {
        types.push('sku');
      } else if (costMoved) {
        const keys = changedSpecKeys(b.spec, a.spec);
        if (keys.includes('seatHeight')) types.push('height');
        if (keys.some((k) => k !== 'seatHeight')) types.push('option');
      }
      if (a.qty !== b.qty && a.sellingSen !== b.sellingSen) types.push('qty');
    }
    const moved = !b || !a || b.code !== a.code || b.qty !== a.qty || b.sellingSen !== a.sellingSen || b.costSen !== a.costSen;
    if (types.length === 0 && !moved) continue;
    types.forEach((t) => seen.add(t));
    lines.push({ id, types, before: b ? side(b) : null, after: a ? side(a) : null });
  }
  const sum = (ls: readonly ChangeLineSnap[], f: (l: ChangeLineSnap) => number) => ls.reduce((s, l) => s + f(l), 0);
  const ev = {
    types: PRODUCT_CHANGE_TYPES.filter((t) => seen.has(t)),
    lines,
    sellingBeforeSen: sum(before, (l) => l.sellingSen),
    sellingAfterSen: sum(after, (l) => l.sellingSen),
    costBeforeSen: sum(before, (l) => l.costSen),
    costAfterSen: sum(after, (l) => l.costSen),
  };
  return { ...ev, bucket: bucketOf(ev) };
}

function bucketOf(ev: Omit<ProductChangeEvent, 'bucket'>): ProductChangeBucket | null {
  if (ev.types.length === 0) return null;
  if (ev.sellingAfterSen !== ev.sellingBeforeSen) return 'SELLING';
  if (ev.costAfterSen !== ev.costBeforeSen) return 'COST_ONLY';
  return null;
}

/** Did the selling change cover the cost change? Not when the margin fell:
 *  selling up less than cost, selling down more than cost, or the cost up with
 *  the selling unchanged. `shortfallSen` is by how much. */
export function changeCoverage(ev: Pick<ProductChangeEvent, 'sellingBeforeSen' | 'sellingAfterSen' | 'costBeforeSen' | 'costAfterSen'>): {
  sellingDeltaSen: number; costDeltaSen: number; marginDeltaSen: number; covered: boolean; shortfallSen: number;
} {
  const sellingDeltaSen = ev.sellingAfterSen - ev.sellingBeforeSen;
  const costDeltaSen = ev.costAfterSen - ev.costBeforeSen;
  const marginDeltaSen = sellingDeltaSen - costDeltaSen;
  return { sellingDeltaSen, costDeltaSen, marginDeltaSen, covered: marginDeltaSen >= 0, shortfallSen: Math.max(0, -marginDeltaSen) };
}
