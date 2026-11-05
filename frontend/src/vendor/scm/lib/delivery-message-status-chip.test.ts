import { describe, expect, it } from 'vitest';
import { MESSAGE_STATUSES, messageStatusChip } from './delivery-planning-queries';

// HC-0188: the board colours each Delivery Message Status like the HC Delivery sheet.
describe('messageStatusChip', () => {
  it('gives every dropdown status a colour', () => {
    for (const s of MESSAGE_STATUSES) expect(messageStatusChip(s), s).toBeDefined();
  });

  it('uses the sheet colours', () => {
    expect(messageStatusChip('To Send Delivery Date')).toEqual({ bg: '#bfe1f6', fg: '#0a53a8' });
    expect(messageStatusChip('Done Scheduling')).toEqual({ bg: '#473822', fg: '#ffe5a0' });
    expect(messageStatusChip('Pending Reschedule (D)')).toEqual({ bg: '#b10202', fg: '#ffcfc9' });
    expect(messageStatusChip('Not Sent (A)')).toEqual({ bg: '#ffcfc9', fg: '#b10202' });
    expect(messageStatusChip('To Remind Customer Reply (2)')).toEqual({ bg: '#e6cff2', fg: '#5a3286' });
  });

  it('leaves blank and off-list values plain', () => {
    expect(messageStatusChip(null)).toBeUndefined();
    expect(messageStatusChip('')).toBeUndefined();
    expect(messageStatusChip('3 Days Reminder Sent (Time)')).toBeUndefined();
  });
});
