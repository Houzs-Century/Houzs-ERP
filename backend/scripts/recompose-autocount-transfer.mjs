// Re-COMPOSE a stuck conversion, instead of replaying the payload it was
// refused with.
//
// WHY THIS EXISTS, and why the re-queue tool could not do it. `requeue-autocount-
// skipped.mjs` says in its own header that a TRANSFER is deliberately replayed:
// "it has no create to compose, its stored payload IS the complete instruction,
// and re-sending that snapshot is what a retry means". That reasoning holds for
// the case it was written for — the DOCUMENT changed, or the host did — and it
// has exactly one blind spot: it assumes the COMPOSER never changes.
//
// On 2026-09-08 the composer changed. `readConvertSourceKeys` used to send one
// DtlKey per ERP line, and AutoCount holds a sofa as ONE line the ERP splits
// into a line per piece — so HC-DO-2609-004 and HC-DO-2609-009 went out as
// `[901830, 901830, 901831]` and the host refused a set it could not reconcile
// (docs/bugs/0722). The fix merges by key. Replaying either row re-sends the
// duplicate, forever: the snapshot is the defect.
//
// So this composes the transfer AGAIN, from the documents as they stand now,
// through the REAL enqueueConvert the Worker runs. No second implementation:
// re-deriving which lines a conversion took is exactly the logic that was just
// found to be wrong, and a copy of it here would be the next thing to go wrong
// on its own. Same tsx + pgrest-shim bridge the re-queue tool uses, for the
// same reason.
//
// WHAT IT DOES NOT DO. It does not touch AutoCount and it does not decide
// anything: enqueueConvert applies every guard it always has, so a document
// that should be refused is still refused — with today's reasons rather than
// last week's.
//
//   MODE=plan (default)  read the rows, compose nothing, print what it would do
//   APPLY=1              compose and queue, and CONFIRM_DOC must equal DOC_NO
//   DOC_NO=HC-DO-2609-004   one document, required — this is not a sweep
//
// RE-RUN: a second run with the same DOC_NO composes again. enqueueConvert
// dedupes on `${op}:${docId}`, so the row is replaced rather than doubled, and
// a document already `sent` is left alone by the guard below.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { enqueueConvert } from '../src/scm/lib/autocount-outbox.ts';
import { pgrestShim } from './lib/pgrest-shim.mjs';

const APPLY = process.env.APPLY === '1';
const DOC_NO = (process.env.DOC_NO || '').trim();
const CONFIRM_DOC = (process.env.CONFIRM_DOC || '').trim();

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error('No DATABASE_URL. Dispatch the workflow, or set it locally.');
  process.exit(1);
}
if (!DOC_NO) {
  console.error('DOC_NO is required. This composes ONE named document, never a sweep.');
  process.exit(1);
}
/* A phrase you must REPEAT, not a flag you can leave on. The apply path queues
   an instruction against a licensed account book. */
if (APPLY && CONFIRM_DOC !== DOC_NO) {
  console.error(`APPLY=1 needs CONFIRM_DOC to equal DOC_NO exactly. Got "${CONFIRM_DOC}", wanted "${DOC_NO}".`);
  process.exit(1);
}

/* Only the DELIVERY-ORDER arm today, because that is the shape that broke and
   the only one with a proven repair. The other three conversions are one entry
   each when they need it — and adding one blind, before a document has actually
   needed it, is how a tool grows an arm nobody has ever run. */
const OP = 'so_to_do';

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });
/* PUSHING IS THIS TOOL'S PURPOSE — see pgrest-shim.mjs. */
const sb = pgrestShim(pg, 'scm', { writeback: 'enqueue' });

try {
  const [doc] = await pg`
    SELECT id, do_number, company_id, do_date, ref
      FROM scm.delivery_orders WHERE do_number = ${DOC_NO}`;
  if (!doc) {
    console.log(`NOT FOUND: scm.delivery_orders has no row with do_number = '${DOC_NO}'. Nothing done.`);
    process.exit(0);
  }

  const [row] = await pg`
    SELECT id, status, attempts, last_error
      FROM scm.autocount_outbox
     WHERE op = ${OP} AND doc_id = ${doc.id}
     ORDER BY created_at DESC LIMIT 1`;
  console.log(`${DOC_NO}: outbox ${row ? `${row.status} after ${row.attempts} attempt(s)` : '(no row)'}`);
  /* ALREADY IN THE BOOK IS A STOP, not a warning. Composing a second transfer
     for a document AutoCount has accepted is how a delivery gets written twice. */
  if (row?.status === 'sent') {
    console.log('  it is already SENT. Refusing to compose a second transfer for a document the book has.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('');
    console.log('PLAN — nothing composed, nothing queued.');
    console.log(`  would call enqueueConvert(${OP}) for ${DOC_NO} (${doc.id})`);
    console.log('  re-run with APPLY=1 and CONFIRM_DOC set to the same document number.');
    process.exit(0);
  }

  /* THE SOURCES, READ OFF THE DOCUMENT'S OWN LINES rather than taken on trust.
     The route has `body.soDocNo` because a person just picked it; this runs long
     after, so the only honest answer is which sales orders these lines actually
     came from. Several is legitimate — a merged delivery draws from more than
     one — and every one has to be named or the transfer is a partial merge. */
  const srcRows = await pg`
    SELECT DISTINCT si.doc_no
      FROM scm.delivery_order_items di
      JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
     WHERE di.delivery_order_id = ${doc.id}
     ORDER BY si.doc_no`;
  const sources = srcRows.map((r) => String(r.doc_no)).filter(Boolean);
  console.log(`  source sales order(s): ${sources.join(', ') || '(none)'}`);
  if (!sources.length) {
    console.log('  no line on this delivery order names a sales-order line, so there is nothing to transfer FROM.');
    process.exit(0);
  }
  const from = sources.map((key) => ({ table: 'mfg_sales_orders', keyCol: 'doc_no', key }));

  const outcome = await enqueueConvert(sb, {
    companyId: doc.company_id,
    op: OP,
    from: from.length === 1 ? from[0] : from,
    to: { table: 'delivery_orders', keyCol: 'id', key: doc.id },
    docType: 'DO',
    docNo: doc.do_number,
    docId: doc.id,
    docDate: doc.do_date ?? null,
    ref: doc.ref ?? null,
  });
  console.log(`  enqueueConvert -> queued=${outcome?.queued}`);

  /* THE SHAPE, on a FRESH connection, because the point of this run is that the
     PAYLOAD is different — a status of `pending` would be true of the old one
     too. What is asserted is that no DtlKey is repeated, which is the whole
     defect this tool exists to clear. */
  const fresh = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  try {
    const [after] = await fresh`
      SELECT status, payload #> '{body,DtlKeys}' AS keys
        FROM scm.autocount_outbox
       WHERE op = ${OP} AND doc_id = ${doc.id}
       ORDER BY created_at DESC LIMIT 1`;
    const keys = Array.isArray(after?.keys) ? after.keys.map(Number) : [];
    const distinct = new Set(keys);
    console.log(`  VERIFY status=${after?.status} keys=[${keys.join(', ')}] distinct=${distinct.size}`);
    if (keys.length && distinct.size !== keys.length) {
      console.log('  STILL REPEATED — the composed payload names a key more than once. Do not re-send.');
      process.exit(0);
    }
    console.log('  no key is repeated. The 5-minute sweep sends it.');
  } finally {
    await fresh.end({ timeout: 5 });
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
