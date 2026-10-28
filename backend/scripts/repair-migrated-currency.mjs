#!/usr/bin/env node
/* repair-migrated-currency — put the AutoCount book's own currency onto the
 * migrated documents whose ERP row says 'MYR' because a script said so.
 *
 * THE DEFECT. `import-ac-outstanding-po.mjs:403`, `import-ac-outstanding-so.mjs`
 * and `import-ac-so-linked-pos.mjs` wrote the CONSTANT 'MYR' into the currency
 * column, whatever the account book said. Measured on the committed header cut
 * (data/ac-doc-headers.json.gz, 2026-09-07 17:36+08): the book holds 22 CNY
 * purchase orders out of 9,408 and 0 non-MYR sales orders out of 13,365; ONE of
 * the 22 is inside the migrated scope. The writers now copy the book
 * (lib/ac-currency.mjs) — this repairs the rows already written.
 *
 * That mislabel is not decoration. It is what let `repair-po-line-discount.mjs`
 * read an exchange rate as a 38.06% discount and take RM 13,068.55 off
 * `HC-PO-009335` (docs/bugs/0665-*, reverted by #3070).
 *
 * WHAT IT WRITES, AND WHAT IT REFUSES TO WRITE. One column, `currency`, on
 * documents whose `linked_ac_docno` names a book document whose CurrencyCode
 * DIFFERS from the ERP's. It touches no amount, no rate, no line, and no
 * downstream document. It refuses:
 *   · any document with no `linked_ac_docno` (not migrated — not this job's);
 *   · any document whose book row is missing from the header cut;
 *   · any currency code that is not a label of scm.currency_code, re-read from
 *     pg_enum at runtime rather than assumed — a code the type has no label for
 *     fails the UPDATE with `invalid_input_value`, which reads as a 500;
 *   · a document that already agrees with the book.
 *
 * WHY THE AMOUNTS ARE LEFT ALONE, STATED SO NOBODY HAS TO REDERIVE IT. The ERP
 * stores the DOCUMENT's own amounts (AutoCount's `NetTotal` / `UnitPrice`), and
 * scm.purchase_orders has NO exchange_rate column at all — verified against
 * production 2026-09-07 23:06+08. Conversion to ringgit happens on the GRN, the
 * purchase invoice and the payment voucher, each carrying its OWN currency and
 * rate (src/scm/lib/fx.ts). So changing this label re-interprets nothing that is
 * already stored. It DOES change what a FUTURE receipt inherits — `resolveGrnFx`
 * (routes/grns.ts) copies the purchase order's currency onto a new GRN, and
 * `assertForeignRatePostable` then refuses to post it until a real rate exists.
 * That refusal is the point: a yuan figure capitalised at 1:1 is the R2 mis-cost.
 *
 * RE-RUN: inert. The plan is built from `ERP currency <> book CurrencyCode`, and
 * the UPDATE re-asserts that same inequality in its WHERE clause, so a second
 * run selects nothing and writes nothing. A document an operator has since set
 * by hand to the book's value is simply no longer in the plan; one set to a
 * THIRD value would be re-planned and named in the output before anything moves.
 *
 * Usage:
 *   MODE=plan  node backend/scripts/repair-migrated-currency.mjs      (default)
 *   MODE=apply CONFIRM="I HAVE REVIEWED THE CURRENCY PLAN" node ...
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { bookCurrency } from "./lib/ac-currency.mjs";
import { CURRENCY_ARMS, missingColumns, splitTable } from "./lib/migrated-currency-arms.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL not set. Aborting."); process.exit(2); }

const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE CURRENCY PLAN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(CO) || CO <= 0) { console.error("COMPANY_ID must be a positive integer"); process.exit(2); }

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const line = (m = "") => console.log(m);
const pad = (s, n) => String(s ?? "").padEnd(n);

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/* The book side. `ac-doc-headers.json.gz` is the FULL header cut — every SO and
   PO in the book, not the outstanding filter — which is why it can answer for a
   migrated document the migration cut no longer contains. */
function bookByDoc() {
  const R = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-doc-headers.json.gz"))),
  ).rows;
  const out = { SO: new Map(), PO: new Map(), exportedAt: R.exportedAt };
  for (const [kind, fk, rk] of [["SO", "so_fields", "so"], ["PO", "po_fields", "po"]]) {
    const fields = R[fk] || [];
    const iDoc = fields.indexOf("DocNo");
    const iCur = fields.indexOf("CurrencyCode");
    if (iDoc < 0 || iCur < 0) continue;
    for (const r of R[rk] || []) {
      const doc = String(r[iDoc] ?? "").trim();
      if (doc) out[kind].set(doc, bookCurrency({ CurrencyCode: r[iCur] }));
    }
  }
  return out;
}

const ARMS = CURRENCY_ARMS;

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"} company_id=${CO}`);

  const book = bookByDoc();
  log(`book header cut exported ${book.exportedAt}; SO ${book.SO.size} documents, PO ${book.PO.size}`);
  if (!book.PO.size && !book.SO.size) {
    log("The header cut carries no CurrencyCode. Nothing can be repaired from it — refusing rather than reporting a clean run.");
    await sql.end();
    return;
  }

  /* The enum's labels, re-read from the catalogue. A code the type has no label
     for must be refused HERE, by name, rather than discovered as a failed
     UPDATE halfway through the run. */
  const labels = new Set(
    (await sql`
      SELECT e.enumlabel AS label
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE n.nspname = 'scm' AND t.typname = 'currency_code'`).map((r) => r.label),
  );
  log(`scm.currency_code labels: ${[...labels].join(", ") || "(the type is not an enum here)"}`);

  /* EVERY COLUMN THIS RUN WILL NAME, CHECKED FIRST. The first production run
     printed a correct purchase-order plan and then died on the sales orders with
     `column "id" does not exist`: scm.mfg_sales_orders has no `id`, it is keyed
     by `doc_no`. A wrong belief about a column must refuse by NAME before any
     statement is built, not surface as a Postgres error halfway through. */
  for (const arm of ARMS) {
    const { schema, table } = splitTable(arm.table);
    const cols = new Set(
      (await sql`SELECT column_name FROM information_schema.columns
                  WHERE table_schema = ${schema} AND table_name = ${table}`).map((r) => r.column_name),
    );
    if (!cols.size) {
      log(`REFUSING: ${arm.table} does not exist. This is a missing-table condition, not a data answer.`);
      await sql.end();
      process.exit(1);
    }
    const gone = missingColumns(arm, cols);
    if (gone.length) {
      log(`REFUSING: ${arm.table} has no column(s) ${gone.join(", ")} — this script would have named them. Fix lib/migrated-currency-arms.mjs rather than the statement.`);
      await sql.end();
      process.exit(1);
    }
    line(`  ${arm.table}: keyed by ${arm.pk}, document number in ${arm.docCol} — both present`);
  }

  const plan = [];
  const refused = [];
  for (const arm of ARMS) {
    const rows = await sql.unsafe(
      `SELECT ${arm.pk}::text AS pk, ${arm.docCol} AS doc, linked_ac_docno AS ac, currency::text AS currency, status
         FROM ${arm.table}
        WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL
        ORDER BY linked_ac_docno`,
    );
    let agree = 0;
    let unknown = 0;
    for (const r of rows) {
      const want = book[arm.kind].get(String(r.ac).trim());
      if (!want) { unknown += 1; continue; }
      const have = String(r.currency ?? "").trim().toUpperCase();
      if (have === want) { agree += 1; continue; }
      if (labels.size && !labels.has(want)) {
        refused.push(`${arm.label}: ${r.doc} wants '${want}', which scm.currency_code has NO LABEL for — apply migration 20260907T2330 first`);
        continue;
      }
      plan.push({ arm, pk: r.pk, doc: r.doc, ac: r.ac, from: have || "(blank)", to: want, status: r.status });
    }
    log(`${arm.label}: ${rows.length} migrated; ${agree} already agree with the book; ${unknown} have no row in the header cut; ${plan.filter((p) => p.arm === arm).length} to change`);
  }

  for (const r of refused) line(`  REFUSED — ${r}`);
  if (!plan.length) {
    log("Nothing to change. Every migrated document already carries the currency its book row states.");
    await sql.end();
    return;
  }
  line("");
  line("PLAN:");
  for (const p of plan) {
    line(`  ${pad(p.arm.label, 16)} ${pad(p.doc, 18)} (book ${p.ac})  ${p.from} -> ${p.to}   [${p.status}]`);
  }

  if (!APPLY) {
    log(`PLAN ONLY — ${plan.length} document(s) would change. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end();
    return;
  }

  let changed = 0;
  for (const p of plan) {
    /* The WHERE re-asserts the inequality the plan was built on, so a row
       another process moved between the plan and the write is skipped rather
       than overwritten. */
    const res = await sql.unsafe(
      `UPDATE ${p.arm.table} SET currency = $1::scm.currency_code
        WHERE ${p.arm.pk}::text = $2 AND company_id = ${CO} AND currency::text <> $1`,
      [p.to, p.pk],
    );
    changed += res.count ?? 0;
  }
  log(`APPLIED. Documents changed: ${changed} of ${plan.length} planned.`);

  /* THE VERIFICATION IS A FRESH CONNECTION AND IT ASKS WHAT THE VALUE NOW IS.
     A row count is not a shape: the count would have said "1 of 1" even if the
     enum cast had landed a different label. This re-reads each document by id
     and asserts the string. */
  const verify = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  let bad = 0;
  for (const arm of ARMS) {
    const ids = plan.filter((p) => p.arm === arm).map((p) => p.pk);
    if (!ids.length) continue;
    const rows = await verify.unsafe(
      `SELECT ${arm.pk}::text AS pk, ${arm.docCol} AS doc, currency::text AS currency, pg_typeof(currency)::text AS coltype
         FROM ${arm.table} WHERE ${arm.pk}::text = ANY($1::text[])`,
      [ids],
    );
    const want = new Map(plan.filter((p) => p.arm === arm).map((p) => [p.pk, p.to]));
    for (const r of rows) {
      const expect = want.get(r.pk);
      const got = String(r.currency ?? "");
      if (got !== expect) { bad += 1; line(`  VERIFY FAILED — ${r.doc}: expected '${expect}', reads '${got}' (${r.coltype})`); }
      else line(`  verified ${pad(r.doc, 18)} currency = '${got}' (${r.coltype})`);
    }
    if (rows.length !== ids.length) { bad += 1; line(`  VERIFY FAILED — ${arm.label}: re-read returned ${rows.length} of ${ids.length} documents`); }
  }
  await verify.end();
  await sql.end();
  if (bad) { console.error(`${bad} verification failure(s).`); process.exit(1); }
  log("Verified on a fresh connection: every changed document reads the book's own currency code.");
}

main().catch(async (e) => { console.error(e); await sql.end().catch(() => {}); process.exit(1); });
