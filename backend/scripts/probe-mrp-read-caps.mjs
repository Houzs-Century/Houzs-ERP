#!/usr/bin/env node
/* How many rows does each of MRP's reads actually MATCH, and where in that
   read's own ORDER BY does one named SO line sit? Read-only.

   WHY THIS EXISTS. routes/mrp.ts reads its demand and its PO supply with
   `.limit(5000)` and a loud guard that throws when the returned length REACHES
   5000. Every other read it makes (inventory_balances, warehouses, suppliers,
   supplier_material_bindings, the category-only mfg_products read) carries no
   limit at all. PostgREST applies its OWN row ceiling on top of whatever the
   caller asked for, and this codebase has already been bitten by it once: the
   comment above section 2 of routes/mrp.ts records an unbounded
   `mfg_products.select()` silently returning ~1000 rows, which resolved
   out-of-slice SO lines to a null category and dropped them from the page.

   A ceiling BELOW the requested 5000 is invisible to that guard: the read comes
   back short, `length >= 5000` is false, and the plan is computed over a slice
   in `ORDER BY id` order — a v4 uuid, i.e. an order with no business meaning.
   Whether a given line survives is then a coin flip on its uuid.

   This probe does NOT re-derive MRP's bucket key or its allocation. It asks the
   database only for row COUNTS under MRP's own SQL-side filters, and for the
   rank of one line under the read's own ORDER BY, so a human can compare those
   two numbers against any ceiling and see for himself whether the line is
   inside the slice.

   DOC="HC-SO-2608-003" CODE="JAGER-(K)" node scripts/probe-mrp-read-caps.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const DOC = (process.env.DOC || '').trim();
if (!DOC) { console.error('need DOC="HC-SO-2608-003"'); process.exit(2); }
const CODE = (process.env.CODE || '').trim() || null;
const CO = Number(process.env.COMPANY || 1);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* Copied from routes/mrp.ts. Printed so a drift is visible rather than assumed:
   SO_DONE is shared/so-terminal-states.ts; PO_DEAD is TWO statuses, not three —
   a CLOSED purchase order still counts as supply on that page. */
const SO_DONE = ['SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'];
const PO_DEAD = ['CANCELLED', 'DRAFT'];

/* The ceilings worth comparing against: PostgREST's historical default, and the
   explicit ask in routes/mrp.ts (MRP_LOAD_CAP). */
const CEILINGS = [1000, 5000];

const verdict = (rank) => CEILINGS
  .map((c) => `<=${c}: ${rank <= c ? 'INSIDE' : `OUTSIDE — dropped if the ceiling is ${c}`}`)
  .join('   |   ');

/* Every count is guarded: a column this probe guesses wrong about must print
   its own error, not abort the reads that DO work. */
const count = async (label, fn) => {
  try {
    const [r] = await fn();
    note(`  ${label.padEnd(28)} ${r.n}`);
    return Number(r.n);
  } catch (e) {
    note(`  ${label.padEnd(28)} QUERY FAILED: ${e.message}`);
    return null;
  }
};

async function main() {
  note(`\n${'='.repeat(72)}`);
  note(`=== MRP read sizes, company ${CO} — DOC ${DOC}${CODE ? `, CODE ${CODE}` : ''} ===`);
  note(`  SO_DONE  ${SO_DONE.join(',')}`);
  note(`  PO_DEAD  ${PO_DEAD.join(',')}   (routes/mrp.ts counts CLOSED POs as supply)`);

  /* ── 1. DEMAND — mfg_sales_order_items, MRP's own SQL-side filters ────────
     routes/mrp.ts: .eq('cancelled', false).not('so.status','in',SO_DONE)
     .order('id').limit(5000), company-scoped on the OUTER table only. The
     embed is `so:mfg_sales_orders!inner`, whose FK is items.doc_no ->
     orders.doc_no (2990s-full-schema.sql), so the join is on doc_no alone. A
     NULL header status is dropped by NOT IN, exactly as PostgREST's not.in
     does — hence the negated = ANY here. */
  note(`\n--- 1. DEMAND read (mfg_sales_order_items, ORDER BY id, limit 5000) ---`);
  const demandN = await count('rows MATCHING the filters', () => sql`
    SELECT count(*)::bigint AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
     WHERE i.company_id = ${CO}::bigint
       AND i.cancelled = false
       AND NOT (s.status::text = ANY(${SO_DONE}::text[]))`);
  note(`  MRP throws mrp_load_truncated only when the read RETURNS >= 5000.`);

  const demandRanked = await sql`
    WITH d AS (
      SELECT i.id::text AS id, i.doc_no, i.item_code, i.line_no,
             row_number() OVER (ORDER BY i.id) AS rn
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
       WHERE i.company_id = ${CO}::bigint
         AND i.cancelled = false
         AND NOT (s.status::text = ANY(${SO_DONE}::text[]))
    )
    SELECT * FROM d WHERE doc_no = ${DOC} ORDER BY line_no`;
  note(`\n  ${DOC} line ranks under ORDER BY id (of ${demandN ?? '?'} matching rows):`);
  if (!demandRanked.length) note(`    (no line of ${DOC} matches the demand filters at all)`);
  for (const r of demandRanked) {
    note(`    line ${r.line_no}  ${String(r.item_code).padEnd(26)} id=${r.id}`);
    note(`        rank ${r.rn}   ${verdict(Number(r.rn))}`);
  }

  /* Same question for every live line of one item code: if the ceiling bites,
     the page shows SOME of a code's demand and silently loses the rest. */
  if (CODE) {
    try {
      const [s] = await sql`
        WITH d AS (
          SELECT i.item_code, row_number() OVER (ORDER BY i.id) AS rn
            FROM scm.mfg_sales_order_items i
            JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
           WHERE i.company_id = ${CO}::bigint
             AND i.cancelled = false
             AND NOT (s.status::text = ANY(${SO_DONE}::text[]))
        )
        SELECT count(*)::bigint AS total,
               count(*) FILTER (WHERE rn <= 1000)::bigint AS within_1000,
               count(*) FILTER (WHERE rn <= 5000)::bigint AS within_5000
          FROM d WHERE item_code = ${CODE}`;
      note(`\n  live demand lines for ${CODE}: ${s.total}   inside first 1000: ${s.within_1000}   inside first 5000: ${s.within_5000}`);
    } catch (e) { note(`\n  ${CODE} spread QUERY FAILED: ${e.message}`); }
  }

  /* ── 2. PO SUPPLY — purchase_order_items, MRP's own SQL-side filters ──── */
  note(`\n--- 2. PO SUPPLY read (purchase_order_items, ORDER BY id, limit 5000) ---`);
  await count('rows MATCHING the filters', () => sql`
    SELECT count(*)::bigint AS n
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE i.company_id = ${CO}::bigint
       AND NOT (p.status::text = ANY(${PO_DEAD}::text[]))`);

  /* ── 3. Reads MRP makes with NO limit at all ──────────────────────────── */
  note(`\n--- 3. UNLIMITED reads (no .limit() in routes/mrp.ts) ---`);
  await count('inventory_balances', () => sql`
    SELECT count(*)::bigint AS n FROM scm.inventory_balances WHERE company_id = ${CO}::bigint`);
  await count('mfg_products', () => sql`
    SELECT count(*)::bigint AS n FROM scm.mfg_products WHERE company_id = ${CO}::bigint`);
  await count('warehouses (active)', () => sql`
    SELECT count(*)::bigint AS n FROM scm.warehouses WHERE company_id = ${CO}::bigint AND is_active = true`);
  await count('state_warehouse_mappings', () => sql`
    SELECT count(*)::bigint AS n FROM scm.state_warehouse_mappings WHERE company_id = ${CO}::bigint`);
  await count('supplier_material_bindings', () => sql`
    SELECT count(*)::bigint AS n FROM scm.supplier_material_bindings
     WHERE company_id = ${CO}::bigint AND material_kind = 'mfg_product'`);

  /* ── 4. effQty — does anything already claim this line's quantity? ─────── */
  note(`\n--- 4. delivered-so-far (MRP drops a line whose remaining hits 0) ---`);
  try {
    const dels = await sql`
      SELECT i.line_no, i.item_code, i.qty,
             coalesce(sum(dl.qty) FILTER (
               WHERE upper(d.status::text) NOT IN ('CANCELLED','DRAFT')), 0) AS delivered
        FROM scm.mfg_sales_order_items i
        LEFT JOIN scm.delivery_order_items dl ON dl.so_item_id = i.id
        LEFT JOIN scm.delivery_orders d ON d.id = dl.delivery_order_id
       WHERE i.doc_no = ${DOC} AND i.company_id = ${CO}::bigint AND i.cancelled = false
       GROUP BY i.line_no, i.item_code, i.qty
       ORDER BY i.line_no`;
    for (const d of dels) {
      note(`  line ${d.line_no}  ${String(d.item_code).padEnd(26)} qty=${d.qty} delivered=${d.delivered} remaining=${Number(d.qty) - Number(d.delivered)}`);
    }
  } catch (e) { note(`  QUERY FAILED: ${e.message}`); }

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
