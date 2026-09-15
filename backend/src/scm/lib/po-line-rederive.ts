/* ----------------------------------------------------------------------------
   po-line-rederive — what a purchase-order line bound to a sales-order line
   becomes once that sales-order line has been revised.

   The one derivation `reviseBoundPo` (so-revision.ts, step 12a) applies to every
   surviving bound line when a sales-order amendment's follow-up is confirmed. It
   lives on its own so a repair that has to put a line back where an approved
   amendment should have left it (backend/scripts/realign-po-line-to-so-line.mjs)
   runs THIS code, not a second copy of it.

   Returns the column patch; the caller writes it. Reads only.
   -------------------------------------------------------------------------- */

import { buildVariantSummary } from '../shared';
import { deriveMfgPoUnitCost } from './po-pricing';
import { supplierSkuFor } from './po-line-supplier-sku';

type Sb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export type RevisedSoLine = {
  item_code: string | null; item_group: string | null; qty: number | null;
  variants: Record<string, unknown> | null; warehouse_id: string | null;
  line_delivery_date: string | null; description: string | null;
  // Owner 2026-08-10 (migration 0274) — an SO line's photos follow it onto the
  // PO line, the same on this amendment path as on the convert paths.
  photo_urls: string[] | null;
};

export type PoLineRederive = {
  patch: Record<string, unknown>;
  /** The code the line carried before, so a caller can tell a SKU move. */
  priorCode: string;
  warnings: string[];
};

export async function rederivePoLineFromSoLine(
  sb: Sb,
  args: {
    poLineId: string;
    /** The line's stored qty — kept when the revised SO line carries none. */
    currentQty: number | null;
    po: { po_number: string; supplier_id: string | null; company_id: number | null };
    /** The SO's company, used only when the PO carries none. */
    soCompanyId: number | null;
    revised: RevisedSoLine;
  },
): Promise<PoLineRederive> {
  const { po, revised } = args;
  const warnings: string[] = [];
  // Read the existing PO line's discount + item_code (the SKU the
  // supplier binding is keyed on).
  const { data: existing, error: exErr } = await sb
    .from('purchase_order_items')
    .select('item_code, material_name, discount_sen, photo_urls, supplier_sku')
    .eq('id', args.poLineId)
    .maybeSingle();
  if (exErr) throw new Error(`reviseBoundPo: PO line load failed: ${exErr.message}`);
  const discountSen = Number((existing as { discount_sen?: number } | null)?.discount_sen ?? 0);
  const qty = revised.qty != null ? Math.max(1, revised.qty) : Number(args.currentQty ?? 1);
  const itemGroup = revised.item_group;
  const variants = revised.variants;
  // Re-derive the revised PO line's supplier cost from the NOW-REVISED SO
  // line's spec (SAME cost-anchor "Create PO from SO" runs). The SKU the cost
  // is keyed on = the revised SO line's item_code (a SPEC change may swap it),
  // falling back to the PO line's existing item_code.
  const itemCode = (revised.item_code || '').trim()
    || String((existing as { item_code?: string } | null)?.item_code ?? '');
  // Persist the revised SKU + name onto the PO line, not just use them for
  // costing (docs/bugs). Before this, reviseBoundPo re-derived cost/variants
  // but left item_code untouched, so an SO SPEC swap (e.g. an LHF->RHF sofa
  // swap that swaps the code) left the PO ordering -- and PRINTING (the PDF
  // derives the sofa orientation from item_code) -- the OLD SKU, and its
  // so_drift never cleared. material_name follows the SO description like the
  // convert / ADD paths, never downgrading to the bare code when the revised
  // SO line has no description.
  const itemName =
    (revised.description || '').trim()
    || String((existing as { material_name?: string } | null)?.material_name ?? '').trim()
    || itemCode;
  const unitPriceSen = await deriveMfgPoUnitCost(sb, {
    supplierId: po.supplier_id ?? '',
    itemCode:   itemCode,
    itemGroup,
    variants:   variants ?? null,
  });

  /* Re-carry the SO line's CURRENT photos, preserving the PO's OWN uploads
     (`po-items/...`). The INSERT already carries an ADDED line's photos
     (mig 0274); a SURVIVING line re-derived here used to keep its STALE
     snapshot, so a code-swap that REPLACED the SO line left the PO showing a
     dead `so-items/<old>/...` key whose R2 object is gone (docs/bugs/0789). */
  const poOwnedPhotos = ((existing as { photo_urls?: string[] | null } | null)?.photo_urls ?? [])
    .filter((k) => String(k).startsWith('po-items/'));
  const rederivedPhotos: string[] = [];
  for (const k of [...poOwnedPhotos, ...(revised.photo_urls ?? [])]) {
    if (!rederivedPhotos.includes(k)) rederivedPhotos.push(k);
  }

  /* The SUPPLIER CODE and the line DESCRIPTION follow a changed item code.
     The supplier code is derived exactly as the convert path derives it
     (lib/po-line-supplier-sku.ts); docs/bugs/0887: HC-PO-2609-064 kept
     `5536-L(LHF)` under `9058-1A(LHF)`. The description is what the detail page
     shows under the code when the variant summary is empty and what the
     AutoCount edit sends as Description; HC-PO-010086 went on reading
     "SQUARE PILLOW (CUSTOM)" under a random sofa pillow. Both are left alone when
     the code did not move, so text keyed on the PO by hand survives an
     unrelated amendment. */
  const priorCode = String((existing as { item_code?: string } | null)?.item_code ?? '').trim();
  const codeMovedPatch: { supplier_sku?: string | null; description?: string } = {};
  if (itemCode !== priorCode) {
    codeMovedPatch.description = (revised.description || '').trim() || itemCode;
    codeMovedPatch.supplier_sku = await supplierSkuFor(sb, {
      supplierId: po.supplier_id, itemCode, companyId: po.company_id ?? args.soCompanyId,
    });
    if (codeMovedPatch.supplier_sku == null) {
      warnings.push(`${itemName} on purchase order ${po.po_number} changed to an item this supplier has no code for, so its supplier code was cleared. Set the supplier's code for it before sending the purchase order.`);
    }
  }

  return {
    priorCode,
    warnings,
    patch: {
      qty,
      item_code:        itemCode,
      material_name:    itemName,
      ...codeMovedPatch,
      unit_price_sen: unitPriceSen,
      line_total_sen: qty * unitPriceSen - discountSen,
      item_group:       itemGroup,
      variants,
      description2:     buildVariantSummary(String(itemGroup ?? ''), variants ?? null) || null,
      warehouse_id:     revised.warehouse_id,
      delivery_date:    revised.line_delivery_date,
      photo_urls:       rederivedPhotos,
    },
  };
}
