#!/usr/bin/env node
// Put each special add-on in the category it is actually SOLD in, and strip the
// category it never was.
//
// THE FACTS THIS ACTS ON, read off production 2026-08-12 (read-only session):
//
//   special_addons rows carrying TWO categories: 3 of ~44.
//     5537 Backrest              [BEDFRAME, SOFA]     0 SO lines
//     Separate Backrest Packing  [BEDFRAME, SOFA]     2 SO lines - BOTH SOFA
//     Nylon Fabric               [BEDFRAME, SOFA]   268 SO lines - ALL 268 SOFA
//
//   Not one bedframe line, in 133 documents, has ever carried any of them. So
//   BEDFRAME on these three is not a historical usage to preserve; it is a
//   mis-tag. The owner's rule is that an ORDER is the only thing that makes a
//   value untouchable ("有 order 用过那就没办法") - and no order does.
//
//   Those same three are ticked on 103 of 113 BEDFRAME models' allowed_options
//   (and only 7 of 77 SOFA models). HOW they got there is NOT established: the
//   obvious suspect, fillEmptyAllowedOptions' default-all-on seeding, is ruled
//   OUT by maintenance-pools.ts:95, which says specials are opt-in and must NOT
//   be passed to it. Recorded as unknown rather than guessed at - the clean-up
//   does not depend on the cause.
//
// WHAT THIS DOES, per code:
//   1. REFUSES if any SO line of a BEDFRAME product carries the code. That is
//      the owner's rule enforced in code, not in a comment - if a bedframe order
//      ever used it, the tag was real and this script must not touch it.
//   2. Removes 'BEDFRAME' from special_addons.categories (never the whole row -
//      the add-on stays alive and every SOFA order keeps resolving it).
//   3. Removes the code from allowed_options.specials on BEDFRAME models only.
//      SOFA models are not touched.
//
// A code that would end up with NO categories is refused rather than orphaned.
//
// plan (default) writes nothing and pins the session read-only.
// apply needs CONFIRM='I HAVE REVIEWED THE DRY-RUN'.
//
// RE-RUN: inert. A special is only in scope while it still carries the category being removed, which the write removes.

import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
const CO = Number(process.env.COMPANY_ID || 1);
const FROM_CAT = (process.env.FROM_CATEGORY || "BEDFRAME").toUpperCase();
const CODES = (process.env.CODES ||
  '5537 Backrest|Separate Backrest Packing|Nylon Fabric').split("|").map((s) => s.trim()).filter(Boolean);

if (MODE === "apply" && process.env.CONFIRM !== "I HAVE REVIEWED THE DRY-RUN") {
  console.error("MODE=apply requires CONFIRM='I HAVE REVIEWED THE DRY-RUN'");
  process.exit(2);
}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const out = (s = "") => console.log(s);

async function main() {
  if (MODE !== "apply") await sql.unsafe("SET default_transaction_read_only = on");
  out(`=== move specials out of ${FROM_CAT} — MODE=${MODE} company=${CO} ===`);
  out(`codes: ${CODES.join(" | ")}\n`);

  const plan = [];
  for (const code of CODES) {
    const [row] = await sql`
      SELECT id, code, label, categories, active
        FROM scm.special_addons WHERE company_id = ${CO} AND code = ${code}`;
    if (!row) { out(`SKIP  "${code}" — no such special_addon`); continue; }

    const cats = (row.categories ?? []).map((c) => String(c).toUpperCase());
    if (!cats.includes(FROM_CAT)) { out(`SKIP  "${code}" — not tagged ${FROM_CAT} (${JSON.stringify(cats)})`); continue; }
    const remaining = cats.filter((c) => c !== FROM_CAT);
    if (remaining.length === 0) {
      out(`REFUSE "${code}" — ${FROM_CAT} is its ONLY category; removing it would orphan the add-on.`);
      continue;
    }

    /* THE OWNER'S RULE, enforced: an order is the only thing that makes this
       untouchable. Look for a line that BOTH carries the code AND is a product
       of the category we are stripping. */
    const [{ n: badLines }] = await sql`
      SELECT count(*)::int AS n
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_products p ON p.company_id = ${CO} AND p.code = i.item_code
       WHERE i.company_id = ${CO}
         AND upper(p.category::text) = ${FROM_CAT}
         AND i.variants IS NOT NULL
         AND i.variants::text ILIKE ${'%' + code + '%'}`;
    if (badLines > 0) {
      out(`REFUSE "${code}" — ${badLines} ${FROM_CAT} SO line(s) carry it. The tag was real; leaving it alone.`);
      continue;
    }

    const [{ n: otherLines }] = await sql`
      SELECT count(*)::int AS n FROM scm.mfg_sales_order_items i
       WHERE i.company_id = ${CO} AND i.variants IS NOT NULL
         AND i.variants::text ILIKE ${'%' + code + '%'}`;

    const models = await sql`
      SELECT id, model_code, category::text AS category
        FROM scm.product_models
       WHERE company_id = ${CO}
         AND upper(category::text) = ${FROM_CAT}
         AND allowed_options IS NOT NULL
         AND allowed_options::text ILIKE ${'%' + code + '%'}
       ORDER BY model_code`;

    plan.push({ row, remaining, models, otherLines });
    out(`MOVE  "${code}"`);
    out(`        categories ${JSON.stringify(cats)} -> ${JSON.stringify(remaining)}`);
    out(`        ${FROM_CAT} SO lines carrying it: 0  (other-category lines: ${otherLines})`);
    out(`        ${FROM_CAT} models to untick: ${models.length}`);
  }

  if (!plan.length) { out("\nNothing to do."); await sql.end(); return; }

  if (MODE !== "apply") {
    out(`\nPLAN ONLY — nothing was written.`);
    out(`${plan.length} special(s) would move; ${plan.reduce((s, p) => s + p.models.length, 0)} model tick(s) would be removed.`);
    out(`Re-run with MODE=apply CONFIRM='I HAVE REVIEWED THE DRY-RUN' to write.`);
    await sql.end();
    return;
  }

  for (const p of plan) {
    await sql`
      UPDATE scm.special_addons
         SET categories = ${p.remaining}, updated_at = now()
       WHERE company_id = ${CO} AND id = ${p.row.id}`;
    out(`APPLIED categories on "${p.row.code}" -> ${JSON.stringify(p.remaining)}`);

    /* allowed_options is jsonb; `specials` is an array of codes. Rebuild it
       without this code and write the WHOLE object back, so a model that stores
       the key under a different shape is left untouched rather than mangled. */
    let ticked = 0;
    for (const m of p.models) {
      const [{ allowed_options: ao }] = await sql`
        SELECT allowed_options FROM scm.product_models WHERE id = ${m.id}`;
      if (!ao || typeof ao !== "object" || Array.isArray(ao)) continue;
      const list = ao.specials;
      if (!Array.isArray(list)) continue;
      const next = list.filter((x) => String(x) !== p.row.code);
      if (next.length === list.length) continue;
      await sql`
        UPDATE scm.product_models
           SET allowed_options = ${{ ...ao, specials: next }}, updated_at = now()
         WHERE id = ${m.id}`;
      ticked++;
    }
    out(`APPLIED unticked "${p.row.code}" on ${ticked} ${FROM_CAT} model(s)`);
  }

  out("\nDONE.");
  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch {} process.exit(1); });
