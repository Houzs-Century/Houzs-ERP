/* Put AutoCount's supplier delivery dates onto the migrated purchase orders that
   never received them.

   THE OWNER, 2026-09-15, about the dates AutoCount's PO chasing list carries and
   the ERP does not: 「第 6 的这样子就要解决掉了」.

   ── THE FIELDS (proven read-only against AED_HOUZS, 2026-09-15) ───────────
   They are HEADER UDFs in AutoCount; the chasing report repeats them per line.

     AutoCount         caption                    report column              ERP slot
     PO.UDF_EDate      "Supplier Delivery Date"   Estimate Delivery Date     supplier_delivery_date_2
     PO.UDF_EDate2     "Supplier Delivery Date 2" Supplier Delivery Date 2   supplier_delivery_date_3
     PO.UDF_EDate3     "Supplier Delivery Date 3" Supplier Delivery Date 3   supplier_delivery_date_4

   The ERP's slot 1 is the base date (line delivery_date / header expected_at,
   already imported from PODTL.DeliveryDate) and 2/3/4 are the supplier's dates
   after it (effective-delivery.ts: effective = MAX of all four). Evidence and
   the rejected name-for-name mapping: docs/bugs entry shipped with this script.

   ── WHERE THE DATES COME FROM ─────────────────────────────────────────────
   `data/ac-po-supplier-dates.json.gz`, produced by export-ac-po-supplier-dates.py
   on this Desktop over ZeroTier. A CI runner cannot reach AutoCount, so the
   snapshot is committed and its export time is printed first.

   ── WHAT IT WRITES — the header PATCH's own cascade ───────────────────────
   Company 1 only (AED_HOUZS is Houzs; 2990 does not sync). A PO is matched on
   purchase_orders.linked_ac_docno = the book's DocNo. For each slot the book has:
     header slot NULL        -> header := book date, updated_at := now()
                                and every LINE whose same slot is NULL := book date
                                (mfg-purchase-orders.ts PATCH /:id cascade, `.is(col, null)`)
     header slot = book      -> nothing
     header slot <> book     -> NOTHING; listed for the owner (the ERP is the editing
                                surface since go-live, so its value may be the newer one)
     line has its own value  -> NOTHING on that line; listed
   One entity_audit_log row per purchase order (source 'repair').
   Never qty, price, status, delivery_date, expected_at or any other column.

   ── IT DOES NOT PUBLISH TO AUTOCOUNT ──────────────────────────────────────
   The write-back is queued by the ROUTE layer (`queueAcPoEdit` in
   mfg-purchase-orders.ts); the only trigger on these two tables is
   trg_po_item_qty_guard (BEFORE UPDATE OF qty). The PO payload sends `UDF: {}`
   (services/autocount-writeback.ts), so even a republish would not carry these
   dates. The verify step PROVES it for this run: zero autocount_outbox rows for
   any touched PO created after the transaction started.

   SAFETY (release discipline, CLAUDE.md R85):
     MODE=plan (default) runs every write inside ONE transaction and ROLLS BACK.
     MODE=apply additionally requires CONFIRM="I HAVE REVIEWED THE DRY-RUN" and
     EXPECT_HEADER_FILLS + EXPECT_LINE_FILLS equal to what the reviewed plan printed;
     any other number refuses. Every UPDATE re-asserts `<slot> IS NULL`.
   VERIFY: re-reads on a FRESH connection and asserts the SHAPE — each filled
   slot reads back as exactly the book's YYYY-MM-DD, every other slot, the base
   dates and qty are unchanged, a line with its own value is untouched, audit rows
   exist, and no outbox row appeared.

   RE-RUN: inert. Keyed on the slot being NULL, so a second plan shows 0 fills
   and the same DIFFERENT / unmatched lists.

   USAGE:
     DATABASE_URL=... node scripts/fill-po-supplier-dates-from-autocount.mjs
     ... MODE=apply CONFIRM="I HAVE REVIEWED THE DRY-RUN" EXPECT_HEADER_FILLS=n EXPECT_LINE_FILLS=m

   Env: DATABASE_URL  MODE=plan|apply  CONFIRM  EXPECT_HEADER_FILLS  EXPECT_LINE_FILLS */

import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DSN = process.env.DATABASE_URL;
const GH = !!process.env.GITHUB_ACTIONS;
const note = (m) => console.log(GH ? `::notice::${m}` : m);
const bad = (m) => console.log(GH ? `::error::${m}` : `ERROR ${m}`);
const say = (m = '') => console.log(m);

if (!DSN) { bad('DATABASE_URL is not set'); process.exit(1); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = 1;
const ACTOR = 'fill-po-supplier-dates-from-autocount';
const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
const EXPECT_H = num(process.env.EXPECT_HEADER_FILLS);
const EXPECT_L = num(process.env.EXPECT_LINE_FILLS);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) { bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`); process.exit(2); }
if (APPLY && (!Number.isInteger(EXPECT_H) || !Number.isInteger(EXPECT_L))) {
  bad('MODE=apply requires EXPECT_HEADER_FILLS and EXPECT_LINE_FILLS (the numbers the reviewed plan printed)');
  process.exit(2);
}

/* book field -> ERP column -> the audit field name the PO header PATCH records */
const SLOTS = [
  { ac: 'EDate', acCol: 'UDF_EDate', col: 'supplier_delivery_date_2', audit: 'supplierDeliveryDate2' },
  { ac: 'EDate2', acCol: 'UDF_EDate2', col: 'supplier_delivery_date_3', audit: 'supplierDeliveryDate3' },
  { ac: 'EDate3', acCol: 'UDF_EDate3', col: 'supplier_delivery_date_4', audit: 'supplierDeliveryDate4' },
];
const ROLLBACK = Symbol('rollback');

function loadSnapshot() {
  const manifest = JSON.parse(readFileSync(join(HERE, 'data', 'ac-po-supplier-dates-manifest.json'), 'utf8'));
  const rows = JSON.parse(gunzipSync(readFileSync(join(HERE, 'data', 'ac-po-supplier-dates.json.gz'))).toString('utf8'));
  return { manifest, rows };
}

async function readErp(client) {
  const heads = await client`
    SELECT p.id::text AS id, p.po_number, p.linked_ac_docno, p.status::text AS status,
           to_char(p.expected_at, 'YYYY-MM-DD') AS expected_at,
           to_char(p.supplier_delivery_date_2, 'YYYY-MM-DD') AS supplier_delivery_date_2,
           to_char(p.supplier_delivery_date_3, 'YYYY-MM-DD') AS supplier_delivery_date_3,
           to_char(p.supplier_delivery_date_4, 'YYYY-MM-DD') AS supplier_delivery_date_4
      FROM scm.purchase_orders p
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`;
  const lines = await client`
    SELECT it.id::text AS id, it.purchase_order_id::text AS po_id, it.line_no, it.item_code, it.qty,
           it.linked_ac_dtlkey::text AS dtlkey,
           to_char(it.delivery_date, 'YYYY-MM-DD') AS delivery_date,
           to_char(it.supplier_delivery_date_2, 'YYYY-MM-DD') AS supplier_delivery_date_2,
           to_char(it.supplier_delivery_date_3, 'YYYY-MM-DD') AS supplier_delivery_date_3,
           to_char(it.supplier_delivery_date_4, 'YYYY-MM-DD') AS supplier_delivery_date_4
      FROM scm.purchase_order_items it
      JOIN scm.purchase_orders p ON p.id = it.purchase_order_id
     WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL
     ORDER BY p.po_number, it.line_no`;
  return { heads, lines };
}

async function main() {
  const { manifest, rows: book } = loadSnapshot();
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (everything rolls back)'} company=${CO}`);
  note(`AutoCount snapshot exported ${manifest.exported_at} from ${manifest.source}: ${book.length} PO(s) with a supplier date`);

  const { heads, lines } = await readErp(sql);
  const byDoc = new Map();
  for (const h of heads) byDoc.set(h.linked_ac_docno, [...(byDoc.get(h.linked_ac_docno) ?? []), h]);
  const linesByPo = new Map();
  for (const l of lines) linesByPo.set(l.po_id, [...(linesByPo.get(l.po_id) ?? []), l]);

  const count = {
    bookPos: book.length, bookCancelled: 0, poUnmatchedOpen: 0, poUnmatchedClosed: 0, poMatched: 0,
    headerFill: 0, headerSame: 0, headerDifferent: 0,
    lineFill: 0, lineSame: 0, lineOwnValue: 0, lineUnderSameHeader: 0, lineUnderDifferentHeader: 0,
    lineKeyMatched: 0, lineItemMatched: 0, lineNotInBook: 0,
  };
  const different = [];
  const ownValue = [];
  const unmatchedOpen = [];
  const unmatchedClosed = [];
  const notInBook = [];
  const plan = []; // { po, fills: [{slot, date}], lineFills: [{line, slot, date}] }

  for (const r of book) {
    if (r.Cancelled) { count.bookCancelled++; continue; }
    const pos = byDoc.get(r.DocNo) ?? [];
    if (!pos.length) {
      const tag = `${r.DocNo} (doc date ${r.DocDate}; ${SLOTS.filter((s) => r[s.ac]).map((s) => `${s.acCol}=${r[s.ac]}`).join(' ')})`;
      if (r.Outstanding) { count.poUnmatchedOpen++; unmatchedOpen.push(tag); } else { count.poUnmatchedClosed++; unmatchedClosed.push(tag); }
      continue;
    }
    for (const po of pos) {
      count.poMatched++;
      const poLines = linesByPo.get(po.id) ?? [];
      const keys = new Set(r.Lines.map((l) => String(l.DtlKey)));
      const items = new Set(r.Lines.map((l) => l.ItemCode));
      for (const l of poLines) {
        if (l.dtlkey && keys.has(l.dtlkey)) count.lineKeyMatched++;
        else if (items.has(String(l.item_code ?? '').trim())) count.lineItemMatched++;
        else { count.lineNotInBook++; notInBook.push(`${po.po_number} ln ${l.line_no} ${l.item_code} (key ${l.dtlkey ?? 'none'})`); }
      }
      const entry = { po, book: r, fills: [], lineFills: [] };
      for (const s of SLOTS) {
        const want = r[s.ac];
        if (!want) continue;
        const have = po[s.col];
        if (have === want) {
          count.headerSame++;
          count.lineUnderSameHeader += poLines.length;
          continue;
        }
        if (have) {
          count.headerDifferent++;
          count.lineUnderDifferentHeader += poLines.length;
          different.push(`${po.po_number} [${po.status}] ${s.col}: ERP ${have} vs AutoCount ${r.DocNo} ${s.acCol} ${want}`);
          continue;
        }
        count.headerFill++;
        entry.fills.push({ slot: s, date: want });
        for (const l of poLines) {
          if (l[s.col] === null) { count.lineFill++; entry.lineFills.push({ line: l, slot: s, date: want }); }
          else if (l[s.col] === want) count.lineSame++;
          else {
            count.lineOwnValue++;
            ownValue.push(`${po.po_number} ln ${l.line_no} ${l.item_code} ${s.col}: line ${l[s.col]} vs AutoCount ${want} (header blank)`);
          }
        }
      }
      if (entry.fills.length) plan.push(entry);
    }
  }

  say('\n=== EVERY FILL ===');
  for (const e of plan) {
    say(`${e.po.po_number} [${e.po.status}] <- ${e.book.DocNo}: ${e.fills.map((f) => `${f.slot.col}=${f.date}`).join(', ')}; lines filled ${e.lineFills.length}`);
  }
  say(`\n=== BOTH SET AND DIFFERENT — NOT OVERWRITTEN, for the owner (${different.length}) ===`);
  for (const x of different) say(`  ${x}`);
  say(`\n=== LINE ALREADY HAS ITS OWN VALUE, HEADER BLANK — NOT OVERWRITTEN (${ownValue.length}) ===`);
  for (const x of ownValue) say(`  ${x}`);
  say(`\n=== AUTOCOUNT PO WITH A DATE, NOT IN THE ERP, STILL OPEN IN THE BOOK (${unmatchedOpen.length}) ===`);
  for (const x of unmatchedOpen) say(`  ${x}`);
  say(`\n=== AUTOCOUNT PO WITH A DATE, NOT IN THE ERP, FULLY RECEIVED IN THE BOOK (${unmatchedClosed.length}; out of cutover scope) ===`);
  for (const x of unmatchedClosed.slice(0, 20)) say(`  ${x}`);
  if (unmatchedClosed.length > 20) say(`  ... and ${unmatchedClosed.length - 20} more`);
  say(`\n=== ERP LINE MATCHED TO NO BOOK LINE BY KEY OR ITEM CODE (${notInBook.length}; still filled — the date belongs to the whole PO) ===`);
  for (const x of notInBook) say(`  ${x}`);

  say('\n=== COUNTS ===');
  for (const [k, v] of Object.entries(count)) say(`  ${k}: ${v}`);
  const hFills = plan.reduce((n, e) => n + e.fills.length, 0);
  const lFills = plan.reduce((n, e) => n + e.lineFills.length, 0);
  note(`plan: ${plan.length} purchase order(s), ${hFills} header slot fill(s), ${lFills} line slot fill(s)`);

  if (APPLY && (hFills !== EXPECT_H || lFills !== EXPECT_L)) {
    bad(`plan has ${hFills} header / ${lFills} line fill(s) but EXPECT_HEADER_FILLS=${EXPECT_H} EXPECT_LINE_FILLS=${EXPECT_L} — refusing`);
    await sql.end({ timeout: 5 });
    process.exit(3);
  }
  if (!plan.length) { note('Nothing to write.'); await sql.end({ timeout: 5 }); return; }

  const [{ started }] = await sql`SELECT now() AS started`;
  let wroteH = 0;
  let wroteL = 0;
  try {
    await sql.begin(async (tx) => {
      for (const e of plan) {
        for (const f of e.fills) {
          const h = await tx.unsafe(
            `UPDATE scm.purchase_orders SET ${f.slot.col} = $1::date, updated_at = now()
              WHERE id = $2::uuid AND company_id = $3 AND ${f.slot.col} IS NULL RETURNING id`,
            [f.date, e.po.id, CO]);
          wroteH += h.length;
          const ids = e.lineFills.filter((x) => x.slot === f.slot).map((x) => x.line.id);
          if (ids.length) {
            const l = await tx.unsafe(
              `UPDATE scm.purchase_order_items SET ${f.slot.col} = $1::date
                WHERE id = ANY($2::uuid[]) AND purchase_order_id = $3::uuid AND company_id = $4
                  AND ${f.slot.col} IS NULL RETURNING id`,
              [f.date, ids, e.po.id, CO]);
            wroteL += l.length;
          }
        }
        await tx`
          INSERT INTO scm.entity_audit_log
            (entity_type, entity_id, entity_doc_no, company_id, action, actor_id, actor_name_snapshot,
             field_changes, status_snapshot, source, note)
          VALUES ('PURCHASE_ORDER', ${e.po.id}, ${e.po.po_number}, ${CO}, 'UPDATE', NULL, ${ACTOR},
                  ${tx.json(e.fills.map((f) => ({ field: f.slot.audit, from: null, to: f.date })))},
                  ${e.po.status}, 'repair',
                  ${`Supplier delivery date copied from AutoCount ${e.book.DocNo} (${e.fills.map((f) => f.slot.acCol).join(', ')}); ${e.lineFills.length} line(s)`})`;
      }
      note(`${APPLY ? 'wrote' : 'would write'}: ${wroteH} header slot(s), ${wroteL} line slot(s)`);
      if (wroteH !== hFills || wroteL !== lFills) throw new Error(`expected ${hFills}/${lFills}, wrote ${wroteH}/${wroteL} — refusing`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note('PLAN: transaction rolled back, nothing was written.');
    await sql.end({ timeout: 5 });
    await verify(plan, heads, lines, started, { expectWritten: false });
    note(`To keep it: MODE=apply CONFIRM="${CONFIRM_PHRASE}" EXPECT_HEADER_FILLS=${hFills} EXPECT_LINE_FILLS=${lFills}`);
    return;
  }
  await sql.end({ timeout: 5 });
  await verify(plan, heads, lines, started, { expectWritten: true });
}

async function verify(plan, beforeHeads, beforeLines, started, { expectWritten }) {
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let failures = 0;
  const fail = (m) => { failures += 1; bad(m); };
  try {
    const { heads, lines } = await readErp(check);
    const hNow = new Map(heads.map((h) => [h.id, h]));
    const lNow = new Map(lines.map((l) => [l.id, l]));
    const hWant = new Map(beforeHeads.map((h) => [h.id, { ...h }]));
    const lWant = new Map(beforeLines.map((l) => [l.id, { ...l }]));
    if (expectWritten) {
      for (const e of plan) {
        for (const f of e.fills) hWant.get(e.po.id)[f.slot.col] = f.date;
        for (const x of e.lineFills) lWant.get(x.line.id)[x.slot.col] = x.date;
      }
    }
    const cols = ['expected_at', ...SLOTS.map((s) => s.col)];
    const lcols = ['delivery_date', 'qty', 'item_code', ...SLOTS.map((s) => s.col)];
    const touched = new Set(plan.map((e) => e.po.id));
    for (const [id, want] of hWant) {
      const got = hNow.get(id);
      if (!got) { fail(`${want.po_number}: header disappeared`); continue; }
      for (const c of cols) if ((got[c] ?? null) !== (want[c] ?? null)) fail(`${want.po_number} ${c}: reads ${got[c]}, wanted ${want[c]}`);
    }
    for (const [id, want] of lWant) {
      if (!touched.has(want.po_id)) continue;
      const got = lNow.get(id);
      if (!got) { fail(`line ${id}: disappeared`); continue; }
      for (const c of lcols) if (String(got[c] ?? '') !== String(want[c] ?? '')) fail(`line ${id} ${c}: reads ${got[c]}, wanted ${want[c]}`);
    }
    const ids = [...touched];
    const numbers = plan.map((e) => e.po.po_number);
    const [{ n: outbox }] = await check`
      SELECT count(*)::int AS n FROM scm.autocount_outbox
       WHERE created_at >= ${started} AND (doc_id = ANY(${ids}) OR doc_no = ANY(${numbers}))`;
    say(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    say(`  headers checked ${hWant.size}, lines on touched POs checked ${[...lWant.values()].filter((l) => touched.has(l.po_id)).length}`);
    say(`  autocount_outbox rows for these ${ids.length} PO(s) created since ${new Date(started).toISOString()}: ${outbox}`);
    if (outbox !== 0) fail(`${outbox} outbox row(s) appeared for a touched PO — this fill must not publish to AutoCount`);
    if (expectWritten) {
      const [{ n }] = await check`
        SELECT count(*)::int AS n FROM scm.entity_audit_log
         WHERE source = 'repair' AND actor_name_snapshot = ${ACTOR} AND created_at >= ${started}
           AND entity_id = ANY(${ids})`;
      say(`  audit rows written by this run: ${n}`);
      if (n !== plan.length) fail(`expected ${plan.length} audit row(s), found ${n}`);
    }
    if (failures) { bad(`${failures} verification failure(s)`); process.exitCode = 1; }
    else note(expectWritten
      ? 'VERIFIED: every filled slot reads back as the book date, nothing else moved, nothing was queued for AutoCount.'
      : 'the rollback HELD: every header and line is exactly as it was, nothing was queued for AutoCount.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
