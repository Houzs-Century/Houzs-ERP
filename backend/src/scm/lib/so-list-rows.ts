// ----------------------------------------------------------------------------
// so-list-rows — the Sales Order LIST's per-row fields, built for a page of
// header rows the list's own filter already matched.
//
// Lifted VERBATIM out of GET /mfg-sales-orders (routes/mfg-sales-orders.ts) on
// 2026-09-15 so the list page and the export (GET /mfg-sales-orders/export/rows)
// produce the identical row shape: a screen cell and a file cell come from the
// same reads. The comments below are the handler's own, moved with the code.
//
// It MUTATES `rows` in place, exactly as the handler did, and ends with the
// finance gate (cost / margin / per-category subtotals + deposit stripped for a
// caller who is not a finance viewer). The reads are sized for ONE page of rows
// (the list caps a page at 100): several per-doc reads send the page's doc
// numbers in one request, so a caller with more rows passes them in pages.
// ----------------------------------------------------------------------------

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

export type SoListRow = { doc_no?: string } & Record<string, unknown>;
export type SoDeliverableMap = Awaited<ReturnType<typeof soDeliverableRemaining>>;

export async function buildSoListRows(
  sb: Variables['supabase'],
  c: Context<{ Bindings: Env; Variables: Variables }>,
  rows: SoListRow[],
): Promise<SoDeliverableMap | null> {
  /* Returned so the line attach (lib/so-list-lines.ts) reuses the delivered /
     returned / remaining reading this builder already made, instead of a second
     identical read. */
  let deliverable: SoDeliverableMap | null = null;
  const docNos = rows.map((r) => r.doc_no).filter((x): x is string => !!x);
  if (docNos.length > 0) {
    /* PERF: every per-doc_no enrichment read below only needs `docNos`, so they
       are independent of one another AND of the item/catalog chain. Launch them
       all up-front so they run as ONE concurrent wave instead of ~6 serial
       round-trips. supabase-js builders are lazy (the request fires on await/
       then), so each is wrapped in an immediately-invoked async thunk to kick it
       off now; each is awaited at its original use-site below, so results and
       error propagation are unchanged. This was the SO list's dominant cost
       (~390ms desktop / ~650ms mobile, almost all serial DB latency). */
    /* chunkIn on every `docNos` read below — the LEGACY arm reads `.limit(500)`, so each URL carried 500 doc numbers (~9.5KB). All feed doc-keyed maps. */
    const payRowsProm = (async () =>
      (await chunkIn(docNos, (batch, from, to) => sb.from('mfg_sales_order_payments')
        .select('so_doc_no, method, online_type, approval_code, paid_at, created_at').in('so_doc_no', batch).order('so_doc_no').range(from, to))).data)();
    // DO No. rides this read rather than a query of its own — the list's cost
    // is round-trips, not rows (see so-delivery-order-nos.ts).
    const downstreamProm = Promise.all([
      chunkIn(docNos, (batch, from, to) => sb.from('delivery_orders').select('id, so_doc_no, do_number, do_date, created_at').in('so_doc_no', batch).neq('status', 'CANCELLED').order('so_doc_no').range(from, to)),
      chunkIn(docNos, (batch, from, to) => sb.from('sales_invoices').select('id, so_doc_no, invoice_number').in('so_doc_no', batch).neq('status', 'CANCELLED').order('so_doc_no').range(from, to)),
    ]);
    const deliverableProm = soDeliverableRemaining(sb, docNos);
    const lifecycleProm = Promise.all([
      computeSoLifecycle(sb, docNos),
      soCurrentDocNo(sb, docNos),
    ]);
    const whRowsProm = (async () =>
      (await sb.from('warehouses').select('id, code, name')).data ?? [])();
    const baseRowsProm = (async () =>
      (await chunkIn(docNos, (batch, from, to) => sb.from('mfg_sales_orders')
        .select('doc_no, delivery_state, amended_delivery_date, linked_ac_docno').in('doc_no', batch).order('doc_no').range(from, to))).data)();
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

    /* Order deterministically so the FIRST line per doc_no is the earliest
       one created (matches the detail endpoint's `.order('created_at')`). We
       add `branding`, `item_code` and `created_at` to the select: branding is
       the mattress brand source for the first-item rule below; item_code lets
       us fall back to mfg_products.branding when a mattress line's own branding
       is blank; created_at drives the first-line pick. */
    /* chunkIn, not paginateAll: the latter bounded the ROWS and re-sent all 500 doc numbers
       in every page's URL. Splitting on doc_no keeps each SO's lines together and ordered
       as before, so the "first line per doc_no" rule below picks the same row. */
    const { data: itemRows } = await chunkIn<{ id: string; doc_no: string; item_group: string | null; stock_status: string | null; cancelled: boolean; branding: string | null; item_code: string | null; warehouse_id: string | null; created_at: string; qty: number | null; allocated_batch_no: string | null }>(docNos, (batch, from, to) => sb
      .from('mfg_sales_order_items')
      // id / qty / allocated_batch_no ride along for the source-PO union below
      // (per-line shipped trace + READY projection — the drill's exact inputs).
      .select('id, doc_no, item_group, stock_status, cancelled, branding, item_code, warehouse_id, created_at, qty, allocated_batch_no')
      .in('doc_no', batch)
      .eq('cancelled', false)
      .order('doc_no')
      .order('line_no', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(from, to));
    /* Per-line SHIPPED source trace for the whole page — the same resolver call
       the drill makes per SO, batched once (chunked internally). Fired now so it
       overlaps the remaining enrichment reads; awaited at the union below. */
    const shippedTraceProm = soLineShippedSources(sb, itemRows.map((it) => it.id));
    const agg = new Map<string, Map<string, { total: number; ready: number }>>();
    /* Branding auto-derive (Commander 2026-05-28, refined PR #266): the SO list
       grid derives its Branding pill from the SO's FIRST line item — no longer
       "Mixed" when categories differ. We track per doc_no:
         · item_categories     — DISTINCT normalized categories (kept for back-compat)
         · first_item_category — normalized category of the earliest-created line
         · first_item_branding — that line's own `branding` text (the mattress brand)
       The header revenue columns merge mattress + sofa into one bucket, so the
       grid can't tell SOFA from MATTRESS at the header level — hence this
       per-line first-item read (from the same fetch already running for stock
       status). The UI maps these through shared/so-branding-label (owner
       2026-08-18): SOFA → the COMPANY's house sofa brand ("ZANOTTI" for Houzs,
       "2990s Sofa" for 2990 — the line's own text is not consulted), BEDFRAME →
       "Bedframe", MATTRESS → first_item_branding, which is the SKU's brand
       (resolved SKU-first below), falling back to "Mattress" when the SKU
       carries none; everything else names its category. */
    const cats = new Map<string, Set<string>>();
    /* Primary warehouse per SO — the FIRST non-null line warehouse_id (mirrors
       the Delivery Planning board's primaryWh = warehouseIds[0]). Drives the
       mobile Orders-list card's warehouse_name. */
    const firstWarehouseByDoc = new Map<string, string>();
    const allCodes = new Set<string>();
    const normCategory = (raw: string): string => {
      const g = (raw ?? '').trim().toUpperCase();
      if (g.includes('BEDFRAME')) return 'BEDFRAME';
      if (g.includes('SOFA'))     return 'SOFA';
      if (g.includes('MATTRESS')) return 'MATTRESS';
      if (g.includes('ACCESSOR')) return 'ACCESSORY';
      if (g.includes('SERVICE')) return 'SERVICE'; // SO-SKU spec P2 — synced with normCat below
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
      /* First non-null line warehouse per doc (rows are line_no/created_at
         ordered) — the SO's primary warehouse for the mobile card. */
      if (it.warehouse_id && !firstWarehouseByDoc.has(it.doc_no)) {
        firstWarehouseByDoc.set(it.doc_no, it.warehouse_id);
      }
    }

    /* Resolve each line's category from the CATALOG (mfg_products.category),
       not just the line's free-text item_group. A sofa module line saved with
       item_group 'others' (or a leading SERVICE/delivery line) must not blank
       the SO's Branding pill — so we (a) trust the catalog category and (b) pick
       the first MAIN line (sofa/bedframe/mattress) as the SO's representative,
       falling back to the earliest line when there is none. Batch-fetch the
       catalog by the codes actually in view (bounded .in, chunked — never the
       whole table) so this can't hit the PostgREST row cap. The same map also
       supplies the mattress-brand fallback (mfg_products.branding). */
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
    /* First-item branding inputs — rep MAIN line (catalog-resolved), else the
       earliest line; mattress SKU-first; bedframe-only -> 'BEDFRAME' (Commander
       2026-07-16). ONE home since 2026-09-14 so the header-branding backfill
       writes exactly what this list shows: scm/lib/so-list-first-item-branding.ts. */
    const firstItemBrandingByDoc = deriveListFirstItemBranding(
      itemRows as unknown as ListBrandingLine[],
      productCategory,
      productBranding,
    );

    /* Commander 2026-05-29 (#19) — Payment Method column summarises the
       payments LEDGER, not just the header's single payment_method field. A
       SO can be settled across several methods (e.g. a cash deposit + a card
       balance), so we collect the DISTINCT method labels per doc_no and join
       them with " + " (→ "Cash + Card"). Label rules mirror the payment form
       cascade: cash→"Cash"; merchant→"Card"; transfer→its online_type
       (Bank Transfer / TNG / Cheque / DuitNow) when set, else "Transfer";
       installment→"Installment" (2026-06-06 unify — these rows were
       silently dropped from the summary before).
       One cheap batched read over the same doc_no set already in play. */
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

    /* Tier 2 downstream-lock — one extra batched read per doc set: pull every
       non-cancelled DO/SI that points back to a listed SO and mark has_children
       on the row. The list grid uses this to hide Edit / Cancel from SOs that
       are downstream-locked (mirrors computeGrnFlags in lib/grn-consumption-flags). */
    const [doRowsRes, siRowsRes] = await downstreamProm;
    const doNosBySo = doNosBySalesOrder(doRowsRes.data as unknown as DeliveryOrderNoRow[]);
    const downRefsBySo = soDownstreamRefs(doRowsRes.data as unknown as DeliveryOrderNoRow[], siRowsRes.data); // do_refs + si_refs: the row menu prints by ADDRESS, not by number
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
    /* FIRST PAINT uses the STORED stock_status alone (`null` live coverage —
       so-line-effective-stock.ts's fail-soft path: the stored value stands).
       The MRP-corrected verdict — which can flip a stale-stored line to READY,
       the 2026-08-17 union — arrives with the deferred enrichment fetch and the
       client overlays stock_remark / is_main_ready / planning_state then. Not
       running computeMrp here is the whole point of the deferral. */
    const readinessByDoc = new Map<string, ReturnType<typeof summariseReadiness>>();
    /* Third argument null: the list first-paint reads the payment-totals VIEW
       (frozen column set, no processing_date) — and with null coverage the
       promotion arm cannot fire anyway, so "cannot say" is exact.
       FOURTH argument null, and typed rather than omitted (the parameter is
       required): the first paint deliberately runs no extra reads, and it does
       not need this one — the STORED status it rolls up was written by the
       allocator, which applies the non-selling rule at source. The enrichment
       fetch a beat later is where the live promotion can fire, and THAT call
       passes the real set. What is given up here is only the cover for a stale
       stored READY, for the few hundred ms until the enrichment lands. */
    const linesByDoc = readinessLinesByDoc(itemRows, null, null, null);
    attachLineCategories(linesByDoc.values(), productCategory);
    for (const [docNo, ls] of linesByDoc) readinessByDoc.set(docNo, summariseReadiness(ls));

    /* "Has undelivered qty" per SO (Wei Siang 2026-05-30) — drives the Issue
       Delivery Order menu gate. Recomputed LIVE (remaining = qty − delivered +
       returned, cancelled DOs excluded) by the same helper the line-level
       picker uses, so it re-opens after a DO is cancelled / a DO line is
       deleted and closes once every line is fully delivered. Replaces the old
       status-only gate that hid the action at SHIPPED/DELIVERED. */
    const hasUndelivered = new Set<string>();
    /* Per-SO delivery progress — the verdict AND the numbers, §0.4b. */
    const deliveredTotal = new Map<string, number>();
    const remainingTotal = new Map<string, number>();
    /* Fully-shipped LINE ids — the union below suppresses READY chips for them,
       exactly as the drill's SoSourceChips does. */
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

    /* Per-SO status badge driver — "latest event wins" across DO / SI / DR
       (Wei Siang 2026-05-31). 'none' falls back to the stored status. */
    const [lifecycleByDoc, currentByDoc] = await lifecycleProm;

    /* Warehouse label map (id → label) for the Orders-list `warehouse_name`.
       Small master, unpaginated. This map used to be the ONE name-first label
       in the codebase, so the same warehouse read "BALAKONG WAREHOUSE" here and
       "KL WAREHOUSE" on every document — it now shares warehouseLabel() with
       them, which also makes a correctly-derived SO's label identical to its
       stored sales_location text. */
    const whName = new Map<string, string>();
    {
      const whRows = await whRowsProm;
      for (const w of (whRows ?? []) as Array<{ id: string; code: string | null; name: string | null }>) {
        const label = warehouseLabel(w);
        if (label) whName.set(w.id, label);
      }
    }

    /* Planning-state inputs that live ONLY on the BASE table (NOT in the
       payment-totals VIEW backing this list): the manual delivery_state override
       and amended_delivery_date. Per the VIEW-TRAP CoE these post-view columns
       must NEVER be added to LIST_COLS/HEADER (they 500 the list), so read them
       straight off mfg_sales_orders keyed by doc_no. customer_delivery_date +
       status are already on the view rows (`r`). */
    const overrideByDoc = new Map<string, string | null>();
    const amendedDDByDoc = new Map<string, string | null>();
    {
      const baseRows = await baseRowsProm;
      for (const b of baseRows as unknown as Array<{ doc_no: string | null; delivery_state?: string | null; deliveryState?: string | null; amended_delivery_date?: string | null; amendedDeliveryDate?: string | null }>) {
        if (!b.doc_no) continue;
        overrideByDoc.set(b.doc_no, b.deliveryState ?? b.delivery_state ?? null);
        amendedDDByDoc.set(b.doc_no, b.amendedDeliveryDate ?? b.amended_delivery_date ?? null);
      }
    }
    const planningToday = todayMyt();

    // PO No. — SO doc_no → system PO numbers it was converted into (see wave).
    const [convertedPoByDoc, migratedGate] = await Promise.all([convertedPoProm, migratedSoListGate(c, await baseRowsProm)]);

    /* Source-PO union per SO (defect 2026-08-02-A): SHIPPED arm only on this
       path — shipped trace from `shippedTraceProm` (cheap real-batch reads),
       run through the SAME pure union the drill uses with an EMPTY ready map.
       The READY arm (`soLineReadySourcePos`, which needs the global MRP run)
       arrives via GET /mfg-sales-orders/list-mrp-enrichment and the client
       unions its chips into this column. Union(shipped-only, ready-only) per
       doc equals the old combined union (set union is associative), so the
       final displayed chips are unchanged; they just fill in a beat later. */
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
      /* Union of per-line source-PO chips (shipped ∪ READY projection) — the
         drill's exact visible set, rolled up per SO.
         C16 CONTRACT: source_po_union / source_po_adj / stock_remark /
         is_main_ready / planning_state are the MRP-DERIVED fields emitted here
         as stored-status placeholders and HEALED by GET /list-mrp-enrichment. If
         you add another field whose value depends on the MRP allocation, add it
         to the enrichment path too — MRP_DERIVED_LIST_FIELD_MAP
         (frontend/src/lib/soListEnrichment.ts) + SO_LIST_MRP_ENRICHMENT_KEYS
         (scm/lib/so-list-mrp-enrichment.ts); the parity tests fail otherwise. */
      (r as Record<string, unknown>).source_po_union = sourceUnionByDoc.get(docNo)?.pos ?? [];
      (r as Record<string, unknown>).source_po_adj = sourceUnionByDoc.get(docNo)?.adj ?? false;
      (r as Record<string, unknown>).has_children = downstreamDocNos.has(docNo);
      const dDelivered = deliveredTotal.get(docNo) ?? 0;
      const dRemaining = remainingTotal.get(docNo) ?? 0;
      (r as Record<string, unknown>).delivery_state =
        dDelivered <= 0 ? 'none' : dRemaining > 0 ? 'partial' : 'full';
      (r as Record<string, unknown>).shipped_qty = dDelivered;          // §0.4b
      (r as Record<string, unknown>).deliverable_qty = dDelivered + dRemaining;
      (r as Record<string, unknown>).lifecycle_state = lifecycleByDoc.get(docNo) ?? 'none';
      (r as Record<string, unknown>).current_doc_no = currentByDoc.get(docNo) ?? (docNo || null);
      (r as Record<string, unknown>).do_nos = doNosBySo.get(docNo) ?? [];
      Object.assign(r as Record<string, unknown>, downRefsBySo.get(docNo) ?? NO_SO_DOWNSTREAM_REFS, migratedGate(docNo));
      (r as Record<string, unknown>).has_undelivered = hasUndelivered.has(docNo);
      const readiness = readinessByDoc.get(docNo);
      (r as Record<string, unknown>).stock_remark = readiness?.stockRemark ?? '';
      (r as Record<string, unknown>).is_main_ready = readiness?.isMainReady ?? false;
      /* Orders-list card fields (snake_case, dual-read by the FE):
         · warehouse_name  — the SO's primary line warehouse label (null until
           set). Desktop AND mobile both render the Location column from this,
           falling back to the free-text sales_location snapshot only when no
           line carries a warehouse.
         · planning_state  — the 4-state Delivery-Planning status, derived from the
           SAME shared helper the board uses. delivery_state (above) is the DO-
           progress none/partial/full field — this is the ORTHOGONAL planning
           status; both are emitted. */
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
        today: planningToday,
      });
      /* First-item branding source (PR #266; catalog-resolved + mains-first). */
      const firstItem = firstItemBrandingByDoc.get(docNo);
      (r as Record<string, unknown>).first_item_category = firstItem?.category ?? null;
      (r as Record<string, unknown>).first_item_branding = firstItem?.branding ?? null;
      /* #19 — distinct ledger payment methods, sorted + joined ("Cash + Card").
         Empty string when no payments recorded yet (UI falls back to the
         header payment_method field). */
      const pm = paymentMethods.get(docNo);
      (r as Record<string, unknown>).payment_methods_summary = pm ? [...pm].sort().join(' + ') : '';
      (r as Record<string, unknown>).approval_codes_summary = approvalCodes.get(docNo) ?? '';
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

  /* Finance gate — strip cost / margin / per-category subtotals + deposit from
     every row unless the caller is a finance-viewer. The KPI aggregates above
     read local_total / balance / paid only, so they are unaffected. */
  if (!canViewScmFinance(c)) {
    for (const r of rows) {
      for (const k of SO_FINANCE_KEYS) delete (r as Record<string, unknown>)[k];
    }
  }
  return deliverable;
}
