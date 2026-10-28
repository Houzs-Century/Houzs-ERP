#!/usr/bin/env node
// Phase 2 — migrate 2990's live data INTO Houzs, tagged company_id=2990.
// SOURCE via Supabase REST (service_role). DEST via postgres.js. Dry-run unless APPLY=1.
// FK checks disabled for the load session so ordering / skipped masters don't block.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import {
  SO_PROCESSING_DATE_COLUMN,
  SO_PROCESSING_DATE_LEGACY_COLUMNS,
} from "./lib/so-processing-date.mjs";
const SUPA_URL = process.env.SOURCE_SUPABASE_URL, SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY, DST = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === "1";
if (!SUPA_URL || !SUPA_KEY || !DST) { console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL"); process.exit(2); }
const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
// 2026-07-23 owner ask: fill remaining diag gaps → add so_revisions +
// mfg_so_audit_log + mfg_so_status_changes + pending_slip_uploads +
// pos_carts + sync_config (5 tables previously omitted). accounts,
// drivers, lorries stay EXCLUDED (deferred per owner rulings).
// 2026-07-23 owner ask: gap-diag caught 9 CARRES SKUs on 2990 source with no
// counterparts on dest — mfg_products was never in ORDER, so the SKU catalog
// only landed via a manual one-shot back at cutover; every top-up since has
// silently ignored new/renamed SKUs. Adding it AFTER the shared masters
// (categories / product_models) and BEFORE anything that FK-refs item_code
// (so mfg_sales_order_items / grn_items find their catalog row).
// 2026-07-23 owner ask: "要搬,帮我处理" — import 2990's chart of accounts (GL).
// check-2990-gl-collision.mjs confirmed NO COLLISION (all 31 2990 codes are free
// on dest), so a plain import is safe: accounts.company_id (mig 0083) stamps the
// rows company_2, the global UNIQUE(account_code) still holds, and the
// payment_vouchers FK is unaffected. The chart is already per-company in the
// code (accounts.company_id NOT NULL + /accounts route scopeToCompany), so these
// rows surface ONLY under the 2990 company. Placed with the other config masters.
const ORDER = ["staff","customers","suppliers","series","categories","products","product_models","product_fabrics","product_size_variants","mfg_products","warehouses","supplier_material_bindings","venues","mfg_sales_orders","mfg_sales_order_items","mfg_sales_order_payments","so_revisions","mfg_so_audit_log","mfg_so_status_changes","delivery_orders","delivery_order_items","sales_invoices","sales_invoice_items","sales_invoice_payments","delivery_returns","delivery_return_items","purchase_orders","purchase_order_items","grns","grn_items","purchase_invoices","purchase_invoice_items","purchase_returns","purchase_return_items","inventory_movements","inventory_lots","inventory_lot_consumptions","pwp_rules","pwp_codes","analysis_customer_targets","drivers","currencies","app_config","accounts","delivery_order_payments","pending_slip_uploads","pos_carts","sync_config"];
// `lorries` deliberately NOT imported (owner ruling 2026-07-21): 2990's lorry
// master is not carried over — Houzs fleet is managed on the Houzs side.
// `accounts` (GL) is now IN ORDER (2026-07-23): check-2990-gl-collision proved 2990's 31
// codes are all free on dest, so the global UNIQUE(account_code) holds and the
// payment_vouchers FK is unaffected — company_id=2 stamping is enough. Before company 3/4/5
// the constraint should become UNIQUE(company_id, account_code) (see the multi-company
// audit), but that is not needed for the 2-company world. `sofa_personal_quick_picks` needs a shape
// transform (staff_id uuid -> owner_user_id bigint) — handled by the custom pass below.
// Earlier import generations REMAPPED some parent ids on PK collision (see mig 0092),
// so verbatim-id child rows can point at parents that don't exist under company_2.
// GUARD drops such rows instead of inserting dangling garbage (FK checks are off).
const DANGLING_GUARD = { product_size_variants: { parent: "size_library", col: "size_id" }, delivery_order_payments: { parent: "delivery_orders", col: "delivery_order_id" } };
// Post-migration NOT NULL columns the SOURCE doesn't carry — set a safe
// default at INSERT time. mig 0177 added `warehouses.type NOT NULL`; source
// 2990 predates that so its rows have no `type` value and Postgres rejects
// the insert with "null value in column type violates not-null constraint".
// Default to 'warehouse' (the most common bucket); operators can retag via
// the Warehouse Maintenance UI drawer if a row should be showroom/display.
const COLUMN_DEFAULTS = { warehouses: { type: "warehouse" } };
const DOCNO_COL = { mfg_sales_orders:"doc_no", delivery_orders:"do_number", sales_invoices:"invoice_number", purchase_orders:"po_number", grns:"grn_number", purchase_invoices:"invoice_number", delivery_returns:"dr_number", purchase_returns:"pr_number" };
const prefixDoc = (v) => (v == null || String(v).startsWith("2990-") ? v : `2990-${v}`);
// Houzs-only FK columns to null on import (source values point at masters we don't migrate)
const NULL_COLS = { mfg_sales_orders: ["venue_id"], delivery_orders: ["venue_id"] };
// Child tables reference parents by doc-number STRING -> must carry the same 2990- prefix
const PREFIX_REF_COLS = { mfg_sales_order_items: ["doc_no"], mfg_sales_order_payments: ["so_doc_no"], delivery_orders: ["so_doc_no"], inventory_lots: ["source_doc_no"], inventory_movements: ["source_doc_no"], inventory_lot_consumptions: ["source_doc_no"], mfg_sales_orders: ["cross_category_source_doc_no"], pwp_codes: ["source_doc_no","redeemed_doc_no"] };
/* RENAMED COLUMNS — source name -> destination name.
   ---------------------------------------------------------------------------
   This importer matches columns BY NAME (`shared` below), which is right until
   the two sides disagree about what a column is called. Then a rename is
   invisible to it twice over: the source key finds no destination column and is
   silently dropped, and any destination column that HAPPENS to share a name with
   something else on the source is filled from that instead.

   THE PROCESSING DATE IS EXACTLY THAT CASE, AND IT IS THE WORST SHAPE OF IT.
   Migration 0286 renamed the destination's `internal_expected_dd` to
   `processing_date`. The 2990 source is a SEPARATE repo on its own deploy
   schedule and still carries BOTH names (scm-schema/2990s-full-schema.sql lists
   "processing_date" AND "internal_expected_dd" on mfg_sales_orders) — its LIVE
   column is `internal_expected_dd`, and its `processing_date` is the dead twin
   that migration 0189 dropped on this side. So without this map the importer
   would match `processing_date` -> `processing_date` by name, fill the ERP's
   LIVE Processing Date from the source's DEAD column, and drop the real date
   into the `[drop:…]` list where it reads as an ordinary unmapped field.

   That is not a cosmetic loss: the Processing Date gates Proceed, the stock
   allocator and the MRP demand set (shared/so-processing-date.ts), and a wrong
   one is worse than a missing one because nothing downstream can tell.

   The live SO MIRROR was already given this alias — SO_PROCESSING_DATE_LEGACY_COLUMNS
   in scripts/lib/so-processing-date.mjs and its TypeScript twin, whose header
   states the rule and the removal condition. This bulk path never was, which is
   the same rule expressed at N call sites and present at N-1.

   BOTH NAMES ARE IMPORTED, NEVER TYPED. tests/soProcessingDateOneName.test.mjs
   walks backend/scripts and fails any script that hand-types the retired name
   in code, because eleven of them once did and every one of their queries was
   answered with 42703 — which fails the WHOLE statement, so the audits returned
   nothing and read as clean. lib/so-processing-date.mjs is the one file
   entitled to spell it; building the map from that export is what keeps this
   script correct on the day 2990 finally deploys and the entry is removed
   there. Doing it by hand here would have re-created the defect this map exists
   to fix, one layer up.

   A rename entry WINS over a same-named source column: the legacy name supplies
   `processing_date` and the source's own dead `processing_date` is ignored. */
const SO_RENAMES = Object.fromEntries(
  SO_PROCESSING_DATE_LEGACY_COLUMNS.map((legacy) => [legacy, SO_PROCESSING_DATE_COLUMN]),
);
const RENAME_COLS = {
  mfg_sales_orders: { ...SO_RENAMES },
  consignment_sales_orders: { ...SO_RENAMES },
};
// Shared masters WITHOUT company_id: import so historical FK refs (salesperson/created_by)
// resolve; forced inactive so they never appear in Houzs pickers.
const NO_CID = { staff: { forceInactive: true } };
async function companyId2990() { const r = await dst`SELECT id FROM companies WHERE code='2990'`; if (!r.length) throw new Error("no 2990 company"); return Number(r[0].id); }
async function fetchAll(table) { const out=[]; const P=1000; for (let f=0;;f+=P){ const {data,error}=await src.schema("public").from(table).select("*").range(f,f+P-1); if(error) throw new Error(error.message); out.push(...(data??[])); if(!data||data.length<P) break; } return out; }
async function destCols(table){ const r=await dst`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name=${table}`; return r.map(x=>x.column_name); }
async function main() {
  const cid = await companyId2990();
  console.log(`2990 company_id=${cid} mode=${APPLY?"APPLY":"DRY-RUN"}`);
  if (APPLY) { try { await dst.unsafe("SET session_replication_role = replica"); console.log("FK checks OFF for load"); } catch(e){ console.log("WARN no FK-disable: "+e.message); } }
  let totalSrc=0,totalImp=0;
  for (const table of ORDER) {
    let rows; try { rows=await fetchAll(table); } catch(e){ console.log(`SKIP ${table}: src (${e.message})`); continue; }
    if (rows.length===0){ console.log(`${table}: 0`); continue; }
    let dcols; try { dcols=await destCols(table); } catch(e){ console.log(`SKIP ${table}: dest (${e.message})`); continue; }
    const noCid=NO_CID[table];
    if (!dcols.includes("company_id")&&!noCid){ console.log(`SKIP ${table}: no company_id`); continue; }
    const dset=new Set(dcols), srcCols=Object.keys(rows[0]);
    /* RENAMES FIRST, and only the ones this destination actually has. An entry
       naming a destination column that does not exist is a stale map, not a
       silent no-op — say so rather than dropping the source column on the floor,
       because "the date never arrived" is precisely the failure mode this map
       exists to stop. */
    const renameAll=RENAME_COLS[table]??{};
    const rename=Object.fromEntries(Object.entries(renameAll).filter(([s,d])=>srcCols.includes(s)&&dset.has(d)));
    for (const [s,d] of Object.entries(renameAll)) {
      if (!srcCols.includes(s)) continue;
      if (!dset.has(d)) console.log(`  WARN rename ${s}->${d}: destination has no '${d}' column; ${s} will be DROPPED`);
    }
    const renamedDest=new Set(Object.values(rename));
    /* A renamed source column supplies its destination, so a same-named source
       column for that SAME destination must not also be copied — otherwise
       iteration order decides which of the two wins, silently. The 2990 source
       carries both `internal_expected_dd` (live) and `processing_date` (dead),
       and this is the line that makes the live one win. */
    const shared=srcCols.filter(c=>dset.has(c)&&c!=="company_id"&&!(c in rename)&&!renamedDest.has(c));
    const dropped=srcCols.filter(c=>!dset.has(c)&&!(c in rename));
    if (Object.keys(rename).length) console.log(`  rename: ${Object.entries(rename).map(([s,d])=>`${s}->${d}`).join(", ")}`);
    const supersededBySrc=srcCols.filter(c=>renamedDest.has(c)&&dset.has(c));
    if (supersededBySrc.length) console.log(`  ignored (superseded by a rename): ${supersededBySrc.join(", ")}`);
    totalSrc+=rows.length; const docCol=DOCNO_COL[table];
    const defs=COLUMN_DEFAULTS[table];
    const shaped=rows.map(r=>{ const o=noCid?{}:{company_id:cid}; for(const c of shared)o[c]=r[c]; for(const[s,d]of Object.entries(rename))o[d]=r[s]; if(docCol&&o[docCol]!=null)o[docCol]=prefixDoc(o[docCol]); const refs=PREFIX_REF_COLS[table]; if(refs)for(const rc of refs)if(o[rc]!=null)o[rc]=prefixDoc(o[rc]); const nulls=NULL_COLS[table]; if(nulls)for(const nc of nulls)if(nc in o)o[nc]=null; if(defs)for(const[k,v]of Object.entries(defs))if(dset.has(k)&&(o[k]==null))o[k]=v; if(noCid?.forceInactive&&dset.has("active"))o.active=false; return o; });
    console.log(`${table}: ${rows.length}`+(docCol?` (${docCol}->2990-)`:"")+(dropped.length?` [drop:${dropped.join(",")}]`:""));
    let toInsert=shaped;
    const guard=DANGLING_GUARD[table];
    if (guard){ const par=await dst`SELECT id FROM scm.${dst(guard.parent)} WHERE company_id=${cid}`; const ok=new Set(par.map(x=>String(x.id))); toInsert=shaped.filter(r=>r[guard.col]!=null&&ok.has(String(r[guard.col]))); if(toInsert.length!==shaped.length)console.log(`  GUARD dropped ${shaped.length-toInsert.length} rows with ${guard.col} not in company-scoped ${guard.parent} (id-remap era parents)`); if(!toInsert.length)continue; }
    if (APPLY){ const cols=Object.keys(toInsert[0]); let ins=0; for(let i=0;i<toInsert.length;i+=500){ const res=await dst`INSERT INTO scm.${dst(table)} ${dst(toInsert.slice(i,i+500),cols)} ON CONFLICT DO NOTHING`; ins+=res.count??0; }
      if (noCid){ totalImp+=ins; console.log(`  -> ${ins} (shared table, inserted this run)`); }
      else { const got=await dst`SELECT count(*)::int AS n FROM scm.${dst(table)} WHERE company_id=${cid}`; totalImp+=Number(got[0].n); console.log(`  -> ${got[0].n}`); } }
  }
  if (APPLY) { try { await dst.unsafe("SET session_replication_role = DEFAULT"); } catch(e){} }
  // Repair pass (idempotent, FK checks back ON so violations fail loudly):
  // earlier runs imported child rows with UNPREFIXED doc-no refs + venue_id set.
  if (APPLY) {
    console.log("=== repair pass ===");
    for (const [t,c] of [["mfg_sales_order_items","doc_no"],["mfg_sales_order_payments","so_doc_no"],["delivery_orders","so_doc_no"],["inventory_lots","source_doc_no"],["inventory_movements","source_doc_no"],["inventory_lot_consumptions","source_doc_no"],["mfg_sales_orders","cross_category_source_doc_no"],["pwp_codes","source_doc_no"],["pwp_codes","redeemed_doc_no"]]) {
      // regex guard: only prefix values that look like internal doc numbers (SO-/DO-/GRN-/...)
      const r=await dst.unsafe(`UPDATE scm."${t}" SET "${c}"='2990-'||"${c}" WHERE company_id=${cid} AND "${c}" IS NOT NULL AND "${c}" NOT LIKE '2990-%' AND "${c}" ~ '^[A-Z]{2,4}-[0-9]'`);
      console.log(`prefix ${t}.${c}: ${r.count} rows`);
    }
    for (const [t,c] of [["mfg_sales_orders","venue_id"],["delivery_orders","venue_id"]]) {
      const r=await dst.unsafe(`UPDATE scm."${t}" SET "${c}"=NULL WHERE company_id=${cid} AND "${c}" IS NOT NULL`);
      console.log(`null ${t}.${c}: ${r.count} rows`);
    }
  }
  // Custom pass: 2990 `sofa_personal_quick_picks` (staff_id uuid) -> Houzs
  // `scm.personal_quick_picks` (owner_user_id bigint). Resolve owner via
  // scm.staff.user_id (staff ids were imported verbatim; user_id backfilled by mig 0066).
  try {
    const picks = await fetchAll("sofa_personal_quick_picks");
    const live = picks.filter(p => p.deleted_at == null);
    console.log(`sofa_personal_quick_picks: ${picks.length} src (${live.length} live) -> personal_quick_picks`);
    if (live.length && APPLY) {
      let ins = 0, unresolved = 0;
      for (const p of live) {
        const s = await dst`SELECT user_id FROM scm.staff WHERE id=${p.staff_id} AND user_id IS NOT NULL`;
        if (!s.length) { unresolved++; console.log(`  WARN no user_id for staff ${p.staff_id} (pick ${p.id}) — skipped`); continue; }
        const r = await dst`INSERT INTO scm.personal_quick_picks ${dst({ id: p.id, company_id: cid, owner_user_id: Number(s[0].user_id), base_model: p.base_model, label: p.label, modules: p.modules, depth: p.depth, sort_order: p.sort_order, deleted_at: p.deleted_at, created_at: p.created_at, updated_at: p.updated_at })} ON CONFLICT DO NOTHING`;
        ins += r.count ?? 0;
      }
      console.log(`  -> inserted ${ins}${unresolved ? `, ${unresolved} unresolved` : ""}`);
    }
  } catch (e) { console.log(`SKIP personal_quick_picks pass: ${e.message}`); }
  console.log(`RECONCILE source=${totalSrc}`+(APPLY?` imported=${totalImp}`:" (DRY-RUN)"));
}
main().then(()=>dst.end()).catch(async e=>{ console.error("MIGRATE_FAIL",e.message); try{await dst.unsafe("SET session_replication_role = DEFAULT");}catch{} await dst.end(); process.exit(1); });
