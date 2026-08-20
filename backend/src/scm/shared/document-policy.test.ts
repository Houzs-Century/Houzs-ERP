// The transaction-workflow header-lock rulebook (document-policy.ts) is the ONE
// place "which header columns freeze once a child exists" is defined, so every
// document reads the same truth. These tests pin the registry (a wrong error code
// or a dropped column would be a silent regression across all callers) and
// exercise the engine API (changedHeaderLockCols / headerLockRefusal).
import { describe, expect, it } from 'vitest';
import {
  TXN_HEADER_LOCK, changedHeaderLockCols, headerLockRefusal,
  PO_LOCK_COLS, GRN_LOCK_COLS, DO_LOCK_COLS, CN_LOCK_COLS, PCO_LOCK_COLS, PCR_LOCK_COLS,
} from './document-policy';

describe('TXN_HEADER_LOCK registry', () => {
  it('registers every transaction document with its exact error code', () => {
    expect(TXN_HEADER_LOCK.PO.error).toBe('po_identity_locked');
    expect(TXN_HEADER_LOCK.GRN.error).toBe('grn_header_inherited_locked');
    expect(TXN_HEADER_LOCK.DO.error).toBe('do_identity_locked');
    expect(TXN_HEADER_LOCK.CN.error).toBe('cn_identity_locked');
    expect(TXN_HEADER_LOCK.PCO.error).toBe('pco_identity_locked');
    expect(TXN_HEADER_LOCK.PC_RECEIVE.error).toBe('pc_receive_identity_locked');
  });

  it('freezes the money/party basis each child snapshots', () => {
    expect([...PO_LOCK_COLS].sort()).toEqual(['currency', 'purchase_location_id', 'supplier_id']);
    expect([...GRN_LOCK_COLS].sort()).toEqual(['allocation_method', 'currency', 'exchange_rate', 'supplier_id']);
    expect([...DO_LOCK_COLS].sort()).toEqual(['branding', 'currency', 'debtor_code', 'debtor_name', 'sales_location']);
    expect([...CN_LOCK_COLS]).toEqual([...DO_LOCK_COLS]); // CN mirrors DO
    expect([...PCO_LOCK_COLS]).toEqual([...PO_LOCK_COLS]); // PCO mirrors PO
    expect([...PCR_LOCK_COLS].sort()).toEqual(['currency', 'supplier_id']);
  });

  it('every policy labels every one of its lock columns', () => {
    for (const [doc, p] of Object.entries(TXN_HEADER_LOCK)) {
      for (const col of p.lockCols) {
        expect(p.labels[col], `${doc} missing a label for ${col}`).toBeTruthy();
      }
    }
  });
});

describe('engine API', () => {
  it('changedHeaderLockCols flags only inherited columns that actually change', () => {
    const before = { supplier_id: 's1', currency: 'MYR', purchase_location_id: 'l1', notes: 'x' };
    expect(changedHeaderLockCols('PO', { notes: 'y' }, before)).toEqual([]);
    expect(changedHeaderLockCols('PO', { supplier_id: 's2' }, before)).toEqual(['supplier_id']);
    // an unchanged blank re-send does not read as a change
    expect(changedHeaderLockCols('PO', { supplier_id: 's1' }, before)).toEqual([]);
  });

  it('headerLockRefusal builds the doc-specific 409 body', () => {
    const r = headerLockRefusal('GRN', ['supplier_id', 'currency']);
    expect(r.error).toBe('grn_header_inherited_locked');
    expect(r.message).toContain('supplier');
    expect(r.message).toContain('currency');
    expect(r.fields).toEqual(['supplier_id', 'currency']);
  });
});
