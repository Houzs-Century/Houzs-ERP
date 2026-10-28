import { describe, expect, it } from 'vitest';
import { venueIdUuidOrNull } from './mfg-sales-orders';

/* Regression: 2026-08-10, prod. mfg_sales_orders.venue_id is a uuid column, but
   the Venue picker is fed from two masters whose ids are NOT uuids — and on
   2026-08-10 the SO-detail venue-seeding effect started adopting the matching
   picker option into form.venueId. Every Save on a showroom-venue SO then
   posted `showroom:<warehouse-uuid>` into the uuid column, aborting the
   statement with "invalid input syntax for type uuid" — surfaced to the floor
   as "Save failed. The system hit a problem." with no clue what to fix. Two
   2990 orders were unsavable for ~40 minutes across 22 attempts.

   The create path had this guard since #154; the header PATCH did not. These
   cases pin the shared helper both now use. */
describe('venueIdUuidOrNull', () => {
  it('keeps a real uuid', () => {
    expect(venueIdUuidOrNull('5cafa0a2-f979-44da-9a76-5030158ebeb7'))
      .toBe('5cafa0a2-f979-44da-9a76-5030158ebeb7');
    // Case is not normalised away — the column accepts either.
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
