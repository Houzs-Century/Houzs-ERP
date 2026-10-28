// Read-only report: did an approved SO amendment actually rewrite its Sales
// Order, and what does the paper trail around it look like?
//
// WHY: the owner approved an amendment and reports the SO "did not change".
// The approve-so handler only advances status AFTER applySoAmendment commits,
// so a real no-op would mean a defect (or the change is on a different
// document than the one being looked at). The answer lives only in
// production rows, so per the repo rule this is a workflow_dispatch check,
// not a SQL snippet pasted at the owner.
//
// Prints, for one SO doc_no:
//   1. every amendment on the SO: status + gate timestamps
//   2. each amendment's requested line changes
//   3. the SO header: status / revision / version / company
//   4. the SO's CURRENT non-cancelled lines
//   5. so_revisions snapshots (proof an apply ran)
//   6. the last mfg_so_audit_log entries (and whether there are ZERO —
//      the known silent-swallow risk when company_id was null)
//   7. a verdict per approved amendment: are its ADDs present and its
//      REMOVEs gone from the current lines?
//
// SELECTs only. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer; non-zero only for an unreachable DB / query error.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const SO_DOC_NO = (process.env.SO_DOC_NO || "").trim();
if (!SO_DOC_NO) {
  console.error("SO_DOC_NO not set — pass the Sales Order doc_no to inspect.");
  process.exit(1);
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

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const so = await pg`
    SELECT doc_no, status, revision, version, company_id, updated_at
    FROM scm.mfg_sales_orders WHERE doc_no = ${SO_DOC_NO}`;
  if (so.length === 0) {
    notice(`SO ${SO_DOC_NO}: NOT FOUND in mfg_sales_orders.`);
    process.exit(0);
  }
  const soRow = so[0];
  notice(
    `SO ${SO_DOC_NO}: status=${soRow.status} revision=${soRow.revision} ` +
      `version=${soRow.version} company_id=${soRow.company_id} updated_at=${soRow.updated_at}`,
  );

  const amendments = await pg`
    SELECT id, amendment_no, status, created_at, so_approved_at, po_approved_at
    FROM scm.so_amendments WHERE so_doc_no = ${SO_DOC_NO} ORDER BY created_at`;
  if (amendments.length === 0) notice("No amendments exist for this SO.");
  for (const a of amendments) {
    notice(
      `Amendment ${a.amendment_no}: status=${a.status} raised=${a.created_at} ` +
        `so_approved_at=${a.so_approved_at ?? "NULL"} po_approved_at=${a.po_approved_at ?? "NULL"}`,
    );
  }

  const amendIds = amendments.map((a) => a.id);
  const amendLines = amendIds.length
    ? await pg`
        SELECT amendment_id, change_type, new_item_code, sales_order_item_id
        FROM scm.so_amendment_lines WHERE amendment_id IN ${pg(amendIds)}`
    : [];
  for (const l of amendLines) {
    const parent = amendments.find((a) => a.id === l.amendment_id);
    notice(
      `  line change [${parent?.amendment_no}]: ${l.change_type} ` +
        `new_item_code=${l.new_item_code ?? "-"} targets_item=${l.sales_order_item_id ?? "-"}`,
    );
  }

  const items = await pg`
    SELECT id, line_no, item_code, cancelled
    FROM scm.mfg_sales_order_items WHERE doc_no = ${SO_DOC_NO}
    ORDER BY line_no NULLS LAST, created_at`;
  notice(`Current SO lines (${items.length} rows incl. cancelled):`);
  for (const it of items) {
    notice(
      `  line ${it.line_no ?? "-"}: ${it.item_code ?? "(no code)"}` +
        `${it.cancelled ? "  [CANCELLED]" : ""}`,
    );
  }

  const revisions = await pg`
    SELECT revision, amendment_id, created_at
    FROM scm.so_revisions WHERE so_doc_no = ${SO_DOC_NO} ORDER BY revision`;
  notice(
    revisions.length === 0
      ? "so_revisions: ZERO snapshots — no apply has ever run for this SO."
      : `so_revisions: ${revisions.length} snapshot(s): ` +
          revisions.map((r) => `r${r.revision}@${r.created_at}`).join(", "),
  );

  const audit = await pg`
    SELECT action, actor_name_snapshot, created_at
    FROM scm.mfg_so_audit_log WHERE so_doc_no = ${SO_DOC_NO}
    ORDER BY created_at DESC LIMIT 12`;
  if (audit.length === 0) {
    notice(
      "mfg_so_audit_log: ZERO rows for this SO. If gates were clicked, the " +
        "audit write was silently swallowed (known risk: company_id NULL on " +
        "the SO makes the NOT NULL insert fail and recordSoAudit hides it).",
    );
  } else {
    notice(`mfg_so_audit_log: last ${audit.length} row(s):`);
    for (const e of audit) {
      notice(`  ${e.created_at} ${e.action} by ${e.actor_name_snapshot ?? "?"}`);
    }
  }

  // Verdict per approved amendment: ADDs present? REMOVEd lines gone?
  const liveCodes = new Set(
    items.filter((i) => !i.cancelled).map((i) => i.item_code).filter(Boolean),
  );
  const liveIds = new Set(items.filter((i) => !i.cancelled).map((i) => String(i.id)));
  for (const a of amendments) {
    if (!["SO_APPROVED", "PO_APPROVED", "SENT"].includes(a.status)) continue;
    const mine = amendLines.filter((l) => l.amendment_id === a.id);
    const problems = [];
    for (const l of mine) {
      if (l.change_type === "ADD" && l.new_item_code && !liveCodes.has(l.new_item_code)) {
        problems.push(`ADD ${l.new_item_code} is MISSING from the live lines`);
      }
      if (
        l.change_type === "REMOVE" &&
        l.sales_order_item_id &&
        liveIds.has(String(l.sales_order_item_id))
      ) {
        problems.push(`REMOVEd item ${l.sales_order_item_id} is STILL live`);
      }
    }
    notice(
      problems.length === 0
        ? `VERDICT ${a.amendment_no}: the approved changes ARE reflected on the SO.`
        : `VERDICT ${a.amendment_no}: NOT fully applied — ${problems.join("; ")}`,
    );
  }
} finally {
  await pg.end();
}
