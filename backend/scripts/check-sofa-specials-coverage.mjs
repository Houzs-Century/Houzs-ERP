#!/usr/bin/env node
// Read-only: report every HOUZS sofa product_model whose
// allowed_options.specials count is BELOW the active `special_addons` pool for
// SOFA. Sanity check after the open-all sofa apply — a shape check that DID
// NOT ship with the apply (which only counted fabrics).
//
// Also reports the count returned by GET /special-addons as seen by any HOUZS
// user context, so we can see if the frontend and backend agree on the pool.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

async function main() {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = ${"HOUZS"}`;
  if (!co) throw new Error("company HOUZS not found");
  const cid = co.id;

  const addons = await sql`SELECT code FROM scm.special_addons
    WHERE company_id = ${cid} AND active = true AND ${"SOFA"} = ANY(categories)
    ORDER BY sort_order NULLS LAST, code`;
  const want = addons.length;
  note(`HOUZS sofa special_addons pool: ${want} codes  (${addons.map((r) => r.code).slice(0, 8).join(", ")}${addons.length > 8 ? " …" : ""})`);

  const models = await sql`SELECT model_code, name, active, allowed_options
    FROM scm.product_models
    WHERE company_id = ${cid} AND category = 'SOFA'
    ORDER BY model_code`;

  const active = models.filter((m) => m.active === true);
  const inactive = models.filter((m) => m.active !== true);
  note(`sofa product_models: ${models.length} total (${active.length} active, ${inactive.length} inactive)`);

  const under = active.filter((m) => (m.allowed_options?.specials ?? []).length < want);
  const empty = active.filter((m) => !Array.isArray(m.allowed_options?.specials) || m.allowed_options.specials.length === 0);
  note(`active sofa models with < ${want} specials: ${under.length}`);
  note(`active sofa models with 0 specials: ${empty.length}`);
  if (under.length > 0) {
    note("under-covered (first 10):");
    for (const m of under.slice(0, 10)) {
      note(`  ${m.model_code}  "${m.name}"  specials=${(m.allowed_options?.specials ?? []).length}/${want}`);
    }
  }
  if (empty.length > 0) {
    note("EMPTY specials — these will show 'No preset special orders' on the SO picker (first 10):");
    for (const m of empty.slice(0, 10)) {
      note(`  ${m.model_code}  "${m.name}"`);
    }
  }

  const inactiveWithSpecials = inactive.filter((m) => (m.allowed_options?.specials ?? []).length > 0);
  note(`inactive sofa models (would be excluded from any picker): ${inactive.length}, of which ${inactiveWithSpecials.length} still carry specials`);
}

main()
  .then(() => sql.end({ timeout: 5 }))
  .catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
