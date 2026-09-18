/* A migration that DROPs a view and recreates it leaves the new object with an
   EMPTY ACL — that is how 0189 took the production Sales Orders list down for
   every user and needed 0190 + 0191 to repair, and it is bug class H in
   docs/bug-classes.md, listed there as "no check yet". This is the check.

   WHAT PRODUCTION ACTUALLY RELIES ON, found while writing this. Three applied
   migrations (0305, 0307, 20260906T1500) DROP views and re-grant nothing, and
   production is fine — because 0217 set ALTER DEFAULT PRIVILEGES in schemas
   public + scm so that every object CREATED afterwards gets service_role SELECT
   automatically. Default privileges apply only to objects created by the role
   that ran 0217 (no FOR ROLE clause), i.e. the migration runner's login role.
   That is the whole reason prod stays up, and it is also why staging can differ:
   a database whose migrations ran as a different role never got the default
   (docs/bugs/0824, the view-grant entry). Hyperdrive origin roles are NOT in
   the default at all — only PostgREST's service_role is.

   RULE, as a RATCHET. (1) The default-privilege migration must exist and cover
   service_role in both schemas — that is the floor prod stands on. (2) Every
   migration NEWER than this gate that DROPs a view must carry a grant-restore:
   either 0191's self-adapting `role_table_grants` copy or an explicit
   `GRANT ... ON <view>`. The applied files that predate the gate are inventory,
   printed, not failed — a checksummed migration cannot be edited anyway.

   The population is asserted non-empty (migrationNumbers.test.ts's lesson: a
   guard that passes on an empty listing is worse than no guard). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '..', 'src', 'db', 'migrations-pg');
/* Files sorting at or before this name were applied before the gate existed. */
const GATE_INTRODUCED = '20260912T0130_scm_regrant_so_payment_totals_view.sql';

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
const read = (f: string) => stripComments(readFileSync(join(DIR, f), 'utf8'));

const droppedViews = (sql: string) =>
  [...sql.matchAll(/drop\s+view\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1].toLowerCase());

const carriesGrantRestore = (sql: string, views: string[]) => {
  if (/role_table_grants/i.test(sql)) return true;
  return views.every((v) => {
    const bare = v.replace(/^scm\./, '').replace(/[.]/g, '\\.');
    return new RegExp(`grant\\s+[a-z, ]+\\s+on\\s+(?:scm\\.)?${bare}\\b`, 'i').test(sql);
  });
};

describe('view grants survive a DROP + CREATE', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  it('the default-privilege floor exists: service_role gets SELECT on future objects in public and scm', () => {
    const all = files.map(read).join('\n');
    for (const schema of ['public', 'scm']) {
      expect(
        new RegExp(`alter\\s+default\\s+privileges\\s+in\\s+schema\\s+${schema}\\s+grant\\s+[a-z, ]*select[a-z, ]*\\s+on\\s+tables\\s+to\\s+service_role`, 'i').test(all),
        `no ALTER DEFAULT PRIVILEGES ... IN SCHEMA ${schema} ... TO service_role in the tree — every recreated view would come up with no PostgREST access`,
      ).toBe(true);
    }
  });

  const droppers = files.filter((f) => droppedViews(read(f)).length > 0);

  it('sees a non-empty population of view-dropping migrations', () => {
    expect(droppers.length).toBeGreaterThan(0);
  });

  it('lists the applied files that drop a view without an explicit re-grant (inventory, covered by the default-privilege floor)', () => {
    const legacy = droppers.filter((f) => f <= GATE_INTRODUCED && !carriesGrantRestore(read(f), droppedViews(read(f))));
    // Not a failure — checksummed, applied, and standing on 0217's default. Printed so
    // the debt is visible and so a hyperdrive-only reader of one of these views is
    // not a surprise.
    console.info(`[view-grant] ${legacy.length} applied migration(s) drop a view and rely on default privileges: ${legacy.join(', ')}`);
    expect(Array.isArray(legacy)).toBe(true);
  });

  it.each(droppers.filter((f) => f > GATE_INTRODUCED))('%s (newer than the gate) re-grants what it drops', (file) => {
    const sql = read(file);
    const views = droppedViews(sql);
    expect(
      carriesGrantRestore(sql, views),
      `${file} drops ${views.join(', ')} and never re-grants it — copy the DO block from 0191 or ${GATE_INTRODUCED} (docs/bugs/0824)`,
    ).toBe(true);
  });

  it('the matcher sees the 0189 shape (would be RED without the ratchet date)', () => {
    const sql = read('0189_drop_so_processing_date.sql');
    expect(droppedViews(sql)).toContain('scm.mfg_sales_orders_with_payment_totals');
    expect(carriesGrantRestore(sql, droppedViews(sql))).toBe(false);
  });
});
