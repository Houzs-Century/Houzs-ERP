#!/usr/bin/env node
// check-so-colour-amendment-trace — for a few sales orders, print what the ERP
// holds about ONE fabric colour and the amendments raised against them.
//
// WHY IT EXISTS. Three staff reports on the same two orders, 2026-09-10..12:
//   #21 "Amend SO-013497 still can't find color HR805-90. Item code have."
//   #25 "SO-013497 now can choose COLOR but save failed."
//   #15 SO-013503 / PO2609-053 and SO-013497 / PO2609-064 item code converted
//       wrong, needed 1A(LHF)+1NA+L(RHF).
// Fixes shipped for each (docs/bugs/0789, 0814, 0816, 0818, 0836, and the sofa
// correction in #3625). Merged is not the same as fixed on these rows, so this
// reads the rows.
//
// WHAT IT PRINTS, per SO in DOCS (company COMPANY):
//   1. header: status, processing date, and the customer name / address1 as
//      JSON so a trailing space is visible (the 0836 cause);
//   2. every line: item code, description, variants' fabric keys, photo count;
//   3. every purchase-order line linked to those SO lines (so_item_id), plus any
//      PO whose number matches PO_NUMBERS, with its own lines;
//   4. every SO amendment on those SOs (all statuses) with its lines, and every
//      PO amendment on those POs, with status / rejection reason / resolution;
//   5. the entity audit trail on those documents since AUDIT_SINCE;
//   6. COLOUR: its fabric_colours rows, its series row(s) in fabric_library, its
//      fabric_trackings rows, and whether GET /fabric-colours?q=COLOUR would
//      return it today (the route's own per-CODE retired rules, restated below);
//   7. per SO line: the Model its item code resolves to (mfg_products.model_id
//      -> product_models.allowed_options.fabrics), and whether the desktop
//      picker's pool filter and the save gate would let COLOUR through. An
//      EMPTY or absent pool means UNRESTRICTED for our SO picker (SoLineCard
//      FabricColourCombobox, allowed-options-check.ts).
//
// The retired rules in (6) are a RESTATEMENT of retiredByCode in
// backend/src/scm/routes/fabric-colours.ts, not an import (that file pulls in
// hono + the Worker env). If the two ever disagree the route is right; the
// restatement is printed beside the raw rows so a reader can check it by eye.
//
// READ-ONLY. Plain selects over one connection, no transaction, no DDL, no
// data change of any kind. Each section is independent: a section whose query
// fails prints the error and the rest still run. Exit 0 for every answer; exit
// 1 only when the database cannot be reached.
//
// RE-RUN: read-only and idempotent; every run re-reads the live rows.
import postgres from "postgres";
import { assertMatcherSane, disagrees } from "./lib/sofa-piece-token.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const list = (v, d) => String(v || d).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const DOCS = list(process.env.DOCS, "HC-SO-013497,HC-SO-013503");
const PO_NUMBERS = list(process.env.PO_NUMBERS, "2609-053,2609-064");
const COLOUR = String(process.env.COLOUR || "HR805-90").trim();
const AUDIT_SINCE = String(process.env.AUDIT_SINCE || "2026-09-09");

const out = (m = "") => console.log(m);
const j = (v) => JSON.stringify(v);
const pick = (row, keys) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]]));

async function section(title, fn) {
  out("");
  out(`==== ${title} ====`);
  try { await fn(); } catch (e) { out(`!! section failed: ${e?.message ?? e}`); }
}

/* Restatement of fabric-colours.ts retiredByCode: a trimmed code is retired
   only when NO active row trims to it. */
function retiredByCode(rows, codeField, activeField) {
  const seen = new Set();
  const live = new Set();
  for (const r of rows) {
    const code = String(r[codeField] ?? "").trim();
    if (!code) continue;
    seen.add(code);
    if (r[activeField] === true) live.add(code);
  }
  for (const c of live) seen.delete(c);
  return seen;
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });

try {
  await sql`SELECT 1`;
} catch (e) {
  console.error(`::error::cannot reach the database: ${e?.message ?? e}`);
  process.exit(1);
}

out(`company=${CO} docs=${DOCS.join(",")} po_numbers~${PO_NUMBERS.join(",")} colour=${COLOUR}`);

let soItems = [];
let poIds = [];
let poNumbers = [];

try {
  await section("1. SALES ORDER HEADERS", async () => {
    const rows = await sql`
      SELECT to_jsonb(h) AS r FROM scm.mfg_sales_orders h
       WHERE h.company_id = ${CO} AND h.doc_no = ANY(${DOCS}) ORDER BY h.doc_no`;
    for (const want of DOCS) if (!rows.some((x) => x.r.doc_no === want)) out(`!! ${want}: NO SUCH SALES ORDER in company ${CO}`);
    for (const { r } of rows) {
      out(`${r.doc_no}  status=${r.status}  processing_date=${r.processing_date ?? "(none)"}  ` +
        `version=${r.version ?? "?"}  revision=${r.revision ?? "?"}  linked_ac_docno=${r.linked_ac_docno ?? "-"}`);
      out(`   debtor_name=${j(r.debtor_name)}  address1=${j(r.address1)}  address2=${j(r.address2)}  venue_id=${j(r.venue_id)}  updated_at=${r.updated_at}`);
    }
  });

  await section("2. SALES ORDER LINES", async () => {
    const rows = await sql`
      SELECT to_jsonb(i) AS r FROM scm.mfg_sales_order_items i
       WHERE i.doc_no = ANY(${DOCS})
       ORDER BY i.doc_no, COALESCE(i.line_no, 0), i.item_code`;
    soItems = rows.map((x) => x.r);
    for (const r of soItems) {
      const v = r.variants && typeof r.variants === "object" ? r.variants : {};
      out(`${r.doc_no} #${r.line_no ?? "?"} id=${r.id} ${j(r.item_code)} group=${r.item_group} qty=${r.qty}` +
        `${r.cancelled ? " [CANCELLED]" : ""}`);
      out(`   description=${j(r.description)}  description2=${j(r.description2)}`);
      out(`   fabric: fabricCode=${j(v.fabricCode)} colourId=${j(v.colourId)} fabricId=${j(v.fabricId)} fabricLabel=${j(v.fabricLabel)}`);
      out(`   variants=${j(r.variants)}`);
      out(`   photo_urls=${Array.isArray(r.photo_urls) ? r.photo_urls.length : 0} updated_at=${r.updated_at ?? "?"}`);
    }
  });

  await section("3. PURCHASE ORDERS + LINES (linked by so_item_id, or number match)", async () => {
    const ids = soItems.map((r) => String(r.id));
    const pats = PO_NUMBERS.map((p) => `%${p}`);
    const heads = await sql`
      SELECT DISTINCT to_jsonb(p) AS r FROM scm.purchase_orders p
       WHERE p.company_id = ${CO}
         AND (p.po_number ILIKE ANY(${pats})
              OR p.id IN (SELECT pi.purchase_order_id FROM scm.purchase_order_items pi
                           WHERE pi.company_id = ${CO} AND pi.so_item_id::text = ANY(${ids})))`;
    const hs = heads.map((x) => x.r).sort((a, b) => String(a.po_number).localeCompare(String(b.po_number)));
    poIds = hs.map((h) => String(h.id));
    poNumbers = hs.map((h) => String(h.po_number));
    if (!hs.length) out("!! no purchase order found");
    const soById = new Map(soItems.map((r) => [String(r.id), r]));
    for (const h of hs) {
      out(`${h.po_number}  id=${h.id} status=${h.status} revision=${h.revision ?? "?"} supplier_id=${h.supplier_id} updated_at=${h.updated_at}`);
      const lines = await sql`
        SELECT to_jsonb(pi) AS r FROM scm.purchase_order_items pi
         WHERE pi.purchase_order_id = ${h.id}
         ORDER BY COALESCE(pi.line_no, 0), pi.item_code`;
      for (const { r } of lines) {
        const v = r.variants && typeof r.variants === "object" ? r.variants : {};
        const so = r.so_item_id ? soById.get(String(r.so_item_id)) : null;
        out(`   #${r.line_no ?? "?"} ${j(r.item_code)} supplier_sku=${j(r.supplier_sku)} qty=${r.qty} received=${r.received_qty}`);
        out(`      description=${j(r.description)} material_name=${j(r.material_name)}`);
        out(`      fabric: fabricCode=${j(v.fabricCode)} colourId=${j(v.colourId)} fabricId=${j(v.fabricId)}`);
        out(`      so_item_id=${r.so_item_id ?? "(none)"}${so ? ` -> ${so.doc_no} ${j(so.item_code)} colour ${j(so.variants?.fabricCode)}` : ""}` +
          `  photo_urls=${Array.isArray(r.photo_urls) ? r.photo_urls.length : 0}`);
      }
    }
  });

  /* 3b. The supplier code each PO line SHOULD carry, from the same place the
     convert path takes it: the supplier_material_bindings row for (item_code,
     the PO's supplier) — routes/mfg-purchase-orders.ts `b.supplier_sku`.
     docs/bugs/0887. */
  await section("3b. SUPPLIER CODE vs THE BINDING (per PO line)", async () => {
    if (!poIds.length) { out("(no purchase orders)"); return; }
    const lines = await sql`
      SELECT p.po_number, p.supplier_id::text AS supplier_id, pi.line_no, pi.item_code, pi.supplier_sku, pi.item_group
        FROM scm.purchase_order_items pi JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
       WHERE pi.purchase_order_id::text = ANY(${poIds})
       ORDER BY p.po_number, COALESCE(pi.line_no, 0)`;
    for (const l of lines) {
      const b = await sql`
        SELECT supplier_sku, is_main_supplier FROM scm.supplier_material_bindings
         WHERE company_id = ${CO} AND material_kind = 'mfg_product'
           AND item_code = ${l.item_code} AND supplier_id::text = ${l.supplier_id}
         ORDER BY is_main_supplier DESC, id`;
      const want = b[0]?.supplier_sku ?? null;
      const verdict = !b.length ? "NO BINDING for this supplier"
        : String(want ?? "") === String(l.supplier_sku ?? "") ? "MATCHES binding" : "DIFFERS from binding";
      out(`${l.po_number} #${l.line_no ?? "?"} ${j(l.item_code)} line supplier_sku=${j(l.supplier_sku)} ` +
        `binding supplier_sku=${j(want)} (${b.length} row(s)) piece-disagrees=${disagrees(l.item_code, l.supplier_sku)} -> ${verdict}`);
    }
  });

  /* 3c. Has the PO left the ERP since it was revised? Email stamp, AutoCount
     link, and every write-back outbox row for it. (A SEND audit row, if any,
     is in section 5.) A PDF downloaded and sent by hand leaves no trace here. */
  await section("3c. WHAT LEFT THE ERP FOR THESE POs (email / AutoCount)", async () => {
    if (!poIds.length) { out("(no purchase orders)"); return; }
    const heads = await sql`
      SELECT po_number, status, revision, updated_at, po_email_sent_at, po_email_sent_to, linked_ac_docno
        FROM scm.purchase_orders WHERE id::text = ANY(${poIds}) ORDER BY po_number`;
    for (const h of heads) {
      out(`${h.po_number} status=${h.status} revision=${h.revision} updated_at=${j(h.updated_at)} ` +
        `po_email_sent_at=${j(h.po_email_sent_at)} po_email_sent_to=${h.po_email_sent_to ? "(set)" : "null"} linked_ac_docno=${j(h.linked_ac_docno)}`);
    }
    const ob = await sql`
      SELECT op, doc_no, status, attempts, created_at, sent_at, ac_doc_no, left(coalesce(last_error, ''), 160) AS err,
             left(payload::text, 900) AS payload
        FROM scm.autocount_outbox
       WHERE company_id = ${CO} AND doc_type = 'PO' AND (doc_no = ANY(${poNumbers}) OR doc_id = ANY(${poIds}))
       ORDER BY created_at`;
    out(`autocount_outbox rows for these POs: ${ob.length}`);
    for (const r of ob) {
      out(`   ${r.created_at?.toISOString?.() ?? r.created_at} op=${r.op} doc=${r.doc_no} status=${r.status} attempts=${r.attempts} ` +
        `sent_at=${r.sent_at?.toISOString?.() ?? r.sent_at} ac_doc_no=${j(r.ac_doc_no)}${r.err ? ` err=${j(r.err)}` : ""}`);
      out(`      payload=${r.payload}`);
    }
    /* Why an approved amendment may have queued nothing: the switch, and whether
       the queue moved at all for the sales orders or the company since then. */
    const flag = await sql`SELECT key, value, updated_at FROM scm.app_config WHERE key ILIKE '%autocount_writeback%'`;
    for (const f of flag) out(`app_config ${f.key}=${j(f.value)} updated_at=${j(f.updated_at)}`);
    const so = await sql`
      SELECT op, doc_no, status, created_at, left(coalesce(last_error, ''), 200) AS err
        FROM scm.autocount_outbox
       WHERE company_id = ${CO} AND doc_type = 'SO' AND doc_no = ANY(${DOCS})
       ORDER BY created_at`;
    out(`autocount_outbox rows for the sales orders: ${so.length}`);
    for (const r of so) out(`   ${r.created_at?.toISOString?.() ?? r.created_at} op=${r.op} doc=${r.doc_no} status=${r.status}${r.err ? ` err=${j(r.err)}` : ""}`);
    const recent = await sql`
      SELECT doc_type, op, status, count(*)::int AS n, max(created_at) AS last
        FROM scm.autocount_outbox
       WHERE company_id = ${CO} AND created_at >= ${AUDIT_SINCE}::date
       GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    out(`company ${CO} outbox since ${AUDIT_SINCE}, by type/op/status:`);
    for (const r of recent) out(`   ${r.doc_type} ${r.op} ${r.status} n=${r.n} last=${r.last?.toISOString?.() ?? r.last}`);
  });

  await section("4a. SO AMENDMENTS (all statuses)", async () => {
    const rows = await sql`
      SELECT to_jsonb(a) AS r FROM scm.so_amendments a
       WHERE a.so_doc_no = ANY(${DOCS}) ORDER BY a.created_at`;
    if (!rows.length) out("(none)");
    for (const { r } of rows) {
      out(`${r.so_doc_no} ${r.amendment_no} status=${r.status} lane=${r.lane ?? "-"} created_at=${r.created_at} updated_at=${r.updated_at}`);
      out(`   ${j(pick(r, ["reason", "rejection_reason", "rejected_at", "resolution", "so_approved_at", "po_approved_at", "sent_at", "edit_count"]))}`);
      if (r.header_changes) out(`   header_changes=${j(r.header_changes)}`);
      const lines = await sql`SELECT to_jsonb(l) AS r FROM scm.so_amendment_lines l WHERE l.amendment_id = ${r.id}`;
      for (const { r: l } of lines) {
        const so = soItems.find((x) => String(x.id) === String(l.sales_order_item_id));
        out(`   line ${l.change_type} so_item=${l.sales_order_item_id}${so ? ` (${j(so.item_code)})` : ""} new_item_code=${j(l.new_item_code)} new_qty=${l.new_qty ?? "-"}`);
        if (l.new_variants) out(`      new_variants=${j(l.new_variants)}`);
        const old = l.old_snapshot && typeof l.old_snapshot === "object" ? l.old_snapshot : null;
        if (old) out(`      old: item_code=${j(old.item_code ?? old.itemCode)} fabric=${j(old.variants?.fabricCode)}`);
      }
    }
  });

  await section("4b. PO AMENDMENTS on those purchase orders", async () => {
    if (!poNumbers.length) { out("(no purchase orders)"); return; }
    const rows = await sql`
      SELECT to_jsonb(a) AS r FROM scm.po_amendments a
       WHERE a.po_number = ANY(${poNumbers}) ORDER BY a.created_at`;
    if (!rows.length) out("(none)");
    for (const { r } of rows) {
      out(`${r.po_number} ${r.amendment_no ?? r.id} status=${r.status} source_so_amendment_no=${r.source_so_amendment_no ?? "-"} created_at=${r.created_at}`);
      out(`   ${j(pick(r, ["reason", "rejection_reason", "resolution", "approved_at", "sent_at"]))}`);
    }
  });

  await section(`5. ENTITY AUDIT since ${AUDIT_SINCE}`, async () => {
    const keys = [...DOCS, ...poNumbers];
    const rows = await sql`
      SELECT to_jsonb(e) AS r FROM scm.entity_audit_log e
       WHERE e.entity_doc_no = ANY(${keys}) AND e.created_at >= ${AUDIT_SINCE}::date
       ORDER BY e.created_at`;
    if (!rows.length) out("(none)");
    for (const { r } of rows) {
      const rest = { ...r };
      for (const k of ["id", "company_id", "entity_id", "entity_doc_no", "action", "actor_id", "actor_name_snapshot", "created_at"]) delete rest[k];
      const s = j(rest);
      out(`${r.created_at} ${r.entity_doc_no} ${r.action} by ${r.actor_name_snapshot ?? r.actor_id ?? "?"}  ${s.length > 600 ? `${s.slice(0, 600)}...` : s}`);
    }
  });

  let colourRows = [];
  let retiredSeries = new Set();
  let retiredCodes = new Set();
  await section(`6. COLOUR ${COLOUR}`, async () => {
    const fc = await sql`
      SELECT to_jsonb(c) AS r FROM scm.fabric_colours c
       WHERE c.company_id = ${CO} AND (c.colour_id ILIKE ${`%${COLOUR}%`} OR c.label ILIKE ${`%${COLOUR}%`})
       ORDER BY c.sort_order, c.colour_id`;
    colourRows = fc.map((x) => x.r);
    out(`fabric_colours rows matching: ${colourRows.length}`);
    for (const r of colourRows) out(`   ${j(pick(r, ["colour_id", "label", "fabric_id", "active", "sort_order", "company_id"]))}`);

    const lib = await sql`SELECT id, active, label FROM scm.fabric_library WHERE company_id = ${CO}`;
    retiredSeries = retiredByCode(lib, "id", "active");
    const series = [...new Set(colourRows.map((r) => String(r.fabric_id ?? "").trim()))];
    out(`fabric_library rows for its series (${series.join(", ") || "none"}):`);
    for (const r of lib.filter((x) => series.includes(String(x.id).trim()))) out(`   ${j(r)}`);

    const trk = await sql`SELECT id, fabric_code, is_active, fabric_description FROM scm.fabric_trackings WHERE company_id = ${CO}`;
    retiredCodes = retiredByCode(trk, "fabric_code", "is_active");
    out(`fabric_trackings rows with fabric_code like ${COLOUR}:`);
    for (const r of trk.filter((x) => String(x.fabric_code ?? "").toUpperCase().includes(COLOUR.toUpperCase()))) out(`   ${j(r)}`);

    /* GET /fabric-colours?q=COLOUR as the route runs it: active, company, ilike
       on colour_id or label, sort_order, limit 50, THEN the two retired filters. */
    const served = await sql`
      SELECT colour_id, fabric_id, label FROM scm.fabric_colours
       WHERE company_id = ${CO} AND active = true
         AND (colour_id ILIKE ${`%${COLOUR}%`} OR label ILIKE ${`%${COLOUR}%`})
       ORDER BY sort_order LIMIT 50`;
    const kept = served.filter((r) => {
      const s = String(r.fabric_id ?? "").trim();
      const c = String(r.colour_id ?? "").trim();
      return !(s && retiredSeries.has(s)) && !(c && retiredCodes.has(c));
    });
    out(`route simulation q=${COLOUR}: ${served.length} before retired filters, ${kept.length} after: ${kept.map((r) => r.colour_id).join(", ") || "(none)"}`);
    out(`   series retired? ${series.map((s) => `${s}=${retiredSeries.has(s)}`).join(" ") || "-"}   code retired? ${retiredCodes.has(COLOUR)}`);
  });

  await section(`7. PER SO LINE: Model pool vs ${COLOUR}`, async () => {
    const exact = colourRows.find((r) => String(r.colour_id).trim().toUpperCase() === COLOUR.toUpperCase());
    const series = exact ? String(exact.fabric_id ?? "") : "";
    const codes = [...new Set(soItems.map((r) => r.item_code).filter(Boolean))];
    if (!codes.length) { out("(no lines)"); return; }
    const prods = await sql`
      SELECT p.code, p.model_id::text AS model_id, p.category::text AS category, m.model_code,
             m.allowed_options->'fabrics' AS fabrics, (m.allowed_options ? 'fabrics') AS has_key
        FROM scm.mfg_products p
        LEFT JOIN scm.product_models m ON m.id = p.model_id
       WHERE p.company_id = ${CO} AND p.code = ANY(${codes})`;
    const byCode = new Map(prods.map((p) => [p.code, p]));
    for (const it of soItems) {
      const p = byCode.get(it.item_code);
      if (!p) { out(`${it.doc_no} ${j(it.item_code)}: NO mfg_products row in company ${CO} -> by-code answers allowedOptions=null -> UNRESTRICTED`); continue; }
      const pool = Array.isArray(p.fabrics) ? p.fabrics : null;
      const restricted = Array.isArray(pool) && pool.length > 0;
      const passes = !restricted || pool.includes(COLOUR) || (series && pool.includes(series));
      out(`${it.doc_no} ${j(it.item_code)}: model=${p.model_code ?? "(none)"} (${p.model_id ?? "-"}) category=${p.category} ` +
        `fabrics key present=${p.has_key} pool size=${pool ? pool.length : "absent"} -> ${restricted ? "RESTRICTED" : "UNRESTRICTED"}; ` +
        `${COLOUR} (series ${series || "?"}) passes picker+gate pool rule: ${passes}`);
    }
  });

  /* 8. System-wide sweep, OPEN purchase orders only: a sofa line whose supplier
     code names a DIFFERENT piece from its own item code — the shape the
     amendment re-derive left on HC-PO-2609-064 (docs/bugs/0887). The matcher is
     the shared one and self-tests before this reads a row. */
  await section("8. SWEEP: OPEN PO sofa lines whose supplier code names another piece", async () => {
    assertMatcherSane();
    const rows = await sql`
      SELECT p.po_number, p.status, pi.line_no, pi.item_code, pi.supplier_sku, pi.qty, pi.received_qty
        FROM scm.purchase_order_items pi JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
       WHERE pi.company_id = ${CO}
         AND upper(coalesce(pi.item_group, '')) = 'SOFA'
         AND upper(coalesce(p.status::text, '')) NOT IN ('RECEIVED', 'CANCELLED', 'CLOSED')
       ORDER BY p.po_number, COALESCE(pi.line_no, 0)`;
    const bad = rows.filter((r) => disagrees(r.item_code, r.supplier_sku));
    out(`open sofa PO lines examined: ${rows.length}   supplier code names another piece: ${bad.length}`);
    for (const r of bad) {
      out(`   ${r.po_number} (${r.status}) #${r.line_no ?? "?"} ${j(r.item_code)} supplier_sku=${j(r.supplier_sku)} qty=${r.qty} received=${r.received_qty}`);
    }
  });
} finally {
  await sql.end({ timeout: 5 });
}
