#!/usr/bin/env node
// Repair the sofa lines that came in through the OLD non-sofa round and were
// never split into compartments (owner 2026-08-10: "那一些可能也要整理一下,
// 因为它的 SKU 等等可能都是有问题的").
//
// A leak is a `{model}-1S` line whose AutoCount text decodes into 2+ pieces and
// which carries NO "SOFA UNPARSED" remark — the sofa lane's own fallback always
// leaves that flag, so anything unflagged came from the old lane.
//
// Repair shape — UPDATE IN PLACE, never delete: the original row becomes piece
// #1 (keeping its id, so PO allocations / any FK stay intact) and the remaining
// pieces are inserted after it at 0 price. Order value is therefore unchanged;
// only the piece breakdown, item_group, variants and remark change.
//
// Guards: skips a line that already looks decomposed, that has an allocation
// pointing at it (reported instead), or whose ERP piece SKUs do not all exist.
// MODE=dry-run default; MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN".
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";

const MODE = (process.env.MODE || "dry-run").toLowerCase();
const APPLY = MODE === "apply" && process.env.CONFIRM === "I HAVE REVIEWED THE DRY-RUN";
if (MODE === "apply" && !APPLY) { console.error('apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN"'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const here = path.dirname(fileURLToPath(import.meta.url));
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-outstanding-so.json.gz"))).toString("utf8"));
const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
csv.shift();
const byAc = new Map();
for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) byAc.set(norm(f[0]), (f[1] || "").trim()); }

async function main() {
  note(`MODE=${MODE}`);
  const prods = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = 1`;
  const codeSet = new Set(prods.map((p) => p.code.toUpperCase()));
  const nameByCode = new Map(prods.map((p) => [p.code.toUpperCase(), p.name]));
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
  const fcx = new Map();
  for (const r of fcRows) for (const k of [norm(r.colour_id), norm(r.label)]) if (k && !fcx.has(k)) fcx.set(k, r);
  const findColour = (c) => (c ? fcx.get(norm(c)) ?? null : null);

  const items = await sql`SELECT i.id, i.doc_no, i.line_no, i.item_code, i.item_group, i.qty,
                                 i.unit_price_centi, i.total_centi, i.remark, i.location, i.uom,
                                 h.linked_ac_docno
                          FROM scm.mfg_sales_order_items i
                          JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                          WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL`;
  const byDoc = new Map();
  for (const it of items) { if (!byDoc.has(it.linked_ac_docno)) byDoc.set(it.linked_ac_docno, []); byDoc.get(it.linked_ac_docno).push(it); }

  const plan = [], blocked = [];
  for (const l of raw) {
    const erpCode = byAc.get(norm(l.ItemCode)) || "";
    if (!/^\w{2,6}-1S$/i.test(erpCode)) continue;
    let model = erpCode.replace(/-1S$/i, "");
    model = SOFA_MODEL_ALIAS[model] || model;
    const list = byDoc.get(l.DocNo);
    if (!list) continue;
    const line = list.find((it) => norm(it.item_code) === norm(`${model}-1S`) && !/SOFA UNPARSED/i.test(it.remark || ""));
    if (!line) continue;
    const reclOK = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"].some((s) => codeSet.has((model + s).toUpperCase()));
    const ps = parseSofa(l.Desc2, model, reclOK);
    if (ps.conf === "low" || ps.pieces.length < 2) continue;
    const codes = ps.pieces.map((c) => `${model}-${c}`);
    const missing = codes.filter((c) => !codeSet.has(c.toUpperCase()));
    if (missing.length) { blocked.push({ doc: line.doc_no, ac: l.DocNo, reason: `piece SKU missing: ${missing.join(",")}` }); continue; }
    const [alloc] = await sql`SELECT 1 AS x FROM scm.po_item_allocations WHERE so_item_id = ${line.id} LIMIT 1`;
    if (alloc) { blocked.push({ doc: line.doc_no, ac: l.DocNo, reason: "line already allocated to a PO — left alone" }); continue; }
    plan.push({ line, ac: l.DocNo, d2: l.Desc2, model, pieces: ps.pieces, codes, size: ps.size,
                colour: ps.color, fc: findColour(ps.color), specials: ps.specials });
  }

  note(`repairable leaked lines: ${plan.length}; blocked: ${blocked.length}`);
  for (const b of blocked) note(`   BLOCKED ${b.doc} (${b.ac}) — ${b.reason}`);
  for (const p of plan) note(`   ${p.line.doc_no} (${p.ac}) ${p.line.item_code} RM${(p.line.total_centi / 100).toFixed(2)} -> ${p.pieces.join(" + ")} @${p.size ?? "?"}`);

  if (!APPLY) { note("DRY-RUN — nothing written."); await sql.end({ timeout: 5 }); return; }

  let fixed = 0, added = 0;
  for (const p of plan) {
    await sql.begin(async (tx) => {
      const v = { seatHeight: p.size ?? null, fabricId: p.fc ? p.fc.fabric_id : null, colourId: p.fc ? p.fc.colour_id : null,
                  fabricCode: p.fc ? p.fc.colour_id : null, colourLabel: p.fc ? p.fc.label : (p.colour || null),
                  fabricLabel: p.fc ? p.fc.fabric_id : null, specials: p.specials || [] };
      const lead = p.codes[0];
      await tx`UPDATE scm.mfg_sales_order_items
               SET item_code = ${lead}, item_group = 'sofa',
                   description = ${nameByCode.get(lead.toUpperCase()) || lead},
                   variants = ${tx.json(v)},
                   remark = ${"sofa: 补拆件(原本整行导入) " + p.pieces.join("+")}
               WHERE id = ${p.line.id}`;
      let ln = Number(p.line.line_no) || 0;
      for (const comp of p.pieces.slice(1)) {
        const code = `${p.model}-${comp}`;
        ln += 1;
        await tx`INSERT INTO scm.mfg_sales_order_items
          (doc_no, line_no, item_group, item_code, description, description2, uom, location,
           qty, unit_price_centi, total_centi, balance_centi, company_id, variants, remark)
          VALUES (${p.line.doc_no}, ${ln + 900}, 'sofa', ${code},
                  ${nameByCode.get(code.toUpperCase()) || code}, ${p.d2 || null}, ${p.line.uom || "UNIT"}, ${p.line.location},
                  ${p.line.qty}, 0, 0, 0, 1, ${tx.json(v)},
                  ${"sofa: 补拆件(原本整行导入) " + p.pieces.join("+")})`;
        added++;
      }
      fixed++;
    });
  }
  note(`APPLIED: lines repaired ${fixed}; pieces added ${added}`);
  await sql.end({ timeout: 5 });
}
main().catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
