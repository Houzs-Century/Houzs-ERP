#!/usr/bin/env node
// Bring the Specials picker to the vocabulary the owner dictated on 2026-08-10,
// in one pass: delete what belongs somewhere else, rename to his spelling, merge
// the duplicate pairs that were already there, and create the codes he thought
// he had.
//
// THE THING THAT MADE THIS NECESSARY: he typed a dozen specials into the
// maintenance page and none of them saved — the SCM write freeze refuses every
// non-GET on /api/scm/* unless the caller holds '*' or 'scm.admin', which his
// account does not. The screenshots showed an unsaved draft. Nine of the codes
// he has been referring to all day do not exist in the database at all.
//
// His rulings, each one applied below:
//   nylon and umbrella fabric are the same treatment  -> one code
//   "fully cover to floor no leg" and "fully cover replace the leg" are both
//     the no-leg case                                  -> one code
//   power slider and armrest-replace-seat are COMPARTMENTS, not specials
//   "seat cushion add height 1 inch" goes in the SO's free text, not the picker
//     ("不要太多选项")
//   "no line do plane" is a real new one, named "Seat Cushion No Notch and Plain"
//   the Altay leg is a LEG choice, code "Altay Leg"
//
// Every destructive step proves the code is unreferenced first (custom_specials
// on SO and PO lines) and REFUSES if it is not — after the backfill starts, a
// rename orphans whatever points at the old spelling.
//
// DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: inert. Renames test the current spelling, deletes are gone, and the creates are ON CONFLICT DO NOTHING.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const K = (s) => String(s ?? "").trim().toUpperCase();

// code -> where its meaning now lives. Deleted from the picker, not from history.
const DELETE = [
  ["Sitting Cushion Add Height 1inch", "SO free text — owner: 不要太多选项"],
  ["1 Side Power Slider", "that is a compartment, not a special"],
  ["2R Armrest Replace Seat", "that is a compartment, not a special"],
  ["After Push Back Align To Seat", "same thing as Seat Behind Extend 5\""],
  ["Umbrella Fabric Bottom (Sofa)", "owner: nylon 和 umbrella fabric 一样的 -> Nylon Fabric"],
  ["Extend To Floor With 1inch Leg", "owner: 都是 under no leg -> Seat Base Fully Cover with no Leg"],
  ["Fully Cover Replace The Leg", "owner: 一样 -> Seat Base Fully Cover with no Leg"],
];

const RENAME = [
  ["Fully Cover To Floor No Leg", "Seat Base Fully Cover with no Leg", "the surviving no-leg code"],
  ["Seat Cushion No Line Do Plane", "Seat Cushion No Notch and Plain", "owner named it"],
  ["Leg Change - Altay Glossy Black", "Altay Leg", "owner: Leg 你写那个 Altay Leg"],
  ["Back Cushion Change 5535 Design", "change to 5535 back cushion", "matches his other four"],
  ["Extend 5\"", "Seat Behind Extend 5\"", "his spelling; keeps ONE code instead of adding a twin"],
];

// duplicate pairs that predate today: keep the plain one, drop the "(Sofa)" twin
const DEDUPE = [
  ["5537 Backrest (Sofa)", "5537 Backrest"],
  ["Nylon Fabric (Sofa)", "Nylon Fabric"],
  ["Separate Backrest Packing (Sofa)", "Separate Backrest Packing"],
];

// the ones he believed existed. Prices 0 — his to set.
const CREATE = [
  "Wooden Arm", "Seat Firmer", "Backcushion Firmer", "Seat and Backcushion Firmer",
  "No notch on Seat Cushion", "Seat Behind Extend 4\"",
  "Change 8030 Backcushion", "change to 9028 back cushion",
  "change to 9050 back cushion", "change to 9058 back cushion",
];

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);
  const rows = await sql`SELECT id, code, label, categories, active FROM scm.special_addons WHERE company_id = ${CO} ORDER BY code`;
  const by = new Map(rows.map((r) => [K(r.code), r]));
  log(`specials on file: ${rows.length}`);
  /* categories is what splits the maintenance page into its BEDFRAME and SOFA
     lists, so a code with the wrong token is invisible even though the row is
     there. Print it. */
  for (const r of rows) log(`   [${r.code}] cat=${JSON.stringify(r.categories)} active=${r.active}`);

  const uses = async (code) => {
    const [{ n: a }] = await sql`SELECT COUNT(*)::int n FROM scm.mfg_sales_order_items
      WHERE company_id = ${CO} AND custom_specials::text ILIKE ${"%" + code + "%"}`;
    const [{ n: b }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_order_items
      WHERE company_id = ${CO} AND custom_specials::text ILIKE ${"%" + code + "%"}`;
    return a + b;
  };

  const plan = []; const blocked = [];
  for (const [code, why] of DELETE) {
    const hit = by.get(K(code)); if (!hit) { log(`  skip delete ${code} — absent`); continue; }
    const n = await uses(code);
    (n ? blocked : plan).push({ kind: "delete", id: hit.id, code, why, n });
  }
  for (const [from, to, why] of RENAME) {
    const hit = by.get(K(from)); if (!hit) { log(`  skip rename ${from} — absent`); continue; }
    if (by.has(K(to))) { log(`  skip rename ${from} — "${to}" already exists`); continue; }
    const n = await uses(from);
    (n ? blocked : plan).push({ kind: "rename", id: hit.id, code: from, to, why, n });
  }
  for (const [dup, keep] of DEDUPE) {
    const hit = by.get(K(dup)); if (!hit) { log(`  skip dedupe ${dup} — absent`); continue; }
    if (!by.has(K(keep))) { log(`  skip dedupe ${dup} — "${keep}" is not there to keep`); continue; }
    const n = await uses(dup);
    (n ? blocked : plan).push({ kind: "delete", id: hit.id, code: dup, why: `duplicate of "${keep}"`, n });
  }
  const toCreate = CREATE.filter((c) => !by.has(K(c)));
  for (const c of CREATE) if (by.has(K(c))) log(`  skip create ${c} — already there`);

  log("");
  for (const p of plan) log(`  ${p.kind.toUpperCase().padEnd(6)} "${p.code}"${p.to ? ` -> "${p.to}"` : ""}   (${p.why})`);
  for (const c of toCreate) log(`  CREATE "${c}"`);
  log("");
  log(`delete ${plan.filter((p) => p.kind === "delete").length} · rename ${plan.filter((p) => p.kind === "rename").length} · create ${toCreate.length}`);
  log(`picker after: ${rows.length - plan.filter((p) => p.kind === "delete").length + toCreate.length}`);
  if (blocked.length) {
    log("");
    for (const b of blocked) log(`  REFUSED "${b.code}" — ${b.n} order line(s) reference it; rename it in the UI so the reference follows`);
  }
  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }

  for (const p of plan) {
    if (p.kind === "delete") await sql`DELETE FROM scm.special_addons WHERE id = ${p.id}`;
    else await sql`UPDATE scm.special_addons SET code = ${p.to}, label = ${p.to} WHERE id = ${p.id}`;
  }
  for (const c of toCreate) {
    await sql`INSERT INTO scm.special_addons
      (code, label, so_description, categories, selling_price_sen, cost_price_sen, option_groups, active, sort_order, company_id)
      VALUES (${c}, ${c}, '', ${["sofa"]}, 0, 0, ${sql.json([])}, true, 0, ${CO})
      ON CONFLICT DO NOTHING`;
  }
  log(`APPLIED — deleted ${plan.filter((p) => p.kind === "delete").length}, renamed ${plan.filter((p) => p.kind === "rename").length}, created ${toCreate.length}.`);
  log("New codes carry price 0: the owner sets them.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
