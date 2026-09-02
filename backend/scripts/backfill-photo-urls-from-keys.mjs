#!/usr/bin/env node
// Re-attach the round-1 line photos to the re-imported orders WITHOUT touching
// R2 at all.
//
// WHY THIS SHAPE. The 744 extracted JPEGs exist only in R2 (verified uploaded
// one-by-one on 2026-08-10; the local copies and the RTF extractor were never
// kept), and the import-*-line-photos scripts MINT keys embedding the current
// ERP item id — ids the wipe replaced, so their minted keys point at objects
// that do not exist. But the signed-URL route serves ANY key listed in
// photo_urls, and the OLD keys still name their objects. So: recover the old
// keys from the round-1 attach-run logs (data/r2-*-photo-keys-2026-08-10.txt,
// newest-run-wins; the doubtful earlier-run keys are quarantined in
// *-doubtful.txt until an R2-read auth can verify them), parse each key's own
// (doc_no, AC DtlKey), and append the key VERBATIM to the matching line's
// photo_urls. The line is found by doc_no + linked_ac_dtlkey — populated
// to 13,417 lines by tonight's backfill. Sofa: one AC line decomposes into
// several piece lines sharing the DtlKey; the photo goes on the FIRST piece
// (lowest line_no), exactly where round 1 put it.
//
// MODE: plan (default) prints every attach and every miss with the reason;
// APPLY=1 + CONFIRM="ATTACH PHOTO KEYS" writes.
// RE-RUN: inert — a key already present in the line's photo_urls is skipped,
// and the UPDATE re-asserts absence via array_position IS NULL.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
if (APPLY && process.env.CONFIRM !== "ATTACH PHOTO KEYS") {
  console.error('APPLY=1 needs CONFIRM="ATTACH PHOTO KEYS" — refusing.');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const readKeys = (f) => fs.readFileSync(path.join(here, "data", f), "utf8")
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

async function attach(kind, file, table, docCol, joinSql) {
  const keys = readKeys(file);
  const pat = new RegExp(`^${kind}-items/([^/]+)/[^/]+/ac-(\\d+)-\\d+\\.jpg$`);
  const rows = await joinSql();
  // (doc_no | dtlkey) -> first line by line-order carrying that AC line
  const byId = new Map();
  for (const r of rows) {
    const k = `${r.doc}|${r.dtlkey}`;
    if (!byId.has(k)) byId.set(k, r);
  }
  const plan = [], misses = [];
  for (const key of keys) {
    const m = key.match(pat);
    if (!m) { misses.push({ key, why: "unparseable key" }); continue; }
    const row = byId.get(`${m[1]}|${m[2]}`);
    if (!row) { misses.push({ key, why: "no line with that doc_no + linked_ac_dtlkey" }); continue; }
    if ((row.photo_urls ?? []).includes(key)) continue; // already attached — inert
    plan.push({ id: row.id, key, doc: row.doc });
  }
  log(`${kind.toUpperCase()}: keys ${keys.length}; to attach ${plan.length}; already attached ${keys.length - plan.length - misses.length}; misses ${misses.length}`);
  for (const s of misses.slice(0, 10)) log(`   MISS ${s.key} — ${s.why}`);
  if (misses.length > 10) log(`   ... and ${misses.length - 10} more misses`);

  if (!APPLY) return { plan, misses, wrote: 0 };
  let wrote = 0;
  for (let i = 0; i < plan.length; i += 200) {
    const b = plan.slice(i, i + 200);
    await sql.begin(async (tx) => {
      for (const u of b) {
        const r = await tx.unsafe(
          `UPDATE scm.${table} SET photo_urls = photo_urls || $1::text[]
            WHERE id = $2 AND array_position(photo_urls, $3) IS NULL RETURNING id`,
          [[u.key], u.id, u.key],
        );
        wrote += r.length;
      }
    });
  }
  log(`${kind.toUpperCase()}: attached ${wrote} of ${plan.length} intended`);
  return { plan, misses, wrote };
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"}`);
  const so = await attach("so", "r2-so-photo-keys-2026-08-10.txt", "mfg_sales_order_items", "doc_no", async () =>
    sql`SELECT i.id, i.doc_no AS doc, i.linked_ac_dtlkey::text AS dtlkey, i.photo_urls
        FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
        WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL AND i.linked_ac_dtlkey IS NOT NULL
        ORDER BY i.doc_no, i.line_no NULLS LAST, i.id`);
  const po = await attach("po", "r2-po-photo-keys-2026-08-10.txt", "purchase_order_items", "po_number", async () =>
    sql`SELECT i.id, p.po_number AS doc, i.linked_ac_dtlkey::text AS dtlkey, i.photo_urls
        FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
        WHERE p.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL
        ORDER BY p.po_number, i.id`);

  if (APPLY) {
    /* fresh-connection SHAPE verify: sample re-read must CONTAIN the key */
    const vsql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
    let bad = 0;
    for (const s of [...so.plan.slice(0, 2), ...po.plan.slice(0, 2)]) {
      const table = s.key.startsWith("so-") ? "mfg_sales_order_items" : "purchase_order_items";
      const [row] = await vsql.unsafe(`SELECT photo_urls FROM scm.${table} WHERE id = $1`, [s.id]);
      if (!row || !(row.photo_urls ?? []).includes(s.key)) { bad++; log(`   VERIFY MISMATCH ${s.doc}: ${s.key} not present after write`); }
    }
    if (bad) { log(`VERIFY FAILED on ${bad} sample(s)`); await vsql.end(); await sql.end(); process.exit(1); }
    log(`VERIFY (fresh connection): ${Math.min(2, so.plan.length) + Math.min(2, po.plan.length)} sample line(s) re-read carry their key.`);
    await vsql.end();
  } else {
    log('PLAN ONLY — APPLY=1 CONFIRM="ATTACH PHOTO KEYS" writes.');
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
