#!/usr/bin/env node
// Derive BUILDING TYPE from the delivery address on the imported company-1
// orders (owner 2026-08-09: "Building Type ... 如果可以根据地址去解决掉是最好").
//
// AutoCount has no building-type field, but Malaysian addresses name the built
// form: a unit number like "C-06-05" or a "RESIDENCE/CONDO/APARTMENT" keyword is
// high-rise; "LORONG/TAMAN/JALAN <no>" with a plain house number is landed.
//
// CONSERVATIVE BY DESIGN: only writes when the address gives a clear signal, and
// only onto orders whose building_type is still NULL. An address that could be
// either is LEFT BLANK — a wrong building type is worse than an empty one
// (it drives delivery planning).
// DRY-RUN by default; APPLY=1 to write.
import fs from "node:fs";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

/** null = not confident, leave blank. */
export function inferBuildingType(addr) {
  const s = (addr || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!s) return null;
  // explicit words win
  if (/\bCONDO(MINIUM)?\b/.test(s)) return "Condo";
  if (/\bAPARTMENT|\bAPT\b|\bPANGSAPURI|\bFLAT\b|\bPPR\b/.test(s)) return "Apartment";
  if (/\bSHOP\s*LOT|\bKEDAI\b|\bSHOPLOT\b/.test(s)) return "Shop";
  if (/\bOFFICE\b|\bPEJABAT\b|\bTOWER\b|\bMENARA\b|\bSUITE\b/.test(s)) return "Office";
  if (/\bRESIDENCE?S?\b|\bSERVICE\s*APARTMENT|\bSOHO\b|\bSOFO\b|\bVISTA\b/.test(s)) return "Condo";
  // a stacked unit number (A-12-3 / C-06-05 / 1-1-11 / B7-7) = high-rise
  if (/(?:^|[\s,])[A-Z]?\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{1,3}\b/.test(s)) return "Condo";
  if (/\b(?:BLOK|BLOCK)\s*[A-Z0-9]+.*\b(?:TINGKAT|LEVEL|FLOOR)\b/.test(s)) return "Apartment";
  // landed signals: a house number on a lorong/jalan/taman, villa, banglo
  if (/\bVILLA\b|\bBANGLO|\bBUNGALOW\b|\bTERRACE\b|\bSEMI-?D\b/.test(s)) return "Landed";
  if (/^(?:NO\.?\s*)?\d+[A-Z]?\s*,/.test(s) && /\b(LORONG|LRG|JALAN|JLN|TAMAN|TMN|PERSIARAN|KAMPUNG|KG)\b/.test(s)) return "Landed";
  return null;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  const rows = await sql`SELECT doc_no, address1, address2, address3, address4
    FROM scm.mfg_sales_orders WHERE company_id = 1 AND building_type IS NULL`;
  log(`orders without a building type: ${rows.length}`);

  const updates = []; const tally = {};
  for (const r of rows) {
    const addr = [r.address1, r.address2, r.address3, r.address4].filter(Boolean).join(", ");
    const t = inferBuildingType(addr);
    if (!t) continue;
    tally[t] = (tally[t] || 0) + 1;
    updates.push({ doc: r.doc_no, t, addr });
  }
  log(`confident inferences: ${updates.length} (${Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(", ")})`);
  log(`left blank (ambiguous): ${rows.length - updates.length}`);
  for (const u of updates.slice(0, 10)) log(`   ${u.doc} -> ${u.t}   "${u.addr.slice(0, 58)}"`);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  for (let i = 0; i < updates.length; i += 200) {
    const b = updates.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of b) await tx`UPDATE scm.mfg_sales_orders SET building_type = ${u.t} WHERE doc_no = ${u.doc} AND company_id = 1`;
    });
    log(`  ..${Math.min(i + 200, updates.length)}/${updates.length}`);
  }
  log(`DONE. building_type set on ${updates.length} orders`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
