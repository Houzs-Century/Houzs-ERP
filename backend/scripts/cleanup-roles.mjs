/* ALREADY RUN — DO NOT RE-RUN.
   
   Written for a one-shot data cleanup and executed in 2026-06. It is kept for the record of
   what was done to production, not as a tool.
   
   It deleted a redundant role by name. The name it was given is gone.
   
   Nothing in this repository reaches it: no npm script, no workflow, no doc,
   no import. That is deliberate now — it used to be an accident, and an
   unreferenced script whose NAME still reads as runnable is an invitation. */
// One-shot: delete a redundant role by name, ONLY if no user holds it.
// Used to remove the 0-user duplicate "Logistic Purchasing" (overlaps the
// distinct Purchaser + Logistic roles). Refuses if any user (active or not)
// still references it.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const names = TARGETS.length ? TARGETS : ["Logistic Purchasing"];

const url = readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const sql = postgres(url, { ssl: "require", prepare: false, max: 1, idle_timeout: 3 });

for (const name of names) {
  const rows = await sql`
    SELECT r.id, r.is_system,
           (SELECT count(*) FROM users u WHERE u.role_id = r.id) AS total
    FROM roles r WHERE r.name = ${name}`;
  if (!rows.length) {
    console.log(`SKIP  '${name}' — not found`);
    continue;
  }
  const { id, is_system, total } = rows[0];
  if (Number(is_system) === 1) {
    console.log(`SKIP  '${name}' (id ${id}) — system role`);
    continue;
  }
  if (Number(total) > 0) {
    console.log(`REFUSE '${name}' (id ${id}) — ${total} user(s) still hold it; reassign first`);
    continue;
  }
  await sql`DELETE FROM role_page_access WHERE role_id = ${id}`;
  await sql`DELETE FROM roles WHERE id = ${id}`;
  console.log(`DELETED '${name}' (id ${id}) + its page-access rows`);
}

await sql.end({ timeout: 3 }).catch(() => {});
process.exitCode = 0;
