#!/usr/bin/env node
/**
 * Import ASSR cases from the "assr case farra" Google Sheet.
 *
 *   node scripts/import-assr-farra.mjs <tsv> [--dry] [--wipe] [--limit N]
 *
 * Prod is Supabase Postgres (post 2026-06-13 cutover). Mapping per
 * Nick's confirmed assr-farra-mapping-zh-v3.xlsx (2026-07-05):
 *
 *   ASSR Status                      → stage/status ("Pending Supplier
 *                                      Inspection" maps to pending_inspection
 *                                      + inspection_by='supplier'; plain
 *                                      "Pending Inspection" sets 'own')
 *   S/O · ASSR NO · Complained date  → doc_no · assr_no · complained_date
 *   Ref No                           → ref_no
 *   Customer Name/HP/Location/Agent  → customer_name/phone/location/sales_agent
 *   Address 1-4                      → addr1-4
 *   Complant issue                   → complaint_issue
 *   Service Category                 → issue_category  (product category
 *                                      stays empty — AutoCount item-group
 *                                      match is a later pass)
 *   Item Details                     → assr_items (single item assumed)
 *   PO No                            → po_no
 *   Supplier                         → creditor_code via name match;
 *                                      misses fold into complaint [Supplier]
 *   Action Remark                    → action_remark + resolution_method
 *                                      keyword inference (replace/repair)
 *   Action Taken : (Summarize) +
 *   Call Log: Purchasing Action…     → assr_activity purchasing notes
 *   Service Pickup Date              → customer_pickup_at
 *   Supplier Pickup Date             → supplier_pickup_at
 *   Supplier Return Date             → items_ready_at
 *   Goods Returned Note & Date +
 *   SUPPLIER SERVICE NOTE            → goods_returned_note (merged)
 *   Service Delivery Date (Compl.)   → completion_date + do_date;
 *                                      delivery_order = ASSR NO ("service
 *                                      delivery 不会有DO, ASSR No 就是DO No")
 *
 * Owner: created_by = Farra, assigned_to = Farra (assigned_to is a
 * single column — Nancy co-owns operationally; flagged in the report).
 * Unresolved history deadline = complained_date + 14 days.
 *
 * Idempotent on assr_no: rerunning without --wipe skips existing rows.
 * Attachments are NOT handled here — see notes at the bottom.
 */
import { readFileSync, existsSync } from "node:fs";
import postgres from "postgres";

// ── CLI ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const tsvPath = argv.find((a) => !a.startsWith("--"));
if (!tsvPath) {
  console.error("usage: node scripts/import-assr-farra.mjs <tsv> [--dry] [--wipe] [--limit N]");
  process.exit(2);
}
const dry = argv.includes("--dry");
const wipe = argv.includes("--wipe");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : null;

const CREATED_BY_EMAIL = "farraellya02@gmail.com"; // Farra
const ASSIGNED_TO_EMAIL = "farraellya02@gmail.com"; // single column; Nancy co-owns operationally

// ── DB ─────────────────────────────────────────────────────────
// CI passes DATABASE_URL as an env var (GitHub secret, same as
// pg-migrate.mjs); locally we fall back to backend/.dev.vars.
function resolveDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const dotEnv = existsSync(".dev.vars") ? ".dev.vars" : "backend/.dev.vars";
  try {
    // Line-anchored so a commented-out `# DATABASE_URL=…` doesn't match.
    return readFileSync(dotEnv, "utf8").match(/^DATABASE_URL="([^"]+)"/m)?.[1];
  } catch {
    return undefined;
  }
}
const dbUrl = resolveDbUrl();
if (!dbUrl) {
  console.error("DATABASE_URL not set (env var or backend/.dev.vars)");
  process.exit(2);
}
const pg = postgres(dbUrl, { ssl: "require", prepare: false, max: 1 });

// ── Stage mapping (v3.1 nine-stage, mig 074) ───────────────────
// Keys are whitespace-normalised (collapse runs, trim) before lookup —
// the sheet has "Pending Supplier  Inspection" with a double space.
// Nick 2026-07-05: "Pending Supplier Inspection" is the SAME stage as
// Pending Inspection — inspection can be done by us or the supplier.
const STAGE_MAP = {
  "Completed":                    "completed",
  "Pending Delivery/Service":     "pending_delivery_service",
  "Pending Delivery / Service":   "pending_delivery_service",
  "Pending Item Ready":           "pending_item_ready",
  "Pending Supplier Inspection":  "pending_inspection",
  "Pending Supplier Inpsection":  "pending_inspection",
  "Pending Supplier Pickup":      "pending_supplier_pickup",
  "Pending Item Pickup":          "pending_item_pickup",
  "Pending Inspection":           "pending_inspection",
  "Pending Solution":             "pending_solution",
  "Under Verification":           "under_verification",
  "Pending Review":               "pending_review",
  "Open":                         "pending_review",
  "":                             "pending_review",
};

function statusForStage(stage) {
  if (stage === "pending_review") return "Open";
  if (stage === "completed") return "Closed";
  return "In Progress";
}

// Default per-stage target days — matches DEFAULT_STAGE_TARGET_DAYS
// in services/assr.ts.
const DEFAULT_STAGE_TARGET_DAYS = {
  pending_review: 1,
  under_verification: 2,
  pending_solution: 2,
  pending_inspection: 2,
  pending_item_pickup: 2,
  pending_supplier_pickup: 3,
  pending_item_ready: 5,
  pending_delivery_service: 4,
  completed: 0,
};

// resolution_method inference from the free-text Action Remark. Only
// high-confidence keywords map; everything else stays NULL (ops can
// set it on the page later).
function inferResolution(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/replac|exchange/.test(t)) return "replace_unit";
  if (/repair|send\s*back|fix/.test(t)) return "supplier_repair";
  return null;
}

// ── Parsers ────────────────────────────────────────────────────
function parseDate(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  if (t === "*" || t === "-" || t === "—") return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function parseTsv(path) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const headerRow = lines.findIndex(
    (l) => /\tASSR NO\t/.test(l) && l.includes("Complained date")
  );
  if (headerRow < 0) throw new Error("Couldn't find header row (needs `ASSR NO` + `Complained date` columns)");
  const headers = lines[headerRow].split("\t").map((h) => h.trim());
  const rows = [];
  for (let i = headerRow + 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    if (cells.every((c) => !c || !c.trim())) continue;
    const row = {};
    headers.forEach((h, j) => (row[h] = (cells[j] ?? "").trim()));
    rows.push(row);
  }
  return rows;
}

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
// Supplier-name key: uppercase, drop punctuation, collapse spaces, and
// strip the common company suffixes so "DIGLANT MANUFACTURING SDN BHD."
// matches "Diglant Manufacturing Sdn. Bhd".
function supplierKey(s) {
  return norm(s)
    .toUpperCase()
    .replace(/[.,()]/g, " ")
    .replace(/\b(SDN|BHD|S\/B|ENTERPRISE|TRADING|MANUFACTURING|FURNITURE|INDUSTRIES|INDUSTRY|M)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Parse rows first — dry-run reports without writing ─────────
const rows = parseTsv(tsvPath);
console.log(`▶ Parsed ${rows.length} candidate row(s)`);

let createdById = null;
let assignedToId = null;
let activeProfileId = null;
let existing = new Set();
let creditorByKey = new Map();

// Creditor matching wants the live list even in --dry so the report
// shows the real match rate.
try {
  const creditors = await pg`SELECT creditor_code, company_name FROM creditors`;
  for (const c of creditors) {
    if (c.company_name) creditorByKey.set(supplierKey(c.company_name), c.creditor_code);
  }
  console.log(`▶ Creditors loaded for name-match: ${creditorByKey.size}`);
} catch (e) {
  console.warn(`  (creditor load failed — supplier matching off: ${e.message})`);
}

if (!dry) {
  const [cb] = await pg`SELECT id FROM users WHERE LOWER(email) = ${CREATED_BY_EMAIL}`;
  const [at] = await pg`SELECT id FROM users WHERE LOWER(email) = ${ASSIGNED_TO_EMAIL}`;
  if (!cb || !at) { console.error(`Missing user account (${CREATED_BY_EMAIL} / ${ASSIGNED_TO_EMAIL})`); process.exit(1); }
  createdById = cb.id;
  assignedToId = at.id;
  console.log(`▶ created_by=${createdById} assigned_to=${assignedToId}`);

  const profileRow = await pg`SELECT id FROM assr_lead_time_profiles WHERE is_active = 1 LIMIT 1`;
  activeProfileId = profileRow[0]?.id ?? null;
  console.log(`  activeProfileId=${activeProfileId ?? "(none)"}`);

  if (!wipe) {
    const exRows = await pg`SELECT assr_no FROM assr_cases WHERE assr_no IS NOT NULL`;
    existing = new Set(exRows.map((r) => r.assr_no));
    console.log(`  existing assr_no on remote: ${existing.size}`);
  }
}

const planned = [];
let skipped = 0;
const unknownStatuses = new Map();
const unmatchedSuppliers = new Map();
const stats = { byStage: new Map(), resolutionInferred: 0, supplierMatched: 0, supplierUnmatched: 0 };

for (const row of rows) {
  const assrNo = (row["ASSR NO"] ?? "").trim();
  if (!assrNo || assrNo === "ASSR NO") { skipped++; continue; }
  if (existing.has(assrNo)) { skipped++; continue; }
  if (LIMIT && planned.length >= LIMIT) break;

  const statusText = norm(row["Delivery Message Status"] ?? row["ASSR Status"]);
  let stage = STAGE_MAP[statusText];
  if (stage === undefined) {
    unknownStatuses.set(statusText, (unknownStatuses.get(statusText) ?? 0) + 1);
    stage = "pending_review";
  }
  stats.byStage.set(stage, (stats.byStage.get(stage) ?? 0) + 1);

  // Who performs the inspection — the sheet tracked it via two status
  // values; keep the distinction on the merged stage.
  const inspectionBy =
    statusText === "Pending Supplier Inspection" || statusText === "Pending Supplier Inpsection" ? "supplier"
    : statusText === "Pending Inspection" ? "own"
    : null;

  const docNo = (row["SO NO"] ?? row["S/O"] ?? "").trim() || "";
  const customerName = (row["Customer Name"] ?? "").trim() || null;
  const phone = (row["HP"] ?? "").trim() || null;
  const location = (row["Location"] ?? "").trim() || null;
  const salesAgent = (row["Sales Agent"] ?? "").trim() || null;
  const refNo = (row["Ref No"] ?? "").trim() || null;
  const itemCode = (row["Item Details"] ?? "").trim() || null;
  const complaint = (row["Complant issue"] ?? row["Complaint issue"] ?? "").trim() || null;
  const issueCategory = (row["Service Category"] ?? "").trim() || null;
  const actionRemark = (row["Action Remark"] ?? "").trim() || null;
  const actionTaken = (row["Action Taken : (Summarize)"] ?? row["Action Taken"] ?? "").trim() || null;
  const callLog = (row["Call Log: Purchasing Action Taken"] ?? "").trim() || null;
  const supplierName = (row["Supplier"] ?? "").trim() || null;
  const poNo = (row["PO No"] ?? "").trim() || null;
  const addr1 = (row["Address 1"] ?? "").trim() || null;
  const addr2 = (row["Address 2"] ?? "").trim() || null;
  const addr3 = (row["Address 3"] ?? "").trim() || null;
  const addr4 = (row["Address 4"] ?? "").trim() || null;

  // Supplier → creditor_code by normalised name.
  let creditorCode = null;
  if (supplierName) {
    creditorCode = creditorByKey.get(supplierKey(supplierName)) ?? null;
    if (creditorCode) stats.supplierMatched++;
    else {
      stats.supplierUnmatched++;
      unmatchedSuppliers.set(supplierName, (unmatchedSuppliers.get(supplierName) ?? 0) + 1);
    }
  }

  // Notes travelling with the item — sheet keeps two columns, DB one.
  const goodsReturnedNote =
    [
      (row["Goods Returned Note & Date"] ?? "").trim(),
      (row["SUPPLIER SERVICE NOTE"] ?? "").trim(),
    ]
      .filter(Boolean)
      .join("\n\n") || null;

  const resolutionMethod = inferResolution(actionRemark);
  if (resolutionMethod) stats.resolutionInferred++;

  const complainedDate = parseDate(row["Complained date"]);
  const customerPickupAt = parseDate(row["Service Pickup Date"]);
  const supplierPickupAt = parseDate(row["Supplier Pickup Date"]);
  const itemsReadyAt = parseDate(row["Supplier Return Date"]);
  const completionDate = parseDate(row["Service Delivery Date (Completion)"] ?? row["Completion Date"]);
  const closedAt = stage === "completed" ? completionDate : null;

  // "service delivery 不会有DO, ASSR No 就是DO No" — once the case has a
  // delivery leg, the DO number is the ASSR number itself.
  const hasDeliveryLeg = stage === "completed" || stage === "pending_delivery_service" || !!completionDate;
  const deliveryOrder = hasDeliveryLeg ? assrNo : null;
  const doDate = completionDate;

  // Complaint text stays clean now that most columns have real fields;
  // only an unmatched supplier folds in so the name isn't lost.
  const parts = [];
  if (complaint) parts.push(complaint);
  if (supplierName && !creditorCode) parts.push(`[Supplier] ${supplierName}`);
  const complaintText = parts.join("\n\n") || "(no description on import)";

  // Purchasing follow-ups → timeline notes (category='purchasing').
  const activityNotes = [];
  if (actionTaken) activityNotes.push(actionTaken);
  if (callLog) activityNotes.push(`[Call log] ${callLog}`);

  const priority = "normal";
  // Historical unresolved rows: deadline anchored at complained_date
  // + 14 days (Nick, mapping tab 3). Closed rows carry no active SLA.
  const slaHours = 336;
  const deadlineAt =
    stage === "completed" || !complainedDate
      ? null
      : new Date(new Date(complainedDate).getTime() + slaHours * 3600 * 1000).toISOString();

  const stageTargetDays = DEFAULT_STAGE_TARGET_DAYS[stage] ?? 2;
  const stageEnteredAt = (closedAt ?? complainedDate ?? new Date().toISOString().slice(0, 10)) + "T00:00:00Z";
  const stageChangedAt = stageEnteredAt;
  const createdAt = complainedDate ? complainedDate + "T00:00:00Z" : new Date().toISOString();

  planned.push({
    assrNo, docNo, complainedDate, customerName, phone, location, salesAgent, refNo,
    itemCode, complaintText, issueCategory, poNo, addr1, addr2, addr3, addr4,
    creditorCode, actionRemark, resolutionMethod, goodsReturnedNote, inspectionBy,
    customerPickupAt, supplierPickupAt, itemsReadyAt, completionDate, doDate, deliveryOrder,
    activityNotes,
    stage, sysStatus: statusForStage(stage),
    priority, slaHours, deadlineAt,
    stageEnteredAt, stageTargetDays, stageChangedAt,
    createdAt, closedAt,
  });
}

console.log(`▶ Planned ${planned.length}; skipped ${skipped}`);
console.log("\n── Stage distribution ───────────────────────────────");
for (const [s, n] of [...stats.byStage.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${s}`);
}
if (unknownStatuses.size) {
  console.log("\n⚠ Unknown ASSR Status values (imported as pending_review):");
  for (const [s, n] of unknownStatuses) console.log(`  ${String(n).padStart(4)}  "${s}"`);
}
console.log(`\n▶ Supplier match: ${stats.supplierMatched} matched · ${stats.supplierUnmatched} unmatched`);
if (unmatchedSuppliers.size) {
  console.log("  Unmatched supplier names (folded into complaint as [Supplier]):");
  for (const [s, n] of [...unmatchedSuppliers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${String(n).padStart(4)}  ${s}`);
  }
}
console.log(`▶ resolution_method inferred on ${stats.resolutionInferred}/${planned.length} rows (rest NULL)`);
console.log(`▶ NB: assigned_to is a single column — importing everything under Farra; Nancy co-owns operationally.`);

if (planned.length === 0 && !wipe) { console.log("Nothing to do."); await pg.end(); process.exit(0); }

if (dry) {
  console.log("\n── Dry-run sample (first 3) ─────────────────────────");
  for (const p of planned.slice(0, 3)) console.log(JSON.stringify(p, null, 2));
  console.log("\n(--dry: not writing)");
  await pg.end();
  process.exit(0);
}

// ── Write ──────────────────────────────────────────────────────
if (wipe) {
  console.log("▶ Wiping assr_cases (children cascade)…");
  await pg`DELETE FROM assr_cases`;
}

let inserted = 0;
let failed = 0;
for (const p of planned) {
  try {
    await pg.begin(async (tx) => {
      const [caseRow] = await tx`
        INSERT INTO assr_cases (
          assr_no, status, stage, doc_no, complained_date,
          customer_name, phone, location, sales_agent, ref_no, item_code,
          complaint_issue, issue_category, priority, po_no,
          addr1, addr2, addr3, addr4,
          creditor_code, action_remark, resolution_method, goods_returned_note, inspection_by,
          customer_pickup_at, supplier_pickup_at, items_ready_at,
          completion_date, do_date, delivery_order,
          created_by, assigned_to, sla_hours, deadline_at,
          stage_entered_at, stage_target_days, stage_changed_at,
          lead_time_profile_id, created_at, closed_at
        ) VALUES (
          ${p.assrNo}, ${p.sysStatus}, ${p.stage}, ${p.docNo}, ${p.complainedDate},
          ${p.customerName}, ${p.phone}, ${p.location}, ${p.salesAgent}, ${p.refNo}, ${p.itemCode},
          ${p.complaintText}, ${p.issueCategory}, ${p.priority}, ${p.poNo},
          ${p.addr1}, ${p.addr2}, ${p.addr3}, ${p.addr4},
          ${p.creditorCode}, ${p.actionRemark}, ${p.resolutionMethod}, ${p.goodsReturnedNote}, ${p.inspectionBy},
          ${p.customerPickupAt}, ${p.supplierPickupAt}, ${p.itemsReadyAt},
          ${p.completionDate}, ${p.doDate}, ${p.deliveryOrder},
          ${createdById}, ${assignedToId}, ${p.slaHours}, ${p.deadlineAt},
          ${p.stageEnteredAt}, ${p.stageTargetDays}, ${p.stageChangedAt},
          ${activeProfileId}, ${p.createdAt}, ${p.closedAt}
        )
        RETURNING id
      `;
      await tx`
        INSERT INTO assr_stage_history (assr_id, stage, entered_at, target_days, alerts_fired)
        VALUES (${caseRow.id}, ${p.stage}, ${p.stageEnteredAt}, ${p.stageTargetDays}, 1)
      `;
      if (p.itemCode) {
        await tx`
          INSERT INTO assr_items (assr_id, item_code, item_description, qty)
          VALUES (${caseRow.id}, ${p.itemCode}, ${null}, ${1})
        `;
      }
      for (const note of p.activityNotes) {
        await tx`
          INSERT INTO assr_activity (assr_id, action, note, category, user_id, created_at)
          VALUES (${caseRow.id}, 'note', ${note.slice(0, 2000)}, 'purchasing', ${createdById}, ${p.createdAt})
        `;
      }
    });
    inserted++;
    if (inserted % 50 === 0) console.log(`  … ${inserted}/${planned.length}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${p.assrNo}: ${e.message}`);
  }
}

console.log(`\nDone. inserted=${inserted}, failed=${failed}`);
await pg.end();

// ── Attachments (phase 2) ──────────────────────────────────────
// Photos in the sheet live on Google Drive. Migrating them means:
//   1. Grant this script Drive read access (service-account JSON or
//      "anyone with the link can view" on the folder).
//   2. For each linked file: fetch via
//      https://drive.google.com/uc?export=download&id=<FILE_ID>
//   3. Upload to R2 under the standard key
//      (see assrAttachmentKey in services/assr.ts).
//   4. Insert into assr_attachments with the r2_key + case id.
// Product-category (AutoCount item-group) matching is also deferred —
// runs as a later UPDATE pass once AutoCount sync is re-enabled.
