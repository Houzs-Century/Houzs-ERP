// ----------------------------------------------------------------------------
// company-scope-file: the `lock_key` writes in this file target
// scm.stock_allocation_recompute_lock, which carries NO company_id — mig 0083
// stamped 116 tables and left this one alone, deliberately. It is global
// infrastructure: ONE recompute runs at a time across the whole system, which is
// the entire point of the lock. There is no company to scope to, and adding one
// would let two companies recompute concurrently over shared inventory.
//
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
//   2. Pull live inventory_balances PER WAREHOUSE, keyed
//      (warehouse_id, item_code, variant_key) — the same bucket the lines are
//      built with at :471. A KL line draws only KL stock, a PJ line only PJ. A
//      line with NO warehouse bound gets its own 'NOWH' bucket and therefore
//      sees no stock at all, so it stays PENDING until one is assigned.
//
//      THIS PARAGRAPH USED TO SAY THE OPPOSITE — "summed across ALL warehouses
//      per (item_code, variant_key) … we just need to know 'is it somewhere'".
//      That was the ORIGINAL design; migration 0118 (Commander 2026-05-31)
//      replaced it with the per-warehouse bucket the code below has used ever
//      since, and this header was never updated. It is auto-loaded context for
//      anyone reading this file, so it did not merely go stale — it actively
//      told readers the wrong rule, and on 2026-08-22 it did exactly that: a
//      written explanation of the allocator went to the owner saying stock is
//      pooled across warehouses, sourced from these three lines rather than
//      from :471 and :564 forty lines below.
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

import { doCountsAsDelivered } from '../shared/do-shipped-states';
import { HARD_BOUND_COMPANY_ID, variantTrackedCompany } from './binding-mode';
import { canonicalVariantKey, computeVariantKey, isServiceLine, effectiveSoDelivery, type VariantAttrs } from '../shared';
import { summariseReadiness } from './so-readiness';
import { loadSofaBatchStock, findCoveringBatch, claimSofaBatch } from './sofa-set-coverage';
import { paginateAll, chunkIn } from './paginate-all';
import { recordSoAudit } from './so-audit';
import { advanceSoGeneration } from './so-generation';
import { enqueueStockAllocationRecompute } from './stock-allocation-queue';
import { SO_TERMINAL_STATES_PGREST } from '../shared/so-terminal-states';
import { sofaSetKey } from '../shared/sofa-set-identity';
import { SO_PROCESSING_DATE_COLUMN } from '../shared/so-processing-date';
import { liveStatusForProcessingDate } from '../shared/so-proceeded-status';
import { loadNonSellingWarehouses, warehouseCanPromise } from './non-selling-warehouse';
import { pgrestIn } from './pgrest-in-list';
import { timed } from '../../lib/step-timing';
import { isDocumentHeld } from './document-hold';

/* Only the variant-bearing categories run bound. Owner 2026-08-10:
   "SOFA 和 BEDFRAME 因为有变体的问题,所以要走 Convert to PO 的那个模式.
    可是 MATTRESS 跟 Accessories 都是没有变体的 ... 走回我们正常 MRP 的模式".
   Owner 2026-08-29: special-order mattresses follow hard binding too —
   "如果是specialorder的话 也是像bedframe这样指定的 hard binding的"; the book's
   own convention marks them with an (SP) suffix. Standard mattresses stay
   pooled (the 2026-08-10 ruling, unchanged).

   EXPORTED because the rule now has two consumers and they must not drift:
   this engine's bound-needs filter, and the display union's promotion gate
   (so-line-effective-stock.ts) — a hard-bound line's live-MRP 'stock' verdict
   is variant-blind and must never promote it (HC-SO-013367, 2026-08-30). */
/* Owner 2026-09-14: the Sofa Accessory category (fabric_accessory) binds per order
   like a sofa - 「这个会需要像 sofa 那样 hardbinding 的」, and for EVERY SKU in it -
   「这些sku全部都要处理」 (SB02, BC04, BC04-MF, BC05, BC05-MF, AR01, AR02, SQUARE
   PILLOW, LONG PILLOW on the Products page). Each is made in the customer's fabric,
   so pooled stock of another colour is never its evidence.

   THE CATEGORY IS THE RULE, READ FROM THE PRODUCT MASTER: a line's item_group is
   stamped from its SKU's category whenever it is written ("SKU wins",
   docs/bugs/0514), so a SKU put into the category binds with nobody editing this
   file. The two-code list (SQUARE PILLOW / LONG PILLOW) that bound the pillows by
   name while they were still `accessory` was REMOVED once the data run (#3864)
   moved their lines: it kept binding a pillow moved back to Accessory, and it bound
   company 2's pillows, which are Accessory there. The random / free-gift pillows
   (AMN-SOFA PILLOW, SOFA PILLOW (FOC)) are Accessory and pool. docs/bugs/0890. */
/* HC-0150 (Sim, 2026-10-23): Dining binds too - 「normally this one in one out,
   seldom have keep stock」. One code (AN-DINING LEG) covers many models whose
   model lives only in free text, so pooled stock of one model covered an order
   for another. Lines migrated from AutoCount before the DINING category existed
   still carry `others` and keep pooling. */
const HARD_BOUND_GROUPS = new Set(['bedframe', 'sofa', 'fabric_accessory', 'dining']);

export function isHardBoundLine(
  itemGroup: string | null | undefined,
  itemCode: string | null | undefined,
): boolean {
  const g = (itemGroup ?? '').toLowerCase();
  if (HARD_BOUND_GROUPS.has(g)) return true;
  return g === 'mattress' && /\(SP\)\s*$/i.test(itemCode ?? '');
}

/* The company whose bound groups are EXCLUSIVELY PO-bound (owner, ruled three
   times — 2026-08-10, 2026-08-29, 2026-08-30 "他明明都没有 PO,怎么会 ready 呢
   …它一定是根据 PO…Company 1 跟 Company 2 机制是不一样的"): a company-1
   bedframe / sofa / (SP) mattress line lights ONLY through its own received
   purchase order; the pooled walk is never its evidence. Company 2 (2990)
   pools. When company-1 stock has grown variants and the migrated blanks have
   washed out, the owner's stated plan is to switch this company to the pooled
   model too — that switch is THIS constant. */
export { HARD_BOUND_COMPANY_ID } from './binding-mode';

export type AllocationResult = {
  ok: boolean;
  linesFlipped: number;
  ordersAdvanced: number;
  ordersRegressed: number;
  reason?: string;
  queuedForRetry?: boolean;
  deferredDocNos?: string[];
  /* Doc numbers holding at least one line the non-selling-warehouse rule kept
     PENDING (owner ruling 2026-09-08). Present only when non-empty, so a caller
     that logs it prints a list or nothing. This is NOT a failure — the
     projection is correct and complete. It is the one difference a salesperson
     can SEE, so the engine names it rather than leaving the change to be
     discovered on the floor. */
  nonSellingWarehouseDocNos?: string[];
};

const ALLOCATION_LOCK_ROW = 'GLOBAL';
const ALLOCATION_LOCK_MS = 15 * 60_000;

/* SKIP LEAVES A TRACE (owner-visible defect, 2026-08-17).
   ─────────────────────────────────────────────────────────────────────────────
   The sweep below has three ways to come back having done nothing, and until
   this wrapper existed all three were INVISIBLE to the ~34 best-effort triggers
   that call it (GRN post, DO ship, returns, stock takes, transfers,
   adjustments, consignment, and eight paths in mfg-sales-orders):

     · it lost the single-flight race     -> { ok: TRUE, reason:
                                               'another_recompute_in_progress' }
     · it threw                           -> { ok: false, reason: <message> }
     · a human held an SO's edit lease    -> { ok: true, deferredDocNos: [...] }

   Every one of those call sites is written `await recomputeSoStockAllocation(sb)`
   with the result discarded, so the request returned success and the projection
   stayed stale until some UNRELATED later mutation happened to sweep it. The
   first case is the one that bites hardest and it is not a crash-window race:
   two GRNs posted close together deterministically leave the second one's lines
   stale, and goods arriving is exactly the moment the operator is looking.

   The five-minute cron could not help, because a best-effort trigger writes NO
   queue row — the cron finds nothing pending and returns `completed: true`. It
   was a backstop for the four durable call sites, never a repair loop.

   So: whenever the sweep did not finish, write the durable retry row HERE, once,
   for every present and future caller. That turns the existing cron into the
   repair loop the system was documented as having. What it does NOT fix is a
   Worker that dies BEFORE reaching this function — that still needs each route
   moved onto `runScmPgCommand` so the enqueue can join the source write's
   transaction (see the SCOPE header in stock-allocation-job.ts). Nothing here
   should be read as making allocation durable in general. */
export async function recomputeSoStockAllocation(
  sb: any,
  scopeToDocNo?: string,
): Promise<AllocationResult> {
  const result = await timed(scopeToDocNo ? 'alloc-recompute-scoped' : 'alloc-recompute', () => runSoStockAllocation(sb, scopeToDocNo));
  const finished = result.ok
    && result.reason !== 'another_recompute_in_progress'
    && !(result.deferredDocNos && result.deferredDocNos.length > 0);
  if (finished) return result;
  try {
    await enqueueStockAllocationRecompute(
      sb,
      `retry:${result.reason ?? (result.deferredDocNos ? 'headers_leased' : 'incomplete')}`,
    );
    return { ...result, queuedForRetry: true };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[so-allocation] recompute did not finish and the retry row could not be written:', error);
    return { ...result, queuedForRetry: false };
  }
}

async function runSoStockAllocation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST client type, unchanged from the exported wrapper this body was split out of; schema.pg.ts covers none of these SCM tables (see ci.yml's lint job comment)
  sb: any,
  scopeToDocNo?: string,
): Promise<AllocationResult> {
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
    const { data: orderRows, error: orderError } = await paginateAll<{ doc_no: string; status: string; on_hold: boolean | null; created_at: string; customer_delivery_date: string | null; amended_delivery_date: string | null; company_id: number | null; processing_date: string | null }>((from, to) => sb
      .from('mfg_sales_orders')
      .select(`doc_no, status, created_at, customer_delivery_date, amended_delivery_date, company_id, on_hold, ${SO_PROCESSING_DATE_COLUMN}`)
      .not('status', 'in', SO_TERMINAL_STATES_PGREST)
      .order('customer_delivery_date',  { ascending: true, nullsFirst: false })
      .order('created_at',              { ascending: true })
      .range(from, to));
    if (orderError) throw new Error(`allocation order load failed: ${orderError.message}`);
    const orders = (orderRows ?? []) as Array<{
      doc_no: string; status: string; on_hold: boolean | null; created_at: string;
      customer_delivery_date: string | null; amended_delivery_date: string | null;
      company_id: number | null;
      processing_date: string | null;
    }>;
    if (orders.length === 0) return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };
    const orderByDoc = new Map(orders.map((o) => [o.doc_no, o]));
    /* Processing-date allocation gate (owner 2026-08-10, go-live): nothing is
       prepared before the order is released for ordering, so an SO with NO
       Processing Date must not claim stock nor show READY TO SHIP ("它明明都没有
       Processing Date, 干嘛分配呢" … "2990 跟整套系统都是这样子的:有 processing
       date 才来分配"). Gated lines still walk (so an already-READY line regresses
       on this same run) but are forced PENDING and never consume a bucket or a
       sofa batch.

       THE RULE WAS RIGHT; THE COLUMN WAS NOT. This filtered on `proceeded_at`
       until 2026-08-18, and NO shipped client writes that column when an
       operator sets a Processing Date: CREATE persists the date to
       `processing_date` (mfg-sales-orders.ts, `processing_date:
       dateOrNull(body.processingDate)`) and stamps `proceeded_at` ONLY when the
       order additionally clears the proceed gate (`autoProceed`); the header
       PATCH writes the date and never stamps a proceed at all; and no frontend
       sends `proceededAt` anywhere (zero occurrences in frontend/src). So an
       order given a Processing Date on the detail screen locked, appeared on the
       delivery board and pushed to AutoCount as PDate while EVERY line was
       forced PENDING — never consuming a bucket, never claiming a sofa batch,
       never reaching READY_TO_SHIP — with the goods physically in the warehouse,
       and with no error, no log and nothing on screen.

       ONE COLUMN, deliberately. Reading both "to be safe" would give the rule a
       second home, which is how it acquired a wrong one. `proceeded_at` is the
       same fact in the wrong shape (see SO_PROCESSING_DATE_COLUMN's docstring);
       this is its stop-reading step, and its last reachable decision — the
       remaining mentions are `soProcessingLocked`'s status-absent fallback,
       which only runs after `processing_date` has already decided. The data was
       consolidated into this column on 2026-08-13 (mig 0286 header: 519
       company-1 orders moved out of `proceeded_at`, both companies verified at
       zero split).

       THE BLAST RADIUS, WHICH #2396 SHIPPED WITHOUT — measured the same day on
       prod, read-only (backend/scripts/probe-proceed-split.mjs, run
       32093080121). #2396's own message says it: *"Blast radius on production is
       UNKNOWN and not invented — the probe that measures it is on a branch that
       is not yet dispatchable."* It is now measured, and it is not nil:

         company 1 — 2724 live orders: 519 both columns set, 2205 neither, ZERO
           in either disagreement class. This flip is a genuine no-op here.
         company 2 — 77 live orders: 5 (all CONFIRMED) gain allocation, which is
           the bug #2396 describes. But 16 LOSE it — 12 CONFIRMED and 4
           READY_TO_SHIP, each carrying a Proceed stamp and NO Processing Date.
           Their lines are forced PENDING on the next 5-minute recompute and the
           4 READY_TO_SHIP orders visibly drop back to CONFIRMED.

       Those 16 are not a regression to undo: by the owner's rule (*"没有
       processing date 就代表没有 proceed"*) an order with no date is not
       proceeded, so gating it is the rule applied correctly, and the repair is a
       human supplying the date — never a script inventing one (PROCEED_NEEDS_DATE
       in shared/order-rules.ts). They are named here so the 4 that move are read
       as this change working rather than as a new fault.

       AND A LIVE PATH COULD STILL REOPEN THE SPLIT — this said it could not.
       `autoProceed` requiring a date and IN_PRODUCTION refusing without one
       cover the two paths that STAMP. They are not the only ways a row becomes
       stamp-without-date: Remove-Processing-Date cleared the date and left the
       stamp (closed 2026-08-18 in the header PATCH), and routes/so-mirror.ts
       replicates whatever 2990 sends, including a stamp, through applyMap. Both
       end for good with the column; see "RETIRING THE SECOND STORAGE" in
       shared/so-processing-date.ts. */
    const allocGated = new Set(
      orders.filter((o) => !o[SO_PROCESSING_DATE_COLUMN] || isDocumentHeld(o)).map((o) => o.doc_no),
    );
    const companyByDoc = new Map(orders.map((o) => [o.doc_no, Number(o.company_id ?? 0)]));

    const docNos = orders.map((o) => o.doc_no);
    const readLines = (cols: string) => chunkIn(docNos, (batch, from, to) => sb
      .from('mfg_sales_order_items')
      .select(cols)
      .in('doc_no', batch)
      .eq('cancelled', false)
      .range(from, to));
    const LINE_COLS = 'id, doc_no, item_code, item_group, variants, qty, warehouse_id, stock_status, stock_qty_ready, cancelled';
    const missingBatchCol = (m: string | undefined) => /allocated_batch_no|column .* does not exist/i.test(m ?? '');
    let { data: lineRows, error: lineError } = await readLines(`${LINE_COLS}, allocated_batch_no`);
    if (lineError && missingBatchCol(lineError.message)) {
      ({ data: lineRows, error: lineError } = await readLines(LINE_COLS));
    }
    if (lineError) throw new Error(`allocation line load failed: ${lineError.message}`);
    const lines = (lineRows ?? []) as Array<{
      id: string; doc_no: string; item_code: string; item_group: string | null;
      variants: VariantAttrs | null; qty: number; warehouse_id: string | null;
      stock_status: string; stock_qty_ready: number | null;
      allocated_batch_no?: string | null;
    }>;
    if (lines.length === 0) return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };

    const { data: catRows, error: categoryError } = await paginateAll<{ code: string; category: string | null }>((from, to) =>
      sb.from('mfg_products').select('code, category').order('code').range(from, to));
    if (categoryError) throw new Error(`allocation product load failed: ${categoryError.message}`);

    /* WHERE the stock stands decides whether it may be PROMISED (owner ruling,
       2026-09-08 09:30 +08: 「分配时跳过这九个仓」). A showroom / display piece is
       standing on the floor doing its job and a unit in a SERVICE warehouse is
       physically away at the supplier being repaired — neither is available to a
       customer, and until this line existed the engine asked no question at all
       about the warehouse it drew from (docs/bugs/0682).
       Loaded ONCE here, before any of the three paths that can light a line, so
       none of them can be the one that forgot: the pooled walk, BOUND MODE (a
       line's own received PO, which never touches inventory_balances) and the
       SOFA dye-lot matcher are all gated off this single set.
       `loadNonSellingWarehouses` THROWS on a read failure rather than answering
       with an empty set — the empty set is indistinguishable from "no warehouse
       is a showroom", and the wrapper's catch turns the throw into a queued
       retry, which is the honest outcome. */
    const nonSellingWarehouses = await loadNonSellingWarehouses(sb);
    const nonSellingIds: ReadonlySet<string> = new Set(nonSellingWarehouses.keys());
    const batchedCodes = new Set<string>();
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

    const curBatchByLine = new Map<string, string | null>();
    for (const l of lines) curBatchByLine.set(l.id, l.allocated_batch_no ?? null);

    const { data: doJoinRows, error: doLineError } = await paginateAll<{
      id: string;
      do_items: Array<{ id: string; qty: number; delivery_order_id: string }> | null;
    }>((from, to) => sb
      .from('mfg_sales_order_items')
      .select('id, so:mfg_sales_orders!inner(status), do_items:delivery_order_items!inner(id, qty, delivery_order_id)')
      .eq('cancelled', false)
      .not('so.status', 'in', SO_TERMINAL_STATES_PGREST)
      .order('id')
      .range(from, to));
    if (doLineError) throw new Error(`allocation DO-line load failed: ${doLineError.message}`);
    const doLineRows: Array<{ id: string; so_item_id: string | null; qty: number; delivery_order_id: string }> = [];
    for (const r of doJoinRows ?? []) {
      for (const d of r.do_items ?? []) {
        doLineRows.push({ id: d.id, so_item_id: r.id, qty: d.qty, delivery_order_id: d.delivery_order_id });
      }
    }
    const doIds = [...new Set(doLineRows.map((l) => l.delivery_order_id).filter(Boolean))];
    const activeDoIds = new Set<string>();
    const doLineToSoItem = new Map<string, string>();
    if (doIds.length > 0) {
      const { data: dos, error: doError } = await chunkIn<{ id: string; status: string | null }>(doIds, (batch, from, to) =>
        sb.from('delivery_orders').select('id, status').in('id', batch).range(from, to));
      if (doError) throw new Error(`allocation DO load failed: ${doError.message}`);
      for (const d of (dos ?? []) as Array<{ id: string; status: string | null }>) {
        if (doCountsAsDelivered(d.status)) activeDoIds.add(d.id);
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

    const WH_NONE = 'NOWH';
    type LineNeed = { id: string; doc_no: string; bucket: string; whId: string | null; need: number; current: string; curReady: number; group: string; item_code: string };
    const needs: LineNeed[] = [];
    type SofaLineRec = {
      id: string; doc_no: string; whId: string | null; item_code: string;
      variant_key: string; need: number; current: string; curReady: number; curBatch: string | null;
    };
    const sofaLineRecs: SofaLineRec[] = [];
    for (const l of lines) {
      if (isServiceLine({
        itemGroup: l.item_group,
        itemCode: l.item_code,
        category: serviceCodes.has(l.item_code) ? 'SERVICE' : null,
      })) continue;
      const remaining = Number(l.qty ?? 0) - (deliveredBySoItem.get(l.id) ?? 0);
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
      const bucketVk = variantTrackedCompany(companyByDoc.get(l.doc_no) || null) ? canonicalVariantKey(variant_key) : variant_key;
      const bucket = `${whId ?? WH_NONE}::${l.item_code}::${bucketVk}`;
      needs.push({
        id: l.id, doc_no: l.doc_no, bucket, whId,
        need: remaining, current: l.stock_status,
        curReady: Number(l.stock_qty_ready ?? 0),
        group: (l.item_group ?? '').toLowerCase(),
        item_code: l.item_code,
      });
    }
    if (needs.length === 0 && sofaLineRecs.length === 0) return { ok: true, linesFlipped: 0, ordersAdvanced: 0, ordersRegressed: 0 };

    const FAR_FUTURE = '9999-12-31';
    const effDate = (o?: { customer_delivery_date: string | null; amended_delivery_date: string | null }): string =>
      (o ? effectiveSoDelivery(o) : null) ?? '';
    const stampKey = (v: unknown): string =>
      v instanceof Date ? v.toISOString() : String(v ?? '');
    needs.sort((a, b) => {
      const A = orderByDoc.get(a.doc_no); const B = orderByDoc.get(b.doc_no);
      const ad = effDate(A) || FAR_FUTURE;
      const bd = effDate(B) || FAR_FUTURE;
      if (ad !== bd) return ad.localeCompare(bd);
      if (a.doc_no !== b.doc_no) return a.doc_no.localeCompare(b.doc_no);
      const ac = stampKey(A?.created_at);
      const bc = stampKey(B?.created_at);
      return ac.localeCompare(bc) || a.id.localeCompare(b.id);
    });

    const itemCodes = [...new Set(needs.map((n) => {
      const parts = n.bucket.split('::');
      return parts[1] ?? '';
    }).filter(Boolean))];
    const { data: balRows, error: balanceError } = await chunkIn<{ warehouse_id: string; item_code: string; variant_key: string | null; qty: number; company_id: number | null }>(itemCodes, (batch, from, to) => pgrestIn(sb
      .from('inventory_balances')
      .select('warehouse_id, item_code, variant_key, qty, company_id'), 'item_code', batch)
      .range(from, to));
    if (balanceError) throw new Error(`allocation balance load failed: ${balanceError.message}`);
    const onHandByBucket = new Map<string, number>();
    for (const r of (balRows ?? []) as Array<{ warehouse_id: string; item_code: string; variant_key: string | null; qty: number; company_id?: number | null }>) {
      if (!warehouseCanPromise(r.warehouse_id, nonSellingIds)) continue;
      const v = variantTrackedCompany(r.company_id ?? null) ? canonicalVariantKey(r.variant_key) : (r.variant_key ?? '');
      const qty = Number(r.qty ?? 0);
      const whKey = `${r.warehouse_id}::${r.item_code}::${v}`;
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
    /* Which lines run bound is `isHardBoundLine` (module top) — one home for
       the two owner rulings (2026-08-10 bedframe/sofa, 2026-08-29 (SP)
       mattresses), shared with the display union's promotion gate. Mattress
       and accessories are common stock: pooling them is correct and is what
       the floor already expects, so they must NOT be diverted. */
    const dedicatedReady = new Map<string, number>();
    const boundNeeds = needs.filter((n) => isHardBoundLine(n.group, n.item_code));
    if (boundNeeds.length > 0 || sofaLineRecs.length > 0) {
      const boundIds = new Set([...boundNeeds.map((n) => n.id), ...sofaLineRecs.map((s) => s.id)]);
      const { data: poLinkRows, error: poLinkError } = await paginateAll<{
        id: string; po_items: Array<{ qty: number; received_qty: number | null }> | null;
      }>((from, to) => sb
        .from('mfg_sales_order_items')
        .select('id, so:mfg_sales_orders!inner(status), po_items:purchase_order_items!inner(qty, received_qty)')
        .eq('cancelled', false)
        .not('so.status', 'in', SO_TERMINAL_STATES_PGREST)
        .gt('po_items.received_qty', 0)
        .order('id')
        .range(from, to));
      if (poLinkError) throw new Error(`allocation PO-receipt load failed: ${poLinkError.message}`);
      for (const r of poLinkRows ?? []) {
        if (!boundIds.has(r.id)) continue;
        for (const p of r.po_items ?? []) {
          const got = Number(p.received_qty ?? 0);
          if (got > 0) dedicatedReady.set(r.id, (dedicatedReady.get(r.id) ?? 0) + got);
        }
      }
    }

    type TargetState = { status: 'READY' | 'PENDING' | 'PARTIAL'; qtyReady: number };
    const targetById = new Map<string, TargetState>();
    const remaining = new Map(onHandByBucket);
    const nonSellingBlockedDocs = new Set<string>();
    for (const n of boundNeeds) {
      if (allocGated.has(n.doc_no)) continue;
      if (!warehouseCanPromise(n.whId, nonSellingIds)) continue;
      const got = dedicatedReady.get(n.id) ?? 0;
      if (got <= 0) continue;
      const fill = Math.min(got, n.need);
      targetById.set(n.id, fill >= n.need
        ? { status: 'READY', qtyReady: n.need }
        : { status: 'PARTIAL', qtyReady: fill });
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
      if (targetById.has(n.id)) continue;
      if (allocGated.has(n.doc_no)) {
        targetById.set(n.id, { status: 'PENDING', qtyReady: 0 });
        continue;
      }
      /* THE DECISIVE GATE (owner ruling 2026-09-08). A line bound to a display,
         showroom or service warehouse is never promised — whatever the pool
         holds and whatever its own purchase order received. Selling the piece
         is still possible, through a stock transfer into a selling warehouse;
         the operator is told so on both surfaces (the pill's
         `non_selling_warehouse` note). */
      if (!warehouseCanPromise(n.whId, nonSellingIds)) {
        targetById.set(n.id, { status: 'PENDING', qtyReady: 0 });
        nonSellingBlockedDocs.add(n.doc_no);
        continue;
      }
      /* HARD BINDING IS EXCLUSIVE for HARD_BOUND_COMPANY_ID: an un-receipted
         bound line must NOT fall through to the pool. Dormant while variant
         buckets mismatched; the moment BOTH sides were blank it fired —
         HC-SO-013253 JAGER-(Q) read READY with no PO against blank-variant
         migrated stock (census run 33287776781, owner report 2026-08-30).
         docs/bugs/0572. Company 2 (2990) keeps pooling past this guard. */
      if (companyByDoc.get(n.doc_no) === HARD_BOUND_COMPANY_ID && isHardBoundLine(n.group, n.item_code)) {
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

    const batchTargetByLine = new Map<string, string | null>();
    if (sofaLineRecs.length > 0) {
      const sofaStock = await loadSofaBatchStock(sb, sofaLineRecs.map((s) => s.item_code));

      const setLines = new Map<string, SofaLineRec[]>();
      for (const s of sofaLineRecs) {
        const key = `${s.whId ?? WH_NONE}|${sofaSetKey(s.doc_no, s.item_code)}`;
        const arr = setLines.get(key) ?? [];
        arr.push(s); setLines.set(key, arr);
      }
      const orderedSets = [...setLines.values()].sort((ga, gb) => {
        const a = ga[0]!; const b = gb[0]!;
        const A = orderByDoc.get(a.doc_no); const B = orderByDoc.get(b.doc_no);
        const ad = effDate(A) || FAR_FUTURE;
        const bd = effDate(B) || FAR_FUTURE;
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
        if (!warehouseCanPromise(whId, nonSellingIds)) {
          for (const s of group) {
            batchTargetByLine.set(s.id, null);
            targetById.set(s.id, { status: 'PENDING', qtyReady: 0 });
          }
          nonSellingBlockedDocs.add(group[0]!.doc_no);
          continue;
        }
        const lines = group.map((s) => ({ itemCode: s.item_code, variantKey: s.variant_key, need: s.need }));
        const batch = findCoveringBatch(whId, lines, sofaStock);
        if (batch && whId) claimSofaBatch(whId, batch, lines, sofaStock);
        for (const s of group) {
          batchTargetByLine.set(s.id, batch);
          if (batch) {
            targetById.set(s.id, { status: 'READY', qtyReady: s.need });
            continue;
          }
          const got = dedicatedReady.get(s.id) ?? 0;
          const fill = Math.min(got, s.need);
          targetById.set(s.id, fill >= s.need
            ? { status: 'READY', qtyReady: s.need }
            : fill > 0
              ? { status: 'PARTIAL', qtyReady: fill }
              : { status: 'PENDING', qtyReady: 0 });
        }
      }
    }

    let linesFlipped = 0;
    type FlipBatch = { ids: string[]; status: 'READY' | 'PENDING' | 'PARTIAL'; qtyReady: number };
    const flipBatches = new Map<string, FlipBatch>();
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
      for (let i = 0; i < batch.ids.length; i += 200) {
        const { error } = await sb.from('mfg_sales_order_items')
          .update({ stock_status: batch.status, stock_qty_ready: batch.qtyReady })
          .in('id', batch.ids.slice(i, i + 200));
        if (error) throw new Error(`allocation line update failed: ${error.message}`);
      }
      linesFlipped += batch.ids.length;
    }

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

    const flippable: Array<{ id: string; current: string }> = [
      ...needs.map((n) => ({ id: n.id, current: n.current })),
      ...sofaLineRecs.map((s) => ({ id: s.id, current: s.current })),
    ];
    const toReady   = flippable.filter((n) => targetById.get(n.id)?.status === 'READY'   && targetById.get(n.id)?.status !== n.current).map((n) => n.id);
    const toPending = flippable.filter((n) => targetById.get(n.id)?.status === 'PENDING' && targetById.get(n.id)?.status !== n.current).map((n) => n.id);
    const toPartial = flippable.filter((n) => targetById.get(n.id)?.status === 'PARTIAL' && targetById.get(n.id)?.status !== n.current).map((n) => n.id);
    const targetStatusById = new Map<string, string>();
    for (const [id, t] of targetById) targetStatusById.set(id, t.status);

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
        try {
          const docNos = [...new Set(auditRows.map((r) => r.so_doc_no as string))];
          const { data: coRows } = await chunkIn<{ doc_no: string; company_id: number | null }>(docNos, (batch, from, to) =>
            sb.from('mfg_sales_orders').select('doc_no, company_id').in('doc_no', batch).order('doc_no').range(from, to));
          const coByDoc = new Map(coRows.map((r) => [r.doc_no, r.company_id]));
          for (const r of auditRows) {
            const cid = coByDoc.get(r.so_doc_no as string);
            if (cid != null) r.company_id = cid;
          }
        } catch { }
        try { await sb.from('mfg_so_audit_log').insert(auditRows); }
        catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] audit insert failed:', e); }
      }
    }

    const touchedDocs = new Set<string>(scopeToDocNo ? [scopeToDocNo] : orders.map((order) => order.doc_no));

    let ordersAdvanced = 0, ordersRegressed = 0;
    const deferredDocNos: string[] = [];
    for (const docNo of touchedDocs) {
      const order = orderByDoc.get(docNo);
      if (!order) continue;
      if (isDocumentHeld(order)) continue;
      const docLines = lines.filter((l) => l.doc_no === docNo);
      const readinessLines = docLines.map((l) => ({
        item_group: l.item_group,
        item_code: l.item_code,
        category: serviceCodes.has(l.item_code) ? 'SERVICE' : null,
        stock_status: targetStatusById.get(l.id) ?? l.stock_status,
        fulfilled: (Number(l.qty ?? 0)
          - (deliveredBySoItem.get(l.id) ?? 0)
          + (returnedBySoItem.get(l.id) ?? 0)) <= 0,
      }));
      const r = summariseReadiness(readinessLines);
      const cur = order.status;
      const auditAutoStatus = async (from: string, to: string, note: string) => {
        try {
          await sb.from('mfg_so_status_changes').insert({
            ...(order.company_id != null ? { company_id: order.company_id } : {}),
            doc_no: docNo, from_status: from, to_status: to, changed_by: null, notes: note,
          });
        } catch { }
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
      if (r.isShipReady && (cur === 'CONFIRMED' || cur === 'IN_PRODUCTION')) {
        const advanced = await advanceSoGeneration(sb, docNo, { status: 'READY_TO_SHIP' }, { status: cur });
        if (advanced.applied) {
          ordersAdvanced += 1;
          await auditAutoStatus(cur, 'READY_TO_SHIP', 'Auto-advanced: every main product line is READY (stock allocation)');
        } else {
          deferredDocNos.push(`${docNo}:${advanced.reason}`);
        }
      } else if (!r.isShipReady && cur === 'READY_TO_SHIP') {
        const regressTo = liveStatusForProcessingDate(order.processing_date);
        const regressed = await advanceSoGeneration(sb, docNo, { status: regressTo }, { status: cur });
        if (regressed.applied) {
          ordersRegressed += 1;
          await auditAutoStatus(cur, regressTo, r.mainCount + r.accCount === 0
            ? 'Auto-regressed: the order has no stock-bearing lines — not ship-able'
            : 'Auto-regressed: a main product line is no longer READY (stock re-allocated)');
        } else {
          deferredDocNos.push(`${docNo}:${regressed.reason}`);
        }
      }
    }

    return {
      ok: true, linesFlipped, ordersAdvanced, ordersRegressed,
      ...(deferredDocNos.length > 0 ? { deferredDocNos } : {}),
      ...(nonSellingBlockedDocs.size > 0
        ? { nonSellingWarehouseDocNos: [...nonSellingBlockedDocs].sort() }
        : {}),
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
