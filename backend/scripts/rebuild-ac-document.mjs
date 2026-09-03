#!/usr/bin/env node
// ----------------------------------------------------------------------------
// REBUILD ONE DOCUMENT'S LINES IN AUTOCOUNT — the recovery tool, by name.
//
// WHY THIS EXISTS AND THE RE-QUEUE LADDER COULD NOT DO IT. requeueOneRow refuses
// a `sent` row, and it is right to: for a CREATE, sending again puts a SECOND
// document into a licensed account book, and an accepted document cannot simply
// be deleted there. That guard must not be widened.
//
// But a document can be `sent` and still WRONG. On 2026-09-02 SO-013394 was
// rebuilt and landed with seven of its eight lines carrying a blank ItemCode
// (docs/bugs/0615). The row said `sent`, so every path back to it was closed:
// the ladder refused it as already-sent, and an ordinary ERP save would compose
// a KEYED edit against DtlKeys the rebuild had already destroyed.
//
// This asks for one more rebuild, by document number, deliberately.
//
// IT IS NOT A SECOND COMPOSER. It calls the same `enqueueEdit` the routes call,
// with `rebuild: true`, against the document AS IT IS NOW. Every refusal the
// composer knows still applies and is reported verbatim: a converted document
// (docs/bugs/0611), a sales order whose keys a purchase order holds
// (docs/bugs/0609), a line the item map cannot resolve. The HOST then refuses
// again on its own evidence if the book says a line was transferred.
//
// WHAT A REBUILD COSTS, so nobody runs this casually: the document's details are
// CLEARED and re-added, so every AutoCount line key on it is destroyed and
// reissued. Anything holding those keys downstream is voided. That is why this
// is a named one-document tool with a confirm phrase and not a sweep.
//
// MODE: DRY RUN unless APPLY=1, and the dry run is not a prediction — it runs
// the real enqueue against the real document and records the write instead of
// performing it.
//
// CONFIRM: on the APPLY path you must repeat the document number in CONFIRM_DOC.
//
// RE-RUN: safe and idempotent in the only sense that matters — a second run
// composes another rebuild from the ERP as it stands, and a rebuild is not
// additive: the book ends holding exactly the ERP's lines either way. It never
// creates a second document. What it DOES do again is reissue the line keys.
//
// Run: DOC_NO=HC-SO-013394 npx tsx scripts/rebuild-ac-document.mjs
//      DOC_NO=... CONFIRM_DOC=... APPLY=1 npx tsx scripts/rebuild-ac-document.mjs
// ----------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { enqueueEdit } from "../src/scm/lib/autocount-outbox.ts";
import { pgrestShim } from "./lib/pgrest-shim.mjs";

const APPLY = process.env.APPLY === "1";
const DOC_NO = (process.env.DOC_NO || "").trim();
const DOC_TYPE = (process.env.DOC_TYPE || "SO").trim().toUpperCase();
const CONFIRM_DOC = (process.env.CONFIRM_DOC || "").trim();

const notice = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

if (!DOC_NO) {
  console.error("DOC_NO is required — this tool rebuilds ONE named document.");
  process.exit(2);
}
/* Only the two the ERP owns the lines of. The other four are built by
   conversion and a rebuild destroys the link that records what they came from;
   the composer refuses them anyway (docs/bugs/0611), and refusing here as well
   means the operator is told before anything is composed. */
if (DOC_TYPE !== "SO" && DOC_TYPE !== "PO") {
  console.error(`DOC_TYPE ${JSON.stringify(DOC_TYPE)} cannot be rebuilt. Only SO and PO — a document `
    + "built by conversion holds its transfer link on the very lines a rebuild clears.");
  process.exit(2);
}
if (APPLY && CONFIRM_DOC !== DOC_NO) {
  console.error(`APPLY needs CONFIRM_DOC to repeat the document number exactly. Got `
    + `${JSON.stringify(CONFIRM_DOC)}, expected ${JSON.stringify(DOC_NO)}.`);
  process.exit(2);
}

function fromDevVars(field) {
  try {
    return readFileSync(".dev.vars", "utf8").match(new RegExp(`^${field}="?([^"\\n]+)"?`, "m"))?.[1];
  } catch {
    return undefined;
  }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const pg = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

async function main() {
  notice(`mode=${APPLY ? "APPLY" : "DRY RUN"} ${DOC_TYPE} ${DOC_NO}`);

  const header = DOC_TYPE === "SO"
    ? await pg`SELECT doc_no, company_id, linked_ac_docno FROM scm.mfg_sales_orders WHERE doc_no = ${DOC_NO}`
    : await pg`SELECT po_number AS doc_no, id::text AS doc_id, company_id, linked_ac_docno FROM scm.purchase_orders WHERE po_number = ${DOC_NO}`;
  if (!header.length) {
    warn(`${DOC_TYPE} ${DOC_NO} is not in the ERP. Nothing to rebuild.`);
    return 0;
  }
  const h = header[0];
  if (!h.linked_ac_docno) {
    warn(`${DOC_NO} carries no linked_ac_docno — it has never reached AutoCount, so there is nothing `
      + "there to rebuild. A create is the operation for that, not this.");
    return 0;
  }
  notice(`company=${h.company_id} book document=${h.linked_ac_docno}`);

  const opts = {
    companyId: Number(h.company_id),
    docType: DOC_TYPE,
    ...(DOC_TYPE === "SO" ? { docNo: DOC_NO } : { docId: h.doc_id }),
    rebuild: true,
  };

  /* THE DRY RUN COMPOSES FOR REAL and throws the write away, so a refusal here
     is the composer's own and not this script's opinion of one. */
  const captured = [];
  const probe = pgrestShim(pg, "scm");
  const realFrom = probe.from.bind(probe);
  probe.from = (table) => {
    const q = realFrom(table);
    if (table !== "autocount_outbox") return q;
    const realInsert = q.insert.bind(q);
    q.insert = (rows) => { captured.push(...(Array.isArray(rows) ? rows : [rows])); return realInsert([]); };
    return q;
  };

  if (!APPLY) {
    await enqueueEdit(probe, opts);
    const row = captured.find((r) => (r.status ?? "pending") !== "skipped");
    const refused = captured.find((r) => r.status === "skipped");
    if (refused) {
      warn(`REFUSED — ${refused.last_error}`);
      return 0;
    }
    if (!row) {
      warn("the composer wrote nothing and recorded no reason. Nothing would be queued.");
      return 0;
    }
    const lines = row.payload?.body?.Lines ?? [];
    const blank = lines.filter((l) => !String(l.ItemCode ?? "").trim()).length;
    notice(`WOULD REBUILD: ${lines.length} line(s), Rebuild=${row.payload?.body?.Rebuild === true}`);
    notice(`  lines with NO item code: ${blank} — this must be 0 (docs/bugs/0615)`);
    notice("DRY RUN — nothing written. Re-run with APPLY=1 and CONFIRM_DOC set.");
    return blank === 0 ? 0 : 0;
  }

  const sb = pgrestShim(pg, "scm");
  const queued = await enqueueEdit(sb, opts);
  if (!queued) {
    warn("the enqueue declined. Read the newest autocount_outbox row for this document — the composer "
      + "records its reason there.");
    return 0;
  }

  /* VERIFY ON A FRESH CONNECTION, and assert the SHAPE rather than a count. A
     row count would have reported 8 of 8 for the very payload that put eight
     blank-coded lines into the account book. */
  const fresh = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
  try {
    const [row] = await fresh`
      SELECT id::text, status, payload
        FROM scm.autocount_outbox
       WHERE doc_no = ${DOC_NO} AND op = 'edit' AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`;
    if (!row) {
      warn("APPLY reported queued and no pending row is readable. Check the queue by hand before re-running.");
      return 1;
    }
    const body = row.payload?.body ?? {};
    const lines = Array.isArray(body.Lines) ? body.Lines : [];
    const blank = lines.filter((l) => !String(l.ItemCode ?? "").trim());
    notice(`QUEUED outbox ${row.id} — ${lines.length} line(s), Rebuild=${body.Rebuild === true}`);
    if (body.Rebuild !== true) {
      warn("the queued payload is NOT a rebuild. It will be applied as a keyed edit against DtlKeys the "
        + "book may no longer have. Do not let the drain send it: cancel this row.");
      return 1;
    }
    if (blank.length) {
      warn(`${blank.length} of ${lines.length} line(s) carry NO item code. Sending this would repeat `
        + "docs/bugs/0615. Cancel this row before the drain picks it up.");
      return 1;
    }
    notice("every line carries an item code. The 5-minute cron sends it.");
    return 0;
  } finally {
    await fresh.end({ timeout: 5 });
  }
}

main()
  .then((code) => pg.end({ timeout: 5 }).then(() => process.exit(code)))
  .catch(async (e) => {
    console.error(e?.stack || String(e));
    await pg.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
