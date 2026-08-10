#!/usr/bin/env node
// Import the purchase orders that were raised FROM the migrated sales orders —
// including the ones already fully received, which the outstanding-PO import
// deliberately skipped.
//
// Owner 2026-08-10: "有一些 PO 虽然不是 outstanding，但它的 PO 已经转成 GR 了，
// 我们应该也是要录入进去。要不然，我的 stock status 转不到 ready."
//
// He is right, and the readiness check proved it: every one of the 2,626 lines
// on a processed order read PENDING, because bound mode decides readiness from
// the line's OWN purchase order, and the received POs — the only ones that can
// make a line ready — were not in the ERP at all. 241 POs / 369 lines / 483
// units received were missing.
//
// ⚠ THESE DOCUMENTS DO NOT MOVE STOCK. The physical stock is already in the
// ERP from the AutoCount balance snapshot; posting a GRN for these would count
// the same units twice. So this writes the PO header + lines + received_qty +
// the so_item_id dedication ONLY — the paperwork that readiness reads, not an
// inventory event. Nothing here touches inventory_movements or lots.
//
// DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const isSofa = (c) => /SOFA/i.test(c || "");
const SYS_USER = "00000000-0000-4000-8000-000000000001";
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

const SALESLOC = {
  KL: "KL WAREHOUSE", PG: "PG WAREHOUSE", SRW: "SRW WAREHOUSE", SBH: "SBH WAREHOUSE",
  HQ: "HQ", "KL DISP": "KL DISPLAY", "PG DISP": "PG DISPLAY", "SBH DISP": "SBH DISPLAY",
  "EM DISP": "EM DISPLAY", "C&C DISP": "C&C DISPLAY",
  "SERV KL": "KL SERVICE", "SERV PG": "PG SERVICE",
  SUNWAY: "SUNWAY SHOWROOM", "KELANA.J": "KELANA.J SHOWROOM",
};

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const rows = gz("ac-so-linked-pos.json.gz");
  const soRows = gz("ac-outstanding-so.json.gz");
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

  // AutoCount SO DtlKey -> (SO doc, item code) so a PO line can find its SO line
  const soLineByDtl = new Map();
  for (const r of soRows) soLineByDtl.set(String(r.DtlKey), { doc: r.DocNo, code: r.ItemCode });

  /* item_group must match the vocabulary the SO/PO line tables use, because
     bound-mode readiness gates on it. Take it from the catalogue rather than
     re-deriving it from the code, so PO lines and SO lines can never disagree. */
  /* scm.mfg_product_category is an enum with exactly these five members
     (SOFA / BEDFRAME / ACCESSORY / MATTRESS / SERVICE); anything else would be
     a value the catalogue cannot hold. Map them to the line-table vocabulary. */
  const CATG = { SOFA: "sofa", BEDFRAME: "bedframe", ACCESSORY: "accessory",
    MATTRESS: "mattress", SERVICE: "service" };
  const prodCat = new Map(
    (await sql`SELECT code, category::text AS category FROM scm.mfg_products WHERE company_id = 1`)
      .map((r) => [norm(r.code), CATG[String(r.category ?? "").toUpperCase()] ?? "others"]),
  );
  const suppliers = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = 1`;
  const supByCode = new Map(suppliers.map((s) => [norm(s.code), s.id]));
  const whs = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = 1`;
  const whByCode = new Map(whs.map((w) => [norm(w.code), w.id]));
  const whId = (loc) => { const k = norm(loc); return whByCode.get(norm(SALESLOC[k] || k)) ?? whByCode.get(k) ?? null; };

  // ERP SO lines, addressable by (AutoCount SO doc | erp code), in line order
  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, h.linked_ac_docno ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL ORDER BY i.line_no`;
  const soByKey = new Map();
  for (const it of soItems) {
    const k = `${it.ac}|${norm(it.item_code)}`;
    if (!soByKey.has(k)) soByKey.set(k, []);
    soByKey.get(k).push(it);
  }
  const takenSoItem = new Set(
    (await sql`SELECT DISTINCT so_item_id FROM scm.purchase_order_items WHERE so_item_id IS NOT NULL`)
      .map((r) => r.so_item_id),
  );

  const existing = new Set(
    (await sql`SELECT linked_ac_docno FROM scm.purchase_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`)
      .map((r) => r.linked_ac_docno),
  );
  const [{ prefix }] = await sql`SELECT 'HC-PO-' AS prefix`;

  // group by PO, dropping sofa lines (sofa is a later round) and unmapped codes
  const groups = new Map();
  let unmapped = 0, sofaSkipped = 0;
  for (const r of rows) {
    if (isSofa(r.ItemCode)) { sofaSkipped++; continue; }
    const erp = byAc.get(norm(r.ItemCode));
    if (!erp) { unmapped++; continue; }
    if (!groups.has(r.DocNo)) groups.set(r.DocNo, []);
    groups.get(r.DocNo).push({ ...r, erp });
  }
  const toCreate = [...groups.entries()].filter(([doc]) => !existing.has(doc));
  const alreadyIn = groups.size - toCreate.length;
  log(`PO docs in file: ${groups.size}; already in ERP: ${alreadyIn}; to create: ${toCreate.length}; sofa lines skipped: ${sofaSkipped}; unmapped codes: ${unmapped}`);

  /* Resolve each PO line's SO line. Same-code lines on one SO are handed out in
     order and never reused, so two PO lines for the same SKU on one order bind
     to two DIFFERENT SO lines instead of both claiming the first. */
  const handedOut = new Map();
  const plan = [];
  let noSoLine = 0, noWh = 0, noSupplier = 0, recvUnits = 0;
  for (const [doc, lines] of toCreate) {
    const first = lines[0];
    const supId = supByCode.get(norm(first.CreditorCode)) ?? null;
    if (!supId) noSupplier++;
    const items = [];
    for (const l of lines) {
      const src = soLineByDtl.get(String(l.FromSODtlKey));
      let soItemId = null;
      if (src) {
        const erpSoCode = byAc.get(norm(src.code));
        const cands = erpSoCode ? soByKey.get(`${src.doc}|${norm(erpSoCode)}`) : null;
        if (cands) {
          const used = handedOut.get(`${src.doc}|${norm(erpSoCode)}`) ?? 0;
          const pick = cands.find((c, i) => i >= used && !takenSoItem.has(c.id));
          if (pick) {
            soItemId = pick.id;
            handedOut.set(`${src.doc}|${norm(erpSoCode)}`, cands.indexOf(pick) + 1);
            takenSoItem.add(pick.id);
          }
        }
      }
      if (!soItemId) noSoLine++;
      const wh = whId(l.Location);
      if (!wh) noWh++;
      const recv = Math.round(Number(l.GrQty ?? 0));
      recvUnits += recv;
      items.push({
        code: l.erp, description: l.Description, desc2: l.Desc2,
        group: prodCat.get(norm(l.erp)) ?? "others",
        qty: Math.round(Number(l.Qty ?? 0)), recv,
        priceCenti: Math.round(Number(l.UnitPrice ?? 0) * 100),
        wh, soItemId, dtlKey: Number(l.DtlKey),
        deliveryDate: l.DeliveryDate ? l.DeliveryDate.slice(0, 10) : null,
      });
    }
    const anyRecv = items.some((i) => i.recv > 0);
    const allRecv = items.every((i) => i.recv >= i.qty);
    plan.push({
      acDoc: doc, supId, docDate: (first.DocDate || "").slice(0, 10) || null,
      ref: first.Ref || null, items,
      status: allRecv ? "RECEIVED" : anyRecv ? "PARTIALLY_RECEIVED" : "SUBMITTED",
    });
  }
  const lineCount = plan.reduce((s, p) => s + p.items.length, 0);
  const linked = plan.reduce((s, p) => s + p.items.filter((i) => i.soItemId).length, 0);
  log(`to create: ${plan.length} POs / ${lineCount} lines; dedicated to an SO line: ${linked}; received units carried: ${recvUnits}`);
  log(`unresolved -> SO line ${noSoLine}; warehouse ${noWh}; supplier ${noSupplier}`);
  for (const p of plan.slice(0, 10)) log(`   ${p.acDoc} [${p.status}] ${p.items.length} lines, recv ${p.items.reduce((s, i) => s + i.recv, 0)}`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write. NOTE: no stock movements are created; the balance snapshot already holds these units."); await sql.end(); return; }

  // next document number, continuing the imported series
  const [{ maxno }] = await sql`SELECT COALESCE(MAX(po_number), '') maxno FROM scm.purchase_orders
    WHERE company_id = 1 AND po_number LIKE ${prefix + "%"}`;
  let seq = Number(String(maxno).replace(prefix, "")) || 0;
  let made = 0;
  for (const p of plan) {
    seq += 1;
    const poNo = prefix + String(seq).padStart(6, "0");
    await sql.begin(async (tx) => {
      const subtotal = p.items.reduce((s2, it) => s2 + it.qty * it.priceCenti, 0);
      const [hdr] = await tx`INSERT INTO scm.purchase_orders
          (po_number, linked_ac_docno, supplier_id, status, po_date, purchase_location_id, currency,
           subtotal_centi, tax_centi, total_centi, revision, company_id, created_by, notes)
        VALUES (${poNo}, ${p.acDoc}, ${p.supId}, ${p.status}, ${p.docDate ?? sql`CURRENT_DATE`},
                ${p.items[0]?.wh ?? null}, 'MYR', ${subtotal}, 0, ${subtotal}, 1, 1, ${SYS_USER},
                ${"imported from AutoCount " + p.acDoc + " (already received; stock came in with the balance snapshot)"})
        RETURNING id`;
      for (const it of p.items) {
        await tx`INSERT INTO scm.purchase_order_items
            (purchase_order_id, material_kind, material_code, material_name, description, description2,
             qty, received_qty, unit_price_centi, line_total_centi, item_group, uom,
             warehouse_id, so_item_id, company_id, delivery_date, from_mrp)
          VALUES (${hdr.id}, 'mfg_product', ${it.code}, ${it.description}, ${it.description}, ${it.desc2},
                  ${it.qty}, ${it.recv}, ${it.priceCenti}, ${it.qty * it.priceCenti}, ${it.group},
                  ${it.group === "bedframe" ? "SET" : "UNIT"},
                  ${it.wh}, ${it.soItemId}, 1, ${it.deliveryDate}, false)`;
      }
    });
    made++;
    if (made % 50 === 0) log(`  ..${made}/${plan.length}`);
  }
  log(`DONE. POs created: ${made}; lines ${lineCount}; dedications ${linked}`);
  log("no inventory movements written — by design.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
