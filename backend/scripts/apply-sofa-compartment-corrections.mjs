#!/usr/bin/env node
// Write the owner-approved compartment + seat-size answers onto the live sofa
// documents.
//
// Source of truth: data/sofa-compartment-corrections-2026-08.json — 33 builds,
// each naming the SO and the PO raised from it (corrected together so the pair
// cannot drift), the target piece list left to right, the seat depth, and how
// the answer was reached.
//
// ── WHAT THIS TOUCHES, AND WHAT IT REFUSES TO ───────────────────────────────
// A build is one AutoCount sofa line = several ERP rows, one per compartment.
// Correcting it changes the ROW COUNT, which is why this is a gated script and
// not a UI edit.
//
//   MATCH FIRST, THEN UPDATE IN PLACE. Existing rows are paired to target
//   pieces by code; a pair is UPDATEd, never dropped and re-inserted, so the
//   row id survives — and with it the purchase_order_items.so_item_id
//   dedication that bound-mode readiness reads. repair-leaked-sofa-lines.mjs
//   set that precedent for exactly this reason.
//
//   DELETE ONLY GENUINE SURPLUS, AND ONLY IF NOTHING POINTS AT IT. A surplus SO
//   line with a PO line or a DO line hanging off it, or a surplus PO line with
//   a GRN line hanging off it, is REFUSED and reported — never silently cut.
//
//   THE MONEY DOES NOT MOVE. The importer put the whole build's price on its
//   first piece and 0 on the rest; this preserves that exactly, so the document
//   total is the same to the cent before and after. The script asserts it per
//   build and aborts the build if it would not hold.
//
// DRY-RUN by default; APPLY=1 writes. Every build is its own transaction.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { selectBuildRows } from "./lib/sofa-desc2-match.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const ONLY = (process.env.DOC || "").trim();
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const K = (s) => String(s ?? "").trim().toUpperCase();
const modelOf = (code) => { const c = K(code); const d = c.indexOf("-"); return d < 0 ? c : c.slice(0, d); };
const compOf = (code) => { const c = K(code); const d = c.indexOf("-"); return d < 0 ? "" : c.slice(d + 1); };

const DATA = JSON.parse(fs.readFileSync(path.join(here, "data", "sofa-compartment-corrections-2026-08.json"), "utf8"));

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}${ONLY ? ` DOC=${ONLY}` : ""}`);
  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => K(p.code)));

  let nBuilds = 0, nUpd = 0, nIns = 0, nDel = 0, nRefused = 0, nMissingSku = 0, nPo = 0, nGr = 0, nDo = 0, nAmbiguous = 0;

  for (const c of DATA.corrections) {
    const docs = ONLY ? c.docs.filter((d) => d === ONLY) : c.docs;
    if (!docs.length) continue;

    for (const doc of docs) {
      const isPo = /^HC-PO-/.test(doc);
      /* Another session is renumbering the migrated POs so every number follows
         AutoCount (#1875), which stranded the po_numbers written into this data
         file. Resolve a PO by its number OR by the AutoCount document it links
         to - linked_ac_docno is the fact that survives a renumber. */
      let poId = null;
      if (isPo) {
        const ac = doc.replace(/^HC-/, "");
        let [hit] = await sql`SELECT id, po_number FROM scm.purchase_orders
          WHERE company_id = ${CO} AND (po_number = ${doc} OR linked_ac_docno = ${ac}) LIMIT 1`;
        /* Some of the numbers in this file were invented by the SO-linked PO
           import (HC-PO- plus its own running sequence) and no longer exist:
           the migrated POs have been renumbered so every number follows
           AutoCount. Neither the number nor the AutoCount link can find those.
           The AutoCount TEXT can - it is the same build either way, so fall
           back to the Desc2 this correction already carries. */
        if (!hit && c.desc2Match) {
          const [byText] = await sql`SELECT p.id, p.po_number FROM scm.purchase_orders p
            JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
           WHERE p.company_id = ${CO} AND i.item_group = 'sofa'
             AND i.description2 LIKE ${"%" + c.desc2Match + "%"}
           GROUP BY p.id, p.po_number LIMIT 2`;
          if (byText) { hit = byText; log(`  ${doc}: found as ${byText.po_number} by its AutoCount text`); }
        }
        if (!hit) { log(`  ${doc}: not in the ERP by number, by AutoCount link, or by its text — skipped`); continue; }
        poId = hit.id;
        if (hit.po_number !== doc && !String(hit.po_number).includes(ac)) { /* already reported above */ }
        else if (hit.po_number !== doc) log(`  ${doc}: found as ${hit.po_number} via linked_ac_docno`);
      }
      let rows = isPo
        ? await sql`SELECT i.id, i.item_code AS code, i.qty, i.unit_price_sen, i.line_total_sen AS total,
                           i.variants, i.description2, i.received_qty, i.so_item_id
                      FROM scm.purchase_order_items i
                     WHERE i.purchase_order_id = ${poId} AND i.item_group = 'sofa'
                     ORDER BY i.id`
        : await sql`SELECT i.id, i.item_code AS code, i.qty, i.unit_price_sen, i.total_sen AS total,
                           i.variants, i.description2, i.line_no
                      FROM scm.mfg_sales_order_items i
                      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                     WHERE h.company_id = ${CO} AND i.doc_no = ${doc} AND i.item_group = 'sofa'
                     ORDER BY i.line_no`;
      /* A DOCUMENT can hold more than one sofa build. Narrow to the build this
         correction is about by its AutoCount text, or a second, perfectly good
         build looks like surplus and the script tries to delete it. Caught on
         HC-SO-011957, which holds a 1R+1NA+1R sofa AND a Stool. */
      /* The narrowing itself lives in scripts/lib/sofa-desc2-match.mjs, with
         its own test, because a plain `includes` here silently dropped seven
         owner-approved builds on 2026-09-02 (run 33657082664): the data file
         writes a line break as the two characters backslash-n and prod holds a
         real newline, so identical text did not compare equal. Read that
         module before widening anything further — and note that it REFUSES an
         ambiguous match rather than picking, which is the only reason a looser
         needle is safe on a document that holds two builds. */
      if (c.desc2Match) {
        const pick = selectBuildRows(rows, c.desc2Match);
        if (pick.verdict === "ambiguous") {
          log(`  ${doc}: REFUSED — "${c.desc2Match}" reaches ${pick.texts.length} DIFFERENT builds on this document, and telling them apart is the whole job of desc2Match: ${pick.texts.map((t) => JSON.stringify(t.slice(0, 56))).join("  vs  ")}`);
          nAmbiguous++; continue;
        }
        if (!pick.rows.length) {
          log(`  ${doc}: no line matches "${c.desc2Match}" (${pick.how}) — skipped, the build is not on this document`);
          continue;
        }
        if (pick.verdict === "normalised")
          log(`  ${doc}: ${pick.how} — the corrections file writes the line break as \\n, the document holds a real one`);
        if (pick.rows.length !== rows.length)
          log(`  ${doc}: ${rows.length} sofa lines on the document, ${pick.rows.length} belong to this build`);
        rows.length = 0; rows.push(...pick.rows);
      }
      if (!rows.length) {
        /* Say WHY, so a missing build is diagnosable instead of a shrug: does
           the document exist at all, and what groups are its lines in? */
        const probe = isPo
          ? await sql`SELECT i.item_group g, COUNT(*)::int n FROM scm.purchase_order_items i
                       WHERE i.purchase_order_id = ${poId} GROUP BY 1`
          : await sql`SELECT i.item_group g, COUNT(*)::int n FROM scm.mfg_sales_order_items i
                       WHERE i.company_id = ${CO} AND i.doc_no = ${doc} GROUP BY 1`;
        log(`  ${doc}: no sofa lines — ${probe.length ? probe.map((x) => `${x.g}:${x.n}`).join(", ") : "the document itself is not in the ERP"}`);
        continue;
      }

      const model = K(c.model || modelOf(rows[0].code));
      const want = c.pieces.map((p) => (K(p).startsWith(model + "-") ? K(p) : `${model}-${K(p)}`));
      const missing = want.filter((w) => !codeSet.has(w));
      if (missing.length) {
        log(`  ${doc}: REFUSED — piece SKU not minted: ${missing.join(", ")}`);
        nMissingSku++; continue;
      }

      /* Pair by code so an unchanged piece keeps its row - and its id. */
      const pool = [...rows];
      const pairs = [];
      for (const w of want) {
        const i = pool.findIndex((r) => K(r.code) === w);
        pairs.push({ want: w, row: i >= 0 ? pool.splice(i, 1)[0] : null });
      }
      for (const p of pairs) if (!p.row && pool.length) p.row = pool.shift(); // reuse a surplus row rather than delete+insert
      const surplus = pool;

      const totalBefore = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
      const lead = rows.reduce((a, r) => (Number(r.total ?? 0) > Number(a.total ?? 0) ? r : a), rows[0]);
      const unit = Number(lead.unit_price_sen ?? 0);
      const qty = Number(lead.qty ?? 1) || 1;
      const totalAfter = unit * qty;
      if (totalAfter !== totalBefore) {
        log(`  ${doc}: REFUSED — money would move (${totalBefore} -> ${totalAfter})`);
        nRefused++; continue;
      }

      // nothing may point at a row we are about to delete
      const blockers = [];
      for (const r of surplus) {
        if (isPo) {
          const [{ n }] = await sql`SELECT COUNT(*)::int n FROM scm.grn_items WHERE purchase_order_item_id = ${r.id}`;
          if (n) blockers.push(`${r.code}: ${n} GRN line(s)`);
        } else {
          const [{ n: a }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_order_items WHERE so_item_id = ${r.id}`;
          const [{ n: b }] = await sql`SELECT COUNT(*)::int n FROM scm.delivery_order_items WHERE so_item_id = ${r.id}`;
          if (a + b) blockers.push(`${r.code}: ${a} PO line(s), ${b} DO line(s)`);
        }
      }
      if (blockers.length) {
        log(`  ${doc}: REFUSED — a surplus line is referenced downstream: ${blockers.join("; ")}`);
        nRefused++; continue;
      }

      const plan = [];
      pairs.forEach((p, idx) => {
        const first = idx === 0;
        const v = { ...(p.row?.variants ?? {}) };
        if (c.seat) v.seatHeight = String(c.seat);
        if (c.colour && !v.colourLabel) v.colourLabel = c.colour;
        const price = first ? unit : 0;
        const tot = first ? unit * qty : 0;
        if (p.row) plan.push({ op: "update", id: p.row.id, from: p.row.code, to: p.want, price, tot, v });
        else plan.push({ op: "insert", to: p.want, price, tot, v, from: null });
      });
      for (const r of surplus) plan.push({ op: "delete", id: r.id, from: r.code });

      nBuilds++;
      log(`  ${doc}  ${model}  ${rows.map((r) => compOf(r.code)).join("+")}  ->  ${c.pieces.join("+")}${c.seat ? `  @${c.seat}"` : ""}`);
      for (const p of plan) {
        if (p.op === "update" && K(p.from) === K(p.to)) { log(`      keep   ${compOf(p.to)}${c.seat ? ` (seat ${c.seat})` : ""}`); nUpd++; }
        else if (p.op === "update") { log(`      change ${compOf(p.from)} -> ${compOf(p.to)}`); nUpd++; }
        else if (p.op === "insert") { log(`      add    ${compOf(p.to)}`); nIns++; }
        else { log(`      remove ${compOf(p.from)}`); nDel++; }
      }

      if (!APPLY) continue;
      const touched = [];
      await sql.begin(async (tx) => {
        for (const p of plan) {
          if (p.op === "delete") {
            if (isPo) await tx`DELETE FROM scm.purchase_order_items WHERE id = ${p.id}`;
            else await tx`DELETE FROM scm.mfg_sales_order_items WHERE id = ${p.id}`;
            continue;
          }
          const name = (await tx`SELECT name FROM scm.mfg_products WHERE company_id = ${CO} AND upper(code) = ${p.to} LIMIT 1`)[0]?.name ?? p.to;
          if (p.op === "update") {
            if (isPo) await tx`UPDATE scm.purchase_order_items SET item_code = ${p.to}, material_name = ${name},
                                 unit_price_sen = ${p.price}, line_total_sen = ${p.tot}, variants = ${tx.json(p.v)} WHERE id = ${p.id}`;
            else await tx`UPDATE scm.mfg_sales_order_items SET item_code = ${p.to}, description = ${name},
                            unit_price_sen = ${p.price}, total_sen = ${p.tot}, balance_sen = ${p.tot},
                            variants = ${tx.json(p.v)} WHERE id = ${p.id}`;
            touched.push({ id: p.id, code: p.to, v: p.v });
          } else {
            const src = rows[0];
            if (isPo) await tx`INSERT INTO scm.purchase_order_items
                (purchase_order_id, material_kind, item_code, material_name, item_group, description2,
                 qty, received_qty, unit_price_sen, line_total_sen, variants, warehouse_id, from_mrp, company_id)
                SELECT i.purchase_order_id, 'mfg_product', ${p.to}, ${name}, 'sofa', ${src.description2 ?? null},
                       i.qty, 0, ${p.price}, ${p.tot}, ${tx.json(p.v)}, i.warehouse_id, false, ${CO}
                  FROM scm.purchase_order_items i WHERE i.id = ${src.id}`;
            /* warehouse_id IS NOT OPTIONAL HERE, and its absence is silent.
               Stock allocation buckets by (warehouse, item, variant), so a line
               that lands NULL can never match stock: it stays PENDING forever,
               shows no incoming PO, and reads as "the system did not capture
               it" even when the goods were received into the right bucket. The
               PO branch above already copies `i.warehouse_id`; this branch
               omitted the column entirely, and the 2026-08-11 run produced
               seven such lines across six orders (repaired 2026-08-18). */
            else await tx`INSERT INTO scm.mfg_sales_order_items
                (doc_no, line_no, item_group, item_code, description, description2, uom, location, qty,
                 unit_price_sen, total_sen, balance_sen, company_id, variants, remark, photo_urls,
                 warehouse_id)
                SELECT i.doc_no, (SELECT COALESCE(MAX(line_no),0)+1 FROM scm.mfg_sales_order_items WHERE doc_no = i.doc_no),
                       'sofa', ${p.to}, ${name}, i.description2, i.uom, i.location, i.qty,
                       ${p.price}, ${p.tot}, ${p.tot}, ${CO}, ${tx.json(p.v)},
                       'compartment corrected 2026-08-10', i.photo_urls,
                       i.warehouse_id
                  FROM scm.mfg_sales_order_items i WHERE i.id = ${src.id}`;
          }
        }
      });

      /* Carry it down the chain. A PO line copies the SO line it is dedicated
         to; a GRN line copies the PO line it received; a DO line copies the SO
         line it delivered. All three took a SNAPSHOT of the code and variants
         when they were created (create-migrated-documents.mjs), so correcting
         the parent alone would leave them stating the old build. These
         documents carry migrated_no_stock, so this is paperwork only - no
         movement is written or implied. */
      for (const t of touched) {
        if (isPo) {
          const g = await sql`UPDATE scm.grn_items
            SET item_code = ${t.code}, variants = ${sql.json(t.v)}
            WHERE purchase_order_item_id = ${t.id} RETURNING id`;
          if (g.length) { nGr += g.length; log(`      -> ${g.length} GRN line(s) follow ${compOf(t.code)}`); }
        } else {
          const po = await sql`UPDATE scm.purchase_order_items
            SET item_code = ${t.code}, variants = ${sql.json(t.v)}
            WHERE so_item_id = ${t.id} RETURNING id`;
          if (po.length) {
            nPo += po.length;
            log(`      -> ${po.length} PO line(s) follow ${compOf(t.code)}`);
            for (const r of po) {
              const g = await sql`UPDATE scm.grn_items
                SET item_code = ${t.code}, variants = ${sql.json(t.v)}
                WHERE purchase_order_item_id = ${r.id} RETURNING id`;
              nGr += g.length;
            }
          }
          const d = await sql`UPDATE scm.delivery_order_items
            SET item_code = ${t.code}, variants = ${sql.json(t.v)}
            WHERE so_item_id = ${t.id} RETURNING id`;
          if (d.length) { nDo += d.length; log(`      -> ${d.length} DO line(s) follow ${compOf(t.code)}`); }
        }
      }
    }
  }

  log("");
  log(`builds touched ${nBuilds} · lines updated ${nUpd} · added ${nIns} · removed ${nDel}`);
  log(`downstream carried: PO lines ${nPo} · GRN lines ${nGr} · DO lines ${nDo}`);
  log(`refused ${nRefused} (downstream reference or the money would move) · piece SKU not minted ${nMissingSku} · refused as ambiguous ${nAmbiguous}`);
  for (const h of DATA._held ?? []) log(`HELD ${h.docs.join(" / ")} — ${h.why}`);
  if (!APPLY) log("\nDRY-RUN — set APPLY=1 to write.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
