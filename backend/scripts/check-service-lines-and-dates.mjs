// Three questions the owner asked on 2026-09-09, answered against production
// rather than argued about.
//
//   1. SERVICE LINES. He ruled they DO belong on an AutoCount sales order —
//      「要进啊 我记得autocount也有这些code 我们也有的 你重新检查」 — so the
//      question is no longer whether they belong, it is why those lines carry no
//      book key. The account book's item map holds exactly five service items
//      (DISPOSE, STORAGE, RC-COM, RC-CUS, RC-TRP, all category SERVICE, no
//      supplier). This asks how many of our keyless service lines use a code the
//      book actually has.
//
//   2. THE DATE CONTRADICTION. 「我们昨天才开始在这套系统开的DO」 — delivery
//      orders only started being raised in this system on 2026-09-08. But
//      check-keyless-source-lines.mjs reports those 58 as raised 2026-06-26 to
//      2026-09-07, from `created_at`. One of the two is wrong. A contradiction
//      is a finding, not something to write a sentence around (CLAUDE.md), so
//      this prints BOTH dates the table carries — `created_at`, the ERP row, and
//      `do_date`, the document — by month, and lets the shapes say which.
//
//   3. THE SEVEN. Seven keyless lines sit on sales orders the book already has,
//      added after the document reached it. He asked what they are. Named here
//      by document number.
//
// READ-ONLY. Counts, document numbers and classified reasons only — this
// repository and its Actions logs are PUBLIC, so no customer name, item code,
// amount or address goes through here. An unmatched service code is reported as
// a COUNT plus the sales orders carrying it; open one in the ERP to see it.
//
// It runs under tsx, because it resolves against the SAME item map the
// write-back uses (src/services/autocount-item-code.ts) rather than a second
// copy of the list.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { acItemIndex } from '../src/services/autocount-item-code.ts';

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
  console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
  process.exit(0);
}

/* The one definition of a service line, copied from check-keyless-source-lines
   .mjs so the two reports agree about which lines they are talking about. */
const SERVICE_SQL = (t) =>
  `(upper(coalesce(${t}.item_group, '')) LIKE '%SERVICE%'
    OR upper(coalesce(${t}.item_code, '')) LIKE 'SVC-_%')`;

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  const index = acItemIndex();
  console.log(`AutoCount item map: ${index.rows} rows, ${index.acCodes.size} distinct ItemCodes.`);

  console.log('');
  console.log('=== 1. DO OUR KEYLESS SERVICE LINES USE A CODE THE BOOK HAS ===');
  const svc = await pg.unsafe(`
    SELECT si.item_code, si.item_group, count(*)::int AS lines,
           count(DISTINCT si.doc_no)::int             AS sales_orders
      FROM scm.mfg_sales_order_items si
     WHERE si.linked_ac_dtlkey IS NULL AND ${SERVICE_SQL('si')}
     GROUP BY si.item_code, si.item_group
     ORDER BY count(*) DESC`);
  let known = 0;
  let unknown = 0;
  const unknownDocs = [];
  for (const r of svc) {
    const inMap = index.byErp.has(String(r.item_code ?? '').trim().toUpperCase());
    if (inMap) known += r.lines; else { unknown += r.lines; unknownDocs.push(r); }
  }
  console.log(`  distinct service codes on keyless lines: ${svc.length}`);
  console.log(`  lines whose code IS in the account book's item map:  ${known}`);
  console.log(`  lines whose code is NOT:                             ${unknown}`);
  console.log(`  distinct codes NOT in the map: ${unknownDocs.length}`);
  console.log('');
  console.log('  A code the book HAS but a line with no key means the line was never');
  console.log('  matched, not that the item is missing — a different remedy entirely.');

  console.log('');
  console.log('=== 1b. THE SALES ORDERS CARRYING AN UNMATCHED SERVICE CODE ===');
  console.log('(open one in the ERP to see the code itself; it is not printed here)');
  if (unknownDocs.length) {
    const which = await pg.unsafe(`
      SELECT DISTINCT si.doc_no
        FROM scm.mfg_sales_order_items si
       WHERE si.linked_ac_dtlkey IS NULL AND ${SERVICE_SQL('si')}
       ORDER BY si.doc_no
       LIMIT 60`);
    for (const r of which) console.log(`  ${r.doc_no}`);
    console.log(`  (${which.length} shown)`);
  } else {
    console.log('  none — every service code on a keyless line is one the book has.');
  }

  console.log('');
  console.log('=== 2. WHEN WERE THOSE DELIVERY ORDERS ACTUALLY RAISED ===');
  console.log('(created_at is the ERP row; do_date is the document. They can differ.)');
  const dates = await pg.unsafe(`
    WITH touched AS (
      SELECT DISTINCT d.id, d.created_at, d.do_date
        FROM scm.delivery_orders d
        JOIN scm.delivery_order_items di ON di.delivery_order_id = d.id
        JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
       WHERE si.linked_ac_dtlkey IS NULL
    )
    SELECT to_char(created_at, 'YYYY-MM')      AS row_month,
           to_char(do_date::date, 'YYYY-MM')   AS doc_month,
           count(*)::int                       AS n
      FROM touched
     GROUP BY 1, 2
     ORDER BY 1, 2`);
  console.log('  ERP ROW MONTH\tDOCUMENT MONTH\tCOUNT');
  for (const r of dates) console.log(`  ${r.row_month ?? '(none)'}\t${r.doc_month ?? '(none)'}\t${r.n}`);

  console.log('');
  console.log('=== 3. THE SEVEN LINES ADDED AFTER THE DOCUMENT REACHED THE BOOK ===');
  const seven = await pg.unsafe(`
    SELECT si.doc_no,
           so.created_at::date::text AS so_created,
           si.created_at::date::text AS line_added,
           ${SERVICE_SQL('si')}      AS is_service
      FROM scm.mfg_sales_order_items si
      JOIN scm.mfg_sales_orders so ON so.doc_no = si.doc_no
     WHERE si.linked_ac_dtlkey IS NULL
       AND so.linked_ac_docno IS NOT NULL
       AND si.created_at > so.created_at + interval '1 minute'
     ORDER BY si.created_at`);
  console.log('  SALES ORDER\tORDER RAISED\tLINE ADDED\tSERVICE LINE');
  for (const r of seven) {
    console.log(`  ${r.doc_no}\t${r.so_created}\t${r.line_added}\t${r.is_service ? 'YES' : 'no'}`);
  }
  console.log(`  (${seven.length} row(s))`);
} catch (e) {
  console.error('DB unreachable or query failed:', e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
