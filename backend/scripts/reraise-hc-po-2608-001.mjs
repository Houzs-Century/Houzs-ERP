// ---------------------------------------------------------------------------
// reraise-hc-po-2608-001.mjs — ONE purchase order, back in front of the
// AutoCount queue, so it lands under the ERP's number instead of AutoCount's.
//
// WHAT HAPPENED. HC-PO-2608-001 was transferred from its sales order through
// /so-to-po, and the transfer arm threw away the composed body — so no `DocNo`
// went with it and AutoCount named the document itself: PO-009968. #2365 fixed
// the arm (composeSoToPo now carries DocNo) and the host binary was rebuilt on
// 2026-08-17. PO-009968 has since been CANCELLED in the live book with the
// owner's explicit approval, so the ERP document has no live counterpart and
// must be sent again.
//
// It will not send again on its own. purchase_orders.linked_ac_docno still
// says PO-009968, and every path that could re-send reads that column:
//
//   enqueuePoCreate  autocount-outbox.ts:752  `if (header.linked_ac_docno) return false;`
//   enqueueEdit      autocount-outbox.ts:1441 `if (!composed.linkedAcDocNo) return false;`
//                    — so CLEARING the column does not make a save re-send it
//                      either; an edit of an unlinked document is a no-op.
//   requeueOneRow    autocount-requeue.ts:703 refuses a `sent` row outright, and
//                    requeueSkipped's select (`.in('status', ['skipped','failed'])`)
//                    can never return one.
//
// That is why this script exists and why it does TWO things rather than one:
// clearing the link on its own leaves the document unlinked AND unqueued, which
// is a worse state than the one it starts in — the ERP would then believe the
// order is not in AutoCount and nothing in the system would ever send it.
//
// ── WHAT THIS CAN SEE, AND WHAT IT CANNOT ─────────────────────────────────
// It has ONE connection and it is to the ERP's Postgres. It cannot open
// AED_HOUZS, so it asserts the ERP'S OWN RECORD and nothing about the account
// book. The cancellation of PO-009968 was measured SEPARATELY, BY A HUMAN, on
// the host: POST /cancel {"DocType":"PO","DocNo":"PO-009968"} -> {"ok":true},
// and SELECT DocNo, Cancelled FROM PO WHERE DocNo='PO-009968' -> Cancelled = T.
// This script REPEATS that claim in its output; it does not verify it. If that
// cancellation did not happen, running this puts a SECOND live purchase order
// for the same goods into a licensed account book.
//
// ── SCOPE ─────────────────────────────────────────────────────────────────
// ONE document, named in a constant. DOC_NO may be supplied but must equal it;
// anything else exits 2. Clearing linked_ac_docno in bulk would tell the ERP
// that documents which ARE in the book are not, and the next drain would
// duplicate every one of them in a live accounting system.
//
// The UPDATE carries `AND linked_ac_docno = 'PO-009968'` as a predicate, so the
// only value it can ever erase is the one named here. A different value is
// refused before anything is written.
//
// MODE=plan (default) reads and writes nothing.
// MODE=apply requires CONFIRM="PO-009968 IS CANCELLED IN AUTOCOUNT".
//
// RE-RUN: inert after a successful apply, in both halves and for different
// reasons. The clear is predicated on linked_ac_docno = 'PO-009968', which is
// no longer true, so it matches zero rows and the script reports the link as
// already cleared instead of erasing whatever the drain has since written back.
// The queue half refuses when a pending create/transfer row for this document
// already exists, and 0277's pending-dedupe index refuses a second row anyway.
// A re-run AFTER the drain has landed the document finds linked_ac_docno set to
// the new AutoCount number, which is not PO-009968, and exits 2 without writing.
// ---------------------------------------------------------------------------
import postgres from 'postgres';
import { enqueuePoCreate } from '../src/scm/lib/autocount-outbox.ts';
import { pgrestShim } from './lib/pgrest-shim.mjs';

/** The ONE document this script is allowed to touch. */
const THE_DOC = 'HC-PO-2608-001';
/** The ONE AutoCount number it is allowed to erase. */
const THE_LINK = 'PO-009968';

const CONFIRM_PHRASE = 'PO-009968 IS CANCELLED IN AUTOCOUNT';
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

const DSN = process.env.DATABASE_URL;
if (!DSN) { bad('DATABASE_URL is not set.'); process.exit(2); }

const asked = (process.env.DOC_NO || THE_DOC).trim();
if (asked !== THE_DOC) {
  bad(`this script is scoped to ${THE_DOC} and was asked for ${JSON.stringify(asked)}. Refusing: `
    + 'clearing linked_ac_docno on a document that IS in the account book makes the next drain '
    + 'write a duplicate into a live licensed system.');
  process.exit(2);
}

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}". `
    + 'That phrase is the fact this script cannot check for itself.');
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** Every outbox row this document has ever produced, oldest first. */
async function outboxRows(client, companyId) {
  return client`
    SELECT id::text AS id, op, status, doc_no, dedupe_key,
           payload->'body'->>'DocNo' AS body_doc_no,
           jsonb_typeof(payload) AS payload_shape,
           jsonb_typeof(payload->'body') AS body_shape,
           ac_doc_no,
           left(coalesce(last_error, ''), 160) AS last_error,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created_utc
      FROM scm.autocount_outbox
     WHERE company_id = ${companyId} AND doc_no = ${THE_DOC}
     ORDER BY created_at, id`;
}

const rowLine = (r) => `  ${String(r.created_utc)}  ${String(r.op).padEnd(10)} ${String(r.status).padEnd(8)}`
  + ` DocNo-in-payload=${r.body_doc_no ?? '(none)'}  ac_doc_no=${r.ac_doc_no ?? '-'}  ${r.id}`
  + (r.last_error ? `\n      ${r.last_error}` : '');

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (reads only, writes nothing)'} document=${THE_DOC}`);

  note('\n=== WHAT THIS ASSERTS, AND WHAT IT DOES NOT ===');
  note("  ASSERTED HERE: the ERP's own record — scm.purchase_orders.linked_ac_docno");
  note('                 and scm.autocount_outbox, on this one document.');
  note(`  NOT ASSERTED:  anything about AED_HOUZS. This script has no connection to the`);
  note(`                 account book and cannot see whether ${THE_LINK} is cancelled.`);
  note(`  MEASURED SEPARATELY, BY A HUMAN, on the host: POST /cancel {"DocType":"PO",`);
  note(`                 "DocNo":"${THE_LINK}"} returned {"ok":true}, and`);
  note(`                 SELECT DocNo, Cancelled FROM PO WHERE DocNo='${THE_LINK}'`);
  note('                 returned Cancelled = T. That is the premise, not a finding.');

  const header = await sql`
    SELECT id::text AS id, company_id, po_number, status::text AS status,
           linked_ac_docno, supplier_id::text AS supplier_id,
           to_char(po_date, 'YYYY-MM-DD') AS po_date
      FROM scm.purchase_orders WHERE po_number = ${THE_DOC}`;

  if (header.length !== 1) {
    bad(`expected exactly one purchase order numbered ${THE_DOC}, found ${header.length}. Refusing.`);
    await sql.end({ timeout: 5 });
    process.exit(2);
  }
  const po = header[0];
  const companyId = Number(po.company_id);

  note('\n=== THE DOCUMENT ===');
  note(`  po_number        ${po.po_number}`);
  note(`  id               ${po.id}`);
  note(`  company_id       ${companyId}`);
  note(`  status           ${po.status}`);
  note(`  po_date          ${po.po_date ?? '-'}`);
  note(`  linked_ac_docno  ${po.linked_ac_docno === null ? 'NULL' : JSON.stringify(po.linked_ac_docno)}`);

  /* THE REFUSAL. NULL is the state a completed run of THIS script leaves
     behind, so it is not an error — it means the clear is already done and only
     the queue half is left. Any OTHER value is a number nobody told this script
     about: the drain may have written back a real, live AutoCount document, and
     erasing that is how a duplicate reaches a licensed book. */
  const alreadyCleared = po.linked_ac_docno === null;
  if (!alreadyCleared && po.linked_ac_docno !== THE_LINK) {
    bad(`linked_ac_docno is ${JSON.stringify(po.linked_ac_docno)}, not ${THE_LINK}. `
      + 'It has changed since this script was written. STOPPING — nothing was written. '
      + 'Whatever that number is, it may be a live document in the account book, and this '
      + 'script was not told about it.');
    await sql.end({ timeout: 5 });
    process.exit(2);
  }

  const before = await outboxRows(sql, companyId);
  note(`\n=== OUTBOX HISTORY FOR ${THE_DOC} (${before.length} row(s)) ===`);
  for (const r of before) note(rowLine(r));
  if (!before.length) note('  (none)');

  /* The only rung left between here and a second document in the book. A
     pending row is already going to be sent by the next 5-minute sweep. */
  const live = before.find((r) => (r.op === 'create_po' || r.op === 'so_to_po') && r.status === 'pending');
  const sent = before.filter((r) => r.status === 'sent');

  note('\n=== WHY NO EXISTING TOOL CAN DO THIS ===');
  note(`  sent row(s) for this document: ${sent.length}. requeueOneRow refuses a 'sent' row`);
  note("  (autocount-requeue.ts:703) and requeueSkipped selects only 'skipped'/'failed', so the");
  note('  "re-queue a refused document" workflow reports nothing to do. An ERP-side save does');
  note('  not reach the queue either: enqueueEdit returns false for a document with no');
  note('  linked_ac_docno, and PATCH /:id/confirm short-circuits on an already-SUBMITTED PO');
  note('  before it reaches enqueuePoCreate. The guard those three share is correct and stays;');
  note('  this run is the owner-approved exception to it, and its whole premise is the');
  note(`  human-measured cancellation of ${THE_LINK} quoted above.`);

  note('\n=== PLAN ===');
  note(alreadyCleared
    ? `  1. clear linked_ac_docno — ALREADY DONE (it is NULL). Nothing to write.`
    : `  1. UPDATE scm.purchase_orders SET linked_ac_docno = NULL`
      + `\n       WHERE id = ${po.id} AND company_id = ${companyId}`
      + `\n         AND po_number = '${THE_DOC}' AND linked_ac_docno = '${THE_LINK}'   -> expect 1 row`);
  note(live
    ? `  2. queue the create — SKIPPED: a pending ${live.op} row already exists (${live.id}).`
    : '  2. call enqueuePoCreate (the REAL one, imported from src/) so the composer that runs'
      + '\n       in the Worker is the composer that runs here. It will pick transfer or create'
      + `\n       through readPoEnqueueShape and carry DocNo=${THE_DOC} in the body — the field`
      + '\n       whose absence produced PO-009968.');
  note('  3. re-read BOTH on a FRESH connection and assert the values, not the row counts.');

  if (!APPLY) {
    note(`\nPLAN — nothing was written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── WRITE ────────────────────────────────────────────────────────────────
  let cleared = alreadyCleared;
  if (!alreadyCleared) {
    const back = await sql`
      UPDATE scm.purchase_orders SET linked_ac_docno = NULL, updated_at = now()
       WHERE id = ${po.id}::uuid AND company_id = ${companyId}
         AND po_number = ${THE_DOC} AND linked_ac_docno = ${THE_LINK}
      RETURNING id::text AS id, linked_ac_docno`;
    if (back.length !== 1) {
      bad(`the clear matched ${back.length} row(s), expected exactly 1. Nothing else was done.`);
      await sql.end({ timeout: 5 });
      process.exit(1);
    }
    cleared = true;
    note(`\ncleared linked_ac_docno on ${THE_DOC} (${back.length} row)`);
  }

  const queued = live ? false : await enqueuePoCreate(pgrestShim(sql, 'scm'), { companyId, poId: po.id, createdBy: null });
  if (live) note(`enqueue skipped — a pending ${live.op} row already exists (${live.id}).`);
  else note(`enqueuePoCreate returned ${queued}`);

  // ── VERIFY ON A FRESH CONNECTION ─────────────────────────────────────────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let ok = true;
  try {
    const [after] = await check`
      SELECT po_number, linked_ac_docno,
             (linked_ac_docno IS NULL) AS is_sql_null,
             pg_typeof(linked_ac_docno)::text AS col_type
        FROM scm.purchase_orders WHERE id = ${po.id}::uuid AND company_id = ${companyId}`;

    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    note(`  ${after.po_number}.linked_ac_docno = ${after.linked_ac_docno === null ? 'NULL' : JSON.stringify(after.linked_ac_docno)}`
      + `  (column type ${after.col_type}, IS NULL = ${after.is_sql_null})`);
    /* A cleared column and an EMPTY-STRING column read the same in a report and
       are not the same value. Asserted as SQL NULL on both sides of the wire. */
    if (after.linked_ac_docno !== null || after.is_sql_null !== true) {
      ok = false;
      bad(`linked_ac_docno is ${JSON.stringify(after.linked_ac_docno)}, not SQL NULL.`);
    }

    const rows = await outboxRows(check, companyId);
    note(`\n  outbox rows for ${THE_DOC}: ${rows.length}`);
    for (const r of rows) note(rowLine(r));

    const fresh = rows.filter((r) => (r.op === 'create_po' || r.op === 'so_to_po') && r.status === 'pending');
    if (fresh.length !== 1) {
      ok = false;
      bad(`expected exactly ONE pending create/transfer row, found ${fresh.length}. `
        + 'Zero means nothing will send; more than one means the drain would write two documents.');
    } else {
      const q = fresh[0];
      /* THE SHAPE THAT MATTERS, and the exact defect being closed: the queued
         body must NAME the document. PO-009968 exists because it did not. */
      note(`\n  queued ${q.op} ${q.id}: payload is a ${q.payload_shape}, body is a ${q.body_shape},`
        + ` body.DocNo = ${q.body_doc_no ?? '(absent)'}`);
      if (q.payload_shape !== 'object' || q.body_shape !== 'object') {
        ok = false;
        bad(`payload/body is ${q.payload_shape}/${q.body_shape}, not object/object — the drain reads it as JSON.`);
      }
      if (q.body_doc_no !== THE_DOC) {
        ok = false;
        bad(`the queued body carries DocNo=${q.body_doc_no ?? '(absent)'}, not ${THE_DOC}. `
          + 'That is the PO-009968 defect, unfixed — do NOT let this drain.');
      } else {
        note(`  body.DocNo is ${THE_DOC}: AutoCount will not name this document itself.`);
      }
    }
  } finally {
    await check.end({ timeout: 5 });
  }

  note(`\n=== RESULT ===`);
  note(`  link cleared: ${cleared} | create queued this run: ${queued}`);
  note('  The queue sends on the next 5-minute cron sweep. WHERE IT LANDED IS NOT KNOWABLE FROM');
  note('  HERE — a `sent` row means AutoCount answered, not that the book holds the number you');
  note('  expect. Confirm on the host:');
  note(`     SELECT DocNo, DocDate, CreditorCode, Cancelled FROM PO WHERE DocNo LIKE 'HC-%';`);
  if (!ok) process.exit(1);
}

main().catch(async (e) => {
  bad(e instanceof Error ? e.message : String(e));
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
