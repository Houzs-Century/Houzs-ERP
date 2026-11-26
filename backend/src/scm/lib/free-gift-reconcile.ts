
import {
  computeDesiredFreeGifts,
  diffFreeGiftLines,
  buildFreeGiftTriggers,
  type ExistingGiftLine,
  type TriggerLine,
} from '../shared';
import { loadProductsByCodes, loadModelDefaultGifts } from './mfg-pricing-recompute';
import { activeCompanyId, scopeToCompanyId } from './companyScope';
import { recomputeTotals } from '../routes/mfg-sales-orders';
import { recordSoAudit, type FieldChange } from './so-audit';
import { restampHeaderBranding } from './derive-line-branding';
import { loadSoWarehouseMasters, resolveSoWarehouseId } from './so-warehouse';
import { readSoLineFreeze } from './downstream-lock';
import { soLineFrozen } from '../shared/so-line-freeze';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface SoItemRow {
  id: string;
  item_code: string;
  item_group: string | null;
  qty: number | null;
  variants: Record<string, unknown> | null;
  unit_price_sen: number | null;
  line_no: number | null;
}

/**
 * Reconcile a placed SO's accessory free-gift lines against its current
 * triggers. ALWAYS finishes by recomputing the header totals — even on error.
 */
export async function reconcileFreeGiftLinesForSo(sb: any, docNo: string, c: any): Promise<void> {
  try {
    const { data: itemsRaw } = await sb
      .from('mfg_sales_order_items')
      .select('id, item_code, item_group, qty, variants, unit_price_sen, line_no')
      .eq('doc_no', docNo)
      .eq('cancelled', false);
    const items = ((itemsRaw ?? []) as SoItemRow[]);

    const [productByCode, modelGiftsById] = await Promise.all([
      loadProductsByCodes(sb, items.map((it) => it.item_code), activeCompanyId(c)),
      loadModelDefaultGifts(sb),
    ]);

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

    const desired = computeDesiredFreeGifts(triggers);

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

    const { toInsert, toDeleteIds: wanted } = diffFreeGiftLines(desired, existing);
    /* A gift line a live Delivery Order / Sales Invoice already carries is FROZEN
       (owner 2026-09-15, shared/so-line-freeze.ts): the gift went out with the
       goods, so removing its trigger later leaves it where it is. An unreadable
       verdict deletes nothing. */
    let toDeleteIds = wanted;
    if (wanted.length > 0) {
      const freezeRead = await readSoLineFreeze(sb, docNo);
      toDeleteIds = freezeRead.ok ? wanted.filter((id) => !soLineFrozen(freezeRead.freeze, id)) : [];
    }

    if (toDeleteIds.length > 0) {
      await sb.from('mfg_sales_order_items').delete().in('id', toDeleteIds);
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
      const giftCompanyId = header.company_id ?? null;
      const giftWarehouseId = giftCompanyId == null
        ? null
        : resolveSoWarehouseId(header, await loadSoWarehouseMasters(sb, (q) => scopeToCompanyId(q, giftCompanyId)));

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
        if (!acc) continue;
        const cost = Number(acc.cost_price_sen ?? acc.base_price_sen ?? 0) || 0;
        const qty = Math.max(1, Number(g.qty ?? 1));
        rows.push({
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
          unit_price_sen:  0,
          discount_sen:    0,
          total_sen:       0,
          total_inc_sen:   0,
          balance_sen:     0,
          venue:             header.venue ?? null,
          branding:          header.branding ?? null,
          variants:          { freeGift: { giftProductId: g.giftProductId, campaignName: g.campaignName ?? null } },
          unit_cost_sen:   cost,
          line_cost_sen:   qty * cost,
          line_margin_sen: -(qty * cost),
          warehouse_id:      giftWarehouseId,
          cancelled:         false,
        });
        if (nextLineNo !== null) nextLineNo += 1;
      }
      if (rows.length > 0) {
        await sb.from('mfg_sales_order_items').insert(rows);
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
    // eslint-disable-next-line no-console
    console.error('[free-gift-reconcile] failed for', docNo, e);
  }

  await recomputeTotals(sb, docNo, c);
  await restampHeaderBranding(sb, docNo, c);
}
