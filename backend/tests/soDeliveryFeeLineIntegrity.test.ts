// Owner ruling 2026-08-07 ("全部都会有 SKU 的 … 怎么可以走后门呢?"): every ringgit
// on a Sales Order is a LINE. These tests pin the two halves of that ruling:
//
//  1. buildDeliveryFeeServiceLines — Σ(lines) === fee.total for every fee
//     shape (the pure layer can never leave money off a line).
//  2. rederiveDeliveryFee — an SO whose SVC-DELIVERY* lines are gone but whose
//     header delivery_fee_sen still carries a fee (the 2990-SO-2608-006
//     shape: fee lines deleted, header dual-write snapshot orphaned) is
//     RE-MATERIALISED through the one true derivation: the 0214 RPC
//     (rebuild_mfg_so_delivery_lines) is called with the DERIVED fee as lines
//     and as the header stamp. And an SO with no fee lines AND no header fee
//     stays fee-less — the dormant-fee rule (nothing ever STARTS a fee on a
//     backend-authored SO).
import { describe, expect, test } from 'vitest';
import { rederiveDeliveryFee } from '../src/scm/routes/mfg-sales-orders';
import { computeSoDeliveryFee } from '../src/scm/shared/pricing';
import { buildDeliveryFeeServiceLines } from '../src/scm/shared/service-lines';

// ── 1. Pure layer: the fee decomposes into lines that sum to the fee ────────

describe('buildDeliveryFeeServiceLines — Σ lines === fee.total', () => {
  const cfg = { baseFee: 25000, crossCategoryFee: 10000 };
  const shapes = [
    { categoryIds: ['sofa'], specialModels: [], isCrossCategoryFollowup: false, additionalFee: 0 },
    { categoryIds: ['sofa', 'mattress'], specialModels: [], isCrossCategoryFollowup: false, additionalFee: 0 },
    { categoryIds: ['sofa'], specialModels: [], isCrossCategoryFollowup: true, additionalFee: 5000 },
    { categoryIds: [], specialModels: [], isCrossCategoryFollowup: false, additionalFee: 7500 },
    { categoryIds: ['bedframe'], specialModels: [{ standaloneFee: 40000, crossCategoryFollowupFee: 15000 }], isCrossCategoryFollowup: false, additionalFee: 123 },
  ];
  for (const [i, input] of shapes.entries()) {
    test(`shape ${i} leaves no header-only money`, () => {
      const fee = computeSoDeliveryFee(input, cfg);
      const lines = buildDeliveryFeeServiceLines(fee, input.isCrossCategoryFollowup ? 'SO-SRC-1' : null);
      expect(lines.reduce((s, l) => s + l.totalSen, 0)).toBe(fee.total);
      // and each line's own arithmetic holds
      for (const l of lines) expect(l.totalSen).toBe(l.unitPriceSen * l.qty);
    });
  }
});

// ── 2. Route layer: the orphaned header fee re-materialises as lines ────────

/* Minimal chainable supabase stub. Every builder method chains; awaiting the
   builder (or .single()/.maybeSingle()) resolves through `resolve(table,
   select, single)`. rpc calls are recorded. Proxy-based so an unnoticed
   chained call can never crash the stub. */
type RpcCall = { name: string; args: Record<string, unknown> };
function makeSb(
  resolve: (table: string, select: string, single: boolean) => unknown,
  /* What the RPC answers, by attempt number (1-based). `false` is migration
     0314's refusal: the fee lines moved between the derivation's read and the
     function's advisory lock, so nothing was written. Default: always wrote. */
  rpcAnswer: (attempt: number, args: Record<string, unknown>) => unknown = () => true,
) {
  const rpcCalls: RpcCall[] = [];
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const makeBuilder = (table: string): unknown => {
    let select = '';
    const builder: any = new Proxy(() => undefined, {
      get(_t, prop: string) {
        if (prop === 'then') {
          const result = resolve(table, select, false);
          return (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve(resolve(table, select, true));
        }
        return (...args: unknown[]) => {
          if (prop === 'select') select = String(args[0] ?? '');
          if (prop === 'update') updates.push({ table, patch: (args[0] ?? {}) as Record<string, unknown> });
          return builder;
        };
      },
    });
    return builder;
  };
  const sb = {
    from: (table: string) => makeBuilder(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: rpcAnswer(rpcCalls.length, args), error: null });
    },
  };
  return { sb, rpcCalls, updates };
}

/* Context stub: no companyId resolved — scopeToCompany degrades to no
   predicate and delivery_fee_config falls back to the id=1 row, exactly the
   single-company read path. */
const ctx = { get: () => undefined } as any;

const GOODS_LINES = [
  { item_code: 'XAMMAR-L(LHF)', item_group: 'sofa', total_sen: 0, line_no: 0, variants: null },
  { item_code: 'XAMMAR-2A(RHF)', item_group: 'sofa', total_sen: 0, line_no: 1, variants: null },
];

function resolverFor(opts: { headerFeeSen: number; feeLines?: Array<Record<string, unknown>> }) {
  return (table: string, select: string, single: boolean): unknown => {
    if (table === 'mfg_sales_orders') {
      if (select.includes('cross_category_source_doc_no')) {
        return { data: { cross_category_source_doc_no: null }, error: null };
      }
      if (select.includes('delivery_fee_sen')) {
        return { data: { delivery_fee_sen: opts.headerFeeSen }, error: null };
      }
      if (select.includes('debtor_name')) {
        return { data: { debtor_name: 'A CUSTOMER', venue: null, customer_delivery_date: null, company_id: 2 }, error: null };
      }
      return single ? { data: null, error: null } : { data: [], error: null };
    }
    if (table === 'mfg_sales_order_items') {
      return { data: [...GOODS_LINES, ...(opts.feeLines ?? [])].map((l, i) => ({ id: `it-${i}`, qty: 1, line_cost_sen: 0, ...l })), error: null };
    }
    if (table === 'delivery_fee_config') {
      // whole-MYR config, like production: base 250 → 25000 sen after ×100
      return { data: { base_fee: 250, cross_category_fee: 100 }, error: null };
    }
    // mfg_products / sofa_combo_pricing / special_delivery_fee_rules / …
    return single ? { data: null, error: null } : { data: [], error: null };
  };
}

describe('rederiveDeliveryFee — no header back door', () => {
  test('an orphaned header fee with NO fee lines is re-materialised through the 0214 RPC', async () => {
    const { sb, rpcCalls } = makeSb(resolverFor({ headerFeeSen: 25000 }));
    await rederiveDeliveryFee(sb, '2990-SO-2608-006', ctx);

    expect(rpcCalls).toHaveLength(1);
    const call = rpcCalls[0]!;
    expect(call.name).toBe('rebuild_mfg_so_delivery_lines');
    expect(call.args.p_doc_no).toBe('2990-SO-2608-006');
    // the DERIVED fee (base 250 for a sofa order) — lines AND header stamp agree
    expect(call.args.p_delivery_fee_sen).toBe(25000);
    const rows = call.args.p_rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.item_code).toBe('SVC-DELIVERY');
    expect(rows[0]!.total_sen).toBe(25000);
    // Σ(rebuilt lines) === header stamp: no ringgit rides the header alone
    expect(rows.reduce((s, r) => s + Number(r.total_sen), 0)).toBe(call.args.p_delivery_fee_sen);
  });

  test('the derivation is the ONE truth — a ghost header amount never survives as-is', async () => {
    // Header claims RM999; the derivation (config base RM250) decides the fee.
    const { sb, rpcCalls } = makeSb(resolverFor({ headerFeeSen: 99900 }));
    await rederiveDeliveryFee(sb, '2990-SO-TEST-GHOST', ctx);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.args.p_delivery_fee_sen).toBe(25000);
    const rows = rpcCalls[0]!.args.p_rows as Array<Record<string, unknown>>;
    expect(rows.reduce((s, r) => s + Number(r.total_sen), 0)).toBe(25000);
  });

  test('no fee lines AND no header fee → dormant: the RPC is never called, totals still refresh', async () => {
    const { sb, rpcCalls, updates } = makeSb(resolverFor({ headerFeeSen: 0 }));
    await rederiveDeliveryFee(sb, 'HC-SO-2608-001', ctx);

    expect(rpcCalls).toHaveLength(0);
    // recomputeTotals still ran for the edit (header roll-up write attempted)
    expect(updates.some((u) => u.table === 'mfg_sales_orders' && 'local_total_sen' in u.patch)).toBe(true);
  });

  test('existing fee lines keep re-deriving exactly as before (regression pin)', async () => {
    const { sb, rpcCalls } = makeSb(resolverFor({
      headerFeeSen: 25000,
      feeLines: [{ item_code: 'SVC-DELIVERY', item_group: 'service', total_sen: 25000, line_no: 2, variants: null }],
    }));
    await rederiveDeliveryFee(sb, '2990-SO-2608-005', ctx);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.args.p_delivery_fee_sen).toBe(25000);
  });
});

/* ── 3. Operator discounts on the fee lines SURVIVE the rebuild (2026-08-19) ──
   The line PATCH accepts a bounded discount on any line, delivery included —
   but this rebuild wrote discount_sen: 0, so the one sanctioned way to REDUCE
   a delivery fee was undone by the very next derivation. An operator typed
   250 → 125 as a price and watched the line "nuke to 0 and disappear": the
   price edit was discarded (the fee is derived — one truth), and the discount
   road was silently a dead end too. The fee stays derived; the DISCOUNT is the
   operator's, and it persists. */
describe('rederiveDeliveryFee — a discount on a fee line survives the rebuild', () => {
  const discountedBase = {
    item_code: 'SVC-DELIVERY', item_group: 'service',
    unit_price_sen: 25000, discount_sen: 12500, total_sen: 12500,
    line_no: 2, variants: null,
  };

  test('unit 250 / discount 125 rebuilds as unit 250 / discount 125 / total 125', async () => {
    const { sb, rpcCalls } = makeSb(resolverFor({ headerFeeSen: 12500, feeLines: [discountedBase] }));
    await rederiveDeliveryFee(sb, '2990-SO-DISC-1', ctx);

    expect(rpcCalls).toHaveLength(1);
    const rows = rpcCalls[0]!.args.p_rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    // the fee itself is still the DERIVED 250 — the discount never rewrites it
    expect(rows[0]!.unit_price_sen).toBe(25000);
    expect(rows[0]!.discount_sen).toBe(12500);
    expect(rows[0]!.total_sen).toBe(12500);
    // the header mirrors the LINES, so it carries the net
    expect(rpcCalls[0]!.args.p_delivery_fee_sen).toBe(12500);
  });

  test('a discount larger than the derived fee clamps to it — a fee line can never go negative', async () => {
    const { sb, rpcCalls } = makeSb(resolverFor({
      headerFeeSen: 0,
      feeLines: [{ ...discountedBase, discount_sen: 99999, total_sen: 0 }],
    }));
    await rederiveDeliveryFee(sb, '2990-SO-DISC-2', ctx);

    const rows = rpcCalls[0]!.args.p_rows as Array<Record<string, unknown>>;
    expect(rows[0]!.discount_sen).toBe(25000);
    expect(rows[0]!.total_sen).toBe(0);
    expect(rpcCalls[0]!.args.p_delivery_fee_sen).toBe(0);
  });

  test('a discounted ADD line does not compound: the gross is recovered, not the net', async () => {
    /* The free-form fee is recovered from unit × qty. Recovering total_sen —
       the NET once discounts survive — would shrink the fee by the discount on
       every rebuild: 50 → 30 → 10 → 0 across three saves. */
    const { sb, rpcCalls } = makeSb(resolverFor({
      headerFeeSen: 28000,
      feeLines: [
        { item_code: 'SVC-DELIVERY', item_group: 'service', unit_price_sen: 25000, discount_sen: 0, total_sen: 25000, line_no: 2, variants: null },
        { item_code: 'SVC-DELIVERY-ADD', item_group: 'service', unit_price_sen: 5000, discount_sen: 2000, total_sen: 3000, line_no: 3, variants: null },
      ],
    }));
    await rederiveDeliveryFee(sb, '2990-SO-DISC-3', ctx);

    const rows = rpcCalls[0]!.args.p_rows as Array<Record<string, unknown>>;
    const add = rows.find((r) => r.item_code === 'SVC-DELIVERY-ADD')!;
    expect(add.unit_price_sen).toBe(5000);   // gross preserved — no compounding
    expect(add.discount_sen).toBe(2000);
    expect(add.total_sen).toBe(3000);
    expect(rpcCalls[0]!.args.p_delivery_fee_sen).toBe(28000);
  });

  test('no discount → byte-identical behaviour to before (regression pin)', async () => {
    const { sb, rpcCalls } = makeSb(resolverFor({
      headerFeeSen: 25000,
      feeLines: [{ item_code: 'SVC-DELIVERY', item_group: 'service', unit_price_sen: 25000, discount_sen: 0, total_sen: 25000, line_no: 2, variants: null }],
    }));
    await rederiveDeliveryFee(sb, '2990-SO-DISC-4', ctx);

    const rows = rpcCalls[0]!.args.p_rows as Array<Record<string, unknown>>;
    expect(rows[0]!.discount_sen).toBe(0);
    expect(rows[0]!.total_sen).toBe(25000);
    expect(rpcCalls[0]!.args.p_delivery_fee_sen).toBe(25000);
  });
});

/* ── 4. A CONCURRENT save cannot revert the operator's typed fee (2026-08-20) ──
   The 0214 advisory lock is taken INSIDE rebuild_mfg_so_delivery_lines. The
   derivation READS the fee lines before that — so read, then lock. One ordinary
   Save fans its dirty-line PATCHes out in parallel (runSoLineWrites ->
   settleParallelLineWrites -> Promise.allSettled), and each ends in
   rederiveDeliveryFee. A salesperson who cuts the fee 250 -> 125 AND changes a
   sofa quantity in the same Save therefore had two rebuilds in flight, the
   second derived from a snapshot taken before the discount committed, and the
   second write put 250 back: quoted RM 125, invoice RM 250.

   Migration 0314 makes the RPC re-read that state under its own lock and return
   FALSE without writing when it has moved. These cases pin both halves — the
   expectation the caller sends, and the re-derivation it does when refused. */
describe('rederiveDeliveryFee — a parallel line PATCH cannot revert a typed fee', () => {
  /** One live SVC-DELIVERY line, mutable so the test can commit a concurrent
   *  edit to it between the derivation's read and the rebuild. */
  const liveFee = () => ({
    id: 'fee-1', item_code: 'SVC-DELIVERY', item_group: 'service',
    qty: 1, unit_price_sen: 25000, discount_sen: 0, total_sen: 25000,
    line_no: 2, variants: null,
  });

  test('the rebuild is told exactly which fee lines the derivation read', async () => {
    const { sb, rpcCalls } = makeSb(resolverFor({ headerFeeSen: 12500, feeLines: [{ ...liveFee(), discount_sen: 12500, total_sen: 12500 }] }));
    await rederiveDeliveryFee(sb, '2990-SO-EXPECT-1', ctx);

    expect(rpcCalls).toHaveLength(1);
    // keyed by row id so the comparison is order-free; [item_code, qty, unit, discount]
    expect(rpcCalls[0]!.args.p_expect_state).toEqual({ 'fee-1': ['SVC-DELIVERY', 1, 25000, 12500] });
  });

  test('REGRESSION: a discount committed by a parallel PATCH is re-read, not overwritten with 0', async () => {
    const fee = [liveFee()];
    const { sb, rpcCalls } = makeSb(
      resolverFor({ headerFeeSen: 25000, feeLines: fee }),
      (attempt) => {
        if (attempt > 1) return true;
        /* The parallel line PATCH — the one that carries the operator's
           250 -> 125 — commits while THIS derivation is between its read and
           the lock. The RPC sees the fee lines no longer match what we derived
           from and refuses. */
        fee[0]!.discount_sen = 12500;
        fee[0]!.total_sen = 12500;
        return false;
      },
    );

    await rederiveDeliveryFee(sb, '2990-SO-RACE-1', ctx);

    // Refused once, re-derived once. The write that lands is the SECOND one.
    expect(rpcCalls).toHaveLength(2);
    const first = rpcCalls[0]!.args.p_rows as Array<Record<string, unknown>>;
    expect(first[0]!.discount_sen).toBe(0);          // what would have reverted the fee
    const rows = rpcCalls[1]!.args.p_rows as Array<Record<string, unknown>>;
    expect(rows[0]!.unit_price_sen).toBe(25000);     // the fee is still derived
    expect(rows[0]!.discount_sen).toBe(12500);       // the operator's reduction survived
    expect(rows[0]!.total_sen).toBe(12500);
    expect(rpcCalls[1]!.args.p_delivery_fee_sen).toBe(12500);
    expect(rpcCalls[1]!.args.p_expect_state).toEqual({ 'fee-1': ['SVC-DELIVERY', 1, 25000, 12500] });
  });

  test('a fee line that keeps moving is left ALONE — never written from stale inputs', async () => {
    /* Fail closed, the same posture as the failed header read: something else is
       actively rewriting these lines and will re-derive after itself. */
    const { sb, rpcCalls } = makeSb(resolverFor({ headerFeeSen: 25000, feeLines: [liveFee()] }), () => false);
    await rederiveDeliveryFee(sb, '2990-SO-RACE-2', ctx);
    expect(rpcCalls).toHaveLength(3);               // DELIVERY_REBUILD_MAX_ATTEMPTS
  });

  test('an unraced rebuild behaves EXACTLY as before — one call, one write', async () => {
    const { sb, rpcCalls } = makeSb(resolverFor({ headerFeeSen: 25000, feeLines: [liveFee()] }));
    await rederiveDeliveryFee(sb, '2990-SO-CALM-1', ctx);
    expect(rpcCalls).toHaveLength(1);
    const rows = rpcCalls[0]!.args.p_rows as Array<Record<string, unknown>>;
    expect(rows[0]!.discount_sen).toBe(0);
    expect(rows[0]!.total_sen).toBe(25000);
  });
});
