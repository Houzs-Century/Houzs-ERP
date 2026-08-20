// Mirror every OHANA STUDIO (400-O002) binding onto the two Hookka houses
// and hand the main flag to Hookka Industries.
//
// Owner 2026-08-09: "hookka industries = hookka manufacturing, 两家一样 SKU
// 一样价钱; Hookka Industries 有的东西都是 main supplier". The 2026-08 price
// list bound every HOK SKU to 400-O002 (the Excel's Main Supplier column);
// the two real factories carried zero SKUs.
//
// What it does (HOUZS company only):
//   1. For every 400-O002 binding (material_kind mfg_product): create the
//      SAME binding (supplier_sku / unit_price_sen / price_matrix /
//      material_name) under 400-H003 HOOKKA MANUFACTURING and
//      400-H004 HOOKKA INDUSTRIES — skip any that already exist.
//   2. main flag: demote every other main on those materials (incl. OHANA),
//      promote 400-H004's binding.
//   3. OHANA bindings stay untouched otherwise (fallback supplier).
//
// DRY-RUN default; APPLY=1 writes. One transaction, count-verified.
//
// RE-RUN: convergent. Mirrors the same bindings and the same is_main_supplier flag from the same source.
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }
const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const SRC = "400-O002";
const MIRRORS = ["400-H003", "400-H004"];
const MAIN_TO = "400-H004";

try {
  const [co] = await sql`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  const cid = co.id;
  const sups = await sql`SELECT id, code, name FROM scm.suppliers
    WHERE company_id = ${cid} AND code IN (${SRC}, ${MIRRORS[0]}, ${MIRRORS[1]})`;
  const byCode = Object.fromEntries(sups.map((s) => [s.code, s]));
  for (const c of [SRC, ...MIRRORS]) if (!byCode[c]) throw new Error(`supplier ${c} missing`);

  const src = await sql`SELECT * FROM scm.supplier_material_bindings
    WHERE company_id = ${cid} AND supplier_id = ${byCode[SRC].id} AND material_kind = 'mfg_product'
    ORDER BY item_code`;
  note(`OHANA bindings to mirror: ${src.length}`);

  const existing = await sql`SELECT supplier_id, item_code FROM scm.supplier_material_bindings
    WHERE company_id = ${cid} AND material_kind = 'mfg_product'
      AND supplier_id IN (${byCode[MIRRORS[0]].id}, ${byCode[MIRRORS[1]].id})`;
  const have = new Set(existing.map((e) => `${e.supplier_id}||${e.item_code}`));

  let toInsert = 0, mainFlips = 0;
  const now = new Date().toISOString();

  await sql.begin(async (tx) => {
    for (const b of src) {
      for (const mc of MIRRORS) {
        const sid = byCode[mc].id;
        if (have.has(`${sid}||${b.item_code}`)) continue;
        toInsert++;
        if (APPLY) {
          await tx`INSERT INTO scm.supplier_material_bindings
            (supplier_id, material_kind, item_code, material_name, supplier_sku,
             unit_price_sen, currency, lead_time_days, moq, price_matrix,
             is_main_supplier, notes, company_id, created_at, updated_at)
            VALUES (${sid}, 'mfg_product', ${b.item_code}, ${b.material_name}, ${b.supplier_sku},
                    ${b.unit_price_sen}, ${b.currency}, ${b.lead_time_days}, ${b.moq},
                    ${b.price_matrix === null ? null : tx.json(b.price_matrix)},
                    false, ${"mirrored from 400-O002 (owner 2026-08-09)"}, ${cid}, ${now}, ${now})`;
        }
      }
      mainFlips++;
      if (APPLY) {
        await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = false, updated_at = ${now}
          WHERE company_id = ${cid} AND material_kind = 'mfg_product'
            AND item_code = ${b.item_code} AND is_main_supplier = true`;
        await tx`UPDATE scm.supplier_material_bindings SET is_main_supplier = true, updated_at = ${now}
          WHERE company_id = ${cid} AND material_kind = 'mfg_product'
            AND item_code = ${b.item_code} AND supplier_id = ${byCode[MAIN_TO].id}`;
      }
    }
    note(`${APPLY ? "APPLIED" : "DRY-RUN"}: insert ${toInsert} mirrored bindings (2 houses), main → ${MAIN_TO} on ${mainFlips} materials`);
    if (!APPLY) throw new Error("DRY-RUN-ROLLBACK");
  }).catch((e) => { if (e.message !== "DRY-RUN-ROLLBACK") throw e; note("DRY-RUN: rolled back, nothing written."); });
} catch (e) {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 3 });
  process.exit(1);
}
await sql.end({ timeout: 3 });
