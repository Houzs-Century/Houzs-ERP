// Archive the outbox rows for every document on the AutoCount Sync page's
// Not Accepted tab EXCEPT the two the owner is handling personally in AC
// (HC-SO-013346, HC-SO-009373). Owner ruling 2026-09-10: 「全部clear掉」.
//
// WHAT EACH DOC IS. Grouped by the class of refusal:
//
//   rebuild-refused (edit) — the composer's re-queue picks REBUILD and the
//   host guards against a rebuild that would clear a line already transferred
//   downstream. The document IS in AutoCount from an earlier save; only the
//   most recent edit did not land. Archiving accepts the account book is one
//   edit behind.
//
//     HC-PO-2609-055, HC-SO-004725, HC-SO-012629
//
//   keyless (edit) — a DO / GR line carries no linked_ac_dtlkey so the
//   composer refuses rather than duplicate lines. Archiving accepts the doc
//   sits out of AutoCount until it is saved in the ERP by hand (or until the
//   composer is extended to build DO/GR line identity — that is a separate
//   PR).
//
//     HC-GRN-2609-008,
//     DOs 21924489-8e6d-4ff2-843b-bb33c92bc284, 8b631d05-bf93-4c96-833f-9a1313b00eac,
//         c8937b75-8e16-422c-a872-9db1a736d8d5, a78a6933-dd10-4263-a647-0eb522535a9c
//
//   desc2-too-long (edit) — a DO Description 2 is over AutoCount's
//   nvarchar(100). The pointer path (SPECIAL_ORDER_POINTER) is applied on the
//   next SAVE, which conversions do not trigger. Archiving = defer to next
//   save.
//
//     DO c1b5bef5-0978-4206-9759-031396b5529f
//
//   already-in-book (so_to_do) — probe-doc-writeback confirmed both are in
//   AutoCount already; the outbox row's `failed` status is history and the
//   documents are synced.
//
//     HC-DO-2609-004, HC-DO-2609-009
//
// The row is ARCHIVED (`archived_at = now()`), not deleted, per 0277's own
// COMMENT ON TABLE: "Never delete rows: this is the audit trail of what the
// ERP told AutoCount". `status` and `last_error` stay as they are, so
// `acOutboxState`, `isRequeuedNote`, `classifyAcSkip` and `acNeedsAttention`
// reach the same verdict; the row is one column away from coming back.
//
// REVERSAL: UPDATE scm.autocount_outbox SET archived_at = NULL WHERE (doc_no,
// company_id) IN (<list below>);
//
// RE-RUN: idempotent. Any row already archived is left alone.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const MODE = process.env.MODE ?? 'plan';
const CONFIRM = process.env.CONFIRM ?? '';
const APPLY = MODE === 'apply';

const COMPANY_ID = 1;
const CONFIRM_PHRASE = 'ARCHIVE-REMAINING-AC-BACKLOG';

// Every doc_no the owner has said to clear. HC-SO-013346 and HC-SO-009373 are
// EXCLUDED on purpose — the owner is aligning those two in AC by hand.
const DOC_NOS = [
  'HC-PO-2609-055',
  'HC-SO-004725',
  'HC-SO-012629',
  'HC-GRN-2609-008',
  '21924489-8e6d-4ff2-843b-bb33c92bc284',
  '8b631d05-bf93-4c96-833f-9a1313b00eac',
  'c8937b75-8e16-422c-a872-9db1a736d8d5',
  'a78a6933-dd10-4263-a647-0eb522535a9c',
  'c1b5bef5-0978-4206-9759-031396b5529f',
  'HC-DO-2609-004',
  'HC-DO-2609-009',
];

// Safety guard the owner asked for explicitly: never archive rows for these
// two, in case a future call site accidentally appends them to DOC_NOS.
const FORBIDDEN = new Set(['HC-SO-013346', 'HC-SO-009373']);
for (const d of DOC_NOS) {
  if (FORBIDDEN.has(d)) {
    console.error(`REFUSED — DOC_NOS contains ${d} which the owner is handling in AC`);
    process.exit(1);
  }
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

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  const rows = await pg`
    SELECT doc_type, doc_no, op, status, archived_at, attempts, created_at
      FROM scm.autocount_outbox
     WHERE doc_no = ANY(${DOC_NOS})
       AND company_id = ${COMPANY_ID}
     ORDER BY doc_no, created_at`;

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
    const done = items.length - live;
    console.log(`  ${d}: ${items.length} row(s), ${live} live, ${done} already archived`);
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
     RETURNING id, doc_no`;

  console.log('WROTE:', written.length, 'row(s)');
} finally {
  await pg.end();
}

// FRESH CONNECTION + SHAPE check: every doc in DOC_NOS must now have
// archived_at NOT NULL on every one of its rows. A row count is not proof.
const pg2 = postgres(url, { ssl: 'require', prepare: false, max: 1 });
try {
  const after = await pg2`
    SELECT doc_no, count(*) FILTER (WHERE archived_at IS NULL)::int AS live_rows,
           count(*)::int AS total_rows
      FROM scm.autocount_outbox
     WHERE doc_no = ANY(${DOC_NOS})
       AND company_id = ${COMPANY_ID}
     GROUP BY doc_no
     ORDER BY doc_no`;

  console.log('AFTER:');
  for (const r of after) console.log(`  ${r.doc_no}: ${r.live_rows} live / ${r.total_rows} total`);

  if (!APPLY) {
    process.exit(0);
  }

  const stillLive = after.filter((r) => r.live_rows > 0);
  if (stillLive.length > 0) {
    console.error(`POST-CHECK FAILED — ${stillLive.length} doc(s) still have live outbox rows`);
    process.exit(1);
  }

  console.log('OK — all named doc(s) archived. UI Not Accepted count drops accordingly.');
} finally {
  await pg2.end();
}
