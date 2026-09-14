/* The Delivery Order header edit, as data — shared by the desktop edit form and
 * the phone's edit sheet. See do-header-form.ts. */
import { describe, expect, it } from 'vitest';
import { buildDoHeaderBody, seedDoHeaderForm } from './do-header-form';

const DOO = {
  debtor_name: 'Alice', debtor_code: 'C-1', customer_so_no: null, po_doc_no: 'PO-9', ref: 'R',
  phone: '+60123456789', email: 'a@x.test', customer_type: 'Retail', salesperson_id: 'sp-1',
  address1: '1 Jalan', address2: '', customer_state: 'Selangor', city: 'Petaling Jaya', postcode: '46000',
  sales_location: 'PJ', emergency_contact_name: 'Ben', emergency_contact_relationship: 'Spouse',
  emergency_contact_phone: '+60111111111', do_date: '2026-09-01T00:00:00+00:00', driver_name: 'Ali',
  vehicle: 'WXX 1', building_type: 'Landed', venue: 'Home', branding: 'Houzs',
  expected_delivery_at: '2026-09-03', customer_delivery_date: '2026-09-02', note: null, notes: 'n',
};
const STAFF = [{ id: 'sp-1', name: 'Sam' }, { id: 'sp-2', name: 'Tina' }];

describe('seedDoHeaderForm', () => {
  it('maps the detail row to the form, dates as calendar days, note falling back to notes', () => {
    const f = seedDoHeaderForm(DOO, '2026-09-14');
    expect(f.customerName).toBe('Alice');
    expect(f.customerSoRef).toBe('PO-9');
    expect(f.state).toBe('Selangor');
    expect(f.doDate).toBe('2026-09-01');
    expect(f.note).toBe('n');
    expect(seedDoHeaderForm({}, '2026-09-14').doDate).toBe('2026-09-14');
  });
});

describe('buildDoHeaderBody', () => {
  it('an open DO sends every header field, with agent derived from the salesperson', () => {
    const f = { ...seedDoHeaderForm(DOO, '2026-09-14'), salespersonId: 'sp-2' };
    const b = buildDoHeaderBody(f, STAFF, { locked: false });
    expect(b).toMatchObject({
      debtorName: 'Alice', phone: '+60123456789', address1: '1 Jalan', customerState: 'Selangor',
      driverName: 'Ali', salespersonId: 'sp-2', agent: 'Tina', note: 'n', customerDeliveryDate: '2026-09-02',
    });
  });

  it('a LOCKED DO sends only the fields that stay open (owner ruling 2026-09-14)', () => {
    const b = buildDoHeaderBody(seedDoHeaderForm(DOO, '2026-09-14'), STAFF, { locked: true });
    expect(Object.keys(b).sort()).toEqual(['driverName', 'expectedDeliveryAt', 'vehicle']);
  });
});
