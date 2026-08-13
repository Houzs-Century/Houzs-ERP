#!/usr/bin/env node
// Make the Fabric Converter say what the SELLING LIBRARY says, for named codes.
//
// WHY THIS IS A SEPARATE SCRIPT FROM tidy-fabric-descriptions.mjs: that one
// normalises each side's TEXT SHAPE (`<CODE> <COLOUR NAME>`) using the row's own
// words. It cannot reconcile the two sides when they disagree about WHICH COLOUR
// a code is, because nothing in the data says which is right. That is an owner
// ruling, and on 2026-08-12 the owner gave it: "跟着POS的" - follow the selling
// library.
//
// The disagreement it settles, measured on production after the shape tidy:
//
//   code        Converter (cost side)   Selling library (POS)
//   BO315-21    PHEONIEX-02             BO315-21 PEARL
//   BO315-23    PHOENIX LITE-01         BO315-23 BEIGE
//   BO315-24    BO315-24 FABRIC         BO315-24 SAND
//
// BO315 runs the same twelve colours twice (-01..-12 and -21..-32). Every other
// code in both runs already agrees; these three are the stragglers. The library
// carries the full correct sequence, which is why it wins - and why the owner
// ruled the way he did.
//
// COPIES, NEVER COMPUTES. The new description is the library's label verbatim.
// A code with no library row, or an empty label, is REPORTED and left alone -
// this script has no opinion of its own about what a colour is called.
//
// CODES ARE NOT TOUCHED. Only fabric_trackings.fabric_description.
//
// plan (default) writes nothing. apply needs CONFIRM='I HAVE REVIEWED THE DRY-RUN'.

import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
const CO = Number(process.env.COMPANY_ID || 1);
const CODES = (process.env.CODES || "BO315-21,BO315-23,BO315-24")
  .split(",").map((s) => s.trim()).filter(Boolean);

const CODE_RE = /^[A-Za-z0-9()#/\- ]{1,48}$/;
for (const c of CODES) {
  if (!CODE_RE.test(c)) { console.error(`CODES contains '${c}', which is not a valid fabric code`); process.exit(2); }
}
if (MODE === "apply" && process.env.CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error("MODE=apply requires CONFIRM='I HAVE REVIEWED THE DRY-RUN'");
  process.exit(2);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const out = (s = "") => console.log(s);

async function main() {
  if (MODE !== "apply") await sql.unsafe("SET default_transaction_read_only = on");
  out(`=== Converter follows the selling library — MODE=${MODE} company=${CO} ===`);
  out(`codes: ${CODES.join(", ")}`);
  out(`CODES ARE NOT TOUCHED. Only fabric_trackings.fabric_description.\n`);

  const todo = [];
  for (const code of CODES) {
    const [t] = await sql`
      SELECT fabric_code, fabric_description, is_active
        FROM scm.fabric_trackings WHERE company_id = ${CO} AND fabric_code = ${code}`;
    if (!t) { out(`SKIP   ${code} — not in the Converter`); continue; }
    const [c] = await sql`
      SELECT colour_id, label FROM scm.fabric_colours
       WHERE company_id = ${CO} AND upper(colour_id) = upper(${code})`;
    if (!c) { out(`REPORT ${code} — no selling-library row; nothing to copy from`); continue; }
    const want = String(c.label ?? "").trim();
    if (!want) { out(`REPORT ${code} — library label is empty; nothing to copy`); continue; }
    const have = String(t.fabric_description ?? "").trim();
    if (have === want) { out(`OK     ${code} — already agrees (${JSON.stringify(want)})`); continue; }
    todo.push({ code, have, want, retired: t.is_active === false });
    out(`CHANGE ${code}${t.is_active === false ? "  [RETIRED row]" : ""}`);
    out(`         converter: ${JSON.stringify(have)}`);
    out(`         library  : ${JSON.stringify(want)}   <- becomes this`);
  }

  if (!todo.length) { out("\nNothing to change."); await sql.end(); return; }

  if (MODE !== "apply") {
    out(`\nPLAN ONLY — nothing was written. ${todo.length} row(s) would change.`);
    out(`Re-run with MODE=apply CONFIRM='I HAVE REVIEWED THE DRY-RUN' to write.`);
    await sql.end();
    return;
  }

  for (const t of todo) {
    await sql`
      UPDATE scm.fabric_trackings SET fabric_description = ${t.want}
       WHERE company_id = ${CO} AND fabric_code = ${t.code}`;
  }
  out(`\nAPPLIED ${todo.length} row(s).`);
  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
