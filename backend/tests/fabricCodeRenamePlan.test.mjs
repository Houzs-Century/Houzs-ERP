/* The planner behind rename-fabric-codes.mjs, and the owner's list it runs.
 *
 * A fabric code is the price-tier join on an order line, the colour inside a
 * stock bucket, an entry in a Model's pool and (as its series) the key of an
 * item KPI rule. Every refusal below is a case where renaming anyway would have
 * re-priced a line, paid a bonus twice or left a code half renamed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seriesOf } from '../src/scm/lib/fabric-series';
import {
  planFabricCodeRename, validateRenamePairs, renamePool, seriesIdOf, trackingIdOf, anyCodeRegex,
  RENAME_CARRIERS, HANDLED_VARIANT_KEYS,
} from '../scripts/lib/fabric-code-rename.mjs';
import { ARMS, VKEY_ARMS, COLOUR_ALIASES } from '../scripts/lib/fabric-write.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOK = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'scripts', 'data', 'fabric-code-renames.json'), 'utf8'));

const CO = 2;
const PAIRS = [{ from: 'KN06', to: 'EM-01' }, { from: 'KN07', to: 'EM-02' }, { from: 'KN01', to: 'EM-09' }];
const NAMES = { KN06: 'Pearl', KN07: 'Sand', KN01: 'Aegean' };

const tracking = (code, to, over = {}) => ({
  id: code, fabric_code: code, fabric_description: `${to} ${NAMES[code]}`, series: 'EMBRACE',
  supplier_code: null, is_active: true, company_id: CO, ...over,
});
const series = (id, over = {}) => ({
  id, label: id, tier: 'standard', default_surcharge: 0, sofa_tier: 'PRICE_2', bedframe_tier: null,
  active: true, sort_order: 10, company_id: CO, ...over,
});
const colour = (fabricId, colourId, over = {}) => ({ fabric_id: fabricId, colour_id: colourId, label: NAMES[colourId] ?? null, active: true, company_id: CO, ...over });
const rule = (ref, n, over = {}) => ({ id: `rule-${n}`, ref, label: ref, bonus_sen: 12500, active: true, created_at: `2026-11-06 08:19:2${n}`, ...over });
const hit = (table, col, n, over = {}) => ({ table, col, kind: 'col', live: true, writer: true, retained: false, hasCompany: true, n, ...over });

/** The masters as production held them before the rename: each code a series of its own. */
const pendingState = (over = {}) => ({
  trackings: PAIRS.map((p) => tracking(p.from, p.to)),
  colours: PAIRS.map((p) => colour(p.from, p.from)),
  library: PAIRS.map((p, i) => series(p.from, { sort_order: (i + 1) * 10 })),
  seriesColours: PAIRS.map((p) => colour(p.from, p.from)),
  kpiRules: PAIRS.map((p, i) => rule(p.from, i + 1)),
  productFabrics: [],
  models: [{ id: 'm-1', model_code: 'BOOQIT', fabrics: ['CG-001', 'KN01', 'KN06', 'KN07', 'BROWNIE-01'] }],
  census: [],
  variantKeys: [],
  variantShapes: [],
  ...over,
});
/** The same masters after the run. */
const doneState = (over = {}) => ({
  trackings: PAIRS.map((p) => tracking(p.to, p.to, { fabric_description: `${p.to} ${NAMES[p.from]}` })),
  colours: PAIRS.map((p) => colour('EM', p.to)),
  library: [series('EM'), ...PAIRS.map((p) => series(p.from, { active: false, label: `${p.from} [renamed to EM on 2026-11-13]` }))],
  seriesColours: PAIRS.map((p) => colour('EM', p.to)),
  kpiRules: [rule('EM', 1)],
  productFabrics: [],
  models: [],
  census: [hit('scm.fabric_library', 'id', 3, { writer: false, retained: true })],
  variantKeys: [],
  variantShapes: [],
  ...over,
});

const plan = (state, over = {}) => planFabricCodeRename({
  companyId: CO, pairs: PAIRS, descriptionLeadsWithNewCode: true, stamp: '2026-11-13', state, ...over,
});

describe('the EMBRACE list (owner 2026-11-13)', () => {
  const batch = BOOK['EMBRACE-2026-11-13'];

  it('renames KN01..KN13 once each onto EM-01..EM-13, for 2990', () => {
    const num = (n) => String(n).padStart(2, '0');
    expect(batch.companyId).toBe(2);
    expect(batch.pairs.map((p) => p.from)).toEqual(Array.from({ length: 13 }, (_, i) => `KN${num(i + 1)}`));
    expect(batch.pairs.map((p) => p.to).sort()).toEqual(Array.from({ length: 13 }, (_, i) => `EM-${num(i + 1)}`));
  });

  it('is the mapping the owner marked on the Fabric Converter screen', () => {
    expect(Object.fromEntries(batch.pairs.map((p) => [p.from, p.to]))).toEqual({
      KN01: 'EM-09', KN02: 'EM-13', KN03: 'EM-10', KN04: 'EM-12', KN05: 'EM-11', KN06: 'EM-01', KN07: 'EM-02',
      KN08: 'EM-04', KN09: 'EM-03', KN10: 'EM-08', KN11: 'EM-06', KN12: 'EM-07', KN13: 'EM-05',
    });
  });

  it('is a valid list, and the thirteen new codes are one series, EM', () => {
    expect(validateRenamePairs(batch.pairs)).toEqual([]);
    expect([...new Set(batch.pairs.map((p) => seriesIdOf(p.to)))]).toEqual(['EM']);
  });
});

describe('the series and id rules match the app', () => {
  it.each(['KN01', 'EM-09', 'BROWNIE-03', 'SF-AT-01', 'ALPINE-5311-13', 'AM275-02', 'KN390-11', 'Velvet Interlace', 'NX011', 'em-2', ''])(
    'seriesIdOf(%j) is what the Fabric Converter mirrors the colour under',
    (code) => { expect(seriesIdOf(code)).toBe(seriesOf(code)); },
  );

  it('derives the Fabric Converter id the way a create and a CSV import do', () => {
    expect(trackingIdOf('EM-09')).toBe('EM-09');
    expect(trackingIdOf(' avani 09 ')).toBe('AVANI_09');
  });

  it('matches a code only as a whole word', () => {
    const re = new RegExp(anyCodeRegex(['KN01', 'KN07']), 'i');
    for (const s of ['KN01', 'KN07 Sand / SEAT 28', 'fabriccode=kn01|seatheight=28', '"fabricCode": "KN07"', 'EMBRACE/KN07 Sand']) expect(re.test(s)).toBe(true);
    for (const s of ['KN011', 'PKN01', 'KN390-01', 'KN0', 'fabriccode=kn017']) expect(re.test(s)).toBe(false);
  });
});

describe('what the sweeps cover', () => {
  it('has a writer for every line table, every stock bucket and the masters', () => {
    const writers = RENAME_CARRIERS.filter((c) => c.writer).map((c) => `${c.table}.${c.col}`);
    for (const arm of ARMS) {
      expect(writers).toContain(`${arm.t}.variants`);
      expect(writers).toContain(`${arm.t}.description2`);
    }
    for (const arm of VKEY_ARMS) expect(writers).toContain(`${arm.t}.${arm.c}`);
    for (const c of ['scm.fabric_trackings.fabric_code', 'scm.fabric_trackings.id', 'scm.fabric_colours.colour_id',
      'scm.fabric_colours.fabric_id', 'scm.hr_item_kpi.ref', 'scm.product_request_lines.fabric_code',
      "scm.product_models.allowed_options->'fabrics'"]) expect(writers).toContain(c);
  });

  it('never rewrites history, and has no writer for a cart or a queued AutoCount push', () => {
    for (const c of RENAME_CARRIERS.filter((x) => !x.live)) expect(c.writer).toBe(false);
    for (const t of ['scm.pos_carts', 'scm.quotes', 'scm.autocount_outbox', 'scm.product_fabrics']) {
      expect(RENAME_CARRIERS.filter((c) => c.table === t).every((c) => !c.writer)).toBe(true);
    }
  });

  it('rewrites the whole colour alias chain and the series keys', () => {
    for (const k of [...COLOUR_ALIASES, 'fabricId', 'fabricLabel', 'colourLabel', 'summary']) expect(HANDLED_VARIANT_KEYS).toContain(k);
  });
});

describe('a list that is wrong before any database is read', () => {
  it.each([
    [[], /empty/],
    [[{ from: 'KN01', to: 'EM-09' }, { from: 'KN01', to: 'EM-10' }], /old code listed twice: KN01/],
    [[{ from: 'KN01', to: 'EM-09' }, { from: 'KN02', to: 'EM-09' }], /new code listed twice: EM-09/],
    [[{ from: 'KN01', to: 'KN02' }, { from: 'KN02', to: 'KN03' }], /both an old and a new code: KN02/],
    [[{ from: 'KN01', to: 'EM09' }], /not in the SERIES-NUMBER form \(it would be "EM-09"\)/],
    [[{ from: 'KN01', to: 'EM-9' }], /it would be "EM-09"/],
    [[{ from: 'KN01', to: 'em-09' }], /upper-case/],
    [[{ from: 'KN01', to: ' EM-09' }], /no padding/],
    [[{ from: 'KN01', to: 'EM-09' }, { from: 'KN02', to: 'HOME-01' }], /more than one series \(EM, HOME\)/],
    [[{ from: 'KN01', to: 'SOFA-01' }], /reads as a product \(SOFA\)/],
  ])('%j is refused', (pairs, why) => {
    expect(validateRenamePairs(pairs).join(' | ')).toMatch(why);
  });
});

describe('renaming a Model fabric pool', () => {
  it('keeps the order and maps each code to its own new colour, not to the series', () => {
    // The 2990 POS reads the pool as colour ids: a bare "EM" would offer nothing.
    expect(renamePool(['CG-001', 'KN01', 'KN07', 'BROWNIE-01'], PAIRS, ['KN01', 'KN06', 'KN07'], 'EM'))
      .toEqual(['CG-001', 'EM-09', 'EM-02', 'BROWNIE-01']);
  });

  it('maps a series entry that is not itself a renamed code onto the new series, once', () => {
    const pairs = [{ from: 'BROWNIE-01', to: 'HOME-01' }, { from: 'BROWNIE-02', to: 'HOME-02' }];
    expect(renamePool(['BROWNIE', 'BROWNIE-02', 'HOME', 'CG'], pairs, ['BROWNIE'], 'HOME')).toEqual(['HOME', 'HOME-02', 'CG']);
  });
});

describe('planning the rename', () => {
  it('moves the three masters, one series for all, in a single plan', () => {
    const p = plan(pendingState());
    expect(p.refusals).toEqual([]);
    expect(p.masters).toBe('pending');
    expect(p.trackingMoves.map((m) => [m.oldId, m.newId, m.to])).toEqual([['KN06', 'EM-01', 'EM-01'], ['KN07', 'EM-02', 'EM-02'], ['KN01', 'EM-09', 'EM-09']]);
    expect(p.colourMoves.map((m) => [m.fromSeries, m.from, m.to])).toEqual([['KN06', 'KN06', 'EM-01'], ['KN07', 'KN07', 'EM-02'], ['KN01', 'KN01', 'EM-09']]);
    // The new series takes its tier from the row whose colour becomes EM-01.
    expect(p.target).toEqual({
      id: 'EM', label: 'EM',
      create: { templateId: 'KN06', tier: 'standard', defaultSurcharge: 0, sofaTier: 'PRICE_2', bedframeTier: null, sortOrder: 10 },
    });
    expect(p.sweepSeries.sort()).toEqual(['KN01', 'KN06', 'KN07']);
    expect(p.work).toBe(true);
  });

  it('switches the old series off and keeps the rows, stamped with what replaced them', () => {
    expect(plan(pendingState()).supersede).toEqual([
      { id: 'KN06', label: 'KN06 [renamed to EM on 2026-11-13]' },
      { id: 'KN07', label: 'KN07 [renamed to EM on 2026-11-13]' },
      { id: 'KN01', label: 'KN01 [renamed to EM on 2026-11-13]' },
    ]);
  });

  it('folds the per-fabric item KPI rules into ONE rule: thirteen rules on one series would pay thirteen times', () => {
    const p = plan(pendingState());
    expect(p.kpi).toEqual({
      keepId: 'rule-1', deleteIds: ['rule-2', 'rule-3'], ref: 'EM', label: 'EM', bonusSen: 12500, active: true, retarget: true,
    });
  });

  it('renames the pool entries in place', () => {
    expect(plan(pendingState()).pools).toEqual([{
      id: 'm-1', modelCode: 'BOOQIT',
      before: ['CG-001', 'KN01', 'KN06', 'KN07', 'BROWNIE-01'], after: ['CG-001', 'EM-09', 'EM-01', 'EM-02', 'BROWNIE-01'],
    }]);
  });

  it('sorts the census into what it rewrites, what stays by rule and what is history', () => {
    const p = plan(pendingState({
      census: [
        hit('scm.mfg_sales_order_items', 'variants', 11, { kind: 'variants' }),
        hit('scm.fabric_library', 'id', 3, { writer: false, retained: true }),
        hit('scm.so_revisions', 'snapshot', 1, { kind: 'blob', live: false, writer: false }),
        hit('scm.delivery_order_items', 'variants', 0, { kind: 'variants' }),
      ],
    }));
    expect(p.refusals).toEqual([]);
    expect(p.hits.rewritten.map((c) => c.table)).toEqual(['scm.mfg_sales_order_items']);
    expect(p.hits.retained.map((c) => c.table)).toEqual(['scm.fabric_library']);
    expect(p.hits.history.map((c) => c.table)).toEqual(['scm.so_revisions']);
  });
});

describe('what the planner refuses', () => {
  const refusal = (state, over) => plan(state, over).refusals.join(' | ');

  it('a pair whose description does not lead with its new code (a typo in the list)', () => {
    const state = pendingState();
    state.trackings[1].fabric_description = 'EM-03 Desert';
    expect(refusal(state)).toMatch(/KN07: its description reads "EM-03 Desert", which does not lead with EM-02/);
    expect(plan(state, { descriptionLeadsWithNewCode: false }).refusals).toEqual([]);
  });

  it('series on different selling tiers: one series has one tier, so lines would be re-priced', () => {
    const state = pendingState();
    state.library[2].sofa_tier = 'PRICE_3';
    expect(refusal(state)).toMatch(/do not share one selling tier and surcharge: KN06, KN07 = standard \/ sofa PRICE_2 \/ bedframe -; KN01 = standard \/ sofa PRICE_3 \/ bedframe -/);
  });

  it('series on different surcharges, without printing the amount (the run log is public)', () => {
    const state = pendingState();
    state.library[0].default_surcharge = 20000;
    const text = refusal(state);
    expect(text).toMatch(/KN06 = standard \/ sofa PRICE_2 \/ bedframe - \/ with a surcharge; KN01, KN07 = standard \/ sofa PRICE_2 \/ bedframe -\./);
    expect(text).not.toMatch(/20000|200\.00/);
  });

  it('item KPI rules that pay different amounts', () => {
    const state = pendingState();
    state.kpiRules[2].bonus_sen = 5000;
    expect(refusal(state)).toMatch(/do not agree \(RM 125\.00, RM 50\.00\)/);
  });

  it('an item KPI rule switched off on one fabric only', () => {
    const state = pendingState();
    state.kpiRules[0].active = false;
    expect(refusal(state)).toMatch(/do not agree \(RM 125\.00 \(off\), RM 125\.00\)/);
  });

  it('a rule on some fabrics and not others: one rule on the series would start paying the rest', () => {
    const state = pendingState();
    state.kpiRules = [rule('KN06', 1), rule('KN07', 2)];
    expect(refusal(state)).toMatch(/2 of 3 series carry an item KPI rule; one rule on "EM" would start paying KN01/);
  });

  it('two rules already on one fabric', () => {
    const state = pendingState();
    state.kpiRules.push(rule('KN07', 9));
    expect(refusal(state)).toMatch(/more than one item KPI rule on KN07/);
  });

  it('an old series that holds a colour the list does not rename', () => {
    const state = pendingState();
    state.seriesColours.push(colour('KN07', 'KN07-DARK'));
    expect(refusal(state)).toMatch(/series "KN07" also holds KN07-DARK, which this list does not rename/);
  });

  it('a series id another organisation already owns (the key is global)', () => {
    const state = pendingState();
    state.library.push(series('EM', { company_id: 1 }));
    expect(refusal(state)).toMatch(/series id "EM" already belongs to another organisation/);
  });

  it('a Fabric Converter row that already sits on the new id', () => {
    const state = pendingState();
    state.trackings.push(tracking('KN07', 'EM-02', { id: 'EM-02', fabric_code: 'OTHER' }));
    expect(refusal(state)).toMatch(/EM-02: another Fabric Converter row already has the id "EM-02"/);
  });

  it('a list that is half renamed', () => {
    const state = pendingState();
    state.trackings[0] = tracking('EM-01', 'EM-01', { fabric_description: 'EM-01 Pearl' });
    state.colours[0] = colour('EM', 'EM-01');
    state.library.push(series('EM'));
    expect(refusal(state)).toMatch(/1 of 3 codes are renamed already and 2 are not/);
  });

  it('a code with no row, or two rows', () => {
    const state = pendingState();
    state.trackings.push(tracking('KN07', 'EM-02', { id: 'FABRIC_KN07' }));
    state.trackings = state.trackings.filter((r) => r.fabric_code !== 'KN01');
    const text = refusal(state);
    expect(text).toMatch(/KN07 -> EM-02: the Fabric Converter holds 2 row\(s\) on the old code/);
    expect(text).toMatch(/KN01 -> EM-09: the Fabric Converter holds 0 row\(s\) on the old code/);
  });

  it('per-product fabric rows on an old series', () => {
    expect(refusal(pendingState({ productFabrics: [{ fabric_id: 'KN07', n: 4 }] }))).toMatch(/scm\.product_fabrics holds 4 row\(s\) on KN07/);
  });

  it('a pool entry that is not text', () => {
    const state = pendingState();
    state.models[0].fabrics = ['KN01', 7];
    expect(refusal(state)).toMatch(/model BOOQIT: its fabric pool holds an entry that is not text/);
  });

  it('an open cart, or any live column it has no writer for', () => {
    const state = pendingState({ census: [hit('scm.pos_carts', 'lines', 2, { kind: 'blob', writer: false })] });
    const p = plan(state);
    expect(p.refusals.join(' | ')).toMatch(/2 row\(s\) of scm\.pos_carts\.lines name an old code and this script has no writer/);
    expect(p.hits.unwritable).toHaveLength(1);
  });

  it('an old code under a variants key the sweeps do not rewrite, or inside a nested value', () => {
    const text = refusal(pendingState({
      variantKeys: [
        { table: 'scm.mfg_sales_order_items', key: 'fabricCode', type: 'string', n: 9 },
        { table: 'scm.mfg_sales_order_items', key: 'remark', type: 'string', n: 1 },
        { table: 'scm.purchase_order_items', key: 'specials', type: 'array', n: 2 },
      ],
    }));
    expect(text).toMatch(/scm\.mfg_sales_order_items: 1 line\(s\) hold an old code under variants\.remark \(string\)/);
    expect(text).toMatch(/scm\.purchase_order_items: 2 line\(s\) hold an old code under variants\.specials \(array\)/);
    expect(text).not.toMatch(/variants\.fabricCode/);
  });

  it('a variants block that is not an object', () => {
    expect(refusal(pendingState({ variantShapes: [{ table: 'scm.mfg_sales_order_items', n: 1 }] }))).toMatch(/not an object/);
  });
});

describe('a second run', () => {
  it('finds the codes renamed and plans no write', () => {
    const p = plan(doneState());
    expect(p.refusals).toEqual([]);
    expect(p.masters).toBe('done');
    expect(p.trackingMoves).toEqual([]);
    expect(p.supersede).toEqual([]);
    expect(p.kpi).toBeNull();
    expect(p.target.create).toBeNull();
    expect(p.work).toBe(false);
  });

  it('still moves an order saved on an old code in between', () => {
    const p = plan(doneState({
      census: [
        hit('scm.fabric_library', 'id', 3, { writer: false, retained: true }),
        hit('scm.mfg_sales_order_items', 'variants', 1, { kind: 'variants' }),
      ],
      variantKeys: [{ table: 'scm.mfg_sales_order_items', key: 'fabricId', type: 'string', n: 1 }],
    }));
    expect(p.refusals).toEqual([]);
    expect(p.work).toBe(true);
    expect(p.trackingMoves).toEqual([]);
    // the line's old series id is known from the code even though its row is switched off
    expect(p.sweepSeries.sort()).toEqual(['KN01', 'KN06', 'KN07']);
    expect(p.seriesLabels).toContain('KN07');
  });
});
