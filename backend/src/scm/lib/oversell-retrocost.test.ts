import { describe, expect, test } from 'vitest';
import {
  planUncostedRetrocost,
  reconcileUncostedOuts,
  reconcileUncostedAfterIn,
  type RetroOutMovement,
  type RetroLot,
} from './oversell-retrocost';

const out = (o: Partial<RetroOutMovement> & { movementId: string; qty: number }): RetroOutMovement => ({
  doId: `do-${o.movementId}`,
  createdAt: '2026-07-10T00:00:00.000Z',
  isDropship: false,
  doStatus: 'SIGNED',
  alreadyConsumedQty: o.qty,
  alreadyCostedSen: 0,
  ...o,
});
const lot = (lotId: string, qtyRemaining: number, unitCostSen: number, receivedAt = '2026-07-15T00:00:00.000Z'): RetroLot =>
  ({ lotId, receivedAt, qtyRemaining, unitCostSen });

const CUTOFF = '2026-07-15T12:00:00.000Z';

const lotSum = (lots: RetroLot[]) => lots.reduce((s, l) => s + l.qtyRemaining, 0);

describe('planUncostedRetrocost — the oversell retro-cost mechanism', () => {
  test('oversold normal DO: short units start uncosted + balance below the lot view', () => {
    const shortOut = out({ movementId: 'm1', qty: 10, alreadyConsumedQty: 6, alreadyCostedSen: 6 * 500 });
    const newLot = lot('L2', 10, 550);
    const balance = -4 + 10;
    expect(lotSum([newLot])).toBe(10);
    expect(balance).toBe(6);
    expect(lotSum([newLot])).not.toBe(balance);

    const plan = planUncostedRetrocost([shortOut], [newLot], CUTOFF);
    expect(plan.totalRetroQty).toBe(4);
    expect(plan.lines).toHaveLength(1);
    const line = plan.lines[0];
    expect(line.retroQty).toBe(4);
    expect(line.retroCostSen).toBe(4 * 550);
    expect(line.newTotalCostSen).toBe(6 * 500 + 4 * 550);
    expect(line.stillShortQty).toBe(0);
    expect(plan.affectedDoIds).toEqual(['do-m1']);

    expect(lotSum(plan.lotsAfter)).toBe(6);
    expect(lotSum(plan.lotsAfter)).toBe(balance);
  });

  test('re-running the reconcile is idempotent — a short costed once is never double-costed', () => {
    const costedOut = out({ movementId: 'm1', qty: 10, alreadyConsumedQty: 10, alreadyCostedSen: 6 * 500 + 4 * 550 });
    const remainingLot = lot('L2', 6, 550);
    const plan = planUncostedRetrocost([costedOut], [remainingLot], CUTOFF);
    expect(plan.lines).toHaveLength(0);
    expect(plan.totalRetroQty).toBe(0);
    expect(lotSum(plan.lotsAfter)).toBe(6);
  });

  test('a NON-shorted normal receipt is unaffected', () => {
    const fullyCosted = out({ movementId: 'm1', qty: 5, alreadyConsumedQty: 5, alreadyCostedSen: 5 * 500 });
    const freshLot = lot('L9', 20, 550);
    const plan = planUncostedRetrocost([fullyCosted], [freshLot], CUTOFF);
    expect(plan.lines).toHaveLength(0);
    expect(plan.affectedDoIds).toEqual([]);
    expect(lotSum(plan.lotsAfter)).toBe(20);
  });

  test('partial coverage: arriving stock smaller than the shortfall leaves a residual for the next receipt', () => {
    const shortOut = out({ movementId: 'm1', qty: 10, alreadyConsumedQty: 2, alreadyCostedSen: 2 * 500 });
    const smallLot = lot('L3', 5, 550);
    const plan = planUncostedRetrocost([shortOut], [smallLot], CUTOFF);
    expect(plan.lines[0].retroQty).toBe(5);
    expect(plan.lines[0].stillShortQty).toBe(3);
    expect(plan.lines[0].newTotalCostSen).toBe(2 * 500 + 5 * 550);
    expect(lotSum(plan.lotsAfter)).toBe(0);
  });

  test('cost comes only from real lots — never a fabricated fallback when no lot is available', () => {
    const shortOut = out({ movementId: 'm1', qty: 10, alreadyConsumedQty: 6, alreadyCostedSen: 6 * 500 });
    const plan = planUncostedRetrocost([shortOut], [], CUTOFF);
    expect(plan.lines).toHaveLength(0);
    expect(plan.totalRetroQty).toBe(0);
  });
});

describe('planUncostedRetrocost — anti "coverage-theft" guards', () => {
  test('a later order (shipped at/after the receipt) is NOT reconciled — its stock is not stolen', () => {
    const priorShort = out({ movementId: 'm-old', qty: 4, createdAt: '2026-07-10T00:00:00.000Z', alreadyConsumedQty: 0, alreadyCostedSen: 0 });
    const freshOrder = out({ movementId: 'm-new', qty: 4, createdAt: '2026-07-16T00:00:00.000Z', alreadyConsumedQty: 0, alreadyCostedSen: 0 });
    const arriving = lot('L4', 4, 550);

    const plan = planUncostedRetrocost([priorShort, freshOrder], [arriving], CUTOFF);
    expect(plan.affectedDoIds).toEqual(['do-m-old']);
    expect(plan.lines.map((l) => l.movementId)).toEqual(['m-old']);
    expect(plan.lines[0].retroQty).toBe(4);
    expect(lotSum(plan.lotsAfter)).toBe(0);

    const noGuard = planUncostedRetrocost([freshOrder], [lot('L4', 4, 550)], '2026-07-20T00:00:00.000Z');
    expect(noGuard.totalRetroQty).toBe(4);
  });

  test('two competing prior shorts: the OLDER ship gets first claim on limited stock (FIFO)', () => {
    const older = out({ movementId: 'm-a', qty: 5, createdAt: '2026-07-10T00:00:00.000Z', alreadyConsumedQty: 0, alreadyCostedSen: 0 });
    const newer = out({ movementId: 'm-b', qty: 5, createdAt: '2026-07-12T00:00:00.000Z', alreadyConsumedQty: 0, alreadyCostedSen: 0 });
    const arriving = lot('L5', 6, 550);
    const plan = planUncostedRetrocost([newer, older], [arriving], CUTOFF);
    expect(plan.lines.map((l) => l.movementId)).toEqual(['m-a', 'm-b']);
    expect(plan.lines[0].retroQty).toBe(5);
    expect(plan.lines[1].retroQty).toBe(1);
    expect(plan.lines[1].stillShortQty).toBe(4);
  });

  test('a CANCELLED DO OUT is excluded (its shipment was already reversed)', () => {
    const cancelled = out({ movementId: 'm1', qty: 10, doStatus: 'CANCELLED', alreadyConsumedQty: 6, alreadyCostedSen: 6 * 500 });
    const plan = planUncostedRetrocost([cancelled], [lot('L6', 10, 550)], CUTOFF);
    expect(plan.lines).toHaveLength(0);
    expect(lotSum(plan.lotsAfter)).toBe(10);
  });

  test('a drop-ship DO OUT is excluded here (owned by the 0088 batched reconcile)', () => {
    const dropship = out({ movementId: 'm1', qty: 10, isDropship: true, alreadyConsumedQty: 6, alreadyCostedSen: 6 * 500 });
    const plan = planUncostedRetrocost([dropship], [lot('L7', 10, 550)], CUTOFF);
    expect(plan.lines).toHaveLength(0);
    expect(lotSum(plan.lotsAfter)).toBe(10);
  });

  test('FIFO across lots: the oldest lot is consumed first', () => {
    const shortOut = out({ movementId: 'm1', qty: 10, alreadyConsumedQty: 4, alreadyCostedSen: 4 * 500 });
    const oldLot = lot('L-old', 3, 520, '2026-07-14T00:00:00.000Z');
    const newLot = lot('L-new', 10, 560, '2026-07-15T06:00:00.000Z');
    const plan = planUncostedRetrocost([shortOut], [newLot, oldLot], CUTOFF);
    expect(plan.lines[0].retroCostSen).toBe(3 * 520 + 3 * 560);
    const byId = Object.fromEntries(plan.lotsAfter.map((l) => [l.lotId, l.qtyRemaining]));
    expect(byId['L-old']).toBe(0);
    expect(byId['L-new']).toBe(7);
  });
});

type Row = Record<string, unknown>;
function fakeSb(opts: {
  rpc: (name: string, args: Row) => number;
  outMovements: Row[];
}) {
  const calls: Array<{ name: string; args: Row }> = [];
  class Q {
    rows: Row[];
    constructor(rows: Row[]) { this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => (vals as unknown[]).includes(r[col])); return this; }
    lt(col: string, val: unknown) { this.rows = this.rows.filter((r) => String(r[col]) < String(val)); return this; }
    then<T>(onF: (v: { data: Row[]; error: null }) => T) { return Promise.resolve({ data: this.rows, error: null }).then(onF); }
  }
  return {
    calls,
    rpc(name: string, args: Row) {
      calls.push({ name, args });
      return Promise.resolve({ data: opts.rpc(name, args), error: null });
    },
    from(_t: string) { return new Q(opts.outMovements); },
  };
}

describe('reconcileUncostedOuts — orchestration', () => {
  const WH = 'wh-1';
  test('dedupes buckets, sums the RPC qty, and collects only prior DO-sourced OUTs in the bucket', async () => {
    const sb = fakeSb({
      rpc: () => 4,
      outMovements: [
        { movement_type: 'OUT', source_doc_type: 'DO', source_doc_id: 'do-1', item_code: 'P1', warehouse_id: WH, variant_key: '', created_at: '2026-07-10T00:00:00.000Z' },
        { movement_type: 'OUT', source_doc_type: 'DO', source_doc_id: 'do-2', item_code: 'P1', warehouse_id: WH, variant_key: '', created_at: '2026-07-16T00:00:00.000Z' },
        { movement_type: 'OUT', source_doc_type: 'CONSIGNMENT_NOTE', source_doc_id: 'cn-1', item_code: 'P1', warehouse_id: WH, variant_key: '', created_at: '2026-07-10T00:00:00.000Z' },
        { movement_type: 'OUT', source_doc_type: 'DO', source_doc_id: 'do-3', item_code: 'P1', warehouse_id: 'wh-OTHER', variant_key: '', created_at: '2026-07-10T00:00:00.000Z' },
      ],
    });
    const res = await reconcileUncostedOuts(
      sb,
      [
        { warehouse_id: WH, item_code: 'P1', variant_key: '' },
        { warehouse_id: WH, item_code: 'P1', variant_key: '' },
      ],
      CUTOFF,
      'user-1',
    );
    expect(sb.calls.filter((c) => c.name === 'fn_reconcile_uncosted_out')).toHaveLength(1);
    expect(sb.calls[0].args).toMatchObject({ p_warehouse_id: WH, p_product_code: 'P1', p_variant_key: '', p_before_ts: CUTOFF, p_created_by: 'user-1' });
    expect(res.reconciled).toBe(4);
    expect(res.affectedDoIds).toEqual(['do-1']);
  });

  test('no buckets -> no RPC call, nothing reconciled', async () => {
    const sb = fakeSb({ rpc: () => 0, outMovements: [] });
    const res = await reconcileUncostedOuts(sb, [], CUTOFF, 'user-1');
    expect(sb.calls).toHaveLength(0);
    expect(res).toEqual({ ok: true, reconciled: 0, affectedDoIds: [] });
  });

  test('zero reconciled -> skips the affected-DO lookup entirely', async () => {
    const sb = fakeSb({
      rpc: () => 0,
      outMovements: [{ source_doc_type: 'DO', source_doc_id: 'do-1', item_code: 'P1', warehouse_id: WH, variant_key: '', created_at: '2026-07-10T00:00:00.000Z' }],
    });
    const res = await reconcileUncostedOuts(sb, [{ warehouse_id: WH, item_code: 'P1', variant_key: '' }], CUTOFF, 'user-1');
    expect(res.reconciled).toBe(0);
    expect(res.affectedDoIds).toEqual([]);
  });
});

describe('reconcileUncostedAfterIn — lot-opening filter + failure containment', () => {
  const WH = 'wh-1';
  const bucketsOf = (sb: { calls: Array<{ name: string; args: Record<string, unknown> }> }) =>
    sb.calls.filter((c) => c.name === 'fn_reconcile_uncosted_out')
      .map((c) => `${c.args.p_warehouse_id}::${c.args.p_product_code}::${c.args.p_variant_key}`);

  test('reconciles IN and POSITIVE ADJUSTMENT rows; ignores OUT and NEGATIVE ADJUSTMENT', async () => {
    const sb = fakeSb({ rpc: () => 0, outMovements: [] });
    await reconcileUncostedAfterIn(sb, [
      { movement_type: 'IN', warehouse_id: WH, item_code: 'P-IN', variant_key: '', qty: 2 },
      { movement_type: 'ADJUSTMENT', warehouse_id: WH, item_code: 'P-PLUS', variant_key: '', qty: 3 },
      { movement_type: 'ADJUSTMENT', warehouse_id: WH, item_code: 'P-MINUS', variant_key: '', qty: -3 },
      { movement_type: 'OUT', warehouse_id: WH, item_code: 'P-OUT', variant_key: '', qty: 5 },
    ], 'user-1');
    expect(bucketsOf(sb)).toEqual([`${WH}::P-IN::`, `${WH}::P-PLUS::`]);
  });

  test('an OUT-only batch (a resync that only removed stock) calls nothing', async () => {
    const sb = fakeSb({ rpc: () => 0, outMovements: [] });
    const res = await reconcileUncostedAfterIn(sb, [
      { movement_type: 'OUT', warehouse_id: WH, item_code: 'P1', variant_key: '', qty: 1 },
    ], 'user-1');
    expect(sb.calls).toHaveLength(0);
    expect(res).toEqual({ reconciled: 0, affectedDoIds: [] });
  });

  test('rows missing a warehouse or product are dropped rather than reconciled as an empty bucket', async () => {
    const sb = fakeSb({ rpc: () => 0, outMovements: [] });
    await reconcileUncostedAfterIn(sb, [
      { movement_type: 'IN', warehouse_id: '', item_code: 'P1', variant_key: '', qty: 1 },
      { movement_type: 'IN', warehouse_id: WH, item_code: '', variant_key: '', qty: 1 },
      { movement_type: 'IN', warehouse_id: WH, item_code: 'P1', qty: 1 },
    ], 'user-1');
    expect(bucketsOf(sb)).toEqual([`${WH}::P1::`]);
  });

  test('a throwing client is contained — resolves 0, never rejects (the receipt must not roll back)', async () => {
    const exploding = {
      rpc() { throw new Error('connection reset'); },
      from() { throw new Error('connection reset'); },
    };
    await expect(reconcileUncostedAfterIn(exploding, [
      { movement_type: 'IN', warehouse_id: WH, item_code: 'P1', variant_key: '', qty: 1 },
    ], 'user-1')).resolves.toEqual({ reconciled: 0, affectedDoIds: [] });
  });

  test('null / empty row list is a no-op', async () => {
    const sb = fakeSb({ rpc: () => 0, outMovements: [] });
    expect(await reconcileUncostedAfterIn(sb, [], 'user-1')).toEqual({ reconciled: 0, affectedDoIds: [] });
    expect(await reconcileUncostedAfterIn(sb, null, 'user-1')).toEqual({ reconciled: 0, affectedDoIds: [] });
    expect(sb.calls).toHaveLength(0);
  });
});
