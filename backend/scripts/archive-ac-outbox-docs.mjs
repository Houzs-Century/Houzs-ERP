// Archive the AutoCount outbox rows for a caller-supplied list of documents,
// so a document whose work is over (or which the owner has decided the parallel
// book need not match) leaves the Not Accepted list without a code change.
//
// WHY A GENERAL TOOL. Five single-document repair scripts were written in one
// day to archive stuck rows (CELENE, the rebuild-refused set, the keyless
// DO/GR set, the two diverged SOs). Each was a PR-merge-dispatch round trip for
// what is the same one-line write. This is that write, once, driven by an
// input, so the next "clear this document off the list" is a single dispatch.
//
// ARCHIVE, NEVER DELETE. `archived_at = now()` only; `status` and `last_error`
// are untouched, so every verdict function reads an archived row the same as a
// live one and the row comes back by clearing one column. 0277's COMMENT ON
// TABLE forbids DELETE ("this is the audit trail of what the ERP told
// AutoCount"), and the owner's standing ERP rule is never delete, only cancel.
//
// SCOPE IS EXPLICIT. It archives ONLY the doc_nos named in DOC_NOS, under one
// company. It never sweeps by status or age — a tool that could archive "all
// skipped" is a tool that hides a genuinely stuck document from the one screen
// meant to show it.
//
// REVERSAL: UPDATE scm.autocount_outbox SET archived_at = NULL WHERE
// doc_no = ANY(<the list>) AND company_id = <company>;
//
// RE-RUN: idempotent. Rows already archived are left alone; a doc_no with no
// rows is reported, not an error.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const MODE = process.env.MODE ?? 'plan';
const CONFIRM = process.env.CONFIRM ?? '';
const APPLY = MODE === 'apply';
const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
const CONFIRM_PHRASE = 'ARCHIVE-THESE-AC-DOCS';

const DOC_NOS = (process.env.DOC_NOS ?? '')
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

if (DOC_NOS.length === 0) {
  console.error('no DOC_NOS — pass a comma/space separated list of document numbers');
  process.exit(1);
}
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

console.log(`docs: ${DOC_NOS.join(', ')}  company: ${COMPANY_ID}  mode: ${MODE}`);

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  const rows = await pg`
    SELECT doc_no, id, op, status, archived_at
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
    console.log(`  ${d}: ${items.length} row(s), ${live} live, ${items.length - live} already archived`
      + (items.length === 0 ? '  (no outbox row for this doc)' : ''));
  }

  const totalLive = rows.filter((r) => r.archived_at === null).length;
  console.log(`TOTAL live to archive: ${totalLive}`);

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

// Fresh connection + SHAPE check: no named doc may have a live row left.
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
  console.log(`OK — ${DOC_NOS.length} document(s) archived off Not Accepted.`);
} finally {
  await pg2.end();
}
