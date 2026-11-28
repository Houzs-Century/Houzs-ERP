
import { yymmFor } from '../../services/documentRefs';
import { Hono } from 'hono';
import { stockTransferDeliveryPodHandler, stockTransferDeliveryPhotoHandler } from './delivery-job-progress';
import { supabaseAuth } from '../middleware/auth';
import type { Env, Variables } from '../env';
import { reverseMovements } from '../lib/inventory-movements';
import { buildTransferPayload } from '../lib/stock-transfer-atomic';
import { reconcileUncostedAfterIn } from '../lib/oversell-retrocost';
import { activeCompanyId, companyDocPrefix, requireActiveCompanyId,
  NOT_THIS_COMPANY, type CompanyScopeCtx } from '../lib/companyScope';
import { scmDb, companyScope, companyIdScope, CENTRALISED,
  type ScmClient, type ScopedDb } from '../lib/scopedDb';
import { mintMonthlyDocNo, insertWithDocNoRetry } from '../lib/doc-no';
import { paginateAll, chunkIn } from '../lib/paginate-all';
import { unreadableMovementError } from '../lib/failed-read-refusal';
import { recordEntityAudit, compactChanges, fieldChange, statusChange, assertAuditWritable, auditUnavailableBody } from '../lib/entity-audit';
import { findTransferShortages, shortageMessage, sumByBucket, STOCK_TRANSFER_ALLOW_SHORT,
  type TransferShortage } from '../lib/stock-transfer-shortages';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { markIdempotencyNoWrite } from '../../middleware/idempotency';

export const stockTransfers = new Hono<{ Bindings: Env; Variables: Variables }>();
stockTransfers.use('*', supabaseAuth);

const HEADER =
  'id, transfer_no, status, from_warehouse_id, to_warehouse_id, transfer_date, ' +
  'notes, posted_at, cancelled_at, created_at, created_by';
const LINE =
  'id, stock_transfer_id, item_code, product_name, variant_key, qty, notes, created_at';

const VALID_STATUS = new Set(['POSTED', 'CANCELLED']);

type ShortStockCtx = Parameters<typeof hasHouzsPerm>[0] & Parameters<typeof markIdempotencyNoWrite>[0];

function shortStockRefusal(c: ShortStockCtx, shortages: TransferShortage[], overrideAsked: boolean) {
  if (shortages.length === 0) return null;
  const canOverride = hasHouzsPerm(c, STOCK_TRANSFER_ALLOW_SHORT);
  if (overrideAsked && canOverride) return null;
  markIdempotencyNoWrite(c);
  return { error: 'insufficient_stock' as const, message: shortageMessage(shortages), shortages, canOverride };
}

const shortOverrideNote = (shortages: TransferShortage[]) =>
  `Posted with short stock (override): ${shortageMessage(shortages)}`;

const nextTransferNo = async (sb: ScmClient, c: CompanyScopeCtx): Promise<string> => {
  const yymm = yymmFor();
  const p = companyDocPrefix(c);
  return mintMonthlyDocNo(sb, 'stock_transfers', 'transfer_no', `${p}ST-${yymm}`);
};

stockTransfers.get('/', async (c) => {
  const db = scmDb(c);
  const status            = c.req.query('status');
  const fromWarehouseId   = c.req.query('fromWarehouseId');
  const toWarehouseId     = c.req.query('toWarehouseId');
  const dateFrom          = c.req.query('dateFrom');
  const dateTo            = c.req.query('dateTo');

  const { data, error } = await paginateAll((pFrom, pTo) => {
    let q = db.from('stock_transfers', companyScope(c))
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
    return q.range(pFrom, pTo);
  });
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);

  const rows = (data as unknown as Array<Record<string, unknown>>) ?? [];
  const ids  = rows.map((r) => r.id as string);
  const countByXfer = new Map<string, number>();
  if (ids.length > 0) {
    const { data: lineRows } = await chunkIn<{ stock_transfer_id: string }>(ids, (batch, pFrom, pTo) => db
      .from('stock_transfer_lines', CENTRALISED(
        'counted only for ids the company-scoped list read above already returned; a predicate here would ALSO drop pre-0061 lines whose company_id is null and understate line_count',
      ))
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

stockTransfers.get('/:id/delivery-pod', stockTransferDeliveryPodHandler);
stockTransfers.get('/:id/delivery-pod/:dpId/photo/:n', stockTransferDeliveryPhotoHandler);

stockTransfers.get('/:id', async (c) => {
  const db = scmDb(c);
  const id = c.req.param('id');

  const [headerRes, linesRes] = await Promise.all([
    db.from('stock_transfers', companyScope(c))
      .select(
        `${HEADER}, ` +
        `from_warehouse:warehouses!stock_transfers_from_warehouse_id_fkey(id, code, name), ` +
        `to_warehouse:warehouses!stock_transfers_to_warehouse_id_fkey(id, code, name)`,
      )
      .eq('id', id).maybeSingle(),
    db.from('stock_transfer_lines', CENTRALISED(
      'the header read beside this one IS the company gate: a miss there returns 404 before these lines are used, and a predicate here would additionally hide pre-0061 lines with a null company_id',
    )).select(LINE).eq('stock_transfer_id', id).order('created_at'),
  ]);

  if (headerRes.error) return c.json({ error: 'load_failed', reason: headerRes.error.message }, 500);
  if (!headerRes.data) return c.json({ error: 'not_found' }, 404);

  let stockNotBack = false;
  if (String((headerRes.data as { status?: string }).status ?? '').toUpperCase() === 'CANCELLED') {
    const { data: movs, error: movsErr } = await db.unscoped(
      'library hand-off: the movements are read by this document id, which the company-scoped header read above proved is ours',
    ).from('inventory_movements').select('movement_type, warehouse_id, item_code, variant_key, batch_no, qty')
      .eq('source_doc_type', 'STOCK_TRANSFER').eq('source_doc_id', id);
    if (movsErr) return c.json({ error: 'load_failed', reason: movsErr.message }, 500);
    stockNotBack = transferStockNotBack(movs as unknown as TransferMovementRow[]);
  }
  return c.json({ transfer: headerRes.data, lines: linesRes.data ?? [], stockNotBack });
});

export const TRANSFER_REVERSAL_LEASE_MS = 60_000;

async function claimTransferReversal(
  db: ReturnType<typeof scmDb>, companyId: number, id: string,
): Promise<{ ok: true } | { ok: false; status: 409 | 500; body: { error: string; message: string } }> {
  const busy = {
    ok: false as const, status: 409 as const,
    body: { error: 'cancel_in_progress', message: 'This transfer\'s stock is being moved back by another cancel right now. Wait a minute, open it again, and press Finish cancel only if it is still offered.' },
  };
  const { data: cur, error: curErr } = await db.from('stock_transfers', companyIdScope(companyId))
    .select('status, cancelled_at').eq('id', id).maybeSingle();
  if (curErr) return { ok: false, status: 500, body: { error: 'cancel_failed', message: `Could not read the transfer: ${curErr.message}` } };
  const prev = (cur as { status?: string; cancelled_at?: string | null } | null)?.cancelled_at ?? null;
  const prevMs = prev ? Date.parse(prev) : NaN;
  if (Number.isFinite(prevMs) && Date.now() - prevMs < TRANSFER_REVERSAL_LEASE_MS) return busy;
  const flip = db.from('stock_transfers', companyIdScope(companyId))
    .update({ cancelled_at: new Date().toISOString() }).eq('id', id).eq('status', 'CANCELLED');
  const { data: won, error: wonErr } = await (prev ? flip.eq('cancelled_at', prev) : flip.is('cancelled_at', null))
    .select('id').maybeSingle();
  if (wonErr) return { ok: false, status: 500, body: { error: 'cancel_failed', message: `Could not claim the transfer: ${wonErr.message}` } };
  return won ? { ok: true } : busy;
}

type TransferMovementRow = { movement_type: string; warehouse_id: string; item_code: string; variant_key: string | null; batch_no?: string | null; qty: number };

/** Some (warehouse, item, variant, batch) bucket of the transfer's own IN/OUT rows does not net to zero. */
export function transferStockNotBack(movs: TransferMovementRow[]): boolean {
  const net = new Map<string, number>();
  for (const m of movs) {
    if (m.movement_type !== 'IN' && m.movement_type !== 'OUT') continue;
    const k = `${m.warehouse_id}::${m.item_code}::${m.variant_key ?? ''}::${m.batch_no ?? ''}`;
    net.set(k, (net.get(k) ?? 0) + (m.movement_type === 'IN' ? Number(m.qty) : -Number(m.qty)));
  }
  return [...net.values()].some((v) => v !== 0);
}

stockTransfers.patch('/:id', async (c) => {
  const db = scmDb(c);
  const user = c.get('user');
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const hasHeaderNotes = Object.hasOwn(body, 'notes');
  const itemsInput = body.items as Array<Record<string, unknown>> | undefined;
  if (!hasHeaderNotes && !itemsInput) return c.json({ error: 'nothing_to_update' }, 400);

  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: beforeRow, error: beforeErr } = await db
    .from('stock_transfers', companyIdScope(co.companyId))
    .select('transfer_no, notes, status, from_warehouse_id, to_warehouse_id, company_id')
    .eq('id', id)
    .maybeSingle();
  if (beforeErr) return c.json({ error: 'load_failed', reason: beforeErr.message }, 500);
  if (!beforeRow) return c.json(NOT_THIS_COMPANY, 404);
  const before = beforeRow as {
    transfer_no: string; notes: string | null; status: string;
    from_warehouse_id: string; to_warehouse_id: string; company_id: number | null;
  };

  if (itemsInput && before.status !== 'POSTED') {
    return c.json({ error: 'not_posted', message: `Cannot edit items on a ${before.status} transfer.` }, 409);
  }

  let newLineRows: Array<{ item_code: string; product_name: string | null; variant_key: string; qty: number; notes: string | null }> = [];
  if (itemsInput) {
    if (itemsInput.length === 0) return c.json({ error: 'items_required' }, 400);
    try {
      newLineRows = itemsInput.map((it) => {
        const qty = Math.max(0, Math.floor(Number(it.qty ?? 0)));
        if (qty <= 0) throw new Error('qty must be > 0');
        if (!it.itemCode) throw new Error('itemCode required per line');
        return {
          item_code: String(it.itemCode),
          product_name: (it.productName as string | undefined) ?? null,
          variant_key: (it.variantKey as string | undefined) ?? '',
          qty,
          notes: (it.notes as string | undefined) ?? null,
        };
      });
    } catch (e) {
      return c.json({ error: 'invalid_line', message: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  const pf = await assertAuditWritable(db.unscoped(
    'library hand-off: the audit sink takes the raw client and is told the company explicitly as companyId',
  ), { entityType: 'STOCK_TRANSFER', entityId: id, action: 'UPDATE', companyId: before.company_id });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  let oldLineRows: Array<{ id: string; item_code: string; variant_key: string | null; qty: number }> = [];
  let sameBuckets = false;
  let shortPosted: TransferShortage[] = [];
  if (itemsInput) {
    const { data: oldLines, error: oldLinesErr } = await db
      .from('stock_transfer_lines', CENTRALISED(
        'the header read above already proved this transfer is this company\'s — its own lines are that document\'s by construction',
      ))
      .select('id, item_code, variant_key, qty')
      .eq('stock_transfer_id', id)
      .order('created_at');
    if (oldLinesErr) return c.json({ error: 'load_failed', reason: oldLinesErr.message }, 500);
    oldLineRows = (oldLines ?? []) as typeof oldLineRows;

    sameBuckets = oldLineRows.length === newLineRows.length && oldLineRows.every((o, i) =>
      o.item_code === newLineRows[i]!.item_code
      && (o.variant_key ?? '') === newLineRows[i]!.variant_key
      && Number(o.qty) === newLineRows[i]!.qty);

    if (!sameBuckets) {
      const check = await findTransferShortages(db, c, before.from_warehouse_id, sumByBucket(newLineRows), sumByBucket(oldLineRows));
      if (!check.ok) return c.json({ error: 'stock_check_failed', reason: check.reason }, 500);
      const refusal = shortStockRefusal(c, check.shortages, body.allowShortStock === true);
      if (refusal) return c.json(refusal, 409);
      shortPosted = check.shortages;
    }
  }

  if (hasHeaderNotes) {
    const { error } = await db
      .from('stock_transfers', companyIdScope(co.companyId))
      .update({ notes: (body.notes as string | null) ?? null })
      .eq('id', id);
    if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
  }

  let movementErrors: string[] = [];
  if (itemsInput && sameBuckets) {
    for (let i = 0; i < oldLineRows.length; i++) {
      const { error } = await db
        .from('stock_transfer_lines', CENTRALISED(
          'the header read above already proved this transfer is this company\'s — updating its own line by id',
        ))
        .update({ product_name: newLineRows[i]!.product_name, notes: newLineRows[i]!.notes })
        .eq('id', oldLineRows[i]!.id);
      if (error) return c.json({ error: 'update_failed', reason: error.message }, 500);
    }
  } else if (itemsInput) {
    const rev = await reverseMovements(db.unscoped(
      'library hand-off: reverseMovements resolves the rows to reverse from this document id, which the company-scoped read above already proved is ours',
    ), 'STOCK_TRANSFER', id, user?.id ?? null);
    if (!rev.ok || rev.failed > 0) {
      return c.json({ error: 'reversal_incomplete', reason: rev.reason ?? 'partial reversal', reversal: rev }, 500);
    }

    const { error: delErr } = await db
      .from('stock_transfer_lines', CENTRALISED(
        'the header read above already proved this transfer is this company\'s — replacing its own lines',
      ))
      .delete().eq('stock_transfer_id', id);
    if (delErr) return c.json({ error: 'lines_replace_failed', reason: delErr.message }, 500);

    const { error: insErr } = await db
      .from('stock_transfer_lines', companyScope(c))
      .insert(newLineRows.map((l) => ({ ...l, stock_transfer_id: id })));
    if (insErr) return c.json({ error: 'lines_replace_failed', reason: insErr.message }, 500);

    movementErrors = await writeTransferMovements(
      db,
      { id, transfer_no: before.transfer_no, from_warehouse_id: before.from_warehouse_id, to_warehouse_id: before.to_warehouse_id },
      user?.id ?? '', before.company_id, c,
    );
  }

  await recordEntityAudit(db.unscoped(
    'library hand-off: the audit writer takes the raw client and is told the company explicitly as companyId',
  ), {
    entityType: 'STOCK_TRANSFER',
    entityId: id,
    entityDocNo: before.transfer_no,
    action: 'UPDATE',
    actor: c.get('houzsUser'),
    companyId: before.company_id,
    note: movementErrors.length
      ? `Item edit — movement re-apply INCOMPLETE: ${movementErrors.join('; ')}`
      : shortPosted.length ? shortOverrideNote(shortPosted) : undefined,
    fieldChanges: compactChanges([
      ...(hasHeaderNotes ? [fieldChange('notes', before.notes, (body.notes as string | null) ?? null)] : []),
      ...(itemsInput ? [
        fieldChange('lineCount', oldLineRows.length, newLineRows.length),
        fieldChange('totalQty', oldLineRows.reduce((s, l) => s + Number(l.qty), 0), newLineRows.reduce((s, l) => s + l.qty, 0)),
      ] : []),
    ]),
  });

  if (movementErrors.length) {
    return c.json({ error: 'transfer_movements_failed', id, transferNo: before.transfer_no, movementErrors }, 422);
  }

  const { data: after, error: afterErr } = await db
    .from('stock_transfers', companyIdScope(co.companyId))
    .select(HEADER).eq('id', id).maybeSingle();
  if (afterErr) return c.json({ error: 'load_failed', reason: afterErr.message }, 500);
  return c.json({ transfer: after });
});

export async function writeTransferMovements(
  db: ScopedDb,
  header: { id: string; transfer_no: string; from_warehouse_id: string; to_warehouse_id: string },
  userId: string,
  companyId: number | null,
  c: CompanyScopeCtx,
): Promise<string[]> {
  const movementErrors: string[] = [];
  const { data: lines, error: linesErr } = await db
    .from('stock_transfer_lines', CENTRALISED(
      'header.id was minted by the company-scoped insert in the caller moments ago, so these lines are that document\'s by construction',
    ))
    .select('item_code, product_name, variant_key, qty')
    .eq('stock_transfer_id', header.id);
  if (linesErr) return [unreadableMovementError(`the lines of transfer ${header.transfer_no}`, linesErr)];
  const lineList = (lines as Array<{ item_code: string; product_name: string | null; variant_key: string | null; qty: number }>) ?? [];

  const batchByBucket = new Map<string, string | null>();
  try {
    const { data: lots, error: lotsErr } = await db
      .from('v_inventory_lots_open', companyScope(c))
      .select('warehouse_id, item_code, variant_key, batch_no, qty_remaining')
      .eq('warehouse_id', header.from_warehouse_id)
      .not('batch_no', 'is', null)
      .gt('qty_remaining', 0);
    if (!lotsErr) {
      const batchesByBucket = new Map<string, Set<string>>();
      /* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the scoped builder types `data` as non-null on this branch, but PostgREST really does return a null body (a 42703 on a column this view lacks pre-0120 is the case this whole try/catch exists for). The type is the optimistic one; the `?? []` is the true one. */
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

  const payload = buildTransferPayload(lineList, batchByBucket);
  if (payload.length > 0) {
    try {
      const { error: rpcErr } = await db.unscoped(
        'an RPC, which this wrapper deliberately does not cover: fn_stock_transfer_apply takes p_company_id explicitly and scopes inside the transaction',
      ).rpc('fn_stock_transfer_apply', {
        p_from_warehouse_id: header.from_warehouse_id,
        p_to_warehouse_id:   header.to_warehouse_id,
        p_source_doc_id:     header.id,
        p_source_doc_no:     header.transfer_no,
        p_company_id:        companyId ?? null,
        p_performed_by:      userId,
        p_lines:             payload,
      });
      /* eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- PostgrestError types `message` as a plain string, but an RPC that fails at the edge (transport, 502 from the pooler) surfaces an error object without one, and an operator reading "TRANSFER ST-2608-001: undefined" learns nothing. */
      if (rpcErr) movementErrors.push(`TRANSFER ${header.transfer_no}: ${rpcErr.message ?? 'movement apply failed'}`);
      if (!rpcErr) {
        await reconcileUncostedAfterIn(
          db.unscoped(
            'library hand-off: the retro-cost walker takes the raw client and resolves lots from the movement rows this transfer just wrote',
          ),
          payload.map((p) => ({
            movement_type: 'IN',
            warehouse_id: header.to_warehouse_id,
            item_code: p.item_code,
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
  try {
    const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
    await recomputeAllocationAfterSave(db.unscoped(
      'library hand-off: the B2C allocation walker is a system-wide recompute across both companies by design',
    ), 'post-transfer');
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-transfer failed:', e); }
  return movementErrors;
}

stockTransfers.post('/', async (c) => {
  /* company-scope: the only by-id write here is the ROLLBACK — the header this
     handler inserted moments earlier is deleted when the child insert fails.
     insertHeader / insertWithDocNoRetry stamp the active company on that row, so
     the id is not caller-supplied and cannot name another company's document.
     Verified 2026-08-13 by reading the handler end to end. Each of those two
     statements now SAYS so, as a CENTRALISED reason the compiler made
     unavoidable, instead of relying on this paragraph being re-read. */
  const db = scmDb(c);
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

  const wanted = [...new Set([fromWarehouseId, toWarehouseId])];
  const { data: ownWhs, error: whErr } = await db
    .from('warehouses', companyScope(c)).select('id').in('id', wanted);
  if (whErr) return c.json({ error: 'warehouse_check_failed', reason: whErr.message }, 500);
  if ((ownWhs ?? []).length !== wanted.length) return c.json(NOT_THIS_COMPANY, 404);

  const requestedByBucket = sumByBucket(items.map((it) => ({
    item_code: String(it.itemCode ?? ''),
    variant_key: (it.variantKey as string | undefined) ?? '',
    qty: Math.max(0, Math.floor(Number(it.qty ?? 0))),
  })).filter((l) => l.item_code && l.qty > 0));
  const stockCheck = await findTransferShortages(db, c, fromWarehouseId, requestedByBucket, new Map());
  if (!stockCheck.ok) return c.json({ error: 'stock_check_failed', reason: stockCheck.reason }, 500);
  const shortRefusal = shortStockRefusal(c, stockCheck.shortages, body.allowShortStock === true);
  if (shortRefusal) return c.json(shortRefusal, 409);

  const headerInsert: Record<string, unknown> = {
    status:             'POSTED',
    posted_at:          new Date().toISOString(),
    from_warehouse_id:  fromWarehouseId,
    to_warehouse_id:    toWarehouseId,
    notes:              (body.notes as string | undefined) ?? null,
    created_by:         user.id,
  };
  if (body.transferDate) headerInsert.transfer_date = body.transferDate;

  const pf = await assertAuditWritable(db.unscoped(
    'library hand-off: the audit sink takes the raw client and is told the company explicitly as companyId',
  ), { entityType: 'STOCK_TRANSFER', action: 'CREATE', companyId: activeCompanyId(c) });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data: headerData, error: hErr } = await insertWithDocNoRetry<{ id: string; transfer_no: string; from_warehouse_id: string; to_warehouse_id: string }>(
    () => nextTransferNo(db.unscoped(
      'library hand-off: mintMonthlyDocNo partitions by the per-company DOC-NUMBER PREFIX (companyDocPrefix), not by a predicate — its .like() for HC-ST-2608-% never matches 2990\'s numbers',
    ), c),
    (transferNo) => db
      .from('stock_transfers', companyScope(c))
      .insert({ transfer_no: transferNo, ...headerInsert }).select(HEADER).single(),
  );
  if (hErr) {
    if (hErr.code === '42501') return c.json({ error: 'forbidden', reason: hErr.message }, 403);
    return c.json({ error: 'insert_failed', reason: hErr.message }, 500);
  }
  const header = headerData as unknown as { id: string; transfer_no: string; from_warehouse_id: string; to_warehouse_id: string };

  const lineRows = items.map((it) => {
    const qty = Math.max(0, Math.floor(Number(it.qty ?? 0)));
    if (qty <= 0) throw new Error('qty must be > 0');
    if (!it.itemCode) throw new Error('itemCode required per line');
    return {
      stock_transfer_id: header.id,
      item_code: String(it.itemCode),
      product_name: (it.productName as string | undefined) ?? null,
      variant_key: (it.variantKey as string | undefined) ?? '',
      qty,
      notes: (it.notes as string | undefined) ?? null,
    };
  });
  const { error: lErr } = await db
    .from('stock_transfer_lines', companyScope(c)).insert(lineRows);
  if (lErr) {
    await db.from('stock_transfers', CENTRALISED(
      'the ROLLBACK of the header this handler inserted seconds ago: the id was minted here, is not caller-supplied, and cannot name another company\'s document — while a predicate WOULD strand the row whenever the active company is unresolved',
    )).delete().eq('id', header.id);
    return c.json({ error: 'lines_insert_failed', reason: lErr.message }, 500);
  }

  const movementErrors = await writeTransferMovements(db, header, user.id, activeCompanyId(c) ?? null, c);

  const transferChanges = compactChanges([
    fieldChange('fromWarehouseId', null, fromWarehouseId),
    fieldChange('toWarehouseId', null, toWarehouseId),
    fieldChange('transferDate', null, (body.transferDate as string | undefined) ?? null),
    fieldChange('lineCount', null, lineRows.length),
    fieldChange('totalQty', null, lineRows.reduce((s, l) => s + l.qty, 0)),
    fieldChange('notes', null, (body.notes as string | undefined) ?? null),
  ]);

  if (movementErrors.length) {
    await db.from('stock_transfers', CENTRALISED(
      'auto-cancel of the header this handler inserted seconds ago — the same handler-minted id as the rollback above, not caller-supplied',
    ))
      .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
      .eq('id', header.id);
    await recordEntityAudit(db.unscoped(
      'library hand-off: the audit writer takes the raw client and is told the company explicitly as companyId',
    ), {
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

  await recordEntityAudit(db.unscoped(
    'library hand-off: the audit writer takes the raw client and is told the company explicitly as companyId',
  ), {
    entityType: 'STOCK_TRANSFER',
    entityId: header.id,
    entityDocNo: header.transfer_no,
    action: 'CREATE',
    actor: c.get('houzsUser'),
    companyId: activeCompanyId(c),
    statusSnapshot: 'POSTED',
    note: stockCheck.shortages.length ? shortOverrideNote(stockCheck.shortages) : undefined,
    fieldChanges: transferChanges,
  });

  return c.json({
    id: header.id,
    transferNo: header.transfer_no,
  }, 201);
});

stockTransfers.patch('/:id/cancel', async (c) => {
  const db = scmDb(c);
  const user = c.get('user');
  const id = c.req.param('id');

  /* Company scope. This handler was missed by the 2026-07-22 owner audit that
     scoped every sibling flow: the before-read and the CANCELLED flip were both
     id-only, so a caller in company A holding B's transfer UUID could cancel B's
     POSTED transfer AND drive reverseMovements over B's stock. stock-takes.ts:437
     carries the same fix and its comment names this exact class. Found 2026-08-13
     by a code audit, verified against both handlers before fixing. */
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);

  const { data: beforeRow } = await db
    .from('stock_transfers', companyIdScope(co.companyId))
    .select('transfer_no, status, from_warehouse_id, to_warehouse_id, company_id')
    .eq('id', id)
    .maybeSingle();
  if (!beforeRow) return c.json(NOT_THIS_COMPANY, 404);
  const beforeTransfer = beforeRow as {
    transfer_no: string; status: string;
    from_warehouse_id: string | null; to_warehouse_id: string | null; company_id: number | null;
  } | null;

  const pf = await assertAuditWritable(db.unscoped(
    'library hand-off: the audit sink takes the raw client and is told the company explicitly as companyId',
  ), { entityType: 'STOCK_TRANSFER', entityId: id, action: 'CANCEL', companyId: beforeTransfer?.company_id ?? null });
  if (!pf.ok) return c.json(auditUnavailableBody(), 409);

  const { data, error } = await db
    .from('stock_transfers', companyIdScope(co.companyId))
    .update({ status: 'CANCELLED', cancelled_at: new Date().toISOString() })
    .eq('id', id).neq('status', 'CANCELLED')
    .select('id, status, cancelled_at').maybeSingle();
  if (error) return c.json({ error: 'cancel_failed', reason: error.message }, 500);
  if (!data) {
    if (String(beforeTransfer?.status ?? '').toUpperCase() !== 'CANCELLED') return c.json({ error: 'already_cancelled' }, 409);
    const claim = await claimTransferReversal(db, co.companyId, id);
    if (!claim.ok) return c.json(claim.body, claim.status);
    const again = await reverseMovements(db.unscoped(
      'library hand-off: reverseMovements resolves the rows to reverse from this document id, which the company-scoped read above already proved is ours',
    ), 'STOCK_TRANSFER', id, user.id);
    const stillShort = !again.ok || again.failed > 0;
    if (again.reversed > 0 || stillShort) {
      await recordEntityAudit(db.unscoped(
        'library hand-off: the audit writer takes the raw client and is told the company explicitly as companyId',
      ), {
        entityType: 'STOCK_TRANSFER', entityId: id, entityDocNo: beforeTransfer?.transfer_no ?? null,
        action: 'CANCEL', actor: c.get('houzsUser'), companyId: beforeTransfer?.company_id ?? null, statusSnapshot: 'CANCELLED',
        note: stillShort
          ? `Stock reversal retried, still INCOMPLETE — ${again.failed} failed: ${again.reason ?? 'partial reversal'}`
          : `Stock reversal finished on retry — ${again.reversed} movement(s) reversed`,
        fieldChanges: compactChanges([fieldChange('movementsReversed', null, again.reversed), fieldChange('movementsFailed', null, again.failed)]),
      });
    }
    return c.json({
      transfer: { id, status: 'CANCELLED' },
      resumed: true,
      reversal: { reversed: again.reversed, skipped: again.skipped, failed: again.failed },
      reversalErrors: stillShort ? [again.reason ?? 'partial reversal'] : undefined,
    });
  }

  const rev = await reverseMovements(db.unscoped(
    'library hand-off: reverseMovements resolves the rows to reverse from this document id, which the company-scoped flip directly above already proved is ours',
  ), 'STOCK_TRANSFER', id, user?.id ?? null);
  const revIncomplete = !rev.ok || rev.failed > 0;

  await recordEntityAudit(db.unscoped(
    'library hand-off: the audit writer takes the raw client and is told the company explicitly as companyId',
  ), {
    entityType: 'STOCK_TRANSFER',
    entityId: id,
    entityDocNo: beforeTransfer?.transfer_no ?? null,
    action: 'CANCEL',
    actor: c.get('houzsUser'),
    companyId: beforeTransfer?.company_id ?? null,
    statusSnapshot: 'CANCELLED',
    note: revIncomplete
      ? `Stock reversal INCOMPLETE — ${rev.failed} failed: ${rev.reason ?? 'partial reversal'}`
      : undefined,
    fieldChanges: compactChanges([
      ...statusChange(beforeTransfer?.status, 'CANCELLED'),
      fieldChange('movementsReversed', null, rev.reversed),
      fieldChange('movementsSkipped', null, rev.skipped),
      fieldChange('movementsFailed', null, rev.failed),
    ]),
  });

  try {
    const { recomputeAllocationAfterSave } = await import('../lib/stock-allocation-job');
    await recomputeAllocationAfterSave(db.unscoped(
      'library hand-off: the B2C allocation walker is a system-wide recompute across both companies by design',
    ), 'post-transfer-cancel');
  } catch (e) { /* eslint-disable-next-line no-console */ console.error('[so-allocation] post-cancel failed:', e); }

  return c.json({
    transfer: data,
    reversal: { reversed: rev.reversed, skipped: rev.skipped, failed: rev.failed },
    reversalErrors: revIncomplete ? [rev.reason ?? 'partial reversal'] : undefined,
  });
});

stockTransfers.patch('/:id/post', async (c) => {
  const db = scmDb(c);
  const id = c.req.param('id');
  const { data } = await db
    .from('stock_transfers', companyScope(c)).select(HEADER).eq('id', id).maybeSingle();
  if (!data) return c.json({ error: 'not_found' }, 404);
  const row = data as unknown as { status: string };
  if (row.status === 'POSTED') return c.json({ transfer: data });
  return c.json({ error: 'cannot_post', message: `Cannot post a ${row.status} transfer.` }, 409);
});
