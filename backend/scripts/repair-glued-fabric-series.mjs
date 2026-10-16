#!/usr/bin/env node
// repair-glued-fabric-series - put colours like KN01, KN02 ... under ONE series
// (KN) instead of each being a series of its own.
//
// WHAT IS WRONG. The Fabric Tracking route mirrors a new fabric code into the
// selling library under a series. Its rule only split on a dash or a space, so
// a code with no separator - "KN01" - became series KN01 holding the single
// colour KN01. The POS picker groups colours by series, so the KN range showed
// as six one-chip groups, each with its own All on / All off, instead of one KN
// group. scripts/lib/fabric-code.mjs always read "KN01" as series KN colour 01;
// the route now does too (fabricSeriesParity.test.ts). This moves the rows the
// old rule already wrote.
//
// SCOPE, as a rule and not a list: a colour whose series id IS its own colour
// id, where lib/fabric-code.mjs parses a different series out of it. That is
// exactly the old route's fallback shape. Codes the lib refuses ("PU1910") are
// left alone.
//
// PER TARGET SERIES, in one transaction:
//   1. create the target library row if it is missing, copying the pricing
//      columns from the old rows,
//   2. move each colour onto it (fabric_id is part of the key),
//   3. repoint every document line whose variants.fabricId names the old series
//      (all arms in lib/fabric-write.mjs, jsonb_set + to_jsonb(text)),
//   4. retire the old series: active = false, tombstone in its label. Nothing is
//      deleted.
//
// REFUSES rather than guesses, reported and skipped:
//   * the old series and the target do not price alike (tier, sofa_tier,
//     bedframe_tier, default_surcharge) - SO pricing reads those off the series,
//     so moving would change what a line costs. That is the owner's call.
//   * the target exists but is retired, or belongs to another company,
//   * the old series holds any other colour, or the target already holds this
//     colour code.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="GLUED-FABRIC-SERIES".
// RE-RUN: idempotent. A moved colour no longer sits on a series named after
// itself, so a second run finds only the refused rows and writes nothing for
// them; the fresh-connection check asserts that SHAPE, not a row count.
import postgres from "postgres";
import { parse } from "./lib/fabric-code.mjs";
import { ARMS, resolveArms, VARIANT_ARM_COLS } from "./lib/fabric-write.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "GLUED-FABRIC-SERIES";
const STAMP = process.env.NOTE_DATE || new Date().toISOString().slice(0, 10);

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const die = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

const PRICE_COLS = ["tier", "sofa_tier", "bedframe_tier", "default_surcharge"];
const priceKey = (row) => PRICE_COLS.map((k) => String(row[k] ?? "")).join("|");

/** Colours on a series named after themselves, grouped by the series they belong in. */
async function findGroups(sql) {
  const rows = await sql`
    SELECT company_id, fabric_id, colour_id FROM scm.fabric_colours
     WHERE fabric_id = colour_id ORDER BY company_id, colour_id`;
  const groups = new Map();
  for (const r of rows) {
    const p = parse(r.colour_id);
    if (!p || p.series === r.fabric_id) continue;
    const key = `${r.company_id}|${p.series}`;
    if (!groups.has(key)) groups.set(key, { company: Number(r.company_id), target: p.series, colours: [] });
    groups.get(key).colours.push(r.colour_id);
  }
  return [...groups.values()];
}

/** Decide, per group, what may move and why anything may not. Read-only. */
async function judge(sql, g) {
  const ids = [g.target, ...g.colours];
  const lib = new Map((await sql`
    SELECT id, company_id, label, active, ${sql(PRICE_COLS)}, sort_order
      FROM scm.fabric_library WHERE id = ANY(${ids})`).map((r) => [r.id, r]));
  const others = new Map((await sql`
    SELECT fabric_id, count(*)::int AS n FROM scm.fabric_colours
     WHERE company_id = ${g.company} AND fabric_id = ANY(${g.colours}) AND colour_id <> fabric_id
     GROUP BY 1`).map((r) => [r.fabric_id, r.n]));
  const taken = new Set((await sql`
    SELECT colour_id FROM scm.fabric_colours
     WHERE company_id = ${g.company} AND fabric_id = ${g.target} AND colour_id = ANY(${g.colours})`).map((r) => r.colour_id));

  const target = lib.get(g.target) ?? null;
  if (target && Number(target.company_id) !== g.company) return { refuse: `series ${g.target} belongs to company ${target.company_id}` };
  if (target && !target.active) return { refuse: `series ${g.target} exists but is retired; moving colours onto it would hide them` };

  const move = [], skipped = [];
  for (const code of g.colours) {
    const old = lib.get(code);
    if (!old || Number(old.company_id) !== g.company) skipped.push(`${code}: its series row is missing or belongs to another company`);
    else if (others.get(code)) skipped.push(`${code}: series ${code} also holds ${others.get(code)} other colour(s)`);
    else if (taken.has(code)) skipped.push(`${code}: ${g.target} already holds a colour ${code}`);
    else move.push(old);
  }
  const prices = new Set([...move, ...(target ? [target] : [])].map(priceKey));
  if (prices.size > 1) {
    return { refuse: `pricing differs across ${[...(target ? [target] : []), ...move].map((r) => `${r.id}=${priceKey(r)}`).join(", ")} (${PRICE_COLS.join("|")})` };
  }
  return { target, move, skipped };
}

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const { ok: arms, skipped: armSkips } = await resolveArms(sql, ARMS, VARIANT_ARM_COLS);
  for (const s of armSkips) log(`arm ${s.name} (${s.t}) not swept: ${s.why}`);

  const groups = await findGroups(sql);
  log(`Series that should hold colours now each sitting on a series of their own: ${groups.length}`);
  const plans = [];
  for (const g of groups) {
    const j = await judge(sql, g);
    log(`\ncompany ${g.company}  ${g.target}  <-  ${g.colours.join(", ")}`);
    if (j.refuse) { log(`   REFUSED: ${j.refuse}`); continue; }
    log(`   target series ${j.target ? "exists" : "will be created"}; moving ${j.move.length}`);
    for (const s of j.skipped) log(`   skipped ${s}`);
    for (const old of j.move) {
      for (const arm of arms) {
        const [{ n }] = await sql.unsafe(
          `SELECT count(*)::int AS n FROM ${arm.t} i
            WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object' AND i.variants->>'fabricId' = $2`,
          [g.company, old.id]);
        if (n) log(`   ${old.id}: ${n} ${arm.name} line(s) to repoint`);
      }
    }
    if (j.move.length) plans.push({ ...g, ...j });
  }

  if (MODE !== "apply") {
    log(`\nPLAN: nothing written. Re-run MODE=apply CONFIRM=${CONFIRM_PHRASE} to apply.`);
    await sql.end();
    return;
  }
  if (CONFIRM !== CONFIRM_PHRASE) { await sql.end(); die(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}"`); }
  if (plans.length === 0) { log("Nothing to move."); await sql.end(); return; }

  for (const p of plans) {
    await sql.begin(async (tx) => {
      if (!p.target) {
        const src = p.move[0];
        await tx`INSERT INTO scm.fabric_library
                   (company_id, id, label, tier, sofa_tier, bedframe_tier, default_surcharge, active, sort_order)
                 VALUES (${p.company}, ${p.target}, ${p.target}, ${src.tier}, ${src.sofa_tier}, ${src.bedframe_tier},
                         ${src.default_surcharge}, true, ${Math.min(...p.move.map((r) => Number(r.sort_order) || 0))})`;
      }
      for (const old of p.move) {
        await tx`UPDATE scm.fabric_colours SET fabric_id = ${p.target}
                  WHERE company_id = ${p.company} AND fabric_id = ${old.id} AND colour_id = ${old.id}`;
        for (const arm of arms) {
          await tx.unsafe(
            `UPDATE ${arm.t} i SET variants = jsonb_set(i.variants, '{fabricId}', to_jsonb($3::text))
              WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object' AND i.variants->>'fabricId' = $2`,
            [p.company, old.id, p.target]);
        }
        await tx`UPDATE scm.fabric_library
                    SET active = false,
                        label = ${`${old.label ?? old.id} [MERGED into ${p.target} on ${STAMP} - superseded, not deleted]`}
                  WHERE id = ${old.id} AND company_id = ${p.company}`;
      }
    });
    log(`APPLIED company ${p.company}: ${p.move.map((r) => r.id).join(", ")} -> ${p.target}`);
  }
  await sql.end();

  /* Verify on a FRESH connection, asserting the SHAPE: every moved colour sits
     on its target, its old series is retired, no line still names an old
     series, and the target is live. A count of updates would be true even if
     the rows had landed somewhere else. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const problems = [];
  for (const p of plans) {
    const olds = p.move.map((r) => r.id);
    const placed = await v`SELECT colour_id FROM scm.fabric_colours
                            WHERE company_id = ${p.company} AND fabric_id = ${p.target} AND colour_id = ANY(${olds})`;
    if (placed.length !== olds.length) problems.push(`${p.target}: ${placed.length} of ${olds.length} colours on the target`);
    const [t] = await v`SELECT active FROM scm.fabric_library WHERE id = ${p.target} AND company_id = ${p.company}`;
    if (!t?.active) problems.push(`${p.target}: target series missing or inactive`);
    const live = await v`SELECT id FROM scm.fabric_library WHERE id = ANY(${olds}) AND active`;
    if (live.length) problems.push(`${p.target}: old series still active: ${live.map((r) => r.id).join(", ")}`);
    for (const arm of arms) {
      const [{ n }] = await v.unsafe(
        `SELECT count(*)::int AS n FROM ${arm.t} i
          WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object' AND i.variants->>'fabricId' = ANY($2)`,
        [p.company, olds]);
      if (n) problems.push(`${p.target}: ${n} ${arm.name} line(s) still name an old series`);
    }
  }
  await v.end();
  if (problems.length) die(`VERIFY FAILED:\n  ${problems.join("\n  ")}`);
  log(`VERIFIED on a fresh connection: ${plans.length} series repaired, every moved colour on its target, no line names an old series.`);
}

main().catch((e) => die(e?.message ?? String(e)));
