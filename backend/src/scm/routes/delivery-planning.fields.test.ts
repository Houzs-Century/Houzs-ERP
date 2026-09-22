// The delivery_message_status whitelist (owner 2026-09-22). The "Delivery
// Message Status" column is inline editable to one of 23 workflow values or
// blank; PATCH /delivery-planning/:type/:id/fields refuses anything else with
// `invalid_message_status`. This pins the value set the guard is built on —
// including that "Done All" is the SEND status, NOT a message status, so it must
// never leak into this list (it was added here twice by mistake and removed).
import { describe, expect, it } from 'vitest';

import { HC_MESSAGE_STATUS_VALUES } from './delivery-planning';

describe('delivery_message_status whitelist', () => {
  it('is the 23-value workflow set, with no duplicates', () => {
    expect(HC_MESSAGE_STATUS_VALUES).toHaveLength(23);
    expect(new Set(HC_MESSAGE_STATUS_VALUES).size).toBe(23);
  });

  it('carries the workflow endpoints the board offers', () => {
    expect(HC_MESSAGE_STATUS_VALUES).toContain('To Send Delivery Date');
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Pending Customer Reply (D)');
    expect(HC_MESSAGE_STATUS_VALUES).toContain('Done Remind');
  });

  it('excludes "Done All" — that is the SEND status, not a message status', () => {
    expect(HC_MESSAGE_STATUS_VALUES).not.toContain('Done All');
  });
});
