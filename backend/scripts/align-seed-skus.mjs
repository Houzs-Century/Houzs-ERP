#!/usr/bin/env node
// Seeds the AutoCount->ERP Houzs Century alignment: creates missing suppliers,
// creates the new mfg_products codes, and creates supplier bindings (one internal
// code + one binding per supplier). Idempotent -- skips suppliers/codes/bindings
// that already exist, so re-runs are safe. MODE=dry-run (default) writes nothing
// and reports what WOULD happen; MODE=apply performs the inserts.
//
// Binding preserves the AutoCount cross-reference: supplier_sku = the AutoCount
// item code, item_code = our ERP code. Env: DATABASE_URL, MODE, DATA_FILE.
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const mode = (process.env.MODE || "dry-run").toLowerCase();
const dataFile = process.env.DATA_FILE || "scripts/data/align-seed-houzs-century.json";
const seed = JSON.parse(readFileSync(dataFile, "utf-8"));
const cid = String(seed.company_id);
const apply = mode === "apply";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

const norm = (s) => (s == null ? "" : String(s).trim());
const nkey = (s) => norm(s).toUpperCase().replace(/\s+/g, " ");

async function main() {
  console.log(`MODE=${mode} company_id=${cid} suppliers=${seed.suppliers.length} products=${seed.products.length} bindings=${seed.bindings.length}`);

  // ---- suppliers ----
  const supRows = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = ${cid}`;
  const supByCode = new Map(supRows.map((r) => [norm(r.code), r.id]));
  let supCreated = 0;
  for (const s of seed.suppliers) {
    if (supByCode.has(norm(s.code))) continue;
    if (apply) {
      const r = await sql`INSERT INTO scm.suppliers (code, name, company_id, status)
        VALUES (${s.code}, ${s.name}, ${cid}, 'ACTIVE') RETURNING id`;
      supByCode.set(norm(s.code), r[0].id);
    }
    supCreated++;
  }
  console.log(`suppliers: create ${supCreated}, existing ${seed.suppliers.length - supCreated}`);

  // ---- products (mfg_products) ----
  const prodRows = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${cid}`;
  const existingCode = new Set(prodRows.map((r) => nkey(r.code)));
  const nameByCode = new Map(prodRows.map((r) => [nkey(r.code), r.name]));
  const now = new Date().toISOString();
  let prodCreated = 0;
  const toInsert = seed.products.filter((p) => !existingCode.has(nkey(p.code)));
  for (const p of toInsert) nameByCode.set(nkey(p.code), p.name);
  if (apply) {
    const BATCH = 200;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const chunk = toInsert.slice(i, i + BATCH).map((p) => ({
        id: "mfg-" + randomBytes(6).toString("hex"),
        code: p.code, name: p.name, company_id: cid,
        category: p.category, status: p.status || "ACTIVE",
        branding: p.branding || null, created_at: now, updated_at: now,
      }));
      const r = await sql`INSERT INTO scm.mfg_products ${sql(chunk, "id", "code", "name", "company_id", "category", "status", "branding", "created_at", "updated_at")}`;
      prodCreated += r.count;
    }
  } else {
    prodCreated = toInsert.length;
  }
  const catCount = {};
  for (const p of toInsert) catCount[p.category] = (catCount[p.category] || 0) + 1;
  console.log(`products: create ${prodCreated}, skip-existing ${seed.products.length - toInsert.length}, by-cat ${JSON.stringify(catCount)}`);

  // ---- bindings ----
  const bindRows = await sql`SELECT item_code, supplier_id FROM scm.supplier_material_bindings WHERE company_id = ${cid}`;
  const existingBind = new Set(bindRows.map((b) => `${nkey(b.item_code)}||${b.supplier_id}`));
  let bindCreated = 0, bindSkip = 0, bindNoSup = 0;
  const missingSup = new Set();
  const bindBatch = [];
  for (const b of seed.bindings) {
    const sid = supByCode.get(norm(b.supplier_code));
    if (!sid) { bindNoSup++; missingSup.add(b.supplier_code); continue; }
    if (existingBind.has(`${nkey(b.item_code)}||${sid}`)) { bindSkip++; continue; }
    existingBind.add(`${nkey(b.item_code)}||${sid}`);
    bindBatch.push({
      supplier_id: sid, material_kind: "mfg_product",
      item_code: b.item_code,
      material_name: nameByCode.get(nkey(b.item_code)) || b.item_code,
      /* is_main comes from the data row now (2026-08-28: owner ruled Hookka is
         the MAIN supplier for the HOK/FLAT dual bindings). Absent = false,
         which is exactly what every earlier data file gets. */
      supplier_sku: b.supplier_sku, is_main_supplier: b.is_main === true,
      company_id: cid, created_at: now, updated_at: now,
    });
    bindCreated++;
  }
  if (apply && bindBatch.length) {
    const BATCH = 200;
    for (let i = 0; i < bindBatch.length; i += BATCH) {
      const chunk = bindBatch.slice(i, i + BATCH);
      await sql`INSERT INTO scm.supplier_material_bindings ${sql(chunk, "supplier_id", "material_kind", "item_code", "material_name", "supplier_sku", "is_main_supplier", "company_id", "created_at", "updated_at")}`;
    }
  }
  console.log(`bindings: create ${bindCreated}, skip-existing ${bindSkip}, no-supplier ${bindNoSup}${bindNoSup ? " (" + [...missingSup].join(",") + ")" : ""}`);
  console.log(apply ? "APPLIED." : "DRY-RUN: nothing written.");
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
