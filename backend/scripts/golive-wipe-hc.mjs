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

   ── DOCUMENT NUMBERS: THERE IS A COUNTER NOW, AND YOU MUST CHOOSE ─────
   THIS PARAGRAPH USED TO SAY THE OPPOSITE, and the old text is quoted here
   because it is the reason this script appears in a COE:

     "running numbers (HC-SO-2608-001, ...) are minted as max(suffix)+1 over the
      rows that already exist for the month -- there is NO sequence table and NO
      per-company counter row anywhere. So deleting HC's document rows IS the
      reset: with zero surviving HC rows in a month, the next mint reads max=0
      and hands out 001."

   That was true, and it is what broke. The AED_HOUZS account book is NOT wiped
   and permanently holds every number the ERP ever exported to it, so a reset to
   001 re-issued HC-SO-2608-001/002, HC-PO-2608-001 and HC-PI-2608-001, which
   AutoCount refused with `Primary Key Error`. docs/doc-number-reissue-coe.md.

   Since migration 0316 the counter is scm.doc_number_counters and it only ever
   goes UP. Deleting rows no longer resets anything. So the reset is now an
   EXPLICIT INPUT and apply REFUSES without it, instead of happening as an
   invisible side effect of a DELETE:

     DOC_COUNTERS=keep   numbering CONTINUES upward. The safe answer, and the
                         only one that cannot collide with the account book.
     DOC_COUNTERS=reset  numbering restarts at 001. Needs a SECOND confirmation
                         phrase, and prints every counter row it will delete
                         together with the evidence that set it -- which for the
                         HC 2608 series literally reads "AED_HOUZS holds
                         HC-SO-2608-001 and -002 since 2026-08-14". Choosing
                         reset with that sentence on screen is a decision; the
                         old behaviour was not one.

   A script whose documented behaviour has quietly stopped being true is the
   exact defect this change exists to remove, so it fails loudly instead.

   ── THE EXPORT LOG IS NOT WIPED ANY MORE ──────────────────────
   scm.autocount_outbox was on the CLEAR list. It is the ERP's ONLY record of
   what it has sent to AutoCount, so wiping it left the account book as the only
   party that remembered -- which is why the queue could truthfully report
   "never sent" for numbers the book demonstrably held, and why the diagnosis
   cost a day. It is on KEEP now. Its HC rows SURVIVE, and any HC row still
   `pending` is marked `skipped` INSIDE the wipe transaction with a reason, so
   the queue stops trying to send documents that no longer exist. The memory is
   kept; only the intent to send is cancelled.


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
     then deletes in ONE transaction using an FK-CORRECT order computed at run time
     — every FK among the CLEAR tables is read from pg_constraint and the tables
     are TOPOLOGICALLY SORTED so each is deleted before anything it references
     (children first). This is provably safe regardless of family grouping and
     also deletes HC trip_stops before HC delivery_orders, so no ON DELETE SET NULL
     orphans an HC stop. Still INSIDE the transaction it re-counts every CLEAR
     table for 2990 and ROLLS BACK if any 2990 row count moved (a trip_stops->trips
     CASCADE could otherwise delete a 2990 stop riding on an HC trip). After commit
     it re-reads on a FRESH connection and ASSERTS: every CLEAR table has 0 HC
     rows; 2990 row counts UNCHANGED (incl. the TMS tables); KEEP-sample UNCHANGED.
     A true FK cycle among CLEAR tables makes apply REFUSE before any delete.

   RE-RUN: idempotent. A second plan run just re-counts. A second apply run finds
     0 HC rows on the CLEAR tables (already wiped) and is a no-op that still
     passes the fresh-connection assertions — the deletes match nothing, the
     2990-unchanged and KEEP-unchanged checks stay green, and it exits 0.
     A second apply with DOC_COUNTERS=keep leaves the counters exactly where the
     first left them; with DOC_COUNTERS=reset it deletes the HC counter rows the
     mints since the first run re-created, which is the same request answered
     again and not a compounding one. The export-log cancel is idempotent too:
     there is nothing left `pending` to cancel.
     A first apply no longer needs a second run to pass. It used to: our own
     AFTER DELETE audit trigger wrote rows back into a CLEAR table faster than
     the single pass removed them (run 32455489040, `scm.mfg_so_item_deletions
     still has 4 HC rows`). The sweep below fixes that.
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

/* THE DOCUMENT-NUMBER DECISION. Since migration 0316 deleting rows does NOT
   reset numbering, so apply must be told what to do about the counter. There is
   deliberately NO default: defaulting to keep would silently stop doing what
   this script's header promised for months, and defaulting to reset would
   silently re-arm the 2026-08-20 collision. Both are the same defect — a
   behaviour nobody chose. */
const DOC_COUNTERS_TABLE = 'scm.doc_number_counters';
const DOC_COUNTERS = (process.env.DOC_COUNTERS || '').toLowerCase();
const DOC_COUNTERS_RESET_PHRASE = 'RESET DOCUMENT NUMBERS TO 001';
if (APPLY && !['keep', 'reset'].includes(DOC_COUNTERS)) {
  bad(`MODE=apply requires DOC_COUNTERS=keep or DOC_COUNTERS=reset.`);
  bad(`  keep  — document numbers CONTINUE upward. Deleting rows no longer resets them (migration 0316).`);
  bad(`  reset — document numbers restart at 001. Also needs CONFIRM_DOC_COUNTERS="${DOC_COUNTERS_RESET_PHRASE}".`);
  bad(`  Reset is what re-issued HC-SO-2608-001/002 into a book that already held them on 2026-08-20.`);
  bad(`  Run MODE=plan first: it prints every counter row and the evidence that set it.`);
  process.exit(2);
}
if (APPLY && DOC_COUNTERS === 'reset' && process.env.CONFIRM_DOC_COUNTERS !== DOC_COUNTERS_RESET_PHRASE) {
  bad(`DOC_COUNTERS=reset requires CONFIRM_DOC_COUNTERS="${DOC_COUNTERS_RESET_PHRASE}"`);
  process.exit(2);
}

/* ── THE CLEAR LIST — HC transaction + stock + document tables ───────────────
   Ordered CHILDREN-BEFORE-PARENTS so a single transaction deletes without
   tripping foreign keys. Every one is scoped by company_id (verified at runtime
   against information_schema; a table missing company_id is DROPPED from the
   delete set and FLAGGED rather than deleted unscoped). Schema is 'scm' unless
   noted. A table absent from the live DB is skipped with a note. */
const CLEAR = [
  // ── TMS / delivery-planning ────────────────────────────────────────────────
  // The DELETE ORDER is NOT the order of this list — it is computed at run time by
  // a topological sort of the live FK graph (section 3b). Because trip_stops has
  // `do_id -> scm.delivery_orders(id)` (mig 0053:99) and trip_stops/trip_locations/
  // delivery_legs reference scm.trips, the topo sort already deletes HC trip_stops
  // before HC delivery_orders and before scm.trips — so no ON DELETE SET NULL
  // orphans an HC stop and no HC orphan is created, without relying on hand order.
  // (The unavoidable residual — a 2990-owned stop pointing at an HC DO getting its
  // do_id SET NULL when the HC DO is deleted — is measured by the census below; it
  // touches no 2990 ROW count, only a column, and the in-transaction 2990 guard
  // rolls the whole wipe back if any 2990 row count moves.)
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
  // ── Delivery Order family ── (delivery_legs is cleared in the TMS block above,
  // before delivery_orders, so it is deliberately NOT repeated here)
  ['scm', 'delivery_order_crew', 'delivery-order'],
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
  /* scm.autocount_outbox is NOT here — see the header. It is the ERP's only
     record of what it has EXPORTED to a book that is never wiped, so deleting
     it destroys the evidence needed to detect this script's own side effects.
     It is on KEEP, and its HC pending rows are CANCELLED (not deleted) inside
     the wipe transaction. */
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
  /* The ERP's memory of what it sent to AutoCount. KEPT ON PURPOSE — see the
     header. Its HC `pending` rows are cancelled in the wipe transaction so the
     drain stops chasing deleted documents, which is a status change, not a
     forgetting. */
  'scm.autocount_outbox',
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

/* FK-correct delete order via topological sort. `nodes` are the tables to delete;
   `edges` are [child, parent] meaning child has a FK REFERENCING parent, so child
   must be deleted BEFORE parent. Produces a children-first order (a table with no
   remaining referencing child comes out last). Self-edges are dropped by the
   caller (a single company-scoped DELETE satisfies a NO ACTION self-FK at
   statement end). Kahn's algorithm; `remaining` is non-empty ONLY if a true
   multi-table cycle exists among `nodes` — the caller reports it and refuses. */
function topoDeleteOrder(nodes, edges) {
  const nodeSet = new Set(nodes);
  const out = new Map(nodes.map((n) => [n, []]));   // child -> [parents]
  const indeg = new Map(nodes.map((n) => [n, 0]));  // parent's indeg = # children referencing it
  const seen = new Set();
  for (const [child, parent] of edges) {
    if (child === parent || !nodeSet.has(child) || !nodeSet.has(parent)) continue;
    const ek = `${child}|${parent}`;
    if (seen.has(ek)) continue;
    seen.add(ek);
    out.get(child).push(parent);
    indeg.set(parent, indeg.get(parent) + 1);
  }
  const order = [];
  const queue = nodes.filter((n) => indeg.get(n) === 0); // pure children first, stable in nodes order
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const parent of out.get(n)) {
      indeg.set(parent, indeg.get(parent) - 1);
      if (indeg.get(parent) === 0) queue.push(parent);
    }
  }
  const placed = new Set(order);
  return { order, remaining: nodes.filter((n) => !placed.has(n)) };
}

// A duplicate CLEAR entry would double-count in the plan total and then make the
// apply's `deletedTotal !== total` guard roll the whole wipe back — fail loud now.
{
  const seen = new Set();
  for (const [s, t] of CLEAR) {
    const k = `${s}.${t}`;
    if (seen.has(k)) { console.error(`ERROR duplicate CLEAR entry: ${k}`); process.exit(2); }
    seen.add(k);
  }
}

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

  // ── 3b. FK-CORRECT DELETE ORDER — topologically sorted from the LIVE graph ──
  // The earlier family-grouped order was fragile and broke once: it deleted
  // purchase_orders while grns (grns.purchase_order_id -> purchase_orders) still
  // referenced them. Instead of a hand order, read EVERY foreign key among the
  // resolved CLEAR tables from pg_constraint and topologically sort so each table
  // is deleted BEFORE anything it references (children first, referenced parents
  // last). Provably correct regardless of family grouping; self-heals on schema
  // change. pg_constraint (not information_schema) = one clean row per FK.
  const fkRows = await sql`
    SELECT ns.nspname AS cs, cl.relname AS ct, fns.nspname AS ps, fcl.relname AS pt
      FROM pg_constraint con
      JOIN pg_class cl      ON cl.oid  = con.conrelid
      JOIN pg_namespace ns  ON ns.oid  = cl.relnamespace
      JOIN pg_class fcl     ON fcl.oid = con.confrelid
      JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
     WHERE con.contype = 'f' AND ns.nspname IN ('scm','public')`;
  const resolvedKeys = resolved.map((r) => `${r.schema}.${r.table}`);
  const resolvedKeySet = new Set(resolvedKeys);
  const clearKeySet = new Set(CLEAR.map(([s, t]) => `${s}.${t}`));
  const intraEdges = [];       // [child, parent] both being deleted -> child first
  const selfRefs = [];         // table with a FK to itself (handled by one DELETE)
  const externalInbound = [];  // a table NOT on CLEAR references a table we DELETE
  for (const r of fkRows) {
    const child = `${r.cs}.${r.ct}`;
    const parent = `${r.ps}.${r.pt}`;
    if (child === parent) { if (resolvedKeySet.has(child)) selfRefs.push(child); continue; }
    if (resolvedKeySet.has(child) && resolvedKeySet.has(parent)) intraEdges.push([child, parent]);
    else if (resolvedKeySet.has(parent) && !clearKeySet.has(child)) externalInbound.push([child, parent]);
  }
  const { order: topoOrder, remaining: cycleMembers } = topoDeleteOrder(resolvedKeys, intraEdges);
  const resolvedByKey = new Map(resolved.map((r) => [`${r.schema}.${r.table}`, r]));
  // Delete order = topo order (children first). Any cycle members (should be none)
  // are appended so nothing is silently dropped; apply REFUSES if the cycle is real.
  const deleteOrder = [...topoOrder, ...cycleMembers].map((k) => resolvedByKey.get(k));

  note(`\n=== FK-CORRECT DELETE ORDER (topological, children before parents) ===`);
  note(`  ${new Set(intraEdges.map((e) => e.join('|'))).size} FK edge(s) among the ${resolvedKeys.length} resolved CLEAR tables; computed order:`);
  topoOrder.forEach((k, i) => note(`  ${String(i + 1).padStart(2)}. ${k}`));
  if (selfRefs.length) note(`  self-referencing (handled by one scoped DELETE, not ordered): ${[...new Set(selfRefs)].join(', ')}`);
  if (cycleMembers.length) {
    bad(`  CYCLE among CLEAR tables (${cycleMembers.length}): ${cycleMembers.join(', ')} — APPLY WILL REFUSE. Break the cycle (defer the FK, or NULL the linking column) before applying.`);
  } else {
    note(`  no cycles — order is provably FK-safe for a single-transaction delete.`);
  }
  if (externalInbound.length) {
    const uniq = [...new Set(externalInbound.map(([c, p]) => `${c} -> ${p}`))].sort();
    note(`\n  ⚠ ${uniq.length} FK edge(s) from a NON-CLEAR table INTO a table we delete — a potential apply blocker IF the non-CLEAR side holds HC rows referencing these (the in-transaction rollback would catch it safely):`);
    for (const e of uniq) note(`     ${e}`);
  }

  // ── 4. Document-number evidence (what resets to 001) ─────────────────────
  note(`\n=== DOCUMENT NUMBERS — highest HC number today ===`);
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
    note(`  ${label.padEnd(4)} ${key.padEnd(30)} HC rows=${String(n).padStart(7)}  highest=${max_no ?? '(none)'}`);
  }

  /* ── 4b. THE COUNTER ITSELF — what actually decides the next number ──────
     Printed with the EVIDENCE that set each row, because the reset decision is
     made while reading this. A row whose source says "AED_HOUZS holds
     HC-SO-2608-001 and -002 since 2026-08-14" is telling the operator exactly
     what a reset would hand out again. */
  const countersLive = liveSet.has(DOC_COUNTERS_TABLE);
  note(`\n=== DOCUMENT-NUMBER COUNTER (${DOC_COUNTERS_TABLE}) ===`);
  let hcCounters = [];
  if (!countersLive) {
    note(`  ABSENT — migration 0316 has not applied here. Numbers are still derived from`);
    note(`  surviving rows, so deleting them DOES reset the series to 001, and can re-issue`);
    note(`  a number the AutoCount book already holds. docs/doc-number-reissue-coe.md.`);
  } else {
    const all = await sql`SELECT series, next_n, seed_source FROM scm.doc_number_counters ORDER BY series`;
    hcCounters = all.filter((r) => String(r.series).startsWith('HC-'));
    note(`  ${all.length} series total, ${hcCounters.length} of them HC.`);
    for (const r of hcCounters) {
      note(`  HC  ${String(r.series).padEnd(18)} next number = ${String(r.next_n).padStart(5)}   ${r.seed_source ?? '(no source recorded)'}`);
    }
    note(`  Deleting HC document rows does NOT move any of these. That is the fix for the`);
    note(`  2026-08-20 re-issue, and it is why apply now needs DOC_COUNTERS=keep|reset.`);
  }

  /* ── 4c. THE EXPORT LOG — kept, and what will be cancelled ────────── */
  const outboxLive = liveSet.has('scm.autocount_outbox');
  note(`\n=== EXPORT LOG (scm.autocount_outbox) — KEPT, not wiped ===`);
  let hcPending = 0;
  let hcOutboxTotal = 0;
  if (!outboxLive) {
    note(`  table absent in this database.`);
  } else {
    const [{ total: obTotal }] = await sql`SELECT count(*)::int AS total FROM scm.autocount_outbox WHERE company_id = ${HC_ID}`;
    const [{ pend }] = await sql`SELECT count(*)::int AS pend FROM scm.autocount_outbox WHERE company_id = ${HC_ID} AND status = 'pending'`;
    hcPending = Number(pend);
    hcOutboxTotal = Number(obTotal);
    note(`  ${obTotal} HC row(s) — ALL SURVIVE. ${hcPending} still 'pending' and would be marked 'skipped'`);
    note(`  (their documents are about to be deleted). The record of what was SENT is never removed:`);
    note(`  AutoCount is not wiped, so the ERP must not forget what it told AutoCount.`);
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
    note(`  Would delete ${total} HC rows across ${resolved.length} CLEAR tables.`);
    note(`  Document numbers would NOT reset by themselves — ${countersLive ? `the ${hcCounters.length} HC counter row(s) above decide that` : 'the counter table is absent here'}.`);
    note(`  ${hcPending} HC outbox row(s) would be marked 'skipped'; NONE would be deleted.`);
    note(`  To execute, numbering CONTINUES upward (recommended):`);
    note(`    MODE=apply CONFIRM="${CONFIRM_PHRASE}" DOC_COUNTERS=keep`);
    note(`  To execute AND restart numbering at 001 — re-read the counter rows above first:`);
    note(`    MODE=apply CONFIRM="${CONFIRM_PHRASE}" DOC_COUNTERS=reset CONFIRM_DOC_COUNTERS="${DOC_COUNTERS_RESET_PHRASE}"`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── 9. APPLY: backup, then delete children->parents in ONE transaction ────
  // Refuse if the FK graph among CLEAR tables has a real cycle — deleting in a
  // wrong order would FK-fail (safe rollback), but refusing up front is honest.
  if (cycleMembers.length) {
    bad(`refusing to apply: FK cycle among CLEAR tables (${cycleMembers.join(', ')}). Break it first.`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
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
    // FK-correct order: children before the parents they reference (section 3b).
    for (const r of deleteOrder) {
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

    /* ── SWEEP: this script's own DELETEs put rows BACK on the CLEAR list ────
       Migration 0302 installs trg_mfg_so_item_delete_audit, an AFTER DELETE ON
       scm.mfg_sales_order_items trigger that writes one audit row per deleted
       line into scm.mfg_so_item_deletions — which is itself a CLEAR table, and
       is emptied EARLIER in the topological order (it is a child, and children
       go first). So the pass above deletes the audit rows, then deletes the
       items, and the trigger writes the audit rows straight back.

       MEASURED, not theorised: run 32455489040 (2026-08-21) committed its wipe
       and then failed its own verification with
       `scm.mfg_so_item_deletions still has 4 HC rows` — exactly the 4 SO items
       the same transaction had deleted. Nothing was corrupt and the 2990 guard
       was green; the FIRST apply simply always failed and always needed a
       second run, which is a verification answering a different question from
       the one it appears to answer.

       Fixed generically rather than by special-casing that one table: sweep the
       CLEAR set until a pass deletes nothing. Any future AFTER DELETE trigger
       writing into a CLEAR table converges the same way. Three passes is a
       ceiling, not an expectation — one sweep has always been enough, and a
       trigger that refills faster than we can empty it is a REFUSAL, not
       something to keep retrying. */
    let sweptTotal = 0;
    let sweeps = 0;
    for (; sweeps < 3; sweeps += 1) {
      let swept = 0;
      for (const r of deleteOrder) {
        const del = await tx`DELETE FROM ${tx(qi(r.schema))}.${tx(qi(r.table))} WHERE company_id = ${HC_ID}`;
        if (del.count) {
          swept += del.count;
          deletedByTable.set(`${r.schema}.${r.table}`, (deletedByTable.get(`${r.schema}.${r.table}`) ?? 0) + del.count);
        }
      }
      if (swept === 0) break;
      sweptTotal += swept;
      note(`  sweep ${sweeps + 1}: ${swept} row(s) written BACK by our own AFTER DELETE triggers, removed`);
    }
    if (sweeps >= 3) {
      throw new Error('CLEAR tables still refilling after 3 sweeps — a trigger is writing rows faster than they are deleted; rolling back');
    }
    deletedTotal += sweptTotal;
    if (sweptTotal) note(`  total after ${sweeps} sweep(s): ${deletedTotal} rows`);

    /* ── THE EXPORT LOG: CANCEL, never delete ───────────────────────────────
       scm.autocount_outbox is on KEEP now (see the header). Its documents are
       gone, so a row still `pending` would have the drain chasing a document
       that no longer exists — but DELETING the row is what left AutoCount as
       the only party that remembered what we had sent. Cancel the intent, keep
       the memory. */
    if (outboxLive) {
      const cancelled = await tx`
        UPDATE scm.autocount_outbox
           SET status = 'skipped',
               last_error = ${`go-live wipe ${new Date().toISOString()}: source document deleted, send cancelled`},
               updated_at = now()
         WHERE company_id = ${HC_ID} AND status = 'pending'`;
      note(`  export log: ${cancelled.count} pending HC row(s) marked 'skipped'; 0 deleted (${hcOutboxTotal} HC rows kept).`);
    }

    /* ── THE COUNTER: whatever the operator chose, in the same transaction ──
       DOC_COUNTERS is required in apply mode (see the gates at the top), so
       there is no default branch here and no silent behaviour.

       reset deletes ONLY series that are unambiguously HC: `HC-…` and the bare
       `JE-…` HOUZS journal series (HOUZS JEs are historically bare — see
       jePrefixForCode in scm/lib/doc-no.ts). It NEVER touches `2990-…`, and it
       NEVER touches `TRIP-…`, which carries no company prefix because it is ONE
       sequence shared by both companies — resetting it would renumber 2990's
       trips, which this script exists to guarantee it does not do. Legacy bare
       `SO-…`/`PO-…` HOUZS series from before 2026-08-07 are left alone too:
       they are past months and nothing mints into them. */
    if (countersLive) {
      if (DOC_COUNTERS === 'reset') {
        const gone = await tx`
          DELETE FROM scm.doc_number_counters
           WHERE series LIKE 'HC-%' OR series LIKE 'JE-%'`;
        note(`  doc-number counters: RESET — ${gone.count} HC series deleted; the next mint of each starts at 001.`);
        note(`  Anything the AutoCount book already holds in those series WILL be offered to it again.`);
      } else {
        note(`  doc-number counters: KEPT — ${hcCounters.length} HC series continue upward. Deleting rows did not move them.`);
      }
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

    /* (d) THE EXPORT LOG SURVIVED, and nothing is left pending.
       Asserted as a SHAPE, not a count: the rows must still be there AND carry
       no `pending`. A count alone would pass on an empty table, which is
       exactly the state this assertion exists to make impossible again. */
    if (outboxLive) {
      const obRows = await check`
        SELECT status, count(*)::int AS n
          FROM scm.autocount_outbox WHERE company_id = ${HC_ID}
         GROUP BY status ORDER BY status`;
      const byStatus = new Map(obRows.map((r) => [String(r.status), Number(r.n)]));
      const kept = [...byStatus.values()].reduce((a, b) => a + b, 0);
      if (kept !== hcOutboxTotal) {
        problems.push(`EXPORT LOG LOST ROWS: ${hcOutboxTotal} HC outbox rows before, ${kept} after — the ERP's record of what it sent to AutoCount must survive a wipe`);
      }
      if ((byStatus.get('pending') ?? 0) !== 0) {
        problems.push(`export log still has ${byStatus.get('pending')} pending HC row(s) whose documents were just deleted`);
      }
      note(`  export log HC rows: ${kept} kept (want ${hcOutboxTotal}), pending ${byStatus.get('pending') ?? 0} (want 0) — ${[...byStatus].map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }

    /* (e) THE COUNTER matches what the operator ASKED FOR — again a shape.
       keep: every HC series is still present at exactly the number it held
       before the wipe. reset: no HC series remains, so each restarts at 001. */
    if (countersLive) {
      const after = await check`SELECT series, next_n FROM scm.doc_number_counters WHERE series LIKE 'HC-%' OR series LIKE 'JE-%' ORDER BY series`;
      const afterMap = new Map(after.map((r) => [String(r.series), Number(r.next_n)]));
      if (DOC_COUNTERS === 'reset') {
        if (after.length !== 0) problems.push(`DOC_COUNTERS=reset but ${after.length} HC counter row(s) remain: ${after.map((r) => r.series).join(', ')}`);
        note(`  doc-number counters after RESET: ${after.length} HC series remain (want 0)`);
      } else {
        for (const r of hcCounters) {
          const now = afterMap.get(String(r.series));
          if (now === undefined) problems.push(`DOC_COUNTERS=keep but counter ${r.series} DISAPPEARED`);
          else if (now < Number(r.next_n)) problems.push(`DOC_COUNTERS=keep but counter ${r.series} went BACKWARDS: was ${r.next_n}, now ${now}`);
        }
        note(`  doc-number counters after KEEP: ${hcCounters.length} HC series still at or above their pre-wipe number (want ${hcCounters.length})`);
      }
    }

    if (problems.length) {
      bad(`VERIFICATION FAILED:\n${problems.map((p) => `    - ${p}`).join('\n')}`);
      process.exit(1);
    }
    note(`\n  ALL ASSERTIONS PASSED: HC CLEAR tables empty, 2990 unchanged, KEEP sample unchanged,`);
    note(`  export log intact with nothing pending, doc-number counters ${DOC_COUNTERS === 'reset' ? 'RESET as requested' : 'KEPT as requested'}.`);
    note(`  Backup is in ${BACKUP_DIR} (also uploaded as a workflow artifact).`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  process.exit(1);
});
