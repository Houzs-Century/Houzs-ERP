// ----------------------------------------------------------------------------
// product-profit — the monthly product profit ranking (owner 2026-10-05: 「我每
// 个月什么产品最好卖，同时要兼顾售价和成本，不能只单单看销量，因为销量通常是最便宜
// 的价格」). As he settled it the same day:
//   • a product is its MODEL, sizes together; a sofa counts in SETS — the
//     orders that bought it (「按套」), because 2990 prices every module and
//     Houzs prices one;
//   • the month is the SO date (「按开单月」); DRAFT and CANCELLED orders,
//     cancelled lines and service lines (delivery, installation) stay out;
//   • a zero-price line of a model the same order also SELLS is part of that
//     product — a set's other modules, a same-model free unit — so its cost is
//     the product's own; every other zero-price line is a GIFT, and an order's
//     gifts are shared among the products it paid for by their sales (whole
//     sen, largest remainder). Whether they count is the screen's switch
//     (「可以让我自己在表 switch 要不要 include」);
//   • the free bedframes among those gifts are shared the same way, so each
//     product shows what it gave away (「床架和床垫一起」).
// Pure: the route reads, this builds, the test feeds it worlds.
// ----------------------------------------------------------------------------

import { SO_NOT_AN_ORDER } from '../scm/shared/so-deliverable-states';
import { performanceGroupOf, soLineCostSen } from './performance-pnl';

export type ProductCategory = 'mattress' | 'sofa' | 'bedframe' | 'other';
export const PRODUCT_CATEGORIES: readonly ProductCategory[] = ['mattress', 'sofa', 'bedframe', 'other'];

export type PpOrder = { doc_no: string; status: string };
export type PpLine = {
  doc_no: string; item_group: string | null; item_code: string | null; description: string | null;
  qty: number | null; total_sen: number | null; unit_cost_sen: number | null; line_cost_sen: number | null; cancelled: boolean | null;
};
/** A product and the model it belongs to — `model_id` is the model's uuid. */
export type PpProduct = { code: string; model_id: string | null; base_model: string | null; size_label: string | null };
export type PpModel = { id: string; name: string | null; branding: string | null };

export type ProductProfitItem = { code: string; size: string | null; units: number; salesSen: number; costSen: number };
export type ProductProfitRow = {
  key: string;
  model: string;
  brand: string | null;
  category: ProductCategory;
  /** Sets for a sofa (the orders that bought it), pieces for everything else. */
  units: number;
  orders: number;
  salesSen: number;
  /** The product's own cost, its sets' unpriced modules included. */
  costSen: number;
  /** Its share of the gifts on the orders that bought it. */
  giftSen: number;
  /** Its share of the free bedframes among those gifts (pieces, one decimal) and their cost. */
  freeBedframes: number;
  freeBedframeSen: number;
  /** Priced lines with no cost written on them — the margin reads high. */
  noCostLines: number;
  items: ProductProfitItem[];
};
export type ProductProfitReport = {
  month: string; from: string; to: string;
  orders: number;
  rows: ProductProfitRow[];
  /** Gifts on orders that paid for no product (only service, or nothing). */
  unallocatedGift: { orders: number; sen: number };
  /** Every bedframe given free in the month. */
  freeBedframes: { pieces: number; sen: number; orders: number };
  noCost: { lines: number; salesSen: number };
};

/** Share a whole number of sen by weight, largest remainder first, so the
    shares add back to the total exactly. */
export function shareByWeight(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (total === 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * Math.max(0, w)) / sum);
  const out = raw.map((r) => Math.floor(r));
  let left = total - out.reduce((a, v) => a + v, 0);
  const order = raw.map((r, i) => ({ frac: r - Math.floor(r), i })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) out[order[k].i] += 1;
  return out;
}

const categoryOf = (l: PpLine): ProductCategory | null => {
  const g = performanceGroupOf(l);
  if (g === 'service') return null;
  return g === 'mattress' || g === 'sofa' || g === 'bedframe' ? g : 'other';
};

type Identity = { key: string; name: string; brand: string | null; size: string | null };
type Entry = { line: PpLine; id: Identity; category: ProductCategory; sales: number; cost: number; qty: number };
type Acc = ProductProfitRow & { qty: number; salesByCategory: Map<ProductCategory, number>; itemsByCode: Map<string, ProductProfitItem>; bedframePieces: number };

export function buildProductProfit(p: {
  month: string; from: string; to: string;
  orders: PpOrder[]; lines: PpLine[]; products: PpProduct[]; models: PpModel[];
}): ProductProfitReport {
  const live = new Set(p.orders.filter((o) => !SO_NOT_AN_ORDER.has(String(o.status))).map((o) => o.doc_no));
  const productByCode = new Map(p.products.map((x) => [String(x.code), x]));
  const modelById = new Map(p.models.map((m) => [String(m.id), m]));
  const text = (v: unknown): string => String(v ?? '').trim();

  const identify = (l: PpLine): Identity => {
    const code = String(l.item_code ?? '').trim();
    const prod = code ? productByCode.get(code) : undefined;
    const size = text(prod?.size_label) || null;
    const modelId = text(prod?.model_id);
    const model = modelId ? modelById.get(modelId) : undefined;
    const base = text(prod?.base_model);
    if (model) return { key: `m:${modelId}`, name: text(model.name) || base || code || '—', brand: text(model.branding) || null, size };
    if (base) return { key: `b:${base}`, name: base, brand: null, size };
    const name = code || String(l.description ?? '').trim() || '—';
    return { key: `c:${name}`, name, brand: null, size };
  };

  const byOrder = new Map<string, Entry[]>();
  for (const l of p.lines) {
    if (!live.has(l.doc_no) || l.cancelled === true) continue;
    const category = categoryOf(l);
    if (!category) continue;
    const list = byOrder.get(l.doc_no) ?? [];
    list.push({ line: l, id: identify(l), category, sales: Number(l.total_sen ?? 0), cost: soLineCostSen(l), qty: Number(l.qty ?? 0) });
    byOrder.set(l.doc_no, list);
  }

  const rows = new Map<string, Acc>();
  const rowFor = (id: Identity): Acc => {
    let r = rows.get(id.key);
    if (!r) {
      r = {
        key: id.key, model: id.name, brand: id.brand, category: 'other', units: 0, orders: 0,
        salesSen: 0, costSen: 0, giftSen: 0, freeBedframes: 0, freeBedframeSen: 0, noCostLines: 0, items: [],
        qty: 0, salesByCategory: new Map(), itemsByCode: new Map(), bedframePieces: 0,
      };
      rows.set(id.key, r);
    }
    return r;
  };
  const itemOf = (r: Acc, e: Entry): ProductProfitItem => {
    const code = String(e.line.item_code ?? '').trim() || e.id.name;
    let it = r.itemsByCode.get(code);
    if (!it) { it = { code, size: e.id.size, units: 0, salesSen: 0, costSen: 0 }; r.itemsByCode.set(code, it); }
    return it;
  };

  const unallocated = { orders: 0, sen: 0 };
  const freeBf = { pieces: 0, sen: 0, orders: 0 };
  const noCost = { lines: 0, salesSen: 0 };

  for (const entries of byOrder.values()) {
    const paid = entries.filter((e) => e.sales > 0);
    const paidKeys = new Set(paid.map((e) => e.id.key));
    const gifts = entries.filter((e) => e.sales <= 0 && !paidKeys.has(e.id.key));
    const giftSen = gifts.reduce((a, e) => a + e.cost, 0);
    const bf = gifts.filter((e) => e.category === 'bedframe');
    const bfPieces = bf.reduce((a, e) => a + e.qty, 0);
    const bfSen = bf.reduce((a, e) => a + e.cost, 0);
    if (bf.length > 0) { freeBf.pieces += bfPieces; freeBf.sen += bfSen; freeBf.orders += 1; }

    /* The products this order paid for, each once, with its sales. */
    const keys: string[] = [];
    const salesByKey = new Map<string, number>();
    for (const e of paid) {
      const r = rowFor(e.id);
      r.salesSen += e.sales;
      r.costSen += e.cost;
      r.qty += e.qty;
      r.salesByCategory.set(e.category, (r.salesByCategory.get(e.category) ?? 0) + e.sales);
      const it = itemOf(r, e);
      it.units += e.qty;
      it.salesSen += e.sales;
      it.costSen += e.cost;
      if (e.cost <= 0) { r.noCostLines += 1; noCost.lines += 1; noCost.salesSen += e.sales; }
      if (!salesByKey.has(e.id.key)) keys.push(e.id.key);
      salesByKey.set(e.id.key, (salesByKey.get(e.id.key) ?? 0) + e.sales);
    }
    for (const k of keys) rows.get(k)!.orders += 1;

    /* A zero-price line of a product the order also sells is that product's own. */
    for (const e of entries) {
      if (e.sales > 0 || !paidKeys.has(e.id.key)) continue;
      const r = rows.get(e.id.key)!;
      r.costSen += e.cost;
      itemOf(r, e).costSen += e.cost;
    }

    if (keys.length === 0) {
      if (giftSen > 0) { unallocated.orders += 1; unallocated.sen += giftSen; }
      continue;
    }
    const weights = keys.map((k) => salesByKey.get(k) ?? 0);
    const giftShares = shareByWeight(giftSen, weights);
    const bfShares = shareByWeight(bfSen, weights);
    const totalWeight = weights.reduce((a, w) => a + w, 0);
    keys.forEach((k, i) => {
      const r = rows.get(k)!;
      r.giftSen += giftShares[i];
      r.freeBedframeSen += bfShares[i];
      r.bedframePieces += totalWeight > 0 ? (bfPieces * weights[i]) / totalWeight : 0;
    });
  }

  const out: ProductProfitRow[] = [...rows.values()].map((r) => {
    let category: ProductCategory = 'other';
    let best = -Infinity;
    for (const c of PRODUCT_CATEGORIES) {
      const s = r.salesByCategory.get(c);
      if (s != null && s > best) { best = s; category = c; }
    }
    return {
      key: r.key, model: r.model, brand: r.brand, category,
      units: category === 'sofa' ? r.orders : r.qty,
      orders: r.orders,
      salesSen: r.salesSen, costSen: r.costSen, giftSen: r.giftSen,
      freeBedframes: Math.round(r.bedframePieces * 10) / 10,
      freeBedframeSen: r.freeBedframeSen,
      noCostLines: r.noCostLines,
      items: [...r.itemsByCode.values()].sort((a, b) => b.salesSen - a.salesSen || a.code.localeCompare(b.code)),
    };
  });
  out.sort((a, b) => (b.salesSen - b.costSen - b.giftSen) - (a.salesSen - a.costSen - a.giftSen) || a.model.localeCompare(b.model));

  return {
    month: p.month, from: p.from, to: p.to,
    orders: [...byOrder.keys()].length,
    rows: out,
    unallocatedGift: unallocated,
    freeBedframes: freeBf,
    noCost,
  };
}
