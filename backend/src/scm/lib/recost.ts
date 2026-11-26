
import { computeVariantKey } from '../shared';
import { restampDoActualCost } from '../routes/delivery-orders-mfg';
import { toMyrSen } from './fx';
import { timed } from '../../lib/step-timing';

async function recomputeSiTotals(sb: any, salesInvoiceId: string) {
  const { data: items, error: itemsErr } = await sb.from('sales_invoice_items')
    .select('item_group, line_total_sen, line_cost_sen')
    .eq('sales_invoice_id', salesInvoiceId);
  if (itemsErr) {
    /* eslint-disable-next-line no-console */
    console.error('[recost-si] item read failed — header left unchanged:', salesInvoiceId, itemsErr.message);
    return;
  }
  let mattressSofa = 0, bedframe = 0, accessories = 0, others = 0, total = 0, totalCost = 0;
  let mattressSofaCost = 0, bedframeCost = 0, accessoriesCost = 0, othersCost = 0;
  for (const it of (items ?? []) as Array<{ item_group: string | null; line_total_sen: number | null; line_cost_sen: number | null }>) {
    const lineTotal = Number(it.line_total_sen ?? 0);
    const lineCost = Number(it.line_cost_sen ?? 0);
    total += lineTotal;
    totalCost += lineCost;
    const g = (it.item_group ?? '').toLowerCase();
    if (g.includes('mattress') || g.includes('sofa')) { mattressSofa += lineTotal; mattressSofaCost += lineCost; }
    else if (g.includes('bedframe')) { bedframe += lineTotal; bedframeCost += lineCost; }
    else if (g.includes('accessor')) { accessories += lineTotal; accessoriesCost += lineCost; }
    else { others += lineTotal; othersCost += lineCost; }
  }
  const margin = total - totalCost;
  const { error: updErr } = await sb.from('sales_invoices').update({
    mattress_sofa_sen: mattressSofa,
    bedframe_sen: bedframe,
    accessories_sen: accessories,
    others_sen: others,
    mattress_sofa_cost_sen: mattressSofaCost,
    bedframe_cost_sen: bedframeCost,
    accessories_cost_sen: accessoriesCost,
    others_cost_sen: othersCost,
    local_total_sen: total,
    total_cost_sen: totalCost,
    total_margin_sen: margin,
    margin_pct_basis: total > 0 ? Math.round((margin / total) * 10000) : 0,
    line_count: (items ?? []).length,
    subtotal_sen: total,
    total_sen: total,
    updated_at: new Date().toISOString(),
  }).eq('id', salesInvoiceId);
  if (updErr) {
    /* eslint-disable-next-line no-console */
    console.error('[recost-si] header update failed — totals left STALE:', salesInvoiceId, updErr.message);
  }
}

export async function restampSiFromDo(sb: any, deliveryOrderId: string): Promise<void> {
  return timed('restamp-si', () => restampSiFromDoInner(sb, deliveryOrderId));
}
async function restampSiFromDoInner(sb: Parameters<typeof restampSiFromDo>[0], deliveryOrderId: string) {
  try {
    const { data: doItems } = await sb.from('delivery_order_items')
      .select('id, unit_cost_sen')
      .eq('delivery_order_id', deliveryOrderId);
    if (!doItems || doItems.length === 0) return;
    const costByDoItem = new Map<string, number>();
    const doItemIds: string[] = [];
    for (const d of doItems as Array<{ id: string; unit_cost_sen: number | null }>) {
      costByDoItem.set(d.id, Number(d.unit_cost_sen ?? 0));
      doItemIds.push(d.id);
    }
    if (doItemIds.length === 0) return;

    const { data: siLines } = await sb.from('sales_invoice_items')
      .select('id, sales_invoice_id, do_item_id, qty, line_total_sen')
      .in('do_item_id', doItemIds);
    if (!siLines || siLines.length === 0) return;

    const siIds = [...new Set((siLines as Array<{ sales_invoice_id: string }>).map((s) => s.sales_invoice_id).filter(Boolean))];
    const cancelled = new Set<string>();
    if (siIds.length > 0) {
      const { data: heads, error: headsErr } = await sb.from('sales_invoices').select('id, status').in('id', siIds);
      if (headsErr) {
        /* eslint-disable-next-line no-console */
        console.error('[restampSiFromDo] invoice status read failed — SI costs left unchanged:', deliveryOrderId, headsErr.message);
        return;
      }
      for (const h of (heads ?? []) as Array<{ id: string; status: string }>) {
        if ((h.status ?? '').toUpperCase() === 'CANCELLED') cancelled.add(h.id);
      }
    }

    const touched = new Set<string>();
    for (const s of siLines as Array<{ id: string; sales_invoice_id: string; do_item_id: string | null; qty: number; line_total_sen: number | null }>) {
      if (cancelled.has(s.sales_invoice_id)) continue;
      if (!s.do_item_id) continue;
      const unitCost = costByDoItem.get(s.do_item_id);
      if (unitCost === undefined) continue;
      const qty = Number(s.qty ?? 0);
      const lineCost = unitCost * qty;
      const lineTotal = Number(s.line_total_sen ?? 0);
      await sb.from('sales_invoice_items').update({
        unit_cost_sen: unitCost,
        line_cost_sen: lineCost,
        line_margin_sen: lineTotal - lineCost,
      }).eq('id', s.id);
      touched.add(s.sales_invoice_id);
    }
    for (const siId of touched) await recomputeSiTotals(sb, siId);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[restampSiFromDo] failed:', deliveryOrderId, e); }
}

async function poNumberByGrnItem(
  sb: any,
  giList: Array<{ id: string; purchase_order_item_id: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const poItemIds = [...new Set(giList.map((g) => g.purchase_order_item_id).filter((x): x is string => !!x))];
  if (poItemIds.length === 0) return out;
  const { data: poi } = await sb.from('purchase_order_items')
    .select('id, purchase_order_id').in('id', poItemIds);
  const poiRows = (poi ?? []) as Array<{ id: string; purchase_order_id: string | null }>;
  const poIds = [...new Set(poiRows.map((r) => r.purchase_order_id).filter((x): x is string => !!x))];
  if (poIds.length === 0) return out;
  const { data: pos } = await sb.from('purchase_orders').select('id, po_number').in('id', poIds);
  const noByPo = new Map<string, string>();
  for (const p of (pos ?? []) as Array<{ id: string; po_number: string }>) noByPo.set(p.id, p.po_number);
  const noByPoItem = new Map<string, string>();
  for (const r of poiRows) {
    const n = r.purchase_order_id ? noByPo.get(r.purchase_order_id) : undefined;
    if (n) noByPoItem.set(r.id, n);
  }
  for (const g of giList) {
    const n = g.purchase_order_item_id ? noByPoItem.get(g.purchase_order_item_id) : undefined;
    if (n) out.set(g.id, n);
  }
  return out;
}

export async function recostFromGrn(sb: any, grnId: string): Promise<void> {
  return timed('recost', () => recostFromGrnInner(sb, grnId));
}
async function recostFromGrnInner(sb: Parameters<typeof recostFromGrn>[0], grnId: string) {
  try {
    const { data: grnItems } = await sb.from('grn_items')
      .select('id, item_code, item_group, variants, unit_price_sen, qty_accepted, allocated_charge_sen, purchase_order_item_id')
      .eq('grn_id', grnId)
      .order('id', { ascending: true });
    if (!grnItems || grnItems.length === 0) return;
    const giList = grnItems as Array<{
      id: string; item_code: string; item_group: string | null;
      variants: Record<string, unknown> | null; unit_price_sen: number | null;
      qty_accepted: number | null; allocated_charge_sen: number | null;
      purchase_order_item_id: string | null;
    }>;

    const { data: grnHead, error: grnHeadErr } = await sb.from('grns').select('exchange_rate').eq('id', grnId).maybeSingle();
    if (grnHeadErr) {
      /* eslint-disable-next-line no-console */
      console.error('[recostFromGrn] GRN rate read failed — lot costs left unchanged:', grnId, grnHeadErr.message);
      return;
    }
    const grnRate = (grnHead as { exchange_rate?: string | number | null } | null)?.exchange_rate ?? 1;

    const giIds = giList.map((g) => g.id);
    const { data: piRows, error: piRowsErr } = await sb.from('purchase_invoice_items')
      .select('grn_item_id, qty, unit_price_sen, purchase_invoice_id, allocated_charge_sen')
      .in('grn_item_id', giIds);
    if (piRowsErr) {
      /* eslint-disable-next-line no-console */
      console.error('[recostFromGrn] PI lines read failed — lot costs left unchanged:', grnId, piRowsErr.message);
      return;
    }
    const piList = (piRows ?? []) as Array<{ grn_item_id: string | null; qty: number; unit_price_sen: number | null; purchase_invoice_id: string; allocated_charge_sen: number | null }>;
    const piIds = [...new Set(piList.map((r) => r.purchase_invoice_id).filter(Boolean))];
    const piExcluded = new Set<string>();
    const piRateById = new Map<string, string | number | null>();
    if (piIds.length > 0) {
      const { data: pis, error: pisErr } = await sb.from('purchase_invoices').select('id, status, exchange_rate').in('id', piIds);
      if (pisErr) {
        /* eslint-disable-next-line no-console */
        console.error('[recostFromGrn] PI status/rate read failed — lot costs left unchanged:', grnId, pisErr.message);
        return;
      }
      for (const p of (pis ?? []) as Array<{ id: string; status: string; exchange_rate?: string | number | null }>) {
        const st = (p.status ?? '').toUpperCase();
        if (st === 'CANCELLED' || st === 'DRAFT') piExcluded.add(p.id);
        piRateById.set(p.id, p.exchange_rate ?? 1);
      }
    }
    const piAgg = new Map<string, { qty: number; amt: number }>();
    for (const r of piList) {
      if (!r.grn_item_id || piExcluded.has(r.purchase_invoice_id)) continue;
      const a = piAgg.get(r.grn_item_id) ?? { qty: 0, amt: 0 };
      const q = Number(r.qty ?? 0);
      const unitMyr = toMyrSen(Number(r.unit_price_sen ?? 0), piRateById.get(r.purchase_invoice_id) ?? 1);
      a.qty += q;
      a.amt += q * unitMyr;
      piAgg.set(r.grn_item_id, a);
    }

    const piFreightByGrnItem = new Map<string, number>();
    for (const r of piList) {
      if (!r.grn_item_id || piExcluded.has(r.purchase_invoice_id)) continue;
      const alloc = Number(r.allocated_charge_sen ?? 0);
      if (alloc === 0) continue;
      piFreightByGrnItem.set(r.grn_item_id, (piFreightByGrnItem.get(r.grn_item_id) ?? 0) + alloc);
    }

    const batchByGrnItem = await poNumberByGrnItem(sb, giList);
    type Agg = { qty: number; amt: number };
    const byLotKey = new Map<string, Agg>();
    const byCoarse = new Map<string, Agg>();
    const addTo = (m: Map<string, Agg>, key: string, qty: number, landed: number) => {
      const a = m.get(key) ?? { qty: 0, amt: 0 };
      a.qty += qty;
      a.amt += qty * landed;
      m.set(key, a);
    };
    const addTotal = (m: Map<string, Agg>, key: string, qty: number, amt: number) => {
      const a = m.get(key) ?? { qty: 0, amt: 0 };
      a.qty += qty;
      a.amt += amt;
      m.set(key, a);
    };
    for (const g of giList) {
      const vkey = computeVariantKey(g.item_group, g.variants);
      const qty = Math.max(0, Number(g.qty_accepted ?? 0));
      const pi = piAgg.get(g.id);
      const piGoods = pi && pi.qty > 0 ? Math.round(pi.amt / pi.qty) : 0;
      const goods = piGoods > 0
        ? piGoods
        : (Number(g.unit_price_sen ?? 0) > 0 ? toMyrSen(Number(g.unit_price_sen), grnRate) : null);
      if (goods === null) continue;
      const freightTotal = Number(g.allocated_charge_sen ?? 0) + (piFreightByGrnItem.get(g.id) ?? 0);
      const amt = qty * goods + freightTotal;
      addTotal(byLotKey, `${g.item_code}::${vkey}::${batchByGrnItem.get(g.id) ?? ''}`, qty, amt);
      addTotal(byCoarse, `${g.item_code}::${vkey}`, qty, amt);
    }
    const resolve = (a: Agg | undefined): number | null =>
      a && a.qty > 0 ? Math.round(a.amt / a.qty) : null;

    const { data: lots } = await sb.from('inventory_lots')
      .select('id, item_code, variant_key, batch_no, qty_received, movement_id, unit_cost_sen')
      .eq('source_doc_type', 'GRN').eq('source_doc_id', grnId);
    if (!lots || lots.length === 0) return;

    type ConsCand = { id: string; qty_consumed: number | null; movement_id: string | null; newCost: number };
    const consCandidates: ConsCand[] = [];
    for (const lot of lots as Array<{ id: string; item_code: string; variant_key: string | null; batch_no: string | null; qty_received: number | null; movement_id: string | null; unit_cost_sen: number | null }>) {
      const vkey = lot.variant_key ?? '';
      const newCost = resolve(
        byLotKey.get(`${lot.item_code}::${vkey}::${lot.batch_no ?? ''}`)
          ?? byCoarse.get(`${lot.item_code}::${vkey}`),
      );
      if (newCost === null) continue;
      if (Number(lot.unit_cost_sen ?? 0) === newCost) continue;

      await sb.from('inventory_lots').update({ unit_cost_sen: newCost }).eq('id', lot.id);
      if (lot.movement_id) {
        await sb.from('inventory_movements').update({
          unit_cost_sen: newCost,
          total_cost_sen: Number(lot.qty_received ?? 0) * newCost,
        }).eq('id', lot.movement_id);
      }
      const { data: cons } = await sb.from('inventory_lot_consumptions')
        .select('id, qty_consumed, movement_id').eq('lot_id', lot.id);
      for (const ct of (cons ?? []) as Array<{ id: string; qty_consumed: number | null; movement_id: string | null }>) {
        consCandidates.push({ id: ct.id, qty_consumed: ct.qty_consumed, movement_id: ct.movement_id, newCost });
      }
    }

    const candidateMovIds = [...new Set(consCandidates.map((c) => c.movement_id).filter((x): x is string => !!x))];
    const movToDo = new Map<string, string>();
    const cancelledMovIds = new Set<string>();
    if (candidateMovIds.length > 0) {
      const { data: movs } = await sb.from('inventory_movements')
        .select('id, source_doc_type, source_doc_id').in('id', candidateMovIds);
      const doIdSet = new Set<string>();
      for (const m of (movs ?? []) as Array<{ id: string; source_doc_type: string | null; source_doc_id: string | null }>) {
        if ((m.source_doc_type ?? '').toUpperCase() === 'DO' && m.source_doc_id) {
          movToDo.set(m.id, m.source_doc_id);
          doIdSet.add(m.source_doc_id);
        }
      }
      if (doIdSet.size > 0) {
        const { data: dos, error: dosErr } = await sb.from('delivery_orders').select('id, status').in('id', [...doIdSet]);
        if (dosErr) {
          /* eslint-disable-next-line no-console */
          console.error('[recostFromGrn] DO status read failed — consumptions NOT re-stamped (lots already re-costed; next PI touch reconverges):', grnId, dosErr.message);
          return;
        }
        const cancelledDoIds = new Set<string>();
        for (const d of (dos ?? []) as Array<{ id: string; status: string | null }>) {
          if ((d.status ?? '').toUpperCase() === 'CANCELLED') cancelledDoIds.add(d.id);
        }
        for (const [movId, doId] of movToDo) if (cancelledDoIds.has(doId)) cancelledMovIds.add(movId);
      }
    }

    const affectedOutMovements = new Set<string>();
    for (const ct of consCandidates) {
      if (ct.movement_id && cancelledMovIds.has(ct.movement_id)) continue;
      await sb.from('inventory_lot_consumptions').update({
        unit_cost_sen: ct.newCost,
        total_cost_sen: Number(ct.qty_consumed ?? 0) * ct.newCost,
      }).eq('id', ct.id);
      if (ct.movement_id) affectedOutMovements.add(ct.movement_id);
    }

    const affectedDoIds = new Set<string>();
    for (const movId of affectedOutMovements) {
      const { data: mc, error: mcErr } = await sb.from('inventory_lot_consumptions')
        .select('qty_consumed, total_cost_sen').eq('movement_id', movId);
      if (mcErr) {
        /* eslint-disable-next-line no-console */
        console.error('[recostFromGrn] consumption read failed — OUT movement cost left unchanged:', movId, mcErr.message);
        continue;
      }
      const rows = (mc ?? []) as Array<{ qty_consumed: number | null; total_cost_sen: number | null }>;
      const totalCost = rows.reduce((s, r) => s + Number(r.total_cost_sen ?? 0), 0);
      const totalQty = rows.reduce((s, r) => s + Number(r.qty_consumed ?? 0), 0);
      await sb.from('inventory_movements').update({
        total_cost_sen: totalCost,
        unit_cost_sen: totalQty > 0 ? Math.round(totalCost / totalQty) : 0,
      }).eq('id', movId);
      const { data: mv } = await sb.from('inventory_movements')
        .select('source_doc_type, source_doc_id').eq('id', movId).maybeSingle();
      const m = mv as { source_doc_type: string | null; source_doc_id: string | null } | null;
      if (m && (m.source_doc_type ?? '').toUpperCase() === 'DO' && m.source_doc_id) {
        affectedDoIds.add(m.source_doc_id);
      }
    }

    for (const doId of affectedDoIds) {
      await restampDoActualCost(sb, doId);
      await restampSiFromDo(sb, doId);
    }
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[recostFromGrn] failed:', grnId, e); }
}

export async function recostForPi(sb: any, piId: string) {
  try {
    const grnIds = new Set<string>();
    const { data: head } = await sb.from('purchase_invoices').select('grn_id').eq('id', piId).maybeSingle();
    const hGrn = (head as { grn_id: string | null } | null)?.grn_id ?? null;
    if (hGrn) grnIds.add(hGrn);

    const { data: lines } = await sb.from('purchase_invoice_items')
      .select('grn_item_id').eq('purchase_invoice_id', piId);
    const giIds = [...new Set(((lines ?? []) as Array<{ grn_item_id: string | null }>)
      .map((l) => l.grn_item_id).filter((x): x is string => !!x))];
    if (giIds.length > 0) {
      const { data: gi } = await sb.from('grn_items').select('grn_id').in('id', giIds);
      for (const g of (gi ?? []) as Array<{ grn_id: string | null }>) if (g.grn_id) grnIds.add(g.grn_id);
    }

    for (const gid of grnIds) await recostFromGrn(sb, gid);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[recostForPi] failed:', piId, e); }
}
