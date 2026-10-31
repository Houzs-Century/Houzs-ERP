// 2990-0018 (owner 2026-10-26): the pooled sofa walk keeps handing a PO to the
// earliest-delivery order, even when the PO was raised for another one. MRP must
// tell purchasing which order took it, so the order that raised it is re-ordered
// on purpose instead of looking like a forgotten PO.
import { describe, expect, it } from 'vitest';

import { ownPoSlottedElsewhere, planSofaSets, type SofaSetLine, type SofaSetPoSupply } from './sofa-set-plan';
import type { SofaBatchStock } from './sofa-set-coverage';

const WH = 'wh-kl';
const VKEY = 'fabriccode=ez-002|seatheight=28|legheight=6"';
const key = (code: string) => `${WH}|${code}|${VKEY}`;

const line = (soItemId: string, docNo: string, code: string, delivery: string): SofaSetLine => ({
  soItemId, docNo, bucketKey: key(code), whId: WH, code, vkey: VKEY, need: 1, lockedBatchNo: null, delivery,
});

const noLots = (): SofaBatchStock => ({ remaining: new Map(), receivedAt: new Map(), batches: new Set() });

const po = (poNumber: string): SofaSetPoSupply => ({ poNumber, eta: '2026-11-04', qtyLeft: 1, supplierId: 'hookka' });

describe('ownPoSlottedElsewhere', () => {
  const older = [line('056-a', '2990-SO-2608-056', 'XAMMAR-2A(LHF)', '2026-11-11'), line('056-b', '2990-SO-2608-056', 'XAMMAR-L(RHF)', '2026-11-11')];
  const earlier = [line('031-a', '2990-SO-2610-031', 'XAMMAR-2A(LHF)', '2026-10-26'), line('031-b', '2990-SO-2610-031', 'XAMMAR-L(RHF)', '2026-10-26')];
  const lines = [...older, ...earlier];
  const raisedFor = new Map([['2990-PO-2610-024', new Set(['056-a', '056-b'])]]);

  it('names the earlier-delivery SO that took the PO raised for this one', () => {
    const supply = new Map([[key('XAMMAR-2A(LHF)'), [po('2990-PO-2610-024')]], [key('XAMMAR-L(RHF)'), [po('2990-PO-2610-024')]]]);
    const plans = planSofaSets(lines, noLots(), supply, raisedFor);

    expect(plans.get('031-a')?.batchNo).toBe('2990-PO-2610-024');
    expect(plans.get('056-a')?.need).toBe(1);
    const slotted = ownPoSlottedElsewhere(lines, plans, raisedFor);
    expect(slotted.get('056-a')).toEqual([{ poNumber: '2990-PO-2610-024', soDocNo: '2990-SO-2610-031', deliveryDate: '2026-10-26' }]);
    expect(slotted.get('056-b')).toEqual([{ poNumber: '2990-PO-2610-024', soDocNo: '2990-SO-2610-031', deliveryDate: '2026-10-26' }]);
    expect(slotted.has('031-a')).toBe(false);
  });

  it('says nothing when the SO is covered by its own PO', () => {
    const supply = new Map([[key('XAMMAR-2A(LHF)'), [po('2990-PO-2610-024')]], [key('XAMMAR-L(RHF)'), [po('2990-PO-2610-024')]]]);
    const plans = planSofaSets(older, noLots(), supply, raisedFor);

    expect(plans.get('056-a')?.batchNo).toBe('2990-PO-2610-024');
    expect(ownPoSlottedElsewhere(older, plans, raisedFor).size).toBe(0);
  });

  it('says nothing for a short SO whose PO was not raised for it', () => {
    const supply = new Map([[key('XAMMAR-2A(LHF)'), [po('2990-PO-2610-024')]], [key('XAMMAR-L(RHF)'), [po('2990-PO-2610-024')]]]);
    const plans = planSofaSets(lines, noLots(), supply, new Map([['2990-PO-2610-024', new Set(['031-a'])]]));

    expect(plans.get('056-a')?.need).toBe(1);
    expect(ownPoSlottedElsewhere(lines, plans, new Map([['2990-PO-2610-024', new Set(['031-a'])]])).size).toBe(0);
  });
});
