#!/usr/bin/env node
/* probe-audit-id-fields — READ-ONLY. Which History fields hold a raw record id.
 *
 * The History drawer printed "Supplier Id d930541c-..." (owner 2026-11-17).
 * Before mapping ids to names we need the real population: which field names in
 * scm.entity_audit_log / scm.mfg_so_audit_log carry a uuid value, per entity
 * type, and how often. Prints field NAMES and COUNTS only: no values, no
 * document numbers, no money (the Actions log is public).
 *
 * MODE: there is none to set. Every statement is a SELECT; no transaction, no
 * INSERT / UPDATE / DELETE anywhere in the file.
 * RE-RUN: a second run prints the same report against whatever is there then.
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(2); }
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

async function report(table, typeExpr) {
  const rows = await pg.unsafe(`
    select ${typeExpr} as entity_type, ch->>'field' as field, count(*)::int as n
      from scm.${table} t, jsonb_array_elements(
        case when jsonb_typeof(t.field_changes) = 'array' then t.field_changes else '[]'::jsonb end) ch
     where coalesce(ch->>'to', '') ~ '${UUID}' or coalesce(ch->>'from', '') ~ '${UUID}'
     group by 1, 2 order by 3 desc`);
  console.log(`\n== ${table}: fields holding a uuid (${rows.length} field/type pairs)`);
  for (const r of rows) console.log(`  ${String(r.entity_type).padEnd(24)} ${String(r.field).padEnd(32)} ${r.n}`);
}

try {
  await report("entity_audit_log", "t.entity_type");
  await report("mfg_so_audit_log", "'sales_order'");
} finally {
  await pg.end();
}
