import { describe, it, expect } from 'vitest';
import { parseFreezeValue, freezeMessage } from './write-freeze';
import { SCM_AREAS, areaLabel } from './scm-areas';

// The company/area GRAMMAR is specified in tests/writeFreezeScope.test.ts and
// the middleware behaviour in tests/writeFreezeMiddleware.test.ts. What is left
// here is the sentence staff actually read, plus the handful of parse shapes
// this file has always pinned.

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
    /* CHANGED DELIBERATELY. This used to resolve to 'off', so a typo in the
       config row silently reopened production writes — the worst outcome this
       switch has, because it is invisible: nothing errors, staff simply start
       saving into data the cutover is mid-way through migrating. Freezing
       instead is loud, is reported within the cache TTL, and is undone by one
       UPDATE (docs/write-freeze-staged-lift.md). The OUTAGE case is unchanged
       and still fails open — see readFreeze. */
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

describe('freezeMessage during a staged lift', () => {
  it('names the module that is still shut', () => {
    const m = freezeMessage(null, 'scm.procurement.po', true);
    expect(m).toMatch(/purchase orders/);
    expect(m).toMatch(/other areas have reopened/i);
  });

  it('says nothing about areas before the first lift', () => {
    // Naming one area is noise while every area is shut, and the row holds a
    // plain '1' today — so this is the sentence production is still sending.
    expect(freezeMessage(null, 'scm.procurement.po', false)).toBe(freezeMessage(null));
    expect(freezeMessage(null, null, true)).toBe(freezeMessage(null));
  });

  it('EVERY area produces a sentence both clients will render', () => {
    // A label long enough to breach the 200-char cap would make both clients
    // fall back to their generic 5xx line — the outage wording again.
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
