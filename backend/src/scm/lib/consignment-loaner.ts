
import { writeMovements } from './inventory-movements';
import { reconcileUncostedAfterIn } from './oversell-retrocost';

export type LoanerSourceType = 'CS_DO' | 'CS_DR';

export type LoanerLine = {
  item_code: string;
  variant_key: string;
  product_name: string | null;
  qty: number;
};

/**
 * The hidden Consignment (Out) warehouse id (migration 0152) FOR ONE COMPANY,
 * or null when that company hasn't seeded one. Callers skip the transfer when
 * null.
 *
 * `companyId` IS REQUIRED, for the same reason `defaultWarehouseId` took the
 * same medicine on 2026-08-03 (lib/inventory-movements.ts, which spells the
 * incident out): a warehouse lookup with no company predicate is a
 * cross-company draw decided silently by whatever the database returns first.
 *
 * This one was worse than a draw, because it also had `.maybeSingle()` and no
 * `error` binding. Three failure modes sat behind one `null`:
 *   · GLOBAL SINGLETON — `scm.warehouses` is per-company (migration 0086), so
 *     `is_consignment = true` can legitimately be true once PER COMPANY. The
 *     unscoped read treated the whole table as if only one such warehouse could
 *     exist anywhere;
 *   · WRONG COMPANY'S WAREHOUSE — with exactly one seeded, every company
 *     resolved to it, so one organisation's consignment stock would have moved
 *     into another organisation's warehouse row;
 *   · TWO ROWS = SILENT NULL — the moment a second company seeded its own,
 *     PostgREST's `.maybeSingle()` errors on multiple rows, the discarded
 *     `error` made that identical to "not seeded", and the documented caller
 *     behaviour is to SKIP the stock transfer. So seeding a warehouse correctly
 *     would have quietly disabled the loaner movement for BOTH companies.
 *
 * Ordered and limited rather than `.maybeSingle()`, so a company that somehow
 * holds two consignment warehouses gets a deterministic answer instead of an
 * error rendered as an absence.
 *
 * NOTE FOR WHOEVER WIRES THIS UP: this module currently has no importers —
 * `transferLoaner` and `reverseLoaner` are exported and uncalled — so nothing in
 * production reaches this today. That is exactly why the signature is being
 * fixed now: the trap is cheaper to disarm before it has callers than after.
 */
export async function consignmentWarehouseId(
  sb: any,
  companyId: number | undefined,
): Promise<string | null> {
  if (companyId === undefined) return null;
  const { data } = await sb.from('warehouses')
    .select('id')
    .eq('is_consignment', true)
    .eq('company_id', companyId)
    .order('code', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function resolveSourceBatches(
  sb: any,
  fromWh: string,
): Promise<Map<string, string | null>> {
  const batchByBucket = new Map<string, string | null>();
  try {
    const { data: lots, error } = await sb
      .from('v_inventory_lots_open')
      .select('warehouse_id, item_code, variant_key, batch_no, qty_remaining')
      .eq('warehouse_id', fromWh)
      .not('batch_no', 'is', null)
      .gt('qty_remaining', 0);
    if (!error) {
      const batchesByBucket = new Map<string, Set<string>>();
      for (const r of (lots ?? []) as Array<{
        item_code: string; variant_key: string | null; batch_no: string | null;
      }>) {
        if (!r.batch_no) continue;
        const k = `${r.item_code}::${r.variant_key ?? ''}`;
        const set = batchesByBucket.get(k) ?? new Set<string>();
        set.add(r.batch_no);
        batchesByBucket.set(k, set);
      }
      for (const [k, set] of batchesByBucket.entries()) {
        batchByBucket.set(k, set.size === 1 ? [...set][0]! : null);
      }
    }
  } catch { }
  return batchByBucket;
}

/**
 * Value-neutral loaner transfer of `lines` from `fromWh` to `toWh`.
 *
 * For each line:
 *   1) Insert an OUT @fromWh (the FIFO trigger fills total_cost_sen). This OUT
 *      carries the CS_DO / CS_DR source type — its partial UNIQUE index is the
 *      per-doc idempotency backstop.
 *   2) Read the OUT back, derive unit_cost = total_cost / qty (weighted avg).
 *   3) Insert an IN @toWh carrying that unit_cost_sen + the source dye-lot batch.
 *      The IN is tagged 'STOCK_TRANSFER' (same source_doc_id) so it never
 *      collides with the OUT on the CS_* unique index (which omits warehouse_id).
 *
 * Goods stay owned — no COGS, no margin: total valuation is unchanged, only the
 * physical location moves. Best-effort; returns the per-line error strings (if
 * any) so the caller can log without rolling back the note.
 */
export async function transferLoaner(
  sb: any,
  fromWh: string,
  toWh: string,
  lines: LoanerLine[],
  sourceDocType: LoanerSourceType,
  sourceDocId: string,
  sourceDocNo: string,
  userId: string | null,
  companyId: number | null | undefined,
): Promise<string[]> {
  const errors: string[] = [];
  if (!fromWh || !toWh || fromWh === toWh || lines.length === 0) return errors;
  const companyCol = companyId != null ? { company_id: companyId } : {};

  const batchByBucket = await resolveSourceBatches(sb, fromWh);

  const byKey = new Map<string, LoanerLine>();
  for (const ln of lines) {
    const qty = Number(ln.qty ?? 0);
    if (qty <= 0 || !ln.item_code) continue;
    const variantKey = ln.variant_key ?? '';
    const k = `${ln.item_code}::${variantKey}`;
    const cur = byKey.get(k);
    if (cur) { cur.qty += qty; }
    else byKey.set(k, { item_code: ln.item_code, variant_key: variantKey, product_name: ln.product_name ?? null, qty });
  }

  for (const ln of byKey.values()) {
    const variantKey = ln.variant_key ?? '';
    const batchNo = batchByBucket.get(`${ln.item_code}::${variantKey}`) ?? null;

    const { data: outRow, error: outErr } = await sb.from('inventory_movements').insert({
      ...companyCol,
      movement_type:   'OUT',
      warehouse_id:    fromWh,
      item_code:    ln.item_code,
      variant_key:     variantKey,
      product_name:    ln.product_name,
      qty:             ln.qty,
      source_doc_type: sourceDocType,
      source_doc_id:   sourceDocId,
      source_doc_no:   sourceDocNo,
      ...(batchNo ? { batch_no: batchNo } : {}),
      performed_by:    userId,
      notes:           `Consignment loaner transfer to warehouse ${toWh} (value-neutral)`,
    }).select('id, qty, unit_cost_sen, total_cost_sen').single();
    if (outErr || !outRow) {
      errors.push(`OUT ${ln.item_code}: ${outErr?.message ?? 'no data'}`);
      continue;
    }

    const outQty   = Number((outRow as { qty: number }).qty ?? ln.qty);
    const outTotal = Number((outRow as { total_cost_sen: number | null }).total_cost_sen ?? 0);
    const inUnitCost = outQty > 0 ? Math.round(outTotal / outQty) : 0;

    const inOk = await writeMovements(sb, [{
      movement_type:   'IN',
      warehouse_id:    toWh,
      item_code:    ln.item_code,
      variant_key:     variantKey,
      product_name:    ln.product_name,
      qty:             ln.qty,
      unit_cost_sen:   inUnitCost,
      source_doc_type: 'STOCK_TRANSFER',
      source_doc_id:   sourceDocId,
      source_doc_no:   sourceDocNo,
      ...(batchNo ? { batch_no: batchNo } : {}),
      performed_by:    userId,
      notes:           `Consignment loaner transfer from warehouse ${fromWh} (value-neutral)`,
    }], companyId);
    if (!inOk.ok) errors.push(`IN ${ln.item_code}: ${inOk.reason ?? 'unknown'}`);
    if (inOk.ok) {
      await reconcileUncostedAfterIn(sb, [{
        movement_type: 'IN', warehouse_id: toWh, item_code: ln.item_code,
        variant_key: variantKey, qty: ln.qty,
      }], userId);
    }
  }

  try {
    const { recomputeAllocationAfterSave } = await import('./stock-allocation-job');
    await recomputeAllocationAfterSave(sb, 'loaner-transfer');
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[consignment-loaner] post-transfer allocation failed:', e); }

  return errors;
}

/**
 * Reverse a prior loaner transfer (used on cancel). We re-derive the original
 * transfer's net effect from THIS doc's own movements and run transferLoaner in
 * the OPPOSITE direction (swap from/to), with a '-CANCEL' source-doc-no suffix.
 *
 * Why not reverseMovements: its balancing row reuses the CS_* (source_doc_type,
 * source_doc_id, item_code, variant_key) key, which the partial UNIQUE index
 * uq_inv_mov_cs_*_source (migration 0153, keyed WITHOUT movement_type) rejects —
 * the same-key opposite collides and the insert silently fails, leaving the
 * loaner permanently relocated. Running transferLoaner in reverse sidesteps that
 * (the reversing OUT consumes from the consignment warehouse under a fresh
 * STOCK_TRANSFER leg, and the reversing CS_* OUT is a brand-new product/variant
 * at the original source warehouse — but to stay clear of the index entirely the
 * reversal is written wholly under STOCK_TRANSFER via a direct pair).
 *
 * IDEMPOTENCY: the reversal pre-checks for an existing '-CANCEL' STOCK_TRANSFER
 * row tagged with this doc id and skips if found, so a double-cancel is a no-op.
 * Best-effort.
 */
export async function reverseLoaner(
  sb: any,
  sourceDocType: LoanerSourceType,
  sourceDocId: string,
  sourceDocNo: string,
  fromWh: string,
  toWh: string,
  userId: string | null,
  companyId: number | null | undefined,
): Promise<string[]> {
  const errors: string[] = [];
  if (!fromWh || !toWh || fromWh === toWh) return errors;
  const companyCol = companyId != null ? { company_id: companyId } : {};
  const cancelNo = `${sourceDocNo}-CANCEL`;

  const { count: alreadyReversed } = await sb
    .from('inventory_movements')
    .select('id', { head: true, count: 'exact' })
    .eq('source_doc_id', sourceDocId)
    .eq('source_doc_type', 'STOCK_TRANSFER')
    .eq('source_doc_no', cancelNo);
  if ((alreadyReversed ?? 0) > 0) return errors;

  const sel = 'id, movement_type, item_code, variant_key, batch_no, qty, total_cost_sen, product_name';
  let movsRes = await sb.from('inventory_movements').select(sel)
    .eq('source_doc_type', sourceDocType).eq('source_doc_id', sourceDocId);
  if (movsRes.error && (movsRes.error.message ?? '').includes('batch_no')) {
    movsRes = await sb.from('inventory_movements')
      .select('id, movement_type, item_code, variant_key, qty, total_cost_sen, product_name')
      .eq('source_doc_type', sourceDocType).eq('source_doc_id', sourceDocId);
  }
  if (movsRes.error) { errors.push(`reverse load: ${movsRes.error.message}`); return errors; }

  const outs = ((movsRes.data ?? []) as Array<{
    id: string; movement_type: string; item_code: string; variant_key: string | null;
    batch_no?: string | null; qty: number; total_cost_sen: number | null; product_name: string | null;
  }>).filter((m) => m.movement_type === 'OUT' && Number(m.qty ?? 0) > 0);

  for (const o of outs) {
    const variantKey = o.variant_key ?? '';
    const batchNo = o.batch_no ?? null;
    const qty = Number(o.qty);
    const unitCost = Math.round(Number(o.total_cost_sen ?? 0) / qty);

    const { error: outErr } = await sb.from('inventory_movements').insert({
      ...companyCol,
      movement_type:   'OUT',
      warehouse_id:    toWh,
      item_code:    o.item_code,
      variant_key:     variantKey,
      product_name:    o.product_name,
      qty,
      source_doc_type: 'STOCK_TRANSFER',
      source_doc_id:   sourceDocId,
      source_doc_no:   cancelNo,
      ...(batchNo ? { batch_no: batchNo } : {}),
      performed_by:    userId,
      notes:           `Consignment loaner cancelled — reversing transfer (value-neutral)`,
    }).select('id').single();
    if (outErr) { errors.push(`reverse OUT ${o.item_code}: ${outErr.message}`); continue; }

    const inOk = await writeMovements(sb, [{
      movement_type:   'IN',
      warehouse_id:    fromWh,
      item_code:    o.item_code,
      variant_key:     variantKey,
      product_name:    o.product_name,
      qty,
      unit_cost_sen:   unitCost,
      reverses_movement_id: o.id,
      source_doc_type: 'STOCK_TRANSFER',
      source_doc_id:   sourceDocId,
      source_doc_no:   cancelNo,
      ...(batchNo ? { batch_no: batchNo } : {}),
      performed_by:    userId,
      notes:           `Consignment loaner cancelled — reversing transfer (value-neutral)`,
    }], companyId);
    if (!inOk.ok) errors.push(`reverse IN ${o.item_code}: ${inOk.reason ?? 'unknown'}`);
    if (inOk.ok) {
      await reconcileUncostedAfterIn(sb, [{
        movement_type: 'IN', warehouse_id: fromWh, item_code: o.item_code,
        variant_key: variantKey, qty,
      }], userId);
    }
  }

  try {
    const { recomputeAllocationAfterSave } = await import('./stock-allocation-job');
    await recomputeAllocationAfterSave(sb, 'loaner-reverse');
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[consignment-loaner] post-reverse allocation failed:', e); }

  return errors;
}
