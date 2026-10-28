// Read-only: every stock bucket where the two ledgers disagree, catalogue-wide.
//
// WHY THIS EXISTS
//
// Houzs keeps stock in two ledgers and they are allowed to drift apart:
//
//   MOVEMENT  scm.inventory_balances — SUM(IN) − SUM(OUT). What MRP allocates
//             from, and what the Inventory list's Available used to be computed
//             from.
//   LOT       scm.v_inventory_lots_open — the open FIFO lots. What can actually
//             be claimed and costed, and what the Inventory list's Stock column
//             shows.
//
// NEITHER IS UNIVERSALLY RIGHT. That is the whole point of this check, and the
// repo proves it from both directions:
//
//   2026-08-04  plan-phantom-lots.mjs: "The MOVEMENT ledger ... is CORRECT on
//               all of them, proven against the documents. The LOT ledger
//               carries units that are not there."
//   2026-08-05  reconcile-sku.mjs against the five drifting sofas: every one
//               came back "movement WRONG / lots matches" —
//                 XAMMAR-1A(LHF)  documents 0   movement −1   lots 0
//                 XAMMAR-2A(RHF)  documents 1   movement  0   lots 1
//                 OMMBUC-1A(LHF)  documents 0   movement −1   lots 0
//                 OMMBUC-2A(RHF)  documents 0   movement −1   lots 0
//
// So "which ledger do we trust" has no global answer, and any screen that picks
// one silently is guessing on half its rows. What CAN be answered globally is
// WHICH BUCKETS DISAGREE — and that is the list a planner needs, because those
// are exactly the MRP rows whose supply figure cannot be relied on.
//
// This does not repair anything and deliberately has no APPLY path. Settle a
// bucket with `reconcile-sku.mjs`, which walks the actual GRN receipts and DO
// shipments and states what the documents require. Only then repair.
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
const lpad = (s, n) => String(s ?? "").padStart(n);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  /* Bucketed by (company, warehouse, product, variant_key) — the SAME key MRP
     allocates on, so a row here maps one-to-one onto an MRP row. A SKU can
     balance overall while two of its variants cancel out, which is why this
     must not be aggregated to the product. */
  const rows = await pg`
    WITH mv AS (
      SELECT company_id, warehouse_id, item_code,
             COALESCE(variant_key, '') AS variant_key,
             SUM(qty)::numeric         AS qty
        FROM scm.inventory_balances
       GROUP BY 1, 2, 3, 4
    ), lot AS (
      SELECT company_id, warehouse_id, item_code,
             COALESCE(variant_key, '')      AS variant_key,
             SUM(qty_remaining)::numeric    AS qty
        FROM scm.v_inventory_lots_open
       GROUP BY 1, 2, 3, 4
    )
    SELECT COALESCE(mv.company_id, lot.company_id)       AS company_id,
           COALESCE(mv.item_code, lot.item_code)   AS item_code,
           COALESCE(mv.variant_key, lot.variant_key)     AS variant_key,
           COALESCE(mv.qty, 0)                           AS movement_qty,
           COALESCE(lot.qty, 0)                          AS lot_qty,
           COALESCE(mv.qty, 0) - COALESCE(lot.qty, 0)    AS diff
      FROM mv
      FULL OUTER JOIN lot
        ON  mv.company_id  = lot.company_id
        AND mv.warehouse_id = lot.warehouse_id
        AND mv.item_code = lot.item_code
        AND mv.variant_key  = lot.variant_key
     WHERE COALESCE(mv.qty, 0) <> COALESCE(lot.qty, 0)
     ORDER BY ABS(COALESCE(mv.qty, 0) - COALESCE(lot.qty, 0)) DESC,
              COALESCE(mv.item_code, lot.item_code)`;

  if (rows.length === 0) {
    notice("The two ledgers agree on every bucket. Nothing to reconcile.");
    process.exit(0);
  }

  const negativeMovement = rows.filter((r) => Number(r.movement_qty) < 0);
  const negativeLot = rows.filter((r) => Number(r.lot_qty) < 0);

  notice(`${rows.length} bucket(s) where the two ledgers disagree.\n`);
  console.log(
    `  ${rpad("product", 34)}${rpad("variant", 44)}${lpad("movement", 10)}${lpad("lots", 8)}${lpad("diff", 8)}  co`,
  );
  for (const r of rows) {
    console.log(
      `  ${rpad(r.item_code, 34)}${rpad(r.variant_key || "(none)", 44)}` +
        `${lpad(r.movement_qty, 10)}${lpad(r.lot_qty, 8)}${lpad(r.diff, 8)}  ${r.company_id}`,
    );
  }

  console.log("");
  /* A NEGATIVE on-hand is not a close call — no warehouse holds minus one sofa.
     Whichever ledger reports it is the wrong one for that bucket, and saying so
     costs nothing and saves a reconcile. */
  if (negativeMovement.length > 0) {
    notice(
      `${negativeMovement.length} bucket(s) have a NEGATIVE movement balance. ` +
        "A warehouse cannot hold minus one of anything, so the movement ledger " +
        "is the wrong side on those — the same shape reconcile-sku confirmed " +
        "for the five sofas on 2026-08-05.",
    );
  }
  if (negativeLot.length > 0) {
    notice(
      `${negativeLot.length} bucket(s) have a NEGATIVE lot balance — the lot ` +
        "ledger is the wrong side there.",
    );
  }
  notice(
    "Do NOT repair from this list alone. It says WHICH buckets disagree, not " +
      "which side is right — the repo has evidence both ways (2026-08-04 the " +
      "lots were wrong, 2026-08-05 the movements were). Settle each one with " +
      "reconcile-sku.mjs, which walks the actual receipts and shipments, and " +
      "repair only what the documents decide.",
  );
} finally {
  await pg.end({ timeout: 5 });
}
