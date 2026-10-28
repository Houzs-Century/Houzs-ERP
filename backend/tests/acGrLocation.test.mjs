// The ONE rule that answers "where did AutoCount receive these goods", shared by
// create-migrated-documents.mjs and reshape-migrated-grns.mjs. Two writers, one
// answer — a receipt written by the old path and the same receipt rebuilt by the
// reshape must not land in different warehouses.
//
// What these tests pin is the part that can go silently wrong: the refusal to
// answer when the book cannot answer with ONE location, and the fact that a miss
// carries a `why` rather than a default. `scm.grn_items` has no warehouse column,
// so a receipt header holds exactly one location and a collapse onto the first
// value would be invisible.
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

/** book.byCell shape: `GRNO|ITEMCODE` -> Set of AutoCount locations. */
const book = (o) => ({ byCell: new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)])) });

describe('resolveAcReceiptLocation', () => {
  it('copies the book location and maps it through the shared SALESLOC', () => {
    const r = resolveAcReceiptLocation(['GR-1'], ['NB-KHJ38(Q)'], book({ 'GR-1|NB-KHJ38(Q)': ['KL'] }), warehouses);
    expect(r).toMatchObject({ warehouseId: 'wh-kl', warehouseCode: 'KL WAREHOUSE', bookLocation: 'KL', why: null });
  });

  it('maps a two-word location too — the display branches are real warehouses', () => {
    const r = resolveAcReceiptLocation(['GR-1'], ['X'], book({ 'GR-1|X': ['PG DISP'] }), warehouses);
    expect(r.warehouseId).toBe('wh-pgd');
    expect(r.warehouseCode).toBe('PG DISPLAY');
  });

  it('agrees across the lines of one receipt', () => {
    const r = resolveAcReceiptLocation(['GR-1'], ['A', 'B'], book({ 'GR-1|A': ['PG'], 'GR-1|B': ['PG'] }), warehouses);
    expect(r.warehouseId).toBe('wh-pg');
  });

  it('REFUSES when the receipt used two locations, and names both', () => {
    /* A receipt header holds one warehouse. Taking the first would be a guess
       that reads as a copy — the whole failure this module exists to stop. */
    const r = resolveAcReceiptLocation(['GR-1'], ['A', 'B'], book({ 'GR-1|A': ['PG'], 'GR-1|B': ['KL'] }), warehouses);
    expect(r.warehouseId).toBeNull();
    expect(r.why).toMatch(/more than one location/);
    expect(r.why).toMatch(/PG/);
    expect(r.why).toMatch(/KL/);
  });

  it('REFUSES when the book was never asked, and says so', () => {
    /* Not "the book agrees". The GR export only started selecting
       GRDTL.Location on 2026-09-08, so an older cut is silent for most rows. */
    const r = resolveAcReceiptLocation(['GR-9'], ['A'], book({ 'GR-1|A': ['KL'] }), warehouses);
    expect(r.warehouseId).toBeNull();
    expect(r.bookLocation).toBeNull();
    expect(r.why).toMatch(/carry no receipt location/);
  });

  it('REFUSES a location with no warehouse in this company, keeping what the book said', () => {
    const r = resolveAcReceiptLocation(['GR-1'], ['A'], book({ 'GR-1|A': ['SRW'] }), warehouses);
    expect(r.warehouseId).toBeNull();
    expect(r.bookLocation).toBe('SRW');
    expect(r.why).toMatch(/SRW WAREHOUSE/);
  });

  it('normalises case and spacing on both sides of the key', () => {
    const r = resolveAcReceiptLocation([' gr-1 '], [' nb-khj38(q) '], book({ 'GR-1|NB-KHJ38(Q)': ['kl'] }), warehouses);
    expect(r.warehouseId).toBe('wh-kl');
  });

  it('reads a receipt covered by more than one AutoCount receipt number', () => {
    const r = resolveAcReceiptLocation(['GR-1', 'GR-2'], ['A'], book({ 'GR-1|A': ['PG'], 'GR-2|A': ['PG'] }), warehouses);
    expect(r.warehouseId).toBe('wh-pg');
  });

  it('REFUSES when two AutoCount receipts of the same document disagree', () => {
    const r = resolveAcReceiptLocation(['GR-1', 'GR-2'], ['A'], book({ 'GR-1|A': ['PG'], 'GR-2|A': ['KL'] }), warehouses);
    expect(r.warehouseId).toBeNull();
    expect(r.why).toMatch(/more than one location/);
  });

  it('an empty receipt list and an empty item list are both a refusal, not a default', () => {
    expect(resolveAcReceiptLocation([], ['A'], book({ 'GR-1|A': ['KL'] }), warehouses).warehouseId).toBeNull();
    expect(resolveAcReceiptLocation(['GR-1'], [], book({ 'GR-1|A': ['KL'] }), warehouses).warehouseId).toBeNull();
  });
});
