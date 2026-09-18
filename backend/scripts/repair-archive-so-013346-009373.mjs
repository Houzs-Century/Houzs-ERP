// Archive the AutoCount outbox rows for HC-SO-013346 and HC-SO-009373.
//
// WHY, and why THESE TWO get their own script. An earlier pass
// (repair-archive-remaining-ac-backlog.mjs) explicitly FORBADE these two
// because the owner was going to reconcile them in AutoCount by hand. On
// 2026-09-10 he changed that call: "你决定 我autocount parallel run而已" — the
// AutoCount book is a parallel run, nobody works off it, and it is not worth
// cancelling a live purchase order to make it match on two documents.
//
// WHAT DIVERGED, so the record is not lost. Both sales orders were edited in
// the ERP to DIFFERENT items than the book holds (013346: book HOK-5540 SOFA +
// HOK-SQUARE PILLOW, ERP 8030-2S + AMN-SOFA PILLOW; 009373: book HOK-2041 (A)(Q)
// vs ERP TRION bedframe, and AK- vs AKEMI codes). The book's OLD items are
// transferred to a purchase order (tPOQty > 0), so AutoCount refuses both an
// edit and a rebuild — the transferred line cannot be cleared. There is no
// matching PO in the ERP to sync down (the transfer-chain probe shows every ERP
// line as parents=[none]), so nothing on our side can reduce the book's PO. The
// only way to make the book match would be to CANCEL that live PO in AutoCount,
// which is a procurement decision, not a sync — deferred to a manual AC
// reconcile. The ERP is correct; the book keeps its old copy of these two.
//
// REVERSAL: UPDATE scm.autocount_outbox SET archived_at = NULL WHERE
// doc_no = ANY(ARRAY['HC-SO-013346','HC-SO-009373']) AND company_id = 1;
//
// RE-RUN: idempotent. Rows already archived are left alone.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const MODE = process.env.MODE ?? 'plan';
const CONFIRM = process.env.CONFIRM ?? '';
const APPLY = MODE === 'apply';

const DOC_NOS = ['HC-SO-013346', 'HC-SO-009373'];
const COMPANY_ID = 1;
const CONFIRM_PHRASE = 'ARCHIVE-013346-009373';

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
  const rows = await pg`
    SELECT doc_no, id, op, status, attempts, archived_at
      FROM scm.autocount_outbox
     WHERE doc_no = ANY(${DOC_NOS})
       AND company_id = ${COMPANY_ID}`;

  const perDoc = new Map();
  for (const r of rows) {
    const arr = perDoc.get(r.doc_no) ?? [];
    arr.push(r);
    perDoc.set(r.doc_no, arr);
  }
  console.log('BEFORE:');
  for (const d of DOC_NOS) {
    const items = perDoc.get(d) ?? [];
    const live = items.filter((r) => r.archived_at === null).length;
    console.log(`  ${d}: ${items.length} row(s), ${live} live, ${items.length - live} already archived`);
  }

  const totalLive = rows.filter((r) => r.archived_at === null).length;
  console.log(`TOTAL to archive: ${totalLive}`);

  if (totalLive === 0) {
    console.log('OK — nothing to do.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`DRY-RUN — no write. Would set archived_at = now() on ${totalLive} row(s).`);
    console.log(`Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} to write.`);
    process.exit(0);
  }

  const written = await pg`
    UPDATE scm.autocount_outbox
       SET archived_at = now()
     WHERE doc_no = ANY(${DOC_NOS})
       AND company_id = ${COMPANY_ID}
       AND archived_at IS NULL
     RETURNING id`;
  console.log('WROTE:', written.length, 'row(s)');
} finally {
  await pg.end();
}

// Fresh connection + SHAPE check: every row for these two docs must now carry
// archived_at. A row count is not proof.
const pg2 = postgres(url, { ssl: 'require', prepare: false, max: 1 });
try {
  const after = await pg2`
    SELECT doc_no, count(*) FILTER (WHERE archived_at IS NULL)::int AS still_live
      FROM scm.autocount_outbox
     WHERE doc_no = ANY(${DOC_NOS})
       AND company_id = ${COMPANY_ID}
     GROUP BY doc_no`;
  console.log('AFTER:', JSON.stringify(after));

  if (!APPLY) process.exit(0);

  const stillLive = after.reduce((a, r) => a + Number(r.still_live), 0);
  if (stillLive > 0) {
    console.error(`POST-CHECK FAILED — ${stillLive} row(s) still not archived`);
    process.exit(1);
  }
  console.log('OK — both docs archived. UI Not Accepted drops by 2.');
} finally {
  await pg2.end();
}
