#!/usr/bin/env node
// Two owner rulings from the picker review, 2026-08-10:
//
//   "Seat Base Fully Cover with no Leg" and "Fully Cover Replace The Leg"
//   "这两个是一样的啊"          -> one code survives, the other goes
//
//   "altay leg 应该开在 leg 那边啊"
//   -> Altay Leg is a LEG choice, not a special. It moves out of the Specials
//      picker and into the sofa leg pool (maintenance config sofaLegHeights).
//
// The delete is FORCED past the usual in-use guard, deliberately and only here.
// That guard counts documents whose custom_specials FREE TEXT contains the
// phrase - it is not a foreign key. Nine lines say "fully cover replace the
// leg" in their own words; deleting the picker entry does not touch that text,
// and the special-order backfill will map it to the surviving code, which is
// what the owner just said it means.
//
// The pool write is append-only: a NEW maintenance_config_history row, so the
// old pool stays readable.
//
// DRY-RUN by default; APPLY=1 writes.
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const K = (s) => String(s ?? "").trim().toUpperCase();
const val = (v) => (v && typeof v === "object" ? v.value : v);

const DROP_SPECIAL = [
  ["Fully Cover Replace The Leg", 'owner: 一样 -> "Seat Base Fully Cover with no Leg"'],
  ["Altay Leg", "owner: altay leg 应该开在 leg 那边 -> sofaLegHeights"],
];
const ADD_TO_LEG_POOL = "Altay Leg";

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}`);

  const rows = await sql`SELECT id, code, categories FROM scm.special_addons WHERE company_id = ${CO}`;
  const by = new Map(rows.map((r) => [K(r.code), r]));
  const kill = [];
  for (const [code, why] of DROP_SPECIAL) {
    const hit = by.get(K(code));
    if (!hit) { log(`  skip ${code} — absent`); continue; }
    const [{ n: a }] = await sql`SELECT COUNT(*)::int n FROM scm.mfg_sales_order_items
      WHERE company_id = ${CO} AND custom_specials::text ILIKE ${"%" + code + "%"}`;
    const [{ n: b }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_order_items
      WHERE company_id = ${CO} AND custom_specials::text ILIKE ${"%" + code + "%"}`;
    log(`  DELETE special "${code}"  (${why})`);
    log(`      free-text mentions: ${a + b} — text is untouched; the backfill maps it to the surviving code`);
    kill.push(hit.id);
  }

  const [cfg] = await sql`SELECT id, config FROM scm.maintenance_config_history
    WHERE company_id = ${CO} AND scope = 'master' AND effective_from <= CURRENT_DATE
    ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
  const pool = cfg?.config?.sofaLegHeights ?? [];
  log("");
  log(`sofa leg pool (${pool.length}): ${pool.map(val).join(", ")}`);
  const need = !pool.some((e) => K(val(e)) === K(ADD_TO_LEG_POOL));
  log(need ? `  APPEND "${ADD_TO_LEG_POOL}" to sofaLegHeights` : `  "${ADD_TO_LEG_POOL}" already in the leg pool`);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); await sql.end(); return; }
  for (const id of kill) await sql`DELETE FROM scm.special_addons WHERE id = ${id}`;
  if (need && cfg) {
    /* priced pool: entries may be {value, price} objects, so append in the same
       shape the list already uses rather than forcing a bare string. */
    const shaped = pool.length && typeof pool[0] === "object" ? { value: ADD_TO_LEG_POOL, price: 0 } : ADD_TO_LEG_POOL;
    const next = { ...cfg.config, sofaLegHeights: [...pool, shaped] };
    await sql`INSERT INTO scm.maintenance_config_history (id, scope, config, effective_from, notes, created_at, company_id)
      VALUES (${"mch-" + randomBytes(6).toString("hex")}, 'master', ${sql.json(next)}, CURRENT_DATE,
              ${"add Altay Leg to the sofa leg pool; it was wrongly opened as a special (owner 2026-08-10)"}, now(), ${CO})`;
  }
  log(`APPLIED — ${kill.length} special(s) deleted${need ? "; Altay Leg added to sofaLegHeights" : ""}.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
