/* The pure half of repair-mislabelled-sofa-po-lines.mjs, under test.
 *
 * The population it selects and every refusal it makes are pinned here, because
 * the two directions of error both cost real orders: too wide and a genuine
 * one-seater gets split into pieces it never had; too narrow and Lisa's sofa
 * (HC-SO-012565, docs/bugs — "the sofa purchase line was filed as others") stays
 * PENDING with the goods sitting in Balakong.
 */
import { describe, expect, test } from 'vitest';
import {
  acSofaItemOfSku, isMislabelledSofaPoLine, planMislabelledBuild, sameText,
} from '../scripts/lib/mislabelled-sofa-po-plan.mjs';
import { canonicaliser } from '../scripts/lib/redecode-sofa-plan.mjs';

const SOFA_ITEMS = new Set(['HOK-5540 SOFA', 'HOK-5530 SOFA', 'HOK-5536 SOFA', 'HOK-5537 SOFA', 'DSL-8030 SOFA']);
const CODES = new Set(['8030-1S', '8030-2A(LHF)', '8030-1A(RHF)', '8030-1A(LHF)', '8030-2A(RHF)', '9028-2A(LHF)', '9028-L(RHF)']);

describe('the population', () => {
  test('a bare -1S filed as others whose supplier_sku is a SOFA item of the binding', () => {
    expect(isMislabelledSofaPoLine({ itemCode: '8030-1S', itemGroup: 'others', supplierSku: 'HOK-5540 SOFA' }, SOFA_ITEMS)).toBe(true);
  });
  test('a line already filed as sofa is NOT one — a genuine one-seater keeps its shape', () => {
    expect(isMislabelledSofaPoLine({ itemCode: '8030-1S', itemGroup: 'sofa', supplierSku: 'HOK-5540 SOFA' }, SOFA_ITEMS)).toBe(false);
  });
  test('a decomposed compartment is NOT one', () => {
    expect(isMislabelledSofaPoLine({ itemCode: '8030-2A(LHF)', itemGroup: 'others', supplierSku: 'HOK-5540 SOFA 2A(LHF)' }, SOFA_ITEMS)).toBe(false);
  });
  test('a -1S whose AutoCount item the binding does not call SOFA is NOT one', () => {
    expect(isMislabelledSofaPoLine({ itemCode: '8030-1S', itemGroup: 'others', supplierSku: 'HOK-LONG PILLOW' }, SOFA_ITEMS)).toBe(false);
    expect(isMislabelledSofaPoLine({ itemCode: '8030-1S', itemGroup: 'others', supplierSku: null }, SOFA_ITEMS)).toBe(false);
  });
  test('the AutoCount item is matched as a PREFIX at a word boundary, longest first', () => {
    expect(acSofaItemOfSku('HOK-5540 SOFA 2A(LHF)', SOFA_ITEMS)).toBe('HOK-5540 SOFA');
    expect(acSofaItemOfSku('hok-5540 sofa', SOFA_ITEMS)).toBe('HOK-5540 SOFA');
    expect(acSofaItemOfSku('HOK-5540 SOFAX', SOFA_ITEMS)).toBeNull();
    expect(acSofaItemOfSku('HOK-5540', new Set(['HOK-5540', 'HOK-5540 SOFA']))).toBe('HOK-5540');
    expect(acSofaItemOfSku('HOK-5540 SOFA', new Set(['HOK-5540', 'HOK-5540 SOFA']))).toBe('HOK-5540 SOFA');
  });
});

const D2 = '(3S)26inch/Col:BO315-31\n*Fully Cover to Floor \n*Bottom wrap Nylon Fabric';
const so = (over = {}) => ({
  doc: 'HC-SO-012565',
  cancelled: false,
  lines: [
    { id: 'so-a', code: '8030-2A(LHF)', group: 'sofa', remark: '账本原文: ' + D2, cancelled: false, lineNo: 1, d2: D2, variants: { seatHeight: '26', fabricCode: 'BO315-31' } },
    { id: 'so-b', code: '8030-1A(RHF)', group: 'sofa', remark: '账本原文: ' + D2, cancelled: false, lineNo: 2, d2: D2, variants: { seatHeight: '26', fabricCode: 'BO315-31' } },
  ],
  ...over,
});
const po = (over = {}) => ({ doc: 'HC-PO-009435', code: '8030-1S', qty: 1, soItemId: null, d2: D2, model: '8030', ...over });
const decoded = (pieces, conf = 'high') => ({ pieces, conf, why: [] });
const base = (over = {}) => ({
  po: po(), so: so(), grns: [{ doc: 'HC-GR-005256-PO-009435', migrated: true, movements: 0 }], doLines: 0,
  decoded: decoded(['2A(LHF)', '1A(RHF)']), codeSet: CODES, canonical: (c) => c, ...over,
});

describe('the plan', () => {
  test('Lisa\'s sofa: the purchase text decodes to the very pieces the order holds, in order', () => {
    const p = planMislabelledBuild(base());
    expect(p.kind).toBe('expand');
    expect(p.target.map((t) => t.code)).toEqual(['8030-2A(LHF)', '8030-1A(RHF)']);
    expect(p.target.map((t) => t.soItemId)).toEqual(['so-a', 'so-b']);
    // the variants come off the SALES line — copied, never recomputed
    expect(p.target[0].variants).toEqual({ seatHeight: '26', fabricCode: 'BO315-31' });
  });
  test('the target follows the order\'s line_no, not the order the rows were handed in', () => {
    const s = so();
    s.lines = [s.lines[1], s.lines[0]];
    const p = planMislabelledBuild(base({ so: s }));
    expect(p.target.map((t) => t.code)).toEqual(['8030-2A(LHF)', '8030-1A(RHF)']);
  });
  test('the same text on both sides carries a build the decoder cannot read', () => {
    const p = planMislabelledBuild(base({ decoded: decoded([], 'low') }));
    expect(p.kind).toBe('expand');
  });
  test('the decoder\'s spelling of a piece is compared through the catalogue\'s canonicaliser', () => {
    const p = planMislabelledBuild(base({ decoded: decoded(['2a(lhf)', '1a(rhf)']), canonical: canonicaliser([...CODES]) }));
    expect(p.kind).toBe('expand');
  });
});

describe('the refusals — every one a stop, never a fallback', () => {
  const why = (over) => { const p = planMislabelledBuild(base(over)); expect(p.kind).toBe('refuse'); return p.why; };
  test('no sales line carries the key', () => expect(why({ so: null })).toMatch(/does not hold/));
  test('the sales order is cancelled', () => expect(why({ so: so({ cancelled: true }) })).toMatch(/cancelled/));
  test('every sales line under the key is cancelled', () => {
    const s = so(); s.lines.forEach((l) => { l.cancelled = true; });
    expect(why({ so: s })).toMatch(/cancelled/);
  });
  test('the sales side is not filed as sofa', () => {
    const s = so(); s.lines[0].group = 'others';
    expect(why({ so: s })).toMatch(/not filed as sofa/);
  });
  test('the sales side is itself a placeholder — another script\'s shape', () => {
    const s = so(); s.lines = [{ ...s.lines[0], code: '8030-1S', remark: 'SOFA UNPARSED — 按图/原文补件' }];
    expect(why({ so: s, decoded: decoded([], 'low') })).toMatch(/placeholder/);
  });
  test('a compartment appears twice on the sales side', () => {
    const s = so(); s.lines[1].code = '8030-2A(LHF)';
    // the wording is the shared judge's (lib/sofa-po-so-pair.mjs), not this planner's
    expect(why({ so: s, decoded: decoded(['2A(LHF)', '2A(LHF)']) })).toMatch(/more than once on one side/);
  });
  test('a piece SKU is not minted', () => expect(why({ codeSet: new Set(['8030-2A(LHF)']) })).toMatch(/not minted: 8030-1A\(RHF\)/));
  test('the purchase line orders more than one build', () => expect(why({ po: po({ qty: 2 }) })).toMatch(/orders 2/));
  test('the purchase line is dedicated somewhere else already', () => expect(why({ po: po({ soItemId: 'other' }) })).toMatch(/dedicated/));
  test('a delivery order already states the build', () => expect(why({ doLines: 1 })).toMatch(/delivery-order/));
  test('...and SILENCE still refuses it - the switch is never inherited', () =>
    expect(why({ doLines: 1, allowDelivered: undefined })).toMatch(/delivery-order/));
  test('...and an explicit false refuses it', () =>
    expect(why({ doLines: 1, allowDelivered: false })).toMatch(/delivery-order/));

  /* THE OWNER'S 2026-09-09 DECISION, pinned. Five purchase orders whose goods had
     already shipped were refused by this gate; told exactly what correcting them
     does and does not touch - no money, no stock, no delivery line moves - he
     said the one word. allowDelivered carries that, and ONLY that. */
  test('allowDelivered lets a DELIVERED build through, and changes nothing else', () => {
    const p = planMislabelledBuild(base({ doLines: 2, allowDelivered: true }));
    expect(p.kind).toBe('expand');
    expect(p.target.map((t) => t.code)).toEqual(['8030-2A(LHF)', '8030-1A(RHF)']);
  });
  test('allowDelivered opens NO other gate', () => {
    const p = planMislabelledBuild(base({ doLines: 2, allowDelivered: true, so: so({ cancelled: true }) }));
    expect(p.kind).toBe('refuse');
    expect(p.why).toMatch(/cancelled/);
    const q = planMislabelledBuild(base({ doLines: 2, allowDelivered: true, codeSet: new Set() }));
    expect(q.kind).toBe('refuse');
    expect(q.why).toMatch(/not minted/);
  });
  test('a goods receipt that really moved stock', () => {
    expect(why({ grns: [{ doc: 'HC-GR-1', migrated: false, movements: 0 }] })).toMatch(/really moved stock/);
    expect(why({ grns: [{ doc: 'HC-GR-1', migrated: true, movements: 2 }] })).toMatch(/really moved stock/);
  });
  test('the two documents decode to different builds', () => {
    expect(why({ decoded: decoded(['1A(LHF)', '2A(RHF)']) })).toMatch(/decodes to 8030-1A\(LHF\)\+8030-2A\(RHF\) where HC-SO-012565 holds 8030-2A\(LHF\)\+8030-1A\(RHF\)/);
  });
  test('the same pieces in the OTHER order is a different sofa', () => {
    expect(why({ decoded: decoded(['1A(RHF)', '2A(LHF)']) })).toMatch(/decodes to/);
  });
  test('unreadable purchase text that is NOT the order\'s text', () => {
    expect(why({ po: po({ d2: 'L shape\nbottom Nilon' }), decoded: decoded([], 'low') })).toMatch(/not the same text/);
  });
});

describe('sameText', () => {
  test('whitespace and case do not separate one book text from itself', () => {
    expect(sameText('(3S)26inch/Col:BO315-31\n*Fully Cover to Floor \n*Bottom', '(3S)26INCH/COL:BO315-31 *FULLY COVER TO FLOOR *BOTTOM')).toBe(true);
    expect(sameText('', '')).toBe(false);
    expect(sameText('a', 'b')).toBe(false);
  });
});
