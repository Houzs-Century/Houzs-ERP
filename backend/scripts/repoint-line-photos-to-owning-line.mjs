#!/usr/bin/env node
/* Put each AutoCount photograph back on the line it belongs to — without
 * uploading anything.
 *
 * WHAT THE OPERATOR SEES. A document lists the same product twice. The first
 * line shows two photographs; the second line shows none. Both pictures are
 * really in the system — they are just both hanging on the first line.
 *
 * THE ROOT CAUSE, traced in import-so-line-photos.mjs /
 * import-po-line-photos.mjs. Those scripts find the ERP row for a photograph
 * by ITEM CODE and take the FIRST match:
 *      const cands = byDocCode.get(`${m.DocNo}|${norm(erp)}`);   ...  cands[0]
 * The book identifies a photograph by its LINE (DtlKey), not by its item code.
 * So when one document carries the same code — or, for sofa, the same model —
 * on two lines, every photograph for that code lands on the first row and the
 * later rows get nothing. Measured on prod 2026-09-03: 34 AutoCount lines on
 * 30 documents, 25 of which show nothing at all and 9 of which show only a
 * broken tile left behind by the round-1 backfill.
 *
 * WHY THIS NEEDS NO UPLOAD. The photograph is already in R2 — under the FIRST
 * row's path. The read routes authorise by MEMBERSHIP of photo_urls, never by
 * key shape ("AUTHZ is MEMBERSHIP, never key shape" —
 * mfg-purchase-orders.ts, poItemPhotoSignedHandler), so listing that same
 * address on the line that owns the AutoCount key makes the tile render. This
 * is the same move backfill-photo-urls-from-keys.mjs already makes with the
 * round-1 keys, and 686 addresses in production are served that way today.
 *
 * WHAT IT LEAVES ALONE. A sofa build is ONE AutoCount line held as several ERP
 * compartment rows, and the owner's rule is one photo on the first piece
 * (2026-08-10: 「每个 SKU 的照片都一样,留第一个就可以了」). A line is skipped the
 * moment ANY of its rows already shows a live picture of it, so the blank
 * compartments stay blank — attaching there is exactly what
 * prune-duplicate-sofa-photos.mjs exists to undo.
 *
 * THE R2 OBJECTS ARE NEVER TOUCHED. This appends to one column and uploads,
 * deletes and moves nothing.
 *
 * MODE=plan (default) reads and prints; MODE=apply needs
 * CONFIRM="REPOINT LINE PHOTOS" and then verifies on a FRESH connection that
 * every line it touched now lists a live address FOR ITS OWN AutoCount key.
 *
 * RE-RUN: inert. A line that now shows a live picture of itself is skipped, and
 * an address already present is filtered out, so a second run writes nothing.
 *
 *   DATABASE_URL    required
 *   R2_API_TOKEN    required — read, never printed
 *   R2_ACCOUNT_ID   default 816e457307d7fa0491c2a08a72ad5dcd
 *   R2_BUCKET       default houzs-erp
 *   COMPANY         default 1
 */
import postgres from 'postgres';
import { acDtlKeyOf, planRepoint } from './lib/line-photo-keys.mjs';
import { listObjectKeys } from './lib/r2-object-index.mjs';

const DSN = process.env.DATABASE_URL;
const TOKEN = process.env.R2_API_TOKEN;
const ACCOUNT = process.env.R2_ACCOUNT_ID || '816e457307d7fa0491c2a08a72ad5dcd';
const BUCKET = process.env.R2_BUCKET || 'houzs-erp';
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'REPOINT LINE PHOTOS';

const note = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
if (!TOKEN) { console.error('need R2_API_TOKEN — "the picture exists" is a fact about the bucket'); process.exit(2); }
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
       WHERE h.company_id = ${co} AND h.linked_ac_docno IS NOT NULL`,
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
       WHERE p.company_id = ${co} AND p.linked_ac_docno IS NOT NULL`,
  },
];

/* The SHAPE this repair claims: the row is still a text[], and it now lists at
   least one LIVE address whose embedded DtlKey is the row's OWN AutoCount key.
   Counting updated rows would report success for an array that appended the
   wrong address, or a string, or nothing at all. */
async function repointedShape(client, arm, plan, liveKeys) {
  if (!plan.length) return [];
  const rows = await client.unsafe(
    `SELECT id::text AS id, linked_ac_dtlkey::text AS dtl, photo_urls AS pics
       FROM ${arm.table} WHERE id = ANY($1::uuid[])`,
    [plan.map((p) => p.id)],
  );
  const wrong = [];
  for (const r of rows) {
    if (!Array.isArray(r.pics)) {
      wrong.push({ id: r.id, why: `photo_urls is ${typeof r.pics}, not an array` });
      continue;
    }
    const own = r.pics.filter((k) => liveKeys.has(k) && acDtlKeyOf(k) === r.dtl);
    if (!own.length) wrong.push({ id: r.id, why: `still lists no live address for its own AC line ${r.dtl}` });
  }
  if (rows.length !== plan.length) wrong.push({ id: '(set)', why: `re-read ${rows.length} row(s), expected ${plan.length}` });
  return wrong;
}

async function main() {
  note(`re-point line photos onto the line that owns them — MODE=${APPLY ? 'apply' : 'plan'} company=${CO} bucket=${BUCKET}`);
  const liveKeys = await listObjectKeys({
    accountId: ACCOUNT, bucket: BUCKET, token: TOKEN, prefixes: ['so-items/', 'po-items/'],
  });
  note(`R2 holds ${liveKeys.size} object(s) under so-items/ + po-items/`);

  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const work = [];
  for (const arm of ARMS) {
    const rows = await arm.load(sql, CO);
    const plan = planRepoint(rows, liveKeys);
    note('');
    note(`${arm.name}: ${rows.length} AutoCount-linked line(s) read`);
    note(`  AutoCount lines whose picture is in R2 but hangs on another row of the same document: ${plan.length}`);
    for (const p of plan) note(`     ${p.doc}  AC line ${p.dtl}  ${p.code}  <- ${p.keys.join(' , ')}`);
    work.push({ arm, plan });
  }

  if (!APPLY) {
    const lines = work.reduce((s, w) => s + w.plan.length, 0);
    const keys = work.reduce((s, w) => s + w.plan.reduce((t, p) => t + p.keys.length, 0), 0);
    note('');
    note(`PLAN ONLY — ${lines} line(s) would gain ${keys} address(es). No object is uploaded, nothing was written.`);
    note(`Set MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write.`);
    await sql.end();
    return;
  }

  for (const { arm, plan } of work) {
    for (const p of plan) {
      await sql.unsafe(
        `UPDATE ${arm.table}
            SET photo_urls = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(photo_urls, '{}'::text[]) || $1::text[])))
          WHERE id = $2::uuid`,
        [p.keys, p.id],
      );
    }
    note(`${arm.name}: APPLIED — ${plan.length} line(s) updated`);
  }

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let wrong = 0;
  try {
    note('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');
    for (const { arm, plan } of work) {
      const problems = await repointedShape(check, arm, plan, liveKeys);
      for (const p of problems) { bad(`  ${arm.name} ${p.id}: ${p.why}`); wrong++; }
      note(`  ${arm.name}: ${plan.length} line(s) re-read; each now lists a live address for its own AutoCount line: ${problems.length === 0}`);
    }
  } finally {
    await check.end();
  }
  await sql.end();
  if (wrong) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
