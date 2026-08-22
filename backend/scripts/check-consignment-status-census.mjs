#!/usr/bin/env node
/* Read-only: how many rows does each CONSIGNMENT document hold, by status and
 * by company — and what status vocabulary does the database actually allow?
 *
 * THE QUESTION, in the owner's words (2026-08-22):
 *   「你再检查一下所有的 Transaction Workflow，包括 Consignment 这边也是一样。
 *     Sales Order、Consignment Order、PO 等等，正常来说每个 Status 都应该有
 *     On Hold 和 Cancel」
 *   「然后 CO=SO，DO=Consignment note。状态等等全部都是要对齐的」
 *
 * Aligning the consignment chain with the sales chain is a proposal
 * (`docs/modules/consignment-alignment.md`), and a proposal costed against
 * guesses is worthless. Two facts live only in production and this reads both:
 *
 *   1. WHAT THE COLUMN ALLOWS. Every consignment status column is declared as
 *      a REUSED enum — consignment_sales_orders.status is `mfg_so_status`, the
 *      Sales Order's own type — so on paper the database already accepts
 *      ON_HOLD on a Consignment Order today. That is read off DDL files
 *      (backend/scripts/scm-schema/consignment/0153_consignment_module.sql,
 *      migrations-pg/0090), and this repo's own schema README says DDL has been
 *      applied out-of-band more than once. Reading a file is not evidence about
 *      production; `pg_enum` is. This prints the LIVE labels.
 *   2. HOW MANY ROWS ARE AT STAKE. A status change is cheap on an empty table
 *      and expensive on a live one. Counts, per company, per status.
 *
 * It also counts the FACTS a machine would need in order to MOVE a consignment
 * status the way the sales chain moves one (a processing date, a note raised
 * against the order, a signature). Those counts are what say whether a derived
 * status is buildable or fictional.
 *
 * WHAT IT DELIBERATELY DOES NOT PRINT. This repository is PUBLIC and so are its
 * Actions logs. Every line below is a COUNT, a table name, a column type or an
 * enum label. No document number, no customer, no supplier, no staff name, no
 * amount, no date. A status label is a vocabulary word, not an identifier.
 *
 * Writes nothing. SELECTs only, no DDL, no transaction. Exit 0 for every
 * legitimate answer — the output IS the answer; non-zero means the database
 * could not be read at all.
 *
 * RE-RUN: safe and idempotent; they are SELECTs. */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The six consignment documents, each beside the sales/purchase-chain document
   the owner says it mirrors. The PAIRING is the point of the report: a reader
   should be able to see the two vocabularies side by side without holding two
   screens. `label` is what the owner calls it. */
const DOCS = [
  { label: "Consignment Order  (CO)",        table: "consignment_sales_orders",       mirrorOf: "Sales Order",        mirror: "mfg_sales_orders" },
  { label: "Consignment Note   (CN)",        table: "consignment_delivery_orders",    mirrorOf: "Delivery Order",     mirror: "delivery_orders" },
  { label: "Consignment Return (CR)",        table: "consignment_delivery_returns",   mirrorOf: "Delivery Return",    mirror: "delivery_returns" },
  { label: "PC Order           (PCO)",       table: "purchase_consignment_orders",    mirrorOf: "Purchase Order",     mirror: "purchase_orders" },
  { label: "PC Receive         (PCR)",       table: "purchase_consignment_receives",  mirrorOf: "GRN",                mirror: "grns" },
  { label: "PC Return          (PCT)",       table: "purchase_consignment_returns",   mirrorOf: "Purchase Return",    mirror: "purchase_returns" },
];

/* The derivation facts. Each row is: if a machine were to write this status on
   the consignment side, WHICH COLUMN would it read to decide? A count of zero
   is the finding — it means the fact exists as a column but nobody fills it, so
   a status derived from it would never fire. */
const FACTS = [
  { q: "CO carrying a Processing Date",            table: "consignment_sales_orders",     where: "processing_date IS NOT NULL" },
  { q: "CO carrying a Delivery Date",              table: "consignment_sales_orders",     where: "customer_delivery_date IS NOT NULL" },
  { q: "CO with a deposit taken",                  table: "consignment_sales_orders",     where: "deposit_sen > 0" },
  { q: "CN linked to a CO (not standalone)",       table: "consignment_delivery_orders",  where: "consignment_so_doc_no IS NOT NULL" },
  { q: "CN with a dispatched timestamp",           table: "consignment_delivery_orders",  where: "dispatched_at IS NOT NULL" },
  { q: "CN with a signed timestamp",               table: "consignment_delivery_orders",  where: "signed_at IS NOT NULL" },
  { q: "CN with a delivered timestamp",            table: "consignment_delivery_orders",  where: "delivered_at IS NOT NULL" },
  { q: "CR linked to a CN",                        table: "consignment_delivery_returns", where: "consignment_do_id IS NOT NULL" },
  { q: "PCO with something received against it",   table: "purchase_consignment_orders",  where: "received_at IS NOT NULL" },
];

/** The live labels of the enum backing <table>.<column>, or null when the
 *  column is plain text (in which case NOTHING constrains the value and the
 *  route is the only guard there is — a finding in itself). */
async function statusType(table) {
  const rows = await sql`
    SELECT t.typname AS type_name, t.typtype AS type_kind, n.nspname AS type_schema
      FROM information_schema.columns c
      JOIN pg_namespace n ON n.nspname = c.udt_schema
      JOIN pg_type t ON t.typname = c.udt_name AND t.typnamespace = n.oid
     WHERE c.table_schema = 'scm' AND c.table_name = ${table} AND c.column_name = 'status'`;
  if (!rows.length) return null;
  const { type_name: typeName, type_kind: kind, type_schema: typeSchema } = rows[0];
  const qualified = `${typeSchema}.${typeName}`;
  if (kind !== "e") return { typeName: qualified, labels: null };
  /* Qualified by SCHEMA as well as name — `po_status` exists in more than one
     schema in this database, and an unqualified match would silently union two
     different vocabularies into one line. */
  const labels = await sql`
    SELECT e.enumlabel AS label
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE t.typname = ${typeName} AND n.nspname = ${typeSchema}
     ORDER BY e.enumsortorder`;
  return { typeName: qualified, labels: labels.map((r) => r.label) };
}

/** company_id -> status -> count. Counts only. */
async function censusByStatus(table) {
  const rows = await sql`
    SELECT company_id, status::text AS status, count(*)::int AS n
      FROM ${sql("scm")}.${sql(table)}
     GROUP BY company_id, status
     ORDER BY company_id, status`;
  return rows;
}

function renderCensus(rows) {
  if (!rows.length) return ["    (no rows at all)"];
  const byCompany = new Map();
  for (const r of rows) {
    const cid = Number(r.company_id ?? 0);
    if (!byCompany.has(cid)) byCompany.set(cid, []);
    byCompany.get(cid).push(r);
  }
  const out = [];
  for (const [cid, rs] of [...byCompany.entries()].sort((a, b) => a[0] - b[0])) {
    const total = rs.reduce((s, r) => s + r.n, 0);
    const parts = rs.map((r) => `${r.status ?? "(null)"}=${r.n}`).join("  ");
    out.push(`    company ${cid}: ${total} rows   ${parts}`);
  }
  return out;
}

async function main() {
  note("=== check-consignment-status-census (read-only) ===");
  note("COUNTS, COLUMN TYPES AND ENUM LABELS ONLY. No document numbers, no names, no amounts.");

  const companies = await sql`SELECT id, code, name FROM scm.companies ORDER BY id`.catch(() => []);
  if (companies.length) {
    note(`companies: ${companies.map((c) => `${c.id}=${c.code ?? c.name}`).join(", ")}`);
  }

  /* ── 1. The vocabulary each column ACTUALLY allows, consignment beside its
        mirror. If the two lines are identical the alignment work is an
        APPLICATION change with no migration; if they differ, a migration on a
        live enum is in scope and the sizing changes. ── */
  note("\n─── 1. WHAT THE DATABASE ALLOWS (live pg_enum, not the DDL files) ───");
  let sameTypeCount = 0;
  let comparedCount = 0;
  for (const d of DOCS) {
    let mine, theirs;
    try { mine = await statusType(d.table); } catch (e) { note(`  ${d.label}: could not read type — ${e.message}`); continue; }
    try { theirs = await statusType(d.mirror); } catch { theirs = null; }
    if (!mine) { note(`  ${d.label}  ${d.table}: NO status column / table not present on this database`); continue; }
    note(`\n  ${d.label}`);
    note(`    scm.${d.table}.status  ->  ${mine.typeName}${mine.labels ? "" : "   (NOT an enum — nothing constrains the value)"}`);
    if (mine.labels) note(`      allows: ${mine.labels.join(", ")}`);
    if (theirs) {
      comparedCount += 1;
      const same = theirs.typeName === mine.typeName;
      if (same) sameTypeCount += 1;
      note(`    mirror ${d.mirrorOf} — scm.${d.mirror}.status  ->  ${theirs.typeName}${same ? "   [SAME TYPE]" : "   [DIFFERENT TYPE]"}`);
      if (!same && theirs.labels) note(`      allows: ${theirs.labels.join(", ")}`);
    } else {
      note(`    mirror ${d.mirrorOf} — scm.${d.mirror}: could not read`);
    }
  }

  /* ── 2. How many rows the change would land on. ── */
  note("\n─── 2. HOW MANY ROWS ARE AT STAKE (per company, per status) ───");
  const totals = new Map();
  for (const d of DOCS) {
    note(`\n  ${d.label}  —  scm.${d.table}`);
    let rows;
    try { rows = await censusByStatus(d.table); }
    catch (e) { note(`    could not read — ${e.message}`); continue; }
    totals.set(d.label, rows.reduce((s, r) => s + r.n, 0));
    for (const line of renderCensus(rows)) note(line);
  }

  note("\n  For comparison, the documents they mirror:");
  for (const d of DOCS) {
    let rows;
    try { rows = await censusByStatus(d.mirror); }
    catch (e) { note(`    scm.${d.mirror}: could not read — ${e.message}`); continue; }
    const total = rows.reduce((s, r) => s + r.n, 0);
    note(`    scm.${d.mirror}: ${total} rows`);
    for (const line of renderCensus(rows)) note(line);
  }

  /* ── 3. Does the FACT a derived status would read actually exist in the data?
        A column that is present but always NULL cannot drive a status. ── */
  note("\n─── 3. THE FACTS A DERIVED STATUS WOULD HAVE TO READ ───");
  note("  (a count of 0 means the column exists but nobody fills it — a status");
  note("   derived from it would never fire)");
  for (const f of FACTS) {
    try {
      /* `f.where` is a hard-coded literal in the FACTS table at the top of this
         file — never caller input — so it is composed as text. Written with
         sql.unsafe over the WHOLE statement rather than interpolated into a
         tagged template, because a fragment interpolated into a template is
         parameterised by this driver and a WHERE clause is not a value. */
      const [{ n, t }] = await sql.unsafe(
        `SELECT count(*) FILTER (WHERE ${f.where})::int AS n, count(*)::int AS t FROM scm.${f.table}`,
      );
      note(`    ${f.q}: ${n} of ${t}`);
    } catch (e) {
      note(`    ${f.q}: could not read — ${e.message}`);
    }
  }

  /* The one relational fact that matters most to the proposal: on the sales
     side DELIVERED is DERIVED from delivery-order coverage. Could the same be
     derived on the consignment side? Only if consignment notes are actually
     linked back to consignment orders. Count of parents WITH a live child. */
  try {
    const [{ n, t }] = await sql`
      SELECT count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM scm.consignment_delivery_orders n
                WHERE n.consignment_so_doc_no = o.doc_no
                  AND n.status::text <> 'CANCELLED'))::int AS n,
             count(*)::int AS t
        FROM scm.consignment_sales_orders o`;
    note(`    CO with at least one live (non-cancelled) CN against it: ${n} of ${t}`);
  } catch (e) {
    note(`    CO-with-a-live-CN: could not read — ${e.message}`);
  }

  note("\n=== VERDICT ===");
  note(`  ${sameTypeCount} of ${comparedCount} consignment documents share their mirror document's EXACT status type.`);
  note("  Where the type is shared, the database already accepts every status the mirror");
  note("  accepts, so aligning that document is an APPLICATION change and needs no migration.");
  note("  Where it is not, a change to a live enum is in scope and must be sized as one.");
  note("  What no query can answer: whether a status SHOULD move, and on what event.");
  note("  That is the owner's to decide — see docs/modules/consignment-alignment.md §5.");

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
