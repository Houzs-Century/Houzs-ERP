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
/* One AutoCount sofa line becomes MANY ERP lines (one per compartment), so a
   sofa photo attaches to every piece of that build — the operator opens any
   piece and sees the reference shot (owner 2026-08-10: "import 进来的时候需要
   连那个照片一起 import 进来"). Model comes from the same mapping + alias the
   SO importer uses. */
const SOFA_MODEL_ALIAS = { "5530": "9028", "5536": "9058", "5537": "8030", "5540": "8030" };
const sofaModelOf = (erp) => {
  const m = (erp || "").replace(/-1S$/i, "").toUpperCase();
  return SOFA_MODEL_ALIAS[m] || m;
};

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

  const items = await sql`SELECT i.id, i.doc_no, i.item_code, i.photo_urls, i.linked_ac_dtlkey, h.linked_ac_docno
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
    ORDER BY i.doc_no, i.line_no`;
  const byDocCode = new Map();
  for (const it of items) {
    const k = `${it.linked_ac_docno}|${norm(it.item_code)}`;
    if (!byDocCode.has(k)) byDocCode.set(k, []);
    byDocCode.get(k).push(it);
  }
  /* THE LINE KEY, and why it goes first (bug 0587). Everything below finds the
     ERP row by ITEM CODE and takes cands[0]. The book does not identify a
     photograph by item code — it identifies it by LINE (DtlKey) — so a document
     carrying the same code, or the same sofa model, on two lines sent BOTH
     photographs to the first row and left the second line blank. Measured on
     prod 2026-09-03: 34 AutoCount lines on 30 documents.
     linked_ac_dtlkey is stamped on the line itself, so the right row can simply
     be asked for. Sofa keeps its rule untouched: a build is one AutoCount line
     held as several compartment rows, they all carry the same key, and the
     photo still goes on the FIRST of them (ORDER BY line_no above).
     The item-code path stays as the FALLBACK, because 244 SO lines carry no
     AutoCount line key at all and matching by code is the only thing that can
     reach them. */
  const byDocDtl = new Map();
  for (const it of items) {
    if (it.linked_ac_dtlkey === null || it.linked_ac_dtlkey === undefined) continue;
    const k = `${it.linked_ac_docno}|${String(it.linked_ac_dtlkey)}`;
    if (!byDocDtl.has(k)) byDocDtl.set(k, []);
    byDocDtl.get(k).push(it);
  }
  const ownerOf = (m) => (byDocDtl.get(`${m.DocNo}|${String(m.DtlKey)}`) ?? [])[0] ?? null;

  const plan = []; // {file, key, itemId, already}
  const seenN = new Map(); // itemId -> next n (photos per line keep manifest order)
  const byDocModel = new Map(); // "<ac doc>|<model>" -> sofa piece lines
  for (const it of items) {
    const code = norm(it.item_code);
    const dash = code.indexOf("-");
    if (dash < 0) continue;
    const k = `${it.linked_ac_docno}|${code.slice(0, dash)}`;
    if (!byDocModel.has(k)) byDocModel.set(k, []);
    byDocModel.get(k).push(it);
  }
  let sofaHeld = 0, noOrder = 0, noLine = 0, unmapped = 0;
  const heldDocs = []; // named, not just counted — a silent count hid a real bug
  for (const m of manifest) {
    /* The line the book actually photographed, when the ERP knows it. See the
       byDocDtl comment above — this is the only branch that cannot put a
       picture on the wrong line. */
    const owner = ownerOf(m);
    if (owner) {
      const n = (seenN.get(owner.id) ?? 0) + 1; seenN.set(owner.id, n);
      const key = `so-items/${owner.doc_no}/${owner.id}/ac-${m.DtlKey}-${n}.jpg`;
      plan.push({ file: m.file, key, itemId: owner.id, already: (owner.photo_urls ?? []).includes(key) });
      continue;
    }
    const erp = byAc.get(norm(m.ItemCode));
    if (isSofa(m.ItemCode)) {
      if (!erp) { unmapped++; log(`  unmapped AC sofa code: ${m.ItemCode} (${m.DocNo})`); continue; }
      /* Not everything whose AutoCount code says SOFA is a BUILD: "AMN-SOFA
         PILLOW" / "THL-SOFA PILLOW" are accessories that import as one literal
         line. byDocModel is keyed on the code up to the FIRST dash, so their
         model key ("AMN-SOFA PILLOW") can never match its index entry ("AMN")
         and three photos were being counted as held with the line sitting
         right there. Mirror of the literal branch below: try compartments,
         then fall back to the exact code. */
      let pieces = byDocModel.get(`${m.DocNo}|${sofaModelOf(erp)}`);
      if (!pieces || !pieces.length) pieces = byDocCode.get(`${m.DocNo}|${norm(erp)}`);
      if (!pieces || !pieces.length) { sofaHeld++; heldDocs.push(`${m.DocNo} ${m.ItemCode}`); continue; }
      /* Owner 2026-08-10: "沙发的照片不需要每个 SKU 都进的 ... 每个 SKU 的照片
         都一样,留第一个就可以了". One AutoCount sofa line is one photograph of
         one build; copying it onto all N compartment rows stored the same image
         N times and made the operator scroll past duplicates. Anchor it on the
         FIRST piece - the same row the importer hangs the price on. */
      for (const it of pieces.slice(0, 1)) {
        const n = (seenN.get(it.id) ?? 0) + 1; seenN.set(it.id, n);
        const key = `so-items/${it.doc_no}/${it.id}/ac-${m.DtlKey}-${n}.jpg`;
        plan.push({ file: m.file, key, itemId: it.id, already: (it.photo_urls ?? []).includes(key) });
      }
      continue;
    }
    if (!erp) { unmapped++; log(`  unmapped AC code: ${m.ItemCode} (${m.DocNo})`); continue; }
    /* Not every sofa's AutoCount code says SOFA — "THL-2379" is a sofa too, and
       taking the literal path for it looks for a whole "2379-1S" line that a
       decomposed order does not have. So when the exact code is not on the
       order, fall back to the build's compartment lines before calling it
       missing. */
    let cands = byDocCode.get(`${m.DocNo}|${norm(erp)}`);
    if (!cands) {
      const pieces = byDocModel.get(`${m.DocNo}|${sofaModelOf(erp)}`);
      if (pieces && pieces.length) {
        for (const it of pieces.slice(0, 1)) {   // first piece only - see above
          const n = (seenN.get(it.id) ?? 0) + 1; seenN.set(it.id, n);
          const key = `so-items/${it.doc_no}/${it.id}/ac-${m.DtlKey}-${n}.jpg`;
          plan.push({ file: m.file, key, itemId: it.id, already: (it.photo_urls ?? []).includes(key) });
        }
        continue;
      }
    }
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
  for (const d of heldDocs) log(`  sofa held (no ERP line): ${d}`);
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
