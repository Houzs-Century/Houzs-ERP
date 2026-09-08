#!/usr/bin/env node
// Copy `description` and `delivery_date` onto migrated company-1 purchase-order
// lines that hold NULL while the book states a value.
//
// WHERE THE NULLS CAME FROM. `apply-sofa-compartment-corrections.mjs` adds a
// compartment row by SELECTing from the piece it is built from, and its PO
// branch listed neither column (its SO branch has always set `description`).
// So every compartment that script ever added carries NULL in both while the
// book's line states a value, and the reconcile reads them as "blank in the ERP
// where the book states one". Fixed at the source in the same change; this
// repairs the rows already written.
//
// THE VALUE IS THE BOOK'S OWN, keyed on AutoCount's DtlKey — not inferred from
// a sibling row and never computed. A line whose key the book does not carry is
// counted and left alone. 空白不覆盖: a line the book states nothing for, and a
// line that already holds a value, are both left alone.
//
// This touches two descriptive columns. It writes no money, no quantity and no
// stock: migrated receipts and delivery notes stay `migrated_no_stock` with
// zero inventory movements, and nothing here can move a readiness bucket, which
// keys on (warehouse, item, variant).
//
// MODE: plan (default) prints every row it would change; APPLY=1 +
// CONFIRM="REPAIR PO LINE TEXT" writes. Convergent: a second run finds zero.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
if (APPLY && process.env.CONFIRM !== "REPAIR PO LINE TEXT") {
  console.error('APPLY=1 needs CONFIRM="REPAIR PO LINE TEXT" — refusing.');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const gz = (f) => {
  const rows = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
  if (!rows.length) { console.error(`${f} is EMPTY — refusing to report over nothing`); process.exit(2); }
  return rows;
};
const day = (v) => (v == null || String(v).trim() === "" ? null : String(v).slice(0, 10));
const txt = (v) => { const s = (v == null ? "" : String(v)).trim(); return s === "" ? null : s; };

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"}`);
  /* Both PO lanes, exactly as the reconcile reads them. 241 DtlKeys appear in
     both; the values are identical on every comparable field, so last-wins is
     the same answer as first-wins. */
  const book = new Map();
  for (const f of ["ac-outstanding-po.json.gz", "ac-so-linked-pos.json.gz"]) {
    for (const r of gz(f)) {
      if (r.DtlKey == null || String(r.DtlKey).trim() === "") continue;
      book.set(String(r.DtlKey).trim(), { desc: txt(r.Description), deliv: day(r.DeliveryDate) });
    }
  }
  log(`book lines keyed: ${book.size}`);

  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const rows = await sql`SELECT i.id, i.item_code, i.linked_ac_dtlkey, i.description,
      to_char(i.delivery_date, 'YYYY-MM-DD') AS deliv, p.po_number
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
    WHERE i.company_id = 1 AND p.linked_ac_docno IS NOT NULL
      AND (i.description IS NULL OR i.delivery_date IS NULL)`;
  log(`company-1 migrated PO lines holding a NULL in either column: ${rows.length}`);

  let noKey = 0, notInBook = 0, bookSilent = 0;
  const ups = [];
  for (const r of rows) {
    const k = r.linked_ac_dtlkey == null ? null : String(r.linked_ac_dtlkey).trim();
    if (!k) { noKey++; continue; }
    const b = book.get(k);
    if (!b) { notInBook++; continue; }
    const desc = txt(r.description) === null && b.desc !== null ? b.desc : null;
    const deliv = r.deliv === null && b.deliv !== null ? b.deliv : null;
    if (desc === null && deliv === null) { bookSilent++; continue; }
    ups.push({ id: r.id, po: r.po_number, code: r.item_code, desc, deliv });
  }
  log(`repairable: ${ups.length} — description ${ups.filter((u) => u.desc !== null).length}, ` +
      `delivery date ${ups.filter((u) => u.deliv !== null).length}`);
  log(`left alone: no AutoCount line key ${noKey}, key not in either PO export ${notInBook}, ` +
      `the book states nothing either (空白不覆盖) ${bookSilent}`);
  for (const u of ups.slice(0, 20)) {
    log(`   ${u.po} ${u.code}${u.desc !== null ? ` description -> ${JSON.stringify(u.desc)}` : ""}${u.deliv !== null ? ` delivery_date -> ${u.deliv}` : ""}`);
  }
  if (ups.length > 20) log(`   ... and ${ups.length - 20} more`);

  if (!APPLY) { log('PLAN ONLY — APPLY=1 CONFIRM="REPAIR PO LINE TEXT" writes.'); await sql.end(); return; }

  /* Sorted id, small batches, retry on the contention codes — the lock-order
     lesson from docs/bugs/0687, learned on this same class of sweep. */
  ups.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let wrote = 0, retried = 0;
  const failed = [];
  for (let i = 0; i < ups.length; i += 100) {
    const batch = ups.slice(i, i + 100);
    for (let attempt = 1; ; attempt++) {
      try {
        let n = 0;
        await sql.begin(async (tx) => {
          n = 0;
          for (const u of batch) {
            const r = await tx`UPDATE scm.purchase_order_items SET
                description   = COALESCE(description, ${u.desc}),
                delivery_date = COALESCE(delivery_date, ${u.deliv}::date)
              WHERE id = ${u.id} RETURNING id`;
            n += r.length;
          }
        });
        wrote += n;
        break;
      } catch (e) {
        if ((e?.code !== "40P01" && e?.code !== "57014") || attempt >= 4) { failed.push(`${i}:${e?.code ?? String(e)}`); break; }
        retried++;
        await new Promise((res) => setTimeout(res, 500 * attempt));
      }
    }
  }
  log(`rows written: ${wrote} of ${ups.length} intended${retried ? `; ${retried} retry(ies)` : ""}${failed.length ? `; BATCHES STILL FAILED: ${failed.join(", ")}` : ""}`);

  /* fresh-connection verify: re-read three of them on a new connection */
  const vsql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  let bad = 0;
  for (const u of ups.slice(0, 3)) {
    const [row] = await vsql`SELECT description, to_char(delivery_date, 'YYYY-MM-DD') AS deliv FROM scm.purchase_order_items WHERE id = ${u.id}`;
    if (!row) { bad++; continue; }
    if (u.desc !== null && txt(row.description) !== u.desc) bad++;
    else if (u.deliv !== null && row.deliv !== u.deliv) bad++;
  }
  await vsql.end();
  if (bad) { log(`VERIFY FAILED on ${bad} sample(s)`); await sql.end(); process.exit(1); }
  log(`VERIFY (fresh connection): ${Math.min(3, ups.length)} sample row(s) re-read equal to the book.`);
  await sql.end();
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
