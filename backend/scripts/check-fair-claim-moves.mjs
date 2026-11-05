// Read-only list of the orders the morning auto-claim moved (scm/lib/fair-claim.ts):
// its History rows name each order, the booth it left, the booth it joined and the bill.
// One SELECT. Exits 0 for every real answer, including no moves.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const days = Number(process.env.DAYS ?? 2);
const sql = postgres(url, { max: 1, prepare: false, connection: { default_transaction_read_only: "on" } });
try {
  const rows = await sql`
    SELECT so_doc_no, created_at, field_changes, note
      FROM scm.mfg_so_audit_log
     WHERE action = 'UPDATE_FAIR' AND source = 'nightly'
       AND note LIKE 'The event''s sales report carries bill%'
       AND created_at > now() - make_interval(days => ${days})
     ORDER BY created_at, so_doc_no`;
  console.log(`auto-claim moves in the last ${days} days: ${rows.length}`);
  for (const r of rows) {
    const fair = (r.field_changes ?? []).find((c) => c.field === "fair");
    console.log(`${new Date(r.created_at).toISOString()} ${r.so_doc_no} | ${fair?.from ?? "?"} -> ${fair?.to ?? "?"} | ${r.note}`);
  }
} finally {
  await sql.end();
}
