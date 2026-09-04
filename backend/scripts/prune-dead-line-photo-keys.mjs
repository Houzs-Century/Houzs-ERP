#!/usr/bin/env node
/* Take the broken photo tiles off the AutoCount-imported lines.
 *
 * WHAT THE OPERATOR SEES. A line shows two thumbnails of what should be one
 * photograph: one opens, the other is a broken tile. 53 rows on 50 documents
 * look like this (measured on prod 2026-09-03).
 *
 * WHAT IT IS. A line's photo_urls column holds ADDRESSES of objects in R2:
 *   <so|po>-items/<doc no>/<ERP row id>/ac-<AutoCount DtlKey>-<n>.jpg
 * The 2026-08-28 re-import replaced every ERP row id, so the addresses minted
 * in round 1 (2026-08-10) name row ids that no longer exist. That is harmless
 * by itself — the read routes authorise by MEMBERSHIP of photo_urls, never by
 * key shape (mfg-purchase-orders.ts, poItemPhotoSignedHandler) — and 686 of
 * those round-1 addresses still open their object. But
 * backfill-photo-urls-from-keys.mjs replayed the round-1 attach LOG
 * (data/r2-*-photo-keys-2026-08-10.txt), and 64 of the addresses in that log
 * name an object that was never uploaded. All 64 answer 404 {"code":10007}.
 *
 * WHAT THIS REMOVES, AND WHAT IT REFUSES TO. Only an address that is dead in
 * R2 AND whose OWN ROW still carries a working address for the SAME AutoCount
 * line — the same photograph, reachable, already on screen. Nothing here can
 * be the last copy of a picture. A dead address whose row would be left blank
 * is NOT touched: it is printed under WOULD GO BLANK and left for the owner,
 * because removing it turns a broken tile into no tile at all, and that is a
 * decision about what he wants to see, not a repair.
 *
 * THE R2 OBJECTS ARE NEVER TOUCHED. This writes one column and uploads,
 * deletes and moves nothing.
 *
 * MODE=plan (default) reads and prints; MODE=apply needs
 * CONFIRM="PRUNE DEAD PHOTO KEYS", writes one row at a time, and then verifies
 * on a FRESH connection that every surviving address on every row it touched
 * is a real object in R2.
 *
 * RE-RUN: inert. The addresses it removes are gone from the column, so a second
 * run finds nothing dead to prune and writes nothing.
 *
 *   DATABASE_URL    required
 *   R2_API_TOKEN    required — read, never printed
 *   R2_ACCOUNT_ID   default 816e457307d7fa0491c2a08a72ad5dcd
 *   R2_BUCKET       default houzs-erp
 *   COMPANY         default 1
 */
import postgres from 'postgres';
import { planDeadKeyPrune } from './lib/line-photo-keys.mjs';
import { listObjectKeys, verifyKeyAbsent } from './lib/r2-object-index.mjs';

const DSN = process.env.DATABASE_URL;
const TOKEN = process.env.R2_API_TOKEN;
const ACCOUNT = process.env.R2_ACCOUNT_ID || '816e457307d7fa0491c2a08a72ad5dcd';
const BUCKET = process.env.R2_BUCKET || 'houzs-erp';
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'PRUNE DEAD PHOTO KEYS';

const note = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
if (!TOKEN) { console.error('need R2_API_TOKEN — deadness is a fact about the bucket, not a list in this repo'); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}" — refusing.`);
  process.exit(2);
}

const ARMS = [
  {
    name: 'SALES ORDER',
    table: 'scm.mfg_sales_order_items',
    load: (sql, co) => sql`
      SELECT i.id::text AS id, i.doc_no AS doc, i.line_no AS "lineNo",
             i.linked_ac_dtlkey::text AS dtl, i.item_code AS "itemCode",
             COALESCE(i.photo_urls, '{}'::text[]) AS pics
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
       WHERE h.company_id = ${co} AND array_length(i.photo_urls, 1) > 0`,
  },
  {
    name: 'PURCHASE ORDER',
    table: 'scm.purchase_order_items',
    load: (sql, co) => sql`
      SELECT i.id::text AS id, p.po_number AS doc, i.id::text AS "lineNo",
             i.linked_ac_dtlkey::text AS dtl, i.item_code AS "itemCode",
             COALESCE(i.photo_urls, '{}'::text[]) AS pics
        FROM scm.purchase_order_items i
        JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
       WHERE p.company_id = ${co} AND array_length(i.photo_urls, 1) > 0`,
  },
];

/* The SHAPE the repair claims to leave behind: photo_urls is still a text[],
   and every importer-minted address left in it opens a real object. A row
   COUNT cannot see this — a repair that wrote the wrong array would report the
   same count (docs/jsonb-double-encoding-coe.md is the whole reason this rule
   exists). */
async function survivingShape(client, arm, ids, liveKeys) {
  if (!ids.length) return [];
  const rows = await client.unsafe(
    `SELECT id::text AS id, photo_urls AS pics FROM ${arm.table} WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const wrong = [];
  for (const r of rows) {
    if (!Array.isArray(r.pics)) {
      wrong.push({ id: r.id, why: `photo_urls is ${typeof r.pics}, not an array` });
      continue;
    }
    for (const k of r.pics) {
      if (/\/ac-\d+-\d+\.jpg$/.test(k) && !liveKeys.has(k)) {
        wrong.push({ id: r.id, why: `still lists a dead address ${k}` });
      }
    }
  }
  return wrong;
}

async function main() {
  note(`prune dead line-photo addresses — MODE=${APPLY ? 'apply' : 'plan'} company=${CO} bucket=${BUCKET}`);
  const liveKeys = await listObjectKeys({
    accountId: ACCOUNT, bucket: BUCKET, token: TOKEN, prefixes: ['so-items/', 'po-items/'],
  });
  note(`R2 holds ${liveKeys.size} object(s) under so-items/ + po-items/`);

  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const work = [];
  for (const arm of ARMS) {
    const rows = await arm.load(sql, CO);
    const { prune, wouldBlank } = planDeadKeyPrune(rows, liveKeys);
    const byRow = new Map(rows.map((r) => [r.id, r]));
    note('');
    note(`${arm.name}: ${rows.length} row(s) carry a photo`);
    note(`  dead addresses that are a STALE DUPLICATE — the row still shows that picture: ${prune.length}`);
    for (const p of prune) note(`     ${p.doc}  AC line ${p.dtl}  drop ${p.drop}`);
    note(`  dead addresses that are the row's ONLY one — LEFT ALONE, owner decides: ${wouldBlank.length}`);
    for (const w of wouldBlank) note(`     WOULD GO BLANK  ${w.doc}  AC line ${w.dtl}  ${w.dead}`);
    work.push({ arm, prune, byRow });
  }

  if (!APPLY) {
    const keys = work.reduce((s, w) => s + w.prune.length, 0);
    const rows = new Set(work.flatMap((w) => w.prune.map((p) => p.id))).size;
    note('');
    note(`PLAN ONLY — ${keys} address(es) would be removed from ${rows} row(s). Nothing was written.`);
    note(`Set MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
    await sql.end();
    return;
  }

  /* Ask the bucket directly about the first few addresses about to be dropped.
     The listing is one authority; a per-key 404 is a second one, and a delete
     licensed by a mis-read listing is the failure worth four requests. */
  const sample = work.flatMap((w) => w.prune).slice(0, 4);
  for (const s of sample) {
    const state = await verifyKeyAbsent({ accountId: ACCOUNT, bucket: BUCKET, token: TOKEN, key: s.drop });
    if (state !== 'absent') {
      bad(`REFUSING: ${s.drop} is ${state} in R2 — the listing and the object disagree`);
      await sql.end();
      process.exit(1);
    }
  }
  note(`spot-checked ${sample.length} address(es) against the bucket directly: absent`);

  const touched = [];
  for (const { arm, prune, byRow } of work) {
    const drops = new Map();
    for (const p of prune) {
      if (!drops.has(p.id)) drops.set(p.id, new Set());
      drops.get(p.id).add(p.drop);
    }
    for (const [id, dead] of drops) {
      const next = (byRow.get(id).pics ?? []).filter((k) => !dead.has(k));
      await sql.unsafe(`UPDATE ${arm.table} SET photo_urls = $1::text[] WHERE id = $2::uuid`, [next, id]);
      touched.push({ arm, id });
    }
    note(`${arm.name}: APPLIED — ${drops.size} row(s) updated, ${prune.length} address(es) removed`);
  }

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let wrong = 0;
  try {
    note('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    for (const arm of ARMS) {
      const ids = touched.filter((t) => t.arm === arm).map((t) => t.id);
      const problems = await survivingShape(check, arm, ids, liveKeys);
      for (const p of problems) { bad(`  ${arm.name} ${p.id}: ${p.why}`); wrong++; }
      note(`  ${arm.name}: ${ids.length} row(s) re-read; every remaining importer address opens a real object: ${problems.length === 0}`);
    }
  } finally {
    await check.end();
  }
  await sql.end();
  if (wrong) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
