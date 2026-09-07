#!/usr/bin/env node
/* READ-ONLY. Why an "APPLIED" log line is not evidence.

   Three `refresh-sofa-colours.mjs` apply runs on 2026-08-10 reported
   "APPLIED - stamped 127/146/146 sofa lines" with raced=0 - meaning every
   UPDATE came back with a non-zero rowcount - and the dry-run 29 seconds after
   the last one still reported the identical "already set 440 / TO FILL 146".
   Either the write never committed, or the write and the read are not looking
   at the same rows, columns or database.

   This script decides that WITHOUT theorising, by printing what is actually in
   the rows now:

     A  connection identity - database, user, schema, search_path, server
        address, backend pid, whether we are on a replica, read-only state.
        If the write and the read land on different databases, this is where it
        shows.
     B  relation identity - every pg_class entry named like the two item tables
        in ANY schema, their relkind, RLS, triggers and rules. A second table of
        the same name in another schema, an INSTEAD OF rule, or a BEFORE UPDATE
        trigger that returns OLD all produce "rowcount 1, nothing changed".
     C  the decisive read - re-derive the TO FILL set with the same query and
        the same matcher `refresh-sofa-colours.mjs` uses, then re-read those
        exact ids and print `variants` VERBATIM, plus `xmin` (the transaction
        that last wrote the row) and pg_typeof for id and variants.
        Colour keys present -> the write persisted and the detector is wrong.
        Colour keys absent   -> the write never committed.
     D  every distinct top-level key in `variants` across the migrated sofa
        lines, with counts. The script's own docstring warns the key names are
        load-bearing and that a near-miss key has already bitten this cutover
        once, on the venue picker; a near-miss key cannot hide from a histogram.
     E  the other applies of 2026-08-10, read from the data rather than their
        logs - the compartment corrections, the MODENZA-01 label and the two
        minted 5526 SKUs, and the 7 series / 18 colours of run 31400892282.

   Reads only. No transaction, no write, no DDL. */
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const txt = (v) => (typeof v === "string" ? v.trim() : "");
// identical to refresh-sofa-colours.mjs - the detector under suspicion
const isBound = (v) => !!(txt(v?.fabricId) || txt(v?.colourId) || txt(v?.fabricCode));

/* what create-missing-sofa-fabrics.mjs run 31400892282 reported creating */
const MADE_COLOURS = [
  ["HR805", "HR805-30"], ["HR805", "HR805-20"], ["HR805", "HR805-09"],
  ["GD2502", "GD2502-14"], ["MODENZA", "MODENZA-04"], ["BO315", "BO315-27"],
  ["J9883", "J9883-1-1"], ["ORION", "ORION-4"], ["ZL", "ZL-11"],
  ["NX", "NX003"], ["NX", "NX005"], ["NINJA 06", "NINJA 06"],
  ["CHINO", "CHINO-12"], ["NICCA", "NICCA-06"], ["PHOENIX", "PHOENIX-1"],
  ["MB", "MB-04"], ["HM3383", "HM3383-6"], ["SL", "SL0095"],
];
const MADE_SERIES = ["NINJA 06", "CHINO", "NICCA", "PHOENIX", "MB", "HM3383", "SL"];

async function main() {
  // ---- A. who are we talking to ---------------------------------------------
  log("=== A. CONNECTION IDENTITY ===");
  const [w] = await sql`SELECT current_database() db, current_user usr, current_schema() sch,
    current_setting('search_path') sp, coalesce(inet_server_addr()::text,'(local)') srv,
    coalesce(inet_server_port()::text,'?') prt, pg_backend_pid() pid,
    pg_is_in_recovery() replica, current_setting('transaction_read_only') ro,
    coalesce(txid_current_if_assigned()::text,'(none)') txid,
    split_part(version(),' on ',1) ver`;
  for (const [k, v] of Object.entries(w)) log(`  ${k.padEnd(9)} ${v}`);

  // ---- B. what are we writing to --------------------------------------------
  log("");
  log("=== B. RELATION IDENTITY (every schema) ===");
  const rels = await sql`SELECT n.nspname sch, c.relname rel, c.relkind::text kind,
      c.relrowsecurity rls, c.relforcerowsecurity frls, c.reltuples::bigint est
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname IN ('mfg_sales_order_items','purchase_order_items')
    ORDER BY n.nspname, c.relname`;
  for (const r of rels)
    log(`  ${r.sch}.${r.rel}  relkind=${r.kind}  rls=${r.rls}/${r.frls}  est_rows=${r.est}`);
  if (rels.length > 2) log(`  !! ${rels.length} relations share these two names - a search_path hazard`);

  const trg = await sql`SELECT c.relname rel, t.tgname, t.tgenabled::text en, pg_get_triggerdef(t.oid) def
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'scm' AND c.relname IN ('mfg_sales_order_items','purchase_order_items')
      AND NOT t.tgisinternal`;
  log(`  triggers: ${trg.length}`);
  for (const t of trg) log(`    ${t.rel}.${t.tgname} enabled=${t.en}  ${t.def}`);

  const rules = await sql`SELECT tablename tbl, rulename, definition FROM pg_rules
    WHERE schemaname = 'scm' AND tablename IN ('mfg_sales_order_items','purchase_order_items')`;
  log(`  rules: ${rules.length}`);
  for (const r of rules) log(`    ${r.tbl}.${r.rulename}  ${r.definition}`);

  const cols = await sql`SELECT table_name tbl, column_name col, data_type dt
    FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name IN ('mfg_sales_order_items','purchase_order_items')
      AND (column_name = 'id' OR column_name ILIKE '%variant%')
    ORDER BY table_name, column_name`;
  for (const c of cols) log(`  column  ${c.tbl}.${c.col} :: ${c.dt}`);

  const stat = await sql`SELECT relname rel, n_tup_upd, n_tup_ins, n_live_tup
    FROM pg_stat_all_tables WHERE schemaname = 'scm'
      AND relname IN ('mfg_sales_order_items','purchase_order_items')`;
  for (const s of stat) log(`  stat    ${s.rel}  n_tup_upd=${s.n_tup_upd} n_tup_ins=${s.n_tup_ins} live=${s.n_live_tup}`);

  // ---- C. the decisive read --------------------------------------------------
  log("");
  log("=== C. THE DECISIVE READ ===");
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  /* The unlabelled-colour rule inside parseSofa is gated on this callback and
     does NOTHING without it - "MODENZA-05 (DARK OLIVE)/35”/1R+1R" writes the
     colour first with no COL: label, and this script, whose whole job is to
     stamp colours, was calling parseSofa without it. Same contract as
     import-ac-outstanding-so.mjs:177. */
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };

  log(`fabric library: ${new Set(fcRows.map((r) => r.fabric_id)).size} series / ${fcRows.length} colours`);

  const soLines = await sql`SELECT i.id, i.item_code AS code, i.description2 AS d2, i.variants
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  const poLines = await sql`SELECT i.id, i.item_code AS code, i.description2 AS d2, i.variants
    FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL`;
  log(`migrated sofa lines: SO ${soLines.length}, PO ${poLines.length}`);

  const fill = { so: [], po: [] };
  const tally = { bound: 0, none: 0, pending: 0, fill: 0, miss: 0 };
  for (const [which, rows] of [["so", soLines], ["po", poLines]]) {
    for (const r of rows) {
      const had = r.variants || {};
      if (isBound(had)) { tally.bound++; continue; }
      let model = String(r.code || "").split("-")[0].toUpperCase();
      model = SOFA_MODEL_ALIAS[model] || model;
      const ps = r.d2 ? parseSofa(r.d2, model, false, { knownColour }) : null;
      const raw = txt(ps?.color) || txt(had.colourLabel);
      if (!raw) { tally.none++; continue; }
      if (isPendingColour(raw)) { tally.pending++; continue; }
      if (!findColour(raw)) { tally.miss++; continue; }
      tally.fill++;
      fill[which].push(r.id);
    }
  }
  log(`detector says: already set ${tally.bound} · no colour ${tally.none} · TBC/KIV ${tally.pending} · TO FILL ${tally.fill} (SO ${fill.so.length}, PO ${fill.po.length}) · unresolved ${tally.miss}`);

  /* Deliberately plain tagged templates, not sql.unsafe(q, params): the probe
     must not read through the very call shape that is under suspicion. */
  const soIds = fill.so.slice(0, 5);
  const poIds = fill.po.slice(0, 5);
  const show = (which, rows) => {
    log("");
    log(`--- RAW variants of ${rows.length} ${which} lines the applies claim they stamped ---`);
    for (const r of rows) {
      log(`  id=${r.id}  (${r.idtype})  code=${r.code}  xmin=${r.xmin}  variants::${r.vtype}`);
      log(`    ${r.v}`);
    }
  };
  if (soIds.length) show("SO", await sql`SELECT id::text AS id, item_code AS code, xmin::text AS xmin,
      pg_typeof(id)::text AS idtype, pg_typeof(variants)::text AS vtype,
      coalesce(variants::text,'<NULL>') AS v
    FROM scm.mfg_sales_order_items WHERE id = ANY(${soIds})`);
  if (poIds.length) show("PO", await sql`SELECT id::text AS id, item_code AS code, xmin::text AS xmin,
      pg_typeof(id)::text AS idtype, pg_typeof(variants)::text AS vtype,
      coalesce(variants::text,'<NULL>') AS v
    FROM scm.purchase_order_items WHERE id = ANY(${poIds})`);

  // ---- D. every key that exists ----------------------------------------------
  log("");
  log("=== D. TOP-LEVEL variants KEYS ACROSS THE MIGRATED SOFA LINES ===");
  /* jsonb_object_keys() ERRORS on anything that is not an object, which is how
     the first prod run of this probe ended: "cannot call jsonb_object_keys on
     an array". Report the shape first, then key only the objects. */
  for (const [which, shapeQ, keyQ] of [
    ["SO",
      sql`SELECT COALESCE(jsonb_typeof(i.variants),'(null)') s, COUNT(*)::int n
            FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
           WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL
           GROUP BY 1 ORDER BY 2 DESC`,
      sql`SELECT k, COUNT(*)::int n FROM (
            SELECT jsonb_object_keys(i.variants) k
              FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
             WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL
               AND jsonb_typeof(i.variants) = 'object'
          ) t GROUP BY k ORDER BY n DESC, k`],
    ["PO",
      sql`SELECT COALESCE(jsonb_typeof(i.variants),'(null)') s, COUNT(*)::int n
            FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
           WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL
           GROUP BY 1 ORDER BY 2 DESC`,
      sql`SELECT k, COUNT(*)::int n FROM (
            SELECT jsonb_object_keys(i.variants) k
              FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
             WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.linked_ac_docno IS NOT NULL
               AND jsonb_typeof(i.variants) = 'object'
          ) t GROUP BY k ORDER BY n DESC, k`],
  ]) {
    const shapes = await shapeQ;
    log(`  ${which} variants SHAPE: ${shapes.map((r) => `${r.s}=${r.n}`).join("  ")}`);
    const ks = await keyQ;
    log(`  ${which} keys (objects only): ${ks.map((r) => `${r.k}=${r.n}`).join("  ")}`);
  }

  /* the sibling exposure: the same double-encoding trap on the specials
     columns, which two other scripts wrote through today */
  const sp = await sql`SELECT COALESCE(jsonb_typeof(custom_specials),'(null)') s, COUNT(*)::int n
    FROM scm.mfg_sales_order_items GROUP BY 1 ORDER BY 2 DESC`;
  log(`  SO custom_specials SHAPE: ${sp.map((r) => `${r.s}=${r.n}`).join("  ")}`);
  const sv = await sql`SELECT COALESCE(jsonb_typeof(variants->'specials'),'(absent)') s, COUNT(*)::int n
    FROM scm.mfg_sales_order_items WHERE jsonb_typeof(variants) = 'object' GROUP BY 1 ORDER BY 2 DESC`;
  log(`  SO variants->specials SHAPE: ${sv.map((r) => `${r.s}=${r.n}`).join("  ")}`);

  // ---- E. did the rest of 2026-08-10 land? -----------------------------------
  log("");
  log("=== E. THE OTHER APPLIES OF 2026-08-10, READ FROM THE DATA ===");

  log("(a) sofa compartment corrections - run 31404463455");
  const added = await sql`SELECT doc_no, item_code FROM scm.mfg_sales_order_items
    WHERE remark = 'compartment corrected 2026-08-10' ORDER BY doc_no, item_code`;
  log(`  lines carrying remark 'compartment corrected 2026-08-10': ${added.length}  (log claimed 'added 2')`);
  for (const r of added) log(`    ${r.doc_no}  ${r.item_code}`);
  for (const doc of ["HC-SO-011733", "HC-SO-012877"]) {
    const r = await sql`SELECT i.item_code c, i.variants->>'seatHeight' sh FROM scm.mfg_sales_order_items i
      WHERE i.doc_no = ${doc} AND i.item_group = 'sofa' ORDER BY i.line_no`;
    log(`  ${doc}: ${r.map((x) => x.c).join(" + ") || "(no sofa lines)"}  seat=${r[0]?.sh ?? "-"}`);
  }
  for (const po of ["HC-PO-008783", "HC-PO-000254"]) {
    const r = await sql`SELECT i.item_code c, i.variants->>'seatHeight' sh
      FROM scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      WHERE h.po_number = ${po} AND i.item_group = 'sofa' ORDER BY i.id`;
    log(`  ${po}: ${r.map((x) => x.c).join(" + ") || "(not found / no sofa lines)"}  seat=${r[0]?.sh ?? "-"}`);
  }
  const [{ n: grnDrift }] = await sql`SELECT COUNT(*)::int n FROM scm.grn_items g
    JOIN scm.purchase_order_items p ON p.id = g.purchase_order_item_id
    WHERE p.item_group = 'sofa' AND g.item_code IS DISTINCT FROM p.item_code`;
  const [{ n: poDrift }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_order_items p
    JOIN scm.mfg_sales_order_items s ON s.id = p.so_item_id
    WHERE p.item_group = 'sofa' AND p.item_code IS DISTINCT FROM s.item_code`;
  const [{ n: doDrift }] = await sql`SELECT COUNT(*)::int n FROM scm.delivery_order_items d
    JOIN scm.mfg_sales_order_items s ON s.id = d.so_item_id
    WHERE s.item_group = 'sofa' AND d.item_code IS DISTINCT FROM s.item_code`;
  log(`  downstream still disagreeing with its parent: GRN ${grnDrift} · PO-vs-SO ${poDrift} · DO-vs-SO ${doDrift} (0 = the carry landed)`);

  log("(b) MODENZA-01 label + the two minted 5526 SKUs - run 31404384410");
  const mod = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours
    WHERE company_id = ${CO} AND fabric_id = 'MODENZA' AND colour_id = 'MODENZA-01'`;
  log(`  MODENZA-01 label = ${mod.length ? JSON.stringify(mod[0].label) : "(row absent)"}`);
  const skus = await sql`SELECT code, name FROM scm.mfg_products
    WHERE company_id = ${CO} AND code IN ('5526-1ABOX(LHF)','5526-1NA','5526-2A(RHF)') ORDER BY code`;
  log(`  minted SKUs found: ${skus.length}/3`);
  for (const s of skus) log(`    ${s.code}  ${JSON.stringify(s.name)}`);

  log("(c) create-missing-sofa-fabrics - run 31400892282 (+7 series / +18 colours)");
  const gotSeries = await sql`SELECT id, label FROM scm.fabric_library
    WHERE company_id = ${CO} AND id = ANY(${MADE_SERIES}) ORDER BY id`;
  log(`  fabric_library: ${gotSeries.length}/7 present -> ${gotSeries.map((r) => r.id).join(", ") || "(none)"}`);
  const missSeries = MADE_SERIES.filter((s) => !gotSeries.some((r) => r.id === s));
  if (missSeries.length) log(`  MISSING series: ${missSeries.join(", ")}`);
  // membership checked in JS against the library already read in section C -
  // a tuple IN list is the one place a driver quirk could fake a clean answer
  const have = new Set(fcRows.map((r) => `${r.fabric_id}\0${r.colour_id}`));
  const missCol = MADE_COLOURS.filter(([f, c]) => !have.has(`${f}\0${c}`));
  log(`  fabric_colours: ${18 - missCol.length}/18 present`);
  if (missCol.length) log(`  MISSING colours: ${missCol.map(([f, c]) => `${f}/${c}`).join(", ")}`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
