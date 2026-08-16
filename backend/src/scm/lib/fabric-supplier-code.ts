// ----------------------------------------------------------------------------
// fabric-supplier-code — READ-time enrichment that stamps each SO/PO/DO/SI line's
// variants with `fabricSupplierCode` (the supplier's own code for our internal
// fabric), so the on-screen detail line reads "BF-01 (PC151-01)" — the same
// internal-plus-supplier pairing the fabric PICKER and the PDFs already show.
//
// Owner rule (2026-07-24): "orders 全部也是要补回去 ... 显示两个 code BF-01（PC151-01)".
// buildVariantSummary renders the parenthesised supplier code when this field is
// present + DISTINCT; absent -> the line is unchanged (old behaviour). So this is
// a pure DISPLAY enrichment on the returned rows — it never mutates stored data.
//
// ONE batched query per document (NOT per line): Cloudflare Workers cap the
// subrequests a single request may make, so a per-line lookup would blow the cap
// on a large order. We collect the distinct internal fabric codes off the lines'
// variants, resolve them all in a single scm.fabric_trackings read scoped to the
// active company, then stamp each line from the resulting map.
//
// Fail-soft: any lookup error leaves the lines untouched (they fall back to the
// bare internal code) — a fabric-code hiccup must never fail a detail response.
// ----------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { chunkIn } from './paginate-all';

/* The variant keys that can carry the internal fabric code, in the SAME
   precedence order computeVariantKey / buildVariantSummary read them:
   SO/PO/DO/SI lines store it under `fabricCode`; the GRN / PI / PR /
   Stock-Adjustment variant editors store the pick under `fabricColor`; POS
   lines may carry `colorCode` / `colourCode`. The summary renders whichever is
   present, so the enrichment must resolve the same chain — otherwise a PI/GRN
   line whose fabric lives in `fabricColor` never gets its supplier parens
   (owner 2026-07-24, "为什么我的 Purchase Invoice 没有看到 PC151-01 那种 code").
   A value that is not actually a fabric code (e.g. a bare colour code) simply
   finds no fabric_trackings row and the line is left unchanged. */
const FABRIC_CODE_KEYS = ['fabricCode', 'colorCode', 'colourCode', 'fabricColor'] as const;

/* A returned order line, loose enough to accept every detail endpoint's mapped
   row shape. Record (index signature) — NOT `{ variants?: unknown }`, which is a
   weak type TS rejects for the concrete mapped rows that carry no static
   `variants` key. `variants` rides on the row as an index-signature value. */
type LineWithVariants = Record<string, unknown>;

const trimStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** One scm.fabric_trackings row, as both lookups below read it. */
type FabricRow = { fabric_code?: string | null; supplier_code?: string | null };

/* The line's internal fabric code, read through the alias chain above. */
const fabricCodeOf = (v: Record<string, unknown>): string => {
  for (const k of FABRIC_CODE_KEYS) {
    const fc = trimStr(v[k]);
    if (fc) return fc;
  }
  return '';
};

/**
 * Stamp `variants.fabricSupplierCode` on every line whose internal fabricCode has
 * a supplier_code in scm.fabric_trackings (active company). Mutates the passed
 * `items` in place — each enriched line gets a CLONED variants object, so the
 * source row (and any drift comparison already computed off the raw variants) is
 * left untouched. Resolves with nothing; on any failure the lines are unchanged.
 */
export async function enrichLinesWithFabricSupplierCode(
  sb: SupabaseClient<any, any, any>,
  c: CompanyScopeCtx,
  items: LineWithVariants[],
): Promise<void> {
  // Distinct internal fabric codes riding on the lines.
  const codes = new Set<string>();
  for (const it of items) {
    const v = it.variants;
    if (v && typeof v === 'object') {
      const fc = fabricCodeOf(v as Record<string, unknown>);
      if (fc) codes.add(fc);
    }
  }
  if (codes.size === 0) return;

  const map = new Map<string, string>();
  try {
    /* Chunked + paged, company-scoped (no-op pre-activation / single-company).
       It used to be ONE unpaged read: PostgREST answers with at most one page
       whatever is asked, so a caller with more fabric codes than fit a page got
       a silent slice and the lines past it lost their supplier-code suffix. MRP
       became such a caller on 2026-08-16 when its demand read stopped being
       truncated — 121 distinct codes today, but the bound is the live catalogue,
       not a constant. */
    const { data } = await chunkIn<FabricRow>(
      [...codes],
      (batch, from, to) => scopeToCompany(
        sb.from('fabric_trackings').select('fabric_code, supplier_code').in('fabric_code', batch),
        c,
      ).order('fabric_code').range(from, to).then((r) => ({
        data: (r.data ?? []) as FabricRow[],
        error: r.error,
      })),
    );
    for (const r of data) {
      const code = trimStr(r.fabric_code);
      const sup = trimStr(r.supplier_code);
      // On HOUZS fabrics supplier_code is often blank -> skip, so the line falls
      // back to the bare internal code with NO empty parens.
      if (code && sup) map.set(code, sup);
    }
  } catch {
    return; // a lookup hiccup must never fail the detail response
  }
  if (map.size === 0) return;

  for (const it of items) {
    const v = it.variants;
    if (!v || typeof v !== 'object') continue;
    const fc = fabricCodeOf(v as Record<string, unknown>);
    if (!fc) continue;
    const sup = map.get(fc);
    // Distinct-only: a supplier code equal to the internal code adds no parens
    // (buildVariantSummary guards this too — belt and braces).
    if (sup && sup !== fc) {
      it.variants = { ...(v as Record<string, unknown>), fabricSupplierCode: sup };
    }
  }
}

/**
 * INVENTORY flavour — stamp `fabric_supplier_code` on rows that carry only the
 * canonical composite `variant_key` (inventory_balances / lots / batch
 * components; mig 0095) instead of a variants object. The key's fabric segment
 * is `fabriccode=<value>` with the value LOWERCASED by computeVariantKey, so
 * the batched fabric_trackings lookup matches case-insensitively by querying
 * both the lowercased key value and its uppercased form (fabric codes are
 * conventionally uppercase — BF-01 / EZ-002 / KN390-1). A code that matches
 * nothing leaves the row unchanged (fail-soft, same contract as above).
 *
 * The stamped `fabric_supplier_code` is what lets the UI render the SAME final
 * fabric format as buildVariantSummary — "EZ-002 (KN390-2) / SEAT 28" — via
 * formatVariantKey's supplier parameter (owner 2026-07-24, "全部包裹 stocks,
 * 你也是要看到他 supplier 的 fabric code").
 */
export async function enrichVariantKeyRowsWithFabricSupplierCode(
  sb: SupabaseClient<any, any, any>,
  c: CompanyScopeCtx,
  rows: Array<Record<string, unknown>>,
  keyField = 'variant_key',
): Promise<void> {
  const fabricOfKey = (key: unknown): string => {
    const k = trimStr(key);
    if (!k) return '';
    for (const part of k.split('|')) {
      if (part.startsWith('fabriccode=')) return part.slice('fabriccode='.length).trim();
    }
    return '';
  };

  const codes = new Set<string>();
  for (const r of rows) {
    const fc = fabricOfKey(r[keyField]);
    if (fc) { codes.add(fc); codes.add(fc.toUpperCase()); }
  }
  if (codes.size === 0) return;

  const map = new Map<string, string>(); // LOWERCASED internal code -> supplier code
  try {
    const { data } = await scopeToCompany(
      sb.from('fabric_trackings').select('fabric_code, supplier_code').in('fabric_code', [...codes]),
      c,
    );
    for (const r of (data ?? []) as Array<{ fabric_code?: string | null; supplier_code?: string | null }>) {
      const code = trimStr(r.fabric_code).toLowerCase();
      const sup = trimStr(r.supplier_code);
      if (code && sup && sup.toLowerCase() !== code) map.set(code, sup);
    }
  } catch {
    return; // a lookup hiccup must never fail an inventory response
  }
  if (map.size === 0) return;

  for (const r of rows) {
    const fc = fabricOfKey(r[keyField]).toLowerCase();
    if (!fc) continue;
    const sup = map.get(fc);
    if (sup) r.fabric_supplier_code = sup;
  }
}
