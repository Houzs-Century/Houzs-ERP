#!/usr/bin/env node
/* Give every fabric colour in the library ONE shape.

   THE OWNER'S RULE, 2026-08-11, quoted back and approved verbatim:

     系列  = J9226          the brand word comes off
     code  = J9226-01       series + a two-digit number. No brand, no colour
                            name, no '#'
     描述  = J9226-01 SAND  the code, then the colour name

   WHY. The library grew by whatever a document happened to write, so the CODE
   column holds anything from "ZL-01" to "AGAZZI JD12377-1 TOASRED ALMOND" - the
   owner's words were "有些很长 有些很短 我们要统一吧". A code that carries the
   colour name is also a code that changes when someone corrects a spelling,
   which is how one fabric ends up stored under three ids.

   THE BRAND IS NOT DELETED, IT MOVES. Owner: "搬到系列...名字". The series ID
   loses it, the series NAME keeps it - "J9226" displayed as "J9226 (ARMANI)" -
   so nobody has to remember that J9226 is Armani's.

   THE TRAP THIS IS BUILT AROUND: a leading word is NOT always a brand.
   "ARMANI J9226" is brand + code, because J9226 is already a complete code -
   letters AND digits. "PC 1461" is not: 1461 is digits only, so PC is part of
   the series and the pair joins into PC1461. Dropping "PC" would invent a
   series called 1461 and orphan every line on it. The test is what FOLLOWS the
   word, never a list of known brand names, which would go stale on the first
   new supplier.

   NOTHING IS DELETED. A row that loses is superseded - active = false, label
   records what absorbed it - the same rule #1972 set and the catalogue script
   follows. Live lines are repointed on BOTH axes (fabricCode and fabricId)
   across EVERY arm lib/fabric-write knows (fifteen as of 2026-08-13), together
   with the stored description2, the variant_key stock bucket and the model's
   allowed_options whitelist — a code change that moves only variants is what
   stranded stock on 2026-08-11.

   THE OWNER'S OWN 12 SERIES ARE SKIPPED. seed-owner-fabric-catalogue.mjs
   already drove those to their canonical form from his list, including colour
   names this script cannot know. Re-deriving them here would fight it.

   MODE=plan (default) prints and writes nothing.
   MODE=apply writes, and needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". */
import postgres from "postgres";
import { normColour } from "./lib/fabric-colour-match.mjs";
import { strip, seriesToken, isJunkBucket, parse, canonId, canonLabel } from "./lib/fabric-code.mjs";
import {
  countColour, countSeries, repointColour, repointSeries, arrayShapeCheck, sum, busy,
  /* A colour CODE change is not just a variants edit. The same string is also
     materialised into the physical stock bucket (variant_key), rendered into
     the stored description2 every PDF prints, and listed in the model's
     allowed_options whitelist. Repointing variants alone is what left
     BO315-2-FEATHER's 3 SO lines and 3 PO lines pointing at one code while its
     3 inventory_movements and 3 inventory_lots rows stayed in the other —
     found by the census on 2026-08-13, after the 2026-08-11 pass. */
  repointDescription2, repointVariantKey, repointAllowedOptions, skippedArms,
} from "./lib/fabric-write.mjs";

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

/* The series seed-owner-fabric-catalogue.mjs owns. It drove these to the
   owner's own list, colour names included; this script must not re-derive them. */
const CATALOGUE_SERIES = new Set(["ZL", "MODENZA", "BO315", "NX", "GD2502", "AM275", "CH141", "M2402", "ORION", "TR", "DE", "HR805"]);

async function main() {
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  note(`MODE=${MODE} company=${CO}${ONLY.length ? ` series filter: ${ONLY.join(",")}` : ""}`);

  const libs = await sql`SELECT id, label, tier, default_surcharge, sort_order, active
                           FROM scm.fabric_library WHERE company_id = ${CO}`;
  const cols = await sql`SELECT fabric_id, colour_id, label, active, sort_order
                           FROM scm.fabric_colours WHERE company_id = ${CO}`;
  note(`library: ${libs.length} series / ${cols.length} colours`);

  const refCache = new Map();
  const refs = async (code) => {
    if (!refCache.has(code)) refCache.set(code, sum(await countColour(sql, CO, code)));
    return refCache.get(code);
  };

  /* Group every ACTIVE colour by the canonical code it should carry. A group
     with more than one member is two spellings of one colour. */
  const groups = new Map();
  const unparsed = [], skipped = [], junk = [];
  for (const r of cols) {
    if (r.active === false) continue;
    const p = parse(r.colour_id);
    if (!p) { unparsed.push(r); continue; }
    if (isJunkBucket(r.fabric_id) || isJunkBucket(r.colour_id)) { junk.push(r); continue; }
    if (CATALOGUE_SERIES.has(p.series)) { skipped.push(r); continue; }
    if (ONLY.length && !ONLY.includes(p.series)) continue;
    const id = canonId(p);
    if (!groups.has(id)) groups.set(id, { id, series: p.series, rows: [], brands: new Set() });
    const g = groups.get(id);
    g.rows.push({ r, p });
    if (p.brand) g.brands.add(p.brand);
  }

  const plan = { change: [], merge: [], seriesRename: new Map(), ok: 0 };
  for (const g of groups.values()) {
    const scored = [];
    for (const x of g.rows) scored.push({ ...x, refs: await refs(x.r.colour_id) });
    /* The row already carrying the canonical id wins outright - it is half the
       primary key, so renaming another row onto an id something still holds is
       a constraint violation, not a preference. Then the side production
       references more, then the longer label because it carries the name. */
    scored.sort((a, b) =>
      (normColour(b.r.colour_id) === g.id) - (normColour(a.r.colour_id) === g.id) ||
      b.refs - a.refs ||
      (b.r.label || "").length - (a.r.label || "").length);
    const [win, ...lose] = scored;

    /* The winner's NAME is the best one in the group: its own if it has one,
       otherwise any sibling's. A merge must not lose the only colour name. */
    let best = win.p.name;
    if (!best) for (const s of scored) if (s.p.name) { best = s.p.name; break; }
    const target = { ...win.p, name: best };
    const newId = canonId(target), newLabel = canonLabel(target);

    if (lose.length) plan.merge.push({ g, win, lose, newId, newLabel });
    if (normColour(win.r.colour_id) !== newId || normColour(win.r.label || "") !== normColour(newLabel)) {
      plan.change.push({ win, newId, newLabel });
    } else if (!lose.length) plan.ok++;

    const oldSeries = win.r.fabric_id;
    if (seriesToken(oldSeries) !== g.series) {
      const brand = [...g.brands][0] || null;
      plan.seriesRename.set(oldSeries, { from: oldSeries, to: g.series, brand });
    }
  }

  /* THE CONSISTENCY GUARD, and the reason it exists.

     The first production plan (run 31465598454) proposed 37 series renames.
     Thirty-four were right - the brand extractions, NB01..NB10 -> NB,
     NINJA 0x -> NINJA, STAR 0x -> STAR. Three were garbage:

       "SF"        -> "SFAT"
       "J9883"     -> "J98831"
       "UNMATCHED" -> "UNMATCHEDPICCOFG66151"

     Every one of those is a series whose colours do NOT agree on what the
     series is. "UNMATCHED" is a junk bucket holding unrelated codes; a rename
     driven by whichever colour happened to be scored first would have renamed a
     real, referenced series to a string nobody will ever type.

     So a rename needs CORROBORATION: every active colour under the series must
     derive the same series token. One disagreement and the rename is refused
     and printed - the colours still get their own code and label fixed, which
     is the part that is unambiguous. This is the same principle the colour
     matcher already applies with its digit guard: correct what is provable,
     refuse what is not, never pick one of two answers. */
  const derived = new Map();
  for (const r of cols) {
    if (r.active === false) continue;
    const p = parse(r.colour_id);
    if (!p) continue;
    if (!derived.has(r.fabric_id)) derived.set(r.fabric_id, new Set());
    derived.get(r.fabric_id).add(p.series);
  }
  const refused = [];
  for (const [from, s] of [...plan.seriesRename]) {
    const seen = derived.get(from) || new Set();
    if (seen.size > 1) {
      refused.push({ from, to: s.to, seen: [...seen] });
      plan.seriesRename.delete(from);
    }
  }
  plan.refusedSeries = refused;

  note("");
  note(`PLAN  code/label rewrites ${plan.change.length} | duplicate colours merged ${plan.merge.reduce((a, m) => a + m.lose.length, 0)} | series renamed ${plan.seriesRename.size} | already right ${plan.ok}`);
  note(`      skipped, the owner's own 12 series: ${skipped.length} colours`);
  note(`      could not be parsed into series+number, LEFT ALONE: ${unparsed.length}`);
  note(`      in the UNMATCHED import bucket, LEFT ALONE for a person: ${junk.length}`);
  for (const r of junk) note(`        ? "${r.colour_id}" ${JSON.stringify(r.label)} series=${r.fabric_id}`);

  if (plan.refusedSeries.length) {
    note("");
    note(`--- SERIES RENAME REFUSED (${plan.refusedSeries.length}) — its colours disagree on what the series is ---`);
    for (const r of plan.refusedSeries) note(`  "${r.from}" left alone; its colours derive ${r.seen.map((x) => `"${x}"`).join(", ")}`);
  }
  if (plan.seriesRename.size) {
    note("");
    note(`--- SERIES RENAMED (${plan.seriesRename.size}) — the brand moves to the NAME ---`);
    for (const s of plan.seriesRename.values()) {
      note(`  "${s.from}" -> id "${s.to}"${s.brand ? `, name "${s.to} (${s.brand})"` : ""}`);
    }
  }
  if (plan.change.length) {
    note("");
    note(`--- CODE / LABEL (${plan.change.length}) ---`);
    for (const c of plan.change) {
      note(`  "${c.win.r.colour_id}" / ${JSON.stringify(c.win.r.label)}`);
      note(`     -> "${c.newId}" / ${JSON.stringify(c.newLabel)}   (${c.win.refs} live line(s))`);
    }
  }
  if (plan.merge.length) {
    note("");
    note(`--- DUPLICATE COLOURS (${plan.merge.length} groups) — losers superseded, never deleted ---`);
    for (const m of plan.merge) {
      note(`  ${m.newId}: keep "${m.win.r.colour_id}" (${m.win.refs} live)`);
      for (const l of m.lose) note(`      absorb "${l.r.colour_id}" ${JSON.stringify(l.r.label)} (${l.refs} live)`);
    }
  }
  if (unparsed.length) {
    note("");
    note(`--- NOT A series+number CODE, left exactly as they are (${unparsed.length}) ---`);
    for (const r of unparsed) note(`  ? "${r.colour_id}" ${JSON.stringify(r.label)} series=${r.fabric_id}`);
  }

  if (!APPLY) {
    note("");
    note('PLAN ONLY - nothing was written. MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" to write.');
    await sql.end({ timeout: 5 });
    return;
  }

  note("");
  note("--- APPLY ---");
  let renamedSeries = 0, rewritten = 0, superseded = 0, movedLines = 0;
  await sql.begin(async (tx) => {
    /* Series first: a colour cannot move onto a series row that does not exist
       yet, and the colour rewrites below all name the new series id. */
    for (const s of plan.seriesRename.values()) {
      const exists = libs.some((l) => l.id === s.to);
      if (!exists) {
        const sib = libs.find((l) => l.id === s.from);
        await tx`INSERT INTO scm.fabric_library (id, label, tier, default_surcharge, active, sort_order, company_id)
                 VALUES (${s.to}, ${s.brand ? `${s.to} (${s.brand})` : s.to},
                         ${sib?.tier ?? "standard"}, ${sib?.default_surcharge ?? 0}, true,
                         ${sib?.sort_order ?? 0}, ${CO})
                 ON CONFLICT (id) DO NOTHING`;
      } else if (s.brand) {
        await tx`UPDATE scm.fabric_library SET label = ${`${s.to} (${s.brand})`}
                  WHERE company_id = ${CO} AND id = ${s.to}`;
      }
      const r = await repointSeries(tx, CO, s.from, s.to);
      movedLines += sum(r);
      await tx`UPDATE scm.fabric_colours SET fabric_id = ${s.to}
                WHERE company_id = ${CO} AND fabric_id = ${s.from}
                  AND colour_id NOT IN (SELECT colour_id FROM scm.fabric_colours
                                         WHERE company_id = ${CO} AND fabric_id = ${s.to})`;
      const left = await tx`SELECT COUNT(*)::int AS n FROM scm.fabric_colours
                             WHERE company_id = ${CO} AND fabric_id = ${s.from} AND active`;
      if (left[0].n === 0) {
        await tx`UPDATE scm.fabric_library
                    SET active = false, label = ${`${s.from} [renamed to ${s.to} on ${STAMP}]`}
                  WHERE company_id = ${CO} AND id = ${s.from}`;
      }
      renamedSeries++;
      note(`  series "${s.from}" -> "${s.to}"${s.brand ? ` (brand "${s.brand}" kept in the name)` : ""}`);
    }

    for (const m of plan.merge) {
      for (const l of m.lose) {
        if (normColour(l.r.colour_id) !== m.newId) {
          const r = await repointColour(tx, CO, l.r.colour_id, m.newId);
          const n = sum(r);
          movedLines += n;
          /* Same transaction, same rename: the printed text, the stock bucket
             and the model whitelist follow the code or they contradict it. */
          const d2 = busy(await repointDescription2(tx, CO, l.r.colour_id, m.newId));
          const vk = busy(await repointVariantKey(tx, CO, l.r.colour_id, m.newId));
          const md = (await repointAllowedOptions(tx, CO, l.r.colour_id, m.newId)).n;
          if (n || d2 || vk || md) note(`  repointed ${n}: "${l.r.colour_id}" -> "${m.newId}" (${busy(r)}) desc2[${d2 || "-"}] stock[${vk || "-"}] models[${md}]`);
        }
        await tx`UPDATE scm.fabric_colours
                    SET active = false,
                        label = ${`${l.r.label || l.r.colour_id} [superseded by ${m.newId} on ${STAMP}]`}
                  WHERE company_id = ${CO} AND fabric_id = ${l.r.fabric_id} AND colour_id = ${l.r.colour_id}`;
        superseded++;
      }
    }

    for (const c of plan.change) {
      const from = c.win.r.colour_id;
      if (normColour(from) !== c.newId) {
        movedLines += sum(await repointColour(tx, CO, from, c.newId));
        const d2 = busy(await repointDescription2(tx, CO, from, c.newId));
        const vk = busy(await repointVariantKey(tx, CO, from, c.newId));
        const md = (await repointAllowedOptions(tx, CO, from, c.newId)).n;
        if (d2 || vk || md) note(`  carried with "${from}" -> "${c.newId}": desc2[${d2 || "-"}] stock[${vk || "-"}] models[${md}]`);
      }
      const seriesNow = plan.seriesRename.get(c.win.r.fabric_id)?.to ?? c.win.r.fabric_id;
      const clash = await tx`SELECT 1 FROM scm.fabric_colours
                              WHERE company_id = ${CO} AND fabric_id = ${seriesNow} AND colour_id = ${c.newId}
                                AND colour_id <> ${from}`;
      if (clash.length) { bad(`"${c.newId}" already exists under "${seriesNow}" - rewrite skipped, look at this pair by hand`); continue; }
      await tx`UPDATE scm.fabric_colours
                  SET colour_id = ${c.newId}, label = ${c.newLabel}
                WHERE company_id = ${CO} AND fabric_id = ${seriesNow} AND colour_id = ${from}`;
      rewritten++;
    }
  });
  note(`  series renamed ${renamedSeries} | codes rewritten ${rewritten} | superseded ${superseded} | live lines repointed ${movedLines}`);

  /* Verify on a SECOND, FRESH connection - a read inside the writing session
     can see its own uncommitted work and would prove nothing. */
  const v = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let fails = 0;
  try {
    note("");
    note("--- VERIFY (fresh connection) ---");
    const after = await v`SELECT fabric_id, colour_id, label, active FROM scm.fabric_colours WHERE company_id = ${CO}`;
    const live = new Set(after.filter((r) => r.active !== false).map((r) => normColour(r.colour_id)));
    for (const c of plan.change) if (!live.has(c.newId)) { fails++; bad(`${c.newId} is not in the library as an active colour`); }
    for (const m of plan.merge) for (const l of m.lose) {
      if (!after.some((r) => r.colour_id === l.r.colour_id) && normColour(l.r.colour_id) !== m.newId) {
        fails++; bad(`"${l.r.colour_id}" is GONE - it must be superseded, not deleted`);
      }
      const still = sum(await countColour(v, CO, l.r.colour_id));
      if (still && normColour(l.r.colour_id) !== m.newId) { fails++; bad(`${still} line(s) still name "${l.r.colour_id}"`); }
    }
    for (const s of plan.seriesRename.values()) {
      const still = sum(await countSeries(v, CO, s.from));
      if (still) { fails++; bad(`${still} line(s) still name series "${s.from}"`); }
    }
    const skipped = skippedArms();
    if (skipped.length) {
      note(`  ARMS SKIPPED (absent from this database — never sweep silently):`);
      for (const sk of skipped) note(`    ${sk.kind.padEnd(12)} ${String(sk.table).padEnd(42)} ${sk.why}`);
    }
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
