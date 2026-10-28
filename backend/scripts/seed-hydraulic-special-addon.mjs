#!/usr/bin/env node
// Open HYDRAULIC as a tickable code in the Special Orders picker.
//
// Owner 2026-08-11: "开 special order 那边勾选". Two prior agents recommended
// AGAINST this — a hydraulic base is a property of the divan, axis-shaped, and
// arguably belongs to the divan-height pool rather than the Specials picker.
// The owner heard that and decided otherwise. This opens the code.
//
// PRICE IS 0, DELIBERATELY, AND THE OWNER SETS IT LATER.
// This is not timidity, it is the interlock with the charging fix landing in
// the same PR. Until now a priced special add-on was COSTED and never CHARGED
// on a sofa line or on any line whose product carries sell_price_sen = 0; that
// asymmetry is fixed, so from now on a priced add-on really does move the
// customer's price. The 49 existing hydraulic lines are MIGRATED AutoCount
// documents. A non-zero price here plus a stamp on those lines is exactly the
// combination that would re-price history, so the price stays 0 and the stamp
// runs through backfill-specials-into-variants.mjs with SKIP_PRICED=1, which
// re-reads priced-ness live on every run and refuses to move money.
//
// THE TICK DOES NOT REPLACE variants.divanHeight, AND MUST NOT.
// parse-bedframe.mjs:46-89 derives the divan height FROM the hydraulic wording
// (outer wins, inner + 2 — owner's ruling 2026-08-10). The tick records WHAT
// THE BED IS; the height records HOW BIG IT IS. 45 of the 49 lines carry both
// and should keep carrying both.
//
// CATEGORIES ARE UPPERCASE. Both pickers filter case-sensitively
// (SoLineCard.tsx:573-579 and MobileNewSO.tsx:3356-3365 both do
// `a.categories.includes(category.toUpperCase())`), so a lowercase token
// produces a row the backfill can map to and no human can ever tick.
//
// WHY IT WRITES THE TABLE AND NOT THE SNAPSHOT ROUTE. POST /special-addons/save
// takes the WHOLE set and deactivates every code missing from it — safe from
// the UI, lethal from a script that knows about one row.
//
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. INSERT ... ON CONFLICT DO NOTHING.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/* One row. `code` is the value that lands in variants.specials and that
   special-order-phrase-map.json resolves against the LIVE table, so the two
   must agree exactly — the family's `code` is "Hydraulic". Title case matches
   every other live code ("HB Straight", "Divan Curve", "1 Piece Divan"). */
const WANTED = [{
  code: "Hydraulic",
  label: "Hydraulic",
  soDescription: "Hydraulic",
  categories: ["BEDFRAME"],
  why: "49 migrated bedframe lines say it: 'DIV 12\" HYDRAULIC', 'Divan: Hydraulic/ Inner Hydraulic: 12\"', 'HYDRAULIC:16\"', and the bare tag",
}];

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  const cols = await sql`SELECT column_name FROM information_schema.columns
    WHERE table_schema='scm' AND table_name='special_addons'`;
  const have = new Set(cols.map((c) => c.column_name));
  log(`special_addons columns: ${[...have].join(", ")}`);

  const existing = await sql`SELECT code, label, categories, active, selling_price_sen, cost_price_sen
    FROM scm.special_addons WHERE company_id = ${CO}`;
  const byCode = new Map(existing.map((r) => [norm(r.code), r]));
  const byLabel = new Map(existing.map((r) => [norm(r.label), r]));
  log(`existing specials: ${existing.length}`);

  /* Report anything already hydraulic-shaped before creating a second one. The
     owner asked for ONE tickable code, and a near-duplicate ("Hydraulic Divan")
     would split the 49 lines across two codes for good. */
  const near = existing.filter((r) => /HYDRAUL|HYDROL|HYDRAIL/i.test(`${r.code} ${r.label}`));
  log(`rows already matching HYDRAUL: ${near.length}` +
      (near.length ? ` -> ${near.map((r) => `[${r.code}] sell=${r.selling_price_sen} cost=${r.cost_price_sen}`).join(" ")}` : ""));

  const todo = [];
  for (const w of WANTED) {
    const hit = byCode.get(norm(w.code)) ?? byLabel.get(norm(w.label));
    if (hit) { log(`  SKIP  ${w.code} — already there as "${hit.code}" (categories=${(hit.categories || []).join("+")}, sell=${hit.selling_price_sen}, cost=${hit.cost_price_sen})`); continue; }
    todo.push(w);
  }
  log("");
  log(`to create: ${todo.length}`);
  for (const t of todo) log(`  + ${t.code}  categories=${t.categories.join("+")}  price 0/0  (${t.why})`);

  if (!todo.length) { log("nothing to do"); await sql.end(); return; }
  if (!APPLY) { log(""); log("DRY-RUN — set APPLY=1 to create it."); await sql.end(); return; }

  /* Build the INSERT from the columns the table actually has, so this keeps
     working if the schema grows. Anything not named here takes its default. */
  const pick = (o) => Object.entries(o).filter(([k]) => have.has(k));
  let n = 0;
  for (const t of todo) {
    const row = {
      code: t.code,
      label: t.label,
      so_description: t.soDescription,
      /* text[] in this table, NOT jsonb — passing sql.json here threw
         "column categories is of type text[] but expression is of type jsonb"
         on the sofa seed's first APPLY and nothing was written. */
      categories: t.categories,
      selling_price_sen: 0,
      cost_price_sen: 0,
      option_groups: sql.json([]),
      active: true,
      /* Land it after the existing bedframe codes rather than colliding with
         one of their slots; the owner reorders in Maintenance if he wants. */
      sort_order: Math.max(0, ...existing.map((r) => Number(r.sort_order ?? 0))) + 1,
      company_id: CO,
    };
    const entries = pick(row);
    const names = entries.map(([k]) => k).join(", ");
    const marks = entries.map((_, i) => `$${i + 1}`).join(", ");
    await sql.unsafe(
      `INSERT INTO scm.special_addons (${names}) VALUES (${marks}) ON CONFLICT DO NOTHING`,
      entries.map(([, v]) => v),
    );
    n++;
  }

  /* Read back on a FRESH connection — a log line is never evidence in this
     repo (docs/jsonb-double-encoding-coe.md). */
  await sql.end();
  const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const back = await verify`SELECT code, label, categories, active, sort_order, selling_price_sen, cost_price_sen
    FROM scm.special_addons WHERE company_id = ${CO} AND code = ANY(${WANTED.map((w) => w.code)})`;
  log("");
  log(`APPLIED — ${n} inserted. Read back on a fresh connection:`);
  for (const r of back)
    log(`   [${r.code}] label="${r.label}" categories=${(r.categories || []).join("+")} active=${r.active} ` +
        `sort_order=${r.sort_order} sell=${r.selling_price_sen} cost=${r.cost_price_sen}`);
  if (back.length !== WANTED.length) {
    log(`NOT LANDED — expected ${WANTED.length} rows, read back ${back.length}`);
    await verify.end();
    process.exit(1);
  }
  const bad = back.filter((r) => Number(r.selling_price_sen) !== 0 || Number(r.cost_price_sen) !== 0);
  if (bad.length) {
    log(`PRICE IS NOT 0 on ${bad.map((r) => r.code).join(", ")} — that is the one thing this script must not do.`);
    await verify.end();
    process.exit(1);
  }
  log("");
  log("Price is 0/0 by design. The owner sets it in Maintenance > Specials when he is ready;");
  log("from that moment a ticked Hydraulic charges on new/edited lines (migrated documents never re-price).");
  await verify.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
