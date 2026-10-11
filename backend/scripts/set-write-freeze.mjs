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
// PER-MODULE — AREAS names the L2 areas to REOPEN while the rest stay frozen,
// which is the staged go-live lift. See docs/write-freeze-staged-lift.md.
//
//   STATE=on|off  COMPANIES="1"|"all"  AREAS="scm.sales.orders,..."  MESSAGE="..."
//
// VALIDATES BEFORE IT WRITES. The middleware fails CLOSED on a value it cannot
// parse — correct as a backstop, but it means a typo here would freeze both
// companies instead of doing what was intended. So the composed value is
// checked against the REAL area keys (parsed out of src/scm/index.ts) and a bad
// one is refused with a non-zero exit and a "did you mean". Nothing is written.
import postgres from "postgres";
import { readScmAreaKeys, validateFreezeValue, describeFreezeValue } from "./lib/scm-area-keys.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const STATE = (process.env.STATE || "").trim().toLowerCase();
if (STATE !== "on" && STATE !== "off") { console.error("need STATE=on|off"); process.exit(2); }
const MESSAGE = (process.env.MESSAGE || "").trim() || null;
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const fail = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); };

const COMPANIES = (process.env.COMPANIES || "1").trim() || "1";
const AREAS = (process.env.AREAS || "").trim();

/* Compose first, validate the COMPOSED string — the middleware only ever sees
   this one text field, so that is the thing that has to be right. */
const value = STATE === "on" ? (AREAS ? `${COMPANIES} - ${AREAS}` : COMPANIES) : "off";

const areaKeys = readScmAreaKeys();
const parsed = validateFreezeValue(value, areaKeys);
if (!parsed.ok) {
  fail(`refusing to write ${JSON.stringify(value)} — the API could not parse it, and would freeze EVERY company as a result.`);
  for (const p of parsed.problems) fail(`  ${p}`);
  fail(`valid areas: ${[...areaKeys].sort().join(", ")}`);
  process.exit(2);
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const [before] = await sql`SELECT value, description FROM scm.app_config WHERE key = 'scm.write_freeze'`;
  log(`current: ${before ? `value=${before.value} description=${before.description ?? "-"}` : "(row absent = open)"}`);
  log(`writing: ${JSON.stringify(value)} -> ${describeFreezeValue(parsed)}`);

  const description = MESSAGE
    ?? (STATE === "on"
      ? "Editing is paused while the AutoCount data migration is completed. Please do not create or change orders — ask IT when you need something updated."
      : null);
  await sql`INSERT INTO scm.app_config (key, value, description, updated_at)
    VALUES ('scm.write_freeze', ${value}, ${description}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now()`;

  const [after] = await sql`SELECT value, description FROM scm.app_config WHERE key = 'scm.write_freeze'`;
  const stored = String(after?.value ?? "off");
  log(`DONE. value=${stored} -> ${describeFreezeValue(validateFreezeValue(stored, areaKeys))}`);
  if (parsed.open.length) {
    const shut = [...areaKeys].filter((a) => !parsed.open.includes(a)).sort();
    log(`still paused (${shut.length}): ${shut.join(", ")}`);
    log("routers with no L2 area key (hr, staff, localities, currencies, categories, state-warehouse-mappings, pos-cart, personal-quick-picks, sales-analysis) stay paused regardless");
  }
  log(`message: ${after?.description ?? "-"}`);
  log("takes effect within ~30s (middleware cache TTL)");
  log("verify with the 'SCM write freeze — status (read-only)' workflow, or GET /api/scm/write-freeze");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
