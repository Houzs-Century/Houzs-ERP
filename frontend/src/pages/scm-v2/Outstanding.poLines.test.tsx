
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { PoOutstandingLineRow } from '../../vendor/scm/lib/po-outstanding-rollup';

const CFG = 'colour : HR805-90 / 28 inch per seat';
const FIXTURE: PoOutstandingLineRow[] = [
  { company_id: 1, company_code: 'HOUZS', po_number: 'HC-PO-010150', ac_po_no: 'PO-010150', so_doc_no: 'HC-SO-011160', creditor_code: '400-A004', creditor_name: 'ARMANI SOFA SDN. BHD.', item_code: '9058-1A(LHF)', item_desc: 'SOFA 1A(LHF)', item_desc2: CFG, location_code: 'KL', item_group: 'sofa', po_date: '2026-09-03', remaining_qty: 1, delivery_date: '2026-09-22', po_item_id: 'a1', is_outstanding: true },
  { company_id: 1, company_code: 'HOUZS', po_number: 'HC-PO-010150', ac_po_no: 'PO-010150', so_doc_no: 'HC-SO-011160', creditor_code: '400-A004', creditor_name: 'ARMANI SOFA SDN. BHD.', item_code: '9058-1NA', item_desc: 'SOFA 1NA', item_desc2: CFG, location_code: 'KL', item_group: 'sofa', po_date: '2026-09-03', remaining_qty: 1, delivery_date: '2026-09-22', po_item_id: 'a2', is_outstanding: true },
  { company_id: 1, company_code: 'HOUZS', po_number: 'HC-PO-010150', ac_po_no: 'PO-010150', so_doc_no: 'HC-SO-011160', creditor_code: '400-A004', creditor_name: 'ARMANI SOFA SDN. BHD.', item_code: '9058-L(RHF)', item_desc: 'SOFA L(RHF)', item_desc2: CFG, location_code: 'KL', item_group: 'sofa', po_date: '2026-09-03', remaining_qty: 1, delivery_date: '2026-09-22', po_item_id: 'a3', is_outstanding: true },
  { company_id: 2, company_code: '2990', po_number: '2990-PO-2609-001', ac_po_no: null, so_doc_no: null, creditor_code: '400-Z003', creditor_name: 'ZOE HOME SDN BHD', item_code: 'AERO-MP (K)', item_desc: 'MATTRESS PROTECTOR (KING)', item_desc2: '', location_code: 'KL', item_group: 'accessory', po_date: '2026-09-02', remaining_qty: 70, delivery_date: '2026-09-23', po_item_id: 'b1', is_outstanding: true },
];

vi.mock('../../vendor/scm/lib/outstanding-queries', () => ({
  useOutstanding: () => ({ data: { rows: [] }, isLoading: false }),
  useOutstandingSummary: () => ({ data: { summary: {} }, isLoading: false }),
  useOutstandingPoLines: () => ({ data: { rows: FIXTURE }, isLoading: false }),
}));

import { Outstanding } from './Outstanding';

const open = () => {
  render(<MemoryRouter><Outstanding /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /PO chasing/ }));
};

describe('Outstanding — PO chasing card', () => {
  test('the card shows the outstanding line count and opens the chasing view', () => {
    open();
    expect(screen.getByText('4 outstanding lines')).toBeTruthy();
    expect(screen.getByRole('button', { name: /PO chasing/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByText('PO chasing')).toHaveLength(2);
    expect(screen.getAllByText('ARMANI SOFA SDN. BHD.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ZOE HOME SDN BHD').length).toBeGreaterThan(0);
    expect(screen.getByText('9058-1A(LHF)')).toBeTruthy();
    expect(screen.getByText('9058-1NA')).toBeTruthy();
  });

  test('cross-company filter chips appear when both companies are present', () => {
    open();
    expect(screen.getByText('All companies')).toBeTruthy();
    expect(screen.getAllByText('HOUZS').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2990').length).toBeGreaterThan(0);
  });

  test('By set folds the three sofa components into one set row', () => {
    open();
    fireEvent.click(screen.getByText('By set'));
    expect(screen.queryByText('9058-1A(LHF)')).toBeNull();
    expect(screen.getByText('9058')).toBeTruthy();
    expect(screen.getByText('AERO-MP (K)')).toBeTruthy();
  });
});
