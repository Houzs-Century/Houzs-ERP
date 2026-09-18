// Split every sales-order address line that is wider than the account book's
// column, in the ERP's own data.
//
// THE OWNER'S INSTRUCTION, 2026-09-09:
//   「我们超过 40 个字的地址全部拆分成 address 1 和 address 2，解决了这个问题。
//     然后再 sync 进去，把我们的 address lock成 40 个字」
//
// AutoCount's four InvAddr columns are 40 characters (measured on AED_HOUZS the
// same day) and it refuses the WHOLE document when one is over, so 72 sales
// orders could not reach the accounts at all. `fitAddressLines` already fits the
// address on its way out; this fixes the DATA, which is what the owner asked for
// and the better answer — the ERP then holds what the book holds, and the two
// stop disagreeing about where a customer lives.
//
// ONE IMPLEMENTATION. The packing is `fitAddressLines` from
// services/autocount-address-fit.ts, imported through tsx, not re-written here.
// A second copy of a word-wrap is a second set of line breaks.
//
// WHAT IT WILL NOT DO. An address that cannot fit four lines of forty is left
// ALONE and named. Something has to come off a label that long and that is not a
// script's decision.
//
//   MODE=plan (default)   read and report; writes nothing
//   APPLY=1               write, and CONFIRM_COMPANY must equal COMPANY_ID
//   COMPANY_ID=1          required on the apply path
//
// RE-RUN: idempotent. A second run finds every line already at or under 40 and
// reports "nothing to do" — the packing of an address that already fits returns
// it unchanged, so re-running cannot re-flow anything a second time.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { fitAddressLines, AC_ADDRESS_LINE_MAX, AC_ADDRESS_LINES } from '../src/services/autocount-address-fit.ts';

const APPLY = process.env.APPLY === '1';
const COMPANY_ID = (process.env.COMPANY_ID || '').trim();
const CONFIRM_COMPANY = (process.env.CONFIRM_COMPANY || '').trim();

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
if (APPLY && (!COMPANY_ID || CONFIRM_COMPANY !== COMPANY_ID)) {
  console.error(`APPLY=1 needs COMPANY_ID and CONFIRM_COMPANY to match exactly. Got "${CONFIRM_COMPANY}", wanted "${COMPANY_ID}".`);
  process.exit(1);
}

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  const over = COMPANY_ID
    ? await pg`SELECT doc_no, company_id, address1, address2, address3, address4
                 FROM scm.mfg_sales_orders
                WHERE company_id = ${Number(COMPANY_ID)}
                  AND (length(coalesce(address1,'')) > ${AC_ADDRESS_LINE_MAX}
                    OR length(coalesce(address2,'')) > ${AC_ADDRESS_LINE_MAX}
                    OR length(coalesce(address3,'')) > ${AC_ADDRESS_LINE_MAX}
                    OR length(coalesce(address4,'')) > ${AC_ADDRESS_LINE_MAX})
                ORDER BY doc_no`
    : await pg`SELECT doc_no, company_id, address1, address2, address3, address4
                 FROM scm.mfg_sales_orders
                WHERE length(coalesce(address1,'')) > ${AC_ADDRESS_LINE_MAX}
                   OR length(coalesce(address2,'')) > ${AC_ADDRESS_LINE_MAX}
                   OR length(coalesce(address3,'')) > ${AC_ADDRESS_LINE_MAX}
                   OR length(coalesce(address4,'')) > ${AC_ADDRESS_LINE_MAX}
                ORDER BY doc_no`;

  console.log(`sales orders with an address line over ${AC_ADDRESS_LINE_MAX}: ${over.length}`);

  const planned = [];
  const cannot = [];
  for (const r of over) {
    const { lines, dropped } = fitAddressLines([r.address1, r.address2, r.address3, r.address4]);
    /* AN ADDRESS THAT CANNOT FIT IS LEFT ALONE, and named. Something has to come
       off a label longer than four lines of forty, and choosing what is not a
       script's decision — the owner's, on a document he can see. */
    if (dropped) { cannot.push(r.doc_no); continue; }
    planned.push({ doc_no: r.doc_no, lines });
  }

  console.log(`  can be re-flowed into ${AC_ADDRESS_LINES} lines: ${planned.length}`);
  console.log(`  CANNOT fit even re-flowed, left alone: ${cannot.length}${cannot.length ? ` — ${cannot.join(', ')}` : ''}`);
  /* Lengths, never the address: this log is public. */
  for (const p of planned.slice(0, 5)) {
    console.log(`    ${p.doc_no} -> line lengths ${p.lines.map((l) => (l ?? '').length).join('/')}`);
  }
  if (planned.length > 5) console.log(`    ... and ${planned.length - 5} more`);

  if (!APPLY) {
    console.log('');
    console.log('PLAN — nothing written. Re-run with APPLY=1, COMPANY_ID and CONFIRM_COMPANY.');
    process.exit(0);
  }

  let written = 0;
  for (const p of planned) {
    await pg`UPDATE scm.mfg_sales_orders
                SET address1 = ${p.lines[0]}, address2 = ${p.lines[1]},
                    address3 = ${p.lines[2]}, address4 = ${p.lines[3]}
              WHERE doc_no = ${p.doc_no}`;
    written += 1;
  }
  console.log(`WROTE ${written} sales order(s).`);

  /* THE SHAPE, on a FRESH connection. A row count would be true of a write that
     stored the same over-long text back; what is asserted is that no address
     line on those documents is over the column any more. */
  const fresh = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  try {
    /* THE VALUES, NOT A COUNT. A count would be true of a write that stored the
       same over-long text straight back — the jsonb double-encoding repair
       counted 7 of 7 while re-corrupting all 7. So the row is READ BACK and its
       four line lengths are asserted one at a time, and the packing is re-run
       over what came back: if the stored address does not already fit, the
       write did not take. */
    const docs = planned.map((p) => p.doc_no);
    const back = docs.length
      ? await fresh`SELECT doc_no, address1, address2, address3, address4
                      FROM scm.mfg_sales_orders WHERE doc_no = ANY(${docs})`
      : [];
    let bad = 0;
    for (const r of back) {
      const got = [r.address1, r.address2, r.address3, r.address4];
      const lens = got.map((l) => (l ?? '').length);
      const overNow = lens.some((n) => n > AC_ADDRESS_LINE_MAX);
      /* IDEMPOTENCE, asserted rather than claimed: fitAddressLines returns an
         address that already fits UNCHANGED, so re-packing what is stored must
         give back the same four strings. If it does not, the stored value is not
         what this run intended to store. */
      const again = fitAddressLines(got).lines;
      const stable = again.every((v, i) => (v ?? null) === (got[i] ?? null));
      if (overNow || !stable) {
        bad += 1;
        console.log(`  ${r.doc_no}: lengths ${lens.join('/')}${overNow ? ' OVER' : ''}${stable ? '' : ' NOT STABLE'}`);
      }
    }
    console.log(`VERIFY (fresh connection): read back ${back.length} of ${docs.length} written; ${bad} wrong`);
    if (bad > 0 || back.length !== docs.length) {
      console.log('  THAT IS A FAILURE. Do not re-sync these documents; read the rows before anything else.');
      process.exit(1);
    }
    console.log('  every written document reads back within the column, and re-packing it changes nothing.');
  } finally {
    await fresh.end({ timeout: 5 });
  }
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
