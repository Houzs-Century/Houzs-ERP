import { describe, it, expect } from 'vitest';
import { shouldSendPodDelivered } from '../src/scm/lib/pod-delivered-message';

/* The auto "Delivery Completed" WhatsApp gate (#5). Owner: fires automatically,
   but ONLY on a real POD, only once the SO is fully delivered, and only once. */
describe('shouldSendPodDelivered', () => {
  it('sends on real POD + fully-delivered SO + not already sent', () => {
    expect(shouldSendPodDelivered({ hasPod: true, soFullyDelivered: true, alreadySent: false })).toBe(true);
  });
  it('no POD → never auto-thanks (an evidence-free "mark delivered" must not send)', () => {
    expect(shouldSendPodDelivered({ hasPod: false, soFullyDelivered: true, alreadySent: false })).toBe(false);
  });
  it('SO not fully delivered → waits (a partial drop does not thank the whole order)', () => {
    expect(shouldSendPodDelivered({ hasPod: true, soFullyDelivered: false, alreadySent: false })).toBe(false);
  });
  it('already sent → never sends twice', () => {
    expect(shouldSendPodDelivered({ hasPod: true, soFullyDelivered: true, alreadySent: true })).toBe(false);
  });
});
