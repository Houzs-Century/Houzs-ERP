#!/usr/bin/env node
/* backfill-document-line-photos — put the sales order's photograph back on the
 * purchase and delivery order lines that show none.
 *
 * WHAT STAFF SEE. A purchase order is printed for the supplier and the sofa
 * sketch is not on it, while the same sketch is on the sales order the PO was
 * raised from. Reported by Sim, 2026-09-11: "PO export PDF dont have photo
 * attach".
 *
 * ROOT CAUSE, PROVEN against production 2026-09-11 (read-only DSN, no writes).
 * NOT the convert. A PO/DO line copies its source SO line's photo keys at
 * convert time (migs 0274, 20260828T0746) and that path is intact:
 *
 *     ERP-raised PO lines missing a key their source SO line holds: 0
 *
 * Every line that IS missing one sits on an AutoCount-IMPORTED document, where
 * no convert ever ran. The importer attached whatever the BOOK had on that
 * document, and AutoCount frequently held the photograph on the SALES order
 * only - so the imported purchase order got nothing.
 *
 *     PO: 117 lines on 83 purchase orders carry no photo while their SO line does
 *     DO:  68 lines on 46 delivery orders, the same shape
 *     every one of the 187 keys involved is a LIVE object in R2 (listed
 *     `so-items/` via the R2 API, 0 dead) - so every photograph this puts on a
 *     document actually opens
 *
 * NOTE what this does NOT fix, because it is a different question. A purchase
 * order raised TODAY still prints without a photograph when the SALES ORDER
 * line has none, and that is almost every new order: of 872 SO lines on
 * ERP-raised sales orders only 8 carry a photograph, and of the 359 lines added
 * since 2026-09-01 only 5 do. The upload path works (15 human uploads exist,
 * the newest 2026-09-10) - it is simply not being used. Nothing in a script can
 * supply a picture nobody took.
 *
 * TWO SHAPES, ONE OF WHICH IS NOT A DEFECT - see lib/document-photo-carry.mjs.
 * FILL (the document line carries nothing) is repaired. MIRROR (the line
 * already carries the book's own PO attachment while the SO holds a different
 * one - 193 PO lines) is HELD BACK and printed, because adding a second sketch
 * to an already-received purchase order is a printing decision, not a repair.
 * INCLUDE_MIRROR=1 does those too, for when the owner asks for it.
 *
 * SAFE TO SHOW: the read routes authorise a photo by MEMBERSHIP of the line's
 * photo_urls and never by key shape (mfg-purchase-orders.ts
 * poItemPhotoSignedHandler, scm/routes/delivery-order-item-photos.ts), so an
 * `so-items/` key on a PO or DO line is served unchanged. The R2 objects are
 * SHARED, not copied (mig 0274) - this uploads nothing and deletes nothing.
 *
 * DEFAULT IS PLAN. MODE=apply needs CONFIRM="CARRY DOCUMENT PHOTOS".
 * RE-RUN: idempotent. The target is computed per line from the SO line, so a
 * second run finds every source key already present, plans zero writes and
 * writes nothing. The fresh-connection check asserts that SHAPE rather than a
 * row count.
 *
 *   DATABASE_URL     required - the only credential
 *   MODE             plan (default) | apply
 *   CONFIRM          required on apply
 *   INCLUDE_MIRROR   1 to also top up lines that already show a photo
 */
import postgres from 'postgres';
import { planPhotoCarry, verifyPhotoCarry } from './lib/document-photo-carry.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').trim().toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'CARRY DOCUMENT PHOTOS';
const INCLUDE_MIRROR = process.env.INCLUDE_MIRROR === '1';

const note = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const fail = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`); process.exit(1); };

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}" - refusing.`);
  process.exit(2);
}

/* One shape per document. `erpMinted` is reported, never filtered on: a
   document number carrying a YYMM block (HC-PO-2609-081) was raised HERE, one
   that is the book's running number (HC-PO-010148) was imported. If an
   ERP-raised document ever appears in this plan, the live convert carry has
   broken and that is the finding, not a row to repair quietly.
   `linked_ac_docno` is NOT the distinguisher - the write-back stamps it on
   documents we raised ourselves. */
const SOURCES = [
  {
    table: 'purchase_order_items',
    label: 'Purchase Order',
    query: (sql) => sql`
      SELECT i.id::text, i.company_id, h.po_number AS doc_no, i.item_code,
             i.photo_urls AS doc_keys, s.photo_urls AS so_keys,
             (h.po_number ~ '-[0-9]{4}-[0-9]+$') AS erp_minted
        FROM scm.purchase_order_items i
        JOIN scm.mfg_sales_order_items s
          ON s.id = i.so_item_id AND s.company_id = i.company_id
        JOIN scm.purchase_orders h
          ON h.id = i.purchase_order_id AND h.company_id = i.company_id
       WHERE i.so_item_id IS NOT NULL
         AND coalesce(array_length(s.photo_urls, 1), 0) > 0
         AND NOT (s.photo_urls <@ i.photo_urls)
       ORDER BY h.po_number, i.line_no`,
  },
  {
    table: 'delivery_order_items',
    label: 'Delivery Order',
    query: (sql) => sql`
      SELECT i.id::text, i.company_id, h.do_number AS doc_no, i.item_code,
             i.photo_urls AS doc_keys, s.photo_urls AS so_keys,
             (h.do_number ~ '-[0-9]{4}-[0-9]+$') AS erp_minted
        FROM scm.delivery_order_items i
        JOIN scm.mfg_sales_order_items s
          ON s.id = i.so_item_id AND s.company_id = i.company_id
        JOIN scm.delivery_orders h
          ON h.id = i.delivery_order_id AND h.company_id = i.company_id
       WHERE i.so_item_id IS NOT NULL
         AND coalesce(array_length(s.photo_urls, 1), 0) > 0
         AND NOT (s.photo_urls <@ i.photo_urls)
       ORDER BY h.do_number, i.line_no`,
  },
];

const read = async (sql, src) => (await src.query(sql)).map((r) => ({
  id: r.id,
  companyId: r.company_id,
  table: src.table,
  label: src.label,
  docNo: r.doc_no,
  itemCode: r.item_code,
  docKeys: r.doc_keys ?? [],
  soKeys: r.so_keys ?? [],
  erpMinted: r.erp_minted === true,
}));

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (no writes)'}  includeMirror=${INCLUDE_MIRROR}`);
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

  const planned = [];
  for (const src of SOURCES) {
    const rows = await read(sql, src);
    const { fills, mirrors, writes } = planPhotoCarry(rows, { includeMirror: INCLUDE_MIRROR });
    const docs = new Set(fills.map((f) => f.docNo));
    note('');
    note(`${src.label}: ${rows.length} line(s) do not carry everything their sales order line does`);
    note(`   showing NO photo at all  -> FILL:   ${fills.length} line(s) on ${docs.size} document(s)`);
    note(`   already showing their own -> MIRROR: ${mirrors.length} line(s)`
      + (INCLUDE_MIRROR ? '  (INCLUDE_MIRROR=1, these are written too)' : '  (held back)'));
    for (const f of fills.slice(0, 8)) note(`      ${f.docNo} ${f.itemCode}: 0 -> ${f.next.length} photo(s)`);
    if (fills.length > 8) note(`      ... and ${fills.length - 8} more`);

    /* An ERP-raised document in this plan means the LIVE carry dropped a photo.
       Say so loudly - the repair would hide it by fixing the symptom. */
    const live = [...fills, ...mirrors].filter((r) => r.erpMinted);
    if (live.length) {
      note(`   WARNING: ${live.length} of these sit on documents WE raised, not imported ones`);
      note('            - the convert carry itself may be dropping photos. Investigate before applying.');
      for (const r of live.slice(0, 10)) note(`      ${r.docNo} ${r.itemCode}`);
    }
    planned.push(...writes);
  }

  if (!APPLY) {
    note('');
    note(`PLAN: ${planned.length} line(s) would be written. Nothing changed.`);
    note(`Re-run MODE=apply CONFIRM="${CONFIRM_PHRASE}" to apply.`);
    await sql.end();
    return;
  }
  if (planned.length === 0) { note('\nNothing to carry.'); await sql.end(); return; }

  let n = 0;
  await sql.begin(async (tx) => {
    for (const w of planned) {
      /* photo_urls is text[]; postgres.js binds a JS array natively, so there
         is no pre-serialised value here for it to double-encode (the jsonb
         trap - docs/bugs/0625 and audit:jsonb-binds). */
      const q = w.table === 'purchase_order_items'
        ? tx`UPDATE scm.purchase_order_items SET photo_urls = ${w.next}
              WHERE id = ${w.id} AND company_id = ${w.companyId}`
        : tx`UPDATE scm.delivery_order_items SET photo_urls = ${w.next}
              WHERE id = ${w.id} AND company_id = ${w.companyId}`;
      await q;
      n += 1;
    }
  });
  note('');
  note(`APPLIED: ${n} document line(s) now carry their sales order line's photograph.`);
  await sql.end();

  /* FRESH connection, and the check is the SHAPE: every written line CONTAINS
     every source key and has LOST none of its own. */
  const v = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  const after = new Map();
  for (const src of SOURCES) {
    const ids = planned.filter((w) => w.table === src.table).map((w) => w.id);
    if (ids.length === 0) continue;
    const rows = src.table === 'purchase_order_items'
      ? await v`SELECT id::text, photo_urls FROM scm.purchase_order_items WHERE id = ANY(${ids}::uuid[])`
      : await v`SELECT id::text, photo_urls FROM scm.delivery_order_items WHERE id = ANY(${ids}::uuid[])`;
    for (const r of rows) after.set(r.id, { docKeys: r.photo_urls ?? [] });
  }
  await v.end();

  const bad = verifyPhotoCarry(planned, after);
  if (bad.length) fail(`VERIFY FAILED on ${bad.length} line(s): ${bad.slice(0, 5).join('; ')}`);
  note(`VERIFIED on a fresh connection: all ${planned.length} line(s) carry every source key, and none lost a key of its own.`);
}

main().catch((e) => fail(e?.message ?? String(e)));
