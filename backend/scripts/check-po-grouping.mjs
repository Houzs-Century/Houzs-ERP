// Read-only ANALYSIS: how were historical POs grouped? Reverse-engineers the
// purchaser's real habit for MATTRESS and ACCESSORY (sofa/bedframe = known:
// per-SO) so the Production Agent can learn the actual rule instead of a guess.
// Manual trigger only (po-grouping-analysis.yml). Copies the check-soak-gate
// contract: read-only, SELECT-only, exit 0 for every answer, ::notice:: output.
//
// For every non-cancelled PO it computes, from the PO's mfg_product lines:
//   - distinct source SOs   (line.so_item_id -> mfg_sales_order_items.doc_no)
//   - distinct categories    (line.item_code -> mfg_products.category)
// then asks, per category, among POs that CONTAIN a line of that category:
//   - single-SO vs pooled-multi-SO   (is a PO raised per one SO, or pooled?)
//   - pure-category vs mixed          (does mattress/accessory ride its own PO?)
// and a co-occurrence cross-tab (what a mattress/accessory PO is mixed WITH).
//
// enums (po_status, material_kind, mfg_product_category) are cast ::text before
// any compare (learned the hard way — an enum can't coalesce with '').
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }
const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "-");
const CATS = ["SOFA", "BEDFRAME", "MATTRESS", "ACCESSORY", "OTHER"];

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  // 1. Non-cancelled PO headers.
  const pos = await pg`
    SELECT id, po_number, upper(coalesce(status::text, '')) AS status
    FROM scm.purchase_orders
    WHERE upper(coalesce(status::text, '')) <> 'CANCELLED'`;
  const poById = new Map(pos.map((p) => [p.id, { po_number: p.po_number, status: p.status, sos: new Set(), cats: new Set(), lines: 0 }]));

  // 2. mfg_product PO lines (skip fabric/raw — they are components, not the sellable grouping).
  const items = await pg`
    SELECT purchase_order_id, so_item_id, item_code
    FROM scm.purchase_order_items
    WHERE material_kind::text = 'mfg_product'`;

  // 3. category per item_code, 4. doc_no per so_item_id — batched.
  const codes = [...new Set(items.map((i) => i.item_code).filter(Boolean))];
  const soIds = [...new Set(items.map((i) => i.so_item_id).filter(Boolean))];
  const catRows = codes.length ? await pg`SELECT code, upper(coalesce(category::text, 'OTHER')) AS category FROM scm.mfg_products WHERE code = ANY(${codes})` : [];
  const catOfCode = new Map(catRows.map((r) => [r.code, CATS.includes(r.category) ? r.category : "OTHER"]));
  const soRows = soIds.length ? await pg`SELECT id, doc_no FROM scm.mfg_sales_order_items WHERE id = ANY(${soIds})` : [];
  const docOfSoItem = new Map(soRows.map((r) => [r.id, r.doc_no]));

  // 5. Fold lines into their PO.
  let soLinkedLines = 0;
  for (const it of items) {
    const po = poById.get(it.purchase_order_id);
    if (!po) continue;
    po.lines += 1;
    po.cats.add(catOfCode.get(it.item_code) ?? "OTHER");
    if (it.so_item_id) { soLinkedLines += 1; const d = docOfSoItem.get(it.so_item_id); if (d) po.sos.add(d); }
  }

  const allPos = [...poById.values()].filter((p) => p.lines > 0);
  const soLinked = allPos.filter((p) => p.sos.size > 0);
  const stockPos = allPos.filter((p) => p.sos.size === 0);

  notice(`=== PO GROUPING ANALYSIS (read-only) — how mattress/accessory POs are actually grouped ===`);
  notice(`Non-cancelled POs with mfg_product lines: ${allPos.length}  (SO-linked: ${soLinked.length}, stock/manual: ${stockPos.length})`);
  notice(`--- per category, among SO-LINKED POs that contain >=1 line of that category ---`);
  notice(`  category   | POs | single-SO | pooled(>1 SO) | pure-cat | mixed | avg SOs/PO | avg lines/PO`);
  for (const cat of CATS) {
    const set = soLinked.filter((p) => p.cats.has(cat));
    if (set.length === 0) { notice(`  ${cat.padEnd(10)} | 0`); continue; }
    const single = set.filter((p) => p.sos.size === 1).length;
    const pooled = set.filter((p) => p.sos.size > 1).length;
    const pure = set.filter((p) => p.cats.size === 1).length;
    const mixed = set.length - pure;
    const avgSos = (set.reduce((s, p) => s + p.sos.size, 0) / set.length).toFixed(1);
    const avgLines = (set.reduce((s, p) => s + p.lines, 0) / set.length).toFixed(1);
    notice(`  ${cat.padEnd(10)} | ${String(set.length).padStart(3)} | ${pct(single, set.length).padStart(8)} | ${pct(pooled, set.length).padStart(12)} | ${pct(pure, set.length).padStart(7)} | ${pct(mixed, set.length).padStart(5)} | ${avgSos.padStart(9)} | ${avgLines.padStart(11)}`);
  }

  notice(`--- co-occurrence: when a PO contains MATTRESS / ACCESSORY, what else is on it? ---`);
  for (const focus of ["MATTRESS", "ACCESSORY"]) {
    const set = allPos.filter((p) => p.cats.has(focus));
    if (set.length === 0) { notice(`  ${focus}: none`); continue; }
    const alone = set.filter((p) => p.cats.size === 1).length;
    const withOf = (o) => set.filter((p) => p.cats.has(o)).length;
    notice(`  ${focus} (on ${set.length} POs): alone=${alone}  +SOFA=${withOf("SOFA")}  +BEDFRAME=${withOf("BEDFRAME")}  +${focus === "MATTRESS" ? "ACCESSORY=" + withOf("ACCESSORY") : "MATTRESS=" + withOf("MATTRESS")}`);
  }

  notice(`INTERPRETATION: read the MATTRESS + ACCESSORY rows above. single-SO high -> per-SO like sofa/bedframe; pooled high -> the purchaser pools across SOs. pure-cat high -> its own PO; mixed high -> rides with other categories. This is the real grouping rule for the agent.`);
  notice(`=== END — read-only, no rows changed. ===`);
} finally {
  await pg.end({ timeout: 5 });
}
