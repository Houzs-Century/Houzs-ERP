// Read-only: WHY DELIVERY ORDERS HAVE A SOURCE LINE WITH NO ACCOUNT-BOOK KEY.
//
// Measured 2026-09-08 by check-so-to-do-line-divergence: of 245 delivery orders,
// 58 have a source sales-order line carrying no `linked_ac_dtlkey`. That is the
// backlog behind the owner's 「都解决」 — the ten stuck documents are cleared, and
// this population is the next thing that will stick.
//
// WHY A LINE HAS NO KEY IS NOT ONE ANSWER, and the remedies differ completely:
//
//   never in the book    the SALES ORDER itself never reached AutoCount, so no
//                        line of it can have a key. Nothing to relink — the
//                        document has to be created there first.
//   added after the fact a line the ERP ADDED to a document AutoCount already
//                        held. The book assigns the key on append and nothing
//                        carried it back until 2026-08-31 (docs/bugs/0583). The
//                        relink tool is the remedy.
//   never keyed          a MIGRATED document whose lines were matched by hand or
//                        not at all. The line-key backfill is the remedy.
//   service line         a fee the account book may legitimately not carry.
//
// It counts the population under each, so the next step is a decision and not a
// guess. It writes nothing.
//
// PUBLIC LOG. This repository and its Actions logs are public, so nothing here
// prints an item code, a customer or a price — counts and classified reasons
// only.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

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

/* Mirrored from scm/shared/service-sku.ts, the same expression the sibling probe
   uses: item_group contains SERVICE, or item_code starts with SVC- and is longer
   than the prefix. */
const SERVICE_SQL = (t) =>
  `(upper(coalesce(${t}.item_group, '')) LIKE '%SERVICE%'
    OR upper(coalesce(${t}.item_code, '')) LIKE 'SVC-_%')`;

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  console.log('=== 1. THE POPULATION ===');
  const pop = await pg.unsafe(`
    SELECT count(DISTINCT si.id)::int                                     AS keyless_so_lines,
           count(DISTINCT si.doc_no)::int                                 AS sales_orders,
           count(DISTINCT si.id) FILTER (WHERE ${SERVICE_SQL('si')})::int AS service_lines
      FROM scm.mfg_sales_order_items si
     WHERE si.linked_ac_dtlkey IS NULL`);
  const p = pop[0];
  console.log(`  sales-order lines with no book key: ${p.keyless_so_lines}`);
  console.log(`  across sales orders:                ${p.sales_orders}`);
  console.log(`  of which SERVICE lines:             ${p.service_lines}`);

  console.log('');
  console.log('=== 2. IS THE SALES ORDER ITSELF IN THE BOOK ===');
  console.log('(a line cannot have a key if its document was never created there)');
  const inBook = await pg.unsafe(`
    SELECT count(*)::int                                               AS keyless_lines,
           count(*) FILTER (WHERE so.linked_ac_docno IS NULL)::int     AS doc_not_in_book,
           count(*) FILTER (WHERE so.linked_ac_docno IS NOT NULL)::int AS doc_in_book
      FROM scm.mfg_sales_order_items si
      JOIN scm.mfg_sales_orders so ON so.doc_no = si.doc_no
     WHERE si.linked_ac_dtlkey IS NULL`);
  const b = inBook[0];
  console.log(`  keyless lines whose SALES ORDER is not in the book: ${b.doc_not_in_book}`);
  console.log(`  keyless lines whose sales order IS in the book:     ${b.doc_in_book}`);
  console.log('  the first group needs the document created; the second needs its lines matched.');

  console.log('');
  console.log('=== 3. WAS THE LINE ADDED AFTER THE DOCUMENT REACHED THE BOOK ===');
  console.log('(a line newer than its own document is the append case, docs/bugs/0583)');
  const added = await pg.unsafe(`
    SELECT count(*)::int AS in_book_keyless,
           count(*) FILTER (WHERE si.created_at > so.created_at + interval '1 minute')::int  AS added_later,
           count(*) FILTER (WHERE si.created_at <= so.created_at + interval '1 minute')::int AS there_from_the_start
      FROM scm.mfg_sales_order_items si
      JOIN scm.mfg_sales_orders so ON so.doc_no = si.doc_no
     WHERE si.linked_ac_dtlkey IS NULL AND so.linked_ac_docno IS NOT NULL`);
  const a = added[0];
  console.log(`  added to a document the book already had: ${a.added_later}`);
  console.log(`  present when the document was created:    ${a.there_from_the_start}`);

  console.log('');
  console.log('=== 4. HOW MANY ARE ACTUALLY BLOCKING A DELIVERY ===');
  console.log('(a keyless line only costs something when a delivery order needs it)');
  const blocking = await pg.unsafe(`
    SELECT count(DISTINCT d.id)::int                                     AS delivery_orders,
           count(DISTINCT d.id) FILTER (WHERE ${SERVICE_SQL('si')})::int AS with_a_service_line,
           count(DISTINCT si.doc_no)::int                                AS sales_orders
      FROM scm.delivery_orders d
      JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
      JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
     WHERE si.linked_ac_dtlkey IS NULL`);
  const k = blocking[0];
  console.log(`  delivery orders touching a keyless source line: ${k.delivery_orders}`);
  console.log(`  their sales orders:                             ${k.sales_orders}`);
  console.log(`  of those, ones whose keyless line is a SERVICE line: ${k.with_a_service_line}`);

  console.log('');
  console.log('=== 5. AND HOW MANY OF THOSE ARE ALREADY IN THE BOOK ANYWAY ===');
  console.log('(a delivery order already sent is not a backlog item, whatever its lines say)');
  const sent = await pg.unsafe(`
    WITH touched AS (
      SELECT DISTINCT d.id
        FROM scm.delivery_orders d
        JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
        JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
       WHERE si.linked_ac_dtlkey IS NULL
    )
    SELECT count(*)::int                                      AS touched,
           count(*) FILTER (WHERE o.status = 'sent')::int     AS already_sent,
           count(*) FILTER (WHERE o.status = 'failed')::int   AS failed,
           count(*) FILTER (WHERE o.status = 'skipped')::int  AS skipped,
           count(*) FILTER (WHERE o.status = 'pending')::int  AS pending,
           count(*) FILTER (WHERE o.id IS NULL)::int          AS never_queued
      FROM touched t
      LEFT JOIN LATERAL (
        SELECT id, status FROM scm.autocount_outbox
         /* CAST, because scm.autocount_outbox.doc_id is TEXT and
            scm.delivery_orders.id is a uuid — Postgres has no text = uuid
            operator and the whole section died on it. */
         WHERE op = 'so_to_do' AND doc_id = t.id::text
         ORDER BY created_at DESC LIMIT 1
      ) o ON true`);
  const s = sent[0];
  console.log(`  delivery orders touching a keyless line: ${s.touched}`);
  console.log(`    already SENT to the book: ${s.already_sent}`);
  console.log(`    failed:                   ${s.failed}`);
  console.log(`    skipped:                  ${s.skipped}`);
  console.log(`    pending:                  ${s.pending}`);
  console.log(`    never queued at all:      ${s.never_queued}`);
  console.log('');
  console.log('');
  console.log('=== 6. NEVER QUEUED IS NOT THE SAME AS MISSING ===');
  console.log('(a delivery order the ERP never queued may already be in the book, from the migration)');
  /* THE QUESTION SECTION 5 RAISES AND CANNOT ANSWER. Every one of the 58 came
     back `never queued at all` — no outbox row was ever written for them. That
     reads as alarming and may be the opposite: a document brought IN from
     AutoCount during the cutover is already there, so there was never anything
     to send. `linked_ac_docno` is what tells the two apart, and getting this
     backwards would put a repair on documents that need none. */
  const linked = await pg.unsafe(`
    WITH touched AS (
      SELECT DISTINCT d.id, d.linked_ac_docno, d.created_at
        FROM scm.delivery_orders d
        JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
        JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
       WHERE si.linked_ac_dtlkey IS NULL
    )
    SELECT count(*)::int                                                 AS touched,
           count(*) FILTER (WHERE linked_ac_docno IS NOT NULL)::int      AS already_in_the_book,
           count(*) FILTER (WHERE linked_ac_docno IS NULL)::int          AS not_in_the_book,
           min(created_at)::date::text                                   AS oldest,
           max(created_at)::date::text                                   AS newest
      FROM touched`);
  const l = linked[0];
  console.log(`  delivery orders touching a keyless line: ${l.touched}`);
  console.log(`    ALREADY carry an AutoCount document number: ${l.already_in_the_book}`);
  console.log(`    carry none:                                 ${l.not_in_the_book}`);
  console.log(`  raised between ${l.oldest} and ${l.newest}`);
  console.log('');
  console.log('  A document that already carries an AutoCount number is IN the book and needs');
  console.log('  no repair — it was never queued because it never had to be. Only the second');
  console.log('  row is a backlog, and only then if the ERP should have sent it.');

  console.log('READ IT LIKE THIS: the ones already SENT cost nothing and need no repair.');
  console.log('What is left after them is the real backlog, and sections 2 and 3 say which');
  console.log('remedy each part of it takes.');
} catch (e) {
  console.error('DB unreachable or query failed:', e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
