#!/usr/bin/env node
// READ-ONLY audit: compare the 2990 documents imported into Houzs (company code
// '2990', doc numbers prefixed '2990-') against the live SOURCE system
// (standalone 2990s ERP, read via Supabase REST service_role — the same
// credentials the Phase-2 importer used). Never writes to either database.
//
// For each doc type (PO / SO / GRN / DO / SI / PI) every source doc number is
// matched to the target doc number with the '2990-' prefix stripped, then the
// header fields and the line-item multiset are fingerprinted and classified:
//   MATCHED-IDENTICAL         same doc number, same fingerprint
//   MATCHED-BUT-DIFFERS       same doc number, different header/lines (diff shown)
//   SOURCE-ONLY               in the source system but not imported
//   TARGET-ONLY-PREFIXED      '2990-' doc in Houzs with no source counterpart
//   TARGET-NATIVE             company-2990 doc in Houzs WITHOUT the prefix
//                             (created natively in Houzs post-cutover; expected)
//
// Ends with a focused dump of the prime suspects: PO-2606-023 / PO-2606-024 and
// GRN-2606-001, printed field-by-field from BOTH systems.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SOURCE_SUPABASE_URL;
const SUPA_KEY = process.env.SOURCE_SERVICE_ROLE_KEY;
const DST = process.env.DATABASE_URL;
if (!SUPA_URL || !SUPA_KEY || !DST) {
  console.error("need SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY + DATABASE_URL");
  process.exit(2);
}
const src = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const PREFIX = "2990-";
const strip = (v) => (v != null && String(v).startsWith(PREFIX) ? String(v).slice(PREFIX.length) : v);
const day = (v) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const rm = (c) => (c == null ? "null" : "RM" + (Number(c) / 100).toFixed(2));

async function fetchAllSrc(table) {
  const out = [];
  const P = 1000;
  for (let f = 0; ; f += P) {
    const { data, error } = await src.schema("public").from(table).select("*").range(f, f + P - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < P) break;
  }
  return out;
}

// Doc-type config. headerKey = the doc-number column. join: how items attach
// (by header uuid `id`, or by doc-number string for SO items). headerFp /
// lineFp produce the comparable fingerprint fields (dates normalised to
// YYYY-MM-DD, money kept in centi ints).
const TYPES = [
  {
    name: "PO", header: "purchase_orders", headerKey: "po_number",
    items: "purchase_order_items", itemRef: "purchase_order_id", joinBy: "id",
    headerFp: (h, ctx) => ({
      date: day(h.po_date), status: h.status,
      supplier: ctx.supplierName(h.supplier_id),
      subtotal_sen: h.subtotal_sen, total_sen: h.total_sen,
    }),
    lineFp: (l) => `${l.item_code}|qty=${l.qty}|unit=${l.unit_price_sen}|disc=${l.discount_sen ?? 0}|total=${l.line_total_sen}`,
  },
  {
    name: "SO", header: "mfg_sales_orders", headerKey: "doc_no",
    items: "mfg_sales_order_items", itemRef: "doc_no", joinBy: "doc_no",
    headerFp: (h) => ({
      date: day(h.so_date), status: h.status, debtor: h.debtor_name,
      local_total_sen: h.local_total_sen, balance_sen: h.balance_sen,
    }),
    lineFp: (l) => `${l.item_code}|qty=${l.qty}|unit=${l.unit_price_sen}|disc=${l.discount_sen ?? 0}|total=${l.total_sen}${l.cancelled ? "|CANCELLED" : ""}`,
  },
  {
    name: "GRN", header: "grns", headerKey: "grn_number",
    items: "grn_items", itemRef: "grn_id", joinBy: "id",
    headerFp: (h, ctx) => ({
      date: day(h.received_at), status: h.status,
      supplier: ctx.supplierName(h.supplier_id),
      po: ctx.poNumberById(h.purchase_order_id),
      total_sen: h.total_sen,
    }),
    lineFp: (l) => `${l.item_code}|recv=${l.qty_received}|acc=${l.qty_accepted}|rej=${l.qty_rejected ?? 0}|unit=${l.unit_price_sen}|total=${l.line_total_sen ?? 0}`,
  },
  {
    name: "DO", header: "delivery_orders", headerKey: "do_number",
    items: "delivery_order_items", itemRef: "delivery_order_id", joinBy: "id",
    headerFp: (h) => ({
      date: day(h.do_date), status: h.status, debtor: h.debtor_name,
      so: strip(h.so_doc_no),
    }),
    lineFp: (l) => `${l.item_code}|qty=${l.qty}|unit=${l.unit_price_sen ?? 0}`,
  },
  {
    name: "SI", header: "sales_invoices", headerKey: "invoice_number",
    items: "sales_invoice_items", itemRef: "sales_invoice_id", joinBy: "id",
    headerFp: (h) => ({
      date: day(h.invoice_date), status: h.status, debtor: h.debtor_name,
      total_sen: h.total_sen, so: strip(h.so_doc_no),
    }),
    lineFp: (l) => `${l.item_code}|qty=${l.qty}|unit=${l.unit_price_sen ?? 0}|total=${l.line_total_sen ?? 0}`,
  },
  {
    name: "PI", header: "purchase_invoices", headerKey: "invoice_number",
    items: "purchase_invoice_items", itemRef: "purchase_invoice_id", joinBy: "id",
    headerFp: (h, ctx) => ({
      date: day(h.invoice_date), status: h.status,
      supplier: ctx.supplierName(h.supplier_id),
      total_sen: h.total_sen,
    }),
    lineFp: (l) => `${l.item_code}|qty=${l.qty}|unit=${l.unit_price_sen}|total=${l.line_total_sen}`,
  },
];

// Groups item lineFps by the RAW header doc-no (no prefix stripping — a
// native 'SO-XXX' must never merge with an imported '2990-SO-XXX').
function groupItems(type, items, headerById) {
  const map = new Map();
  for (const l of items) {
    let docNo;
    if (type.joinBy === "doc_no") docNo = l[type.itemRef];
    else {
      const h = headerById.get(l[type.itemRef]);
      if (!h) continue; // orphan line — reported separately
      docNo = h[type.headerKey];
    }
    if (docNo == null) continue;
    if (!map.has(docNo)) map.set(docNo, []);
    map.get(docNo).push(type.lineFp(l));
  }
  for (const v of map.values()) v.sort();
  return map;
}

function diffHeader(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[k] == null ? null : String(a[k]);
    const bv = b[k] == null ? null : String(b[k]);
    if (av !== bv) out.push(`${k}: src=${av} dst=${bv}`);
  }
  return out;
}

function diffLines(a = [], b = []) {
  const count = (arr) => {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ca = count(a), cb = count(b);
  const onlyA = [], onlyB = [];
  for (const [k, n] of ca) { const d = n - (cb.get(k) ?? 0); if (d > 0) onlyA.push(`${d}x ${k}`); }
  for (const [k, n] of cb) { const d = n - (ca.get(k) ?? 0); if (d > 0) onlyB.push(`${d}x ${k}`); }
  return { onlyA, onlyB };
}

async function main() {
  const cidRow = await dst`SELECT id FROM companies WHERE code = '2990'`;
  if (!cidRow.length) throw new Error("no company with code 2990 in target");
  const cid = Number(cidRow[0].id);
  console.log(`SNAPSHOT ${new Date().toISOString()} target company_id=${cid} (READ-ONLY)`);
  console.log("Last prod import: 2026-07-23T13:31Z (migrate-2990 run 30011439146). Source docs created after that are expected SOURCE-ONLY.");

  // Supplier name maps (ids were copied verbatim by the importer, but resolve
  // each side against its own master so a re-pointed FK shows up as a diff).
  const srcSuppliers = await fetchAllSrc("suppliers");
  const dstSuppliers = await dst`SELECT id, name FROM scm.suppliers WHERE company_id = ${cid}`;
  const srcSupName = new Map(srcSuppliers.map((s) => [s.id, s.name]));
  const dstSupName = new Map(dstSuppliers.map((s) => [s.id, s.name]));

  const special = {
    PO: ["PO-2606-023", "PO-2606-024"],
    GRN: ["GRN-2606-001"],
  };
  const specialDump = [];

  for (const type of TYPES) {
    let srcHeaders, srcItems;
    try {
      srcHeaders = await fetchAllSrc(type.header);
      srcItems = await fetchAllSrc(type.items);
    } catch (e) {
      console.log(`\n[${type.name}] SKIP source read failed: ${e.message}`);
      continue;
    }
    let dstHeaders, dstItems;
    try {
      dstHeaders = await dst`SELECT * FROM scm.${dst(type.header)} WHERE company_id = ${cid}`;
      // Scope items via the company-2990 header join; item tables do not all
      // carry their own company_id.
      dstItems = type.joinBy === "doc_no"
        ? await dst`SELECT i.* FROM scm.${dst(type.items)} i JOIN scm.${dst(type.header)} h ON h.${dst(type.headerKey)} = i.${dst(type.itemRef)} AND h.company_id = ${cid}`
        : await dst`SELECT i.* FROM scm.${dst(type.items)} i JOIN scm.${dst(type.header)} h ON h.id = i.${dst(type.itemRef)} AND h.company_id = ${cid}`;
    } catch (e) {
      console.log(`\n[${type.name}] SKIP target read failed: ${e.message}`);
      continue;
    }

    // PO-number lookup for GRN header fingerprint (per side).
    const srcPoById = new Map(), dstPoById = new Map();
    if (type.name === "GRN") {
      for (const p of await fetchAllSrc("purchase_orders")) srcPoById.set(p.id, p.po_number);
      for (const p of await dst`SELECT id, po_number FROM scm.purchase_orders WHERE company_id = ${cid}`) dstPoById.set(p.id, strip(p.po_number));
    }
    const srcCtx = { supplierName: (id) => srcSupName.get(id) ?? id, poNumberById: (id) => srcPoById.get(id) ?? id };
    const dstCtx = { supplierName: (id) => dstSupName.get(id) ?? id, poNumberById: (id) => dstPoById.get(id) ?? id };

    const srcByDoc = new Map(srcHeaders.map((h) => [h[type.headerKey], h]));
    const dstPrefixed = new Map(), dstNative = new Map();
    for (const h of dstHeaders) {
      const raw = h[type.headerKey];
      if (raw != null && String(raw).startsWith(PREFIX)) dstPrefixed.set(strip(raw), h);
      else dstNative.set(raw, h);
    }
    const srcHeaderById = new Map(srcHeaders.map((h) => [h.id, h]));
    const dstHeaderById = new Map(dstHeaders.map((h) => [h.id, h]));
    const srcLines = groupItems(type, srcItems, srcHeaderById);
    const dstLines = groupItems(type, dstItems, dstHeaderById);

    const identical = [], differs = [], sourceOnly = [], targetOnly = [];
    for (const [docNo, sh] of [...srcByDoc.entries()].sort()) {
      const th = dstPrefixed.get(docNo);
      if (!th) { sourceOnly.push({ docNo, created: day(sh.created_at) }); continue; }
      const hd = diffHeader(type.headerFp(sh, srcCtx), type.headerFp(th, dstCtx));
      const ld = diffLines(srcLines.get(docNo), dstLines.get(th[type.headerKey]));
      const idNote = type.joinBy === "doc_no" ? [] : (sh.id === th.id ? [] : [`row-id: src=${sh.id} dst=${th.id}`]);
      if (!hd.length && !ld.onlyA.length && !ld.onlyB.length) identical.push(docNo);
      else differs.push({ docNo, hd, ld, idNote });
    }
    for (const [docNo, th] of [...dstPrefixed.entries()].sort()) {
      if (!srcByDoc.has(docNo)) targetOnly.push({ docNo, created: day(th.created_at) });
    }
    const native = [...dstNative.keys()].sort();

    console.log(`\n[${type.name}] source=${srcByDoc.size} target-prefixed=${dstPrefixed.size} target-native=${native.length}`);
    console.log(`  MATCHED-IDENTICAL: ${identical.length}`);
    console.log(`  MATCHED-BUT-DIFFERS: ${differs.length}`);
    for (const d of differs) {
      console.log(`    ${d.docNo}`);
      for (const x of d.hd) console.log(`      header ${x}`);
      for (const x of d.ld.onlyA) console.log(`      line only-in-SOURCE ${x}`);
      for (const x of d.ld.onlyB) console.log(`      line only-in-TARGET ${x}`);
      for (const x of d.idNote) console.log(`      ${x}`);
    }
    console.log(`  SOURCE-ONLY: ${sourceOnly.length}${sourceOnly.length ? " " + sourceOnly.map((x) => `${x.docNo}(created ${x.created})`).join(", ") : ""}`);
    console.log(`  TARGET-ONLY-PREFIXED: ${targetOnly.length}${targetOnly.length ? " " + targetOnly.map((x) => `${x.docNo}(created ${x.created})`).join(", ") : ""}`);
    console.log(`  TARGET-NATIVE (post-cutover, no prefix): ${native.length}${native.length ? " " + native.join(", ") : ""}`);

    // Collect prime-suspect dumps.
    for (const want of special[type.name] ?? []) {
      for (const [side, h, ctx, lines] of [
        ["SOURCE", srcByDoc.get(want), srcCtx, srcLines.get(want)],
        ["TARGET", dstPrefixed.get(want), dstCtx, dstLines.get(PREFIX + want)],
      ]) {
        specialDump.push(h
          ? `${type.name} ${want} [${side}] id=${h.id} created=${h.created_at} fp=${JSON.stringify(type.headerFp(h, ctx))}\n` +
            (lines ?? []).map((l) => `    line ${l}`).join("\n")
          : `${type.name} ${want} [${side}] ABSENT`);
      }
    }
  }

  console.log("\n=== PRIME SUSPECTS (field-by-field, both systems) ===");
  for (const s of specialDump) console.log(s);

  // Raw money view of the suspect POs on both sides for the verdict.
  const suspects = await dst`SELECT po_number, status, po_date, subtotal_sen, total_sen, created_at, created_by FROM scm.purchase_orders WHERE company_id = ${cid} AND (po_number LIKE '%PO-2606-023' OR po_number LIKE '%PO-2606-024') ORDER BY po_number`;
  for (const p of suspects) console.log(`TARGET-RAW ${p.po_number} status=${p.status} date=${day(p.po_date)} subtotal=${rm(p.subtotal_sen)} total=${rm(p.total_sen)} created_at=${p.created_at} created_by=${p.created_by}`);
  const { data: sp } = await src.schema("public").from("purchase_orders").select("po_number,status,po_date,subtotal_sen,total_sen,created_at,created_by").in("po_number", ["PO-2606-023", "PO-2606-024"]);
  for (const p of sp ?? []) console.log(`SOURCE-RAW ${p.po_number} status=${p.status} date=${day(p.po_date)} subtotal=${rm(p.subtotal_sen)} total=${rm(p.total_sen)} created_at=${p.created_at} created_by=${p.created_by}`);
  console.log("DONE");
}

main()
  .then(() => dst.end({ timeout: 5 }))
  .catch(async (e) => {
    console.error("COMPARE_FAIL", e.message);
    await dst.end({ timeout: 5 });
    process.exit(1);
  });
