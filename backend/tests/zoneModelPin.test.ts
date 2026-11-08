// The Delivery Zones page (frontend .../delivery-zones/zoneModel.ts) mirrors the
// classifier so it can preview a rule before it is saved. This pins the two:
// same zones, same Klang Valley, and the same zone for every postcode prefix.
import { describe, expect, it } from 'vitest';
import {
  ZONES, KLANG_VALLEY_ZONES, DEFAULT_ZONE_PREFIX_MAP, zoneForPostcode,
} from '../src/scm/lib/zone-classify';
import {
  ZONE_NAME, KLANG_VALLEY, zoneByPrefix, zoneColour,
} from '../../frontend/src/pages/scm-v2/delivery-zones/zoneModel';

describe('Delivery Zones page model matches the classifier', () => {
  it('names and colours every zone, and nothing else', () => {
    expect(Object.keys(ZONE_NAME).sort()).toEqual([...ZONES].sort());
    for (const z of ZONES) expect(zoneColour(z)).not.toEqual(zoneColour('NOT_A_ZONE'));
  });
  it('has the same Klang Valley', () => {
    expect([...KLANG_VALLEY].sort()).toEqual([...KLANG_VALLEY_ZONES].sort());
  });
  it('resolves every prefix the same way, overlaps included', () => {
    const maps = [
      [...DEFAULT_ZONE_PREFIX_MAP],
      [...DEFAULT_ZONE_PREFIX_MAP, { zone: 'PUCHONG', prefixStart: 47, prefixEnd: 47 }, { zone: 'KL', prefixStart: 0, prefixEnd: 99 }],
    ];
    for (const map of maps) {
      const page = zoneByPrefix(map);
      for (let p = 0; p < 100; p += 1) {
        expect(page[p]).toBe(zoneForPostcode(`${String(p).padStart(2, '0')}100`, map));
      }
    }
  });
});
