// Expose the `scm` schema to Supabase PostgREST so the supabase-js SCM routes
// can reach it, and grant access to service_role ONLY (server-side; not anon,
// so the public anon key can never read SCM data). Then verify end-to-end.
//   node scripts/scm-schema/expose-scm-rest.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const dv = readFileSync(".dev.vars", "utf8");
const g = (n) => dv.match(new RegExp(`^${n}=(.+)$`, "m"))?.[1]?.trim().replace(/^"|"$/g, "");
const url = g("DATABASE_URL");
const restUrl = g("SUPABASE_URL");
const serviceKey = g("SUPABASE_SERVICE_ROLE_KEY");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 25 });
try {
  // 1) Grants — service_role only (RLS-bypassing server role used by the routes).
  await sql.unsafe(`
    GRANT USAGE ON SCHEMA scm TO service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA scm TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA scm TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA scm GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA scm GRANT ALL ON SEQUENCES TO service_role;
  `);

  // 2) Add scm to PostgREST's exposed schemas (append, never clobber).
  const cur = await sql`
    SELECT setting FROM (
      SELECT unnest(rolconfig) AS setting FROM pg_roles WHERE rolname='authenticator'
    ) s WHERE setting LIKE 'pgrst.db_schemas=%'`;
  const existing = cur[0]?.setting?.split("=")[1] || "public, graphql_public";
  const schemas = existing.split(",").map((x) => x.trim());
  if (!schemas.includes("scm")) schemas.push("scm");
  const next = schemas.join(", ");
  await sql.unsafe(`ALTER ROLE authenticator SET pgrst.db_schemas = '${next}'`);
  await sql.unsafe(`NOTIFY pgrst, 'reload config'`);
  await sql.unsafe(`NOTIFY pgrst, 'reload schema'`);
  console.log("exposed schemas now:", next);
} catch (e) {
  console.error("SETUP FAILED:", String(e?.message || e).slice(0, 250));
}
await sql.end();

// 3) Give PostgREST a moment, then verify via supabase-js over REST.
await new Promise((r) => setTimeout(r, 3000));
const sb = createClient(restUrl, serviceKey, {
  db: { schema: "scm" },
  auth: { persistSession: false },
});
const { count, error } = await sb.from("suppliers").select("*", { head: true, count: "exact" });
if (error) {
  console.error("REST VERIFY FAILED:", JSON.stringify(error).slice(0, 250));
  console.error("(if 'schema must be one of' — PostgREST reload may need a few more seconds; rerun)");
  process.exitCode = 2;
} else {
  console.log(`REST OK — scm.suppliers reachable via supabase-js (count=${count}). Foundation proven end-to-end.`);
}
