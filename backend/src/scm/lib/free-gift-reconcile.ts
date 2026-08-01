// Default Free Gift — placed-SO edit reconciler (migration 0170, D9).
//
// When a line is added / removed / edited / swapped on an EXISTING Sales Order,
// the SO's accessory free-gift lines must auto-reconcile to match its CURRENT
// triggers:
//   - remove a trigger (e.g. a mattress) → its free gift auto-deletes;
//   - add a trigger → the gift auto-inserts;
//   - a free-gift line with no real trigger is deleted (honest-pricing);
//   - gift lines stay at unit_price_centi = 0.
//
// Both POS and Backend edits funnel through the same /mfg-sales-orders edit
// endpoints, so reconciling here fixes both surfaces. The trigger set is built
// by the SAME pure function the SO-create validator uses (buildFreeGiftTriggers),
// so an edit can never grant/revoke a gift the create path would have rejected.
//
// DEFENSIVE: a reconcile bug must NEVER break an edit. The whole trigger/diff/
// apply pass is wrapped in try/catch; on any error we log and STILL recompute
// the header totals, leaving the edit itself intact. Idempotent: when nothing
// changed (diffFreeGiftLines returns empty) we write nothing but the normal
// recomputeTotals.

import {
  computeDesiredFreeGifts,
  diffFreeGiftLines,
  buildFreeGiftTriggers,
  type ExistingGiftLine,
  type TriggerLine,
} from '../shared';
import { loadProductsByCodes, loadModelDefaultGifts } from './mfg-pricing-recompute';
// recomputeTotals is the route's authoritative header roll-up. The route<->lib
// reference is a function-level cycle (route imports this file, this file
// imports recomputeTotals) — safe with esbuild because neither is called at
// module-eval time. Same pattern the route already uses with delivery-orders-mfg.
import { recomputeTotals } from '../routes/mfg-sales-orders';
import { recordSoAudit, type FieldChange } from './so-audit';
import { loadSoWarehouseMasters, resolveSoWarehouseId } from './so-warehouse';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SoItemRow {
  id: string;
  item_code: string;
  item_group: string | null;
  qty: number | null;
  variants: Record<string, unknown> | null;
  unit_price_centi: number | null;
  line_no: number | null;
}

/**
 * Reconcile a placed SO's accessory free-gift lines against its current
 * triggers. ALWAYS finishes by recomputing the header totals — even on error.
 */
export async function reconcileFreeGiftLinesForSo(sb: any, docNo: string, c: any): Promise<void> {
  try {
    // 1. Load the SO's non-cancelled lines.
    const { data: itemsRaw } = await sb
      .from('mfg_sales_order_items')
      .select('id, item_code, item_group, qty, variants, unit_price_centi, line_no')
      .eq('doc_no', docNo)
      .eq('cancelled', false);
    const items = ((itemsRaw ?? []) as SoItemRow[]);

    // 2. Resolve each line's product (category / model_id) in ONE in() query,
    //    and load the per-Model default-gift map (keyed by product_models.id).
    //    Both batched — never per-line (CF Workers subrequest cap).
    const [productByCode, modelGiftsById] = await Promise.all([
      loadProductsByCodes(sb, items.map((it) => it.item_code)),
      loadModelDefaultGifts(sb),
    ]);

    // 3. Build TriggerLine[] from the lines. A gift line (variants.freeGift) is
    //    flagged isFreeGift so the builder skips it as a trigger (one-way). The
    //    line id is the stable trigger key. Gifts resolve from the line's Model
    //    (model_id) — IDENTICAL shape to the create path so the two can't drift.
    const triggerLines: TriggerLine[] = items.map((it) => {
      const variants = it.variants ?? null;
      const product = productByCode.get((it.item_code ?? '').trim()) ?? null;
      const modelId = product?.model_id ?? null;
      const cells = (variants?.cells as Array<{ moduleId?: unknown }> | undefined) ?? [];
      const builtCompartments = Array.isArray(cells)
        ? cells.map((cl) => String(cl?.moduleId ?? '')).filter(Boolean)
        : [];
      return {
        triggerKey: it.id,
        itemCode:   product?.code ?? (it.item_code ?? ''),
        category:   String(product?.category ?? ''),
        qty:        Number(it.qty ?? 1),
        modelId,
        buildKey:   (variants?.buildKey as string | undefined) ?? null,
        isFreeGift: Boolean((variants as Record<string, unknown> | null)?.freeGift),
        sizeCode:   product?.size_code ? String(product.size_code).toUpperCase() : null,
        builtCompartments,
        gifts:      modelId ? (modelGiftsById.get(modelId) ?? []) : [],
      };
    });
    const triggers = buildFreeGiftTriggers(triggerLines);

    // 4. The gift lines the SO SHOULD contain.
    const desired = computeDesiredFreeGifts(triggers);

    // 5. The gift lines the SO DOES contain.
    const existing: ExistingGiftLine[] = [];
    for (const it of items) {
      const fg = it.variants?.freeGift;
      if (!fg) continue;
      const fgObj = (fg && typeof fg === 'object') ? (fg as Record<string, unknown>) : null;
      existing.push({
        id:            it.id,
        giftProductId: String(fgObj?.giftProductId ?? ''),
        campaignName:  (typeof fgObj?.campaignName === 'string' && fgObj.campaignName.trim() !== '')
          ? (fgObj.campaignName as string)
          : null,
        qty:           Number(it.qty ?? 1),
      });
    }

    // 6. Diff (bucketed by giftProductId + campaignName; idempotent no-op when
    //    the bucket totals already match).
    const { toInsert, toDeleteIds } = diffFreeGiftLines(desired, existing);

    // 7. Delete gift lines the triggers no longer grant.
    if (toDeleteIds.length > 0) {
      await sb.from('mfg_sales_order_items').delete().in('id', toDeleteIds);
      /* History audit (owner requirement: AUTOMATED line changes must show on
         the SO timeline). One summary row naming the removed gift codes. */
      const removedCodes = items
        .filter((it) => toDeleteIds.includes(it.id))
        .map((it) => it.item_code)
        .filter(Boolean);
      await recordSoAudit(sb, {
        docNo,
        action: 'DELETE_LINE',
        actorId: null,
        actorName: 'System (free gift)',
        source: 'automation',
        note: 'Free-gift line(s) auto-removed — the triggering product left the order',
        fieldChanges: [
          { field: 'itemCode', from: removedCodes.join(', ') || `${toDeleteIds.length} gift line(s)` },
        ] satisfies FieldChange[],
      });
    }

    // 8. Insert the missing gift lines. giftProductId is an mfg_products.id; load
    //    the accessory rows by id in ONE in() query for code / name / cost.
    if (toInsert.length > 0) {
      const giftIds = Array.from(new Set(toInsert.map((g) => g.giftProductId).filter(Boolean)));
      const { data: accRaw } = giftIds.length > 0
        ? await sb
            .from('mfg_products')
            .select('id, code, name, cost_price_sen, base_price_sen')
            .in('id', giftIds)
        : { data: [] as any[] };
      const accById = new Map(
        ((accRaw ?? []) as Array<{
          id: string; code: string; name: string;
          cost_price_sen: number | null; base_price_sen: number | null;
        }>).map((a) => [a.id, a]),
      );

      // Header snapshot fields, mirroring the add-line insert (debtor/agent/
      // venue/branding ride along from the SO header).
      const { data: hdr } = await sb
        .from('mfg_sales_orders')
        .select('debtor_code, debtor_name, agent, venue, branding, company_id, sales_location, customer_state')
        .eq('doc_no', docNo)
        .maybeSingle();
      const header = (hdr ?? {}) as {
        debtor_code?: string | null; debtor_name?: string | null;
        agent?: string | null; venue?: string | null; branding?: string | null;
        company_id?: number | null;
        sales_location?: string | null; customer_state?: string | null;
      };
      /* The warehouse follows the SO (owner 2026-07-31). This insert used to
         omit warehouse_id, so an auto free-gift line landed NULL and split its
         order into a second MRP row under the WH_NONE bucket. Resolved from the
         SO's OWN header — never from a sibling line — via lib/so-warehouse.ts.
         Fail-soft: an unresolvable header yields null, i.e. exactly the previous
         behaviour, so a gift line is never blocked by a missing mapping. */
      const giftWarehouseId = resolveSoWarehouseId(header, await loadSoWarehouseMasters(sb));

      // Continue the doc's line numbering (max + 1, incrementing) when the doc
      // is already numbered; pre-0165 docs (max NULL) keep gift lines un-numbered.
      const maxLineNo = items.reduce<number | null>((mx, it) => {
        const n = it.line_no;
        if (typeof n === 'number') return mx === null ? n : Math.max(mx, n);
        return mx;
      }, null);
      let nextLineNo = maxLineNo === null ? null : maxLineNo + 1;

      const rows: Record<string, unknown>[] = [];
      for (const g of toInsert) {
        if (!g.giftProductId) continue;
        const acc = accById.get(g.giftProductId);
        if (!acc) continue;                                    // gift product gone → skip (honest: no phantom line)
        const cost = Number(acc.cost_price_sen ?? acc.base_price_sen ?? 0) || 0;
        const qty = Math.max(1, Number(g.qty ?? 1));
        rows.push({
          // Multi-company (mig 0061): the free-gift line inherits the SO's company.
          ...(header.company_id != null ? { company_id: header.company_id } : {}),
          doc_no:            docNo,
          ...(nextLineNo !== null ? { line_no: nextLineNo } : {}),
          debtor_code:       header.debtor_code ?? null,
          debtor_name:       header.debtor_name ?? null,
          agent:             header.agent ?? null,
          item_group:        'accessory',
          item_code:         acc.code,
          description:       acc.name ?? null,
          uom:               'UNIT',
          qty,
          unit_price_centi:  0,
          discount_centi:    0,
          total_centi:       0,
          total_inc_centi:   0,
          balance_centi:     0,
          venue:             header.venue ?? null,
          branding:          header.branding ?? null,
          variants:          { freeGift: { giftProductId: g.giftProductId, campaignName: g.campaignName ?? null } },
          unit_cost_centi:   cost,
          line_cost_centi:   qty * cost,
          line_margin_centi: -(qty * cost),                    // free line: revenue 0 − cost
          warehouse_id:      giftWarehouseId,                  // follows the SO — see above
          cancelled:         false,
        });
        if (nextLineNo !== null) nextLineNo += 1;
      }
      if (rows.length > 0) {
        await sb.from('mfg_sales_order_items').insert(rows);
        /* History audit — one summary row naming the auto-added gift codes. */
        await recordSoAudit(sb, {
          docNo,
          action: 'ADD_LINE',
          actorId: null,
          actorName: 'System (free gift)',
          source: 'automation',
          note: 'Free-gift line(s) auto-added by the campaign trigger',
          fieldChanges: [
            { field: 'itemCode', to: rows.map((r) => String(r.item_code ?? '')).filter(Boolean).join(', ') },
            { field: 'qty', to: rows.reduce((s, r) => s + Number(r.qty ?? 0), 0) },
          ] satisfies FieldChange[],
        });
      }
    }
  } catch (e) {
    if (sb?.__atomicCommand === true) throw e;
    // Legacy non-transactional callers keep best-effort behaviour. Atomic
    // commands rethrow above so the enclosing command rolls back.
    // eslint-disable-next-line no-console
    console.error('[free-gift-reconcile] failed for', docNo, e);
  }

  // 9 + 10. ALWAYS recompute the header totals (the route's authoritative
  // roll-up) — even if the reconcile pass above threw. This REPLACES the final
  // recomputeTotals each edit endpoint used to call directly.
  await recomputeTotals(sb, docNo, c);
}
