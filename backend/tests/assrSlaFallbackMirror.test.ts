import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

/* `backend/scripts/check-assr-sla-priorities.mjs` reports what production's
   assr_priorities.sla_hours values are BESIDE the hardcoded fallback, so the
   owner can see whether making that column live moves any deadline. To do that
   it carries its own copy of the fallback table — a script that runs against a
   production DSN cannot import a Worker service module.

   A hand-copied table is a fact with an expiry date (CLAUDE.md). This is the
   self-check that keeps it honest: if SLA_HOURS_BY_PRIORITY in
   services/assr.ts changes and the script's copy does not, the script starts
   reporting AGREES/DIFFERS against a table nobody uses, and its whole output
   becomes wrong in a way no reader could see. This test goes red instead.

   Deliberately reads the SOURCE rather than importing services/assr: that
   module pulls in the Supabase + AutoCount clients, and this suite must stay
   in the LIGHT vitest project (no Workers runtime) so it gates the merge. */

function serviceFallback(): Record<string, number> {
  const src = readFileSync(
    new URL('../src/services/assr.ts', import.meta.url),
    'utf8',
  );
  const block = src.match(
    /const SLA_HOURS_BY_PRIORITY: Record<Priority, number> = \{([^}]*)\}/,
  );
  expect(block, 'SLA_HOURS_BY_PRIORITY block not found — did it move or get renamed?')
    .toBeTruthy();
  const out: Record<string, number> = {};
  for (const m of block![1]!.matchAll(/^\s*(\w+)\s*:\s*(\d+)/gm)) {
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

describe('the prod-check script mirrors the service fallback', () => {
  test('the matcher actually matched — a verdict over nothing is not a pass', () => {
    // CLAUDE.md: "a checker that cannot match reports a clean run". If the
    // regex above ever stops matching, every assertion below compares {} to {}
    // and passes. This is the assertion that refuses that.
    expect(Object.keys(serviceFallback()).length).toBeGreaterThanOrEqual(4);
  });

  test('both tables carry exactly the same slugs and the same hours', async () => {
    const script = await import('../scripts/check-assr-sla-priorities.mjs');
    expect(script.FALLBACK_SLA_HOURS).toEqual(serviceFallback());
  });
});
