#!/usr/bin/env node
// Open the sofa special-order codes the AutoCount slips actually use.
//
// Owner 2026-08-10: "那个 special order 刚刚不是发你照片了?你先去开,开完了叫我
// 我去检查." The list below is not invented — every entry was counted in the
// 1,456 sofa Desc2 strings across the three cutover exports, and the count is
// carried on the row so the reason is auditable.
//
// The biggest one is UMBRELLA FABRIC: 53 occurrences, more than nylon, and the
// decoder currently DELETES the phrase (parse-sofa.mjs strips `bottom...` before
// specials are collected), so not one of those 53 instructions reached the ERP.
//
// WHY IT WRITES THE TABLE AND NOT THE SNAPSHOT ROUTE. POST /special-addons/save
// takes the WHOLE set and deactivates every code missing from it — safe from the
// UI, lethal from a script that only knows about eleven rows. This inserts the
// missing codes into scm.special_addons and touches nothing else.
//
// DRY-RUN by default; APPLY=1 writes.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/* code, label, how many document lines say it, and the raw spellings it covers.
   Prices are 0 — the owner sets them; a wrong price is worse than none. */
const WANTED = [
  ["Umbrella Fabric Bottom (Sofa)", "Umbrella Fabric Bottom", 53,
   "bottom use umbrella fabric / bottom upgrade to umbrella fabric / wrap bottom to umbrella fabric"],
  ["Fully Cover To Floor No Leg", "Fully Cover To Floor No Leg", 11,
   "fully covered to floor no leg / fully cover to floor"],
  ["Fully Cover Replace The Leg", "Fully Cover Replace The Leg", 8,
   "fully cover replace the leg"],
  ["Leg Change - Altay Glossy Black", "Leg Change - Altay Glossy Black", 6,
   "leg change altay leg grossy black leg"],
  ["Extend To Floor With 1inch Leg", "Extend To Floor With 1inch Leg", 5,
   "extend to floor with 1'inch leg"],
  ["After Push Back Align To Seat", "After Push Back Align To Seat", 5,
   "after push back align to seat"],
  ["Sitting Cushion Add Height 1inch", "Sitting Cushion Add Height 1inch", 3,
   "sitting cushion add height 1'inch"],
  ["Seat Cushion No Line Do Plane", "Seat Cushion No Line Do Plane", 3,
   "seat cushion no line do plane"],
  ["Back Cushion Change 5535 Design", "Back Cushion Change 5535 Design", 3,
   "back cushion change 5535 design"],
  ["1 Side Power Slider", "1 Side Power Slider", 3, "1 side power slider"],
  ["2R Armrest Replace Seat", "2R Armrest Replace Seat", 3, "2r armrest replace seat"],
];

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  const cols = (await sql`SELECT column_name, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema='scm' AND table_name='special_addons'`);
  const have = new Set(cols.map((c) => c.column_name));
  log(`special_addons columns: ${[...have].join(", ")}`);

  const existing = await sql`SELECT code, label FROM scm.special_addons WHERE company_id = ${CO}`;
  const byCode = new Map(existing.map((r) => [norm(r.code), r]));
  const byLabel = new Map(existing.map((r) => [norm(r.label), r]));
  log(`existing specials: ${existing.length}`);

  const todo = [];
  for (const [code, label, n, raw] of WANTED) {
    const hit = byCode.get(norm(code)) ?? byLabel.get(norm(label));
    if (hit) { log(`  SKIP  ${code}  — already there as "${hit.code}"`); continue; }
    todo.push({ code, label, n, raw });
  }
  log("");
  log(`to create: ${todo.length}`);
  for (const t of todo) log(`  + ${t.code}  (${t.n} document lines say: ${t.raw})`);

  if (!todo.length) { log("nothing to do"); await sql.end(); return; }
  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to create them."); await sql.end(); return; }

  /* Build the INSERT from the columns the table actually has, so this keeps
     working if the schema grows. Anything not named here takes its default. */
  const pick = (o) => Object.entries(o).filter(([k]) => have.has(k));
  let n = 0;
  for (const t of todo) {
    const row = {
      code: t.code,
      label: t.label,
      so_description: "",
      categories: sql.json(["sofa"]),
      selling_price_sen: 0,
      cost_price_sen: 0,
      option_groups: sql.json([]),
      active: true,
      sort_order: 0,
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
  log(`APPLIED — ${n} special-order codes created (price 0, active, category sofa).`);
  log("Prices are deliberately 0: the owner sets them, a wrong price is worse than none.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
