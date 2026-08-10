#!/usr/bin/env node
/* Find the fabric SERIES that exist twice, and cost out merging them.

   WHY. `refresh-sofa-colours.mjs` bound "HR805-90" to `FABRIC HR805` and
   "HR805-30" to `HR805` in the same run - one physical fabric series, two
   fabric_library ids, live document lines split across both. The picker then
   shows the same fabric twice and a report that groups by fabric_id splits one
   series' history in half.

   HOW A DUPLICATE IS DETECTED - by the COLOUR, never by the series name.
   Two series are duplicates when they hold the same colour CODE. The code is
   the colour with its trailing colour NAME peeled off ("STAR-01 SILVER GREY" ->
   "STAR-01"), folded the same way the matcher folds, and taken from BOTH the
   colour_id and the label, because the brand sits in one and not the other
   ("ARMANI J9226-02 BUTTER CREAM" vs label "J9226-02 BUTTER CREAM" vs the other
   series' "J9226-2"). A leading brand word is dropped as a second candidate for
   the same reason. Naming alone would have missed AVANI / "AVANI 01" and caught
   nothing that the colours do not already prove.

   WHICH SIDE IS CANONICAL. The one PRODUCTION references more - counted off the
   live document lines (`variants->>'fabricId'`), not off the library. Ties go to
   the series holding more colours, then to the shorter id. The point is to move
   the fewest live rows.

   THIS SCRIPT NEVER WRITES. Merging a series repoints which colour a live
   document names, so it is the owner's call, not a script's. There is no APPLY
   path here on purpose: it prints the plan, the counts and the exposure, and
   stops. Read-only, one connection, no transaction. */
import postgres from "postgres";
import { normColour, foldColour } from "./lib/fabric-colour-match.mjs";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const CO = Number(process.env.COMPANY || 1);

// the matcher's rung 3, re-derived: peel trailing colour NAMES off a code
const dropName = (s) => {
  let v = s, m;
  while ((m = /^(.+?)[\s-]+[A-Z]+$/.exec(v)) && /\d/.test(m[1]) && /[A-Z]/.test(m[1])) v = m[1].trim();
  return v;
};
const padTail = (x) => x.replace(/(?<!\d)(\d)$/, "0$1");
const dropBrand = (s) => s.replace(/^[A-Z]+\s+(?=[A-Z]*\d)/, "");

/* every key this colour could be recognised by, from colour_id AND label */
const codeKeys = (r) => {
  const out = new Set();
  for (const src of [r.colour_id, r.label]) {
    if (!src) continue;
    const base = dropName(normColour(src));
    for (const v of [base, dropBrand(base)]) {
      const f = foldColour(v);
      if (f && /\d/.test(f) && f.length >= 3) { out.add(f); out.add(padTail(f)); }
    }
  }
  return [...out];
};

async function main() {
  const cols = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const libs = await sql`SELECT id, label, tier, default_surcharge FROM scm.fabric_library WHERE company_id = ${CO}`;
  note(`library: ${libs.length} series / ${cols.length} colours (company ${CO})`);

  /* live references, per series and per colour. These are the five keys the SO
     importer and refresh-sofa-colours write; fabricId is the series. */
  const refRows = await sql`
    SELECT src, fabric_id, colour_id, COUNT(*)::int AS n FROM (
      SELECT 'SO' AS src, i.variants->>'fabricId' AS fabric_id, i.variants->>'fabricCode' AS colour_id
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${CO} AND COALESCE(i.variants->>'fabricId','') <> ''
      UNION ALL
      SELECT 'PO', i.variants->>'fabricId', i.variants->>'fabricCode'
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
       WHERE h.company_id = ${CO} AND COALESCE(i.variants->>'fabricId','') <> ''
    ) t GROUP BY src, fabric_id, colour_id`;

  /* A fabric_id may itself contain a space ("AVANI 01", "FABRIC HR805"), so a
     space-joined composite key is not reversible. JSON keys both parts unambiguously. */
  const pk2 = (a, b) => JSON.stringify([a, b]);

  const bySeries = new Map(), byColour = new Map();
  for (const r of refRows) {
    bySeries.set(r.fabric_id, (bySeries.get(r.fabric_id) || 0) + r.n);
    byColour.set(pk2(r.fabric_id, r.colour_id), (byColour.get(pk2(r.fabric_id, r.colour_id)) || 0) + r.n);
  }
  const totalRefs = refRows.reduce((a, r) => a + r.n, 0);
  note(`live bound document lines: ${totalRefs} (across ${bySeries.size} series)`);

  const colsBySeries = new Map();
  for (const r of cols) {
    if (!colsBySeries.has(r.fabric_id)) colsBySeries.set(r.fabric_id, []);
    colsBySeries.get(r.fabric_id).push(r);
  }

  /* key -> which series carry a colour with that key */
  const keyToSeries = new Map();
  for (const r of cols) for (const k of codeKeys(r)) {
    if (!keyToSeries.has(k)) keyToSeries.set(k, new Map());
    keyToSeries.get(k).set(r.fabric_id, r);
  }

  // series pair -> the colours that collide
  const pairs = new Map();
  for (const [k, m] of keyToSeries) {
    if (m.size < 2) continue;
    const ids = [...m.keys()].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const pk = pk2(ids[i], ids[j]);
      if (!pairs.has(pk)) pairs.set(pk, []);
      pairs.get(pk).push([k, m.get(ids[i]), m.get(ids[j])]);
    }
  }

  note(`\n=== DUPLICATE SERIES PAIRS: ${pairs.size} ===`);
  const plan = [];
  for (const [pk, hits] of [...pairs].sort((a, b) => b[1].length - a[1].length)) {
    const [a, b] = JSON.parse(pk);
    const ra = bySeries.get(a) || 0, rb = bySeries.get(b) || 0;
    const ca = (colsBySeries.get(a) || []).length, cb = (colsBySeries.get(b) || []).length;
    // canonical: most live references, then most colours, then shorter id
    const aWins = ra !== rb ? ra > rb : ca !== cb ? ca > cb : a.length <= b.length;
    const [keep, drop] = aWins ? [a, b] : [b, a];
    const keepRefs = aWins ? ra : rb, dropRefs = aWins ? rb : ra;
    plan.push({ keep, drop, keepRefs, dropRefs, hits, keepCols: aWins ? ca : cb, dropCols: aWins ? cb : ca });
    note(`\n  "${keep}"  <=  "${drop}"     [${hits.length} shared colour code${hits.length === 1 ? "" : "s"}]`);
    note(`      KEEP  "${keep}"  ${keepRefs} live line${keepRefs === 1 ? "" : "s"}, ${aWins ? ca : cb} colours`);
    note(`      DROP  "${drop}"  ${dropRefs} live line${dropRefs === 1 ? "" : "s"}, ${aWins ? cb : ca} colours`);
    for (const [k, ra2, rb2] of hits.slice(0, 6)) {
      const from = aWins ? rb2 : ra2, to = aWins ? ra2 : rb2;
      const n = byColour.get(pk2(from.fabric_id, from.colour_id)) || 0;
      note(`        ${k}: "${from.colour_id}" -> "${to.colour_id}"   (${n} live line${n === 1 ? "" : "s"} move)`);
    }
    if (hits.length > 6) note(`        ... and ${hits.length - 6} more`);
  }

  const movedLines = plan.reduce((a, p) => a + p.dropRefs, 0);
  const droppedSeries = new Set(plan.map((p) => p.drop));
  note(`\n=== EXPOSURE IF MERGED ===`);
  note(`  series removed:                 ${droppedSeries.size} of ${libs.length}`);
  note(`  live document lines repointed:  ${movedLines} of ${totalRefs}`);
  note(`  lines NOT touched:              ${totalRefs - movedLines}`);

  /* the same disease inside ONE series: two rows for one colour code. Not a
     series merge, so not in the plan above - but it is why a picker shows
     "CH141-1" and "CH141-1-CREAM" as two choices for one fabric. */
  let within = 0;
  const withinEg = [];
  for (const [series, list] of colsBySeries) {
    const seen = new Map();
    for (const r of list) for (const k of codeKeys(r)) {
      if (seen.has(k) && seen.get(k) !== r.colour_id) {
        within++;
        if (withinEg.length < 12) withinEg.push(`${series}: "${seen.get(k)}" = "${r.colour_id}"`);
        break;
      }
      seen.set(k, r.colour_id);
    }
  }
  note(`\n=== SECONDARY: duplicate COLOURS inside one series: ${within} ===`);
  for (const e of withinEg) note(`  ${e}`);
  if (within > withinEg.length) note(`  ... and ${within - withinEg.length} more`);

  note(`\nREAD-ONLY: nothing was written. Merging is an owner decision.`);
}
main().then(() => sql.end({ timeout: 5 })).catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
