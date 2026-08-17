/* SPENT PROBE — kept for the record, not as a tool.
   
   This was a one-off check that supabase-js could reach the Houzs project at all.
   It answered its question at the time and nothing reaches it now: no npm
   script, no workflow, no doc, no import.
   
   It is read-only, so running it is not dangerous — but it probes an
   environment that has since moved, so what it prints is unlikely to mean
   what its output says it means. */
// One-off: verify supabase-js / PostgREST can reach the Houzs Supabase using
// the keys in .dev.vars. Confirms the foundation for the 2990's SCM port.
//   node scripts/test-supabase-rest.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function fromDevVars(name) {
  if (process.env[name]) return process.env[name];
  try {
    const m = readFileSync(".dev.vars", "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
    return m?.[1];
  } catch {
    return undefined;
  }
}

const url = fromDevVars("SUPABASE_URL");
const serviceKey = fromDevVars("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .dev.vars");
  process.exit(1);
}
console.log("URL:", url);
console.log("service key role:", JSON.parse(atob(serviceKey.split(".")[1])).role);

const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 1) Can we reach PostgREST + read an existing Houzs table (service_role bypasses RLS)?
const { count, error } = await sb
  .from("users")
  .select("id", { head: true, count: "exact" });

if (error) {
  console.error("QUERY FAILED:", JSON.stringify(error, null, 2));
  process.exit(2);
}
console.log(`OK — PostgREST reachable. users count = ${count}`);

// 2) Confirm the SCM tables are NOT there yet (expected — we create them later).
const { error: scmErr } = await sb.from("mfg_suppliers").select("id", { head: true, count: "exact" });
console.log(
  scmErr
    ? `mfg_suppliers: not present yet (expected) — ${scmErr.code || scmErr.message}`
    : "mfg_suppliers: ALREADY EXISTS (unexpected)",
);
console.log("DONE — supabase-js foundation verified.");
