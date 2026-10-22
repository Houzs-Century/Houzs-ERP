// Rename SKUs to the code and name their product family uses, and move them onto
// that family's Model. PLAN BY DEFAULT: nothing is written unless MODE=apply and
// CONFIRM repeats the phrase this run prints.
//
// The renames are not typed on the command line: TICKET names an entry in
// data/sku-renames-into-model.json, which carries them and who asked.
// DEV-41 (2026-10-06): AKEMI SOLITUDE MATT (SS/K) become HAPPI SLEEP SOLITUDE
// MATT (SS/K) on the HAPPI SLEEP SOLITUDE Model, beside the Q/S/SK/SP that
// BUG-38 merged there. The rules live once, in lib/sku-rename-into-model-plan.mjs.
//
// WHAT IT WRITES, per rename and in one transaction:
//   - every PRODUCT_CODE_CASCADE column (SO, PO, DO, GRN, PI and consignment
//     lines, amendments, stock ledger, lots, racks, supplier bindings, price
//     history) moved from the old code to the new one, as PATCH /mfg-products/:id;
//   - the SKU row's code, name and model_id.
// Then, in its own transaction, the old Model switched off (active = false) when
// none of its SKUs is ACTIVE any more.
// WHAT IT NEVER TOUCHES: prices, stock quantities, status, the description text
// already printed on documents; AutoCount - a raw SQL change queues no write-back
// (the AutoCount item keeps its code, data/autocount-erp-mapping-1561.csv maps it
// to the new ERP code).
//
// OUTPUT: counts and product codes only, because this repository's Actions logs
// are public: no document numbers, no money.
//
//   DATABASE_URL  required
//   TICKET        required, a key of data/sku-renames-into-model.json (e.g. DEV-41)
//   MODE          plan (default, writes nothing) | apply
//   CONFIRM       on apply, the phrase this run prints; it carries the counts it
//                 measured, so a phrase copied from an older run cannot fire
//   COMPANY_ID    default 1
//
// RE-RUN: convergent. After an apply the old codes are gone from the catalogue, so
// every rename plans as refused ("not in the catalogue") and nothing is written.
// Every UPDATE re-asserts the code it replaces, so a row changed in between fails
// the in-transaction check and rolls that rename back.
//
// UNDO: the new codes were unused before the apply (the plan refuses otherwise),
// so UPDATE scm.<table> SET <col> = '<old>' WHERE <col> = '<new>' AND company_id = N
// for each column listed, then the SKU row's code / name / model_id from the
// UNDO lines, and active = true on the old Model.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { PRODUCT_CODE_CASCADE } from "../src/scm/lib/product-code-rename.ts";
import { planSkuRenameIntoModel, confirmPhrase } from "./lib/sku-rename-into-model-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DST = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = process.env.CONFIRM ?? "";
const TICKET = (process.env.TICKET || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!["plan", "apply"].includes(MODE)) { console.error(`REFUSED: MODE must be plan or apply, got "${MODE}".`); process.exit(2); }
const BOOK = JSON.parse(fs.readFileSync(path.join(HERE, "data", "sku-renames-into-model.json"), "utf8"));
if (!BOOK[TICKET]) { console.error(`REFUSED: TICKET must be one of ${Object.keys(BOOK).join(", ")}, got "${TICKET}".`); process.exit(2); }
const ENTRY = BOOK[TICKET];

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const kindClause = (sql, c) => (c.kind ? sql`AND material_kind::text = 'mfg_product'` : sql``);
const sizesOf = (opts) => (Array.isArray(opts?.sizes) ? opts.sizes.map(String) : []);

async function readWorld(sql) {
  const codes = ENTRY.renames.flatMap((r) => [r.from, r.to]);
  const models = (await sql`
    SELECT id::text AS id, model_code, category::text AS category, active, allowed_options
      FROM scm.product_models
     WHERE company_id = ${CO} AND model_code = ANY(${[ENTRY.fromModel, ENTRY.toModel]})`)
    .map((m) => ({ ...m, sizes: sizesOf(m.allowed_options) }));
  const products = await sql`
    SELECT id::text AS id, code, name, status::text AS status, category::text AS category,
           model_id::text AS model_id, size_code
      FROM scm.mfg_products
     WHERE company_id = ${CO} AND (code = ANY(${codes}) OR model_id::text = ANY(${models.map((m) => m.id)}))`;

  const have = new Map();
  for (const r of await sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ANY(${[...new Set(PRODUCT_CODE_CASCADE.map((c) => c.table))]})`) {
    have.set(r.table_name, (have.get(r.table_name) ?? new Set()).add(r.column_name));
  }
  const refs = [];
  const missing = [];
  for (const c of PRODUCT_CODE_CASCADE) {
    const cols = have.get(c.table);
    if (!cols?.has(c.col) || !cols.has("company_id")) { missing.push(`${c.table}.${c.col}`); continue; }
    const rows = await sql`
      SELECT ${sql(c.col)} AS code, COUNT(*)::int AS n
        FROM ${sql(`scm.${c.table}`)}
       WHERE company_id = ${CO} AND ${sql(c.col)} = ANY(${codes}) ${kindClause(sql, c)}
       GROUP BY 1`;
    for (const r of rows) refs.push({ table: c.table, col: c.col, code: r.code, rows: r.n });
  }
  return { models, products, refs, missing };
}

async function main() {
  log(`mode=${MODE} ticket=${TICKET} company=${CO}; ${ENTRY.renames.length} rename(s), Model "${ENTRY.fromModel}" -> "${ENTRY.toModel}"`);
  log(`ruling: ${ENTRY.ruling}`);

  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const world = await readWorld(sql);
  for (const m of world.missing) log(`   cascade column ${m} is not on this database - skipped`);

  const plan = planSkuRenameIntoModel({ entry: ENTRY, models: world.models, products: world.products, refs: world.refs });

  log("");
  log("PER RENAME  (old code -> new code)");
  for (const r of plan.renames) {
    log(`  "${r.from}" -> "${r.to}"  size ${r.sizeCode ?? "-"}`);
    log(`     name: "${r.oldName ?? "-"}" -> "${r.name}"`);
    for (const x of r.rekey) log(`     re-key ${x.rows} row(s) in scm.${x.table}.${x.col}`);
    for (const x of r.refusals) log(`     REFUSED: ${x}`);
  }
  if (plan.retireFromModel) log(`  then switch Model "${ENTRY.fromModel}" off: no ACTIVE SKU is left on it`);
  else if (plan.leftActive.length) log(`  Model "${ENTRY.fromModel}" stays on: still ACTIVE on it ${plan.leftActive.join(", ")}`);

  const t = plan.totals;
  const phrase = confirmPhrase(t);
  log("");
  log(`TOTALS  renames ${t.renames}; refused ${t.refused}; re-key ${t.rowsToRekey} row(s); retire ${t.retireModel} Model`);
  log(`to apply: MODE=apply CONFIRM="${phrase}"`);

  if (!APPLY) {
    log("PLAN ONLY - nothing was written.");
    await sql.end();
    return;
  }
  if (CONFIRM !== phrase) {
    log(`REFUSED: apply needs CONFIRM="${phrase}" - measured by this run. Nothing was written.`);
    await sql.end();
    process.exit(2);
  }
  const work = plan.renames.filter((r) => r.refusals.length === 0);
  if (work.length === 0) {
    log("nothing to do - a re-run after a completed apply ends here.");
    await sql.end();
    return;
  }

  log("");
  log("UNDO  (before any write): the cascade columns go back by code (the new codes were unused), and the SKU rows with:");
  for (const r of work) {
    log(`   undo scm.mfg_products id ${r.productId}: code "${r.from}", name "${r.oldName}", model_id ${plan.fromModelId}`);
  }
  if (plan.retireFromModel) log(`   undo scm.product_models id ${plan.fromModelId}: active = true`);

  const committed = [];
  const problems = [];
  let rekeyed = 0;
  for (const r of work) {
    try {
      let n = 0;
      await sql.begin(async (tx) => {
        for (const x of r.rekey) {
          const c = PRODUCT_CODE_CASCADE.find((y) => y.table === x.table && y.col === x.col);
          const done = await tx`
            UPDATE ${tx(`scm.${x.table}`)} SET ${tx(x.col)} = ${r.to}
             WHERE company_id = ${CO} AND ${tx(x.col)} = ${r.from} ${kindClause(tx, c)}`;
          if (done.count !== x.rows) throw new Error(`scm.${x.table}.${x.col}: re-keyed ${done.count} of ${x.rows} - a row changed since the plan`);
          n += done.count;
        }
        const row = await tx`
          UPDATE scm.mfg_products
             SET code = ${r.to}, name = ${r.name}, model_id = ${plan.toModelId}, updated_at = now()
           WHERE company_id = ${CO} AND id::text = ${r.productId} AND code = ${r.from}
             AND model_id::text = ${plan.fromModelId} AND status = 'ACTIVE'
          RETURNING id`;
        if (row.length !== 1) throw new Error("the SKU row changed since the plan");
      });
      committed.push(r);
      rekeyed += n;
    } catch (e) {
      problems.push(`"${r.from}" ROLLED BACK, nothing of it was written: ${String(e?.message ?? e)}`);
    }
  }

  let retired = false;
  if (plan.retireFromModel && committed.length === work.length) {
    try {
      await sql.begin(async (tx) => {
        const [left] = await tx`
          SELECT COUNT(*)::int AS n FROM scm.mfg_products
           WHERE company_id = ${CO} AND model_id::text = ${plan.fromModelId} AND status = 'ACTIVE'`;
        if (left.n !== 0) throw new Error(`${left.n} ACTIVE SKU(s) are still on it`);
        const off = await tx`
          UPDATE scm.product_models SET active = false, updated_at = now()
           WHERE company_id = ${CO} AND id::text = ${plan.fromModelId} AND active = true
          RETURNING id`;
        if (off.length !== 1) throw new Error("it was not active any more");
      });
      retired = true;
    } catch (e) {
      problems.push(`Model "${ENTRY.fromModel}" not switched off: ${String(e?.message ?? e)}`);
    }
  }
  log(`WRITTEN: ${rekeyed} row(s) re-keyed, ${committed.length} of ${work.length} SKU(s) renamed and moved, ${retired ? 1 : 0} Model switched off`);
  await sql.end();

  /* ---- verification on a connection this run has not used, asserting what the
     rows now SAY, not how many were touched ----------------------------------- */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  for (const r of committed) {
    const [row] = await v`
      SELECT code, name, model_id::text AS model_id, status::text AS status
        FROM scm.mfg_products WHERE id::text = ${r.productId}`;
    if (row?.code !== r.to || row?.name !== r.name || row?.model_id !== plan.toModelId || row?.status !== "ACTIVE") {
      problems.push(`SKU ${r.productId} reads ${JSON.stringify(row ?? null)}, wanted code "${r.to}", name "${r.name}", model ${plan.toModelId}, ACTIVE`);
    }
    for (const x of r.rekey) {
      const c = PRODUCT_CODE_CASCADE.find((y) => y.table === x.table && y.col === x.col);
      const [old] = await v`SELECT COUNT(*)::int AS n FROM ${v(`scm.${x.table}`)} WHERE company_id = ${CO} AND ${v(x.col)} = ${r.from} ${kindClause(v, c)}`;
      const [now] = await v`SELECT COUNT(*)::int AS n FROM ${v(`scm.${x.table}`)} WHERE company_id = ${CO} AND ${v(x.col)} = ${r.to} ${kindClause(v, c)}`;
      if (old.n !== 0) problems.push(`scm.${x.table}.${x.col}: ${old.n} row(s) still carry "${r.from}"`);
      if (now.n !== x.rows) problems.push(`scm.${x.table}.${x.col}: ${now.n} row(s) carry "${r.to}", planned ${x.rows}`);
    }
    const [lines] = await v`SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND item_code = ${r.to}`;
    log(`   VERIFY "${r.to}": ${lines.n} sales-order line(s)`);
  }
  if (retired) {
    const [m] = await v`SELECT active FROM scm.product_models WHERE id::text = ${plan.fromModelId}`;
    if (m?.active !== false) problems.push(`Model "${ENTRY.fromModel}" reads active = ${m?.active}, wanted false`);
  }
  await v.end();

  if (problems.length > 0) {
    for (const x of problems) log(`   VERIFY FAILED: ${x}`);
    log("FAILED. The UNDO lines above cover every write that landed.");
    process.exit(1);
  }
  log("VERIFIED on a fresh connection: every renamed SKU carries its new code, name and Model, and no cascade row is left on an old code.");
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://<redacted>"));
  process.exit(1);
});
