#!/usr/bin/env node
/* Re-align scm.fabric_trackings with scm.fabric_colours, and fill its series.

   WHY THIS EXISTS, stated plainly because it is a defect I introduced.

   normalize-fabric-codes.mjs (run 31470428224) rewrote colour codes in
   scm.fabric_colours and repointed 267 live document lines' variants->>'fabricCode'
   onto the new strings. seed-owner-fabric-catalogue.mjs had already moved 227
   more. What neither touched is scm.fabric_trackings - the "Fabric Converter"
   master - whose fabric_code is THE SAME STRING by construction:

     fabric-tracking.ts:74-82, on create, mirrors the tracking row into the
     selling library with colour_id = the fabric_code itself.

   And that column is not decoration. It is the join key for the PRICE TIER:

     mfg-sales-orders.ts:7209        sofa combo tier
     mfg-purchase-orders.ts:1903,3750
     consignment-orders.ts:1404
     po-pricing.ts:171
     mfg-pricing-recompute.ts:879,895 (loadFabricByCode / loadFabricsByCodes)

   A line whose fabricCode no longer matches any tracking row does not error.
   mfg-sales-orders.ts says it in its own comment: an empty tier map "does not
   skip the combo, it makes every fabric fall to the PRICE_2 default - so a
   failed read would pick a REAL combo at the WRONG tier and write that cost to
   the header as fact". Silent, and in the money path.

   The owner, when shown the Converter screen: "两边一定要一样的啊".

   SECTION 1 IS THE MEASUREMENT, and it runs in plan mode too: how many live
   document lines carry a fabricCode with no tracking row behind it. That number
   is the blast radius of the defect, taken from production rather than reasoned
   about.

   WHAT IT WILL NOT DO. If two tracking rows normalise onto one code, only the
   better-informed one is rewritten and the other is REPORTED, never merged and
   never deleted. fabric_trackings has no active flag to supersede into, and
   fabric_code carries a non-unique index - loadFabricByCode already warns that a
   duplicate makes .maybeSingle() error and "the fabric tier surcharge silently
   drops". Creating a duplicate to tidy a code would be trading a visible mess
   for an invisible one, on the money path.

   MODE=plan (default) prints and writes nothing.
   MODE=apply writes, and needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". */
import postgres from "postgres";
import { normColour } from "./lib/fabric-colour-match.mjs";
import { ARMS, sum } from "./lib/fabric-write.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
if (APPLY && process.env.CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error('apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN"');
  process.exit(1);
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

/* The series token, exactly as normalize-fabric-codes derives it: separators
   collapse to one dash, nothing is added or removed. Deriving it any other way
   here is how the two halves drift apart again. */
const seriesOfCode = (code) => {
  const v = normColour(code);
  const m = /^(.+)[\s\-]+\d{1,3}$/.exec(v) || /^([A-Z][A-Z0-9\- ]*?)[\s\-]*\d{1,3}$/.exec(v);
  const head = m ? m[1] : v;
  return head.replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
};

const tierOf = (r) => [r.sofa_price_tier, r.bedframe_price_tier, r.price_tier].filter(Boolean).join("/");
const informedness = (r) =>
  (tierOf(r) ? 4 : 0) + (r.supplier_code ? 2 : 0) + ((r.fabric_description || "").length > 0 ? 1 : 0);

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  note(`MODE=${MODE} company=${CO}`);

  const trk = await sql`SELECT id, fabric_code, fabric_description, series, supplier_code,
                               price_tier, sofa_price_tier, bedframe_price_tier
                          FROM scm.fabric_trackings WHERE company_id = ${CO}`;
  const cols = await sql`SELECT colour_id, label, active FROM scm.fabric_colours WHERE company_id = ${CO}`;
  note(`fabric_trackings: ${trk.length} rows | fabric_colours: ${cols.length} rows`);

  /* ---- 1. THE BLAST RADIUS, measured on production ---------------------- */
  note("");
  note("=== 1. LIVE LINES WHOSE fabricCode HAS NO TRACKING ROW (the price-tier join) ===");
  const trkCodes = new Set(trk.map((r) => normColour(r.fabric_code)));
  const perArm = [];
  const orphanCounts = new Map();
  for (const arm of ARMS) {
    const rows = await sql.unsafe(
      `SELECT i.variants->>'fabricCode' AS code, COUNT(*)::int AS n
         FROM ${arm.t} i
        WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
          AND COALESCE(i.variants->>'fabricCode', '') <> ''
        GROUP BY 1`, [CO]);
    let hit = 0, miss = 0;
    for (const r of rows) {
      if (trkCodes.has(normColour(r.code))) hit += r.n;
      else { miss += r.n; orphanCounts.set(r.code, (orphanCounts.get(r.code) || 0) + r.n); }
    }
    perArm.push({ arm: arm.name, hit, miss });
    note(`  ${arm.name}: lines with a fabricCode ${hit + miss} | resolve to a tracking row ${hit} | ORPHANED ${miss}`);
  }
  const totalMiss = perArm.reduce((a, b) => a + b.miss, 0);
  note(`  TOTAL ORPHANED LINES: ${totalMiss} across ${orphanCounts.size} distinct code(s)`);
  if (orphanCounts.size) {
    note("  each orphaned code, with how many lines sit on it:");
    for (const [code, n] of [...orphanCounts].sort((a, b) => b[1] - a[1])) note(`     ${String(code).padEnd(24)} ${n}`);
  }

  /* ---- 2. WHAT THE TRACKING TABLE SHOULD SAY ---------------------------- */
  const canonical = new Map();
  for (const r of cols) if (r.active !== false) canonical.set(normColour(r.colour_id), r);

  const rewrite = [], fillSeries = [], dupes = [], unknown = [];
  const byTarget = new Map();

  for (const r of trk) {
    const code = normColour(r.fabric_code);
    /* The library is the authority: normalize-fabric-codes already drove it to
       the owner's shape. A tracking code that is already in it is correct. */
    if (canonical.has(code)) {
      const want = seriesOfCode(code);
      if (normColour(r.series || "") !== want) fillSeries.push({ r, want });
      continue;
    }
    /* Not in the library. Find what the library renamed it to, by matching on
       the label the library kept - the rewrite preserved the colour NAME, so a
       tracking code "AM275-2-BEIGE" is findable as the library row whose label
       is "AM275-02 BEIGE". Nothing is guessed: no match means it is reported. */
    const wantSeries = seriesOfCode(code);
    const nameless = code.replace(/[^A-Z0-9]/g, "");
    let hit = null;
    for (const [cid, row] of canonical) {
      const lab = normColour(row.label || "").replace(/[^A-Z0-9]/g, "");
      const cidFlat = cid.replace(/[^A-Z0-9]/g, "");
      if (lab === nameless || cidFlat === nameless || lab.replace(/\s/g, "") === nameless) { hit = row; break; }
    }
    if (!hit) { unknown.push(r); continue; }
    const target = normColour(hit.colour_id);
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push(r);
    rewrite.push({ r, target, label: hit.label, series: seriesOfCode(target) });
  }

  /* One target, two tracking rows - keep the better-informed one, report the
     other. See the header: a duplicate fabric_code is worse than an untidy one. */
  const keep = new Set();
  for (const [target, rows] of byTarget) {
    if (canonical.has(target) && trkCodes.has(target)) {
      dupes.push({ target, rows, reason: "a tracking row already carries that code" });
      continue;
    }
    if (rows.length === 1) { keep.add(rows[0].id); continue; }
    const sorted = [...rows].sort((a, b) => informedness(b) - informedness(a) || String(a.id).localeCompare(String(b.id)));
    keep.add(sorted[0].id);
    const tiers = new Set(rows.map(tierOf).filter(Boolean));
    dupes.push({ target, rows: sorted.slice(1), reason: tiers.size > 1 ? "TIERS DISAGREE - do not merge blind" : "same colour, two rows" });
  }
  const doRewrite = rewrite.filter((x) => keep.has(x.r.id));

  note("");
  note("=== 2. PLAN ===");
  note(`  codes to rewrite: ${doRewrite.length} | series to fill: ${fillSeries.length}`);
  note(`  duplicates left for a person: ${dupes.reduce((a, d) => a + d.rows.length, 0)}`);
  note(`  tracking codes the library does not know: ${unknown.length}`);

  if (doRewrite.length) {
    note("");
    note(`--- REWRITE (${doRewrite.length}) ---`);
    for (const x of doRewrite) note(`  "${x.r.fabric_code}" -> "${x.target}" / ${JSON.stringify(x.label)}  series="${x.series}"`);
  }
  if (fillSeries.length) {
    note("");
    note(`--- SERIES FILLED, code already correct (${fillSeries.length}) ---`);
    for (const x of fillSeries.slice(0, 40)) note(`  ${String(x.r.fabric_code).padEnd(22)} series="${x.want}"${x.r.series ? ` (was ${JSON.stringify(x.r.series)})` : " (was empty)"}`);
    if (fillSeries.length > 40) note(`  ... and ${fillSeries.length - 40} more`);
  }
  if (dupes.length) {
    note("");
    note(`--- DUPLICATES, NOT TOUCHED (${dupes.length} groups) ---`);
    for (const d of dupes) {
      note(`  ${d.target}: ${d.reason}`);
      for (const r of d.rows) note(`      id=${r.id} code="${r.fabric_code}" desc=${JSON.stringify(r.fabric_description)} tiers="${tierOf(r) || "-"}"`);
    }
  }
  if (unknown.length) {
    note("");
    note(`--- THE LIBRARY DOES NOT KNOW THESE CODES, left alone (${unknown.length}) ---`);
    for (const r of unknown.slice(0, 40)) note(`  ? "${r.fabric_code}" ${JSON.stringify(r.fabric_description)} tiers="${tierOf(r) || "-"}"`);
    if (unknown.length > 40) note(`  ... and ${unknown.length - 40} more`);
  }

  if (!APPLY) {
    note("");
    note('PLAN ONLY - nothing was written. MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" to write.');
    await sql.end({ timeout: 5 });
    return;
  }

  note("");
  note("--- APPLY ---");
  let wrote = 0, filled = 0;
  await sql.begin(async (tx) => {
    for (const x of doRewrite) {
      /* fabric_trackings.id is a text PK that HAPPENS to equal the code by
         minting convention. It is not rewritten: upserts and deletes key off
         it, and a PK change is a different, riskier operation than fixing the
         column the joins actually read. */
      await tx`UPDATE scm.fabric_trackings
                  SET fabric_code = ${x.target}, fabric_description = ${x.label}, series = ${x.series}
                WHERE company_id = ${CO} AND id = ${x.r.id}`;
      wrote++;
    }
    for (const x of fillSeries) {
      await tx`UPDATE scm.fabric_trackings SET series = ${x.want}
                WHERE company_id = ${CO} AND id = ${x.r.id}`;
      filled++;
    }
  });
  note(`  codes rewritten ${wrote} | series filled ${filled}`);

  /* Verify on a SECOND, FRESH connection, and verify the thing that matters:
     the join is whole again. */
  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let fails = 0;
  try {
    note("");
    note("--- VERIFY (fresh connection) ---");
    const after = await v`SELECT fabric_code FROM scm.fabric_trackings WHERE company_id = ${CO}`;
    const now = new Set(after.map((r) => normColour(r.fabric_code)));
    let left = 0;
    for (const arm of ARMS) {
      const rows = await v.unsafe(
        `SELECT i.variants->>'fabricCode' AS code, COUNT(*)::int AS n
           FROM ${arm.t} i
          WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
            AND COALESCE(i.variants->>'fabricCode', '') <> ''
          GROUP BY 1`, [CO]);
      const miss = rows.filter((r) => !now.has(normColour(r.code))).reduce((a, r) => a + r.n, 0);
      note(`  ${arm.name}: lines still orphaned from the tier join: ${miss}`);
      left += miss;
    }
    note(`  TOTAL still orphaned: ${left} (was ${totalMiss} before this run)`);
    if (left > totalMiss) { fails++; bad("this run made the orphan count WORSE"); }
    const dupNow = await v`SELECT fabric_code, COUNT(*)::int AS n FROM scm.fabric_trackings
                            WHERE company_id = ${CO} GROUP BY 1 HAVING COUNT(*) > 1`;
    note(`  tracking codes carried by more than one row: ${dupNow.length}`);
    for (const d of dupNow) note(`     "${d.fabric_code}" x${d.n}`);
    note(`  VERIFY ${fails === 0 ? "PASS" : `FAILED with ${fails} problem(s)`}`);
  } finally { await v.end({ timeout: 5 }); }
  await sql.end({ timeout: 5 });
  if (fails) process.exit(1);
}

main().catch((e) => { bad(e.message); process.exit(1); });
