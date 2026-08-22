#!/usr/bin/env node
/* Read-only: how many document lines carry a category that DISAGREES with their
 * own SKU, and how much stock is therefore sitting in the wrong bucket?
 *
 * WHAT THIS IS ABOUT, in the owner's words (2026-08-22), looking at
 * HC-SO-2608-004: 「明明已经送达货物了，可是它却不是说 Ready，所以这整个链路 ...
 * 是不是有 bug 之类的？」
 *
 * It was. `item_group` is not a label — it is an INPUT TO THE STOCK BUCKET.
 * `computeVariantKey(item_group, variants)` folds a sofa's fabric / seat / leg
 * into the key ONLY when the group is sofa or bedframe; for `others`,
 * `accessory`, `service`, `mattress` or NULL it returns '' by design
 * (shared/variant-key.ts, ATTRS_BY_GROUP). So a sofa line that reaches the
 * database with a blank or wrong group puts its goods in the UNCLASSIFIED
 * bucket, and every later reader — the delivery order's stock check, the
 * allocator, the READY projection — looks in the sofa bucket and finds nothing.
 * The goods are in the warehouse, at the right value, with their `variants`
 * jsonb intact, and invisible.
 *
 * PR #2660 stopped it happening again: the server now resolves the category
 * from `mfg_products` instead of believing the client. **It did not move the
 * goods that were already misfiled**, and nobody has counted them. That is what
 * this measures, and it is the input to deciding whether a repair script is
 * worth writing.
 *
 * THE TEST IS THE SKU, not a guess about the variants. A line is a FINDING when
 * its stored `item_group` disagrees with `mfg_products.category` for the same
 * `item_code` in the same company — which is exactly the comparison the fix now
 * makes at write time. A line whose SKU is unknown is reported SEPARATELY as
 * unresolvable rather than counted as a fault: an item code with no product row
 * is a different problem and lumping the two together would overstate this one.
 *
 * SCOPE. Purchase-order lines, GRN lines and sales-order lines — the three the
 * SO -> PO -> GRN chain writes. Read-only, one SELECT per table, no DDL, no
 * writes, no transaction.
 *
 * COUNTS ONLY. This repository and its Actions logs are PUBLIC, so the output
 * is how many rows and which category pairs, never a document number, an item
 * code, a customer or a value.
 *
 * RE-RUN: safe and idempotent; it is a SELECT.
 *
 * UNTESTED as of writing — a workflow_dispatch workflow is not shipped until it
 * has been dispatched once and reported success. Delete this line after the
 * first green run and paste the run id in its place. */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The groups whose key folds in variant attributes. A line in one of these is
   in a DIFFERENT bucket from the same code in any other group — which is what
   makes a disagreement matter rather than merely look untidy.
   Mirrors ATTRS_BY_GROUP in backend/src/scm/shared/variant-key.ts. */
const KEYED_GROUPS = new Set(["sofa", "bedframe"]);
const norm = (s) => String(s ?? "").trim().toLowerCase();

const LINE_TABLES = [
  ["purchase_order_items", "Purchase Order lines"],
  ["grn_items",            "Goods Received lines"],
  ["mfg_sales_order_items", "Sales Order lines"],
];

async function main() {
  note("=== check-stock-in-the-wrong-bucket (read-only, counts only) ===");

  /* The SKU master, once. `code` is shared across both companies by design
     (grns.ts:287), so the category is looked up by code alone here — the same
     assumption the fix makes. */
  let products;
  try {
    products = await sql`SELECT code, category FROM scm.mfg_products WHERE code IS NOT NULL`;
  } catch (e) {
    note(`  COULD NOT READ scm.mfg_products — ${e.message}`);
    note("  Without the SKU master there is no comparison to make. Stopping rather than");
    note("  reporting a clean run over nothing.");
    await sql.end({ timeout: 5 });
    process.exit(1);
  }
  const catOf = new Map();
  for (const p of products) catOf.set(norm(p.code), norm(p.category));
  note(`  SKU master: ${products.length} products\n`);

  let bucketAffecting = 0;

  for (const [table, label] of LINE_TABLES) {
    let rows;
    try {
      rows = await sql`
        SELECT item_code, item_group, COUNT(*)::int AS n
          FROM ${sql("scm")}.${sql(table)}
         WHERE item_code IS NOT NULL
         GROUP BY 1, 2`;
    } catch (e) {
      note(`${label} (scm.${table}): COULD NOT READ — ${e.message}\n`);
      continue;
    }

    let total = 0, agree = 0, unknownSku = 0;
    /* "stored group -> real category" pair -> row count. Naming the PAIR is what
       makes the output actionable: it says which way the drift goes. */
    const mismatches = new Map();
    let affecting = 0;

    for (const r of rows) {
      total += r.n;
      const real = catOf.get(norm(r.item_code));
      if (real === undefined) { unknownSku += r.n; continue; }
      const stored = norm(r.item_group);
      if (stored === real) { agree += r.n; continue; }
      const key = `${stored || "(blank)"} -> ${real || "(blank)"}`;
      mismatches.set(key, (mismatches.get(key) ?? 0) + r.n);
      /* Only a disagreement that CROSSES the keyed/unkeyed line moves the goods
         to a different bucket. others<->accessory is untidy; sofa<->others is
         the fault that hid HC-SO-2608-004's stock. */
      if (KEYED_GROUPS.has(stored) !== KEYED_GROUPS.has(real)) affecting += r.n;
    }

    bucketAffecting += affecting;
    const bad = [...mismatches.values()].reduce((s, n) => s + n, 0);
    note(`${label} (scm.${table})`);
    note(`    ${total} lines · ${agree} agree with their SKU · ${bad} disagree · ${unknownSku} SKU not found`);
    note(`    ${affecting} of the disagreements CHANGE THE STOCK BUCKET`);
    for (const [pair, n] of [...mismatches.entries()].sort((a, b) => b[1] - a[1])) {
      const marks = KEYED_GROUPS.has(norm(pair.split(" -> ")[0])) !== KEYED_GROUPS.has(norm(pair.split(" -> ")[1]));
      note(`      ${String(n).padStart(5)}  stored ${pair}${marks ? "   <== wrong bucket" : ""}`);
    }
    note("");
  }

  note("=== VERDICT ===");
  note(bucketAffecting === 0
    ? "  ZERO lines sit in the wrong stock bucket. PR #2660 stopped the leak and there"
      + " is nothing already misfiled to repair — no repair script is needed."
    : `  ${bucketAffecting} line(s) carry a category that puts their goods in a DIFFERENT`
      + ` bucket from the one their SKU belongs to. PR #2660 stops NEW ones; these are`
      + ` already written and a repair has to move them. Read the pairs above before`
      + ` writing one — the direction of the drift decides what the repair does.`);

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
