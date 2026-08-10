import { describe, it, expect } from 'vitest';
import { parseFreezeValue, freezeMessage } from './write-freeze';

describe('parseFreezeValue', () => {
  it('treats absent / empty / off as open', () => {
    for (const raw of [null, undefined, '', '   ', 'off', 'OFF', '0', 'false']) {
      expect(parseFreezeValue(raw)).toBe('off');
    }
  });

  it('freezes every company on all / true', () => {
    expect(parseFreezeValue('all')).toBe('all');
    expect(parseFreezeValue('TRUE')).toBe('all');
  });

  it('parses a company id list', () => {
    expect(parseFreezeValue('1')).toEqual([1]);
    expect(parseFreezeValue(' 1 , 3 ')).toEqual([1, 3]);
  });

  it('falls OPEN on an unparseable value rather than freezing everything', () => {
    expect(parseFreezeValue('yes please')).toBe('off');
  });
});

describe('freezeMessage', () => {
  it('says saving is paused, never that the service is down', () => {
    const m = freezeMessage(null);
    expect(m).toMatch(/paused/i);
    expect(m).not.toMatch(/unavailable|down|outage/i);
  });

  it('does not invite a retry — the freeze is a decision, not a blip', () => {
    // The bug this replaces: staff saw "The service is briefly unavailable.
    // Please try again in a moment.", which reads as an outage AND is the exact
    // wording api/client.ts isColdPool503 matches, so the client silently
    // re-sent the refused save four more times.
    const m = freezeMessage(null);
    expect(m).not.toMatch(/briefly unavailable|warming up|try again in a moment/i);
  });

  it('prefers the operator sentence from app_config.description', () => {
    expect(freezeMessage('Saving is off until Monday. Talk to Ah Meng.'))
      .toBe('Saving is off until Monday. Talk to Ah Meng.');
    expect(freezeMessage('  trimmed  ')).toBe('trimmed');
  });

  it('discards an operator sentence both clients would throw away', () => {
    // 200+ characters is dropped by api/client.ts presentable() and by the SCM
    // client's humanApiError, which then fall back to their generic 5xx line —
    // i.e. exactly the outage wording this fix removes. Cap it server-side.
    const tooLong = 'a'.repeat(200);
    expect(freezeMessage(tooLong)).not.toBe(tooLong);
    expect(freezeMessage(tooLong)).toMatch(/paused/i);
  });

  it('stays inside the length both clients will render', () => {
    expect(freezeMessage(null).length).toBeLessThan(200);
  });
});
