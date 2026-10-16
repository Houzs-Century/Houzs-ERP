/* GET /api/scm/procurement-overview?from=YYYY-MM-DD&to=YYYY-MM-DD
   The Procurement Overview page (owner, 2026-10-16) — replaces the PO CHASING
   LIST sheet. Open PO lines and how late they are, the PO raised and supplier
   bills received in the period, and how long each category / supplier really
   takes to deliver. Arithmetic in lib/procurement-overview.ts.

   Company scope: every read is scoped to the active company. */
import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { scopeToCompany } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import {
  procurementCategory, promisedDate, overdueMatrix, leadStats, suggestedLeadDays, daysBetween,
  PROCUREMENT_CATEGORIES, type OpenLine, type ReceiptLine, type ProcurementCategory,
} from '../lib/procurement-overview';

export const procurementOverview = new Hono<{ Bindings: Env; Variables: Variables }>();
procurementOverview.use('*', supabaseAuth);

type Row = Record<string, unknown>;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => Number(v ?? 0) || 0;

procurementOverview.get('/', async (c) => {
  const sb = c.get('supabase');
  const today = todayMyt();
  const from = ISO.test(c.req.query('from') ?? '') ? (c.req.query('from') as string) : `${today.slice(0, 7)}-01`;
  const to = ISO.test(c.req.query('to') ?? '') ? (c.req.query('to') as string) : today;
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 180 * 86400000).toISOString().slice(0, 10);
  const fail = (what: string, e: { message: string }) => c.json({ error: 'load_failed', reason: `${what}: ${e.message}` }, 500);

  /* ── 1. Open PO lines ─────────────────────────────────────────────────── */
  const open = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('v_po_outstanding_lines')
    .select('po_id, po_item_id, po_number, po_date, status, creditor_name, item_code, item_desc, item_group, location_code, so_doc_no, remaining_qty, delivery_date, supplier_delivery_date_2, supplier_delivery_date_3')
    .eq('is_outstanding', true).neq('status', 'DRAFT'), c).order('po_item_id').range(f, t));
  if (open.error) return fail('open PO lines', open.error);
  const openRows = open.data ?? [];

  const itemIds = openRows.map((r) => String(r.po_item_id));
  const poIds = [...new Set(openRows.map((r) => String(r.po_id)))];
  const items = await chunkIn<Row>(itemIds, (b, f, t) => scopeToCompany(sb.from('purchase_order_items').select('id, unit_price_sen, supplier_delivery_date_4').in('id', b), c).order('id').range(f, t));
  if (items.error) return fail('PO line prices', items.error);
  const heads = await chunkIn<Row>(poIds, (b, f, t) => scopeToCompany(sb.from('purchase_orders').select('id, expected_at').in('id', b), c).order('id').range(f, t));
  if (heads.error) return fail('PO headers', heads.error);
  const itemById = new Map(items.data.map((r) => [String(r.id), r]));
  const expectedByPo = new Map(heads.data.map((r) => [String(r.id), str(r.expected_at)]));

  /* ── 2. Period: PO raised and PI received ─────────────────────────────── */
  const pos = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('purchase_orders')
    .select('id, supplier_id, total_sen').gte('po_date', from).lte('po_date', to)
    .not('status', 'in', '("DRAFT","CANCELLED")'), c).order('id').range(f, t));
  if (pos.error) return fail('PO raised', pos.error);
  const pis = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('purchase_invoices')
    .select('id, supplier_id, total_sen').gte('invoice_date', from).lte('invoice_date', to)
    .not('status', 'in', '("DRAFT","CANCELLED")'), c).order('id').range(f, t));
  if (pis.error) return fail('supplier bills', pis.error);
  const poLines = await chunkIn<Row>((pos.data ?? []).map((r) => String(r.id)), (b, f, t) => scopeToCompany(sb.from('purchase_order_items')
    .select('purchase_order_id, item_code, item_group, line_total_sen').in('purchase_order_id', b), c).order('id').range(f, t));
  if (poLines.error) return fail('PO raised lines', poLines.error);
  const piLines = await chunkIn<Row>((pis.data ?? []).map((r) => String(r.id)), (b, f, t) => scopeToCompany(sb.from('purchase_invoice_items')
    .select('purchase_invoice_id, item_code, item_group, line_total_sen').in('purchase_invoice_id', b), c).order('id').range(f, t));
  if (piLines.error) return fail('supplier bill lines', piLines.error);

  /* ── 3. Receipts of the last 180 days, for lead time ──────────────────── */
  const grns = await paginateAll<Row>((f, t) => scopeToCompany(sb.from('grns')
    .select('id, supplier_id, received_at, status').gte('received_at', since)
    .not('status', 'in', '("DRAFT","CANCELLED")'), c).order('id').range(f, t));
  if (grns.error) return fail('goods received', grns.error);
  const grnById = new Map((grns.data ?? []).map((r) => [String(r.id), r]));
  const grnLines = await chunkIn<Row>([...grnById.keys()], (b, f, t) => scopeToCompany(sb.from('grn_items')
    .select('grn_id, purchase_order_item_id, item_code, item_group, qty_received, qty_rejected').in('grn_id', b), c).order('id').range(f, t));
  if (grnLines.error) return fail('goods received lines', grnLines.error);
  const rcvItemIds = [...new Set(grnLines.data.map((r) => str(r.purchase_order_item_id)).filter((x): x is string => !!x))];
  const rcvItems = await chunkIn<Row>(rcvItemIds, (b, f, t) => scopeToCompany(sb.from('purchase_order_items').select('id, purchase_order_id, delivery_date').in('id', b), c).order('id').range(f, t));
  if (rcvItems.error) return fail('received PO lines', rcvItems.error);
  const rcvPoIds = [...new Set(rcvItems.data.map((r) => String(r.purchase_order_id)))];
  const rcvPos = await chunkIn<Row>(rcvPoIds, (b, f, t) => scopeToCompany(sb.from('purchase_orders').select('id, po_date, expected_at').in('id', b), c).order('id').range(f, t));
  if (rcvPos.error) return fail('received POs', rcvPos.error);
  const rcvItemById = new Map(rcvItems.data.map((r) => [String(r.id), r]));
  const rcvPoById = new Map(rcvPos.data.map((r) => [String(r.id), r]));

  /* ── Names: suppliers and product categories ──────────────────────────── */
  const supplierIds = [...new Set([...(pos.data ?? []), ...(pis.data ?? []), ...(grns.data ?? [])].map((r) => str(r.supplier_id)).filter((x): x is string => !!x))];
  const sups = await chunkIn<Row>(supplierIds, (b, f, t) => scopeToCompany(sb.from('suppliers').select('id, name').in('id', b), c).order('id').range(f, t));
  if (sups.error) return fail('suppliers', sups.error);
  const supName = new Map(sups.data.map((r) => [String(r.id), String(r.name ?? '—')]));
  const codes = [...new Set([...openRows, ...poLines.data, ...piLines.data, ...grnLines.data].map((r) => str(r.item_code)).filter((x): x is string => !!x))];
  const prods = await chunkIn<Row>(codes, (b, f, t) => scopeToCompany(sb.from('mfg_products').select('code, category').in('code', b), c).order('code').range(f, t));
  if (prods.error) return fail('products', prods.error);
  const prodCat = new Map(prods.data.map((r) => [String(r.code), str(r.category)]));
  const catOf = (r: Row): ProcurementCategory => procurementCategory(prodCat.get(String(r.item_code ?? '')) ?? null, str(r.item_group));

  const settings = await scopeToCompany(sb.from('mrp_category_lead_times').select('category, lead_days'), c);
  if (settings.error) return fail('lead time settings', settings.error);
  const currentLead = new Map<string, number>();
  for (const s of (settings.data ?? []) as Row[]) {
    const k = procurementCategory(str(s.category), null);
    currentLead.set(k, Math.max(currentLead.get(k) ?? 0, num(s.lead_days)));
  }

  /* ── Assemble ─────────────────────────────────────────────────────────── */
  const lines: OpenLine[] = openRows.map((r) => {
    const it = itemById.get(String(r.po_item_id));
    const original = str(r.delivery_date) ?? expectedByPo.get(String(r.po_id)) ?? null;
    const revised = [str(r.supplier_delivery_date_2), str(r.supplier_delivery_date_3), str(it?.supplier_delivery_date_4)].filter((x): x is string => !!x);
    return {
      poId: String(r.po_id), poNumber: String(r.po_number ?? ''), supplier: String(r.creditor_name ?? '—'), category: catOf(r),
      itemCode: str(r.item_code), itemDesc: str(r.item_desc), location: str(r.location_code), soDocNo: str(r.so_doc_no),
      poDate: str(r.po_date), remainingQty: num(r.remaining_qty), unitPriceSen: num(it?.unit_price_sen),
      originalDue: original, promised: promisedDate([original, ...revised]), revised,
    };
  });
  const receipts: ReceiptLine[] = grnLines.data.flatMap((g) => {
    const grn = grnById.get(String(g.grn_id));
    const it = rcvItemById.get(String(g.purchase_order_item_id ?? ''));
    const po = it ? rcvPoById.get(String(it.purchase_order_id)) : undefined;
    if (!grn || !grn.received_at) return [];
    return [{
      supplier: supName.get(String(grn.supplier_id ?? '')) ?? '—', category: catOf(g),
      poDate: str(po?.po_date), originalDue: str(it?.delivery_date) ?? str(po?.expected_at),
      receivedAt: String(grn.received_at).slice(0, 10), qtyReceived: num(g.qty_received), qtyRejected: num(g.qty_rejected),
    }];
  });

  const periodBy = (rows: Row[], lineRows: Row[], fk: string) => {
    const bySup = new Map<string, number>();
    for (const r of rows) { const k = supName.get(String(r.supplier_id ?? '')) ?? '—'; bySup.set(k, (bySup.get(k) ?? 0) + num(r.total_sen)); }
    const byCat = new Map<string, number>();
    for (const l of lineRows) { const k = catOf(l); byCat.set(k, (byCat.get(k) ?? 0) + num(l.line_total_sen)); }
    void fk;
    return { totalSen: rows.reduce((a, r) => a + num(r.total_sen), 0), count: rows.length, bySupplier: Object.fromEntries(bySup), byCategory: Object.fromEntries(byCat) };
  };

  const catLead = leadStats(receipts, 'category').map((s) => ({ ...s, current: currentLead.get(s.key) ?? null, ...suggestedLeadDays(s, currentLead.get(s.key) ?? null) }));
  const late5 = lines.filter((l) => l.promised && daysBetween(l.promised, today) >= 5);

  return c.json({
    today, from, to,
    categories: PROCUREMENT_CATEGORIES,
    open: {
      poCount: new Set(lines.map((l) => l.poId)).size,
      lineCount: lines.length,
      remainingQty: lines.reduce((a, l) => a + l.remainingQty, 0),
      remainingSen: lines.reduce((a, l) => a + l.remainingQty * l.unitPriceSen, 0),
      late5Lines: late5.length,
      late5LinesOriginal: lines.filter((l) => l.originalDue && daysBetween(l.originalDue, today) >= 5).length,
      late5Suppliers: new Set(late5.map((l) => l.supplier)).size,
      worstDaysLate: late5.reduce((m, l) => Math.max(m, daysBetween(l.promised as string, today)), 0),
    },
    poRaised: periodBy(pos.data ?? [], poLines.data, 'purchase_order_id'),
    piReceived: periodBy(pis.data ?? [], piLines.data, 'purchase_invoice_id'),
    overdueByCategory: overdueMatrix(lines, today, 'category', 'promised'),
    overdueBySupplier: overdueMatrix(lines, today, 'supplier', 'promised'),
    overdueByCategoryOriginal: overdueMatrix(lines, today, 'category', 'original'),
    overdueBySupplierOriginal: overdueMatrix(lines, today, 'supplier', 'original'),
    chasing: lines.filter((l) => l.promised).map((l) => ({ ...l, daysLate: daysBetween(l.promised as string, today), daysLateOriginal: l.originalDue ? daysBetween(l.originalDue, today) : null }))
      .sort((a, b) => Math.max(b.daysLate, b.daysLateOriginal ?? b.daysLate) - Math.max(a.daysLate, a.daysLateOriginal ?? a.daysLate)).slice(0, 200),
    leadByCategory: catLead,
    leadBySupplier: leadStats(receipts, 'supplier'),
    receiptsSince: since,
  });
});
