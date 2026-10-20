// ---------------------------------------------------------------------------
// grn-scan-gifts — free gifts a supplier puts on the delivery order that are on
// no PO (DIGLANT's "GWP Pillow" with the mattresses). Sim, 2026-10-20: receive
// them into stock at RM0. A gift's printed code is taught once on the scan card
// to a product of our catalogue (scm.supplier_scan_codes, like any taught code);
// from then on each scanned draft gets it as a line with no PO link, RM0,
// acknowledged as a free gift. No PO link means it never reaches AutoCount
// (autocount-convert-lines carries source-linked lines only).
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { recomputeGrnTotals } from '../routes/grns';
import { buildVariantSummary } from '../shared';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { normalizeCode, type GrnMatchResult, type ScannedGrnLine, type SupplierSkuBinding } from './grn-scan-match';
import { lineIdentityFields, skuCategoryResolver } from './sku-category';
import { zeroCostAckColumns } from './zero-cost-receipt-guard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped service client every scm route uses (grn-scan-load.ts)
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export const FREE_GIFT_REASON = 'Free gift on the supplier delivery order';

export type GiftLine = { printedCode: string; itemCode: string; name: string; qty: number };
export type CatalogueProduct = { code: string; name: string };

/**
 * The delivery-order rows that are free gifts: left off the draft as not on
 * any PO, printing a code taught to a product of our catalogue. One entry per
 * product, qty summed. Pure.
 */
export function giftLines(
  match: Pick<GrnMatchResult, 'unmatched'>,
  taught: ReadonlyArray<SupplierSkuBinding>,
  products: ReadonlyMap<string, CatalogueProduct>,
): GiftLine[] {
  const itemOf = new Map(taught.map((t) => [normalizeCode(t.supplierSku), t.itemCode]));
  const byItem = new Map<string, GiftLine>();
  for (const u of match.unmatched) {
    if (u.reason !== 'not_on_po' && u.reason !== 'no_open_po_line') continue;
    const itemCode = itemOf.get(normalizeCode(u.line.itemCode)) ?? itemOf.get(normalizeCode(u.line.barcode));
    const product = itemCode ? products.get(itemCode) : undefined;
    if (!itemCode || !product || !(u.line.qty > 0)) continue;
    const prev = byItem.get(itemCode);
    if (prev) prev.qty += u.line.qty;
    else byItem.set(itemCode, { printedCode: (u.line.itemCode ?? u.line.barcode ?? '').trim(), itemCode, name: product.name, qty: u.line.qty });
  }
  return [...byItem.values()];
}

/** The rows giftLines turned into gift lines, so the "not added" note leaves them out. */
export function isGiftRow(line: ScannedGrnLine, gifts: ReadonlyArray<GiftLine>): boolean {
  const codes = new Set(gifts.map((g) => normalizeCode(g.printedCode)));
  return codes.has(normalizeCode(line.itemCode)) || codes.has(normalizeCode(line.barcode));
}

/** ACTIVE products of the company with these codes. */
export async function loadCatalogueProducts(svc: SupabaseClient, companyId: number | null, codes: string[]): Promise<Map<string, CatalogueProduct>> {
  const out = new Map<string, CatalogueProduct>();
  if (codes.length === 0) return out;
  const { data, error } = await scopeToCompanyIdOrOpen(
    svc.from('mfg_products').select('code, name').in('code', codes).eq('status', 'ACTIVE'), companyId);
  if (error) { console.error('[scan-gr gifts] product read failed:', error.message); return out; }
  for (const p of data as Array<{ code: string; name: string | null }>) out.set(p.code, { code: p.code, name: p.name ?? p.code });
  return out;
}

/**
 * Add each gift to a DRAFT GRN as a line with no PO link at RM0, acknowledged
 * as a free gift, unless the GRN already has a no-PO line of that product.
 * Returns the gifts added. Best-effort: a failure is logged, never thrown.
 */
export async function addGiftLines(
  svc: SupabaseClient,
  companyId: number | null,
  grnId: string,
  gifts: ReadonlyArray<GiftLine>,
  ackUserId: string | null,
): Promise<GiftLine[]> {
  if (gifts.length === 0) return [];
  const { data: grn, error: grnErr } = await scopeToCompanyIdOrOpen(svc.from('grns').select('id, status, company_id').eq('id', grnId), companyId).maybeSingle();
  if (grnErr || !grn || String((grn as { status: string }).status).toUpperCase() !== 'DRAFT') {
    if (grnErr) console.error('[scan-gr gifts] grn read failed:', grnErr.message);
    return [];
  }
  const owner = (grn as { company_id: number | null }).company_id ?? companyId;
  const { data: existing, error: exErr } = await scopeToCompanyIdOrOpen(
    svc.from('grn_items').select('item_code').eq('grn_id', grnId).is('purchase_order_item_id', null), companyId);
  if (exErr) { console.error('[scan-gr gifts] line read failed:', exErr.message); return []; }
  const have = new Set((existing as Array<{ item_code: string }>).map((r) => r.item_code));
  const todo = gifts.filter((g) => !have.has(g.itemCode));
  if (todo.length === 0) return [];

  const groupOf = await skuCategoryResolver(svc, todo.map((g) => ({ itemCode: g.itemCode })), owner);
  const added: GiftLine[] = [];
  for (const g of todo) {
    const row = {
      company_id: owner,
      grn_id: grnId,
      purchase_order_item_id: null,
      material_kind: 'mfg_product',
      item_code: g.itemCode,
      material_name: g.name,
      description: g.name,
      qty_received: g.qty,
      qty_accepted: g.qty,
      qty_rejected: 0,
      unit_price_sen: 0,
      discount_sen: 0,
      line_total_sen: 0,
      unit_cost_sen: 0,
      uom: 'UNIT',
      notes: `Free gift, printed ${g.printedCode} on the delivery order`,
      ...lineIdentityFields(groupOf, { itemCode: g.itemCode }, buildVariantSummary),
      ...zeroCostAckColumns({ zeroCostAck: true, zeroCostReason: FREE_GIFT_REASON }, ackUserId),
    };
    const { error } = await svc.from('grn_items').insert(row);
    if (error) { console.error('[scan-gr gifts] insert failed:', grnId, g.itemCode, error.message); continue; }
    added.push(g);
  }
  if (added.length > 0) await recomputeGrnTotals(svc, grnId);
  return added;
}

export function giftNote(added: ReadonlyArray<GiftLine>): string | null {
  return added.length === 0 ? null
    : `Free gifts added at RM0: ${added.map((g) => `${g.itemCode} x${g.qty}`).join('; ')}.`;
}
