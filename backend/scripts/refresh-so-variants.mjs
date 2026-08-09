#!/usr/bin/env node
// Re-parse the AutoCount Desc2 with the CURRENT parser and UPDATE the already
// imported company-1 bedframe lines in place. No wipe, no re-import: the orders,
// payments and the backfilled processing/delivery dates all stay exactly as they
// are — only the variant fields are recomputed.
//
// Owner 2026-08-09: "为什么要清旧的SO 不能update进去用旧的" — right, an UPDATE is
// safer than wipe+reload, so parser improvements land this way from now on.
//
// Writes: variants (fabricId/colourId/fabricCode/colourLabel/gap/divanHeight/
// legHeight/totalHeight/specials/size), gap_inches, divan_height_inches,
// leg_height_inches, custom_specials (mapped to REAL scm.special_addons codes).
// DRY-RUN by default; APPLY=1 to write.
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
const strip = (s) => norm(s).replace(/[^A-Z0-9]/g, "");
const isPendingColour = (c) => /(TBC|KIV)/i.test(c || "");

// The parser + the special mapper are loaded from the import scripts so there is
// exactly ONE definition of each and this can never drift from the importer.
const soSrc = fs.readFileSync(path.join(here, "import-ac-outstanding-so.mjs"), "utf8");
const fxSrc = fs.readFileSync(path.join(here, "fix-so-specials.mjs"), "utf8");
const parseBedframe = new Function(`${soSrc.slice(soSrc.indexOf("function parseBedframe"), soSrc.indexOf("// free-text name resolver")).trim()}; return parseBedframe;`)();
const mapSpecial = new Function(`${fxSrc.slice(fxSrc.indexOf("function mapSpecial"), fxSrc.indexOf("async function main")).trim()}; return mapSpecial;`)();

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-so.json.gz"))).toString("utf8").replace(/^﻿/, ""));
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  const byAc = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

  // AutoCount DocNo|erp_code -> the freshly parsed variant block
  const parsed = new Map();
  for (const r of rows) {
    const erp = byAc.get(norm(r.ItemCode)); if (!erp) continue;
    parsed.set(`${r.DocNo}|${erp.toUpperCase()}`, parseBedframe(r.Desc2));
  }

  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const fcx = new Map(); for (const r of fcRows) for (const k of [norm(r.colour_id), norm(r.label), strip(r.colour_id), strip(r.label)]) if (k && !fcx.has(k)) fcx.set(k, r);
  const findColour = (c) => {
    if (!c) return null;
    const pad = (x) => x.replace(/(?<!\d)(\d)$/, "0$1");
    /* SERIESNUM: split "PC151-2"/"PC151101" into series + number so a 1-digit or
       over-long tail still finds PC151-02 / PC151-01 (owner data has both). */
    const seriesNum = (x) => { const mm = /^([A-Z]{2,4})(\d{2,4})(\d{1,3})$/.exec(strip(x)); return mm ? [mm[1] + mm[2] + mm[3].padStart(2, "0"), mm[1] + mm[2] + mm[3].slice(-2)] : []; };
    const toks = [c, (c.trim().split(/\s+/)[0] || "")];
    const m = /[A-Z]{1,4}\s?\d{2,4}\s?-?\s?\d*/i.exec(c); if (m) toks.push(m[0]);
    const cands = [];
    for (const t of toks) { if (!t) continue; cands.push(norm(t), strip(t), pad(strip(t)), ...seriesNum(t)); if (/^\d/.test(t.trim())) cands.push(strip("PC" + t), pad(strip("PC" + t))); }
    for (const t of cands) { const h = fcx.get(t); if (h) return h; }
    return null;
  };
  const validSpecials = new Set((await sql`SELECT code FROM scm.special_addons WHERE company_id = 1 AND 'BEDFRAME' = ANY(categories)`).map((r) => r.code));

  const items = await sql`SELECT i.id, i.item_code, i.variants, h.linked_ac_docno
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = 1 AND i.item_group = 'bedframe' AND h.linked_ac_docno IS NOT NULL`;
  log(`imported bedframe lines: ${items.length}`);

  const updates = []; let gained = 0;
  for (const it of items) {
    const bf = parsed.get(`${it.linked_ac_docno}|${(it.item_code || "").toUpperCase()}`);
    if (!bf) continue;
    const pending = isPendingColour(bf.color);
    const fc = pending ? null : findColour(bf.color);
    const codes = new Set();
    for (const raw of bf.specials || []) {
      if (validSpecials.has(raw)) { codes.add(raw); continue; }        // already a real code
      for (const c of mapSpecial(raw)) if (validSpecials.has(c)) codes.add(c);
    }
    const specials = [...codes];
    const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
    const variants = {
      fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null,
      fabricCode: fc ? fc.colour_id : null, colourLabel: fc ? fc.label : null,
      fabricLabel: fc ? fc.fabric_id : null,
      gap: bf.gap != null ? bf.gap + '"' : null, divanHeight: bf.divan != null ? bf.divan + '"' : null,
      legHeight: bf.leg != null ? bf.leg + '"' : null, totalHeight: tot ? tot + '"' : null,
      size: bf.size || null, specials,
    };
    const had = it.variants || {};
    if (!had.colourId && variants.colourId) gained++;
    updates.push({ id: it.id, variants, specials, gap: bf.gap, divan: bf.divan, leg: bf.leg });
  }
  const withColour = updates.filter((u) => u.variants.colourId).length;
  const withSpecials = updates.filter((u) => u.specials.length).length;
  log(`lines to refresh: ${updates.length}; with colour: ${withColour} (newly gained ${gained}); with real special options: ${withSpecials}`);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  for (let i = 0; i < updates.length; i += 200) {
    const b = updates.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of b) {
        await tx`UPDATE scm.mfg_sales_order_items SET
                   variants = ${sql.json(u.variants)},
                   custom_specials = ${u.specials.length ? sql.json(u.specials) : null},
                   gap_inches = ${u.gap != null ? Math.round(u.gap) : null},
                   divan_height_inches = ${u.divan != null ? Math.round(u.divan) : null},
                   leg_height_inches = ${u.leg != null ? Math.round(u.leg) : null}
                 WHERE id = ${u.id}`;
      }
    });
    log(`  ..${Math.min(i + 200, updates.length)}/${updates.length}`);
  }
  log(`DONE. refreshed ${updates.length} bedframe lines`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
