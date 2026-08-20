#!/usr/bin/env node
/* golive-wipe-hc.mjs — WIPE Houzs Century (HC) transaction + stock data for a
   clean production go-live, KEEPING all master / config / identity data, and
   NEVER touching the other company (2990).
   ===========================================================================

   PLAIN LANGUAGE (老板版):
   这支工具是给 Houzs Century（HC）上线用的「清空交易 + 库存，保留资料」。
   它只删 HC 的单据和库存（销售单/采购单/交货单/收货单/发票/付款/总账/库存移动
   等），把 HC 的单据号码归零回 001；产品、客户、供应商、仓库、价格设定、员工、
   权限——全部保留。**2990 完全不碰**。默认只做「预演（plan）」：只数数、不删任
   何东西。要真的删，必须 MODE=apply 且输入确认句。

   ── WHAT THIS DOES ─────────────────────────────────────────────────────────
   Resolves the HC company by CODE ('HOUZS') from public.companies, asserts it
   is NOT the 2990 company, then for every table on the curated CLEAR list
   (documents + stock) deletes ONLY the rows scoped to HC's company_id. Master
   and config tables (products, customers, suppliers, warehouses, price config,
   users, roles, ...) are on the KEEP list and are never touched. Any live table
   that is on NEITHER list is reported as UNSURE and left alone (default KEEP).

   ── DOCUMENT NUMBERS: THERE IS NO COUNTER TO RESET ─────────────────────────
   Verified in scm/lib/doc-no.ts: running numbers (HC-SO-2608-001, ...) are
   minted as max(suffix)+1 over the rows that already exist for the month — there
   is NO sequence table and NO per-company counter row anywhere (so_settings /
   app_config are key/value config, not counters). So deleting HC's document rows
   IS the reset: with zero surviving HC rows in a month, the next mint reads
   max=0 and hands out 001. The plan prints the current highest HC number per
   document family as evidence of what resets.

   ── SAFETY MODEL ───────────────────────────────────────────────────────────
   The DB client is service-role (RLS bypassed), so the company_id predicate is
   the ONLY isolation. Every CLEAR delete carries WHERE company_id = <HC>. 2990's
   rows carry company_id = <2990> (the one-way 2990 mirror always stamps it), so
   they are structurally excluded. The apply path runs in ONE transaction: any FK
   surprise or count mismatch rolls the whole thing back — never a partial wipe.
   Before deleting, apply mode DUMPS every CLEAR row for HC to a backup directory
   (uploaded as a workflow artifact) so the wipe is 100% recoverable.

   ── MODES ──────────────────────────────────────────────────────────────────
   MODE=plan (DEFAULT): count-only. Prints, per CLEAR table, the HC rows it WOULD
     delete + the grand total; the document-number evidence; a KEEP sample with
     HC row counts (proving they survive); and the UNSURE list. WRITES NOTHING.
   MODE=apply: requires CONFIRM="WIPE HOUZS-CENTURY TRANSACTIONS". Dumps backup,
     deletes children-before-parents in one transaction (the six TMS tables FIRST,
     before the DO/SO deletes, so no ON DELETE SET NULL orphans an HC stop), then
     — still INSIDE the transaction — re-counts every CLEAR table for 2990 and
     ROLLS BACK if any 2990 row count moved (a trip_stops->trips CASCADE could
     otherwise delete a 2990 stop riding on an HC trip). After commit it re-reads
     on a FRESH connection and ASSERTS: every CLEAR table has 0 HC rows; 2990 row
     counts UNCHANGED (incl. the TMS tables); KEEP-sample tables UNCHANGED.

   RE-RUN: idempotent. A second plan run just re-counts. A second apply run finds
     0 HC rows on the CLEAR tables (already wiped) and is a no-op that still
     passes the fresh-connection assertions — the deletes match nothing, the
     2990-unchanged and KEEP-unchanged checks stay green, and it exits 0.
   =========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

// ── Config / gates ──────────────────────────────────────────────────────────
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'WIPE HOUZS-CENTURY TRANSACTIONS';
const HC_CODE = 'HOUZS';        // Houzs Century — the base company
const MIRRORED_CODE = '2990';   // must NEVER be touched
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'golive-backup');

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const ident = /^[a-z_][a-z0-9_]*$/; // every identifier below is hardcoded; assert it anyway

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/* ── THE CLEAR LIST — HC transaction + stock + document tables ───────────────
   Ordered CHILDREN-BEFORE-PARENTS so a single transaction deletes without
   tripping foreign keys. Every one is scoped by company_id (verified at runtime
   against information_schema; a table missing company_id is DROPPED from the
   delete set and FLAGGED rather than deleted unscoped). Schema is 'scm' unless
   noted. A table absent from the live DB is skipped with a note. */
const CLEAR = [
  // ── TMS / delivery-planning — DELETED FIRST, before DO/SO ──────────────────
  // Ordered ahead of delivery_orders + mfg_sales_orders on purpose: trip_stops
  // has `do_id -> scm.delivery_orders(id) ON DELETE SET NULL` (mig 0053:99) and a
  // bare `so_id` with no FK, and delivery_legs has a bare polymorphic `source_id`
  // — so deleting the DO/SO first would leave HC trip_stops / legs / dp_orders as
  // orphaned rows with NULL or dangling links. Removing HC's TMS rows first means
  // no ON DELETE SET NULL ever fires on an HC stop and no HC orphan is created.
  // Children-before-parent within TMS: trip_stops / trip_locations / delivery_legs
  // all reference scm.trips (CASCADE / SET NULL) so they go before scm.trips.
  // (The unavoidable residual — a 2990-owned stop that points at an HC DO getting
  // its do_id SET NULL when the HC DO is later deleted — is measured by the census
  // below; it touches no 2990 ROW count, only a column, and the in-transaction
  // 2990 guard rolls the whole wipe back if any 2990 row count moves.)
  ['scm', 'trip_stops', 'tms'],           // child of trips; do_id -> DO SET NULL
  ['scm', 'trip_locations', 'tms'],       // child of trips (CASCADE)
  ['scm', 'delivery_legs', 'tms'],        // trip_id -> trips SET NULL; source_id bare
  ['scm', 'dp_orders', 'tms'],            // no FK into DO/SO/trips (company_id nullable)
  ['scm', 'delivery_day_locks', 'tms'],   // no FK; pure capacity lock
  ['scm', 'trips', 'tms'],                // TMS parent — last of the TMS block
  // ── Sales Order family ──
  ['scm', 'mfg_so_status_changes', 'sales-order'],
  ['scm', 'mfg_so_price_overrides', 'sales-order'],
  ['scm', 'mfg_so_audit_log', 'sales-order'],
  ['scm', 'mfg_so_item_deletions', 'sales-order'],
  ['scm', 'mfg_sales_order_payments', 'sales-order'],
  ['scm', 'mfg_sales_order_items', 'sales-order'],
  ['scm', 'so_amendment_lines', 'sales-order'],
  ['scm', 'so_amendments', 'sales-order'],
  ['scm', 'so_revisions', 'sales-order'],
  ['scm', 'scan_jobs', 'sales-order'],
  ['scm', 'mfg_sales_orders', 'sales-order'],       // header
  ['scm', 'quotes', 'quotation'],
  // ── Delivery Order family ──
  ['scm', 'delivery_order_crew', 'delivery-order'],
  ['scm', 'delivery_legs', 'delivery-order'],
  ['scm', 'delivery_return_items', 'delivery-order'],
  ['scm', 'delivery_returns', 'delivery-order'],
  ['scm', 'delivery_order_items', 'delivery-order'],
  ['scm', 'delivery_orders', 'delivery-order'],     // header
  // ── Purchase Order family ──
  ['scm', 'po_amendment_lines', 'purchase-order'],
  ['scm', 'po_amendments', 'purchase-order'],
  ['scm', 'po_revisions', 'purchase-order'],
  ['scm', 'purchase_order_item_allocations', 'purchase-order'],
  ['scm', 'purchase_order_items', 'purchase-order'],
  ['scm', 'purchase_order_lines', 'purchase-order'],
  ['scm', 'purchase_orders', 'purchase-order'],     // header
  // ── GRN family ──
  ['scm', 'grn_items', 'grn'],
  ['scm', 'grns', 'grn'],                            // header
  // ── Purchase Invoice family ──
  ['scm', 'purchase_invoice_items', 'purchase-invoice'],
  ['scm', 'purchase_invoices', 'purchase-invoice'], // header
  // ── Sales Invoice family ──
  ['scm', 'sales_invoice_items', 'sales-invoice'],
  ['scm', 'sales_invoice_payments', 'sales-invoice'],
  ['scm', 'sales_invoices', 'sales-invoice'],        // header
  // ── Purchase Returns ──
  ['scm', 'purchase_return_items', 'purchase-return'],
  ['scm', 'purchase_returns', 'purchase-return'],
  // ── Payment Vouchers ──
  ['scm', 'pv_allocations', 'payment-voucher'],
  ['scm', 'payment_voucher_lines', 'payment-voucher'],
  ['scm', 'payment_vouchers', 'payment-voucher'],
  // ── Consignment (sales side) ──
  ['scm', 'consignment_sales_order_payments', 'consignment'],
  ['scm', 'consignment_sales_order_items', 'consignment'],
  ['scm', 'consignment_sales_orders', 'consignment'],
  ['scm', 'consignment_delivery_order_payments', 'consignment'],
  ['scm', 'consignment_delivery_order_items', 'consignment'],
  ['scm', 'consignment_delivery_orders', 'consignment'],
  ['scm', 'consignment_delivery_return_items', 'consignment'],
  ['scm', 'consignment_delivery_returns', 'consignment'],
  // ── Purchase Consignment ──
  ['scm', 'purchase_consignment_return_items', 'purchase-consignment'],
  ['scm', 'purchase_consignment_returns', 'purchase-consignment'],
  ['scm', 'purchase_consignment_receive_items', 'purchase-consignment'],
  ['scm', 'purchase_consignment_receives', 'purchase-consignment'],
  ['scm', 'purchase_consignment_order_items', 'purchase-consignment'],
  ['scm', 'purchase_consignment_orders', 'purchase-consignment'],
  // ── Stock ──
  ['scm', 'inventory_lot_consumptions', 'stock'],
  ['scm', 'inventory_lots', 'stock'],
  ['scm', 'inventory_movements', 'stock'],
  ['scm', 'stock_take_lines', 'stock'],
  ['scm', 'stock_takes', 'stock'],
  ['scm', 'stock_transfer_lines', 'stock'],
  ['scm', 'stock_transfers', 'stock'],
  ['scm', 'warehouse_rack_movements', 'stock'],
  ['scm', 'warehouse_rack_items', 'stock'],
  // ── General Ledger ──
  ['scm', 'journal_entry_lines', 'gl'],
  ['scm', 'journal_entries', 'gl'],
  // ── Integration outbox (ERP -> AutoCount) ──
  ['scm', 'autocount_outbox', 'integration'],
  // ── POS transient drafts ──
  ['scm', 'pos_carts', 'pos'],
];

/* ── Document-number evidence: header table + its doc-number column. The plan
   reports the current highest HC number in each family; after the wipe the next
   mint is 001 (see doc-no.ts note above). The doc-no column is auto-detected
   from these candidates so a rename cannot silently mis-report. */
const DOC_HEADERS = [
  ['scm', 'mfg_sales_orders', 'SO', ['doc_no']],
  ['scm', 'delivery_orders', 'DO', ['do_number', 'doc_no']],
  ['scm', 'purchase_orders', 'PO', ['po_number', 'doc_no']],
  ['scm', 'grns', 'GRN', ['grn_number', 'doc_no']],
  ['scm', 'purchase_invoices', 'PI', ['invoice_number', 'doc_no']],
  ['scm', 'sales_invoices', 'SI', ['invoice_number', 'doc_no']],
  ['scm', 'payment_vouchers', 'PV', ['voucher_no', 'pv_no', 'doc_no']],
  ['scm', 'journal_entries', 'JE', ['je_no', 'doc_no']],
  ['scm', 'quotes', 'QT', ['quote_no', 'quotation_no', 'doc_no']],
  ['scm', 'stock_takes', 'STK', ['take_no', 'doc_no']],
  ['scm', 'stock_transfers', 'TRF', ['transfer_no', 'doc_no']],
  ['scm', 'delivery_returns', 'DRN', ['return_number', 'doc_no']],
  ['scm', 'purchase_returns', 'PRN', ['return_number', 'doc_no']],
];

/* ── KEEP LIST — master / config / identity. Never touched. A sample is
   re-counted for HC in plan (and asserted UNCHANGED in apply) to prove
   preservation. This is the confident master set; anything live that is on
   neither CLEAR nor KEEP is reported as UNSURE and also left alone. */
const KEEP = new Set([
  // Catalog / product masters
  'scm.products', 'scm.mfg_products', 'scm.product_models', 'scm.product_size_variants',
  'scm.product_compartments', 'scm.product_fabrics', 'scm.product_bundles',
  'scm.product_bedframe_colours', 'scm.product_dept_configs', 'scm.product_model_photos',
  'scm.categories', 'scm.bundle_library', 'scm.compartment_library', 'scm.size_library',
  'scm.fabric_library', 'scm.fabrics', 'scm.fabric_colours', 'scm.bedframe_colours',
  'scm.bedframe_options', 'scm.addons', 'scm.special_addons', 'scm.sofa_combo_pricing',
  'scm.sofa_quick_picks', 'scm.sofa_personal_quick_picks', 'scm.personal_quick_picks',
  'scm.model_default_free_gifts', 'scm.model_fabric_tier_overrides',
  'scm.model_special_delivery_fees', 'scm.compartment_fabric_tier_overrides',
  'scm.fabric_tier_addon_config', 'scm.free_item_campaigns', 'scm.pwp_rules',
  'scm.supplier_material_bindings', 'scm.master_price_history', 'scm.mfg_product_price_history',
  'scm.maintenance_config_history', 'scm.fabric_trackings', 'scm.series',
  // Parties
  'scm.customers', 'scm.suppliers', 'public.creditors', 'scm.drivers', 'scm.helpers',
  'scm.staff', 'scm.hr_salesperson_profiles', 'scm.hr_commission_config', 'scm.hr_item_kpi',
  'scm.hr_override_levels',
  // Locations / warehouse masters
  'scm.warehouses', 'scm.warehouse_racks', 'scm.showrooms', 'scm.venues',
  'scm.state_warehouse_mappings', 'scm.my_localities', 'scm.state_delivery_regions',
  'scm.delivery_planning_regions', 'scm.delivery_zone_postcodes', 'scm.delivery_residence_rules',
  'scm.delivery_rate_cards', 'scm.delivery_rate_rules', 'scm.delivery_fee_config',
  'scm.special_delivery_fee_rules',
  // Config
  'scm.app_config', 'scm.so_settings', 'scm.so_dropdown_options', 'scm.currencies',
  'scm.accounts', 'scm.acc_account_roles', 'scm.acc_acquirers', 'scm.mrp_category_lead_times',
  'scm.so_scan_rules', 'scm.so_scan_samples', 'scm.sync_config', 'scm.geocode_cache',
  'scm.analysis_customer_targets', 'scm.pos_pins',
  // Fleet masters
  'scm.lorries', 'scm.lorry_components', 'scm.lorry_maintenance_plans', 'scm.threepl_companies',
  'scm.workshops', 'public.lorries',
  // Identity (public)
  'public.users', 'public.roles', 'public.role_page_access', 'public.positions',
  'public.position_page_access', 'public.departments', 'public.user_departments',
  'public.user_brands', 'public.sales_reps', 'public.sales_positions',
  'public.sales_commission_tiers', 'public.sales_rep_brands', 'public.sales_rep_commission_tiers',
  'public.project_brands', 'public.project_cost_rates', 'public.companies',
  'public.user_companies', 'public.push_devices', 'public.sessions', 'public.invitations',
  'public.password_resets', 'public.warehouses',
]);

// A KEEP sample re-counted to prove preservation (scoped by company_id when present).
const KEEP_SAMPLE = [
  ['scm', 'products'], ['scm', 'customers'], ['scm', 'suppliers'],
  ['scm', 'warehouses'], ['public', 'users'], ['public', 'companies'],
];

const qi = (s) => { if (!ident.test(s)) throw new Error(`unsafe identifier: ${s}`); return s; };

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (read-only, nothing is written)'}`);
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

  // ── 1. Resolve HC + 2990, assert distinct ────────────────────────────────
  const companies = await sql`SELECT id::text AS id, code, name FROM public.companies ORDER BY id`;
  note(`\n=== COMPANIES (public.companies) ===`);
  for (const r of companies) note(`  id=${r.id}  code=${r.code}  name=${r.name}`);

  const hc = companies.filter((r) => String(r.code).trim().toUpperCase() === HC_CODE);
  const other = companies.filter((r) => String(r.code).trim().toUpperCase() === MIRRORED_CODE);
  if (hc.length !== 1) { bad(`expected exactly ONE company with code '${HC_CODE}', found ${hc.length} — refusing`); await sql.end({ timeout: 5 }); process.exit(2); }
  const HC_ID = Number(hc[0].id);
  const OTHER_ID = other.length === 1 ? Number(other[0].id) : null;
  if (!Number.isInteger(HC_ID) || HC_ID <= 0) { bad(`HC id is not a positive integer (${hc[0].id}) — refusing`); await sql.end({ timeout: 5 }); process.exit(2); }
  if (OTHER_ID !== null && HC_ID === OTHER_ID) { bad(`HC id equals 2990 id (${HC_ID}) — refusing, this must never happen`); await sql.end({ timeout: 5 }); process.exit(2); }

  note(`\n=== TARGET ===`);
  note(`  HC (to wipe): id=${HC_ID} code=${hc[0].code} name=${hc[0].name}`);
  note(`  2990 (NEVER touch): ${OTHER_ID !== null ? `id=${OTHER_ID} code=${other[0].code} name=${other[0].name}` : 'not present in this DB'}`);
  note(`  asserted: HC id (${HC_ID}) is NOT the 2990 id (${OTHER_ID ?? 'n/a'})`);

  // ── 2. Live schema: tables + columns in scm/public ───────────────────────
  const cols = await sql`
    SELECT table_schema AS s, table_name AS t, column_name AS c
      FROM information_schema.columns
     WHERE table_schema IN ('scm','public')`;
  const colsByTable = new Map(); // "s.t" -> Set(columns)
  for (const r of cols) {
    const k = `${r.s}.${r.t}`;
    if (!colsByTable.has(k)) colsByTable.set(k, new Set());
    colsByTable.get(k).add(r.c);
  }
  const liveTables = await sql`
    SELECT table_schema AS s, table_name AS t
      FROM information_schema.tables
     WHERE table_schema IN ('scm','public') AND table_type = 'BASE TABLE'`;
  const liveSet = new Set(liveTables.map((r) => `${r.s}.${r.t}`));

  // ── 3. Resolve CLEAR plan (scope each by company_id; flag if unscopable) ──
  note(`\n=== CLEAR PLAN — HC rows that WOULD be deleted (scoped WHERE company_id = ${HC_ID}) ===`);
  const resolved = [];    // { schema, table, family, count }
  const missing = [];     // CLEAR tables absent from the live DB
  const unscopable = [];  // CLEAR tables present but with no company_id column
  let total = 0;
  const byFamily = new Map();
  for (const [schema, table, family] of CLEAR) {
    const key = `${schema}.${table}`;
    if (!liveSet.has(key)) { missing.push(key); continue; }
    const has = colsByTable.get(key);
    if (!has || !has.has('company_id')) { unscopable.push(key); continue; }
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(qi(schema))}.${sql(qi(table))} WHERE company_id = ${HC_ID}`;
    resolved.push({ schema, table, family, count: n });
    total += n;
    byFamily.set(family, (byFamily.get(family) || 0) + n);
  }
  for (const r of resolved) {
    note(`  ${String(r.count).padStart(8)}  ${r.schema}.${r.table}  [${r.family}]`);
  }
  note(`  ${'-'.repeat(60)}`);
  note(`  ${String(total).padStart(8)}  TOTAL HC rows across ${resolved.length} CLEAR tables`);
  note(`\n  --- by family ---`);
  for (const [f, n] of [...byFamily.entries()].sort((a, b) => b[1] - a[1])) note(`  ${String(n).padStart(8)}  ${f}`);

  if (missing.length) {
    note(`\n  CLEAR tables NOT present in this DB (skipped): ${missing.length}`);
    for (const k of missing) note(`     - ${k}`);
  }
  if (unscopable.length) {
    note(`\n  ⚠ CLEAR tables present but WITHOUT company_id — NOT deleted, FLAGGED for review: ${unscopable.length}`);
    for (const k of unscopable) note(`     - ${k}`);
  }

  // ── 4. Document-number evidence (what resets to 001) ─────────────────────
  note(`\n=== DOCUMENT NUMBERS — highest HC number today (resets to 001 after wipe; there is NO counter table) ===`);
  for (const [schema, table, label, cands] of DOC_HEADERS) {
    const key = `${schema}.${table}`;
    if (!liveSet.has(key)) { note(`  ${label.padEnd(4)} ${key.padEnd(30)} (table absent)`); continue; }
    const has = colsByTable.get(key) || new Set();
    const col = cands.find((c) => has.has(c));
    if (!col) { note(`  ${label.padEnd(4)} ${key.padEnd(30)} (no known doc-no column)`); continue; }
    if (!has.has('company_id')) { note(`  ${label.padEnd(4)} ${key.padEnd(30)} (no company_id — skipped)`); continue; }
    const rows = await sql`
      SELECT count(*)::int AS n, max(${sql(qi(col))}) AS max_no
        FROM ${sql(qi(schema))}.${sql(qi(table))} WHERE company_id = ${HC_ID}`;
    const { n, max_no } = rows[0];
    note(`  ${label.padEnd(4)} ${key.padEnd(30)} HC rows=${String(n).padStart(7)}  highest=${max_no ?? '(none)'}  -> next mint 001`);
  }

  // ── 5. KEEP sample — proof of preservation ───────────────────────────────
  note(`\n=== KEEP SAMPLE — master rows PRESERVED (not touched) ===`);
  const keepBefore = new Map();
  for (const [schema, table] of KEEP_SAMPLE) {
    const key = `${schema}.${table}`;
    if (!liveSet.has(key)) { note(`  ${key} (absent)`); continue; }
    const scoped = (colsByTable.get(key) || new Set()).has('company_id');
    const [{ n }] = scoped
      ? await sql`SELECT count(*)::int AS n FROM ${sql(qi(schema))}.${sql(qi(table))} WHERE company_id = ${HC_ID}`
      : await sql`SELECT count(*)::int AS n FROM ${sql(qi(schema))}.${sql(qi(table))}`;
    keepBefore.set(key, n);
    note(`  ${String(n).padStart(8)}  ${key}${scoped ? ` (HC)` : ` (all)`}`);
  }

  // ── 6. 2990 UNCHANGED baseline (counts captured, asserted after apply) ────
  const otherBefore = new Map();
  if (OTHER_ID !== null) {
    note(`\n=== 2990 BASELINE — these counts must be UNCHANGED after any apply ===`);
    for (const r of resolved) {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(qi(r.schema))}.${sql(qi(r.table))} WHERE company_id = ${OTHER_ID}`;
      otherBefore.set(`${r.schema}.${r.table}`, n);
    }
    const tot2990 = [...otherBefore.values()].reduce((a, b) => a + b, 0);
    note(`  2990 rows across the SAME ${resolved.length} CLEAR tables: ${tot2990} (must stay ${tot2990})`);
  }

  // ── 6b. MIXED-TRIP CENSUS (read-only) — the pivotal cross-company safety fact ─
  // TMS is a cross-company SHARED queue by design (scm/lib/companyScope.ts:16-23):
  // a trip is created under whichever company you are in, and its stops can point
  // at the OTHER company's deliveries. Two hazards follow, both measured here:
  //   • trip_stops.trip_id -> scm.trips(id) ON DELETE CASCADE (mig 0053:96): if a
  //     2990-owned stop sits on an HC-owned trip, deleting that HC trip would
  //     CASCADE-DELETE a 2990 row. If this count is > 0, HC-only TMS clearing is
  //     NOT safe as-is (the in-transaction 2990 guard would roll the wipe back).
  //   • trip_stops.do_id -> scm.delivery_orders(id) ON DELETE SET NULL (0053:99):
  //     a 2990-owned stop pointing at an HC delivery gets its do_id NULLed when we
  //     delete the HC DO — the unavoidable core-wipe side-effect (a column change,
  //     not a row delete).
  if (OTHER_ID !== null && liveSet.has('scm.trip_stops') && liveSet.has('scm.trips')) {
    note(`\n=== MIXED-TRIP CENSUS (read-only) — HC=${HC_ID}, 2990=${OTHER_ID} ===`);

    const cross = await sql`
      SELECT ts.company_id::text AS stop_co, t.company_id::text AS trip_co, count(*)::int AS n
        FROM scm.trip_stops ts JOIN scm.trips t ON t.id = ts.trip_id
       WHERE ts.company_id <> t.company_id
       GROUP BY ts.company_id, t.company_id ORDER BY 1, 2`;
    const crossN = (sc, tc) => Number(cross.find((r) => Number(r.stop_co) === sc && Number(r.trip_co) === tc)?.n ?? 0);
    note(`  (a) HC stops sitting on a 2990 trip   (ts.company_id=${HC_ID} on trip.company_id=${OTHER_ID}): ${crossN(HC_ID, OTHER_ID)}`);
    note(`  (a) 2990 stops sitting on an HC trip  (ts.company_id=${OTHER_ID} on trip.company_id=${HC_ID}): ${crossN(OTHER_ID, HC_ID)}   <- these would CASCADE-DELETE if we delete HC trips`);

    const [{ n: mixedTrips }] = await sql`
      SELECT count(*)::int AS n FROM (
        SELECT ts.trip_id FROM scm.trip_stops ts
         GROUP BY ts.trip_id HAVING count(DISTINCT ts.company_id) > 1
      ) x`;
    note(`  (b) DISTINCT trips carrying stops from BOTH companies (genuinely shared): ${mixedTrips}`);

    const sideEffect = await sql`
      SELECT count(DISTINCT do_.id)::int AS hc_dos, count(*)::int AS stops
        FROM scm.delivery_orders do_
        JOIN scm.trip_stops ts ON ts.do_id = do_.id
       WHERE do_.company_id = ${HC_ID} AND ts.company_id = ${OTHER_ID}`;
    note(`  (c) HC delivery_orders referenced by a 2990-owned stop's do_id: ${sideEffect[0].hc_dos} HC DOs via ${sideEffect[0].stops} 2990 stops`);
    note(`      -> those ${sideEffect[0].stops} 2990 stop(s) get do_id SET NULL when HC DOs are deleted (unavoidable; row count unchanged).`);
  }

  // ── 7. UNSURE — every live scm/public table on NEITHER list (left alone) ──
  const clearKeys = new Set(CLEAR.map(([s, t]) => `${s}.${t}`));
  const unsure = [...liveSet].filter((k) => !clearKeys.has(k) && !KEEP.has(k)).sort();
  note(`\n=== UNSURE — live tables on NEITHER CLEAR nor KEEP: default KEEP, FLAGGED for owner (${unsure.length}) ===`);
  for (const k of unsure) note(`  ? ${k}`);

  // ── 8. PLAN EXIT ─────────────────────────────────────────────────────────
  if (!APPLY) {
    note(`\n=== PLAN COMPLETE — nothing was written. ===`);
    note(`  Would delete ${total} HC rows across ${resolved.length} CLEAR tables; reset ${DOC_HEADERS.length} doc-number families to 001.`);
    note(`  To execute: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── 9. APPLY: backup, then delete children->parents in ONE transaction ────
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  note(`\n=== BACKUP — dumping HC CLEAR rows to ${BACKUP_DIR} before deleting ===`);
  const manifest = { company: { id: HC_ID, code: hc[0].code, name: hc[0].name }, when: new Date().toISOString(), tables: {} };
  for (const r of resolved) {
    const rows = await sql`SELECT * FROM ${sql(qi(r.schema))}.${sql(qi(r.table))} WHERE company_id = ${HC_ID}`;
    const file = path.join(BACKUP_DIR, `${r.schema}.${r.table}.json`);
    fs.writeFileSync(file, JSON.stringify(rows, null, 0));
    manifest.tables[`${r.schema}.${r.table}`] = rows.length;
    note(`  dumped ${String(rows.length).padStart(8)}  ${r.schema}.${r.table}`);
  }
  fs.writeFileSync(path.join(BACKUP_DIR, '_manifest.json'), JSON.stringify(manifest, null, 2));
  note(`  backup manifest written; ${resolved.length} table dumps saved.`);

  const ROLLBACK = Symbol('safety');
  let deletedTotal = 0;
  const deletedByTable = new Map();
  await sql.begin(async (tx) => {
    for (const r of resolved) {
      // company_id predicate is the ONLY isolation (service-role bypasses RLS).
      const del = await tx`DELETE FROM ${tx(qi(r.schema))}.${tx(qi(r.table))} WHERE company_id = ${HC_ID}`;
      deletedByTable.set(`${r.schema}.${r.table}`, del.count);
      deletedTotal += del.count;
    }
    note(`\n=== DELETED ${deletedTotal} HC rows across ${resolved.length} CLEAR tables (in transaction) ===`);
    if (deletedTotal !== total) {
      // The plan counted `total`; a mismatch means the world moved under us.
      // Roll the whole wipe back rather than commit a partial one.
      throw new Error(`expected to delete ${total}, deleted ${deletedTotal} — rolling back the entire wipe`);
    }

    // ── IN-TRANSACTION 2990 GUARD — the cascade safety net ─────────────────
    // trip_stops.trip_id -> trips ON DELETE CASCADE means deleting an HC trip can
    // cascade-delete a 2990-owned stop that rides on it. That is a 2990 ROW
    // deletion, and it must NEVER commit. Re-count every CLEAR table for 2990
    // INSIDE this transaction; if any moved from the captured baseline, THROW so
    // the whole wipe rolls back BEFORE commit (the fresh-connection check below
    // is post-commit and cannot undo). Row-count based: a do_id SET NULL on a
    // surviving 2990 stop changes a column, not the count, and is allowed.
    if (OTHER_ID !== null) {
      for (const r of resolved) {
        const key = `${r.schema}.${r.table}`;
        const [{ n }] = await tx`SELECT count(*)::int AS n FROM ${tx(qi(r.schema))}.${tx(qi(r.table))} WHERE company_id = ${OTHER_ID}`;
        const was = otherBefore.get(key) ?? 0;
        if (n !== was) {
          throw new Error(`2990 row count MOVED on ${key} (was ${was}, now ${n}) — a cross-company cascade would delete 2990 data; rolling back the entire wipe`);
        }
      }
      note(`  in-transaction guard: all ${resolved.length} 2990 CLEAR-table counts unchanged — safe to commit.`);
    }
  }).catch((e) => { if (e !== ROLLBACK) throw e; });

  // ── 10. VERIFY on a FRESH connection: HC=0, 2990 unchanged, KEEP unchanged ─
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const problems = [];

    // (a) every CLEAR table now has 0 HC rows — assert the SHAPE of the result.
    const hcAfter = [];
    for (const r of resolved) {
      const [{ n }] = await check`SELECT count(*)::int AS n FROM ${check(qi(r.schema))}.${check(qi(r.table))} WHERE company_id = ${HC_ID}`;
      hcAfter.push({ table: `${r.schema}.${r.table}`, n });
      if (n !== 0) problems.push(`${r.schema}.${r.table} still has ${n} HC rows`);
    }
    if (!Array.isArray(hcAfter) || hcAfter.length !== resolved.length) problems.push(`HC re-read shape wrong: expected ${resolved.length} rows, got ${typeof hcAfter}`);
    note(`  HC CLEAR rows remaining: ${hcAfter.reduce((a, b) => a + b.n, 0)} (want 0)`);

    // (b) 2990 counts UNCHANGED (before vs after).
    if (OTHER_ID !== null) {
      let drift = 0;
      for (const r of resolved) {
        const key = `${r.schema}.${r.table}`;
        const [{ n }] = await check`SELECT count(*)::int AS n FROM ${check(qi(r.schema))}.${check(qi(r.table))} WHERE company_id = ${OTHER_ID}`;
        const was = otherBefore.get(key) ?? 0;
        if (n !== was) { problems.push(`2990 CHANGED on ${key}: was ${was}, now ${n}`); drift++; }
      }
      note(`  2990 tables changed by the wipe: ${drift} (want 0)`);
    }

    // (c) KEEP sample UNCHANGED.
    let keepDrift = 0;
    for (const [schema, table] of KEEP_SAMPLE) {
      const key = `${schema}.${table}`;
      if (!keepBefore.has(key)) continue;
      const scoped = (colsByTable.get(key) || new Set()).has('company_id');
      const [{ n }] = scoped
        ? await check`SELECT count(*)::int AS n FROM ${check(qi(schema))}.${check(qi(table))} WHERE company_id = ${HC_ID}`
        : await check`SELECT count(*)::int AS n FROM ${check(qi(schema))}.${check(qi(table))}`;
      const was = keepBefore.get(key);
      if (n !== was) { problems.push(`KEEP table ${key} CHANGED: was ${was}, now ${n}`); keepDrift++; }
    }
    note(`  KEEP-sample tables changed: ${keepDrift} (want 0)`);

    if (problems.length) {
      bad(`VERIFICATION FAILED:\n${problems.map((p) => `    - ${p}`).join('\n')}`);
      process.exit(1);
    }
    note(`\n  ALL ASSERTIONS PASSED: HC CLEAR tables empty, 2990 unchanged, KEEP sample unchanged.`);
    note(`  Backup is in ${BACKUP_DIR} (also uploaded as a workflow artifact).`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  process.exit(1);
});
