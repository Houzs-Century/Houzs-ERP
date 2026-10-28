// Global sofa tier shift (owner 2026-08-09: "all of our normal price start
// from P2"; third fabric band not recorded).
//
// The 2026-08 load put each supplier's base band at PRICE_1. Correct
// convention (same as the Hookka quotation): base band -> PRICE_2, second
// band -> PRICE_3, third band dropped.
//   AMN/DSL: B&C->P2, A->P3, Luxury deleted
//   THL:     Fabric->P2, Acacia->P3, Half Leather deleted
//   TD:      C (5066's base band) -> P2
//   RDS:     EasyClean->P3, Acacia deleted (Normal had no sheet prices)
//
// Value-guarded everywhere; per-SKU order: delete old P3, move P2->P3,
// move P1->P2. Touches seat grids, each supplier's binding matrices
// (incl. STD keys), flat base/price1 lanes, and that supplier's combo
// batch (both scopes). Audited. DRY-RUN default; APPLY=1 writes.
//
// RE-RUN: REFUSED once the combo batch has been shifted. This is a ONE-SHOT
// migration and the combo block below is the reason it cannot simply be made
// idempotent: it shifts by POSITION (P1->P2, P2->P3, P3->deleted), not by
// value, so a second pass takes the band the first pass promoted to P2 and
// pushes it to P3, and soft-DELETES the band the first pass promoted to P3.
// The second run destroys exactly what the first one built. The seat grids,
// binding matrices and flat lanes are value-guarded and would be inert on
// their own; the pre-flight below refuses the whole script anyway, because a
// half-shifted price list is worse than an unshifted one.
//
// The receipt is in the data, not in a flag file: before this runs, the
// 2026-08 combo batch has no soft-deleted rows (it was loaded hours earlier by
// load-supplier-combos.mjs / load-hookka-combos.mjs). After it runs, every old
// PRICE_3 row in the batch carries a deleted_at. So one deleted row in the
// batch means "already shifted, or a person has retired a combo by hand" - and
// both are reasons to stop and let someone look.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const data = JSON.parse(readFileSync(new URL("./data/sofa-tier-shift-2026-08.json", import.meta.url), "utf8"));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const REASON = "sofa-tier-shift (owner 2026-08-09: normal starts at P2)";
const COMBO_NOTES = ["supplier-price-list-2026-08 set rows (AMN)", "supplier-price-list-2026-08 set rows (DSL)",
                     "supplier-price-list-2026-08 set rows (THL)", "supplier-price-list-2026-08 set rows (TD)",
                     "supplier-price-list-2026-08 set rows (RDS)"];

const bySku = new Map();
for (const c of data.cells) {
  if (!bySku.has(c.sku)) bySku.set(c.sku, []);
  bySku.get(c.sku).push(c);
}
const flatBySku = new Map();
for (const f of data.flats) {
  if (!flatBySku.has(f.sku)) flatBySku.set(f.sku, []);
  flatBySku.get(f.sku).push(f);
}

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const cid = co.id;
  const stats = {};
  const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };
  /* PRE-FLIGHT, before a single write. A shifted batch must not be shifted
     again - see the header. Checked outside the transaction so the refusal is
     a plain message rather than a rollback nobody reads. */
  const [{ n: retired }] = await sql`SELECT COUNT(*)::int AS n FROM scm.sofa_combo_pricing
    WHERE deleted_at IS NOT NULL AND notes = ANY(${COMBO_NOTES})`;
  if (retired) {
    console.error(`REFUSED: ${retired} row(s) of the 2026-08 combo batch are already soft-deleted, `
      + `which is what THIS script does to the old PRICE_3 band. Shifting again would push the `
      + `promoted P2 band to P3 and delete the promoted P3 band. If a person retired those combos `
      + `by hand and the shift really has not run, say so and re-run the combo block deliberately.`);
    await sql.end({ timeout: 3 });
    process.exit(2);
  }

  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    const audit = (code, field, oldV, newV) => APPLY
      ? tx`INSERT INTO scm.master_price_history (item_code, field, old_value_sen, new_value_sen, reason, changed_at, company_id)
           VALUES (${code}, ${field}, ${oldV ?? null}, ${newV ?? null}, ${REASON}, ${now}, ${cid})`
      : Promise.resolve();

    // ---- seat grids ----
    for (const [sku, list] of bySku) {
      const [p] = await tx`SELECT id, seat_height_prices FROM scm.mfg_products WHERE company_id = ${cid} AND code = ${sku}`;
      if (!p || !Array.isArray(p.seat_height_prices)) continue;
      let entries = p.seat_height_prices.map((e) => ({ ...e }));
      let touched = false;
      const find = (h, t, sen) => entries.findIndex((e) => e.height === h && (e.tier ?? "PRICE_2") === t && e.priceSen === sen);
      const drop = (i) => { if (entries[i].sellingPriceSen != null) delete entries[i].priceSen; else entries.splice(i, 1); };
      for (const c of list.filter((x) => x.act === "delP3")) {
        const i = find(c.height, "PRICE_3", c.sen);
        if (i >= 0) { drop(i); touched = true; bump("grid_del"); await audit(sku, `seat_height:${c.height}|PRICE_3`, c.sen, null); }
      }
      for (const c of list.filter((x) => x.act === "P2->P3")) {
        const i = find(c.height, "PRICE_2", c.sen);
        if (i < 0) continue;
        if (entries.some((e) => e.height === c.height && (e.tier ?? "PRICE_2") === "PRICE_3" && e.priceSen != null)) { bump("grid_p3_occupied"); continue; }
        drop(i); entries.push({ height: c.height, tier: "PRICE_3", priceSen: c.sen });
        touched = true; bump("grid_p2to3"); await audit(sku, `seat_height:${c.height}|PRICE_2->PRICE_3`, c.sen, c.sen);
      }
      for (const c of list.filter((x) => x.act === "P1->P2")) {
        const i = find(c.height, "PRICE_1", c.sen);
        if (i < 0) continue;
        if (entries.some((e) => e.height === c.height && (e.tier ?? "PRICE_2") === "PRICE_2" && e.priceSen != null)) { bump("grid_p2_occupied"); continue; }
        drop(i); entries.push({ height: c.height, tier: "PRICE_2", priceSen: c.sen });
        touched = true; bump("grid_p1to2"); await audit(sku, `seat_height:${c.height}|PRICE_1->PRICE_2`, c.sen, c.sen);
      }
      if (touched && APPLY)
        await tx`UPDATE scm.mfg_products SET seat_height_prices = ${tx.json(entries)}, updated_at = ${now} WHERE id = ${p.id}`;

      // supplier binding matrix (same shifts, incl STD)
      const supCode = list[0].sup;
      const [b] = await tx`SELECT b.id, b.price_matrix FROM scm.supplier_material_bindings b
        JOIN scm.suppliers s ON s.id = b.supplier_id
        WHERE b.company_id = ${cid} AND b.material_kind = 'mfg_product' AND b.item_code = ${sku} AND s.code = ${supCode}`;
      if (b && b.price_matrix && typeof b.price_matrix === "object") {
        const m = JSON.parse(JSON.stringify(b.price_matrix));
        let mt = false;
        const all = [...list, ...(flatBySku.get(sku) || [])];
        for (const c of all.filter((x) => x.act === "delP3")) {
          const hk = c.height ?? "STD";
          if (m[hk]?.P3 === c.sen) { delete m[hk].P3; if (!Object.keys(m[hk]).length) delete m[hk]; mt = true; bump("matrix_del"); }
        }
        for (const c of all.filter((x) => x.act === "P2->P3")) {
          const hk = c.height ?? "STD";
          if (m[hk]?.P2 === c.sen && m[hk]?.P3 == null) { m[hk].P3 = c.sen; delete m[hk].P2; mt = true; bump("matrix_p2to3"); }
        }
        for (const c of all.filter((x) => x.act === "P1->P2")) {
          const hk = c.height ?? "STD";
          if (m[hk]?.P1 === c.sen && m[hk]?.P2 == null) { m[hk].P2 = c.sen; delete m[hk].P1; mt = true; bump("matrix_p1to2"); }
        }
        if (mt && APPLY)
          await tx`UPDATE scm.supplier_material_bindings SET price_matrix = ${Object.keys(m).length ? tx.json(m) : null}, updated_at = ${now} WHERE id = ${b.id}`;
      }
    }

    // ---- flat lanes: base held the old-P2 band, price1 held the old-P1 band ----
    for (const [sku, list] of flatBySku) {
      const p1v = list.find((x) => x.act === "P1->P2")?.sen ?? null;
      const p2v = list.find((x) => x.act === "P2->P3")?.sen ?? null;
      if (p1v == null) continue;  // no base-band value to promote; leave as-is
      const [p] = await tx`SELECT id, base_price_sen, price1_sen FROM scm.mfg_products WHERE company_id = ${cid} AND code = ${sku}`;
      if (!p) continue;
      if ((p.price1_sen || 0) === p1v && (p2v == null || (p.base_price_sen || 0) === p2v)) {
        if (APPLY) await tx`UPDATE scm.mfg_products SET base_price_sen = ${p1v}, price1_sen = 0, updated_at = ${now} WHERE id = ${p.id}`;
        await audit(sku, "base_price_sen", p.base_price_sen, p1v);
        await audit(sku, "price1_sen", p.price1_sen, null);
        bump("flat_promoted");
      } else bump("flat_mismatch");
    }

    // ---- combos: shift tiers within our supplier batches (both scopes) ----
    const combos = await tx`SELECT id, tier, notes FROM scm.sofa_combo_pricing
      WHERE deleted_at IS NULL AND notes = ANY(${COMBO_NOTES})`;
    for (const cb of combos) {
      if (cb.tier === "PRICE_3") { bump("combo_del"); if (APPLY) await tx`UPDATE scm.sofa_combo_pricing SET deleted_at = ${now}, updated_at = ${now} WHERE id = ${cb.id}`; }
      else if (cb.tier === "PRICE_2") { bump("combo_p2to3"); if (APPLY) await tx`UPDATE scm.sofa_combo_pricing SET tier = 'PRICE_3', updated_at = ${now} WHERE id = ${cb.id}`; }
      else if (cb.tier === "PRICE_1") { bump("combo_p1to2"); if (APPLY) await tx`UPDATE scm.sofa_combo_pricing SET tier = 'PRICE_2', updated_at = ${now} WHERE id = ${cb.id}`; }
    }

    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: ${JSON.stringify(stats)}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });
