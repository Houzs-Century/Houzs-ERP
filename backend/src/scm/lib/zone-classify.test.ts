import { describe, it, expect } from 'vitest';
import {
  ZONES,
  DEFAULT_ZONE_PREFIX_MAP,
  KLANG_VALLEY_ZONES,
  THREEPL_ONLY_ZONES,
  isKlangValleyZone,
  isThreePlOnlyZone,
  parsePostcode,
  postcodePrefix,
  zoneForPostcode,
  zoneForAddress,
  type ZonePrefixRule,
} from './zone-classify';

const MAP = DEFAULT_ZONE_PREFIX_MAP;

describe('parsePostcode', () => {
  it('reads a bare 5-digit postcode', () => {
    expect(parsePostcode('43000')).toBe('43000');
  });
  it('extracts a postcode embedded in an address', () => {
    expect(parsePostcode('12, Jalan A, 43000 Kajang, Selangor')).toBe('43000');
  });
  it('returns null when there is no 5-digit run', () => {
    expect(parsePostcode('Kajang, Selangor')).toBeNull();
    expect(parsePostcode('')).toBeNull();
    expect(parsePostcode(null)).toBeNull();
  });
  it('does not treat a longer digit run (phone/id) as a postcode', () => {
    expect(parsePostcode('0123456789')).toBeNull();
  });
});

describe('postcodePrefix', () => {
  it('takes the first two digits', () => {
    expect(postcodePrefix('05100')).toBe(5);
    expect(postcodePrefix('43000')).toBe(43);
    expect(postcodePrefix('86000')).toBe(86);
  });
  it('is null for a non-postcode', () => {
    expect(postcodePrefix('abc')).toBeNull();
  });
});

describe('zoneForPostcode — default Malaysian map', () => {
  const cases: Array<[string, string]> = [
    ['10450', 'PENANG'],   // Georgetown
    ['14000', 'PENANG'],   // Bukit Mertajam (top of range)
    ['05000', 'KEDAH'],    // Alor Setar
    ['09000', 'KEDAH'],    // Kulim (top of range)
    ['30000', 'PERAK'],    // Ipoh
    ['36000', 'PERAK'],    // Teluk Intan (top of range)
    ['40000', 'PJ'],       // Shah Alam (Petaling district)
    ['41000', 'KLANG'],
    ['42000', 'KLANG'],
    ['43000', 'KAJANG'],
    ['46000', 'PJ'],       // Petaling Jaya
    ['47500', 'PJ'],       // Subang Jaya
    ['48000', 'RAWANG'],
    ['50000', 'KL'],
    ['60000', 'KL'],       // top of KL range
    ['68000', 'KL'],       // Ampang
    ['70000', 'NS'],       // Seremban
    ['73000', 'NS'],
    ['75000', 'MELAKA'],
    ['78000', 'MELAKA'],
    ['79000', 'JOHOR'],
    ['80000', 'JOHOR'],    // JB
    ['86000', 'JOHOR'],    // top of range
    ['15000', 'EAST'],     // Kota Bharu
    ['20000', 'EAST'],     // Kuala Terengganu
    ['24000', 'EAST'],
    ['25000', 'PAHANG'],   // Kuantan
    ['39000', 'PAHANG'],   // Cameron Highlands
    ['49000', 'PAHANG'],   // Genting
    ['69000', 'PAHANG'],
    // Owner 2026-11-11 (3PL areas aligned with Delivery Zones): the gaps the
    // carriers' cards price, and East Malaysia.
    ['01000', 'KEDAH'],    // Kangar, Perlis
    ['45000', 'KLANG'],    // Kuala Selangor
    ['64000', 'KAJANG'],   // KLIA
    ['87000', 'LABUAN'],
    ['88000', 'SABAH'],    // Kota Kinabalu
    ['90000', 'SABAH'],    // Sandakan
    ['93000', 'SARAWAK'],  // Kuching
    ['98000', 'SARAWAK'],  // Miri
  ];
  for (const [pc, zone] of cases) {
    it(`${pc} -> ${zone}`, () => {
      expect(zoneForPostcode(pc, MAP)).toBe(zone);
    });
  }

  it('returns null for an unmapped prefix (99xxx is no postcode)', () => {
    expect(zoneForPostcode('99000', MAP)).toBeNull();
  });
  it('returns null for garbage input', () => {
    expect(zoneForPostcode('not-a-postcode', MAP)).toBeNull();
    expect(zoneForPostcode(null, MAP)).toBeNull();
  });
});

describe('zoneForPostcode — most-specific rule wins', () => {
  // Owner carves PUCHONG (single prefix 47) out of the broad 46-47 PJ block.
  const custom: ZonePrefixRule[] = [
    ...MAP,
    { zone: 'PUCHONG', prefixStart: 47, prefixEnd: 47 },
  ];
  it('a narrower added rule overrides the broad default without deleting it', () => {
    expect(zoneForPostcode('47100', custom)).toBe('PUCHONG'); // width 0 beats width 1
    expect(zoneForPostcode('46000', custom)).toBe('PJ');      // still PJ
  });
});

describe('zoneForAddress', () => {
  it('prefers the explicit postcode field', () => {
    const r = zoneForAddress({ postcode: '43000', address1: 'nonsense 50000' }, MAP);
    expect(r).toEqual({ zone: 'KAJANG', method: 'postcode', postcode: '43000' });
  });
  it('falls back to a postcode inside an address line', () => {
    const r = zoneForAddress({ postcode: null, address2: 'Taman X, 10450 Penang' }, MAP);
    expect(r.zone).toBe('PENANG');
    expect(r.method).toBe('postcode');
  });
  it('reports none when there is no postcode anywhere', () => {
    const r = zoneForAddress({ postcode: null, address1: 'Jalan Besar', address2: 'Melaka' }, MAP);
    expect(r).toEqual({ zone: null, method: 'none', postcode: null });
  });
  it('reports a postcode that maps to no zone (method postcode, zone null)', () => {
    const r = zoneForAddress({ postcode: '99000' }, MAP);
    expect(r).toEqual({ zone: null, method: 'postcode', postcode: '99000' });
  });
});

describe('zone metadata', () => {
  it('has the 14 planning zones and the 3 East Malaysia zones', () => {
    expect(ZONES).toHaveLength(17);
  });
  it('East Malaysia is priced on 3PL rate cards, never planned on own lorries', () => {
    expect([...THREEPL_ONLY_ZONES].sort()).toEqual(['LABUAN', 'SABAH', 'SARAWAK']);
    expect(isThreePlOnlyZone('SARAWAK')).toBe(true);
    expect(isThreePlOnlyZone('JOHOR')).toBe(false);
    expect(isThreePlOnlyZone(null)).toBe(false);
  });
  it('classifies Klang Valley membership', () => {
    expect(KLANG_VALLEY_ZONES).toHaveLength(6);
    expect(isKlangValleyZone('KL')).toBe(true);
    expect(isKlangValleyZone('PENANG')).toBe(false);
    expect(isKlangValleyZone(null)).toBe(false);
  });
});
