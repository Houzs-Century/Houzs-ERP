#!/usr/bin/env node
// Put a real cost on the cutover lots that landed at zero.
//
// Owner 2026-08-10 read the zero-cost list and said what half of it was:
// "可能是因为它是 GWP 免费的吧" — and tracing the movements back to AutoCount
// proved him right about that half, and wrong (usefully) about the other:
//
//   • 129 units genuinely have NO purchase price anywhere in AutoCount — GWP
//     pillows, DEMO units, dining/display furniture (CH-DC, DESIGN CHR,
//     SIDE TBL, GN-VM PILLOW-DEMO). Zero IS their cost. Left alone.
//   • 954 units came in on a receipt line whose UnitPrice happened to be 0,
//     while the SAME item has a real purchase price elsewhere in its history
//     — including bedframes at RM705 / RM870 / RM1,680 each. Shipping those at
//     zero cost would overstate margin every time one goes out.
//
// This backfills the second group from data/ac-last-purchase-costs.json.gz
// (each item's most recent PRICED purchase-invoice line).
//
// SAFETY — only touches lots that are:
//   · from this cutover (source_doc_type AC_CUTOVER), and
//   · still FULLY unconsumed (qty_remaining = qty_received), so no already-
//     shipped COGS is being rewritten after the fact, and
//   · currently zero-cost.
// The originating movement is updated in the same transaction, so the lot and
// the ledger never disagree.
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. Keyed on a lot whose unit_cost_sen is 0 or NULL, which its own write fills with a real cost.
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
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; } }
  out.push(cur); return out;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const costs = gz("ac-last-purchase-costs.json.gz");
  const csv = fs.readFileSync(path.join(here, "data", "autocount-erp-mapping-1561.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  csv.shift();
  /* ERP code -> best known purchase cost. Several AutoCount codes can map to
     ONE ERP code (HOK-1007 (Q) and NB-KHJ57(Q) are both CODY-(Q)); take the
     HIGHEST of their last-priced costs rather than whichever came first, so a
     stray cheap variant cannot understate the whole SKU. */
  const bestByErp = new Map();
  const acToErp = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) acToErp.set(norm(f[0]), (f[1] || "").trim()); }
  for (const r of costs) {
    const erp = acToErp.get(norm(r.ItemCode));
    if (!erp || !(r.LastCost > 0)) continue;
    const k = norm(erp);
    if (!bestByErp.has(k) || r.LastCost > bestByErp.get(k)) bestByErp.set(k, r.LastCost);
  }
  log(`items with a known purchase cost: ${bestByErp.size}`);

  const lots = await sql`SELECT l.id, l.item_code, l.qty_received, l.qty_remaining, l.movement_id
    FROM scm.inventory_lots l
    WHERE l.company_id = 1 AND l.source_doc_type = 'AC_CUTOVER'
      AND (l.unit_cost_sen = 0 OR l.unit_cost_sen IS NULL)
      AND l.qty_remaining > 0`;
  log(`zero-cost cutover lots still on hand: ${lots.length}`);

  const plan = []; let consumed = 0, noPrice = 0, noPriceUnits = 0;
  for (const l of lots) {
    if (Number(l.qty_remaining) !== Number(l.qty_received)) { consumed++; continue; }
    const cost = bestByErp.get(norm(l.item_code));
    if (!(cost > 0)) { noPrice++; noPriceUnits += Number(l.qty_remaining); continue; }
    plan.push({ id: l.id, movementId: l.movement_id, code: l.item_code, qty: Number(l.qty_received), sen: Math.round(cost * 100) });
  }
  const units = plan.reduce((s, p) => s + p.qty, 0);
  const value = plan.reduce((s, p) => s + p.qty * p.sen, 0) / 100;
  log(`to cost: ${plan.length} lots / ${units} units, adding RM ${value.toFixed(2)} of inventory value`);
  log(`left at zero on purpose (no purchase price anywhere — GWP / demo / display): ${noPrice} lots / ${noPriceUnits} units`);
  log(`skipped because already partly shipped (never rewrite settled COGS): ${consumed}`);
  for (const p of plan.slice(0, 20)) log(`   ${p.code} x${p.qty} @ RM${(p.sen / 100).toFixed(2)}`);

  if (!APPLY) { log("DRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  let done = 0;
  for (const p of plan) {
    await sql.begin(async (tx) => {
      await tx`UPDATE scm.inventory_lots SET unit_cost_sen = ${p.sen} WHERE id = ${p.id}`;
      if (p.movementId) {
        await tx`UPDATE scm.inventory_movements
                   SET unit_cost_sen = ${p.sen}, total_cost_sen = ${p.sen * p.qty}
                 WHERE id = ${p.movementId}`;
      }
    });
    done++;
    if (done % 100 === 0) log(`  ..${done}/${plan.length}`);
  }
  log(`DONE. lots costed: ${done}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
