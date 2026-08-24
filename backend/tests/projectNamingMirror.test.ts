import { describe, expect, test } from 'vitest';

import {
  deriveProjectCode as tsCode,
  deriveProjectName as tsName,
} from '../src/services/project-naming';
// @ts-expect-error - plain .mjs mirror for the seed / backfill scripts
import {
  deriveProjectCode as jsCode,
  deriveProjectName as jsName,
} from '../scripts/lib/project-naming.mjs';

/* WHY THIS FILE EXISTS. `seed-projects.mjs` carried its own `buildName()` under
   a comment reading "Must match deriveProjectName() in services/projects.ts and
   the backfill in mig 071 so re-seeds converge on the same string." It did not
   match: the TypeScript rule forces the organizer slot to "SOLO" for a solo
   event even when an organizer was picked, and the hand copy had no such
   branch — while the SAME script read `row["EVENT TYPE"]` and mapped SOLO to
   event_type_id 2 twelve lines later. So the app and the seed produced two
   different names for one event, and the comment asking them to converge was
   the only thing enforcing it.

   A comment is an instruction to a human. This is the check. */

/* Cases chosen so a rule that is quietly dropped shows up as a MISMATCH, not as
   two functions agreeing on the easy inputs. */
const CASES = [
  { label: 'ordinary exhibition', state: 'JOHOR', brand: 'AKEMI', organizer: 'KAI HAO (KL CHEN)', venue: 'PARADIGM MALL', event_type_slug: 'exhibition' },
  { label: 'solo with NO organizer', state: 'SABAH', brand: 'AKEMI', organizer: null, venue: 'SURIA SABAH', event_type_slug: 'solo' },
  { label: 'SOLO WITH an organizer — the rule the seed script dropped', state: 'SABAH', brand: 'AKEMI', organizer: 'KAI HAO', venue: 'SURIA SABAH', event_type_slug: 'solo' },
  { label: 'mixed case slug — "Solo" must count', state: 'PERAK', brand: 'HAPPISLEEP', organizer: 'SOMEONE', venue: 'AEON IPOH', event_type_slug: 'Solo' },
  { label: 'no event type at all', state: 'KEDAH', brand: 'AKEMI', organizer: 'SOMEONE', venue: 'AMAN CENTRAL', event_type_slug: null },
  { label: 'punctuation and spaces in every slot', state: "Pulau Pinang", brand: 'My-Mattress', organizer: "O'Brien & Co.", venue: 'Queensbay Mall', event_type_slug: 'exhibition' },
  { label: 'blank organizer string, not null', state: 'MELAKA', brand: 'AKEMI', organizer: '   ', venue: 'MAHKOTA', event_type_slug: 'exhibition' },
];

describe('the .mjs mirror agrees with the TypeScript rule', () => {
  for (const c of CASES) {
    test(`name: ${c.label}`, () => {
      expect(jsName(c)).toBe(tsName(c));
    });

    test(`code: ${c.label}`, () => {
      const withDate = { ...c, year: 2026, month: 8 };
      expect(jsCode(withDate)).toBe(tsCode(withDate));
    });
  }

  test('both throw on a missing required slot, rather than minting a holed code', () => {
    for (const missing of ['state', 'venue', 'brand'] as const) {
      const input: Record<string, unknown> = {
        year: 2026, month: 8, organizer: 'X', state: 'JOHOR', venue: 'V', brand: 'B',
      };
      input[missing] = null;
      expect(() => tsCode(input as never), `ts, missing ${missing}`).toThrow();
      expect(() => jsCode(input), `mjs, missing ${missing}`).toThrow();
    }
  });
});

describe('the rules themselves, stated once', () => {
  test('a picked organizer wins the NAME slot even on a solo event; the CODE keeps SOLO', () => {
    /* Owner 2026-08-17 (IOI Mall Damansara): the calendar said SOLO while the
       Excel organizer column said MALL MGMT. The name follows the organizer
       field; the code is the immutable identity and keeps its SOLO segment. */
    expect(tsName({ state: 'SABAH', brand: 'AKEMI', organizer: 'KAI HAO', venue: 'SURIA', event_type_slug: 'solo' }))
      .toBe('SABAH [AKEMI] KAI HAO @ SURIA');
    expect(tsCode({ year: 2026, month: 8, state: 'SABAH', brand: 'AKEMI', organizer: 'KAI HAO', venue: 'SURIA', event_type_slug: 'solo' }))
      .toBe('2026-08-SOLO-SABAH-SURIA-AKEMI');
  });

  test('a NON-solo event keeps its organizer', () => {
    expect(tsName({ state: 'SABAH', brand: 'AKEMI', organizer: 'KAI HAO', venue: 'SURIA', event_type_slug: 'exhibition' }))
      .toBe('SABAH [AKEMI] KAI HAO @ SURIA');
  });

  test('a missing organizer reads SOLO in both formats', () => {
    expect(tsName({ state: 'SABAH', brand: 'AKEMI', organizer: null, venue: 'SURIA' }))
      .toBe('SABAH [AKEMI] SOLO @ SURIA');
  });

  test('the NAME falls back to an em dash; the CODE refuses', () => {
    /* Deliberately different: a name is a label and must always render, a code
       is an identifier and a hole in it is worse than an error. */
    expect(tsName({})).toBe('— [—] SOLO @ —');
    expect(() => tsCode({ year: 2026, month: 8 })).toThrow(/state is required/);
  });

  test('the code slugs punctuation away; the name keeps it', () => {
    const input = { year: 2026, month: 8, state: 'Pulau Pinang', brand: 'My-Mattress', organizer: "O'Brien & Co.", venue: 'Queensbay Mall' };
    expect(tsCode(input)).toBe('2026-08-O-BRIEN-CO-PULAU-PINANG-QUEENSBAY-MALL-MY-MATTRESS');
    expect(tsName(input)).toBe("Pulau Pinang [My-Mattress] O'Brien & Co. @ Queensbay Mall");
  });

  test('the month is zero-padded, so codes sort', () => {
    expect(tsCode({ year: 2026, month: 8, state: 'S', venue: 'V', brand: 'B' })).toContain('2026-08-');
  });
});
