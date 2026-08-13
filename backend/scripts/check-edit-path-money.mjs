// Read-only: the two EDIT-PATH money defects, measured against production.
//
// WHY THIS EXISTS
//
// Two defects sit on the owner's go-live requirement that EDIT must work and
// must sync. Both were found by audit, neither was fixed, and both were argued
// about from migration FILES rather than from the live schema. This script is
// the live read, so the argument stops.
//
// DEFECT 1 — editing a shipped Delivery Order never reaches the stock ledger.
//   resyncInventoryForDo writes DELTA movements into the SAME
//   (source_doc_type='DO', source_doc_id, product_code, variant_key) bucket the
//   first ship already wrote. Production carries PARTIAL UNIQUE indexes on that
//   key (uq_inv_mov_do_source and three siblings) which exist in NO file in this
//   repo, so every delta on an already-shipped bucket is rejected and the ledger
//   never moves. Sections 1-4 below prove or refute that, and COUNT the damage.
//
// DEFECT 2 — the amendment path reprices a MIGRATED order to catalogue.
//   recomputeOneLine is called with 14 positional arguments; the 15th,
//   trustOperatorSelling, defaults to false, so approving even a qty-only
//   amendment rewrites unit_price_centi to mfg_products.sell_price_sen. Section
//   6 counts how many migrated orders are exposed and how many of their lines
//   are priced 0 by design (the sofa sibling shape that a catalogue rewrite
//   would destroy).
//
// Strictly SELECTs. No DDL, no writes, no transaction, nothing inserted to make
// an answer come out a particular way. Exits 0 for every legitimate answer —
// the answer IS the output. Non-zero only when the database is unreachable.
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
const head = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* Column/table existence, so a schema that has moved on cannot make this script
   throw and read as "the check broke" instead of "here is the answer". */
async function hasCol(table, col) {
  const [r] = await pg`
    SELECT 1 AS ok FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table} AND column_name = ${col}`;
  return !!r;
}
async function hasTable(table) {
  const [r] = await pg`
    SELECT 1 AS ok FROM information_schema.tables
     WHERE table_schema = 'scm' AND table_name = ${table}`;
  return !!r;
}

const SHIPPED = ["DISPATCHED", "IN_TRANSIT", "SIGNED", "DELIVERED", "INVOICED", "COMPLETED"];

try {
  /* ── 1. THE INDEXES THAT ARE NOT IN ANY FILE ───────────────────────────────
     The whole of defect 1 rests on these existing. Print every index on
     inventory_movements verbatim, so the claim is checkable and not inherited. */
  head("1. scm.inventory_movements — EVERY index, verbatim from pg_indexes");
  const idx = await pg`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'scm' AND tablename = 'inventory_movements'
     ORDER BY indexname`;
  let uniqueOnSourceKey = [];
  /* Does the DO index carry the correction slot migration 0279 added? That is
     the single thing separating "an edit after shipping is silently refused"
     from "it lands", so the verdict has to READ it rather than restate what the
     index used to be. */
  let withCorrectionSlot = [];
  for (const r of idx) {
    const isUnique = /CREATE UNIQUE/i.test(r.indexdef);
    const onSourceKey = /source_doc_type[\s\S]*source_doc_id[\s\S]*product_code[\s\S]*variant_key/i.test(r.indexdef);
    if (isUnique && onSourceKey) {
      uniqueOnSourceKey.push(r.indexname);
      if (/correction_seq/i.test(r.indexdef)) withCorrectionSlot.push(r.indexname);
    }
    console.log(`  ${isUnique ? "UNIQUE " : "       "}${r.indexname}`);
    console.log(`          ${r.indexdef}`);
  }
  console.log("");
  if (uniqueOnSourceKey.length === 0) {
    notice("1. VERDICT: NO unique index on (source_doc_type, source_doc_id, product_code, variant_key). Defect 1's premise is REFUTED — delta rows would insert.");
  } else {
    const plain = uniqueOnSourceKey.filter((n) => !withCorrectionSlot.includes(n));
    notice(`1. VERDICT: ${uniqueOnSourceKey.length} UNIQUE index(es) on the source key: ${uniqueOnSourceKey.join(", ")}.`);
    notice(
      withCorrectionSlot.length > 0
        ? `1a. ${withCorrectionSlot.join(", ")} carr${withCorrectionSlot.length === 1 ? "ies" : "y"} COALESCE(correction_seq, 0) (migration 0279): ONE primary posting per bucket -- the double-post backstop -- plus one row per numbered correction, so an edit after shipping REACHES the ledger.`
        : "1a. NONE of them carries correction_seq. Migration 0279 has not been applied here, so every edit-after-ship delta is still silently REFUSED.",
    );
    if (plain.length > 0) {
      notice(`1b. Still four-column (one row per bucket, ever): ${plain.join(", ")}. Correct for these paths -- the DR resync posts under source_doc_type='ADJUSTMENT' instead, and the consignment paths write once.`);
    }
  }

  /* ── 2. Is source_doc_type constrained? ────────────────────────────────────
     Decides whether a NEW source_doc_type value is even available as a fix
     shape, or whether the fix must reuse an existing one. */
  head("2. Constraints on scm.inventory_movements.source_doc_type");
  const cons = await pg`
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'scm' AND rel.relname = 'inventory_movements'
       AND pg_get_constraintdef(con.oid) ILIKE '%source_doc_type%'`;
  if (cons.length === 0) notice("2. VERDICT: NO check constraint mentions source_doc_type — the column is free text at the DB level.");
  for (const c of cons) console.log(`  ${c.conname}: ${c.def}`);

  const types = await pg`
    SELECT source_doc_type, COUNT(*)::int AS n
      FROM scm.inventory_movements GROUP BY 1 ORDER BY 2 DESC`;
  console.log("\n  source_doc_type values in use:");
  for (const t of types) console.log(`    ${rpad(t.source_doc_type, 30)}${lpad(t.n, 8)}`);

  /* ── 3. Has the resync path EVER landed a row? ─────────────────────────────
     resyncInventoryForDo stamps its own notes marker on every row it writes.
     Zero rows carrying it means the path has never succeeded, once, ever. */
  head("3. Has resyncInventoryForDo ever written a movement?");
  const marker = await pg`
    SELECT source_doc_type, movement_type, COUNT(*)::int AS n
      FROM scm.inventory_movements
     WHERE notes LIKE 'Resync: line qty%'
     GROUP BY 1, 2 ORDER BY 3 DESC`;
  if (marker.length === 0) {
    notice("3. VERDICT: ZERO movements carry the resync marker ('Resync: line qty...'). The edit-after-ship path has never landed a single row in production.");
  } else {
    notice(`3. VERDICT: the resync path HAS landed rows — ${marker.reduce((a, r) => a + r.n, 0)} of them:`);
    for (const m of marker) console.log(`    ${rpad(m.source_doc_type, 12)}${rpad(m.movement_type, 12)}${lpad(m.n, 6)}`);
  }

  // The failure trail added 2026-08-05: every rejected resync leaves an audit row.
  if (await hasTable("entity_audit_log")) {
    const failed = await pg`
      SELECT entity_doc_no, created_at::date AS d, note
        FROM scm.entity_audit_log
       WHERE action = 'RECOUNT_FAILED' AND source = 'resyncInventoryForDo'
       ORDER BY created_at DESC LIMIT 50`;
    console.log("");
    if (failed.length === 0) {
      notice("3b. No RECOUNT_FAILED audit rows from resyncInventoryForDo. NOTE: that trail only exists since 2026-08-05, and only fires when an edit is actually attempted — its absence is NOT evidence the path works.");
    } else {
      notice(`3b. ${failed.length} RECOUNT_FAILED audit row(s) from resyncInventoryForDo — each one is an edit whose ledger did not follow:`);
      for (const f of failed) console.log(`    ${rpad(f.d, 12)}${rpad(f.entity_doc_no, 24)}${String(f.note ?? "").slice(0, 90)}`);
    }
  }

  /* ── 4. THE DAMAGE — shipped DOs whose ledger disagrees with the document ──
     Bucketed by ITEM CODE, not variant: delivery_order_items has no variant_key
     column (the key is computed in application code), so a variant-level join is
     not available in SQL. Per-item is the honest granularity, and it is the one
     that catches a rejected qty delta.
     Service lines never moved stock by design; cancelled DOs are excluded (their
     movements are legitimately reversed). */
  head("4. DAMAGE — shipped, non-cancelled DOs whose stock ledger != their document");

  /* MIGRATED delivery orders are excluded, and leaving them in was the single
     biggest distortion in the first run of this check: scm.delivery_orders
     carries `migrated_no_stock` (migration 0276) and a document flagged that way
     moved NO stock BY DESIGN — its goods left the building before this ERP
     existed, and the AutoCount cutover booked the balance instead. Counting
     those as "ledger disagrees with document" reported 15 Houzs Century DOs as
     damage when nothing is wrong with any of them. */
  const haveMigFlag = await hasCol("delivery_orders", "migrated_no_stock");
  notice(haveMigFlag
    ? "4pre. delivery_orders.migrated_no_stock EXISTS — migrated DOs are excluded below (they move no stock by design)."
    : "4pre. delivery_orders.migrated_no_stock NOT FOUND — cannot exclude migrated DOs; the count below is an UPPER BOUND.");

  const dmg = await pg`
    WITH eligible AS (
      SELECT d.id, d.do_number
        FROM scm.delivery_orders d
       WHERE upper(d.status::text) = ANY(${SHIPPED})
         AND (${!haveMigFlag}::boolean OR COALESCE(d.migrated_no_stock, false) = false)
    ), lines AS (
      SELECT e.id AS doc_id, e.do_number AS doc_no, i.item_code,
             SUM(i.qty)::numeric AS doc_qty
        FROM eligible e
        JOIN scm.delivery_order_items i ON i.delivery_order_id = e.id
       WHERE NOT (i.item_code ILIKE 'SVC-%' OR lower(COALESCE(i.item_group,'')) = 'service')
       GROUP BY 1, 2, 3
    ), moves AS (
      SELECT m.source_doc_id AS doc_id, m.product_code AS item_code,
             SUM(CASE WHEN m.movement_type = 'OUT' THEN ABS(m.qty) ELSE 0 END)::numeric
           - SUM(CASE WHEN m.movement_type = 'IN'  THEN ABS(m.qty) ELSE 0 END)::numeric AS net_out
        FROM scm.inventory_movements m
        JOIN eligible e ON e.id = m.source_doc_id
       WHERE m.source_doc_type = 'DO'
       GROUP BY 1, 2
    )
    SELECT COALESCE(l.doc_id, m.doc_id) AS doc_id,
           COALESCE(l.doc_no, (SELECT do_number FROM scm.delivery_orders WHERE id = m.doc_id)) AS doc_no,
           COALESCE(l.item_code, m.item_code) AS item_code,
           l.doc_qty, m.net_out,
           COALESCE(l.doc_qty, 0) - COALESCE(m.net_out, 0) AS gap
      FROM lines l
      FULL OUTER JOIN moves m ON l.doc_id = m.doc_id AND l.item_code = m.item_code
     WHERE COALESCE(l.doc_qty, 0) <> COALESCE(m.net_out, 0)
     ORDER BY 2, 3`;

  const dos = new Set(dmg.map((r) => r.doc_no));
  notice(`4. VERDICT: ${dmg.length} (DO, item) pair(s) disagree, across ${dos.size} distinct delivery order(s).`);
  if (dmg.length > 0) {
    console.log(`\n  ${rpad("DO", 24)}${rpad("item", 32)}${lpad("doc", 7)}${lpad("moved", 8)}${lpad("gap", 7)}`);
    for (const r of dmg.slice(0, 120)) {
      console.log(`  ${rpad(r.doc_no, 24)}${rpad(r.item_code, 32)}${lpad(r.doc_qty ?? "-", 7)}${lpad(r.net_out ?? "-", 8)}${lpad(r.gap, 7)}`);
    }
    if (dmg.length > 120) console.log(`  ... and ${dmg.length - 120} more`);
  }

  /* Which shipped DOs were EDITED AFTER SHIPPING? That is the population defect
     1 can silently mis-state, as distinct from the other known ledger faults
     (the duplicate-DO pair, the MAKOTO variant drift).

     There is no shipped_at on scm.delivery_orders and no updated_at on
     scm.delivery_order_items — the first run of this check assumed both and got
     nothing. The ship instant that DOES always exist is the DO's own first
     inventory movement: deductInventoryForDo writes it at the moment of
     dispatch. Any entity_audit_log row for the DO after that is an edit that
     landed on an already-shipped document. */
  console.log("");
  if (!(await hasTable("entity_audit_log"))) {
    notice("4b. No scm.entity_audit_log — cannot attribute to edit-after-ship. Reporting the total only.");
  } else {
    const actions = await pg`
      SELECT a.action, COUNT(*)::int AS n
        FROM scm.entity_audit_log a
       WHERE a.entity_type = 'DELIVERY_ORDER'
       GROUP BY 1 ORDER BY 2 DESC`;
    console.log("  entity_audit_log actions recorded for DELIVERY_ORDER:");
    for (const a of actions) console.log(`    ${rpad(a.action, 30)}${lpad(a.n, 7)}`);
    if (actions.length === 0) console.log("    (none)");

    /* entity_id is text and delivery_orders.id is uuid, so the join casts both
       to text. Wrapped because an attribution failure must not sink the DAMAGE
       count above, which is the number that actually matters. */
    let edited = [];
    try {
      edited = await pg`
        WITH ship AS (
          SELECT m.source_doc_id AS doc_id, MIN(m.created_at) AS shipped_at
            FROM scm.inventory_movements m
           WHERE m.source_doc_type = 'DO'
           GROUP BY 1
        )
        SELECT d.do_number, d.status, s.shipped_at,
               COUNT(a.id)::int AS post_ship_audit_rows
          FROM scm.delivery_orders d
          JOIN ship s ON s.doc_id = d.id
          JOIN scm.entity_audit_log a
            ON a.entity_type = 'DELIVERY_ORDER'
           AND a.entity_id::text = d.id::text
           AND a.created_at > s.shipped_at
         WHERE upper(d.status::text) = ANY(${SHIPPED})
         GROUP BY 1, 2, 3
         ORDER BY 1`;
    } catch (e) {
      notice(`4b. Attribution query failed (${e?.message ?? e}) — the DAMAGE count above still stands.`);
      edited = null;
    }
    if (edited) {
      console.log("");
      notice(`4b. ${edited.length} shipped DO(s) carry an audit row written AFTER their first stock movement — the population an edit-after-ship can silently mis-state.`);
      const gapSet = new Set(dmg.map((r) => r.doc_no));
      const both = edited.filter((e) => gapSet.has(e.do_number));
      notice(`4c. ${both.length} of those ALSO have a ledger/document gap.`);
      for (const e of edited.slice(0, 60)) {
        console.log(`    ${rpad(e.do_number, 24)}${rpad(e.status, 14)}post-ship audit rows: ${lpad(e.post_ship_audit_rows, 3)}${gapSet.has(e.do_number) ? "   <- LEDGER GAP" : ""}`);
      }
      if (edited.length > 60) console.log(`    ... and ${edited.length - 60} more`);
    }
  }

  /* ── 5. Could a partial UNIQUE index be added anywhere? ────────────────────
     A unique index cannot be built over duplicate rows. Per source_doc_type,
     count the buckets that already hold more than one row. Any type with a
     non-zero count can never carry this index; a TABLE-WIDE one is impossible if
     any type is non-zero. */
  head("5. Duplicate (source_doc_type, source_doc_id, product_code, variant_key) buckets");
  const dup = await pg`
    SELECT source_doc_type,
           COUNT(*)::int AS dup_buckets,
           SUM(n)::int   AS rows_in_them
      FROM (
        SELECT source_doc_type, source_doc_id, product_code, COALESCE(variant_key,'') AS vk, COUNT(*)::int AS n
          FROM scm.inventory_movements
         GROUP BY 1,2,3,4
        HAVING COUNT(*) > 1
      ) q
     GROUP BY 1 ORDER BY 2 DESC`;
  const totalDup = dup.reduce((a, r) => a + r.dup_buckets, 0);
  console.log(`  ${rpad("source_doc_type", 30)}${lpad("dup buckets", 13)}${lpad("rows", 8)}`);
  for (const d of dup) console.log(`  ${rpad(d.source_doc_type, 30)}${lpad(d.dup_buckets, 13)}${lpad(d.rows_in_them, 8)}`);
  console.log("");
  notice(`5. VERDICT: ${totalDup} duplicate bucket(s) in total. A TABLE-WIDE unique index on that key is ${totalDup > 0 ? "IMPOSSIBLE" : "possible"}; any new index must stay PARTIAL.`);

  /* Same question with movement_type joined in — i.e. would the "add
     movement_type to the index" candidate shape even be buildable today, and
     does it actually solve repeated edits? */
  const dupWithMt = await pg`
    SELECT source_doc_type, COUNT(*)::int AS dup_buckets
      FROM (
        SELECT source_doc_type, source_doc_id, product_code, COALESCE(variant_key,'') AS vk, movement_type, COUNT(*)::int AS n
          FROM scm.inventory_movements
         GROUP BY 1,2,3,4,5
        HAVING COUNT(*) > 1
      ) q
     GROUP BY 1 ORDER BY 2 DESC`;
  console.log("\n  With movement_type ADDED to the key (the alternative fix shape):");
  if (dupWithMt.length === 0) console.log("    no duplicates — such an index would build.");
  for (const d of dupWithMt) console.log(`    ${rpad(d.source_doc_type, 30)}${lpad(d.dup_buckets, 13)}`);

  /* ── 6. DEFECT 2 EXPOSURE — migrated orders and their 0-priced lines ───────
     linked_ac_docno IS NOT NULL is the migrated marker that actually exists on
     the SO/PO headers. migrated_no_stock does NOT exist there; a prior agent's
     run died on that assumption, so this section proves which is which. */
  head("6. DEFECT 2 — migrated-order exposure to the amendment reprice");
  for (const [t, c] of [
    ["mfg_sales_orders", "linked_ac_docno"],
    ["mfg_sales_orders", "migrated_no_stock"],
    ["mfg_sales_orders", "processing_date"],
    ["purchase_orders", "linked_ac_docno"],
    ["purchase_orders", "migrated_no_stock"],
  ]) {
    console.log(`  scm.${rpad(t, 20)}.${rpad(c, 24)} exists: ${await hasCol(t, c)}`);
  }

  if (await hasCol("mfg_sales_orders", "linked_ac_docno")) {
    const [m] = await pg`
      SELECT COUNT(*)::int AS migrated,
             COUNT(*) FILTER (WHERE processing_date IS NOT NULL)::int AS with_dd
        FROM scm.mfg_sales_orders
       WHERE linked_ac_docno IS NOT NULL`;
    console.log("");
    notice(`6a. ${m.migrated} migrated SO(s) (linked_ac_docno set). ${m.with_dd} of them already carry processing_date — those are the ones that can reach the amendment path TODAY.`);

    const lineTable = (await hasTable("mfg_sales_order_items")) ? "mfg_sales_order_items" : null;
    if (lineTable && (await hasCol(lineTable, "unit_price_centi"))) {
      /* Lines join their header by (doc_no, company_id) — mfg_sales_order_items
         carries no header id FK; every script in this tree joins it that way. */
      const [z] = await pg`
        SELECT COUNT(*)::int AS lines,
               COUNT(*) FILTER (WHERE COALESCE(i.unit_price_centi,0) = 0)::int AS zero_priced
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders h
            ON h.doc_no = i.doc_no AND h.company_id = i.company_id
         WHERE h.linked_ac_docno IS NOT NULL`;
      const pct = z.lines > 0 ? Math.round((z.zero_priced / z.lines) * 1000) / 10 : 0;
      notice(`6b. Those orders hold ${z.lines} line(s), of which ${z.zero_priced} (${pct}%) are priced 0. EVERY one of them would take a catalogue price on the next approved amendment before the 'including-zero' fix.`);

      /* The first version of this line asserted that the 0-priced lines ARE "the
         sofa-sibling shape (whole set on the lead module, 0 on the siblings)".
         It never measured category, and 78% of all migrated lines being sofa
         siblings was never plausible — most are simply lines the import carried
         without a price. The sofa-sibling shape is the WORST case in here, not
         the whole of it, and the difference matters: a stale fact in a
         diagnostic is worse than no fact, because the diagnostic is what the
         next person trusts. So measure it instead of asserting it. */
      const byGroup = await pg`
        SELECT COALESCE(NULLIF(lower(trim(i.item_group)), ''), '(none)') AS grp,
               COUNT(*)::int AS lines,
               COUNT(*) FILTER (WHERE COALESCE(i.unit_price_centi,0) = 0)::int AS zero_priced
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders h
            ON h.doc_no = i.doc_no AND h.company_id = i.company_id
         WHERE h.linked_ac_docno IS NOT NULL
         GROUP BY 1 ORDER BY 3 DESC`;
      console.log(`\n  ${rpad("item_group", 30)}${lpad("lines", 8)}${lpad("priced 0", 10)}`);
      for (const g of byGroup) console.log(`  ${rpad(g.grp, 30)}${lpad(g.lines, 8)}${lpad(g.zero_priced, 10)}`);
      const sofaZero = byGroup.filter((g) => g.grp.includes('sofa')).reduce((a, g) => a + g.zero_priced, 0);
      console.log("");
      notice(`6c. Of the 0-priced migrated lines, ${sofaZero} are SOFA — the lead-module/sibling shape where a catalogue rewrite bills the same set several times over. The rest are lines the import carried without a price; preserving them is still correct, but it is a different fact.`);
    } else {
      notice("6b. Could not measure 0-priced migrated lines: line table / unit_price_centi column not found under the expected names.");
    }
  }

  console.log("");
  notice("Done. Every number above is a SELECT against production; nothing was written.");
  process.exit(0);
} catch (e) {
  console.error("Database unreachable or a query failed:", e?.message ?? e);
  process.exit(1);
}
