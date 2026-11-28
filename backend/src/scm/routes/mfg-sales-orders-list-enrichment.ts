
import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { resolveSalesScopeIds, applySoScope, soDocOutOfScope } from '../lib/salesScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { mrpLineCoverage } from './mrp';
import { resolveListMrp, wantsListMrpRefresh } from '../lib/list-mrp-source';
import { eager } from '../lib/concurrency';
import { soLineReadySourcePos } from '../lib/source-po-trace';
import { soCoverage } from './mfg-sales-orders';
import { effectiveLineStockStatus, type LiveStockState } from '../lib/so-line-effective-stock';
import { loadNonSellingWarehouses, nonSellingWarehouseNotice } from '../lib/non-selling-warehouse';
import { isHardBoundLine } from '../lib/so-stock-allocation';
import { isServiceLine } from '../shared/service-sku';
import { soDeliverableRemaining } from './delivery-orders-mfg';
import { normCategory } from '../lib/so-readiness';
import { chunkIn } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import { loadAcExemptionExpiryByDoc } from '../lib/ac-exemption-expiry';
import { soExemptionExpiryOf } from '../lib/so-exemption-expiry';
import {
  assembleSoListMrpEnrichment,
  type EnrichmentHeader,
  type EnrichmentItem,
} from '../lib/so-list-mrp-enrichment';
import { pgrestIn } from '../lib/pgrest-in-list';

export const mfgSalesOrdersListEnrichment = new Hono<{ Bindings: Env; Variables: Variables }>();
mfgSalesOrdersListEnrichment.use('*', supabaseAuth);

const MAX_DOCS = 200;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js builder generics do not survive structural narrowing; every SCM read helper takes the client this way (see companyScope.ts header).
type Sb = any;

mfgSalesOrdersListEnrichment.get('/list-mrp-enrichment', async (c) => {
  const sb = c.get('supabase') as Sb;

  const raw = (c.req.query('docNos') ?? '').trim();
  const docNos = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_DOCS);
  if (docNos.length === 0) return c.json({ enrichment: {} });

  const companyId = activeCompanyId(c) ?? null;
  const listMrp = resolveListMrp(sb, c, wantsListMrpRefresh(c));
  const nonSellingProm = eager(loadNonSellingWarehouses(sb));
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  const headers = new Map<string, EnrichmentHeader>();
  const processedDocs = new Set<string>();
  {
    const { data, error } = await chunkIn<{
      doc_no: string; status: string | null;
      delivery_state?: string | null; deliveryState?: string | null;
      amended_delivery_date?: string | null; amendedDeliveryDate?: string | null;
      customer_delivery_date?: string | null; customerDeliveryDate?: string | null;
      processing_date?: string | null; processingDate?: string | null;
      sales_exemption_expiry?: string | null; salesExemptionExpiry?: string | null;
      linked_ac_docno?: string | null; linkedAcDocno?: string | null;
    }>(docNos, (batch, from, to) => {
      let q = sb.from('mfg_sales_orders')
        .select('doc_no, status, delivery_state, amended_delivery_date, customer_delivery_date, processing_date, sales_exemption_expiry, linked_ac_docno')
        .in('doc_no', batch);
      q = applySoScope(q, scopeIds);
      return scopeToCompany(q, c).order('doc_no').range(from, to);
    });
    if (error) return c.json({ error: 'enrichment_failed', reason: error.message }, 500);
    const acExpiryByDoc = await loadAcExemptionExpiryByDoc(sb, c, data);
    for (const r of data) {
      const override = r.deliveryState ?? r.delivery_state ?? null;
      const amendedDD = r.amendedDeliveryDate ?? r.amended_delivery_date ?? null;
      const customerDD = r.customerDeliveryDate ?? r.customer_delivery_date ?? null;
      if (r.processingDate ?? r.processing_date) processedDocs.add(r.doc_no);
      headers.set(r.doc_no, {
        status: r.status ?? null,
        storedOverride: override,
        effectiveDD: amendedDD ?? customerDD,
        amendedDD,
        salesExemptionExpiry: soExemptionExpiryOf({
          sales_exemption_expiry: r.salesExemptionExpiry ?? r.sales_exemption_expiry ?? null,
          ac_sales_exemption_expiry: acExpiryByDoc.get(r.doc_no) ?? null,
          customer_delivery_date: customerDD,
        }),
      });
    }
  }
  const visibleDocNos = [...headers.keys()];
  if (visibleDocNos.length === 0) return c.json({ enrichment: {}, mrp: (await listMrp).meta });

  const items: EnrichmentItem[] = [];
  const readyItems: Array<EnrichmentItem & { qty: number | null; allocated_batch_no: string | null }> = [];
  {
    const { data, error } = await chunkIn<{
      id: string; doc_no: string; item_group: string | null; item_code: string | null;
      stock_status: string | null; cancelled: boolean | null;
      qty: number | null; allocated_batch_no: string | null; warehouse_id: string | null;
    }>(visibleDocNos, (batch, from, to) => {
      let q = sb.from('mfg_sales_order_items')
        .select('id, doc_no, item_group, item_code, stock_status, cancelled, qty, allocated_batch_no, warehouse_id')
        .in('doc_no', batch)
        .eq('cancelled', false);
      if (companyId != null) q = q.eq('company_id', companyId);
      return q.order('doc_no').range(from, to);
    });
    if (error) return c.json({ error: 'enrichment_failed', reason: error.message }, 500);
    const acExpiryByDoc = await loadAcExemptionExpiryByDoc(sb, c, data);
    for (const r of data) {
      items.push({ id: r.id, doc_no: r.doc_no, item_group: r.item_group, item_code: r.item_code, stock_status: r.stock_status, cancelled: r.cancelled, warehouse_id: r.warehouse_id });
      readyItems.push({ id: r.id, doc_no: r.doc_no, item_group: r.item_group, item_code: r.item_code, stock_status: r.stock_status, cancelled: r.cancelled, qty: r.qty, allocated_batch_no: r.allocated_batch_no });
    }
  }

  const deliverableProm = eager(soDeliverableRemaining(sb, visibleDocNos));

  const categoryByCode = new Map<string, string>();
  {
    const codes = [...new Set(items.map((i) => i.item_code).filter((x): x is string => !!x))];
    for (let i = 0; i < codes.length; i += 300) {
      const chunk = codes.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data, error } = await scopeToCompany(
        pgrestIn(sb.from('mfg_products').select('code, category'), 'code', chunk),
        c,
      );
      if (error) break;
      for (const p of (data ?? []) as Array<{ code: string; category: string | null }>) {
        if (p.category) categoryByCode.set(p.code, normCategory(p.category));
      }
    }
  }

  const { result: mrp, meta: mrpMeta } = await listMrp;
  const readyByItem = await soLineReadySourcePos(sb, companyId, mrp, readyItems);

  const fullyShippedItemIds = new Set<string>();
  const delivered = new Map<string, number>();
  const remaining = new Map<string, number>();
  {
    const deliverable = (await deliverableProm)();
    for (const [itemId, line] of deliverable.entries()) {
      if (line.remaining <= 0 && line.delivered > 0) fullyShippedItemIds.add(itemId);
      delivered.set(line.docNo, (delivered.get(line.docNo) ?? 0) + line.delivered);
      remaining.set(line.docNo, (remaining.get(line.docNo) ?? 0) + line.remaining);
    }
  }

  /* 7. Display / showroom / service warehouses (owner ruling 2026-09-08). One
     small read, on the DEFERRED path where the live-'stock' promotion fires —
     the list's first paint deliberately passes null and leans on the stored
     status the allocator already gated. */
  const nonSellingWarehouseIds = new Set(
    (await nonSellingProm)().keys(),
  ) as ReadonlySet<string>;

  const enrichment = assembleSoListMrpEnrichment({
    docNos: visibleDocNos,
    items,
    coverage: mrp ? mrpLineCoverage(mrp) : null,
    categoryByCode,
    readyByItem,
    fullyShippedItemIds,
    headers,
    delivered,
    remaining,
    today: todayMyt(),
    processedDocs,
    nonSellingWarehouseIds,
  });

  return c.json({ enrichment: Object.fromEntries(enrichment), mrp: mrpMeta });
});

/* GET /:docNo/coverage — the DEFERRED live Stock column for the SO DETAIL page
   (2026-09-01, docs/bugs/0589). `GET /mfg-sales-orders/:docNo` used to run the
   GLOBAL company-wide MRP allocation (`soCoverage` → `computeMrp`, ~105 DB round
   trips) INLINE just to paint the per-line badge, making a cold open ~4.7s. It
   no longer does; the client calls THIS endpoint after the doc renders and
   overlays the MRP-derived per-line fields. This is the EXACT code the detail
   removed — same MRP run (the shared, exported `soCoverage`), same per-line rule
   (sofa/service special-casing + `effectiveLineStockStatus` with the LIVE state)
   — moved off the critical path, not changed. It lives HERE rather than in
   mfg-sales-orders.ts only because that file is at its size ceiling; mounted at
   the same `/mfg-sales-orders` prefix, so the path is exactly
   `/api/scm/mfg-sales-orders/:docNo/coverage`. Same company scope +
   self-scoped-sales 404 guard the detail uses. Returns { coverage }. */
mfgSalesOrdersListEnrichment.get('/:docNo/coverage', async (c) => {
  const sb = c.get('supabase') as Sb;
  const docNo = c.req.param('docNo');
  const [h, i, nonSellingWh] = await Promise.all([
    scopeToCompany(sb.from('mfg_sales_orders').select('doc_no, salesperson_id, access_staff_ids, processing_date, open_to_all, updated_at').eq('doc_no', docNo), c).maybeSingle(),
    sb.from('mfg_sales_order_items').select('id, item_group, item_code, qty, stock_status, allocated_batch_no, warehouse_id').eq('doc_no', docNo)
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at'),
    /* Display / showroom / service warehouses (owner ruling 2026-09-08). THIS
       is the endpoint where the live-'stock' promotion actually fires, so it is
       the one that must know which warehouses may not promise — MRP pools per
       warehouse and would happily report 'stock' for a line in KL DISPLAY. */
    loadNonSellingWarehouses(sb),
  ]);
  if (h.error) return c.json({ error: 'load_failed', reason: h.error.message }, 500);
  if (!h.data) return c.json({ error: 'not_found' }, 404);
  {
    const d = h.data as { salesperson_id?: number | string | null; access_staff_ids?: string[] | null; open_to_all?: boolean | null };
    if (await soDocOutOfScope(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c), { salespersonId: d.salesperson_id, accessStaffIds: d.access_staff_ids, openToAll: d.open_to_all })) {
      return c.json({ error: 'not_found' }, 404);
    }
  }
  const lineRows = (i.data ?? []) as Array<{ id: string; item_group?: string | null; item_code?: string | null; qty?: number | null; stock_status?: string | null; allocated_batch_no?: string | null; warehouse_id?: string | null }>;
  /* Coverage from the SAME allocation engine the MRP page uses (Wei Siang
     2026-05-31): stock first → earliest-ETA outstanding PO → shortage. The MRP
     allocation is GLOBAL by design and cannot be narrowed to one order; a failed
     allocation drops every line to Pending and this endpoint still returns.
     READY trace (owner 2026-08-01): a READY (allocated, un-shipped) line resolves
     the PO(s) it WILL draw from — sofa via its stored allocated_batch_no, non-sofa
     by projecting the engine's own FIFO consumption order over the bucket's open
     lots. Read-time derivation, no writes. */
  const cov = await soCoverage(c, sb, (h.data as { updated_at?: string | null }).updated_at ?? null);
  const coverageMap = cov.coverage;
  const readyPosMap = await soLineReadySourcePos(sb, activeCompanyId(c) ?? null, cov.mrp, lineRows);
  const orderProcessed = !!(h.data as { processing_date?: string | null }).processing_date;
  const coverage = lineRows.map((it) => {
    const lineCov = coverageMap.get(it.id);
    const covered = lineCov?.source === 'po';
    const isSofaLine = String(it.item_group ?? '').toUpperCase().includes('SOFA');
    /* SERVICE lines never enter the MRP allocator (mrp.ts skips them), so `cov`
       is always undefined; a service is inherently available, so surface it as
       READY ('stock'). (Owner Q2, 2026-07-24.) */
    const isSvcLine = isServiceLine({ itemGroup: it.item_group ?? null, itemCode: it.item_code ?? null });
    const lineNonSelling = nonSellingWh.get(String(it.warehouse_id ?? '')) ?? null;
    const stockState = isSvcLine
      ? 'stock'
      : isSofaLine
      ? (it.stock_status === 'READY' ? 'stock' : (lineCov?.source === 'po' ? 'po' : 'shortage'))
      : (lineCov?.source ?? null);
    return {
      id: it.id,
      stock_state: stockState,
      stock_status_effective: effectiveLineStockStatus(
        it.stock_status ?? null,
        stockState as LiveStockState,
        {
          orderProcessed,
          lineHardBound: isHardBoundLine(it.item_group ?? null, it.item_code ?? null),
          lineNonSellingWarehouse: lineNonSelling !== null,
        },
      ),
      non_selling_warehouse: lineNonSelling === null ? null : {
        code: lineNonSelling.code,
        name: lineNonSelling.name,
        type: lineNonSelling.type,
        notice: nonSellingWarehouseNotice(lineNonSelling),
      },
      coverage_po: covered ? lineCov.po ?? null : null,
      coverage_eta: covered ? lineCov.eta ?? null : null,
      ready_source_pos: readyPosMap.get(it.id) ?? [],
    };
  });
  return c.json({ coverage });
});
