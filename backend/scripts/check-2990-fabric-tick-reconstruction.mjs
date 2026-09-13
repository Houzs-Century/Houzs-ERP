#!/usr/bin/env node
// check-2990-fabric-tick-reconstruction — can the owner's ORIGINAL Modular fabric
// ticks be worked out again, now that the pool that held them was cleared?
//
// THE QUESTION, in his words: 「原本是 28 到 36 个，现在突然变 56 个了」 and
// 「为什么你会去 edit 改掉我的这些 Modular 里面勾的这些东西呢」.
//
// He is right on both counts. `open-model-fabric-pools.mjs` cleared
// `allowed_options.fabrics` on every SOFA Model, and that column held HIS
// per-Model tick selection, not a restriction to be removed. Its production run
// recorded what was lost only in aggregate:
//
//   company 2: 16 model(s), pool size 28/36, colours offered 28/36 -> 56
//
// So every 2990 sofa Model was ticked to either 28 or 36 colours. The refill
// that unblocked the POS gave all of them every active colour (58 today), which
// is MORE than he chose — safe to sell with, but not his configuration.
//
// THE HYPOTHESIS THIS TESTS. A pool of 28 or 36 out of 58 looks like "every
// colour of these N series" rather than a hand-picked scatter, and the SERIES a
// product offers is still recorded elsewhere: `scm.product_fabrics`
// (product_id, fabric_id, active) — the legacy-retail per-SKU table the POS also
// reads at `GET /pos-pools/product-fabrics`. It was never touched.
//
// So: for each 2990 sofa Model, take the ACTIVE series of its own products,
// expand to every active colour of those series, and see whether the count lands
// on 28 or 36. If it does for every Model, the ticks are reconstructable and a
// restore can be written. If it does not, say so — a reconstruction that only
// half matches must NOT be applied, because a wrong tick list is worse than an
// open one: it silently removes colours he can sell.
//
// SECOND SOURCE (added after the first run proved scm.product_fabrics holds
// ZERO rows for company 2): the 2990 SOURCE system this company was migrated
// from. If its product_models still carry allowed_options.fabrics at 28 / 36,
// those are the ticks. Read with SOURCE_SUPABASE_URL / SOURCE_SERVICE_ROLE_KEY,
// the same secrets mirror-sentinel reads with. Skipped with a notice if absent.
//
// READ-ONLY. Selects only, no writes, no DDL, no transaction.
//
// RE-RUN: read-only and idempotent; every run re-reads the live rows.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const COMPANY = Number(process.env.COMPANY || 2);
/** The pool sizes the clear's own run recorded for this company. */
const RECORDED = String(process.env.RECORDED_SIZES || "28,36")
  .split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
const GH = !!process.env.GITHUB_ACTIONS;
const log = (m) => console.log(GH ? `::notice::${m}` : m);

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const [co] = await sql`SELECT id, code, name FROM public.companies WHERE id = ${COMPANY}`;
  if (!co) { await sql.end(); console.error(`::error::no company ${COMPANY}`); process.exit(1); }

  const colours = await sql`
    SELECT colour_id::text AS colour_id, fabric_id::text AS fabric_id FROM scm.fabric_colours
     WHERE company_id = ${COMPANY} AND coalesce(active, true) = true`;
  const coloursBySeries = new Map();
  for (const r of colours) {
    const k = String(r.fabric_id);
    if (!coloursBySeries.has(k)) coloursBySeries.set(k, []);
    coloursBySeries.get(k).push(String(r.colour_id));
  }

  const models = await sql`
    SELECT id::text AS id, model_code, allowed_options FROM scm.product_models
     WHERE company_id = ${COMPANY} AND upper(coalesce(category::text,'')) = 'SOFA'
     ORDER BY model_code`;

  /* The SERIES each Model's own SKUs offer. product_fabrics is per PRODUCT, so
     a Model's set is the union over its products — which is what the Modular
     drawer shows at the Model layer. */
  /* Cast both sides: mfg_products.id is TEXT (`mfg-<hex>`) and the first run
     of this check died on `operator does not exist: text = uuid`. Count the
     table's rows for the company separately, so a join that matches nothing
     reads as "no join", never as "no series". */
  const [pfTotal] = await sql`
    SELECT count(*)::int AS n FROM scm.product_fabrics WHERE company_id = ${COMPANY}`;
  const pf = await sql`
    SELECT p.model_id::text AS model_id, f.fabric_id::text AS fabric_id, f.active
      FROM scm.product_fabrics f
      JOIN scm.mfg_products p ON p.id::text = f.product_id::text
     WHERE f.company_id = ${COMPANY} AND p.model_id IS NOT NULL`;
  const seriesByModel = new Map();
  for (const r of pf) {
    if (r.active === false) continue;
    const k = String(r.model_id);
    if (!seriesByModel.has(k)) seriesByModel.set(k, new Set());
    seriesByModel.get(k).add(String(r.fabric_id));
  }

  await sql.end();

  log(`${co.code}: ${models.length} SOFA Model(s); ${colours.length} active colour(s) across ${coloursBySeries.size} series.`);
  log(`Pool sizes the clear recorded for this company: ${RECORDED.join(" / ")}`);
  log(`product_fabrics rows for this company: ${pfTotal.n}; joined to a Model: ${pf.length}`);
  log(`Models with any product_fabrics series: ${seriesByModel.size}`);

  const rows = [];
  for (const m of models) {
    const series = seriesByModel.get(String(m.id)) ?? new Set();
    const reconstructed = [...series].flatMap((s) => coloursBySeries.get(s) ?? []);
    const now = Array.isArray(m.allowed_options?.fabrics) ? m.allowed_options.fabrics.length : 0;
    rows.push({
      code: m.model_code,
      series: series.size,
      reconstructed: new Set(reconstructed).size,
      now,
      matches: RECORDED.includes(new Set(reconstructed).size),
    });
  }

  console.log("\nmodel                 series   reconstructed   now   matches a recorded size");
  console.log("--------------------  ------   -------------   ---   -----------------------");
  for (const r of rows) {
    console.log(`${String(r.code).padEnd(20)}  ${String(r.series).padStart(6)}   ${String(r.reconstructed).padStart(13)}   ${String(r.now).padStart(3)}   ${r.matches ? "yes" : "NO"}`);
  }

  const matched = rows.filter((r) => r.matches).length;
  const noSeries = rows.filter((r) => r.series === 0).length;

  console.log("");
  await fromSource(colours.map((r) => String(r.colour_id)));

  log(`VERDICT: ${matched} of ${rows.length} Model(s) reconstruct to a size the clear recorded (${RECORDED.join("/")}).`);
  if (noSeries) log(`${noSeries} Model(s) have NO product_fabrics series at all — nothing to reconstruct from for those.`);

  if (matched === rows.length && rows.length > 0) {
    log("Every Model reconstructs to a recorded size. The ticks ARE recoverable; a restore can be written from product_fabrics.");
  } else {
    /* Say it plainly. A reconstruction that only half matches must not be
       applied: a wrong tick list silently removes colours he can sell, which is
       worse than the current open state. */
    log("NOT every Model reconstructs to a recorded size. Do NOT apply a reconstruction from this source — "
      + "a partially-right tick list removes colours he can sell, which is worse than the current open state. "
      + "The honest options are: leave every Model open, or have him re-tick the ones he wants narrowed.");
  }
}

async function fromSource(activeColourIds) {
  const url = process.env.SOURCE_SUPABASE_URL, key = process.env.SOURCE_SERVICE_ROLE_KEY;
  if (!url || !key) { log("SOURCE: secrets absent in this environment - second source skipped."); return; }
  const src = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await src.schema("public").from("product_models").select("*");
  if (error) { log(`SOURCE: product_models read failed - ${error.message}`); return; }
  const sofas = (data ?? []).filter((m) => String(m.category ?? "").toUpperCase() === "SOFA");
  log(`SOURCE: ${data?.length ?? 0} product_models, ${sofas.length} SOFA.`);
  const active = new Set(activeColourIds);
  console.log("\nsource model          fabrics   in 2990 active colours   matches a recorded size   updated_at");
  let matched = 0;
  for (const m of sofas.sort((a, b) => String(a.code ?? a.model_code).localeCompare(String(b.code ?? b.model_code)))) {
    const fab = Array.isArray(m.allowed_options?.fabrics) ? m.allowed_options.fabrics.map(String) : null;
    const n = fab ? fab.length : 0;
    const known = fab ? fab.filter((c) => active.has(c)).length : 0;
    const ok = RECORDED.includes(n);
    if (ok) matched += 1;
    console.log(`${String(m.code ?? m.model_code ?? m.id).padEnd(20)}  ${String(fab ? n : "none").padStart(7)}   ${String(known).padStart(22)}   ${(ok ? "yes" : "NO").padStart(23)}   ${m.updated_at ?? ""}`);
  }
  log(`SOURCE VERDICT: ${matched} of ${sofas.length} SOFA Model(s) in the 2990 source hold a pool of a recorded size (${RECORDED.join("/")}).`);
}

main().catch((e) => { console.error(GH ? `::error::${e?.message ?? e}` : e); process.exit(1); });
