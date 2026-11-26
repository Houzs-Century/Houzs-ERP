
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { activeCompanyId, scopeToCompany } from './companyScope';
import { doNosBySalesOrder, type DeliveryOrderNoRow } from './so-delivery-order-nos';
import { deriveListFirstItemBranding, type ListBrandingLine } from './so-list-first-item-branding';
import { soDownstreamRefs, NO_SO_DOWNSTREAM_REFS } from './downstream-doc-refs';
import { SO_FINANCE_KEYS } from './finance-keys';
import { approvalCodesByOrder } from './so-list-approval-codes';
import { attachLineCategories } from './so-readiness-category';
import { canViewScmFinance } from './houzs-perms';
import { chunkIn } from './paginate-all';
import { acExemptionExpiryByDoc } from './ac-exemption-expiry';
import { migratedSoListGate } from './migrated-so-readonly';
import { pgrestIn } from './pgrest-in-list';
import { readinessLinesByDoc } from './so-line-effective-stock';
import { soConvertedPoNumbers } from './so-converted-po';
import { soDocNosWithDownstream } from './downstream-lock';
import { summariseReadiness } from './so-readiness';
import { todayMyt } from './my-time';
import { unionSoLineChips } from './source-po-trace';
import { warehouseLabel } from './warehouse-label';
import { soDeliverableRemaining, computeSoLifecycle, soCurrentDocNo, soLineShippedSources } from '../routes/delivery-orders-mfg';
import { derivePlanningState } from '../routes/delivery-planning';
import { soExemptionExpiryOf } from './so-exemption-expiry';
import { soReopenable } from './so-reopen';

export type SoListRow = { doc_no?: string } & Record<string, unknown>;
export type SoDeliverableMap = Awaited<ReturnType<typeof soDeliverableRemaining>>;
type ReadResult<T> = { data: T[] | null; error: { message: string } | null };
/** What buildSoListRows already read for these orders, handed to the line attach
 *  (lib/so-list-lines.ts) so it does not read the same rows again. */
export type SoListPrior = {
  deliverable: SoDeliverableMap | null;
  base: ReadResult<{ doc_no: string; linked_ac_docno: string | null }> | null;
  warehouses: ReadResult<{ id: string; code: string | null; name: string | null }> | null;
};

export { acExemptionExpiryByDoc };

export async function buildSoListRows(
  sb: Variables['supabase'],
  c: Context<{ Bindings: Env; Variables: Variables }>,
  rows: SoListRow[],
): Promise<SoListPrior> {
  let deliverable: SoDeliverableMap | null = null;
  let baseRes: SoListPrior['base'] = null;
  let whRes: SoListPrior['warehouses'] = null;
  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  if (docNos.length > 0) {
    const payRowsProm = (async () =>
      (await chunkIn(docNos, (batch, from, to) => sb.from('mfg_sales_order_payments')
        .select('so_doc_no, method, online_type, approval_code, paid_at, created_at').in('so_doc_no', batch).order('so_doc_no').range(from, to))).data)();
    const downstreamProm = Promise.all([
      chunkIn(docNos, (batch, from, to) => sb.from('delivery_orders').select('id, so_doc_no, do_number, do_date, created_at').in('so_doc_no', batch).neq('status', 'CANCELLED').order('so_doc_no').range(from, to)),
      chunkIn(docNos, (batch, from, to) => sb.from('sales_invoices').select('id, so_doc_no, invoice_number').in('so_doc_no', batch).neq('status', 'CANCELLED').order('so_doc_no').range(from, to)),
    ]);
    const deliverableProm = soDeliverableRemaining(sb, docNos);
    const lifecycleProm = Promise.all([
      computeSoLifecycle(sb, docNos),
      soCurrentDocNo(sb, docNos),
    ]);
    const whRowsProm = (async () => {
      whRes = await sb.from('warehouses').select('id, code, name');
      return whRes.data ?? [];
    })();
    const baseRowsProm = (async () => {
      const res = await chunkIn(docNos, (batch, from, to) => sb.from('mfg_sales_orders')
        .select('doc_no, delivery_state, amended_delivery_date, linked_ac_docno').in('doc_no', batch).order('doc_no').range(from, to));
      baseRes = res as unknown as SoListPrior['base'];
      return res.data;
    })();
    /* PO No. column (owner 2026-07-24): the system Purchase Order numbers this
       SO was converted into. Its own SO-line→PO-item→PO chain, independent of
       every other enrichment above, so it rides the same concurrent wave.
       Since 2026-08-02 this is the TOOLTIP-only legacy raise-link — the visible
       chips come from source_po_union below. */
    const convertedPoProm = soConvertedPoNumbers(sb, docNos, activeCompanyId(c) ?? null);
    /* Source-PO union (owner 2026-08-02, "他拿的货是谁的货"): the list "PO No."
       column shows the union of per-line source chips the drill shows —
       SHIPPED/DELIVERED consumed batches ∪ READY projections. Only the SHIPPED
       arm is computed HERE (cheap real-batch reads); the READY arm needs the
       GLOBAL MRP allocation (`computeMrp`), which paginates the company's whole
       products / balances / PO-lines / SO-lines tables and was the dominant cost
       of opening this list. It — and the readiness/planning fields it also fed
       (see below) — are no longer on this path. The client fetches them a beat
       later from GET /mfg-sales-orders/list-mrp-enrichment and merges them in
       (lib/so-list-mrp-enrichment.ts). */

    const { data: itemRows } = await chunkIn<{ id: string; doc_no: string; item_group: string | null; stock_status: string | null; cancelled: boolean; branding: string | null; item_code: string | null; warehouse_id: string | null; created_at: string; qty: number | null; allocated_batch_no: string | null }>(docNos, (batch, from, to) => sb
      .from('mfg_sales_order_items')
      .select('id, doc_no, item_group, stock_status, cancelled, branding, item_code, warehouse_id, created_at, qty, allocated_batch_no')
      .in('doc_no', batch)
      .eq('cancelled', false)
      .order('doc_no')
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(from, to));
    const shippedTraceProm = soLineShippedSources(sb, itemRows.map((it) => it.id));
    const agg = new Map<string, Map<string, { total: number; ready: number }>>();
    const cats = new Map<string, Set<string>>();
    const firstWarehouseByDoc = new Map<string, string>();
    const allCodes = new Set<string>();
    const normCategory = (raw: string): string => {
      const g = (raw ?? '').trim().toUpperCase();
      if (g.includes('BEDFRAME')) return 'BEDFRAME';
      if (g.includes('SOFA'))     return 'SOFA';
      if (g.includes('MATTRESS')) return 'MATTRESS';
      if (g.includes('ACCESSOR')) return 'ACCESSORY';
      if (g.includes('SERVICE')) return 'SERVICE';
      return 'OTHERS';
    };
    for (const it of itemRows as unknown as Array<{ doc_no: string; item_group: string; stock_status: string; cancelled: boolean; branding: string | null; item_code: string | null; warehouse_id: string | null; created_at: string | null }>) {
      let perGroup = agg.get(it.doc_no);
      if (!perGroup) { perGroup = new Map(); agg.set(it.doc_no, perGroup); }
      const g = (it.item_group ?? '').trim().toUpperCase() || 'OTHERS';
      let cell = perGroup.get(g);
      if (!cell) { cell = { total: 0, ready: 0 }; perGroup.set(g, cell); }
      cell.total += 1;
      if (it.stock_status === 'READY') cell.ready += 1;

      let catSet = cats.get(it.doc_no);
      if (!catSet) { catSet = new Set(); cats.set(it.doc_no, catSet); }
      catSet.add(normCategory(it.item_group));
      if (it.item_code) allCodes.add(it.item_code);
      if (it.warehouse_id && !firstWarehouseByDoc.has(it.doc_no)) {
        firstWarehouseByDoc.set(it.doc_no, it.warehouse_id);
      }
    }

    const productCategory = new Map<string, string>();
    const productBranding = new Map<string, string>();
    const codeList = [...allCodes];
    for (let i = 0; i < codeList.length; i += 300) {
      const chunk = codeList.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data: prodRows } = await scopeToCompany(
        pgrestIn(sb
          .from('mfg_products')
          .select('code, category, branding'), 'code', chunk),
        c,
      );
      for (const p of (prodRows ?? []) as Array<{ code: string; category: string | null; branding: string | null }>) {
        if (p.category) productCategory.set(p.code, normCategory(p.category));
        if (p.branding && p.branding.trim()) productBranding.set(p.code, p.branding);
      }
    }
    const firstItemBrandingByDoc = deriveListFirstItemBranding(
      itemRows as unknown as ListBrandingLine[],
      productCategory,
      productBranding,
    );

    const paymentMethods = new Map<string, Set<string>>();
    /* The Approval Code column (docs/bugs/0909): each payment's code, by
       payment date, " + " joined — off the same read. */
    let approvalCodes = new Map<string, string>();
    {
      const payRows = await payRowsProm;
      approvalCodes = approvalCodesByOrder((payRows ?? []) as unknown as Array<{ so_doc_no: string; approval_code: string | null; paid_at: string | null; created_at: string | null }>);
      for (const p of payRows as unknown as Array<{ so_doc_no: string; method: string | null; online_type: string | null }>) {
        const m = (p.method ?? '').trim().toLowerCase();
        let label: string;
        if (m === 'cash') label = 'Cash';
        else if (m === 'merchant') label = 'Card';
        else if (m === 'transfer') label = (p.online_type && p.online_type.trim()) ? p.online_type.trim() : 'Transfer';
        else if (m === 'installment') label = 'Installment';
        else continue;
        let set = paymentMethods.get(p.so_doc_no);
        if (!set) { set = new Set(); paymentMethods.set(p.so_doc_no, set); }
        set.add(label);
      }
    }

    const [doRowsRes, siRowsRes] = await downstreamProm;
    const doNosBySo = doNosBySalesOrder(doRowsRes.data as unknown as DeliveryOrderNoRow[]);
    const downRefsBySo = soDownstreamRefs(doRowsRes.data as unknown as DeliveryOrderNoRow[], siRowsRes.data);
    const downstreamDocNos = soDocNosWithDownstream(doRowsRes.data, siRowsRes.data);

    /* B2C readiness summary per SO (Commander 2026-05-30) — derive the
       "Stock Remark" the operator's existing ERP shows: READY, PARTIAL
       (every MAIN line in, an accessory not), or the "/"-joined list of
       groups that ARE in — blank when none is, because it names what IS
       ready (owner 2026-08-16). `category` rides along from the catalog map
       already built above (productCategory, zero extra reads): it is
       isServiceLine's strongest signal, so a delivery/dispose SKU whose line
       item_group was saved as 'others' is still recognised as a SERVICE line
       and cannot masquerade as a short accessory. */
    const readinessByDoc = new Map<string, ReturnType<typeof summariseReadiness>>();
    const linesByDoc = readinessLinesByDoc(itemRows, null, null, null);
    attachLineCategories(linesByDoc.values(), productCategory);
    for (const [docNo, ls] of linesByDoc) readinessByDoc.set(docNo, summariseReadiness(ls));

    const hasUndelivered = new Set<string>();
    const deliveredTotal = new Map<string, number>();
    const remainingTotal = new Map<string, number>();
    const fullyShippedItemIds = new Set<string>();
    {
      const deliverableMap = await deliverableProm;
      deliverable = deliverableMap;
      for (const [itemId, line] of deliverableMap.entries()) {
        if (line.remaining > 0) hasUndelivered.add(line.docNo);
        else if (line.delivered > 0) fullyShippedItemIds.add(itemId);
        deliveredTotal.set(line.docNo, (deliveredTotal.get(line.docNo) ?? 0) + line.delivered);
        remainingTotal.set(line.docNo, (remainingTotal.get(line.docNo) ?? 0) + line.remaining);
      }
    }

    const [lifecycleByDoc, currentByDoc] = await lifecycleProm;

    const whName = new Map<string, string>();
    {
      const whRows = await whRowsProm;
      for (const w of (whRows ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
        const label = warehouseLabel(w);
        if (label) whName.set(w.id, label);
      }
    }

    const overrideByDoc = new Map<string, string | null>();
    const amendedDDByDoc = new Map<string, string | null>();
    /* BUG-51 column repoint (owner 2026-10-15): the SO list "Sales Exemption
       Expiry Date" column shows the REAL AutoCount exemption-expiry UDF, keyed by
       the order's linked book doc no — NOT the ERP's own `sales_exemption_expiry`
       (the frozen original delivery date, which stays untouched). Collect each
       order's `linked_ac_docno` here (already on this base read) for the mirror
       read below. */
    const linkedAcByDoc = new Map<string, string>();
    {
      const baseRows = await baseRowsProm;
      for (const b of baseRows as unknown as Array<{ doc_no: string | null; delivery_state?: string | null; deliveryState?: string | null; amended_delivery_date?: string | null; amendedDeliveryDate?: string | null; linked_ac_docno?: string | null; linkedAcDocno?: string | null }>) {
        if (!b.doc_no) continue;
        overrideByDoc.set(b.doc_no, b.deliveryState ?? b.delivery_state ?? null);
        amendedDDByDoc.set(b.doc_no, b.amendedDeliveryDate ?? b.amended_delivery_date ?? null);
        const ac = (b.linkedAcDocno ?? b.linked_ac_docno ?? '').trim();
        if (ac) linkedAcByDoc.set(b.doc_no, ac);
      }
    }
    const acExemptionByDoc = new Map<string, string>();
    {
      const acDocNos = [...new Set(linkedAcByDoc.values())];
      if (acDocNos.length > 0) {
        const { data: acRows, error: acErr } = await chunkIn<{ doc_no: string | null; expiry_date: string | null }>(
          acDocNos,
          (batch, from, to) =>
            scopeToCompany(
              sb.schema('public').from('sales_orders').select('doc_no, expiry_date').in('doc_no', batch).order('doc_no'),
              c,
            ).range(from, to),
        );
        if (acErr) console.warn('[so-list] AutoCount exemption-expiry read failed, column left blank:', acErr.message);
        else for (const [docNo, v] of acExemptionExpiryByDoc(linkedAcByDoc, acRows ?? [])) acExemptionByDoc.set(docNo, v);
      }
    }
    const planningToday = todayMyt();

    const [convertedPoByDoc, migratedGate] = await Promise.all([convertedPoProm, migratedSoListGate(c, await baseRowsProm)]);

    const sourceUnionByDoc = await (async () => {
      try {
        const pageItems = itemRows as unknown as Array<{ id: string; doc_no: string }>;
        const shippedByItem = await shippedTraceProm;
        return unionSoLineChips(
          pageItems.map((it) => ({ id: it.id, docNo: it.doc_no })),
          shippedByItem,
          new Map(),
          fullyShippedItemIds,
        );
      } catch {
        return new Map<string, { pos: string[]; adj: boolean }>();
      }
    })();

    for (const r of rows) {
      const docNo = r.doc_no ?? '';
      const perGroup = agg.get(docNo);
      (r as Record<string, unknown>).item_categories = [...(cats.get(docNo) ?? [])].sort();
      /* The PO numbers this SO produced (LEGACY convert-time raise-link; empty
         array when none). Kept for the FE tooltip — the VISIBLE chips are
         source_po_union below (owner 2026-08-02: the list must show the same
         union of per-line source chips the drill shows). */
      (r as Record<string, unknown>).converted_po_nos = convertedPoByDoc.get(docNo) ?? [];
      (r as Record<string, unknown>).source_po_union = sourceUnionByDoc.get(docNo)?.pos ?? [];
      (r as Record<string, unknown>).source_po_adj = sourceUnionByDoc.get(docNo)?.adj ?? false;
      (r as Record<string, unknown>).has_children = downstreamDocNos.has(docNo);
      const dDelivered = deliveredTotal.get(docNo) ?? 0;
      const dRemaining = remainingTotal.get(docNo) ?? 0;
      (r as Record<string, unknown>).delivery_state =
        dDelivered <= 0 ? 'none' : dRemaining > 0 ? 'partial' : 'full';
      (r as Record<string, unknown>).shipped_qty = dDelivered;
      (r as Record<string, unknown>).deliverable_qty = dDelivered + dRemaining;
      (r as Record<string, unknown>).lifecycle_state = lifecycleByDoc.get(docNo) ?? 'none';
      (r as Record<string, unknown>).current_doc_no = currentByDoc.get(docNo) ?? (docNo || null);
      (r as Record<string, unknown>).do_nos = doNosBySo.get(docNo) ?? [];
      Object.assign(r as Record<string, unknown>, downRefsBySo.get(docNo) ?? NO_SO_DOWNSTREAM_REFS, migratedGate(docNo));
      (r as Record<string, unknown>).has_undelivered = hasUndelivered.has(docNo);
      const readiness = readinessByDoc.get(docNo);
      (r as Record<string, unknown>).stock_remark = readiness?.stockRemark ?? '';
      (r as Record<string, unknown>).is_main_ready = readiness?.isMainReady ?? false;
      const primaryWh = firstWarehouseByDoc.get(docNo) ?? null;
      (r as Record<string, unknown>).warehouse_name = primaryWh ? (whName.get(primaryWh) ?? null) : null;
      const effectiveDD = (amendedDDByDoc.get(docNo) ?? null) ?? ((r as Record<string, unknown>).customer_delivery_date as string | null ?? null);
      (r as Record<string, unknown>).planning_state = derivePlanningState({
        storedOverride: overrideByDoc.get(docNo) ?? null,
        status: (r as Record<string, unknown>).status as string | null,
        readiness: { isShipReady: readiness?.isShipReady ?? false },
        delivered: dDelivered,
        remaining: dRemaining,
        effectiveDD,
        amendedDD: amendedDDByDoc.get(docNo) ?? null,
        salesExemptionExpiry: soExemptionExpiryOf({
          sales_exemption_expiry: (r as Record<string, unknown>).sales_exemption_expiry as string | null ?? null,
          ac_sales_exemption_expiry: acExemptionByDoc.get(docNo) ?? null,
          customer_delivery_date: (r as Record<string, unknown>).customer_delivery_date as string | null ?? null,
        }),
        today: planningToday,
      });
      const firstItem = firstItemBrandingByDoc.get(docNo);
      (r as Record<string, unknown>).first_item_category = firstItem?.category ?? null;
      (r as Record<string, unknown>).first_item_branding = firstItem?.branding ?? null;
      const pm = paymentMethods.get(docNo);
      (r as Record<string, unknown>).payment_methods_summary = pm ? [...pm].sort().join(' + ') : '';
      (r as Record<string, unknown>).approval_codes_summary = approvalCodes.get(docNo) ?? '';
      (r as Record<string, unknown>).ac_sales_exemption_expiry = acExemptionByDoc.get(docNo) ?? null;
      (r as Record<string, unknown>).reopenable = soReopenable((r as Record<string, unknown>).status as string | null, linkedAcByDoc.get(docNo) ?? null);
      if (!perGroup) {
        (r as Record<string, unknown>).ready_categories = [];
        (r as Record<string, unknown>).is_fully_ready = false;
        continue;
      }
      const ready: string[] = [];
      let allReady = true;
      for (const [grp, cell] of perGroup) {
        if (cell.total > 0 && cell.ready === cell.total) ready.push(grp);
        else allReady = false;
      }
      (r as Record<string, unknown>).ready_categories = ready;
      (r as Record<string, unknown>).is_fully_ready = allReady && perGroup.size > 0;
    }
  }

  if (!canViewScmFinance(c)) {
    for (const r of rows) {
      for (const k of SO_FINANCE_KEYS) delete (r as Record<string, unknown>)[k];
    }
  }
  return { deliverable, base: baseRes, warehouses: whRes };
}
