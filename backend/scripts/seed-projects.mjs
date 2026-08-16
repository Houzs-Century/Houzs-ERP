#!/usr/bin/env node
/**
 * Seed projects + finance lines from a TSV exported from the team's
 * Google Sheet (the historical "A42" tracker).
 *
 * Usage:
 *   node scripts/seed-projects.mjs <tsv-file> [--remote|--local] [--dry]
 *
 * Defaults to --local. --dry prints the generated SQL without executing.
 *
 * Idempotency:
 *   - Reads existing project codes from the target DB; rows whose code
 *     already exists are skipped.
 *   - Within a single import, code collisions (or rows whose code-suffix
 *     mismatches the actual brand) are auto-disambiguated by replacing
 *     the suffix with the row's brand and, if that still collides,
 *     appending -2, -3, …
 *
 * Owner:
 *   created_by + pic_id resolve to the user with email `OWNER_EMAIL`.
 *   Override via OWNER_EMAIL=… env if you want a different owner.
 */
import { deriveProjectName } from './lib/project-naming.mjs';
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";

const DB = "autocount-sync";
const argv = process.argv.slice(2);
const tsvPath = argv.find((a) => !a.startsWith("--"));
if (!tsvPath) {
  console.error("Usage: node scripts/seed-projects.mjs <tsv-file> [--remote|--local] [--dry]");
  process.exit(1);
}
const remote = argv.includes("--remote");
const dry = argv.includes("--dry");
const FLAG = remote ? "--remote" : "--local";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "nijammohd12@gmail.com";

const VALID_BRANDS = new Set([
  "AKEMI", "ZANOTTI", "DUNLOPILLO", "ERGOTEX", "MY SOFA FACTORY", "AKEMI C&C",
]);
const STAGE_BY_PROGRESS = {
  COMPLETED: "completed",
  "IN PROGRESS": "live",
  "": "setup",
};
const EVENT_TYPE_ID = { SOLO: 2, EXHIBITION: 1 };

function wrangler(cmd, opts = {}) {
  return execSync(
    `npx wrangler d1 execute ${DB} ${FLAG} ${cmd}`,
    { stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" },
  );
}

function queryJson(sql) {
  const out = wrangler(`--json --command "${sql.replace(/"/g, '\\"')}"`, { silent: true });
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? [];
}

function sqlStr(s) {
  if (s == null) return "NULL";
  return `'${String(s).replace(/'/g, "''")}'`;
}
function sqlNum(n) {
  if (n == null || n === "" || Number.isNaN(n)) return "NULL";
  return String(n);
}

function parseDate(s) {
  // DD/MM/YYYY → YYYY-MM-DD
  const m = String(s ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseAmount(s) {
  // Strip currency prefix ("RM ", "RM"), thousands separators, and
  // surrounding whitespace. Negative values stay negative — the
  // emitter ignores them anyway.
  const t = String(s ?? "")
    .replace(/^\s*RM\s*/i, "")
    .replace(/,/g, "")
    .trim();
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

function slug(s) {
  return String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9&]+/g, "");
}

function parseTsv(path) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = lines[0].split("\t").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    const row = {};
    headers.forEach((h, j) => (row[h] = (cells[j] ?? "").trim()));
    rows.push(row);
  }
  return rows;
}

// Pick the first non-empty column from a list of aliases. Lets the
// same script handle multiple sheet exports — early sheets used
// "TOTAL SALES (RM)" while newer ones use "SALES (RM)", etc.
function pick(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== "") return v;
  }
  return "";
}

// Stage from start_date when the sheet doesn't carry STATUS / PROGRESS.
// Past events → completed, current → live, future → setup. Matches the
// stage enum after mig 053.
function stageFromDates(startIso, endIso) {
  const today = new Date().toISOString().slice(0, 10);
  if (endIso && endIso < today) return "completed";
  if (startIso && startIso > today) return "setup";
  return "live";
}

// Compute the row's natural code (after brand-suffix correction)
// before any within-batch dedupe. The caller checks this against
// the DB set to decide skip-vs-insert; when inserting, buildCode
// then suffixes for within-batch collisions only.
function naturalCode(row) {
  const sheetCode = pick(row, "A42", "CODE");
  const brand = row["BRAND"];
  const venue = pick(row, "VENUE", "EVENT VENUE");
  if (sheetCode) {
    const lastDash = sheetCode.lastIndexOf("-");
    return lastDash > 0
      ? `${sheetCode.slice(0, lastDash)}-${slug(brand)}`
      : `${sheetCode}-${slug(brand)}`;
  }
  // Synthesise from organizer / state / venue / brand for sheets
  // that don't carry their own code column.
  const dateMatch = String(row["START DATE"] ?? "").match(/^\d{2}\/(\d{2})\/(\d{4})$/);
  const ym = dateMatch ? `${dateMatch[2]}-${dateMatch[1]}` : "0000-00";
  return `${ym}-${slug(row["ORGANIZER"])}-${slug(row["STATE"])}-${slug(venue)}-${slug(brand)}`;
}

// Within-batch collision dedupe: keep the natural code if free,
// otherwise append -2, -3, … `takenCodes` should already hold the
// DB code set (so bumped suffixes don't accidentally hit a real row).
function buildCode(base, takenCodes) {
  let code = base;
  let n = 2;
  while (takenCodes.has(code)) {
    code = `${base}-${n++}`;
  }
  takenCodes.add(code);
  return code;
}

function buildName(row) {
  /* The canonical format lives in ONE place now — scripts/lib/project-naming.mjs,
     pinned to src/services/project-naming.ts by tests/projectNamingMirror.test.ts.
     It used to be hand-copied here under a comment saying it must match, and it
     did not: this function had no solo branch, so a row with EVENT TYPE = SOLO
     and a named ORGANIZER got the organizer in its name from the seed and the
     literal SOLO from the app — while the SAME row got event_type_id 2 twelve
     lines below. Re-seeds could not converge, which is what the comment asked
     for. */
  return deriveProjectName({
    state: row["STATE"],
    brand: row["BRAND"],
    organizer: row["ORGANIZER"],
    venue: pick(row, "VENUE", "EVENT VENUE"),
    event_type_slug: row["EVENT TYPE"],
  });
}

function deriveStage(row, startIso, endIso) {
  const status = (row["STATUS"] ?? "").toUpperCase();
  const progress = (row["PROGRESS"] ?? "").toUpperCase();
  // Sheets without STATUS/PROGRESS fall back to a date-based stage.
  if (!status && !progress) return stageFromDates(startIso, endIso);
  if (status && status !== "CONFIRMED") return "draft";
  return STAGE_BY_PROGRESS[progress] ?? stageFromDates(startIso, endIso);
}

// ── 1. Resolve owner ──────────────────────────────────────────
console.log(`▶ Looking up owner ${OWNER_EMAIL} on ${remote ? "remote" : "local"}…`);
const ownerRows = queryJson(`SELECT id FROM users WHERE email = '${OWNER_EMAIL}'`);
if (ownerRows.length === 0) {
  console.error(`No user found for ${OWNER_EMAIL}. Set OWNER_EMAIL env to override.`);
  process.exit(1);
}
const ownerId = ownerRows[0].id;
console.log(`  owner_id=${ownerId}`);

// ── 2. Existing project codes (skip-on-duplicate) ─────────────
console.log("▶ Reading existing project codes…");
const existing = new Set(
  queryJson("SELECT code FROM projects WHERE code IS NOT NULL")
    .map((r) => r.code),
);
console.log(`  ${existing.size} existing project codes on remote`);

// ── 3. Existing supplier codes (DREAMART, etc. become contractor FKs) ─
const supplierByCode = new Map();
for (const r of queryJson("SELECT id, code FROM suppliers WHERE code IS NOT NULL")) {
  supplierByCode.set(r.code, r.id);
}

// ── 4. Parse TSV ──────────────────────────────────────────────
const rows = parseTsv(tsvPath);
console.log(`▶ Parsed ${rows.length} row(s) from ${basename(tsvPath)}`);

// Codes used in this batch (start with what's already in DB so newly
// generated suffixes don't collide with existing rows either).
const taken = new Set(existing);
const contractorsToInsert = new Set();

const projectStmts = [];
const financeStmts = [];
const rollupStmts = [];

let skipped = 0;
let queued = 0;

for (const row of rows) {
  const startDate = parseDate(row["START DATE"]);
  const endDate = parseDate(row["END DATE"]);
  if (!startDate) {
    console.warn(`  skip: bad start date "${row["START DATE"]}" (organizer=${row["ORGANIZER"]})`);
    skipped++;
    continue;
  }

  const brand = (row["BRAND"] ?? "").trim();
  if (!VALID_BRANDS.has(brand)) {
    console.warn(`  skip: unknown brand "${brand}" (code=${row["A42"]})`);
    skipped++;
    continue;
  }

  // Two-phase code resolution. (1) Natural code = brand-corrected
  // sheet code or synthesised stem. If that already lives on remote,
  // skip the row entirely — re-seeds are idempotent. (2) Otherwise,
  // dedupe the natural code against in-batch collisions only.
  const base = naturalCode(row);
  if (existing.has(base)) {
    skipped++;
    continue;
  }
  const code = buildCode(base, taken);

  const name = buildName(row);
  const stage = deriveStage(row, startDate, endDate);
  const eventTypeId = EVENT_TYPE_ID[(row["EVENT TYPE"] ?? "").toUpperCase()] ?? null;
  const sizeSqm = parseAmount(row["SIZE (SQM)"]);
  const boothNo = row["BOOTH NO"] ? row["BOOTH NO"].trim() : null;
  const organizer = row["ORGANIZER"] ? row["ORGANIZER"].trim() : null;
  const state = row["STATE"] ? row["STATE"].trim() : null;
  const venue = pick(row, "VENUE", "EVENT VENUE") || null;
  const gcalId = row["GCAL ID"] ? row["GCAL ID"].trim() : null;

  // contractor_id was dropped from projects in mig 053 (the stage-rebuild).
  // Keep contractor as text inside notes so the data lands somewhere
  // reachable; suppliers table still gets upserted for future reuse.
  const contractor = (row["CONTRACTOR"] ?? "").trim();
  if (contractor) {
    const ccode = slug(contractor);
    if (!supplierByCode.has(ccode)) {
      contractorsToInsert.add(JSON.stringify({ code: ccode, name: contractor }));
    }
  }
  const noteParts = [];
  if (contractor) noteParts.push(`Contractor: ${contractor}`);
  if (gcalId) noteParts.push(`GCAL: ${gcalId}`);
  const notes = noteParts.length ? noteParts.join("\n") : null;

  // Emit the project insert. event_type_id is hard-coded from the
  // event_type lookup seeded by mig 021 (1=exhibition, 2=solo).
  projectStmts.push(
    `INSERT INTO projects (
      code, name, stage,
      start_date, end_date,
      organizer, state, venue, brand,
      event_type_id, booth_no, size_sqm,
      notes,
      pic_id, created_by
    ) VALUES (
      ${sqlStr(code)}, ${sqlStr(name)}, ${sqlStr(stage)},
      ${sqlStr(startDate)}, ${sqlStr(endDate)},
      ${sqlStr(organizer)}, ${sqlStr(state)}, ${sqlStr(venue)}, ${sqlStr(brand)},
      ${sqlNum(eventTypeId)}, ${sqlStr(boothNo)}, ${sqlNum(sizeSqm)},
      ${sqlStr(notes)},
      ${sqlNum(ownerId)}, ${sqlNum(ownerId)}
    );`
  );
  // Pull ledger amounts. Sheets vary on the column name — tolerate
  // both the legacy "TOTAL SALES (RM)" and the newer "SALES (RM)".
  const sales = parseAmount(pick(row, "TOTAL SALES (RM)", "SALES (RM)"));
  const rental = parseAmount(row["RENTAL (RM)"]);
  const cogs = parseAmount(row["COGS (RM)"]);
  const setupCost = parseAmount(row["SETUP COST (RM)"]);
  const projectIdExpr = `(SELECT id FROM projects WHERE code = ${sqlStr(code)})`;

  const pushLine = (kind, category, amount, description, occurredAt) => {
    financeStmts.push(
      `INSERT INTO project_finance_lines (project_id, kind, category, description, amount, occurred_at, created_by)
       VALUES (${projectIdExpr}, ${sqlStr(kind)}, ${sqlStr(category)}, ${sqlStr(description)}, ${amount}, ${sqlStr(occurredAt)}, ${ownerId});`
    );
  };

  if (sales != null && sales > 0) {
    pushLine("income", "sales", sales, "Total sales (seeded)", endDate ?? startDate);
  }
  if (rental != null && rental > 0) {
    pushLine("cost", "rental", rental, "Rental (seeded)", startDate);
  }
  if (cogs != null && cogs > 0) {
    pushLine("cost", "cogs", cogs, "COGS (seeded)", startDate);
  }
  if (setupCost != null && setupCost > 0) {
    pushLine("cost", "setup", setupCost, "Setup cost (seeded)", startDate);
  }

  // Refresh the project_finance rollup row from the lines we just
  // inserted. Keeps the Finance List view in sync without needing a
  // resync API call after the seed.
  rollupStmts.push(
    `INSERT OR REPLACE INTO project_finance (
      project_id, total_sales, rental,
      contractor_cost, license_fee, deposit_paid, deposit_refund, misc_cost,
      updated_at, updated_by
    )
    SELECT
      p.id,
      COALESCE((SELECT SUM(amount) FROM project_finance_lines WHERE project_id = p.id AND kind='income' AND category='sales' AND archived_at IS NULL), 0),
      COALESCE((SELECT SUM(amount) FROM project_finance_lines WHERE project_id = p.id AND kind='cost' AND category='rental' AND archived_at IS NULL), 0),
      COALESCE((SELECT SUM(amount) FROM project_finance_lines WHERE project_id = p.id AND kind='cost' AND category='contractor' AND archived_at IS NULL), 0),
      COALESCE((SELECT SUM(amount) FROM project_finance_lines WHERE project_id = p.id AND kind='cost' AND category='license' AND archived_at IS NULL), 0),
      COALESCE((SELECT SUM(amount) FROM project_finance_lines WHERE project_id = p.id AND kind='cost' AND category='deposit' AND archived_at IS NULL), 0),
      COALESCE((SELECT SUM(amount) FROM project_finance_lines WHERE project_id = p.id AND kind='income' AND category='deposit_refund' AND archived_at IS NULL), 0),
      COALESCE((SELECT SUM(amount) FROM project_finance_lines WHERE project_id = p.id AND kind='cost' AND category NOT IN ('rental','contractor','license','deposit') AND archived_at IS NULL), 0),
      datetime('now'), ${ownerId}
    FROM projects p WHERE p.code = ${sqlStr(code)};`
  );

  queued++;
}

console.log(`▶ Queued ${queued} project(s); skipped ${skipped}; contractors to upsert: ${contractorsToInsert.size}`);
if (queued === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

// ── 5. Build SQL bundle ───────────────────────────────────────
const supplierStmts = [];
for (const s of contractorsToInsert) {
  const { code, name } = JSON.parse(s);
  supplierStmts.push(
    `INSERT OR IGNORE INTO suppliers (code, name, active) VALUES (${sqlStr(code)}, ${sqlStr(name)}, 1);`
  );
}

const sql = [
  "-- Auto-generated by scripts/seed-projects.mjs — do not commit edits here.",
  "-- Suppliers (idempotent)",
  ...supplierStmts,
  "",
  "-- Projects",
  ...projectStmts,
  "",
  "-- Finance lines",
  ...financeStmts,
  "",
  "-- project_finance rollup cache",
  ...rollupStmts,
  "",
].join("\n");

const outPath = join("scripts", ".seed-projects.generated.sql");
writeFileSync(outPath, sql, "utf8");
console.log(`▶ Wrote ${outPath} (${sql.length.toLocaleString()} chars)`);

if (dry) {
  console.log("(--dry: not executing)");
  process.exit(0);
}

// ── 6. Execute ────────────────────────────────────────────────
console.log(`▶ Executing against ${remote ? "REMOTE" : "local"} D1…`);
wrangler(`--file=${outPath}`);

// Clean up the generated file once it's been applied. Keeps the repo
// tidy and avoids confusion about whether it's committed or not.
try { unlinkSync(outPath); } catch {}

console.log(`\nDone. Inserted ${queued} project(s) and ${financeStmts.length} finance line(s).`);
