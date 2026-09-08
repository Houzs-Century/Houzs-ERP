// The customer / delivery card on a MIGRATED delivery order — address, phone,
// email, salesperson, delivery date — comes from the sales order's header, by
// the same rule the interactive /from-sos path applies. Until 2026-09-08 the
// migrated writer copied only the debtor NAME, so every AutoCount-mirrored DO
// opened with the whole card "—" (docs/bugs/0716).
//
// Three things are pinned, because each can regress on its own:
//   1. the script-side mapping agrees with the TypeScript one the API uses;
//   2. BOTH callers of insertMigratedDo hand it the SO header, and the writer
//      spreads the snapshot into the INSERT — a caller that stops passing it
//      would default to NULL with no error, which is how the gap opened;
//   3. sales_location is NOT in the snapshot: on a migrated DO it is the
//      ship-from branch from the account book (owner 2026-09-07), and copying
//      the SO's sales branch over it would overwrite a ruling with a guess.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DO_HEADER_SNAPSHOT_COLS, SO_HEADER_SNAPSHOT_COLS, soHeaderSelectList, soHeaderToDoSnapshot,
} from '../scripts/lib/migrated-do-header-snapshot.mjs';
import { soHeaderToDoSource, SO_CONVERT_HEADER } from '../src/scm/lib/so-to-do-fields';

const head = {
  doc_no: 'HC-SO-011302', debtor_name: 'Na E Chuen',
  address1: ' 12 Jalan Bunga ', address2: null, address3: 'Taman Sri', address4: 'Kajang',
  city: 'Kajang', customer_state: 'Selangor', customer_country: 'Malaysia', postcode: '43000',
  phone: '012-345 6789', email: 'na@example.com', salesperson_id: 'sp-1', agent: 'Farra',
  customer_type: 'Retail', building_type: 'Landed', branding: 'Houzs', venue: 'Showroom', venue_id: 'v-1',
  ref: 'PO-77', emergency_contact_name: 'Lim', emergency_contact_phone: '+60 11-6155 6133',
  emergency_contact_relationship: 'Sibling', customer_delivery_date: '2026-07-20',
};

describe('soHeaderToDoSnapshot', () => {
  it('derives every field exactly as the TypeScript mapping the API uses', () => {
    const ts = soHeaderToDoSource(head);
    const s = soHeaderToDoSnapshot(head, { doDate: '2026-07-14' });
    expect(s.address1).toBe(ts.address1);
    expect(s.address2).toBe(ts.address2);
    expect(s.address2).toBe('Taman Sri, Kajang');
    expect(s.city).toBe(ts.city);
    expect(s.state).toBe(ts.customerState);
    expect(s.customer_state).toBe(ts.customerState);
    expect(s.customer_country).toBe(ts.customerCountry);
    expect(s.postcode).toBe(ts.postcode);
    expect(s.email).toBe(ts.email);
    expect(s.salesperson_id).toBe(ts.salespersonId);
    expect(s.agent).toBe(ts.agent);
    expect(s.customer_type).toBe(ts.customerType);
    expect(s.building_type).toBe(ts.buildingType);
    expect(s.branding).toBe(ts.branding);
    expect(s.venue).toBe(ts.venue);
    expect(s.venue_id).toBe(ts.venueId);
    expect(s.ref).toBe(ts.customerSoRef);
    expect(s.emergency_contact_name).toBe(ts.emergencyContactName);
    expect(s.emergency_contact_relationship).toBe(ts.emergencyContactRelationship);
    expect(s.customer_delivery_date).toBe(ts.customerDeliveryDate);
    expect(s.expected_delivery_at).toBe('2026-07-20');
  });

  it('stores phones E.164, as the API does on write', () => {
    const s = soHeaderToDoSnapshot(head);
    expect(s.phone).toBe('+60123456789');
    expect(s.emergency_contact_phone).toBe('+601161556133');
  });

  it('expected_delivery_at falls back to the DO date when the SO names no delivery date', () => {
    const s = soHeaderToDoSnapshot({ ...head, customer_delivery_date: null }, { doDate: '2026-07-14' });
    expect(s.customer_delivery_date).toBeNull();
    expect(s.expected_delivery_at).toBe('2026-07-14');
  });

  it('a blank source stays NULL — never an empty string, never a default', () => {
    const s = soHeaderToDoSnapshot({ ...head, email: '   ', address1: null });
    expect(s.email).toBeNull();
    expect(s.address1).toBeNull();
    for (const c of DO_HEADER_SNAPSHOT_COLS) expect(soHeaderToDoSnapshot(null)[c]).toBeNull();
  });

  it('does NOT carry sales_location or warehouse_id — those are the ship-from branch from the book', () => {
    expect(DO_HEADER_SNAPSHOT_COLS).not.toContain('sales_location');
    expect(DO_HEADER_SNAPSHOT_COLS).not.toContain('warehouse_id');
    expect(SO_HEADER_SNAPSHOT_COLS).not.toContain('sales_location');
  });

  it('reads only columns the API already selects from the SO, plus the debtor name', () => {
    const api = new Set(SO_CONVERT_HEADER.split(',').map((s) => s.trim()));
    for (const c of SO_HEADER_SNAPSHOT_COLS) expect(api.has(c) || c === 'debtor_name').toBe(true);
    expect(soHeaderSelectList('h')).toContain('h.address1');
    expect(soHeaderSelectList('h', 'so')).toContain('h.address1 AS "so_address1"');
  });
});

describe('the writer and BOTH its callers carry the header', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const writer = src('../scripts/lib/migrated-do-writer.mjs');
  const cutover = src('../scripts/create-migrated-documents.mjs');
  const delta = src('../scripts/sync-ac-delta.mjs');
  const backfill = src('../scripts/backfill-migrated-do-header.mjs');

  it('insertMigratedDo accepts soHeader and spreads the snapshot into the INSERT', () => {
    expect(writer).toMatch(/insertMigratedDo\([^)]*soHeader/s);
    expect(writer).toContain('...soHeaderToDoSnapshot(soHeader, { doDate })');
  });

  it('create-migrated-documents.mjs passes the SO header it loads', () => {
    const call = cutover.slice(cutover.indexOf('insertMigratedDo(sql, d,'));
    expect(call.slice(0, 400)).toContain('soHeader:');
    expect(cutover).toContain('soHeaderSelectList(');
  });

  it('sync-ac-delta.mjs passes the SO header it loads', () => {
    const call = delta.slice(delta.indexOf('insertMigratedDo(sql, d,'));
    expect(call.slice(0, 400)).toContain('soHeader:');
    expect(delta).toContain('soHeaderSelectList(');
  });

  it('the backfill uses the SAME mapping module, never a private copy', () => {
    expect(backfill).toContain("from \"./lib/migrated-do-header-snapshot.mjs\"");
    expect(backfill).not.toMatch(/const FIELDS = \[/);
    expect(backfill).toContain('IS NULL THEN');
  });
});
