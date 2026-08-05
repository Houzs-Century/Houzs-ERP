#!/usr/bin/env node
// Cleans up + completes the catalogue category list (scm.categories) for one
// company: fixes sort_order, clears the `tbc` placeholder flag on categories we
// now use, and inserts the missing rows (bedlines/diffuser/carpet). Idempotent.
// MODE=dry-run (default) prints the before/after and writes nothing; MODE=apply
// performs the UPDATE/INSERT. Env: DATABASE_URL, MODE, COMPANY_ID (default 1).
import postgres from "postgres";

const mode = (process.env.MODE || "dry-run").toLowerCase();
const cid = String(process.env.COMPANY_ID || "1");
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

// Desired final state (company-scoped). label/icon/sort/tbc.
const DESIRED = [
  { id: "mattress",  label: "Mattresses",  icon: "bed-double", sort_order: 1, tbc: false },
  { id: "bedframe",  label: "Bed frames",  icon: "bed",        sort_order: 2, tbc: false },
  { id: "sofa",      label: "Sofas",       icon: "sofa",       sort_order: 3, tbc: false },
  { id: "accessory", label: "Accessories", icon: "lamp",       sort_order: 4, tbc: false },
  { id: "dining",    label: "Dining",      icon: "utensils",   sort_order: 5, tbc: false },
  { id: "bedlines",  label: "Bedlines",    icon: "layers",     sort_order: 6, tbc: false },
  { id: "diffuser",  label: "Diffuser",    icon: "wind",       sort_order: 7, tbc: false },
  { id: "carpet",    label: "Carpet",      icon: "square",     sort_order: 8, tbc: false },
];

async function main() {
  console.log(`MODE=${mode} company_id=${cid}`);
  const before = await sql`SELECT id, label, icon, tbc, sort_order FROM scm.categories WHERE company_id = ${cid} ORDER BY sort_order, id`;
  console.log("BEFORE:", JSON.stringify(before));
  const have = new Map(before.map((r) => [r.id, r]));

  const updates = [];
  const inserts = [];
  for (const d of DESIRED) {
    const cur = have.get(d.id);
    if (!cur) inserts.push(d);
    else if (cur.label !== d.label || cur.icon !== d.icon || Number(cur.sort_order) !== d.sort_order || cur.tbc !== d.tbc) {
      updates.push(d);
    }
  }
  console.log(`PLAN: update ${updates.length} (${updates.map((u) => u.id).join(",")}), insert ${inserts.length} (${inserts.map((i) => i.id).join(",")})`);

  if (mode !== "apply") { console.log("DRY-RUN: nothing written."); return; }

  for (const u of updates) {
    await sql`UPDATE scm.categories SET label=${u.label}, icon=${u.icon}, sort_order=${u.sort_order}, tbc=${u.tbc}
              WHERE company_id=${cid} AND id=${u.id}`;
  }
  for (const i of inserts) {
    await sql`INSERT INTO scm.categories (company_id, id, label, icon, tbc, sort_order)
              VALUES (${cid}, ${i.id}, ${i.label}, ${i.icon}, ${i.tbc}, ${i.sort_order})
              ON CONFLICT (company_id, id) DO NOTHING`;
  }
  const after = await sql`SELECT id, label, icon, tbc, sort_order FROM scm.categories WHERE company_id = ${cid} ORDER BY sort_order, id`;
  console.log(`APPLIED: ${updates.length} updated, ${inserts.length} inserted.`);
  console.log("AFTER:", JSON.stringify(after));
}

main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
