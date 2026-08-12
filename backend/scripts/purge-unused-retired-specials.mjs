#!/usr/bin/env node
// Delete RETIRED special add-ons that nothing has ever referenced.
//
// WHY THIS IS A SCRIPT AND NOT PART OF /save
//
// The obvious place to put "delete it if nobody used it" is the save path, so
// that Remove means remove. It does not belong there. Deciding it requires
// scanning mfg_sales_order_items.variants::text and product_models
// .allowed_options::text for the code - an unindexed full scan over thousands of
// rows - and putting that on a routine Save would fix one complaint by making
// every save slow. A retire is instant and reversible; a purge is a deliberate
// operation. So Save retires, and this purges.
//
// THE RULE IT ENFORCES is the owner's own, 2026-08-12: "有 order 用过那就没办法".
// An order is the only thing that makes a value untouchable. A retired add-on
// that no order and no Model has ever named is not history worth keeping - it is
// a greyed-out row cluttering a master list.
//
// WHAT COUNTS AS A REFERENCE (any one of these keeps the row):
//   * an SO line whose variants JSON contains the code (variants.specials)
//   * a product_model whose allowed_options JSON contains the code
// Both are matched as SUBSTRINGS of the JSON text, which is deliberately the
// WIDEST possible net: a false positive keeps a row that could have gone (cheap
// and reversible), a false negative would delete something a document names
// (not). Erring the other way would be the wrong mistake to make.
//
// Only `active = false` rows are ever considered. This script cannot touch a
// live add-on, so it can never remove something staff are still choosing.
//
// plan (default) writes nothing. apply needs CONFIRM='I HAVE REVIEWED THE DRY-RUN'.

import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
const CO = Number(process.env.COMPANY_ID || 1);
// Blank = every retired add-on. A '|' separated list narrows it.
const ONLY = (process.env.CODES || "").split("|").map((s) => s.trim()).filter(Boolean);

if (MODE === "apply" && process.env.CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error("MODE=apply requires CONFIRM='I HAVE REVIEWED THE DRY-RUN'");
  process.exit(2);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const out = (s = "") => console.log(s);

async function main() {
  if (MODE !== "apply") await sql.unsafe("SET default_transaction_read_only = on");
  out(`=== purge unused RETIRED specials — MODE=${MODE} company=${CO} ===`);
  out(ONLY.length ? `limited to: ${ONLY.join(" | ")}\n` : `scope: every retired add-on\n`);

  const retired = await sql`
    SELECT id, code, label, categories, updated_at
      FROM scm.special_addons
     WHERE company_id = ${CO} AND active = false
     ORDER BY label`;
  out(`${retired.length} retired add-on(s) in the table`);
  const rows = ONLY.length ? retired.filter((r) => ONLY.includes(r.code)) : retired;
  if (ONLY.length) out(`${rows.length} of them match the CODES filter`);
  if (!rows.length) { out("\nNothing to consider."); await sql.end(); return; }

  const purge = [], keep = [];
  for (const r of rows) {
    const pat = `%${r.code}%`;
    const [{ n: soLines }] = await sql`
      SELECT count(*)::int AS n FROM scm.mfg_sales_order_items
       WHERE company_id = ${CO} AND variants IS NOT NULL AND variants::text ILIKE ${pat}`;
    const [{ n: models }] = await sql`
      SELECT count(*)::int AS n FROM scm.product_models
       WHERE company_id = ${CO} AND allowed_options IS NOT NULL AND allowed_options::text ILIKE ${pat}`;
    if (soLines === 0 && models === 0) purge.push(r);
    else keep.push({ ...r, soLines, models });
  }

  out(`\n-- KEEP (something references them): ${keep.length}`);
  for (const k of keep) out(`     ${String(k.label).padEnd(32)} ${k.soLines} SO line(s), ${k.models} model(s)`);

  out(`\n-- PURGE (zero references anywhere): ${purge.length}`);
  for (const p of purge) out(`     ${String(p.label).padEnd(32)} code=${JSON.stringify(p.code)} cats=${JSON.stringify(p.categories)}`);

  if (!purge.length) { out("\nNothing to purge."); await sql.end(); return; }

  if (MODE !== "apply") {
    out(`\nPLAN ONLY — nothing was written. ${purge.length} row(s) would be DELETED.`);
    out(`Re-run with MODE=apply CONFIRM='I HAVE REVIEWED THE DRY-RUN' to write.`);
    await sql.end();
    return;
  }

  for (const p of purge) {
    await sql`DELETE FROM scm.special_addons WHERE company_id = ${CO} AND id = ${p.id}`;
    out(`DELETED ${p.label}`);
  }
  out(`\nAPPLIED — ${purge.length} row(s) deleted.`);
  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
