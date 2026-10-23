// The delivery_message_status whitelist (owner 2026-09-22). The "Delivery
// Message Status" column is inline editable to one of 28 workflow values or
// blank; PATCH /delivery-planning/:type/:id/fields refuses anything else with
// `invalid_message_status`. This pins the value set the guard is built on —
// including that "Done All" is the SEND status, NOT a message status, so it must
// never leak into this list (it was added here twice by mistake and removed).
import { describe, expect, it } from 'vitest';

import { HC_MESSAGE_STATUS_VALUES } from './delivery-planning-fields';

describe('delivery_message_status whitelist', () => {
  it('is the 28-value workflow set, with no duplicates', () => {
    expect(HC_MESSAGE_STATUS_VALUES).toHaveLength(28);
    expect(new Set(HC_MESSAGE_STATUS_VALUES).size).toBe(28);
  });

  it('carries the workflow endpoints the board offers', () => {
    expect(HC_MESSAGE_STATUS_VALUES).toContain('To Send Delivery Date');
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Done Send');
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Done Remind (3)');
    // inbound customer taps (chat-request-patch) write these onto the column
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Done Scheduling');
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Pending Reschedule (D)');
  });

  it('carries the EM/SG shipping + customer-reply statuses from the sheet (owner 2026-10-22)', () => {
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Done Shipout');
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Pending Delivery (EM)');
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Customer Confirm Shipment');
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Pending Reschedule (A)');
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Pending Customer Reply (D)');
  });

  it('drops the retired states and never carries the SEND status', () => {
    expect(HC_MESSAGE_STATUS_VALUES).not.toContain('Done All');
    expect(HC_MESSAGE_STATUS_VALUES).not.toContain('Peding Delivery (EM)'); // the sheet typo, normalised on backfill
    expect(HC_MESSAGE_STATUS_VALUES).not.toContain('To Send Delivery Time');
  });
});
