/* Every SCM sub-router mounts the bridge — the pin behind docs/bugs/0648.
   scm/index.ts mounts NO global supabaseAuth: each router must declare
   `<router>.use('*', supabaseAuth)` itself, because that middleware is what
   stashes the real caller as `houzsUser` (the flat-key permission source
   hasHouzsPerm reads) and hands out the service client `c.get('supabase')`.
   Three routers shipped without it (other-debtors 2026-09-03, receipts
   2026-09-03, ap-invoices 2026-09-06): in production their reads answered
   500 (no client) or 403 (no permissions) and their writes 403, while every
   test passed — the harnesses set both variables by hand. This test PARSES
   scm/index.ts the way tests/writeFreezeAreas.test.ts does, follows each
   `scm.route("/prefix", router)` to its file, and asserts the bridge line is
   there. A router that legitimately skips the bridge is named below WITH
   its reason; nothing else may. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const SCM_DIR = resolve(__dirname, '../src/scm');
const INDEX = readFileSync(resolve(SCM_DIR, 'index.ts'), 'utf8');

/* Routers that read no SCM data through the bridge, by design. */
const NO_BRIDGE_BY_DESIGN: Record<string, string> = {
  '/write-freeze': 'the freeze STATUS endpoint — reads the toggle through its own client, gated inside to the bypass cohort (no houzsUser needed)',
};

const BRIDGE_LINE = /\.use\(\s*(['"])(?:\*|\/\*)\1\s*,\s*supabaseAuth\s*\)/;

function importedRouters(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of INDEX.matchAll(/import\s+\{([^}]+)\}\s+from\s+"\.\/routes\/([^"]+)"/g)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.set(name, resolve(SCM_DIR, 'routes', `${m[2]!}.ts`));
    }
  }
  for (const m of INDEX.matchAll(/import\s+(\w+)\s+from\s+"\.\/routes\/([^"]+)"/g)) {
    out.set(m[1]!, resolve(SCM_DIR, 'routes', `${m[2]!}.ts`));
  }
  return out;
}

describe('every SCM sub-router mounts the supabaseAuth bridge', () => {
  test('scm.route("/prefix", router) → the router file carries `.use(\'*\', supabaseAuth)`, or is named here with a reason', () => {
    const files = importedRouters();
    const mounts = [...INDEX.matchAll(/scm\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g)].map((m) => ({ prefix: m[1]!, name: m[2]! }));
    expect(mounts.length).toBeGreaterThan(50);

    const missing: string[] = [];
    for (const { prefix, name } of mounts) {
      if (NO_BRIDGE_BY_DESIGN[prefix]) continue;
      const file = files.get(name);
      if (!file) { missing.push(`${prefix} (${name}: not imported from ./routes)`); continue; }
      const src = readFileSync(file, 'utf8');
      if (!BRIDGE_LINE.test(src)) missing.push(`${prefix} (${name} in ${file.slice(SCM_DIR.length + 1)})`);
    }
    expect(missing, `routers mounted without the bridge — their reads 500/403 in production:\n${missing.join('\n')}`).toEqual([]);
  });

  test('the by-design list names only prefixes that are actually mounted', () => {
    for (const prefix of Object.keys(NO_BRIDGE_BY_DESIGN)) {
      expect(INDEX.includes(`scm.route("${prefix}"`), `${prefix} is on the by-design list but no longer mounted`).toBe(true);
    }
  });
});
