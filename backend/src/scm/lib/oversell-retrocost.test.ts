// Tests for the oversell (short-shipped) retro-cost reconcile.
//
// The actual FIFO consumption runs in PL/pgSQL (scm.fn_reconcile_uncosted_out,
// migration 0154); this repo's vitest harness rebuilds only the D1 side and
// cannot run the scm Supabase-Postgres layer (same limitation the dropship-batch
// tests note). So these drive planUncostedRetrocost — the pure, in-memory mirror
// the SQL is written against — through the money scenarios the fix must hold, plus
// the app wrapper reconcileUncostedOuts through a minimal fake PostgREST client.
import { describe, expect, test } from 'vitest';
import {
  planUncostedRetrocost,
  reconcileUncostedOuts,
  reconcileUncostedAfterIn,
  type RetroOutMovement,
  type RetroLot,
} from './oversell-retrocost';

// A DO OUT movement. Defaults describe a plain, fully-costed, non-drop-ship ship.
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

const CUTOFF = '2026-07-15T12:00:00.000Z'; // the receipt moment

/** The two on-hand representations for a bucket, to prove they re-converge.
 *  balance = signed movement sum; lotSum = Σ open-lot qty_remaining. */
const lotSum = (lots: RetroLot[]) => lots.reduce((s, l) => s + l.qtyRemaining, 0);

describe('planUncostedRetrocost — the oversell retro-cost mechanism', () => {
  test('oversold normal DO: short units start uncosted + balance below the lot view', () => {
    // DO shipped 10, warehouse held 6 @ 500 -> 6 costed, 4 uncosted short. Then a
    // GRN receives 10 @ 550. BEFORE the reconcile the two views diverge:
    //   balance (signed) = -4 + 10 = 6 ; lot view = 10. Off by the 4 short units.
    const shortOut = out({ movementId: 'm1', qty: 10, alreadyConsumedQty: 6, alreadyCostedSen: 6 * 500 });
    const newLot = lot('L2', 10, 550);
    const balance = -4 + 10; // signed movement sum for the bucket
    expect(lotSum([newLot])).toBe(10);
    expect(balance).toBe(6);
    expect(lotSum([newLot])).not.toBe(balance); // divergence the bug leaves behind

    // The reconcile retro-costs the 4 short units against the new lot.
    const plan = planUncostedRetrocost([shortOut], [newLot], CUTOFF);
    expect(plan.totalRetroQty).toBe(4);
    expect(plan.lines).toHaveLength(1);
    const line = plan.lines[0];
    expect(line.retroQty).toBe(4);
    expect(line.retroCostSen).toBe(4 * 550);          // at the NEW lot cost
    expect(line.newTotalCostSen).toBe(6 * 500 + 4 * 550); // COGS caught up in full
    expect(line.stillShortQty).toBe(0);
    expect(plan.affectedDoIds).toEqual(['do-m1']);

    // AFTER: lot view drops to 6 and now equals the signed balance — reconciled.
    expect(lotSum(plan.lotsAfter)).toBe(6);
    expect(lotSum(plan.lotsAfter)).toBe(balance);
  });

  test('re-running the reconcile is idempotent — a short costed once is never double-costed', () => {
    // Feed the POST-reconcile ledger back in: the movement now shows all 10
    // consumed at the caught-up cost, and the lot sits at its decremented 6.
    const costedOut = out({ movementId: 'm1', qty: 10, alreadyConsumedQty: 10, alreadyCostedSen: 6 * 500 + 4 * 550 });
    const remainingLot = lot('L2', 6, 550);
    const plan = planUncostedRetrocost([costedOut], [remainingLot], CUTOFF);
    expect(plan.lines).toHaveLength(0);
    expect(plan.totalRetroQty).toBe(0);
    expect(lotSum(plan.lotsAfter)).toBe(6); // untouched
  });

  test('a NON-shorted normal receipt is unaffected', () => {
    // A fully-costed prior ship (nothing short) + fresh stock -> no retro-cost,
    // lots left intact for whoever ships next.
    const fullyCosted = out({ movementId: 'm1', qty: 5, alreadyConsumedQty: 5, alreadyCostedSen: 5 * 500 });
    const freshLot = lot('L9', 20, 550);
    const plan = planUncostedRetrocost([fullyCosted], [freshLot], CUTOFF);
    expect(plan.lines).toHaveLength(0);
    expect(plan.affectedDoIds).toEqual([]);
    expect(lotSum(plan.lotsAfter)).toBe(20);
  });

  test('partial coverage: arriving stock smaller than the shortfall leaves a residual for the next receipt', () => {
    const shortOut = out({ movementId: 'm1', qty: 10, alreadyConsumedQty: 2, alreadyCostedSen: 2 * 500 });
    const smallLot = lot('L3', 5, 550); // only 5 arrive; shortfall is 8
    const plan = planUncostedRetrocost([shortOut], [smallLot], CUTOFF);
    expect(plan.lines[0].retroQty).toBe(5);
    expect(plan.lines[0].stillShortQty).toBe(3);       // 8 - 5, retried next receipt
    expect(plan.lines[0].newTotalCostSen).toBe(2 * 500 + 5 * 550);
    expect(lotSum(plan.lotsAfter)).toBe(0);            // the arriving lot fully drawn
  });

  test('cost comes only from real lots — never a fabricated fallback when no lot is available', () => {
    const shortOut = out({ movementId: 'm1', qty: 10, alreadyConsumedQty: 6, alreadyCostedSen: 6 * 500 });
    const plan = planUncostedRetrocost([shortOut], [], CUTOFF); // nothing received
    expect(plan.lines).toHaveLength(0);                 // no line, no 0-cost stamp
    expect(plan.totalRetroQty).toBe(0);
  });
});

describe('planUncostedRetrocost — anti "coverage-theft" guards', () => {
  test('a later order (shipped at/after the receipt) is NOT reconciled — its stock is not stolen', () => {
    // A genuine prior short (shipped before the receipt) and a FRESH order that
    // ships AFTER the receipt, same SKU, both currently uncosted. Only 4 units
    // arrive. The reconcile must cover the prior short and leave the fresh order
    // entirely alone (it will consume via the normal FIFO trigger at its own ship).
    const priorShort = out({ movementId: 'm-old', qty: 4, createdAt: '2026-07-10T00:00:00.000Z', alreadyConsumedQty: 0, alreadyCostedSen: 0 });
    const freshOrder = out({ movementId: 'm-new', qty: 4, createdAt: '2026-07-16T00:00:00.000Z', alreadyConsumedQty: 0, alreadyCostedSen: 0 });
    const arriving = lot('L4', 4, 550);

    const plan = planUncostedRetrocost([priorShort, freshOrder], [arriving], CUTOFF);
    expect(plan.affectedDoIds).toEqual(['do-m-old']);   // ONLY the prior short
    expect(plan.lines.map((l) => l.movementId)).toEqual(['m-old']);
    expect(plan.lines[0].retroQty).toBe(4);
    expect(lotSum(plan.lotsAfter)).toBe(0);             // all 4 went to the prior short

    // Control: without the temporal guard the fresh order WOULD have taken the
    // stock (proving the guard is what prevents the theft, not a lack of demand).
    const noGuard = planUncostedRetrocost([freshOrder], [lot('L4', 4, 550)], '2026-07-20T00:00:00.000Z');
    expect(noGuard.totalRetroQty).toBe(4);
  });

  test('two competing prior shorts: the OLDER ship gets first claim on limited stock (FIFO)', () => {
    const older = out({ movementId: 'm-a', qty: 5, createdAt: '2026-07-10T00:00:00.000Z', alreadyConsumedQty: 0, alreadyCostedSen: 0 });
    const newer = out({ movementId: 'm-b', qty: 5, createdAt: '2026-07-12T00:00:00.000Z', alreadyConsumedQty: 0, alreadyCostedSen: 0 });
    const arriving = lot('L5', 6, 550); // only 6 for 10 short
    const plan = planUncostedRetrocost([newer, older], [arriving], CUTOFF); // pass out of order
    expect(plan.lines.map((l) => l.movementId)).toEqual(['m-a', 'm-b']); // older first
    expect(plan.lines[0].retroQty).toBe(5); // older fully covered
    expect(plan.lines[1].retroQty).toBe(1); // newer gets the remaining 1
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
    const plan = planUncostedRetrocost([shortOut], [newLot, oldLot], CUTOFF); // unsorted input
    // shortfall 6: 3 from the older lot @520, then 3 from the newer @560.
    expect(plan.lines[0].retroCostSen).toBe(3 * 520 + 3 * 560);
    const byId = Object.fromEntries(plan.lotsAfter.map((l) => [l.lotId, l.qtyRemaining]));
    expect(byId['L-old']).toBe(0);
    expect(byId['L-new']).toBe(7);
  });
});

// ── App wrapper — orchestration over a minimal fake PostgREST/RPC client ──────
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
      rpc: () => 4, // each bucket reconciles 4
      outMovements: [
        { movement_type: 'OUT', source_doc_type: 'DO', source_doc_id: 'do-1', product_code: 'P1', warehouse_id: WH, variant_key: '', created_at: '2026-07-10T00:00:00.000Z' },
        { movement_type: 'OUT', source_doc_type: 'DO', source_doc_id: 'do-2', product_code: 'P1', warehouse_id: WH, variant_key: '', created_at: '2026-07-16T00:00:00.000Z' }, // AFTER cutoff -> excluded
        { movement_type: 'OUT', source_doc_type: 'CONSIGNMENT_NOTE', source_doc_id: 'cn-1', product_code: 'P1', warehouse_id: WH, variant_key: '', created_at: '2026-07-10T00:00:00.000Z' }, // not a DO -> excluded
        { movement_type: 'OUT', source_doc_type: 'DO', source_doc_id: 'do-3', product_code: 'P1', warehouse_id: 'wh-OTHER', variant_key: '', created_at: '2026-07-10T00:00:00.000Z' }, // other bucket -> excluded
      ],
    });
    const res = await reconcileUncostedOuts(
      sb,
      [
        { warehouse_id: WH, product_code: 'P1', variant_key: '' },
        { warehouse_id: WH, product_code: 'P1', variant_key: '' }, // dup -> one RPC call
      ],
      CUTOFF,
      'user-1',
    );
    expect(sb.calls.filter((c) => c.name === 'fn_reconcile_uncosted_out')).toHaveLength(1);
    expect(sb.calls[0].args).toMatchObject({ p_warehouse_id: WH, p_product_code: 'P1', p_variant_key: '', p_before_ts: CUTOFF, p_created_by: 'user-1' });
    expect(res.reconciled).toBe(4);
    expect(res.affectedDoIds).toEqual(['do-1']); // do-2 (later), cn-1 (not DO), do-3 (other bucket) all excluded
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
      outMovements: [{ source_doc_type: 'DO', source_doc_id: 'do-1', product_code: 'P1', warehouse_id: WH, variant_key: '', created_at: '2026-07-10T00:00:00.000Z' }],
    });
    const res = await reconcileUncostedOuts(sb, [{ warehouse_id: WH, product_code: 'P1', variant_key: '' }], CUTOFF, 'user-1');
    expect(res.reconciled).toBe(0);
    expect(res.affectedDoIds).toEqual([]); // lookup not run because nothing was reconciled
  });
});

/* reconcileUncostedAfterIn — the shared post-IN entry point every stock-IN path
   calls (2026-07-29). What is worth pinning here is the LOT-OPENING FILTER (it
   must mirror the FIFO trigger exactly: an IN always opens a lot, an ADJUSTMENT
   only when positive) and the NEVER-THROWS contract — a failed retro-cost must
   not be able to roll back the receipt that triggered it. */
describe('reconcileUncostedAfterIn — lot-opening filter + failure containment', () => {
  const WH = 'wh-1';
  const bucketsOf = (sb: { calls: Array<{ name: string; args: Record<string, unknown> }> }) =>
    sb.calls.filter((c) => c.name === 'fn_reconcile_uncosted_out')
      .map((c) => `${c.args.p_warehouse_id}::${c.args.p_product_code}::${c.args.p_variant_key}`);

  test('reconciles IN and POSITIVE ADJUSTMENT rows; ignores OUT and NEGATIVE ADJUSTMENT', async () => {
    const sb = fakeSb({ rpc: () => 0, outMovements: [] });
    await reconcileUncostedAfterIn(sb, [
      { movement_type: 'IN', warehouse_id: WH, product_code: 'P-IN', variant_key: '', qty: 2 },
      { movement_type: 'ADJUSTMENT', warehouse_id: WH, product_code: 'P-PLUS', variant_key: '', qty: 3 },
      { movement_type: 'ADJUSTMENT', warehouse_id: WH, product_code: 'P-MINUS', variant_key: '', qty: -3 },
      { movement_type: 'OUT', warehouse_id: WH, product_code: 'P-OUT', variant_key: '', qty: 5 },
    ], 'user-1');
    expect(bucketsOf(sb)).toEqual([`${WH}::P-IN::`, `${WH}::P-PLUS::`]);
  });

  test('an OUT-only batch (a resync that only removed stock) calls nothing', async () => {
    const sb = fakeSb({ rpc: () => 0, outMovements: [] });
    const res = await reconcileUncostedAfterIn(sb, [
      { movement_type: 'OUT', warehouse_id: WH, product_code: 'P1', variant_key: '', qty: 1 },
    ], 'user-1');
    expect(sb.calls).toHaveLength(0);
    expect(res).toEqual({ reconciled: 0, affectedDoIds: [] });
  });

  test('rows missing a warehouse or product are dropped rather than reconciled as an empty bucket', async () => {
    const sb = fakeSb({ rpc: () => 0, outMovements: [] });
    await reconcileUncostedAfterIn(sb, [
      { movement_type: 'IN', warehouse_id: '', product_code: 'P1', variant_key: '', qty: 1 },
      { movement_type: 'IN', warehouse_id: WH, product_code: '', variant_key: '', qty: 1 },
      { movement_type: 'IN', warehouse_id: WH, product_code: 'P1', qty: 1 }, // variant_key absent -> ''
    ], 'user-1');
    expect(bucketsOf(sb)).toEqual([`${WH}::P1::`]);
  });

  test('a throwing client is contained — resolves 0, never rejects (the receipt must not roll back)', async () => {
    const exploding = {
      rpc() { throw new Error('connection reset'); },
      from() { throw new Error('connection reset'); },
    };
    await expect(reconcileUncostedAfterIn(exploding, [
      { movement_type: 'IN', warehouse_id: WH, product_code: 'P1', variant_key: '', qty: 1 },
    ], 'user-1')).resolves.toEqual({ reconciled: 0, affectedDoIds: [] });
  });

  test('null / empty row list is a no-op', async () => {
    const sb = fakeSb({ rpc: () => 0, outMovements: [] });
    expect(await reconcileUncostedAfterIn(sb, [], 'user-1')).toEqual({ reconciled: 0, affectedDoIds: [] });
    expect(await reconcileUncostedAfterIn(sb, null, 'user-1')).toEqual({ reconciled: 0, affectedDoIds: [] });
    expect(sb.calls).toHaveLength(0);
  });
});
