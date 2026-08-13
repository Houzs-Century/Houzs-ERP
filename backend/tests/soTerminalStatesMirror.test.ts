import { describe, expect, test } from 'vitest';
import {
  SO_TERMINAL_STATES as tsStates,
  SO_TERMINAL_STATES_PGREST as tsPgrest,
} from '../src/scm/shared/so-terminal-states';
// @ts-expect-error - plain .mjs mirror for audit scripts
import { SO_TERMINAL_STATES as jsStates } from '../scripts/lib/so-terminal-states.mjs';

/* The .mjs mirror exists because eight audit/repair scripts judge which sales
   orders are still LIVE by this set and cannot import TypeScript. This test is
   the pin — the same role phoneNormaliseMirror and variantAxesMirror play.

   Before 2026-08-13 the set was hand-typed in fourteen places across ten files,
   under four names, each citing a different file as the authority. SHIPPED was
   added to it on 2026-08-01 precisely because one consumer had been missed in an
   earlier round of the same hand-editing. */

describe('so-terminal-states.mjs mirrors so-terminal-states.ts', () => {
  test('the state list is identical', () => {
    expect([...jsStates]).toEqual([...tsStates]);
  });
});

describe('the PostgREST rendering is exactly what it replaced', () => {
  /* so-stock-allocation.ts sends this string to PostgREST verbatim as a
     `not.in` filter. If the declared ORDER changes, this string changes, and
     the query sent over the wire is no longer byte-identical to the literal
     that stood there for the life of the allocator. Semantics would survive;
     the proof that nothing changed would not. */
  test('renders the allocator literal', () => {
    expect(tsPgrest).toBe('(CANCELLED,CLOSED,SHIPPED,DELIVERED,INVOICED,DRAFT)');
  });
});

describe('the set still means what its consumers assume', () => {
  test.each(['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'])(
    '%s is terminal',
    (s) => { expect(tsStates).toContain(s); },
  );

  test.each(['CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'ON_HOLD'])(
    '%s is NOT terminal — it still demands stock',
    (s) => { expect(tsStates).not.toContain(s); },
  );

  test('exactly six statuses — a seventh needs the consumers re-read, not just this list', () => {
    expect(tsStates.length).toBe(6);
  });
});
