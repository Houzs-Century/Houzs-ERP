// Read-only: WHO wrote each consumption row on the over-consumed lots, and when.
//
// THE QUESTION THIS SETTLES (2026-08-05). Four sofa lots read received=1,
// consumed=2, remaining=0 — one unit received, two consumed. Static analysis
// proved the mechanism REQUIRES the lot to have passed through a state with
// consumption rows present AND qty_remaining still positive (every consumer is
// gated on qty_remaining > 0 and decrements exactly what it inserts). Static
// analysis cannot say WHO created that state. The rows themselves can:
//
//   trigger-authored row   created_by = the movement's performed_by (a real id),
//                          consumed_at = the ship-time now()
//   reconstruct-repair row created_by NULL, consumed_at = the repair run date
//                          (backfill-fifo-divergence.mjs writes literal NULL)
//   doc-relabel repoint    keeps the ORIGINAL consumed_at (copied, not reset)
//
// Two trigger-authored rows on one over-consumed lot  -> the lot was consumable
// twice in normal shipping (the import-top-up hypothesis). A repair-authored row
// -> a repair double-counted. Rows sharing one movement_id -> over-attribution
// (audit 10c), a different fault again.
//
// Also prints, per lot, the OUT movements of its consumers with their DO and
// whether that DO still carries a LINE for the item — the orphan-movement axis
// measured the same day (DOs 2990-DO-2607-016/-017).
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — the answer IS the output.
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
const rpad = (s, n) => String(s ?? "").padEnd(n);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  /* Every lot that breaks conservation on the over-consumed side, discovered
     from the ledger itself — no hardcoded ids, so this re-runs cleanly after
     any repair and reports whatever remains. */
  const lots = await pg`
    SELECT l.id, l.item_code, COALESCE(l.variant_key,'') AS variant_key,
           l.batch_no, l.qty_received, l.qty_remaining, l.unit_cost_sen,
           COALESCE(c.consumed, 0) AS consumed
      FROM scm.inventory_lots l
      JOIN LATERAL (
        SELECT SUM(qty_consumed) AS consumed
          FROM scm.inventory_lot_consumptions
         WHERE lot_id = l.id
      ) c ON TRUE
     WHERE COALESCE(c.consumed, 0) > l.qty_received
     ORDER BY l.item_code`;

  if (lots.length === 0) {
    notice("No over-consumed lot anywhere (consumed <= received on every lot). Nothing to attribute.");
    process.exit(0);
  }

  notice(`${lots.length} over-consumed lot(s). Attribution below — the verdict is per row, not per lot.`);

  for (const lot of lots) {
    console.log("=".repeat(78));
    console.log(
      `${lot.item_code}  lot ${lot.id}\n` +
        `  key="${lot.variant_key}" batch=${lot.batch_no ?? "-"} ` +
        `received=${lot.qty_received} consumed=${lot.consumed} remaining=${lot.qty_remaining}`,
    );

    const rows = await pg`
      SELECT c.id, c.movement_id, c.qty_consumed, c.unit_cost_sen,
             c.consumed_at, c.created_by,
             m.movement_type, m.source_doc_type, m.source_doc_no, m.created_at AS movement_at,
             m.performed_by AS movement_by
        FROM scm.inventory_lot_consumptions c
        LEFT JOIN scm.inventory_movements m ON m.id = c.movement_id
       WHERE c.lot_id = ${lot.id}
       ORDER BY c.consumed_at NULLS LAST, c.id`;

    for (const r of rows) {
      const author =
        r.created_by == null && r.movement_by != null
          ? "REPAIR-AUTHORED (created_by NULL)"
          : r.created_by == null
            ? "author unknown (both ids NULL)"
            : "trigger-authored (ship-time)";
      console.log(
        `  consumption ${r.id}\n` +
          `    qty=${r.qty_consumed}  at=${String(r.consumed_at ?? "-").slice(0, 19)}  ${author}\n` +
          `    movement ${r.movement_id ?? "(none)"}  ${r.movement_type ?? "-"}  ` +
          `${r.source_doc_type ?? "-"} ${r.source_doc_no ?? "-"}  movement_at=${String(r.movement_at ?? "-").slice(0, 10)}`,
      );
    }

    // Same movement consumed twice = over-attribution (10c), not a double ship.
    const movementIds = new Set(rows.map((r) => r.movement_id));
    if (movementIds.size === 1 && rows.length > 1) {
      console.log(`  NOTE: all ${rows.length} rows share ONE movement — over-attribution (audit 10c), not a second shipment.`);
    }

    /* Does each consuming DO still carry a LINE for this item? A consumption
       whose DO has no line is the orphan-movement shape. */
    const doNos = [...new Set(rows.map((r) => r.source_doc_no).filter(Boolean))];
    for (const doNo of doNos) {
      const [line] = await pg`
        SELECT COALESCE(SUM(i.qty), 0) AS qty
          FROM scm.delivery_order_items i
          JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
         WHERE d.do_number = ${doNo} AND i.item_code = ${lot.item_code}`;
      console.log(
        `  ${rpad(doNo, 22)} document line qty for ${lot.item_code}: ${line.qty}` +
          (Number(line.qty) === 0 ? "   <- NO LINE: this consumption's shipment is undocumented" : ""),
      );
    }
  }

  console.log("");
  notice(
    "Reading the verdicts: two trigger-authored rows on one lot -> the lot was " +
      "consumable twice in normal shipping (stale qty_remaining, the import " +
      "top-up shape). A REPAIR-AUTHORED row -> a repair double-counted. A " +
      "consuming DO with NO LINE -> that shipment is the orphan-movement fault " +
      "and the reversal decision goes through the owner, never a blind delete — " +
      "these rows carry live COGS.",
  );
} finally {
  await pg.end({ timeout: 5 });
}
