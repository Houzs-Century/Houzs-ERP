// ----------------------------------------------------------------------------
// Oversell (short-shipped) retro-costing — app-layer orchestration + the pure
// reference model of the receipt-time reconcile.
//
// THE BUG (money-critical, owner-approved 2026-07-20). The soft "ship anyway"
// oversell path lets a DO ship more than the warehouse holds. The FIFO trigger's
// fn_consume_fifo costs only what is on hand and discards the qty_short, so the
// short units ship at ZERO recorded cost and inventory_balances goes negative.
// The drop-ship receipt reconcile (fn_reconcile_dropship_batch, 0057/0088) only
// catches this up for is_dropship + batched DOs, so a NORMAL oversold DO is never
// retro-costed: COGS stays understated -> margin OVERSTATED permanently, and the
// signed-balance view diverges from the lot-value view forever.
//
// THE FIX. At GRN receipt (the IN that adds stock) reconcileUncostedOuts calls
// the DB function scm.fn_reconcile_uncosted_out (migration 0154) once per
// received (warehouse, product, variant) bucket. That function consumes each
// prior uncosted short OUT's shortfall from the newly-received open lots (plain
// FIFO, real cost), booking consumptions + restamping the OUT COGS; the caller
// then re-stamps the affected DO lines + Sales Invoices. See 0154 for the full
// mechanism and the anti "coverage-theft" guards.
//
// WHY A DB FUNCTION does the actual consumption: it needs atomic SELECT ... FOR
// UPDATE over the FIFO lots, which PostgREST/supabase-js cannot express. Doing it
// in the app layer would open a money-critical race (two receipts double-
// consuming a lot). The wrapper here only orchestrates (which buckets, the
// receipt cutoff) and collects the affected DOs to re-stamp — mirroring how
// reconcileDropshipBatches wraps fn_reconcile_dropship_batch.
//
// planUncostedRetrocost is the PURE, in-memory mirror of what the SQL function
// does. This repo's vitest harness rebuilds only the D1 side (the scm FIFO layer
// is Supabase Postgres + PL/pgSQL and cannot run under the Workers pool), so the
// SQL itself is untestable here — the model is the executable specification the
// SQL is written against, and what oversell-retrocost.test.ts exercises. KEEP THE
// TWO IN LOCKSTEP: any change to fn_reconcile_uncosted_out must change this too.
//
// That instruction was in capitals here and was still missed once (migration
// 0230 narrowed the SQL and left this file untouched, so the test suite went on
// asserting behaviour production no longer had). It is now ENFORCED rather than
// requested: oversell-retrocost.test.ts reads the newest migration that defines
// fn_reconcile_uncosted_out and fails if its guard set is not the guard set
// planUncostedRetrocost implements. Change one, the test names the other.
//
// SQL-ONLY (no lockstep counterpart): the 2026-07-20 enum-coercion hotfix —
// `UPPER(COALESCE(d.status::text, ''))` in fn_reconcile_uncosted_out (0154) and in
// its already-live sibling fn_reconcile_dropship_batch (0155) — is a Postgres
// plan-time fix only. doStatus is a plain string in this model, so the CANCELLED
// guard below (`(m.doStatus ?? '').toUpperCase()`) never reaches Postgres's enum
// input parser and needs no change. The two stay in lockstep on LOGIC; the ::text
// cast has no behavioural effect to mirror.
// ----------------------------------------------------------------------------

/** One prior OUT movement in a single (warehouse, product, variant) + company
 *  bucket, with the ledger facts the reconcile decision depends on. */
export type RetroOutMovement = {
  movementId: string;
  /** Source DO id (source_doc_id). Collected for the COGS re-stamp. */
  doId: string;
  /** Requested OUT qty (inventory_movements.qty; stored as a positive count). */
  qty: number;
  /** inventory_movements.created_at (ISO). The temporal anti-theft key. */
  createdAt: string;
  /** delivery_orders.is_dropship — drop-ship coverage is owned by 0088. */
  isDropship: boolean;
  /** Migration 0230 — a line of this OUT's DO commits this movement's batch in
   *  this variant AND is STRICT-BATCH (a sofa dye lot). Those belong to
   *  fn_reconcile_dropship_batch alone; costing them from any open lot here
   *  would mix dye lots.
   *
   *  ⚠ NON-strict commitments (mattress / bedframe / accessory) are NOT excluded
   *  — deliberately. They have no dye lot, and their bound PO can die (cancelled,
   *  re-raised under a new number, superseded by a transfer or a stock take)
   *  without any reconcile noticing. If they were excluded, the batch-agnostic
   *  repair would step over them permanently and their COGS would stay at RM0 —
   *  a worse version of the very bug 0230 was written to end. Optional so every
   *  pre-0230 caller and fixture keeps its meaning (undefined = not strict). */
  strictBatchCommitted?: boolean;
  /** delivery_orders.status — a CANCELLED DO's OUT was already reversed. */
  doStatus: string;
  /** Σ inventory_lot_consumptions.qty_consumed already booked for this movement
   *  (ship-time partial + any prior reconcile). Drives idempotent shortfall. */
  alreadyConsumedQty: number;
  /** Σ inventory_lot_consumptions.total_cost_sen already booked for this movement
   *  — the OUT's current total_cost_sen, the base the restamp adds onto. */
  alreadyCostedSen: number;
};

/** One open FIFO lot in the bucket (inventory_lots, qty_remaining > 0). */
export type RetroLot = {
  lotId: string;
  /** inventory_lots.received_at (ISO). FIFO consumption order. */
  receivedAt: string;
  qtyRemaining: number;
  unitCostSen: number;
};

export type RetroPlanLine = {
  movementId: string;
  doId: string;
  /** Units retro-costed now (0 excluded from the plan). */
  retroQty: number;
  /** Cost booked now (sen), from the lots' real unit costs — never a fallback. */
  retroCostSen: number;
  /** The OUT movement's total_cost_sen after the restamp (base + retro). */
  newTotalCostSen: number;
  /** Residual shortfall left uncosted because no lot was available — retro-costed
   *  by a LATER receipt (still idempotent). */
  stillShortQty: number;
};

export type RetroPlan = {
  lines: RetroPlanLine[];
  /** Lots with qty_remaining decremented by what the plan consumed. */
  lotsAfter: RetroLot[];
  totalRetroQty: number;
  /** Distinct DOs whose OUT COGS changed — the ones to re-stamp. */
  affectedDoIds: string[];
};

/**
 * Pure reference model of scm.fn_reconcile_uncosted_out for ONE
 * (warehouse, product, variant) + company bucket. Given the bucket's prior OUT
 * movements, its open lots, and the receipt cutoff, returns the retro-cost plan
 * (which OUTs get topped up, by how much, from which lots) and the resulting lot
 * balances. No I/O — the SQL function performs the same walk atomically under row
 * locks in the database.
 *
 * Guards (identical to the SQL):
 *   - TEMPORAL: only OUTs created strictly before cutoffTs (prior to the receipt)
 *     — the direct defence against diverting a later order's stock.
 *   - is_dropship = false (0088 owns drop-ship) and status <> CANCELLED.
 *   - NOT a STRICT-BATCH per-line commitment (0230) — a bound sofa OUT is the
 *     batched reconcile's alone. A bound non-sofa OUT stays eligible here.
 *   - OLDEST-FIRST (created_at, then movementId) so limited stock covers the
 *     earliest short first.
 *   - IDEMPOTENT: shortfall = abs(qty) - alreadyConsumedQty, so a short already
 *     costed once contributes nothing on a re-run (never double-costed).
 */
export function planUncostedRetrocost(
  movements: RetroOutMovement[],
  lots: RetroLot[],
  cutoffTs: string,
): RetroPlan {
  // Work on a copy of the lots, FIFO-ordered, so the caller's array is untouched.
  const lotsAfter: RetroLot[] = lots
    .map((l) => ({ ...l }))
    .sort((a, b) =>
      a.receivedAt < b.receivedAt ? -1
        : a.receivedAt > b.receivedAt ? 1
        : a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0);

  const eligible = movements
    .filter((m) =>
      m.createdAt < cutoffTs &&
      !m.isDropship &&
      !m.strictBatchCommitted &&
      (m.doStatus ?? '').toUpperCase() !== 'CANCELLED')
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1
        : a.createdAt > b.createdAt ? 1
        : a.movementId < b.movementId ? -1 : a.movementId > b.movementId ? 1 : 0);

  const lines: RetroPlanLine[] = [];
  const affected = new Set<string>();
  let totalRetroQty = 0;

  for (const m of eligible) {
    // Idempotent shortfall — abs() mirrors the SQL (qty is a positive count, but
    // guard the sign so a defensively-signed OUT can't invert the shortfall).
    let short = Math.abs(m.qty) - m.alreadyConsumedQty;
    if (short <= 0) continue;

    let retroQty = 0;
    let retroCostSen = 0;
    for (const lot of lotsAfter) {
      if (short <= 0) break;
      if (lot.qtyRemaining <= 0) continue;
      const take = Math.min(lot.qtyRemaining, short);
      lot.qtyRemaining -= take;
      retroQty += take;
      retroCostSen += take * lot.unitCostSen;
      short -= take;
    }
    if (retroQty === 0) continue; // no lot available — leave for a later receipt

    lines.push({
      movementId: m.movementId,
      doId: m.doId,
      retroQty,
      retroCostSen,
      newTotalCostSen: m.alreadyCostedSen + retroCostSen,
      stillShortQty: short,
    });
    affected.add(m.doId);
    totalRetroQty += retroQty;
  }

  return { lines, lotsAfter, totalRetroQty, affectedDoIds: [...affected] };
}

/** A (warehouse, product, variant) bucket the reconcile should scan. batch_no is
 *  intentionally NOT part of the key: a normal oversell ships unbatched while the
 *  arriving lot is batched, so the reconcile matches on the SKU and consumes lots
 *  plain-FIFO regardless of batch (see 0154). */
export type UncostedBucket = {
  warehouse_id: string;
  product_code: string;
  variant_key: string;
};

/**
 * Receipt-time retro-cost of oversold NON-drop-ship DO OUTs. After a GRN posts
 * its IN movements (the FIFO trigger having opened the new lots), call this with
 * the received buckets and the receipt cutoff. For each distinct bucket it
 * invokes scm.fn_reconcile_uncosted_out, which consumes every prior uncosted
 * short OUT's shortfall from the new lots (plain FIFO, real cost) and restamps
 * the OUT COGS. Returns the qty reconciled and the DOs whose cost changed so the
 * caller can re-stamp their lines + Sales Invoices.
 *
 * Best-effort, mirroring reconcileDropshipBatches: a missing function (pre-0154)
 * or any error is logged and swallowed so the GRN post is never rolled back — but
 * NOTE it never fabricates a cost: on failure it simply reconciles nothing and
 * the shortfall is retried on the next receipt.
 *
 * @param cutoffTs ISO timestamp captured right AFTER the IN rows post. Only OUTs
 *   created before it (prior shipments) are eligible — the coverage-theft guard.
 */
export async function reconcileUncostedOuts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  buckets: UncostedBucket[],
  cutoffTs: string,
  performedBy: string | null,
): Promise<{ ok: boolean; reconciled: number; affectedDoIds: string[]; reason?: string }> {
  // One call per distinct (warehouse, product, variant) bucket.
  const seen = new Set<string>();
  const distinct = buckets.filter((b) => {
    const k = `${b.warehouse_id}::${b.product_code}::${b.variant_key ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (distinct.length === 0) return { ok: true, reconciled: 0, affectedDoIds: [] };

  let reconciled = 0;
  for (const b of distinct) {
    try {
      const { data, error } = await sb.rpc('fn_reconcile_uncosted_out', {
        p_warehouse_id: b.warehouse_id,
        p_product_code: b.product_code,
        p_variant_key: b.variant_key ?? '',
        p_before_ts: cutoffTs,
        p_created_by: performedBy,
      });
      if (error) {
        // Pre-0154 (function not created) — silently no-op; nothing to reconcile.
        if (!(error.message ?? '').includes('fn_reconcile_uncosted_out')) {
          // eslint-disable-next-line no-console
          console.error('[oversell] retro-cost reconcile failed:', error.message);
        }
      } else {
        reconciled += Number(data ?? 0);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[oversell] retro-cost reconcile exception:', e);
    }
  }

  // Collect the non-drop-ship DOs with a prior OUT in any reconciled bucket, so
  // the caller can re-stamp their actual COGS (the reconcile bumped those OUT
  // movements' total_cost_sen from the arriving lots). Bounded to created_at <
  // cutoff — the same prior-shipment window the reconcile used — so a later
  // order's DO is never dragged into the re-stamp. Re-stamp is idempotent, so a
  // DO that happened not to be short recomputes the same cost (harmless).
  const affectedDoIds = new Set<string>();
  if (reconciled > 0) {
    try {
      const codes = [...new Set(distinct.map((b) => b.product_code))];
      const whs = [...new Set(distinct.map((b) => b.warehouse_id))];
      const { data: outs } = await sb
        .from('inventory_movements')
        .select('source_doc_type, source_doc_id, product_code, warehouse_id, variant_key, created_at')
        .eq('movement_type', 'OUT')
        .in('product_code', codes)
        .in('warehouse_id', whs)
        .lt('created_at', cutoffTs);
      const bucketKeys = new Set(distinct.map((b) => `${b.warehouse_id}::${b.product_code}::${b.variant_key ?? ''}`));
      for (const m of (outs ?? []) as Array<{ source_doc_type: string | null; source_doc_id: string | null; product_code: string; warehouse_id: string; variant_key: string | null; created_at?: string | null }>) {
        if ((m.source_doc_type ?? '').toUpperCase() !== 'DO' || !m.source_doc_id) continue;
        // Belt-and-suspenders on the temporal window: never re-stamp a DO that
        // shipped at/after the receipt (the query already bounds this — re-check
        // in JS so a dropped filter can't widen a money re-stamp to a later order).
        if (m.created_at != null && m.created_at >= cutoffTs) continue;
        const k = `${m.warehouse_id}::${m.product_code}::${m.variant_key ?? ''}`;
        if (!bucketKeys.has(k)) continue;
        affectedDoIds.add(m.source_doc_id);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[oversell] affected-DO lookup failed:', e);
    }
  }
  return { ok: true, reconciled, affectedDoIds: [...affectedDoIds] };
}

// ----------------------------------------------------------------------------
// reconcileUncostedAfterIn — the SHARED post-IN entry point (2026-07-29).
//
// WHY. reconcileUncostedOuts above was wired to exactly ONE caller, the GRN post
// handler. Lots are opened by MANY other paths (stock transfer, stock take,
// manual adjustment, consignment receive, and every return / resync / reversal
// that books goods back onto the shelf), and none of them retro-costed the prior
// short. An accessory oversold via "ship anyway" and then replenished by an
// inter-warehouse transfer or a positive count stayed at RM0 COGS forever —
// `docs/inventory-costing-oversell-coe.md`, BUG-HISTORY 2026-07-24.
//
// WHAT. Give every stock-IN path the SAME reconcile the GRN post runs, in one
// line: hand it the movement rows that were just committed and it derives the
// lot-opening buckets, reconciles, and re-stamps the affected DO lines + Sales
// Invoices. No costing logic lives here — it delegates to reconcileUncostedOuts,
// which delegates to scm.fn_reconcile_uncosted_out (migration 0154). No schema
// or SQL change: the function's signature is unchanged, only who calls it.
//
// NEVER THROWS. A retro-cost is a repair, never a precondition of the receipt
// that triggered it: a failure here must not roll back a legitimate stock IN.
// Everything is swallowed and logged, exactly like the GRN callsite, and the
// shortfall is simply retried (idempotently) on the next IN into that bucket.
//
// The GRN post keeps its own inline block deliberately: there the oversell
// reconcile must run AFTER reconcileDropshipBatches, and its cutoff is captured
// before that call, so the ordering is load-bearing and is left untouched.
// ----------------------------------------------------------------------------

/** A movement row as any stock-IN path writes it. Typed loose on purpose so both
 *  the strongly-typed writeMovements payloads and the raw
 *  `Record<string, unknown>` inserts (stock take, adjustment) fit without a cast. */
export type PostedMovementRow = {
  movement_type?: unknown;
  warehouse_id?: unknown;
  product_code?: unknown;
  variant_key?: unknown;
  qty?: unknown;
};

/**
 * Retro-cost prior oversold OUTs from the lots a just-committed stock IN opened.
 * Call AFTER the movement rows are written (the FIFO trigger opens the lots on
 * insert, so they exist by the time this runs).
 *
 * Lot-opening test mirrors the FIFO trigger (`inventory-fifo-trigger.sql`):
 * `IN` always opens a lot; `ADJUSTMENT` opens one only when qty > 0 — a negative
 * ADJUSTMENT consumes lots exactly like an OUT and must NOT trigger a reconcile.
 * Rows that open nothing are ignored, so a mixed OUT/IN batch (a GRN warehouse
 * relocate, a resync delta) is safe to pass wholesale.
 *
 * @param rows the movement rows just committed (any mix; filtered here)
 * @param performedBy actor id stamped on the retro-cost consumptions
 */
export async function reconcileUncostedAfterIn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  rows: PostedMovementRow[] | null | undefined,
  performedBy: string | null,
): Promise<{ reconciled: number; affectedDoIds: string[] }> {
  const none = { reconciled: 0, affectedDoIds: [] as string[] };
  try {
    const buckets: UncostedBucket[] = [];
    for (const r of rows ?? []) {
      const type = String(r?.movement_type ?? '').toUpperCase();
      const opensLot = type === 'IN' || (type === 'ADJUSTMENT' && Number(r?.qty ?? 0) > 0);
      if (!opensLot) continue;
      const warehouseId = typeof r?.warehouse_id === 'string' ? r.warehouse_id : '';
      const productCode = typeof r?.product_code === 'string' ? r.product_code : '';
      if (!warehouseId || !productCode) continue;
      buckets.push({
        warehouse_id: warehouseId,
        product_code: productCode,
        variant_key: typeof r?.variant_key === 'string' ? r.variant_key : '',
      });
    }
    if (buckets.length === 0) return none;

    /* Cutoff = now, i.e. after the IN committed. Only OUTs that shipped BEFORE
       this may draw on the arriving lots; a later order consumes them through the
       normal FIFO trigger at its own ship time (coverage-theft guard, 0154). */
    const cutoffTs = new Date().toISOString();
    const res = await reconcileUncostedOuts(sb, buckets, cutoffTs, performedBy);
    if (res.affectedDoIds.length > 0) {
      try {
        const { restampDoActualCost } = await import('../routes/delivery-orders-mfg');
        const { restampSiFromDo } = await import('./recost');
        for (const doId of res.affectedDoIds) {
          await restampDoActualCost(sb, doId);
          try { await restampSiFromDo(sb, doId); } catch { /* best-effort */ }
        }
      } catch (e) { /* eslint-disable-next-line no-console */ console.error('[oversell] DO restamp failed:', e); }
    }
    return { reconciled: res.reconciled, affectedDoIds: res.affectedDoIds };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[oversell] post-IN reconcile failed:', e);
    return none;
  }
}
