#!/usr/bin/env node
/* Trim leading/trailing whitespace off the salesperson name and debtor code on
   sales-order headers. A data-hygiene repair, found by the 2026-08-18 integrity
   sweep: 93 headers carry an `agent` like "ETHAN SOO " (trailing space) and 1
   carries a `debtor_code` with a stray space.

   WHY THIS IS SAFE — and why it is still gated like every other write.

   `agent` is a DISPLAY string; the salesperson IDENTITY is `salesperson_id`
   (scm.staff uuid), which this never touches. So trimming cannot re-point a
   commission or a scope — it only makes "ETHAN SOO " and "ETHAN SOO" stop
   reading as two salespeople in a group-by or a filter. Proven safe before
   writing: no trimmed value collides with a DIFFERENT existing spelling
   (`GROUP BY btrim(agent) HAVING count(distinct agent) > 1` returned zero on
   2026-08-18), so no row is silently merged into an unrelated name.

   Still, it is a write to a money document's header, so it carries the four
   release-discipline gates (see CLAUDE.md and repair-array-shaped-variants.mjs):

     1. MODE defaults to 'plan' — it reports and changes nothing unless
        MODE=apply is set explicitly.
     2. On apply it also requires CONFIRM=trim-so-whitespace, refused with a
        non-zero exit otherwise.
     3. It verifies on a FRESH connection and asserts the SHAPE — zero dirty
        rows remain — not a row count from the write itself.
     4. RE-RUN: idempotent. A second run finds nothing left to trim and is a
        no-op; the WHERE clause only matches a value that differs from its own
        trim, which a trimmed value never does.
*/
import { readFileSync } from "node:fs";
import postgres from "postgres";

const MODE = process.env.MODE ?? "plan";
const CONFIRM = process.env.CONFIRM ?? "";
const CONFIRM_PHRASE = "trim-so-whitespace";

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

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function census(sql) {
  const [{ agent }] = await sql`
    SELECT count(*)::int AS agent FROM scm.mfg_sales_orders
    WHERE agent IS NOT NULL AND agent <> btrim(agent)`;
  const [{ debtor }] = await sql`
    SELECT count(*)::int AS debtor FROM scm.mfg_sales_orders
    WHERE debtor_code IS NOT NULL AND debtor_code <> btrim(debtor_code)`;
  return { agent, debtor };
}

try {
  const before = await census(pg);
  console.log(`Dirty rows: agent=${before.agent}, debtor_code=${before.debtor}`);

  if (before.agent + before.debtor === 0) {
    notice("Nothing to trim — every agent/debtor_code is already clean.");
    await pg.end({ timeout: 5 });
    process.exit(0);
  }

  if (MODE !== "apply") {
    // Show a sample so the plan run is legible before anyone applies it.
    const sample = await pg`
      SELECT DISTINCT agent FROM scm.mfg_sales_orders
      WHERE agent IS NOT NULL AND agent <> btrim(agent) LIMIT 5`;
    for (const r of sample) console.log(`  would trim agent: "${r.agent}" -> "${r.agent.trim()}"`);
    notice(`PLAN: would trim ${before.agent} agent + ${before.debtor} debtor_code value(s). ` +
      `Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
    await pg.end({ timeout: 5 });
    process.exit(0);
  }

  if (CONFIRM !== CONFIRM_PHRASE) {
    console.error(`MODE=apply requires CONFIRM=${CONFIRM_PHRASE}. Refusing.`);
    await pg.end({ timeout: 5 });
    process.exit(1);
  }

  await pg`
    UPDATE scm.mfg_sales_orders SET agent = btrim(agent)
    WHERE agent IS NOT NULL AND agent <> btrim(agent)`;
  await pg`
    UPDATE scm.mfg_sales_orders SET debtor_code = btrim(debtor_code)
    WHERE debtor_code IS NOT NULL AND debtor_code <> btrim(debtor_code)`;
  await pg.end({ timeout: 5 });

  // Verify on a FRESH connection, asserting the shape: zero dirty rows remain.
  const pg2 = postgres(url, { ssl: "require", prepare: false, max: 1 });
  const after = await census(pg2);
  await pg2.end({ timeout: 5 });
  if (after.agent + after.debtor !== 0) {
    console.error(`VERIFY FAILED: ${after.agent} agent + ${after.debtor} debtor_code still dirty.`);
    process.exit(1);
  }
  notice(`APPLIED: trimmed ${before.agent} agent + ${before.debtor} debtor_code value(s). ` +
    `Fresh-connection re-read confirms zero dirty rows remain.`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  try { await pg.end({ timeout: 5 }); } catch {}
  process.exit(1);
}
