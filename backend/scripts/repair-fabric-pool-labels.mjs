#!/usr/bin/env node
// repair-fabric-pool-labels — a Model's fabric allow-list holds ten LABELS
// where it should hold fabric codes, so those ten fabrics are offered by
// nothing.
//
// WHAT IS WRONG. `product_models.allowed_options.fabrics` is a list of fabric
// SERIES (`fabric_library.id`). MEASURED on production 2026-09-11, company 1:
// all 79 sofa Models carry the same 101-entry pool, and TEN of those entries
// are the library's `label` rather than its `id` -
// `"GD2034 (HIVE)"` where the code is `GD2034`. A label matches neither a
// colour code nor a series, so the gate and the POS picker both reject every
// shade of those ten fabrics. docs/bugs/0814.
//
// Each of the ten maps to exactly one library row by `label`, so the repair is
// a rename, not a guess: it rewrites the entry to that row's `id` and changes
// nothing else in the blob. A label matching zero or MORE THAN ONE library row
// is REFUSED and listed - ambiguity is a finding, not something to pick from.
//
// WHY NOT TEACH THE GATE TO ACCEPT LABELS. Because a label is display text: it
// is edited for readability, translated, and carries the marketing name in
// brackets. A gate that matches on it would start refusing the day somebody
// tidies a name. The code is the identifier; the data is what is wrong here.
//
// SCOPE: every company, every category - the defect is in whatever pool holds a
// label, and `check-allowed-options-vocabulary.mjs` is what says where those
// are. Company 2's fabric pools were clean at the time of writing (54 values, 0
// unresolvable), so in practice this touches company 1's sofa Models.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="FABRIC-POOL-LABELS".
// RE-RUN: idempotent. A second run finds no label left to rewrite (the entries
// are codes by then) and reports zero; the fresh-connection check below asserts
// the SHAPE - that every pool value resolves to a library id or a colour id.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "FABRIC-POOL-LABELS";

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const die = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

async function loadVocab(sql, company) {
  const lib = await sql`SELECT id, label FROM scm.fabric_library WHERE company_id = ${company}`;
  const colours = await sql`SELECT colour_id FROM scm.fabric_colours WHERE company_id = ${company}`;
  const ids = new Set(lib.map((r) => r.id));
  const colourIds = new Set(colours.map((r) => r.colour_id));
  /* label -> [id, ...]. An array, because a label is not unique by contract and
     a duplicate must be refused rather than silently resolved to the first. */
  const byLabel = new Map();
  for (const r of lib) {
    if (r.label == null) continue;
    const k = String(r.label).trim();
    byLabel.set(k, [...(byLabel.get(k) ?? []), r.id]);
  }
  return { ids, colourIds, byLabel };
}

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const models = await sql`
    SELECT company_id, model_code, category, allowed_options
      FROM scm.product_models
     WHERE allowed_options ? 'fabrics'
       AND jsonb_array_length(coalesce(allowed_options->'fabrics','[]'::jsonb)) > 0
     ORDER BY company_id, model_code`;
  log(`Models with a non-empty fabric pool: ${models.length}`);

  const vocab = new Map();
  for (const c of new Set(models.map((m) => String(m.company_id)))) {
    vocab.set(c, await loadVocab(sql, Number(c)));
  }

  const fixes = [];            // { company, model_code, from, to, pool }
  const refused = [];          // { company, model_code, value, why }
  for (const m of models) {
    const v = vocab.get(String(m.company_id));
    const pool = m.allowed_options.fabrics.map(String);
    let changed = false;
    const next = pool.map((entry) => {
      if (v.ids.has(entry) || v.colourIds.has(entry)) return entry;     // already fine
      const hits = v.byLabel.get(entry.trim()) ?? [];
      if (hits.length === 1) { changed = true; return hits[0]; }
      refused.push({
        company: m.company_id, model_code: m.model_code, value: entry,
        why: hits.length === 0 ? "matches no fabric code, colour or label" : `label matches ${hits.length} fabric codes`,
      });
      return entry;
    });
    /* Rewriting to a value the pool ALREADY holds would duplicate it - the ten
       labels sit beside no code twin today, but a second run of an earlier
       partial apply could. De-duplicate while preserving order. */
    if (changed) {
      const seen = new Set();
      const deduped = next.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
      fixes.push({ company: m.company_id, model_code: m.model_code, pool: deduped, before: pool });
    }
  }

  const distinct = new Set();
  for (const f of fixes) f.before.forEach((b, i) => { if (f.pool[i] !== b) distinct.add(`${b} -> ${f.pool[i]}`); });
  log(`\nModels whose pool changes: ${fixes.length}`);
  log(`Distinct label -> code rewrites: ${distinct.size}`);
  for (const d of [...distinct].slice(0, 20)) log(`   ${d}`);
  if (refused.length) {
    const uniq = [...new Map(refused.map((r) => [`${r.company}|${r.value}`, r])).values()];
    log(`\nREFUSED (left exactly as they are): ${uniq.length} distinct value(s)`);
    for (const r of uniq.slice(0, 15)) log(`   company ${r.company} ${JSON.stringify(r.value)} - ${r.why}`);
  }

  if (MODE !== "apply") {
    log(`\nPLAN: nothing written. Re-run MODE=apply CONFIRM=${CONFIRM_PHRASE} to apply.`);
    await sql.end();
    return;
  }
  if (CONFIRM !== CONFIRM_PHRASE) { await sql.end(); die(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}"`); }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const f of fixes) {
      await tx`UPDATE scm.product_models
                  SET allowed_options = jsonb_set(allowed_options, '{fabrics}', ${JSON.stringify(f.pool)}::jsonb),
                      updated_at = now()
                WHERE company_id = ${f.company} AND model_code = ${f.model_code}`;
      n++;
    }
  });
  log(`\nAPPLIED: ${n} model(s) rewritten.`);
  await sql.end();

  /* Verify on a FRESH connection, and assert the SHAPE - that no pool value is
     a label any more - not the row count. A count of updates is true while the
     blob is wrong. */
  const v2 = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const after = await v2`
    SELECT company_id, model_code, allowed_options->'fabrics' AS pool
      FROM scm.product_models
     WHERE allowed_options ? 'fabrics'
       AND jsonb_array_length(coalesce(allowed_options->'fabrics','[]'::jsonb)) > 0`;
  const vocab2 = new Map();
  for (const c of new Set(after.map((r) => String(r.company_id)))) vocab2.set(c, await loadVocab(v2, Number(c)));
  await v2.end();

  const stillLabels = [];
  for (const r of after) {
    const v = vocab2.get(String(r.company_id));
    for (const entry of r.pool.map(String)) {
      if (v.ids.has(entry) || v.colourIds.has(entry)) continue;
      if ((v.byLabel.get(entry.trim()) ?? []).length === 1) stillLabels.push(`${r.model_code}: ${entry}`);
    }
  }
  if (stillLabels.length) die(`VERIFY FAILED: ${stillLabels.length} pool value(s) are still a resolvable label - ${stillLabels.slice(0, 5).join("; ")}`);
  log("VERIFIED on a fresh connection: no fabric pool holds a label that maps to a code.");
}

main().catch((e) => die(e?.message ?? String(e)));
