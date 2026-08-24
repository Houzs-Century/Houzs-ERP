import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  PERMISSIONS,
  UNDECLARED_ROLE_KEYS,
  isValidPermission,
  parsePermissions,
  droppedPermissions,
} from '../src/services/permissions';

/* A permission key granted in a role row but absent from PERMISSIONS is
   DROPPED by parsePermissions at session hydration — no log, no error, nothing
   in the UI. That silence is the defect class, not the drop itself:
   `service_cases.approve` gated routes/assr.ts for weeks while missing from the
   catalogue, so cost approval was accidentally Owner/IT-only and no amount of
   clicking in Team > Positions could change it.

   This is the build-time half of the fix. It re-derives the dropped set from
   every role grant in the tree and fails when a key appears that nobody has
   classified in UNDECLARED_ROLE_KEYS. The runtime half is
   `unknown_permissions` on GET /api/roles.

   LIGHT project on purpose (no cloudflare:test, no env.DB) so it runs inside
   `npm run test:light`, which backend-typecheck runs — a REQUIRED context. An
   assertion that only lives in a shard is advisory at merge time. */

const ROLE_GRANT = /'(\[[^']*\])'/g;

/** Every permission string granted to a role anywhere in the repo's own SQL. */
function grantedInTree(): { keys: Set<string>; sources: number } {
  const keys = new Set<string>();
  let sources = 0;

  const sqlFiles = [
    new URL('../src/db/schema.sql', import.meta.url),
    ...readdirSync(new URL('../src/db/migrations/', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => new URL(`../src/db/migrations/${f}`, import.meta.url)),
    ...readdirSync(new URL('../src/db/migrations-pg/', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => new URL(`../src/db/migrations-pg/${f}`, import.meta.url)),
  ];

  for (const url of sqlFiles) {
    let src: string;
    try {
      src = readFileSync(url, 'utf8');
    } catch {
      continue;
    }
    if (!/INSERT\s+(OR\s+IGNORE\s+)?INTO\s+"?roles"?/i.test(src)) continue;
    for (const m of src.matchAll(ROLE_GRANT)) {
      let arr: unknown;
      try {
        arr = JSON.parse(m[1]!);
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      sources += 1;
      for (const k of arr) if (typeof k === 'string') keys.add(k);
    }
  }

  // The generated test fixture carries the same role JSON, collapsed. Included
  // because it is what every test database actually gets.
  const seed = JSON.parse(
    readFileSync(new URL('./generated/test-schema-seed.json', import.meta.url), 'utf8'),
  ) as { table: string; columns: string[]; rows: unknown[][] }[];
  for (const t of seed) {
    if (t.table !== 'roles') continue;
    const col = t.columns.indexOf('permissions');
    if (col < 0) continue;
    for (const row of t.rows) {
      const raw = row[col];
      if (typeof raw !== 'string') continue;
      let arr: unknown;
      try {
        arr = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      sources += 1;
      for (const k of arr) if (typeof k === 'string') keys.add(k);
    }
  }

  return { keys, sources };
}

describe('permission catalogue drift', () => {
  test('the extractor actually found role grants — a verdict over nothing is not a pass', () => {
    // CLAUDE.md: "a checker that cannot match reports a clean run". If the
    // regex or the paths above ever stop matching, every assertion below
    // compares an empty set to an empty set and passes silently.
    const { keys, sources } = grantedInTree();
    expect(sources, 'no role permission arrays found — did the seeds move?')
      .toBeGreaterThanOrEqual(5);
    expect(keys.size, 'no permission keys extracted').toBeGreaterThanOrEqual(20);
  });

  test('every granted key is either declared, or classified in the ledger', () => {
    const { keys } = grantedInTree();
    const dropped = [...keys].filter((k) => !isValidPermission(k)).sort();
    const classified = Object.keys(UNDECLARED_ROLE_KEYS).sort();

    // A key on neither list is the failure this test exists for: something
    // grants it, this build throws it away, and nobody decided that.
    //
    // The fix is NOT to add it here. Run
    //   grep -rF '"<key>"' backend/src frontend/src --include=*.ts --include=*.tsx
    // If ANY requirePermission / requireAnyPermission / can() hit comes back,
    // the key has a live gate and belongs in PERMISSIONS — declaring it is what
    // service_cases.approve needed. Only a key that gates nothing goes in the
    // ledger, with the evidence in its `why`.
    expect(dropped).toEqual(classified);
  });

  test('a ledger entry that has since been DECLARED must be removed from the ledger', () => {
    // The ledger is a ratchet: it may only shrink. Leaving a declared key in it
    // would make the file lie about which keys are dropped.
    const declared = new Set(PERMISSIONS.map((p) => p.key));
    const stale = Object.keys(UNDECLARED_ROLE_KEYS).filter((k) => declared.has(k));
    expect(stale, 'these are in PERMISSIONS now — delete them from UNDECLARED_ROLE_KEYS').toEqual([]);
  });

  test('every ledger entry carries a reason a reader can act on', () => {
    for (const [key, entry] of Object.entries(UNDECLARED_ROLE_KEYS)) {
      expect(['legacy-closed', 'retired'], `${key} status`).toContain(entry.status);
      expect(entry.why.length, `${key} needs a why`).toBeGreaterThan(20);
    }
  });

  test('the five legacy-closed keys are exactly the ones udf.ts still gates on', () => {
    // These are the dangerous half of the ledger: each one IS a live gate, and
    // declaring it would OPEN a UDF table that is shut on purpose. Derived from
    // udf.ts rather than retyped, so the two cannot drift.
    const udf = readFileSync(new URL('../src/routes/udf.ts', import.meta.url), 'utf8');
    const gated = [...udf.matchAll(/requirePermission\("([^"]+)"\)/g)]
      .map((m) => m[1]!)
      .filter((k) => !isValidPermission(k))
      .sort();
    expect(gated.length, 'no ungrantable udf gates found — did udf.ts change shape?')
      .toBeGreaterThanOrEqual(5);

    const legacyClosed = Object.entries(UNDECLARED_ROLE_KEYS)
      .filter(([, v]) => v.status === 'legacy-closed')
      .map(([k]) => k)
      .sort();
    expect(legacyClosed).toEqual(gated);
  });
});

describe('the drop is reported, not swallowed', () => {
  const row = JSON.stringify(['service_cases.read', 'trips.manage', 'not.a.key']);

  test('parsePermissions keeps only declared keys', () => {
    expect(parsePermissions(row)).toEqual(['service_cases.read']);
  });

  test('droppedPermissions returns exactly what parsePermissions threw away', () => {
    expect(droppedPermissions(row)).toEqual(['trips.manage', 'not.a.key']);
  });

  test('the two halves partition the stored array — nothing is lost or counted twice', () => {
    const stored = JSON.parse(row) as string[];
    expect([...parsePermissions(row), ...droppedPermissions(row)].sort()).toEqual(
      [...stored].sort(),
    );
  });

  test('both agree on the degenerate inputs', () => {
    for (const bad of [null, undefined, '', 'not json', '{"a":1}', '[1,2,3]']) {
      expect(parsePermissions(bad)).toEqual([]);
      expect(droppedPermissions(bad)).toEqual([]);
    }
  });
});
