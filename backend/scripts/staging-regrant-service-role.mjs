#!/usr/bin/env node
/* STAGING ONLY. Tables and views the Worker's role (service_role) cannot read.

   THE SHAPE. On 2026-11-06 the staging Procurement overview failed with
   "permission denied for table po_receipt_so_assignments", although migration
   20261019T1200 grants service_role on that table. The Worker reads through
   PostgREST as service_role, so any relation without that grant fails the
   page that reads it.

   WHAT THIS DOES. Lists every table, partitioned table, view and materialized
   view in `scm` and `public` that service_role cannot SELECT, with its owner
   and ACL, and the ledger row of the migration above. On apply it grants
   SELECT, INSERT, UPDATE, DELETE on each listed table and SELECT on each
   listed view, which is what the migrations grant on production.

   WHAT IT REFUSES. A DATABASE_URL that is not the staging project.

   MODE=plan (default) prints the list and writes nothing. MODE=apply needs
   CONFIRM="REGRANT STAGING", grants in one transaction, and re-reads on a
   fresh connection that service_role can SELECT every relation it listed.

   REVERSAL: REVOKE the same privileges on the names the plan printed.
   RE-RUN: inert. Keyed on relations service_role cannot SELECT, which the
   grant ends. */
import postgres from 'postgres';

const STAGING_REF = 'minnapsemfzjmtvnnvdd';
const PROD_REF = 'anogrigyjbduyzclzjgn';
const CONFIRM_PHRASE = 'REGRANT STAGING';
const WATCHED_MIGRATION = '20261019T1200_scm_po_receipt_so_assignments.sql';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
if (!DSN.includes(STAGING_REF) || DSN.includes(PROD_REF)) {
  console.error(`REFUSE: DATABASE_URL is not the staging project (${STAGING_REF})`);
  process.exit(2);
}
const isApply = (process.env.MODE || 'plan').toLowerCase() === 'apply';
if (isApply && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const say = (message) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${message}` : message);
const connect = () => postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const findUnreadable = (client) => client`
  SELECT n.nspname AS schema_name, c.relname AS relation_name, c.relkind AS kind,
         c.relowner::regrole::text AS owner, COALESCE(c.relacl::text, '(default)') AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('scm', 'public') AND c.relkind IN ('r', 'p', 'v', 'm')
     AND NOT has_table_privilege('service_role', c.oid, 'SELECT')
   ORDER BY 1, 2`;

const isTableKind = (kind) => kind === 'r' || kind === 'p';
const quoted = ({ schema_name: schemaName, relation_name: relationName }) =>
  `"${schemaName.replaceAll('"', '""')}"."${relationName.replaceAll('"', '""')}"`;

const planClient = connect();
const [{ current_user: currentUser }] = await planClient`SELECT current_user`;
const ledger = await planClient`
  SELECT filename, checksum, applied_at FROM _pg_migrations WHERE filename = ${WATCHED_MIGRATION}`;
const unreadable = await findUnreadable(planClient);
const roleReach = await planClient`
  SELECT r.rolname AS role_name,
         has_table_privilege(r.rolname, 'scm.po_receipt_so_assignments', 'SELECT') AS can_read_watched,
         COUNT(*) FILTER (WHERE NOT has_table_privilege(r.rolname, c.oid, 'SELECT'))::int AS unreadable_count,
         COUNT(*)::int AS relation_count
    FROM pg_roles r
    CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE r.rolname IN ('service_role', 'authenticated', 'anon')
     AND n.nspname = 'scm' AND c.relkind IN ('r', 'p', 'v', 'm')
   GROUP BY r.rolname ORDER BY r.rolname`;
const restCallers = await planClient`
  SELECT s.userid::regrole::text AS role_name,
         SUM(s.calls)::bigint AS scm_calls,
         SUM(s.calls) FILTER (WHERE s.query ILIKE '%po_receipt_so_assignments%')::bigint AS watched_calls
    FROM extensions.pg_stat_statements s
   WHERE s.query ILIKE '%"scm"."%'
   GROUP BY 1 ORDER BY 2 DESC`.catch((error) => [{ role_name: `pg_stat_statements unreadable: ${error.message}`, scm_calls: 0, watched_calls: 0 }]);
await planClient.end();

for (const { role_name: roleName, scm_calls: scmCalls, watched_calls: watchedCalls } of restCallers) {
  say(`REST-style scm queries run as ${roleName}: ${scmCalls} call(s), ${watchedCalls ?? 0} on po_receipt_so_assignments`);
}
for (const { role_name: roleName, can_read_watched: canReadWatched, unreadable_count: unreadableCount, relation_count: relationCount } of roleReach) {
  say(`role ${roleName}: po_receipt_so_assignments readable=${canReadWatched}; cannot read ${unreadableCount} of ${relationCount} scm relations`);
}

say(`mode=${isApply ? 'APPLY' : 'PLAN (writes nothing)'} connected as ${currentUser}`);
say(`ledger ${WATCHED_MIGRATION}: ${ledger.length ? `applied ${ledger[0].applied_at.toISOString()} ${ledger[0].checksum}` : 'NOT IN LEDGER'}`);
console.log(`=== service_role CANNOT SELECT: ${unreadable.length} relation(s) ===`);
for (const relation of unreadable) {
  say(`  ${quoted(relation)} kind=${relation.kind} owner=${relation.owner} acl=${relation.acl}`);
}

if (!isApply) {
  console.log(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
  process.exit(0);
}
if (!unreadable.length) { say('Nothing to grant.'); process.exit(0); }

const writeClient = connect();
await writeClient.begin(async (transaction) => {
  for (const relation of unreadable) {
    const privileges = isTableKind(relation.kind) ? 'SELECT, INSERT, UPDATE, DELETE' : 'SELECT';
    await transaction.unsafe(`GRANT ${privileges} ON ${quoted(relation)} TO service_role`);
  }
});
await writeClient.end();

const verifyClient = connect();
const stillUnreadable = await findUnreadable(verifyClient);
const listedNames = new Set(unreadable.map(quoted));
const stillListed = stillUnreadable.filter((relation) => listedNames.has(quoted(relation)));
await verifyClient.end();

console.log('=== VERIFIED ON A FRESH CONNECTION ===');
if (stillListed.length) {
  for (const relation of stillListed) console.log(`::error::still unreadable ${quoted(relation)}`);
  process.exit(1);
}
say(`service_role can now SELECT all ${unreadable.length} relation(s).`);
