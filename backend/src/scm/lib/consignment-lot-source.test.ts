import { describe, it, expect } from 'vitest';
import { isConsignmentLotSource } from './inventory-movements';

/* Consignment stock must be identified by the lot's SOURCE (it was fed by a
   Purchase Consignment Receive), NOT by the warehouse's is_consignment flag — a
   PCR can be mis-posted into a normal warehouse, so the flag leaks consignment
   into owned VALUE (BUG-HISTORY 2026-07-25, HIGH). */
describe('isConsignmentLotSource', () => {
  it('flags the first PC receive lot by source_doc_type PC_RECEIVE', () => {
    expect(isConsignmentLotSource('PC_RECEIVE', '2990-PCR-2606-001')).toBe(true);
  });

  it('flags PC_RETURN and the sales-side PURCHASE_CONSIGNMENT_NOTE', () => {
    expect(isConsignmentLotSource('PC_RETURN', '2990-PCR-2606-001')).toBe(true);
    expect(isConsignmentLotSource('PURCHASE_CONSIGNMENT_NOTE', null)).toBe(true);
  });

  it('flags a PC-receive DELTA top-up written as STOCK_TRANSFER — it keeps the PCR number', () => {
    // resyncReceiveInventory books later increases as STOCK_TRANSFER IN but with
    // source_doc_no = the receive number; the type check alone would miss these.
    expect(isConsignmentLotSource('STOCK_TRANSFER', '2990-PCR-2606-002')).toBe(true);
  });

  it('flags a bare (HOUZS base) PCR number with no company prefix', () => {
    expect(isConsignmentLotSource('STOCK_TRANSFER', 'PCR-2606-001')).toBe(true);
  });

  it('does NOT flag a normal GRN lot', () => {
    expect(isConsignmentLotSource('GRN', '2990-GRN-2607-023')).toBe(false);
  });

  it('does NOT flag a genuine inter-warehouse STOCK_TRANSFER (non-PCR number)', () => {
    expect(isConsignmentLotSource('STOCK_TRANSFER', '2990-ST-2607-004')).toBe(false);
  });

  it('does NOT match the PCR token inside a sibling consignment doc type', () => {
    // PCO = Purchase Consignment Order, PCT = Purchase Consignment Return — a
    // boundary-anchored PCR- must not fire on either (cf. BUG-HISTORY R7).
    expect(isConsignmentLotSource('STOCK_TRANSFER', '2990-PCO-2606-001')).toBe(false);
    expect(isConsignmentLotSource('STOCK_TRANSFER', '2990-PCT-2606-001')).toBe(false);
  });

  it('is null-safe on missing source fields', () => {
    expect(isConsignmentLotSource(null, null)).toBe(false);
    expect(isConsignmentLotSource(undefined, undefined)).toBe(false);
  });
});

/* The drawer's fix, in miniature: owned VALUE excludes consignment lots even when
   they sit in a NORMAL warehouse. Reproduces the owner's BOOQIT-CNR case — 3
   units, 2 from PC receives + 1 from a GRN — proving the 2 consignment units drop
   out of owned value while their quantity is still surfaced separately. */
describe('owned-value aggregation excludes consignment lots (drawer rule)', () => {
  type Lot = { qty_remaining: number; unit_cost_sen: number; source_doc_type: string; source_doc_no: string };
  const lots: Lot[] = [
    { qty_remaining: 1, unit_cost_sen: 100_000, source_doc_type: 'PC_RECEIVE',    source_doc_no: '2990-PCR-2606-001' },
    { qty_remaining: 1, unit_cost_sen:  56_419, source_doc_type: 'STOCK_TRANSFER', source_doc_no: '2990-PCR-2606-002' },
    { qty_remaining: 1, unit_cost_sen: 100_000, source_doc_type: 'GRN',           source_doc_no: '2990-GRN-2607-023' },
  ];

  const ownedLots = lots.filter((l) => !isConsignmentLotSource(l.source_doc_type, l.source_doc_no));
  const consignmentLots = lots.filter((l) => isConsignmentLotSource(l.source_doc_type, l.source_doc_no));

  it('counts only the GRN lot in owned value', () => {
    const ownedValue = ownedLots.reduce((s, l) => s + l.qty_remaining * l.unit_cost_sen, 0);
    expect(ownedLots).toHaveLength(1);
    expect(ownedValue).toBe(100_000); // NOT 256_419 — the two PCR lots are excluded
  });

  it('still surfaces the consignment quantity separately', () => {
    const consignmentQty = consignmentLots.reduce((s, l) => s + l.qty_remaining, 0);
    expect(consignmentLots).toHaveLength(2);
    expect(consignmentQty).toBe(2);
  });

  it('total quantity still reflects all 3 physical units', () => {
    const totalQty = lots.reduce((s, l) => s + l.qty_remaining, 0);
    expect(totalQty).toBe(3);
  });
});
