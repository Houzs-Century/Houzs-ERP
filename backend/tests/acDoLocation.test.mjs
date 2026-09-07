// The ONE rule that answers "which branch shipped this AutoCount delivery
// note", shared by create-migrated-documents.mjs (stamps it as a document is
// written) and backfill-migrated-do-warehouse.mjs (stamps the ones already
// written). Two scripts, one answer — a document stamped now and the same
// document stamped later must not land on different branches.
//
// Owner ruling 2026-09-07, "记在单头就好": the delivery location lives on the DO
// HEADER, never on a per-line column. What these tests pin is the part of that
// ruling that can go silently wrong — the ORDER of the sources, and the refusal
// to guess when the book cannot answer with one location.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { mixedLocationDocs, resolveAcDeliveryLocation } from '../scripts/lib/ac-do-location.mjs';

/* Company-1 shapes: scm.warehouses.code holds the ERP warehouse code that
   SALESLOC maps an AutoCount location onto ("KL" -> "KL WAREHOUSE"), which is
   what import-ac-outstanding-po.mjs's whId() already relies on. */
const warehouses = [
  { id: 'wh-kl', code: 'KL WAREHOUSE', name: 'Balakong' },
  { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'Penang' },
  { id: 'wh-hq', code: 'HQ', name: 'Head office' },
];
const hdr = (o) => new Map(Object.entries(o));
const lines = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

describe('resolveAcDeliveryLocation', () => {
  it('takes the book HEADER first, and maps it through the shared SALESLOC', () => {
    const r = resolveAcDeliveryLocation('DO-1', hdr({ 'DO-1': 'KL' }), lines({}), warehouses);
    expect(r).toMatchObject({ warehouseId: 'wh-kl', salesLocation: 'KL WAREHOUSE', bookLocation: 'KL', source: 'header', why: null });
  });

  it('prefers the header even when the lines say something else', () => {
    /* The 12 book lines that disagree with their own header, and the 2 mixed
       documents, resolve HERE — the header is the ruling's authority. */
    const r = resolveAcDeliveryLocation('DO-1', hdr({ 'DO-1': 'PG' }), lines({ 'DO-1': ['KL'] }), warehouses);
    expect(r.warehouseId).toBe('wh-pg');
    expect(r.source).toBe('header');
  });

  it('falls back to the document own lines when the header snapshot is behind', () => {
    // 19 of the cutover cut's 84 documents are this shape.
    const r = resolveAcDeliveryLocation('DO-2', hdr({}), lines({ 'DO-2': ['PG'] }), warehouses);
    expect(r).toMatchObject({ warehouseId: 'wh-pg', salesLocation: 'PG WAREHOUSE', source: 'lines' });
  });

  it('REFUSES when there is no header and the lines disagree — never picks one', () => {
    const r = resolveAcDeliveryLocation('DO-3', hdr({}), lines({ 'DO-3': ['KL', 'PG'] }), warehouses);
    expect(r.warehouseId).toBeNull();
    expect(r.salesLocation).toBeNull();
    expect(r.why).toMatch(/lines disagree \(KL \+ PG\)/);
  });

  it('REFUSES when the book carries no location at all', () => {
    const r = resolveAcDeliveryLocation('DO-4', hdr({}), lines({}), warehouses);
    expect(r.warehouseId).toBeNull();
    expect(r.why).toMatch(/carry no location/);
  });

  it('REFUSES a location that maps to no warehouse in this company, and NAMES it', () => {
    /* SUNWAY maps to "SUNWAY SHOWROOM"; a company without that row must get a
       NULL and a sentence, never the nearest warehouse or a default. */
    const r = resolveAcDeliveryLocation('DO-5', hdr({ 'DO-5': 'SUNWAY' }), lines({}), warehouses);
    expect(r.warehouseId).toBeNull();
    expect(r.why).toMatch(/"SUNWAY" maps to "SUNWAY SHOWROOM"/);
    expect(r.why).toMatch(/no single warehouse/);
    expect(r.bookLocation).toBe('SUNWAY');
  });

  it('passes an unmapped location through verbatim rather than inventing a code', () => {
    // Not in SALESLOC, but it IS a warehouse code here — resolve on its own name.
    const r = resolveAcDeliveryLocation('DO-6', hdr({ 'DO-6': 'HQ' }), lines({}), warehouses);
    expect(r).toMatchObject({ warehouseId: 'wh-hq', salesLocation: 'HQ' });
  });

  it('the stored TEXT is the same answer as the stored ID, always', () => {
    /* sales_location and warehouse_id are written together from this one
       result, so the two can never tell a reader different things. */
    const r = resolveAcDeliveryLocation('DO-7', hdr({ 'DO-7': 'kl ' }), lines({}), warehouses);
    const w = warehouses.find((x) => x.id === r.warehouseId);
    expect(w.code).toBe(r.salesLocation);
  });

  it('is not fooled by casing or padding in the book value', () => {
    const r = resolveAcDeliveryLocation('DO-8', hdr({ 'DO-8': '  pg  ' }), lines({}), warehouses);
    expect(r.warehouseId).toBe('wh-pg');
  });

  it('treats a blank header value as absent and moves to the lines', () => {
    const r = resolveAcDeliveryLocation('DO-9', hdr({ 'DO-9': '   ' }), lines({ 'DO-9': ['KL'] }), warehouses);
    expect(r.source).toBe('lines');
    expect(r.warehouseId).toBe('wh-kl');
  });
});

describe('mixedLocationDocs', () => {
  it('names only the documents that span more than one location', () => {
    const got = mixedLocationDocs(lines({ 'DO-A': ['KL'], 'DO-B': ['PG', 'HQ'], 'DO-C': [] }));
    expect(got).toHaveLength(1);
    expect(got[0].doc).toBe('DO-B');
    expect(got[0].locations.sort()).toEqual(['HQ', 'PG']);
  });

  it('returns an empty list rather than null when every document is unanimous', () => {
    expect(mixedLocationDocs(lines({ 'DO-A': ['KL'] }))).toEqual([]);
  });
});

/* ── BOTH CALLERS OF THE WRITER, not just the one that was fixed ────────────
 * #3121 gave `create-migrated-documents.mjs` a ship-from branch. The writer's
 * own header names TWO callers, and the other one — `sync-ac-delta.mjs`, which
 * creates every delivery note raised AFTER the cutover cut — went on passing
 * neither field, so those documents landed with a NULL branch. That is this
 * repo's most expensive recurring shape: one rule, two callers, one of them
 * updated.
 *
 * Source-level, because the lane's I/O is a production database and the RULE it
 * must reach is already covered by the tests above; what was missing was the
 * WIRING, and the wiring is exactly what a source assertion can hold. */
describe('the delta lane resolves the ship-from branch through the same rule', () => {
  const delta = readFileSync(new URL('../scripts/sync-ac-delta.mjs', import.meta.url), 'utf8');
  const writer = readFileSync(new URL('../scripts/lib/migrated-do-writer.mjs', import.meta.url), 'utf8');

  it('imports the shared resolver rather than restating the order', () => {
    expect(delta).toContain("from \"./lib/ac-do-location.mjs\"");
    expect(delta).toContain('resolveAcDeliveryLocation(');
  });

  it('passes BOTH location fields into insertMigratedDo', () => {
    const call = delta.slice(delta.indexOf('insertMigratedDo(sql, d,'));
    expect(call.slice(0, 400)).toContain('warehouseId:');
    expect(call.slice(0, 400)).toContain('salesLocation:');
  });

  /* The writer accepts them; a caller that stopped passing them would default to
     NULL with no error, which is how this gap opened in the first place. */
  it('the writer still accepts the two fields it is being handed', () => {
    expect(writer).toMatch(/insertMigratedDo\([^)]*warehouseId/s);
    expect(writer).toMatch(/insertMigratedDo\([^)]*salesLocation/s);
  });

  it('reads the line Location by NAME, so an older snapshot resolves to nothing', () => {
    expect(delta).toContain('LFD.indexOf("location")');
  });
});
