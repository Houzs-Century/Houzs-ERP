/* GET /api/scm/procurement-overview?from=YYYY-MM-DD&to=YYYY-MM-DD&basis=original|promised
   The Procurement Overview page (owner, 2026-10-16/17) — replaces the PO
   CHASING LIST sheet. Everything follows the selected period: PO raised, due,
   received and billed in it; what was still open and how late at its last day;
   supplier lead time over the receipts in it; and how far ahead we order
   against the customer's date. Arithmetic in lib/procurement-period.ts.

   Reads every PO line of POs dated in the year before the period ends (a line
   older than that and still open is rare and would be chased elsewhere), with
   its receipts, its sales order's customer date, and its product category.

   Company scope: every read is scoped to the active company. */
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { doCountsAsDelivered } from '../shared/do-shipped-states';
import { procurementCategory, promisedDate, PROCUREMENT_CATEGORIES, type ProcurementCategory } from '../lib/procurement-overview';
import { procurementPeriod, deadStock, turnoverAndSellers, type PLine } from '../lib/procurement-period';
import { attributeStockPos, type StockReceipt, type StockOut } from '../lib/stock-po-attribution';

export const procurementOverview = new Hono<{ Bindings: Env; Variables: Variables }>();
procurementOverview.use('*', supabaseAuth);

type Row = Record<string, unknown>;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => Number(v ?? 0) || 0;
const day = (v: unknown) => (v == null ? null : String(v).slice(0, 10));

procurementOverview.get('/', async (c) => {
  const sb = c.get('supabase');
  const today = todayMyt();
  const qFrom = c.req.query('from') ?? ''; const qTo = c.req.query('to') ?? '';
  const from = ISO.test(qFrom) ? qFrom : `${today.slice(0, 7)}-01`;
  const to = ISO.test(qTo) && qTo >= from ? qTo : today;
  const basis = c.req.query('basis') === 'promised' ? 'promised' : 'original';
  const windowStart = new Date(Date.parse(`${to}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
  const fail = (what: string, e: { message: string }) => c.json({ error: 'load_failed', reason: `${what}: ${e.message}` }, 500);

  /* ── PO headers and lines ─────────────────────────────────────────────── */
  const pos = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('purchase_orders')
    .select('id, po_number, po_date, supplier_id, expected_at').gte('po_date', windowStart).lte('po_date', to)
    .not('status', 'in', '("DRAFT","CANCELLED")'), c).order('id').range(f, t));
  if (pos.error) return fail('purchase orders', pos.error);
  const poById = new Map((pos.data ?? []).map((r) => [String(r.id), r]));
  const items = await chunkIn<Row>([...poById.keys()], (b, f, t) => scopeToCompany(sb.from('purchase_order_items')
    .select('id, purchase_order_id, item_code, item_group, description, qty, received_qty, unit_price_sen, line_total_sen, delivery_date, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, so_item_id')
    .in('purchase_order_id', b), c).order('id').range(f, t));
  if (items.error) return fail('PO lines', items.error);

  /* ── Receipts of those lines ──────────────────────────────────────────── */
  const grnItems = await chunkIn<Row>(items.data.map((r) => String(r.id)), (b, f, t) => scopeToCompany(sb.from('grn_items')
    .select('grn_id, purchase_order_item_id, qty_received, qty_rejected').in('purchase_order_item_id', b), c).order('id').range(f, t));
  if (grnItems.error) return fail('goods received lines', grnItems.error);
  const grns = await chunkIn<Row>([...new Set(grnItems.data.map((r) => String(r.grn_id)))], (b, f, t) => scopeToCompany(sb.from('grns')
    .select('id, received_at, status').in('id', b), c).order('id').range(f, t));
  if (grns.error) return fail('goods received', grns.error);
  const grnDate = new Map(grns.data.filter((g) => g.received_at && !['DRAFT', 'CANCELLED'].includes(String(g.status))).map((g) => [String(g.id), day(g.received_at) as string]));
  const receiptsByLine = new Map<string, PLine['receipts']>();
  for (const g of grnItems.data) {
    const d = grnDate.get(String(g.grn_id));
    if (!d) continue;
    const k = String(g.purchase_order_item_id);
    receiptsByLine.set(k, [...(receiptsByLine.get(k) ?? []), { date: d, qty: num(g.qty_received), rejected: num(g.qty_rejected) }]);
  }

  /* ── The customer's date, through the linked sales order line ─────────── */
  const soItems = await chunkIn<Row>([...new Set(items.data.map((r) => str(r.so_item_id)).filter((x): x is string => !!x))], (b, f, t) =>
    scopeToCompany(sb.from('mfg_sales_order_items').select('id, doc_no').in('id', b), c).order('id').range(f, t));
  if (soItems.error) return fail('sales order lines', soItems.error);
  const soDocOfItem = new Map(soItems.data.map((r) => [String(r.id), String(r.doc_no)]));
  const sos = await chunkIn<Row>([...new Set(soDocOfItem.values())], (b, f, t) => scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no, customer_delivery_date, amended_delivery_date').in('doc_no', b), c).order('doc_no').range(f, t));
  if (sos.error) return fail('sales orders', sos.error);
  const needOfSo = new Map(sos.data.map((r) => [String(r.doc_no), day(r.amended_delivery_date) ?? day(r.customer_delivery_date)]));

  /* ── Names, categories, lead-time settings ────────────────────────────── */
  const sups = await chunkIn<Row>([...new Set((pos.data ?? []).map((r) => str(r.supplier_id)).filter((x): x is string => !!x))], (b, f, t) =>
    scopeToCompany(sb.from('suppliers').select('id, name').in('id', b), c).order('id').range(f, t));
  if (sups.error) return fail('suppliers', sups.error);
  const supName = new Map(sups.data.map((r) => [String(r.id), String(r.name ?? '—')]));
  const prods = await chunkIn<Row>([...new Set(items.data.map((r) => str(r.item_code)).filter((x): x is string => !!x))], (b, f, t) =>
    scopeToCompany(sb.from('mfg_products').select('code, category').in('code', b), c).order('code').range(f, t));
  if (prods.error) return fail('products', prods.error);
  const prodCat = new Map(prods.data.map((r) => [String(r.code), str(r.category)]));
  /* The company-wide MRP setting per category (warehouse overrides aside) —
     the value "Apply" on the page writes back. */
  const settings = await scopeToCompany(sb.from('mrp_category_lead_times').select('category, lead_days, warehouse_id'), c);
  if (settings.error) return fail('lead time settings', settings.error);
  const currentLead: Record<string, number> = {};
  const leadOverrides: Record<string, Array<{ warehouseId: string; days: number }>> = {};
  for (const s of settings.data as Row[]) {
    const k = procurementCategory(str(s.category), null);
    if (s.warehouse_id == null) currentLead[k] = num(s.lead_days);
    else (leadOverrides[k] ??= []).push({ warehouseId: String(s.warehouse_id), days: num(s.lead_days) });
  }

  /* ── Supplier bills in the period ─────────────────────────────────────── */
  const pis = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('purchase_invoices')
    .select('id, supplier_id, total_sen').gte('invoice_date', from).lte('invoice_date', to)
    .not('status', 'in', '("DRAFT","CANCELLED")'), c).order('id').range(f, t));
  if (pis.error) return fail('supplier bills', pis.error);
  const piLines = await chunkIn<Row>((pis.data ?? []).map((r) => String(r.id)), (b, f, t) => scopeToCompany(sb.from('purchase_invoice_items')
    .select('purchase_invoice_id, item_code, item_group, line_total_sen').in('purchase_invoice_id', b), c).order('id').range(f, t));
  if (piLines.error) return fail('supplier bill lines', piLines.error);
  const piSupIds = [...new Set((pis.data ?? []).map((r) => str(r.supplier_id)).filter((x): x is string => !!x && !supName.has(x)))];
  if (piSupIds.length) {
    const more = await chunkIn<Row>(piSupIds, (b, f, t) => scopeToCompany(sb.from('suppliers').select('id, name').in('id', b), c).order('id').range(f, t));
    if (more.error) return fail('suppliers', more.error);
    for (const r of more.data) supName.set(String(r.id), String(r.name ?? '—'));
  }
  const billedBySupplier: Record<string, number> = {};
  for (const r of pis.data ?? []) { const k = supName.get(String(r.supplier_id ?? '')) ?? '—'; billedBySupplier[k] = (billedBySupplier[k] ?? 0) + num(r.total_sen); }
  const piCodes = [...new Set(piLines.data.map((r) => str(r.item_code)).filter((x): x is string => !!x && !prodCat.has(x)))];
  if (piCodes.length) {
    const more = await chunkIn<Row>(piCodes, (b, f, t) => scopeToCompany(sb.from('mfg_products').select('code, category').in('code', b), c).order('code').range(f, t));
    if (more.error) return fail('products', more.error);
    for (const r of more.data) prodCat.set(String(r.code), str(r.category));
  }
  const catOf = (r: Row): ProcurementCategory => procurementCategory(prodCat.get(String(r.item_code ?? '')) ?? null, str(r.item_group));
  const billedByCategory: Record<string, number> = {};
  for (const l of piLines.data) { const k = catOf(l); billedByCategory[k] = (billedByCategory[k] ?? 0) + num(l.line_total_sen); }

  /* ── Assemble ─────────────────────────────────────────────────────────── */
  /* A line can record more received than its GRNs carry (marked received on
     import, 109 of 2,715 lines in the year to 2026-10-17): the difference is
     received, on the line's due date, and kept out of lead time. */
  const withInferred = (rs: PLine['receipts'], receivedQty: number, due: string): PLine['receipts'] => {
    const gap = receivedQty - rs.reduce((a, x) => a + x.qty, 0);
    return gap > 0 ? [...rs, { date: due, qty: gap, rejected: 0, inferred: true }] : rs;
  };
  const lines: PLine[] = items.data.flatMap((r) => {
    const po = poById.get(String(r.purchase_order_id));
    if (!po?.po_date) return [];
    const original = day(r.delivery_date) ?? day(po.expected_at);
    const revised = [day(r.supplier_delivery_date_2), day(r.supplier_delivery_date_3), day(r.supplier_delivery_date_4)].filter((x): x is string => !!x);
    const soDoc = r.so_item_id ? soDocOfItem.get(String(r.so_item_id)) ?? null : null;
    return [{
      poId: String(po.id), poNumber: String(po.po_number ?? ''), poDate: day(po.po_date) as string,
      supplier: supName.get(String(po.supplier_id ?? '')) ?? '—', category: catOf(r),
      itemCode: str(r.item_code), itemDesc: str(r.description), soDocNo: soDoc,
      /* Net of line discount: the line total spread over its quantity, so PO
         raised adds up to the PO totals. */
      qty: num(r.qty), priceSen: num(r.qty) > 0 && r.line_total_sen != null ? num(r.line_total_sen) / num(r.qty) : num(r.unit_price_sen),
      originalDue: original, promised: promisedDate([original, ...revised]),
      needDate: soDoc ? needOfSo.get(soDoc) ?? null : null,
      receipts: withInferred(receiptsByLine.get(String(r.id)) ?? [], num(r.received_qty), original ?? (day(po.po_date) as string)),
    }];
  });

  /* ── Dead stock: on hand now, by how long since it last went out ──────── */
  const stock = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('v_inventory_value')
    .select('warehouse_id, warehouse_code, item_code, variant_key, product_name, qty_on_hand, value_sen').gt('qty_on_hand', 0), c)
    .order('warehouse_id').order('item_code').order('variant_key').range(f, t));
  if (stock.error) return fail('stock on hand', stock.error);
  const moves = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('inventory_movements')
    .select('warehouse_id, item_code, variant_key, movement_type, movement_date, created_at, total_cost_sen'), c).order('id').range(f, t));
  if (moves.error) return fail('stock movements', moves.error);
  const keyOf = (r: Row) => `${String(r.warehouse_id)}|${String(r.item_code)}|${String(r.variant_key ?? '')}`;
  const lastOut = new Map<string, string>(); const firstMove = new Map<string, string>();
  for (const m of moves.data ?? []) {
    const k = keyOf(m); const d = day(m.movement_date) ?? day(m.created_at);
    if (!d) continue;
    if (!firstMove.has(k) || d < (firstMove.get(k) as string)) firstMove.set(k, d);
    if (m.movement_type === 'OUT' && (!lastOut.has(k) || d > (lastOut.get(k) as string))) lastOut.set(k, d);
  }
  const stockCodes = [...new Set((stock.data ?? []).map((r) => String(r.item_code)).filter((x) => !prodCat.has(x)))];
  if (stockCodes.length) {
    const more = await chunkIn<Row>(stockCodes, (b, f, t) => scopeToCompany(sb.from('mfg_products').select('code, category').in('code', b), c).order('code').range(f, t));
    if (more.error) return fail('products', more.error);
    for (const r of more.data) prodCat.set(String(r.code), str(r.category));
  }
  /* Display / showroom stock is on the floor to be seen, not waiting to be
     sold off, so it is not dead stock (owner 2026-10-17). */
  const isShowroom = (r: Row) => /SHOWROOM|DISPLAY/i.test(String(r.warehouse_code ?? ''));
  /* What open sales orders still wait for, per item: an open line's quantity
     less what has gone out on a shipped DO — the same claim the inventory
     page's Spare subtracts. */
  const SO_DONE = new Set(['DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED', 'DRAFT']);
  const demandLines = await chunkIn<Row>([...new Set((stock.data ?? []).map((r) => String(r.item_code)))], (b, f, t) => scopeToCompany(sb
    .from('mfg_sales_order_items').select('id, item_code, qty, so:mfg_sales_orders!inner(status)').in('item_code', b).eq('cancelled', false), c).order('id').range(f, t));
  if (demandLines.error) return fail('open order lines', demandLines.error);
  const openLines = demandLines.data.filter((r) => { const so = (Array.isArray(r.so) ? r.so[0] : r.so) as Row | null; return !!so && !SO_DONE.has(String(so.status)); });
  const shippedLines = await chunkIn<Row>(openLines.map((r) => String(r.id)), (b, f, t) => scopeToCompany(sb
    .from('delivery_order_items').select('so_item_id, qty, do:delivery_orders!inner(status)').in('so_item_id', b), c).order('id').range(f, t));
  if (shippedLines.error) return fail('shipped order lines', shippedLines.error);
  const shipped = new Map<string, number>();
  for (const l of shippedLines.data) {
    const d = (Array.isArray(l.do) ? l.do[0] : l.do) as Row | null;
    if (d && doCountsAsDelivered(str(d.status))) shipped.set(String(l.so_item_id), (shipped.get(String(l.so_item_id)) ?? 0) + num(l.qty));
  }
  const openDemand = new Map<string, number>();
  for (const r of openLines) openDemand.set(String(r.item_code), (openDemand.get(String(r.item_code)) ?? 0) + Math.max(0, num(r.qty) - (shipped.get(String(r.id)) ?? 0)));
  const dead = deadStock((stock.data ?? []).filter((r) => !isShowroom(r)).map((r) => ({
    warehouse: String(r.warehouse_code ?? '—'), category: catOf(r), itemCode: String(r.item_code), name: str(r.product_name),
    qty: num(r.qty_on_hand), valueSen: num(r.value_sen), lastOut: lastOut.get(keyOf(r)) ?? null, firstMove: firstMove.get(keyOf(r)) ?? null,
  })), today, openDemand);

  /* ── Turnover and sellers in the period ───────────────────────────────── */
  const whs = await scopeToCompany(sb.from('warehouses').select('id, code'), c);
  if (whs.error) return fail('warehouses', whs.error);
  const whCode = new Map((whs.data as Row[]).map((w) => [String(w.id), String(w.code ?? '—')]));
  /* Turnover reads a fixed trailing year (owner 2026-10-17: it should not move
     with the period picked); stock movements only begin 2026-09, so until a
     year has passed the window starts at the first OUT. */
  let firstOut: string | null = null;
  for (const m of moves.data ?? []) {
    if (m.movement_type !== 'OUT') continue;
    const d = day(m.movement_date) ?? day(m.created_at);
    if (d && (!firstOut || d < firstOut)) firstOut = d;
  }
  const yearAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 364 * 86400000).toISOString().slice(0, 10);
  const turnFrom = firstOut && firstOut > yearAgo ? firstOut : yearAgo;
  const outs = (moves.data ?? []).flatMap((m) => {
    if (m.movement_type !== 'OUT') return [];
    const d = day(m.movement_date) ?? day(m.created_at);
    if (!d || d < turnFrom || d > today) return [];
    return [{ warehouse: whCode.get(String(m.warehouse_id)) ?? '—', category: catOf(m), costSen: num(m.total_cost_sen), zeroCost: !num(m.total_cost_sen) }];
  });
  const periodSos = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no').gte('so_date', from).lte('so_date', to).not('status', 'in', '("DRAFT","CANCELLED")'), c).order('doc_no').range(f, t));
  if (periodSos.error) return fail('sales orders in the period', periodSos.error);
  const soLines = await chunkIn<Row>((periodSos.data ?? []).map((r) => String(r.doc_no)), (b, f, t) => scopeToCompany(sb.from('mfg_sales_order_items')
    .select('item_code, item_group, description, qty, total_sen, cancelled').in('doc_no', b), c).order('id').range(f, t));
  /* Sellers leave out service lines (delivery, disposal, lift — not stock), and
     count a sofa by its model: KABBIN-L(RHF) and KABBIN-2A(LHF) are KABBIN. */
  const isService = (r: Row) => String(r.item_group ?? '').toLowerCase() === 'service' || String(r.item_code ?? '').toUpperCase().startsWith('SVC-')
    || prodCat.get(String(r.item_code ?? '')) === 'SERVICE';
  const modelOf = (code: string, category: string) => (category === 'SOFA' ? code.split('-')[0] || code : code);
  if (soLines.error) return fail('sales order lines', soLines.error);
  const soldCodes = [...new Set(soLines.data.map((r) => str(r.item_code)).filter((x): x is string => !!x && !prodCat.has(x)))];
  if (soldCodes.length) {
    const more = await chunkIn<Row>(soldCodes, (b, f, t) => scopeToCompany(sb.from('mfg_products').select('code, category').in('code', b), c).order('code').range(f, t));
    if (more.error) return fail('products', more.error);
    for (const r of more.data) prodCat.set(String(r.code), str(r.category));
  }
  const turnDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${turnFrom}T00:00:00Z`)) / 86400000) + 1;
  const periodDays = Math.round((Date.parse(`${to < today ? to : today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  const turnover = {
    firstOut, turnFrom, turnTo: today,
    ...turnoverAndSellers(
      (stock.data ?? []).filter((r) => !isService(r)).map((r) => {
        const cat = catOf(r); const model = modelOf(String(r.item_code), cat);
        return { warehouse: String(r.warehouse_code ?? '—'), category: cat, itemCode: model, name: model === String(r.item_code) ? str(r.product_name) : `${model} (all variants)`, qty: num(r.qty_on_hand), valueSen: num(r.value_sen), lastOut: null, firstMove: null };
      }),
      outs,
      soLines.data.filter((r) => !r.cancelled && r.item_code && !isService(r)).map((r) => {
        const cat = catOf(r); const model = modelOf(String(r.item_code), cat);
        return { itemCode: model, name: model === String(r.item_code) ? str(r.description) : `${model} (all variants)`, category: cat, qty: num(r.qty), salesSen: num(r.total_sen) };
      }),
      Math.max(1, turnDays),
      Math.max(1, periodDays),
    ),
  };

  return c.json({
    today, from, to,
    deadStock: dead,
    turnover,
    categories: PROCUREMENT_CATEGORIES,
    currentLead,
    leadOverrides: Object.fromEntries(Object.entries(leadOverrides).map(([k, xs]) => [k, xs.map((x) => ({ warehouse: whCode.get(x.warehouseId) ?? '—', days: x.days }))])),
    billed: { totalSen: (pis.data ?? []).reduce((a, r) => a + num(r.total_sen), 0), count: (pis.data ?? []).length, bySupplier: billedBySupplier, byCategory: billedByCategory },
    ...procurementPeriod(lines, from, to, today, basis),
  });
});

/* GET /api/scm/procurement-overview/stock-ordering — how far ahead stock POs
   (raised with no customer behind them) were ordered, matched first in first
   out to the delivered orders that later took their goods
   (lib/stock-po-attribution.ts). Back end only (owner 2026-10-17): no page
   shows it. The past year of receipts and deliveries, active company. */
procurementOverview.get('/stock-ordering', async (c) => {
  const sb = c.get('supabase');
  const today = todayMyt();
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
  const fail = (what: string, e: { message: string }) => c.json({ error: 'load_failed', reason: `${what}: ${e.message}` }, 500);

  const grns = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('grns')
    .select('id, received_at, warehouse_id').gte('received_at', since), c).order('id').range(f, t));
  if (grns.error) return fail('goods received', grns.error);
  const grnById = new Map((grns.data ?? []).map((g) => [String(g.id), g]));
  const grnItems = await chunkIn<Row>([...grnById.keys()], (b, f, t) => scopeToCompany(sb.from('grn_items')
    .select('grn_id, purchase_order_item_id, item_code, qty_received').in('grn_id', b), c).order('id').range(f, t));
  if (grnItems.error) return fail('goods received lines', grnItems.error);
  const poItems = await chunkIn<Row>([...new Set(grnItems.data.map((g) => str(g.purchase_order_item_id)).filter((x): x is string => !!x))], (b, f, t) =>
    scopeToCompany(sb.from('purchase_order_items').select('id, purchase_order_id, so_item_id, item_group').in('id', b), c).order('id').range(f, t));
  if (poItems.error) return fail('PO lines', poItems.error);
  const poItemById = new Map(poItems.data.map((p) => [String(p.id), p]));
  const pos = await chunkIn<Row>([...new Set(poItems.data.map((p) => String(p.purchase_order_id)))], (b, f, t) =>
    scopeToCompany(sb.from('purchase_orders').select('id, po_date').in('id', b), c).order('id').range(f, t));
  if (pos.error) return fail('purchase orders', pos.error);
  const poDate = new Map(pos.data.map((p) => [String(p.id), day(p.po_date)]));

  const dos = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('delivery_orders')
    .select('id, do_date, warehouse_id').gte('do_date', since).in('status', ['LOADED', 'DELIVERED']), c).order('id').range(f, t));
  if (dos.error) return fail('delivery orders', dos.error);
  const doById = new Map((dos.data ?? []).map((d) => [String(d.id), d]));
  const doLines = await chunkIn<Row>([...doById.keys()], (b, f, t) => scopeToCompany(sb.from('delivery_order_items')
    .select('delivery_order_id, so_item_id, item_code, qty').in('delivery_order_id', b), c).order('id').range(f, t));
  if (doLines.error) return fail('delivery order lines', doLines.error);
  /* A sales-order line some PO line was raised for was bought for that customer, not taken from stock. */
  const soItemIds = [...new Set(doLines.data.map((l) => str(l.so_item_id)).filter((x): x is string => !!x))];
  const boughtFor = await chunkIn<Row>(soItemIds, (b, f, t) => scopeToCompany(sb.from('purchase_order_items')
    .select('so_item_id').in('so_item_id', b), c).order('id').range(f, t));
  if (boughtFor.error) return fail('PO lines for orders', boughtFor.error);
  const bought = new Set(boughtFor.data.map((r) => String(r.so_item_id)));
  const soItems = await chunkIn<Row>(soItemIds, (b, f, t) => scopeToCompany(sb.from('mfg_sales_order_items')
    .select('id, doc_no').in('id', b), c).order('id').range(f, t));
  if (soItems.error) return fail('sales order lines', soItems.error);
  const docOf = new Map(soItems.data.map((r) => [String(r.id), String(r.doc_no)]));
  const sos = await chunkIn<Row>([...new Set(docOf.values())], (b, f, t) => scopeToCompany(sb.from('mfg_sales_orders')
    .select('doc_no, so_date, customer_delivery_date, amended_delivery_date').in('doc_no', b), c).order('doc_no').range(f, t));
  if (sos.error) return fail('sales orders', sos.error);
  const soByDoc = new Map(sos.data.map((s) => [String(s.doc_no), s]));
  const codes = [...new Set(grnItems.data.map((g) => str(g.item_code)).filter((x): x is string => !!x))];
  const prods = await chunkIn<Row>(codes, (b, f, t) => scopeToCompany(sb.from('mfg_products').select('code, category').in('code', b), c).order('code').range(f, t));
  if (prods.error) return fail('products', prods.error);
  const prodCat = new Map(prods.data.map((p) => [String(p.code), str(p.category)]));

  const receipts: StockReceipt[] = grnItems.data.flatMap((g) => {
    const pi = poItemById.get(String(g.purchase_order_item_id ?? ''));
    const grn = grnById.get(String(g.grn_id));
    const pd = pi ? poDate.get(String(pi.purchase_order_id)) : null;
    if (!pi || pi.so_item_id || !grn?.warehouse_id || !pd || !g.item_code) return [];
    return [{ warehouse: String(grn.warehouse_id), itemCode: String(g.item_code), category: procurementCategory(prodCat.get(String(g.item_code)) ?? null, str(pi.item_group)),
      poId: String(pi.purchase_order_id), poDate: pd, receivedAt: String(grn.received_at).slice(0, 10), qty: num(g.qty_received) }];
  });
  const outs: StockOut[] = doLines.data.flatMap((l) => {
    const d = doById.get(String(l.delivery_order_id));
    if (!d?.warehouse_id || !l.item_code || (l.so_item_id && bought.has(String(l.so_item_id)))) return [];
    const so = l.so_item_id ? soByDoc.get(docOf.get(String(l.so_item_id)) ?? '') : undefined;
    return [{ warehouse: String(d.warehouse_id), itemCode: String(l.item_code), doDate: String(d.do_date).slice(0, 10), qty: num(l.qty),
      soDate: so ? day(so.so_date) : null, needDate: so ? day(so.amended_delivery_date) ?? day(so.customer_delivery_date) : null }];
  });
  return c.json({ since, to: today, ...attributeStockPos(receipts, outs) });
});
