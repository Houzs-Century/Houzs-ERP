#!/usr/bin/env node
/* open-ac-supplier-400-z003 — open ZOE HOME SDN BHD in scm.suppliers.
 *
 * WHY THIS EXISTS.  AutoCount PO-010113 (2026-09-02, RM 3,550, three AERO-MP
 * mattress-protector lines) names CreditorCode 400-Z003.  That supplier is not
 * in scm.suppliers, and import-ac-outstanding-po.mjs:195 skips the WHOLE
 * document when the supplier is missing — so this one purchase order has been
 * dropped from every go-live import run.  Measured 2026-09-07 against
 * production: `suppliers matching code 400-Z003 or name ~ ZOE: 0` of 44.
 *
 * THE SUPPLIER IS NOT NEW.  The committed 2026-08-11 fidelity export carries
 * 22 purchase orders to 400-Z003 going back to 2024-09-19; it was simply never
 * in the "Stock Only" creditor list that seeded the master
 * (backfill-suppliers-from-autocount.mjs, 38 rows, 2026-08-06), so it has been
 * absent since the beginning.
 *
 * EVERY VALUE IS COPIED FROM THE BOOK, NOT COMPUTED.  Read 2026-09-07 with one
 * single-row indexed lookup, `SELECT ... FROM Creditor WHERE AccNo='400-Z003'`
 * against AED_HOUZS.  A column AutoCount holds as NULL is left blank here —
 * blank stays blank (the migration rule).  The two values that are NOT copies
 * are named explicitly in ASSUMED below and printed on every run.
 *
 * RE-RUN: safe and inert.  The insert is ON CONFLICT (company_id, code) DO
 * NOTHING, so a second run finds the row already present, writes nothing, and
 * still runs the verification.  It never edits a row it did not create — if
 * somebody has since corrected an address by hand, this script leaves it.
 *
 *   node scripts/open-ac-supplier-400-z003.mjs                       # plan
 *   MODE=apply CONFIRM_SUPPLIER="400-Z003 ZOE HOME" node ...         # write
 */
import postgres from "postgres";

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "400-Z003 ZOE HOME";
const CO = Number(process.env.COMPANY_ID || 1);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL not set.");
  process.exit(2);
}
/* The apply path is refused here, before a connection is even opened, so the
   refusal cannot be reached with a half-open transaction behind it. */
if (APPLY && (process.env.CONFIRM_SUPPLIER ?? "").trim() !== CONFIRM_PHRASE) {
  console.error(
    `REFUSED: MODE=apply requires CONFIRM_SUPPLIER="${CONFIRM_PHRASE}". ` +
      "The phrase is typed on purpose so an apply cannot happen by copying a command.",
  );
  process.exit(2);
}

/* Copied verbatim from Creditor WHERE AccNo='400-Z003', 2026-09-07.
   NULL in the book stays null here. */
const BOOK = {
  code: "400-Z003",
  name: "ZOE HOME SDN BHD",
  registration_no: "1441349-X",
  address1: "G23A SK 1 RESIDENSI,JALAN PSK 4",
  address2: "PUSAT PERDAGANGAN SERI KEMBANGAN",
  address3: null,
  address4: null,
  postcode: "43300",
  attention: null,
  phone: null,
  phone2: null,
  mobile: null,
  website: null,
  email: null,
  currency: "MYR",
  credit_limit_sen: 3000000, // AutoCount CreditLimit 30000.00
};
/* The only two values that are not copies. AutoCount's Creditor row has no
   country column at all, and the ERP's is NOT NULL; the registered address is
   Malaysian (postcode 43300, Seri Kembangan, Selangor). Named here rather than
   buried so the assumption is reviewable. */
const ASSUMED = { country: "MY" };

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 30, prepare: false });
let exitCode = 0;

try {
  plain(`MODE=${APPLY ? "apply" : "plan"}  company_id=${CO}`);
  plain(`AutoCount values copied: ${JSON.stringify(BOOK)}`);
  plain(`ASSUMED (not in the book): ${JSON.stringify(ASSUMED)}`);

  const existing = await sql`SELECT id, code, name FROM scm.suppliers
    WHERE company_id = ${CO} AND code = ${BOOK.code}`;
  plain(`\nalready present: ${existing.length ? JSON.stringify(existing[0]) : "no"}`);

  /* PLAN-TIME SAFETY: prove the payload covers every NOT NULL column that has
     no default, BEFORE the apply path can fail halfway. A column list read
     from the live catalog, never from a migration file. */
  const cols = await sql`SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'suppliers'`;
  const payload = { company_id: CO, ...BOOK, ...ASSUMED };
  const uncovered = cols
    .filter((c) => c.is_nullable === "NO" && c.column_default == null)
    .map((c) => c.column_name)
    .filter((n) => !(n in payload));
  plain(`NOT NULL columns with no default that the payload does NOT cover: ${uncovered.length}`);
  if (uncovered.length) plain(`  ${uncovered.join(", ")}`);

  const unknown = Object.keys(payload).filter((k) => !cols.some((c) => c.column_name === k));
  plain(`payload keys that are not columns of scm.suppliers: ${unknown.length}`);
  if (unknown.length) plain(`  ${unknown.join(", ")}`);

  /* The document this unblocks, so the plan says what it is FOR. */
  const po = await sql`SELECT po_number FROM scm.purchase_orders
    WHERE company_id = ${CO} AND linked_ac_docno = 'PO-010113'`;
  plain(`PO-010113 currently in the ERP: ${po.length ? po[0].po_number : "no — this is the document being unblocked"}`);

  if (uncovered.length || unknown.length) {
    console.error(
      "REFUSED: the payload does not match the live table. Fix the column list before applying — " +
        "a half-applied insert is worse than no insert.",
    );
    exitCode = 2;
  } else if (!APPLY) {
    log(
      existing.length
        ? "PLAN — the supplier is already present; an apply run would write nothing."
        : "PLAN — nothing written. Re-run with MODE=apply and the CONFIRM phrase to open the supplier.",
    );
  } else {
    const written = await sql`INSERT INTO scm.suppliers ${sql(payload)}
      ON CONFLICT (company_id, code) DO NOTHING RETURNING id`;
    log(`APPLIED — rows inserted: ${written.length} (0 means it was already there)`);
  }
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  exitCode = 2;
} finally {
  await sql.end({ timeout: 5 });
}

/* VERIFICATION, on a FRESH connection, reading VALUES rather than a count.
   A row count would have said "1 row" for a row whose name was mangled; the
   shape check below reads the actual strings back and asserts their types and
   contents against what the book holds. */
if (exitCode === 0) {
  const fresh = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 30, prepare: false });
  try {
    const back = await fresh`SELECT code, name, registration_no, address1, address2,
        postcode, country, currency, credit_limit_sen
      FROM scm.suppliers WHERE company_id = ${CO} AND code = ${BOOK.code}`;
    plain(`\nVERIFY (fresh connection): rows = ${back.length}`);
    if (!back.length) {
      plain(APPLY ? "VERIFY FAILED — the row is not there after an apply run." : "VERIFY — not yet opened (plan run).");
      if (APPLY) exitCode = 2;
    } else {
      const r = back[0];
      plain(`VERIFY row: ${JSON.stringify(r)}`);
      const shapeOk =
        typeof r.code === "string" && r.code === BOOK.code &&
        typeof r.name === "string" && r.name === BOOK.name &&
        typeof r.registration_no === "string" && r.registration_no === BOOK.registration_no &&
        typeof r.address1 === "string" && r.address1 === BOOK.address1 &&
        typeof r.postcode === "string" && r.postcode === BOOK.postcode &&
        typeof Number(r.credit_limit_sen) === "number" &&
        Number(r.credit_limit_sen) === BOOK.credit_limit_sen &&
        !Array.isArray(r.name);
      plain(`VERIFY shape matches the AutoCount row verbatim: ${shapeOk ? "YES" : "NO"}`);
      if (!shapeOk) {
        plain(`  expected ${JSON.stringify({ ...BOOK, country: ASSUMED.country })}`);
        if (APPLY) exitCode = 2;
      }
    }
  } catch (e) {
    console.error(`VERIFY REFUSED: ${e.message}`);
    exitCode = 2;
  } finally {
    await fresh.end({ timeout: 5 });
  }
}

process.exit(exitCode);
