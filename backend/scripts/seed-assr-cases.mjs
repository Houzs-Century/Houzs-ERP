#!/usr/bin/env node
/* ALREADY RUN — DO NOT RE-RUN.
   
   Written for a one-shot seed and executed in 2026-05. It is kept for the record of
   what was done to production, not as a tool.
   
   It seeded ASSR cases from a specific spreadsheet export. Re-running it duplicates every case it created.
   
   Nothing in this repository reaches it: no npm script, no workflow, no doc,
   no import. That is deliberate now — it used to be an accident, and an
   unreferenced script whose NAME still reads as runnable is an invitation. */
/**
 * Seed ASSR cases from the Farra sheet of HC Delivery Updated.xlsx.
 *
 * Usage:
 *   node scripts/seed-assr-cases.mjs <tsv> [--remote|--local] [--dry] [--wipe]
 *
 * --wipe: deletes every row from assr_cases first. Children
 *         (assr_items, assr_attachments, assr_activity, assr_logistics)
 *         are FK-cascade so they go with the parent.
 *
 * Idempotency: re-running without --wipe relies on assr_no being
 * unique. Existing rows are skipped on collision.
 *
 * Owner: created_by + assigned_to default to the user with email
 * `OWNER_EMAIL` (override via env).
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DB = "autocount-sync";
const argv = process.argv.slice(2);
const tsvPath = argv.find((a) => !a.startsWith("--"));
if (!tsvPath) {
  console.error("Usage: node scripts/seed-assr-cases.mjs <tsv> [--remote|--local] [--dry] [--wipe]");
  process.exit(1);
}
const remote = argv.includes("--remote");
const dry = argv.includes("--dry");
const wipe = argv.includes("--wipe");
const FLAG = remote ? "--remote" : "--local";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "nijammohd12@gmail.com";

// ── Status → stage map ─────────────────────────────────────────
// Sheet uses friendly-name statuses; the schema CHECK constraint
// limits stage to one of six slugs.
const STAGE_MAP = {
  "Completed": "closed",
  "Pending Item Ready": "logistics",
  "Pending Delivery/Service": "logistics",
  "Pending Item Pickup": "logistics",
  "Pending Supplier Pickup": "logistics",
  "Pending Solution": "action",
  "Under Verification": "triage",
  "Open": "registration",
  "": "registration",
};

function statusForStage(stage) {
  if (stage === "registration") return "Open";
  if (stage === "closed") return "Closed";
  return "In Progress";
}

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
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  // Sentinels seen in the sheet — empty placeholder values.
  if (t === "*" || t === "-" || t === "—" || t === "—") return null;
  // ISO with time: "2024-12-31 00:00:00" → "2024-12-31"
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Slash form: "2025/02/12" or "2025/2/12"
  m = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  // DD/MM/YYYY
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

function parseTsv(path) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  // The Farra sheet has 11 rows of summary tables before the actual
  // header row; that header lives at index 11 (line 12, 1-indexed).
  // Anything above is dashboard cruft.
  const headerRow = lines.findIndex((l) => /^ASSR Status\tS\/O\tASSR NO\b/.test(l));
  if (headerRow < 0) {
    throw new Error("Couldn't find header row (looking for `ASSR Status\\tS/O\\tASSR NO`)");
  }
  const headers = lines[headerRow].split("\t").map((h) => h.trim());
  const rows = [];
  for (let i = headerRow + 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    if (cells.every((c) => !c || !c.trim())) continue; // skip blank rows
    const row = {};
    headers.forEach((h, j) => (row[h] = (cells[j] ?? "").trim()));
    rows.push(row);
  }
  return rows;
}

// ── Resolve owner ──────────────────────────────────────────────
console.log(`▶ Looking up owner ${OWNER_EMAIL} on ${remote ? "remote" : "local"}…`);
const ownerRows = queryJson(`SELECT id FROM users WHERE email = '${OWNER_EMAIL}'`);
if (ownerRows.length === 0) {
  console.error(`No user found for ${OWNER_EMAIL}.`);
  process.exit(1);
}
const ownerId = ownerRows[0].id;
console.log(`  owner_id=${ownerId}`);

// ── Existing assr_no codes (skip-on-duplicate when not wiping) ──
let existing = new Set();
if (!wipe) {
  existing = new Set(
    queryJson("SELECT assr_no FROM assr_cases WHERE assr_no IS NOT NULL").map((r) => r.assr_no),
  );
  console.log(`  ${existing.size} existing assr_no codes on remote`);
}

// ── Parse TSV ──────────────────────────────────────────────────
const rows = parseTsv(tsvPath);
console.log(`▶ Parsed ${rows.length} candidate row(s)`);

const inserts = [];
let skipped = 0;

for (const row of rows) {
  const assrNo = (row["ASSR NO"] ?? "").trim();
  // Drop the 1 stray row whose first column literally says
  // "Delivery Message Status" — it's a section heading, not a case.
  if (!assrNo || assrNo === "ASSR NO") {
    skipped++;
    continue;
  }
  if (existing.has(assrNo)) {
    skipped++;
    continue;
  }

  const status = (row["ASSR Status"] ?? "").trim();
  const stage = STAGE_MAP[status] ?? "registration";
  // assr_cases.doc_no is NOT NULL on the legacy schema. Fall back to
  // an empty string when the sheet doesn't carry an SO — historical
  // rows with no SO still need to land.
  const docNo = (row["S/O"] ?? "").trim() || "";
  const refNo = (row["Ref No"] ?? "").trim() || null;
  const customerName = (row["Customer Name"] ?? "").trim() || null;
  const phone = (row["HP"] ?? "").trim() || null;
  const location = (row["Location"] ?? "").trim() || null;
  const salesAgent = (row["Sales Agent"] ?? "").trim() || null;
  const deliveryOrder = (row["D/O"] ?? "").trim() || null;
  const itemCode = (row["Item Details"] ?? row["Service Item Code"] ?? "").trim() || null;
  const complaint = (row["Complant issue"] ?? row["Complaint issue"] ?? "").trim() || null;
  const actionRemark = (row["Action Taken : (Summarize)"] ?? row["Action Taken"] ?? "").trim() || null;
  const callLog = (row["Call Log: Purchasing Action Taken"] ?? "").trim() || null;
  const serviceCategory = (row["Service Category"] ?? "").trim() || null;
  const supplier = (row["Supplier"] ?? "").trim() || null;
  const poNo = (row["PO No"] ?? "").trim() || null;
  const addr1 = (row["Address 1"] ?? "").trim() || null;
  const addr2 = (row["Address 2"] ?? "").trim() || null;
  const addr3 = (row["Address 3"] ?? "").trim() || null;
  const addr4 = (row["Address 4"] ?? "").trim() || null;

  const complainedDate = parseDate(row["Complained date"]);
  const doDate = parseDate(row["DO Delivered Date"]);
  const completionDate = parseDate(
    row["Service Delivery Date (Completion)"] ?? row["Completion Date"]
  );
  const supplierPickupAt = parseDate(row["Supplier Pickup Date"]);
  const itemsReadyAt = parseDate(row["Supplier Return Date"] ?? row["Supplier Ready Date"]);
  const closedAt = stage === "closed" ? completionDate : null;

  const sysStatus = statusForStage(stage);
  const stageChangedAt = closedAt ?? complainedDate ?? null;

  // notes column doesn't exist — fold supplier + call log into
  // action_remark when there's room, else leave it on action_remark.
  let mergedRemark = actionRemark;
  if (callLog) {
    mergedRemark = mergedRemark
      ? `${mergedRemark}\n\n[Purchasing] ${callLog}`
      : `[Purchasing] ${callLog}`;
  }
  if (supplier) {
    mergedRemark = mergedRemark
      ? `${mergedRemark}\n\n[Supplier] ${supplier}`
      : `[Supplier] ${supplier}`;
  }

  inserts.push(
    `INSERT INTO assr_cases (
      assr_no, status, stage,
      doc_no, ref_no, delivery_order, do_date,
      complained_date, completion_date, closed_at, stage_changed_at,
      supplier_pickup_at, items_ready_at,
      customer_name, phone, location, sales_agent,
      item_code, complaint_issue, action_remark,
      service_category, po_no,
      addr1, addr2, addr3, addr4,
      created_by, assigned_to,
      created_at, updated_at
    ) VALUES (
      ${sqlStr(assrNo)}, ${sqlStr(sysStatus)}, ${sqlStr(stage)},
      ${sqlStr(docNo)}, ${sqlStr(refNo)}, ${sqlStr(deliveryOrder)}, ${sqlStr(doDate)},
      ${sqlStr(complainedDate)}, ${sqlStr(completionDate)}, ${sqlStr(closedAt)}, ${sqlStr(stageChangedAt)},
      ${sqlStr(supplierPickupAt)}, ${sqlStr(itemsReadyAt)},
      ${sqlStr(customerName)}, ${sqlStr(phone)}, ${sqlStr(location)}, ${sqlStr(salesAgent)},
      ${sqlStr(itemCode)}, ${sqlStr(complaint)}, ${sqlStr(mergedRemark)},
      ${sqlStr(serviceCategory)}, ${sqlStr(poNo)},
      ${sqlStr(addr1)}, ${sqlStr(addr2)}, ${sqlStr(addr3)}, ${sqlStr(addr4)},
      ${sqlNum(ownerId)}, ${sqlNum(ownerId)},
      datetime('now'), datetime('now')
    );`,
  );
}

console.log(`▶ Queued ${inserts.length} insert(s); skipped ${skipped}`);

if (inserts.length === 0 && !wipe) {
  console.log("Nothing to do.");
  process.exit(0);
}

// ── Build SQL bundle ───────────────────────────────────────────
const stmts = [];
stmts.push("-- Auto-generated by scripts/seed-assr-cases.mjs.");
if (wipe) {
  stmts.push("-- Wipe existing cases. assr_items / assr_attachments /");
  stmts.push("-- assr_activity / assr_logistics cascade via FK ON DELETE.");
  stmts.push("DELETE FROM assr_cases;");
}
stmts.push("", "-- Cases", ...inserts, "");

const sql = stmts.join("\n");
const outPath = join("scripts", ".seed-assr-cases.generated.sql");
writeFileSync(outPath, sql, "utf8");
console.log(`▶ Wrote ${outPath} (${sql.length.toLocaleString()} chars)`);

if (dry) {
  console.log("(--dry: not executing)");
  process.exit(0);
}

// ── Execute ────────────────────────────────────────────────────
console.log(`▶ Executing against ${remote ? "REMOTE" : "local"} D1…`);
wrangler(`--file=${outPath}`);

try { unlinkSync(outPath); } catch {}

console.log(`\nDone. ${wipe ? "Wiped + " : ""}inserted ${inserts.length} case(s).`);
