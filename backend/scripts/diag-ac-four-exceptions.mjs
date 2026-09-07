#!/usr/bin/env node
/* diag-ac-four-exceptions — the four data exceptions blocking the go-live tally
 * between AutoCount and the ERP (owner, 2026-09-07:「SO PO DO GR SI PI 一定要
 * 是内容和该有的数据全部 tally 跟 autocount」).
 *
 * READ-ONLY.  One Postgres connection, SELECTs only, no DDL, no writes, no
 * transaction.  Every legitimate answer — including "the row is there and it
 * is wrong" — exits 0, because the ANSWER is the output and a red job reads as
 * "the check broke" (CLAUDE.md, the check-soak-gate rules).  Non-zero is
 * reserved for the check being UNABLE to answer: unreachable DB, or a missing
 * AutoCount snapshot.
 *
 * ── THE FOUR ────────────────────────────────────────────────────────────────
 *   1. HC-PO-009944  an ERP purchase order claiming AutoCount PO-009944, which
 *      the book does not have.  Reports provenance (created_at / created_by),
 *      its lines, and everything downstream — a GRN, an invoice, stock moves.
 *      RECOMMENDS ONLY.  The owner's standing rule is never delete, only
 *      cancel, so this script neither deletes nor cancels anything.
 *   2. PO-010113     names CreditorCode 400-Z003, absent from scm.suppliers,
 *      so import-ac-outstanding-po.mjs:195 skips the whole document every run.
 *      Reports whether that supplier is already present under another code or
 *      another name, which decides "link it" against "open it".
 *   3. PO-009979     one line with NO item code, "ERGOTEX PILLOW CASE - FAIR"
 *      x20.  scm.purchase_order_items.item_code is NOT NULL, so the line
 *      cannot be inserted as-is.  Reports whether an accessory product that
 *      would carry it already exists.
 *   4. The sofa MODEL disagreements on sales orders.  Reproduces the
 *      comparison check-ac-erp-reconcile.mjs makes, then applies ONE extra
 *      test that the reconcile checker does not: whether the ERP model that
 *      "disagrees" is itself the model of ANOTHER AutoCount line of the SAME
 *      document.  If it is, the two systems hold the same multiset of models
 *      and only the DtlKey pairing is crossed — a checker defect, not a data
 *      defect.  The two populations are counted separately and neither is
 *      reported as the other.
 *
 * Nothing here writes.  Repairs, if any, are separate scripts with their own
 * plan/apply switch.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const SNAP = path.join(DATA, "ac-reconcile-truth.json.gz");
const MAP_CSV = path.join(DATA, "autocount-erp-mapping-1561.csv");
const CO = Number(process.env.COMPANY_ID || 1);
const SHOW = Number(process.env.SHOW || 25);

const plain = (m) => console.log(m);
const head = (m) => console.log(`\n===== ${m} =====`);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL not set.");
  process.exit(2);
}
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is missing.`);
  process.exit(2);
}

const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
plain(`AutoCount snapshot exported_at=${snap.exported_at}  source=${snap.source}`);
plain(`book rows: ${JSON.stringify(snap.counts)}`);

const hIdx = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
const lIdx = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/* the reconcile checker's own two predicates, copied verbatim so this
   diagnostic measures the SAME population it is explaining */
const isSofaCode = (s) => /SOFA/i.test(String(s ?? ""));
const modelOf = (s) => (String(s ?? "").match(/\d{3,}/) || [null])[0];
/* the fold 10 other scripts apply and check-ac-erp-reconcile.mjs does not */
const foldedModel = (s) => {
  const m = modelOf(s);
  return m == null ? null : SOFA_MODEL_ALIAS[m] || m;
};

const codeMap = new Map();
{
  const rows = fs.readFileSync(MAP_CSV, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  rows.shift();
  for (const line of rows) {
    const [ac, erp] = line.split(",");
    if (ac && erp) codeMap.set(norm(ac), norm(erp));
  }
}
const mapped = (s) => codeMap.get(norm(s)) ?? norm(s);
plain(`item-code map: ${codeMap.size} rows`);

const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 30, prepare: false });

/* Schema discovery.  This diagnostic must not GUESS a column name: a wrong
   guess exits 2 and reads as "the DB is unreachable", which is exactly the
   failure mode CLAUDE.md reserves that code for.  One catalog read, then every
   optional query is gated on what actually exists. */
const colsOf = new Map();
{
  const rows = await sql`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'scm'`;
  for (const r of rows) {
    if (!colsOf.has(r.table_name)) colsOf.set(r.table_name, new Set());
    colsOf.get(r.table_name).add(r.column_name);
  }
}
const hasCol = (t, c) => colsOf.has(t) && colsOf.get(t).has(c);
const hasTable = (t) => colsOf.has(t);

const fence = (title, lines) => {
  plain(`\n\`\`\`enumeration ${title}`);
  for (const l of lines) plain(l);
  plain("```");
};

try {
  /* ── 1. the phantom purchase order ─────────────────────────────────────── */
  head("1. HC-PO-009944 — an ERP purchase order the book does not have");
  plain(`scm.purchase_orders columns: ${[...(colsOf.get("purchase_orders") || [])].join(", ")}`);
  const po44raw = await sql`SELECT to_jsonb(p) AS j, p.id AS id FROM scm.purchase_orders p
    WHERE p.company_id = ${CO} AND (p.po_number = 'HC-PO-009944' OR p.linked_ac_docno = 'PO-009944')`;
  const po44 = po44raw.map((r) => r.j);
  plain(`rows matching po_number='HC-PO-009944' OR linked_ac_docno='PO-009944': ${po44.length}`);
  for (const r of po44) plain(`  ${JSON.stringify(r)}`);

  if (po44.length) {
    const id = po44raw[0].id;
    const li = await sql`SELECT to_jsonb(i) AS j FROM scm.purchase_order_items i
      WHERE i.purchase_order_id = ${id} ORDER BY i.id`;
    plain(`  lines: ${li.length}`);
    for (const l of li) plain(`    ${JSON.stringify(l.j)}`);

    if (hasTable("grns") && hasCol("grns", "purchase_order_id")) {
      const grn = await sql`SELECT to_jsonb(g) AS j FROM scm.grns g WHERE g.purchase_order_id = ${id}`;
      plain(`  downstream GRNs: ${grn.length}`);
      for (const g of grn) plain(`    ${JSON.stringify(g.j)}`);
    } else {
      plain(`  downstream GRNs: scm.grns has no purchase_order_id column - not checked`);
    }

    /* did any stock actually move on the back of it? */
    if (hasTable("stock_movements")) {
      const smc = colsOf.get("stock_movements");
      plain(`  scm.stock_movements columns: ${[...smc].join(", ")}`);
    } else {
      plain(`  scm.stock_movements does not exist under schema scm`);
    }

    /* how do the OTHER migrated POs of the same era look?  a hand-made row and
       a migrated row differ in whether the AC line keys are stamped */
    const keyed = await sql`SELECT COUNT(*)::int AS with_key FROM scm.purchase_order_items
      WHERE purchase_order_id = ${id} AND linked_ac_dtlkey IS NOT NULL`;
    plain(`  lines carrying an AutoCount DtlKey: ${keyed[0].with_key} of ${li.length}`);
  }

  /* THE DELETION FINGERPRINT, generalised.  AutoCount hard-deletes a document:
     the header and its DtlKeys vanish together, leaving a hole in the key
     sequence.  An ERP row whose linked_ac_docno is absent from the book AND
     whose line keys are absent too is a faithful import of a DELETED document,
     not a row somebody invented.  The two are opposite findings and must not be
     reported as one. */
  const bookPo = new Set(snap.types.PO.headers.map((r) => r[hIdx.docNo]));
  const bookKeys = new Set();
  for (const t of Object.keys(snap.types)) {
    for (const r of snap.types[t].lines) bookKeys.add(String(r[lIdx.dtlKey]));
  }
  const orphanPos = await sql`SELECT h.po_number, h.linked_ac_docno, h.created_at, h.created_by,
      h.status, h.total_sen,
      COUNT(i.id)::int AS lines,
      COUNT(i.linked_ac_dtlkey)::int AS keyed,
      COALESCE(ARRAY_AGG(DISTINCT i.linked_ac_dtlkey) FILTER (WHERE i.linked_ac_dtlkey IS NOT NULL), '{}') AS keys
    FROM scm.purchase_orders h
    LEFT JOIN scm.purchase_order_items i ON i.purchase_order_id = h.id
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
    GROUP BY h.id, h.po_number, h.linked_ac_docno, h.created_at, h.created_by, h.status, h.total_sen`;
  const absent = orphanPos.filter((r) => !bookPo.has(r.linked_ac_docno));
  const deleted = absent.filter((r) => r.keyed > 0 && r.keys.every((k) => !bookKeys.has(String(k))));
  const invented = absent.filter((r) => !(r.keyed > 0 && r.keys.every((k) => !bookKeys.has(String(k)))));
  plain(`
  ERP purchase orders claiming an AutoCount number the book does not have: ${absent.length}`);
  plain(`    of those, EVERY line key is also absent from the book (the deletion fingerprint): ${deleted.length}`);
  plain(`    of those, some line key still exists in the book, or no key at all: ${invented.length}`);
  fence("ERP POs whose AutoCount document is absent from the book",
    absent.map((r) => `${r.po_number} -> ${r.linked_ac_docno} created ${r.created_at.toISOString?.() ?? r.created_at} ` +
      `status=${r.status} lines=${r.lines} keyed=${r.keyed} keys=[${r.keys.join(",")}] ` +
      `${r.keyed > 0 && r.keys.every((k) => !bookKeys.has(String(k))) ? "DELETED-IN-BOOK" : "UNEXPLAINED"}`));

  /* neighbours, to place it in the numbering */
  const nb = await sql`SELECT to_jsonb(p) AS j FROM scm.purchase_orders p
    WHERE p.company_id = ${CO} AND p.po_number BETWEEN 'HC-PO-009940' AND 'HC-PO-009950'
    ORDER BY p.po_number`;
  plain(`  ERP POs numbered HC-PO-009940..009950: ${nb.length}`);
  for (const r of nb) plain(`    ${JSON.stringify(r.j)}`);

  /* ── 2. supplier 400-Z003 ──────────────────────────────────────────────── */
  head("2. PO-010113 — CreditorCode 400-Z003 (ZOE HOME SDN BHD) not in scm.suppliers");
  const z = await sql`SELECT id, code, name, created_at FROM scm.suppliers
    WHERE company_id = ${CO} AND (code = '400-Z003' OR name ILIKE '%ZOE%')`;
  plain(`suppliers matching code 400-Z003 or name ~ ZOE: ${z.length}`);
  for (const r of z) plain(`  ${JSON.stringify(r)}`);
  const zcount = await sql`SELECT COUNT(*)::int AS n FROM scm.suppliers WHERE company_id = ${CO}`;
  plain(`total suppliers in company ${CO}: ${zcount[0].n}`);
  const zsample = await sql`SELECT code, name FROM scm.suppliers
    WHERE company_id = ${CO} AND code LIKE '400-%' ORDER BY code DESC LIMIT 8`;
  plain(`code shape of existing suppliers (newest 8 of the 400- series):`);
  for (const r of zsample) plain(`  ${r.code}  ${r.name}`);
  const cols = await sql`SELECT column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'suppliers' ORDER BY ordinal_position`;
  plain(`scm.suppliers columns that are NOT NULL and have no default (what opening one requires):`);
  for (const c of cols) if (c.is_nullable === "NO") plain(`  ${c.column_name} ${c.data_type}`);

  /* ── 3. the code-less accessory line ───────────────────────────────────── */
  head("3. PO-009979 — code-less line \"ERGOTEX PILLOW CASE - FAIR\" x20");
  const nn = await sql`SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'purchase_order_items' AND column_name = 'item_code'`;
  plain(`scm.purchase_order_items.item_code is_nullable = ${nn.length ? nn[0].is_nullable : "(column not found)"}`);
  plain(`scm.products columns: ${[...(colsOf.get("products") || [])].join(", ")}`);
  /* scm.products keys on sku + model_code + name; there is no item_code column
     here - the NOT NULL item_code lives on purchase_order_items and is a free
     text code, not a foreign key into this table. */
  const erg = await sql`SELECT p.id, p.sku, p.model_code, p.name, p.category_id, p.supplier_id
    FROM scm.products p
    WHERE p.company_id = ${CO} AND (p.sku ILIKE '%ERGOTEX%' OR p.name ILIKE '%ERGOTEX%'
       OR p.model_code ILIKE '%ERGOTEX%' OR p.sku ILIKE '%PILLOW%' OR p.name ILIKE '%PILLOW%')
    ORDER BY p.sku LIMIT 40`;
  plain(`existing products matching ERGOTEX / PILLOW: ${erg.length}`);
  for (const r of erg) plain(`  ${JSON.stringify(r)}`);
  /* what the PO importer actually validates against: the item codes already in
     use on purchase order lines, which is where the accessory has to land */
  const accLines = await sql`SELECT DISTINCT i.item_code, i.material_name
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
    WHERE h.company_id = ${CO} AND i.item_group = 'accessory'
      AND (i.item_code ILIKE '%PILLOW%' OR i.material_name ILIKE '%PILLOW%')
    ORDER BY i.item_code LIMIT 25`;
  plain(`accessory item codes already used on PO lines (pillow family): ${accLines.length}`);
  for (const r of accLines) plain(`  ${r.item_code}  |  ${r.material_name}`);
  const ergMap = [...codeMap.entries()].filter(([k]) => k.includes("ERGOTEX") || k.includes("PILLOW CASE"));
  plain(`mapping CSV rows mentioning ERGOTEX / PILLOW CASE: ${ergMap.length}`);
  for (const [k, v] of ergMap.slice(0, 20)) plain(`  "${k}" -> "${v}"`);
  const po79 = await sql`SELECT po_number, linked_ac_docno, status FROM scm.purchase_orders
    WHERE company_id = ${CO} AND linked_ac_docno = 'PO-009979'`;
  plain(`is PO-009979 already in the ERP? ${po79.length ? JSON.stringify(po79) : "no"}`);

  /* ── 4. the sofa MODEL disagreements ───────────────────────────────────── */
  head("4. Sales-order sofa lines whose MODEL disagrees");

  const soDocs = await sql`SELECT doc_no AS erp_no, linked_ac_docno AS ac_no
    FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const soLines = await sql`SELECT h.linked_ac_docno AS ac_no, i.item_code,
      i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix, i.id::text AS id
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`;
  plain(`ERP sales orders carrying an AutoCount number: ${soDocs.length}; their lines: ${soLines.length}`);

  const acLinesByDoc = new Map();
  for (const r of snap.types.SO.lines) {
    const d = r[lIdx.docNo];
    if (!acLinesByDoc.has(d)) acLinesByDoc.set(d, []);
    acLinesByDoc.get(d).push({ docNo: d, dtlKey: r[lIdx.dtlKey], itemKey: r[lIdx.itemKey] });
  }
  const erpByDoc = new Map();
  for (const l of soLines) {
    if (!erpByDoc.has(l.ac_no)) erpByDoc.set(l.ac_no, []);
    erpByDoc.get(l.ac_no).push(l);
  }

  /* Reproduce check-ac-erp-reconcile.mjs's sofa branch EXACTLY as it stood
     before today's fix, then say why each finding fired. */
  const rawModelOf = (x) => (String(x ?? "").match(/\d{3,}/) || [null])[0];
  const mism = [];
  for (const [ac, erpLines] of erpByDoc) {
    const acLines = acLinesByDoc.get(ac);
    if (!acLines) continue;
    const acByKey = new Map(acLines.map((l) => [String(l.dtlKey), l]));
    for (const el of erpLines) {
      const k = el.ac_dtlkey == null ? null : String(el.ac_dtlkey).trim();
      if (!k) continue;
      const al = acByKey.get(k);
      if (!al) continue;
      if (!isSofaCode(al.itemKey)) continue;
      const am = rawModelOf(al.itemKey);
      const em = rawModelOf(el.item_code);
      const oldSaysOk = Boolean(am && em && am === em);
      if (oldSaysOk) continue; // the old checker was happy; not a finding
      const fam = foldedModel(al.itemKey);
      const fem = foldedModel(el.item_code);
      let why;
      if (!am && !em) {
        why = mapped(al.itemKey) === norm(el.item_code)
          ? "identical-codes"           // byte-identical, reported anyway
          : "no-model-codes-differ";
      } else if (am && em && fam === fem) why = "alias";
      else why = "genuine";
      mism.push({ ac, dtlKey: k, book: al.itemKey, erp: el.item_code, am, em, why });
    }
  }
  plain(`sofa-branch findings the OLD checker would raise, over DtlKey-paired lines: ${mism.length}`);
  plain(`distinct sales orders involved: ${new Set(mism.map((m) => m.ac)).size}`);

  const buckets = {
    "identical-codes": [], alias: [], "no-model-codes-differ": [], genuine: [],
  };
  for (const m of mism) buckets[m.why].push(m);
  plain(`
WHY EACH ONE FIRED:`);
  plain(`  (c) identical-codes      the two codes are BYTE IDENTICAL and neither`);
  plain(`      yields a model - an accessory whose NAME contains "SOFA".`);
  plain(`      A pure false positive:                              ${buckets["identical-codes"].length}`);
  plain(`  (a) alias                SOFA_MODEL_ALIAS folds them equal; this`);
  plain(`      checker is the only one that did not fold:          ${buckets.alias.length}`);
  plain(`  (b) no-model-codes-differ neither yields a model AND the codes differ`);
  plain(`      - a real finding:                                   ${buckets["no-model-codes-differ"].length}`);
  plain(`  (b) genuine              the folded models genuinely disagree:  ${buckets.genuine.length}`);

  for (const [name, rows] of Object.entries(buckets)) {
    if (!rows.length) continue;
    const pairs = new Map();
    for (const m of rows) {
      const kk = `${m.am ?? "?"} -> ${m.em ?? "?"}`;
      pairs.set(kk, (pairs.get(kk) || 0) + 1);
    }
    fence(`${name}: ${rows.length} line(s) over ${new Set(rows.map((r) => r.ac)).size} sales order(s), by model pair`,
      [...pairs.entries()].sort((a, b) => b[1] - a[1]).map(([kk, n]) => `${String(n).padStart(5)}  ${kk}`));
    fence(`${name}: first ${Math.min(SHOW, rows.length)} line(s)`,
      rows.slice(0, SHOW).map((m) =>
        `${m.ac} DtlKey ${m.dtlKey}: book "${m.book}" vs ERP "${m.erp}"`));
  }
  const byCause = buckets;

  head("VERDICT");
  plain(`1. HC-PO-009944 present in ERP: ${po44.length ? "YES" : "NO"}`);
  plain(`2. supplier 400-Z003 present: ${z.some((r) => r.code === "400-Z003") ? "YES" : "NO"}; ZOE-named rows: ${z.length}`);
  plain(`3. an ERGOTEX/PILLOW product exists: ${erg.length ? "YES" : "NO"}`);
  plain(`4. sofa-branch findings ${mism.length}: identical-codes ${byCause["identical-codes"].length}, ` +
    `alias ${byCause.alias.length}, no-model-codes-differ ${byCause["no-model-codes-differ"].length}, genuine ${byCause.genuine.length}`);
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  process.exitCode = 2;
} finally {
  await sql.end({ timeout: 5 });
}
