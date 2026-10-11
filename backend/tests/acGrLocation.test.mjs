// The ONE rule that answers "where did AutoCount receive these goods", shared by
// create-migrated-documents.mjs and reshape-migrated-grns.mjs. Two writers, one
// answer — a receipt written by the old path and the same receipt rebuilt by the
// reshape must not land in different warehouses.
//
// What these tests pin is the part that can go silently wrong:
//
//  1. the RECEIPT leads and the item join is only the refinement. Keying on
//     (receipt, item) alone answered for 0 of 320 migrated receipts in
//     production (run 34150043151) because the book holds AutoCount's ItemCode
//     and the ERP holds the ERP one — they differ on 1,407 of the 1,577 bound
//     codes. A key that cannot match reports a clean miss.
//  2. the refusal when the book cannot answer with ONE location.
//     `scm.grn_items` has no warehouse column, so a receipt header holds exactly
//     one location and a collapse onto the first value would be invisible.
import { describe, expect, it } from 'vitest';

import { resolveAcReceiptLocation } from '../scripts/lib/ac-gr-location.mjs';

/* Company-1 shapes: scm.warehouses.code holds the ERP warehouse code that
   SALESLOC maps an AutoCount location onto ("KL" -> "KL WAREHOUSE"), which is
   what import-ac-outstanding-po.mjs's whId() already relies on. */
const warehouses = [
  { id: 'wh-kl', code: 'KL WAREHOUSE', name: 'Balakong' },
  { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'Penang' },
  { id: 'wh-pgd', code: 'PG DISPLAY', name: 'Penang showroom' },
  { id: 'wh-hq', code: 'HQ', name: 'Head office' },
];

/** Builds both indexes the resolver reads, from `GRNO|ITEMCODE` -> locations. */
const book = (o) => {
  const byCell = new Map();
  const byDoc = new Map();
  for (const [k, v] of Object.entries(o)) {
    byCell.set(k, new Set(v));
    const doc = k.split('|')[0];
    if (!byDoc.has(doc)) byDoc.set(doc, new Set());
    for (const l of v) byDoc.get(doc).add(l);
  }
  return { byCell, byDoc };
};

/* The real one is inverted from autocount-erp-mapping-1561.csv. */
const alias = new Map([['DIVAN ONLY-(K)', new Set(['AERO-DIVAN ONLY (K)'])]]);
const NOALIAS = new Map();

describe('resolveAcReceiptLocation', () => {
  it('copies the receipt location and maps it through the shared SALESLOC', () => {
    const r = resolveAcReceiptLocation(['GR-1'], ['NB-KHJ38(Q)'], book({ 'GR-1|NB-KHJ38(Q)': ['KL'] }), warehouses, NOALIAS);
    expect(r).toMatchObject({ warehouseId: 'wh-kl', warehouseCode: 'KL WAREHOUSE', bookLocation: 'KL', source: 'receipt', why: null });
  });

  it('answers WITHOUT the item code matching — the receipt is the key', () => {
    /* This is the production failure of run 34150043151, pinned. The ERP passes
       its own code; the book holds AutoCount's. A unanimous receipt needs no
       join at all, and demanding one answered for 0 of 320. */
    const r = resolveAcReceiptLocation(['GR-1'], ['DIVAN ONLY-(K)'], book({ 'GR-1|AERO-DIVAN ONLY (K)': ['PG'] }), warehouses, NOALIAS);
    expect(r.warehouseId).toBe('wh-pg');
    expect(r.source).toBe('receipt');
  });

  it('maps a two-word location too — the display branches are real warehouses', () => {
    const r = resolveAcReceiptLocation(['GR-1'], ['X'], book({ 'GR-1|X': ['PG DISP'] }), warehouses, NOALIAS);
    expect(r.warehouseId).toBe('wh-pgd');
    expect(r.warehouseCode).toBe('PG DISPLAY');
  });

  it('narrows by item code ONLY when the receipt spans locations, and uses the ERP alias', () => {
    const b = book({ 'GR-1|AERO-DIVAN ONLY (K)': ['PG'], 'GR-1|NB-OTHER': ['KL'] });
    const r = resolveAcReceiptLocation(['GR-1'], ['DIVAN ONLY-(K)'], b, warehouses, alias);
    expect(r.warehouseId).toBe('wh-pg');
    expect(r.source).toBe('lines');
  });

  it('REFUSES a spanning receipt when the narrowing cannot match, and names both locations', () => {
    /* Without the alias the ERP code matches nothing, and the honest answer is
       a refusal — never the first of the two locations. */
    const b = book({ 'GR-1|AERO-DIVAN ONLY (K)': ['PG'], 'GR-1|NB-OTHER': ['KL'] });
    const r = resolveAcReceiptLocation(['GR-1'], ['DIVAN ONLY-(K)'], b, warehouses, NOALIAS);
    expect(r.warehouseId).toBeNull();
    expect(r.why).toMatch(/more than one location/);
    expect(r.why).toMatch(/PG/);
    expect(r.why).toMatch(/KL/);
    expect(r.why).toMatch(/matched none of them/);
  });

  it('REFUSES a spanning receipt whose own lines still span after narrowing', () => {
    const b = book({ 'GR-1|A': ['PG'], 'GR-1|B': ['KL'] });
    const r = resolveAcReceiptLocation(['GR-1'], ['A', 'B'], b, warehouses, NOALIAS);
    expect(r.warehouseId).toBeNull();
    expect(r.why).toMatch(/still leaves/);
  });

  it('REFUSES when the book was never asked, and says so', () => {
    /* Not "the book agrees". The GR export only started selecting
       GRDTL.Location on 2026-09-08, so an older cut is silent for most rows. */
    const r = resolveAcReceiptLocation(['GR-9'], ['A'], book({ 'GR-1|A': ['KL'] }), warehouses, NOALIAS);
    expect(r.warehouseId).toBeNull();
    expect(r.bookLocation).toBeNull();
    expect(r.why).toMatch(/carry no receipt location/);
  });

  it('REFUSES a location with no warehouse in this company, keeping what the book said', () => {
    const r = resolveAcReceiptLocation(['GR-1'], ['A'], book({ 'GR-1|A': ['SRW'] }), warehouses, NOALIAS);
    expect(r.warehouseId).toBeNull();
    expect(r.bookLocation).toBe('SRW');
    expect(r.why).toMatch(/SRW WAREHOUSE/);
  });

  it('normalises case and spacing on the receipt number', () => {
    const r = resolveAcReceiptLocation([' gr-1 '], ['A'], book({ 'GR-1|A': ['kl'] }), warehouses, NOALIAS);
    expect(r.warehouseId).toBe('wh-kl');
  });

  it('reads a document covered by more than one AutoCount receipt', () => {
    const r = resolveAcReceiptLocation(['GR-1', 'GR-2'], ['A'], book({ 'GR-1|A': ['PG'], 'GR-2|A': ['PG'] }), warehouses, NOALIAS);
    expect(r.warehouseId).toBe('wh-pg');
  });

  it('REFUSES when two AutoCount receipts of the same document disagree', () => {
    const r = resolveAcReceiptLocation(['GR-1', 'GR-2'], ['A'], book({ 'GR-1|A': ['PG'], 'GR-2|A': ['KL'] }), warehouses, NOALIAS);
    expect(r.warehouseId).toBeNull();
    expect(r.why).toMatch(/more than one location/);
  });

  it('an empty receipt list is a refusal, not a default', () => {
    expect(resolveAcReceiptLocation([], ['A'], book({ 'GR-1|A': ['KL'] }), warehouses, NOALIAS).warehouseId).toBeNull();
  });

  it('THROWS when the alias map is omitted — it decides whether narrowing can match', () => {
    /* The repo's optional-param-noop bug class: an argument that decides
       something must not be silently defaultable. */
    expect(() => resolveAcReceiptLocation(['GR-1'], ['A'], book({ 'GR-1|A': ['KL'] }), warehouses))
      .toThrow(/erpToAcCodes is required/);
  });
});
