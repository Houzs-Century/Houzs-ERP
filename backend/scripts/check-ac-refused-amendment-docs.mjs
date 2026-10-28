#!/usr/bin/env node
// check-ac-refused-amendment-docs — WHY the 0888 requeue refused 11 documents.
//
// WHY IT EXISTS. After #3833 fixed the amendment enqueue, the requeue plan
// (run 34823021667) composed 34 documents and REFUSED 11 of them:
//   KeylessLineError  HC-PO-2609-087, -027, -032, -064
//   ItemCodeError     HC-PO-2609-009, -086, -010, -079, -074 (supplier 400-H004)
//                     (+ HC-PO-2609-068, same refusal, approved 2026-09-14 after the fix)
//   SofaCollapseError HC-SO-013320, HC-PO-010008 (sofa 8069)
// A refusal names the symptom. This prints the rows that settle the cause:
//
//   1. each document's header (status, linked_ac_docno, supplier code/name);
//   2. each LINE with its AutoCount key, item code, supplier code, Desc2, SO link,
//      created_at / updated_at — a line re-created by an amendment shows a
//      created_at AFTER the approval;
//   3. every outbox row for the document (any op, any status): its last_error
//      (where the drain records why no line identity was stored — docs/bugs/0813),
//      and the ItemCode / Desc2 / DtlKey of every detail it sent, plus the
//      lineWriteback it would zip keys onto;
//   4. every po_revisions / so_revisions snapshot's line keys — revision 1 is the
//      document BEFORE its first amendment, so a key present there and absent now
//      was LOST by the amendment, and a key absent there was never stored;
//   5. the amendments and their line changes;
//   6. the suppliers whose code or name says HOOKKA / OHANA / 400-H004 / 400-O002
//      / 400-N002, and the bindings for the refused item codes;
//   7. the POPULATION: company documents in the book whose create/convert row was
//      SENT, and how many of them still hold a keyless line, by op and by the
//      reason the drain recorded.
//
// READ-ONLY. Plain SELECTs on one connection, no transaction, no DDL, no writes.
// Each section is independent; a failing one prints its error and the rest run.
// Exit 0 for every answer; exit 1 only when the database cannot be reached.
//
// RE-RUN: read-only and idempotent; every run re-reads the live rows.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const GO_LIVE = String(process.env.GO_LIVE || "2026-09-07");
const DOCS = String(process.env.DOCS || [
  "HC-PO-2609-087", "HC-PO-2609-027", "HC-PO-2609-032", "HC-PO-2609-064",
  "HC-PO-2609-009", "HC-PO-2609-086", "HC-PO-2609-010", "HC-PO-2609-079", "HC-PO-2609-074", "HC-PO-2609-068",
  "HC-SO-013320", "HC-PO-010008",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const CODES = String(process.env.CODES || "JAGER-(K),JAGER-(Q),CODY-(Q),CODY-(K),CELENE (A)-(Q)")
  .split(",").map((s) => s.trim()).filter(Boolean);

const out = (m = "") => console.log(m);
const iso = (v) => (v instanceof Date ? v.toISOString() : v == null ? "-" : String(v));
const pick = (row, keys) => keys.filter((k) => row && row[k] !== undefined)
  .map((k) => `${k}=${typeof row[k] === "object" && row[k] !== null ? JSON.stringify(row[k]) : row[k]}`).join("  ");

async function section(title, fn) {
  out("");
  out(`==== ${title} ====`);
  try { await fn(); } catch (e) { out(`!! section failed: ${e?.message ?? e}`); }
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
try {
  await sql`SELECT 1`;
} catch (e) {
  console.error(`::error::cannot reach the database: ${e?.message ?? e}`);
  process.exit(1);
}

const LINE_KEYS = ["id", "line_no", "item_code", "supplier_sku", "item_group", "description2", "qty", "unit_price_sen", "linked_ac_dtlkey",
  "so_item_id", "cancelled", "created_at", "updated_at", ...(process.env.SHOW_VARIANTS === "0" ? [] : ["variants"])];

/* Detail summary of an outbox payload: every object carrying an ItemCode or a
   DtlKey anywhere under body, in document order. */
function detailsOf(payload) {
  const found = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === "object") {
      if ("ItemCode" in v || "DtlKey" in v) {
        found.push(pick(v, ["ItemCode", "DtlKey", "Desc2", "Qty", "IsNewLine", "Retire", "ErpLineIds"]) + `  @${path}`);
        return;
      }
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(payload?.body, "body");
  return found;
}

try {
  out(`company=${CO} go_live=${GO_LIVE} docs=${DOCS.join(",")}`);

  const poDocs = DOCS.filter((d) => d.includes("-PO-"));
  const soDocs = DOCS.filter((d) => d.includes("-SO-"));
  const pos = await sql`
    SELECT to_jsonb(p) AS r, s.code AS supplier_code, s.name AS supplier_name
      FROM scm.purchase_orders p LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
     WHERE p.company_id = ${CO} AND p.po_number = ANY(${poDocs}::text[])`;
  const sos = await sql`
    SELECT to_jsonb(h) AS r FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${CO} AND h.doc_no = ANY(${soDocs}::text[])`;

  for (const doc of DOCS) {
    const isPo = doc.includes("-PO-");
    const hdr = isPo ? pos.find((x) => x.r.po_number === doc) : sos.find((x) => x.r.doc_no === doc);
    await section(`${doc}`, async () => {
      if (!hdr) { out("(no header row in this company)"); return; }
      const h = hdr.r;
      out(`HEADER  ${pick(h, ["id", "status", "revision", "linked_ac_docno", "created_at", "updated_at", "po_date", "so_doc_no", "source_so_doc_no"])}` +
        (isPo ? `  supplier=${hdr.supplier_code} ${hdr.supplier_name}` : ""));

      const lines = isPo
        ? await sql`SELECT to_jsonb(i) AS r FROM scm.purchase_order_items i WHERE i.purchase_order_id = ${h.id}::uuid ORDER BY i.line_no NULLS LAST, i.created_at, i.id`
        : await sql`SELECT to_jsonb(i) AS r FROM scm.mfg_sales_order_items i WHERE i.doc_no = ${doc} ORDER BY i.line_no NULLS LAST, i.created_at, i.id`;
      out(`LINES (${lines.length})`);
      for (const l of lines) out(`   ${pick(l.r, LINE_KEYS)}`);

      /* The SO lines a PO line was converted from, so the key the SO holds can be
         compared with the key the PO holds. */
      if (isPo) {
        const soIds = lines.map((l) => l.r.so_item_id).filter(Boolean);
        if (soIds.length) {
          const src = await sql`SELECT to_jsonb(i) AS r FROM scm.mfg_sales_order_items i WHERE i.id::text = ANY(${soIds}::text[])`;
          out(`SOURCE SO LINES (${src.length})`);
          for (const l of src) out(`   doc_no=${l.r.doc_no}  ${pick(l.r, LINE_KEYS)}`);
        }
      }

      const ob = await sql`
        SELECT id, op, status, created_at, updated_at, sent_at, attempts, ac_doc_no, last_error, archived_at,
               host_built_at, payload
          FROM scm.autocount_outbox
         WHERE company_id = ${CO} AND doc_type = ${isPo ? "PO" : "SO"}
           AND (doc_no = ${doc} OR (${isPo} AND doc_id = ${String(h.id)}))
         ORDER BY created_at`;
      out(`OUTBOX (${ob.length})`);
      for (const o of ob) {
        out(`   ${iso(o.created_at)}  ${o.op}/${o.status}  sent_at=${iso(o.sent_at)}  attempts=${o.attempts}  ac=${o.ac_doc_no ?? "-"}  archived=${iso(o.archived_at)}  host=${iso(o.host_built_at)}  id=${o.id}`);
        out(`      last_error: ${o.last_error ?? "-"}`);
        const lw = o.payload?.lineWriteback;
        if (lw) out(`      lineWriteback: table=${lw.table} ids=${JSON.stringify(lw.ids)} codes=${JSON.stringify(lw.codes)} desc2=${lw.desc2 === undefined ? "ABSENT" : JSON.stringify(lw.desc2)}`);
        if (o.payload?.fromDoc) out(`      fromDoc: ${JSON.stringify(o.payload.fromDoc)}`);
        for (const d of detailsOf(o.payload)) out(`      detail: ${d}`);
      }

      const revs = isPo
        ? await sql`SELECT revision, amendment_id, created_at, snapshot->'lines' AS lines FROM scm.po_revisions WHERE po_id = ${h.id}::uuid ORDER BY revision`
        : await sql`SELECT revision, amendment_id, created_at, snapshot->'lines' AS lines FROM scm.so_revisions WHERE so_doc_no = ${doc} ORDER BY revision`;
      out(`REVISIONS (${revs.length})`);
      for (const rv of revs) {
        out(`   rev=${rv.revision}  amendment=${rv.amendment_id ?? "-"}  at=${iso(rv.created_at)}`);
        for (const l of rv.lines ?? []) out(`      ${pick(l, ["id", "item_code", "supplier_sku", "linked_ac_dtlkey", "so_item_id", "description2", "created_at"])}`);
      }

      const amds = isPo
        ? await sql`SELECT to_jsonb(a) AS r FROM scm.po_amendments a WHERE a.po_id = ${h.id}::uuid ORDER BY a.created_at`
        : await sql`SELECT to_jsonb(a) AS r FROM scm.so_amendments a WHERE a.so_doc_no = ${doc} AND a.company_id = ${CO} ORDER BY a.created_at`;
      out(`AMENDMENTS (${amds.length})`);
      for (const a of amds) {
        out(`   ${pick(a.r, ["id", "amendment_no", "status", "lane", "source_so_amendment_id", "created_at", "approved_at", "so_approved_at"])}`);
        const al = isPo
          ? await sql`SELECT to_jsonb(x) AS r FROM scm.po_amendment_lines x WHERE x.amendment_id = ${a.r.id}::uuid`
          : await sql`SELECT to_jsonb(x) AS r FROM scm.so_amendment_lines x WHERE x.amendment_id = ${a.r.id}::uuid`;
        for (const x of al) out(`      ${pick(x.r, ["change_type", "purchase_order_item_id", "so_item_id", "new_item_code", "new_material_code", "new_qty"])}`);
      }
    });
  }

  await section("6a. SUPPLIERS — Hookka / Ohana and the codes in the refusals", async () => {
    const rows = await sql`
      SELECT id, code, name, to_jsonb(s) - 'id' - 'code' - 'name' AS rest FROM scm.suppliers s
       WHERE code IN ('400-H004', '400-O002', '400-N002')
          OR name ILIKE '%hookka%' OR name ILIKE '%ohana%'
       ORDER BY code`;
    for (const r of rows) out(`${r.code}  ${r.name}  id=${r.id}  company=${r.rest?.company_id ?? "-"}  active=${r.rest?.is_active ?? r.rest?.active ?? "-"}`);
    if (!rows.length) out("(none)");
  });

  await section("6b. BINDINGS for the refused item codes", async () => {
    const rows = await sql`
      SELECT b.item_code, s.code AS supplier_code, s.name AS supplier_name, b.supplier_sku, b.ac_item_code,
             b.is_main_supplier, b.company_id
        FROM scm.supplier_material_bindings b LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
       WHERE upper(b.item_code) = ANY(${CODES.map((c) => c.toUpperCase())}::text[])
       ORDER BY b.item_code, b.is_main_supplier DESC, s.code`;
    for (const r of rows) out(`${r.item_code}  ${r.supplier_code} ${r.supplier_name}  supplier_sku=${r.supplier_sku ?? "-"}  ac_item_code=${r.ac_item_code ?? "-"}  main=${r.is_main_supplier}  company=${r.company_id ?? "-"}`);
    if (!rows.length) out("(none)");
  });

  await section(`7a. POPULATION — ${CO} POs whose create/convert row was SENT since ${GO_LIVE}, keyless lines by op and recorded reason`, async () => {
    const rows = await sql`
      WITH c AS (
        SELECT DISTINCT ON (o.doc_id) o.doc_id, o.op, o.last_error
          FROM scm.autocount_outbox o
         WHERE o.company_id = ${CO} AND o.doc_type = 'PO' AND o.op IN ('create_po', 'so_to_po')
           AND o.status = 'sent' AND o.created_at >= ${GO_LIVE}::date
         ORDER BY o.doc_id, o.created_at DESC
      ), k AS (
        SELECT c.op, left(coalesce(c.last_error, '(none recorded)'), 70) AS reason,
               p.po_number,
               count(i.*) AS lines,
               count(i.*) FILTER (WHERE i.linked_ac_dtlkey IS NULL) AS keyless
          FROM c JOIN scm.purchase_orders p ON p.id::text = c.doc_id
          LEFT JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
         GROUP BY 1, 2, 3
      )
      SELECT op, reason, count(*)::int AS docs,
             count(*) FILTER (WHERE keyless > 0)::int AS docs_with_keyless,
             count(*) FILTER (WHERE keyless = lines AND lines > 0)::int AS docs_all_keyless
        FROM k GROUP BY 1, 2 ORDER BY 1, 3 DESC`;
    for (const r of rows) out(`${r.op}  docs=${r.docs}  with_keyless=${r.docs_with_keyless}  all_keyless=${r.docs_all_keyless}  reason: ${r.reason}`);
    if (!rows.length) out("(none)");
  });

  await section(`7b. POPULATION — ${CO} SOs whose create_so row was SENT since ${GO_LIVE}, keyless lines by recorded reason`, async () => {
    const rows = await sql`
      WITH c AS (
        SELECT DISTINCT ON (o.doc_no) o.doc_no, o.last_error
          FROM scm.autocount_outbox o
         WHERE o.company_id = ${CO} AND o.doc_type = 'SO' AND o.op = 'create_so'
           AND o.status = 'sent' AND o.created_at >= ${GO_LIVE}::date
         ORDER BY o.doc_no, o.created_at DESC
      ), k AS (
        SELECT left(coalesce(c.last_error, '(none recorded)'), 70) AS reason, c.doc_no,
               count(i.*) AS lines,
               count(i.*) FILTER (WHERE i.linked_ac_dtlkey IS NULL) AS keyless
          FROM c LEFT JOIN scm.mfg_sales_order_items i ON i.doc_no = c.doc_no
         GROUP BY 1, 2
      )
      SELECT reason, count(*)::int AS docs,
             count(*) FILTER (WHERE keyless > 0)::int AS docs_with_keyless,
             count(*) FILTER (WHERE keyless = lines AND lines > 0)::int AS docs_all_keyless
        FROM k GROUP BY 1 ORDER BY 2 DESC`;
    for (const r of rows) out(`create_so  docs=${r.docs}  with_keyless=${r.docs_with_keyless}  all_keyless=${r.docs_all_keyless}  reason: ${r.reason}`);
    if (!rows.length) out("(none)");
  });

  /* 7d. THE PAIRING of every SENT so_to_po payload since go-live: composeSoToPo
     zips shape.dtlKeys (readPoTransferFacts, no ORDER BY) with the composed
     details (created_at, id order) BY INDEX, and the host applies each Detail's
     Qty / UnitPrice / Location / DeliveryDate to the line transferred from THAT
     Detail's DtlKey. A Detail is MIS-PAIRED when its DtlKey is not the key of
     the SO line behind lineWriteback.ids[i] — the ERP row the Qty and price came
     from. `differs` = the mis-pairing changed a quantity or a price. */
  await section(`7d. so_to_po payloads since ${GO_LIVE}: Details[i].DtlKey vs the SO line behind lineWriteback.ids[i]`, async () => {
    const rows = await sql`
      SELECT o.doc_no, o.created_at, o.status, o.payload
        FROM scm.autocount_outbox o
       WHERE o.company_id = ${CO} AND o.doc_type = 'PO' AND o.op = 'so_to_po'
         AND o.status = 'sent' AND o.created_at >= ${GO_LIVE}::date
       ORDER BY o.created_at`;
    const ids = [...new Set(rows.flatMap((r) => (r.payload?.lineWriteback?.ids ?? []).flat().map(String)))];
    const po = ids.length ? await sql`
      SELECT i.id::text AS id, i.item_code, i.qty, i.unit_price_sen, s.linked_ac_dtlkey AS so_key, s.item_code AS so_code
        FROM scm.purchase_order_items i LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
       WHERE i.id::text = ANY(${ids}::text[])` : [];
    const byId = new Map(po.map((r) => [r.id, r]));
    let docs = 0, multi = 0, misDocs = 0, misLines = 0, differsLines = 0;
    for (const r of rows) {
      const lw = r.payload?.lineWriteback; const det = r.payload?.body?.Details;
      if (!lw || !Array.isArray(det)) continue;
      docs += 1;
      if (det.length > 1) multi += 1;
      const bad = [];
      det.forEach((d, i) => {
        const rowId = String((lw.ids?.[i] ?? [])[0] ?? "");
        const erp = byId.get(rowId);
        if (!erp) { bad.push(`#${i + 1} ERP row ${rowId || "?"} not found`); return; }
        if (String(erp.so_key) === String(d.DtlKey)) return;
        const owner = [...byId.values()].find((x) => String(x.so_key) === String(d.DtlKey) && (lw.ids ?? []).flat().map(String).includes(x.id));
        const differs = owner && (Number(owner.qty) !== Number(d.Qty));
        if (differs) differsLines += 1;
        bad.push(`#${i + 1} DtlKey ${d.DtlKey} is ${owner ? owner.item_code : "?"} (qty ${owner?.qty ?? "?"}) but carries Qty ${d.Qty} UnitPrice ${d.UnitPrice} of ${erp.item_code} (qty ${erp.qty})${differs ? "  QTY DIFFERS" : ""}`);
      });
      if (bad.length) {
        misDocs += 1; misLines += bad.length;
        out(`${r.doc_no}  sent@${iso(r.created_at)}  ${bad.length}/${det.length} mis-paired`);
        for (const b of bad) out(`   ${b}`);
      }
    }
    out(`SUMMARY: ${docs} sent so_to_po payloads, ${multi} with 2+ lines; ${misDocs} documents / ${misLines} lines MIS-PAIRED; ${differsLines} line(s) where the carried quantity differs from the transferred line's own`);
  });

  /* 8. THE UNVERIFIED CLAIM IN docs/bugs/0888: neither approve route passes the
     lines it ADDED (newLineIds) or the keys of the lines it REMOVED (retire) to
     enqueueEdit. Reading the routes settles THAT; this settles how often an
     approved amendment has actually carried an ADD or a REMOVE since go-live. */
  await section(`8. Approved amendments since ${GO_LIVE} that ADD or REMOVE a line`, async () => {
    const so = await sql`
      SELECT a.amendment_no, a.so_doc_no AS doc, a.so_approved_at AS at, upper(l.change_type) AS change, count(*)::int AS n
        FROM scm.so_amendments a JOIN scm.so_amendment_lines l ON l.amendment_id = a.id
       WHERE a.company_id = ${CO} AND a.so_approved_at >= ${GO_LIVE}::date AND upper(l.change_type) IN ('ADD', 'REMOVE')
       GROUP BY 1, 2, 3, 4 ORDER BY 3`;
    const po = await sql`
      SELECT a.amendment_no, a.po_number AS doc, a.approved_at AS at, (a.source_so_amendment_id IS NOT NULL) AS follow_up,
             upper(l.change_type) AS change, count(*)::int AS n
        FROM scm.po_amendments a JOIN scm.po_amendment_lines l ON l.amendment_id = a.id
       WHERE a.company_id = ${CO} AND a.status = 'APPROVED' AND a.approved_at >= ${GO_LIVE}::date AND upper(l.change_type) IN ('ADD', 'REMOVE')
       GROUP BY 1, 2, 3, 4, 5 ORDER BY 3`;
    out(`SO amendment line changes: ${so.length} (ADD ${so.filter((r) => r.change === "ADD").length}, REMOVE ${so.filter((r) => r.change === "REMOVE").length})`);
    for (const r of so) out(`   ${iso(r.at)}  ${r.amendment_no}  ${r.change} x${r.n}`);
    out(`PO amendment line changes: ${po.length} (ADD ${po.filter((r) => r.change === "ADD").length}, REMOVE ${po.filter((r) => r.change === "REMOVE").length})`);
    for (const r of po) out(`   ${iso(r.at)}  ${r.amendment_no}  ${r.follow_up ? "follow-up" : "manual"}  ${r.change} x${r.n}`);
  });

  await section("7c. The keyless POs from 7a, listed (up to 60)", async () => {
    const rows = await sql`
      WITH c AS (
        SELECT DISTINCT ON (o.doc_id) o.doc_id, o.op, o.created_at, o.last_error
          FROM scm.autocount_outbox o
         WHERE o.company_id = ${CO} AND o.doc_type = 'PO' AND o.op IN ('create_po', 'so_to_po')
           AND o.status = 'sent' AND o.created_at >= ${GO_LIVE}::date
         ORDER BY o.doc_id, o.created_at DESC
      )
      SELECT p.po_number, c.op, c.created_at, p.status,
             count(i.*)::int AS lines, count(i.*) FILTER (WHERE i.linked_ac_dtlkey IS NULL)::int AS keyless,
             left(coalesce(c.last_error, '(none recorded)'), 140) AS reason
        FROM c JOIN scm.purchase_orders p ON p.id::text = c.doc_id
        JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
       GROUP BY 1, 2, 3, 4, 7
      HAVING count(i.*) FILTER (WHERE i.linked_ac_dtlkey IS NULL) > 0
       ORDER BY c.created_at LIMIT 60`;
    for (const r of rows) out(`${r.po_number}  ${r.op}@${iso(r.created_at)}  status=${r.status}  keyless=${r.keyless}/${r.lines}  reason: ${r.reason}`);
    if (!rows.length) out("(none)");
  });
} finally {
  await sql.end({ timeout: 5 });
}
