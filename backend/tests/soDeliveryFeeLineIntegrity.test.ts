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
function makeSb(resolve: (table: string, select: string, single: boolean) => unknown) {
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
      return Promise.resolve({ data: null, error: null });
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
