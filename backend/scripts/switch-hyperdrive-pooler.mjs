/* ALREADY RUN — DO NOT RE-RUN.
   
   Written for a one-shot prod config change and executed in 2026-06. It is kept for the record of
   what was done to production, not as a tool.
   
   It switched the prod Hyperdrive config between Supabase poolers. Same caution: it sets, it does not read first.
   
   Nothing in this repository reaches it: no npm script, no workflow, no doc,
   no import. That is deliberate now — it used to be an accident, and an
   unreferenced script whose NAME still reads as runnable is an invitation. */
// One-shot: switch the prod Hyperdrive config between Supabase poolers to fix
// the ~20s connection-establishment latency on multi-query endpoints (inbox).
// Default -> TRANSACTION pooler (6543), which multiplexes without spinning up a
// dedicated backend per connection. The Postgres client uses prepare:false +
// fetch_types:false (pg.ts), so 6543 is fully supported.
//
//   node scripts/switch-hyperdrive-pooler.mjs           # -> 6543 (transaction)
//   node scripts/switch-hyperdrive-pooler.mjs --revert  # -> 5432 (session)
//
// Builds the full connection string from .dev.vars by swapping the port
// (wrangler's --origin-port alone needs the whole origin). --caching-disabled
// is re-passed so the read-your-writes fix is preserved across the update.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const CONFIG_ID = "f0f9bd0d6b924496981b97b9ebcfe898"; // houzs-erp-pg-v2
const ACCOUNT_ID = "816e457307d7fa0491c2a08a72ad5dcd"; // hello@houzscentury.com
const PORT = process.argv.includes("--revert") ? 5432 : 6543;

const raw = (readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/) || [])[1] || "";
if (!raw) {
  console.error(".dev.vars DATABASE_URL not found");
  process.exit(1);
}
// Swap only the host port (…@host:5432/…) — leaves user/password/db intact.
const url = raw.replace(/(@[^/@:]+:)\d+/, `$1${PORT}`);
console.log(
  `Switching Hyperdrive ${CONFIG_ID} -> port ${PORT} ` +
    `(${PORT === 6543 ? "transaction" : "session"} pooler)`,
);
execSync(
  `npx wrangler hyperdrive update ${CONFIG_ID} --connection-string "${url}" --caching-disabled`,
  { stdio: "inherit", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID } },
);
