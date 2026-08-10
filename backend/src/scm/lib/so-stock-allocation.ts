// ----------------------------------------------------------------------------
// so-stock-allocation — auto-allocate live inventory to PENDING SO lines
// (Commander 2026-05-30, B2C READY-when-stock-on-hand model).
//
// B2C reality: customer orders a mattress at the showroom. If it's on the
// shelf — SO is "ready", call customer to schedule. If not — wait for GRN.
// The operator should NOT have to manually flip stock_status — the system
// derives it from live inventory_balances + outstanding SO claims.
//
// Algorithm — runs against ALL active SO lines, not just one SO, because
// allocating to one SO might "use up" stock that another SO wanted:
//
//   1. Pull every non-cancelled, non-completed SO line (PENDING + READY)
//      with deliverable_remaining > 0. ORDER BY sales-order created_at ASC
//      so older orders claim stock first (FIFO allocation).
//   2. Pull live inventory_balances summed across ALL warehouses per
//      (product_code, variant_key) bucket. B2C: operator chooses warehouse
//      at DO time; we just need to know "is it somewhere".
//   3. Walk lines in FIFO order. For each line, deduct its deliverable
//      remaining from the bucket's remaining qty:
//        if bucket has enough → mark line READY, decrement bucket
//        if not                → mark line PENDING
//   4. UPDATE stock_status only on lines that changed (idempotent on stable
//      stock + line state).
//   5. For each touched SO: re-aggregate header status.
//        all live lines READY + currently CONFIRMED / IN_PRODUCTION → READY_TO_SHIP
//        any live line PENDING + currently READY_TO_SHIP            → CONFIRMED
//
// Best-effort: never throws. Returns counts so callers can log without
// rolling back a GRN/SO post (audit-DLQ pattern matching writeMovements).
// ----------------------------------------------------------------------------

import { computeVariantKey, isServiceLine, type VariantAttrs } from '../shared';
import { summariseReadiness } from './so-readiness';
import { loadSofaBatchStock, findCoveringBatch, claimSofaBatch } from './sofa-set-coverage';
import { paginateAll, chunkIn } from './paginate-all';
import { recordSoAudit } from './so-audit';
import { advanceSoGeneration } from './so-generation';

export type AllocationResult = {
  ok: boolean;
  linesFlipped: number;
  ordersAdvanced: number;
  ordersRegressed: number;
  reason?: string;
  /* Doc numbers whose HEADER status could not be advanced/regressed this pass
     because a human editor holds the SO's edit lease (or the header moved under
     us). See the skip-and-continue note at the header-transition block: these
     are NOT failures. The line-level projection for these orders is already
     committed; only the derived header status is pending. The caller re-queues
     the job so a later sweep finishes them. */
  deferredDocNos?: string[];
};

/**
 * Resolve READY/PENDING for every active SO line based on live inventory.
 * Idempotent — running twice on the same DB state is a no-op.
 *
 * `scopeToDocNo` (optional): when provided, only touches lines on that one SO
 * + skips the global FIFO walk (used by POST /mfg-sales-orders to avoid the
 * full sweep when creating a single order — but still respects older orders'
 * claims because we deduct ALL outstanding qty from the bucket first).
 */
const ALLOCATION_LOCK_ROW = 'GLOBAL';
const ALLOCATION_LOCK_MS = 15 * 60_000;

export async function recomputeSoStockAllocation(
  sb: any,
  scopeToDocNo?: string,
): Promise<AllocationResult> {
  /* Edge #F — single-flight guard. PostgREST does not retain one PostgreSQL
     session across the recompute's reads/writes, so a session advisory lock is
     not a lock here. Claim the durable singleton lease row instead. Missing
     migration or a lock read failure fails closed before projection writes. */
  let lockHeld = false;
  const lockToken = crypto.randomUUID();
  try {
    const now = new Date().toISOString();
    const lockedUntil = new Date(Date.now() + ALLOCATION_LOCK_MS).toISOString();
    const { data: claimed, error: lockError } = await sb
      .from('stock_allocation_recompute_lock')
      .update({ locked_by: lockToken, locked_until: lockedUntil })
      .eq('lock_key', ALLOCATION_LOCK_ROW)
      .or(`locked_by.is.null,locked_until.lt.${now}`)
      .select('lock_key')
      .maybeSingle();
    if (lockError) {
      return {
        ok: false, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0,
        reason: `allocation lock unavailable: ${lockError.message}`,
      };
    }
    if (!claimed) {
      return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0, reason: 'another_recompute_in_progress' };
    }
    lockHeld = true;
  } catch (error) {
    return {
      ok: false, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0,
      reason: `allocation lock unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    /* 1. All non-cancelled, non-completed SOs. Allocation priority:
            a) customer_delivery_date ASC NULLS LAST  — earlier delivery wins
            b) created_at ASC  — tiebreaker so order is deterministic */
    // Page through — PostgREST's default 1000-row cap would truncate the active
    // SO set, silently DROPPING orders from allocation (their lines never flip).
    const { data: orderRows, error: orderError } = await paginateAll<{ doc_no: string; status: string; created_at: string; customer_delivery_date: string | null; company_id: number | null; proceeded_at: string | null }>((from, to) => sb
      .from('mfg_sales_orders')
      .select('doc_no, status, created_at, customer_delivery_date, company_id, proceeded_at')
      .not('status', 'in', '(CANCELLED,CLOSED,SHIPPED,DELIVERED,INVOICED,DRAFT)')
      .order('customer_delivery_date',  { ascending: true, nullsFirst: false })
      .order('created_at',              { ascending: true })
      .range(from, to));
    if (orderError) throw new Error(`allocation order load failed: ${orderError.message}`);
    const orders = (orderRows ?? []) as Array<{
      doc_no: string; status: string; created_at: string;
      customer_delivery_date: string | null; company_id: number | null;
      proceeded_at: string | null;
    }>;
    if (orders.length === 0) return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };
    const orderByDoc = new Map(orders.map((o) => [o.doc_no, o]));
    /* Processing-date allocation gate (owner 2026-08-10, go-live): nothing is
       prepared before the order is proceeded, so an SO with NO Processing Date
       must not claim stock nor show READY TO SHIP ("它明明都没有 Processing
       Date, 干嘛分配呢" … "2990 跟整套系统都是这样子的:有 processing date 才来
       分配"). Shipped company-1-only first; flipped GLOBAL after measuring the
       blast radius (check-cutover-metrics 2026-08-10: company 1: 15, company 2:
       5 READY_TO_SHIP-without-processing-date — both regress to CONFIRMED on
       the next recompute, which is the owner's intent). Gated lines still walk
       (so an already-READY line regresses on this same run) but are forced
       PENDING and never consume a bucket or a sofa batch. */
    const allocGated = new Set(
      orders.filter((o) => !o.proceeded_at).map((o) => o.doc_no),
    );

    // 2. Non-cancelled lines on those SOs. Pull qty + variant fields so we
    //    can compute variant_key and the bucket.
    const docNos = orders.map((o) => o.doc_no);
    // chunkIn — docNos can exceed 1000 (un-truncated SO set) and lines across
    // them can exceed the 1000-row cap; batch the .in() and page each batch so
    // no SO line is dropped from the allocation walk.
    const { data: lineRows, error: lineError } = await chunkIn(docNos, (batch, from, to) => sb
      .from('mfg_sales_order_items')
      .select('id, doc_no, item_code, item_group, variants, qty, warehouse_id, stock_status, stock_qty_ready, cancelled')
      .in('doc_no', batch)
      .eq('cancelled', false)
      .range(from, to));
    if (lineError) throw new Error(`allocation line load failed: ${lineError.message}`);
    const lines = (lineRows ?? []) as Array<{
      id: string; doc_no: string; item_code: string; item_group: string | null;
      variants: VariantAttrs | null; qty: number; warehouse_id: string | null;
      stock_status: string; stock_qty_ready: number | null;
    }>;
    if (lines.length === 0) return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };

    /* Stage 3 (Commander 2026-05-31) — SOFA is colour-matched and ships as a
       whole SET from ONE batch (= source PO / one dye lot). Sofa lines are NOT
       allocated per-line off the qty bucket like everything else; instead the
       SO's whole sofa set is matched atomically to ONE batch whose component
       multiset EXACTLY equals the set's need. Identify sofa lines via the
       product catalog's category so the per-line walk below can skip them.
       BEDFRAME is by-SKU (Commander 2026-05-31) — it stays on plain per-line
       FIFO and is NOT batched. */
    // Page through — mfg_products is >1000 rows (1141 live), so the default cap
    // would DROP catalog rows → SOFA/SERVICE codes past row 1000 misclassified.
    /* DELIBERATELY NOT company-scoped, unlike every other by-code product read
       (2026-08-01 audit). This job recomputes allocation for EVERY SO across
       both companies — it has no single active company, and its 34 callers
       include crons and post-write hooks with no request context. Threading a
       company here would mean either 34 signature changes or an arbitrary
       choice of "which company" for a cross-company job.
       Instead the read is made HONEST: `code` is not unique, so a code present
       in both companies yields two rows, and the sets below take their union.
       That is correct while the two rows agree on category (true for all 17
       colliding codes on production: CODY/FENRIR/JAGER bedframes + 2 mattress
       codes) and WRONG the moment they don't — so a disagreement is logged
       loudly rather than silently deciding whether a line is a batched sofa. */
    const { data: catRows, error: categoryError } = await paginateAll<{ code: string; category: string | null }>((from, to) =>
      sb.from('mfg_products').select('code, category').order('code').range(from, to));
    if (categoryError) throw new Error(`allocation product load failed: ${categoryError.message}`);
    const batchedCodes = new Set<string>();
    /* P1 SO-SKU spec — SERVICE SKUs (delivery fee / dispose / lift) are not
       goods. Collect their codes here (same catalog pull) so the needs walk
       below can skip them by the authoritative category signal too. */
    const serviceCodes = new Set<string>();
    const catByCode = new Map<string, string>();
    const conflicting: string[] = [];
    for (const p of (catRows ?? []) as Array<{ code: string; category: string | null }>) {
      const cat = (p.category ?? '').toUpperCase();
      const seen = catByCode.get(p.code);
      if (seen !== undefined && seen !== cat) conflicting.push(`${p.code}(${seen}/${cat})`);
      else catByCode.set(p.code, cat);
      if (cat === 'SOFA') batchedCodes.add(p.code);
      else if (cat === 'SERVICE') serviceCodes.add(p.code);
    }
    if (conflicting.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[so-allocation] mfg_products codes disagree on category across companies: ${conflicting.join(', ')} — sofa/service classification is a union and may be wrong for these lines`);
    }
    const isBatchedLine = (item_code: string, item_group: string | null) =>
      batchedCodes.has(item_code) || (item_group ?? '').toUpperCase().includes('SOFA');

    /* Read each sofa line's currently-locked batch so we can tell what changed.
       Forward-compat (migration 0121): allocated_batch_no may not exist yet —
       read it best-effort; on any error treat every line's batch as unset. */
    const curBatchByLine = new Map<string, string | null>();
    const sofaLineIds = lines.filter((l) => isBatchedLine(l.item_code, l.item_group)).map((l) => l.id);
    if (sofaLineIds.length > 0) {
      try {
        const { data: bRows, error: bErr } = await chunkIn<{ id: string; allocated_batch_no: string | null }>(sofaLineIds, (batch, from, to) => sb
          .from('mfg_sales_order_items')
          .select('id, allocated_batch_no')
          .in('id', batch)
          .range(from, to));
        if (!bErr) {
          for (const r of (bRows ?? []) as Array<{ id: string; allocated_batch_no: string | null }>) {
            curBatchByLine.set(r.id, r.allocated_batch_no ?? null);
          }
        } else if (!/allocated_batch_no|column .* does not exist/i.test(bErr.message ?? '')) {
          throw new Error(`allocation sofa-batch binding load failed: ${bErr.message}`);
        }
      } catch (error) {
        if (!/allocated_batch_no|column .* does not exist/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }

    // 3. Compute deliverable_remaining per line — = qty − Σ delivered (via
    //    non-cancelled DOs) + Σ returned (via non-cancelled DRs). Same formula
    //    as soDeliverableRemaining but inlined since we already have line ids.
    const lineIds = lines.map((l) => l.id);
    // chunkIn — lineIds can exceed 1000 (un-truncated SO set); batch + page so
    // delivered qty isn't understated by a dropped DO line.
    const { data: doLines, error: doLineError } = await chunkIn<{ id: string; so_item_id: string | null; qty: number; delivery_order_id: string }>(lineIds, (batch, from, to) => sb
      .from('delivery_order_items')
      .select('id, so_item_id, qty, delivery_order_id')
      .in('so_item_id', batch)
      .range(from, to));
    if (doLineError) throw new Error(`allocation DO-line load failed: ${doLineError.message}`);
    const doLineRows = (doLines ?? []) as Array<{ id: string; so_item_id: string | null; qty: number; delivery_order_id: string }>;
    const doIds = [...new Set(doLineRows.map((l) => l.delivery_order_id).filter(Boolean))];
    const activeDoIds = new Set<string>();
    const doLineToSoItem = new Map<string, string>();
    if (doIds.length > 0) {
      const { data: dos, error: doError } = await chunkIn<{ id: string; status: string | null }>(doIds, (batch, from, to) =>
        sb.from('delivery_orders').select('id, status').in('id', batch).range(from, to));
      if (doError) throw new Error(`allocation DO load failed: ${doError.message}`);
      for (const d of (dos ?? []) as Array<{ id: string; status: string | null }>) {
        /* LEAK GUARD (DRAFT) — audit D5, 2026-08-01: a DRAFT DO has NOT
           shipped, so it must not count as delivered here. This inline sum
           used to exclude only CANCELLED while its source of truth
           (soDeliverableRemaining, delivery-orders-mfg.ts) and the DO->SO
           delivery sync both exclude CANCELLED + DRAFT — so a draft DO
           quietly shrank a line's remaining, starved it of allocation, and
           MRP (which uses soDeliverableRemaining) disagreed with this job
           about the same line. One rule everywhere now. */
        const st = (d.status ?? '').toUpperCase();
        if (st !== 'CANCELLED' && st !== 'DRAFT') activeDoIds.add(d.id);
      }
    }
    const deliveredBySoItem = new Map<string, number>();
    for (const l of doLineRows) {
      if (!l.so_item_id || !activeDoIds.has(l.delivery_order_id)) continue;
      doLineToSoItem.set(l.id, l.so_item_id);
      deliveredBySoItem.set(l.so_item_id, (deliveredBySoItem.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
    }
    const returnedBySoItem = new Map<string, number>();
    const activeDoLineIds = [...doLineToSoItem.keys()];
    if (activeDoLineIds.length > 0) {
      const { data: drLines, error: drLineError } = await chunkIn<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>(activeDoLineIds, (batch, from, to) => sb
        .from('delivery_return_items')
        .select('do_item_id, qty_returned, delivery_return_id')
        .in('do_item_id', batch)
        .range(from, to));
      if (drLineError) throw new Error(`allocation return-line load failed: ${drLineError.message}`);
      const drLineRows = (drLines ?? []) as Array<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>;
      const drIds = [...new Set(drLineRows.map((l) => l.delivery_return_id).filter(Boolean))];
      const activeDrIds = new Set<string>();
      if (drIds.length > 0) {
        const { data: drs, error: drError } = await chunkIn<{ id: string; status: string | null }>(drIds, (batch, from, to) =>
          sb.from('delivery_returns').select('id, status').in('id', batch).range(from, to));
        if (drError) throw new Error(`allocation return load failed: ${drError.message}`);
        for (const d of (drs ?? []) as Array<{ id: string; status: string | null }>) {
          if ((d.status ?? '').toUpperCase() !== 'CANCELLED') activeDrIds.add(d.id);
        }
      }
      for (const l of drLineRows) {
        if (!l.do_item_id || !activeDrIds.has(l.delivery_return_id)) continue;
        const soItemId = doLineToSoItem.get(l.do_item_id);
        if (!soItemId) continue;
        returnedBySoItem.set(soItemId, (returnedBySoItem.get(soItemId) ?? 0) + Number(l.qty_returned ?? 0));
      }
    }

    /* 4. Build per-line allocation request. Commander 2026-05-31 — the LINE's
          own warehouse_id (migration 0118) scopes the bucket key. MRP + auto-
          allocation run strictly PER-WAREHOUSE: 2990 can't pull stock across
          warehouses, so a KL line draws only KL stock, a PJ line only PJ. A
          line with NO warehouse bound yet (NULL) gets its own 'NOWH' bucket —
          inventory always carries a warehouse_id, so a NULL-warehouse line sees
          no stock and stays PENDING until a warehouse is assigned. Drop lines
          with deliverable_remaining ≤ 0 (already shipped). curReady is the
          line's existing stock_qty_ready — used to compute "did the value
          change". */
    const WH_NONE = 'NOWH';
    type LineNeed = { id: string; doc_no: string; bucket: string; whId: string | null; need: number; current: string; curReady: number };
    const needs: LineNeed[] = [];
    /* Sofa lines walk the batch-bound path instead of the per-line bucket
       fill. Keep the SKU + variant + remaining so we can check each module's
       on-hand within its bound batch below. */
    type SofaLineRec = {
      id: string; doc_no: string; whId: string | null; item_code: string;
      variant_key: string; need: number; current: string; curReady: number; curBatch: string | null;
    };
    const sofaLineRecs: SofaLineRec[] = [];
    for (const l of lines) {
      /* P1 SO-SKU spec §4.6 — SERVICE lines are services, not goods: never
         allocate stock to them and never let them gate readiness. Without
         this skip a SERVICE line stays PENDING forever and wedges the SO
         short of READY_TO_SHIP (so-readiness already treats SERVICE as
         non-MAIN, so skipping here completes the pair). */
      if (isServiceLine({
        itemGroup: l.item_group,
        itemCode: l.item_code,
        category: serviceCodes.has(l.item_code) ? 'SERVICE' : null,
      })) continue;
      const delivered = deliveredBySoItem.get(l.id) ?? 0;
      const returned = returnedBySoItem.get(l.id) ?? 0;
      const remaining = Number(l.qty ?? 0) - delivered + returned;
      if (remaining <= 0) continue;
      const variant_key = computeVariantKey(l.item_group ?? null, l.variants ?? null);
      const whId = l.warehouse_id ?? null;
      if (isBatchedLine(l.item_code, l.item_group)) {
        sofaLineRecs.push({
          id: l.id, doc_no: l.doc_no, whId, item_code: l.item_code, variant_key,
          need: remaining, current: l.stock_status, curReady: Number(l.stock_qty_ready ?? 0),
          curBatch: curBatchByLine.get(l.id) ?? null,
        });
        continue;
      }
      const bucket = `${whId ?? WH_NONE}::${l.item_code}::${variant_key}`;
      needs.push({
        id: l.id, doc_no: l.doc_no, bucket, whId,
        need: remaining, current: l.stock_status,
        curReady: Number(l.stock_qty_ready ?? 0),
      });
    }
    if (needs.length === 0 && sofaLineRecs.length === 0) return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };

    /* 5. Sort needs by allocation priority. Commander 2026-05-31 — equal
          delivery date now tie-breaks by SO doc number ascending (SO-2605-001
          before SO-2605-002) so same-day allocation is deterministic, matching
          the MRP engine. created_at + line id break any remaining ties. */
    const FAR_FUTURE = '9999-12-31';
    needs.sort((a, b) => {
      const A = orderByDoc.get(a.doc_no); const B = orderByDoc.get(b.doc_no);
      const ad = A?.customer_delivery_date ?? FAR_FUTURE;
      const bd = B?.customer_delivery_date ?? FAR_FUTURE;
      if (ad !== bd) return ad.localeCompare(bd);                         // a) delivery date
      if (a.doc_no !== b.doc_no) return a.doc_no.localeCompare(b.doc_no); // b) SO doc number
      const ac = A?.created_at ?? '';
      const bc = B?.created_at ?? '';
      return ac.localeCompare(bc) || a.id.localeCompare(b.id);            // c) created_at + line id
    });

    /* 6. Pull live on-hand, keyed strictly per-warehouse to match the per-line
          buckets above. No cross-warehouse aggregate — a line draws only its
          own warehouse's stock. */
    const productCodes = [...new Set(needs.map((n) => {
      const parts = n.bucket.split('::');
      return parts[1] ?? '';
    }).filter(Boolean))];
    // chunkIn — productCodes can exceed 1000 and balances can exceed the 1000-row
    // cap; batch + page so on-hand isn't understated → lines wrongly PENDING.
    const { data: balRows, error: balanceError } = await chunkIn<{ warehouse_id: string; product_code: string; variant_key: string | null; qty: number }>(productCodes, (batch, from, to) => sb
      .from('inventory_balances')
      .select('warehouse_id, product_code, variant_key, qty')
      .in('product_code', batch)
      .range(from, to));
    if (balanceError) throw new Error(`allocation balance load failed: ${balanceError.message}`);
    const onHandByBucket = new Map<string, number>();
    for (const r of (balRows ?? []) as Array<{ warehouse_id: string; product_code: string; variant_key: string | null; qty: number }>) {
      const v = r.variant_key ?? '';
      const qty = Number(r.qty ?? 0);
      const whKey = `${r.warehouse_id}::${r.product_code}::${v}`;
      onHandByBucket.set(whKey, (onHandByBucket.get(whKey) ?? 0) + qty);
    }

    /* 6b. BOUND MODE — a line whose OWN purchase order has been received is
           ready, whatever the pooled buckets say (owner 2026-08-10: "Houzs 的
           BEDFRAME 可以用 Convert To … 代表这个 PO 是 assign 给这个 SalesOrder
           的", to run until the migrated stock is delivered off, then switch to
           2990's pooled model).

           This is not a nicety, it is the only way the migrated data can read
           correctly: the AutoCount stock snapshot carries NO variant, so every
           imported bedframe unit landed under a blank variant_key while its SO
           line carries colour + heights. Pooled matching is
           warehouse+code+variant_key, so those two can never meet and a
           bedframe physically standing in the warehouse would report PENDING
           forever.

           Claimed units are also DECREMENTED from the pooled bucket (exact
           variant first, then the blank-variant bucket the migration created),
           so a dedicated receipt can never be counted twice — once for its own
           SO here, and again for somebody else's line in the pooled walk below. */
    const dedicatedReady = new Map<string, number>();
    if (needs.length > 0) {
      const lineIds = needs.map((n) => n.id);
      const { data: poLinkRows } = await chunkIn<{ so_item_id: string; qty: number; received_qty: number | null }>(
        lineIds,
        (batch, from, to) => sb
          .from('purchase_order_items')
          .select('so_item_id, qty, received_qty')
          .in('so_item_id', batch)
          .range(from, to),
      );
      for (const r of (poLinkRows ?? []) as Array<{ so_item_id: string; received_qty: number | null }>) {
        const got = Number(r.received_qty ?? 0);
        if (got > 0) dedicatedReady.set(r.so_item_id, (dedicatedReady.get(r.so_item_id) ?? 0) + got);
      }
    }

    /* 7. Walk needs in priority order. Partial fill (#4) — when bucket has
          some but not enough, allocate what's available and mark the line
          PARTIAL (stock_qty_ready = whatever fit). Full fill → READY. Zero
          allocation → PENDING (stock_qty_ready = 0). */
    type TargetState = { status: 'READY' | 'PENDING' | 'PARTIAL'; qtyReady: number };
    const targetById = new Map<string, TargetState>();
    const remaining = new Map(onHandByBucket);
    // Bound lines first, so their units leave the pool before anyone else walks it.
    for (const n of needs) {
      if (allocGated.has(n.doc_no)) continue;
      const got = dedicatedReady.get(n.id) ?? 0;
      if (got <= 0) continue;
      const fill = Math.min(got, n.need);
      targetById.set(n.id, fill >= n.need
        ? { status: 'READY', qtyReady: n.need }
        : { status: 'PARTIAL', qtyReady: fill });
      // take the units out of the pool: exact bucket first, then blank-variant
      let left = fill;
      for (const key of [n.bucket, `${n.whId ?? WH_NONE}::${n.bucket.split('::')[1]}::`]) {
        if (left <= 0) break;
        const have = remaining.get(key) ?? 0;
        if (have <= 0) continue;
        const take = Math.min(have, left);
        remaining.set(key, have - take);
        left -= take;
      }
    }
    for (const n of needs) {
      if (targetById.has(n.id)) continue; // settled by its dedicated PO above
      if (allocGated.has(n.doc_no)) {
        targetById.set(n.id, { status: 'PENDING', qtyReady: 0 });
        continue;
      }
      const avail = remaining.get(n.bucket) ?? 0;
      if (avail >= n.need) {
        targetById.set(n.id, { status: 'READY', qtyReady: n.need });
        remaining.set(n.bucket, avail - n.need);
      } else if (avail > 0) {
        targetById.set(n.id, { status: 'PARTIAL', qtyReady: avail });
        remaining.set(n.bucket, 0);
      } else {
        targetById.set(n.id, { status: 'PENDING', qtyReady: 0 });
      }
    }

    /* 7b. SOFA — whole-set, all-or-nothing batch coverage (Wei Siang 2026-06-03,
           replaces the old "batch belongs to the PO's SO" model). A sofa SET =
           all the sofa module lines of one SO at one warehouse (e.g. LHF + RHF,
           same fabric). The set is READY only when ONE single production batch
           (batch_no = a PO's dye lot) holds enough of EVERY module; that batch is
           then locked onto every line as allocated_batch_no so the DO consumes
           the whole set from one dye lot. No single covering batch → PENDING
           (never PARTIAL, never split across two batches, never strand a half-set).
           Eligibility is plain SKU + variant — NOT the SO's own PO link; ANY SO
           whose set a batch fully covers may claim it. Sets are walked in the
           SAME priority order as non-sofa needs (delivery date → SO doc number)
           and each claimed batch is decremented, so two SOs can't double-claim the
           same units. */
    const batchTargetByLine = new Map<string, string | null>();
    if (sofaLineRecs.length > 0) {
      const sofaStock = await loadSofaBatchStock(sb, sofaLineRecs.map((s) => s.item_code));

      // Group sofa lines into per-SO sets (within a warehouse).
      const setLines = new Map<string, SofaLineRec[]>(); // key = `${wh}|${docNo}`
      for (const s of sofaLineRecs) {
        const key = `${s.whId ?? WH_NONE}|${s.doc_no}`;
        const arr = setLines.get(key) ?? [];
        arr.push(s); setLines.set(key, arr);
      }
      // Walk sets in allocation priority so a single covering batch goes to the
      // highest-priority SO first, then is decremented before lower-priority sets.
      const orderedSets = [...setLines.values()].sort((ga, gb) => {
        const a = ga[0]!; const b = gb[0]!;
        const A = orderByDoc.get(a.doc_no); const B = orderByDoc.get(b.doc_no);
        const ad = A?.customer_delivery_date ?? FAR_FUTURE;
        const bd = B?.customer_delivery_date ?? FAR_FUTURE;
        if (ad !== bd) return ad.localeCompare(bd);
        return a.doc_no.localeCompare(b.doc_no);
      });
      for (const group of orderedSets) {
        if (allocGated.has(group[0]!.doc_no)) {
          for (const s of group) {
            batchTargetByLine.set(s.id, null);
            targetById.set(s.id, { status: 'PENDING', qtyReady: 0 });
          }
          continue;
        }
        const whId = group[0]!.whId;
        const lines = group.map((s) => ({ itemCode: s.item_code, variantKey: s.variant_key, need: s.need }));
        const batch = findCoveringBatch(whId, lines, sofaStock);
        if (batch && whId) claimSofaBatch(whId, batch, lines, sofaStock);
        for (const s of group) {
          batchTargetByLine.set(s.id, batch);
          targetById.set(s.id, batch ? { status: 'READY', qtyReady: s.need } : { status: 'PENDING', qtyReady: 0 });
        }
      }
    }

    /* 8. Flip lines that changed. Group by exact (status, qtyReady) so we can
          batch the UPDATEs. Optionally scope writes to scopeToDocNo. */
    let linesFlipped = 0;
    type FlipBatch = { ids: string[]; status: 'READY' | 'PENDING' | 'PARTIAL'; qtyReady: number };
    const flipBatches = new Map<string, FlipBatch>(); // key = status|qtyReady
    for (const n of needs) {
      if (scopeToDocNo && n.doc_no !== scopeToDocNo) continue;
      const t = targetById.get(n.id);
      if (!t) continue;
      if (t.status === n.current && t.qtyReady === n.curReady) continue;
      const key = `${t.status}|${t.qtyReady}`;
      const batch = flipBatches.get(key) ?? { ids: [], status: t.status, qtyReady: t.qtyReady };
      batch.ids.push(n.id);
      flipBatches.set(key, batch);
    }
    for (const batch of flipBatches.values()) {
      // Chunk the id list so the UPDATE's .in() never builds a >1000-element IN
      // (a full re-allocation can flip thousands of lines into one bucket).
      for (let i = 0; i < batch.ids.length; i += 200) {
        const { error } = await sb.from('mfg_sales_order_items')
          .update({ stock_status: batch.status, stock_qty_ready: batch.qtyReady })
          .in('id', batch.ids.slice(i, i + 200));
        if (error) throw new Error(`allocation line update failed: ${error.message}`);
      }
      linesFlipped += batch.ids.length;
    }

    /* 8b. Flip sofa lines — they also persist allocated_batch_no (the locked
           batch the whole set ships from). Group by (status|qtyReady|batch).
           Forward-compat (0121): if allocated_batch_no isn't in the schema yet,
           retry the update without it so READY/PENDING still flips. */
    type SofaFlip = { ids: string[]; status: 'READY' | 'PENDING' | 'PARTIAL'; qtyReady: number; batchNo: string | null };
    const sofaFlips = new Map<string, SofaFlip>();
    for (const s of sofaLineRecs) {
      if (scopeToDocNo && s.doc_no !== scopeToDocNo) continue;
      const t = targetById.get(s.id);
      if (!t) continue;
      const batchNo = batchTargetByLine.get(s.id) ?? null;
      if (t.status === s.current && t.qtyReady === s.curReady && batchNo === s.curBatch) continue;
      const key = `${t.status}|${t.qtyReady}|${batchNo ?? ''}`;
      const f = sofaFlips.get(key) ?? { ids: [], status: t.status, qtyReady: t.qtyReady, batchNo };
      f.ids.push(s.id);
      sofaFlips.set(key, f);
    }
    for (const f of sofaFlips.values()) {
      // Chunk the id list so the UPDATE's .in() never builds a >1000-element IN.
      for (let i = 0; i < f.ids.length; i += 200) {
        const idChunk = f.ids.slice(i, i + 200);
        const { error } = await sb.from('mfg_sales_order_items')
          .update({ stock_status: f.status, stock_qty_ready: f.qtyReady, allocated_batch_no: f.batchNo })
          .in('id', idChunk);
        if (error && (error.message ?? '').includes('allocated_batch_no')) {
          const { error: fallbackError } = await sb.from('mfg_sales_order_items')
            .update({ stock_status: f.status, stock_qty_ready: f.qtyReady })
            .in('id', idChunk);
          if (fallbackError) throw new Error(`allocation sofa-line fallback update failed: ${fallbackError.message}`);
        } else if (error) {
          throw new Error(`allocation sofa-line update failed: ${error.message}`);
        }
      }
      linesFlipped += f.ids.length;
    }

    /* Flatten the maps so the audit + header re-aggregation steps below see
       per-line target status directly. Combine non-sofa needs + sofa lines. */
    const flippable: Array<{ id: string; current: string }> = [
      ...needs.map((n) => ({ id: n.id, current: n.current })),
      ...sofaLineRecs.map((s) => ({ id: s.id, current: s.current })),
    ];
    const toReady   = flippable.filter((n) => targetById.get(n.id)?.status === 'READY'   && targetById.get(n.id)?.status !== n.current).map((n) => n.id);
    const toPending = flippable.filter((n) => targetById.get(n.id)?.status === 'PENDING' && targetById.get(n.id)?.status !== n.current).map((n) => n.id);
    const toPartial = flippable.filter((n) => targetById.get(n.id)?.status === 'PARTIAL' && targetById.get(n.id)?.status !== n.current).map((n) => n.id);
    /* Map of id → target status (string) for the readiness summary below.
       Replaces the old targetStatusById which was 'READY' | 'PENDING' only. */
    const targetStatusById = new Map<string, string>();
    for (const [id, t] of targetById) targetStatusById.set(id, t.status);

    // ── Audit trail: one entry per affected SO summarising the auto-flip
    //    (Edge #H polish). Operator can later see "why did this line change?"
    //    Best-effort — never blocks the allocation result.
    if (toReady.length > 0 || toPending.length > 0 || toPartial.length > 0) {
      const lineToDoc = new Map(lines.map((l) => [l.id, l.doc_no]));
      const byDoc = new Map<string, { ready: string[]; pending: string[]; partial: string[] }>();
      const bucket = (id: string, key: 'ready' | 'pending' | 'partial') => {
        const doc = lineToDoc.get(id); if (!doc) return;
        const cur = byDoc.get(doc) ?? { ready: [], pending: [], partial: [] };
        cur[key].push(id); byDoc.set(doc, cur);
      };
      for (const id of toReady)   bucket(id, 'ready');
      for (const id of toPending) bucket(id, 'pending');
      for (const id of toPartial) bucket(id, 'partial');
      const auditRows: Array<Record<string, unknown>> = [];
      for (const [docNo, flips] of byDoc) {
        const parts: string[] = [];
        if (flips.ready.length)   parts.push(`${flips.ready.length} line(s) → READY`);
        if (flips.partial.length) parts.push(`${flips.partial.length} line(s) → PARTIAL`);
        if (flips.pending.length) parts.push(`${flips.pending.length} line(s) → PENDING`);
        auditRows.push({
          so_doc_no:           docNo,
          action:              'UPDATE_LINE',
          actor_id:            null,
          actor_name_snapshot: 'system (auto-allocate)',
          field_changes:       [{ field: 'stockStatus', from: 'auto', to: parts.join(', ') }],
          status_snapshot:     null,
          source:              'auto-allocation',
          note:                'Stock allocation recomputed against live inventory',
        });
      }
      if (auditRows.length > 0) {
        // Multi-company (migration 0061): mfg_so_audit_log.company_id is NOT NULL.
        // Batch-resolve each SO's company so an auto-allocation audit row inherits
        // the company of the SO it describes. Best-effort (the insert is swallowed).
        try {
          const docNos = [...new Set(auditRows.map((r) => r.so_doc_no as string))];
          const { data: coRows } = await sb.from('mfg_sales_orders')
            .select('doc_no, company_id').in('doc_no', docNos);
          const coByDoc = new Map(((coRows ?? []) as Array<{ doc_no: string; company_id: number | null }>)
            .map((r) => [r.doc_no, r.company_id]));
          for (const r of auditRows) {
            const cid = coByDoc.get(r.so_doc_no as string);
            if (cid != null) r.company_id = cid;
          }
        } catch { /* swallow — best-effort */ }
        try { await sb.from('mfg_so_audit_log').insert(auditRows); }
        catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] audit insert failed:', e); }
      }
    }

    // 9. Per-SO header re-aggregation (only for SOs that had a line flip,
    //    or the scoped SO if any). all-READY → READY_TO_SHIP (when previously
    //    CONFIRMED / IN_PRODUCTION). any-PENDING → CONFIRMED (when previously
    //    READY_TO_SHIP).
    // Re-evaluate every loaded header during a global run. If a prior attempt
    // flipped lines but lost a header CAS, the retry has no fresh line flip to
    // rediscover that SO; walking all loaded headers is what makes convergence
    // durable. Scoped runs retain their single-document bound.
    const touchedDocs = new Set<string>(scopeToDocNo ? [scopeToDocNo] : orders.map((order) => order.doc_no));

    let ordersAdvanced = 0, ordersRegressed = 0;
    const deferredDocNos: string[] = [];
    for (const docNo of touchedDocs) {
      const order = orderByDoc.get(docNo);
      if (!order) continue;
      const docLines = lines.filter((l) => l.doc_no === docNo);
      /* Re-evaluate readiness using the live target status (lines that weren't
         in needs are already shipped → treat as READY). B2C semantics: an SO
         is ship-able when every MAIN product line (sofa/bedframe/mattress) is
         READY — accessories pending don't block ship ("READY (PARTIAL)").
         Auto-regress only when a MAIN line goes back to PENDING. */
      const readinessLines = docLines.map((l) => ({
        item_group: l.item_group,
        item_code: l.item_code,
        stock_status: targetStatusById.get(l.id) ?? l.stock_status,
      }));
      const r = summariseReadiness(readinessLines);
      const cur = order.status;
      /* Owner requirement — the SO History timeline must show AUTOMATED status
         transitions too ("the system did it" disputes). Mirror the manual
         status-PATCH audit pattern: one mfg_so_status_changes row (legacy
         StatusTimeline) + one mfg_so_audit_log row. Best-effort, never blocks
         the allocation result (recordSoAudit swallows failures internally). */
      const auditAutoStatus = async (from: string, to: string, note: string) => {
        try {
          await sb.from('mfg_so_status_changes').insert({
            // Multi-company: the automated status-change row inherits the SO's company.
            ...(order.company_id != null ? { company_id: order.company_id } : {}),
            doc_no: docNo, from_status: from, to_status: to, changed_by: null, notes: note,
          });
        } catch { /* best-effort */ }
        await recordSoAudit(sb, {
          docNo,
          action: 'UPDATE_STATUS',
          actorId: null,
          actorName: 'System (auto-allocate)',
          fieldChanges: [{ field: 'status', from, to }],
          statusSnapshot: to,
          source: 'automation',
          note,
        });
      };
      /* SKIP AND CONTINUE — do NOT throw (livelock fix, 2026-07-22).

         advanceSoGeneration stands down while a human holds the SO's edit lease.
         That lease is FIVE minutes and the retry cron is also FIVE minutes, so
         throwing here meant: one order under active edit aborted the whole
         global recompute, the queue row was marked failed, and the next sweep
         five minutes later hit the same still-leased order. Two equal timers —
         the projection could fail forever while looking like it was retrying,
         and every order AFTER the leased one in this loop never got its header
         evaluated at all.

         A deferral is not an error. The line-level projection for this order is
         already committed above; only the derived header status is outstanding,
         and it is re-derived from scratch on every pass (this function is
         idempotent). So record the doc number, keep going, and let the caller
         re-queue. Progress is made on every other order in the batch. */
      if (r.isMainReady && (cur === 'CONFIRMED' || cur === 'IN_PRODUCTION')) {
        const advanced = await advanceSoGeneration(sb, docNo, { status: 'READY_TO_SHIP' }, { status: cur });
        if (advanced.applied) {
          ordersAdvanced += 1;
          await auditAutoStatus(cur, 'READY_TO_SHIP', 'Auto-advanced: every main product line is READY (stock allocation)');
        } else {
          deferredDocNos.push(`${docNo}:${advanced.reason}`);
        }
      } else if (!r.isMainReady && cur === 'READY_TO_SHIP') {
        const regressed = await advanceSoGeneration(sb, docNo, { status: 'CONFIRMED' }, { status: cur });
        if (regressed.applied) {
          ordersRegressed += 1;
          await auditAutoStatus(cur, 'CONFIRMED', 'Auto-regressed: a main product line is no longer READY (stock re-allocated)');
        } else {
          deferredDocNos.push(`${docNo}:${regressed.reason}`);
        }
      }
    }

    return {
      ok: true, linesFlipped, ordersAdvanced, ordersRegressed,
      ...(deferredDocNos.length > 0 ? { deferredDocNos } : {}),
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[so-allocation] recompute failed:', e);
    return { ok: false, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (lockHeld) {
      try {
        const { error } = await sb.from('stock_allocation_recompute_lock')
          .update({ locked_by: null, locked_until: null })
          .eq('lock_key', ALLOCATION_LOCK_ROW)
          .eq('locked_by', lockToken);
        if (error) console.warn('[so-allocation] durable lock release failed:', error.message); // eslint-disable-line no-console
      } catch (error) {
        console.warn('[so-allocation] durable lock release failed:', error); // eslint-disable-line no-console
      }
    }
  }
}
