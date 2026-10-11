#!/usr/bin/env node
// READ-ONLY probe — CSL vs Console. Produces the real numbers behind the
// "rename CSL -> Console" question BEFORE anyone rewrites a document.
//
// WHY THIS EXISTS: the owner ruled CSL and Console are the same thing and that
// Houzs should adopt 2990's `Console`. The repo says otherwise (see the report
// / BUG-HISTORY entry), and the ruling was made on a set-diff that cannot
// distinguish {rename A->B} from {independent add B, independent remove A}.
// This probe reads prod and answers, with counts, which one actually happened —
// and what a cascade would touch if the owner still wants it.
//
// Writes NOTHING. The session is pinned read-only at connect time so a coding
// mistake cannot write even by accident.

import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const FROM = process.env.PROBE_FROM || "CSL";
const TO   = process.env.PROBE_TO   || "Console";

// FROM/TO arrive from workflow_dispatch inputs and are interpolated into
// unsafe() SQL below (the column/pattern positions cannot be parameterised).
// Compartment codes are a closed alphabet — anything else is rejected rather
// than escaped, so no dispatch input can reach the planner as syntax.
const CODE_RE = /^[A-Za-z0-9()/\-]{1,32}$/;
for (const [name, v] of [["PROBE_FROM", FROM], ["PROBE_TO", TO]]) {
  if (!CODE_RE.test(v)) { console.error(`${name}='${v}' is not a valid compartment code`); process.exit(2); }
}

// Every (table, column) the ported rename_sofa_compartment() would rewrite.
// Mirrors backend/scripts/scm-schema/port-missing-functions-triggers.sql (A3).
// Suffix columns: value is '<BASE>-<compartment>'.
const SUFFIX_COLS = [
  ["mfg_sales_order_items", "item_code"],
  ["mfg_so_price_overrides", "item_code"],
  ["delivery_order_items", "item_code"],
  ["delivery_return_items", "item_code"],
  ["sales_invoice_items", "item_code"],
  ["consignment_delivery_order_items", "item_code"],
  ["consignment_sales_order_items", "item_code"],
  ["purchase_consignment_receive_items", "material_code"],
  ["purchase_consignment_order_items", "material_code"],
  ["purchase_invoice_items", "material_code"],
  ["purchase_return_items", "material_code"],
  ["grn_items", "material_code"],
  ["grn_items", "supplier_sku"],
  ["purchase_order_items", "material_code"],
  ["purchase_order_items", "supplier_sku"],
  ["supplier_material_bindings", "material_code"],
  ["supplier_material_bindings", "supplier_sku"],
  ["pwp_codes", "trigger_item_code"],
  ["pwp_codes", "redeemed_item_code"],
];

// JSON blobs the rename token-replaces.
const JSON_COLS = [
  ["product_models", "allowed_options"],
  ["sofa_combo_pricing", "modules"],
  ["sofa_quick_picks", "modules"],
  ["sofa_personal_quick_picks", "modules"],
  ["pos_carts", "lines"],
  ["mfg_sales_order_items", "variants"],
  ["maintenance_config_history", "config"],
];

async function tableExists(t) {
  const r = await dst`SELECT 1 FROM information_schema.tables WHERE table_schema='scm' AND table_name=${t}`;
  return r.length > 0;
}
async function colExists(t, c) {
  const r = await dst`SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name=${t} AND column_name=${c}`;
  return r.length > 0;
}

async function countSuffix(t, c, code) {
  const q = `SELECT count(*)::int AS n FROM scm."${t}" WHERE right(coalesce("${c}",''), ${code.length + 1}) = '-${code}'`;
  const [r] = await dst.unsafe(q);
  return r.n;
}

async function countJsonToken(t, c, code) {
  // Token-exact: match the QUOTED JSON string ("CSL"), never a bare substring,
  // so prose like "CSL-style" in a label is not counted as a code occurrence.
  const lit = `'${JSON.stringify(code).replace(/'/g, "''")}'`;
  const q = `SELECT count(*)::int AS n FROM scm."${t}" WHERE "${c}" IS NOT NULL AND position(${lit} in "${c}"::text) > 0`;
  const [r] = await dst.unsafe(q);
  return r.n;
}

async function main() {
  // Hard read-only guarantee for this session.
  await dst.unsafe("SET default_transaction_read_only = on");
  console.log(`=== PROBE csl-console (READ-ONLY) — from='${FROM}' to='${TO}' ===`);

  // ── 1. Does the cascade function actually exist in this DB? ───────────
  // It was ported out-of-band (not in the migration tree), so its presence
  // in prod is an assumption until read.
  console.log("\n=== 1. rename_sofa_compartment() presence ===");
  const fn = await dst`
    SELECT n.nspname AS schema, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           p.prosecdef AS security_definer, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'rename_sofa_compartment'`;
  if (!fn.length) console.log("ABSENT — the cascade function is NOT in this database.");
  else for (const r of fn) console.log(`PRESENT ${r.schema}.${r.proname}(${r.args}) secdef=${r.security_definer} config=${JSON.stringify(r.proconfig)}`);

  // ── 2. Live master pool + meta: what does the config actually say? ────
  console.log("\n=== 2. live master pool + meta ===");
  const pool = await dst`
    SELECT h.id, h.effective_from,
           h.config->'sofaCompartments' AS comps,
           h.config->'sofaCompartmentMeta'->${FROM} AS meta_from,
           h.config->'sofaCompartmentMeta'->${TO}   AS meta_to
      FROM maintenance_config_history h
     WHERE h.scope='master' AND h.effective_from <= CURRENT_DATE
     ORDER BY h.effective_from DESC, h.created_at DESC
     LIMIT 1`;
  if (!pool.length) console.log("NO live master config row.");
  else {
    const p = pool[0];
    console.log(`row=${p.id} effective_from=${p.effective_from}`);
    console.log(`sofaCompartments = ${JSON.stringify(p.comps)}`);
    console.log(`meta['${FROM}'] = ${JSON.stringify(p.meta_from)}`);
    console.log(`meta['${TO}']   = ${JSON.stringify(p.meta_to)}`);
    const comps = Array.isArray(p.comps) ? p.comps : [];
    console.log(`pool has '${FROM}': ${comps.includes(FROM)} · pool has '${TO}': ${comps.includes(TO)}`);
    // This is the guard the function actually enforces. It checks the POOL only.
    console.log(comps.includes(TO)
      ? `GUARD: rename would RAISE code_exists (pool already offers '${TO}').`
      : `GUARD: rename would PASS the collision check — the guard reads the POOL only, NOT compartment_library / mfg_products (see section 3).`);
  }

  // ── 3. The guard's blind spot: Console may exist OUTSIDE the pool ─────
  console.log("\n=== 3. compartment_library (guard does NOT read this) ===");
  if (await tableExists("compartment_library")) {
    const lib = await dst`
      SELECT id, comp_group::text AS comp_group, label, width_cm, depth_cm, cushions,
             default_price, is_accessory, sort_order
        FROM compartment_library WHERE id IN (${FROM}, ${TO}) ORDER BY id`;
    if (!lib.length) console.log(`neither '${FROM}' nor '${TO}' present in compartment_library.`);
    for (const r of lib) console.log(JSON.stringify(r));
    const haveFrom = lib.some((r) => r.id === FROM), haveTo = lib.some((r) => r.id === TO);
    if (haveTo && !haveFrom) console.log(`NOTE: '${TO}' exists in the library but '${FROM}' does not — the rename's legacy library section is a NO-OP, and '${TO}' keeps its OWN attributes (price/group/is_accessory). The pool entry and the library row would then disagree.`);
    if (haveTo && haveFrom) console.log(`COLLISION: BOTH rows exist. The rename repoints product_compartments from '${FROM}' to the EXISTING '${TO}' row and DELETES '${FROM}' — '${FROM}' attributes are lost (INSERT is ON CONFLICT DO NOTHING).`);
  } else console.log("compartment_library ABSENT.");

  console.log("\n=== 3b. product_compartments ===");
  if (await tableExists("product_compartments")) {
    const pc = await dst`
      SELECT compartment_id, count(*)::int AS n FROM product_compartments
       WHERE compartment_id IN (${FROM}, ${TO}) GROUP BY compartment_id ORDER BY compartment_id`;
    if (!pc.length) console.log("0 rows for either code.");
    for (const r of pc) console.log(`${r.compartment_id}: ${r.n} rows`);
  } else console.log("product_compartments ABSENT.");

  // ── 4. SKU master: casing matters, the engine matches case-sensitively ─
  console.log("\n=== 4. mfg_products SKU suffixes (casing is load-bearing) ===");
  if (await tableExists("mfg_products")) {
    const sku = await dst.unsafe(`
      SELECT substring(code from '[^-]+$') AS suffix, count(*)::int AS n
        FROM scm.mfg_products
       WHERE category='SOFA' AND upper(code) LIKE ANY (ARRAY['%-${FROM.toUpperCase()}', '%-${TO.toUpperCase()}'])
       GROUP BY 1 ORDER BY 1`);
    if (!sku.length) console.log(`no SOFA SKUs ending in -${FROM} or -${TO}.`);
    for (const r of sku) console.log(`suffix '${r.suffix}': ${r.n} SKUs`);
    console.log(`(If both '-${TO}' and '-${TO.toUpperCase()}' appear, the systems already disagree on casing and a rename to '${TO}' does NOT converge them.)`);
    // A rename that would collide on a UNIQUE code aborts the whole function.
    const clash = await dst.unsafe(`
      SELECT count(*)::int AS n FROM scm.mfg_products p
       WHERE p.category='SOFA' AND right(p.code, ${FROM.length + 1}) = '-${FROM}'
         AND EXISTS (SELECT 1 FROM scm.mfg_products s
                      WHERE s.code = left(p.code, length(p.code) - ${FROM.length}) || '${TO}')`);
    console.log(clash[0].n > 0
      ? `SKU CLASH: ${clash[0].n} '-${FROM}' SKUs already have a '-${TO}' sibling. The rename's UPDATE would hit the unique index and ABORT the whole function.`
      : `no '-${FROM}' SKU has an existing '-${TO}' sibling.`);
  } else console.log("mfg_products ABSENT.");

  // ── 5. The document blast radius ──────────────────────────────────────
  console.log("\n=== 5. document blast radius (rows the cascade would REWRITE) ===");
  let totalFrom = 0, totalTo = 0;
  for (const [t, c] of SUFFIX_COLS) {
    if (!(await tableExists(t)) || !(await colExists(t, c))) { console.log(`SKIP ${t}.${c} (absent)`); continue; }
    const a = await countSuffix(t, c, FROM), b = await countSuffix(t, c, TO);
    totalFrom += a; totalTo += b;
    if (a || b) console.log(`${t}.${c}: -${FROM}=${a}  -${TO}=${b}`);
  }
  console.log(`SUFFIX TOTALS: -${FROM}=${totalFrom}  -${TO}=${totalTo}`);

  console.log("\n=== 5b. JSON token occurrences ===");
  let jFrom = 0, jTo = 0;
  for (const [t, c] of JSON_COLS) {
    if (!(await tableExists(t)) || !(await colExists(t, c))) { console.log(`SKIP ${t}.${c} (absent)`); continue; }
    const a = await countJsonToken(t, c, FROM), b = await countJsonToken(t, c, TO);
    jFrom += a; jTo += b;
    if (a || b) console.log(`${t}.${c}: "${FROM}"=${a}  "${TO}"=${b}`);
  }
  console.log(`JSON TOTALS: "${FROM}"=${jFrom}  "${TO}"=${jTo}`);

  // maintenance_config_history is the audit trail. The cascade rewrites EVERY
  // scope and EVERY history row, including the 0030 HOOKKA-alignment baseline.
  console.log("\n=== 5c. maintenance_config_history rows the cascade would rewrite ===");
  if (await tableExists("maintenance_config_history")) {
    const mch = await dst.unsafe(`
      SELECT scope, count(*)::int AS n, min(effective_from)::text AS oldest, max(effective_from)::text AS newest
        FROM scm.maintenance_config_history
       WHERE position('${JSON.stringify(FROM).replace(/'/g, "''")}' in config::text) > 0
       GROUP BY scope ORDER BY scope`);
    if (!mch.length) console.log(`no config rows carry "${FROM}".`);
    for (const r of mch) console.log(`scope=${r.scope}: ${r.n} rows (${r.oldest} .. ${r.newest}) — INCLUDES historical/audit rows`);
  }

  // ── 6. Description rewrites (free-text on historical SO lines) ────────
  console.log("\n=== 6. SO description word-boundary rewrites ===");
  if (await tableExists("mfg_sales_order_items")) {
    const re = FROM.replace(/([\\^$.|?*+()[\]{}])/g, "\\$1");
    const [d] = await dst.unsafe(`
      SELECT count(*)::int AS n FROM scm.mfg_sales_order_items
       WHERE description ~ '(^|[^A-Za-z0-9)])${re}($|[^A-Za-z0-9(])'
          OR coalesce(description2,'') ~ '(^|[^A-Za-z0-9)])${re}($|[^A-Za-z0-9(])'`);
    console.log(`mfg_sales_order_items description/description2 matching '${FROM}': ${d.n} rows`);
    const samples = await dst.unsafe(`
      SELECT description FROM scm.mfg_sales_order_items
       WHERE description ~ '(^|[^A-Za-z0-9)])${re}($|[^A-Za-z0-9(])' LIMIT 5`);
    for (const s of samples) console.log(`  e.g. ${JSON.stringify(s.description)}`);
  }

  // ── 7. Verdict summary ────────────────────────────────────────────────
  console.log("\n=== 7. SUMMARY ===");
  console.log(`Rows carrying '${FROM}' (suffix+json): ${totalFrom + jFrom}`);
  console.log(`Rows carrying '${TO}'   (suffix+json): ${totalTo + jTo}`);
  console.log(`If BOTH are non-zero, '${FROM}' and '${TO}' COEXIST in live data — they are two`);
  console.log(`live products, not one product under two names, and the rename would MERGE them.`);

  await dst.end();
}

main().catch(async (e) => { console.error(e); try { await dst.end(); } catch {} process.exit(1); });
