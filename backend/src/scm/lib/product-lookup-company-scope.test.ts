import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  loadProductByCode, loadProductsByCodes,
  loadModelSofaModulePrices, loadModelSofaModuleCosts, loadModelSofaModuleCostRows,
} from './mfg-pricing-recompute';
import { loadProductAndModel, loadProductsAndModels } from './allowed-options-check';
import { validateItemCodes } from './validate-item-codes';
import { checkPwpEligibility, type PwpCodeRow } from './pwp-claim-single';


type Row = Record<string, unknown> & { _table: string };
const makeSb = (rows: Row[]) => ({
  from(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const run = () => rows
      .filter((r) => r._table === table)
      .filter((r) => eqs.every(([col, v]) => r[col] === v))
      .filter((r) => ins.every(([col, vs]) => vs.includes(r[col])));
    const builder: any = {
      select: () => builder,
      order:  () => builder,
      eq: (col: string, v: unknown) => { eqs.push([col, v]); return builder; },
      in: (col: string, vs: unknown[]) => { ins.push([col, vs]); return builder; },
      maybeSingle: async () => {
        const out = run();
        return out.length > 1
          ? { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
          : { data: out[0] ?? null, error: null };
      },
      then: (res: any, rej: any) => Promise.resolve({ data: run(), error: null }).then(res, rej),
    };
    return builder;
  },
});

const HOUZS_CODY: Row = {
  _table: 'mfg_products', company_id: 1, code: 'CODY-(SS)', category: 'BEDFRAME',
  base_price_sen: 40750, price1_sen: null, cost_price_sen: 0, seat_height_prices: null,
  sell_price_sen: null, pwp_price_sen: 0, model_id: 'mdl-houzs-cody', size_code: 'SS',
  base_model: 'cody', branding: null, default_free_gifts: [],
};
const S2990_CODY: Row = {
  _table: 'mfg_products', company_id: 2, code: 'CODY-(SS)', category: 'BEDFRAME',
  base_price_sen: 40750, price1_sen: null, cost_price_sen: 0, seat_height_prices: null,
  sell_price_sen: 199000, pwp_price_sen: 49000, model_id: 'mdl-2990-cody', size_code: 'SS',
  base_model: 'cody', branding: null, default_free_gifts: [],
};
const HOUZS_ONLY: Row = { ...HOUZS_CODY, code: 'CODYS-(K)' };
const MODELS: Row[] = [
  { _table: 'product_models', id: 'mdl-houzs-cody', allowed_options: { sizes: ['K'] } },
  { _table: 'product_models', id: 'mdl-2990-cody',  allowed_options: { sizes: ['SS'] } },
];
const sb = () => makeSb([HOUZS_CODY, S2990_CODY, HOUZS_ONLY, ...MODELS]);

afterEach(() => vi.restoreAllMocks());

describe('loadProductsByCodes — the batched pricing read', () => {
  it('company 2 gets 2990’s row: the selling and PWP prices the SKU Master shows', async () => {
    const m = await loadProductsByCodes(sb(), ['CODY-(SS)'], 2);
    expect(m.get('CODY-(SS)')?.pwp_price_sen).toBe(49000);
    expect(m.get('CODY-(SS)')?.sell_price_sen).toBe(199000);
  });

  it('company 1 gets HOUZS’s row — same code, different product', async () => {
    const m = await loadProductsByCodes(sb(), ['CODY-(SS)'], 1);
    expect(m.get('CODY-(SS)')?.pwp_price_sen).toBe(0);
    expect(m.get('CODY-(SS)')?.sell_price_sen).toBeNull();
  });

  it('UNSCOPED silently drops one of the two rows — the defect, and it warns', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = await loadProductsByCodes(sb(), ['CODY-(SS)'], undefined);
    expect(m.size).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('duplicate mfg_products codes'));
  });

  it('a null companyId degrades to no predicate (single-company / headless / tests)', async () => {
    const only2990 = makeSb([S2990_CODY]);
    expect((await loadProductsByCodes(only2990, ['CODY-(SS)'], null)).get('CODY-(SS)')?.pwp_price_sen).toBe(49000);
  });
});

describe('loadProductByCode — the single-row pricing read', () => {
  it('resolves within the company', async () => {
    expect((await loadProductByCode(sb(), 'CODY-(SS)', 2))?.pwp_price_sen).toBe(49000);
    expect((await loadProductByCode(sb(), 'CODY-(SS)', 1))?.pwp_price_sen).toBe(0);
  });

  it('UNSCOPED returns NULL on a duplicated code — "unknown item code" for a SKU that exists twice', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadProductByCode(sb(), 'CODY-(SS)', undefined)).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('loadProductByCode'), expect.anything());
  });
});

describe('the reported failure, end to end', () => {
  const voucher: PwpCodeRow = {
    code: 'PWP-4599PWWB', status: 'AVAILABLE', owner_staff_id: 'staff-1',
    reward_category: 'BEDFRAME', eligible_reward_model_ids: [], reward_combo_ids: [],
    customer_id: null, source_doc_no: 'SO-1', redeemed_doc_no: null, type: 'pwp',
  };
  const claim = (product: any) => checkPwpEligibility({
    codeRow: voucher, product, customerId: null, ownerStaffId: 'staff-1', qty: 1,
    isOrphanedUsed: false, alreadyOnOrder: false, sofaCombos: [], sofaModules: [],
  });

  it('the wrong company’s row reproduces "this SKU has no PWP price set (SKU Master)"', async () => {
    const wrong = await loadProductByCode(sb(), 'CODY-(SS)', 1);
    expect(claim(wrong)).toEqual({ ok: false, reason: 'this SKU has no PWP price set (SKU Master)' });
  });

  it('the right company’s row grants the RM 490 the operator was promised', async () => {
    const right = await loadProductByCode(sb(), 'CODY-(SS)', 2);
    expect(claim(right)).toEqual({ ok: true, grantPwpPrice: 49000, grantSofaComboIds: null });
  });
});

const SOFA: Row[] = [
  { _table: 'mfg_products', company_id: 1, code: 'LOTTI-2A(LHF)', category: 'SOFA', base_model: 'lotti',
    sell_price_sen: 111100, base_price_sen: 50000, price1_sen: null, cost_price_sen: 0, seat_height_prices: null },
  { _table: 'mfg_products', company_id: 2, code: 'LOTTI-2A(LHF)', category: 'SOFA', base_model: 'lotti',
    sell_price_sen: 222200, base_price_sen: 90000, price1_sen: null, cost_price_sen: 0, seat_height_prices: null },
  { _table: 'mfg_products', company_id: 2, code: 'LOTTI-1B(RHF)', category: 'SOFA', base_model: 'lotti',
    sell_price_sen: 333300, base_price_sen: 70000, price1_sen: null, cost_price_sen: 0, seat_height_prices: null },
];
const sofaSb = () => makeSb(SOFA);

describe('sofa module loaders — base_model is not unique either', () => {
  it('cost rows come back for ONE company only', async () => {
    const co2 = await loadModelSofaModuleCostRows(sofaSb(), 'lotti', 2);
    expect(co2?.map((r) => r.code).sort()).toEqual(['LOTTI-1B(RHF)', 'LOTTI-2A(LHF)']);
    expect(co2?.find((r) => r.code === 'LOTTI-2A(LHF)')?.base_price_sen).toBe(90000);

    const co1 = await loadModelSofaModuleCostRows(sofaSb(), 'lotti', 1);
    expect(co1?.map((r) => r.code)).toEqual(['LOTTI-2A(LHF)']);
    expect(co1?.[0]?.base_price_sen).toBe(50000);
  });

  it('UNSCOPED merges both companies — 3 rows for a 2-module Model', async () => {
    const both = await loadModelSofaModuleCostRows(sofaSb(), 'lotti', undefined);
    expect(both).toHaveLength(3);
    expect(both!.filter((r) => r.code === 'LOTTI-2A(LHF)')).toHaveLength(2);
  });

  it('the SELLING map differs per company (it is the drift gate’s input)', async () => {
    const a = await loadModelSofaModulePrices(sofaSb(), 'lotti', '24', 1);
    const b = await loadModelSofaModulePrices(sofaSb(), 'lotti', '24', 2);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('the COST map is scoped too (Combo auto-cost = Σ module SKU costs)', async () => {
    const a = await loadModelSofaModuleCosts(sofaSb(), 'lotti', 1);
    const b = await loadModelSofaModuleCosts(sofaSb(), 'lotti', 2);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });
});

describe('validateItemCodes — must move in lock-step with the pricing read', () => {
  it('a HOUZS-only code is NOT orderable by 2990', async () => {
    expect(await validateItemCodes(sb(), ['CODYS-(K)'], 2)).toEqual({ ok: false, unknown: ['CODYS-(K)'], inactive: [] });
  });

  it('...and is orderable by HOUZS', async () => {
    expect(await validateItemCodes(sb(), ['CODYS-(K)'], 1)).toEqual({ ok: true });
  });

  it('EXPLICITLY unscoped admits it — which the now-scoped pricing read would then price at 0', async () => {
    expect(await validateItemCodes(sb(), ['CODYS-(K)'], null)).toEqual({ ok: true });
  });

  it('omitting the company is a COMPILE error, not a silent unscoped gate', () => {
    // @ts-expect-error
    const omitted = () => validateItemCodes(sb(), ['CODYS-(K)']);
    expect(omitted).toBeInstanceOf(Function);
  });
});

describe('allowed-options loaders — a miss here means the gate stops checking', () => {
  it('each company resolves its OWN model, so allowed_options are its own', async () => {
    expect((await loadProductAndModel(sb(), 'CODY-(SS)', 2)).model?.id).toBe('mdl-2990-cody');
    expect((await loadProductAndModel(sb(), 'CODY-(SS)', 1)).model?.id).toBe('mdl-houzs-cody');
  });

  it('UNSCOPED reports the PGRST116 instead of passing the gate as product=null', async () => {
    const { product, model, lookupError } = await loadProductAndModel(sb(), 'CODY-(SS)', undefined);
    expect(product).toBeNull();
    expect(model).toBeNull();
    expect(lookupError).toContain('multiple');
  });

  it('a scoped hit carries no lookupError, so the gate runs normally', async () => {
    expect((await loadProductAndModel(sb(), 'CODY-(SS)', 2)).lookupError).toBeNull();
  });

  it('the batched form keys by code, so it too needs the company', async () => {
    expect((await loadProductsAndModels(sb(), ['CODY-(SS)'], 2)).byCode.get('CODY-(SS)')?.model?.id).toBe('mdl-2990-cody');
    expect((await loadProductsAndModels(sb(), ['CODY-(SS)'], 1)).byCode.get('CODY-(SS)')?.model?.id).toBe('mdl-houzs-cody');
  });
});
