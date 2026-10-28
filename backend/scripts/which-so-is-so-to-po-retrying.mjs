#!/usr/bin/env node
// READ-ONLY. Which sales order is each `so_to_po` row actually transferring
// FROM, and does the purchase order's own line data agree?
//
// THE QUESTION, 2026-08-17. The service log shows `/so-to-po HC-SO-2608-001`
// retrying every five minutes; the owner says he raised the purchase order from
// HC-SO-2608-003. Both are naming a SALES ORDER, so they disagree about a fact,
// and "the owner misremembered" is a story, not a finding.
//
// WHY THE LOG NAMED A SALES ORDER, ON EVERY REQUEST UP TO 2026-08-17.
// AcSyncService logs
//
//     Log(path + " " + Str(p, "DocType") + " " + Or(Str(p, "DocNo"), Str(p, "FromDocNo")))
//
// and `composeSoToPo` used to send neither DocType nor DocNo -- it returned
// { DtlKeys, Details } and nothing else. So `Or(...)` fell through to
// FromDocNo, and the identifier in that log line was the SOURCE SALES ORDER,
// never the purchase order. A reader who took it for the PO number searched for
// a document that does not exist.
//
// CHANGED 2026-08-17, when divergence D5 was closed on this route: the payload
// now carries `DocNo`, so `Or(...)` takes it and a NEW request line names the
// PURCHASE ORDER. Both shapes are in the log file at once and neither is wrong
// -- which of the two you are reading is decided by the date, so check it:
//
//     10:15:14  /so-to-po  HC-SO-2608-001   <- before; the SOURCE sales order
//     ...       /so-to-po  HC-PO-2608-001   <- after;  the purchase order
//
// Section A below prints both numbers side by side for exactly this reason.
//
// THE THREE ANSWERS THIS CAN GIVE, and they are different repairs:
//
//   A. TWO ROWS. A `so_to_po` for a PO raised from HC-SO-2608-001 is stuck and
//      retrying, and the owner's HC-SO-2608-003 purchase order is a separate
//      row -- possibly `create_po`, because poTransferShape falls back to a
//      create on any doubt. Nobody is wrong; there are simply two documents.
//
//   B. ONE ROW, AND THE ERP RESOLVED A DIFFERENT SOURCE. The owner's purchase
//      order has lines whose `so_item_id` points at sales-order lines belonging
//      to HC-SO-2608-001. `fromSoDocNo` is read from the SO LINE's `doc_no`
//      (scm/lib/autocount-read.ts, readPoTransferFacts) and not from whatever
//      the PO page believed, so a mislinked line renames the source silently.
//      That is the same defect class as the delivery-order `so_item_id` entry
//      at the top of BUG-HISTORY.md, and it would mean the transfer is pointed
//      at the wrong sales order -- a real bug, not a bookkeeping mismatch.
//
//   C. NEITHER. No `so_to_po` row names HC-SO-2608-001 at all, and the log line
//      is older than the queue's current contents.
//
// Section C below decides between them by re-deriving `fromSoDocNo` from the
// PO's own lines and comparing it with what the queued payload holds. A row
// where those two disagree is answer B and is printed as MISMATCH.
//
// NOTHING IS WRITTEN. One connection, SELECTs only, no DDL, no transaction.
//
// RE-RUN: idempotent and side-effect free. Run it as often as you like; it
// reads the queue as it stands at that moment, so re-running after a drain
// legitimately gives a different answer.
//
//   COMPANY_ID=1 node backend/scripts/which-so-is-so-to-po-retrying.mjs
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('DATABASE_URL missing'); process.exit(1); }
const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
const LIMIT = Math.min(Number(process.env.LIMIT || 50), 200);

const sql = postgres(DSN, { ssl: 'require', max: 1, idle_timeout: 20, connect_timeout: 60 });
const notice = (m) => console.log(`::notice::${m}`);
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
const iso = (d) => (d?.toISOString?.() ?? (d == null ? '(null)' : String(d)));

async function main() {
  notice(`company_id=${COMPANY_ID} — read-only`);

  /* A — every so_to_po and create_po row, whatever its status. Both, because
     the SAME button produces either one and a reader looking only for
     `so_to_po` concludes the purchase order was never queued when it was
     queued as a create. */
  const rows = await sql`
    SELECT id, op, doc_type, doc_no, doc_id, status::text AS status,
           attempts, last_error, created_at, updated_at,
           payload -> 'fromDoc' ->> 'key'         AS from_key,
           payload -> 'body'    ->> 'CreditorCode' AS body_creditor,
           payload -> 'body'    ->> 'DtlKeys'      AS body_dtlkeys
      FROM scm.autocount_outbox
     WHERE company_id = ${COMPANY_ID}
       AND op IN ('so_to_po', 'create_po')
     ORDER BY created_at DESC
     LIMIT ${LIMIT}`;

  console.log('');
  notice(`A — so_to_po / create_po rows (${rows.length})`);
  if (!rows.length) {
    notice('  none. Answer C: the queue holds no purchase-order push at all for this company.');
  }
  console.log(`  ${pad('op', 11)} ${pad('PO doc_no', 18)} ${pad('from (SO)', 18)} ${pad('status', 9)} ${pad('att', 4)} ${pad('creditor', 10)} created`);
  for (const r of rows) {
    console.log(`  ${pad(r.op, 11)} ${pad(r.doc_no, 18)} ${pad(r.from_key ?? '(none)', 18)} ${pad(r.status, 9)} ${pad(r.attempts, 4)} ${pad(r.body_creditor ?? 'MISSING', 10)} ${iso(r.created_at)}`);
    if (r.last_error) console.log(`      last_error: ${String(r.last_error).slice(0, 300)}`);
  }

  /* B — the PO each row is FOR, and the sales orders its lines actually name.
     This is the half the queue cannot answer on its own. */
  const poIds = [...new Set(rows.map((r) => r.doc_id).filter(Boolean))];
  console.log('');
  notice(`B — what each purchase order's own lines say (${poIds.length} PO(s))`);
  const derived = new Map();
  for (const poId of poIds) {
    const lines = await sql`
      SELECT poi.id,
             poi.so_item_id,
             soi.doc_no            AS so_doc_no,
             soi.linked_ac_dtlkey  AS dtl_key,
             (SELECT count(*) FROM scm.purchase_order_item_allocations a
               WHERE a.purchase_order_item_id = poi.id) AS alloc_count
        FROM scm.purchase_order_items poi
        LEFT JOIN scm.mfg_sales_order_items soi ON soi.id = poi.so_item_id
       WHERE poi.purchase_order_id = ${poId}
       ORDER BY poi.id`;
    const sources = [...new Set(lines.map((l) => (l.so_doc_no ?? '').trim()).filter(Boolean))];
    const forStock = lines.filter((l) => l.so_item_id == null).length;
    const keyless = lines.filter((l) => l.so_item_id != null && l.dtl_key == null).length;
    const consolidated = lines.filter((l) => Number(l.alloc_count) > 0).length;
    derived.set(poId, { sources, forStock, keyless, consolidated, lineCount: lines.length });
    const po = rows.find((r) => r.doc_id === poId);
    console.log(`  PO ${pad(po?.doc_no, 18)} lines=${lines.length} stock=${forStock} keyless=${keyless} consolidated=${consolidated} sources=[${sources.join(', ') || 'none'}]`);
  }

  /* C — the verdict, and it is a comparison rather than a claim. */
  console.log('');
  notice('C — does the queued source match the purchase order\'s own lines?');
  let mismatches = 0;
  for (const r of rows.filter((x) => x.op === 'so_to_po')) {
    const d = derived.get(r.doc_id);
    if (!d) { console.log(`  ${pad(r.doc_no, 18)} the purchase order row could not be read`); continue; }
    const only = d.sources.length === 1 ? d.sources[0] : null;
    if (only && r.from_key && only !== r.from_key) {
      mismatches++;
      console.log(`  MISMATCH ${pad(r.doc_no, 18)} queued from=${r.from_key} but its lines name ${only}`);
    } else if (d.sources.length > 1) {
      console.log(`  ODD      ${pad(r.doc_no, 18)} queued as a TRANSFER but its lines name ${d.sources.length} sales orders — poTransferShape should have made this a create_po`);
    } else {
      console.log(`  agrees   ${pad(r.doc_no, 18)} from=${r.from_key ?? '(none)'}`);
    }
  }

  console.log('');
  notice('D — HOW TO READ THIS');
  notice('  A /so-to-po request line names the PURCHASE ORDER from 2026-08-17, when composeSoToPo');
  notice('  started sending DocNo (divergence D5). BEFORE that date it named the SOURCE SALES ORDER,');
  notice('  because Or(DocNo, FromDocNo) fell through. Both shapes are in the log; the date decides.');
  notice('  Section A prints the ERP doc_no and the "from (SO)" column, so either one is findable.');
  if (mismatches) {
    notice(`  ${mismatches} MISMATCH row(s): the ERP resolved a different source than the purchase order's`);
    notice('  own lines imply. That is answer B — a mislinked so_item_id, the same class as the');
    notice('  delivery-order entry at the top of BUG-HISTORY.md — and it is a bug, not a mismatch of memory.');
  } else {
    notice('  No mismatches. If the owner names a sales order that appears in no row above, look for a');
    notice('  SECOND purchase order (answer A): the same button falls back to create_po on any doubt,');
    notice('  and section A lists both ops for exactly that reason.');
  }
  notice('  creditor=MISSING in section A is the payload defect this run exists alongside; rows queued');
  notice('  before that fix are backfilled at drain from the PO row, so MISSING there is not fatal.');
}

main()
  /* Exit 0 for every legitimate answer, including an empty queue: the ANSWER is
     the output, and a red job reads as "the check broke". Only an unreachable
     database is non-zero. */
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
