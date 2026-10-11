#!/usr/bin/env node
// The sofa compartment POOL: drop the sideless bench codes, keep DB, and prove
// nothing was using them.
//
// Owner 2026-08-10: "1B 都是要 direction 的啊,扶手在哪里" — a bench is always
// 1B(LHF) or 1B(RHF); a bare "1B" is a leftover from before that ruling and
// must not be pickable. "把 DB 的 code 换去 DB,把 1B 的 code clear 掉."
//
// WHY THIS IS A SCRIPT AND NOT A UI CLICK. Deleting a pool row in the
// maintenance page while ALSO adding one in the same save makes the UI's
// POSITIONAL rename detector (Products.tsx) read the pair as a rename and offer
// to cascade "1B -> DB" across SKU codes, sales orders INCLUDING HISTORY,
// delivery orders, invoices, GRN/PO lines, Modular ticks, combos and quick
// picks — with no dry run. The owner was one click away from it. This script
// does the removal ALONE, so no phantom rename can be inferred.
//
// Append-only, like every other pool change: it writes a NEW
// maintenance_config_history row rather than editing the current one, so the
// old pool stays readable.
//
// SAFETY: refuses to drop a code that any mfg_products SKU, sales-order line or
// purchase-order line actually uses. DRY-RUN by default; APPLY=1 writes.
//
// RE-RUN: convergent, but APPENDS. The pool is written to the same value; the maintenance_config_history row is added again on every run.
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CO = Number(process.env.COMPANY || 1);
const DROP = (process.env.DROP || "1B,2B").split(",").map((s) => s.trim()).filter(Boolean);
const KEEP = (process.env.KEEP || "DB").split(",").map((s) => s.trim()).filter(Boolean);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const val = (v) => (v && typeof v === "object" ? v.value : v);
const norm = (s) => String(s ?? "").trim().toUpperCase();

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO} drop=[${DROP.join(", ")}] keep=[${KEEP.join(", ")}]`);

  const [cfg] = await sql`SELECT id, config, effective_from FROM scm.maintenance_config_history
    WHERE company_id = ${CO} AND scope = 'master' AND effective_from <= CURRENT_DATE
    ORDER BY effective_from DESC, created_at DESC LIMIT 1`;
  if (!cfg) { log("no master maintenance_config_history row — nothing to do"); await sql.end(); return; }

  const cur = cfg.config?.sofaCompartments ?? [];
  log(`current pool (${cur.length}): ${cur.map(val).join(", ")}`);

  const dropSet = new Set(DROP.map(norm));
  const present = cur.filter((e) => dropSet.has(norm(val(e))));
  if (!present.length) log(`none of [${DROP.join(", ")}] is in the pool — nothing to drop`);

  /* A pool value is the OUTPUT vocabulary: what a compartment SKU's code suffix
     may be. So "in use" means a real SKU or a real document line carries
     {model}-{code}. Anything with a side ("1B(LHF)") is a DIFFERENT value and
     must not be counted — hence the exact suffix match. */
  const used = new Map();
  for (const code of DROP) {
    const suffix = `-${code}`;
    const [{ n: nSku }] = await sql`SELECT COUNT(*)::int n FROM scm.mfg_products
      WHERE company_id = ${CO} AND upper(code) LIKE ${"%" + suffix.toUpperCase()}`;
    const [{ n: nSo }] = await sql`SELECT COUNT(*)::int n FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = ${CO} AND upper(i.item_code) LIKE ${"%" + suffix.toUpperCase()}`;
    const [{ n: nPo }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
      WHERE p.company_id = ${CO} AND upper(i.material_code) LIKE ${"%" + suffix.toUpperCase()}`;
    const [{ n: nMod }] = await sql`SELECT COUNT(*)::int n FROM scm.product_models
      WHERE company_id = ${CO} AND allowed_options::text ILIKE ${'%"' + code + '"%'}`;
    used.set(code, { nSku, nSo, nPo, nMod });
    log(`  ${code}: SKUs ${nSku} | SO lines ${nSo} | PO lines ${nPo} | models listing it ${nMod}`);
  }

  const blocked = DROP.filter((c) => {
    const u = used.get(c);
    return u.nSku > 0 || u.nSo > 0 || u.nPo > 0;
  });
  if (blocked.length) {
    log(`REFUSING to drop ${blocked.join(", ")} — still used by a SKU or a document line.`);
    log("Remap those rows first; a pool value that a live line uses makes the line fail allowed-options-check.");
    await sql.end();
    return;
  }

  const nextPool = cur.filter((e) => !dropSet.has(norm(val(e))));
  for (const k of KEEP) {
    if (!nextPool.some((e) => norm(val(e)) === norm(k))) {
      nextPool.push(k);
      log(`  ${k} was missing from the pool — appending it`);
    }
  }
  const seen = new Set(); const deduped = [];
  for (const e of nextPool) {
    const k = norm(val(e));
    if (seen.has(k)) { log(`  dropping duplicate pool entry ${val(e)}`); continue; }
    seen.add(k); deduped.push(e);
  }

  log("");
  log(`pool ${cur.length} -> ${deduped.length}`);
  log(`removed: ${cur.map(val).filter((v) => !deduped.map(val).some((x) => norm(x) === norm(v))).join(", ") || "(none)"}`);
  log(`next pool: ${deduped.map(val).join(", ")}`);

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write the new config row."); await sql.end(); return; }

  const nextCfg = { ...cfg.config, sofaCompartments: deduped };
  await sql`INSERT INTO scm.maintenance_config_history (id, scope, config, effective_from, notes, created_at, company_id)
    VALUES (${"mch-" + randomBytes(6).toString("hex")}, 'master', ${sql.json(nextCfg)}, CURRENT_DATE,
            ${"drop sideless bench codes " + DROP.join("/") + "; keep " + KEEP.join("/") + " (owner 2026-08-10: 1B 都是要 direction 的)"},
            now(), ${CO})`;
  log("APPLIED — new master config row written (append-only; the old pool is still readable).");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
