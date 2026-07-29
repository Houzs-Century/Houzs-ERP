// ----------------------------------------------------------------------------
// /stock-transfers — move stock between warehouses with a document trail.
//
// PR-DRAFT-removal (2026-05-27): DRAFT step removed. POST creates the row
// as POSTED directly. PATCH /:id/post kept as no-op for backward compat.
//
// Atomicity (audit R3, 2026-07-24): the paired OUT@from + IN@to for the whole
// transfer are written by scm.fn_stock_transfer_apply (migration 0192) in ONE
// transaction — any failure rolls the entire transfer back, so stock is never
// half-moved. The OUT's FIFO trigger consumes the source lots and stamps its
// cost; the function reads that back in-txn and opens the IN@to at OUT.total_cost
// / qty, so the destination lot carries the exact FIFO basis of the source.
//
// Endpoints:
//   GET   /stock-transfers                — list
//   GET   /stock-transfers/:id            — header + lines + warehouse names
//   POST  /stock-transfers                — create + post (writes movements)
//   PATCH /stock-transfers/:id/post       — idempotent no-op (legacy)
//   PATCH /stock-transfers/:id/cancel     — POSTED → CANCELLED + reverses the
//                                            inter-warehouse movement (variant-
//                                            aware, idempotent: only fires on
//                                            ACTIVE→CANCELLED)
//   DELETE /stock-transfers/:id           — disabled (only CANCELLED allowed)
// ----------------------------------------------------------------------------

import { Hono } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { reverseMovements } from '../lib/inventory-movements';
import { buildTransferPayload } from '../lib/stock-transfer-atomic';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { scopeToCompany, activeCompanyId, stampCompany, companyDocPrefix } from '../lib/companyScope';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { recordEntityAudit, compactChanges, fieldChange, statusChange, assertAuditWritable, auditUnavailableBody } from '../lib/entity-audit';

export const stockTransfers = new Hono<{ Bindings: Env; Variables: Variables }>();
stockTransfers.use('*', supabaseAuth);

const HEADER =
  'id, transfer_no, status, from_warehouse_id, to_warehouse_id, transfer_date, ' +
  'notes, posted_at, cancelled_at, created_at, created_by';
const LINE =
  'id, stock_transfer_id, product_code, product_name, variant_key, qty, notes, created_at';

const VALID_STATUS = new Set(['POSTED', 'CANCELLED']);

const nextTransferNo = async (sb: any, c: any): Promise<string> => {
  const d = new Date();
  const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'stock_transfers', 'transfer_no', `${p}ST-${yymm}`);
};

// ── List ──────────────────────────────────────────────────────────────
stockTransfers.get('/', async (c) => {
  const sb = c.get('supabase');
  const status            = c.req.query('status');
  const fromWarehouseId   = c.req.query('fromWarehouseId');
  const toWarehouseId     = c.req.query('toWarehouseId');
  const dateFrom          = c.req.query('dateFrom');
  const dateTo            = c.req.query('dateTo');

  // Page through so PostgREST's default 1000-row cap can't silently truncate
  // the transfer list (filters below only narrow the set).
  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = sb.from('stock_transfers')
      .select(
        `${HEADER}, ` +
        `from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(id, code, name), ` +
        `to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(id, code, name)`,
      )
      .order('transfer_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (status && VALID_STATUS.has(status)) q = q.eq('status', status);
    if (fromWarehouseId) q = q.eq('from_warehouse_id', fromWarehouseId);
    if (toWarehouseId)   q = q.eq('to_warehouse_id',   toWarehouseId);
    if (dateFrom)        q = q.gte('transfer_date', dateFrom);
    if (dateTo)          q = q.lte('transfer_date', dateTo);
    q = scopeToCompany(q, c); // multi-company: isolate to the active company
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  // Add a `lineCount` per row via a follow-up query (cheap, no separate table needed
  // until volumes grow). For pilot scale (<100 transfers/month) this is fine.
  // Cast through unknown — project-wide pattern when the Supabase client is
  // untyped (no generated DB types).
  const rows = (data as unknown as Array<Record<string, unknown>>) ?? [];
  const ids  = rows.map((r) => r.id as string);
  const countByXfer = new Map<string, number>();
  if (ids.length > 0) {
    // chunkIn — ids can exceed 1000 (un-truncated list) and lines across the
    // listed transfers can exceed the 1000-row cap; batch + page so line_count
    // is never understated.
    const { data: lineRows } = await chunkIn<{ stock_transfer_id: string }>(ids, (batch, pFrom, pTo) => sb
      .from('stock_transfer_lines')
      .select('stock_transfer_id')
      .in('stock_transfer_id', batch)
      .range(pFrom, pTo));
    const lineList = (lineRows as unknown as Array<{ stock_transfer_id: string }>) ?? [];
    for (const l of lineList) {
      countByXfer.set(l.stock_transfer_id, (countByXfer.get(l.stock_transfer_id) ?? 0) + 1);
    }
  }

  const transfers = rows.map((r) => ({
    ...r,
    line_count: countByXfer.get(r.id as string) ?? 0,
  }));

  return c.json({ transfers });
});

// ── Detail ────────────────────────────────────────────────────────────
stockTransfers.get('/:id', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');

  const [headerRes, linesRes] = await Promise.all([
    scopeToCompany(sb.from('stock_transfers')
      .select(
        `${HEADER}, ` +
        `from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(id, code, name), ` +
        `to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(id, code, name)`,
      )
      .eq('id', id), c).maybeSingle(),
    sb.from('stock_transfer_lines').select(LINE).eq('stock_transfer_id', id).order('created_at'),
  ]);

  if (headerRes.error) return c.json({ error: 'load_failed', reason: headerRes.error.message }, 500);
  if (!headerRes.data) return c.json({ error: 'not_found' }, 404);

  return c.json({ transfer: headerRes.data, lines: linesRes.data ?? [] });
});

/* ── Movement writer (POST) ──────────────────────────────────────────
   Resolves the per-line dye-lot batch (needs the source lots, so it stays
   here), then hands EVERY line to scm.fn_stock_transfer_apply in ONE RPC.
   That function does each line's OUT@from + IN@to inside a SINGLE transaction
   (audit R3): the OUT's FIFO trigger consumes the source lots and stamps its
   cost, which the function reads back in-txn and carries onto the IN, and any
   failure rolls the WHOLE transfer back — stock can never be half-moved.
   Returns [] on success, or a one-element error list so the POST handler
   auto-cancels the header and returns a non-201. */
async function writeTransferMovements(
  sb: any,
  header: { id: string; transfer_no: string; from_warehouse_id: string; to_warehouse_id: string },
  userId: string,
  // Multi-company (mig 0061): stamp the transfer's company on every movement row.
  companyId?: number | null,
  // Context for scopeToCompany on the source open-lots read (no-ops when the
  // active company is unresolved / single-company fallback).
  c?: any,
): Promise<string[]> {
  const movementErrors: string[] = [];
  const { data: lines } = await sb.from('stock_transfer_lines')
    .select('product_code, product_name, variant_key, qty')
    .eq('stock_transfer_id', header.id);
  const lineList = (lines as Array<{ product_code: string; product_name: string | null; variant_key: string | null; qty: number }>) ?? [];

  /* Resolve the dye-lot batch each line moves so a batched (sofa) lot keeps its
     batch_no across the warehouse hop — otherwise the destination can't satisfy
     a batch-scoped sofa ship. We read OPEN lots at the SOURCE warehouse and, for
     each (product_code, variant_key) bucket, carry the batch ONLY when the source
     stock sits in a single non-null batch. If the bucket spans multiple batches
     (or is plain un-batched), we leave the line un-batched → plain FIFO, rather
     than guess a wrong dye-lot. Forward-compat: pre-0120 the column/view is absent
     → empty map → every line un-batched (old behaviour). */
  const batchByBucket = new Map<string, string | null>(); // key `code::variant` → batch_no | null (ambiguous/none)
  try {
    const { data: lots, error: lotsErr } = await scopeToCompany(
      sb
        .from('v_inventory_lots_open')
        .select('warehouse_id, product_code, variant_key, batch_no, qty_remaining')
        .eq('warehouse_id', header.from_warehouse_id)
        .not('batch_no', 'is', null)
        .gt('qty_remaining', 0),
      c,
    );
    if (!lotsErr) {
      // Collect the distinct non-null batches per bucket; single → carry, else null.
      const batchesByBucket = new Map<string, Set<string>>();
      for (const r of (lots ?? []) as Array<{
        product_code: string; variant_key: string | null; batch_no: string | null;
      }>) {
        if (!r.batch_no) continue;
        const k = `${r.product_code}::${r.variant_key ?? ''}`;
        const set = batchesByBucket.get(k) ?? new Set<string>();
        set.add(r.batch_no);
        batchesByBucket.set(k, set);
      }
      for (const [k, set] of batchesByBucket.entries()) {
        batchByBucket.set(k, set.size === 1 ? [...set][0]! : null);
      }
    }
  } catch { /* view/column absent pre-0120 — every line stays un-batched (plain FIFO) */ }

  /* Build the atomic payload (pure) and hand ALL lines to the DB function in
     one transaction. No more per-line OUT/re-read/IN/compensate in JS: if any
     line fails, fn_stock_transfer_apply rolls the whole transfer back, so a
     partial failure leaves BOTH warehouses untouched (nothing to compensate).
     variant_key '' = unclassified; batchNo carried only when the source bucket
     resolved to a single dye-lot (batchByBucket already collapsed ambiguity). */
  const payload = buildTransferPayload(lineList, batchByBucket);
  if (payload.length > 0) {
    try {
      const { error: rpcErr } = await sb.rpc('fn_stock_transfer_apply', {
        p_from_warehouse_id: header.from_warehouse_id,
        p_to_warehouse_id:   header.to_warehouse_id,
        p_source_doc_id:     header.id,
        p_source_doc_no:     header.transfer_no,
        p_company_id:        companyId ?? null,
        p_performed_by:      userId,
        p_lines:             payload,
      });
      if (rpcErr) movementErrors.push(`TRANSFER ${header.transfer_no}: ${rpcErr.message ?? 'movement apply failed'}`);
      /* Oversell retro-cost (0154) — the transfer just opened lots at the
         DESTINATION. If that warehouse had a prior "ship anyway" DO whose short
         units went out at RM0, retro-cost them from the arriving lots now. Until
         2026-07-29 this ran ONLY on GRN post, so stock replenished by a transfer
         left the earlier shipment at zero COGS forever (COE §2). Best-effort:
         never rolls the transfer back. Only on a clean apply — a failed RPC
         rolled the whole transfer back, so no lot exists to draw on. */
      if (!rpcErr) {
        await reconcileUncostedAfterIn(
          sb,
          payload.map((p) => ({
            movement_type: 'IN',
            warehouse_id: header.to_warehouse_id,
            product_code: p.product_code,
            variant_key: p.variant_key,
            qty: p.qty,
          })),
          userId,
        );
      }
    } catch (e) {
      movementErrors.push(`TRANSFER ${header.transfer_no}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /* Stock Transfer = net-zero across warehouses, but B2C allocation sums all
     warehouses anyway so the totals don't change. Still re-walk in case any
     row failed (partial transfer) and the bucket has actually shifted. */
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-transfer failed:', e); }
  return movementErrors;
}

// ── Create + auto-post ────────────────────────────────────────────────
// body: { fromWarehouseId, toWarehouseId, transferDate?, notes?,
//         items: [{ productCode, productName?, variantKey?, qty, notes? }] }
// PR-DRAFT-removal: row is inserted as POSTED and inventory_movements
// are written inline. No separate /post call needed.
stockTransfers.post('/', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }
  if (body.status === 'DRAFT') return c.json({ error: 'draft_status_not_supported', message: 'DRAFT was removed in migration 0078.' }, 400);

  const fromWarehouseId = body.fromWarehouseId as string | undefined;
  const toWarehouseId   = body.toWarehouseId   as string | undefined;
  if (!fromWarehouseId) return c.json({ error: 'from_warehouse_required' }, 400);
  if (!toWarehouseId)   return c.json({ error: 'to_warehouse_required' }, 400);
  if (fromWarehouseId === toWarehouseId) return c.json({ error: 'same_warehouse' }, 400);

  const items = (body.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (items.length === 0) return c.json({ error: 'items_required' }, 400);

  const headerInsert: Record<string, unknown> = {
    company_id:         activeCompanyId(c), // multi-company: stamp the active company
    status:             'POSTED',
    posted_at:          new Date().toISOString(),
    from_warehouse_id:  fromWarehouseId,
    to_warehouse_id:    toWarehouseId,
    notes:              (body.notes as string | undefined) ?? null,
    created_by:         user.id,
  };
  if (body.transferDate) headerInsert.transfer_date = body.transferDate;

  /* Ask the audit sink BEFORE the header insert — the first write this handler
     makes — because both audit rows below (the success one and the auto-cancel
     one) are written after stock has already moved, so neither can honestly fail
     there. One probe covers both: they share this entity and action, and by the
     time either runs the choice between them is already made. */
  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TRANSFER', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data: headerData, error: hErr } = await insertWithDocNoRetry<{ id: string; transfer_no: string; from_warehouse_id: string; to_warehouse_id: string }>(
    () => nextTransferNo(sb, c),
    (transferNo) => sb
      .from('stock_transfers').insert({ transfer_no: transferNo, ...headerInsert }).select(HEADER).single(),
  );
  if (hErr) {
    if (hErr.code === '42501') return c.json({ error: 'forbidden', reason: hErr.message }, 403);
    return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  }
  const header = headerData as unknown as { id: string; transfer_no: string; from_warehouse_id: string; to_warehouse_id: string };

  const lineRows = items.map((it) => {
    const qty = Math.max(0, Math.floor(Number(it.qty ?? 0)));
    if (qty <= 0) throw new Error('qty must be > 0');
    if (!it.productCode) throw new Error('productCode required per line');
    return {
      stock_transfer_id: header.id,
      product_code: String(it.productCode),
      product_name: (it.productName as string | undefined) ?? null,
      // Variant bucket so the OUT@from / IN@to movements consume + re-open the
      // matching FIFO batch. Omit / '' = unclassified (legacy behaviour).
      variant_key: (it.variantKey as string | undefined) ?? '',
      qty,
      notes: (it.notes as string | undefined) ?? null,
    };
  });
  const { error: lErr } = await sb.from('stock_transfer_lines').insert(stampCompany(lineRows, c));
  if (lErr) {
    await sb.from('stock_transfers').delete().eq('id', header.id);
    return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500);
  }

  // Write inventory movements (paired OUT/IN) inline.
  const movementErrors = await writeTransferMovements(sb, header, user.id, activeCompanyId(c), c);

  /* If the movement apply failed, the transfer did NOT complete — and because
     fn_stock_transfer_apply is atomic, NOTHING moved (both warehouses are
     untouched, no compensation needed). Auto-cancel the header so it can't
     masquerade as a posted transfer, and return a non-201 so the UI surfaces
     the failure instead of silently treating it as success. */
  /* Recorded on BOTH outcomes, with the status snapshot telling them apart. The
     auto-cancel path below is the one a reader most needs in the history: stock
     was touched, the transfer did not complete, and the header now says
     CANCELLED with no other trace of why. */
  const transferChanges = compactChanges([
    fieldChange('fromWarehouseId', null, fromWarehouseId),
    fieldChange('toWarehouseId', null, toWarehouseId),
    fieldChange('transferDate', null, (body.transferDate as string | undefined) ?? null),
    fieldChange('lineCount', null, lineRows.length),
    fieldChange('totalQty', null, lineRows.reduce((s, l) => s + l.qty, 0)),
    fieldChange('notes', null, (body.notes as string | undefined) ?? null),
  ]);

  if (movementErrors.length) {
    await sb.from('stock_transfers')
      .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
      .eq('id', header.id);
    await recordEntityAudit(sb, {
      entityType: 'STOCK_TRANSFER',
      entityId: header.id,
      entityDocNo: header.transfer_no,
      action: 'CREATE',
      actor: c.get('houzsUser'),
      companyId: activeCompanyId(c),
      statusSnapshot: 'CANCELLED',
      note: `Auto-cancelled — movements failed: ${movementErrors.join('; ')}`,
      fieldChanges: transferChanges,
    });
    return c.json({
      error: 'transfer_movements_failed',
      id: header.id,
      transferNo: header.transfer_no,
      status: 'CANCELLED',
      movementErrors,
    }, 422);
  }

  await recordEntityAudit(sb, {
    entityType: 'STOCK_TRANSFER',
    entityId: header.id,
    entityDocNo: header.transfer_no,
    action: 'CREATE',
    actor: c.get('houzsUser'),
    companyId: activeCompanyId(c),
    statusSnapshot: 'POSTED',
    fieldChanges: transferChanges,
  });

  return c.json({
    id: header.id,
    transferNo: header.transfer_no,
  }, 201);
});

// ── Cancel POSTED ─────────────────────────────────────────────────────
// Cancel actually REVERSES the inter-warehouse movement: it posts an
// opposite-direction movement per original row (IN@to → OUT@to, OUT@from →
// IN@from) via reverseMovements, so stock flows back to the source warehouse
// and the FIFO cost basis is restored. Variant-aware (reverseMovements buckets
// by product_code + variant_key + warehouse). Idempotent two ways: the
// status flip is gated POSTED→CANCELLED (the .neq guard returns no row on a
// second call → 409), and reverseMovements itself skips buckets whose signed
// net is already 0, so even a retry that slipped past the gate is a no-op.
stockTransfers.patch('/:id/cancel', async (c) => {
  const sb = c.get('supabase');
  const user = c.get('user');
  const id = c.req.param('id');

  // Gate on the ACTIVE(=POSTED)→CANCELLED transition. Only the call that
  // actually flips the status proceeds to reverse — never on an already
  // CANCELLED row.
  /* The BEFORE half of the audit pair. Read before the flip because afterwards
     the prior status is unrecoverable, and it is exactly what a reader wants:
     "this was POSTED and someone cancelled it". */
  const { data: beforeRow } = await sb.from('stock_transfers')
    .select('transfer_no, status, from_warehouse_id, to_warehouse_id, company_id')
    .eq('id', id).maybeSingle();
  const beforeTransfer = beforeRow as {
    transfer_no: string; status: string;
    from_warehouse_id: string | null; to_warehouse_id: string | null; company_id: number | null;
  } | null;

  const pf = await assertAuditWritable(sb, { entityType: 'STOCK_TRANSFER', entityId: id, action: 'CANCEL', companyId: beforeTransfer?.company_id ?? null });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data, error } = await sb.from('stock_transfers')
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'CANCELLED')
    .select('id, status, cancelled_at').single();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data)  return c.json({ error: 'already_cancelled' }, 409);

  // Reverse the paired OUT/IN movements this transfer wrote. Best-effort,
  // mirroring the post path: a failed reversal row is logged + reported, it
  // does NOT roll back the CANCELLED status (audit-DLQ posture).
  const rev = await reverseMovements(sb, 'STOCK_TRANSFER', id, user?.id ?? null);

  /* One row covering the cancel AND its stock reversal — unlike the PV cancel,
     which splits them, because here the reversal has no independent identity (no
     JE number) and its counts only mean anything next to the cancel itself. A
     partial reversal is the case worth surfacing: the header says CANCELLED but
     stock did not fully come back. */
  await recordEntityAudit(sb, {
    entityType: 'STOCK_TRANSFER',
    entityId: id,
    entityDocNo: beforeTransfer?.transfer_no ?? null,
    action: 'CANCEL',
    actor: c.get('houzsUser'),
    companyId: beforeTransfer?.company_id ?? null,
    statusSnapshot: 'CANCELLED',
    note: rev.failed > 0
      ? `Stock reversal INCOMPLETE — ${rev.failed} failed: ${rev.reason ?? 'partial reversal'}`
      : undefined,
    fieldChanges: compactChanges([
      ...statusChange(beforeTransfer?.status, 'CANCELLED'),
      fieldChange('movementsReversed', null, rev.reversed),
      fieldChange('movementsSkipped', null, rev.skipped),
      fieldChange('movementsFailed', null, rev.failed),
    ]),
  });

  // Net-zero across warehouses again — re-walk B2C stock allocation in case a
  // partial reversal actually shifted a bucket.
  try {
    const { recomputeSoStockAllocation } = await import('../lib/so-stock-allocation');
    await recomputeSoStockAllocation(sb);
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-cancel failed:', e); }

  return c.json({
    transfer: data,
    reversal: { reversed: rev.reversed, skipped: rev.skipped, failed: rev.failed },
    reversalErrors: rev.failed > 0 ? (rev.reason ?? 'partial reversal') : undefined,
  });
});

// ── Post → idempotent no-op (legacy compat) ───────────────────────────
stockTransfers.patch('/:id/post', async (c) => {
  const sb = c.get('supabase');
  const id = c.req.param('id');
  const { data } = await scopeToCompany(sb.from('stock_transfers').select(HEADER).eq('id', id), c).maybeSingle();
  if (!data) return c.json({ error: 'not_found' }, 404);
  const row = data as unknown as { status: string };
  if (row.status === 'POSTED') return c.json({ transfer: data });
  return c.json({ error: 'cannot_post', message: `Cannot post a ${row.status} transfer.` }, 409);
});
