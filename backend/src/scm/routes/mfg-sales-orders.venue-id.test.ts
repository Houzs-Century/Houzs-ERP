import { describe, expect, it } from 'vitest';
import { venueIdUuidOrNull } from './mfg-sales-orders';

describe('venueIdUuidOrNull', () => {
  it('keeps a real uuid', () => {
    expect(venueIdUuidOrNull('5cafa0a2-f979-44da-9a76-5030158ebeb7'))
      .toBe('5cafa0a2-f979-44da-9a76-5030158ebeb7');
    expect(venueIdUuidOrNull('5CAFA0A2-F979-44DA-9A76-5030158EBEB7'))
      .toBe('5CAFA0A2-F979-44DA-9A76-5030158EBEB7');
  });

  it('rejects the showroom synthetic id, uuid-shaped tail and all', () => {
    expect(venueIdUuidOrNull('showroom:69f78399-d4bf-4d3a-92b9-582b598dcbef')).toBeNull();
  });

  it('rejects a project_venues integer id', () => {
    expect(venueIdUuidOrNull('42')).toBeNull();
    expect(venueIdUuidOrNull(42)).toBeNull();
  });

  it('rejects blanks and non-strings', () => {
    for (const v of ['', '   ', null, undefined, {}, []]) {
      expect(venueIdUuidOrNull(v)).toBeNull();
    }
  });
});
