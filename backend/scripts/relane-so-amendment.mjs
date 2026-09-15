// relane-so-amendment.mjs — move ONE open Sales Order amendment to the other
// approval lane, when the lane it was stored with is not the lane the rule
// gives it today.
//
// WHY THIS EXISTS. The lane (LINES = Purchaser, DELIVERY = Logistic) is decided
// ONCE, at submit, and stored on scm.so_amendments.lane. A rule fix therefore
// reaches only amendments raised AFTER it deploys: HC-SO-012757/A1 added
// TRANSPORTATION CHARGES (catalogue category SERVICE) on 2026-09-14 and was
// stored LINES; the fix that reads the catalogue category for an added line
// (docs/bugs/0895) merged on 2026-09-15 and left A1 where it was. The owner,
// 2026-09-15: 「那就把这张 A1 改到 Logistic」. There is no screen for this — an
// approver cannot re-route a request, by design — so the repair is a script.
//
// WHAT IT REFUSES, so it can only correct a mis-route and never invent one:
//   - a row that is not REQUESTED (an applied / rejected lane is history);
//   - a LEGACY row (lane NULL — the pre-rework chain has no lanes to move between);
//   - a target lane already holding an open request on the same order
//     (uq_so_amendment_open_lane would refuse the UPDATE anyway; this says why);
//   - an amendment carrying HEADER changes — those keys have their own lane
//     table and this tool judges LINES only;
//   - moving to DELIVERY when any line is NOT a service line by the same signal
//     the submit route uses today: catalogue category SERVICE for an added code,
//     item_group 'service' on an existing SO line;
//   - moving to LINES when every line IS a service line (that would recreate
//     the exact mis-route 0816 / 0895 fixed).
//
// WHAT IT WRITES (APPLY=1 only), in ONE transaction: the lane on the amendment
// row, and one mfg_so_audit_log row (action AMENDMENT_RELANED) so the order's
// History shows who moved it and from where. It posts NO notice: the Logistic
// inbox reads so_amendments by lane, so the row is on their desk the moment the
// UPDATE commits, and the announcements banner sits behind a KV cache this
// script cannot bust.
//
// This repository is PUBLIC and Actions logs with it: the output names the
// amendment (an input) and prints counts + lane words — never the reason text,
// the customer, or a line's price.
//
//   DATABASE_URL    required (env, or .dev.vars for local use)
//   AMENDMENT_NO    e.g. HC-SO-012757/A1
//   TO_LANE         LINES | DELIVERY
//   APPLY=1         write. Anything else is a dry run.
//   CONFIRM         "I HAVE REVIEWED THE DRY-RUN" — required with APPLY=1.
//
// After the write it re-reads the row on a FRESH connection and asserts the
// SHAPE: lane = TO_LANE, status still REQUESTED, exactly one AMENDMENT_RELANED
// history row naming this amendment.
//
// RE-RUN: inert — a row already on TO_LANE is reported and left alone.

import { readFileSync } from "node:fs";
import postgres from "postgres";

const AMENDMENT_NO = (process.env.AMENDMENT_NO || "").trim();
const TO_LANE = (process.env.TO_LANE || "").trim().toUpperCase();
const APPLY = process.env.APPLY === "1";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";

if (!AMENDMENT_NO) {
  console.error("AMENDMENT_NO is required (e.g. HC-SO-012757/A1). Aborting.");
  process.exit(2);
}
if (TO_LANE !== "LINES" && TO_LANE !== "DELIVERY") {
  console.error(`TO_LANE must be LINES or DELIVERY (got "${TO_LANE}"). Aborting.`);
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 requires CONFIRM="${CONFIRM_PHRASE}". Aborting.`);
  process.exit(2);
}

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

const log = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* Same signal as shared/service-sku.ts isServiceLine, restated for SQL rows:
   an existing line by its item_group, an added one by its catalogue category,
   and the SVC- prefix either way. */
function isServiceLine(line) {
  const group = (line.item_group || "").trim().toLowerCase();
  const category = (line.category || "").trim().toUpperCase();
  const code = (line.item_code || "").trim().toUpperCase();
  return group === "service" || category === "SERVICE" || code.startsWith("SVC-");
}

async function main() {
  log(APPLY ? "MODE: APPLY (writes)" : "MODE: DRY RUN (no writes)");
  log(`Amendment ${AMENDMENT_NO} -> ${TO_LANE}`);

  const [row] = await pg`
    SELECT id::text AS id, so_doc_no, status::text AS status, lane, company_id,
           header_changes
      FROM scm.so_amendments
     WHERE amendment_no = ${AMENDMENT_NO}`;
  if (!row) {
    log(`NOT FOUND: no amendment ${AMENDMENT_NO}. Nothing to do.`);
    return;
  }
  log(`Found: status=${row.status} lane=${row.lane ?? "NULL (legacy)"} company_id=${row.company_id}`);

  if (row.status !== "REQUESTED") {
    log(`REFUSED: only a REQUESTED amendment can move lanes (this one is ${row.status}).`);
    return;
  }
  if (row.lane == null) {
    log("REFUSED: a legacy (lane NULL) row has no lanes to move between.");
    return;
  }
  if (row.lane === TO_LANE) {
    log(`ALREADY on ${TO_LANE}. Nothing to do.`);
    return;
  }
  const headerKeys = row.header_changes && typeof row.header_changes === "object"
    ? Object.keys(row.header_changes)
    : [];
  if (headerKeys.length > 0) {
    log(`REFUSED: the amendment carries ${headerKeys.length} header change(s); this tool re-lanes LINE-only amendments.`);
    return;
  }

  const [{ n: openOnTarget }] = await pg`
    SELECT count(*)::int AS n
      FROM scm.so_amendments
     WHERE so_doc_no = ${row.so_doc_no}
       AND lane = ${TO_LANE}
       AND status = 'REQUESTED'`;
  if (openOnTarget > 0) {
    log(`REFUSED: ${row.so_doc_no} already has an open ${TO_LANE} amendment; resolve it first.`);
    return;
  }

  /* Every line, with the service signal resolved the way the submit route
     resolves it today. */
  const lines = await pg`
    SELECT l.change_type,
           COALESCE(l.new_item_code, i.item_code) AS item_code,
           i.item_group,
           p.category
      FROM scm.so_amendment_lines l
      LEFT JOIN scm.mfg_sales_order_items i ON i.id = l.sales_order_item_id
      LEFT JOIN scm.mfg_products p
             ON p.company_id = ${row.company_id}
            AND p.code = trim(COALESCE(l.new_item_code, i.item_code))
     WHERE l.amendment_id = ${row.id}::uuid`;
  if (lines.length === 0) {
    log("REFUSED: the amendment has no lines; nothing to judge.");
    return;
  }
  const serviceCount = lines.filter(isServiceLine).length;
  log(`Lines: ${lines.length}, of which service: ${serviceCount}`);

  if (TO_LANE === "DELIVERY" && serviceCount !== lines.length) {
    log(`REFUSED: ${lines.length - serviceCount} line(s) are product lines; a product change is the Purchaser's.`);
    return;
  }
  if (TO_LANE === "LINES" && serviceCount === lines.length) {
    log("REFUSED: every line is a service line; that is exactly the Logistic desk's (docs/bugs/0816, 0895).");
    return;
  }

  log(`PLAN: ${AMENDMENT_NO} lane ${row.lane} -> ${TO_LANE}, plus one AMENDMENT_RELANED history row on ${row.so_doc_no}.`);
  if (!APPLY) {
    log(`DRY RUN — nothing was written. Re-run with APPLY=1 CONFIRM="${CONFIRM_PHRASE}" to apply.`);
    return;
  }

  await pg.begin(async (tx) => {
    const updated = await tx`
      UPDATE scm.so_amendments
         SET lane = ${TO_LANE}, updated_at = now()
       WHERE id = ${row.id}::uuid
         AND status = 'REQUESTED'
         AND lane = ${row.lane}`;
    if (updated.count !== 1) {
      throw new Error(`expected to update 1 row, updated ${updated.count} — the row changed under us; rolled back`);
    }
    await tx`
      INSERT INTO scm.mfg_so_audit_log
        (so_doc_no, company_id, action, actor_name_snapshot, field_changes, source, note)
      VALUES
        (${row.so_doc_no}, ${row.company_id}, 'AMENDMENT_RELANED',
         'System (relane-so-amendment)',
         ${tx.json([
           { field: "amendment", from: null, to: AMENDMENT_NO },
           { field: "lane", from: row.lane, to: TO_LANE },
         ])},
         'repair',
         ${`Approval lane moved ${row.lane} -> ${TO_LANE}: the amendment was raised before the rule that routes an added service line to Logistic (docs/bugs/0895) and kept the lane it was stored with.`})`;
  });
  log(`APPLIED: ${AMENDMENT_NO} lane ${row.lane} -> ${TO_LANE}.`);

  /* The session that wrote is the worst witness that the write landed: verify
     on a FRESH connection, asserting what the row now IS, not how many rows the
     UPDATE claimed. */
  await pg.end({ timeout: 5 });
  const check = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    log("=== VERIFIED ON A FRESH CONNECTION ===");
    const [after] = await check`
      SELECT lane, status::text AS status
        FROM scm.so_amendments
       WHERE id = ${row.id}::uuid`;
    const [{ n: historyRows }] = await check`
      SELECT count(*)::int AS n
        FROM scm.mfg_so_audit_log
       WHERE so_doc_no = ${row.so_doc_no}
         AND action = 'AMENDMENT_RELANED'
         AND field_changes::text LIKE ${"%" + AMENDMENT_NO + "%"}`;
    const shapeOk = after?.lane === TO_LANE && after?.status === "REQUESTED" && historyRows === 1;
    log(`  lane is ${after?.lane ?? "(row gone)"}, status ${after?.status ?? "-"}, AMENDMENT_RELANED history rows for this amendment: ${historyRows}`);
    if (!shapeOk) {
      throw new Error(`verification FAILED: expected lane ${TO_LANE}, status REQUESTED, 1 history row`);
    }
    log(`VERIFIED: ${AMENDMENT_NO} is on ${TO_LANE}. It appears in that desk's Amendments inbox at once; no notice was posted.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main()
  .then(() => pg.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error(e);
    try { await pg.end({ timeout: 5 }); } catch { /* already closed */ }
    process.exit(1);
  });
