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

   WHAT IT DOES, END TO END. Owner: tidy the Converter, merge what should be
   merged, finish it.
     1. measures the orphaned lines (above)
     2. rewrites each tracking code to the library's canonical form
     3. fills the series column, which is empty on every row today
     4. MERGES duplicate rows - the loser goes is_active = false with a note
        saying what absorbed it, never deleted, and the winner absorbs any tier
        or supplier code only the loser carried
     5. CREATES the master rows the library has no counterpart for - the 88
        codes opened from the owner's catalogue today, TR and DE among them,
        went into the library only and cannot be priced from the master screen

   THE ONE THING IT REFUSES. Two rows carrying DIFFERENT tiers are not a
   spelling difference, they are two answers to what the fabric costs. Printed,
   never merged. And a created row gets NO tier: a tier is a price, and this
   script does not know it.

   MODE=plan (default) prints and writes nothing.
   MODE=apply writes, and needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". */
import postgres from "postgres";
import { normColour } from "./lib/fabric-colour-match.mjs";
import { parse, seriesToken, canonId } from "./lib/fabric-code.mjs";
import { repointColour, busy } from "./lib/fabric-write.mjs";
import { ARMS as BASE_ARMS, sum } from "./lib/fabric-write.mjs";

/* The document number each arm shows a human, so an affected order can be
   opened rather than counted. Kept here and not in lib/fabric-write because it
   is a reporting concern, not part of the write contract. */
const DOC = {
  SO: "i.doc_no",
  PO: "(SELECT h2.po_number FROM scm.purchase_orders h2 WHERE h2.id = i.purchase_order_id)",
  GRN: "(SELECT h2.grn_number FROM scm.grns h2 WHERE h2.id = i.grn_id)",
  DO: "(SELECT h2.do_number FROM scm.delivery_orders h2 WHERE h2.id = i.delivery_order_id)",
};
const ARMS = BASE_ARMS.map((a) => ({ ...a, doc: DOC[a.name] }));

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

/* The series token comes from lib/fabric-code, never from a local copy. Its
   own copy of this rule is what called NOVENA-1003's series "NOVENA-1" after
   the number rule had already been fixed in the other script. */
const seriesOfCode = (code) => {
  const p = parse(code);
  return p ? p.series : seriesToken(code);
};

const tierOf = (r) => [r.sofa_price_tier, r.bedframe_price_tier, r.price_tier].filter(Boolean).join("/");
const informedness = (r) =>
  (tierOf(r) ? 4 : 0) + (r.supplier_code ? 2 : 0) + ((r.fabric_description || "").length > 0 ? 1 : 0);

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  note(`MODE=${MODE} company=${CO}`);

  const trk = await sql`SELECT id, fabric_code, fabric_description, series, supplier_code,
                               price_tier, sofa_price_tier, bedframe_price_tier, is_active
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

  /* ---- 1B. THE ORPHANED LINES THAT CAN BE PUT BACK ---------------------
     An orphaned code is not always a mystery. "CH141-1" is the pre-rename
     spelling of "CH141-01": the shared rule resolves it, and the canonical code
     is sitting in the library and in the Converter. Those lines were simply
     written after the repoint pass had already counted them, so they were left
     on the old string and stopped resolving to a price tier.

     Only a code whose canonical form EXISTS as an active tracking row is moved.
     Anything else stays orphaned and is reported - moving a line onto a code
     that does not exist would trade one silent miss for another. */
  const orphanFix = [];
  for (const [code, n] of orphanCounts) {
    const p = parse(code);
    if (!p) continue;
    const want = canonId(p);
    if (normColour(want) === normColour(code)) continue;
    if (!trkCodes.has(normColour(want))) continue;
    orphanFix.push({ from: code, to: want, lines: n });
  }
  if (orphanFix.length) {
    note("");
    note(`--- ORPHANED LINES THAT RESOLVE (${orphanFix.length} code(s)) ---`);
    for (const o of orphanFix) {
      note(`  "${o.from}" -> "${o.to}"  (${o.lines} line(s))`);
      for (const arm of ARMS) {
        const docs = await sql.unsafe(
          `SELECT ${arm.doc} AS doc, COUNT(*)::int AS n
             FROM ${arm.t} i
            WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
              AND i.variants->>'fabricCode' = $2
            GROUP BY 1 ORDER BY 1`, [CO, o.from]);
        for (const d of docs) note(`       ${arm.name} ${d.doc}  ${d.n} line(s)`);
      }
    }
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
    /* Ask the SHARED rule first. Stripping the brand is precisely what it does,
       so "ARMANI J9226-02 BUTTER CREAM" resolves to J9226-02 in one step. The
       label comparison below only ever matched codes WITHOUT a brand prefix,
       which left all 303 brand-prefixed rows - ARMANI, AGAZZI, GIRONA, HIVE,
       HIRRING, PIERRO, PALERMO, ROLANDO, SANSONE, SANDRO, MORENO - reported as
       "the library does not know this", when the library knew every one of
       them. That is the exact set the owner pointed at. */
    let hit = null;
    const parsed = parse(code);
    if (parsed) {
      const want = canonId(parsed);
      if (canonical.has(want)) hit = canonical.get(want);
    }
    /* Fallback: match on the label the rename preserved, for codes the parser
       refuses (a colour number it cannot read, a name-only code). */
    if (!hit) {
      const nameless = code.replace(/[^A-Z0-9]/g, "");
      for (const [cid, row] of canonical) {
        const lab = normColour(row.label || "").replace(/[^A-Z0-9]/g, "");
        const cidFlat = cid.replace(/[^A-Z0-9]/g, "");
        if (lab === nameless || cidFlat === nameless || lab.replace(/\s/g, "") === nameless) { hit = row; break; }
      }
    }
    /* THE LIBRARY NOT KNOWING A CODE IS NOT A REASON TO LEAVE IT UNTIDY.
       Owner, on the Converter screen: "不会说今天突然有字母，明天突然没有字母".
       Tidiness is a property of the ROW - its code, its description, its series
       - and it does not depend on whether a selling-library colour happens to
       exist. Binding the two left 32 rows in the old shape, "LAMB VELVET-2002"
       with a space and an empty Series among them, sitting next to 386 tidy
       ones. That IS the inconsistency he is describing.

       So a row the library does not know is still driven to the same shape by
       the shared rule, and its library counterpart is minted so it becomes
       pickable too. Only a row the RULE cannot read stays untouched - and those
       are reported, as always. */
    if (!hit) {
      const own = parse(code);
      if (!own) { unknown.push(r); continue; }
      const target = canonId(own);
      const label = own.name ? `${target} ${own.name}` : target;
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push(r);
      rewrite.push({ r, target, label, series: own.series, mintLibrary: !canonical.has(normColour(target)) });
      continue;
    }
    const target = normColour(hit.colour_id);
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push(r);
    rewrite.push({ r, target, label: hit.label, series: seriesOfCode(target) });
  }

  /* One target, several tracking rows: MERGE them. The owner asked for it
     directly, and the table can carry it honestly because scm.fabric_trackings
     has is_active. The loser is DEACTIVATED, never deleted, exactly like a
     superseded colour, and the winner first absorbs anything the loser knew
     that it does not - a tier, a supplier code. Nothing is lost by the merge.

     The one case still refused: two rows carrying DIFFERENT tiers. That is not
     a spelling difference, it is two answers to what the fabric costs, and
     picking one silently is how a wrong price becomes a fact.

     Deactivating also fixes the hazard by itself: loadFabricByCode warns that a
     duplicate fabric_code makes .maybeSingle() error and the fabric tier
     surcharge silently drops. ONE ACTIVE ROW PER CODE is what the join needs. */
  const keep = new Set();
  const merges = [];
  for (const [target, rows] of byTarget) {
    const existing = trk.filter((r) => normColour(r.fabric_code) === target && !rows.some((x) => x.id === r.id));
    /* A row that is already is_active = false is SETTLED. Re-merging it stamps
       "[merged into X on D]" onto a description that already says so, and the
       note grows on every run. The 2026-08-11 re-plan reported all 67 pairs a
       second time for exactly this reason - correct detection, corrupting
       apply. Same guard the catalogue seeder needed. */
    const all = [...rows, ...existing].filter((r) => r.is_active !== false);
    if (all.length === 0) continue;
    if (all.length === 1) { keep.add(all[0].id); continue; }
    const tiers = new Set(all.map(tierOf).filter(Boolean));
    if (tiers.size > 1) {
      dupes.push({ target, rows: all, reason: "TIERS DISAGREE - not merged, a person has to say which price is right" });
      continue;
    }
    const sorted = [...all].sort((a, b) => informedness(b) - informedness(a) || String(a.id).localeCompare(String(b.id)));
    keep.add(sorted[0].id);
    merges.push({ target, win: sorted[0], lose: sorted.slice(1) });
  }
  const doRewrite = rewrite.filter((x) => keep.has(x.r.id));

  /* Every colour the library holds must exist in the Converter, because the
     Converter is the MASTER: fabric-tracking.ts mints a tracking row and mirrors
     it into the library, never the other way round. The 88 codes opened from the
     owner's catalogue today - all of TR and DE among them - went into the
     library only, so they cannot be found or priced on the master screen.
     Created here with NO tier: a tier is a price and this script does not know
     it. Every created row is printed so the owner can set them. */
  const trkNow = new Set(trk.filter((r) => r.is_active !== false).map((r) => normColour(r.fabric_code)));
  for (const x of doRewrite) trkNow.add(x.target);
  const create = [];
  for (const [cid, row] of canonical) {
    if (trkNow.has(cid)) continue;
    create.push({ code: cid, label: row.label || cid, series: seriesOfCode(cid) });
  }

  note("");
  note("=== 2. PLAN ===");
  note(`  codes to rewrite: ${doRewrite.length} | series to fill: ${fillSeries.length}`);
  note(`  duplicate rows to merge (loser deactivated, never deleted): ${merges.reduce((a, m) => a + m.lose.length, 0)}`);
  note(`  master rows to CREATE for library colours that have none: ${create.length}`);
  note(`  duplicates REFUSED because their tiers disagree: ${dupes.reduce((a, d) => a + d.rows.length, 0)}`);
  note(`  tracking codes the library does not know: ${unknown.length}`);

  if (doRewrite.length) {
    note("");
    note(`--- REWRITE (${doRewrite.length}) ---`);
    for (const x of doRewrite) note(`  "${x.r.fabric_code}" -> "${x.target}" / ${JSON.stringify(x.label)}  series="${x.series}"${x.mintLibrary ? "  + mint the library colour" : ""}`);
  }
  if (fillSeries.length) {
    note("");
    note(`--- SERIES FILLED, code already correct (${fillSeries.length}) ---`);
    for (const x of fillSeries.slice(0, 40)) note(`  ${String(x.r.fabric_code).padEnd(22)} series="${x.want}"${x.r.series ? ` (was ${JSON.stringify(x.r.series)})` : " (was empty)"}`);
    if (fillSeries.length > 40) note(`  ... and ${fillSeries.length - 40} more`);
  }
  if (merges.length) {
    note("");
    note(`--- MERGE (${merges.length} groups) - winner keeps the code, loser is deactivated ---`);
    for (const m of merges) {
      note(`  ${m.target}: keep id=${m.win.id} "${m.win.fabric_code}" tiers="${tierOf(m.win) || "-"}"`);
      for (const l of m.lose) note(`      deactivate id=${l.id} "${l.fabric_code}" desc=${JSON.stringify(l.fabric_description)} tiers="${tierOf(l) || "-"}"`);
    }
  }
  if (create.length) {
    note("");
    note(`--- CREATE IN THE CONVERTER (${create.length}) - no tier is invented, set them yourself ---`);
    for (const x of create.slice(0, 60)) note(`  + ${x.code.padEnd(18)} ${JSON.stringify(x.label)} series="${x.series}"`);
    if (create.length > 60) note(`  ... and ${create.length - 60} more`);
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
  let wrote = 0, filled = 0, mergedOff = 0, created = 0, rescued = 0, mintedLib = 0;
  await sql.begin(async (tx) => {
    for (const o of orphanFix) {
      const r = await repointColour(tx, CO, o.from, o.to);
      const n = sum(r);
      rescued += n;
      note(`  rescued ${n} orphaned line(s): "${o.from}" -> "${o.to}" (${busy(r)})`);
    }
    for (const x of doRewrite) {
      /* fabric_trackings.id is a text PK that HAPPENS to equal the code by
         minting convention. It is not rewritten: upserts and deletes key off
         it, and a PK change is a different, riskier operation than fixing the
         column the joins actually read. */
      await tx`UPDATE scm.fabric_trackings
                  SET fabric_code = ${x.target}, fabric_description = ${x.label}, series = ${x.series}
                WHERE company_id = ${CO} AND id = ${x.r.id}`;
      wrote++;
      /* Mirror it into the selling library the way fabric-tracking.ts does on
         create, so a fabric that exists in the master is also pickable on an
         order. Without this the row is tidy and still invisible to sales. */
      if (x.mintLibrary) {
        await tx`INSERT INTO scm.fabric_library (id, label, tier, default_surcharge, active, sort_order, company_id)
                 VALUES (${x.series}, ${x.series}, 'standard', 0, true, 0, ${CO})
                 ON CONFLICT (id) DO NOTHING`;
        await tx`INSERT INTO scm.fabric_colours (fabric_id, colour_id, label, active, sort_order, company_id)
                 VALUES (${x.series}, ${x.target}, ${x.label}, true, 0, ${CO})
                 ON CONFLICT (fabric_id, colour_id) DO NOTHING`;
        mintedLib++;
      }
    }
    for (const x of fillSeries) {
      await tx`UPDATE scm.fabric_trackings SET series = ${x.want}
                WHERE company_id = ${CO} AND id = ${x.r.id}`;
      filled++;
    }
    for (const m of merges) {
      /* The winner absorbs FIRST - a merge must not drop a tier or a supplier
         code that only the losing row carried. */
      const donor = m.lose.find((l) => tierOf(l)) || null;
      const sup = m.lose.find((l) => l.supplier_code)?.supplier_code ?? null;
      /* price_tier and its two siblings are scm.fabric_price_tier, an ENUM. A
         bound string is text, and postgres will not coalesce text into an enum
         column - the first apply died on exactly that and rolled the whole
         transaction back. Cast explicitly; NULL casts fine too. */
      await tx`UPDATE scm.fabric_trackings
                  SET sofa_price_tier     = COALESCE(${m.win.sofa_price_tier}::scm.fabric_price_tier, ${donor?.sofa_price_tier ?? null}::scm.fabric_price_tier),
                      bedframe_price_tier = COALESCE(${m.win.bedframe_price_tier}::scm.fabric_price_tier, ${donor?.bedframe_price_tier ?? null}::scm.fabric_price_tier),
                      price_tier          = COALESCE(${m.win.price_tier}::scm.fabric_price_tier, ${donor?.price_tier ?? null}::scm.fabric_price_tier),
                      supplier_code       = COALESCE(${m.win.supplier_code}::text, ${sup}::text)
                WHERE company_id = ${CO} AND id = ${m.win.id}`;
      for (const l of m.lose) {
        await tx`UPDATE scm.fabric_trackings
                    SET is_active = false,
                        fabric_description = ${(l.fabric_description || l.fabric_code) + ' [merged into ' + m.target + ' on ' + STAMP + ']'}
                  WHERE company_id = ${CO} AND id = ${l.id}`;
        mergedOff++;
      }
    }
    for (const x of create) {
      /* id follows the minting convention in fabric-tracking.ts: the code,
         uppercased. */
      await tx`INSERT INTO scm.fabric_trackings (id, fabric_code, fabric_description, series, is_active, company_id)
               VALUES (${x.code}, ${x.code}, ${x.label}, ${x.series}, true, ${CO})
               ON CONFLICT (id) DO NOTHING`;
      created++;
    }
  });
  note(`  codes rewritten ${wrote} | series filled ${filled} | duplicates deactivated ${mergedOff} | master rows created ${created} | orphaned lines rescued ${rescued} | library colours minted ${mintedLib}`);

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
                            WHERE company_id = ${CO} AND is_active GROUP BY 1 HAVING COUNT(*) > 1`;
    note(`  codes carried by more than one ACTIVE row (must be 0 for the tier join): ${dupNow.length}`);
    if (dupNow.length) fails++;
    const libOnly = await v`SELECT COUNT(*)::int AS n FROM scm.fabric_colours fc
                             WHERE fc.company_id = ${CO} AND fc.active
                               AND NOT EXISTS (SELECT 1 FROM scm.fabric_trackings t
                                                WHERE t.company_id = ${CO} AND t.is_active
                                                  AND upper(t.fabric_code) = upper(fc.colour_id))`;
    note(`  library colours with no ACTIVE Converter row (must be 0): ${libOnly[0].n}`);
    if (libOnly[0].n) fails++;
    for (const d of dupNow) note(`     "${d.fabric_code}" x${d.n}`);
    note(`  VERIFY ${fails === 0 ? "PASS" : `FAILED with ${fails} problem(s)`}`);
  } finally { await v.end({ timeout: 5 }); }
  await sql.end({ timeout: 5 });
  if (fails) process.exit(1);
}

main().catch((e) => { bad(e.message); process.exit(1); });
