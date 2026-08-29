// ----------------------------------------------------------------------------
// mfg-sales-orders-list-enrichment — the DEFERRED half of the Sales Orders list.
//
// Opening the SO list used to run a full `computeMrp` on the critical path (see
// so-list-mrp-enrichment.ts for why that is the dominant cost). The list now
// returns immediately with stored-status placeholders for the four MRP-derived
// fields, and the client calls THIS endpoint once, for the page it just
// rendered, to heal them a beat later:
//
//   GET /mfg-sales-orders/list-mrp-enrichment?docNos=A,B,C
//     → { enrichment: { [docNo]: { sourcePoReady, sourcePoAdj, stockRemark,
//                                  isMainReady, planningState } } }
//
// It runs the SAME company-wide `computeMrp` the list used to run (the engine is
// global by design and cannot be narrowed to the requested docs — see the note
// in mfg-sales-orders.ts soCoverage) and then derives only the requested docs'
// fields, through the SAME shared helpers, so the values are byte-identical to
// the old inline path.
//
// Its own thin router, mounted at the same `/mfg-sales-orders` prefix (Hono
// resolves this static path ahead of the main router's `/:docNo`), because
// mfg-sales-orders.ts is at its file-size ceiling. Auth + the
// scm.sales.orders area guard cover it via the shared `/mfg-sales-orders/*`
// middleware in scm/index.ts, exactly as they cover the list.
//
// Fail-soft, exactly like the list: a failed MRP drops to empty READY chips and
// stored-status readiness; a failed catalog read drops service classification;
// neither 500s the page (the shipped chips + stored placeholders already show).
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Env, Variables } from '../env';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { resolveSalesScopeIds } from '../lib/salesScope';
import { canViewAllSales } from '../lib/houzs-perms';
import { loadLeadBuffers } from '../../services/agents/procurement-learning';
import { computeMrp, mrpLineCoverage, type MrpResult } from './mrp';
import { soLineReadySourcePos } from '../lib/source-po-trace';
import { soDeliverableRemaining } from './delivery-orders-mfg';
import { normCategory } from '../lib/so-readiness';
import { chunkIn } from '../lib/paginate-all';
import { todayMyt } from '../lib/my-time';
import {
  assembleSoListMrpEnrichment,
  type EnrichmentHeader,
  type EnrichmentItem,
} from '../lib/so-list-mrp-enrichment';

export const mfgSalesOrdersListEnrichment = new Hono<{ Bindings: Env; Variables: Variables }>();
mfgSalesOrdersListEnrichment.use('*', supabaseAuth);

/* One list page is capped at 100 rows (backend contract), so a well-behaved
   client asks for at most that many. Bound it defensively — the endpoint is
   read-only, but computeMrp downstream is company-wide work and there is no
   reason to fan a giant unbounded list into it. */
const MAX_DOCS = 200;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js builder generics do not survive structural narrowing; every SCM read helper takes the client this way (see companyScope.ts header).
type Sb = any;

mfgSalesOrdersListEnrichment.get('/list-mrp-enrichment', async (c) => {
  const sb = c.get('supabase') as Sb;

  const raw = (c.req.query('docNos') ?? '').trim();
  const docNos = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_DOCS);
  if (docNos.length === 0) return c.json({ enrichment: {} });

  const companyId = activeCompanyId(c) ?? null;
  // Same row-level visibility the list applies (self + downline, or all for a
  // view-all caller). The docs come from a page the client already received, so
  // this is defence in depth, not the only gate — the company predicate below
  // is the tenant boundary.
  const scopeIds = await resolveSalesScopeIds(sb, c.env, c.get('houzsUser')?.id, canViewAllSales(c));

  /* 1. Header inputs (status / manual override / delivery dates) AND the
     visibility filter, in one read. Only docs that survive company + sales
     scope are returned, so a spoofed doc_no yields nothing. */
  const headers = new Map<string, EnrichmentHeader>();
  /* The first promotion gate for the readiness rollup: which of these orders
     carry a processing date (readinessLinesByDoc suppresses the live-'stock'
     promotion on the rest — the allocator refuses to allocate to them, so the
     enrichment must not light them either; HC-SO-013367, 2026-08-30). */
  const processedDocs = new Set<string>();
  {
    const { data, error } = await chunkIn<{
      doc_no: string; status: string | null;
      delivery_state?: string | null; deliveryState?: string | null;
      amended_delivery_date?: string | null; amendedDeliveryDate?: string | null;
      customer_delivery_date?: string | null; customerDeliveryDate?: string | null;
      processing_date?: string | null; processingDate?: string | null;
    }>(docNos, (batch, from, to) => {
      let q = sb.from('mfg_sales_orders')
        .select('doc_no, status, delivery_state, amended_delivery_date, customer_delivery_date, processing_date')
        .in('doc_no', batch);
      if (scopeIds) q = q.in('salesperson_id', scopeIds);
      return scopeToCompany(q, c).order('doc_no').range(from, to);
    });
    if (error) return c.json({ error: 'enrichment_failed', reason: error.message }, 500);
    for (const r of data) {
      const override = r.deliveryState ?? r.delivery_state ?? null;
      const amendedDD = r.amendedDeliveryDate ?? r.amended_delivery_date ?? null;
      const customerDD = r.customerDeliveryDate ?? r.customer_delivery_date ?? null;
      if (r.processingDate ?? r.processing_date) processedDocs.add(r.doc_no);
      headers.set(r.doc_no, {
        status: r.status ?? null,
        storedOverride: override,
        effectiveDD: amendedDD ?? customerDD,
      });
    }
  }
  const visibleDocNos = [...headers.keys()];
  if (visibleDocNos.length === 0) return c.json({ enrichment: {} });

  /* 2. The page's SO lines — the exact columns readiness + the chip union read,
     scoped to the company (the tenant boundary; the list's own items read is
     already inside a company-scoped doc set). cancelled=false to match the list. */
  const items: EnrichmentItem[] = [];
  const readyItems: Array<EnrichmentItem & { qty: number | null; allocated_batch_no: string | null }> = [];
  {
    const { data, error } = await chunkIn<{
      id: string; doc_no: string; item_group: string | null; item_code: string | null;
      stock_status: string | null; cancelled: boolean | null;
      qty: number | null; allocated_batch_no: string | null;
    }>(visibleDocNos, (batch, from, to) => {
      let q = sb.from('mfg_sales_order_items')
        .select('id, doc_no, item_group, item_code, stock_status, cancelled, qty, allocated_batch_no')
        .in('doc_no', batch)
        .eq('cancelled', false);
      if (companyId != null) q = q.eq('company_id', companyId);
      return q.order('doc_no').range(from, to);
    });
    if (error) return c.json({ error: 'enrichment_failed', reason: error.message }, 500);
    for (const r of data) {
      items.push({ id: r.id, doc_no: r.doc_no, item_group: r.item_group, item_code: r.item_code, stock_status: r.stock_status, cancelled: r.cancelled });
      readyItems.push({ id: r.id, doc_no: r.doc_no, item_group: r.item_group, item_code: r.item_code, stock_status: r.stock_status, cancelled: r.cancelled, qty: r.qty, allocated_batch_no: r.allocated_batch_no });
    }
  }

  /* 3. The global MRP allocation — the SAME call the list used to make on its
     critical path, now off it. Best-effort: a failure drops to stored-status
     readiness + no READY chips, identical to the list's fail-soft. */
  let mrp: MrpResult | null = null;
  try {
    mrp = await computeMrp(sb, {
      catFilter: null, whFilter: null, includeUndated: true,
      companyId, leadBuffers: await loadLeadBuffers(c.env.DB),
    });
  } catch { mrp = null; }

  /* 4. Catalog category per code (normalised, the list's exact build) — feeds
     readiness's SERVICE classification. Bound error → best-effort empty. */
  const categoryByCode = new Map<string, string>();
  {
    const codes = [...new Set(items.map((i) => i.item_code).filter((x): x is string => !!x))];
    for (let i = 0; i < codes.length; i += 300) {
      const chunk = codes.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data, error } = await scopeToCompany(
        sb.from('mfg_products').select('code, category').in('code', chunk),
        c,
      );
      if (error) break; // service classification degrades; readiness still answers from stored status
      for (const p of (data ?? []) as Array<{ code: string; category: string | null }>) {
        if (p.category) categoryByCode.set(p.code, normCategory(p.category));
      }
    }
  }

  // 5. READY-arm source-PO chips (fail-soft internally).
  const readyByItem = await soLineReadySourcePos(sb, companyId, mrp, readyItems);

  /* 6. Delivered/remaining per line → fully-shipped ids (suppress READY chips
     for them) + per-doc delivered/remaining totals (planning_state input),
     exactly the list's derivation. */
  const fullyShippedItemIds = new Set<string>();
  const delivered = new Map<string, number>();
  const remaining = new Map<string, number>();
  {
    const deliverable = await soDeliverableRemaining(sb, visibleDocNos);
    for (const [itemId, line] of deliverable.entries()) {
      if (line.remaining <= 0 && line.delivered > 0) fullyShippedItemIds.add(itemId);
      delivered.set(line.docNo, (delivered.get(line.docNo) ?? 0) + line.delivered);
      remaining.set(line.docNo, (remaining.get(line.docNo) ?? 0) + line.remaining);
    }
  }

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
  });

  return c.json({ enrichment: Object.fromEntries(enrichment) });
});
