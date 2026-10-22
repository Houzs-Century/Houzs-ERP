/* The four consignment list drawers added alongside the CO / CN ones. Rendered
   with a fake row and a stubbed detail query, because production holds no
   returns or purchase-consignment documents to click on. Each case checks the
   header, the party, one line and the footer action so a renamed field or a
   wrong hook shows up here rather than on a blank drawer. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoHeaderRow } from '../../vendor/scm/lib/suppliers-queries';

const detail = (items: unknown[]) => ({ data: { items }, isLoading: false, isError: false, error: null });

vi.mock('../../vendor/scm/lib/consignment-return-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/consignment-return-queries')>()),
  useConsignmentReturnDetail: () => detail([
    { id: 'l1', item_code: 'MAT-001', item_group: 'MATTRESS', description: 'Queen mattress', variants: null,
      qty_returned: 2, condition: 'GOOD', line_total_sen: 150000 },
  ]),
}));
vi.mock('../../vendor/scm/lib/purchase-consignment-order-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/purchase-consignment-order-queries')>()),
  usePurchaseConsignmentOrderDetail: () => detail([
    { id: 'p1', item_code: 'BF-010', material_name: 'Bed frame', item_group: 'BEDFRAME', qty: 3, line_total_sen: 90000 },
  ]),
}));
vi.mock('../../vendor/scm/lib/purchase-consignment-receive-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/purchase-consignment-receive-queries')>()),
  usePurchaseConsignmentReceiveDetail: () => detail([
    { id: 'g1', item_code: 'SF-020', description: 'Sofa 3 seater', qty_received: 1, line_total_sen: 250000 },
  ]),
}));
vi.mock('../../vendor/scm/lib/purchase-consignment-return-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/purchase-consignment-return-queries')>()),
  usePurchaseConsignmentReturnDetail: () => detail([
    { id: 'r1', item_code: 'ACC-100', description: 'Pillow', qty_returned: 4, line_refund_sen: 8000 },
  ]),
}));

import { ConsignmentReturnDrawer } from './ConsignmentReturns';
import { PurchaseConsignmentOrderDrawer } from './PurchaseConsignmentOrders';
import { PurchaseConsignmentReceiveDrawer } from './PurchaseConsignmentReceives';
import { PurchaseConsignmentReturnDrawer } from './PurchaseConsignmentReturns';

afterEach(cleanup);
const noop = () => undefined;

describe('consignment list quick-view drawers', () => {
  it('Consignment Return: header, customer, returned line, cancel action', () => {
    render(
      <ConsignmentReturnDrawer
        row={{
          id: 'cr1', return_number: 'HC-CR-2610-001', do_doc_no: 'HC-CN-2610-001', return_date: '2026-10-06',
          debtor_code: 'C001', debtor_name: 'NORHAWANI HASHIM', salesperson_id: null, sales_location: 'KL',
          ref: null, customer_so_no: 'HC12457', branding: null, venue: null, phone: '0193641577', email: null,
          customer_type: null, building_type: null, address1: '20 JLN 7/6', address2: null, customer_state: 'Selangor',
          customer_country: null, city: 'Bandar Baru Bangi', postcode: '43650', reason: 'Damaged',
          local_total_sen: 150000, status: 'RECEIVED', currency: 'MYR', note: null,
        }}
        canFinance={false}
        salespersonName="HOUZS CENTURY"
        onClose={noop} onOpenFull={noop} onEdit={noop} onCancel={noop} onReopen={noop}
      />,
    );
    expect(screen.getByText('HC-CR-2610-001')).toBeTruthy();
    expect(screen.getByText('HC-CN-2610-001')).toBeTruthy();
    expect(screen.getAllByText('NORHAWANI HASHIM').length).toBeGreaterThan(0);
    expect(screen.getByText('MAT-001')).toBeTruthy();
    expect(screen.getByText('Received')).toBeTruthy();
    expect(screen.getByText('Cancel Return')).toBeTruthy();
    expect(screen.queryByText('Reopen')).toBeNull();
  });

  it('Purchase Consignment Order: header, supplier, line, Receive Goods for an open order', () => {
    render(
      <PurchaseConsignmentOrderDrawer
        row={{
          id: 'po1', po_number: 'HC-PCO-001', supplier_id: 's1', status: 'SUBMITTED', po_date: '2026-10-01',
          expected_at: '2026-10-15', currency: 'MYR', subtotal_sen: 90000, tax_sen: 0, total_sen: 90000,
          notes: null, submitted_at: null, received_at: null, cancelled_at: null, purchase_location_id: null,
          created_at: '', created_by: '', updated_at: '',
          supplier: { id: 's1', code: 'SUP01', name: 'ACME BEDDING' },
        } as PoHeaderRow}
        onClose={noop} onOpenFull={noop} onEdit={noop} onReceive={noop} onCancel={noop}
      />,
    );
    expect(screen.getByText('HC-PCO-001')).toBeTruthy();
    expect(screen.getAllByText('ACME BEDDING').length).toBeGreaterThan(0);
    expect(screen.getByText('BF-010')).toBeTruthy();
    expect(screen.getByText('Receive Goods')).toBeTruthy();
  });

  it('Purchase Consignment Receive: header, source order, line, Create Return when posted', () => {
    render(
      <PurchaseConsignmentReceiveDrawer
        row={{
          id: 'g1', receive_number: 'HC-PCR-001', status: 'POSTED', received_at: '2026-10-05',
          delivery_note_ref: 'DN-77', total_sen: 250000, currency: 'MYR',
          supplier: { id: 's1', code: 'SUP01', name: 'ACME BEDDING' },
          purchase_consignment_order: { id: 'po1', pc_number: 'HC-PCO-001' },
        }}
        onClose={noop} onOpenFull={noop} onEdit={noop} onCreateReturn={noop} onCancel={noop}
      />,
    );
    expect(screen.getByText('HC-PCR-001')).toBeTruthy();
    expect(screen.getByText('HC-PCO-001')).toBeTruthy();
    expect(screen.getByText('SF-020')).toBeTruthy();
    expect(screen.getByText('Create Return')).toBeTruthy();
  });

  it('Purchase Consignment Return: header, source receive, line, no cancel once completed', () => {
    render(
      <PurchaseConsignmentReturnDrawer
        row={{
          id: 'r1', return_number: 'HC-PCT-001', status: 'COMPLETED', return_date: '2026-10-06', refund_sen: 8000,
          supplier: { id: 's1', code: 'SUP01', name: 'ACME BEDDING' },
          pc_receive: { id: 'g1', receive_number: 'HC-PCR-001' },
        }}
        onClose={noop} onOpenFull={noop} onEdit={noop} onCancel={noop}
      />,
    );
    expect(screen.getByText('HC-PCT-001')).toBeTruthy();
    expect(screen.getByText('HC-PCR-001')).toBeTruthy();
    expect(screen.getByText('ACC-100')).toBeTruthy();
    expect(screen.getByText('Edit')).toBeTruthy();
    expect(screen.queryByText('Cancel Return')).toBeNull();
  });
});
