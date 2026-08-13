#!/usr/bin/env node
/* Find the fabric SERIES that exist twice, and cost out merging them.

   WHY. `refresh-sofa-colours.mjs` bound "HR805-90" to `FABRIC HR805` and
   "HR805-30" to `HR805` in the same run - one physical fabric series, two
   fabric_library ids, live document lines split across both. The picker then
   shows the same fabric twice and a report that groups by fabric_id splits one
   series' history in half.

   TWO WAYS A PAIR GETS INTO THE PLAN. Detected (below), or DECLARED by the
   owner: DECLARE="FG66151:PC151" asserts that two series are one fabric even
   though they share no colour code and the detector can therefore never see
   them (owner 2026-08-12, "这两个是一样的"). A declared pair skips DETECTION
   and nothing else - same canonical-side rule, same LOSSLESS/LOSSY grading,
   same refusals. Its colours are matched by NUMBER (FG66151-01 <-> PC151-01),
   which is the only correspondence that exists when no code is shared, and a
   number the winner does not hold still counts as uncovered. A run with
   DECLARE set applies ONLY the declared pairs unless PAIRS widens it.

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

   THE OWNER CALLED IT on 2026-08-11: "合并，按引用数多的那边" - merge, and the
   side with more references wins. So this script now has an APPLY path. It did
   not before, deliberately, because merging repoints which colour a live
   document names and that was not a script's decision to make.

   WHAT "MERGE" MEANS HERE, GIVEN THAT NOTHING MAY BE DELETED.
   A merge that removes the losing `fabric_library` row is a DELETE, and the
   owner's rule is that nothing is deleted, only cancelled. So the losing series
   is SUPERSEDED, never dropped: `active = false`, and its label records which
   series absorbed it and when. The row stays, its colours stay attached to it,
   and a historical document that still names it still resolves for display.

   AND NOTHING MAY BECOME UNREACHABLE EITHER. Superseding a series hides every
   colour hanging off it from the picker. That is harmless when the losing side
   only holds colours the winner already has - the usual case, where the pair is
   two spellings of one series - and it is a real loss when the loser holds
   colours the winner does not. Each pair is therefore classified by evidence
   before anything is written:

     LOSSLESS  every colour on the losing side has a counterpart on the winning
               side, so superseding hides nothing that is not already there.
               Live lines are repointed and the series is superseded.

     LOSSY     the losing side holds colours the winner does not. Applying would
               remove a named colour from the picker, and any live line sitting
               on one of those colours would be repointed to a series that
               cannot express it. REFUSED and reported - never applied by
               default. MOVE_COLOURS=1 makes it lossless instead, by
               re-parenting those colours onto the winner first; that changes
               the library's CONTENT, not just its shape, so it is opt-in.

   FOUR DOCUMENT ARMS, NOT TWO. The reference COUNT above is taken off SO and PO
   lines, which is what decides the canonical side. The REPOINT has to reach
   every table whose variants block can name a series, or a merge leaves an arm
   pointing at a superseded row - which is exactly the unswept-arm bug #1964
   found in the GRN snapshot. All four are measured and written.

   THE JSONB WRITE USES jsonb_set + to_jsonb(text), NOT a bound object. Binding
   a pre-serialized string to a jsonb parameter is what destroyed the variants
   column three times on 2026-08-10 (docs/jsonb-double-encoding-coe.md).
   to_jsonb($1::text) is built server-side from a plain text parameter, so no
   json serializer can run over it and there is no `||` merge to turn an
   unexpected shape into an array.

   MODE=plan (default) prints and writes nothing. MODE=apply writes, one
   transaction per pair, and verifies on a SECOND, FRESH connection. */
import postgres from "postgres";
import { normColour, foldColour, markColour } from "./lib/fabric-colour-match.mjs";

const DSN = process.env.DATABASE_URL;
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const MOVE_COLOURS = process.env.MOVE_COLOURS === "1";
const ONLY = (process.env.PAIRS || "").split(",").map((s) => s.trim()).filter(Boolean);
const STAMP = process.env.NOTE_DATE || new Date().toISOString().slice(0, 10);

/* Every table whose `variants` can name a fabric series, with how each row
   reaches its company. These are literal constants, never user input - they are
   interpolated as identifiers because a table name cannot be a bind parameter.
   Every VALUE below is still a bind parameter, and none of them is jsonb. */
const ARMS = [
  { name: "SO", t: "scm.mfg_sales_order_items", join: "JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no" },
  { name: "PO", t: "scm.purchase_order_items", join: "JOIN scm.purchase_orders h ON h.id = i.purchase_order_id" },
  { name: "GRN", t: "scm.grn_items", join: "JOIN scm.grns h ON h.id = i.grn_id" },
  { name: "DO", t: "scm.delivery_order_items", join: "JOIN scm.delivery_orders h ON h.id = i.delivery_order_id" },
];

/* live lines on a series, per colour, across one arm */
const armLines = (client, arm, series) => client.unsafe(
  `SELECT i.variants->>'fabricCode' AS colour, COUNT(*)::int AS n
     FROM ${arm.t} i ${arm.join}
    WHERE h.company_id = $1 AND jsonb_typeof(i.variants) = 'object'
      AND i.variants->>'fabricId' = $2
    GROUP BY 1 ORDER BY 1`, [CO, series]);

// the matcher's rung 3, re-derived: peel trailing colour NAMES off a code
const dropName = (s) => {
  let v = s, m;
  while ((m = /^(.+?)[\s-]+[A-Z]+$/.exec(v)) && /\d/.test(m[1]) && /[A-Z]/.test(m[1])) v = m[1].trim();
  return v;
};
const padTail = (x) => x.replace(/(?<!\d)(\d)$/, "0$1");
const dropBrand = (s) => s.replace(/^[A-Z]+\s+(?=[A-Z]*\d)/, "");
/* Pad a one-digit tail while the SEPARATOR is still there: "J9226-2" ->
   "J9226-02". It has to happen before folding, because the fold runs the series
   number into the colour number ("J92262") and nothing downstream can then tell
   which digits are which - which is why ARMANI J9226 / J9226 went undetected on
   the first prod run. Same rule as the matcher's rung 6. */
const padWrittenTail = (s) => s.replace(/([\s-])(\d)$/, "$10$2");

/* every key this colour could be recognised by, from colour_id AND label */
const codeKeys = (r) => {
  const out = new Set();
  for (const src of [r.colour_id, r.label]) {
    if (!src) continue;
    const base = dropName(normColour(src));
    for (const v of [base, dropBrand(base), padWrittenTail(base), dropBrand(padWrittenTail(base))]) {
      const f = foldColour(v);
      /* The digit test MUST run in MARK space. foldColour turns letter-O into
         "0", so a colour whose label is only a NAME - "BROWN", "GOLD" - folds to
         "BR0WN", passes a digit test on the fold, and then collides with every
         other series that holds a BROWN. That one false key paired 311 with
         A201, KS, M2402 and XQ#18 on the first prod run. In mark space letter-O
         is "@", so only a WRITTEN digit counts - the same reason the matcher's
         own digit guard compares in mark space. */
      if (f && /\d/.test(markColour(v)) && f.length >= 3) { out.add(f); out.add(padTail(f)); }
    }
  }
  return [...out];
};

async function main() {
  const allCols = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const libs = await sql`SELECT id, label, tier, default_surcharge, active FROM scm.fabric_library WHERE company_id = ${CO}`;

  /* A SUPERSEDED series is not a duplicate any more - it is a merge that already
     happened. Its colours are retained on purpose (nothing is deleted), so they
     still collide by code with the winner that absorbed them, and a census that
     reads the whole table therefore re-proposes every pair it just merged
     forever. Count only the ACTIVE library, and say how many pairs that
     removed, so a completed merge reads as done instead of as outstanding. */
  const retired = new Set(libs.filter((l) => l.active === false).map((l) => l.id));
  const cols = allCols.filter((c) => !retired.has(c.fabric_id));
  note(`library: ${libs.length} series / ${allCols.length} colours (company ${CO})`);
  note(`  ACTIVE: ${libs.length - retired.size} series / ${cols.length} colours`);
  note(`  SUPERSEDED (already merged, retained not deleted): ${retired.size} series / ${allCols.length - cols.length} colours`);

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

  /* ── OWNER-DECLARED PAIRS ────────────────────────────────────────────────
     The detector above recognises a duplicate by a SHARED COLOUR CODE, and
     that is deliberate: naming alone is a hunch. But two series can be one
     physical fabric and share not a single code — the owner named FG66151 and
     PC151 on 2026-08-12 ("这两个是一样的"), and their codes have nothing in
     common, so no amount of folding will ever pair them. The only authority
     that can pair them is the owner, so DECLARE is exactly that: a human
     assertion, typed in, that these two series are the same fabric.

     A declared pair is not trusted any further than the assertion itself. It
     enters the SAME plan, is classified by the SAME evidence, and is refused
     by the SAME rules — it only skips the DETECTION step. The colours are
     matched by their trailing number (FG66151-01 ↔ PC151-01), because with no
     shared code that is the only correspondence there is, and a number that
     matches nothing on the winner still lands in `uncovered` and still needs
     MOVE_COLOURS. */
  const DECLARED = (process.env.DECLARE || "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split(":").map((x) => x.trim()))
    .filter(([a, b]) => a && b);
  /* the colour's own number within its series: strip the series prefix, then
     take the leading digits. Falls back to the trailing digits after the last
     separator. Padded to 2 so "-1" and "-01" are one number. */
  const colourNumOf = (r) => {
    const cid = String(r.colour_id || "").toUpperCase();
    const fid = String(r.fabric_id || "").toUpperCase();
    const rest = cid.startsWith(fid) ? cid.slice(fid.length) : cid;
    const m = /(\d{1,3})/.exec(rest.replace(/^[^A-Z0-9]+/, "")) || /(\d{1,3})\s*$/.exec(cid);
    return m ? String(Number(m[1])).padStart(2, "0") : null;
  };
  const declaredPks = new Set();
  for (const [a, b] of DECLARED) {
    const [x, y] = [a, b].sort();
    const pk = pk2(x, y);
    declaredPks.add(pk);
    const ax = colsBySeries.get(x) || [], by = colsBySeries.get(y) || [];
    if (!ax.length || !by.length) {
      bad(`DECLARE "${a}:${b}": ${!ax.length ? `"${x}"` : `"${y}"`} holds no colours (or does not exist) — nothing to merge`);
      continue;
    }
    if (pairs.has(pk)) { note(`DECLARE "${a}:${b}": already detected by shared colour code — using the detected pairing`); continue; }
    const byNum = new Map();
    for (const r of ax) { const n = colourNumOf(r); if (n && !byNum.has(n)) byNum.set(n, r); }
    const hits = [];
    for (const r of by) { const n = colourNumOf(r); if (n && byNum.has(n)) hits.push([`#${n}`, byNum.get(n), r]); }
    pairs.set(pk, hits);
    note(`DECLARE "${x}" = "${y}" (owner-asserted): ${hits.length} colour number(s) line up, ${ax.length}/${by.length} colours held`);
  }

  note(`\n=== DUPLICATE SERIES PAIRS: ${pairs.size}${declaredPks.size ? ` (${declaredPks.size} owner-declared)` : ""} ===`);
  const plan = [];
  for (const [pk, hits] of [...pairs].sort((a, b) => b[1].length - a[1].length)) {
    const [a, b] = JSON.parse(pk);
    const ra = bySeries.get(a) || 0, rb = bySeries.get(b) || 0;
    const ca = (colsBySeries.get(a) || []).length, cb = (colsBySeries.get(b) || []).length;
    // canonical: most live references, then most colours, then shorter id
    const aWins = ra !== rb ? ra > rb : ca !== cb ? ca > cb : a.length <= b.length;
    const [keep, drop] = aWins ? [a, b] : [b, a];
    const keepRefs = aWins ? ra : rb, dropRefs = aWins ? rb : ra;
    const declared = declaredPks.has(pk);
    plan.push({ keep, drop, keepRefs, dropRefs, hits, declared, keepCols: aWins ? ca : cb, dropCols: aWins ? cb : ca });
    note(`\n  "${keep}"  <=  "${drop}"     [${hits.length} ${declared ? "matching colour number" : "shared colour code"}${hits.length === 1 ? "" : "s"}]${declared ? "   OWNER-DECLARED" : ""}`);
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
  note(`\n=== EXPOSURE IF MERGED (SO+PO reference count, the canonical-side rule) ===`);
  note(`  series superseded:              ${droppedSeries.size} of ${libs.length - retired.size} active`);
  note(`  live document lines repointed:  ${movedLines} of ${totalRefs}`);
  note(`  lines NOT touched:              ${totalRefs - movedLines}`);

  /* ── THE PER-COLOUR PLAN ──────────────────────────────────────────────────
     The summary above says how many lines move. It does NOT say whether the
     losing side holds a colour the winner cannot express, and that is the only
     question that decides whether a merge is safe to apply. Answer it colour by
     colour, across all four document arms, before writing anything. */
  const keysOf = new Map(cols.map((r) => [pk2(r.fabric_id, r.colour_id), codeKeys(r)]));
  const bothSides = new Set([...droppedSeries].filter((d) => plan.some((p) => p.keep === d)));
  for (const s of bothSides) bad(`series "${s}" is KEEP in one pair and DROP in another - chained merge, refused`);

  note(`\n=== PER-PAIR PLAN ===`);
  for (const p of plan) {
    p.skip = null;
    /* DECLARE names ONE pair the owner asked for. Letting the run also apply
       every pair the detector happened to find would merge things nobody
       asked about in the same transaction batch, so a declared run is
       restricted to the declared pairs unless PAIRS explicitly widens it. */
    if (DECLARED.length && !ONLY.length && !p.declared) { p.skip = "DECLARE set — only declared pairs run"; continue; }
    if (ONLY.length && !ONLY.includes(p.drop)) { p.skip = "not in PAIRS"; continue; }
    if (bothSides.has(p.drop) || bothSides.has(p.keep)) { p.skip = "chained merge"; continue; }

    const keepCols = colsBySeries.get(p.keep) || [];
    const dropCols = colsBySeries.get(p.drop) || [];
    /* A losing colour is "covered" when the winner holds its counterpart.
       Detected pair: counterpart = a colour sharing a code key. Owner-declared
       pair: the two series share NO code by definition (that is why the
       detector was blind to them), so the counterpart is the colour with the
       same number — the correspondence the owner is asserting when they say
       the series are the same. A number the winner does not hold is still
       uncovered, so a declared pair is graded on the same evidence. */
    const keyFn = p.declared
      ? (r) => { const n = colourNumOf(r); return n ? [n] : []; }
      : (r) => keysOf.get(pk2(r.fabric_id, r.colour_id)) || [];
    const keepKey = new Map();
    for (const r of keepCols) for (const k of keyFn(r)) if (!keepKey.has(k)) keepKey.set(k, r);
    p.cover = new Map();   // drop colour_id -> keep colour row (or null)
    for (const r of dropCols) {
      const hit = keyFn(r).map((k) => keepKey.get(k)).find(Boolean) || null;
      p.cover.set(r.colour_id, hit);
    }
    p.uncovered = dropCols.filter((r) => !p.cover.get(r.colour_id));

    // live lines on the losing series, per arm, per colour
    p.live = new Map();  // colour string (may be null) -> {n, byArm}
    for (const arm of ARMS) {
      for (const r of await armLines(sql, arm, p.drop)) {
        const cur = p.live.get(r.colour) || { n: 0, byArm: {} };
        cur.n += r.n; cur.byArm[arm.name] = (cur.byArm[arm.name] || 0) + r.n;
        p.live.set(r.colour, cur);
      }
    }
    p.liveTotal = [...p.live.values()].reduce((a, v) => a + v.n, 0);
    // a live line whose colour is not a row of the losing series at all
    p.unmapped = [...p.live.entries()].filter(([c]) => c == null || !p.cover.has(c));
    p.orphan = [...p.live.entries()].filter(([c]) => c != null && p.cover.has(c) && !p.cover.get(c));

    p.verdict = p.uncovered.length === 0 && p.unmapped.length === 0 ? "LOSSLESS"
      : p.unmapped.length ? "REFUSED-UNMAPPED" : (MOVE_COLOURS ? "LOSSY-MOVE" : "REFUSED-LOSSY");

    note(`\n  "${p.keep}"  <=  "${p.drop}"     ${p.verdict}`);
    note(`      winner holds ${keepCols.length} colour(s); loser holds ${dropCols.length}, of which ${p.uncovered.length} the winner does NOT have`);
    note(`      live lines on the loser, all four arms: ${p.liveTotal}`);
    for (const [c, v] of [...p.live].sort()) {
      const tgt = c == null ? null : p.cover.get(c);
      const where = Object.entries(v.byArm).map(([k, n]) => `${k}=${n}`).join(" ");
      note(`        ${v.n} line(s) on "${c ?? "(no fabricCode)"}"  [${where}]  -> ${tgt ? `"${tgt.colour_id}"` : c != null && p.cover.has(c) ? "NO TARGET on the winner" : "colour is not a row of the loser"}`);
    }
    if (p.uncovered.length) {
      note(`      colours that would leave the picker unless re-parented:`);
      for (const r of p.uncovered) note(`        "${r.colour_id}"${r.label && r.label !== r.colour_id ? `  label "${r.label}"` : ""}`);
    }
  }

  const doable = plan.filter((p) => !p.skip && (p.verdict === "LOSSLESS" || p.verdict === "LOSSY-MOVE"));
  const held = plan.filter((p) => !p.skip && p.verdict !== "LOSSLESS" && p.verdict !== "LOSSY-MOVE");
  note(`\n=== VERDICT ===`);
  note(`  pairs that merge with nothing lost:   ${plan.filter((p) => p.verdict === "LOSSLESS").length}`);
  note(`  pairs needing a colour re-parent:     ${plan.filter((p) => p.verdict === "LOSSY-MOVE" || p.verdict === "REFUSED-LOSSY").length}${MOVE_COLOURS ? " (MOVE_COLOURS=1, they will be moved)" : " (HELD - re-run with MOVE_COLOURS=1 to move them)"}`);
  note(`  pairs refused, a live line names a colour the loser does not hold: ${plan.filter((p) => p.verdict === "REFUSED-UNMAPPED").length}`);
  note(`  pairs skipped:                        ${plan.filter((p) => p.skip).length}`);
  for (const p of held) bad(`HELD "${p.keep}" <= "${p.drop}": ${p.verdict}. ${p.uncovered.length} colour(s) the winner does not hold, ${p.liveTotal} live line(s) on the loser.`);

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

  /* CH141 / CHANTIC and NX / NX016 are NOT in the pairs above and are not an
     oversight: this detector recognises a duplicate by a SHARED COLOUR CODE,
     and those two pairs share none, so nothing here can see them. They are
     reported as still-open rather than folded in on a naming hunch. */
  note(`\n=== STILL OPEN - suspected duplicates this detector CANNOT see ===`);
  for (const [a, b] of [["CH141", "CHANTIC"], ["NX", "NX016"]]) {
    const ea = libs.some((l) => l.id === a), eb = libs.some((l) => l.id === b);
    note(`  "${a}" vs "${b}": ${ea && eb ? "both series exist" : `${ea ? a : b} only`}; share ZERO colour codes, so the detector is blind to them. Owner decision, not merged here.`);
    for (const s of [a, b]) if (libs.some((l) => l.id === s)) {
      const cs = colsBySeries.get(s) || [];
      note(`     "${s}": ${bySeries.get(s) || 0} live line(s), ${cs.length} colour(s)${cs.length ? ` - ${cs.slice(0, 6).map((r) => `"${r.colour_id}"`).join(", ")}${cs.length > 6 ? ", ..." : ""}` : ""}`);
    }
  }

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing was written. ${doable.length} pair(s) would merge. Re-run with MODE=apply.`);
    return;
  }

  // ── APPLY ────────────────────────────────────────────────────────────────
  note(`\n=== APPLYING ${doable.length} PAIR(S) ===`);
  const done = [];
  for (const p of doable) {
    const moved = [], repointed = [];
    await sql.begin(async (tx) => {
      /* 1. re-parent the colours the winner does not hold. Not a copy: the row
            keeps its id and its name and changes parent, so nothing is
            duplicated and nothing is lost. */
      if (p.uncovered.length) {
        if (!MOVE_COLOURS) throw new Error(`${p.drop}: uncovered colours without MOVE_COLOURS`);
        for (const r of p.uncovered) {
          const clash = await tx`SELECT 1 FROM scm.fabric_colours
             WHERE company_id = ${CO} AND fabric_id = ${p.keep} AND colour_id = ${r.colour_id}`;
          if (clash.length) throw new Error(`${p.keep} already holds colour_id "${r.colour_id}" - refusing to re-parent`);
          const back = await tx`UPDATE scm.fabric_colours SET fabric_id = ${p.keep}
             WHERE company_id = ${CO} AND fabric_id = ${p.drop} AND colour_id = ${r.colour_id}
            RETURNING colour_id`;
          if (back.length !== 1) throw new Error(`re-parent of "${r.colour_id}" matched ${back.length} rows`);
          moved.push(r.colour_id);
        }
      }

      /* 2. repoint every live line, on every arm. jsonb_set + to_jsonb($::text)
            keeps the value a plain text bind - no json serializer can run over
            it, so the 2026-08-10 double-encoding cannot recur here. */
      for (const [colour] of p.live) {
        if (colour == null) continue;
        const tgt = p.cover.get(colour);
        const toColour = tgt ? tgt.colour_id : colour; // a re-parented colour keeps its name
        for (const arm of ARMS) {
          const back = await tx.unsafe(
            `UPDATE ${arm.t} SET variants =
                jsonb_set(jsonb_set(variants, '{fabricId}', to_jsonb($1::text)),
                          '{fabricCode}', to_jsonb($2::text))
              WHERE id IN (SELECT i.id FROM ${arm.t} i ${arm.join}
                            WHERE h.company_id = $3 AND jsonb_typeof(i.variants) = 'object'
                              AND i.variants->>'fabricId' = $4
                              AND i.variants->>'fabricCode' = $5)
             RETURNING id::text AS id`, [p.keep, toColour, CO, p.drop, colour]);
          if (back.length) repointed.push(`${arm.name}:${colour}->${toColour}=${back.length}`);
        }
      }

      /* 3. nothing may still name the losing series before it is superseded */
      for (const arm of ARMS) {
        const left = await tx.unsafe(
          `SELECT COUNT(*)::int AS n FROM ${arm.t} i ${arm.join}
            WHERE h.company_id = $1 AND jsonb_typeof(i.variants) = 'object'
              AND i.variants->>'fabricId' = $2`, [CO, p.drop]);
        if (left[0].n) throw new Error(`${arm.name} still has ${left[0].n} line(s) naming "${p.drop}" - not superseding`);
      }

      /* 4. SUPERSEDE, never delete. The row stays; `active = false` takes it
            out of the picker and the label records what absorbed it. */
      const tag = `[MERGED into ${p.keep} on ${STAMP} - superseded, not deleted]`;
      const sup = await tx`UPDATE scm.fabric_library
           SET active = false,
               label = CASE WHEN COALESCE(label,'') LIKE '%[MERGED into %' THEN label
                            ELSE TRIM(BOTH ' ' FROM COALESCE(label,'') || ' ' || ${tag}) END
         WHERE company_id = ${CO} AND id = ${p.drop}
        RETURNING id, label, active`;
      if (sup.length !== 1) throw new Error(`supersede of "${p.drop}" matched ${sup.length} rows`);
    });
    done.push({ p, moved, repointed });
    note(`  "${p.keep}" <= "${p.drop}": ${moved.length} colour(s) re-parented, repointed ${repointed.join(", ") || "(no live lines)"}, series superseded`);
  }

  // ── VERIFY, ON A FRESH CONNECTION ────────────────────────────────────────
  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let fails = 0;
  try {
    note(`\n=== INDEPENDENT READ-BACK (fresh connection) ===`);
    for (const { p, moved } of done) {
      const lib = await v`SELECT id, label, active FROM scm.fabric_library WHERE company_id = ${CO} AND id IN (${p.keep}, ${p.drop})`;
      const dropRow = lib.find((l) => l.id === p.drop), keepRow = lib.find((l) => l.id === p.keep);
      if (!dropRow) { fails++; bad(`"${p.drop}" is GONE from fabric_library - it must be superseded, not deleted`); }
      else if (dropRow.active !== false) { fails++; bad(`"${p.drop}" still active`); }
      if (!keepRow || keepRow.active === false) { fails++; bad(`"${p.keep}" is missing or inactive`); }
      let left = 0;
      for (const arm of ARMS) {
        const r = await v.unsafe(
          `SELECT COUNT(*)::int AS n FROM ${arm.t} i ${arm.join}
            WHERE h.company_id = $1 AND jsonb_typeof(i.variants) = 'object' AND i.variants->>'fabricId' = $2`,
          [CO, p.drop]);
        left += r[0].n;
      }
      if (left) { fails++; bad(`${left} line(s) still name "${p.drop}"`); }
      const nowKeep = await v`SELECT COUNT(*)::int AS n FROM scm.fabric_colours WHERE company_id = ${CO} AND fabric_id = ${p.keep}`;
      const nowDrop = await v`SELECT COUNT(*)::int AS n FROM scm.fabric_colours WHERE company_id = ${CO} AND fabric_id = ${p.drop}`;
      note(`  "${p.keep}" <= "${p.drop}": superseded=${dropRow?.active === false} label=${JSON.stringify(dropRow?.label)} lines-still-naming-loser=${left} colours now keep=${nowKeep[0].n} loser-retains=${nowDrop[0].n} re-parented=${moved.length}`);
      for (const c of moved) {
        const r = await v`SELECT fabric_id FROM scm.fabric_colours WHERE company_id = ${CO} AND colour_id = ${c}`;
        if (!r.some((x) => x.fabric_id === p.keep)) { fails++; bad(`re-parented colour "${c}" is not under "${p.keep}"`); }
      }
    }
    /* the whole point: no variants block anywhere may have been turned into an
       array by a bad jsonb write. This is the shape the 2026-08-10 COE is about. */
    for (const arm of ARMS) {
      const r = await v.unsafe(
        `SELECT COUNT(*)::int AS n FROM ${arm.t} i ${arm.join}
          WHERE h.company_id = $1 AND jsonb_typeof(i.variants) = 'array'`, [CO]);
      note(`  ${arm.name}: variants blocks of ARRAY shape (must be 0): ${r[0].n}`);
      if (r[0].n) { fails++; bad(`${arm.name} holds ${r[0].n} array-shaped variants block(s)`); }
    }
    const stillDup = await v`SELECT COUNT(*)::int AS n FROM scm.fabric_library WHERE company_id = ${CO} AND active`;
    note(`  active series remaining: ${stillDup[0].n} (was ${libs.filter((l) => l.active !== false).length})`);
  } finally { await v.end({ timeout: 5 }); }

  if (fails) { bad(`${fails} verification failure(s)`); process.exit(1); }
  note(`\nVERIFIED on a fresh connection: ${done.length} pair(s) merged, losers superseded and still present, no colour deleted, no variants block reshaped.`);
}
main().then(() => sql.end({ timeout: 5 })).catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
