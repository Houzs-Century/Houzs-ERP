// Read-only: the evidence behind four half-done documents found by
// check-half-done-documents.mjs (run 42808054032): header, lines, every movement,
// the lots they opened and consumed, audit rows, the PO / SO chain, and the
// item's ledger at the warehouse. Quantities, document numbers and dates only:
// this repo's Actions logs are public.
//
//   Actions -> "Run a backend script on production": script check-half-done-evidence.mjs,
//   mode plan, env COMPANY_ID=1;DOC_NOS=HC-GRN-2609-118,HC-GRN-2610-045,HC-DO-2610-319,HC-DO-2610-419
//
// SELECTs only, one READ ONLY transaction, every query names company_id. Exits 0
// for every real answer.
import "./lib/public-log-guard.mjs";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { variantKeyMirror } from "./lib/ledger-repair-core.mjs";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
const CO = Number(process.env.COMPANY_ID ?? "");
const DOCS = String(process.env.DOC_NOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!url || !Number.isInteger(CO) || CO <= 0 || DOCS.length === 0) { console.error("Needs DATABASE_URL, COMPANY_ID, DOC_NOS"); process.exit(1); }

const iso = (t) => (t ? new Date(t).toISOString().replace(".000Z", "Z") : "-");
const cut = (s, n) => (s == null ? "" : String(s).replace(/\s+/g, " ").slice(0, n));
const s8 = (x) => String(x ?? "").slice(0, 8);
const SAFE_KEY = /(status|_at$|date|warehouse_id|so_doc_no|purchase_order_id|migrated|_number$|doc_no$|^id$|type|source|kind|line_no|^qty|_qty$|item_code|item_group|so_item_id|purchase_order_item_id|rack_id|correction|version)/i;
const UNSAFE_KEY = /(name|phone|address|amount|sen$|price|cost|remark|note|email|contact|ic_|signature|photo|url)/i;
const safe = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => SAFE_KEY.test(k) && !UNSAFE_KEY.test(k)));
const safeShipped = (v) => {
  if (v == null) return "";
  const strip = (o) => (Array.isArray(o) ? o.map(strip) : o && typeof o === "object"
    ? Object.fromEntries(Object.entries(o).filter(([k]) => !UNSAFE_KEY.test(k)).map(([k, x]) => [k, strip(x)])) : o);
  return cut(JSON.stringify(strip(v)), 300);
};

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  await pg.begin("read only", async (sql) => {
    const wh = new Map((await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`).map((w) => [w.id, w.code || w.name]));
    const whOf = (id) => wh.get(id) ?? s8(id);
    const ledgerKeys = new Map();
    const tryq = (label, fn) => sql.savepoint(fn).catch((e) => console.log(`  [${label}] query failed: ${e.message}`));

    for (const docNo of DOCS) {
      const isGrn = docNo.includes("-GRN-");
      console.log(`\n################ ${docNo} ################`);
      const [hdr] = isGrn
        ? await sql`SELECT to_jsonb(g) AS j FROM scm.grns g WHERE g.company_id = ${CO} AND g.grn_number = ${docNo}`
        : await sql`SELECT to_jsonb(d) AS j FROM scm.delivery_orders d WHERE d.company_id = ${CO} AND d.do_number = ${docNo}`;
      if (!hdr) { console.log("  NOT FOUND"); continue; }
      const h = hdr.j;
      console.log(`HEADER ${JSON.stringify(safe(h))}`);
      console.log(`  header columns: ${Object.keys(h).join(",")}`);
      const docId = h.id;

      const lines = isGrn
        ? await sql`SELECT to_jsonb(gi) AS j FROM scm.grn_items gi WHERE gi.grn_id = ${docId} ORDER BY gi.created_at, gi.id`
        : await sql`SELECT to_jsonb(i) AS j FROM scm.delivery_order_items i WHERE i.delivery_order_id = ${docId} ORDER BY i.line_no, i.id`;
      console.log(`LINES ${lines.length}; columns: ${lines[0] ? Object.keys(lines[0].j).join(",") : "-"}`);
      for (const { j } of lines) {
        const vk = variantKeyMirror(j.item_group, j.variants);
        console.log(`  line ${s8(j.id)} ${JSON.stringify(safe(j))} vk=${vk} shipped_from=${safeShipped(j.shipped_from)}`);
        ledgerKeys.set(`${h.warehouse_id}|${j.item_code}`, { warehouse_id: h.warehouse_id, item_code: j.item_code });
      }

      const movs = await sql`
        SELECT id, created_at, movement_date, movement_type, warehouse_id, item_code, variant_key, batch_no, qty,
               total_cost_sen, source_doc_type, source_doc_id, source_doc_no, correction_seq, notes, reason_code
          FROM scm.inventory_movements
         WHERE company_id = ${CO} AND (source_doc_id = ${docId} OR source_doc_no = ${docNo} OR notes LIKE ${"%" + docNo + "%"})
         ORDER BY created_at, id`;
      console.log(`MOVEMENTS ${movs.length}`);
      for (const m of movs) {
        console.log(`  ${iso(m.created_at)} d=${m.movement_date ? String(m.movement_date).slice(0, 10) : "-"} ${m.movement_type} qty=${m.qty} ${whOf(m.warehouse_id)} ${m.item_code} vk=${m.variant_key ?? ""} batch=${m.batch_no ?? ""} ${m.source_doc_type}:${m.source_doc_no ?? ""} srcid=${s8(m.source_doc_id)} seq=${m.correction_seq ?? ""} reason=${m.reason_code ?? ""} costed=${Number(m.total_cost_sen ?? 0) > 0 ? "y" : "n"} mov=${s8(m.id)} | ${cut(m.notes, 140)}`);
        ledgerKeys.set(`${m.warehouse_id}|${m.item_code}`, { warehouse_id: m.warehouse_id, item_code: m.item_code });
      }
      const movIds = movs.map((m) => m.id);
      if (movIds.length) {
        const lots = await sql`SELECT id, movement_id, item_code, variant_key, batch_no, qty_received, qty_remaining, source_doc_type, source_doc_no
                                 FROM scm.inventory_lots WHERE company_id = ${CO} AND movement_id = ANY(${movIds}::uuid[])`;
        console.log(`LOTS OPENED BY THESE MOVEMENTS ${lots.length}`);
        for (const l of lots) console.log(`  lot=${s8(l.id)} mov=${s8(l.movement_id)} ${l.item_code} vk=${l.variant_key ?? ""} batch=${l.batch_no ?? ""} recv=${l.qty_received} left=${l.qty_remaining} ${l.source_doc_type}:${l.source_doc_no ?? ""}`);
        const lotIds = lots.map((l) => l.id);
        const cons = await sql`
          SELECT c.lot_id, c.movement_id, c.qty_consumed, c.source_doc_type, c.source_doc_no, c.variant_key,
                 l.source_doc_type AS lot_src, l.source_doc_no AS lot_no, l.batch_no AS lot_batch
            FROM scm.inventory_lot_consumptions c JOIN scm.inventory_lots l ON l.id = c.lot_id
           WHERE l.company_id = ${CO} AND (c.movement_id = ANY(${movIds}::uuid[]) OR c.lot_id = ANY(${lotIds.length ? lotIds : ["00000000-0000-0000-0000-000000000000"]}::uuid[]))`;
        console.log(`CONSUMPTIONS ${cons.length}`);
        for (const c of cons) console.log(`  lot=${s8(c.lot_id)} (${c.lot_src}:${c.lot_no ?? ""} batch=${c.lot_batch ?? ""}) by mov=${s8(c.movement_id)} ${c.source_doc_type}:${c.source_doc_no ?? ""} qty=${c.qty_consumed} vk=${c.variant_key ?? ""}`);
      }

      await tryq("audit", async (sql) => {
      const audit = await sql`
        SELECT created_at, entity_type, action, status_snapshot, source, field_changes
          FROM scm.entity_audit_log
         WHERE company_id = ${CO} AND (entity_id = ${String(docId)} OR entity_doc_no = ${docNo})
         ORDER BY created_at`;
      console.log(`ENTITY AUDIT ${audit.length}`);
      for (const a of audit) {
        const fc = Array.isArray(a.field_changes) ? a.field_changes : [];
        const shown = fc.map((f) => {
          const k = String(f.field ?? f.key ?? "?");
          return SAFE_KEY.test(k) && !UNSAFE_KEY.test(k) ? `${k}:${cut(JSON.stringify(f.from ?? f.old ?? null), 40)}->${cut(JSON.stringify(f.to ?? f.new ?? null), 40)}` : k;
        });
        console.log(`  ${iso(a.created_at)} ${a.entity_type} ${a.action} status=${a.status_snapshot ?? ""} src=${a.source ?? ""} [${shown.join("; ")}]`);
      }
      });

      /* The chain: GRN line -> PO line -> SO line; DO line -> SO line -> PO lines. */
      await tryq("chain", async (sql) => {
      if (isGrn) {
        const chain = await sql`
          SELECT gi.item_code, gi.qty_accepted, po.po_number, po.status::text AS po_status, pi.id AS po_item, pi.qty AS po_qty,
                 pi.received_qty, pi.so_item_id, si.doc_no AS so_doc_no, si.qty AS so_qty, si.cancelled AS so_cancelled
            FROM scm.grn_items gi
            LEFT JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
            LEFT JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${CO}
            LEFT JOIN scm.mfg_sales_order_items si ON si.id = pi.so_item_id AND si.company_id = ${CO}
           WHERE gi.grn_id = ${docId}`;
        console.log("CHAIN GRN line -> PO line -> SO line");
        for (const c of chain) console.log(`  ${c.item_code} acc=${c.qty_accepted} PO ${c.po_number ?? "-"} (${c.po_status ?? "-"}) po_item=${s8(c.po_item)} po_qty=${c.po_qty ?? ""} received=${c.received_qty ?? ""} SO ${c.so_doc_no ?? "-"} so_item=${s8(c.so_item_id)} so_qty=${c.so_qty ?? ""} cancelled=${c.so_cancelled ?? ""}`);
        const other = await sql`
          SELECT g.grn_number, g.status::text AS status, g.created_at, gi.item_code, gi.qty_accepted, pi.so_item_id
            FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
            JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
           WHERE g.company_id = ${CO} AND g.id <> ${docId}
             AND gi.purchase_order_item_id IN (SELECT purchase_order_item_id FROM scm.grn_items WHERE grn_id = ${docId})
           ORDER BY g.created_at`;
        console.log(`  other GRNs on the same PO lines: ${other.length}`);
        for (const o of other) console.log(`    ${o.grn_number} ${o.status} ${iso(o.created_at)} ${o.item_code} acc=${o.qty_accepted}`);
        const dos = await sql`
          SELECT d.do_number, d.status::text AS status, d.created_at, i.item_code, i.qty
            FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
           WHERE d.company_id = ${CO} AND i.so_item_id IN (
             SELECT pi.so_item_id FROM scm.grn_items gi JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
              WHERE gi.grn_id = ${docId} AND pi.so_item_id IS NOT NULL)
           ORDER BY d.created_at`;
        console.log(`  DOs on the SO lines those PO lines serve: ${dos.length}`);
        for (const o of dos) console.log(`    ${o.do_number} ${o.status} ${iso(o.created_at)} ${o.item_code} qty=${o.qty}`);
      } else {
        const chain = await sql`
          SELECT i.item_code, i.qty, si.doc_no AS so_doc_no, si.qty AS so_qty, si.cancelled, si.stock_status,
                 (SELECT string_agg(po.po_number || ' recv=' || COALESCE(pi.received_qty, 0) || ' st=' || po.status::text, '; ')
                    FROM scm.purchase_order_items pi JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id
                   WHERE pi.so_item_id = i.so_item_id AND po.company_id = ${CO}) AS pos,
                 (SELECT string_agg(g.grn_number || ' ' || g.status::text || ' acc=' || gi.qty_accepted, '; ')
                    FROM scm.purchase_order_items pi JOIN scm.grn_items gi ON gi.purchase_order_item_id = pi.id
                    JOIN scm.grns g ON g.id = gi.grn_id
                   WHERE pi.so_item_id = i.so_item_id AND g.company_id = ${CO}) AS grns,
                 (SELECT string_agg(d2.do_number || ' ' || d2.status::text || ' qty=' || i2.qty, '; ')
                    FROM scm.delivery_order_items i2 JOIN scm.delivery_orders d2 ON d2.id = i2.delivery_order_id
                   WHERE i2.so_item_id = i.so_item_id AND d2.company_id = ${CO} AND d2.id <> ${docId}) AS other_dos
            FROM scm.delivery_order_items i
            LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id AND si.company_id = ${CO}
           WHERE i.delivery_order_id = ${docId}
           ORDER BY i.line_no`;
        console.log("CHAIN DO line -> SO line -> PO / GRN / other DOs");
        for (const c of chain) console.log(`  ${c.item_code} qty=${c.qty} SO ${c.so_doc_no ?? "-"} so_qty=${c.so_qty ?? ""} cancelled=${c.cancelled ?? ""} stock=${c.stock_status ?? ""} | PO ${c.pos ?? "-"} | GRN ${c.grns ?? "-"} | other DOs ${c.other_dos ?? "-"}`);
      }
      });
      await tryq("so-audit", async (sql) => {
        if (!isGrn && h.so_doc_no) {
          const soa = await sql`
            SELECT created_at, action, status_snapshot, field_changes, note
              FROM scm.mfg_so_audit_log
             WHERE company_id = ${CO} AND so_doc_no = ${h.so_doc_no}
               AND (note LIKE ${"%" + docNo + "%"} OR field_changes::text LIKE ${"%" + docNo + "%"} OR action ILIKE '%DO%' OR action ILIKE '%deliver%')
             ORDER BY created_at`;
          console.log(`SO AUDIT (${h.so_doc_no}) rows naming this DO or a DO action: ${soa.length}`);
          for (const a of soa) {
            const fc = Array.isArray(a.field_changes) ? a.field_changes.map((f) => String(f.field ?? f.key ?? "?")) : [];
            const docs = String(a.note ?? "").match(/HC-(DO|GRN|SO|PO)-\d{4}-\d+/g) ?? [];
            console.log(`  ${iso(a.created_at)} ${a.action} status=${a.status_snapshot ?? ""} fields=[${fc.join(",")}] docs=${docs.join(",")}`);
          }
        }
      });
    }

    /* The item's ledger at the warehouse: every bucket, movement net vs open lots,
       and every movement since 2026-09-01. */
    for (const { warehouse_id, item_code } of ledgerKeys.values()) {
      console.log(`\n=========== LEDGER ${item_code} @ ${whOf(warehouse_id)} ===========`);
      const b = await sql`
        WITH mv AS (SELECT COALESCE(variant_key, '') vk,
                           SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int net
                      FROM scm.inventory_movements WHERE company_id = ${CO} AND warehouse_id = ${warehouse_id} AND item_code = ${item_code} GROUP BY 1),
             lt AS (SELECT COALESCE(variant_key, '') vk, SUM(qty_remaining)::int open
                      FROM scm.inventory_lots WHERE company_id = ${CO} AND warehouse_id = ${warehouse_id} AND item_code = ${item_code} GROUP BY 1)
        SELECT COALESCE(mv.vk, lt.vk) vk, COALESCE(mv.net, 0) net, COALESCE(lt.open, 0) open FROM mv FULL JOIN lt ON lt.vk = mv.vk ORDER BY 1`;
      for (const r of b) console.log(`  bucket vk=${r.vk} movements=${r.net} lots=${r.open}${r.net === r.open ? "" : " DIFFERS"}`);
      const ms = await sql`
        SELECT m.created_at, m.movement_type, m.qty, m.variant_key, m.batch_no, m.source_doc_type, m.source_doc_no, m.correction_seq, m.id,
               COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = m.id), 0)::int AS consumed,
               (SELECT l.qty_remaining FROM scm.inventory_lots l WHERE l.movement_id = m.id LIMIT 1) AS lot_left
          FROM scm.inventory_movements m
         WHERE m.company_id = ${CO} AND m.warehouse_id = ${warehouse_id} AND m.item_code = ${item_code}
         ORDER BY m.created_at, m.id`;
      console.log(`  movements (all time): ${ms.length}`);
      for (const m of ms) console.log(`  ${iso(m.created_at)} ${m.movement_type} qty=${m.qty} vk=${m.variant_key ?? ""} batch=${m.batch_no ?? ""} ${m.source_doc_type}:${m.source_doc_no ?? ""} seq=${m.correction_seq ?? ""} consumed=${m.consumed} lot_left=${m.lot_left ?? "-"} mov=${s8(m.id)}`);
      await tryq("so-lines", async (sql) => {
      const open = await sql`
        SELECT si.doc_no, h.status::text so_status, si.qty, si.stock_status, si.stock_qty_ready, si.item_group, si.variants, si.cancelled
          FROM scm.mfg_sales_order_items si JOIN scm.mfg_sales_orders h ON h.doc_no = si.doc_no AND h.company_id = ${CO}
         WHERE si.company_id = ${CO} AND si.item_code = ${item_code} AND si.warehouse_id = ${warehouse_id}
           AND h.created_at >= '2026-08-01'
         ORDER BY si.doc_no`;
      console.log(`  SO lines since 2026-08 on this item here: ${open.length}`);
      for (const o of open) console.log(`    ${o.doc_no} ${o.so_status} qty=${o.qty} stock=${o.stock_status ?? ""} ready=${o.stock_qty_ready ?? ""} cancelled=${o.cancelled} vk=${variantKeyMirror(o.item_group, o.variants)}`);
      });
    }
  });
} finally {
  await pg.end({ timeout: 5 });
}
