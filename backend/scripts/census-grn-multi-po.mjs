// Read-only census: how many goods receipts took their lines from MORE THAN ONE
// purchase order, and how many still have something to bill?
//
// WHY THIS EXISTS
//
// Staff, 2026-11-09, on HC-PI-2611-104 (HOOKKA): "When we want to add missing
// item, convert GRN list all same PO number". The Bill-a-GRN pickers labelled
// every line of HC-GRN-2611-052 with the receipt HEADER's PO, while each line
// carries its own purchase_order_item_id and a receipt can take lines from
// several POs (the add-PO picker). Reading the code says the label was wrong
// for every such receipt; only production says how many there are.
//
// A line's PO is grn_items.purchase_order_item_id -> purchase_order_items
// .purchase_order_id. A receipt is "mislabelled" when at least one of its lines
// names a PO other than grns.purchase_order_id — that is exactly the set the
// old picker showed wrongly.
//
// READING, NOT A SETTING. SELECTs only — no DDL, no writes, no transaction.
// Exits 0 for every legitimate answer; only an unreachable database or a query
// error exits non-zero.
//
// RE-RUN: safe and identical. It writes nothing.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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
  const rows = await pg`
    WITH line_po AS (
      SELECT g.id AS grn_id, g.company_id, g.status::text AS status, g.on_hold,
             g.purchase_order_id AS header_po,
             poi.purchase_order_id AS line_po,
             gi.qty_accepted - COALESCE(gi.invoiced_qty, 0) - COALESCE(gi.returned_qty, 0) AS remaining
        FROM scm.grns g
        JOIN scm.grn_items gi ON gi.grn_id = g.id
        LEFT JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id
    ),
    per_grn AS (
      SELECT grn_id, company_id, status, on_hold,
             COUNT(DISTINCT line_po) AS po_count,
             BOOL_OR(line_po IS NOT NULL AND line_po IS DISTINCT FROM header_po) AS mislabelled,
             BOOL_OR(remaining > 0) AS has_unbilled,
             COUNT(*) AS lines,
             COUNT(*) FILTER (WHERE line_po IS NOT NULL AND line_po IS DISTINCT FROM header_po) AS mislabelled_lines
        FROM line_po
       GROUP BY grn_id, company_id, status, on_hold
    )
    SELECT company_id,
           COUNT(*) FILTER (WHERE status = 'POSTED')                                    AS posted_grns,
           COUNT(*) FILTER (WHERE status = 'POSTED' AND po_count > 1)                   AS posted_multi_po,
           COUNT(*) FILTER (WHERE status = 'POSTED' AND mislabelled)                    AS posted_mislabelled,
           COALESCE(SUM(mislabelled_lines) FILTER (WHERE status = 'POSTED'), 0)         AS posted_mislabelled_lines,
           COUNT(*) FILTER (WHERE status = 'POSTED' AND NOT on_hold AND has_unbilled)   AS billable_grns,
           COUNT(*) FILTER (WHERE status = 'POSTED' AND NOT on_hold AND has_unbilled AND mislabelled) AS billable_mislabelled
      FROM per_grn
     GROUP BY company_id
     ORDER BY company_id
  `;

  console.log("── goods receipts whose lines name a PO other than the header's ──");
  console.log("company | posted GRNs | of which >1 PO | header PO wrong for >=1 line | such lines | still to bill | of which wrong label");
  for (const r of rows) {
    console.log(
      `${r.company_id ?? "NULL"} | ${r.posted_grns} | ${r.posted_multi_po} | ${r.posted_mislabelled} | ${r.posted_mislabelled_lines} | ${r.billable_grns} | ${r.billable_mislabelled}`,
    );
  }
  if (rows.length === 0) {
    notice("No goods receipts read at all. That is not 'none affected': check the database this ran against.");
  } else {
    const tot = rows.reduce(
      (a, r) => ({
        posted: a.posted + Number(r.posted_grns),
        wrong: a.wrong + Number(r.posted_mislabelled),
        billable: a.billable + Number(r.billable_grns),
        billableWrong: a.billableWrong + Number(r.billable_mislabelled),
      }),
      { posted: 0, wrong: 0, billable: 0, billableWrong: 0 },
    );
    notice(
      `${tot.wrong} of ${tot.posted} posted GRNs had at least one line the old picker labelled with the wrong PO; ${tot.billableWrong} of ${tot.billable} GRNs still to bill are among them.`,
    );
  }

  const examples = await pg`
    SELECT g.grn_number, hp.po_number AS header_po,
           STRING_AGG(DISTINCT lp.po_number, ', ' ORDER BY lp.po_number) AS line_pos
      FROM scm.grns g
      JOIN scm.grn_items gi ON gi.grn_id = g.id
      JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id
      JOIN scm.purchase_orders lp ON lp.id = poi.purchase_order_id
      LEFT JOIN scm.purchase_orders hp ON hp.id = g.purchase_order_id
     WHERE g.status::text = 'POSTED'
     GROUP BY g.id, g.grn_number, hp.po_number, g.received_at
    HAVING BOOL_OR(poi.purchase_order_id IS DISTINCT FROM g.purchase_order_id)
     ORDER BY g.received_at DESC
     LIMIT 15
  `;
  console.log("\n── newest examples (receipt · header PO · POs its lines name) ──");
  for (const e of examples) console.log(`${e.grn_number} · ${e.header_po ?? "-"} · ${e.line_pos}`);
} finally {
  await pg.end({ timeout: 5 });
}
