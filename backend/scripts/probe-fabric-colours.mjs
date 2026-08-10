// Read-only probe: does the fabric library actually contain the colour codes
// the sofa SO import could not resolve? (owner 2026-08-10: "BOOBOO315-31、
// grafield1-softlinen、ZL-6 Lether 这个没有?") Prints, for each queried name,
// the exact/typo-folded hit or the nearest library entries, so the answer is
// evidence rather than assumption. Read-only — no writes anywhere.
import postgres from "postgres";
import { buildFabricColourIndex, isPendingColour, foldColour } from "./lib/fabric-colour-match.mjs";
import { parseBedframe } from "./lib/parse-bedframe.mjs";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const QUERY = (process.env.NAMES || [
  "BOOBOO315-31", "grafield1-softlinen", "ZL-6 Lether", "ZL-20 BLACK",
  "J9883-2-Chic", "J9226-2-buttercream", "M2402-8", "Wowsons-8877-3 Hazelnut",
  "CHANTIC 141-2", "NX007", "NX010 Ivory", "NX011-Beige", "GD2502#04-OAK",
  "GD2502#18-Grey", "GD 2502#09- sandy", "HR805-40", "HR805-31", "KN390-2",
  "Mordenza 06", "Modenza 06", "Modenza 02 Barley", "modenza 01- Houston cream",
  "B0315-2 feather", "B0315-23 Beige", "BOO315-11", "BOO315-25", "BO315-4",
].join("|")).split("|");

const rows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = 1`;
note(`fabric_colours rows: ${rows.length}`);
const { findColour, folded, ambiguous } = buildFabricColourIndex(rows);

const MODE = (process.env.DUMP || "0").toLowerCase();

/* DUMP=1 prints the WHOLE library, grouped by series. Without it this probe can
   only answer "is THIS name in there?", one name at a time — which is no use
   when 138 document lines carry a colour that would not bind and the question
   is really "what does the library actually contain, and which of these are
   spacing/suffix variants of something that IS there?" (owner 2026-08-10:
   "这些你不能只能跟我们 fabrics matching?"). Read-only either way. */
if (MODE === "1" || MODE === "scan") {
  const bySeries = new Map();
  for (const r of rows) {
    const k = r.fabric_id ?? "(no fabric_id)";
    if (!bySeries.has(k)) bySeries.set(k, []);
    bySeries.get(k).push(r);
  }
  note(`--- LIBRARY DUMP: ${bySeries.size} series / ${rows.length} colours ---`);
  for (const [series, list] of [...bySeries].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const cols = list
      .map((r) => (r.label && String(r.label).trim() && String(r.label) !== String(r.colour_id)
        ? `${r.colour_id}=${r.label}` : `${r.colour_id}`))
      .sort();
    note(`SERIES ${series} (${cols.length}): ${cols.join(" | ")}`);
  }
}
note(`ambiguous folds dropped: ${ambiguous.size} (fold index ${folded.size})`);

/* DUMP=scan additionally walks the LIVE migrated document lines that carry no
   bound fabric and re-runs the shared matcher over the colour their AutoCount
   Desc2 still holds. That is the only way to answer "which of these does the
   library genuinely NOT have?" with evidence instead of a guess — and it is
   what decides the create-missing-sofa-fabrics.mjs candidate list. Read-only. */
if (MODE === "scan") {
  const soLines = await sql`
    SELECT i.item_group, i.description2, i.variants
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND i.item_group IN ('sofa', 'bedframe')
       AND COALESCE(i.variants->>'fabricCode', '') = ''`;
  const poLines = await sql`
    SELECT i.item_group, i.description2, i.variants
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = 1 AND i.item_group IN ('sofa', 'bedframe')
       AND COALESCE(i.variants->>'fabricCode', '') = ''`;
  const lines = [...soLines.map((r) => ({ ...r, src: "SO" })), ...poLines.map((r) => ({ ...r, src: "PO" }))];
  note(`--- LIVE SCAN: ${lines.length} unbound lines (SO ${soLines.length} / PO ${poLines.length}) ---`);

  // mirrors parse-sofa's colour arm; a bedframe goes through the real parser
  const sofaColour = (d2) => {
    const m = /col(?:our|or)?\s*[-:：]\s*([^\/\n]+)/i.exec(d2 || "");
    return m ? m[1].trim() : null;
  };
  const seen = new Map();
  let withColour = 0, nowBinds = 0;
  for (const l of lines) {
    const raw = (l.item_group === "bedframe" ? parseBedframe(l.description2 || "").color : sofaColour(l.description2))
      || (l.variants && l.variants.colourLabel) || null;
    if (!raw || !String(raw).trim() || isPendingColour(raw)) continue;
    withColour++;
    const key = String(raw).trim();
    if (!seen.has(key)) seen.set(key, { n: 0, group: l.item_group });
    seen.get(key).n++;
  }
  const resolved = [], missing = [];
  for (const [c, meta] of [...seen].sort((a, b) => a[0].localeCompare(b[0]))) {
    const h = findColour(c);
    if (h) { resolved.push([c, meta, h]); nowBinds += meta.n; } else missing.push([c, meta]);
  }
  note(`lines carrying a colour: ${withColour}; distinct strings: ${seen.size}`);
  note(`RESOLVED by the shared matcher: ${resolved.length} distinct / ${nowBinds} lines`);
  for (const [c, meta, h] of resolved) note(`  BINDS   ${String(meta.n).padStart(3)}x [${meta.group}] ${c}  ->  ${h.fabric_id} / ${h.colour_id}`);
  note(`STILL UNRESOLVED: ${missing.length} distinct / ${withColour - nowBinds} lines`);
  for (const [c, meta] of missing) {
    const f = foldColour(c);
    const near = rows.filter((r) => { const k = foldColour(r.colour_id); return k && f && (k.startsWith(f.slice(0, 4)) || f.startsWith(k.slice(0, 4))); })
      .slice(0, 4).map((r) => r.colour_id);
    note(`  MISSING ${String(meta.n).padStart(3)}x [${meta.group}] ${c}   nearest: ${near.length ? near.join(", ") : "(no sibling series)"}`);
  }
}

for (const q of QUERY) {
  const h = findColour(q);
  note(h ? `HIT     ${q}  ->  ${h.fabric_id} / ${h.colour_id} (${h.label})` : `MISSING ${q}  ->  库里没有`);
}
await sql.end({ timeout: 5 });
