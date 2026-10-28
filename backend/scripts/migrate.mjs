#!/usr/bin/env node
/**
 * D1 migration runner — tracker-table approach.
 *
 * Why this exists:
 *   The previous `db:migrate` ran every .sql file in src/db/migrations
 *   and swallowed errors for migrations that had already been applied.
 *   With 60+ migrations that's a 3–5 minute wrangler-invocation chain
 *   even when nothing has actually changed. This script asks the
 *   database what it has, and only runs what's missing.
 *
 * Usage:
 *   node scripts/migrate.mjs              # apply only unseen migrations
 *   node scripts/migrate.mjs --baseline   # mark every file as applied
 *                                         # without executing them — run
 *                                         # this once after deploying the
 *                                         # tracker for the first time so
 *                                         # the script doesn't try to
 *                                         # re-run everything that's
 *                                         # already on remote.
 *
 *   The runner creates a `_migrations(name TEXT PRIMARY KEY,
 *   applied_at TEXT)` table on first use. Append-only audit; one row
 *   per applied migration.
 */
import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DB = "autocount-sync";
const REMOTE_FLAG = "--remote";
const DIR = "src/db/migrations";

const args = process.argv.slice(2);
const baseline = args.includes("--baseline");

function run(cmd, opts = {}) {
  return execSync(cmd, {
    stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
}

function ensureTracker() {
  const sql =
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))";
  run(
    `npx wrangler d1 execute ${DB} ${REMOTE_FLAG} --command "${sql}"`,
    { silent: true },
  );
}

function appliedSet() {
  try {
    const out = run(
      `npx wrangler d1 execute ${DB} ${REMOTE_FLAG} --json --command "SELECT name FROM _migrations"`,
      { silent: true },
    );
    const parsed = JSON.parse(out);
    const rows = parsed?.[0]?.results ?? [];
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

function recordApplied(names) {
  if (names.length === 0) return;
  // Filenames are alphanumeric + underscore + dot; no apostrophes
  // expected. Defensive escape anyway.
  const values = names
    .map((n) => `('${n.replace(/'/g, "''")}')`)
    .join(", ");
  run(
    `npx wrangler d1 execute ${DB} ${REMOTE_FLAG} --command "INSERT OR IGNORE INTO _migrations (name) VALUES ${values}"`,
    { silent: true },
  );
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

ensureTracker();

if (baseline) {
  console.log(
    `Baselining ${files.length} migration(s) as already applied (no SQL executed)…`,
  );
  recordApplied(files);
  for (const f of files) console.log(`  marked ${f}`);
  console.log(
    "\nDone. Future `npm run db:migrate` runs will only apply NEW files.",
  );
  process.exit(0);
}

const applied = appliedSet();
const pending = files.filter((f) => !applied.has(f));

if (pending.length === 0) {
  console.log(
    `Nothing to apply. ${applied.size} migration(s) already tracked on remote.`,
  );
  process.exit(0);
}

console.log(
  `Applying ${pending.length} migration(s) (${applied.size} already tracked)…`,
);
for (const f of pending) {
  console.log(`▶ ${f}`);
  run(`npx wrangler d1 execute ${DB} ${REMOTE_FLAG} --file=${join(DIR, f)}`);
  recordApplied([f]);
}
console.log(
  `\nApplied ${pending.length} migration(s). ${applied.size + pending.length} total tracked.`,
);