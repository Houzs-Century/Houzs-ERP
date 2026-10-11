#!/usr/bin/env node
// Read-only report on the SCM write freeze — what is frozen, right now.
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW. The freeze is the switch between
// "staff cannot save" and "staff can save", and during go-live the owner makes
// live go/no-go calls on it. Until this existed, reading it meant either a SQL
// console against production or asking an agent — the first puts the production
// DSN in front of a person for a SELECT, the second means the answer to "what is
// frozen?" depends on somebody being awake. (Repo rule: build the check, never
// ask the owner to run a query. Twin of backend/scripts/check-soak-gate.mjs.)
//
// The in-app twin is GET /api/scm/write-freeze, for when a session is already
// open. This one needs nothing but the Actions button.
//
// Strictly one SELECT. No DDL, no writes, no transaction, and it NEVER writes
// the row — turning the freeze on or off is set-write-freeze.mjs, deliberately a
// different script with a different workflow. Exits 0 for every legitimate
// answer, including "the value is broken": a red job would read as "the check
// broke", and the ANSWER is the output. Only an unreachable database exits
// non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { readScmAreaKeys, validateFreezeValue, describeFreezeValue } from "./lib/scm-area-keys.mjs";

const KEY = "scm.write_freeze";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
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

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARNING: ${m}`);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const rows = await sql`
    SELECT value, description, updated_at
    FROM scm.app_config
    WHERE key = ${KEY}
  `;

  if (rows.length === 0) {
    /* Evidence, not a setting: an absent row is a real answer (migration 0272
       seeds 'off', so absent means open). Never insert it to tidy the output. */
    log(`${KEY}: ROW ABSENT -> OPEN. Every company can save.`);
    await sql.end();
    return;
  }

  const [row] = rows;
  const areaKeys = readScmAreaKeys();
  const parsed = validateFreezeValue(row.value, areaKeys);

  log(`${KEY} = ${JSON.stringify(row.value)}   (updated ${row.updated_at?.toISOString?.() ?? row.updated_at})`);
  log(`MEANS: ${describeFreezeValue(parsed)}`);
  log(`staff message: ${row.description ?? "(default)"}`);

  if (!parsed.ok) {
    /* The value is present but the middleware cannot read it, so it FREEZES
       EVERY COMPANY (fail closed). Say that loudly — this is the one state an
       operator must not have to infer. */
    warn(
      "This value is NOT parseable. The API fails CLOSED, so EVERY company is "
      + "frozen right now, including any that should be trading.",
    );
    for (const p of parsed.problems) warn(`  ${p}`);
    warn("Fix with the 'SCM write freeze (on/off)' workflow, or the rollback UPDATE in docs/write-freeze-staged-lift.md");
  }

  if (parsed.scope !== "off") {
    const shut = [...areaKeys].filter((a) => !parsed.open.includes(a)).sort();
    log(`areas still PAUSED (${shut.length}): ${shut.join(", ")}`);
    log(`areas REOPENED (${parsed.open.length}): ${parsed.open.length ? parsed.open.join(", ") : "none"}`);
    log(
      "note: routers with no L2 area key (hr, staff, localities, currencies, categories, "
      + "state-warehouse-mappings, pos-cart, personal-quick-picks, sales-analysis) cannot be "
      + "lifted individually and stay paused until the company is unfrozen.",
    );
  }

  log("enforcement trails this row by up to 30s (middleware cache TTL)");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
