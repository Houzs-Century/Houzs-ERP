// Read-only: HOW LONG IS THE ADDRESS THAT STOPPED THE DOCUMENT?
//
// HC-SO-2609-006 never reached the account book: "Cannot set column
// 'InvAddr1'. The value violates the MaxLength limit of this column." The four
// InvAddr columns are 40 characters (measured on AED_HOUZS, 2026-09-09), and
// fitAddressLines now re-packs an overflowing address across them.
//
// WHAT THAT FIX CANNOT DO is make an address shorter than itself. Four lines of
// forty is 160 characters; past that, something has to be left out. Nobody has
// measured whether this document is inside or outside that, so whether the fix
// clears it is UNKNOWN rather than likely — and the honest way to find out is
// to measure, not to send it and see.
//
// It also asks the same question of every other sales order that has not
// reached the book, because a second one behind this is worth knowing about
// before it stops too.
//
// PUBLIC LOG. This repository and its Actions logs are public, so no address is
// ever printed — only its LENGTH, and how it splits.
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

/* The book's own width, measured on AED_HOUZS 2026-09-09 and mirrored from
   services/autocount-address-fit.ts. A number in a comment expires: re-run the
   INFORMATION_SCHEMA query in that module's header rather than trusting it. */
const LINE = 40;
const LINES = 4;

const DOC_NO = (process.env.DOC_NO || '').trim();

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  console.log('=== 1. THE DOCUMENT THAT STOPPED ===');
  const one = DOC_NO
    ? await pg`SELECT doc_no, length(coalesce(address1,'')) AS a1,
                      length(coalesce(address2,'')) AS a2,
                      length(coalesce(address3,'')) AS a3,
                      length(coalesce(address4,'')) AS a4,
                      length(coalesce(postcode,'') || ' ' || coalesce(city,'')) AS town,
                      length(coalesce(customer_state,'')) AS st
                 FROM scm.mfg_sales_orders WHERE doc_no = ${DOC_NO}`
    : [];
  if (!DOC_NO) console.log('  (no DOC_NO given, skipping)');
  else if (!one.length) console.log(`  NOT FOUND: no sales order with doc_no = '${DOC_NO}'`);
  else {
    const r = one[0];
    const total = Number(r.a1) + Number(r.a2) + Number(r.a3 || r.town) + Number(r.a4 || r.st);
    console.log(`  ${r.doc_no}`);
    console.log(`    address line 1: ${r.a1} characters  (the column holds ${LINE})`);
    console.log(`    address line 2: ${r.a2}`);
    console.log(`    address line 3: ${r.a3} (or town ${r.town} when blank)`);
    console.log(`    address line 4: ${r.a4} (or state ${r.st} when blank)`);
    console.log(`    the whole address is about ${total} characters; ${LINES} lines of ${LINE} hold ${LINES * LINE}`);
    console.log(total <= LINES * LINE
      ? '    IT FITS once re-packed - the re-flow clears this document.'
      : '    IT DOES NOT FIT even re-packed. Something has to be left out, and that is a decision.');
  }

  console.log('');
  console.log('=== 1b. AND WHAT DID THE QUEUE ACTUALLY SEND ===');
  console.log('(the composer is right in a test; the question is what the STORED payload holds)');
  /* THE ONE FACT THAT SETTLES IT. fitAddressLines demonstrably fits a 62-
     character line, and HC-SO-2609-006 still came back refused for InvAddr1 —
     so either the row was composed before the fix, or the fix is not on this
     path. The payload is what was posted; nothing else is evidence. */
  if (DOC_NO) {
    const rows = await pg`
      SELECT status, attempts, created_at,
             length(coalesce(payload #>> '{body,InvAddr1}', '')) AS a1,
             length(coalesce(payload #>> '{body,InvAddr2}', '')) AS a2,
             length(coalesce(payload #>> '{body,InvAddr3}', '')) AS a3,
             length(coalesce(payload #>> '{body,InvAddr4}', '')) AS a4
        FROM scm.autocount_outbox
       WHERE doc_no = ${DOC_NO}
       ORDER BY created_at DESC LIMIT 5`;
    if (!rows.length) console.log('  no outbox row for this document');
    for (const r of rows) {
      const over = [r.a1, r.a2, r.a3, r.a4].some((n) => Number(n) > LINE);
      console.log(
        `  ${String(r.created_at)}  ${r.status} after ${r.attempts}  `
        + `InvAddr lengths ${r.a1}/${r.a2}/${r.a3}/${r.a4}  ${over ? 'OVER THE COLUMN' : 'fits'}`,
      );
    }
    console.log('  a row that is OVER was composed before the fit shipped; one that FITS and still');
    console.log('  failed means the fit is not on this path and the search moves there.');
  }

  console.log('');
  console.log('=== 2. IS THERE A SECOND ONE BEHIND IT ===');
  console.log('(sales orders whose address would be refused by the same rule)');
  const wide = await pg`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE linked_ac_docno IS NULL)::int AS not_in_book
      FROM scm.mfg_sales_orders
     WHERE length(coalesce(address1,'')) > ${LINE}
        OR length(coalesce(address2,'')) > ${LINE}
        OR length(coalesce(address3,'')) > ${LINE}
        OR length(coalesce(address4,'')) > ${LINE}`;
  console.log(`  sales orders with any address line over ${LINE}: ${wide[0].n}`);
  console.log(`    of those, not yet in the account book:        ${wide[0].not_in_book}`);

  console.log('');
  console.log('=== 3. AND HOW MANY COULD NOT FIT EVEN RE-PACKED ===');
  const huge = await pg`
    SELECT doc_no,
           length(coalesce(address1,'')) + length(coalesce(address2,''))
         + length(coalesce(address3,'')) + length(coalesce(address4,'')) AS total
      FROM scm.mfg_sales_orders
     WHERE length(coalesce(address1,'')) + length(coalesce(address2,''))
         + length(coalesce(address3,'')) + length(coalesce(address4,'')) > ${LINES * LINE}
     ORDER BY total DESC`;
  console.log(`  sales orders whose whole address is over ${LINES * LINE} characters: ${huge.length}`);
  /* THE DOCUMENT NUMBER, AND NOT THE ADDRESS. The owner asked to see the one
     that will not fit (2026-09-09, 「160 个字的是怎么样的？你发我」) and this log
     is public — a customer's address printed here is published. The number lets
     him open it in the ERP, where it belongs, and it is already the identifier
     every other line of this output uses. */
  for (const r of huge) console.log(`    ${r.doc_no} — ${r.total} characters of address`);
  console.log('');
  console.log('READ IT LIKE THIS: section 2 is what the re-flow fixes. Section 3 is what it');
  console.log('cannot, and each one there needs somebody to decide what comes off the label.');
} catch (e) {
  console.error('DB unreachable or query failed:', e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
