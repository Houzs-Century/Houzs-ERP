#!/usr/bin/env node
// Toggle the global SCM write freeze (owner 2026-08-10, go-live cutover:
// "暂时把整个 ERP 的 edit 和 create 功能也关掉 sales 有些 update").
//
// Writes app_config['scm.write_freeze']; the API middleware
// (scm/lib/write-freeze.ts) reads it with a 30s cache, so a change takes
// effect within half a minute WITHOUT a deploy. Reads stay open either way;
// owner / scm.admin always bypass.
// PER-COMPANY (owner 2026-08-10: "是 Houzs company 而已, 2990 remain") — the
// stored value is the company id list to freeze ('1' = Houzs only), or 'all'.
//   STATE=on|off   COMPANIES="1" | "all"   MESSAGE="shown to staff"
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const STATE = (process.env.STATE || "").trim().toLowerCase();
if (STATE !== "on" && STATE !== "off") { console.error("need STATE=on|off"); process.exit(2); }
const MESSAGE = (process.env.MESSAGE || "").trim() || null;
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const [before] = await sql`SELECT value, description FROM scm.app_config WHERE key = 'scm.write_freeze'`;
  log(`current: ${before ? `value=${before.value} description=${before.description ?? "-"}` : "(row absent = open)"}`);
  const COMPANIES = (process.env.COMPANIES || "1").trim() || "1";
  const value = STATE === "on" ? COMPANIES : "off";
  const description = MESSAGE
    ?? (STATE === "on"
      ? "Editing is paused while the AutoCount data migration is completed. Please do not create or change orders — ask IT when you need something updated."
      : null);
  await sql`INSERT INTO scm.app_config (key, value, description, updated_at)
    VALUES ('scm.write_freeze', ${value}, ${description}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now()`;
  const [after] = await sql`SELECT value, description FROM scm.app_config WHERE key = 'scm.write_freeze'`;
  const scope = String(after?.value ?? "off");
  log(`DONE. value=${scope} -> ${scope === "off" ? "OPEN for every company"
    : scope === "all" ? "FROZEN for EVERY company"
    : `FROZEN for company ${scope} only (others trade normally)`}`);
  log(`message: ${after?.description ?? "-"}`);
  log("takes effect within ~30s (middleware cache TTL)");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
