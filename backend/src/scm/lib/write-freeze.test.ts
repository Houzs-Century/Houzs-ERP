import { describe, it, expect } from 'vitest';
import { parseFreezeValue, freezeMessage } from './write-freeze';
import { SCM_AREAS, areaLabel } from './scm-areas';


describe('parseFreezeValue', () => {
  it('treats absent / empty / off as open', () => {
    for (const raw of [null, undefined, '', '   ', 'off', 'OFF', '0', 'false']) {
      expect(parseFreezeValue(raw).scope, String(raw)).toBe('off');
    }
  });

  it('freezes every company on all / true', () => {
    expect(parseFreezeValue('all').scope).toBe('all');
    expect(parseFreezeValue('TRUE').scope).toBe('all');
  });

  it('parses a company id list', () => {
    expect(parseFreezeValue('1').scope).toEqual([1]);
    expect(parseFreezeValue(' 1 , 3 ').scope).toEqual([1, 3]);
  });

  it('FREEZES on an unparseable value rather than opening', () => {
    expect(parseFreezeValue('yes please').scope).toBe('all');
    expect(parseFreezeValue('yes please').malformed).toBe(true);
  });
});

describe('freezeMessage', () => {
  it('says saving is paused, never that the service is down', () => {
    const m = freezeMessage(null);
    expect(m).toMatch(/paused/i);
    expect(m).not.toMatch(/unavailable|down|outage/i);
  });

  it('does not invite a retry — the freeze is a decision, not a blip', () => {
    const m = freezeMessage(null);
    expect(m).not.toMatch(/briefly unavailable|warming up|try again in a moment/i);
  });

  it('prefers the operator sentence from app_config.description', () => {
    expect(freezeMessage('Saving is off until Monday. Talk to Ah Meng.'))
      .toBe('Saving is off until Monday. Talk to Ah Meng.');
    expect(freezeMessage('  trimmed  ')).toBe('trimmed');
  });

  it('discards an operator sentence both clients would throw away', () => {
    const tooLong = 'a'.repeat(200);
    expect(freezeMessage(tooLong)).not.toBe(tooLong);
    expect(freezeMessage(tooLong)).toMatch(/paused/i);
  });

  it('stays inside the length both clients will render', () => {
    expect(freezeMessage(null).length).toBeLessThan(200);
  });
});

describe('freezeMessage during a staged lift', () => {
  it('names the module that is still shut', () => {
    const m = freezeMessage(null, 'scm.procurement.po', true);
    expect(m).toMatch(/purchase orders/);
    expect(m).toMatch(/other areas have reopened/i);
  });

  it('says nothing about areas before the first lift', () => {
    expect(freezeMessage(null, 'scm.procurement.po', false)).toBe(freezeMessage(null));
    expect(freezeMessage(null, null, true)).toBe(freezeMessage(null));
  });

  it('EVERY area produces a sentence both clients will render', () => {
    for (const area of SCM_AREAS) {
      const m = freezeMessage(null, area, true);
      expect(m.length, `${area} -> ${m.length}`).toBeLessThan(200);
      expect(m, area).toMatch(new RegExp(areaLabel(area).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('an operator sentence still wins', () => {
    expect(freezeMessage('Ask Ah Meng.', 'scm.procurement.po', true)).toBe('Ask Ah Meng.');
  });
});
