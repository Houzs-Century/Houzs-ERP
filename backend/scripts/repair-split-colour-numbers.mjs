#!/usr/bin/env node
/* Put back the colour numbers the 2026-08-11 normalisation cut in half.

   WHAT WENT WRONG. normalize-fabric-codes.mjs read the colour number with
   \d{1,3}. A four-digit number does not fit that, so the lazy branch of the
   split took the first three digits as the number and left the fourth as the
   colour NAME:

     NOVENA-1003       ->  NOVENA-100        labelled "NOVENA-100 3"
     LAMB VELVET-2005  ->  LAMB-VELVET-200   labelled "LAMB-VELVET-200 5"
     GORGE-3003        ->  GORGE-300         labelled "GORGE-300 3"
     POLAR-5002        ->  POLAR-500         labelled "POLAR-500 2"
     MERINO-4005       ->  MERINO-400        labelled "MERINO-400 5"
     MERINO-4010       ->  MERINO-401        labelled "MERINO-401 0"

   Run 31470428224 wrote those to production, and repointed live document lines
   onto the truncated strings with them. The rule is fixed for the future in the
   same PR; this puts the rows that were already written back.

   HOW A DAMAGED ROW IS RECOGNISED - by its own fingerprint, not by a list.
   The colour LABEL is the code followed by a name that is nothing but digits.
   No real colour is called "3". Gluing the label's digits back onto the code
   reproduces the original string exactly, which is why this is a repair and not
   a guess: NOVENA-100 + "3" is NOVENA-1003, and nothing else it could be.

   Everything else follows the rules the other fabric scripts already keep:
   live lines are repointed on all four arms through lib/fabric-write, the
   jsonb write is jsonb_set + to_jsonb($1::text), and a row that has to give way
   is deactivated rather than deleted.

   MODE=plan (default) prints and writes nothing.
   MODE=apply writes, and needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". */
import postgres from "postgres";
import { normColour } from "./lib/fabric-colour-match.mjs";
import { repointColour, countColour, arrayShapeCheck, sum, busy } from "./lib/fabric-write.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
if (APPLY && process.env.CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error('apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN"');
  process.exit(1);
}
const STAMP = process.env.NOTE_DATE || "2026-08-11";
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

/* code + a label whose name part is only digits => the number was cut. */
const damaged = (colourId, label) => {
  const code = normColour(colourId);
  const lab = normColour(label || "");
  if (!lab.startsWith(code + " ")) return null;
  const tail = lab.slice(code.length + 1).trim();
  if (!/^\d+$/.test(tail)) return null;
  if (!/\d$/.test(code)) return null;          // the code must end in the digits we are extending
  return { restored: `${code}${tail}` };
};

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  note(`MODE=${MODE} company=${CO}`);

  const cols = await sql`SELECT fabric_id, colour_id, label, active
                           FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const trk = await sql`SELECT id, fabric_code, fabric_description
                          FROM scm.fabric_trackings WHERE company_id = ${CO}`;
  note(`fabric_colours ${cols.length} | fabric_trackings ${trk.length}`);

  const hits = [];
  for (const r of cols) {
    if (r.active === false) continue;
    const d = damaged(r.colour_id, r.label);
    if (!d) continue;
    const clash = cols.find((x) => normColour(x.colour_id) === d.restored && x.fabric_id === r.fabric_id);
    hits.push({ r, restored: d.restored, clash: !!clash, lines: sum(await countColour(sql, CO, r.colour_id)) });
  }

  note("");
  note(`=== DAMAGED BY THE 2026-08-11 SPLIT: ${hits.length} ===`);
  for (const h of hits) {
    note(`  "${h.r.colour_id}" / ${JSON.stringify(h.r.label)}  ->  "${h.restored}"  (${h.lines} live line(s))${h.clash ? "  CLASH - a row already holds the restored code, skipped" : ""}`);
  }
  const trkHits = trk.filter((t) => hits.some((h) => normColour(t.fabric_code) === normColour(h.r.colour_id)));
  note(`  matching Converter rows to fix alongside: ${trkHits.length}`);
  for (const t of trkHits) note(`     tracking id=${t.id} "${t.fabric_code}"`);

  const doIt = hits.filter((h) => !h.clash);
  if (!APPLY) {
    note("");
    note('PLAN ONLY - nothing was written. MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" to write.');
    await sql.end({ timeout: 5 });
    return;
  }

  note("");
  note("--- APPLY ---");
  let fixed = 0, moved = 0, trkFixed = 0;
  await sql.begin(async (tx) => {
    for (const h of doIt) {
      const from = h.r.colour_id;
      const r = await repointColour(tx, CO, from, h.restored);
      const n = sum(r);
      moved += n;
      if (n) note(`  repointed ${n}: "${from}" -> "${h.restored}" (${busy(r)})`);
      await tx`UPDATE scm.fabric_colours
                  SET colour_id = ${h.restored}, label = ${h.restored}
                WHERE company_id = ${CO} AND fabric_id = ${h.r.fabric_id} AND colour_id = ${from}`;
      fixed++;
      const t = trk.filter((x) => normColour(x.fabric_code) === normColour(from));
      for (const row of t) {
        await tx`UPDATE scm.fabric_trackings
                    SET fabric_code = ${h.restored}, fabric_description = ${h.restored}
                  WHERE company_id = ${CO} AND id = ${row.id}`;
        trkFixed++;
      }
    }
  });
  note(`  colours restored ${fixed} | Converter rows restored ${trkFixed} | live lines repointed ${moved}`);

  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let fails = 0;
  try {
    note("");
    note("--- VERIFY (fresh connection) ---");
    const after = await v`SELECT colour_id, label FROM scm.fabric_colours
                           WHERE company_id = ${CO} AND active`;
    for (const h of doIt) {
      if (!after.some((x) => normColour(x.colour_id) === h.restored)) { fails++; bad(`${h.restored} is not in the library`); }
      if (after.some((x) => normColour(x.colour_id) === normColour(h.r.colour_id))) { fails++; bad(`the truncated code "${h.r.colour_id}" is still active`); }
      const left = sum(await countColour(v, CO, h.r.colour_id));
      if (left) { fails++; bad(`${left} line(s) still name the truncated "${h.r.colour_id}"`); }
    }
    const stillCut = after.filter((x) => damaged(x.colour_id, x.label));
    note(`  rows still carrying a digit-only colour name (must be 0): ${stillCut.length}`);
    if (stillCut.length) fails++;
    for (const a of await arrayShapeCheck(v, CO)) {
      note(`  ${a.arm}: array-shaped variants blocks (must be 0): ${a.n}`);
      if (a.n) { fails++; bad(`${a.arm} holds ${a.n} array-shaped variants block(s)`); }
    }
    note(`  VERIFY ${fails === 0 ? "PASS" : `FAILED with ${fails} problem(s)`}`);
  } finally { await v.end({ timeout: 5 }); }
  await sql.end({ timeout: 5 });
  if (fails) process.exit(1);
}

main().catch((e) => { bad(e.message); process.exit(1); });
