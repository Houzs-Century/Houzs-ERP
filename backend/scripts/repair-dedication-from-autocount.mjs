#!/usr/bin/env node
/* Set every purchase-order line's dedication from AutoCount's OWN link.
 *
 * Owner, 2026-08-11: 以 AutoCount 为准，最准.
 *
 * `PODTL.FromSODtlKey` is the ONE line-to-line link AutoCount actually
 * populates. Everything else in this migration joins on (document, ItemCode,
 * Desc2), which cannot tell two sibling lines of the same SKU apart - and that
 * is the origin of every wrong-value incident recorded in
 * docs/autocount-migration-record.md section 3.1.
 *
 * WHAT THIS PROVED. Five documents were reported as SO-vs-PO "conflicts", and
 * the owner's first instinct was to follow the purchase order because it has
 * been issued. Reading AutoCount instead DISPROVED the premise: the AutoCount
 * SO and PO are byte-identical on all five, carrying the same sibling lines
 * with the same values. Our `so_item_id` had simply paired SO line A with PO
 * line B. Following the PO would have WRITTEN AN ERROR - stamping PC151-03 onto
 * a line whose true counterpart says PC151-02.
 *
 * Measured against production before this was written: 86 dedications agree
 * with AutoCount, 8 disagree (exactly the four "conflict" documents, two lines
 * each) and 30 lines have no dedication that AutoCount can supply.
 *
 * This writes a LINK, never a value. No money moves, no stock moves.
 *
 * The snapshot is committed because a CI runner cannot reach the AutoCount host
 * (ZeroTier, office network) - the same split every other check here uses.
 * Refresh it from a machine on that network with export-ac-po-fromsodtlkey.py.
 *
 *   DATABASE_URL   required
 *   APPLY=1        write. Dry-run otherwise.
 *
 * RE-RUN: convergent. AutoCount's dedication is the source and does not move, so a second run writes the same link.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => String(s ?? "").trim().toUpperCase();
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-po-fromsodtlkey.json.gz"))).toString("utf8"));
  const fromSo = new Map(snap.rows.map((r) => [String(r.DtlKey), String(r.FromSODtlKey)]));
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}; AutoCount snapshot ${snap.exportedAt}, ${snap.rows.length} PO lines carry a FromSODtlKey`);

  const po = await sql`SELECT i.id, p.po_number doc, i.item_code code, i.linked_ac_dtlkey k, i.so_item_id
      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL`;
  const so = await sql`SELECT i.id, i.doc_no, i.item_code, i.linked_ac_dtlkey k
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL`;
  const byKey = new Map(so.map((r) => [String(r.k), r]));
  const byId = new Map(so.map((r) => [r.id, r]));

  const fix = [], create = [];
  let agree = 0, noLink = 0, noSoLine = 0, pieceUnresolved = 0;
  for (const r of po) {
    const fk = fromSo.get(String(r.k));
    if (!fk) { noLink++; continue; }
    const tgt = byKey.get(fk);
    if (!tgt) { noSoLine++; continue; }
    /* AutoCount holds ONE line for a whole sofa, so its pointer identifies the
       DOCUMENT and the build, not the piece. Where we split that build into
       compartments, the pointer can only ever land on one of them. So let
       AutoCount choose the sales order and let the compartment code choose the
       piece within it - pieces are unambiguous inside one build, and a code
       mismatch is never a legitimate dedication. */
    let dest = tgt;
    if (norm(r.code) !== norm(tgt.item_code)) {
      const sib = so.filter((x) => x.doc_no === tgt.doc_no && norm(x.item_code) === norm(r.code));
      if (sib.length !== 1) { pieceUnresolved++; continue; }
      dest = sib[0];
    }
    if (!r.so_item_id) { create.push({ ...r, tgt: dest }); continue; }
    if (r.so_item_id === dest.id) { agree++; continue; }
    fix.push({ ...r, was: byId.get(r.so_item_id), tgt: dest });
  }

  log("");
  log(`agrees with AutoCount            ${agree}`);
  log(`AutoCount states no link          ${noLink}`);
  log(`its SO line has no key here       ${noSoLine}`);
  log(`piece not resolvable in that SO   ${pieceUnresolved}`);
  log(`WRONG SIBLING, to re-point        ${fix.length}`);
  for (const f of fix) log(`   ${f.doc} ${String(f.code).padEnd(26)} ${f.was ? `${f.was.doc_no}` : "?"}: sibling ${f.was ? f.was.id.slice(0, 8) : "?"} -> ${f.tgt.id.slice(0, 8)}`);
  log(`MISSING, to create from AutoCount ${create.length}`);
  for (const c of create.slice(0, 15)) log(`   ${c.doc} ${String(c.code).padEnd(26)} -> ${c.tgt.doc_no} ${c.tgt.item_code}`);
  if (create.length > 15) log(`   ... and ${create.length - 15} more`);

  if (!APPLY) {
    /* The apply-path guard below scans EVERY company-1 dedication, not only
       this batch's writes — so a pre-existing mismatch fails the whole apply
       and reads as if the batch caused it (run 33271420009 did exactly that).
       Surface the CURRENT violations here, read-only, so the operator can see
       whether the refusal belongs to the batch or to standing data. */
    const bad = await sql`SELECT p.linked_ac_docno AS po, i.item_code AS po_code, s.doc_no AS so, s.item_code AS so_code
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
       WHERE p.company_id = 1 AND upper(btrim(i.item_code)) <> upper(btrim(s.item_code))`;
    log(`\ncode check on CURRENT data: ${bad.length} dedication(s) already point at a different item code`);
    for (const b of bad.slice(0, 10)) log(`   ${b.po} "${b.po_code}" -> ${b.so} "${b.so_code}"`);
    log("DRY-RUN - set APPLY=1 to write.");
    await sql.end(); return;
  }

  let n = 0;
  await sql.begin(async (tx) => {
    /* A dedication may only point at a line carrying the SAME item code - two
       rows describing one physical build cannot be different products. The
       guard used to scan the WHOLE company-1 population after writing, so ONE
       pre-existing mismatch (PO-001696 "2379-2S" -> a still-unsplit sofa
       placeholder line, standing data) vetoed every future batch including
       clean ones (run 33271420009). Scope it to the batch: snapshot the
       standing violations first, write, then fail only on NEW ones — the
       standing set is reported, never silently accepted. */
    const before = await tx`SELECT i.id FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
       WHERE p.company_id = 1 AND upper(btrim(i.item_code)) <> upper(btrim(s.item_code))`;
    const standing = new Set(before.map((r) => r.id));
    if (standing.size) log(`standing code-mismatch dedications (NOT this batch's, left alone): ${standing.size}`);
    for (const r of [...fix, ...create]) {
      const u = await tx`UPDATE scm.purchase_order_items SET so_item_id = ${r.tgt.id} WHERE id = ${r.id} RETURNING id`;
      n += u.length;
    }
    const after = await tx`SELECT i.id FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
       WHERE p.company_id = 1 AND upper(btrim(i.item_code)) <> upper(btrim(s.item_code))`;
    const fresh = after.filter((r) => !standing.has(r.id));
    if (fresh.length) throw new Error(`REFUSED: this batch would create ${fresh.length} dedication(s) pointing at a different item code. Rolled back.`);
    log(`code check: this batch created 0 cross-code dedications (standing: ${standing.size})`);
  });
  log(`APPLIED - re-pointed ${fix.length}, created ${create.length}, total ${n}. A link only: no value, no money, no stock.`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
