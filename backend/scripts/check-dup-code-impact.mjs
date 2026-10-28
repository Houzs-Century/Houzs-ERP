// Read-only: what would MERGING one product code into another actually move?
//
// The owner, 2026-09-10: `9058-Console` and `9058-CONSOLE` are two products with
// one description (SOFA MAYBATCH CONSOLE) and different main suppliers. He chose
// to merge them and keep `9058-Console`. Before a single row moves he is owed the
// blast radius: how many sales-order lines, purchase-order lines, stock movements
// / balances, supplier bindings and price rows each code carries, so "merge" is a
// decision made on numbers, not a leap.
//
// This COUNTS, per code, every place a code is the key. It writes NOTHING. The
// merge itself is a separate, gated script written only after these numbers are
// seen — and stock is the reason to look before leaping: two codes are two
// buckets in `inventory_movements`, and moving one onto the other re-keys history.
//
//   DATABASE_URL   required
//   KEEP           the survivor code       (default 9058-Console)
//   DROP           the code to merge away   (default 9058-CONSOLE)
//   COMPANY_ID     default 1
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL required'); process.exit(1); }
const KEEP = (process.env.KEEP ?? '9058-Console').trim();
const DROP = (process.env.DROP ?? '9058-CONSOLE').trim();
const CO = Number(process.env.COMPANY_ID ?? 1);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

// item_code lives on different columns in different tables; count each honestly.
const PLACES = [
  { label: 'sales-order lines',        table: 'scm.mfg_sales_order_items',   col: 'item_code' },
  { label: 'purchase-order lines',     table: 'scm.purchase_order_items',    col: 'item_code' },
  { label: 'delivery-order lines',     table: 'scm.delivery_order_items',    col: 'item_code' },
  { label: 'goods-received lines',     table: 'scm.goods_received_items',    col: 'item_code' },
  { label: 'purchase-invoice lines',   table: 'scm.purchase_invoice_items',  col: 'item_code' },
  { label: 'supplier bindings',        table: 'scm.supplier_material_bindings', col: 'item_code' },
  { label: 'product master rows',      table: 'scm.mfg_products',            col: 'code' },
];

async function countIn(table, col, code) {
  try {
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM ${sql(table)} WHERE ${sql(col)} = ${code} AND company_id = ${CO}`;
    return n;
  } catch (e) {
    return `err: ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`;
  }
}

try {
  log(`company=${CO}  KEEP="${KEEP}"  DROP="${DROP}"`);
  log('');
  log(`${'place'.padEnd(26)}${KEEP.padStart(16)}${DROP.padStart(16)}`);
  for (const p of PLACES) {
    const a = await countIn(p.table, p.col, KEEP);
    const b = await countIn(p.table, p.col, DROP);
    log(`  ${p.label.padEnd(24)}${String(a).padStart(16)}${String(b).padStart(16)}`);
  }

  // Stock — the one that re-keys history if the codes are merged. Balances by
  // the stored variant_key, and raw movement rows.
  log('');
  for (const code of [KEEP, DROP]) {
    try {
      const bal = await sql`
        SELECT COALESCE(SUM(qty), 0)::numeric AS on_hand, COUNT(*)::int AS lots
          FROM scm.inventory_balances WHERE item_code = ${code} AND company_id = ${CO}`;
      const mv = await sql`
        SELECT COUNT(*)::int AS moves FROM scm.inventory_movements WHERE item_code = ${code} AND company_id = ${CO}`;
      log(`  STOCK ${code}: on-hand ${bal[0].on_hand}, ${bal[0].lots} balance row(s), ${mv[0].moves} movement row(s)`);
    } catch (e) {
      log(`  STOCK ${code}: err ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`);
    }
  }

  // The suppliers each code is bound to, to show the divergence the owner named.
  log('');
  for (const code of [KEEP, DROP]) {
    const rows = await sql`
      SELECT b.is_main_supplier, s.code AS scode, s.name
        FROM scm.supplier_material_bindings b
        LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
       WHERE b.company_id = ${CO} AND b.material_kind = 'mfg_product' AND b.item_code = ${code}
       ORDER BY b.is_main_supplier DESC NULLS LAST`;
    log(`  SUPPLIERS ${code}: ${rows.length === 0 ? '(none)' : rows.map((r) => `${r.scode ?? '?'} ${r.name ?? ''}${r.is_main_supplier ? ' [main]' : ''}`).join(' | ')}`);
  }

  log('');
  log('READ-ONLY. Nothing moved. The merge that follows this is a separate gated');
  log('script; the numbers above are its blast radius, seen before the leap.');
} catch (err) {
  console.error(`query failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
