import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { PAYMENT_METHOD_CODES } from '../src/scm/shared/payment-methods';

/* The payment-method vocabulary was re-typed as a z.enum literal in SEVEN route
   files — in a DIFFERENT ORDER from PAYMENT_METHOD_CODES, and one of them said
   it was "kept in sync with PAYMENT_METHOD_CODES in
   packages/shared/src/payment-methods.ts", a path this repo does not have. So
   payment-methods.ts's own instruction ("don't add a 5th code without wiring
   its branch logic end-to-end") could not be followed: a 5th code added there
   would have been rejected by every payments endpoint.

   The literals are gone. This is what keeps them gone. */

/* Sources as strings, inlined by Vite at transform time. The suite runs inside
   workerd, which has no filesystem, so a readdirSync guard would only ever
   report ENOENT — it would pass as "no offenders" the day someone deleted the
   directory and fail on the day it worked. */
const ROUTE_SOURCES = import.meta.glob('../src/scm/routes/*.ts', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

describe('no route re-types the payment-method vocabulary', () => {
  test('the glob actually sees the routes', () => {
    // Guards the guard: an empty map would make the next test vacuously green.
    expect(Object.keys(ROUTE_SOURCES).length).toBeGreaterThan(30);
  });

  test('z.enum over a payment-method literal appears nowhere under scm/routes', () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(ROUTE_SOURCES)) {
      // A z.enum whose members include 'merchant' — whatever the ordering.
      for (const m of src.matchAll(/z\.enum\(\s*\[[^\]]*'merchant'[^\]]*\]/g)) {
        offenders.push(`${path}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the accepted set is unchanged by the collapse', () => {
  /* The literals accepted merchant / transfer / cash / installment. So does
     PAYMENT_METHOD_CODES — the ORDER differs, which changes only the `options`
     array echoed inside a 400 body, never what is accepted or stored. */
  const schema = z.enum(PAYMENT_METHOD_CODES);
  const RETIRED_LITERAL = ['merchant', 'transfer', 'cash', 'installment'];

  test('same members, order aside', () => {
    expect([...PAYMENT_METHOD_CODES].sort()).toEqual([...RETIRED_LITERAL].sort());
  });

  test.each(RETIRED_LITERAL)('%s is still accepted', (v) => {
    expect(schema.safeParse(v).success).toBe(true);
  });

  test.each(['Merchant', 'card', 'cheque', '', 'CASH'])('%s is still rejected', (v) => {
    expect(schema.safeParse(v).success).toBe(false);
  });
});
