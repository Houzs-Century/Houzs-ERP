#!/usr/bin/env node
// Attach the AutoCount FurtherDescription photos to the imported SO lines
// (owner 2026-08-09: "有照片的都要拿出来放进去那个 line 那个 sku 的 photos";
// sofa lines held for the sofa round).
//
// The images were extracted locally from the AutoCount RTF (WMF->DIB->JPEG) and
// uploaded to the SO_ITEM_PHOTOS bucket under DETERMINISTIC keys:
//   so-items/<erp doc_no>/<item id>/ac-<AC DtlKey>-<n>.jpg
// This script computes the same keys from data/ac-photo-manifest.json.gz:
//   MODE resolve (default): prints the upload list (file -> key) for the local
//     wrangler uploader, plus everything it could NOT match and why.
//   APPLY=1: appends each key to the line's photo_urls (skips ones already
//     there — idempotent; the signed-URL route serves any key listed there).
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

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "RESOLVE"}`);
  const manifest = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-photo-manifest.json.gz"))).toString("utf8"));
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

  const items = await sql`SELECT i.id, i.doc_no, i.item_code, i.photo_urls, h.linked_ac_docno
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
  const byDocCode = new Map();
  for (const it of items) {
    const k = `${it.linked_ac_docno}|${norm(it.item_code)}`;
    if (!byDocCode.has(k)) byDocCode.set(k, []);
    byDocCode.get(k).push(it);
  }

  let sofaHeld = 0, noOrder = 0, noLine = 0, unmapped = 0;
  const plan = []; // {file, key, itemId, already}
  const seenN = new Map(); // itemId -> next n (photos per line keep manifest order)
  for (const m of manifest) {
    if (isSofa(m.ItemCode)) { sofaHeld++; continue; }
    const erp = byAc.get(norm(m.ItemCode));
    if (!erp) { unmapped++; log(`  unmapped AC code: ${m.ItemCode} (${m.DocNo})`); continue; }
    const cands = byDocCode.get(`${m.DocNo}|${norm(erp)}`);
    if (!cands) {
      // order not imported at all vs line missing
      const anyDoc = items.some((it) => it.linked_ac_docno === m.DocNo);
      if (anyDoc) { noLine++; log(`  line not found: ${m.DocNo} ${m.ItemCode} -> ${erp}`); }
      else noOrder++;
      continue;
    }
    const it = cands[0];
    const n = (seenN.get(it.id) ?? 0) + 1; seenN.set(it.id, n);
    const key = `so-items/${it.doc_no}/${it.id}/ac-${m.DtlKey}-${n}.jpg`;
    plan.push({ file: m.file, key, itemId: it.id, already: (it.photo_urls ?? []).includes(key) });
  }
  const todo = plan.filter((p) => !p.already);
  log(`manifest rows: ${manifest.length}; sofa held: ${sofaHeld}; unmapped: ${unmapped}; order-not-imported: ${noOrder}; line-missing: ${noLine}`);
  log(`photo keys planned: ${plan.length} (already attached: ${plan.length - todo.length})`);

  if (!APPLY) {
    for (const p of plan) log(`UPLOAD ${p.file} -> ${p.key}`);
    log("RESOLVE done — upload the files above, then re-run with APPLY=1.");
    await sql.end(); return;
  }
  // APPLY: append keys per item (pull-then-push, mirrors the upload route)
  const byItem = new Map();
  for (const p of todo) { if (!byItem.has(p.itemId)) byItem.set(p.itemId, []); byItem.get(p.itemId).push(p.key); }
  let updated = 0;
  for (const [itemId, keys] of byItem) {
    const [row] = await sql`SELECT photo_urls FROM scm.mfg_sales_order_items WHERE id = ${itemId}`;
    if (!row) { log(`  !! item ${itemId} vanished, skipped`); continue; }
    const next = [...(row.photo_urls ?? [])];
    for (const k of keys) if (!next.includes(k)) next.push(k);
    await sql`UPDATE scm.mfg_sales_order_items SET photo_urls = ${next} WHERE id = ${itemId}`;
    updated++;
  }
  log(`DONE. lines updated: ${updated}; keys attached: ${todo.length}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
