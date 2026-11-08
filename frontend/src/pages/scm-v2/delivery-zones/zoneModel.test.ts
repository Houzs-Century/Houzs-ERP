import { describe, expect, it } from 'vitest';
import {
  coverageChanges, effectiveMap, tiedPrefixes, withRule, parseRuleForm, postcodePrefix, rangeForPrefix, rangeText, runs, zoneByPrefix, zoneSummary,
  type RuleLike, type ZoneRange,
} from './zoneModel';

const DEFAULTS: ZoneRange[] = [
  { zone: 'PJ', prefixStart: 46, prefixEnd: 47 },
  { zone: 'KAJANG', prefixStart: 43, prefixEnd: 43 },
  { zone: 'KL', prefixStart: 50, prefixEnd: 60 },
];
const rule = (id: string, zone: string, a: number, b: number, isActive = true): RuleLike =>
  ({ id, zone, prefixStart: a, prefixEnd: b, isActive, label: null });

describe('effectiveMap', () => {
  it('uses the built-in map while no rule is active, the active rules otherwise', () => {
    expect(effectiveMap([], DEFAULTS).usingDefault).toBe(true);
    expect(effectiveMap([rule('a', 'KL', 50, 60, false)], DEFAULTS).usingDefault).toBe(true);
    const m = effectiveMap([rule('a', 'KL', 50, 60), rule('b', 'PJ', 46, 47, false)], DEFAULTS);
    expect(m.usingDefault).toBe(false);
    expect(m.map).toEqual([{ zone: 'KL', prefixStart: 50, prefixEnd: 60 }]);
  });
});

describe('rangeForPrefix', () => {
  it('lets the narrowest range win, ties to the earlier rule', () => {
    const map = [{ zone: 'PJ', prefixStart: 46, prefixEnd: 47 }, { zone: 'PUCHONG', prefixStart: 47, prefixEnd: 47 }];
    expect(rangeForPrefix(47, map)?.zone).toBe('PUCHONG');
    expect(rangeForPrefix(46, map)?.zone).toBe('PJ');
    expect(rangeForPrefix(10, map)).toBeNull();
    const tie = [{ zone: 'A', prefixStart: 1, prefixEnd: 2 }, { zone: 'B', prefixStart: 2, prefixEnd: 3 }];
    expect(rangeForPrefix(2, tie)?.zone).toBe('A');
  });
});

describe('postcode and text helpers', () => {
  it('reads a prefix only from a full five-digit postcode', () => {
    expect(postcodePrefix('43000')).toBe(43);
    expect(postcodePrefix('05100')).toBe(5);
    expect(postcodePrefix('4300')).toBeNull();
  });
  it('formats ranges and tile summaries', () => {
    expect(rangeText(5, 9)).toBe('05000 – 09999');
    const by = zoneByPrefix([...DEFAULTS, { zone: 'KL', prefixStart: 68, prefixEnd: 68 }, { zone: 'KL', prefixStart: 70, prefixEnd: 70 }]);
    expect(zoneSummary('PJ', by)).toBe('46–47');
    expect(zoneSummary('KL', by)).toBe('50–60, 68 +1');
    expect(zoneSummary('JOHOR', by)).toBe('No postcodes');
  });
  it('groups consecutive equal values into runs', () => {
    expect(runs(['a', 'a', null, 'a', 'b'], (v) => v !== null)).toEqual([
      { from: 0, to: 1, value: 'a' }, { from: 3, to: 3, value: 'a' }, { from: 4, to: 4, value: 'b' },
    ]);
  });
});

describe('parseRuleForm', () => {
  it('treats a blank "Prefix to" as the same prefix', () => {
    expect(parseRuleForm({ zone: 'kajang', from: '43', to: '', label: ' Semenyih ' }))
      .toEqual({ ok: true, value: { zone: 'KAJANG', prefixStart: 43, prefixEnd: 43, label: 'Semenyih' } });
  });
  it('refuses a bad or reversed range', () => {
    expect(parseRuleForm({ zone: 'KL', from: '100', to: '', label: '' })).toMatchObject({ ok: false, field: 'from' });
    expect(parseRuleForm({ zone: 'KL', from: '50', to: '40', label: '' })).toMatchObject({ ok: false, field: 'to' });
    expect(parseRuleForm({ zone: '', from: '50', to: '', label: '' })).toMatchObject({ ok: false, field: 'zone' });
  });
});

describe('coverageChanges', () => {
  it('shows a narrower rule carving postcodes out of a broad one', () => {
    const rules = [rule('pj', 'PJ', 46, 47), rule('kl', 'KL', 50, 60)];
    expect(coverageChanges(rules, DEFAULTS, { zone: 'PUCHONG', prefixStart: 47, prefixEnd: 47, isActive: true }, null))
      .toEqual([{ from: 47, to: 47, before: 'PJ', after: 'PUCHONG' }]);
  });
  it('warns that the first active rule switches the built-in map off', () => {
    const changes = coverageChanges([], DEFAULTS, { zone: 'KL', prefixStart: 50, prefixEnd: 60, isActive: true }, null);
    expect(changes).toEqual([
      { from: 43, to: 43, before: 'KAJANG', after: null },
      { from: 46, to: 47, before: 'PJ', after: null },
    ]);
  });
  it('leaves the edited rule out of the result', () => {
    const rules = [rule('pj', 'PJ', 46, 47), rule('kl', 'KL', 50, 60)];
    expect(coverageChanges(rules, DEFAULTS, { zone: 'PJ', prefixStart: 46, prefixEnd: 46, isActive: true }, 'pj'))
      .toEqual([{ from: 47, to: 47, before: 'PJ', after: null }]);
  });
});

describe('withRule and tiedPrefixes', () => {
  const rules = [rule('pj', 'PJ', 46, 47), rule('pu', 'PUCHONG', 47, 47)];
  it('keeps an edited rule in its place and appends a new one', () => {
    expect(withRule(rules, { zone: 'PUCHONG', prefixStart: 46, prefixEnd: 47, isActive: true }, 'pu').map((r) => r.id)).toEqual(['pj', 'pu']);
    expect(withRule(rules, { zone: 'KL', prefixStart: 50, prefixEnd: 60, isActive: true }, null).map((r) => r.id)).toEqual(['pj', 'pu', '__next__']);
  });
  it('flags prefixes another zone covers with a range of the same width', () => {
    expect(tiedPrefixes(rules, { zone: 'PUCHONG', prefixStart: 46, prefixEnd: 47 }, 'pu')).toEqual([46, 47]);
    expect(tiedPrefixes(rules, { zone: 'PUCHONG', prefixStart: 47, prefixEnd: 47 }, 'pu')).toEqual([]);
    expect(tiedPrefixes(rules, { zone: 'PJ', prefixStart: 46, prefixEnd: 47 }, null)).toEqual([]);
  });
});
