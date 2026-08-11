#!/usr/bin/env node
/* Bring scm.fabric_colours to the catalogue the owner dictated on 2026-08-11.

   WHAT THE OWNER GAVE US. A flat list of every fabric code the business is
   supposed to hold, series by series, most of them with their colour NAME.
   His three rulings, verbatim, are what this script implements:

     "没有的都帮我开code进去"     open the codes that are missing
     "旧的就merge起来 跟我们现在的整齐的"  merge the old spellings into the tidy form
     "同个颜色的就merge起来"       merge the rows that are the same colour
     "Modenza 才对"                MODENZA keeps its spelling; the list's
                                   "MONDENZA" is a typo and must NOT rename it

   WHY A MERGE IS NEEDED AT ALL. The library grew one row per SPELLING, not one
   per colour. CH141 holds 28 rows for 14 colours ("CH141-8" and "CH141-8-ARMY"
   are the same fabric), AM275 holds 16 for 14, M2402 holds 21 for 12, and ZL /
   ORION carry unpadded ids ("ZL-3", "ORION-1") beside padded ones. Creating the
   owner's "ZL-03" without merging would make it a 3rd spelling of one colour.

   NOTHING IS DELETED. The owner's standing rule is that a row is cancelled,
   never dropped, and #1972 already set the shape for fabric merges: the losing
   row stays, goes active = false, and its label records which code absorbed it.
   A historical document that still names the loser still resolves for display.

   WHICH ROW WINS. The one PRODUCTION references more, counted off live document
   lines across all FOUR arms that can name a fabric (SO, PO, GRN, DO) - the
   same four #1964 found unswept. Ties go to the row whose colour_id already
   equals the canonical form, then to the longer label (it carries the name),
   then to the shorter id. The point is to move the fewest live rows.

   RENAMING IS A MERGE OF ONE. Setting "ZL-3" to "ZL-03" changes the string live
   lines carry in variants->>'fabricCode', so a rename repoints those lines too.
   A rename that never touched the documents would orphan them silently, which
   is the same defect class as the unswept GRN arm.

   MATCHING USES THE SHARED MATCHER, NOT A LOCAL COPY. lib/fabric-colour-match
   is the one place that knows letter-O folds to zero while a colour NUMBER may
   never move (the digit guard, #1976). A local re-implementation is how five
   scripts drifted apart before #1893 pulled them back together.

   THE JSONB WRITE USES jsonb_set + to_jsonb($1::text). Binding a pre-serialized
   string to a jsonb parameter is what destroyed the variants column three times
   on 2026-08-10 - see docs/jsonb-double-encoding-coe.md.

   MODE=plan (default) prints and writes nothing.
   MODE=apply writes, and needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". */
import postgres from "postgres";
import { normColour, foldColour, markColour } from "./lib/fabric-colour-match.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
if (APPLY && process.env.CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error('apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN"');
  process.exit(1);
}
const ONLY = (process.env.SERIES || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const STAMP = process.env.NOTE_DATE || "2026-08-11";

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

/* Every table whose variants block can name a fabric colour, and how each row
   reaches its company. Table names are literal constants interpolated as
   identifiers because an identifier cannot be a bind parameter; every VALUE is
   still bound, and none of them is jsonb.

   The company test is an EXISTS, not a JOIN, so the same clause serves both the
   count and the UPDATE. An UPDATE ... FROM would need the item table to have a
   surrogate key, and scm.mfg_sales_orders is keyed by doc_no with no id column
   at all (#1854) - close enough to that trap to be worth avoiding. */
const ARMS = [
  { name: "SO", t: "scm.mfg_sales_order_items", ex: "SELECT 1 FROM scm.mfg_sales_orders h WHERE h.doc_no = i.doc_no AND h.company_id = $1" },
  { name: "PO", t: "scm.purchase_order_items", ex: "SELECT 1 FROM scm.purchase_orders h WHERE h.id = i.purchase_order_id AND h.company_id = $1" },
  { name: "GRN", t: "scm.grn_items", ex: "SELECT 1 FROM scm.grns h WHERE h.id = i.grn_id AND h.company_id = $1" },
  { name: "DO", t: "scm.delivery_order_items", ex: "SELECT 1 FROM scm.delivery_orders h WHERE h.id = i.delivery_order_id AND h.company_id = $1" },
];

/* ---------------------------------------------------------------------------
   THE OWNER'S CATALOGUE, 2026-08-11, transcribed verbatim.

   `id` is the canonical colour_id this script drives every spelling towards.
   `name` is the colour name he gave; blank means his list gave none, and this
   script then leaves the label as the code alone rather than inventing one.

   Two transcription decisions, both his, both recorded here so the next reader
   does not "fix" them back:
     - MODENZA, not MONDENZA. He confirmed the spelling when asked.
     - GD2502 keeps the '#' in its LABEL ("GD2502#04 OAK") because that is how
       the existing rows read, but its colour_id is dashed like every other
       series, which is what the matcher's rung 2 already assumes.
--------------------------------------------------------------------------- */
const N = (series, id, name) => ({ series, id, name: name || "" });
const seq = (series, prefix, from, to, pad = 2) => {
  const out = [];
  for (let i = from; i <= to; i++) out.push(N(series, `${prefix}${String(i).padStart(pad, "0")}`, ""));
  return out;
};

const CATALOGUE = [
  ...[
    ["01", "IVORY"], ["02", "BUTTER CREAM"], ["03", "CHAMPAGNE"], ["04", "GREIGE"],
    ["05", "SMOKE"], ["06", "DESSERT"], ["07", "FOSSIL"], ["08", "STONE"],
    ["09", "TAUPE"], ["10", "MUSTARD"], ["11", "ORANGE"], ["12", "TAN"],
    ["13", "OLIVE"], ["14", "JADE"], ["15", "MISTY"], ["16", "METAL"],
    ["17", "GREY"], ["18", "SLATE"], ["19", "DARK BROWN"], ["20", "BLACK"],
  ].map(([n, c]) => N("ZL", `ZL-${n}`, c)),

  ...[
    ["01", "HOUSTON CREAM"], ["02", "BARLEY"], ["03", "BROWN"], ["04", "MUSTARD"],
    ["05", "DARK OLIVE"], ["06", "SILVER GREY"], ["07", "SILVER HEATHER"], ["08", "GRAPHITE"],
  ].map(([n, c]) => N("MODENZA", `MODENZA-${n}`, c)),

  /* 21-32 are the same twelve colours with a star. The star is part of the
     NAME the owner wrote, not of the code, so it rides in the label. */
  ...[
    ["01", "PEARL"], ["02", "FEATHER"], ["03", "BEIGE"], ["04", "SAND"],
    ["05", "FOSSIL"], ["06", "YELLOW"], ["07", "PEACH"], ["08", "SKY"],
    ["09", "MINT"], ["10", "SILVER"], ["11", "METAL"], ["12", "DEEP GREY"],
    ["21", "PEARL*"], ["22", "FEATHER*"], ["23", "BEIGE*"], ["24", "SAND*"],
    ["25", "FOSSIL*"], ["26", "YELLOW*"], ["27", "PEACH*"], ["28", "SKY*"],
    ["29", "MINT*"], ["30", "SILVER*"], ["31", "METAL*"], ["32", "DEEP GREY*"],
  ].map(([n, c]) => N("BO315", `BO315-${n}`, c)),

  ...[
    ["001", "CANDY"], ["002", "BANANA"], ["003", "HONEY"], ["004", "OPAL"],
    ["005", "AVOCADO"], ["006", "PACIFIC"], ["007", "LILAC"], ["008", "TORTILLA"],
    ["009", "EARTH"], ["010", "IVORY"], ["011", "BEIGE"], ["012", "DOVE"],
    ["013", "GRANITE"], ["014", "SMOKE"], ["015", "FERN"], ["016", "CHARCOAL"],
  ].map(([n, c]) => N("NX", `NX${n}`, c)),

  ...[
    ["04", "OAK"], ["09", "SANDY"], ["11", "WHEAT"], ["13", "PEARL"],
    ["14", "SILVER"], ["18", "GREY"], ["20", "DARK GREY"], ["22", "INK"],
  ].map(([n, c]) => N("GD2502", `GD2502-${n}`, c)),

  ...[
    ["01", "IVORY"], ["02", "BEIGE"], ["03", "LATTE"], ["04", "WOOD"],
    ["05", "BROWN"], ["06", "BEE"], ["07", "FOREST"], ["08", "TURQUOISE"],
    ["09", "NAVY"], ["10", "MAROON"], ["11", "VIOLET"], ["12", "SILVER"],
    ["13", "GREY"], ["14", "CHARCOAL"],
  ].map(([n, c]) => N("AM275", `AM275-${n}`, c)),

  /* 13 and 14 are the other way round in the library today (13 CHARCOAL /
     14 DEEP GREY). The owner's list is the authority, so this renames them.
     Only the NAME moves - the code a live document carries does not. */
  ...[
    ["01", "CREAM"], ["02", "BEIGE"], ["03", "KHAKI"], ["04", "WOOD"],
    ["05", "PEARL"], ["06", "PEACH"], ["07", "WINE"], ["08", "ARMY"],
    ["09", "SKY"], ["10", "OCEAN"], ["11", "SILVER"], ["12", "METAL"],
    ["13", "DEEP GREY"], ["14", "CHARCOAL"],
  ].map(([n, c]) => N("CH141", `CH141-${n}`, c)),

  ...[
    ["01", "PEARL"], ["04", "SAND"], ["05", "LIGHT BROWN"], ["06", "FOSSIL"],
    ["07", "DARK BROWN"], ["08", "YELLOW"], ["09", "TAN"], ["13", "FOREST"],
    ["15", "AQUA"], ["17", "SILVER"], ["18", "LIGHT GREY"], ["19", "DARK GREY"],
  ].map(([n, c]) => N("M2402", `M2402-${n}`, c)),

  ...seq("ORION", "ORION-", 1, 13),
  ...seq("TR", "TR", 1, 21),
  ...seq("DE", "DE", 1, 22),
  ...["10", "20", "30", "31", "40", "90"].map((n) => N("HR805", `HR805-${n}`, "")),
];

const labelFor = (e) => {
  if (!e.name) return e.id;
  // GD2502 reads with a '#' in its label, which is how every existing row reads
  if (e.series === "GD2502") return `${e.id.replace("-", "#")} ${e.name}`;
  return `${e.id} ${e.name}`;
};

/* --------------------------------------------------------------------------
   Recognition. Re-derived from merge-duplicate-fabric-series.mjs so the two
   agree: peel a trailing colour NAME, drop a leading brand word, pad a
   one-digit tail while the separator is still there, then fold. The digit test
   runs in MARK space, where letter-O is '@' and a written zero stays '0', so
   BO315 and B0315 agree while 10 and 01 never do.
-------------------------------------------------------------------------- */
const dropName = (s) => {
  let v = s, m;
  while ((m = /^(.+?)[\s-]+[A-Z*]+$/.exec(v)) && /\d/.test(m[1]) && /[A-Z]/.test(m[1])) v = m[1].trim();
  return v;
};
const dropBrand = (s) => s.replace(/^[A-Z]+\s+(?=[A-Z]*\d)/, "");
const padWrittenTail = (s) => s.replace(/([\s-])(\d)$/, "$10$2");
const digitsOf = (mark) => (mark.match(/\d+/g) || []).join("-");

/* Every key a row could be recognised by, taken from colour_id AND label. */
const keysOf = (...sources) => {
  const out = new Set();
  for (const src of sources) {
    if (!src) continue;
    const base = dropName(normColour(src));
    for (const v of [base, dropBrand(base), padWrittenTail(base), dropBrand(padWrittenTail(base))]) {
      const f = foldColour(v), m = markColour(v);
      if (!f || !/\d/.test(m)) continue;   // a name-only label carries no identity
      out.add(`${f}|${digitsOf(m)}`);
    }
  }
  return out;
};

const armCount = (client, code) => Promise.all(ARMS.map(async (arm) => {
  const r = await client.unsafe(
    `SELECT COUNT(*)::int AS n FROM ${arm.t} i
      WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
        AND i.variants->>'fabricCode' = $2`, [CO, code]);
  return { arm: arm.name, n: r[0].n };
}));

const repoint = (client, from, to) => Promise.all(ARMS.map(async (arm) => {
  const r = await client.unsafe(
    `UPDATE ${arm.t} i
        SET variants = jsonb_set(i.variants, '{fabricCode}', to_jsonb($3::text))
      WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
        AND i.variants->>'fabricCode' = $2`, [CO, from, to]);
  return { arm: arm.name, n: r.count };
}));

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const wanted = ONLY.length ? CATALOGUE.filter((e) => ONLY.includes(e.series)) : CATALOGUE;
  note(`MODE=${MODE} company=${CO} catalogue entries=${wanted.length}${ONLY.length ? ` (series filter: ${ONLY.join(",")})` : ""}`);

  const libs = await sql`SELECT id, label, tier, default_surcharge, sort_order, active
                           FROM scm.fabric_library WHERE company_id = ${CO}`;
  const cols = await sql`SELECT fabric_id, colour_id, label, active, sort_order
                           FROM scm.fabric_colours WHERE company_id = ${CO}`;
  note(`library: ${libs.length} series / ${cols.length} colours`);

  // index every existing colour by every key it answers to
  const byKey = new Map();
  for (const r of cols) for (const k of keysOf(r.colour_id, r.label)) {
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const libByStripped = new Map();
  for (const l of libs) {
    const k = normColour(l.id).replace(/[^A-Z0-9]/g, "");
    if (!libByStripped.has(k)) libByStripped.set(k, l);
  }

  // live reference counts, once per distinct existing colour string
  const refCache = new Map();
  const refsFor = async (code) => {
    if (!refCache.has(code)) {
      const per = await armCount(sql, code);
      refCache.set(code, per.reduce((a, b) => a + b.n, 0));
    }
    return refCache.get(code);
  };

  const plan = { create: [], rename: [], merge: [], ok: [], reparent: [], newSeries: new Set() };
  const claimed = new Set();

  for (const e of wanted) {
    const keys = keysOf(e.id, labelFor(e));
    const hits = new Map();
    for (const k of keys) for (const r of byKey.get(k) || []) hits.set(`${r.fabric_id} ${r.colour_id}`, r);
    const rows = [...hits.values()];
    for (const r of rows) claimed.add(`${r.fabric_id} ${r.colour_id}`);

    if (!rows.length) {
      if (!libByStripped.has(e.series)) plan.newSeries.add(e.series);
      plan.create.push({ e });
      continue;
    }
    const scored = [];
    for (const r of rows) scored.push({ r, refs: await refsFor(r.colour_id) });
    /* The row that ALREADY carries the canonical id wins outright, ahead of
       reference count. Two reasons, and the first is not a preference:
       (fabric_id, colour_id) is the primary key, so renaming some other row to
       the canonical id while that row still holds it is a constraint violation.
       Letting it win means a rename only ever happens when nothing holds the
       target. Second, it is also the least surprising outcome - the tidy
       spelling the owner asked us to converge on is the one that survives.
       Everything below it is #1972's rule: the side production references more. */
    scored.sort((a, b) =>
      (normColour(b.r.colour_id) === e.id) - (normColour(a.r.colour_id) === e.id) ||
      b.refs - a.refs ||
      (b.r.label || "").length - (a.r.label || "").length ||
      String(a.r.colour_id).length - String(b.r.colour_id).length);
    const [win, ...lose] = scored;
    const needsRename = normColour(win.r.colour_id) !== e.id || normColour(win.r.label || "") !== normColour(labelFor(e));
    if (lose.length) plan.merge.push({ e, win, lose, needsRename });
    else if (needsRename) plan.rename.push({ e, win });
    else plan.ok.push({ e });

    /* The winner can be sitting under the WRONG series row, and renaming its
       colour_id does not move it. The 2026-08-11 apply left exactly two that
       way: AM275-07 stayed under the space-spelled series "AM 275", and NX016
       stayed under a one-colour junk series literally called "NX016". The
       colour is then correct and still invisible in its own series' picker.

       merge-duplicate-fabric-series cannot fix these two. It picks the side
       production references more, which for AM 275 / AM275 is the SPACE one
       (it holds the 2 live lines), so applying it would move 16 real colours
       onto the junk name - backwards. And NX / NX016 share no colour code at
       all, so its detector is blind to the pair and says so.

       Re-parenting is the narrow fix: move the colour to the series its code
       names, and repoint any live line that named the old series. */
    const canonical = libByStripped.get(e.series)?.id ?? e.series;
    if (normColour(win.r.fabric_id) !== normColour(canonical) && !plan.newSeries.has(e.series)) {
      plan.reparent.push({ e, row: win.r, from: win.r.fabric_id, to: canonical });
    }
  }

  // rows sitting in the owner's series that his list does not mention
  const seriesOfEntry = new Set(wanted.map((e) => e.series));
  const extras = cols.filter((r) => {
    if (claimed.has(`${r.fabric_id} ${r.colour_id}`)) return false;
    const s = normColour(r.fabric_id).replace(/[^A-Z0-9]/g, "");
    return [...seriesOfEntry].some((x) => s === x || s.startsWith(x));
  });

  note("");
  note(`PLAN  create ${plan.create.length} | merge ${plan.merge.length} | rename ${plan.rename.length} | re-parent ${plan.reparent.length} | already correct ${plan.ok.length}`);
  note(`      new SERIES to open: ${plan.newSeries.size ? [...plan.newSeries].join(", ") : "none"}`);
  note(`      rows in these series the list does not mention (LEFT ALONE): ${extras.length}`);

  if (plan.create.length) {
    note("");
    note(`--- CREATE (${plan.create.length}) ---`);
    for (const { e } of plan.create) note(`  + ${e.id.padEnd(14)} ${labelFor(e)}`);
  }
  if (plan.merge.length) {
    note("");
    note(`--- MERGE (${plan.merge.length}) — winner keeps, losers superseded, live lines repointed ---`);
    for (const m of plan.merge) {
      note(`  ${m.e.id.padEnd(14)} keep "${m.win.r.colour_id}" (${m.win.refs} live line(s))${m.needsRename ? " -> renamed to canonical" : ""}`);
      for (const l of m.lose) note(`      absorb "${l.r.colour_id}" label=${JSON.stringify(l.r.label)} refs=${l.refs}`);
    }
  }
  if (plan.rename.length) {
    note("");
    note(`--- RENAME (${plan.rename.length}) — code and/or name moves to the canonical form ---`);
    for (const r of plan.rename) {
      note(`  "${r.win.r.colour_id}" / ${JSON.stringify(r.win.r.label)}  ->  "${r.e.id}" / ${JSON.stringify(labelFor(r.e))}  (${r.win.refs} live line(s))`);
    }
  }
  if (plan.reparent.length) {
    note("");
    note(`--- RE-PARENT (${plan.reparent.length}) — the colour is right, its SERIES is not ---`);
    for (const p of plan.reparent) note(`  "${p.e.id}" moves from series "${p.from}" to "${p.to}"`);
  }
  if (extras.length) {
    note("");
    note(`--- NOT IN THE OWNER'S LIST, left exactly as they are (${extras.length}) ---`);
    for (const r of extras) note(`  ? ${String(r.colour_id).padEnd(20)} ${JSON.stringify(r.label)} series=${r.fabric_id}`);
  }

  if (!APPLY) {
    note("");
    note('PLAN ONLY - nothing was written. MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" to write.');
    await sql.end({ timeout: 5 });
    return;
  }

  note("");
  note("--- APPLY ---");
  let created = 0, merged = 0, renamed = 0, moved = 0, seriesOpened = 0, reparented = 0;
  await sql.begin(async (tx) => {
    let sortCursor = Math.max(0, ...libs.map((l) => Number(l.sort_order) || 0));
    for (const s of plan.newSeries) {
      /* tier 'standard' + surcharge 0 is the conservative default this repo
         already uses for a brand-new series (add-missing-sofa-fabrics.mjs):
         a guessed surcharge would silently price every order on it. */
      sortCursor += 10;
      await tx`INSERT INTO scm.fabric_library (id, label, tier, default_surcharge, active, sort_order, company_id)
               VALUES (${s}, ${s}, 'standard', 0, true, ${sortCursor}, ${CO})
               ON CONFLICT (id) DO NOTHING`;
      seriesOpened++;
      note(`  series opened: ${s} (tier=standard, surcharge 0)`);
    }
    for (const m of plan.merge) {
      for (const l of m.lose) {
        if (normColour(l.r.colour_id) !== m.e.id) {
          const r = await repoint(tx, l.r.colour_id, m.e.id);
          const n = r.reduce((a, b) => a + b.n, 0);
          moved += n;
          if (n) note(`  repointed ${n} line(s): "${l.r.colour_id}" -> "${m.e.id}" (${r.filter((x) => x.n).map((x) => `${x.arm}:${x.n}`).join(" ")})`);
        }
        await tx`UPDATE scm.fabric_colours
                    SET active = false,
                        label = ${`${l.r.label || l.r.colour_id} [superseded by ${m.e.id} on ${STAMP}]`}
                  WHERE company_id = ${CO} AND fabric_id = ${l.r.fabric_id} AND colour_id = ${l.r.colour_id}`;
        merged++;
      }
    }
    for (const item of [...plan.merge.filter((m) => m.needsRename), ...plan.rename]) {
      const from = item.win.r.colour_id;
      if (normColour(from) !== item.e.id) {
        const r = await repoint(tx, from, item.e.id);
        moved += r.reduce((a, b) => a + b.n, 0);
      }
      await tx`UPDATE scm.fabric_colours
                  SET colour_id = ${item.e.id}, label = ${labelFor(item.e)}, active = true
                WHERE company_id = ${CO} AND fabric_id = ${item.win.r.fabric_id} AND colour_id = ${from}`;
      renamed++;
    }
    const perSeries = new Map();
    for (const r of cols) perSeries.set(r.fabric_id, (perSeries.get(r.fabric_id) || 0) + 1);
    for (const { e } of plan.create) {
      const fabricId = libByStripped.get(e.series)?.id ?? e.series;
      const n = (perSeries.get(fabricId) || 0) + 1;
      perSeries.set(fabricId, n);
      await tx`INSERT INTO scm.fabric_colours (fabric_id, colour_id, label, active, sort_order, company_id)
               VALUES (${fabricId}, ${e.id}, ${labelFor(e)}, true, ${n * 10}, ${CO})
               ON CONFLICT (fabric_id, colour_id) DO NOTHING`;
      created++;
    }
    /* Move the colour onto the series its own code names, take any live line
       that pointed at the old series with it, and then retire that series if
       re-parenting emptied it of anything active. An emptied series is retired,
       never dropped - the same rule the colours follow. */
    for (const p of plan.reparent) {
      const clash = await tx`SELECT 1 FROM scm.fabric_colours
                              WHERE company_id = ${CO} AND fabric_id = ${p.to} AND colour_id = ${p.e.id}`;
      if (clash.length) { bad(`"${p.e.id}" already exists under "${p.to}" - re-parent skipped, this is a real duplicate to look at`); continue; }
      await tx`UPDATE scm.fabric_colours SET fabric_id = ${p.to}
                WHERE company_id = ${CO} AND fabric_id = ${p.from} AND colour_id = ${p.e.id}`;
      for (const arm of ARMS) {
        const r = await tx.unsafe(
          `UPDATE ${arm.t} i
              SET variants = jsonb_set(i.variants, '{fabricId}', to_jsonb($3::text))
            WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
              AND i.variants->>'fabricId' = $2 AND i.variants->>'fabricCode' = $4`,
          [CO, p.from, p.to, p.e.id]);
        moved += r.count;
      }
      reparented++;
      const left = await tx`SELECT COUNT(*)::int AS n FROM scm.fabric_colours
                             WHERE company_id = ${CO} AND fabric_id = ${p.from} AND active`;
      if (left[0].n === 0) {
        await tx`UPDATE scm.fabric_library
                    SET active = false,
                        label = ${`${p.from} [emptied into ${p.to} on ${STAMP}]`}
                  WHERE company_id = ${CO} AND id = ${p.from}`;
        note(`  series "${p.from}" retired - re-parenting left it with no active colour`);
      }
      note(`  re-parented "${p.e.id}": "${p.from}" -> "${p.to}"`);
    }
  });
  note(`  series opened ${seriesOpened} | created ${created} | superseded ${merged} | renamed ${renamed} | re-parented ${reparented} | live lines repointed ${moved}`);

  /* Verify on a SECOND, FRESH connection - a read inside the writing session
     can see its own uncommitted work and would prove nothing. */
  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let fails = 0;
  try {
    note("");
    note("--- VERIFY (fresh connection) ---");
    const after = await v`SELECT colour_id, label, active FROM scm.fabric_colours WHERE company_id = ${CO}`;
    /* Prefer an ACTIVE row: a superseded twin under another series can hold the
       same colour_id, and checking that one would fail for the wrong reason. */
    const have = new Map();
    for (const r of after) {
      const k = normColour(r.colour_id);
      if (!have.has(k) || (have.get(k).active === false && r.active !== false)) have.set(k, r);
    }
    for (const e of wanted) {
      const r = have.get(e.id);
      if (!r) { fails++; bad(`${e.id} is still not in the library`); continue; }
      if (r.active === false) { fails++; bad(`${e.id} exists but is inactive`); }
      if (normColour(r.label || "") !== normColour(labelFor(e))) { fails++; bad(`${e.id} label is ${JSON.stringify(r.label)}, expected ${JSON.stringify(labelFor(e))}`); }
    }
    for (const m of plan.merge) for (const l of m.lose) {
      const gone = !after.some((r) => r.colour_id === l.r.colour_id);
      if (gone && normColour(l.r.colour_id) !== m.e.id) { fails++; bad(`"${l.r.colour_id}" is GONE - it must be superseded, not deleted`); }
      const left = (await armCount(v, l.r.colour_id)).reduce((a, b) => a + b.n, 0);
      if (left && normColour(l.r.colour_id) !== m.e.id) { fails++; bad(`${left} line(s) still name "${l.r.colour_id}"`); }
    }
    /* The shape the 2026-08-10 COE is about: no variants block anywhere may
       have been turned into an array by a bad jsonb write. */
    for (const arm of ARMS) {
      const r = await v.unsafe(
        `SELECT COUNT(*)::int AS n FROM ${arm.t} i
          WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'array'`, [CO]);
      note(`  ${arm.name}: array-shaped variants blocks (must be 0): ${r[0].n}`);
      if (r[0].n) { fails++; bad(`${arm.name} holds ${r[0].n} array-shaped variants block(s)`); }
    }
    note(`  VERIFY ${fails === 0 ? "PASS" : `FAILED with ${fails} problem(s)`}`);
  } finally { await v.end({ timeout: 5 }); }
  await sql.end({ timeout: 5 });
  if (fails) process.exit(1);
}

main().catch((e) => { bad(e.message); process.exit(1); });
