import { describe, expect, it } from 'vitest';
import grnsSrc from '../routes/grns.ts?raw';
import { isValidPositionCapability } from '../../services/positionCapabilities';
import { GRN_POST_CAPABILITY, GRN_POST_REFUSAL, grnPostRefusal } from './grn-post-capability';

describe('Post GRN capability', () => {
  it('is a catalogued capability, so the Roles matrix can grant it', () => {
    expect(isValidPositionCapability(GRN_POST_CAPABILITY)).toBe(true);
  });

  it('refuses a Goods Receipt editor without the capability (the storekeeper)', () => {
    expect(grnPostRefusal({ permissions: [], position_capabilities: ['scm.do.load'] })).toBe(GRN_POST_REFUSAL);
    expect(grnPostRefusal(null)).toBe(GRN_POST_REFUSAL);
  });

  it('admits the purchaser holding it, and the wildcard positions', () => {
    expect(grnPostRefusal({ permissions: [], position_capabilities: [GRN_POST_CAPABILITY] })).toBeNull();
    expect(grnPostRefusal({ permissions: ['*'], position_capabilities: [] })).toBeNull();
  });

  it('keeps the refusal short enough to reach the operator verbatim', () => {
    expect(GRN_POST_REFUSAL.reason.length).toBeLessThan(200);
  });

  it('guards every route that posts a GRN, before it writes', () => {
    const src = grnsSrc;
    const anchors = [
      "grns.post('/', async (c) => {",
      'export const createGrnFromPosHandler = async',
      'export const postGrnHandler = async',
      'export const createGrnsFromPoItemsHandler = async',
    ];
    for (const anchor of anchors) {
      const start = src.indexOf(anchor);
      expect(start, anchor).toBeGreaterThan(-1);
      const body = src.slice(start);
      const gate = body.indexOf("grnPostRefusal(c.get('houzsUser'))");
      const firstPost = body.indexOf('postGrnAndRollup(');
      expect(gate, anchor).toBeGreaterThan(-1);
      expect(gate, anchor).toBeLessThan(firstPost);
    }
  });
});
