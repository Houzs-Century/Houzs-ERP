import { describe, expect, test } from 'vitest';
import { SO_CANCELLED_FINAL_REASON, soReopenable } from './so-reopen';

describe('Sales Order reopen — offered only where the status PATCH takes it', () => {
  test('a cancelled order carried over from AutoCount is reopenable', () => {
    expect(soReopenable('CANCELLED', 'IV-00123')).toBe(true);
    expect(soReopenable('cancelled', ' IV-00123 ')).toBe(true);
  });

  test('a cancel the ERP ran itself is final', () => {
    expect(soReopenable('CANCELLED', null)).toBe(false);
    expect(soReopenable('CANCELLED', '   ')).toBe(false);
  });

  test('a live order has nothing to reopen', () => {
    expect(soReopenable('CONFIRMED', 'IV-00123')).toBe(false);
    expect(soReopenable(null, 'IV-00123')).toBe(false);
  });

  /* The client shows a server reason only under 200 characters
     (frontend authed-fetch.ts isPlain); the old sentence was shown, this one
     must stay showable and say what to do instead. */
  test('the refusal sentence is short enough to reach the operator and names the way out', () => {
    expect(SO_CANCELLED_FINAL_REASON.length).toBeLessThan(200);
    expect(SO_CANCELLED_FINAL_REASON).toContain('Copy as new');
    expect(SO_CANCELLED_FINAL_REASON).toContain('AutoCount');
  });
});
