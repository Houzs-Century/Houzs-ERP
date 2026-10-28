import { describe, it, expect } from 'vitest';
import { parseRouterDecision, agentLabel, recordTeaching } from './assistant-teach';

const FAMILIES = ['DELIVERY', 'DOCUMENT', 'CS', 'COLLECTION', 'PROCUREMENT', 'PMS', 'OF', 'SI'];
const KEYS = ['order_fulfilment', 'delivery', 'receivables', 'procurement', 'sales_intel', 'documents'];

describe('parseRouterDecision', () => {
  it('reads a teach object and normalises the family to upper-case', () => {
    const d = parseRouterDecision(
      '{"teach":{"agent":"procurement","instruction":"From now on split mattress and bedframe onto separate POs"}}',
      FAMILIES,
      KEYS,
    );
    expect(d).toEqual({
      kind: 'teach',
      family: 'PROCUREMENT',
      instruction: 'From now on split mattress and bedframe onto separate POs',
    });
  });

  it('tolerates prose / markdown fences around the JSON object', () => {
    const d = parseRouterDecision(
      'Sure. ```json\n{"teach":{"agent":"CS","instruction":"Never promise a delivery date"}}\n``` ok',
      FAMILIES,
      KEYS,
    );
    expect(d).toEqual({ kind: 'teach', family: 'CS', instruction: 'Never promise a delivery date' });
  });

  it('does not invent a target: an unknown teach family yields null', () => {
    expect(parseRouterDecision('{"teach":{"agent":"MARKETING","instruction":"do x"}}', FAMILIES, KEYS)).toBeNull();
  });

  it('rejects a teach with an empty instruction', () => {
    expect(parseRouterDecision('{"teach":{"agent":"PROCUREMENT","instruction":"   "}}', FAMILIES, KEYS)).toBeNull();
  });

  it('reads an ask object and drops unknown keys', () => {
    const d = parseRouterDecision('{"ask":["procurement","nonsense","delivery"]}', FAMILIES, KEYS);
    expect(d).toEqual({ kind: 'ask', keys: ['procurement', 'delivery'] });
  });

  it('accepts a bare array for back-compat with the old array-only router', () => {
    const d = parseRouterDecision('["receivables","procurement"]', FAMILIES, KEYS);
    expect(d).toEqual({ kind: 'ask', keys: ['receivables', 'procurement'] });
  });

  it('prefers a valid teach over an also-present ask', () => {
    const d = parseRouterDecision(
      '{"teach":{"agent":"OF","instruction":"Flag orders older than 30 days"},"ask":["delivery"]}',
      FAMILIES,
      KEYS,
    );
    expect(d).toEqual({ kind: 'teach', family: 'OF', instruction: 'Flag orders older than 30 days' });
  });

  it('falls back to ask when the teach target is invalid but an ask is present', () => {
    const d = parseRouterDecision('{"teach":{"agent":"XX","instruction":"y"},"ask":["procurement"]}', FAMILIES, KEYS);
    expect(d).toEqual({ kind: 'ask', keys: ['procurement'] });
  });

  it('returns an empty ask for an empty ask array', () => {
    expect(parseRouterDecision('{"ask":[]}', FAMILIES, KEYS)).toEqual({ kind: 'ask', keys: [] });
  });

  it('returns null on garbage or blank input', () => {
    expect(parseRouterDecision('not json at all', FAMILIES, KEYS)).toBeNull();
    expect(parseRouterDecision('', FAMILIES, KEYS)).toBeNull();
    expect(parseRouterDecision('   ', FAMILIES, KEYS)).toBeNull();
  });
});

describe('agentLabel', () => {
  it('maps a known family to its human label', () => {
    expect(agentLabel('PROCUREMENT')).toBe('Procurement / purchasing');
    expect(agentLabel('CS')).toBe('Customer service');
  });
  it('falls back to the id for an unknown family', () => {
    expect(agentLabel('WHATEVER')).toBe('WHATEVER');
  });
});

describe('recordTeaching validation (guards run before any DB write)', () => {
  it('rejects an unknown family', async () => {
    await expect(
      recordTeaching({} as never, { family: 'MARKETING' as never, instruction: 'x', actor: null }),
    ).rejects.toThrow(/unknown agent family/);
  });
  it('rejects an empty instruction', async () => {
    await expect(
      recordTeaching({} as never, { family: 'PROCUREMENT' as never, instruction: '   ', actor: null }),
    ).rejects.toThrow(/empty instruction/);
  });
});
