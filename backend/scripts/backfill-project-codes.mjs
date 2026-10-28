#!/usr/bin/env node
/**
 * Rewrite every project's `code` to the new format:
 *
 *   YYYY-MM-{ORGANIZER|SOLO}-{STATE}-{VENUE}-{BRAND}
 *
 * Year + month come from `start_date` (or `created_at` if start_date
 * is null). State / venue / brand are required — projects missing any
 * are skipped with a warning so the admin can fix the data and re-run.
 * Organizer null → literal `SOLO`. Slugging: uppercase, replace
 * non-alphanumeric with `-`, trim leading/trailing `-`.
 *
 * Duplicates within the new format get `-2`, `-3`, … suffixes
 * (assigned in id order so the lowest-id keeps the bare base code).
 *
 * Usage:
 *   node scripts/backfill-project-codes.mjs [--local] [--dry]
 *
 * Defaults to --remote. --dry prints the planned UPDATEs without
 * executing.
 *
 * Idempotency:
 *   Re-running produces the same final codes. The first run rewrites
 *   legacy `PRJ-YYYY-NNN` rows; subsequent runs are no-ops because the
 *   computed code already matches the row's current code.
 */
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = "autocount-sync";
const argv = process.argv.slice(2);
const local = argv.includes("--local");
const dry = argv.includes("--dry");
const FLAG = local ? "--local" : "--remote";

function wrangler(cmd, opts = {}) {
  return execSync(`npx wrangler d1 execute ${DB} ${FLAG} ${cmd}`, {
    stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
}

function queryJson(sql) {
  const out = wrangler(`--json --command "${sql.replace(/"/g, '\\"')}"`, { silent: true });
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? [];
}

function slug(s) {
  return (s ?? "")
    .toString()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveCode(row) {
  const state = slug(row.state);
  const venue = slug(row.venue);
  const brand = slug(row.brand);
  if (!state || !venue || !brand) return null;
  const organizer = slug(row.organizer) || "SOLO";
  const anchor = row.start_date || row.created_at;
  const d = new Date(anchor);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}-${organizer}-${state}-${venue}-${brand}`;
}

const projects = queryJson(
  "SELECT id, code, organizer, state, venue, brand, start_date, created_at FROM projects ORDER BY id"
);
if (projects.length === 0) {
  console.error("No projects found.");
  process.exit(1);
}

console.log(`Computing new codes for ${projects.length} project(s)…`);

const skipped = [];
const planned = []; // [{ id, base }]
for (const p of projects) {
  const base = deriveCode(p);
  if (!base) {
    skipped.push(p);
    continue;
  }
  planned.push({ id: p.id, oldCode: p.code, base });
}

// Assign disambiguating suffixes — lowest-id keeps the bare base.
const counts = new Map();
const updates = [];
for (const p of planned) {
  const n = (counts.get(p.base) ?? 0) + 1;
  counts.set(p.base, n);
  const newCode = n === 1 ? p.base : `${p.base}-${n}`;
  if (newCode !== p.oldCode) updates.push({ id: p.id, oldCode: p.oldCode, newCode });
}

console.log(
  `\n${updates.length} project(s) need an update. ${planned.length - updates.length} already on the new format. ${skipped.length} skipped (missing state/venue/brand).`
);
if (skipped.length > 0) {
  console.log("\nSkipped projects (fix the data and re-run):");
  for (const p of skipped) {
    console.log(`  id=${p.id} code=${p.code} — state=${p.state ?? "?"} venue=${p.venue ?? "?"} brand=${p.brand ?? "?"}`);
  }
}

if (updates.length === 0) {
  console.log("\nNothing to do. Exiting.");
  process.exit(0);
}

if (dry) {
  console.log("\n--- DRY RUN — first 20 planned updates ---");
  for (const u of updates.slice(0, 20)) {
    console.log(`  id=${u.id}: ${u.oldCode} → ${u.newCode}`);
  }
  if (updates.length > 20) console.log(`  …and ${updates.length - 20} more.`);
  process.exit(0);
}

// Batch UPDATEs. SQLite UPDATE with CASE is the fastest way to do
// many rows in one round trip. Each chunk's SQL is written to a temp
// file and passed via --file so Windows' 8 KB argv cap doesn't
// truncate the command line on bigger projects.
const tmpDir = mkdtempSync(join(tmpdir(), "houzs-codes-"));
try {
  const CHUNK = 50;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const ids = slice.map((u) => u.id).join(",");
    const cases = slice
      .map((u) => `  WHEN ${u.id} THEN '${u.newCode.replace(/'/g, "''")}'`)
      .join("\n");
    const sql =
      `UPDATE projects SET\n  code = CASE id\n${cases}\n  END,\n  updated_at = datetime('now')\nWHERE id IN (${ids});\n`;
    const sqlPath = join(tmpDir, `chunk-${i}.sql`);
    writeFileSync(sqlPath, sql, "utf8");
    try {
      wrangler(`--file=${sqlPath}`);
    } finally {
      try { unlinkSync(sqlPath); } catch {}
    }
    console.log(`  applied ${slice.length} updates (${i + slice.length}/${updates.length})`);
  }
} finally {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log(`\nDone. Rewrote ${updates.length} project codes.`);
