import { describe, it, expect } from 'vitest';
import { buildContactSyncEvent, nextCursor } from './connect-contact-sync';
import { CONNECT_SYNC_AUTOMATION } from '../../services/connect';

const CALLBACK = 'https://erp.houzscentury.com/api/chat-callback';

const ROW = {
  doc_no: 'HC-SO-2610-044',
  ref: 'HC 11063',
  debtor_name: 'JOOANN CHEE',
  phone: '60126989616',
  branding: 'AKEMI',
  company_id: 1,
  customer_delivery_date: '2026-11-02',
  amended_delivery_date: null,
  venue: 'KL Showroom',
  agent: 'Azza',
  customer_state: 'Selangor',
  house_type: 'Condominium',
  disposal_request: 'Old mattress',
  delivery_message_status: 'Done Send',
};

describe('buildContactSyncEvent', () => {
  it('builds a no-send sync: sentinel automation, headline + bundle fields, no conversation reset', () => {
    const contact = buildContactSyncEvent({
      phone: '+60126989616',
      groupRows: [ROW],
      balanceByDoc: new Map([['HC-SO-2610-044', 150000]]),
      totalByDoc: new Map([['HC-SO-2610-044', 357265]]),
      companyProfile: null,
      companyCode: 'HOUZS',
      callbackUrl: CALLBACK,
    });
    // Fires the sentinel, so Connect upserts the fields and sends nothing.
    expect(contact.automation).toBe(CONNECT_SYNC_AUTOMATION);
    // Headline (single-value) panel fields.
    expect(contact.attributes.reference_no).toBe('HC 11063');
    expect(contact.attributes.brand).toBe('AKEMI');
    expect(contact.attributes.purchase_venue).toBe('KL Showroom');
    expect(contact.attributes.sales_person).toBe('Azza');
    expect(contact.attributes.delivery_state).toBe('Selangor');
    expect(contact.attributes.house_type).toBe('Condominium');
    expect(contact.attributes.disposal).toBe('Old mattress');
    expect(contact.attributes.customer_phone).toBe('+60126989616');
    expect(contact.attributes.client_delivery_date).toBe('2026/11/02');
    // The delivery bundle rides along too.
    expect(contact.attributes.ref_1).toBe('HC-SO-2610-044');
    expect(contact.attributes.ref_no_1).toBe('HC 11063');
    expect(contact.attributes.brand_1).toBe('AKEMI');
    expect(contact.attributes.delivery_date_1).toBe('2026/11/02');
    expect(contact.attributes.amount).toBe('1,500.00');
    expect(contact.attributes.order_amount).toBe('3572.65');
    expect(contact.attributes.company_code).toBe('HOUZS');
    // A sync NEVER resets the conversation (would unlock the Delivery Lock).
    expect(contact.attributes.button_status).toBeUndefined();
    expect(contact.attributes.last_button).toBeUndefined();
  });

  it('uses the amended date as the effective delivery date, and the first order for the headline', () => {
    const contact = buildContactSyncEvent({
      phone: '+60111',
      groupRows: [
        { ...ROW, doc_no: 'A1', ref: 'HC 1', amended_delivery_date: '2026-12-01' },
        { ...ROW, doc_no: 'B2', ref: 'HC 2' },
      ],
      balanceByDoc: new Map(),
      totalByDoc: new Map(),
      companyProfile: null,
      companyCode: null,
      callbackUrl: CALLBACK,
    });
    expect(contact.attributes.client_delivery_date).toBe('2026/12/01');
    expect(contact.attributes.reference_no).toBe('HC 1');
    expect(contact.attributes.order_total).toBe('2');
    expect(contact.attributes.ref_2).toBe('B2');
    // No company resolved AND a sync does not reset: company_code is left unset
    // (undefined), never blanked -- a prior send's value stays on the contact.
    expect(contact.attributes.company_code).toBeUndefined();
  });
});

describe('nextCursor', () => {
  it('a FULL batch advances to its last doc_no (more to walk next run)', () => {
    expect(nextCursor(['A', 'B', 'C'], 3)).toBe('C');
  });

  it('a SHORT batch wraps to the top (window exhausted -> refresh from the start)', () => {
    expect(nextCursor(['A', 'B'], 3)).toBe('');
    expect(nextCursor([], 3)).toBe('');
  });
});
