#!/usr/bin/env node
// refill-pos-sofa-fabric-pools — give the 2990 POS its sofa colours back.
//
// WHAT BROKE, and it is ours. `open-model-fabric-pools.mjs` cleared
// `allowed_options.fabrics` on every SOFA Model, "every company, SOFA Models
// only". It was written against the reading our OWN picker takes
// (`SoLineCard`: `const restricted = pool.length > 0` — an empty pool offers
// EVERY active colour), and it did widen Houzs, measured at the time.
//
// The 2990 POS is a DIFFERENT client, in a different repository
// (wenwei4046/2990s, pos.2990shome.com), reading the SAME field through
// `GET /pos-pools/mfg-catalog`, which selects
// `product_models(..., allowed_options)` (routes/pos-pools.ts). It reads the
// pool as the SOURCE, not as a filter:
//
//   apps/pos/src/pages/Configurator.tsx
//     fabricIds: (allowed as { fabrics?: string[] }).fabrics ?? []   // absent -> []
//     buildFabricSeriesRows(codes):
//       const enabled = new Set(codes);
//       const seriesWithColour = new Set(
//         fabricColours.filter((c) => enabled.has(c.colourId)).map((c) => c.fabricId));
//       return fabricLib.filter((f) => seriesWithColour.has(f.id));
//     // its own comment: "Empty -> 'No fabrics enabled'."
//
// So an empty pool removes the SERIES CHIPS as well as the colours: the
// salesperson sees nothing to pick. Staff, 2026-09-13: 「Coner 款选不到颜色」
// 「其他款式也选不了颜色」. docs/bugs/0856.
//
// WHAT THIS RESTORES, and what it CANNOT. The pool holds COLOUR ids. This fills
// every SOFA Model of the POS company with every ACTIVE colour id belonging to
// that company — which is exactly the state the clear's own plan promised
// ("-> every active colour") and the state our SO picker already behaves as.
//
// It does NOT restore the per-Model narrowing that existed before the clear.
// That script took NO BACKUP and printed only aggregates, so the previous
// contents are not recoverable from anywhere. Said plainly here because the next
// reader will ask: a Model that was deliberately narrowed must be re-ticked by
// hand in the Modular drawer.
//
// SCOPE: SOFA Models of ONE company, default 2 (the POS). Houzs is deliberately
// excluded — its picker reads an empty pool as unrestricted, so it is not
// broken, and writing an explicit pool there would create a list somebody then
// has to maintain.
//
// DEFAULT IS PLAN. APPLY needs MODE=apply and CONFIRM="REFILL-POS-FABRICS".
// RE-RUN: idempotent. A second run finds every Model already holding the full
// active-colour set and reports zero changes. The pre-change backup is written
// once and never overwritten.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();
const CONFIRM_PHRASE = "REFILL-POS-FABRICS";
const COMPANY = Number(process.env.COMPANY || 2);
const BACKUP_KEY = "scm.sofa_fabric_pools_backup";
const GH = !!process.env.GITHUB_ACTIONS;
const log = (m) => console.log(GH ? `::notice::${m}` : m);
const die = (m) => { console.error(GH ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

const sameSet = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const s = new Set(a.map(String));
  return b.every((x) => s.has(String(x)));
};

async function main() {
  if (MODE === "apply" && CONFIRM !== CONFIRM_PHRASE) die(`apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  if (!Number.isInteger(COMPANY) || COMPANY <= 0) die(`COMPANY must be a company id; got "${process.env.COMPANY}"`);
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

  const [co] = await sql`SELECT id, code, name FROM public.companies WHERE id = ${COMPANY}`;
  if (!co) { await sql.end(); die(`no company with id ${COMPANY}`); }

  const colours = await sql`
    SELECT colour_id, fabric_id FROM scm.fabric_colours
     WHERE company_id = ${COMPANY} AND coalesce(active, true) = true`;
  const colourIds = colours.map((r) => String(r.colour_id));
  const seriesCount = new Set(colours.map((r) => String(r.fabric_id))).size;

  /* ZERO active colours is the finding, not a reason to write an empty pool.
     Writing [] here would reproduce the exact defect this script exists to
     undo. */
  if (colourIds.length === 0) {
    await sql.end();
    die(`company ${co.code} has NO active fabric colours — refusing to write an empty pool, which is the defect being fixed. Check scm.fabric_colours first.`);
  }

  const models = await sql`
    SELECT company_id, model_code, allowed_options
      FROM scm.product_models
     WHERE company_id = ${COMPANY}
       AND upper(coalesce(category::text, '')) = 'SOFA'
     ORDER BY model_code`;

  const todo = models.filter((m) => !sameSet(m.allowed_options?.fabrics, colourIds));
  const empty = models.filter((m) => !Array.isArray(m.allowed_options?.fabrics) || m.allowed_options.fabrics.length === 0);

  log(`${co.code} (${co.name}): ${models.length} SOFA Model(s); ${empty.length} currently offer NO colour at all.`);
  log(`Active colours for this company: ${colourIds.length} across ${seriesCount} series.`);
  log(`Models to fill: ${todo.length}`);

  if (!todo.length) { log("Nothing to do — every SOFA Model already offers every active colour."); await sql.end(); return; }

  if (MODE !== "apply") {
    log(`\nPLAN ONLY — nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    log("On apply, the CURRENT allowed_options of these Models is saved to "
      + `scm.app_config['${BACKUP_KEY}'] first.`);
    await sql.end();
    return;
  }

  /* The backup the ORIGINAL clear should have taken. ON CONFLICT DO NOTHING so a
     second run cannot overwrite the pre-change copy with a post-change one. */
  const snapshot = models.map((m) => ({
    company_id: m.company_id, model_code: m.model_code, allowed_options: m.allowed_options,
  }));
  const [existing] = await sql`SELECT key FROM scm.app_config WHERE key = ${BACKUP_KEY}`;
  if (existing) {
    log("BACKUP already exists — keeping it; it holds the state before the FIRST apply.");
  } else {
    await sql`
      INSERT INTO scm.app_config (key, value, description, updated_at)
      VALUES (${BACKUP_KEY}, ${JSON.stringify(snapshot)}::text,
              ${`sofa allowed_options for company ${COMPANY}, taken ${new Date().toISOString()} before refill-pos-sofa-fabric-pools`},
              now())
      ON CONFLICT (key) DO NOTHING`;
    const [chk] = await sql`SELECT length(value) AS n FROM scm.app_config WHERE key = ${BACKUP_KEY}`;
    if (!chk || !(chk.n > 0)) die("BACKUP FAILED — refusing to write without a copy of the current state.");
    log(`BACKUP written: ${models.length} model(s), ${chk.n} bytes.`);
  }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const m of todo) {
      await tx`UPDATE scm.product_models
                  SET allowed_options = coalesce(allowed_options, '{}'::jsonb)
                        || jsonb_build_object('fabrics', ${JSON.stringify(colourIds)}::text::jsonb),
                      updated_at = now()
                WHERE company_id = ${m.company_id} AND model_code = ${m.model_code}`;
      n += 1;
    }
  });
  log(`APPLIED: ${n} SOFA Model(s) now offer every active colour.`);
  await sql.end();

  /* Verify on a FRESH connection, asserting the SHAPE — every SOFA Model holds
     the full colour set — not the number of rows the UPDATE reported. */
  const v2 = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const after = await v2`
    SELECT model_code, allowed_options FROM scm.product_models
     WHERE company_id = ${COMPANY} AND upper(coalesce(category::text,'')) = 'SOFA'`;
  await v2.end();
  const wrong = after.filter((m) => !sameSet(m.allowed_options?.fabrics, colourIds));
  if (wrong.length) die(`VERIFY FAILED: ${wrong.length} Model(s) still do not hold the full colour set — ${wrong.slice(0, 5).map((m) => m.model_code).join(", ")}`);
  log(`VERIFIED on a fresh connection: all ${after.length} SOFA Model(s) hold ${colourIds.length} colour(s).`);
}

main().catch((e) => die(e?.message ?? String(e)));
