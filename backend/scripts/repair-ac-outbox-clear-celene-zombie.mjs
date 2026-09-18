// Archive the AutoCount outbox row(s) that reference a UUID doc_no whose
// document was DELETED from the ERP — the "CELENE zombie" row.
//
// WHAT WAS OBSERVED. The outbox row for doc `044f73de-c197-4e0d-a3f3-27fa0ab77724`
// sat as `skipped/ItemCodeError` for CELENE (A)-(K). The read-only workflow
// `probe-doc-writeback` was dispatched with that UUID and returned "NO SUCH
// DOCUMENT in this company. Check the number and the company id." — meaning
// neither `scm.mfg_sales_orders.doc_no` nor `scm.purchase_orders.po_number`
// carries this value in company 1. So the outbox row references a purchase
// order that no longer exists in the ERP: a zombie. The document cannot ever
// be sent, will never be completed, and does not belong on Not Accepted.
//
// The row is ARCHIVED (`archived_at = now()`), not deleted, per 0277's own
// COMMENT ON TABLE: "Never delete rows: this is the audit trail of what the
// ERP told AutoCount". `archived_at` says a person has finished with the row;
// `status` and `last_error` stay exactly as they are, so bringing the row back
// is clearing one column.
//
// REVERSAL: UPDATE scm.autocount_outbox SET archived_at = NULL WHERE
// doc_no = '044f73de-c197-4e0d-a3f3-27fa0ab77724' AND company_id = 1;
//
// RE-RUN: idempotent. Any row already archived is left alone.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const MODE = process.env.MODE ?? 'plan';
const CONFIRM = process.env.CONFIRM ?? '';
const APPLY = MODE === 'apply';

const DOC_NO = '044f73de-c197-4e0d-a3f3-27fa0ab77724';
const COMPANY_ID = 1;
const CONFIRM_PHRASE = 'ARCHIVE-CELENE-ZOMBIE';

if (APPLY && CONFIRM !== CONFIRM_PHRASE) {
  console.error(`refuses to apply: CONFIRM must be exactly "${CONFIRM_PHRASE}"`);
  process.exit(1);
}

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
  console.error('no DATABASE_URL — set it in the environment or .dev.vars');
  process.exit(1);
}

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  // Confirm the doc is really absent from both tables before we act.
  const [inSo] = await pg`SELECT 1 AS x FROM scm.mfg_sales_orders WHERE doc_no = ${DOC_NO} AND company_id = ${COMPANY_ID}`;
  const [inPo] = await pg`SELECT 1 AS x FROM scm.purchase_orders WHERE po_number = ${DOC_NO} AND company_id = ${COMPANY_ID}`;
  if (inSo || inPo) {
    console.error(`REFUSED — the document EXISTS in the ERP (so=${!!inSo}, po=${!!inPo}). It is not a zombie; do not archive.`);
    process.exit(1);
  }

  const rows = await pg`
    SELECT id, op, status, attempts, archived_at, created_at
      FROM scm.autocount_outbox
     WHERE doc_no = ${DOC_NO}
       AND company_id = ${COMPANY_ID}
     ORDER BY created_at`;

  console.log('BEFORE:', JSON.stringify(rows, null, 2));

  const live = rows.filter((r) => r.archived_at === null);
  console.log(`already archived: ${rows.length - live.length}`);
  console.log(`about to archive: ${live.length}`);

  if (live.length === 0) {
    console.log('OK — nothing to do.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`DRY-RUN — no write. Would set archived_at = now() on ${live.length} row(s).`);
    console.log(`Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
    process.exit(0);
  }

  const written = await pg`
    UPDATE scm.autocount_outbox
       SET archived_at = now()
     WHERE doc_no = ${DOC_NO}
       AND company_id = ${COMPANY_ID}
       AND archived_at IS NULL
     RETURNING id`;

  console.log('WROTE:', written.length, 'row(s)');
} finally {
  await pg.end();
}

// Fresh connection + SHAPE check: every row for this doc_no must now have
// archived_at NOT NULL. A row count is not proof.
const pg2 = postgres(url, { ssl: 'require', prepare: false, max: 1 });
try {
  const after = await pg2`
    SELECT id, status, archived_at
      FROM scm.autocount_outbox
     WHERE doc_no = ${DOC_NO}
       AND company_id = ${COMPANY_ID}`;
  console.log('AFTER:', JSON.stringify(after, null, 2));

  if (!APPLY) {
    process.exit(0);
  }

  const stillLive = after.filter((r) => r.archived_at === null);
  if (stillLive.length > 0) {
    console.error(`POST-CHECK FAILED — ${stillLive.length} row(s) still not archived`);
    process.exit(1);
  }

  console.log('OK — zombie CELENE row(s) archived. UI Not Accepted count drops by 1.');
} finally {
  await pg2.end();
}
