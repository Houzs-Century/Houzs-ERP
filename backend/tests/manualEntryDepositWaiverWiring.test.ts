// ----------------------------------------------------------------------------
// The deposit waiver is reachable ONLY through `manualEntry === true`, asserted
// against the source — same idiom and same reason as soProceedRefusalWiring.
//
// The behaviour is tested in src/scm/shared/manual-entry-deposit-waiver.test.ts
// (deposit: null drops that one condition, keeps the other four). Nothing here
// re-tests logic. What it pins is the WIRING, because the failure mode is not a
// wrong verdict — it is the waiver becoming reachable without the flag, which no
// unit test over the collector could ever see.
//
// Two ways that could happen, both asserted against:
//   1. someone loosens `body.manualEntry === true` to a truthy read, so a stray
//      "false" / 0 / "" waives a money condition;
//   2. someone passes `deposit: null` on the create path unconditionally while
//      fixing something else, and every collector test still passes.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import soRoutes from '../src/scm/routes/mfg-sales-orders.ts?raw';
import salesOrderNew from '../../frontend/src/pages/scm-v2/SalesOrderNew.tsx?raw';

/** Source with comments stripped — a rule named only in a comment is not a
 *  rule, and the comments here quote the very shapes this file forbids. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SO = code(soRoutes);
const NEW_SO = code(salesOrderNew);

describe('manualEntry deposit waiver — wiring', () => {
  test('the flag is read STRICTLY, so no truthy value can waive a money condition', () => {
    expect(SO).toMatch(/manualEntry\s*===\s*true/);
  });

  test('the waiver is gated on the flag — deposit: null is never unconditional here', () => {
    expect(SO).toMatch(/deposit:\s*manualEntry\s*\n?\s*\?\s*null/);
    /* The create path must not hand the collector a bare null. */
    expect(SO).not.toMatch(/deposit:\s*null\s*,/);
  });

  test('the hand-keyed screen is what sends it', () => {
    expect(NEW_SO).toMatch(/manualEntry:\s*true/);
  });

  /* The POS handover shares this endpoint and must NOT waive. It never sends
     the flag, so the guard is that the SERVER never turns the flag on for
     itself — the only writer is the client body, read once, strictly. */
  test('the route never sets the flag itself — only reads it from the body', () => {
    expect(SO).not.toMatch(/manualEntry\s*[:=]\s*true/);
    expect(SO.match(/const\s+manualEntry\s*=/g) ?? []).toHaveLength(1);
  });
});
