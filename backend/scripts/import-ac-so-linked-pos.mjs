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
// It also stores PODTL.DtlKey now. The value was computed at three sites and
// written nowhere, so the link back to the AutoCount line existed only inside
// this process; every later repair had to re-derive it from supplier_sku
// prefixes and (qty, Desc2) buckets.
//
// DRY-RUN by default; APPLY=1 writes.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { acDeliveryDate, acDtlKey } from "./lib/ac-po-line.mjs";
import { RECEIVED_INDETERMINATE, buildGrQtyGroups, resolveReceivedQty } from "./lib/po-line-topup-core.mjs";
import { makeSoLineTaker } from "./lib/so-line-dedication.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
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

  /* AutoCount SO DtlKey -> (SO doc, item code, Desc2) so a PO line can find its
     SO line. Desc2 rides along because a sofa PO line sometimes carries a
     thinner spec than the order it was raised from, and the order's own text is
     the first fallback before the photo (owner 2026-08-10: 如果遇到解析不出来的
     部分，你还可以再结合照片去进行解析). */
  const soLineByDtl = new Map();
  for (const r of soRows) soLineByDtl.set(String(r.DtlKey), { doc: r.DocNo, code: r.ItemCode, d2: r.Desc2 });

  /* item_group must match the vocabulary the SO/PO line tables use, because
     bound-mode readiness gates on it. Take it from the catalogue rather than
     re-deriving it from the code, so PO lines and SO lines can never disagree. */
  /* scm.mfg_product_category is an enum with exactly these five members;
     anything else is a value the catalogue cannot hold. */
  const CATG = { SOFA: "sofa", BEDFRAME: "bedframe", ACCESSORY: "accessory",
    MATTRESS: "mattress", SERVICE: "service" };
  const products = await sql`SELECT code, name, category::text AS category FROM scm.mfg_products WHERE company_id = 1`;
  const prodCat = new Map(products.map((r) => [norm(r.code), CATG[String(r.category ?? "").toUpperCase()] ?? "others"]));
  const prodByCode = new Map(products.map((p) => [p.code.toUpperCase(), p]));
  const codeSet = new Set(products.map((p) => p.code.toUpperCase()));

  /* Colour resolver — same folding rules as the SO/outstanding-PO importers, so
     one AutoCount colour string lands on the same fabric_colours row whichever
     document carries it. Ambiguity is not resolved by guessing: no hit means the
     colour rides as a label only. */
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const { findColour } = buildFabricColourIndex(fcRows);
  // #1998 contract: an unlabelled colour is read only when the library CONFIRMS
  // the code. The predicate was built for the backfill and the importers never
  // passed it, so colour-first Desc2 lost even library-known codes.
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  const suppliers = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = 1`;
  const supByCode = new Map(suppliers.map((s) => [norm(s.code), s.id]));
  const whs = await sql`SELECT id, code FROM scm.warehouses WHERE company_id = 1`;
  const whByCode = new Map(whs.map((w) => [norm(w.code), w.id]));
  const whId = (loc) => { const k = norm(loc); return whByCode.get(norm(SALESLOC[k] || k)) ?? whByCode.get(k) ?? null; };

  /* ERP SO lines, addressable by (AutoCount SO doc | erp code), in line order.
     The hand-out rule now lives in lib/so-line-dedication.mjs so the
     outstanding-PO import and the repair claim from the SAME pool — a line is
     claimed once no matter which writer asks. A cancelled line is not offered. */
  const soItems = await sql`SELECT i.id, i.item_code, i.line_no, h.linked_ac_docno ac
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
      AND COALESCE(i.cancelled, false) = false
    ORDER BY i.line_no`;
  const takenSoItem = new Set(
    (await sql`SELECT DISTINCT so_item_id FROM scm.purchase_order_items WHERE so_item_id IS NOT NULL`)
      .map((r) => r.so_item_id),
  );
  const taker = makeSoLineTaker(soItems, takenSoItem);

  const existing = new Set(
    (await sql`SELECT linked_ac_docno FROM scm.purchase_orders WHERE company_id = 1 AND linked_ac_docno IS NOT NULL`)
      .map((r) => r.linked_ac_docno),
  );
  const [{ prefix }] = await sql`SELECT 'HC-PO-' AS prefix`;

  // group by PO, dropping sofa lines (sofa is a later round) and unmapped codes
  const groups = new Map();
  /* Sofa is IN now (owner 2026-08-10: 沙发的 SO 已经进完了). It was held back
     only while the sofa sales orders were still being imported by the parallel
     round — a PO line whose SO line does not exist yet cannot be dedicated, and
     an undedicated sofa PO is exactly the thing that leaves a sofa set stuck on
     PENDING. Their SO lines are in, so their POs come in with everything else. */
  let unmapped = 0;
  for (const r of rows) {
    const erp = byAc.get(norm(r.ItemCode));
    if (!erp) { unmapped++; continue; }
    if (!groups.has(r.DocNo)) groups.set(r.DocNo, []);
    groups.get(r.DocNo).push({ ...r, erp });
  }
  const candidates = [...groups.entries()].filter(([doc]) => !existing.has(doc));
  const alreadyIn = groups.size - candidates.length;

  /* ⚠ GrQty IS AGGREGATED ON (DocNo + ItemCode) - IT IS NOT A PER-LINE FIGURE.
     This line used to read `Math.round(Number(l.GrQty ?? 0))` per PO line, so on
     a document holding two lines of one ItemCode every line was written with the
     DOCUMENT's total. That is how 65 migrated purchase-order lines reached
     production with received_qty > qty - a permanent negative outstanding that
     no report surfaces. (Those 65 existing rows are a SEPARATE repair owned by
     another lane; nothing here rewrites them.) The argument and the evidence are
     in lib/po-line-topup-core.mjs; the rule is shared from there rather than
     re-stated, so this importer and the top-up cannot drift apart.

     A document is refused WHOLE, not line by line: received_qty is NOT NULL
     DEFAULT 0 (migration 0090) so a blank cannot be written, and importing the
     determinate lines only would recreate exactly the defect the top-up exists
     to repair - a document that looks present and is short a line, which the
     document-level idempotency guard below then skips forever. */
  const grQtyGroups = buildGrQtyGroups(rows);
  const blindDocs = [];
  const toCreate = candidates.filter(([doc, lines]) => {
    const blind = lines.filter((l) => resolveReceivedQty(l, grQtyGroups).receivedSource === RECEIVED_INDETERMINATE);
    if (!blind.length) return true;
    blindDocs.push({ doc, blind: blind.length, of: lines.length });
    return false;
  });
  log(`PO docs in file: ${groups.size}; already in ERP: ${alreadyIn}; to create: ${toCreate.length}; unmapped codes: ${unmapped}`);
  if (blindDocs.length) {
    log(`REFUSED - GrQty is aggregated and cannot give a per-line received quantity: ${blindDocs.length} document(s) NOT imported`);
    log("   Re-export with PODTL.TransferedQty (data/autocount-refetch-so-linked-po.sql) and re-run.");
    for (const b of blindDocs.slice(0, 25)) log(`   ${b.doc}: ${b.blind} of ${b.of} line(s) have no per-line received quantity`);
    if (blindDocs.length > 25) log(`   ... and ${blindDocs.length - 25} more`);
  }

  /* Resolve each PO line's SO line. Same-code lines on one SO are handed out in
     order and never reused, so two PO lines for the same SKU on one order bind
     to two DIFFERENT SO lines instead of both claiming the first. */
  const plan = [];
  let noSoLine = 0, noWh = 0, noSupplier = 0, recvUnits = 0, sofaPlaceholderBind = 0;
  const sofaDecode = [];
  for (const [doc, lines] of toCreate) {
    const first = lines[0];
    const supId = supByCode.get(norm(first.CreditorCode)) ?? null;
    if (!supId) {
      /* Same refusal the outstanding-PO import carries. Counting alone let a
         null supplier_id reach the INSERT and the NOT NULL constraint killed
         the whole run mid-loop (PO-009555, creditor 400-R002 — docs/bugs/0557).
         A missing master skips ITS document, loudly, and the rest still land. */
      noSupplier++;
      log(`   SKIP ${doc}: supplier ${first.CreditorCode} (${first.CreditorName || "?"}) has no scm.suppliers row — open it, then re-run`);
      continue;
    }
    const items = [];
    for (const l of lines) {
      const src = soLineByDtl.get(String(l.FromSODtlKey));
      /* Hand out the SO line for one ERP code on one AutoCount order: same-code
         lines are consumed in order and never reused, so two PO lines for the
         same SKU bind to two DIFFERENT SO lines. */
      const takeSoLine = (erpCode) => (src ? taker.take(src.doc, erpCode) : null);
      const wh = whId(l.Location);
      if (!wh) noWh++;
      /* Never Number(l.GrQty): that column is aggregated. Every document
         reaching here was proven determinate by the filter above, so this can
         only be a per-line TransferedQty or an aggregate that is exactly zero -
         and the throw says so rather than writing a plausible wrong number. */
      const rq = resolveReceivedQty(l, grQtyGroups);
      if (rq.receivedSource === RECEIVED_INDETERMINATE) throw new Error(`no per-line received qty for ${doc} ${l.ItemCode}`);
      const recv = Math.round(rq.receivedQty);
      const qty = Math.round(Number(l.Qty ?? 0));
      const priceSen = Math.round(Number(l.UnitPrice ?? 0) * 100);
      const deliveryDate = acDeliveryDate(l);
      const group = prodCat.get(norm(l.erp)) ?? "others";

      /* SOFA — one AutoCount line is one BUILD; the ERP models it as one line
         per compartment, exactly like the sales order it came from (grammar and
         owner rulings: docs/sofa-import-handoff.md, decoder lib/parse-sofa.mjs).
         Owner 2026-08-10: "在 PO 那边带进来的时候，你需要把它解析成 compartment、
         颜色、脚等维度". Price rides the lead piece and the rest are 0, so the PO
         total still equals AutoCount's to the cent. Each piece then dedicates to
         the SO line carrying the SAME compartment code, which is what flips that
         line to READY under bound mode. */
      if (group === "sofa") {
        let model = (l.erp || "").replace(/-1S$/i, "");
        model = SOFA_MODEL_ALIAS[model] || model;
        const reclOK = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"]
          .some((sfx) => codeSet.has((model + sfx).toUpperCase()));
        // the PO's own spec first, then the order it was raised from
        let ps = parseSofa(l.Desc2, model, reclOK, { knownColour });
        let usedSoText = false;
        if ((ps.conf === "low" || !ps.pieces.length) && src && src.d2) {
          const alt = parseSofa(src.d2, model, reclOK, { knownColour });
          if (alt.pieces.length && alt.conf !== "low") { ps = alt; usedSoText = true; }
        }
        const codes = ps.pieces.map((cmp) => `${model}-${cmp}`);
        const allExist = codes.length > 0 && codes.every((cd) => codeSet.has(cd.toUpperCase()));
        const colour = isPendingColour(ps.color) ? null : ps.color;
        const fc = colour ? findColour(colour) : null;
        const variants = {
          seatHeight: ps.size || null,
          fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null,
          fabricCode: fc ? fc.colour_id : null, colourLabel: fc ? fc.label : (colour || null),
          fabricLabel: fc ? fc.fabric_id : null, specials: ps.specials,
        };
        sofaDecode.push({ po: doc, code: l.ItemCode, d2: l.Desc2, model, usedSoText,
          pieces: ps.conf !== "low" && allExist ? ps.pieces : null,
          why: allExist ? ps.why : [...ps.why, "piece SKU missing: " + codes.filter((cd) => !codeSet.has(cd.toUpperCase())).join(",")] });

        if (ps.conf !== "low" && allExist) {
          let first = true;
          for (const cmp of ps.pieces) {
            const code = `${model}-${cmp}`;
            let soItemId = takeSoLine(code);
            /* The order may have landed as a placeholder while this PO decodes
               cleanly (or the reverse). Falling back to the placeholder line
               keeps the dedication rather than losing it — the operator swaps
               the SO line's piece later and the link still points at the right
               order line. */
            if (!soItemId) { soItemId = takeSoLine(`${model}-1S`); if (soItemId) sofaPlaceholderBind++; }
            if (!soItemId) noSoLine++;
            recvUnits += recv;
            items.push({
              code, description: l.Description, desc2: l.Desc2, group,
              name: (prodByCode.get(code.toUpperCase()) || {}).name || code,
              supplierSku: `${l.ItemCode} ${cmp}`,
              qty, recv, priceSen: first ? priceSen : 0,
              wh, soItemId, dtlKey: acDtlKey(l), deliveryDate, variants, note: null,
            });
            first = false;
          }
          continue;
        }
        // never guess a build: a real, existing code carries the money, the
        // original text stays on the line, and a human finishes the pieces
        const ph = `${model}-1S`;
        const code = codeSet.has(ph.toUpperCase()) ? ph : l.erp;
        /* The ALIASED placeholder is tried FIRST and unconditionally: the SO
           importer writes `${model}-1S` (alias applied), so when the catalog has
           no row for it this branch would otherwise look up the SO line by the
           raw mapped code only and lose a link the book actually states
           (owner 2026-08-31, HC-SO-013389 / PO-010087). */
        const soItemId = takeSoLine(ph) ?? takeSoLine(code) ?? takeSoLine(l.erp);
        if (!soItemId) noSoLine++;
        recvUnits += recv;
        items.push({
          code, description: l.Description, desc2: l.Desc2, group,
          name: (prodByCode.get(code.toUpperCase()) || {}).name || code,
          supplierSku: l.ItemCode, qty, recv, priceSen, wh, soItemId,
          dtlKey: acDtlKey(l), deliveryDate,
          variants: { seatHeight: ps.size || null, colourLabel: colour || null, specials: ps.specials },
          note: "SOFA UNPARSED — 按图/原文补件: " + (ps.why.join("; ") || "unreadable"),
        });
        continue;
      }

      const soItemId = takeSoLine(byAc.get(norm(src ? src.code : "")));
      if (!soItemId) noSoLine++;
      recvUnits += recv;
      items.push({
        code: l.erp, description: l.Description, desc2: l.Desc2, group,
        name: (prodByCode.get(String(l.erp).toUpperCase()) || {}).name || l.Description || l.erp,
        supplierSku: l.ItemCode, qty, recv, priceSen,
        wh, soItemId, dtlKey: acDtlKey(l), deliveryDate, variants: null, note: null,
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
  if (sofaDecode.length) {
    const ok = sofaDecode.filter((d) => d.pieces);
    log("");
    log(`SOFA decode: ${ok.length} decomposed, ${sofaDecode.length - ok.length} placeholder (never guessed); read from the SO's own text: ${sofaDecode.filter((d) => d.usedSoText).length}; bound to a placeholder SO line: ${sofaPlaceholderBind}`);
    for (const d of sofaDecode) log(`   ${d.po} ${d.code} | ${JSON.stringify(d.d2 || "").slice(0, 60)} -> ${d.pieces ? d.pieces.join(" + ") : "PLACEHOLDER"}${d.why.length ? " (" + d.why.join("; ") + ")" : ""}`);
  }

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write. NOTE: no stock movements are created; the balance snapshot already holds these units."); await sql.end(); return; }

  // next document number, continuing the imported series
  /* Migrated documents KEEP AutoCount's number (owner 2026-08-10: 我们从
     AutoCount 搬进来的东西全部 numbering 都跟着 AutoCount 的). The sales-order
     import and the outstanding-PO import both do this already; minting a fresh
     sequence here meant PO-000596 arrived as HC-PO-009844 and nobody could find
     it by the number printed on the AutoCount document. */
  let made = 0;
  for (const p of plan) {
    const poNo = "HC-" + p.acDoc;
    await sql.begin(async (tx) => {
      const subtotal = p.items.reduce((s2, it) => s2 + it.qty * it.priceSen, 0);
      /* The PO screen's EXPECTED DELIVERY reads the HEADER, and this import only
         ever wrote the per-line date, so every migrated PO showed a blank
         delivery date while AutoCount had one on all 579 lines. Derive it the
         way the app's own SO->PO convert does: the earliest line date. */
      const headerEta = p.items.map((it) => it.deliveryDate).filter(Boolean).sort()[0] ?? null;
      const [hdr] = await tx`INSERT INTO scm.purchase_orders
          (po_number, linked_ac_docno, supplier_id, status, po_date, expected_at, purchase_location_id, currency,
           subtotal_sen, tax_sen, total_sen, revision, company_id, created_by, notes)
        VALUES (${poNo}, ${p.acDoc}, ${p.supId}, ${p.status}, ${p.docDate ?? sql`CURRENT_DATE`}, ${headerEta},
                ${p.items[0]?.wh ?? null}, 'MYR', ${subtotal}, 0, ${subtotal}, 1, 1, ${SYS_USER},
                ${"imported from AutoCount " + p.acDoc + " (already received; stock came in with the balance snapshot)"})
        RETURNING id`;
      for (const it of p.items) {
        await tx`INSERT INTO scm.purchase_order_items
            (purchase_order_id, material_kind, item_code, material_name, supplier_sku,
             description, description2, notes,
             qty, received_qty, unit_price_sen, line_total_sen, item_group, uom,
             custom_specials, variants,
             warehouse_id, so_item_id, company_id, delivery_date, from_mrp, linked_ac_dtlkey)
          VALUES (${hdr.id}, 'mfg_product', ${it.code}, ${it.name ?? it.description}, ${it.supplierSku ?? null},
                  ${it.description}, ${it.desc2},
                  ${it.note ? (it.desc2 ? it.desc2 + " | " + it.note : it.note) : (it.desc2 || null)},
                  ${it.qty}, ${it.recv}, ${it.priceSen}, ${it.qty * it.priceSen}, ${it.group},
                  ${it.group === "bedframe" ? "SET" : "UNIT"},
                  ${it.variants && it.variants.specials && it.variants.specials.length ? sql.json(it.variants.specials) : null},
                  ${it.variants ? sql.json(it.variants) : null},
                  ${it.wh}, ${it.soItemId}, 1, ${it.deliveryDate}, false, ${it.dtlKey ?? null})`;
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
