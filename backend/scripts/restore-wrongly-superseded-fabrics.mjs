#!/usr/bin/env node
/* Bring back the fabric colours that were superseded onto a code that does not
   exist - they were never duplicates.

   WHAT HAPPENED, and it is mine. normalize-fabric-codes read the colour number
   as \d{1,3} on 2026-08-11. So NOVENA-1001, NOVENA-1002 ... NOVENA-1008 all
   parsed as "series NOVENA, colour 100, name 1/2/...". The script concluded
   they were EIGHT SPELLINGS OF ONE COLOUR, kept one and deactivated the rest,
   each stamped "[superseded by NOVENA-100 on 2026-08-11]". The same happened to
   MERINO (10 colours), POLAR (7), GORGE (6) and LAMB VELVET (7).

   They are not spellings of one colour. They are different colours, and the
   code they were superseded ONTO - NOVENA-100 - was itself the truncation
   artefact, since repaired away. Owner: "不要停用吧，全部 active 回来".

   THE SIGNATURE, which is why this is a repair and not a bulk undo:

     the row is inactive, its label says "[superseded by X on ...]", and X is
     NOT an active colour today.

   A supersede whose target is alive was a REAL merge - "CH141-8" into
   "CH141-08", "AM275-2-BEIGE" into "AM275-02" - and the owner asked for those
   ("同个颜色的就merge起来"). Reviving one puts two active rows on one code,
   which is precisely what makes loadFabricByCode's .maybeSingle() error and the
   price tier silently drop. Those are counted and named, never touched. Set
   ALL=1 to revive them too, which is an explicit decision, not a default.

   The same rule runs over scm.fabric_trackings, whose merge note reads
   "[merged into X on ...]".

   MODE=plan (default) prints and writes nothing.
   MODE=apply writes, and needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". */
import postgres from "postgres";
import { normColour } from "./lib/fabric-colour-match.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const ALL = process.env.ALL === "1";
if (APPLY && process.env.CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error('apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN"');
  process.exit(1);
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

const NOTE_RE = /\s*\[(?:superseded by|merged into)\s+([^\]\s]+)\s+on\s+[^\]]*\]\s*$/i;

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  note(`MODE=${MODE} company=${CO} ALL=${ALL ? "1 (revive real merges too)" : "0"}`);

  const cols = await sql`SELECT fabric_id, colour_id, label, active
                           FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const trk = await sql`SELECT id, fabric_code, fabric_description, is_active
                          FROM scm.fabric_trackings WHERE company_id = ${CO}`;
  const liveColour = new Set(cols.filter((r) => r.active !== false).map((r) => normColour(r.colour_id)));
  const liveCode = new Set(trk.filter((r) => r.is_active !== false).map((r) => normColour(r.fabric_code)));

  const pick = (rows, idOf, labelOf, live) => {
    const orphanTarget = [], realMerge = [], noNote = [];
    for (const r of rows) {
      const m = NOTE_RE.exec(labelOf(r) || "");
      if (!m) { noNote.push(r); continue; }
      const target = normColour(m[1]);
      const clean = (labelOf(r) || "").replace(NOTE_RE, "").trim() || idOf(r);
      (live.has(target) ? realMerge : orphanTarget).push({ r, target, clean });
    }
    return { orphanTarget, realMerge, noNote };
  };

  const C = pick(cols.filter((r) => r.active === false), (r) => r.colour_id, (r) => r.label, liveColour);
  const T = pick(trk.filter((r) => r.is_active === false), (r) => r.fabric_code, (r) => r.fabric_description, liveCode);

  note("");
  note("=== fabric_colours ===");
  note(`  inactive rows: ${cols.filter((r) => r.active === false).length}`);
  note(`  SUPERSEDED ONTO A CODE THAT NO LONGER EXISTS - never a duplicate, revive: ${C.orphanTarget.length}`);
  note(`  superseded onto a LIVE code - a real merge, left alone${ALL ? " (but ALL=1, so revived)" : ""}: ${C.realMerge.length}`);
  note(`  inactive with no supersede note at all, left alone: ${C.noNote.length}`);
  for (const x of C.orphanTarget) note(`     revive "${x.r.colour_id}" -> label ${JSON.stringify(x.clean)}   (was superseded by "${x.target}", which is not an active colour)`);

  note("");
  note("=== fabric_trackings ===");
  note(`  inactive rows: ${trk.filter((r) => r.is_active === false).length}`);
  note(`  merged into a code that no longer exists, revive: ${T.orphanTarget.length}`);
  note(`  merged into a LIVE code - a real merge, left alone${ALL ? " (but ALL=1, so revived)" : ""}: ${T.realMerge.length}`);
  note(`  inactive with no merge note, left alone: ${T.noNote.length}`);
  for (const x of T.orphanTarget) note(`     revive "${x.r.fabric_code}" (was merged into "${x.target}")`);

  const colDo = ALL ? [...C.orphanTarget, ...C.realMerge] : C.orphanTarget;
  const trkDo = ALL ? [...T.orphanTarget, ...T.realMerge] : T.orphanTarget;

  /* Reviving a real merge puts two ACTIVE rows on one tracking code, and that
     is the shape loadFabricByCode warns about: .maybeSingle() errors and the
     fabric tier surcharge silently drops. Say so before doing it. */
  if (ALL && T.realMerge.length) {
    const codes = new Map();
    for (const x of T.realMerge) codes.set(normColour(x.r.fabric_code), (codes.get(normColour(x.r.fabric_code)) || 0) + 1);
    const collide = [...codes].filter(([c]) => liveCode.has(c));
    if (collide.length) {
      note("");
      note(`  WARNING - ALL=1 will put a SECOND active row on ${collide.length} tracking code(s). The price-tier`);
      note("  read resolves a duplicate by erroring, and the surcharge drops without a message.");
      for (const [c, n] of collide.slice(0, 20)) note(`     "${c}" would have ${n + 1} active rows`);
    }
  }

  if (!APPLY) {
    note("");
    note(`PLAN ONLY - would revive ${colDo.length} colour(s) and ${trkDo.length} tracking row(s). MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" to write.`);
    await sql.end({ timeout: 5 });
    return;
  }

  note("");
  note("--- APPLY ---");
  let c = 0, t = 0;
  await sql.begin(async (tx) => {
    for (const x of colDo) {
      await tx`UPDATE scm.fabric_colours SET active = true, label = ${x.clean}
                WHERE company_id = ${CO} AND fabric_id = ${x.r.fabric_id} AND colour_id = ${x.r.colour_id}`;
      c++;
    }
    for (const x of trkDo) {
      await tx`UPDATE scm.fabric_trackings SET is_active = true, fabric_description = ${x.clean}
                WHERE company_id = ${CO} AND id = ${x.r.id}`;
      t++;
    }
  });
  note(`  colours revived ${c} | tracking rows revived ${t}`);

  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let fails = 0;
  try {
    note("");
    note("--- VERIFY (fresh connection) ---");
    const after = await v`SELECT fabric_id, colour_id, label, active FROM scm.fabric_colours WHERE company_id = ${CO}`;
    for (const x of colDo) {
      const r = after.find((y) => y.fabric_id === x.r.fabric_id && y.colour_id === x.r.colour_id);
      if (!r || r.active === false) { fails++; bad(`"${x.r.colour_id}" is still inactive`); }
      else if (NOTE_RE.test(r.label || "")) { fails++; bad(`"${x.r.colour_id}" still carries the supersede note`); }
    }
    const dup = await v`SELECT fabric_code, COUNT(*)::int AS n FROM scm.fabric_trackings
                         WHERE company_id = ${CO} AND is_active GROUP BY 1 HAVING COUNT(*) > 1`;
    note(`  tracking codes on more than one ACTIVE row (must be 0): ${dup.length}`);
    for (const d of dup) note(`     "${d.fabric_code}" x${d.n}`);
    if (dup.length) fails++;
    const stillOrphan = after.filter((r) => r.active === false && NOTE_RE.test(r.label || "") &&
      !after.some((y) => y.active !== false && normColour(y.colour_id) === normColour(NOTE_RE.exec(r.label)[1])));
    note(`  colours still superseded onto a dead code (must be 0): ${stillOrphan.length}`);
    if (stillOrphan.length) fails++;
    note(`  VERIFY ${fails === 0 ? "PASS" : `FAILED with ${fails} problem(s)`}`);
  } finally { await v.end({ timeout: 5 }); }
  await sql.end({ timeout: 5 });
  if (fails) process.exit(1);
}

main().catch((e) => { bad(e.message); process.exit(1); });
