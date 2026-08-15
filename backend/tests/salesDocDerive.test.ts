import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import coSource from '../src/scm/routes/consignment-orders.ts?raw';
import soSource from '../src/scm/routes/mfg-sales-orders.ts?raw';
import { senOrZero } from '../src/scm/lib/sales-doc-derive';

/* Three derivations used to exist in BOTH the Sales Order and the Consignment
   Order routers, and two of them had drifted. They are one module now.

   Consolidating them was only safe because of two facts about OTHER files, and
   those files can change. So the facts are asserted here rather than written in
   a comment nobody re-runs:

     1. Nothing `canonicalizeMyState` produces can name a NON-Malaysia locality,
        so canonicalising before the my_localities lookup (which the SO did and
        the CO did not) cannot change the country.
     2. Every CO callsite already coerces its argument with Number(), so the
        CO's missing senOrZero could never see a string or a NaN.

   Break either and this file goes red BEFORE anyone notices a wrong country on
   a document. */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nl = (s: string) => s.replace(/\r\n/g, '\n');

describe('neither router keeps a private copy any more', () => {
  for (const [label, src] of [['SO', nl(soSource)], ['CO', nl(coSource)]] as const) {
    test(`${label} imports the shared module and declares none of them`, () => {
      expect(src, `${label} does not import sales-doc-derive`).toContain('sales-doc-derive');
      for (const name of ['deriveCountryFromState', 'deriveSalesLocationFromState', 'snapshotUnitCostSen']) {
        expect(
          new RegExp(`^\\s*(export\\s+)?const ${name} = async \\(`, 'm').test(src),
          `${label} still declares its own ${name}`,
        ).toBe(false);
      }
    });
  }
});

describe('PROOF 1 — canonicalising cannot change the derived country', () => {
  /** Every value canonicalizeMyState can RETURN. */
  function canonicalTargets(): Set<string> {
    const src = fs.readFileSync(path.join(ROOT, 'src/scm/lib/canonical-state.ts'), 'utf8');
    const canon = src.match(/const CANONICAL_STATES[\s\S]*?\]\)/)?.[0] ?? '';
    const alias = src.match(/const ALIAS_MAP[\s\S]*?\]\);/)?.[0] ?? '';
    return new Set([
      ...[...canon.matchAll(/'([^']+)'/g)].map((m) => m[1]),
      ...[...alias.matchAll(/\['[^']*',\s*'([^']+)'\]/g)].map((m) => m[1]),
    ]);
  }

  /** `state` values seeded into my_localities under a country that is NOT Malaysia. */
  function nonMalaysiaStates(): Map<string, Set<string>> {
    const dir = path.join(ROOT, 'src/db/migrations-pg');
    const out = new Map<string, Set<string>>();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.sql')) continue;
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!t.includes('my_localities')) continue;
      for (const m of t.matchAll(/\(\s*'[^']*',\s*'[^']*',\s*'([^']*)',\s*'[^']*',\s*'([^']*)'\s*\)/g)) {
        const [, state, country] = m;
        if (country.toLowerCase() === 'malaysia') continue;
        if (!out.has(country)) out.set(country, new Set());
        out.get(country)!.add(state);
      }
    }
    return out;
  }

  test('the two scans read real data — neither is empty', () => {
    /* Without this the intersection below is empty for the wrong reason. */
    expect(canonicalTargets().size, 'no canonical targets parsed').toBeGreaterThanOrEqual(16);
    const nonMy = nonMalaysiaStates();
    expect(nonMy.size, 'no non-Malaysia localities found — mig 0181 seeds SG and CN').toBeGreaterThan(0);
    expect([...nonMy.values()].reduce((n, s) => n + s.size, 0)).toBeGreaterThan(10);
  });

  test('no canonical Malaysian state name is also a non-Malaysia locality', () => {
    const targets = canonicalTargets();
    const clashes: string[] = [];
    for (const [country, states] of nonMalaysiaStates()) {
      for (const s of states) if (targets.has(s)) clashes.push(`${s} (${country})`);
    }
    expect(
      clashes,
      'A state name that canonicalizeMyState can PRODUCE is also seeded under a non-Malaysia\n' +
        'country. deriveCountryFromState canonicalises before the lookup, so such a row would make\n' +
        'the derived country depend on the spelling the caller typed:\n  ' + clashes.join('\n  '),
    ).toEqual([]);
  });
});

describe('PROOF 2 — every snapshotUnitCostSen callsite coerces its argument', () => {
  test('the CO passes a Number(...) or a literal, never a raw body field', () => {
    const calls = [...nl(coSource).matchAll(/snapshotUnitCostSen\(([^;]*?)\);/gs)].map((m) => m[1]);
    expect(calls.length, 'no callsites found — this guard is reading the wrong file').toBeGreaterThan(0);
    const raw = calls.filter((args) => {
      const third = args.split(',')[2]?.trim() ?? '';
      return !/^Number\(/.test(third) && !/^\d+$/.test(third);
    });
    expect(
      raw,
      'a callsite passes `explicit` without coercing it. senOrZero now guards this, so it is no\n' +
        'longer a bug — but the guard exists because the CO copy did NOT have senOrZero, and this\n' +
        'assertion is the record of why removing that copy was safe:\n  ' + raw.join('\n  '),
    ).toEqual([]);
  });

  test('senOrZero itself does what the proof assumes', () => {
    expect(senOrZero(1250)).toBe(1250);
    expect(senOrZero('1250')).toBe(1250);
    expect(senOrZero(NaN)).toBe(0);
    expect(senOrZero(Infinity)).toBe(0);
    expect(senOrZero('abc')).toBe(0);
    expect(senOrZero(null)).toBe(0);
    /* NOT clamped: a negative is finite and passes through. The callers that
       must refuse one do it themselves. */
    expect(senOrZero(-5)).toBe(-5);
  });
});
