#!/usr/bin/env node
/* Make the ERP's queue agree with the account book for THREE documents that were
   put into AED_HOUZS by hand.

   WHAT HAPPENED. On 2026-08-17 around 01:00 MYT three documents were written to
   the production AutoCount book by calling AcSyncService DIRECTLY on the
   shop-floor host, bypassing the outbox drain. Read back out of the book by
   direct SQL against AED_HOUZS the same night:

     DO  HC-DO-2608-001  300-C002  Cancelled=F  2 lines, Qty 1.0  FromDocType=SO FromDocNo=HC-SO-2608-003
     DO  HC-DO-2608-002  300-C002  Cancelled=F  2 lines, Qty 1.0  FromDocType=SO FromDocNo=HC-SO-2608-002
     IV  HC-SI-2608-001  300-C002  Cancelled=F  2 lines, Qty 1.0  FromDocType=DO FromDocNo=HC-DO-2608-002

   and the source lines now carry TransferedQty = 1.0 on HC-SO-2608-002 and
   HC-SO-2608-003 (seq 16 and 32 on each).

   THE ERP DOES NOT KNOW. The drain never ran for these, so their outbox rows
   still read as backlog and their ERP documents still carry no linked_ac_docno.

   WHY THAT IS URGENT AND NOT UNTIDY. `status` is the ONLY thing standing between
   these rows and a SECOND copy of a live accounting document:

     - requeueOutboxRow (the AutoCount Sync page's per-row "Send again") refuses
       `sent` outright and nothing else on the failed rows' path refuses them:
       #2330 made a FAILED transfer re-sendable, and #2331 gave the re-send the
       row's own dedupe key. transferVerdict's duplicate guard reads
       linked_ac_docno, which is NULL on all three, so it does not fire either.
     - acRowIsRequeueable, the button-visibility hint, returns true for a FAILED
       transfer row, so the button is ON SCREEN today.

   Whether AutoCount refuses a duplicate DocNo or writes a second voucher has
   NOT been tested and must not be tested by finding out. Setting `status =
   'sent'` closes it at the one rung of the ladder that has no exception
   (requeueOneRow's `if (status === 'sent')`), and writing linked_ac_docno closes
   it a second, independent time at transferVerdict's own guard.

   FIVE ROWS, THREE DOCUMENTS — measured, not assumed. The first PLAN dispatch
   (run 31985282257, 2026-08-17) refused because it expected one outbox row per
   document and found five. Both delivery orders carry TWO `so_to_do` rows: the
   original, annotated `[re-queued 2026-08-16T15:12…]` when somebody pressed
   Send again yesterday, and the fresh row that press inserted, which then
   failed with `Invalid transfer item.` on all six attempts. Only the fresh one
   is live. The annotated predecessor is already inert — the marker is its own
   rung on the ladder (`already-requeued`, checked before status or payload) —
   so this repair leaves it exactly as it is. Nothing was ever sent for that
   row, and `annotate` declined to move its status for precisely that reason.

   WHAT THIS WRITES, per LIVE row, and nothing else:

     scm.autocount_outbox   status = 'sent', ac_doc_no, sent_at, last_error
                            prefixed with the repair marker, updated_at
     the ERP document       linked_ac_docno = the AutoCount DocNo

   `attempts` is left alone: nothing about the attempts changed, and 6 of 6 is
   still what the queue tried. `sent_at` is the REPAIR time, not the time the
   host call landed — the book has the real timestamp and this column has never
   claimed to be the account book's clock. The original `last_error` is kept
   whole behind the marker, because scm.autocount_outbox is an audit trail
   (0277's own COMMENT ON TABLE) and the refusal that happened is still a fact.
   A `sent` row's `last_error` is invisible on the AutoCount Sync page —
   routes/autocount-outbox.ts:176 computes `reason_kind` only for `skipped`, and
   acRowDetail suppresses `said` when the state is `sent` — so the note costs the
   reader nothing.

   WHAT IT DOES NOT WRITE. The DtlKeys of the lines AutoCount created. The drain
   would have stored them through persistLineKeys from the service's reply, and
   this repair never spoke to the service, so it does not have them. The cost is
   named rather than papered over: composeEdit REFUSES an edit of a document
   whose lines carry no linked_ac_dtlkey, so these three cannot be edited through
   the write-back until somebody backfills the keys from the book. A refused edit
   is the safe direction — a WRONG key silently rewrites a different line in a
   live book.

   THE THREE ARE HARD-CODED. There is no parameter that can point this at another
   document. DOC may narrow the run to one of the three by name and is refused
   for anything else: a repair that can mark an arbitrary document `sent` is a
   worse hazard than the one it fixes, because `sent` is precisely the state that
   makes the ERP stop asking.

   RE-RUN: safe, and a second run writes nothing. Every row it has already
   repaired carries the marker in `last_error` and is reported as
   already-repaired, and every UPDATE is additionally predicated on the status it
   expects to find, so a row that moved on its own matches nothing. A row that is
   `sent` WITHOUT the marker is not a no-op and not a re-repair — it means the
   drain sent something this script does not know about, so the run REFUSES and
   exits 3 rather than deciding for you. So does a pending row for any of the
   three, which would mean a second copy is already in flight.

   MODE=plan (default) runs every write inside a transaction and ROLLS BACK, so
   the plan proves the predicates match real rows without keeping anything.
   MODE=apply requires CONFIRM="I HAVE SEEN ALL THREE IN AED_HOUZS". */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE SEEN ALL THREE IN AED_HOUZS';
const CO = Number(process.env.COMPANY || 1);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** Prefix on the repaired row's `last_error`. Deliberately not `[re-queued`,
 *  which acOutboxState reads as a re-queue marker on skipped/failed rows. */
const REPAIR_NOTE_PREFIX = '[sent by hand, outbox repaired';

/** What annotate() writes on a skip the re-queue tool has replaced. Its own
 *  rung: requeueOneRow answers `already-requeued` to any row carrying it,
 *  before status or payload are looked at, and acOutboxState maps it to
 *  `requeued` so the page files the row as history. Copied as a STRING because
 *  the definition is TypeScript in backend/src and this is plain node; the
 *  string is the wire format both sides already agree on. */
const REQUEUE_NOTE_PREFIX = '[re-queued';
const isSettledPredecessor = (r) => String(r.last_error ?? '').startsWith(REQUEUE_NOTE_PREFIX);

/* THE THREE, and the whole list. Every field is a measurement from the account
   book or a column name from DOWNSTREAM in scm/lib/autocount-outbox.ts, not
   something derived at run time. `acDocNo` equals `docNo` on all three because
   a transfer sends the ERP's own number as the AutoCount DocNo, and the book
   was read back to confirm it rather than assumed. */
const REPAIRS = [
  {
    docNo: 'HC-DO-2608-001', docType: 'DO', op: 'so_to_do', expectStatus: 'failed',
    acDocNo: 'HC-DO-2608-001', fromDocNo: 'HC-SO-2608-003',
    erpTable: 'delivery_orders',
  },
  {
    docNo: 'HC-DO-2608-002', docType: 'DO', op: 'so_to_do', expectStatus: 'failed',
    acDocNo: 'HC-DO-2608-002', fromDocNo: 'HC-SO-2608-002',
    erpTable: 'delivery_orders',
  },
  {
    docNo: 'HC-SI-2608-001', docType: 'IV', op: 'do_to_iv', expectStatus: 'skipped',
    acDocNo: 'HC-SI-2608-001', fromDocNo: 'HC-DO-2608-002',
    erpTable: 'sales_invoices',
  },
];

const ALLOWED_DOCS = new Set(REPAIRS.map((r) => r.docNo));

/* `all` and empty both mean all three. Anything else must be one of the three
   BY NAME — a repair that can be pointed at an arbitrary document is a worse
   hazard than the one it fixes. */
const raw = (process.env.DOC || '').trim();
const only = raw.toLowerCase() === 'all' ? '' : raw;
if (only && !ALLOWED_DOCS.has(only)) {
  bad(`DOC="${only}" is not one of the three this repair knows: ${[...ALLOWED_DOCS].join(', ')}`);
  process.exit(2);
}
const planned = only ? REPAIRS.filter((r) => r.docNo === only) : REPAIRS;

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const pad = (v, n) => String(v ?? '').padEnd(n);

/* THE TWO TABLES ARE SPELLED OUT IN SQL, never interpolated as an identifier.
   postgres.js would accept `sql(\`scm.${t}\`)` and escape it, but an identifier
   assembled at run time is a table name this file cannot be read to know, and
   the whole point of the hard-coded list above is that a reader can see every
   table this repair can reach. Keyed lookups, so a name not in the map throws
   rather than falling through to a default.
   `id::text` on both sides of every comparison: delivery_orders and
   sales_invoices do not have to agree on their key type for this to be right. */
const READ_ERP = {
  delivery_orders: (q, docNo) => q`
    SELECT id::text AS id, linked_ac_docno FROM scm.delivery_orders
     WHERE company_id = ${CO} AND do_number = ${docNo}`,
  sales_invoices: (q, docNo) => q`
    SELECT id::text AS id, linked_ac_docno FROM scm.sales_invoices
     WHERE company_id = ${CO} AND invoice_number = ${docNo}`,
};
const LINK_ERP = {
  delivery_orders: (q, id, acDocNo) => q`
    UPDATE scm.delivery_orders SET linked_ac_docno = ${acDocNo}
     WHERE id::text = ${id} AND company_id = ${CO} AND linked_ac_docno IS NULL
    RETURNING id::text AS id`,
  sales_invoices: (q, id, acDocNo) => q`
    UPDATE scm.sales_invoices SET linked_ac_docno = ${acDocNo}
     WHERE id::text = ${id} AND company_id = ${CO} AND linked_ac_docno IS NULL
    RETURNING id::text AS id`,
};
const RECHECK_ERP = {
  delivery_orders: (q, ids) => q`
    SELECT id::text AS id, linked_ac_docno FROM scm.delivery_orders
     WHERE company_id = ${CO} AND id::text = ANY(${ids})`,
  sales_invoices: (q, ids) => q`
    SELECT id::text AS id, linked_ac_docno FROM scm.sales_invoices
     WHERE company_id = ${CO} AND id::text = ANY(${ids})`,
};

/* A checker that cannot match reports a clean run. Every hard-coded row must
   resolve to a statement in all three maps before anything is read. */
for (const r of REPAIRS) {
  if (!READ_ERP[r.erpTable] || !LINK_ERP[r.erpTable] || !RECHECK_ERP[r.erpTable]) {
    bad(`${r.docNo}: scm.${r.erpTable} has no spelled-out statement in this script`);
    process.exit(2);
  }
}

/** Refuse the whole run. A precondition that does not hold means the world is
 *  not the one this repair was written against, and guessing which half is
 *  right is exactly what a repair script must never do. */
const refusals = [];
const refuse = (m) => { refusals.push(m); bad(m); };

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (everything rolls back)'} company=${CO} documents=${planned.map((r) => r.docNo).join(', ')}`);

  const docNos = planned.map((r) => r.docNo);
  const rows = await sql`
    SELECT id::text AS id, company_id, op, doc_type, doc_no, doc_id, status,
           attempts, last_error, ac_doc_no, sent_at,
           payload #>> '{writeback,table}'  AS wb_table,
           payload #>> '{writeback,keyCol}' AS wb_keycol,
           payload #>> '{writeback,key}'    AS wb_key,
           coalesce(payload #> '{body}', '{}'::jsonb) = '{}'::jsonb AS body_empty
      FROM scm.autocount_outbox
     WHERE company_id = ${CO} AND doc_no = ANY(${docNos})
     ORDER BY doc_no, created_at`;

  note(`\n=== EVERY OUTBOX ROW FOR THESE ${docNos.length} DOCUMENT(S) — ${rows.length} found ===`);
  note(`  ${pad('doc_no', 18)} ${pad('op', 10)} ${pad('status', 9)} att  ${pad('ac_doc_no', 16)} writeback / reason`);
  for (const r of rows) {
    const wb = r.wb_table ? `${r.wb_table}.${r.wb_keycol}=${r.wb_key}` : `no writeback (body_empty=${r.body_empty})`;
    note(`  ${pad(r.doc_no, 18)} ${pad(r.op, 10)} ${pad(r.status, 9)} ${pad(r.attempts, 3)}  ${pad(r.ac_doc_no ?? '-', 16)} ${wb}`);
    if (r.last_error) note(`      reason: ${String(r.last_error).slice(0, 240)}`);
  }

  /* THE FACTS THE RE-SEND LADDER READS, printed rather than re-implemented.
     autocount-requeue.ts is the ONE answer to "may this be sent again" and a
     second copy of its rule living in a script is the drift this repo has paid
     for twice. So this prints the recorded columns and names the rung. */
  note(`\n=== IS THE DUPLICATE-SEND WINDOW OPEN RIGHT NOW ===`);
  note(`  requeueOneRow refuses a row outright when status = 'sent', and that rung has no exception.`);
  note(`  transferVerdict re-sends a TRANSFER when status = 'failed' AND the payload is composed`);
  note(`  AND the ERP document carries no linked_ac_docno. acRowIsRequeueable puts the "Send again"`);
  note(`  button on a FAILED transfer row. Read the columns above against those two sentences.`);

  const pending = rows.filter((r) => r.status === 'pending');
  if (pending.length) {
    refuse(`${pending.length} PENDING outbox row(s) for these documents: ${pending.map((r) => `${r.doc_no}/${r.id}`).join(', ')}. `
      + 'The drain is already going to send them, which would put a SECOND copy in the book. '
      + 'Deal with that first — this repair will not race it.');
  }

  const superseded = rows.filter(isSettledPredecessor);
  if (superseded.length) {
    note(`\n=== SUPERSEDED PREDECESSORS — settled already, left exactly as they are ===`);
    for (const r of superseded) note(`  ${pad(r.doc_no, 18)} ${pad(r.id, 38)} ${r.status} + the re-queue marker`);
    note(`  requeueOneRow answers 'already-requeued' to a row carrying that marker, before it looks at`);
    note(`  anything else, and acOutboxState reads it as 'requeued' so the page counts it as history.`);
    note(`  Nothing was ever sent FOR these rows, so marking them 'sent' would be the lie annotate()`);
    note(`  declined to tell when it left their status alone.`);
  }

  const work = [];
  const doneAlready = [];
  for (const spec of planned) {
    const mine = rows.filter((r) => r.doc_no === spec.docNo && r.op === spec.op);
    /* ONE LIVE ROW PER DOCUMENT, not one row. Both delivery orders carry a
       re-queued predecessor as well: the button was pressed on 2026-08-16
       15:12, which annotated the original and inserted a fresh row, and that
       fresh row is the one that then failed. The predecessor is already inert
       — the marker is its own rung on the ladder — so the live row is the one
       WITHOUT it, and there must be exactly one. */
    const live = mine.filter((r) => !isSettledPredecessor(r));
    if (live.length !== 1) {
      refuse(`${spec.docNo}: expected exactly one live ${spec.op} outbox row, found ${live.length} `
        + `(${mine.length} row(s) in total, ${mine.length - live.length} already superseded)`);
      continue;
    }
    const row = live[0];
    if (row.doc_type !== spec.docType) {
      refuse(`${spec.docNo}: outbox doc_type is ${row.doc_type}, expected ${spec.docType}`);
      continue;
    }

    const repaired = String(row.last_error ?? '').startsWith(REPAIR_NOTE_PREFIX);
    if (row.status === 'sent' && repaired) { doneAlready.push({ spec, row }); continue; }
    if (row.status === 'sent') {
      refuse(`${spec.docNo}: the outbox row is ALREADY 'sent' and carries no repair marker, so the drain `
        + `sent something this script does not know about (ac_doc_no=${row.ac_doc_no ?? 'null'}, sent_at=${row.sent_at ?? 'null'}). `
        + 'Look in the book before anything else runs.');
      continue;
    }
    if (row.status !== spec.expectStatus) {
      refuse(`${spec.docNo}: outbox status is '${row.status}', expected '${spec.expectStatus}'`);
      continue;
    }

    /* The ERP document, found by its NUMBER — the hard-coded half — and then
       cross-checked against the row's own doc_id and, where the payload has
       one, against the writeback target the drain itself would have used.
       Three independent identifications that must agree. */
    const found = await READ_ERP[spec.erpTable](sql, spec.docNo);
    if (found.length !== 1) {
      refuse(`${spec.docNo}: expected exactly one scm.${spec.erpTable} row, found ${found.length}`);
      continue;
    }
    const erp = found[0];
    if (row.doc_id && String(row.doc_id) !== erp.id) {
      refuse(`${spec.docNo}: outbox doc_id ${row.doc_id} is not the ERP row id ${erp.id}`);
      continue;
    }
    if (row.wb_table && (row.wb_table !== spec.erpTable || row.wb_keycol !== 'id' || row.wb_key !== erp.id)) {
      refuse(`${spec.docNo}: the payload's writeback target ${row.wb_table}.${row.wb_keycol}=${row.wb_key} `
        + `is not scm.${spec.erpTable}.id=${erp.id}`);
      continue;
    }
    if (erp.linked_ac_docno && erp.linked_ac_docno !== spec.acDocNo) {
      refuse(`${spec.docNo}: scm.${spec.erpTable} already links to AutoCount document `
        + `"${erp.linked_ac_docno}", not "${spec.acDocNo}"`);
      continue;
    }

    work.push({ spec, row, erpId: erp.id, linkAlready: erp.linked_ac_docno === spec.acDocNo });
  }

  if (doneAlready.length) {
    note(`\n=== ALREADY REPAIRED BY AN EARLIER RUN — untouched ===`);
    for (const d of doneAlready) note(`  ${pad(d.spec.docNo, 18)} sent_at=${d.row.sent_at} ac_doc_no=${d.row.ac_doc_no}`);
  }
  if (refusals.length) {
    bad(`\n${refusals.length} precondition(s) failed. NOTHING was written.`);
    await sql.end({ timeout: 5 });
    process.exit(3);
  }
  if (!work.length) {
    note(`\nNothing to repair — all ${planned.length} document(s) already agree with the book.`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== PLAN — ${work.length} document(s) ===`);
  for (const w of work) {
    note(`  ${pad(w.spec.docNo, 18)} outbox ${w.row.id}: ${w.row.status} -> sent, ac_doc_no=${w.spec.acDocNo}`);
    note(`  ${pad('', 18)} scm.${w.spec.erpTable}.id=${w.erpId}: linked_ac_docno ${w.linkAlready ? 'already set, untouched' : `null -> ${w.spec.acDocNo}`}`);
    note(`  ${pad('', 18)} the book has it as ${w.spec.docType} ${w.spec.acDocNo} from ${w.spec.fromDocNo}`);
  }

  const at = new Date().toISOString();
  let outboxWrote = 0;
  let linkWrote = 0;
  const expectLinks = work.filter((w) => !w.linkAlready).length;
  const ROLLBACK = Symbol('plan rollback');
  try {
    await sql.begin(async (tx) => {
      for (const w of work) {
        const marker = `${REPAIR_NOTE_PREFIX} ${at}] AcSyncService was called directly on the host, so the `
          + `queue never sent this; the book holds ${w.spec.docType} ${w.spec.acDocNo}. Original reason: `;
        /* Predicated on the status this run READ, so a concurrent drain or
           button press between the read and the write matches nothing and the
           row-count check below rolls the whole transaction back. */
        const back = await tx`
          UPDATE scm.autocount_outbox
             SET status = 'sent',
                 ac_doc_no = ${w.spec.acDocNo},
                 sent_at = ${at}::timestamptz,
                 last_error = ${marker} || coalesce(last_error, ''),
                 updated_at = ${at}::timestamptz
           WHERE id::text = ${w.row.id} AND company_id = ${CO} AND status = ${w.spec.expectStatus}
          RETURNING id::text AS id`;
        outboxWrote += back.length;

        if (w.linkAlready) continue;
        const link = await LINK_ERP[w.spec.erpTable](tx, w.erpId, w.spec.acDocNo);
        linkWrote += link.length;
      }
      note(`\n${APPLY ? 'wrote' : 'would write'}: ${outboxWrote} outbox row(s), ${linkWrote} linked_ac_docno`);
      if (outboxWrote !== work.length || linkWrote !== expectLinks) {
        throw new Error(`expected ${work.length} outbox + ${expectLinks} link, got ${outboxWrote} + ${linkWrote} — refusing`);
      }
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note(`PLAN: transaction rolled back, nothing was written.`);
    note(`Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to keep it.`);
    await sql.end({ timeout: 5 });
    return;
  }

  // Verify on a FRESH connection: the session that wrote is the worst witness.
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const after = await check`
      SELECT o.doc_no, o.id::text AS id, o.status, o.ac_doc_no,
             o.sent_at::text AS sent_at, o.attempts,
             left(o.last_error, 40) AS note_head
        FROM scm.autocount_outbox o
       WHERE o.company_id = ${CO} AND o.doc_no = ANY(${work.map((w) => w.spec.docNo)})
       ORDER BY o.doc_no`;

    /* THE SHAPE, not the count. A repair of the jsonb double-encoding COE
       reported 7 of 7 while re-corrupting all 7, because it counted instead of
       looking. So every value written is read back and compared to the value
       this script intended, one document at a time. */
    const wrong = [];
    for (const w of work) {
      const got = after.filter((r) => r.doc_no === w.spec.docNo && r.id === w.row.id);
      if (got.length !== 1) { wrong.push(`${w.spec.docNo}: ${got.length} rows read back, expected 1`); continue; }
      const r = got[0];
      if (r.status !== 'sent') wrong.push(`${w.spec.docNo}: status is "${r.status}", not "sent"`);
      if (r.ac_doc_no !== w.spec.acDocNo) wrong.push(`${w.spec.docNo}: ac_doc_no is "${r.ac_doc_no}", not "${w.spec.acDocNo}"`);
      if (typeof r.sent_at !== 'string' || !r.sent_at) wrong.push(`${w.spec.docNo}: sent_at is ${typeof r.sent_at} "${r.sent_at}", expected a timestamp`);
      if (!String(r.note_head).startsWith(REPAIR_NOTE_PREFIX)) wrong.push(`${w.spec.docNo}: last_error does not start with the repair marker, it starts "${r.note_head}"`);
      note(`  ${pad(r.doc_no, 18)} status=${pad(r.status, 8)} ac_doc_no=${pad(r.ac_doc_no, 16)} attempts=${r.attempts} sent_at=${r.sent_at}`);
    }

    for (const table of new Set(work.map((w) => w.spec.erpTable))) {
      const mine = work.filter((w) => w.spec.erpTable === table);
      const links = await RECHECK_ERP[table](check, mine.map((w) => w.erpId));
      for (const w of mine) {
        const got = links.find((l) => l.id === w.erpId);
        if (!got) { wrong.push(`${w.spec.docNo}: scm.${table} row ${w.erpId} could not be read back`); continue; }
        if (got.linked_ac_docno !== w.spec.acDocNo) {
          wrong.push(`${w.spec.docNo}: scm.${table}.linked_ac_docno is "${got.linked_ac_docno}", not "${w.spec.acDocNo}"`);
        }
        note(`  ${pad(w.spec.docNo, 18)} scm.${table}.linked_ac_docno=${got.linked_ac_docno}`);
      }
    }

    /* THE WINDOW IS CLOSED when every row for these documents is refused by one
       of requeueOneRow's two unconditional rungs: `status === 'sent'` (no
       exception, checked by the ladder AND by both entry points) or the
       re-queue marker on last_error (`already-requeued`, checked before status
       or payload). Asserted over EVERY row, not only the ones written — a row
       this run never touched can still be re-sendable. */
    const open = await check`
      SELECT doc_no, id::text AS id, status, left(coalesce(last_error, ''), 30) AS note_head
        FROM scm.autocount_outbox
       WHERE company_id = ${CO} AND doc_no = ANY(${work.map((w) => w.spec.docNo)})
         AND status <> 'sent'
         AND coalesce(last_error, '') NOT LIKE ${`${REQUEUE_NOTE_PREFIX}%`}`;
    if (open.length) {
      wrong.push(`${open.length} outbox row(s) for these documents are neither 'sent' nor superseded, so `
        + `the ladder can still re-send them: ${open.map((r) => `${r.doc_no}/${r.id}/${r.status}`).join(', ')}`);
    } else {
      note(`  every outbox row for these documents is now either 'sent' or carries the re-queue marker,`);
      note(`  and requeueOneRow refuses both of those before it reads anything else. Window closed.`);
    }

    if (wrong.length) {
      for (const m of wrong) bad(m);
      bad(`the re-read does NOT match what was intended — ${wrong.length} discrepancy(ies). Do not run this again until that is understood.`);
      await check.end({ timeout: 5 });
      process.exit(4);
    }
    note(`  every value read back equals the value this run intended.`);

    note(`\n=== WHAT THIS RUN DID NOT CHECK ===`);
    note(`  It CANNOT see the account book. There is no AutoCount connection in this script and no`);
    note(`  reachable one from CI. So it asserts only that the ERP now CLAIMS what a human measured`);
    note(`  in AED_HOUZS by direct SQL on 2026-08-17: DO HC-DO-2608-001, DO HC-DO-2608-002 and`);
    note(`  IV HC-SI-2608-001, all Cancelled=F. If that measurement was wrong, this run has made the`);
    note(`  ERP confidently wrong in the same direction, and nothing here would notice.`);
    note(`  It also did NOT store the AutoCount DtlKeys of the lines. The service was never asked, so`);
    note(`  the keys do not exist on this side; composeEdit will refuse an edit of these three until`);
    note(`  somebody backfills them from the book.`);
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
