#!/usr/bin/env node
// Attach the AutoCount FurtherDescription photos to the imported PO lines.
//
// Owner 2026-08-10: "正常我们的 Sales Order 里面可以存放照片，PO 那边也可以存放照片。
// 因为当我们将 Sales Order 转换成 PO（convert to PO）时，那个 PO 也会自动带着这张照片."
// AutoCount holds a picture on the PURCHASE line too, and it is the picture the
// factory actually builds from — so it has to arrive with the paperwork, not be
// re-attached by hand afterwards.
//
// Same shape as import-so-line-photos.mjs. The images were extracted locally
// from the AutoCount RTF (WMF -> DIB -> JPEG) and uploaded to the same bucket
// under deterministic keys:
//   po-items/<erp po_number>/<item id>/ac-<AC DtlKey>-<n>.jpg
//   MODE resolve (default): prints the upload list (file -> key) for the local
//     wrangler uploader, plus everything it could NOT match and why.
//   APPLY=1: appends each key to the line's photo_urls (idempotent).
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
/* One AutoCount sofa line becomes MANY ERP lines (one per compartment), so the
   build photo attaches to EVERY piece of that build: whichever piece the
   supplier or the warehouse opens, the reference shot is on it. */
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
  const manifest = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-po-photo-manifest.json.gz"))).toString("utf8"));
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

  const items = await sql`SELECT i.id, i.item_code, i.photo_urls, i.linked_ac_dtlkey, p.po_number, p.linked_ac_docno
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE p.company_id = 1 AND p.linked_ac_docno IS NOT NULL ORDER BY i.id`;
  /* THE LINE KEY, and why it goes first (bug 0587). Everything below finds the
     ERP row by ITEM CODE and takes the first match. The book identifies a
     photograph by LINE (DtlKey), not by item code, so a PO carrying the same
     code — or the same sofa model — twice sent BOTH photographs to the first
     row and left the second line blank. Measured on prod 2026-09-03: 34
     AutoCount lines on 30 documents, 22 of them on the purchase side.
     Sofa is unchanged: a build is one AutoCount line held as several
     compartment rows sharing the key, and the photo still lands on the first of
     them (ORDER BY i.id above). The item-code path stays as the FALLBACK for
     lines with no AutoCount key stamped. */
  const byDocDtl = new Map();
  for (const it of items) {
    if (it.linked_ac_dtlkey === null || it.linked_ac_dtlkey === undefined) continue;
    const k = `${it.linked_ac_docno}|${String(it.linked_ac_dtlkey)}`;
    if (!byDocDtl.has(k)) byDocDtl.set(k, []);
    byDocDtl.get(k).push(it);
  }
  const ownerOf = (m) => (byDocDtl.get(`${m.DocNo}|${String(m.DtlKey)}`) ?? [])[0] ?? null;
  const byDocCode = new Map();
  const byDocModel = new Map();
  for (const it of items) {
    const code = norm(it.item_code);
    const k = `${it.linked_ac_docno}|${code}`;
    if (!byDocCode.has(k)) byDocCode.set(k, []);
    byDocCode.get(k).push(it);
    const dash = code.indexOf("-");
    if (dash < 0) continue;
    const mk = `${it.linked_ac_docno}|${code.slice(0, dash)}`;
    if (!byDocModel.has(mk)) byDocModel.set(mk, []);
    byDocModel.get(mk).push(it);
  }

  const plan = [];
  const seenN = new Map();
  let sofaHeld = 0, noOrder = 0, noLine = 0, unmapped = 0;
  const heldDocs = []; // named, not just counted — a silent count hid a real bug on the SO side
  for (const m of manifest) {
    /* The line the book actually photographed, when the ERP knows it — the only
       branch that cannot put a picture on the wrong line. See byDocDtl above. */
    const owner = ownerOf(m);
    if (owner) {
      const n = (seenN.get(owner.id) ?? 0) + 1; seenN.set(owner.id, n);
      const key = `po-items/${owner.po_number}/${owner.id}/ac-${m.DtlKey}-${n}.jpg`;
      plan.push({ file: m.file, key, itemId: owner.id, already: (owner.photo_urls ?? []).includes(key) });
      continue;
    }
    const erp = byAc.get(norm(m.ItemCode));
    if (!erp) { unmapped++; log(`  unmapped AC code: ${m.ItemCode} (${m.DocNo})`); continue; }
    let targets = null;
    if (isSofa(m.ItemCode)) {
      /* SOFA in the code does not always mean a BUILD — "AMN-SOFA PILLOW" is an
         accessory that imports as one literal line, and byDocModel is keyed on
         the code up to the FIRST dash, so its model key can never match. Try
         compartments, then the exact code, before calling the PO missing. */
      targets = byDocModel.get(`${m.DocNo}|${sofaModelOf(erp)}`);
      if (!targets || !targets.length) targets = byDocCode.get(`${m.DocNo}|${norm(erp)}`);
      if (!targets || !targets.length) { sofaHeld++; heldDocs.push(`${m.DocNo} ${m.ItemCode}`); continue; }
      /* Owner 2026-08-10: "我开 PO 每个 SKU 的照片都一样,留第一个就可以了" -
         one AutoCount sofa line is one photograph of one build, so it belongs
         on the first compartment row, not copied onto all of them. */
      targets = targets.slice(0, 1);
    } else {
      const exact = byDocCode.get(`${m.DocNo}|${norm(erp)}`);
      /* Not every sofa's AutoCount code says SOFA — "THL-2379" is one too, and
         the literal path would look for a whole "2379-1S" line that a
         decomposed PO does not have. Fall back to the build's compartment
         lines before calling it missing. */
      targets = exact && exact.length ? [exact[0]] : (byDocModel.get(`${m.DocNo}|${sofaModelOf(erp)}`) ?? []).slice(0, 1);
      if (!targets || !targets.length) {
        if (items.some((it) => it.linked_ac_docno === m.DocNo)) { noLine++; log(`  line not found: ${m.DocNo} ${m.ItemCode} -> ${erp}`); }
        else noOrder++;
        continue;
      }
    }
    for (const it of targets) {
      const n = (seenN.get(it.id) ?? 0) + 1; seenN.set(it.id, n);
      const key = `po-items/${it.po_number}/${it.id}/ac-${m.DtlKey}-${n}.jpg`;
      plan.push({ file: m.file, key, itemId: it.id, already: (it.photo_urls ?? []).includes(key) });
    }
  }
  const todo = plan.filter((p) => !p.already);
  log(`manifest rows: ${manifest.length}; sofa held (PO not imported): ${sofaHeld}; unmapped: ${unmapped}; PO-not-imported: ${noOrder}; line-missing: ${noLine}`);
  for (const d of heldDocs) log(`  sofa held (no ERP line): ${d}`);
  log(`photo keys planned: ${plan.length} (already attached: ${plan.length - todo.length})`);

  if (!APPLY) {
    for (const p of plan) log(`UPLOAD ${p.file} -> ${p.key}`);
    log("RESOLVE done — upload the files above, then re-run with APPLY=1.");
    await sql.end(); return;
  }

  const byItem = new Map();
  for (const p of todo) { if (!byItem.has(p.itemId)) byItem.set(p.itemId, []); byItem.get(p.itemId).push(p.key); }
  let n = 0;
  for (const [itemId, keys] of byItem) {
    await sql`UPDATE scm.purchase_order_items
      SET photo_urls = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(photo_urls, '{}') || ${keys})))
      WHERE id = ${itemId}`;
    n += keys.length;
  }
  log(`DONE. lines updated: ${byItem.size}; keys attached: ${n}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
