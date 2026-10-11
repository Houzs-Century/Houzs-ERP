// ─────────────────────────────────────────────────────────────────────────
// cost-anchor-sync.ts — Product cost ⇄ supplier-binding cost mapping (R8 at
// the SKU level). Pure functions only: NO db, NO io. The suppliers.ts /
// mfg-products.ts routes call these, then perform the single mirror write.
//
// SCALE: mfg_products cost is in *sen* (base_price_sen = PRICE_2/cost ref,
// price1_sen = PRICE_1 cost). supplier_material_bindings cost is in *centi*
// (unit_price_centi flat, or price_matrix cells). centi === sen (both RM×100),
// so the mapping is 1:1 — no unit conversion, only field/shape mapping.
//
// DIRECTIONS (bidirectional for FLAT/BEDFRAME; SOFA is one-way product→binding):
//   FLAT  (unit_price_centi; MATTRESS/ACCESSORY/SERVICE)
//        binding→product: base_price_sen = unit_price_centi
//        product→binding: unit_price_centi = base_price_sen
//   BEDFRAME (price_matrix {P1,P2})
//        binding→product: base_price_sen = matrix.P2, price1_sen = matrix.P1
//        product→binding: matrix.P2 = base_price_sen, matrix.P1 = price1_sen
//   SOFA (per-height matrix {height:{P1,P2,P3}})
//        ONE-WAY — the PRODUCT record is authoritative (owner 2026-07-20:
//        "我这用的是产品档"). The product's sofa cost lives in
//        seat_height_prices (per-(height,tier) priceSen = COST) — the SAME grid
//        the binding stores as price_matrix { "<height>": {P1,P2,P3} }. So the
//        old "single SKU cost vs per-height grid is ambiguous" skip compared the
//        WRONG product field (base_price_sen); the real mapping is a shape
//        transform, not ambiguous.
//        product→binding: price_matrix ⇐ seat_height_prices (grouped by height,
//          tier→P1/P2/P3); unit_price_centi ⇐ base_price_sen (flat fallback).
//        binding→product: SKIPPED — a supplier-side edit must NEVER overwrite
//          the authoritative product cost.
// ─────────────────────────────────────────────────────────────────────────

/** Category as stored on mfg_products (uppercased before calling). */
export type AnchorCategory = 'MATTRESS' | 'ACCESSORY' | 'SERVICE' | 'BEDFRAME' | 'SOFA' | string;

/** Minimal binding cost shape this helper reads/writes. */
export type BindingCost = {
  category: AnchorCategory | null;
  unit_price_centi: number | null;
  price_matrix: unknown; // JSONB — { P1,P2 } (bedframe) | { h:{P1,P2,P3} } (sofa) | null
};

/** One row of the product's SOFA cost grid (mfg_products.seat_height_prices,
 *  JSONB). `priceSen` is the COST side (the selling side, sellingPriceSen, is
 *  deliberately NOT read here — cost sync only). A row with no `priceSen`
 *  (selling-only) carries no cost and is skipped, never mirrored as a 0. */
export type ProductSeatCost = {
  height: string;
  tier?: 'PRICE_1' | 'PRICE_2' | 'PRICE_3' | null;
  priceSen?: number | null;
};

/** Minimal product cost shape this helper reads/writes (sen). */
export type ProductCost = {
  base_price_sen: number | null;
  price1_sen: number | null;
  /** SOFA per-(height,tier) COST grid — the authoritative source for the sofa
   *  binding's price_matrix. Absent/empty for non-sofa categories. */
  seat_height_prices?: ProductSeatCost[] | null;
};

/** Patch to apply to the mfg_products row (only the keys that changed). */
export type ProductPatch = Partial<Pick<ProductCost, 'base_price_sen' | 'price1_sen'>>;

/** Patch to apply to the binding row (only the keys that changed). */
export type BindingPatch = {
  unit_price_centi?: number;
  price_matrix?: Record<string, unknown>;
};

export type SyncResult<P> =
  | { skipped: true; reason: string; patch?: undefined }
  | { skipped: false; patch: P };

/** Which cost "lane" a binding uses, derived from its category. SOFA is its
 *  own lane purely so it can be skipped; everything that isn't BEDFRAME/SOFA
 *  falls back to the FLAT unit_price lane (matches validatePriceMatrix, where
 *  only BEDFRAME + SOFA carry a matrix and the rest use unit_price_centi). */
function laneFor(category: AnchorCategory | null): 'FLAT' | 'BEDFRAME' | 'SOFA' {
  const cat = (category ?? '').toUpperCase();
  if (cat === 'SOFA') return 'SOFA';
  if (cat === 'BEDFRAME') return 'BEDFRAME';
  return 'FLAT';
}

/** Coerce a JSONB cell to a finite non-negative integer, or null. */
function asCent(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Coerce a sen value (from a product row / patch) to int, or null. */
function asSen(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/* ── binding cost → product cost ──────────────────────────────────────────
   Called after a binding's cost is written (suppliers.ts PATCH). Returns the
   mfg_products patch to mirror, or { skipped } for SOFA / no-op. */
export function bindingToProductPatch(binding: BindingCost): SyncResult<ProductPatch> {
  const lane = laneFor(binding.category);

  if (lane === 'SOFA') {
    // ONE-WAY: the PRODUCT record is authoritative for sofa cost (owner
    // 2026-07-20 "我这用的是产品档"). A supplier-side binding edit must NEVER
    // flow back onto the product — that would let a supplier overwrite the cost
    // the owner maintains in Product Maintenance. The forward leg
    // (productToBindingPatch) mirrors the product's seat_height_prices onto the
    // binding's price_matrix.
    return { skipped: true, reason: 'sofa_product_is_authoritative' };
  }

  if (lane === 'BEDFRAME') {
    const m = (binding.price_matrix && typeof binding.price_matrix === 'object' && !Array.isArray(binding.price_matrix))
      ? (binding.price_matrix as Record<string, unknown>)
      : {};
    const p2 = asCent(m.P2);
    const p1 = asCent(m.P1);
    const patch: ProductPatch = {};
    // base_price_sen ⇐ matrix.P2 (PRICE_2 / cost ref); price1_sen ⇐ matrix.P1.
    // A missing matrix cell maps to null (clears the product side) so the two
    // sides can't silently diverge.
    patch.base_price_sen = p2;
    patch.price1_sen = p1;
    return { skipped: false, patch };
  }

  // FLAT — 1:1 unit_price_centi → base_price_sen. price1 untouched (flat
  // categories have no PRICE_1 lane on the binding side).
  return { skipped: false, patch: { base_price_sen: asCent(binding.unit_price_centi) } };
}

/* ── product cost → binding cost ──────────────────────────────────────────
   Called after a product's cost is written (mfg-products.ts PATCH). Needs the
   binding's CURRENT price_matrix so the bedframe path can merge P1/P2 onto the
   existing object (preserving any unrelated keys). Returns the binding patch
   to mirror, or { skipped } for SOFA / no-op. */
export function productToBindingPatch(
  product: ProductCost,
  binding: Pick<BindingCost, 'category' | 'price_matrix'>,
): SyncResult<BindingPatch> {
  const lane = laneFor(binding.category);

  if (lane === 'SOFA') {
    // ONE-WAY product→binding (owner 2026-07-20: the product record is the boss
    // for sofa cost). The product's seat_height_prices is a per-(height,tier)
    // COST grid — the SAME information the binding stores as price_matrix
    // { "<height>": {P1,P2,P3} } — so mirror it across as a shape transform.
    // Only the COST side (priceSen) is read; sellingPriceSen is never touched.
    const rows = Array.isArray(product.seat_height_prices) ? product.seat_height_prices : [];
    const matrix: Record<string, { P1?: number; P2?: number; P3?: number }> = {};
    for (const r of rows) {
      if (!r || typeof r.height !== 'string' || r.height === '') continue;
      const cost = asSen(r.priceSen);
      // Money-safe: a selling-only / empty seat row carries NO cost. Skip it —
      // never fabricate a 0 cost into the binding matrix (mirrors
      // resolveSeatHeightSen's costed() guard). A missing cost stays missing.
      if (cost === null) continue;
      const key = r.tier === 'PRICE_1' ? 'P1' : r.tier === 'PRICE_3' ? 'P3' : 'P2';
      const cell = matrix[r.height] ?? (matrix[r.height] = {});
      cell[key] = cost;
    }
    const flat = asSen(product.base_price_sen);
    const patch: BindingPatch = {};
    // Replace the matrix ONLY when the product carries a priced grid, so a
    // product with no seat cost can never WIPE an existing binding matrix to {}.
    if (Object.keys(matrix).length > 0) patch.price_matrix = matrix;
    // Flat fallback lane (unmatched seat size). Set only when the product has a
    // base cost; a null base leaves the binding's flat price untouched rather
    // than forcing it to 0 (money-safe — a missing cost must stay visible).
    if (flat !== null) patch.unit_price_centi = flat;
    if (Object.keys(patch).length === 0) {
      return { skipped: true, reason: 'sofa_product_has_no_cost' };
    }
    return { skipped: false, patch };
  }

  if (lane === 'BEDFRAME') {
    const prev = (binding.price_matrix && typeof binding.price_matrix === 'object' && !Array.isArray(binding.price_matrix))
      ? (binding.price_matrix as Record<string, unknown>)
      : {};
    const next: Record<string, unknown> = { ...prev };
    const p2 = asSen(product.base_price_sen);
    const p1 = asSen(product.price1_sen);
    // Write set cells; strip a cell whose product side is null so the matrix
    // doesn't accumulate nulls (matches the UI's sparse-matrix convention).
    if (p2 === null) delete next.P2; else next.P2 = p2;
    if (p1 === null) delete next.P1; else next.P1 = p1;
    return { skipped: false, patch: { price_matrix: next } };
  }

  // FLAT — 1:1 base_price_sen → unit_price_centi. unit_price_centi is NOT NULL
  // (default 0) on the binding, so a null product cost maps to 0.
  return { skipped: false, patch: { unit_price_centi: asSen(product.base_price_sen) ?? 0 } };
}
