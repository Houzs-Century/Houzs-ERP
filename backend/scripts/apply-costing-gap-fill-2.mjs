// Costing gap-fill round 2 (owner 2026-08-09: fill every costing the
// workbook can support; Super King = Queen x 2).
//
// 92 rows, every one auditable:
//   - 37 exact-match sheet prices (full-name equality only — the fuzzy
//     matcher from the first pass was discarded per "确定的才做")
//   - 50 SK = 2 x Q (owner rule, validated against Hookka's own quotation:
//     HILTON 1170=585x2, JAGER 610=305x2, FENRIR 850=425x2)
//   - 5 VALKYRIE (A) rows: the quotation's "VALKRIE(A)" — a spelling
//     mismatch hid them; Hookka's prices overwrite (flagged rows only)
//
// Fill-empty-only unless the row carries overwrite:true. Audited.
// DRY-RUN default; APPLY=1 writes.
//
// RE-RUN: convergent. Writes the same base_price_sen from the same fixed list, but appends a master_price_history row each time - re-run only to correct a drifted price, and expect a duplicate audit entry.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set"); process.exit(1); }
const rows = JSON.parse(readFileSync(new URL("./data/costing-gap-fill-round2.json", import.meta.url), "utf8"));
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  let fill = 0, ow = 0, skipNonzero = 0, noProd = 0, noop = 0;
  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    for (const r of rows) {
      const [p] = await tx`SELECT id, base_price_sen FROM scm.mfg_products
                           WHERE company_id = ${co.id} AND code = ${r.erp}`;
      if (!p) { noProd++; console.log("  no product:", r.erp); continue; }
      const cur = p.base_price_sen || 0;
      if (cur === r.base_price_sen) { noop++; continue; }
      if (cur > 0 && !r.overwrite) { skipNonzero++; continue; }
      if (APPLY) {
        await tx`UPDATE scm.mfg_products SET base_price_sen = ${r.base_price_sen}, updated_at = ${now} WHERE id = ${p.id}`;
        await tx`INSERT INTO scm.master_price_history (product_code, field, old_value_sen, new_value_sen, reason, changed_at, company_id)
                 VALUES (${r.erp}, 'base_price_sen', ${cur || null}, ${r.base_price_sen}, ${"gap-fill-2: " + r.source}, ${now}, ${co.id})`;
      }
      if (cur > 0) ow++; else fill++;
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: filled ${fill}, overwrote ${ow}, skip-nonzero ${skipNonzero}, noop ${noop}, no-product ${noProd} of ${rows.length}`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });
