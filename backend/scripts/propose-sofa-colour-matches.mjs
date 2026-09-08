#!/usr/bin/env node
/* The colour pairings, for the owner to confirm. READ-ONLY: this writes nothing.
 *
 * Owner, 2026-09-07: 你确定你辨认不出吗？你 AI 辨认不出我们的 fabric 有哪一些是
 * 跟它一样接近的吗？  Refusing outright was lazy. So this PROPOSES: for every
 * colour the sofa backfill holds because it resolves only through the matcher,
 * it prints the customer's own text, how many lines carry it and on which
 * documents, the library row it would resolve to, WHICH pass resolved it, and
 * the sibling rows in the same fabric series so the alternatives are visible
 * rather than asserted away.
 *
 * It proposes. It does not write. `backfill-sofa-variants-from-desc2` with
 * FUZZY=1 is what applies them, once he has confirmed.
 *
 * THE DEAD-ROW TRAP, and why this file exists rather than a re-read of the
 * backfill's log. The fabric library renumbered itself on 2026-08-11, keeping
 * each 1-digit predecessor as `active = false`. `fabric-colour-match.mjs`
 * handles that - `claimIndex` lets the ACTIVE row take a key two rows claim,
 * and `live()` follows a superseded hit to its replacement - but BOTH read
 * `r.active`, and `backfill-sofa-variants-from-desc2.mjs:85` selects only
 * `fabric_id, colour_id, label`. With `active` absent every row is neither
 * live nor superseded, so `live()` can never redirect and a match that lands on
 * a dead row STAYS on the dead row. This selects `active` and reports, per
 * proposal, whether the answer changed because of it. A pairing the owner
 * confirms must be a pairing against the row that is alive.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     default 1
 */
import postgres from "postgres";
import { parseSofa, SOFA_MODEL_ALIAS } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex, isPendingColour, normColour } from "./lib/fabric-colour-match.mjs";
import { buildSofaVariantPatch } from "./lib/variant-merge.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const PDATE = soProcessingDateFragment(sql);
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const modelOf = (code) => {
  const c = normColour(code);
  const dash = c.indexOf("-");
  const base = dash < 0 ? c : c.slice(0, dash);
  return SOFA_MODEL_ALIAS[base] || base;
};
const isReadyStock = (d2) => /\bready\s*stock\b/i.test(d2 || "");

/* How much of the customer's text the library code already accounts for. A
   proposal is only as good as what it had to IGNORE to get there, so this is
   what the confidence is built out of rather than a feeling about the string. */
const leftover = (text, colourId) => {
  const t = normColour(text).replace(/[^A-Z0-9]/g, "");
  const c = normColour(colourId).replace(/[^A-Z0-9]/g, "");
  /* Compare in the matcher's own O/0 space; a written zero for a letter O is a
     spelling, not a different fabric. */
  const f = (x) => x.replace(/O/g, "0");
  const ft = f(t), fc = f(c);
  if (ft.includes(fc)) return ft.slice(0, ft.indexOf(fc)) + ft.slice(ft.indexOf(fc) + fc.length);
  return null;
};

async function main() {
  log(`sofa colour pairings for confirmation - company ${CO}. READ-ONLY, nothing is written.`);

  /* `active` IS selected here. That is the whole point - see the header. */
  const fcRows = await sql`SELECT fabric_id, colour_id, label, active FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const withActive = buildFabricColourIndex(fcRows);
  const withoutActive = buildFabricColourIndex(fcRows.map(({ active, ...r }) => r));
  const nLive = fcRows.filter((r) => r.active === true).length;
  const nDead = fcRows.filter((r) => r.active === false).length;
  log(`fabric library: ${fcRows.length} colour rows - ${nLive} live, ${nDead} superseded, ${fcRows.length - nLive - nDead} unstated`);

  const exactRow = new Map();
  for (const r of fcRows) for (const k of [normColour(r.colour_id), normColour(r.label)]) if (k && !exactRow.has(k)) exactRow.set(k, r);
  const knownColour = (t) => (exactRow.has(normColour(t)) || withActive.findColour(t) ? String(t).trim() : null);

  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  const codeSet = new Set(prods.map((p) => normColour(p.code)));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const reclOf = (m) => RECL.some((s) => codeSet.has(normColour(m + s)));

  /* The same two populations the backfill reads, so this reports on exactly the
     lines that sweep would touch and not on a wider set that flatters it. */
  const po = (await sql`
    SELECT i.id, p.po_number AS doc, i.item_code AS code, i.description2 AS d2, i.variants
      FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE p.company_id = ${CO} AND i.item_group = 'sofa' ORDER BY p.po_number`)
    .map((r) => ({ ...r, scope: "PO" }));
  const so = (await sql`
    SELECT i.id, h.doc_no AS doc, i.item_code AS code, i.description2 AS d2, i.variants
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.item_group = 'sofa' AND h.${PDATE} IS NOT NULL
     ORDER BY h.doc_no, i.line_no`).map((r) => ({ ...r, scope: "SO" }));

  const held = new Map(), absent = new Map();
  for (const r of [...po, ...so]) {
    const d2 = (r.d2 || "").trim();
    if (!d2 || isReadyStock(d2) || isPendingColour(d2)) continue;
    const ps = parseSofa(d2, modelOf(r.code), reclOf(modelOf(r.code)), { knownColour });
    if (!ps.color) continue;
    if (exactRow.get(normColour(ps.color))) continue;         // exact: not a proposal
    const e = withActive.explainColour(ps.color);
    if (!e) {
      const k = normColour(ps.color);
      const a = absent.get(k) ?? { text: String(ps.color).trim(), lines: [] };
      a.lines.push(r); absent.set(k, a);
      continue;
    }
    /* Only lines the sweep would actually FILL are a decision. A line whose
       colour is already bound is not held on anything. */
    if (!buildSofaVariantPatch(ps, e.row, r.variants)?.colourId) continue;
    const k = normColour(ps.color);
    const h = held.get(k) ?? { text: String(ps.color).trim(), row: e.row, e, lines: [] };
    h.lines.push(r); held.set(k, h);
  }

  const props = [...held.values()].sort((a, b) => b.lines.length - a.lines.length);
  const nLines = props.reduce((t, p) => t + p.lines.length, 0);

  log("");
  log("══════════════════════════════════════════════════════════════════════");
  log(`${props.length} colour text(s), covering ${nLines} line(s), for the owner to CONFIRM.`);
  log("Nothing here is written by this script. Confirm, then run");
  log("backfill-sofa-variants-from-desc2 with FUZZY=1.");
  log("══════════════════════════════════════════════════════════════════════");

  for (const p of props) {
    /* Every other colour in the same fabric series: the alternatives the owner
       is really choosing between. Printed so the proposal can be checked, not
       taken on trust. */
    const sibs = fcRows.filter((r) => r.fabric_id === p.row.fabric_id)
      .sort((a, b) => String(a.colour_id).localeCompare(String(b.colour_id)));
    const left = leftover(p.text, p.row.colour_id);
    /* Confidence, from what the match had to ignore - not from a feeling.
       HIGH  the library code is contained in the customer's text and what is
             left over is the colour's own English name (or nothing).
       CHECK anything else: the code is not literally present, so the pass
             reached it by a widening the owner should look at. */
    const nameOnly = left !== null && (left === "" || normColour(p.row.label).replace(/[^A-Z0-9]/g, "").includes(left) || left.length <= 12);
    /* AN ASSUMED SERIES IS NEVER HIGH — docs/bugs/0672 site 16. When the
       document wrote a BARE NUMBER, the matcher supplied the "PC" itself; the
       series is not in the text at all. In the owner's data that is usually
       right, which is why the pass exists, but "usually right" is precisely the
       thing a person should be shown rather than told. */
    const conf = p.e.assumedSeries ? "CHECK" : (left !== null && nameOnly ? "HIGH" : "CHECK");
    const dead = p.row.active === false;
    const wouldDiffer = (() => {
      const alt = withoutActive.explainColour(p.text);
      const a = alt?.row?.colour_id ?? null;
      return a !== p.row.colour_id ? (a ?? "no match at all") : null;
    })();

    log("");
    log(`─ "${p.text}"   ${p.lines.length} line(s)`);
    log(`   PROPOSE  ${p.row.fabric_id} / ${p.row.colour_id}   "${p.row.label}"   [${conf}]`);
    if (p.e.assumedSeries) log(`   *** THE SERIES WAS ASSUMED. The text is a bare number; "PC" came from the matcher, not the document. ***`);
    log(`   matched by: ${p.e.via}${p.e.padded ? " +padded" : ""}${p.e.assumedSeries ? " +ASSUMED SERIES (PC)" : ""}${p.e.redirected ? " +redirected to the live row" : ""}` +
        `${left !== null ? `; text minus the code = ${JSON.stringify(left)}` : "; the code is not literally in the text"}`);
    if (dead) log(`   *** THIS ROW IS SUPERSEDED (active = false). Do NOT bind to it. ***`);
    if (wouldDiffer) log(`   *** without \`active\`, the matcher would have answered ${wouldDiffer} - the dead-row trap, avoided here. ***`);
    log(`   same series (${sibs.length}): ${sibs.map((s) => `${s.colour_id}${s.active === false ? "(dead)" : ""}`).join(", ").slice(0, 260)}`);
    for (const l of p.lines.slice(0, 4)) log(`      ${l.scope} ${l.doc}  ${l.code}   Desc2 ${JSON.stringify(String(l.d2).replace(/\s+/g, " ").slice(0, 76))}`);
    if (p.lines.length > 4) log(`      ... and ${p.lines.length - 4} more line(s)`);
  }

  log("");
  log("══════════════════════════════════════════════════════════════════════");
  log(`NOT IN THE LIBRARY AT ALL - ${absent.size} code(s). These have to be CREATED before anything can bind.`);
  log("══════════════════════════════════════════════════════════════════════");
  for (const a of absent.values()) {
    /* What creating one would take: the series it would join, and whether that
       series already exists. A new colour in an existing series is a row; a new
       series is a row plus a fabric. */
    const seriesGuess = normColour(a.text).replace(/[^A-Z0-9]/g, " ").trim().split(/\s+/)[0] || "";
    const sibs = fcRows.filter((r) => normColour(r.fabric_id) === seriesGuess);
    log("");
    log(`─ "${a.text}"   ${a.lines.length} line(s)`);
    log(`   would join series ${seriesGuess || "(unreadable)"} - ${sibs.length ? `EXISTS, ${sibs.length} colour(s): ${sibs.map((s) => s.colour_id).join(", ").slice(0, 200)}` : "does NOT exist, so the fabric has to be created too"}`);
    for (const l of a.lines.slice(0, 4)) log(`      ${l.scope} ${l.doc}  ${l.code}   Desc2 ${JSON.stringify(String(l.d2).replace(/\s+/g, " ").slice(0, 76))}`);
    if (a.lines.length > 4) log(`      ... and ${a.lines.length - 4} more line(s)`);
  }

  log("");
  log(`totals: ${props.length} pairing(s) over ${nLines} line(s); ${absent.size} code(s) absent from the library.`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
